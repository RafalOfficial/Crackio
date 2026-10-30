import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "./db";
import { urlToPath } from "./media";
import { mediaInfo } from "./media-info";
import type { Generation } from "@/lib/generations/types";
import { cleanName, isHexColor, isProjectIcon, nameProblem, type LibraryProject, type Placement, type ProjectInput } from "@/lib/library/types";

/**
 * Library projects (see lib/library/types). Projects and where takes are filed live in their own
 * tables, so a job saving its generation can never undo a move.
 */

const g = globalThis as unknown as { __crackioLibraryTables?: boolean };

function tables() {
  const d = db();
  if (!g.__crackioLibraryTables) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS library_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_items (
        generation_id TEXT NOT NULL,
        output_index INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        moved_at INTEGER NOT NULL,
        PRIMARY KEY (generation_id, output_index)
      );
      CREATE INDEX IF NOT EXISTS library_items_project ON library_items(project_id);
    `);
    g.__crackioLibraryTables = true;
  }
  return d;
}

/** A request the Library can't do, with the reason to show. */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function transaction<T>(run: () => T): T {
  const d = tables();
  d.exec("BEGIN");
  try {
    const out = run();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** The shape of a project in a request; `checked` does the real validation, with reasons. */
export const ProjectBody = z.object({
  name: z.string().max(400),
  icon: z.string().max(40_000),
  color: z.string().max(16),
});

type ProjectRow = { id: string; name: string; icon: string; color: string; created_at: number };
const toProject = (r: ProjectRow): LibraryProject => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, createdAt: r.created_at });

/** Oldest first, so a new project lands at the end of the row. */
export function listProjects(): LibraryProject[] {
  return (tables().prepare("SELECT * FROM library_projects ORDER BY created_at").all() as ProjectRow[]).map(toProject);
}

function getProject(id: string) {
  const row = tables().prepare("SELECT * FROM library_projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

function checked(input: ProjectInput, self?: string): ProjectInput {
  const name = cleanName(input.name);
  const problem = nameProblem(
    name,
    listProjects()
      .filter((p) => p.id !== self)
      .map((p) => p.name),
  );
  if (problem) throw new LibraryError(problem);
  if (!isProjectIcon(input.icon)) throw new LibraryError("Pick an icon, or upload a small .svg.");
  if (!isHexColor(input.color)) throw new LibraryError("Pick a color.");
  return { name, icon: input.icon, color: input.color.toLowerCase() };
}

export function createProject(input: ProjectInput): LibraryProject {
  const p: LibraryProject = { id: nanoid(10), ...checked(input), createdAt: Date.now() };
  tables().prepare("INSERT INTO library_projects (id, name, icon, color, created_at) VALUES (?, ?, ?, ?, ?)").run(p.id, p.name, p.icon, p.color, p.createdAt);
  return p;
}

export function updateProject(id: string, patch: Partial<ProjectInput>): LibraryProject {
  const current = getProject(id);
  if (!current) throw new LibraryError("That project doesn't exist anymore.", 404);
  const next = { ...current, ...checked({ ...current, ...patch }, id) };
  tables().prepare("UPDATE library_projects SET name = ?, icon = ?, color = ? WHERE id = ?").run(next.name, next.icon, next.color, id);
  return next;
}

/** Deletes the folder only: its takes go back to General. */
export function deleteProject(id: string) {
  transaction(() => {
    const d = tables();
    d.prepare("DELETE FROM library_items WHERE project_id = ?").run(id);
    d.prepare("DELETE FROM library_projects WHERE id = ?").run(id);
  });
}

export function listPlacements(): Placement[] {
  const rows = tables().prepare("SELECT generation_id, output_index, project_id FROM library_items").all() as {
    generation_id: string;
    output_index: number;
    project_id: string;
  }[];
  return rows.map((r) => ({ id: r.generation_id, index: r.output_index, project: r.project_id }));
}

/** Files takes into a project, or back into General when `project` is null. Takes that no longer exist are skipped. */
export function fileTakes(takes: { id: string; index: number }[], project: string | null) {
  if (project && !getProject(project)) throw new LibraryError("That project doesn't exist anymore.", 404);
  const d = tables();
  const outputs = new Map<string, number>();
  const count = (id: string) => {
    if (!outputs.has(id)) {
      const row = d.prepare("SELECT status, data FROM generations WHERE id = ?").get(id) as { status: string; data: string } | undefined;
      outputs.set(id, row?.status === "done" ? (JSON.parse(row.data) as Generation).outputs.length : 0);
    }
    return outputs.get(id)!;
  };
  const file = d.prepare(
    `INSERT INTO library_items (generation_id, output_index, project_id, moved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(generation_id, output_index) DO UPDATE SET project_id = excluded.project_id, moved_at = excluded.moved_at`,
  );
  const unfile = d.prepare("DELETE FROM library_items WHERE generation_id = ? AND output_index = ?");
  const now = Date.now();
  transaction(() => {
    for (const t of takes) {
      if (project) {
        if (t.index < count(t.id)) file.run(t.id, t.index, project, now);
      } else unfile.run(t.id, t.index);
    }
  });
}

/** A generation was deleted: forget where its takes were filed. */
export function forgetGeneration(id: string) {
  tables().prepare("DELETE FROM library_items WHERE generation_id = ?").run(id);
}

/**
 * Every generation the Library shows, newest first. Only what a card and the viewer need is sent:
 * references and tool settings (Director scenes, storyboards) stay on the server. Takes saved
 * before outputs carried their file size and a clip's length get them filled in here.
 */
export async function libraryGenerations(): Promise<Generation[]> {
  const rows = db().prepare("SELECT data FROM generations WHERE tool != 'showcase' ORDER BY created_at DESC").all() as { data: string }[];
  const items = rows.map((r) => {
    const gen = JSON.parse(r.data) as Generation;
    const kind = gen.params?.kind;
    return { ...gen, references: [], params: kind ? { kind } : undefined };
  });
  const missing = items.flatMap((gen) => gen.outputs.filter((o) => o.bytes === undefined || (o.kind === "video" && o.duration === undefined)));
  // A few at a time: the first listing after a restart reads every clip's header once.
  for (let i = 0; i < missing.length; i += 16) {
    await Promise.all(
      missing.slice(i, i + 16).map(async (o) => {
        const file = urlToPath(o.url);
        const info = file ? await mediaInfo(file) : null;
        if (!info) return;
        o.bytes = info.bytes;
        if (info.duration !== undefined) o.duration = info.duration;
        if (info.fps !== undefined) o.fps = info.fps;
      }),
    );
  }
  return items;
}
