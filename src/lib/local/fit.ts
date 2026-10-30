import type { Fit, Gpu, LocalModel, LocalTask, LocalVariant, Machine } from "./types";

/**
 * Whether a model runs on a machine, which of its variants to install, and roughly how fast. Speeds start
 * from a measured RTX 5090 time and scale by the GPU's diffusion throughput; a variant that doesn't fit in
 * the GPU's memory spills into RAM on NVIDIA (ComfyUI streams the rest each step, which costs time) and
 * doesn't run on a Mac (unified memory has nowhere else to go).
 */

/**
 * Diffusion throughput next to an RTX 5090 (same format), first match wins. NVIDIA ratios follow measured
 * FLUX/ComfyUI runs (3090 0.38, 4070 0.30, 5060 Ti 0.24, 3060 0.14), Crackio's own on rented cards (Oct 2026: 5070 Ti
 * 0.42, 4060 Ti 0.23, 3060 Ti 0.17, 2080 Ti 0.19, the other RTX 20 cards scaled with it), published cross-card ComfyUI
 * benchmarks where two or more agree (SDXL, FLUX.1 dev, FLUX.2 klein 9B and MiniMax H3 tables: 4090 0.7, 3090 0.35, L40S
 * 0.68, RTX A5000 0.32, A4000 0.24, 4060 0.15, 5060 Ti 0.26; scripts/local/reported-times.json) and spec ratios elsewhere; Apple Silicon
 * in its own table (APPLE, by GPU cores); AMD (ROCm) and Intel (XPU) from community ComfyUI runs, ±50%. A GPU's first run
 * on the Local page replaces all of this. Oct 2026.
 */
const SPEED: [RegExp, number][] = [
  [/b300|gb300/i, 1.2],
  [/rtx pro 6000|b200|b100/i, 1.05],
  [/h200|h100/i, 1.1],
  [/5090/, 1],
  [/rtx 6000 ada/i, 0.7],
  [/4090/, 0.7],
  [/a100/i, 0.72],
  [/l40s?\b/i, 0.68],
  [/5080/, 0.54],
  [/4080/, 0.47],
  [/5070 ?ti/i, 0.42],
  [/4070 ?ti ?super/i, 0.42],
  [/3090 ?ti/i, 0.42],
  [/dgx spark|gb10/i, 0.4],
  [/3090|a6000|a40\b/i, 0.35],
  [/4070 ?ti/i, 0.37],
  [/4070 ?super/i, 0.33],
  [/3080 ?ti/i, 0.33],
  [/4070/, 0.3],
  [/3080/, 0.3],
  [/5070/, 0.29],
  [/a10g?\b/i, 0.3],
  [/a30\b/i, 0.3],
  [/v100/i, 0.22],
  [/rx 7900 ?xtx/i, 0.3],
  [/rx 7900/i, 0.26],
  [/rx 9070 ?xt|r9700/i, 0.25],
  [/a5000|a4500/i, 0.32],
  [/5060 ?ti/i, 0.26],
  [/arc pro b70/i, 0.23],
  [/4060 ?ti/i, 0.23],
  [/3070/, 0.2],
  [/rx 9070|rx 7800/i, 0.2],
  [/5060/, 0.18],
  [/a4000/i, 0.24],
  [/3060 ?ti/i, 0.17],
  [/2080 ?ti/i, 0.19],
  [/4060/, 0.15],
  [/3060/, 0.14],
  [/rx 7700/i, 0.15],
  [/rx 69[05]0/i, 0.14],
  [/rx 9060/i, 0.13],
  [/rx 6800/i, 0.12],
  [/arc pro b60|arc b580/i, 0.12],
  [/l4\b/i, 0.18],
  [/titan rtx/i, 0.19],
  [/arc b570|arc a770/i, 0.1],
  [/2080|2070/, 0.13],
  [/rx 7600/i, 0.09],
  [/arc a750/i, 0.09],
  [/2060 ?super/i, 0.1],
  [/a2000/i, 0.08],
  [/rx 67[05]0/i, 0.08],
  [/8060s|8050s/i, 0.08],
  [/2060/, 0.09],
  [/3050/, 0.07],
  [/arc a580/i, 0.07],
  [/1080 ?ti|titan x/i, 0.06],
  [/rx 66[05]0/i, 0.06],
  [/t4\b/i, 0.06],
  [/1080|1070/, 0.045],
  [/p100/i, 0.045],
  // GTX 1060 6 GB measured: FLUX.2 klein 4B GGUF Q5, 1 MP, 4 steps, 63 s warm (Oct 2026).
  [/1660/, 0.05],
  [/1060/, 0.035],
  [/1650|2050/, 0.03],
  [/980 ?ti/i, 0.03],
  [/arc a380/i, 0.03],
  [/980/, 0.025],
  [/970|1050/, 0.02],
  [/890m|880m|780m|760m|arc 1[34]0v/i, 0.015],
  [/9[56]0\b/, 0.012],
  // Apple: see APPLE below.
];

