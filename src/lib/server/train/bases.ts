import "server-only";
import { allLocalModels } from "../local-templates";
import { installedFiles } from "../local-models";
import { getJson, postJson } from "./comfy";
import type { LocalFile } from "@/lib/local/types";
import { fitTraining, type PlanMachine, type TrainFit } from "@/lib/train/plan";
import { profileById, profileForArchitecture, TRAIN_PROFILES, type TrainProfile, type TrainWeights } from "@/lib/train/profiles";
import type { TrainBase } from "@/lib/train/types";

/**
 * The model a LoRA trains on, as files on one machine: which of a family's weights fit its GPU, the text encoder and VAE
 * that go with them, what's there already and what a run downloads first. And your own model files: the ones in a
 * machine's models/diffusion_models and models/checkpoints that aren't Crackio's, read by the bridge to see what they are.
 * Everything here talks to `currentTarget()` (call inside `withTarget`).
 */

/** A catalog file by its name (any model, any version of it): where it downloads from, its size and checksum. */
export function catalogFile(name: string): LocalFile | null {
  for (const m of allLocalModels()) for (const v of m.variants) for (const f of v.files) if (f.name === name) return f;
  return null;
}

const fileOf = (w: TrainWeights) => w.file ?? catalogFile(w.name);

/** Bytes of each of a family's weights files (by file name), for the memory sums. */
export function weightSizes(profile: TrainProfile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of profile.weights) {
    const f = fileOf(w);
    if (f) out[w.name] = f.bytes;
  }
  return out;
}

export type ResolvedBase = {
  profile: TrainProfile;
  weights: TrainWeights;
  fit: TrainFit;
  /** How ComfyUI loads it. */
  loader: "parts" | "checkpoint";
  /** File names for the loaders. */
  files: { model: string; text?: string; vae?: string; dual?: string };
  folder: "diffusion_models" | "checkpoints";
  /** What isn't on the machine yet. */
  missing: LocalFile[];
  /** A file the catalog doesn't have a source for (a custom model's partner files are Crackio's; this is never it). */
  unknown: string[];
};

/** Weights standing for a model file of your own: its family's numbers, with its own size where the file says. */
export function customWeights(profile: TrainProfile, file: string, bytes?: number): TrainWeights {
  const like = profile.weights[0];
  const gb = bytes ? bytes / 1024 ** 3 : null;
  const likeGb = (fileOf(like)?.bytes ?? 0) / 1024 ** 3;
  // A file much smaller than the family's full weights is a quantized one: it holds less, and costs a little more a step.
  const small = gb !== null && likeGb > 0 && gb < likeGb * 0.7;
  return {
    id: "custom",
    label: "Your file",
    name: file,
    needGb: gb !== null && likeGb > 0 ? Math.max(3, like.needGb - likeGb + gb) : like.needGb,
    streamGb: like.streamGb,
    quantized: small,
    cost: small ? 1.25 : 1,
    ...(bytes ? { file: { role: "model", folder: "diffusion_models", name: file, url: "", bytes } } : {}),
  };
}

/**
 * A job's base on this machine: the weights that fit, the files to load them with, and what's missing. `settings` say
 * the picture size and LoRA size asked for; the fit may answer with a smaller picture size or streaming.
 */
export async function resolveBase(base: TrainBase, machine: PlanMachine, opts: { resolution: number; rank: number; meanMp?: number; customBytes?: number; weights?: string }): Promise<ResolvedBase | null> {
  const profile = profileById(base.family);
  if (!profile) return null;
  const have = await installedFiles().catch(() => new Set<string>());
  const there = (folder: string, name: string) => have.has(`${folder}/${name}`);
  const pick = (names: string[], folder: string) => names.find((n) => there(folder, n)) ?? names[0];
  const missing: LocalFile[] = [];
  const unknown: string[] = [];
  const need = (name: string | undefined, folder: LocalFile["folder"], own?: LocalFile) => {
    if (!name || there(folder, name)) return;
    const f = own ?? catalogFile(name);
    if (f?.url) missing.push({ ...f, folder });
    else unknown.push(name);
  };

  if (base.kind === "custom") {
    const weights = customWeights(profile, base.file, opts.customBytes);
    const fit = fitTraining(profile, machine, { ...opts, only: weights, sizes: opts.customBytes ? { [base.file]: opts.customBytes } : undefined });
    if (base.folder === "checkpoints") return { profile, weights, fit, loader: "checkpoint", files: { model: base.file }, folder: "checkpoints", missing, unknown };
    if (profile.loader.kind !== "parts") return null;
    const text = pick(profile.loader.text, "text_encoders");
    const vae = pick(profile.loader.vae, "vae");
    need(text, "text_encoders");
    need(vae, "vae");
    return { profile, weights, fit, loader: "parts", files: { model: base.file, text, vae }, folder: "diffusion_models", missing, unknown };
  }

  // `weights`: the ones a run has begun on. What it has learned is for those, so they aren't picked again (a machine
  // whose GPU wasn't known yet at Carry on was given the full-precision ones, and the run that had trained on INT8
  // found its kept state "for other settings" and started over).
  const pinned = opts.weights ? profile.weights.find((w) => w.id === opts.weights) : undefined;
  const fit = fitTraining(profile, machine, { ...opts, sizes: weightSizes(profile), ...(pinned ? { only: pinned } : {}) });
  const picked = fit.weights ?? pinned ?? profile.weights[0];
  const folder = profile.loader.kind === "checkpoint" ? "checkpoints" : "diffusion_models";
  need(picked.name, folder, picked.file);
  if (profile.loader.kind === "checkpoint") return { profile, weights: picked, fit, loader: "checkpoint", files: { model: picked.name }, folder, missing, unknown };
  const text = pick(profile.loader.text, "text_encoders");
  const vae = pick(profile.loader.vae, "vae");
  need(text, "text_encoders");
  need(vae, "vae");
  return { profile, weights: picked, fit, loader: "parts", files: { model: picked.name, text, vae }, folder, missing, unknown };
}

