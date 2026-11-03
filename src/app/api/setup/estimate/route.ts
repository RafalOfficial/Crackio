import { z } from "zod";
import { jobUnits, recipeFor } from "@/lib/engines/comfy-local-recipes";
import type { EngineJob } from "@/lib/engines/types";
import { targetById, withTarget } from "@/lib/server/comfy-targets";
import { estimateContext, estimateFor } from "@/lib/server/local-models";
import { allLocalModels } from "@/lib/server/local-templates";
import { setupSnapshot } from "@/lib/server/setup/status";
import { recipeKey } from "@/lib/local/estimate";
import { speedModeFor } from "@/lib/local/work";
import { fitVariant, shortGpuName } from "@/lib/local/fit";
import { recentTakes, sizeClass } from "@/lib/server/setup/takes";
import { apiQuote } from "@/lib/setup/api-prices";
import { SAFETY, type SetupEstimate } from "@/lib/setup/knobs";

/**
 * Settings' estimate: how long one job takes with a model's version on one machine, before it's installed there, and what
 * that time costs on a rented GPU, next to the price of the same job on the model's official API. The time is the tools'
 * own (local/estimate from that machine's runs, Crackio's benchmarks of its card or series, its recipe's units for the
 * job), shown 7% slower (setup/knobs SAFETY) so it's a promise kept.
 */

const Body = z.object({
  machine: z.string().min(1).max(80),
  /** Catalog id ("ltx-2.5"). */
  model: z.string().min(1).max(80),
  variant: z.string().min(1).max(60),
  kind: z.enum(["image", "video", "upscale", "swap", "voice"]),
  seconds: z.number().min(1).max(60).optional(),
  resolution: z.string().max(16).optional(),
  count: z.number().int().min(1).max(8).optional(),
  scale: z.number().min(1).max(8).optional(),
  source: z.object({ width: z.number().int().min(16).max(20_000), height: z.number().int().min(16).max(20_000) }).optional(),
  clip: z.boolean().optional(),
  references: z.number().int().min(0).max(4).optional(),
});

/**
 * A voice job: Voice's own pace for each model (server/voice/run, its progress bar), seconds of speech after a warm-up,
 * three times slower on a GPU under 24 GB, where the model shares the card or RAM. Rough: Voice doesn't time its runs per
 * card yet.
 */
function voiceEstimate(model: string, speech: number, machine: { gpu: { memoryGb: number | null } | null; label: string; pricePerHour: number | null; priceFrom: string | null }): SetupEstimate {
  const perSecond = model === "local:voice:drama3" ? 0.7 : model === "local:voice:voxcpm2" ? 0.6 : 0.25;
  // A "24 GB" card reports 23.5 GiB: it counts as one.
  const big = (machine.gpu?.memoryGb ?? 8) >= 22;
  const seconds = 6 + speech * perSecond * (big ? 1 : 3);
  const shown = seconds * SAFETY;
  const perHour = machine.pricePerHour;
  return {
    seconds,
    shown,
    low: seconds * 0.7,
    high: seconds * 1.5 * SAFETY,
    load: 20,
    basis: `Voice's own pace for this model (${perSecond * (big ? 1 : 3)} s per second of speech on a ${big ? "24 GB or bigger" : "smaller"} GPU), not yet timed on this card`,
    measured: false,
    gpu: machine.label,
    price: perHour ? { perHour, from: machine.priceFrom ?? "your cloud", job: (shown * perHour) / 3600, firstJob: ((shown + 20) * perHour) / 3600 } : null,
    api: apiQuote(model, { kind: "voice", seconds: speech }),
  };
}

/**
 * What an estimate reads from a machine (its card, its runs, what's installed), kept for half a minute per machine and
 * model: moving a slider then costs only the math, not four requests to a box across the world.
 */