/**
 * Apple Silicon next to an RTX 5090, in ComfyUI's bf16 (M1 and M2 gain 1.48× on fp16 models, see formatCost), with the
 * GPU core count each is for; a Mac with more or fewer cores scales by them. Anchored on the M2 Air measured through
 * Crackio (8 cores, FLUX.2 klein 4B: 146 s in bf16, 97 s in fp16, Oct 2026). Other chips by their compute-bound matmul
 * speed next to it (llama.cpp's per-chip prompt-processing table, which tracks a 1 MP diffusion step: it predicts the M1
 * Max within 5% of mflux's measured klein steps); M3 and later run bf16 at full rate. M5, whose GPU Neural Accelerators
 * PyTorch reaches through MPSGraph and its 2.14 attention kernel, by measured diffusion runs instead, which gain less
 * than matmul benchmarks show: an M5 Ultra did FLUX.2 klein 9B in 5.61 s in stock ComfyUI, an M5 Max klein 4B in
 * 0.81–0.98 s a step in mflux. Pro/Max/Ultra ±30%; a laptop under a long job loses up to a quarter (an M5 Max MacBook Pro:
 * 2.85 → 3.9 s a step). Oct 2026.
 */
const APPLE: [RegExp, number, number][] = [
  [/apple m5 ultra/i, 0.36, 80],
  [/apple m4 ultra/i, 0.27, 80],
  [/apple m3 ultra/i, 0.22, 80],
  [/apple m2 ultra/i, 0.128, 76],
  [/apple m1 ultra/i, 0.107, 64],
  [/apple m5 max/i, 0.23, 40],
  [/apple m4 max/i, 0.135, 40],
  [/apple m3 max/i, 0.113, 40],
  [/apple m2 max/i, 0.069, 38],
  [/apple m1 max/i, 0.054, 32],
  [/apple m5 pro/i, 0.114, 20],
  [/apple m4 pro/i, 0.069, 20],
  [/apple m3 pro/i, 0.051, 18],
  [/apple m2 pro/i, 0.035, 19],
  [/apple m1 pro/i, 0.027, 16],
  [/apple m5/i, 0.052, 10],
  [/apple m4/i, 0.033, 10],
  [/apple m3/i, 0.029, 10],
  [/apple m2/i, 0.015, 8],
  [/apple m1/i, 0.012, 8],
];

/** The GPU a machine runs models on: the one with the most memory. */
export function mainGpu(m: Machine): Gpu | undefined {
  return [...m.gpus].sort((a, b) => (b.memoryGb ?? 0) - (a.memoryGb ?? 0))[0];
}

/** A laptop's GPU: the same chip as the desktop card, held to a fraction of its power ("RTX 4070 Laptop GPU", "RX 7600M XT"). */
const LAPTOP = /laptop|mobile|max-q|\brx \d{4}m\b|\brx \d{4}m xt\b/i;

/** How fast this GPU runs diffusion next to an RTX 5090; null when it isn't known. */
export function speedOf(m: Machine): number | null {
  const gpu = mainGpu(m);
  if (!gpu || m.accel === "cpu") return null;
  let speed = SPEED.find(([re]) => re.test(gpu.name))?.[1] ?? null;
  const apple = gpu.unified ? APPLE.find(([re]) => re.test(gpu.name)) : undefined;
  // A Mac's GPU core count: an M4 Max comes with 32 or 40, an M2 with 8 or 10.
  if (apple) speed = apple[1] * (gpu.cores ? gpu.cores / apple[2] : 1);
  // Unknown cards: by memory, which tracks the tier (AMD's and Intel's PyTorch builds get less from the same size).
  if (!speed && gpu.memoryGb && !gpu.unified) {
    const per = gpu.vendor === "nvidia" ? 60 : gpu.vendor === "amd" ? 90 : 110;
    speed = Math.min(0.5, Math.max(0.02, gpu.memoryGb / per));
  }
  // A Mac whose chip isn't named (a ComfyUI without Crackio's bridge says only "Apple Silicon"): the slowest M chip's speed.
  if (!speed && gpu.unified) speed = 0.01;
  if (!speed) return null;
  if (!gpu.unified && LAPTOP.test(gpu.name)) speed *= 0.65;
  // DirectML (an AMD card on Windows through ComfyUI's --directml) runs far below the card's ROCm speed.
  if (m.accel === "directml") speed *= 0.3;
  return speed;
}

