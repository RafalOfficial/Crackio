import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import type { MotionPlan } from "./playbook";
import { workspaceDir } from "./workspace";

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

const DIR = () => path.join(DATA_DIR, "motion");
const file = (id: string) => path.join(DIR(), `${id.replace(/[^\w-]/g, "")}.json`);

async function read(id: string): Promise<MotionProject | null> {
  try {
    return JSON.parse(await fs.readFile(file(id), "utf8")) as MotionProject;
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
const g = globalThis as unknown as { __crackioMotionLocks?: Map<string, Promise<unknown>> };
const locks: Map<string, Promise<unknown>> = (g.__crackioMotionLocks ??= new Map());

function inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, run);
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

export async function listProjects(): Promise<Pick<MotionProject, "id" | "title" | "updatedAt">[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(DIR())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const all = await Promise.all(names.map((n) => getProject(n.replace(/\.json$/, ""))));
  return all
    .filter((p): p is MotionProject => Boolean(p))
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Removes the project and its folder of files (only ever data/media/motion/<id>). */
export async function deleteProject(id: string) {
  // In turn, so a save already on its way can't bring the project back.
  await inTurn(id, () => fs.rm(file(id), { force: true }));
  await fs.rm(workspaceDir(id), { recursive: true, force: true });
}
