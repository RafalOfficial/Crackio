import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, getGeneration, saveGeneration } from "./db";
import { createProject, deleteProject, fileTakes, LibraryError, listPlacements, listProjects, updateProject } from "./library";
import { saveOutputs, urlToPath } from "./media";
import { probe } from "@/lib/motion/ffmpeg";
import { renderEdit } from "@/lib/storyboard/render-edit";
import { emptyTimeline, filmLength, FILM_ASPECTS, type EditFile, type EditProject, type EditProjectSummary } from "@/lib/storyboard/edit";
import type { Generation } from "@/lib/generations/types";
import { ASPECTS, type AspectId } from "@/lib/shot";

/**
 * Storyboard projects (lib/storyboard/edit). Each one is a Library folder, so everything made in it is filed there and
 * shows in the Library too; the timeline, the Director's set and the files you added live here, one row per project.
 */

const g = globalThis as unknown as { __crackioEditTables?: boolean };

function tables() {
  const d = db();
  if (!g.__crackioEditTables) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS edit_projects (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edit_filed (
        generation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        filed_at INTEGER NOT NULL
      );
    `);
    g.__crackioEditTables = true;
  }
  return d;
}

/** The tools whose takes are filed into the project they were made in (a Cast sheet made from it isn't one of its shots). */
const FILED_TOOLS = new Set(["director", "storyboard", "video", "image"]);

const COLOR = "#e8d35a";

function readDoc(id: string): EditProject | null {
  const row = tables().prepare("SELECT data FROM edit_projects WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as EditProject) : null;
}

function writeDoc(doc: EditProject) {
  tables().prepare("INSERT INTO edit_projects (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(doc.id, JSON.stringify(doc), doc.updatedAt);
}

/** A project with its folder's name, icon and color; null once the folder is gone (deleted in the Library). */
export function getEditProject(id: string): EditProject | null {
  const doc = readDoc(id);
  const folder = listProjects().find((p) => p.id === id);
  if (!doc || !folder) return null;
  return { ...doc, name: folder.name, icon: folder.icon, color: folder.color };
}

function summary(doc: EditProject): EditProjectSummary {
  const first = doc.timeline.main[0];
  return {
    id: doc.id,
    name: doc.name,
    icon: doc.icon,
    color: doc.color,
    aspect: doc.aspect,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    cover: first?.url ?? doc.uploads.find((u) => u.kind !== "audio")?.url,
    clips: doc.timeline.main.length,
    seconds: filmLength(doc.timeline),
  };
}

/** Newest first. Projects whose folder was deleted in the Library are gone with it. */
export function listEditProjects(): EditProjectSummary[] {
  const folders = new Map(listProjects().map((p) => [p.id, p]));
  const rows = tables().prepare("SELECT data FROM edit_projects ORDER BY updated_at DESC").all() as { data: string }[];
  return rows.flatMap((r) => {
    const doc = JSON.parse(r.data) as EditProject;
    const folder = folders.get(doc.id);
    return folder ? [summary({ ...doc, name: folder.name, icon: folder.icon, color: folder.color })] : [];
  });
}

/** "Film 1", "Film 2"…: the first name no folder has yet. */
function freeName() {
  const taken = new Set(listProjects().map((p) => p.name.toLowerCase()));
  for (let i = 1; ; i++) if (!taken.has(`film ${i}`)) return `Film ${i}`;
}

export function createEditProject(input: { name?: string; aspect?: AspectId } = {}): EditProject {
  const folder = createProject({ name: input.name?.trim() || freeName(), icon: "clapperboard", color: COLOR });
  const now = Date.now();
  const doc: EditProject = {
    id: folder.id,
    name: folder.name,
    icon: folder.icon,
    color: folder.color,
    aspect: input.aspect && FILM_ASPECTS.includes(input.aspect) ? input.aspect : "16:9",
    timeline: emptyTimeline(),
    mode: "edit",
    uploads: [],
    createdAt: now,
    updatedAt: now,
  };
  writeDoc(doc);
  return doc;
}

const aspectIds = ASPECTS.map((a) => a.id) as [AspectId, ...AspectId[]];
const seconds = z.number().min(0).max(36_000);

const Clip = z.object({
  id: z.string().min(1).max(40),
  url: z.string().min(1).max(600),
  kind: z.enum(["image", "video", "audio"]),
  name: z.string().max(300).optional(),
  gen: z.string().max(40).optional(),
  width: z.number().positive().max(20_000).optional(),
  height: z.number().positive().max(20_000).optional(),
  length: seconds.optional(),
  sound: z.boolean().optional(),
  in: seconds,
  out: seconds,
  at: seconds.optional(),
  speed: z.number().min(0.25).max(4).optional(),
  volume: z.number().min(0).max(1).optional(),
  muted: z.boolean().optional(),
  fit: z.enum(["fill", "fit"]).optional(),
  push: z.boolean().optional(),
  fadeIn: z.number().min(0).max(60).optional(),
  fadeOut: z.number().min(0).max(60).optional(),
  making: z.string().max(40).optional(),
});

export const EditPatch = z.object({
  name: z.string().max(400).optional(),
  aspect: z.enum(aspectIds).optional(),
  mode: z.enum(["edit", "direct"]).optional(),
  timeline: z.object({ main: z.array(Clip).max(400), music: z.array(Clip).max(100) }).optional(),
  // The Director's set, kept as it comes (it's the Director's to read).
  scene: z.record(z.string(), z.unknown()).optional(),
});

export function patchEditProject(id: string, patch: z.infer<typeof EditPatch>): EditProject {
  const doc = getEditProject(id);
  if (!doc) throw new LibraryError("That project doesn't exist anymore.", 404);
  if (patch.scene && JSON.stringify(patch.scene).length > 2_000_000) throw new LibraryError("The Director's set is too big to save.", 413);
  // The name is the folder's: the Library checks it (length, taken by another folder).
  const folder = patch.name !== undefined && patch.name.trim() !== doc.name ? updateProject(id, { name: patch.name }) : null;
  const next: EditProject = {
    ...doc,
    ...(folder ? { name: folder.name } : {}),
    ...(patch.aspect ? { aspect: patch.aspect } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.timeline ? { timeline: patch.timeline } : {}),
    ...(patch.scene ? { scene: patch.scene } : {}),
    updatedAt: Date.now(),
  };
  writeDoc(next);
  return next;
}

/** The project and its folder go; everything that was in the folder goes back to General in the Library. */
export function deleteEditProject(id: string) {
  deleteProject(id);
  tables().prepare("DELETE FROM edit_projects WHERE id = ?").run(id);
}

/**
 * A take made in a project goes into its folder once, when it's done (db's saveGeneration calls this). Once: moved
 * elsewhere in the Library afterwards, it stays where you put it.
 */
export function fileFinished(gen: Generation) {
  const project = gen.params?.project;
  if (typeof project !== "string" || gen.status !== "done" || !gen.outputs.length || !FILED_TOOLS.has(gen.tool)) return;
  const d = tables();
  if (d.prepare("SELECT 1 FROM edit_filed WHERE generation_id = ?").get(gen.id)) return;
  try {
    fileTakes(
      gen.outputs.map((_, index) => ({ id: gen.id, index })),
      project,
    );
  } catch (err) {
    // The folder is gone: there's nowhere to file it, and nothing to try again.
    if (!(err instanceof LibraryError)) throw err;
  }
  d.prepare("INSERT OR IGNORE INTO edit_filed (generation_id, project_id, filed_at) VALUES (?, ?, ?)").run(gen.id, project, Date.now());
}

const fileOf = (gen: Generation, index: number): EditFile | null => {
  const o = gen.outputs[index];
  if (!o) return null;
  return {
    key: `gen:${gen.id}:${index}`,
    url: o.url,
    kind: o.kind,
    name: gen.prompt.split(/[.\n]/)[0]?.trim().slice(0, 80) || (o.kind === "video" ? "Clip" : "Picture"),
    width: o.width,
    height: o.height,
    duration: o.duration,
    gen: gen.id,
    index,
    createdAt: gen.finishedAt ?? gen.createdAt,
    prompt: gen.prompt,
    from: gen.tool,
  };
};

/**
 * Everything in the project, newest first: the takes in its folder (whatever made them, also ones you moved there in
 * the Library) and the files you added. Takes still being made are the page's to show (it follows them live).
 */
export async function projectFiles(id: string): Promise<EditFile[]> {
  const doc = getEditProject(id);
  if (!doc) throw new LibraryError("That project doesn't exist anymore.", 404);
  // Takes that finished while nothing filed them (the server stopped between): filed now.
  const unfiled = tables()
    .prepare(
      `SELECT data FROM generations WHERE status = 'done' AND json_extract(data, '$.params.project') = ?
       AND id NOT IN (SELECT generation_id FROM edit_filed)`,
    )
    .all(id) as { data: string }[];
  for (const r of unfiled) fileFinished(JSON.parse(r.data) as Generation);

  const byGen = new Map<string, number[]>();
  for (const p of listPlacements()) if (p.project === id) byGen.set(p.id, [...(byGen.get(p.id) ?? []), p.index]);
  const takes: EditFile[] = [];
  for (const [genId, indexes] of byGen) {
    const gen = getGeneration(genId);
    if (!gen || gen.status !== "done") continue;
    for (const i of indexes.sort((a, b) => a - b)) {
      const f = fileOf(gen, i);
      if (f) takes.push(f);
    }
  }
  // Whether a clip has its own sound decides how it's shown and mixed: read once per clip, a few at a time.
  const clips = takes.filter((f) => f.kind === "video");
  for (let i = 0; i < clips.length; i += 4) {
    await Promise.all(
      clips.slice(i, i + 4).map(async (f) => {
        const info = await soundOf(f.url);
        if (info) Object.assign(f, info);
      }),
    );
  }
  return [...takes, ...doc.uploads].sort((a, b) => b.createdAt - a.createdAt);
}

// On globalThis, so a hot reload in development keeps what's been read.
const gs = globalThis as unknown as { __crackioClipSound?: Map<string, { sound: boolean; duration?: number }> };
const soundCache = (gs.__crackioClipSound ??= new Map());

/** A clip's sound and length, read from the file once. */
async function soundOf(url: string) {
  const hit = soundCache.get(url);
  if (hit) return { sound: hit.sound, ...(hit.duration ? { duration: hit.duration } : {}) };
  const file = urlToPath(url);
  const info = file ? await probe(file).catch(() => null) : null;
  if (!info) return null;
  const entry = { sound: Boolean(info.audio), duration: info.duration };
  soundCache.set(url, entry);
  return { sound: entry.sound, ...(entry.duration ? { duration: entry.duration } : {}) };
}

export const AddFiles = z.object({ items: z.array(z.object({ url: z.string().min(1).max(600), name: z.string().max(300).optional() })).min(1).max(24) });

/** Files from your computer (already uploaded) added to the project. */
export async function addUploads(id: string, items: z.infer<typeof AddFiles>["items"]) {
  const doc = getEditProject(id);
  if (!doc) throw new LibraryError("That project doesn't exist anymore.", 404);
  const added: EditFile[] = [];
  for (const item of items) {
    const file = urlToPath(item.url);
    if (!file || !item.url.startsWith("/api/media/uploads/")) throw new LibraryError("That file isn't one Crackio stored.");
    if (doc.uploads.some((u) => u.url === item.url)) continue;
    const info = await probe(file).catch(() => null);
    if (!info || (info.kind !== "image" && info.kind !== "video" && info.kind !== "audio")) throw new LibraryError(`${item.name ?? "That file"} isn't a picture, clip or sound.`, 415);
    added.push({
      key: `up:${item.url}`,
      url: item.url,
      kind: info.kind,
      name: (item.name ?? "").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || (info.kind === "audio" ? "Sound" : info.kind === "video" ? "Clip" : "Picture"),
      width: info.width,
      height: info.height,
      duration: info.duration,
      sound: info.kind === "video" ? Boolean(info.audio) : undefined,
      createdAt: Date.now(),
      from: "upload",
    });
  }
  if (added.length) writeDoc({ ...doc, uploads: [...added, ...doc.uploads], updatedAt: Date.now() });
  return added;
}

