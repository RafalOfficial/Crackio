import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "@/lib/server/paths";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { demoFull } from "./config";

/**
 * Access codes and their credits. A code is the account: whoever has it spends its credits, and its work is kept apart
 * from everyone else's. Only a hash of each code is stored, made by scripts/demo/codes.mjs (`add`, `list`).
 * One server process owns the file, so a charge is read, checked and written in one turn of a queue; every change is
 * also appended to ledger.jsonl.
 */
export type DemoCode = {
  id: string;
  label: string;
  credits: number;
  spent: number;
  createdAt: number;
  disabled?: boolean;
  /** Credits taken for jobs still running, by generation id: kept when one finishes, given back when it fails. */
  held?: Record<string, number>;
};
type CodesFile = { version: 1; codes: Record<string, DemoCode> };

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "demo");
const FILE = path.join(/*turbopackIgnore: true*/ DIR, "codes.json");
const LEDGER = path.join(/*turbopackIgnore: true*/ DIR, "ledger.jsonl");

const g = globalThis as unknown as { __crackioDemoCodes?: { file: CodesFile; mtime: number }; __crackioDemoQueue?: Promise<unknown> };

/** Codes are typed loosely: case, spaces and dashes don't matter. */
export const codeHash = (code: string) =>
  createHash("sha256")
    .update(code.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .digest("hex");

async function load(): Promise<CodesFile> {
  const stat = await fs.stat(FILE).catch(() => null);
  if (!stat) return { version: 1, codes: {} };
  // The codes script may have added one while the server runs.
  if (g.__crackioDemoCodes && g.__crackioDemoCodes.mtime === stat.mtimeMs) return g.__crackioDemoCodes.file;
  const file = JSON.parse(await fs.readFile(FILE, "utf8")) as CodesFile;
  g.__crackioDemoCodes = { file, mtime: stat.mtimeMs };
  return file;
}

async function save(file: CodesFile) {
  await writeFileAtomic(FILE, JSON.stringify(file, null, 2));
  const stat = await fs.stat(FILE).catch(() => null);
  g.__crackioDemoCodes = { file, mtime: stat?.mtimeMs ?? 0 };
}

/** One change at a time. */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const next = (g.__crackioDemoQueue ?? Promise.resolve()).then(job, job);
  g.__crackioDemoQueue = next.catch(() => {});
  return next;
}

const left = (c: DemoCode) => Math.max(0, c.credits - c.spent);

/** The code someone typed, when it exists and is on. */
export async function findCode(code: string): Promise<DemoCode | null> {
  const entry = (await load()).codes[codeHash(code)];
  return entry && !entry.disabled ? entry : null;
}

/** A signed-in code by its id, with what it has left. */
export async function codeById(id: string): Promise<(DemoCode & { left: number }) | null> {
  const entry = Object.values((await load()).codes).find((c) => c.id === id);
  return entry && !entry.disabled ? { ...entry, left: left(entry) } : null;
}

async function note(entry: Record<string, unknown>) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.appendFile(LEDGER, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
}

/** Takes `credits` from a code for a job (a generation id), or says how many it has left. */
export function charge(id: string, credits: number, job: string): Promise<{ ok: boolean; left: number }> {
  return queued(async () => {
    const file = await load();
    const entry = Object.values(file.codes).find((c) => c.id === id);
    if (!entry || entry.disabled) return { ok: false, left: 0 };
    if (left(entry) < credits) return { ok: false, left: left(entry) };
    entry.spent += credits;
    entry.held = { ...entry.held, [job]: credits };
    await save(file);
    await note({ id, delta: -credits, job });
    return { ok: true, left: left(entry) };
  });
}

/**
 * A charged job ended: its credits come back when it failed or was cancelled. When it worked they stay spent, or, when
 * its recipe carries the GPU time a serverless provider billed, that time is charged instead (up to what the code has).
 * Once per job.
 */
export async function settle(job: string, worked: boolean): Promise<void> {
  // A job is saved as done a moment before its recipe (what it ran, and RunPod's billed time) is written: wait for it,
  // outside the queue so other codes' charges don't wait too.
  if (worked) await recipeOf(job);
  return queued(async () => {
    const file = await load();
    const entry = Object.values(file.codes).find((c) => c.held?.[job] !== undefined);
    if (!entry?.held) return;
    const credits = entry.held[job];
    delete entry.held[job];
    if (!worked) {
      entry.spent = Math.max(0, entry.spent - credits);
      await save(file);
      await note({ id: entry.id, delta: credits, job, refund: true });
      return;
    }
    // The full demo charges only what ran on its own GPU: a job on the visitor's own machines or keys costs nothing.
    const billed = (await billedCredits(job)) ?? (demoFull() ? 0 : null);
    if (billed !== null && billed !== credits) {
      const charged = Math.min(billed, credits + left(entry));
      entry.spent = Math.max(0, entry.spent - credits + charged);
      await save(file);
      await note({ id: entry.id, delta: credits - charged, job, billed });
      return;
    }
    await save(file);
  });
}

/** A finished job's recipe, waited for up to 15 s; null when it has none (no ComfyUI or Router step). */
async function recipeOf(job: string) {
  const { readRecipe } = await import("@/lib/server/recipes");
  for (let i = 0; i < 30; i++) {
    const recipe = await readRecipe(job).catch(() => null);
    if (recipe) return recipe;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** RunPod serverless with an RTX 5090: $1.79 an hour. A credit is half a cent. */
const SERVERLESS_USD_PER_SECOND = 1.79 / 3600;
/** The worker idles this long after a job, and that's billed too. */
const IDLE_SECONDS = 5;

/**
 * The hook for charging what a job really cost: the GPU time a serverless provider billed for it, from its recipe
 * (lib/server/recipes), where each serverless step keeps RunPod's `executionTime` and `delayTime` in milliseconds. In
 * credits, or null when no step carries them (local ComfyUI jobs), and then the price list's charge stands.
 */
async function billedCredits(job: string): Promise<number | null> {
  const [{ readRecipe, machineKey }, { demoGpuId }] = await Promise.all([import("@/lib/server/recipes"), import("@/lib/server/comfy-targets")]);
  const recipe = await readRecipe(job).catch(() => null);
  const steps = (recipe?.steps ?? []) as { executionTime?: unknown; delayTime?: unknown; machine?: { key?: string } }[];
  // Only steps on the demo's own endpoint: one a visitor added runs on their RunPod account.
  const own = demoGpuId();
  const ownKey = own ? machineKey(own) : null;
  const billed = steps.filter((s) => (typeof s.executionTime === "number" || typeof s.delayTime === "number") && (!ownKey || s.machine?.key === ownKey));
  if (!billed.length) return null;
  const seconds = billed.reduce((sum, s) => sum + (Number(s.executionTime) || 0) / 1000 + (Number(s.delayTime) || 0) / 1000 + IDLE_SECONDS, 0);
  return Math.max(1, Math.ceil(seconds * SERVERLESS_USD_PER_SECOND * 200));
}