type Ctx = NonNullable<Awaited<ReturnType<typeof estimateContext>>>;
const g = globalThis as unknown as { __crackioSetupEstimateCtx?: Map<string, { at: number; ctx: Promise<Ctx | null> }> };
const contexts = (g.__crackioSetupEstimateCtx ??= new Map<string, { at: number; ctx: Promise<Ctx | null> }>());

function contextFor(machine: string, key: string, target: Parameters<typeof withTarget>[0]): Promise<Ctx | null> {
  const id = `${machine}:${key}`;
  const hit = contexts.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.ctx;
  const ctx = withTarget(target, () => estimateContext(key)).catch(() => null);
  contexts.set(id, { at: Date.now(), ctx });
  for (const [k, v] of contexts) if (Date.now() - v.at > 120_000) contexts.delete(k);
  return ctx;
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request." }, { status: 400 });
  const b = parsed.data;
  const snap = await setupSnapshot();
  const machine = snap.machines.find((m) => m.id === b.machine);
  if (!machine) return Response.json({ error: "That computer isn't one of your machines." }, { status: 404 });
  if (!machine.online) return Response.json({ error: `${machine.label} isn't answering.` }, { status: 409 });
  if (b.model.startsWith("local:voice:")) return Response.json({ estimate: voiceEstimate(b.model, b.seconds ?? 30, machine) }, { headers: { "Cache-Control": "no-store" } });
  const model = allLocalModels().find((m) => m.id === b.model);
  if (!model?.variants.some((v) => v.id === b.variant)) return Response.json({ error: "Crackio doesn't know that model." }, { status: 404 });
  const key = recipeKey(model);
  const recipe = recipeFor(key);
  const api = apiQuote(model.id, b);
  if (!recipe) return Response.json({ estimate: null, api, why: "Crackio can't time this one yet." });

  const job = {
    kind: b.kind === "swap" ? "video" : b.kind,
    count: b.count ?? 1,
    references: Array.from({ length: b.references ?? 0 }, () => ({ path: "" })),
    options: {
      ...(b.seconds ? { duration: b.seconds } : {}),
      ...(b.resolution ? { resolution: b.resolution } : {}),
      ...(b.source ? { sourceWidth: b.source.width, sourceHeight: b.source.height } : {}),
      ...(b.scale ? { scale: b.scale } : {}),
    },
    ...(b.clip ? { source: { path: "" } } : {}),
    width: 1024,
    height: 1024,
  } as unknown as EngineJob;

  const target = await targetById(machine.id).catch(() => null);
  if (!target) return Response.json({ error: `${machine.label} isn't answering.` }, { status: 409 });
  const ctx = await contextFor(machine.id, key, target);
  const out = await withTarget(target, async () => {
    if (!ctx) return null;
    // The version asked, even one not on the machine: its first run loads it.
    const variant = ctx.model.variants.find((v) => v.id === b.variant);
    if (!variant) return null;
    // On a free GPU: Settings plans a job, so what the machine happens to be doing now (another job) doesn't count.
    const asked = { ...ctx, variant, live: { ...ctx.live, busy: 0, loaded: ctx.variant.id === variant.id ? ctx.live.loaded : false } };
    const mode = speedModeFor(recipe.output, job.kind, job.references.length);
    const pace = estimateFor(asked, mode, 1);
    if (!pace) return null;
    let units = jobUnits(recipe, job, undefined, pace.perUnit);
    // A clip upscaler without units of its own counts a 5 s clip as one.
    if (b.clip && !recipe.units) units *= (b.seconds ?? 5) / 5;
    const e = estimateFor(asked, mode, units);
    if (!e) return null;
    // Not run here yet: the time comes from other cards, shifted by how fast this machine ran other models, and that shift
    // can carry another box's oddities (runs are kept by card name: a 4090 with 21 GB of RAM made every 4090 look slow,
    // so the next one looked twice as fast as benchmarked). Never promise more than the benchmarks alone do.
    // A second look: the model's measured RTX 5090 time scaled to this card (the model library's fit). A card's series can
    // say less than what a faster card measured (RTX 40 benchmarks put Wan 2.2 5B at 7 s on a 4090 where a 5090 took 13).
    // Only where it fits the card whole: a version that spills into RAM has a rough penalty in that fit, and the card's
    // own benchmarks (GTX 10 runs on a GTX 1060) know better. Not over a benchmark of this very card either.
    if (e.basis === "series" || e.basis === "others" || e.basis === "catalog") {
      const plain = estimateFor({ ...asked, runs: undefined }, mode, units);
      const fit = fitVariant(ctx.machine, variant);
      const whole = fit.state === "great" || fit.state === "ok";
      const floor = Math.max(plain ? plain.seconds - plain.load : 0, whole && fit.seconds !== null ? fit.seconds * units : 0);
      const run = e.seconds - e.load;
      if (floor > run) {
        const k = floor / Math.max(0.1, run);
        return { e: { ...e, seconds: floor + e.load, low: (e.low - e.load * 0.7) * k + e.load * 0.7, high: (e.high - e.load * 1.4) * k + e.load * 1.4 }, gpu: ctx.gpu, units };
      }
    }
    return { e, gpu: ctx.gpu, units };
  });
  if (!out) return Response.json({ estimate: null, api, why: `Crackio couldn't time it on ${machine.label}.` });
  const { gpu, units } = out;
  let e = out.e;
  // Whole takes: a tool that runs more than its model (a swap's looks, redraws, checks and both passes) takes longer than
  // the model's pass the math times. Where three or more takes of this model finished on this card, their pace per unit
  // of the recipe's work, every step counted, is the floor (RTX 5090 swaps: a median 4 min a take, where the Ripple pass
  // alone is well under one).
  let takes = 0;
  if ((b.kind === "video" || b.kind === "swap") && recipe.units) {
    const unitsOf = recipe.units;
    const rates = (await recentTakes())
      .filter((t) => t.model === `local:${key}` && t.seconds && shortGpuName(t.gpu) === gpu)
      .map((t) => t.spanMs / 1000 / Math.max(0.05, unitsOf({ ...job, options: { ...job.options, duration: t.seconds!, resolution: sizeClass(t.width, t.height) } } as EngineJob)))
      .sort((x, y) => x - y);
    if (rates.length >= 3) {
      const whole = rates[Math.floor(rates.length / 2)] * units;
      const run = e.seconds - e.load;
      if (whole > run) {
        const k = whole / Math.max(0.1, run);
        e = { ...e, seconds: whole + e.load, low: (e.low - e.load * 0.7) * k + e.load * 0.7, high: (e.high - e.load * 1.4) * k + e.load * 1.4 };
        takes = rates.length;
      }
    }
  }
  const warm = Math.max(0.1, e.seconds - e.load);
  const shown = warm * SAFETY;
  const perHour = machine.pricePerHour;
  const estimate: SetupEstimate = {
    seconds: warm,
    shown,
    low: Math.max(0.1, e.low - e.load * 0.7),
    high: Math.max(0.1, e.high - e.load * 1.4) * SAFETY,
    load: e.load,
    basis: takes
      ? `From ${takes} whole ${b.kind === "swap" ? "swaps" : "clips"} on ${gpu} machines, every step counted (not only the model's pass)`
      : e.basis === "measured"
        ? `From ${e.runs} run${e.runs === 1 ? "" : "s"} on ${gpu} machines like this one`
        : e.basis === "same-gpu"
          ? `From Crackio's benchmarks of the ${gpu}`
          : e.basis === "catalog"
            ? "A rough estimate from the model's size: a run here makes it exact"
            : `From Crackio's benchmarks on ${e.from ?? "other cards"}`,
    measured: e.basis === "measured",
    gpu,
    price: perHour ? { perHour, from: machine.priceFrom ?? "your cloud", job: (shown * perHour) / 3600, firstJob: ((shown + e.load) * perHour) / 3600 } : null,
    api,
  };
  return Response.json({ estimate }, { headers: { "Cache-Control": "no-store" } });
}
