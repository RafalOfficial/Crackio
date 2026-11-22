import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { DATA_DIR } from "../paths";
import { writeFileAtomic } from "../atomic-write";
import { isActive, type LogLine, type TrainJob, type TrainProgress, type TrainSummary } from "@/lib/train/types";
import { DEFAULT_SETTINGS, SETTING_KEYS } from "@/lib/train/plan";
import { trainable } from "@/lib/train/plan";

/**
 * Training jobs on disk: data/training/<id>/job.json (the job), images/ (its pictures as Crackio keeps them), thumbs/,
 * previews/ (test pictures), lora/ (a copy of the finished LoRA) and log.txt. Jobs are held in memory once read and
 * written back at most twice a second (a running job changes with every step), each write whole or not at all.
 */

const ROOT = path.join(/*turbopackIgnore: true*/ DATA_DIR, "training");
const newId = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 10);
const ID = /^[a-z0-9]{6,24}$/;

type Held = { jobs: Map<string, TrainJob>; logs: Map<string, LogLine[]>; loaded: Promise<void> | null; writes: Map<string, { timer: ReturnType<typeof setTimeout> | null; busy: Promise<void> }> };
const g = globalThis as unknown as { __crackioTrain?: Held };
const held = (g.__crackioTrain ??= { jobs: new Map(), logs: new Map(), loaded: null, writes: new Map() });

export const validId = (id: string) => ID.test(id);
export const jobDir = (id: string) => path.join(/*turbopackIgnore: true*/ ROOT, id);
export const jobPath = (id: string, ...parts: string[]) => path.join(/*turbopackIgnore: true*/ jobDir(id), ...parts);

const emptyProgress = (): TrainProgress => ({ step: 0, steps: 0, loss: null, losses: [], pace: null, peakGb: null, stage: "", share: null, startedAt: null, trainingAt: null, finishedAt: null, trainedSeconds: 0 });

/** A job read from disk made whole: fields a newer Crackio added get their defaults. */
function whole(raw: Partial<TrainJob> & { id: string }): TrainJob {
  return {
    name: "Untitled",
    goal: "person",
    trigger: "",
    noun: "",
    base: null,
    machine: null,
    images: [],
    auto: [...SETTING_KEYS],
    testPrompts: [],
    state: "draft",
    checkpoints: [],
    result: null,
    heals: [],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    progress: { ...emptyProgress(), ...(raw.progress ?? {}) },
  };
}

function load() {
  return (held.loaded ??= (async () => {
    const names = await fs.readdir(/*turbopackIgnore: true*/ ROOT).catch(() => [] as string[]);
    await Promise.all(
      names.filter(validId).map(async (id) => {
        try {
          const raw = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ jobPath(id, "job.json"), "utf8")) as TrainJob;
          if (!held.jobs.has(id)) held.jobs.set(id, whole({ ...raw, id }));
        } catch {
          // A folder without a readable job (a delete cut short): left alone.
        }
      }),
    );
  })());
}

export async function allJobs(): Promise<TrainJob[]> {
  await load();
  return [...held.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string): Promise<TrainJob | null> {
  if (!validId(id)) return null;
  await load();
  return held.jobs.get(id) ?? null;
}

export const summaryOf = (j: TrainJob): TrainSummary => ({
  id: j.id,
  name: j.name,
  goal: j.goal,
  state: j.state,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
  // An edit LoRA's are its pairs.
  images: trainable(j.images, j.goal).length,
  cover: (trainable(j.images, j.goal)[0] ?? j.images.find((i) => !i.skip))?.id ?? null,
  family: j.base?.family ?? null,
  step: j.progress.step,
  steps: j.progress.steps || j.settings.steps,
  done: Boolean(j.result),
});

export async function createJob(init: Partial<TrainJob> = {}): Promise<TrainJob> {
  await load();
  const id = newId();
  const job = whole({ ...init, id, createdAt: Date.now(), updatedAt: Date.now() });
  await fs.mkdir(/*turbopackIgnore: true*/ jobPath(id, "images"), { recursive: true });
  held.jobs.set(id, job);
  await flush(id);
  return job;
}

/** Marks a job changed: written to disk within half a second (`now`: before this returns). */
export function touch(job: TrainJob, now = false): Promise<void> {
  job.updatedAt = Date.now();
  const w = held.writes.get(job.id) ?? { timer: null, busy: Promise.resolve() };
  held.writes.set(job.id, w);
  if (now) {
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    return flush(job.id);
  }
  if (!w.timer) {
    w.timer = setTimeout(() => {
      w.timer = null;
      void flush(job.id);
    }, 500);
    w.timer.unref?.();
  }
  return Promise.resolve();
}

function flush(id: string): Promise<void> {
  const w = held.writes.get(id) ?? { timer: null, busy: Promise.resolve() };
  held.writes.set(id, w);
  w.busy = w.busy
    .catch(() => undefined)
    .then(async () => {
      const job = held.jobs.get(id);
      if (!job) return;
      await writeFileAtomic(jobPath(id, "job.json"), JSON.stringify(job));
    })
    .catch((err: Error) => console.warn(`[train] couldn't save job ${id}: ${err.message}`));
  return w.busy;
}

export async function deleteJob(id: string) {
  const job = await getJob(id);
  if (!job) return false;
  if (isActive(job.state)) throw new Error("Stop it first.");
  const w = held.writes.get(id);
  if (w?.timer) clearTimeout(w.timer);
  await w?.busy.catch(() => undefined);
  held.writes.delete(id);
  held.jobs.delete(id);
  held.logs.delete(id);
  await fs.rm(/*turbopackIgnore: true*/ jobDir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return true;
}

/* ------------------------------------------------------------------ the log */

const KEEP = 600;

async function logOf(id: string): Promise<LogLine[]> {
  let lines = held.logs.get(id);
  if (!lines) {
    const text = await fs.readFile(/*turbopackIgnore: true*/ jobPath(id, "log.txt"), "utf8").catch(() => "");
    const all = text.split("\n").filter(Boolean);
    lines = all.slice(-KEEP).map((line, i) => [all.length - Math.min(KEEP, all.length) + i + 1, line] as LogLine);
    held.logs.set(id, lines);
  }
  return lines;
}

/** Adds lines to a job's log (kept in memory, the last 600, and appended to its log.txt). */
export async function log(id: string, ...texts: string[]) {
  if (!texts.length) return;
  const lines = await logOf(id);
  let seq = lines.at(-1)?.[0] ?? 0;
  const stamp = new Date().toTimeString().slice(0, 8);
  const added = texts.map((t) => (/^\d\d:\d\d:\d\d /.test(t) ? t : `${stamp} ${t}`));
  for (const t of added) lines.push([++seq, t]);
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  await fs.appendFile(/*turbopackIgnore: true*/ jobPath(id, "log.txt"), added.map((t) => `${t}\n`).join("")).catch(() => undefined);
}

/** A job's log lines after `from` (all it holds when 0). */
export async function logSince(id: string, from = 0): Promise<LogLine[]> {
  return (await logOf(id)).filter(([seq]) => seq > from);
}