/**
 * What a precision costs on this GPU next to the RTX 5090 times the catalog starts from. FP8 runs on FP8 math only on
 * RTX 40/50 (compute 8.9+); elsewhere its weights are widened to 16 bits for every layer, about bf16's speed rather than
 * 1.3× faster. ComfyUI's fast int8 and fp8 kernels also need PyTorch's CUDA 13 build: on a CUDA 12 build (an older
 * driver) they fall back to plain PyTorch. INT8 then measured 3–4× slower: FLUX 3 Klein on rented RTX 4060 Ti and 5070
 * Ti (cu128) next to a 4070 and a 3060 Ti (cu130), Z-Image Turbo 2.3× (Oct 2026).
 */
function formatCost(m: Machine, v: LocalVariant) {
  const gpu = mainGpu(m);
  const nvidia = gpu?.vendor === "nvidia";
  const cuda12 = nvidia && /\+cu12/.test(m.comfy?.torch ?? "");
  let cost = 1;
  if (/fp8/i.test(v.id) && !(nvidia && (gpu?.compute ?? 0) >= 8.9)) cost *= 1.35;
  if (nvidia && v.oldGpuCost && (gpu?.compute ?? 7) < 7) cost *= v.oldGpuCost;
  if (cuda12 && /int8/i.test(v.id)) cost *= 3;
  else if (cuda12 && /fp8/i.test(v.id)) cost *= 1.3;
  // M1 and M2 GPUs have no bf16 math, so ComfyUI's bf16 runs at about half speed there; models made for fp16 compute in it
  // through the bridge's Crackio Mac Tuning (FLUX.2 klein 4B on an M2 Air: 145 → 97 s a picture, Oct 2026). The Apple
  // speeds above are bf16's.
  if (gpu?.unified && /apple m[12]\b/i.test(gpu.name) && FP16_MODEL.test(v.files.find((f) => f.role === "model")?.name ?? "")) cost /= 1.48;
  // GGUF K-quants (Q2_K to Q6_K) unpack in many small steps, which Apple GPUs run slowly: a Q5_K weight took ~4.7× a
  // Q8_0's on an M2 (Qwen3-4B's Q5_K/Q6_K weights: 7.1 s on its GPU, 3.5 s on its CPU; Q8_0 ~0.4 s a billion). About a
  // quarter more a step for a picture model, so on a Mac the Q8 version wins whenever it fits.
  if (gpu?.unified && /^gguf-q[2-6]/i.test(v.id)) cost *= 1.25;
  return cost;
}

/** Model files of the architectures ComfyUI computes in fp16 when asked (its supported_models.py): FLUX.1/2, Krea 2, Chroma, Wan, SDXL, SeedVR2. */
const FP16_MODEL = /flux[-_.]?[12](?!\d)|flux1|krea[-_]?2|chroma|wan[-_]?2[._]?[12]|scail|seedvr|sdxl|sd_xl|longcat|anima/i;

/** Can this machine run this precision at all? A reason when not. */
function blocker(m: Machine, v: LocalVariant): string | null {
  const need = v.requires;
  if (!need) return null;
  if (need.backends && !need.backends.includes(m.accel)) {
    return m.accel === "mps" ? `${v.label} doesn't run on Apple GPUs` : m.accel === "cpu" ? "Needs a GPU" : `${v.label} needs an NVIDIA GPU`;
  }
  const compute = mainGpu(m)?.compute;
  if (need.compute && compute !== undefined && compute < need.compute) return `${v.label} needs a newer NVIDIA GPU`;
  return null;
}

