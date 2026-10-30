import { BENCHMARKS, type Benchmark } from "./benchmarks";
import { downloadGb, gpuScale, mainGpu } from "./fit";
import { gpuClass, gpuKeyOf } from "./gpu-series";
import type { LocalModel, LocalVariant, MacHeat, Machine } from "./types";
import { LOAD_GB_PER_S, type SpeedMode } from "./work";

/**
 * How long a job will take on one machine, as close to what it will really take as Crackio can tell. Client-safe.
 *
 * 1. A starting point for this model on this GPU: Crackio's benchmarks (local/benchmarks) of the same card, else its
 *    series' (an RTX 4060 from the RTX 40 cards that ran), else every card that ran the model, each carried over by the
 *    cards' speed (fit's gpuScale); a model nobody benchmarked starts from its catalog time.
 * 2. What this machine has taught: every job it runs is kept (local-models `recordSpeed`). Its runs of this model, the
 *    recent ones and the ones of a similar size first, outweigh the starting point after a run or two; its runs of the
 *    other models tell how it compares with the benchmarks (a laptop's power limit, a slower bus, a busier desktop),
 *    and that carries over to models it hasn't run yet.
 * 3. The machine right now: memory free on the GPU (what doesn't fit streams from RAM each step, over the PCIe link),
 *    other apps keeping the GPU busy, the model already loaded or not (loading at the speed this machine's disk showed).
 */

/** One run a machine kept (local-models `recordSpeed`): seconds, work units, model loaded or not, kind, when, and what was estimated before it. */
export type Run = { s: number; u: number; warm: boolean; mode?: SpeedMode; variant?: string; at?: number; e?: number };
/** One GPU's record of every model it ran (local-models' speeds file, by model key). */
export type MachineRuns = Record<string, { variant?: string; runs?: Run[] }>;

/** What the machine is doing now (local-models `liveHere`): each one optional. */
export type Live = {
  /** GPU memory models can use now, in GB (what other apps hold left out). */
  freeGb?: number;
  /** How busy other apps keep the GPU, 0–1. */
  busy?: number;
  /** What the GPU's PCIe link carries, GB/s (its generation and lanes). */
  pcieGBps?: number;
  /** The model is loaded already (the last job here ran it). */
  loaded?: boolean;
  /** A Mac: how hot it is and its battery (shown on the Local page; the bridge rests between steps while it's hot). */
  mac?: MacHeat;
};

export type Basis = "measured" | "same-gpu" | "series" | "others" | "catalog";

export type Estimate = {
  /** The whole job, in seconds. */
  seconds: number;
  /** A likely range for it. */
  low: number;
  high: number;
  /** Seconds per unit of work at the conditions now, loading apart. */
  perUnit: number;
  /** What loading the model adds to this job (0 when it's loaded). */
  load: number;
  /** Of `seconds`: weights streaming from RAM, and the wait other apps on the GPU cause. */
  offload: number;
  busy: number;
  basis: Basis;
  /** This model's runs on this machine behind it. */
  runs: number;
  /** Where the starting point came from: "RTX 4070", "RTX 40 cards", "8 cards". */
  from: string | null;
  /** This machine next to its starting points, learned from its runs (1 = as benchmarked). */
  factor: number;
};

const SPREAD: Record<Basis, number> = { measured: 0.12, "same-gpu": 0.18, series: 0.28, others: 0.38, catalog: 0.55 };

/** How much a published timing counts next to one of Crackio's runs, by how sure its source is. */
const REPORTED_TRUST = { high: 0.5, medium: 0.3, low: 0.12 };

/** Compute capability by architecture, for a benchmark's card (fit's precision costs need it). */
const COMPUTE: Record<string, number> = { blackwell: 12, hopper: 9, ada: 8.9, ampere: 8.6, turing: 7.5, volta: 7, pascal: 6.1, maxwell: 5.2 };