/** Takes it out of the project: a file you added is forgotten, a take goes back to General in the Library. */
export function removeFile(id: string, key: string) {
  const doc = getEditProject(id);
  if (!doc) throw new LibraryError("That project doesn't exist anymore.", 404);
  if (key.startsWith("up:")) {
    writeDoc({ ...doc, uploads: doc.uploads.filter((u) => u.key !== key), updatedAt: Date.now() });
    return;
  }
  const m = /^gen:([A-Za-z0-9_-]+):(\d+)$/.exec(key);
  if (!m) throw new LibraryError("Unknown file.");
  fileTakes([{ id: m[1], index: Number(m[2]) }], null);
}

/**
 * The film made from the timeline in the background, as a take filed into the project (and its Library folder). `owner`:
 * the live demo's access code, so the page that started it can follow it (lib/demo shows a code only its own takes).
 */
export function startExport(id: string, quality: "720p" | "1080p", owner?: string): Generation {
  const doc = getEditProject(id);
  if (!doc) throw new LibraryError("That project doesn't exist anymore.", 404);
  if (!doc.timeline.main.length) throw new LibraryError("Put some pictures or clips on the timeline first.");
  const gen: Generation = {
    id: nanoid(14),
    tool: "storyboard",
    engine: "auto",
    status: "running",
    prompt: `${doc.name} · the film`,
    aspect: doc.aspect,
    count: 1,
    references: [],
    outputs: [],
    params: { kind: "video", project: id, export: { quality, clips: doc.timeline.main.length } },
    progress: 0.02,
    stage: "Putting the film together",
    createdAt: Date.now(),
    ...(owner ? { owner } : {}),
  };
  saveGeneration(gen);
  const snapshot = structuredClone(doc);
  void (async () => {
    let last = 0;
    try {
      const film = await renderEdit(snapshot, quality, {
        progress: (share) => {
          const now = Date.now();
          if (now - last < 500) return;
          last = now;
          saveGeneration({ ...gen, progress: 0.02 + share * 0.9 });
        },
      });
      const outputs = await saveOutputs(gen.id, [{ data: film.data, mime: "video/mp4", width: film.width, height: film.height }]);
      saveGeneration({ ...gen, status: "done", outputs, progress: 1, stage: undefined, finishedAt: Date.now() });
    } catch (err) {
      saveGeneration({ ...gen, status: "error", error: (err as Error).message, stage: undefined, finishedAt: Date.now() });
    }
  })();
  return gen;
}
