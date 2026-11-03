import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { DATA_DIR } from "./paths";
import { RECIPES_DIR } from "./recipes";
import { urlToPath } from "./media";
import { mediaInfo } from "./media-info";
import { modelById } from "@/lib/models/catalog";
import { VOICE_MODELS } from "@/lib/voice/models";
import { shortGpuName } from "@/lib/local/fit";
import { toolBySlug } from "@/lib/tools";
import type { MediaRef } from "@/lib/generations/types";
import type { JobRecipe, RecipeStep } from "@/lib/recipes/recipe";
import type { UsageDay, UsageDays, UsageMachine, UsageModel, UsageStorage, UsageSummary, UsageTool, UsageTotals } from "@/lib/usage/types";

/**
 * Settings → Usage (lib/usage/types): every number from the most honest record of it.
 *
 * - Counts, outcomes, days, tools, storage and failures per model: the `generations` table (server/db), one row per take
 *   from every tool. A deleted take's row goes with it. Error "Cancelled." is cancelled; "Stopped when Crackio restarted."
 *   counts as failed, and apart as interrupted; any other error is failed.
 * - Where a take ran and ComfyUI's working time: its recipe (data/recipes, server/recipes), the only record of either.
 *   Kept since Oct 29, 2026, and only for takes that finished, so a failed or older take has no machine (`machine: null`).
 * - The comparison with Crackio's estimates: the Local page's measured runs (data/local-speeds.json, `recordSpeed` in
 *   server/local-models), which keep the estimate made beforehand (`e`) beside the seconds ComfyUI took (`s`).
 *
 * It only reads: recipes go through JSON.parse here, never `readRecipe` (which can write one back).
 */

/* ------------------------------------------------------------------ takes (generations) */

type Row = {
  id: string;
  createdAt: number;
  status: string;
  tool: string;
  engine: string | null;
  model: string | null;
  modelName: string | null;
  error: string | null;
  finishedAt: number | null;
  outputs: string | null;
};

// Only the fields used, pulled out by SQLite: prompts, references and tool settings stay in the database.
const ROWS = `SELECT id, created_at AS createdAt, status, tool,
    json_extract(data, '$.engine') AS engine, json_extract(data, '$.model') AS model, json_extract(data, '$.modelName') AS modelName,
    json_extract(data, '$.error') AS error, json_extract(data, '$.finishedAt') AS finishedAt, json_extract(data, '$.outputs') AS outputs
  FROM generations WHERE created_at >= ? AND created_at <= ?`;

type Outcome = "done" | "failed" | "interrupted" | "cancelled" | "running";

function outcomeOf(r: Row): Outcome {
  if (r.status === "done") return "done";
  if (r.status !== "error") return "running";
  // The runner's and db.ts's own words for these two.
  return r.error === "Cancelled." ? "cancelled" : r.error === "Stopped when Crackio restarted." ? "interrupted" : "failed";
}

function filesOf(json: string | null): MediaRef[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as unknown;
    return Array.isArray(list) ? (list.filter((o) => o && typeof o === "object" && typeof (o as MediaRef).url === "string") as MediaRef[]) : [];
  } catch {
    return [];
  }
}

// Lookups by ids read from takes are Maps: a tool a script named "constructor" finds nothing, not Object's own.
type Made = "pictures" | "clips" | "audio" | "other";
const MADE = new Map<string, Made>([
  ["image", "pictures"],
  ["video", "clips"],
  ["audio", "audio"],
]);
/** What a finished take made: its first file's kind. One with no file (a Motion turn that only answered) is "other". */
const madeBy = (files: MediaRef[]): Made => MADE.get(files[0]?.kind ?? "") ?? "other";

/** Engines by name. Grok, ChatGPT, fal and OpenAI left on Oct 30 (Crackio went ComfyUI-only); their takes keep the ids. */
const ENGINES = new Map([
  ["comfy-local", "ComfyUI"],
  ["comfy-cloud", "Comfy Router"],
  ["grok", "Grok (removed)"],
  ["codex", "ChatGPT (removed)"],
  ["fal", "fal (removed)"],
  ["openai-api", "OpenAI API (removed)"],
  ["auto", "None picked"],
]);
const LEGACY = new Map([
  ["grok", "Grok"],
  ["codex", "ChatGPT"],
  ["fal", "fal"],
  ["openai-api", "OpenAI"],
]);