/** A benchmark's machine, as much of one as fit's scale reads. */
export function benchMachine(b: Benchmark): Machine {
  const c = gpuClass(b.gpu);
  const unified = c.vendor === "apple";
  const name = c.vendor === "nvidia" && /^(RTX|GTX) d/i.test(b.gpu) ? `NVIDIA GeForce ${b.gpu}` : b.gpu;
  return {
    where: "comfyui",
    label: b.gpu,
    os: { family: b.os, name: b.os, arch: "" },
    cpu: null,
    ramGb: unified ? b.vram : 64,
    gpus: [{ name, vendor: c.vendor === "other" ? "nvidia" : c.vendor, memoryGb: b.vram, unified, ...(c.vendor === "nvidia" ? { compute: COMPUTE[c.arch] } : {}) }],
    diskFreeGb: null,
    accel: unified ? "mps" : c.vendor === "amd" ? "rocm" : c.vendor === "intel" ? "xpu" : "cuda",
    modelMemoryGb: b.vram,
    comfy: { url: "", torch: b.build === "cu12" ? "2.10.0+cu128" : "2.10.0+cu130" },
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** The weighted median of values (log space). */
function weightedMedian(items: { x: number; w: number }[]) {
  const s = [...items].sort((a, b) => a.x - b.x);
  const total = s.reduce((n, i) => n + i.w, 0);
  let acc = 0;
  for (const i of s) {
    acc += i.w;
    if (acc >= total / 2) return i.x;
  }
  return s.at(-1)?.x ?? NaN;
}

/** A first run's time with its loading taken out: its files at the speed rented boxes loaded them. */
const warmFromCold = (coldPerUnit: number, units: number, v: LocalVariant | undefined) =>
  Math.max(coldPerUnit * 0.35, coldPerUnit - (v ? downloadGb(v) / LOAD_GB_PER_S : 0) / Math.max(units, 0.1));

/**
 * How much a first run says about the pace, 0.4–1: what loading the files could have taken (at a slow disk's 0.25 GB/s)
 * next to the run. A 0.1 GB upscaler's first minute is all work; a 6 GB picture model's first run was a third loading on
 * a GTX 1060 (100 s against 67).
 */
const coldTrust = (r: Run, v: LocalVariant) => Math.min(1, Math.max(0.4, 1 - (2 * downloadGb(v)) / 0.25 / Math.max(r.s, 0.1)));

/** The jobs a model's other kind of job stands in for: an edit's pace from its pictures', and back. */
const MODE_TWIN: Partial<Record<SpeedMode, SpeedMode>> = { edit: "t2i", t2i: "edit" };

type Start = { perUnit: number; basis: Exclude<Basis, "measured">; from: string | null };

/**
 * The starting point for a model's version on this machine, per unit of work: benchmarks of the same card first, then its
 * series', then any card's, carried over by the cards' speed; else the catalog's RTX 5090 time scaled to the card.
 */
export function startingPoint(machine: Machine, model: LocalModel, v: LocalVariant, mode: SpeedMode, key = recipeKey(model), bench: Benchmark[] = BENCHMARKS): Start | null {
  const scale = gpuScale(machine, v);
  if (!scale) return null;
  const gpu = mainGpu(machine);
  const mine = gpu ? gpuKeyOf(gpu.name) : "";
  const cls = gpu ? gpuClass(gpu.name, gpu.compute) : null;
  // Every benchmark of this model, as the RTX 5090 time of this version it implies.
  const items: { x: number; w: number; tier: number; gpu: string }[] = [];
  for (const b of bench) {
    if (b.model !== key) continue;
    const sameMode = b.mode === mode;
    if (!sameMode && MODE_TWIN[mode] !== b.mode) continue;
    const bv = model.variants.find((x) => x.id === b.variant);
    if (!bv) continue;
    const bm = benchMachine(b);
    const bScale = gpuScale(bm, bv);
    if (!bScale) continue;
    const t = b.warm ?? (b.cold !== undefined ? warmFromCold(b.cold, b.units, bv) : null);
    if (!t) continue;
    // Its card's time → that version's RTX 5090 time → this version's (the catalog's ratio between the two).
    const s5090 = (t / bScale) * (v.seconds5090 / bv.seconds5090);
    const bc = gpuClass(b.gpu);
    const same = gpuKeyOf(b.gpu) === mine;
    const tier = same ? 3 : cls && bc.series === cls.series ? 2 : cls && bc.arch === cls.arch ? 1.5 : 1;
    // A card with tensor cores says little about one without (a GTX 10 ran LTX-2.5 five times slower than its ratio).
    const kin = !cls || bc.tensorCores === cls.tensorCores ? 1 : 0.2;
    // Published timings (other workflows, settings converted) count less than Crackio's own runs.
    const trust = b.source === "reported" ? REPORTED_TRUST[b.confidence ?? "low"] : 1;
    const w = (same ? 12 : tier === 2 ? 4 : tier === 1.5 ? 2 : 1) * kin * trust * (b.variant === v.id ? 1 : 0.35) * (sameMode ? 1 : 0.5) * (b.warm ? 1 : 0.5) * Math.min(1, 0.4 + b.runs * 0.2);
    items.push({ x: Math.log(s5090), w, tier, gpu: b.gpu });
  }
  if (!items.length) return { perUnit: v.seconds5090 * scale, basis: "catalog", from: null };
  const best = Math.max(...items.map((i) => i.tier));
  // The closest cards decide; farther ones only when nothing closer ran it. Thin evidence (another version, a card of
  // another kind, a first run, a published number) takes every card's in, then the catalog's own time.
  const sum = (xs: typeof items) => xs.reduce((n, i) => n + i.w, 0);
  let pool = items.filter((i) => i.tier >= best);
  if (sum(pool) < 0.5) pool = items;
  if (sum(pool) < 0.5) pool = [...pool, { x: Math.log(v.seconds5090), w: 0.5 - sum(pool), tier: 0, gpu: "" }];
  const near = pool.filter((i) => i.gpu);
  const s5090 = Math.exp(weightedMedian(pool));
  const cards = [...new Set(near.map((i) => i.gpu))];
  const top = Math.max(...near.map((i) => i.tier));
  const basis = top === 3 ? "same-gpu" : top === 2 ? "series" : "others";
  const from = basis === "same-gpu" ? cards[0] : basis === "series" && cls ? `${cls.series} cards` : cards.length === 1 ? cards[0] : `${cards.length} cards`;
  return { perUnit: s5090 * scale, basis, from };
}

/** The key a model's runs are kept under: the recipe it runs with. */
export const recipeKey = (model: LocalModel) => (model.crackio ?? model.id).replace(/^local:/, "");

/**
 * How this machine compares with its starting points, from every model it ran (runs with the model loaded): 1 when it
 * runs as benchmarked. Pulled toward 1 while it has run little, so one odd run doesn't skew every estimate.
 */
export function machineFactor(machine: Machine, models: LocalModel[], runs: MachineRuns | undefined, except?: string) {
  if (!runs) return 1;
  let num = 0;
  let den = 1.5;
  for (const [key, e] of Object.entries(runs)) {
    if (key === except || !e.variant) continue;
    const model = models.find((m) => recipeKey(m) === key);
    const v = model?.variants.find((x) => x.id === e.variant);
    if (!model || !v) continue;
    for (const mode of ["t2i", "edit", "clip", "upscale"] as SpeedMode[]) {
      const warm = (e.runs ?? []).filter((r) => r.warm && (r.mode ?? mainMode(model)) === mode).map((r) => r.s / r.u);
      if (!warm.length) continue;
      const start = startingPoint(machine, model, v, mode, key);
      if (!start) continue;
      const w = Math.min(4, warm.length);
      num += w * Math.log(median(warm) / start.perUnit);
      den += w;
    }
  }
  return Math.min(3, Math.max(1 / 3, Math.exp(num / den)));
}

/** A model's main kind of job, for runs kept before kinds were. */
export const mainMode = (model: LocalModel): SpeedMode => (model.tasks.includes("upscale") ? "upscale" : model.unit === "clip" ? "clip" : "t2i");

/**
 * What this machine's own runs of the model say, per unit: the recent ones and those near this job's size count most
 * (a model's small pictures cost more per megapixel than its big ones). Null when it hasn't run here.
 */
function fromRuns(model: LocalModel, v: LocalVariant, mode: SpeedMode, work: number, record: MachineRuns[string] | undefined) {
  // Runs of another version, or of one nobody noted when the model has several, say little about this one.
  if (!record?.runs?.length || (record.variant ? record.variant !== v.id : model.variants.length > 1)) return null;
  const all = record.runs.filter((r) => r.s > 0 && r.u > 0);
  const pick = (m: SpeedMode) => all.filter((r) => (r.mode ?? mainMode(model)) === m);
  let mine = pick(mode);
  let twin = false;
  if (!mine.length && MODE_TWIN[mode]) {
    mine = pick(MODE_TWIN[mode]!);
    twin = true;
  }
  if (!mine.length) return null;
  // With the model loaded its pace shows plainly; first runs that loading weighed on then only tell what it adds (a small
  // model's first runs are as good as any). Before any, they're the pace.
  const trusted = mine.filter((r) => r.warm || coldTrust(r, v) >= 0.9);
  const paced = mine.some((r) => r.warm) ? trusted : mine;
  const items = paced.map((r, i) => {
    const age = paced.length - 1 - i;
    const recency = Math.pow(0.5, age / 10);
    const size = Math.exp(-Math.pow(Math.log(r.u / Math.max(work, 0.05)), 2) / (2 * 0.8 * 0.8));
    const perUnit = r.warm ? r.s / r.u : warmFromCold(r.s / r.u, r.u, v);
    return { x: Math.log(perUnit), w: recency * (0.15 + size) * (r.warm ? 1 : coldTrust(r, v)) * (twin ? 0.5 : 1), r };
  });
  const x = weightedMedian(items);
  const n = items.reduce((s, i) => s + i.w, 0);
  // How far its runs stray from their middle: the range shown.
  const spread = items.length >= 3 ? Math.min(0.5, Math.max(0.06, median(items.map((i) => Math.abs(i.x - x))) * 1.5)) : null;
  // What loading added on this machine: a first run's time less its work at the loaded pace.
  const cold = all.filter((r) => !r.warm);
  const pace = Math.exp(x);
  const load = cold.length && mine.some((r) => r.warm) ? Math.max(0, median(cold.map((r) => r.s - pace * r.u))) : null;
  return { perUnit: pace, weight: n, count: mine.length, spread, load };
}

/** How fast this machine's disk loads models, GB/s: from the first runs it timed, else the speed rented boxes showed. */
export function diskSpeed(models: LocalModel[], runs: MachineRuns | undefined) {
  const speeds: number[] = [];
  for (const [key, e] of Object.entries(runs ?? {})) {
    const model = models.find((m) => recipeKey(m) === key);
    const v = model?.variants.find((x) => x.id === e.variant);
    const rs = e.runs ?? [];
    const warm = rs.filter((r) => r.warm).map((r) => r.s / r.u);
    if (!v || !warm.length) continue;
    const pace = median(warm);
    for (const r of rs.filter((x) => !x.warm)) {
      const loadS = r.s - pace * r.u;
      if (loadS > 1) speeds.push(downloadGb(v) / loadS);
    }
  }
  return speeds.length ? Math.min(6, Math.max(0.05, median(speeds))) : LOAD_GB_PER_S;
}

/** PCIe link to GB/s that weights streaming from pageable RAM really get (about 60% of the link). */
export function pcieGBps(gen?: number | null, width?: number | null) {
  if (!gen || !width) return null;
  const perLane = gen >= 5 ? 3.94 : gen === 4 ? 1.97 : gen === 3 ? 0.985 : 0.5;
  return perLane * width * 0.6;
}

/** Denoising passes over the model's weights in a job (each streams what doesn't fit): its steps, else a typical count. */
const passesOf = (v: LocalVariant, model: LocalModel) => v.steps ?? (model.tasks.includes("upscale") ? 1 : model.unit === "clip" ? 8 : 20);

export function estimateJob(o: {
  machine: Machine;
  model: LocalModel;
  variant: LocalVariant;
  mode: SpeedMode;
  /** The job's work (local/work units). */
  work: number;
  /** Every model this GPU ran (its speeds record), for its own runs and how it compares. */
  runs?: MachineRuns;
  /** All models, to read the other runs against. */
  models?: LocalModel[];
  live?: Live;
}): Estimate | null {
  const { machine, model, variant: v, mode, live = {} } = o;
  const work = Math.max(0.05, o.work);
  const key = recipeKey(model);
  const start = startingPoint(machine, model, v, mode, key);
  if (!start) return null;
  const models = o.models ?? [model];
  const factor = machineFactor(machine, models, o.runs, key);
  const prior = start.perUnit * factor;
  const own = fromRuns(model, v, mode, work, o.runs?.[key]);
  // Its own runs outweigh the starting point after a run or two (k: the starting point's weight in runs, less the farther
  // it is from other cards), and the more they disagree with it, the less it counts: a time carried over from other cards
  // can be plain wrong for this one (a GTX 1080 Ti's small Nomos2 HQ runs put a GTX 1060's picture at 250 s; it took 64).
  const k0 = start.basis === "same-gpu" ? 1 : start.basis === "series" ? 0.6 : start.basis === "others" ? 0.45 : 0.3;
  const miss = own ? Math.log2(own.perUnit / prior) : 0;
  const k = k0 / (1 + miss * miss);
  const perUnit = own ? Math.exp((own.weight * Math.log(own.perUnit) + k * Math.log(prior)) / (own.weight + k)) : prior;
  const basis: Basis = own ? "measured" : start.basis;

  // Memory now: what doesn't fit streams from RAM every pass, over the PCIe link (Linux). GGUF models stream their layers
  // themselves, cheaply anywhere (a GTX 1060 under Windows ran Qwen-Image 2.1's GGUF 1.26× slower spilling 4.8 GB); on
  // Windows the others meet the driver lending the GPU system memory, far slower (Z-Image Turbo ran ~5× slower there).
  const gpu = mainGpu(machine);
  const budget = live.freeGb ?? machine.modelMemoryGb;
  const spill = gpu && !gpu.unified && budget ? Math.max(0, v.needGb - budget) : 0;
  let offloadFactor = 1;
  let offloadAdd = 0;
  if (spill > 0.2 && !own) {
    const share = spill / Math.max(1, gpu?.memoryGb ?? budget);
    if (/^gguf/.test(v.id)) offloadFactor = 1 + 0.5 * share;
    else if (machine.os.family === "windows") offloadFactor = Math.min(6, 1 + 6 * share);
    else offloadAdd = (passesOf(v, model) * spill * Math.max(1, work)) / (live.pcieGBps ?? 8);
  }
  // Other apps on the GPU take their share of it.
  const busy = Math.min(0.8, Math.max(0, live.busy ?? 0));
  const busyFactor = 1 / (1 - busy * 0.9);
  // RAM short of the model's files: the OS pages them in and out.
  const paging = !gpu?.unified && downloadGb(v) > machine.ramGb * 0.85 ? 2 : 1;
  const compute = perUnit * work * offloadFactor * paging;
  const run = compute * busyFactor + offloadAdd;
  const load = live.loaded ? 0 : (own?.load ?? (downloadGb(v) / diskSpeed(models, o.runs)));
  const seconds = run + load;
  const spread = own?.spread ?? (own ? SPREAD.measured : SPREAD[basis]) + (spill > 0.2 ? 0.1 : 0);
  return {
    seconds,
    low: run * Math.exp(-spread) + load * 0.7,
    high: run * Math.exp(spread) + load * 1.4,
    perUnit,
    load,
    offload: offloadAdd + perUnit * work * (offloadFactor - 1),
    busy: compute * (busyFactor - 1),
    basis,
    runs: own?.count ?? 0,
    from: start.from,
    factor,
  };
}

/** Where a time comes from, for the page: "12 runs here", "benchmarked on an RTX 4070", "from RTX 40 cards", "estimated". */
export function basisLabel(e: Pick<Estimate, "basis" | "runs" | "from">) {
  if (e.basis === "measured") return `${e.runs} run${e.runs === 1 ? "" : "s"} here`;
  if (e.basis === "same-gpu") return `benchmarked on this card`;
  if (e.basis === "catalog") return "estimated";
  return `from benchmarks on ${e.from ?? "other cards"}`;
}
