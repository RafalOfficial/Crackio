import "server-only";
import type { ResolvedBase } from "./bases";
import type { TrainJob, TrainSettings } from "@/lib/train/types";

/**
 * The ComfyUI graphs a training run queues: one that prepares the pictures (the model's own text encoder and VAE turn
 * them into what the model learns from, kept on the machine), then one per stretch of training (the model's loader and
 * Crackio's trainer, which carries on from where the last stretch stopped). Nodes: comfyui/crackio_bridge/train.py.
 */

type Node = { class_type: string; inputs: Record<string, unknown> };
export type Graph = Record<string, Node>;

/** What the cache on the machine is for: another model family, text encoder or VAE encodes the pictures again. */
export const signatureOf = (base: ResolvedBase) => [base.profile.id, base.files.text ?? base.files.model, base.files.vae ?? "", base.files.dual ?? ""].join("|");

function loaders(base: ResolvedBase): { graph: Graph; model: [string, number]; clip: [string, number]; vae: [string, number] } {
  if (base.loader === "checkpoint") {
    return { graph: { ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: base.files.model } } }, model: ["ckpt", 0], clip: ["ckpt", 1], vae: ["ckpt", 2] };
  }
  const kind = base.profile.loader.kind === "parts" ? base.profile.loader : null;
  const graph: Graph = {
    model: { class_type: "UNETLoader", inputs: { unet_name: base.files.model, weight_dtype: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: base.files.vae } },
    clip: kind?.dual && base.files.dual
      ? { class_type: "DualCLIPLoader", inputs: { clip_name1: base.files.dual, clip_name2: base.files.text, type: kind.dual.type, device: "default" } }
      : { class_type: "CLIPLoader", inputs: { clip_name: base.files.text, type: kind?.clipType ?? "stable_diffusion", device: "default" } },
  };
  return { graph, model: ["model", 0], clip: ["clip", 0], vae: ["vae", 0] };
}

/**
 * Pictures (names in the machine's input folder) and their words into the job's cache. An edit LoRA's items are pairs:
 * `source` is the before picture, `file` the after picture, `caption` the instruction.
 */
export function prepareGraph(job: TrainJob, base: ResolvedBase, items: { file: string; caption: string; source?: string }[], resolution: number): Graph {
  const l = loaders(base);
  const { model: _model, ...rest } = l.graph;
  void _model;
  return {
    ...(base.loader === "checkpoint" ? l.graph : rest),
    data: {
      class_type: "CrackioTrainData",
      inputs: {
        vae: l.vae,
        clip: l.clip,
        job: job.id,
        items: JSON.stringify(items),
        resolution,
        grid: base.profile.grid,
        signature: signatureOf(base),
        // The same names once more, each a value of its own: a serverless endpoint sends along the files a graph names.
        files: { names: items.flatMap((i) => (i.source ? [i.file, i.source] : [i.file])) },
        // How the model takes a pair's before picture (helper 1.14).
        ...(items.some((i) => i.source) ? { edit: base.profile.edit ?? "reference" } : {}),
      },
    },
  };
}

export type Stretch = {
  /** The step this stretch stops at (the next version to save, or the end). */
  stopAt: number;
  /** Seconds it may run before it stops by itself (a serverless job's time limit). */
  budget: number;
  /** Start over: what was trained so far doesn't fit the settings any more. */
  fresh?: boolean;
  /** Push every correction this much harder or gentler (after a loss that stopped being a number). */
  lrScale?: number;
};

/** The steps versions are saved at: evenly through the run, on round numbers; the last is the end of the run. */
export function saveSteps(settings: Pick<TrainSettings, "steps" | "checkpoints">): number[] {
  const n = Math.max(1, Math.min(20, Math.round(settings.checkpoints)));
  const round = settings.steps >= 1000 ? 50 : settings.steps >= 300 ? 25 : 10;
  const out = new Set<number>();
  for (let k = 1; k < n; k++) {
    const s = Math.round((settings.steps * k) / n / round) * round;
    if (s > 0 && s < settings.steps) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

/** The LoRA's file name stem: the job's name in plain letters, and a piece of its id so two never collide. */
export function loraStem(job: Pick<TrainJob, "name" | "id">) {
  const plain = job.name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  return `${plain || "lora"}-${job.id.slice(0, 5)}`;
}

/** The trainer's settings for one stretch (train.py's `config`). */
export function trainConfig(job: TrainJob, base: ResolvedBase, settings: TrainSettings, stretch: Stretch, extra: Record<string, unknown> = {}) {
  const p = base.profile;
  return {
    name: loraStem(job),
    steps: settings.steps,
    rank: settings.rank,
    alpha: settings.rank,
    lr: settings.lr,
    warmup: Math.min(200, Math.round(settings.steps * 0.1)),
    schedule: "constant",
    timestep: p.timestep,
    loss: "target",
    ...(p.flow ? {} : { snr_gamma: 5 }),
    ...(p.guidance !== undefined ? { guidance: p.guidance } : {}),
    caption_dropout: Math.max(0, Math.min(50, settings.captionDropout)) / 100,
    seed: settings.seed,
    save_at: saveSteps(settings),
    stop_at: stretch.stopAt,
    budget_s: stretch.budget,
    save_every_s: 240,
    offload: settings.offload,
    checkpointing: true,
    // What this training needs of the GPU, so the trainer can refuse in words when other programs leave less: with
    // part of the model in RAM (asked for, or the way out of too little memory) that's the streamed need. It stood at
    // the whole model's whatever was tried, so every way out of a crowded card was refused the same.
    ...(base.fit.needGb ? { need_gb: Math.round((settings.offload ? Math.min(base.fit.needGb, base.fit.streamedGb ?? base.fit.needGb) : base.fit.needGb) * 10) / 10 } : {}),
    // The step it carries on from: a trainer that finds nothing kept for it says so, where it used to start at 0
    // quietly with Crackio still showing this step.
    ...(job.progress.step > 0 && !stretch.fresh ? { resume_step: job.progress.step } : {}),
    base: `${p.id}:${base.weights.id}:${base.files.model}`,
    ...(stretch.fresh ? { fresh: true } : {}),
    ...(stretch.lrScale && stretch.lrScale !== 1 ? { lr_scale: stretch.lrScale } : {}),
    export: true,
    meta: {
      "crackio.job": job.id,
      "crackio.name": job.name,
      "crackio.family": p.id,
      "crackio.trigger": job.goal === "edit" ? "" : job.trigger,
      "crackio.base": base.files.model,
      ...(job.goal === "edit" ? { "crackio.edit": p.edit ?? "reference", "crackio.instruction": (job.instruction ?? "").slice(0, 300) } : {}),
    },
    ...extra,
  };
}

/** One stretch of training (or, with `finalize`, the LoRA saved as it stands). */
export function trainGraph(job: TrainJob, base: ResolvedBase, config: Record<string, unknown>): Graph {
  const l = loaders(base);
  const graph: Graph = base.loader === "checkpoint" ? l.graph : { model: l.graph.model };
  return { ...graph, train: { class_type: "CrackioTrainLora", inputs: { model: l.model, job: job.id, config: JSON.stringify(config) } } };
}