/** A take that failed before its engine was picked still names its model, whose id says the engine. */
const ENGINE_OF: [RegExp, string][] = [
  [/^local:/, "comfy-local"],
  [/^comfy:/, "comfy-cloud"],
  [/^grok:/, "grok"],
  [/^(codex|chatgpt):/, "codex"],
  [/^fal:/, "fal"],
  [/^openai:/, "openai-api"],
];
const engineOf = (engine: string | null, model: string) => (engine && engine !== "auto" ? engine : (ENGINE_OF.find(([re]) => re.test(model))?.[1] ?? "auto"));

/** Every open model's catalog name says "(your GPU)": not here, where the machine has its own column. */
const plain = (name: string) => name.replace(/\s*\(your GPU\)/gi, "").trim();

function modelName(model: string, saved: Map<string, number> | undefined) {
  if (model === "auto") return "None (failed before a model was picked)";
  if (model === "unknown") return "Not recorded";
  const known = modelById(model)?.name ?? VOICE_MODELS.find((m) => m.id === model)?.name ?? (model === "local:lipsync:latentsync" ? "LatentSync 1.6" : undefined);
  // Else the name its takes were saved with most often (the templates' models, the removed engines' ones).
  const usual = [...(saved ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  return plain(known ?? usual ?? model) || model;
}

/** Tools that aren't on the tools list (lib/tools), which names the rest ("recast" is Swap). */
const TOOL_NAMES = new Map([
  ["image", "Create"],
  ["video", "Video"],
  ["create", "API & scripts"],
  ["templates", "Templates"],
  ["showcase", "Showcase demos"],
  ["home", "Home"],
]);
const toolName = (tool: string) => TOOL_NAMES.get(tool) ?? toolBySlug(tool)?.name ?? (tool.charAt(0).toUpperCase() + tool.slice(1) || "Unknown");

/* ------------------------------------------------------------------ recipes: machines and times */

/** One graph a recipe kept: its GPU, the machine's name, and ComfyUI's working time. */
type Graph = { key: string; gpu: string; where: string; rented: boolean; at: number; ms: number; timed: boolean };
/** What usage needs from one recipe: its graphs, the GPU its main graph ran on, and the take's own ComfyUI time there. */
type Kept = { id: string; createdAt: number; graphs: Graph[]; gpu: string | null; ownMs: number | null };

/**
 * Rented by its name ("RTX 5090 · vast.ai", "… · RunPod", "RunPod Serverless", "Comfy Cloud") or its bill. A rented box you
 * renamed reads as your own: recipes keep no more than the name.
 */
const RENTED = /vast\.ai|runpod|serverless|comfy cloud|cloud gpu|rented/i;
const gpuOf = (s: RecipeStep) => (s.machine?.gpu || s.machine?.label || "").trim() || "unknown";

function keptOf(raw: string): Kept | null {
  let r: JobRecipe;
  try {
    r = JSON.parse(raw) as JobRecipe;
  } catch {
    return null;
  }
  if (!r || typeof r.id !== "string" || !Array.isArray(r.steps)) return null;
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : 0;
  const graphs: Graph[] = [];
  for (const s of r.steps) {
    if (s?.kind !== "comfyui" || !s.machine) continue;
    const ms = typeof s.ms === "number" ? s.ms : typeof s.executionMs === "number" ? s.executionMs : null;
    graphs.push({
      // A take that reuses an earlier take's result (a swap's first frame) lists its graph too: each graph counts once.
      key: s.promptId || `${s.machine.key}@${s.at}@${s.name}`,
      gpu: gpuOf(s),
      where: (s.machine.label || "").trim(),
      rented: [s.executionTime, s.delayTime, s.executionMs, s.comfyCredits].some((v) => v !== undefined) || RENTED.test(`${s.machine.label} ${s.machine.gpu ?? ""}`),
      at: typeof s.at === "number" ? s.at : createdAt,
      // ComfyUI's own working time; a graph that never ran (ComfyUI unreachable) kept none and adds nothing.
      ms: ms ?? 0,
      timed: ms !== null,
    });
  }
  const main = r.steps[r.main];
  const gpu = main?.kind === "comfyui" && main.machine ? gpuOf(main) : null;
  // The take's own graphs on that machine: a reused one was sent before this take was made.
  const own = gpu ? graphs.filter((s) => s.gpu === gpu && s.timed && s.at >= createdAt) : [];
  return { id: r.id, createdAt, graphs, gpu, ownMs: own.length ? own.reduce((n, s) => n + s.ms, 0) : null };
}

const RECIPE_FILE = /^[\w-]{1,80}\.json$/;
// On globalThis, so a reload in development keeps what's been read; a new `KEPT` drops it when `Kept` changes shape.
const KEPT = 2;
const g = globalThis as unknown as { __crackioUsageRecipes?: { v: number; files: Map<string, Kept | null> } };
let scanning: Promise<Map<string, Kept>> | null = null;

/** Every recipe (two summaries asked at once share one look at the folder). */
const recipes = () => (scanning ??= scanRecipes().finally(() => (scanning = null)));

/**
 * Each recipe file read once: a new one when it appears, a deleted one forgotten. A kept recipe's machines and times never
 * change (`readRecipe` may write one again, scrubbed, with the same steps).
 */
async function scanRecipes(): Promise<Map<string, Kept>> {
  const store = g.__crackioUsageRecipes?.v === KEPT ? g.__crackioUsageRecipes : (g.__crackioUsageRecipes = { v: KEPT, files: new Map() });
  const names = (await fs.readdir(/*turbopackIgnore: true*/ RECIPES_DIR).catch(() => [] as string[])).filter((n) => RECIPE_FILE.test(n));
  const here = new Set(names);
  for (const name of [...store.files.keys()]) if (!here.has(name)) store.files.delete(name);
  const fresh = names.filter((n) => !store.files.has(n));
  for (let i = 0; i < fresh.length; i += 32) {
    await Promise.all(
      fresh.slice(i, i + 32).map(async (name) => {
        // One Windows won't let us read this moment (mid-rename) is read next time.
        const raw = await fs.readFile(path.join(/*turbopackIgnore: true*/ RECIPES_DIR, name), "utf8").catch(() => null);
        if (raw !== null) store.files.set(name, keptOf(raw));
      }),
    );
  }
  const byId = new Map<string, Kept>();
  for (const k of store.files.values()) if (k) byId.set(k.id, k);
  return byId;
}

/* ------------------------------------------------------------------ estimates (local-speeds) */

/** server/local-models keeps it: GPU name → model (its id without "local:") → its last runs. */
const SPEEDS_FILE = path.join(DATA_DIR, "local-speeds.json");
type SpeedRun = { s?: number; e?: number; at?: number };
type SpeedEntry = { runs?: SpeedRun[] };
type Speeds = Record<string, Record<string, SpeedEntry | undefined> | undefined>;

async function readSpeeds(): Promise<Speeds> {
  try {
    const all = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ SPEEDS_FILE, "utf8")) as unknown;
    return all && typeof all === "object" ? (all as Speeds) : {};
  } catch {
    return {};
  }
}

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** A GPU's speeds: under its name, else (a Mac, "Apple silicon (Metal)" in recipes) under the one Apple chip measured. */
function speedsOn(speeds: Speeds, gpu: string) {
  if (has(speeds, gpu)) return speeds[gpu];
  if (!/^apple/i.test(gpu)) return undefined;
  const macs = Object.keys(speeds).filter((k) => /^apple/i.test(k));
  return macs.length === 1 ? speeds[macs[0]] : undefined;
}