const gb = (n: number) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} GB`;

/** Everything a variant downloads, in GB: on a Mac it all lives in unified memory at once. */
const filesGb = (v: LocalVariant) => v.files.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;

/**
 * What one second of a variant's RTX 5090 time takes on this machine, its model loaded and nothing spilling: the GPU's
 * speed ratio and what the precision costs it, on the share of the work that follows the GPU. Null for a GPU of unknown
 * speed. Benchmarks carry over from card to card by it (local/estimate).
 */
export function gpuScale(m: Machine, v: LocalVariant): number | null {
  const speed = speedOf(m);
  if (!speed) return null;
  const fixed = v.fixedShare ?? 0;
  return fixed + ((1 - fixed) * formatCost(m, v)) / speed;
}

/** One variant on one machine. */
export function fitVariant(m: Machine, v: LocalVariant): Fit {
  const why = blocker(m, v);
  if (why) return { state: "no", variant: v, seconds: null, why };
  const scale = gpuScale(m, v);
  const mem = m.modelMemoryGb;
  if (!mem || !scale) return { state: "no", variant: v, seconds: null, why: m.accel === "cpu" ? "Needs a GPU" : "Unknown GPU" };
  const base = v.seconds5090 * scale;
  const total = filesGb(v);
  if (mainGpu(m)?.unified) {
    // The GPU's share of unified memory holds the model at work; the rest of the files sit beside it in the same memory.
    if (v.needGb > mem || total + 4 > m.ramGb) return { state: "no", variant: v, seconds: null, why: `Needs ${gb(Math.max(v.needGb / 0.67, total + 4))} of memory` };
    return { state: v.needGb <= mem * 0.75 ? "great" : "ok", variant: v, seconds: base, why: `Fits in ${gb(m.ramGb)}` };
  }
  // Discrete GPUs: what isn't working sits in RAM, so RAM has to hold the whole set (or the disk pages). A ComfyUI's
  // budget is what its card has free right now; a card's nominal size loses what a desktop and a browser hold on it
  // (1.2–1.9 GB measured on Windows).
  const paging = total > m.ramGb * 0.85;
  const budget = m.where === "comfyui" ? mem : Math.max(0.5, mem - 1.2);
  if (v.minGb && budget < v.minGb) return { state: "no", variant: v, seconds: null, why: `Needs ${gb(v.minGb)} of GPU memory` };
  if (v.needGb <= budget && !paging) {
    // Comfortable, or just about: a tight fit leaves no room for anything else on the GPU.
    return { state: v.needGb <= mem * 0.75 ? "great" : "ok", variant: v, seconds: base, why: `Fits in ${gb(mem)}` };
  }
  // The rest of the weights stream from RAM every step.
  const spill = Math.max(0, v.needGb - budget);
  // Long steps (a video model at swap sizes): streaming costs little, so any card with room for a step's work runs it.
  if (v.streams && !paging && total <= m.ramGb * 0.85) {
    if (budget < 4) return { state: "no", variant: v, seconds: null, why: "Needs 4 GB of GPU memory" };
    return { state: "ok", variant: v, seconds: base * 1.15, why: `Streams ${gb(spill)} from RAM` };
  }
  if (total > m.ramGb * 1.2) return { state: "no", variant: v, seconds: null, why: `Needs ${gb(total / 1.2)} of RAM` };
  if (spill > m.ramGb * 0.6 || v.needGb > mem * 3) return { state: "no", variant: v, seconds: null, why: `Needs ${gb(v.needGb)} of GPU memory` };
  // Measured on a GTX 1060 under Windows: Z-Image Turbo spilling 1.3 GB of a 4.7 GB budget ran ~5× slower than it would
  // whole. On Linux, rented RTX 3060 Tis spilling 1.3 GB (FLUX 3 Klein) and 3.1 GB of 7.7 (SeedVR2 7B) ran as fast as
  // cards that hold them (Oct 2026).
  const steep = m.os.family === "linux" ? 1.5 : 14;
  const penalty = Math.min(12, (1 + steep * (spill / Math.max(1, mem))) * (paging ? 3 : 1));
  return { state: "slow", variant: v, seconds: base * penalty, why: paging ? `Needs ${gb(total)} of RAM` : `Spills ${gb(spill)} into RAM` };
}

const RANK: Record<Fit["state"], number> = { great: 3, ok: 2, slow: 1, no: 0 };

/**
 * The variant to install on this machine: of those that run well and look as good as the best of them (within 1.5%, so
 * int8 beats bf16 at twice the speed), the fastest; else the one that runs best.
 */
export function fitModel(m: Machine, model: LocalModel): Fit {
  const fits = model.variants.map((v) => fitVariant(m, v));
  const good = fits.filter((f) => f.state === "great" || f.state === "ok");
  if (good.length) {
    const top = Math.max(...good.map((f) => f.variant!.fidelity));
    return good
      .filter((f) => f.variant!.fidelity >= top - 0.015)
      .sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0) || RANK[b.state] - RANK[a.state] || b.variant!.fidelity - a.variant!.fidelity)[0];
  }
  const slow = fits.filter((f) => f.state === "slow").sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));
  if (slow.length) return slow[0];
  // Nothing runs: say what the smallest one this machine could run at all needs.
  const usable = (f: Fit) => (f.variant && blocker(m, f.variant) ? 1 : 0);
  return fits.sort((a, b) => usable(a) - usable(b) || (a.variant?.needGb ?? 0) - (b.variant?.needGb ?? 0))[0] ?? { state: "no", variant: null, seconds: null, why: "No files listed" };
}

/**
 * A model too big for this machine whose pooling version runs split with another computer that lends `lendGb` of GPU
 * memory (its bridge's /crackio/pool): this machine keeps the first blocks, that one the rest. Null when the model fits
 * here alone, doesn't pool, or doesn't fit the two together. Slower than one GPU that held it, since the two take turns
 * at every step: twice the time until a run measures it.
 */
export function fitPooled(m: Machine, model: LocalModel, lendGb: number, lender: string): Fit | null {
  const v = model.variants.find((x) => x.pool);
  if (!v || blocker(m, v)) return null;
  const alone = fitVariant(m, v);
  if (alone.state === "great" || alone.state === "ok") return null;
  const both = fitVariant({ ...m, modelMemoryGb: m.modelMemoryGb + lendGb }, v);
  if (both.state === "no") return null;
  return { ...both, state: "slow", seconds: both.seconds === null ? null : both.seconds * 2, why: `Splits with ${lender}: neither GPU holds it alone`, pool: lender };
}

export type Pick = { model: LocalModel; fit: Fit };

/**
 * The models for a task on this machine, best first: what runs well beats what runs slowly, then quality
 * (scaled by how much of it the variant keeps), then speed.
 */
export function rankFor(m: Machine, models: LocalModel[], task: LocalTask): Pick[] {
  return models
    .filter((model) => model.tasks.includes(task))
    .map((model) => ({ model, fit: fitModel(m, model) }))
    .sort((a, b) => {
      const ra = Math.min(2, RANK[a.fit.state]);
      const rb = Math.min(2, RANK[b.fit.state]);
      if (ra !== rb) return rb - ra;
      const qa = a.model.quality * (a.fit.variant?.fidelity ?? 1);
      const qb = b.model.quality * (b.fit.variant?.fidelity ?? 1);
      return qb - qa || (a.fit.seconds ?? Infinity) - (b.fit.seconds ?? Infinity);
    });
}

/** The fastest model that runs well for a task (quality within reach of the best), for the "fastest" pick. */
export function fastestFor(picks: Pick[]): Pick | null {
  const running = picks.filter((p) => p.fit.state === "great" || p.fit.state === "ok");
  if (!running.length) return null;
  const best = Math.max(...running.map((p) => p.model.quality));
  return running.filter((p) => p.model.quality >= best - 15).sort((a, b) => (a.fit.seconds ?? Infinity) - (b.fit.seconds ?? Infinity))[0] ?? null;
}

/** "12 s", "1.5 min", "14 min". */
export function formatSeconds(s: number | null) {
  if (s === null || !Number.isFinite(s)) return "—";
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  const min = s / 60;
  return min < 10 ? `${min.toFixed(1).replace(/\.0$/, "")} min` : `${Math.round(min)} min`;
}

/** "GTX 1060", "RTX 5090", "Apple M2 Pro": a GPU's name without its maker and memory. */
export const shortGpuName = (name: string) =>
  /comfy cloud/i.test(name)
    ? "Comfy Cloud"
    : name.replace(/^(NVIDIA|AMD|Intel)\s+/i, "").replace(/^(GeForce|Radeon)\s+/i, "").replace(/\s+\d+\s*GB$/i, "").trim() || name;

/**
 * How a machine you don't own reads, wherever machines are listed: Comfy Cloud runs on Comfy's servers for your Comfy
 * credits or plan (Comfy picks the hardware, so no card is named), and a rented box says it's rented. Null for your own.
 */
export const hostedNote = (t: { id: string; cloud?: { provider: string } | null }) =>
  t.id === "comfy-cloud"
    ? "Comfy's servers · your Comfy credits or plan"
    : t.id.startsWith("runpod-")
      ? "Rented · RunPod Serverless, by the second"
      : t.cloud
        ? `Rented · ${({ vast: "vast.ai", runpod: "RunPod" } as Record<string, string>)[t.cloud.provider] ?? "cloud GPU"}`
        : null;

/** Total download of a variant, in GB. */
export const downloadGb = (v: LocalVariant) => v.files.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;
