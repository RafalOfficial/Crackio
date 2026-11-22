import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import type { MotionPlan } from "./playbook";
import { validProjectId, workspaceDir } from "./workspace";

/**
 * Motion projects, one JSON file each: the conversation with the agent, the step-by-step log
 * of every turn, and the files in the project folder (your attachments and everything the agent
 * made, kept on disk under data/media/motion/<id>/).
 */
export type MotionAttachment = {
  url: string;
  kind: "image" | "video" | "audio" | "file";
  name: string;
  width?: number;
  height?: number;
  /** Its name in the project folder, once the agent has picked it up. */
  file?: string;
};

export type MotionFile = {
  name: string;
  kind: "image" | "video" | "audio" | "text" | "other";
  url: string;
  /** A still for videos, for thumbnails. */
  poster?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  audio?: boolean;
  bytes: number;
  /** Your upload, or the tool that made it. */
  source: "upload" | "image" | "video" | "ffmpeg" | "render" | "write" | "sound" | "depth" | "download";
  /** For downloads: where it came from, and which part of it (seconds of the source). */
  origin?: { url: string; title?: string; start?: number; end?: number };
  /** The turn that made it (or the message it came with). */
  turn?: string;
  /** For rendered files: the HTML behind it, which can play live. */
  compositionId?: string;
  createdAt: number;
};

export type MotionComposition = {
  id: string;
  html: string;
  aspect: string;
  width?: number;
  height?: number;
  duration: number;
  fps: number;
  /** Where the composition's relative file names resolve (the project folder's URL). */
  base?: string;
  file?: string;
  createdAt: number;
};

export type MotionStepStatus = "running" | "done" | "error" | "stopped";

export type MotionLogEntry =
  | { id: string; kind: "note"; text: string; at: number }
  | { id: string; kind: "step"; tool: string; title: string; status: MotionStepStatus; detail?: string; files?: string[]; at: number; endedAt?: number };

export type MotionMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  attachments?: MotionAttachment[];
  /** The background job working on this turn (agent messages). */
  generationId?: string;
  /**
   * A turn worked by an agent outside Crackio, through the MCP's motion tool (Claude Code, Codex…): its name, whether
   * the turn is still open, and when it last did something (the page follows an open turn closely).
   */
  agent?: { client: string; open: boolean; at: number };
  /** What the agent did, in order: what it said and each tool it ran. */
  log?: MotionLogEntry[];
  /** The file the agent delivered. */
  output?: { name: string; url: string; kind: "video" | "image" };
  /** Older single-composition turns. */
  compositionId?: string;
  createdAt: number;
};

export type MotionProject = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: MotionMessage[];
  compositions: MotionComposition[];
  files?: MotionFile[];
  /** The creative plan the agent is working to (concept, look, sound, shots), revised as the project goes. */
  plan?: MotionPlan;
};

const DIR = () => path.join(/*turbopackIgnore: true*/ DATA_DIR, "motion");
const file = (id: string) => {
  if (!validProjectId(id)) throw new Error("Not a Motion project.");
  return path.join(/*turbopackIgnore: true*/ DIR(), `${id}.json`);
};

async function read(id: string): Promise<MotionProject | null> {
  if (!validProjectId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ file(id), "utf8")) as MotionProject;
  } catch {
    return null;
  }
}

const write = (p: MotionProject) => writeFileAtomic(file(p.id), JSON.stringify(p));

/**
 * Reads and writes of one project happen one at a time, so a job and a new message never clobber
 * each other, and a save never lands while the page is reading the file (Windows won't replace an
 * open file).
 */
type Summary = Pick<MotionProject, "id" | "title" | "updatedAt">;
const g = globalThis as unknown as {
  __crackioMotionLocks?: Map<string, Promise<unknown>>;
  __crackioMotionList?: Map<string, { stamp: string; entry: Summary | null }>;
};
const locks: Map<string, Promise<unknown>> = (g.__crackioMotionLocks ??= new Map());
/** Each project's title and date, kept while its file is unchanged: listing doesn't read every conversation again. */
const summaries = (g.__crackioMotionList ??= new Map());

function inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, run);
  // The last one out takes the lock away: the map doesn't keep every project ever opened.
  void run
    .catch(() => {})
    .finally(() => {
      if (locks.get(id) === run) locks.delete(id);
    });
  return run;
}

export function getProject(id: string): Promise<MotionProject | null> {
  return inTurn(id, () => read(id));
}

export function updateProject(id: string, change: (p: MotionProject) => MotionProject | void): Promise<MotionProject> {
  return inTurn(id, async () => {
    const current = await read(id);
    if (!current) throw new Error("Project not found.");
    const next = change(current) ?? current;
    next.updatedAt = Date.now();
    await write(next);
    return next;
  });
}

export async function createProject(title = "Untitled motion"): Promise<MotionProject> {
  const now = Date.now();
  const p: MotionProject = { id: nanoid(12), title, createdAt: now, updatedAt: now, messages: [], compositions: [], files: [] };
  await write(p);
  return p;
}

export async function listProjects(): Promise<Summary[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(/*turbopackIgnore: true*/ DIR())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const ids = names.map((n) => n.replace(/\.json$/, "")).filter(validProjectId);
  const all = await Promise.all(
    ids.map(async (id) => {
      const st = await fs.stat(/*turbopackIgnore: true*/ file(id)).catch(() => null);
      if (!st) return null;
      const stamp = `${st.mtimeMs}:${st.size}`;
      const known = summaries.get(id);
      if (known?.stamp === stamp) return known.entry;
      const p = await getProject(id);
      const entry = p ? { id: p.id, title: p.title, updatedAt: p.updatedAt } : null;
      summaries.set(id, { stamp, entry });
      return entry;
    }),
  );
  const present = new Set(ids);
  for (const id of summaries.keys()) if (!present.has(id)) summaries.delete(id);
  return all.filter((p): p is Summary => Boolean(p)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Removes the project and its folder of files (only ever data/media/motion/<id>). */
export async function deleteProject(id: string) {
  if (!validProjectId(id)) return;
  // In turn, so a save already on its way can't bring the project back.
  await inTurn(id, () => fs.rm(/*turbopackIgnore: true*/ file(id), { force: true }));
  await fs.rm(/*turbopackIgnore: true*/ workspaceDir(id), { recursive: true, force: true });
}