/** How a model's main graph took against what Crackio estimated beforehand, on these GPUs, in the range. */
function versusEstimate(speeds: Speeds, gpus: Iterable<string>, model: string, from: number, to: number) {
  if (!model.startsWith("local:")) return { vs: null, runs: 0 };
  const entries = new Set<SpeedEntry>();
  const id = model.slice("local:".length);
  for (const gpu of gpus) {
    const mine = speedsOn(speeds, gpu);
    const e = mine && typeof mine === "object" && has(mine, id) ? mine[id] : undefined;
    if (e && typeof e === "object") entries.add(e);
  }
  const ratios: number[] = [];
  for (const e of entries) {
    for (const r of Array.isArray(e.runs) ? e.runs : []) {
      if (typeof r.s === "number" && r.s > 0 && typeof r.e === "number" && r.e > 0 && typeof r.at === "number" && r.at >= from && r.at <= to) ratios.push(r.s / r.e);
    }
  }
  return { vs: ratios.length ? round(median(ratios) - 1, 2) : null, runs: ratios.length };
}

/* ------------------------------------------------------------------ the summary */

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hours = (ms: number) => round(ms / 3_600_000, 3);
const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-11-02", in this computer's time zone. */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Midnight, `back` days before the day of `ms`, local time. */
function midnight(ms: number, back = 0) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

