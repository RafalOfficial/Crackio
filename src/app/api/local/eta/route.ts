import { z } from "zod";
import { jobUnits, picturePlan, recipeFor } from "@/lib/engines/comfy-local-recipes";
import type { EngineJob } from "@/lib/engines/types";
import { watchRentedBoxes } from "@/lib/server/cloud-accounts";
import { demoGpuId, withTarget } from "@/lib/server/comfy-targets";
import { demoFull, demoOn } from "@/lib/demo/config";
import { estimateContext, estimateFor, localModelReady, machinesFor, pickTarget } from "@/lib/server/local-models";
import { getSettings } from "@/lib/server/settings";
import { pricePerSecond } from "@/lib/server/serverless/runpod";
import { basisLabel } from "@/lib/local/estimate";
import { speedModeFor } from "@/lib/local/work";
import type { Machine } from "@/lib/local/types";

type Recipe = NonNullable<ReturnType<typeof recipeFor>>;

/**
 * Room on a machine to redraw a picture at full size beside the model, as the engine checks it before it does
 * (comfy-local): 16 GB of memory on a GPU PyTorch drives as CUDA (NVIDIA, or AMD on ROCm), or a Mac with 32 GB.
 */
const roomyOn = (m: Machine | null) => (m ? (m.accel === "mps" ? m.ramGb >= 32 : (m.accel === "cuda" || m.accel === "rocm") && (m.gpus[0]?.memoryGb ?? 0) >= 16) : false);

/** A job's work on a machine, as the engine counts it there: a redraw it has no room for counts as on a GPU too slow for one. */
function unitsOn(recipe: Recipe, job: EngineJob, perUnit: number | null, machine: Machine | null, referenceMp?: number) {
  const plan = picturePlan(recipe, job, perUnit);
  return jobUnits(recipe, job, referenceMp, plan?.detail && !roomyOn(machine) ? Infinity : perUnit);
}

const Body = z.object({
  model: z.string().startsWith("local:"),
  kind: z.enum(["image", "video", "upscale"]).default("image"),
  count: z.number().int().min(1).max(8).default(1),
  references: z.number().int().min(0).max(16).default(0),
  duration: z.number().min(1).max(60).optional(),
  resolution: z.string().max(16).optional(),
  /** The picture's shape (width / height), for the size a resolution comes to. */
  ratio: z.number().min(0.2).max(5).optional(),
  /** An upscale: the picture's size and the factor asked (its work grows with them). */
  source: z.object({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) }).optional(),
  scale: z.number().min(1).max(8).optional(),
  /** Advanced's "Never enlarge": the picture stays at the largest size the model draws by itself. */
  nativeOnly: z.boolean().optional(),
});