/* ------------------------------------------------------------------ your own model files */

export type ModelFacts = {
  folder: "diffusion_models" | "checkpoints";
  name: string;
  bytes: number;
  /** ComfyUI's name for its architecture ("Flux3", "SDXL"). */
  architecture?: string;
  /** Tensor values in the file (its parameters, about). */
  values?: number;
  dtypes?: Record<string, number>;
  quantized?: boolean;
  /** A step-distilled file (FLUX 3's fast model): not trainable. */
  distilled?: boolean;
  checkpoint?: boolean;
  has_text?: boolean;
  has_vae?: boolean;
  problem?: string;
};

export type CustomModel = {
  folder: "diffusion_models" | "checkpoints";
  file: string;
  bytes: number;
  /** The family it trains as, once read; null when Crackio can't train its architecture. */
  family: string | null;
  familyName: string | null;
  /** "FLUX 3 architecture · 5.6B values · 16-bit" */
  facts: string;
  /** Why it can't be trained, when it can't. */
  problem?: string;
};

const g = globalThis as unknown as { __crackioTrainFacts?: Map<string, ModelFacts> };
const factsCache = (g.__crackioTrainFacts ??= new Map());

/** Every catalog file name, to tell Crackio's own model files from yours. */
function catalogNames() {
  const names = new Set<string>();
  for (const m of allLocalModels()) for (const v of m.variants) for (const f of v.files) names.add(f.name);
  for (const p of TRAIN_PROFILES) for (const w of p.weights) names.add(w.name);
  return names;
}

const billions = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`);

function describe(f: ModelFacts): string {
  const bits = f.quantized ? "quantized" : f.dtypes ? (Object.entries(f.dtypes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "").replace(/^F(\d+)$/, "$1-bit").replace("BF16", "16-bit") : "";
  return [f.architecture ? `${f.architecture} architecture` : null, f.values ? `${billions(f.values)} values` : null, bits || null, f.checkpoint ? "all-in-one checkpoint" : null].filter(Boolean).join(" · ");
}

/**
 * Model files on the machine that aren't Crackio's own, each read by its bridge (name, size, architecture). Machines
 * without the bridge's training routes (a serverless endpoint) answer with none.
 */
export async function customModels(targetId: string): Promise<{ models: CustomModel[]; folderHint: string | null }> {
  const listing = await getJson<{ models?: { folder: string; name: string; bytes: number; dir?: string }[] }>("/crackio/train/models", 20_000);
  if (!listing?.models) return { models: [], folderHint: null };
  const known = catalogNames();
  const mine = listing.models.filter((m) => !known.has(m.name.split("/").pop() ?? m.name) && m.bytes > 200 * 1024 ** 2);
  const out: CustomModel[] = [];
  for (const m of mine.slice(0, 40)) {
    const key = `${targetId}|${m.folder}|${m.name}|${m.bytes}`;
    let facts = factsCache.get(key);
    if (!facts) {
      const res = await postJson<ModelFacts & { error?: string }>("/crackio/train/inspect", { folder: m.folder, name: m.name }, 120_000).catch(() => null);
      facts = res?.ok && res.data ? res.data : { folder: m.folder as ModelFacts["folder"], name: m.name, bytes: m.bytes, problem: res?.data?.error ?? "Crackio couldn't read this file." };
      // Only what was read is remembered: a file that couldn't be is asked about again next time.
      if (res?.ok && facts.architecture) factsCache.set(key, facts);
    }
    const profile = profileForArchitecture(facts.architecture);
    const partsOnly = facts.checkpoint === false || m.folder === "diffusion_models";
    let problem = facts.problem;
    if (!problem && facts.distilled) problem = "This is a fast, step-distilled model: it can't be trained on. Train on its Base version; the LoRA runs on this one.";
    if (!problem && !profile) problem = facts.architecture ? `Crackio can't train ${facts.architecture} models yet.` : "ComfyUI doesn't recognise this file as a picture model.";
    // A kind Crackio keeps off the page isn't offered through your own file of it either.
    if (!problem && profile?.hold) problem = `Crackio doesn't train ${profile.name} yet (${profile.hold.charAt(0).toLowerCase()}${profile.hold.slice(1)}).`;
    if (!problem && m.folder === "checkpoints" && !(facts.has_text && facts.has_vae)) problem = "This checkpoint has no text encoder or VAE inside: put the file in models/diffusion_models instead.";
    if (!problem && partsOnly && profile?.loader.kind === "checkpoint") problem = `${profile.name} trains from an all-in-one checkpoint: put a full checkpoint in models/checkpoints.`;
    out.push({ folder: m.folder as CustomModel["folder"], file: m.name, bytes: m.bytes, family: problem ? null : (profile?.id ?? null), familyName: profile?.name ?? null, facts: describe(facts), ...(problem ? { problem } : {}) });
  }
  const dir = listing.models.find((m) => m.folder === "diffusion_models")?.dir ?? null;
  return { models: out, folderHint: dir };
}