type ModelAcc = { model: string; engineId: string; machine: string | null; gpus: Set<string>; runs: number; times: number[]; failed: number; lastAt: number | null };
type MachineAcc = { ms: number; rentedMs: number; runs: number; where: Set<string> };

const STORED = new Set<string>(["image", "video", "audio"]);

/**
 * Sizes of files saved before outputs carried one (null: not on disk), read from disk. media-info keeps each answer, and the
 * Library reads the same files' sizes, so this costs once per server start.
 */
async function sizesOf(urls: string[]): Promise<Map<string, number | null>> {
  const sizes = new Map<string, number | null>();
  for (let i = 0; i < urls.length; i += 32) {
    const batch = urls.slice(i, i + 32);
    const got = await Promise.all(
      batch.map(async (url) => {
        const file = urlToPath(url);
        return file ? ((await mediaInfo(file).catch(() => null))?.bytes ?? null) : null;
      }),
    );
    batch.forEach((url, j) => sizes.set(url, got[j]));
  }
  return sizes;
}

async function summarize(days: UsageDays, machine: string | undefined): Promise<UsageSummary> {
  const to = Date.now();
  // Files are read while the database answers: the recipes, the measured speeds, and any take's file without a size.
  const keptP = recipes();
  const speedsP = readSpeeds();
  const all = db()
    .prepare(ROWS)
    .all(days ? midnight(to, days - 1) : 0, to) as Row[];
  const filesById = new Map<string, MediaRef[]>();
  const unsizedUrls: string[] = [];
  for (const r of all) {
    const files = filesOf(r.outputs);
    filesById.set(r.id, files);
    for (const o of files) if (STORED.has(o.kind) && !(typeof o.bytes === "number" && o.bytes >= 0)) unsizedUrls.push(o.url);
  }
  const [kept, speeds, sizes] = await Promise.all([keptP, speedsP, sizesOf(unsizedUrls)]);
  let first = to;
  for (const r of all) if (r.createdAt < first) first = r.createdAt;
  const from = days ? midnight(to, days - 1) : midnight(first);

  const wanted = machine?.toLowerCase();
  const isWanted = (gpu: string | null | undefined) => Boolean(gpu && wanted && (shortGpuName(gpu).toLowerCase() === wanted || gpu.toLowerCase() === wanted));

  // Machines, by GPU: every graph in the range once, by when it was sent; runs are finished takes by their main graph.
  const machines = new Map<string, MachineAcc>();
  const machineOf = (gpu: string) => {
    const label = shortGpuName(gpu);
    let m = machines.get(label);
    if (!m) machines.set(label, (m = { ms: 0, rentedMs: 0, runs: 0, where: new Set() }));
    return m;
  };
  const counted = new Set<string>();
  let gpuMs = 0;
  let rentedMs = 0;
  for (const k of kept.values()) {
    for (const s of k.graphs) {
      if (s.at < from || s.at > to || counted.has(s.key)) continue;
      counted.add(s.key);
      const m = machineOf(s.gpu);
      m.ms += s.ms;
      if (s.rented) m.rentedMs += s.ms;
      if (s.where) m.where.add(s.where);
      if (wanted && !isWanted(s.gpu)) continue;
      gpuMs += s.ms;
      if (s.rented) rentedMs += s.ms;
    }
  }
  for (const r of all) {
    const gpu = r.status === "done" ? kept.get(r.id)?.gpu : null;
    if (gpu) machineOf(gpu).runs++;
  }

  // One machine: the takes known to have run there, which are finished ones (a failure keeps no recipe).
  const rows = wanted ? all.filter((r) => isWanted(kept.get(r.id)?.gpu)) : all;

  const totals: UsageTotals = {
    generations: rows.length,
    done: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    firstTry: null,
    gpuHours: hours(gpuMs),
    rentedHours: hours(rentedMs),
    pictures: 0,
    clips: 0,
    audio: 0,
  };
  const dayList = new Map<string, UsageDay>();
  for (const d = new Date(from); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    const day = dayOf(d.getTime());
    dayList.set(day, { day, pictures: 0, clips: 0, audio: 0, other: 0, failed: 0 });
  }
  const tools = new Map<string, UsageTool>();
  const models = new Map<string, ModelAcc>();
  const savedNames = new Map<string, Map<string, number>>();
  const storage: Record<UsageStorage["kind"], UsageStorage> = {
    image: { kind: "image", files: 0, bytes: 0 },
    video: { kind: "video", files: 0, bytes: 0 },
    audio: { kind: "audio", files: 0, bytes: 0 },
  };
  let unknown = 0;
  const legacy = new Set<string>();

  // By engine too: takes that kept no model id ("unknown") stay apart per engine.
  const modelOf = (r: Row, gpu: string | null) => {
    const model = r.model?.trim() || "unknown";
    const engineId = engineOf(r.engine, model);
    const label = gpu ? shortGpuName(gpu) : null;
    const key = `${model}\n${engineId}\n${label ?? ""}`;
    let a = models.get(key);
    if (!a) models.set(key, (a = { model, engineId, machine: label, gpus: new Set(), runs: 0, times: [], failed: 0, lastAt: null }));
    if (gpu) a.gpus.add(gpu);
    const when = r.finishedAt ?? r.createdAt;
    if (a.lastAt === null || when > a.lastAt) a.lastAt = when;
    if (r.modelName) {
      let saved = savedNames.get(model);
      if (!saved) savedNames.set(model, (saved = new Map()));
      saved.set(r.modelName, (saved.get(r.modelName) ?? 0) + 1);
    }
    return a;
  };

  for (const r of rows) {
    const outcome = outcomeOf(r);
    const day = dayList.get(dayOf(r.createdAt));
    let tool = tools.get(r.tool);
    if (!tool) tools.set(r.tool, (tool = { tool: r.tool, label: toolName(r.tool), done: 0, failed: 0, cancelled: 0 }));
    const files = filesById.get(r.id) ?? [];
    for (const o of files) {
      if (!STORED.has(o.kind)) continue;
      const s = storage[o.kind];
      s.files++;
      const bytes = typeof o.bytes === "number" && o.bytes >= 0 ? o.bytes : sizes.get(o.url);
      if (typeof bytes === "number") s.bytes += bytes;
      else unknown++;
    }
    const removed = LEGACY.get(engineOf(r.engine, r.model?.trim() ?? ""));
    if (removed) legacy.add(removed);

    if (outcome === "done") {
      totals.done++;
      tool.done++;
      const made = madeBy(files);
      if (made !== "other") totals[made]++;
      if (day) day[made]++;
      const k = kept.get(r.id);
      const a = modelOf(r, k?.gpu ?? null);
      a.runs++;
      if (k?.gpu && k.ownMs !== null) a.times.push(k.ownMs / 1000);
    } else if (outcome === "cancelled") {
      totals.cancelled++;
      tool.cancelled++;
    } else if (outcome === "failed" || outcome === "interrupted") {
      totals.failed++;
      if (outcome === "interrupted") totals.interrupted++;
      tool.failed++;
      if (day) day.failed++;
      modelOf(r, null).failed++;
    }
  }
  // A failed take is the model's or its machine's doing, a cancelled one yours; one machine's view has no failures to count.
  totals.firstTry = !wanted && totals.done + totals.failed > 0 ? round(totals.done / (totals.done + totals.failed), 3) : null;

  const modelRows: UsageModel[] = [...models.values()]
    .map((a) => {
      const est = a.machine ? versusEstimate(speeds, a.gpus, a.model, from, to) : { vs: null, runs: 0 };
      return {
        model: a.model,
        name: modelName(a.model, savedNames.get(a.model)),
        engine: ENGINES.get(a.engineId) ?? a.engineId,
        engineId: a.engineId,
        machine: a.machine,
        runs: a.runs,
        medianSeconds: a.times.length ? round(median(a.times), 1) : null,
        fastestSeconds: a.times.length ? round(a.times.reduce((x, y) => Math.min(x, y)), 1) : null,
        vsEstimate: est.vs,
        estimateRuns: est.runs,
        failed: a.failed,
        lastAt: a.lastAt,
      };
    })
    .sort((x, y) => y.runs + y.failed - (x.runs + x.failed) || x.name.localeCompare(y.name) || (x.machine ?? "").localeCompare(y.machine ?? ""));

  const machineRows: UsageMachine[] = [...machines]
    .map(([label, m]) => ({ machine: label, gpuHours: hours(m.ms), rentedHours: hours(m.rentedMs), runs: m.runs, where: [...m.where].sort() }))
    .sort((x, y) => y.gpuHours - x.gpuHours || y.runs - x.runs || x.machine.localeCompare(y.machine));

  const toolRows = [...tools.values()].sort((x, y) => y.done + y.failed + y.cancelled - (x.done + x.failed + x.cancelled) || x.label.localeCompare(y.label));

  const notes: string[] = [];
  let since: number | null = null;
  for (const k of kept.values()) if (k.createdAt > 0 && (since === null || k.createdAt < since)) since = k.createdAt;
  if (wanted) notes.push("Only finished takes say where they ran, so one machine's view has no failures and no first-try rate.");
  else if (modelRows.some((m) => m.machine === null))
    notes.push(`Where a take ran, and for how long, is known ${since ? `since ${shortDate(since)} ` : ""}for takes that finished on a ComfyUI. Older and failed takes show no machine.`);
  notes.push("Deleted takes aren't counted.");
  if (totals.interrupted) notes.push(`${plural(totals.interrupted, "take")} stopped when Crackio restarted ${totals.interrupted === 1 ? "counts" : "count"} as failed.`);
  if (legacy.size) notes.push(`Takes made with ${list([...LEGACY.values()].filter((name) => legacy.has(name)))} still count: Crackio has run on ComfyUI only since Oct 30.`);
  if (totals.rentedHours > 0) notes.push("Rented time is ComfyUI's working time, not what was billed: a rented box also bills while it waits.");
  notes.push("Storage counts each take's own files, not uploads, models or caches.");
  if (unknown) notes.push(`${plural(unknown, "file")} of these takes ${unknown === 1 ? "isn't" : "aren't"} on disk any more: ${unknown === 1 ? "its" : "their"} size isn't counted.`);

  return {
    range: { days, from, to },
    totals,
    days: [...dayList.values()],
    tools: toolRows,
    models: modelRows,
    machines: machineRows,
    storage: [storage.image, storage.video, storage.audio],
    notes,
  };
}

const TTL = 60_000;
const answers = new Map<string, { at: number; value: Promise<UsageSummary> }>();

/** Settings → Usage for the last `days` days (null: everything), optionally one GPU ("RTX 5090"); each answer kept a minute. */
export async function usageSummary(opts: { days: UsageDays; machine?: string }): Promise<UsageSummary> {
  const days = opts.days ?? null;
  const machine = opts.machine?.trim() || undefined;
  const key = `${days ?? "all"}|${machine?.toLowerCase() ?? ""}`;
  const now = Date.now();
  const hit = answers.get(key);
  if (hit && now - hit.at < TTL) return hit.value;
  for (const [k, v] of answers) if (now - v.at >= TTL || answers.size > 32) answers.delete(k);
  const value = summarize(days, machine);
  answers.set(key, { at: now, value });
  value.catch(() => {
    if (answers.get(key)?.value === value) answers.delete(key);
  });
  return value;
}