/**
 * How long a local job will take, before it runs, on the machine it would run on (the same pick as the engine's: the one
 * chosen to run on, else Auto's): local/estimate from that machine's own runs, Crackio's benchmarks of its card or its
 * series, and what the machine is doing now. With a likely range, where the number comes from, the same job without its
 * reference pictures, and every machine it could run on with its time there, for the "Run on" pickers.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request." }, { status: 400 });
  // A GPU just rented on your cloud account joins the machines to run on.
  watchRentedBoxes();
  const b = parsed.data;
  const id = b.model.slice("local:".length);
  const recipe = recipeFor(id);
  if (!recipe || (await localModelReady(b.model).catch(() => null)) !== true) return Response.json({ eta: null });
  const job = {
    kind: b.kind,
    count: b.count,
    references: Array.from({ length: b.references }, () => ({ path: "" })),
    options: {
      ...(b.duration ? { duration: b.duration } : {}),
      ...(b.resolution ? { resolution: b.resolution } : {}),
      ...(b.nativeOnly ? { nativeOnly: true } : {}),
      ...(b.source ? { sourceWidth: b.source.width, sourceHeight: b.source.height } : {}),
      ...(b.scale ? { scale: b.scale } : {}),
    },
    width: Math.round(1024 * Math.sqrt(b.ratio ?? 1)),
    height: Math.round(1024 / Math.sqrt(b.ratio ?? 1)),
  } as unknown as EngineJob;
  const mode = speedModeFor(recipe.output, job.kind, job.references.length);
  const target = await pickTarget(id);
  const estimateHere = withTarget(target, async () => {
    const ctx = await estimateContext(id).catch(() => null);
    if (!ctx) return null;
    // The pace first: on a slow card the recipe shrinks reference pictures, which changes the work.
    const pace = estimateFor(ctx, mode, 1);
    if (!pace) return null;
    const referenceMp = recipe.referenceMp?.(job, pace.perUnit) ?? 1;
    // How a picture comes to the size asked: drawn there, or drawn at the most the model draws well and then redrawn
    // lightly at the size (a fast GPU) or enlarged (a slow one).
    const plan = picturePlan(recipe, job, pace.perUnit);
    // The redraw at full size needs room for that many pixels beside the model, as the engine checks it (comfy-local):
    // 16 GB of GPU memory, or a Mac with 32 GB. Without it the picture is enlarged: the line says so, and the time
    // leaves the redraw out as the engine does (it stood at about three times the real time on a quick 12 GB card).
    const roomy = roomyOn(ctx.machine);
    const e = estimateFor(ctx, mode, unitsOn(recipe, job, pace.perUnit, ctx.machine, referenceMp));
    if (!e) return null;
    const size = plan
      ? {
          native: `${plan.native.width}×${plan.native.height}`,
          target: `${plan.target.width}×${plan.target.height}`,
          how: plan.kept ? "kept" : plan.factor <= 1.02 ? "native" : plan.detail && roomy ? "detail" : "enlarge",
          // The size's name, for the line ("4K here: …"), and the size picked when "Never enlarge" held the picture below it.
          asked: `${plan.asked.width}×${plan.asked.height}`,
        }
      : null;
    // The same job without its pictures, for the hint that they're what makes it long.
    const plain = b.references && b.kind === "image" ? estimateFor(ctx, "t2i", jobUnits(recipe, { ...job, references: [] }, undefined, pace.perUnit)) : null;
    return {
      seconds: Math.round(e.seconds),
      low: Math.round(e.low),
      high: Math.round(e.high),
      measured: e.basis === "measured",
      basis: e.basis,
      why: basisLabel(e),
      runs: e.runs,
      load: Math.round(e.load),
      busy: Math.round(e.busy),
      offload: Math.round(e.offload),
      gpu: ctx.gpu,
      machine: target.label,
      referenceMp: b.references && b.kind === "image" ? referenceMp : null,
      plain: plain ? Math.round(plain.seconds) : null,
      size,
      target: target.id,
      // When that machine is a Mac: how hot it is, its battery and energy mode (its bridge's /crackio/live).
      mac: ctx.live.mac ?? null,
      // A billed machine: RunPod's price a second for its GPU (the line shows the job's cost, not "free").
      billing: target.serverless ? { perSecond: pricePerSecond(ctx.gpu) } : target.metered === "comfy-cloud" ? { credits: true } : null,
    };
  });
  const [eta, machines, settings] = await Promise.all([estimateHere, machinesFor(id, mode, (perUnit, machine) => unitsOn(recipe, job, perUnit, machine, perUnit ? recipe.referenceMp?.(job, perUnit) : undefined)).catch(() => []), getSettings()]);
  // The machine chosen to run on (one since removed is Auto again), and when the job can't go there: offline, or without
  // the model.
  const asked = settings.runOn ? machines.find((m) => m.id === settings.runOn) : undefined;
  const runOn = asked?.id ?? "auto";
  const fallback = asked && asked.id !== target.id ? (asked.note ? "unavailable" : asked.online ? "no-model" : "offline") : null;
  return Response.json(
    {
      eta,
      runOn,
      fallback,
      demo: demoOn() ? { charged: !demoFull() || runOn === "auto" || runOn === demoGpuId() } : null,
      machines: machines.map((m) => ({
        id: m.id,
        label: m.label,
        gpu: m.gpu,
        online: m.online,
        hasModel: m.hasModel,
        queue: m.queue,
        ...(m.note ? { note: m.note } : {}),
        cloud: m.cloud,
        here: m.onThisComputer,
        seconds: m.estimate ? Math.round(m.estimate.seconds) : null,
        measured: m.estimate?.basis === "measured",
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
