import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ASPECTS, aspectById, type AspectId } from "@/lib/shot";
import { frameAt, probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import { urlToPath } from "@/lib/server/media";
import { withSubjectMatte } from "@/lib/server/vision";
import { jsonObject } from "@/lib/json-answer";
import { installedFiles } from "@/lib/server/local-models";
import { localModel } from "@/lib/local/catalog";
import { pictureWork, WORK_POWER } from "@/lib/local/work";
import { IMAGE_RESOLUTIONS, imagePixels, pixelsAt } from "@/lib/local/resolution";
import { nativeMp, templateGraph, templateIO, templateModels } from "@/lib/server/local-templates";
import { detail, fill, fillFor, freeLatent, growImages, grownRoom, growsImages, isLink, maskLatent, redrawLatent, settle, stockAttention, type ApiGraph } from "./comfy-local-templates";
import type { LocalModel, TemplateMode } from "@/lib/local/types";
import { EngineError, type EngineJob, type EngineReference } from "./types";

/**
 * One ComfyUI workflow per local model, in ComfyUI's API format, with the job's inputs filled in.
 * The engine (comfy-local) uploads files, queues the graph and downloads what its save node writes.
 *
 * The graphs follow ComfyUI's official templates (comfyui_workflow_templates, Oct 2026):
 * - LTX-2.5 (video_ltx2_5_i2v / _t2v): the distilled 22B model in two passes, 8 steps at half size,
 *   then the ×2 latent upscaler and 3 more; 24 fps, 24 × seconds + 1 frames, sound in the same pass.
 * - SCAIL-2 (video_wan21_scail2_character_replacement_int8): a Wan 2.1 14B model that puts the person
 *   from a reference photo in place of the one in a clip. SAM 3.1 tracks the person in both; the clip
 *   runs in 81-frame segments that overlap by 5, each continuing from the last, colour-matched to it.
 */

/** A file in ComfyUI's input folder, by the name its loaders take ("crackio/in-….png"). */
export type Uploaded = { name: string };

export type RecipeTools = {
  /** Upload a file from disk; `tag` prefixes its name. */
  upload: (file: string, tag?: string) => Promise<Uploaded>;
  uploadData: (data: Buffer, name: string) => Promise<Uploaded>;
  /** Run a small workflow before the real one (a look at the clip) and get the pictures it saves. */
  probe?: (graph: Record<string, unknown>) => Promise<Buffer[]>;
  /** Whether this ComfyUI has a node type (newer core nodes, custom nodes). */
  hasNode?: (classType: string) => Promise<boolean>;
  /** Seconds per unit of work this model takes on the ComfyUI the job runs on (measured there, else estimated), when known. */
  perUnit?: number | null;
  /** The memory of the NVIDIA card the job runs on, in GB; null on a Mac or a CPU, or when it's unknown. */
  vramGb?: number | null;
  /** The RAM of the machine the job runs on (what ComfyUI may use: a container's limit), in GB, when known. */
  ramGb?: number | null;
  /** Another computer that runs the model's last blocks, when this ComfyUI's GPU can't hold it (local-models `poolFor`). */
  pool?: { url: string; token?: string; label: string } | null;
  /**
   * A picture edited by your image model (your default for pictures, else Crackio's pick), before this graph runs:
   * the first is the picture to edit, the rest are references. Null when no image model can. `prefer`: models tried
   * first, each only when it runs here; `stage`: what the progress line calls the edit.
   */
  edit?: (prompt: string, pictures: string[], aspect: AspectId, opts?: { prefer?: string[]; stage?: string }) => Promise<Buffer | null>;
  /** A line for the job's progress (what a recipe did instead, and why). */
  note?: (message: string) => void;
  /** Pictures: the size to render at (from the resolution asked, up to the model's `maxMp`); about 1 MP when missing. */
  size?: { width: number; height: number };
  signal: AbortSignal;
};

export type Recipe = {
  /** The model id in Crackio's catalog (`ModelDef.model`). */
  id: string;
  name: string;
  output: "image" | "video";
  /** Rough wall time for the progress bar before ComfyUI reports steps. */
  expectedMs: (job: EngineJob) => number;
  /**
   * How much work a job is in the Local catalog's units (local/work: ~1 MP pictures with their reference pictures counted;
   * or 5 s of 720p clip, one person), so the time it took becomes the per-unit speed the Local page shows, and a time
   * shown before a run is that speed times this. `referenceMp`: the size its reference pictures run at. One when missing.
   */
  units?: (job: EngineJob, referenceMp?: number) => number;
  /** The size each reference picture runs at, when it depends on the machine (`perUnit`: its seconds per unit). */
  referenceMp?: (job: EngineJob, perUnit: number | null) => number;
  /**
   * Pictures: the most megapixels the model renders well (it learned up to that size); a bigger resolution is made at this
   * and its detail drawn in at the size asked (comfy-local, `DETAIL_PASS`). About 2 when missing. `nativeMp` decides it per
   * job where it depends on the job or the machine (`perUnit`: its seconds per unit).
   */
  maxMp?: number;
  nativeMp?: (job: EngineJob, perUnit?: number | null) => number;
  /** The longest side the model renders well, where that binds before the area does (models made for up to 2048 a side). */
  maxEdge?: number;
  /** False where its graph can't take the detail pass (a few-step schedule): past `maxMp` its pictures are enlarged. */
  detailable?: boolean;
  build: (job: EngineJob, tools: RecipeTools) => Promise<Record<string, unknown>>;
};

/**
 * Past what its model draws well, a picture is drawn at that size, then drawn over lightly at the size asked
 * (comfy-local-templates `detail`): `steps` steps at `denoise`, on a GPU that makes a 1 MP picture in `slowest` seconds or
 * less (a slower one enlarges it instead), sharpened by Real-ESRGAN first when it grows more than `sharpenPast` times.
 * Its work is `work` of a whole picture at the size asked: FLUX 3 Klein took 18 s for 3840×2160 on an RTX 5090, where a
 * unit took 2.9 s.
 */
export const DETAIL_PASS = { denoise: 0.3, steps: 10, slowest: 15, sharpenPast: 1.5, work: 0.4 };

/* ------------------------------------------------------------------ graph building */

type Link = [string, number];
type ApiNode = { class_type: string; inputs: Record<string, unknown> };

class Graph {
  readonly nodes: Record<string, ApiNode> = {};
  private next = 1;
  add(classType: string, inputs: Record<string, unknown>) {
    const id = String(this.next++);
    this.nodes[id] = { class_type: classType, inputs };
    return id;
  }
}

const at = (id: string, slot = 0): Link => [id, slot];

/**
 * SaveVideo's H.264 at CRF 22 (its own default is 18): about a third of the size, no visible loss at web
 * sizes. A rented box can upload slowly toward you (one US host managed ~150 KB/s to Europe), so size is time.
 */
const COMPACT_MP4 = { format: "auto", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 22 };
const seed = () => Math.floor(Math.random() * 2 ** 48);
const snap = (n: number, step: number) => Math.max(step * 4, Math.round(n / step) * step);
const seconds = (job: EngineJob, fallback = 5) => (typeof job.options?.duration === "number" ? job.options.duration : fallback);

/**
 * The installed variant's files by role ("model", "text", "vae"…): the first of the model's variants (best first,
 * see local/catalog) whose files are all in ComfyUI's folders. Without one, nothing: recipes fall back to the files
 * they were written for, and ComfyUI names whatever is missing.
 */
async function filesFor(id: string): Promise<Record<string, string>> {
  const model = localModel(id);
  if (!model) return {};
  const have = await installedFiles().catch(() => new Set<string>());
  const v = model.variants.find((x) => x.files.every((file) => have.has(`${file.folder}/${file.name}`)));
  return v ? Object.fromEntries(v.files.map((file) => [file.role, file.name])) : {};
}

/** ComfyUI-GGUF's loaders for .gguf files (Macs, older NVIDIA cards), ComfyUI's own for the rest. */
function unetLoader(name: string): [string, Record<string, unknown>] {
  return /\.gguf$/i.test(name) ? ["UnetLoaderGGUF", { unet_name: name }] : ["UNETLoader", { unet_name: name, weight_dtype: "default" }];
}
/** The model's loader, split with another computer when the job pooled (its last blocks run there; GGUF only). */
function modelLoader(name: string, pool: RecipeTools["pool"]): [string, Record<string, unknown>] {
  if (pool && /\.gguf$/i.test(name)) return ["CrackioPoolLoaderGGUF", { unet_name: name, helper: pool.url, helper_blocks: 0, token: pool.token ?? "" }];
  return unetLoader(name);
}
function clipLoader(name: string, type: string): [string, Record<string, unknown>] {
  return /\.gguf$/i.test(name) ? ["CLIPLoaderGGUF", { clip_name: name, type }] : ["CLIPLoader", { clip_name: name, type, device: "default" }];
}

/** A picture at most `edge` px on its long side, as a PNG upload. */
async function picture(ref: EngineReference, tools: RecipeTools, tag: string, edge: number, enlarge = false) {
  // `enlarge`: a picture that sets the result's size is brought up to it as well as down.
  const png = await sharp(await fs.readFile(ref.path)).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: !enlarge }).png().toBuffer();
  return tools.uploadData(png, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
}

/** The clip's shape: its start frame's, else the shot's. */
async function ratioOf(job: EngineJob) {
  if (job.start) {
    const { width = 0, height = 0 } = await sharp(job.start.path).metadata();
    if (width && height) return width / height;
  }
  const a = aspectById(job.aspect);
  return a.w / a.h;
}

/* ------------------------------------------------------------------ LTX-2.5 */

const LTX = {
  unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
  textEncoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
  videoVae: "ltx-2.5-video-vae-bf16.safetensors",
  audioVae: "ltx-2.5-audio-vae-bf16.safetensors",
  upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
  // The distilled model's own schedules: 8 steps at half size, then 3 after the upscale.
  stage1: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
  stage2: "0.85, 0.7250, 0.4219, 0.0",
  negative: "pc game, console game, video game, cartoon, childish, ugly",
  fps: 24,
};

/**
 * Output size for a shape: ~0.9 MP for 720p (1280×704 at 16:9), ~2 MP for 1080p, ~3.7 MP for 1440p (2560×1472), ~0.5 MP
 * for 540p; multiples of 64 so the half-size pass stays on LTX's grid of 32. LTX-2.5 has no one-pass 1440p: like 1080p it's
 * a half-size pass doubled by its ×2 latent upscaler, then refined.
 */
export function ltxSize(ratio: number, resolution: string | number | undefined) {
  const r = Math.min(3, Math.max(1 / 3, ratio));
  const mp = { "540p": 0.5, "1080p": 2.0, "1440p": 3.7 }[String(resolution ?? "720p").toLowerCase()] ?? 0.9;
  const h = Math.sqrt((mp * 1e6) / r);
  return { width: snap(h * r, 64), height: snap(h, 64) };
}

/** A clip's work at each resolution, next to 720p's (1440p measured: 1.7× 1080p on an RTX 5090). */
const LTX_WORK: Record<string, number> = { "540p": 0.6, "1080p": 2.4, "1440p": 4.1 };

/**
 * LTX-2.5 from words, or from a start frame: the half-size pass, the ×2 latent upscale and the
 * refining pass, with the soundtrack made alongside. A start frame pins the first frame (strength
 * 0.7 in the first pass, 1 in the second, as the template does).
 */
const LTX_VIDEO: Recipe = {
  id: "ltx-2.5",
  name: "LTX-2.5",
  output: "video",
  expectedMs: (job) => Math.max(25_000, seconds(job) * 7_000 * (LTX_WORK[String(job.options?.resolution)] ?? 1)),
  units: (job) => (seconds(job) / 5) * (LTX_WORK[String(job.options?.resolution)] ?? 1),
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Write what happens in the clip.");
    // 1440p's second pass holds 3.7 MP of every frame at once: below 24 GB it's made at 1080p instead.
    const roomy = !tools.vramGb || tools.vramGb >= 24;
    const asked = String(job.options?.resolution) === "1440p" && !roomy ? "1080p" : job.options?.resolution;
    if (asked !== job.options?.resolution) tools.note?.(`1440p needs a GPU with 24 GB; this one makes it at 1080p`);
    const { width, height } = ltxSize(await ratioOf(job), asked);
    const length = Math.round(Math.min(20, Math.max(1, seconds(job))) * LTX.fps) + 1;
    const f = await filesFor("ltx-2.5");
    const g = new Graph();
    const model = at(g.add(...modelLoader(f.model ?? LTX.unet, tools.pool)));
    const clip = at(g.add("CLIPLoader", { clip_name: f.text ?? LTX.textEncoder, type: "ltxv", device: "default" }));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? LTX.videoVae }));
    const audioVae = at(g.add("VAELoader", { vae_name: f.audio ?? LTX.audioVae }));
    const cond = g.add("LTXVConditioning", {
      positive: at(g.add("CLIPTextEncode", { text: job.prompt, clip })),
      negative: at(g.add("CLIPTextEncode", { text: LTX.negative, clip })),
      frame_rate: LTX.fps,
    });
    const guider = () => at(g.add("LTXVDualCFGGuider", { model, positive: at(cond, 0), negative: at(cond, 1), video_cfg: 1, audio_cfg: 1 }));
    const sampler = () => at(g.add("KSamplerSelect", { sampler_name: "euler_ancestral" }));

    // The start frame, at most 1536 px, compressed the way LTX was trained to see first frames.
    const start = job.start
      ? at(g.add("LTXVPreprocess", { img_compression: 18, image: at(g.add("LoadImage", { image: (await picture(job.start, tools, "start", 1536)).name })) }))
      : null;
    const pin = (latent: Link, strength: number) => (start ? at(g.add("LTXVImgToVideoInplace", { vae, image: start, latent, strength, bypass: false })) : latent);

    const empty = at(g.add("EmptyLTXVLatentVideo", { width: width / 2, height: height / 2, length, batch_size: 1 }));
    const silence = at(g.add("LTXVEmptyLatentAudio", { frames_number: length, frame_rate: LTX.fps, batch_size: 1, audio_vae: audioVae }));
    const first = g.add("SamplerCustomAdvanced", {
      noise: at(g.add("RandomNoise", { noise_seed: seed() })),
      guider: guider(),
      sampler: sampler(),
      sigmas: at(g.add("ManualSigmas", { sigmas: LTX.stage1 })),
      latent_image: at(g.add("LTXVConcatAVLatent", { video_latent: pin(empty, 0.7), audio_latent: silence })),
    });
    const draft = g.add("LTXVSeparateAVLatent", { av_latent: at(first) });
    const upscaled = at(g.add("LTXVLatentUpsampler", { samples: at(draft, 0), upscale_model: at(g.add("LatentUpscaleModelLoader", { model_name: f.upscaler ?? LTX.upscaler })), vae }));
    const second = g.add("SamplerCustomAdvanced", {
      noise: at(g.add("RandomNoise", { noise_seed: seed() })),
      guider: guider(),
      sampler: sampler(),
      sigmas: at(g.add("ManualSigmas", { sigmas: LTX.stage2 })),
      latent_image: at(g.add("LTXVConcatAVLatent", { video_latent: pin(upscaled, 1), audio_latent: at(draft, 1) })),
    });
    const final = g.add("LTXVSeparateAVLatent", { av_latent: at(second) });
    // Split with another computer means a small card here: the model leaves its memory before the decode, which runs in
    // smaller tiles (with the model still loaded, a 6 GB card spilled into system memory and took 13 min for 2 s).
    const small = Boolean(tools.pool);
    const samples = small ? at(g.add("CrackioFreeMemory", { samples: at(final, 0) })) : at(final, 0);
    const tiles = small ? { tile_size: 256, overlap: 64, temporal_size: 32, temporal_overlap: 8 } : { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 };
    const frames = at(g.add("VAEDecodeTiled", { samples, vae, ...tiles }));
    const sound = job.options?.sound ?? true;
    const audio = sound ? at(g.add("LTXVAudioVAEDecode", { samples: at(final, 1), audio_vae: audioVae })) : null;
    const video = g.add("CreateVideo", { images: frames, fps: LTX.fps, bit_depth: 8, color_space: "sRGB", codec: "none", ...(audio ? { audio } : {}) });
    g.add("SaveVideo", { video: at(video), filename_prefix: "crackio/ltx-2.5", ...COMPACT_MP4 });
    return g.nodes;
  },
};

/* ------------------------------------------------------------------ SCAIL-2 */

const SCAIL = {
  unet: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors",
  dpo: "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors",
  turbo: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
  textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  clipVision: "clip_vision_h.safetensors",
  vae: "Wan2_1_VAE_bf16.safetensors",
  sam: "sam3.1_multiplex_fp16.safetensors",
  segment: 81,
  overlap: 5,
  /** Latent frames (4 video frames each) a frame attends to on each side after the first step (Crackio Window Attention). */
  window: 2,
  /** SCAIL-2's identity colours, in the order it was trained on: the clip's people get them left to right. */
  colors: [
    [0, 0, 255],
    [255, 0, 0],
  ],
};

type Box = { x: number; y: number; w: number; h: number };

/**
 * The part of the clip SCAIL-2 makes, and its size there. Only the people being replaced change, and every frame is
 * pasted back onto the clip, so SCAIL-2 makes just their box: the people with room around them (an eighth of their
 * height each side, for limbs the look missed and characters bigger than their person), between 1:2 and 2:1, or the
 * whole frame when that is most of it. Two people side by side share one box.
 *
 * It's made at about `mp` megapixels (0.9 at 704p, the size SCAIL-2's authors replace at; 0.46 at 512p), never below
 * 0.3 MP however small the people are, on SCAIL's grid of 32; the box takes exactly that shape, so nothing is stretched.
 * On a 720p clip one person's box is about half the frame: the people come out at the clip's own sharpness for half
 * the work of the whole frame, and the rest of the clip is untouched.
 */
export function swapBox(people: Box | null, W: number, H: number, mp: number) {
  let { x, y, w, h } = people ?? { x: 0, y: 0, w: W, h: H };
  if (people) {
    const pad = h / 8;
    [x, y] = [Math.max(0, x - pad), Math.max(0, y - pad)];
    [w, h] = [Math.min(W, x + w + 2 * pad) - x, Math.min(H, y + h + 2 * pad) - y];
  }
  // Grows a side about its centre, kept inside the frame.
  const widen = (to: number) => {
    to = Math.min(W, to);
    x = Math.min(W - to, Math.max(0, x + (w - to) / 2));
    w = to;
  };
  const heighten = (to: number) => {
    to = Math.min(H, to);
    y = Math.min(H - to, Math.max(0, y + (h - to) / 2));
    h = to;
  };
  if (w < h / 2) widen(h / 2);
  if (h < w / 2) heighten(w / 2);
  if (w * h > 0.7 * W * H) [x, y, w, h] = [0, 0, W, H];
  const target = Math.min(mp, Math.max(0.3, (w * h) / 1e6));
  const s = Math.sqrt((target * 1e6) / (w * h));
  const width = snap(w * s, 32);
  const height = snap(h * s, 32);
  // The box in the generated shape: the short side grows, or where the frame stops it, the other side shrinks.
  const shape = width / height;
  if (w / h < shape) {
    widen(h * shape);
    if (w / h < shape - 1e-3) heighten(w / shape);
  } else {
    heighten(w / shape);
    if (w / h > shape + 1e-3) widen(h * shape);
  }
  const box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  return { box: { ...box, w: Math.min(W - box.x, box.w), h: Math.min(H - box.y, box.h) }, width, height };
}

/** A picture's subject trimmed to its matte (RGBA), or null when its alpha isn't a usable matte. */
async function figureOf(file: string): Promise<Buffer | null> {
  const { data, info } = await sharp(await fs.readFile(file)).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let on = 0;
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= 127) continue;
      on++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const share = on / (width * height);
  if (share < 0.03 || share > 0.97) return null;
  return sharp(data, { raw: { width, height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .png()
    .toBuffer();
}

/**
 * Figures on SCAIL-2's canvas, whole. WanSCAILToVideo scales every reference to the canvas and crops it to the
 * canvas' shape, so a tall figure on a wide canvas kept only a band across its middle (no head, no feet: the
 * model drew the rest from the prompt). Each figure is laid at 95% of the canvas height in its own slot (side by
 * side, the leftmost first), its colours on black, with an identity mask in its own colour on black.
 */
async function onCanvas(figures: Buffer[], W: number, H: number, colors: number[][], places?: number[] | null) {
  const n = figures.length;
  // Each figure's centre: where its person stands in the clip (when known), else evenly spaced; and the room it has,
  // half-way to its neighbours, so pairs never overlap.
  const centres = places?.length === n ? places.map((x) => Math.min(W, Math.max(0, x))) : figures.map((_, i) => (W * (2 * i + 1)) / (2 * n));
  const room = centres.map((c, i) => {
    const left = i ? (c - centres[i - 1]) / 2 : c;
    const right = i < n - 1 ? (centres[i + 1] - c) / 2 : W - c;
    return Math.max(W * 0.08, 2 * Math.min(left, right) * 0.96);
  });
  const rgb = Buffer.alloc(W * H * 3);
  const mask = Buffer.alloc(W * H * 3);
  for (const [i, figure] of figures.entries()) {
    const { width = 1, height = 1 } = await sharp(figure).metadata();
    const scale = Math.min((H * 0.95) / height, room[i] / width);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const input = await sharp(figure).resize(w, h, { kernel: "lanczos3" }).png().toBuffer();
    const left = Math.min(W - w, Math.max(0, Math.round(centres[i] - w / 2)));
    const placed = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input, left, top: Math.round((H - h) / 2) }])
      .raw()
      .toBuffer();
    for (let px = 0; px < W * H; px++) {
      const a = placed[px * 4 + 3];
      if (!a) continue;
      for (let c = 0; c < 3; c++) rgb[px * 3 + c] = Math.round((placed[px * 4 + c] * a + rgb[px * 3 + c] * (255 - a)) / 255);
      if (a > 127) for (let c = 0; c < 3; c++) mask[px * 3 + c] = colors[i][c];
    }
  }
  const png = (b: Buffer) => sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { image: await png(rgb), mask: await png(mask) };
}

type Cast = { image: Link; vision: Link; mask: Link | null; track: Link | null };

type Tracked = { sam: string; frames: Link; track: Link; colored: Link; small: { width: number; height: number } };

/**
 * The clip's frames and SAM 3.1's track of the people being replaced through all of it: their colours (SCAIL-2's
 * replacement masks, white where nobody is replaced) at about 640 px. SAM 3.1 looks at every frame at 1008 px (3.3 s a
 * frame on a GTX 1060), so with Crackio's bridge it tracks every 2nd frame. The look before the job (findPeople) and
 * the job build these same nodes, so ComfyUI keeps the track and the decoded clip from the look.
 */
function trackPeople(g: Graph, clip: string, W: number, H: number, frameCount: number, n: number, samFile: string, sparse: boolean): Tracked {
  const sam = g.add("CheckpointLoaderSimple", { ckpt_name: samFile });
  const frames = at(g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file: clip })) }));
  const s = Math.min(1, 640 / Math.max(W, H));
  const small = { width: snap(W * s, 16), height: snap(H * s, 16) };
  const picked = sparse ? at(g.add("CrackioResampleFrames", { frames: Math.max(2, Math.ceil(frameCount / 2)), images: frames }), 0) : frames;
  const images = at(g.add("ImageScale", { image: picked, upscale_method: "area", ...small, crop: "disabled" }));
  const track = at(g.add("SAM3_VideoTrack", { images, model: at(sam), conditioning: at(g.add("CLIPTextEncode", { text: "person", clip: at(sam, 1) })), detection_threshold: 0.5, max_objects: 4, detect_interval: 2 }));
  const colored = at(g.add("SCAIL2ColoredMask", { driving_track_data: track, object_indices: Array.from({ length: n }, (_, k) => k).join(","), sort_by: n > 1 ? "left_to_right" : "area", replacement_mode: true }));
  return { sam, frames, track, colored, small };
}

/**
 * Where the people being replaced are, from SAM 3.1's track of the whole clip (W×H): where each stands in the first
 * frame (their centres across, in SCAIL-2's left-to-right order) and the box all of them stay inside, in the clip's
 * pixels. SCAIL-2 learned from references taken from the clip itself, with each character in its person's place; a
 * figure standing elsewhere on the reference sometimes gets painted into the scene as an extra person. Null when the
 * look fails or misses someone.
 */
async function findPeople(tools: RecipeTools, clip: string, W: number, H: number, frameCount: number, n: number, samFile: string, sparse: boolean): Promise<{ places: number[]; box: Box; first: Buffer } | null> {
  if (!tools.probe) return null;
  const g = new Graph();
  const { colored, small } = trackPeople(g, clip, W, H, frameCount, n, samFile, sparse);
  g.add("SaveImage", { images: colored, filename_prefix: "crackio/people" });
  const pngs = await tools.probe(g.nodes);
  if (!pngs.length) return null;
  const colors = SCAIL.colors.slice(0, n);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  let places: number[] | null = null;
  for (const [f, png] of pngs.entries()) {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const sums = colors.map(() => ({ x: 0, count: 0 }));
    for (let px = 0; px < info.width * info.height; px++) {
      const [r, g2, b] = [data[px * 3], data[px * 3 + 1], data[px * 3 + 2]];
      // Replacement masks are white where nobody is replaced.
      if (r > 200 && g2 > 200 && b > 200) continue;
      const [x, y] = [px % info.width, Math.floor(px / info.width)];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      if (f) continue;
      const k = colors.findIndex(([cr, cg, cb]) => Math.abs(r - cr) < 60 && Math.abs(g2 - cg) < 60 && Math.abs(b - cb) < 60);
      if (k < 0) continue;
      sums[k].x += x;
      sums[k].count++;
    }
    if (!f) {
      // Every person found, with a sensible share of the frame.
      if (sums.some((c) => c.count < info.width * info.height * 0.004)) return null;
      places = sums.map((c) => ((c.x / c.count) * W) / info.width);
    }
  }
  if (!places || x1 < 0) return null;
  const [sx, sy] = [W / small.width, H / small.height];
  return { places, box: { x: x0 * sx, y: y0 * sy, w: (x1 + 1 - x0) * sx, h: (y1 + 1 - y0) * sy }, first: pngs[0] };
}

/**
 * Each character drawn by your picture model in place of the person it replaces: given the clip's first frame and the
 * character's own picture, it draws the character in that person's pose, size and place, alone on white (the scene
 * shows it how the person stands and what they reach for; the white leaves nothing else to cut out), and the drawing is
 * cut out where it stands. SCAIL-2 keeps the pose of the picture it's given: on a GTX 1060 a man in profile at a
 * keyboard became a front-facing scarecrow beside it from the Cast picture; drawn in his place from the frame, it
 * turned to the keys. Returns the drawn characters on black, cut to the box at the generated size, and their
 * identity mask (each in its person's colour, the leftmost first); null when the picture model didn't draw everyone.
 */
async function posedCast(job: EngineJob, tools: RecipeTools, first: Buffer, W: number, H: number, box: Box, width: number, height: number, nouns: string[], targets: string[]) {
  if (!tools.edit || !job.source) return null;
  const frame = await sharp(await frameAt(job.source.path, 0, W)).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const data = await sharp(first).removeAlpha().raw().toBuffer();
  const people = job.references.slice(0, SCAIL.colors.length);
  const shape = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / (W / H))) < Math.abs(Math.log(best.w / best.h / (W / H))) ? a : best)).id;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-pose-"));
  try {
    const drawn = await Promise.all(
      people.map(async (ref, k) => {
        if (!data.some((_, i) => i % 3 === 0 && Math.abs(data[i] - SCAIL.colors[k][0]) < 60 && Math.abs(data[i + 1] - SCAIL.colors[k][1]) < 60 && Math.abs(data[i + 2] - SCAIL.colors[k][2]) < 60)) {
          throw new Error("a person wasn't found in the first frame");
        }
        const noun = nouns[k] ? `the ${nouns[k]}` : "the character";
        const who = targets[k] || (people.length > 1 ? ["the person on the left", "the person on the right"][k] : "the main person");
        const prompt = [
          `Image 1 is a frame from a video. Draw ${noun} from image 2 in place of ${who}:`,
          "exactly that person's pose, size and place in the frame, cut off by the edges of the frame just where they are",
          "(the same turn of the body and head, the same arms, hands and legs, touching what they touch).",
          `Keep everything about ${noun} from image 2: face, body, costume and colours.`,
          `Show only ${noun} on a plain white background: leave out everything else in the frame.`,
        ].join(" ");
        const person = path.join(dir, `frame-${k}.png`);
        await fs.writeFile(person, await sharp(frame, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
        const picture = await tools.edit!(prompt, [person, ref.path], shape);
        if (!picture) throw new Error("no picture model is connected");
        const file = path.join(dir, `drawn-${k}.png`);
        await fs.writeFile(file, await sharp(picture).rotate().removeAlpha().resize(W, H, { fit: "cover" }).png().toBuffer());
        const matted = await withSubjectMatte(file);
        if (!matted) throw new Error("the drawn character couldn't be cut out");
        return sharp(matted).raw().toBuffer();
      }),
    );
    // Everyone on black, each in their colour (a later one over an earlier one where they overlap).
    const image = Buffer.alloc(W * H * 3);
    const mask = Buffer.alloc(W * H * 3);
    for (const [k, rgba] of drawn.entries()) {
      for (let i = 0; i < W * H; i++) {
        const a = rgba[i * 4 + 3];
        if (!a) continue;
        for (let c = 0; c < 3; c++) image[i * 3 + c] = Math.round((rgba[i * 4 + c] * a + image[i * 3 + c] * (255 - a)) / 255);
        if (a > 127) for (let c = 0; c < 3; c++) mask[i * 3 + c] = SCAIL.colors[k][c];
      }
    }
    const cut = (raw: Buffer, kernel: "nearest" | "lanczos3") =>
      sharp(raw, { raw: { width: W, height: H, channels: 3 } }).extract({ left: box.x, top: box.y, width: box.w, height: box.h }).resize(width, height, { fit: "fill", kernel }).png().toBuffer();
    return { image: await cut(image, "lanczos3"), mask: await cut(mask, "nearest") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Who goes into the clip, as SCAIL-2 takes them: one picture with every character in place (the leftmost first,
 * as the clip's people are coloured), then any extra views of each (a close-up, other sides) in that character's
 * colour, batched. Pictures whose alpha is the figure's matte (Templates cuts every reference out) give exact
 * masks; plain photos go side by side and SAM 3.1 finds the characters in them by name. With the clip's first frame
 * drawn in the people's places (posedCast), that drawing is the picture with everyone.
 */
async function scailCast(g: Graph, files: string[], views: string[][], W: number, H: number, tools: RecipeTools, sam: string, lookFor: Link, places?: number[] | null, posed?: { image: Buffer; mask: Buffer } | null, fullModel = true): Promise<Cast> {
  const load = async (png: Buffer, tag: string) =>
    at(g.add("LoadImage", { image: (await tools.uploadData(png, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`)).name }));
  const mains = await Promise.all(files.map((f) => figureOf(f).catch(() => null)));
  if (mains.some((m) => !m) && !posed) {
    const slot = Math.floor(W / files.length);
    const tiles = await Promise.all(files.map(async (f) => sharp(await fs.readFile(f)).rotate().removeAlpha().resize(slot, H, { fit: "contain", background: "#000000" }).png().toBuffer()));
    const png = await sharp({ create: { width: W, height: H, channels: 3, background: "#000000" } })
      .composite(tiles.map((input, i) => ({ input, left: i * slot, top: 0 })))
      .png()
      .toBuffer();
    const image = await load(png, "cast");
    const track = at(g.add("SAM3_VideoTrack", { images: image, model: at(sam), conditioning: lookFor, detection_threshold: 0.4, max_objects: files.length, detect_interval: 1 }));
    return { image, vision: image, mask: null, track };
  }
  const images: Link[] = [];
  const masks: Link[] = [];
  const put = async (figures: Buffer[], colors: number[][], at?: number[] | null) => {
    const c = await onCanvas(figures, W, H, colors, at);
    images.push(await load(c.image, "cast"));
    masks.push(await load(c.mask, "cast-mask"));
  };
  // The picture with everyone stands each character where its person is; extra views are close-ups, centred.
  if (posed) {
    images.push(await load(posed.image, "cast-posed"));
    masks.push(await load(posed.mask, "cast-posed-mask"));
  } else await put(mains as Buffer[], SCAIL.colors.slice(0, files.length), places);
  // Every extra view is another frame of tokens the whole clip attends to (at 704p each costs about a tenth more time):
  // the close-up and one more side for a character alone, the close-up for each of a pair. Not with the edited first
  // frame, nor on GGUF builds: on a GTX 1060 (Q4, 9–33 frames) centred views on black painted a second character into
  // the scene and darkened the background where the replaced person stood.
  const per = posed || !fullModel ? 0 : files.length > 1 ? 1 : 2;
  for (const [k, list] of views.slice(0, files.length).entries()) {
    for (const v of list.slice(0, per)) {
      const figure = await figureOf(v).catch(() => null);
      if (figure) await put([figure], [SCAIL.colors[k]]);
    }
  }
  const batch = (links: Link[]) => (links.length === 1 ? links[0] : at(g.add("BatchImagesNode", Object.fromEntries(links.map((l, k) => [`images.image${k}`, l])))));
  return { image: batch(images), vision: images[0], mask: batch(masks), track: null };
}

/** Where the clip's replaced people are: anything coloured (not white) in SCAIL-2's replacement mask. */
function replacedArea(g: Graph, colored: Link) {
  const channel = (c: string) => at(g.add("ImageToMask", { image: colored, channel: c }));
  const rg = at(g.add("MaskComposite", { destination: channel("red"), source: channel("green"), x: 0, y: 0, operation: "multiply" }));
  const white = at(g.add("MaskComposite", { destination: rg, source: channel("blue"), x: 0, y: 0, operation: "multiply" }));
  return at(g.add("InvertMask", { mask: white }));
}

/**
 * Character swap: the clip's people are replaced by the characters in the pictures, in the clip's own frames.
 * All of them in one pass (SCAIL-2 binds each to its person by colour, left to right; one person alone is the
 * biggest in the clip), in 81-frame segments that each continue from the last 5 frames of the one before.
 * The turbo preset: lightx2v at 0.8 over the DPO LoRA, 6 steps, CFG 1, euler, shift 5; 704p by default.
 * Only the box around the people being replaced is made (swapBox), and each segment is pasted back onto the clip at
 * the clip's own size through the replaced people's outline united with where SAM 3.1 finds the new characters (a
 * pumpkin head is bigger than the head it replaces), grown and feathered: the other people and the background stay
 * exactly as filmed. GGUF versions run on small GPUs, with Crackio's bridge cutting the attention work.
 */
const SCAIL_SWAP: Recipe = {
  id: "scail-2",
  name: "SCAIL-2 character swap",
  output: "video",
  expectedMs: (job) => {
    const seconds = typeof job.options?.duration === "number" ? job.options.duration : 10;
    const segs = Math.max(1, Math.ceil((seconds * 16) / 76));
    return segs * (String(job.options?.resolution) === "512p" ? 100_000 : 330_000) * (job.references.length > 1 ? 1.25 : 1);
  },
  units: (job) => {
    const seconds = typeof job.options?.duration === "number" ? job.options.duration : 5;
    return Math.max(1, Math.ceil((seconds * 16 - 5) / 76)) * (String(job.options?.resolution) === "512p" ? 0.31 : 1) * (job.references.length > 1 ? 1.25 : 1);
  },
  async build(job, tools) {
    if (!job.source) throw new EngineError("Pick a clip to swap someone into.");
    if (!job.references.length) throw new EngineError("Add the photo of who goes into the clip.");
    const info = await probe(job.source.path).catch(() => null);
    if (!info?.duration || !info.width || !info.height) throw new EngineError("Couldn't read the clip.");
    const fps = info.fps || 16;
    const step = SCAIL.segment - SCAIL.overlap;
    const f = await filesFor("scail-2");

    const g = new Graph();
    const base = at(g.add(...modelLoader(f.model ?? SCAIL.unet, tools.pool)));
    const dpo = at(g.add("LoraLoaderModelOnly", { lora_name: f.dpo ?? SCAIL.dpo, strength_model: 1, model: base }));
    const turbo = at(g.add("LoraLoaderModelOnly", { lora_name: f.turbo ?? SCAIL.turbo, strength_model: 0.8, model: dpo }));
    // Small GPUs (Crackio's bridge): fp16 on cards without bf16 (half the memory, the same speed there), and after the
    // first step each frame attends to its neighbours, the references and its pose instead of the whole clip.
    let tuned = turbo;
    if (await tools.hasNode?.("CrackioHalfOnOldGPUs")) tuned = at(g.add("CrackioHalfOnOldGPUs", { model: tuned }));
    if (await tools.hasNode?.("CrackioWindowAttention")) tuned = at(g.add("CrackioWindowAttention", { model: tuned, window: SCAIL.window, dense_steps: 1 }));
    const model = at(g.add("ModelSamplingSD3", { shift: 5, model: tuned }));
    const clip = at(g.add(...clipLoader(f.text ?? SCAIL.textEncoder, "wan")));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? SCAIL.vae }));
    const positive = at(g.add("CLIPTextEncode", { text: job.prompt || "The person from the reference image, moving exactly as in the video.", clip }));
    const negative = at(g.add("CLIPTextEncode", { text: "", clip }));
    const vision = at(g.add("CLIPVisionLoader", { clip_name: f.vision ?? SCAIL.clipVision }));
    // More views of each character (Templates sends a Cast character's portrait and other sheet views), by reference.
    const views = (Array.isArray(job.options?.extra?.views) ? (job.options.extra.views as unknown[]) : []).map((list) =>
      (Array.isArray(list) ? list : []).flatMap((u) => (typeof u === "string" ? (urlToPath(u) ?? []) : [])),
    );
    const people = job.references.slice(0, SCAIL.colors.length);
    const clipName = (await tools.upload(job.source.path, "clip")).name;
    // SAM 3.1 tracks the people through the whole clip once: the look finds their box, the job reuses its track.
    const count = Math.max(1, Math.round(info.duration * fps));
    const sparse = Boolean(await tools.hasNode?.("CrackioResampleFrames"));
    // On a slow GPU (more than 10 minutes a 5 s segment here, measured or estimated) SCAIL-2 makes every 2nd frame in 4 steps
    // and FILM draws the frames between: on a GTX 1060 a 5 s swap took 32 minutes instead of 55, the in-between frames clean.
    const slow = (tools.perUnit ?? 0) > 600 && sparse && Boolean(f.film) && Boolean(await tools.hasNode?.("FrameInterpolate"));
    const rate = slow ? 2 : 1;
    const generated = slow ? Math.floor((count - 1) / 2) + 1 : count;
    const total = Math.max(SCAIL.segment, generated);
    let segments = Math.max(1, Math.ceil((total - SCAIL.overlap) / step));
    // A last segment of only a few new frames isn't worth a pass (and can't hold its 5-frame lead-in): the clip ends a moment early.
    if (segments > 1 && total - (SCAIL.segment + step * (segments - 2)) < 12) segments--;
    const found = await findPeople(tools, clipName, info.width, info.height, count, people.length, f.sam ?? SCAIL.sam, sparse).catch(() => null);
    const tracked = trackPeople(g, clipName, info.width, info.height, count, people.length, f.sam ?? SCAIL.sam, sparse);
    const sam = tracked.sam;
    // What the characters are (Templates reads it from the photos): SAM 3.1 sees a pumpkin head or a pigeon by name, not as a "person".
    const subjects = (Array.isArray(job.options?.extra?.subjects) ? (job.options.extra.subjects as unknown[]) : [])
      .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
      .map((s) => s.trim().replace(/^(a|an|the)\s+/i, ""));
    const lookFor = at(g.add("CLIPTextEncode", { text: [...new Set([...subjects, "person"])].join(", "), clip: at(sam, 1) }));
    // Only the box around the people being replaced is made (see swapBox), at about 0.9 MP (704p) or 0.46 MP (512p).
    const mp = String(job.options?.resolution ?? "704p").toLowerCase() === "512p" ? 0.46 : 0.9;
    const { box, width, height } = swapBox(found?.box ?? null, info.width, info.height, mp);
    const places = found?.places.map((x) => ((x - box.x) * width) / box.w) ?? null;
    // The characters edited into the clip's first frame, when Templates wrote that edit and an image model made it.
    // The characters drawn in their people's poses, when Templates asked for it and a picture model made them.
    const targets = (Array.isArray(job.options?.extra?.targets) ? (job.options.extra.targets as unknown[]) : []).map((t) => (typeof t === "string" ? t : ""));
    const posed =
      job.options?.extra?.pose === true && found
        ? await posedCast(job, tools, found.first, info.width, info.height, box, width, height, subjects, targets).catch((err: unknown) => {
            tools.note?.(`Posing the characters: ${err instanceof Error ? err.message : String(err)} (using their own pictures)`);
            return null;
          })
        : null;
    const cast = await scailCast(g, people.map((r) => r.path), views, width, height, tools, sam, lookFor, places, posed, !/\.gguf$/i.test(f.model ?? SCAIL.unet));
    const seen = at(g.add("CLIPVisionEncode", { crop: "none", clip_vision: vision, image: cast.vision }));
    const frames = tracked.frames;
    // The track's colours back at every frame of the clip, and the reference's identity mask when its pictures had none.
    const colored = sparse ? at(g.add("CrackioResampleFrames", { frames: 1, images: tracked.colored, like: frames }), 0) : tracked.colored;
    // The frames SCAIL-2 makes: every frame, or every 2nd on a slow GPU (from an odd count of frames, so exactly every 2nd).
    const every2nd = (images: Link) => at(g.add("CrackioResampleFrames", { frames: generated, images: at(g.add("ImageFromBatch", { image: images, batch_index: 0, length: 2 * generated - 1 })) }), 0);
    const genFrames = slow ? every2nd(frames) : frames;
    const genColored = slow ? every2nd(colored) : colored;
    const interp = slow ? at(g.add("FrameInterpolationModelLoader", { model_name: f.film })) : null;
    const refMask = cast.mask ?? at(g.add("SCAIL2ColoredMask", { driving_track_data: tracked.track, ref_track_data: cast.track, object_indices: people.map((_, k) => k).join(","), sort_by: people.length > 1 ? "left_to_right" : "area", replacement_mode: true }), 1);
    // Mask sizes follow the clip's frame (its height in generated pixels), not the box.
    const frameH = (info.height * height) / box.h;
    const grow = Math.round(frameH * 0.028);
    const feather = Math.min(31, Math.max(4, Math.round(frameH * 0.02)));
    const whole = box.w === info.width && box.h === info.height;
    const sized = (image: Link, w: number, h: number, how = "lanczos") => at(g.add("ImageScale", { image, upscale_method: how, width: w, height: h, crop: "disabled" }));
    const [mx, my] = [tracked.small.width / info.width, tracked.small.height / info.height];
    const maskBox = { x: Math.round(box.x * mx), y: Math.round(box.y * my), width: Math.max(1, Math.round(box.w * mx)), height: Math.max(1, Math.round(box.h * my)) };

    const outs: Link[] = [];
    let output: Link | null = null;
    for (let i = 0; i < segments; i++) {
      // This segment's frames in the box at the generated size, and the people's colours there (nearest, so the colours stay
      // SCAIL's own): at the rate SCAIL-2 makes them, and at the clip's own for the paste-back.
      const inBox = (images: Link) => (box.w === width && box.h === height ? (whole ? images : at(g.add("ImageCrop", { image: images, width: box.w, height: box.h, x: box.x, y: box.y }))) : sized(whole ? images : at(g.add("ImageCrop", { image: images, width: box.w, height: box.h, x: box.x, y: box.y })), width, height));
      const tinted = (images: Link) => sized(whole ? images : at(g.add("ImageCrop", { image: images, ...maskBox })), width, height, "nearest-exact");
      const slice = (images: Link, from: number, length: number) => at(g.add("ImageFromBatch", { image: images, batch_index: from, length }));
      const driving = inBox(slice(genFrames, i * step, SCAIL.segment));
      const drivingMask = tinted(slice(genColored, i * step, SCAIL.segment));
      const part = slice(frames, i * step * rate, (SCAIL.segment - 1) * rate + 1);
      const drivingHere = slow ? inBox(part) : driving;
      const maskHere = slow ? tinted(slice(colored, i * step * rate, (SCAIL.segment - 1) * rate + 1)) : drivingMask;
      const scail = g.add("WanSCAILToVideo", {
        positive,
        negative,
        vae,
        width,
        height,
        length: at(g.add("GetImageSize", { image: driving }), 2),
        batch_size: 1,
        pose_strength: 1,
        pose_start: 0,
        pose_end: 1,
        video_frame_offset: 0,
        previous_frame_count: SCAIL.overlap,
        pose_video: driving,
        pose_video_mask: drivingMask,
        replacement_mode: true,
        reference_image: cast.image,
        reference_image_mask: refMask,
        clip_vision_output: seen,
        ...(i ? { previous_frames: outs[i - 1] } : {}),
      });
      const sampled = g.add("SamplerCustom", {
        add_noise: true,
        noise_seed: seed(),
        cfg: 1,
        model,
        positive: at(scail, 0),
        negative: at(scail, 1),
        sampler: at(g.add("KSamplerSelect", { sampler_name: "euler" })),
        sigmas: at(g.add("BasicScheduler", { scheduler: "simple", steps: slow ? 4 : 6, denoise: 1, model: turbo })),
        latent_image: at(scail, 2),
      });
      let made = at(g.add("VAEDecode", { samples: at(sampled, 1), vae }));
      // Later segments: colours matched to the last frame so far.
      if (i) {
        const last = at(g.add("ImageFromBatch", { image: outs[i - 1], batch_index: -1, length: 1 }));
        made = at(g.add("ColorTransfer", { image_target: made, image_ref: last, method: "reinhard_lab", source_stats: "per_frame", strength: 1 }));
      }
      // Back onto the clip: the replaced people's outline, plus wherever the new frames differ clearly from the clip near
      // them (a pumpkin head bigger than the head it replaces, a limb the track drew a frame late), grown and feathered.
      // Only near the replaced people: SCAIL-2 sometimes paints a copy of a reference figure elsewhere in the frame, and
      // redraws the background a little differently, and that stays out.
      // Masks grow on the GPU: a wide blur cut at 2.5% spreads an outline by about two sigmas. (ImageBlur takes sigma up to 10.)
      const blur = (mask: Link, radius: number, sigma: number) => at(g.add("ImageToMask", { image: at(g.add("ImageBlur", { image: at(g.add("MaskToImage", { mask })), blur_radius: radius, sigma })), channel: "red" }));
      const spread = (mask: Link, sigma: number) => at(g.add("ThresholdMask", { mask: blur(mask, 31, Math.min(10, sigma)), value: 0.025 }));
      const both = (a: Link, b: Link, operation: string) => at(g.add("MaskComposite", { destination: a, source: b, x: 0, y: 0, operation }));
      // The frames between, drawn by FILM on a slow GPU; from here on, everything is at the clip's own rate.
      const madeHere = interp ? at(g.add("FrameInterpolate", { interp_model: interp, images: made, multiplier: 2 })) : made;
      let area = replacedArea(g, maskHere);
      const diff = at(g.add("ImageBlend", { image1: madeHere, image2: drivingHere, blend_factor: 1, blend_mode: "difference" }));
      const channel = (c: string) => at(g.add("ImageToMask", { image: diff, channel: c }));
      // Above about an eighth of full scale a channel on average, after a light blur against the redrawn background's grain.
      const changed = at(g.add("ThresholdMask", { mask: blur(both(both(channel("red"), channel("green"), "add"), channel("blue"), "add"), 7, 2), value: 0.36 }));
      // Within about 6% of the frame's height of the people being replaced (two spreads of ~20 px at 704p).
      const near = spread(spread(area, frameH * 0.02), frameH * 0.02);
      area = both(area, both(changed, near, "multiply"), "or");
      const soft = blur(spread(area, grow / 2), feather, Math.min(10, feather / 2));
      // At the generated size: what the next segment continues from and matches its colours to (SCAIL-2's own frames on a
      // slow GPU, where the mask is at the clip's rate).
      const kept = slow ? made : at(g.add("ImageCompositeMasked", { destination: driving, source: made, x: 0, y: 0, resize_source: false, mask: soft }));
      outs.push(kept);
      // Into the clip at its own size: the new people (and their mask) at the box's size, where the box is.
      const pasted = whole && box.w === width && box.h === height && !slow
        ? kept
        : at(g.add("ImageCompositeMasked", {
            destination: part,
            source: sized(madeHere, box.w, box.h),
            x: box.x,
            y: box.y,
            resize_source: false,
            mask: at(g.add("ImageToMask", { image: sized(at(g.add("MaskToImage", { mask: soft })), box.w, box.h), channel: "red" })),
          }));
      // Each segment after the first starts with the 5 frames it continues from (9 at the clip's rate when it made every 2nd).
      const lead = (SCAIL.overlap - 1) * rate + 1;
      output = output ? at(g.add("BatchImagesNode", { "images.image0": output, "images.image1": at(g.add("ImageFromBatch", { image: pasted, batch_index: lead, length: 4096 })) })) : pasted;
    }
    const video = g.add("CreateVideo", { images: output!, fps, bit_depth: 8, color_space: "sRGB", codec: "none" });
    g.add("SaveVideo", { video: at(video), filename_prefix: "crackio/scail-2", ...COMPACT_MP4 });
    return g.nodes;
  },
};

/* ------------------------------------------------------------------ LTX-2.5 + Ripple */

const RIPPLE = {
  lora: "LTX25_Ripple_v11.safetensors",
  // Its author's setting: higher carries the edit further, lower changes less of the rest.
  strength: 1.35,
  steps: 8,
  /** Frames a pass makes from the first frame (5 s at 24 fps, 8n + 1); a longer clip continues from each pass's last frame. */
  segment: 121,
  /**
   * Each way in one pass, up to the longest clip (20 s), so the whole edit comes from one drawing: 15 s took 5.4 min and
   * 31.8 GB on the 5090 at 720p. A second pass continued from the first one's frames (`hold`) still came out a shade
   * lighter (a jacket's blue jumped where it took over), so passes are only for longer ways.
   */
  long: 481,
  /** A pass after the first starts on the last one's final frames, kept as they are in its latent: it goes on from them. */
  hold: 17,
  /**
   * Long ways: the character redrawn again about every 4 s (`every` frames), on the calmest frame within `window` of
   * there, matched to the first redraw, and given to LTX as a keyframe of the same pass, so the model keeps the character
   * as drawn and moves into it on its own: nothing is blended. Before, at 10 s Pigeongoo jumped to smaller eyes, a thin
   * chain and new hair (a second pass from the first's drifted last frame), and crossfading into fresh passes showed a
   * see-through head and hair for the length of the blend.
   */
  keys: { every: 96, window: 24, edge: 24, strength: 1 },
  prompt:
    "Use the reference video for motion, timing, camera movement, composition, and unchanged scene content, while consistently propagating the visual edit established in the first frame throughout the video.",
  negative: "blurry, low resolution, ugly, garbled mess, compression artifacts, glitch, stop motion, still image, pixelated, robotic voice, oversaturated",
  /** Picture models that hand an edited frame back exactly where it was (Grok's edits drift and rescale: Ripple carries that as a jump). */
  editors: ["local:flux3-klein"],
  /**
   * The vision model for the looks at each drawing (the pose in words, which take is best): Gemini 3.5 Flash with a Comfy
   * API key (all four pictures of a look: the frame, two takes, the character), else Qwen3-VL 4B on your own GPU (FLUX 3
   * Klein's text encoder; it reads them as one labelled sheet). One of the two is required (see canLook).
   */
  lookers: ["comfy:google/gemini-3.5-flash", "local:text"],
};

type Size = { width: number; height: number };

/**
 * Lightricks' in/outpainting IC-LoRA (LTX-2.3, used with LTX-2.5 in Lightricks' own workflows): the guide is the clip with
 * the part to make anew painted green, the redrawn frame conditions the first frame, and the model draws only the green.
 */
const INPAINT = {
  lora: "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
  strength: 1,
  /** Stage 1 of Lightricks' distilled inpaint workflow, with euler_ancestral. */
  sigmas: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
  /** #66FF00, the green it was trained to fill. */
  green: 0x66ff00,
  /** How strongly the redrawn first frame holds (their stage 1). */
  start: 0.7,
};

/** Ripple's size for a shape: about 0.9 MP at 720p (704×1248 at 9:16), 0.5 MP at 540p, on LTX's grid of 32. */
function rippleSize(ratio: number, resolution: unknown) {
  const r = Math.min(3, Math.max(1 / 3, ratio));
  const mp = String(resolution ?? "720p").toLowerCase() === "540p" ? 0.5 : 0.9;
  const h = Math.sqrt((mp * 1e6) / r);
  return { width: snap(h * r, 32), height: snap(h, 32) };
}

/** A click on the clip: when (seconds) and where (0–1 across and down its frame). */
type Pick = { t: number; x: number; y: number };

function pickOf(p: unknown): Pick | null {
  const o = (p ?? {}) as Partial<Pick>;
  const ok = [o.t, o.x, o.y].every((v) => typeof v === "number" && Number.isFinite(v));
  return ok ? { t: Math.max(0, o.t!), x: Math.min(1, Math.max(0, o.x!)), y: Math.min(1, Math.max(0, o.y!)) } : null;
}

function picksOf(job: EngineJob): Pick[] {
  const raw = job.options?.extra?.picks;
  return (Array.isArray(raw) ? raw : []).flatMap((p) => pickOf(p) ?? []);
}

/**
 * One change from the Swap area: what was clicked (`at`, and `what` it is in words) and what it becomes: one of the
 * job's pictures (`ref`, a Cast member's sheet or a picture you added, with its noun, look, clothes and kind), a change
 * in words ("turns bright red", "becomes a vintage camper van"), or nothing (removed).
 */
type Edit = { at: Pick; what: string; to: "cast" | "words" | "remove"; ref?: number; noun: string; look: string; wearing: string; kind: string; words: string };

/**
 * Templates' characters as changes, through the same redraw as the Swap area's: who was clicked for each slot becomes
 * that slot's character (its sheet, look and clothes), and the points SAM 3.1 follows for each. One character needs no
 * click (the redraw only needs who it is in words); several need one each (`extra.slotPicks`), or there are none.
 */
function slotEdits(job: EngineJob, picks: Pick[]): { edits: Edit[]; points: Pick[][] } {
  const extra = job.options?.extra ?? {};
  const nth = (key: string, i: number) => (Array.isArray(extra[key]) && typeof extra[key][i] === "string" ? (extra[key][i] as string).trim() : "");
  const edit = (i: number, at: Pick): Edit => ({ at, what: nth("targets", i) || "the main person", to: "cast", ref: i, noun: nth("subjects", i), look: nth("looks", i), wearing: nth("wearing", i), kind: nth("kinds", i) || "person", words: "" });
  if (job.references.length === 1) return { edits: [edit(0, picks[0] ?? { t: 0, x: 0.5, y: 0.5 })], points: picks.length ? [picks] : [] };
  const each = (Array.isArray(extra.slotPicks) ? extra.slotPicks : []).map((list) => (Array.isArray(list) ? list.flatMap((p) => pickOf(p) ?? []) : []));
  if (job.references.length < 2 || each.length !== job.references.length || each.some((list) => !list.length)) return { edits: [], points: picks.length ? [picks] : [] };
  return { edits: each.map((list, i) => edit(i, list[0])), points: each };
}

function editsOf(job: EngineJob): Edit[] {
  const raw = job.options?.extra?.edits;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return (Array.isArray(raw) ? raw : []).slice(0, 4).flatMap((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const at = pickOf(o.at);
    const to = o.to === "cast" || o.to === "words" || o.to === "remove" ? o.to : null;
    const ref = typeof o.ref === "number" && o.ref >= 0 && o.ref < job.references.length ? Math.round(o.ref) : undefined;
    if (!at || !to || (to === "cast" && ref === undefined) || (to === "words" && !text(o.words, 400))) return [];
    return [{ at, what: text(o.what, 200) || "the one clicked", to, ref, noun: text(o.noun, 120), look: text(o.look, 1200), wearing: text(o.wearing, 500), kind: text(o.kind, 20), words: text(o.words, 400) }];
  });
}

/** Every frame of a list of white-on-black masks (one byte a pixel): how much of it is lit, and the box around that. */
function maskBox(mask: Buffer, size: Size) {
  let [area, x0, y0, x1, y1] = [0, size.width, size.height, -1, -1];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] < 128) continue;
    area++;
    const [x, y] = [i % size.width, Math.floor(i / size.width)];
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  return area ? { area, box: { x: x0, y: y0, w: x1 + 1 - x0, h: y1 + 1 - y0 } } : null;
}

/**
 * Ripple carried over less than this many frames either way goes wrong on fast moves (Özil: redrawn 1 s in, the first
 * half second showed the grandma again beside Pigeongoo), so the frame redrawn is the first, the last, or one at least
 * this far from both ends.
 */
const MIN_BACK = 48;

/**
 * The frame to redraw: where what was clicked shows biggest (with several subjects, the frame that shows the most of
 * them, then the biggest all round), the first or last frame or one MIN_BACK frames from both ends. Cut off by the top or a side counts
 * for less (the bottom is where vertical clips cut everyone); each subject's box there, in the masks' pixels (null
 * where it's out of sight). Null when nothing shows.
 */
type Seen = { frame: number; boxes: (Box | null)[]; seen: number; score: number };

function bestFrame(masks: Buffer[][], size: Size) {
  let best: Seen | null = null;
  let first: Seen | null = null;
  const last = masks[0].length - 1;
  for (let frame = 0; frame <= last; frame++) {
    if (frame && frame < last && (frame < MIN_BACK || frame > last - MIN_BACK)) continue;
    let [seen, score] = [0, 0];
    const boxes = masks.map((list) => {
      const found = list[frame] ? maskBox(list[frame], size) : null;
      if (!found) return null;
      const { box } = found;
      const cut = [box.x <= 1, box.y <= 1, box.x + box.w >= size.width - 1].filter(Boolean).length;
      seen++;
      score += Math.log(found.area * 0.7 ** cut);
      return box;
    });
    if (seen && (!best || seen > best.seen || (seen === best.seen && score > best.score))) best = { frame, boxes, seen, score };
    if (frame === 0) first = best;
  }
  // Forward from the first frame wins unless the subjects show much bigger later: Ripple carried backward (from 2 s in)
  // sometimes zoomed in or brought the original back beside the new one; forward only, as the first version ran, it didn't.
  if (best && first && first.seen === best.seen && (first.score - best.score) / Math.max(1, best.seen) >= Math.log(0.45)) return first;
  return best;
}

/** Every subject's outline in one, frame by frame. */
function unionOf(masks: Buffer[][], size: Size) {
  if (masks.length === 1) return masks[0];
  return masks[0].map((_, f) => {
    const out = Buffer.alloc(size.width * size.height);
    for (const list of masks) {
      const m = list[f];
      if (m) for (let i = 0; i < out.length; i++) if (m[i] > out[i]) out[i] = m[i];
    }
    return out;
  });
}

/**
 * SAM 3.1's look at the clip, at about 640 px, white on black, in the clip's order: each subject outlined in every
 * frame (a subject is the points clicked on it, on one frame), tracked forward from the frame it was clicked on and
 * backward on the clip played in reverse; and everyone SAM 3.1 finds in each frame (`others`, one outline a frame), so a
 * swap can keep its hands off the people around. `count` is the clip's frames as ComfyUI read them. Null when there's no
 * look or a subject is nowhere.
 */
async function rippleLook(tools: RecipeTools, clip: string, reversed: string, count: number, W: number, H: number, subjects: Pick[][]) {
  if (!tools.probe) return null;
  const g = new Graph();
  const sam = g.add("CheckpointLoaderSimple", { ckpt_name: SCAIL.sam });
  const s = Math.min(1, 640 / Math.max(W, H));
  const small = { width: snap(W * s, 16), height: snap(H * s, 16) };
  const frames = (file: string) =>
    at(g.add("ImageScale", { image: at(g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file })) }), 0), upscale_method: "area", ...small, crop: "disabled" }));
  const ahead = frames(clip);
  const back = frames(reversed);
  const track = (images: Link, from: number, length: number, outline: Link) =>
    at(g.add("MaskToImage", {
      mask: at(g.add("SAM3_TrackToMask", {
        track_data: at(g.add("SAM3_VideoTrack", { images: at(g.add("ImageFromBatch", { image: images, batch_index: from, length })), model: at(sam), initial_mask: outline, detection_threshold: 0.5, max_objects: 1, detect_interval: 1 })),
        object_indices: "0",
      })),
    }));
  const clicked = subjects.map((points) => Math.min(count - 1, Math.round(points[0].t * LTX.fps)));
  const parts: Link[] = [];
  for (const [k, points] of subjects.entries()) {
    const c = clicked[k];
    const coords = JSON.stringify(points.map((p) => ({ x: Math.round(p.x * (small.width - 1)), y: Math.round(p.y * (small.height - 1)) })));
    const outline = at(
      g.add("SAM3_Detect", {
        model: at(sam),
        image: at(g.add("ImageFromBatch", { image: ahead, batch_index: c, length: 1 })),
        threshold: 0.4,
        refine_iterations: 2,
        individual_masks: false,
        positive_coords: at(g.add("PrimitiveString", { value: coords })),
      }),
    );
    // Forward from the clicked frame, then backward from it.
    parts.push(track(ahead, c, count - c, outline), track(back, count - 1 - c, c + 1, outline));
  }
  // Everyone in each frame (up to 24 people, found by name), then any ball they play with (Özil: the grandma's ball went
  // with her when she was redrawn), 90 frames at a time.
  for (const text of ["person:24", "ball:4"]) {
    const named = at(g.add("CLIPTextEncode", { text, clip: at(sam, 1) }));
    for (let from = 0; from < count; from += 90) {
      const found = g.add("SAM3_Detect", { model: at(sam), image: at(g.add("ImageFromBatch", { image: ahead, batch_index: from, length: Math.min(90, count - from) })), conditioning: named, threshold: 0.45, refine_iterations: 0, individual_masks: false });
      parts.push(at(g.add("MaskToImage", { mask: at(found, 0) })));
    }
  }
  // One animated picture for a single download.
  g.add("SaveAnimatedWEBP", { images: at(g.add("BatchImagesNode", Object.fromEntries(parts.map((p, k) => [`images.image${k}`, p])))), filename_prefix: "crackio/ripple-look", fps: LTX.fps, lossless: true, quality: 100, method: "fastest" });
  const [webp] = await tools.probe(g.nodes);
  if (!webp) return null;
  const read = sharp(webp, { animated: true, limitInputPixels: false });
  const { delay } = await read.metadata();
  const { data, info } = await read.extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== small.width) return null;
  // The WebP keeps a run of identical frames as one longer frame (Özil: 22 frames with her out of sight came back as
  // one, the look was thrown away and the swap ran on the whole frame): one page a frame again, by how long each shows.
  const per = small.width * small.height;
  const unit = Math.trunc(1000 / LTX.fps);
  const pages: Buffer[] = [];
  for (let p = 0; p < Math.floor(data.length / per); p++) {
    for (let n = Math.max(1, Math.round((delay?.[p] ?? unit) / unit)); n > 0; n--) pages.push(data.subarray(p * per, (p + 1) * per));
  }
  // Each subject: its frames ahead and behind (the clicked one twice); then everyone, a frame each; then the balls.
  const frameCount = (pages.length - subjects.length) / (subjects.length + 2);
  if (!Number.isInteger(frameCount) || frameCount < Math.max(9, count - 2) || frameCount > count) return null;
  const masks = subjects.map((_, k) => {
    const c = Math.min(clicked[k], frameCount - 1);
    const base = k * (frameCount + 1);
    const list: Buffer[] = new Array(frameCount);
    for (let i = 0; i < frameCount - c; i++) list[c + i] = pages[base + i];
    for (let j = 1; j <= c; j++) list[c - j] = pages[base + frameCount - c + j];
    return list;
  });
  if (masks.some((list) => !list.some((m) => maskBox(m, small)))) return null;
  // Everyone else (white) and the balls (grey) in one outline a frame, without the people who are what you clicked:
  // their whole blob goes (a cardigan's flaps the click's outline missed were kept as "someone else" and cut into the
  // new one).
  const base = subjects.length * (frameCount + 1);
  const picked = unionOf(masks, small);
  const others = Array.from({ length: frameCount }, (_, f) => {
    const people = withoutSubjects(pages[base + f], picked[f], small);
    const balls = pages[base + frameCount + f];
    const out = Buffer.alloc(per);
    for (let i = 0; i < per; i++) out[i] = people[i] >= 128 ? 255 : balls[i] >= 128 ? 160 : 0;
    return out;
  });
  return { masks, others, small, count: frameCount };
}

/**
 * A mask of people (one byte a pixel) without the ones who are the subject: each separate blob that is mostly the
 * subject's outline is cleared. A blob where someone else touches the subject (the keeper diving at her) stays: cleared,
 * the keeper took the new one's suit again.
 */
function withoutSubjects(people: Buffer, subject: Buffer | undefined, size: Size) {
  if (!subject) return people;
  const out = Buffer.from(people);
  const seen = new Uint8Array(out.length);
  let subjectArea = 0;
  for (let i = 0; i < subject.length; i++) if (subject[i] >= 128) subjectArea++;
  if (!subjectArea) return out;
  const stack: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (seen[start] || out[start] < 128) continue;
    const blob: number[] = [];
    let shared = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      blob.push(i);
      if (subject[i] >= 128) shared++;
      const [x, y] = [i % size.width, Math.floor(i / size.width)];
      for (const j of [x > 0 ? i - 1 : -1, x < size.width - 1 ? i + 1 : -1, y > 0 ? i - size.width : -1, y < size.height - 1 ? i + size.width : -1]) {
        if (j < 0 || seen[j] || out[j] < 128) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (shared >= blob.length * 0.6) for (const i of blob) out[i] = 0;
  }
  return out;
}

/** A one-byte mask grown by about `r` pixels. */
async function grown(mask: Buffer, size: Size, r: number) {
  const soft = await sharp(mask, { raw: { ...size, channels: 1 } }).blur(Math.max(0.3, r / 2)).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < soft.length; i++) soft[i] = soft[i] >= 16 ? 255 : 0;
  return soft;
}

/**
 * Where a redraw of subject `k` must leave the frame as it was (W×H, one byte a pixel, 255: all of it): everyone else
 * SAM 3.1 found and the other subjects, but not subject k grown a little (its own edges may change). Null when that's
 * nowhere. Picture models restyle the people beside the one they're asked for, and Ripple carries whatever changed.
 */
async function guardAt(k: number, here: (Buffer | undefined)[], others: Buffer | undefined, small: Size, W: number, H: number) {
  const n = small.width * small.height;
  const keep = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let v = others?.[i] ?? 0;
    for (const [j, m] of here.entries()) if (j !== k && m && m[i] > v) v = m[i];
    keep[i] = v >= 128 ? 255 : 0;
  }
  const own = here[k] ? await grown(here[k]!, small, Math.round(small.height * 0.02)) : null;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (own?.[i]) keep[i] = 0;
    if (keep[i]) any = true;
  }
  if (!any) return null;
  return sharp(await grown(keep, small, 2), { raw: { ...small, channels: 1 } }).blur(1).resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
}

/** `next` over `before` (both W×H pictures), except where `guard` keeps `before` (255: all of it). */
async function keepWhere(before: Buffer, next: Buffer, guard: Buffer, W: number, H: number) {
  const [a, b] = await Promise.all([before, next].map((p) => sharp(p).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer()));
  for (let i = 0; i < guard.length; i++) {
    const g = guard[i];
    if (g) for (let c = i * 3; c < i * 3 + 3; c++) b[c] = Math.round((a[c] * g + b[c] * (255 - g)) / 255);
  }
  return sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** One frame of a clip by its number (exactly that frame), as a PNG at W×H. */
async function frameNo(file: string, n: number, W: number, H: number, signal: AbortSignal) {
  const run = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),scale=${W}:${H}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { signal, timeoutMs: 60_000 });
  if (!run.stdout.length) throw new EngineError(`Couldn't read frame ${n} of the clip.`);
  return run.stdout;
}

/**
 * How much each frame of a clip moves: the mean change from the frame before, on a small grey copy. A long swap's
 * keyframes go on calm frames: sharp to redraw, and never mid-spin.
 */
async function motionOf(file: string, signal: AbortSignal) {
  const side = 48;
  const run = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${side}:${side},format=gray`, "-an", "-f", "rawvideo", "-"], { signal, timeoutMs: 2 * 60_000 });
  const size = side * side;
  const n = Math.floor(run.stdout.length / size);
  const out = Array.from({ length: n }, () => 0);
  for (let f = 1; f < n; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Math.abs(run.stdout[f * size + i] - run.stdout[(f - 1) * size + i]);
    out[f] = sum / size;
  }
  if (n > 1) out[0] = out[1];
  return out;
}

/** A clip played backwards (a new file in `dir`). */
async function backwards(file: string, dir: string, signal: AbortSignal) {
  const out = path.join(dir, "reversed.mp4");
  const run = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", "reverse", "-an", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", out], { signal, timeoutMs: 5 * 60_000 });
  if (run.code !== 0) throw new EngineError("Couldn't play the clip backwards.");
  return out;
}

/** Masks in a given order as a small lossless clip (white on black at 24 fps), for the graph to load. */
async function maskClip(masks: Buffer[], order: number[], size: Size, file: string, signal: AbortSignal) {
  const raw = `${file}.gray`;
  const blank = Buffer.alloc(size.width * size.height);
  await fs.writeFile(raw, Buffer.concat(order.map((f) => masks[f] ?? blank)));
  const run = await runFfmpeg(
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size.width}x${size.height}`, "-r", String(LTX.fps), "-i", raw, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", file],
    { signal, timeoutMs: 2 * 60_000 },
  );
  await fs.rm(raw, { force: true });
  if (run.code !== 0) throw new EngineError("Couldn't save the outlines of what you picked.");
  return file;
}

/**
 * The part of a W×H frame to redraw around a subject's box: the box with room around it (a fifth of its height above
 * for hair and hats, an eighth below, a quarter each side for arms), widened to the nearest shape Crackio renders and
 * kept inside the frame. Null when that is half the frame or more: the whole frame is redrawn then. A small subject
 * redrawn this way gets the picture model's full size for its face and clothes, instead of a corner of a frame.
 */
function zoomBox(box: Box, W: number, H: number): Box | null {
  const s = Math.max(box.h, box.w * 0.8);
  const [x1, y1] = [box.x + box.w + s * 0.25, box.y + box.h + s * 0.125];
  let [x0, y0] = [box.x - s * 0.25, box.y - s * 0.2];
  const shape = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ((x1 - x0) / (y1 - y0)))) < Math.abs(Math.log(best.w / best.h / ((x1 - x0) / (y1 - y0)))) ? a : best));
  const r = shape.w / shape.h;
  let [w, h] = [x1 - x0, y1 - y0];
  if (w / h < r) w = h * r;
  else h = w / r;
  [w, h] = [Math.min(W, w), Math.min(H, h)];
  if ((w * h) / (W * H) >= 0.5) return null;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  x0 = Math.min(W - w, Math.max(0, cx - w / 2));
  y0 = Math.min(H - h, Math.max(0, cy - h / 2));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h) };
}

const SWAP_CHECK = `You compare takes of the same edit of a video frame. Image 1 is the original frame, the next images are takes of the edit, and the last image shows who or what should now be in it.
Pick the take where the one named below is most fully replaced by the one in the last image: a person's face, hair and skin must now be the new one's, and their whole outfit from head to toe too (top, skirt or trousers, legs, shoes) unless a costume is named below (that costume is meant to be worn, even when it matches the original's clothes); an animal, vehicle or object must now be the new one entirely. Glasses or a colour added to the original do not count. Small things they wear or hold (a watch, a ring, a phone) do not matter either way. Prefer the take that keeps the original's exact pose, size and place and the rest of the frame unchanged, with no extra figures. A take that redraws the new one standing in a stock pose instead of the original's (a raised leg put down, a ball or object dropped, arms moved) is wrong even when the new one looks right.
Answer with JSON only: {"best": the take's image number, "replaced": true or false for that take, "pose": true or false (that take keeps the original's body position, limbs and what they hold or touch), "left": "what is still wrong in that take, in a few words"}`;

/**
 * The best of the takes, read by a vision model next to the original and the character: which take shows the new one
 * most fully in place, and whether even that one still shows the original. Null when no vision model answers.
 */
async function bestTake(frame: string, takes: Buffer[], picture: string, who: string, costume: string, dir: string, signal: AbortSignal) {
  const files = await Promise.all(
    takes.map(async (take, k) => {
      const file = path.join(dir, `take-${k}.png`);
      await fs.writeFile(file, take);
      return file;
    }),
  );
  // Loaded here: the text models' module reaches the engines, which load these recipes.
  const { askText } = await import("@/lib/engines/refine");
  const answer = await askText({
    instructions: SWAP_CHECK,
    text: `Replaced: ${who}.${costume ? ` Costume asked for: ${costume}.` : ""} Takes: ${files.map((_, k) => `image ${k + 2}`).join(", ")}.`,
    references: [
      { path: frame, label: "the original frame" },
      ...files.map((f, k) => ({ path: f, label: `take ${k + 1}` })),
      { path: picture, label: "who or what should now be there" },
    ],
    imageEdge: 1024,
    detail: "high",
    prefer: RIPPLE.lookers,
    signal,
    timeoutMs: 60_000,
  }).catch(() => null);
  const read = answer ? jsonObject<{ best?: unknown; replaced?: unknown; pose?: unknown; left?: unknown }>(answer) : null;
  if (typeof read?.replaced !== "boolean") return null;
  const k = typeof read.best === "number" ? Math.round(read.best) - 2 : 0;
  return { take: Math.min(takes.length - 1, Math.max(0, k)), replaced: read.replaced, pose: read.pose !== false, left: typeof read.left === "string" ? read.left.trim() : "" };
}

/**
 * A frame of the clip (W×H) with the change made. Your picture model gets the frame (or, with `focus`, the part of it
 * around the subject, so a small one is drawn at full size) and each character's pictures (a sheet, then a close-up),
 * and redraws each character in place of what it replaces, in the same pose, size and place; a local model first, since
 * it hands the picture back where it was. With `tries` above one it draws that many and a vision model keeps the best;
 * when even that one still shows the original, it draws once more. Without pictures the job's words are the change
 * ("make the car red"). The edit goes back where it came from, over the frame (a zoomed part with feathered edges).
 */
async function rippleRedraw(job: EngineJob, tools: RecipeTools, frame: Buffer, W: number, H: number, focus: Box | null = null, tries = 1): Promise<Buffer> {
  const firstUrl = job.options?.extra?.firstFrame;
  const given = typeof firstUrl === "string" ? urlToPath(firstUrl) : null;
  if (given) return sharp(await fs.readFile(given)).resize(W, H, { fit: "fill" }).removeAlpha().png().toBuffer();
  if (!tools.edit) throw new EngineError("No picture model is connected to redraw the clip's frame.", "Install FLUX 3 Klein on the Local page, or connect one.");
  const extra = job.options?.extra ?? {};
  const list = (key: string) => (Array.isArray(extra[key]) ? (extra[key] as unknown[]) : []).map((v) => (typeof v === "string" ? v.trim() : ""));
  const [nouns, targets, looks, wearing, kinds] = [list("subjects"), list("targets"), list("looks"), list("wearing"), list("kinds")];
  const views = (Array.isArray(extra.views) ? (extra.views as unknown[]) : []).map((l) => (Array.isArray(l) ? l : []).flatMap((u) => (typeof u === "string" ? (urlToPath(u) ?? []) : [])));
  const pictures: string[] = [];
  const whom: string[] = [];
  const costumes: string[] = [];
  // Who each one is comes first: with the trend's own costume (the same tweed suit), FLUX 3 Klein kept the dancer's
  // blonde wig and face and only added the glasses, and Ripple carried that unchanged dancer through the clip.
  const parts = job.references.slice(0, 3).map((ref, k) => {
    const shown = [ref.path, ...(views[k] ?? []).slice(0, 1)].map((p) => {
      pictures.push(p);
      return `image ${pictures.length + 1}`;
    });
    const noun = (nouns[k] || "character").replace(/^(a|an|the)\s+/i, "");
    const who = targets[k] || (job.references.length > 1 ? (["the person on the left", "the person on the right"][k] ?? "the next person") : "the main person");
    whom.push(who);
    const look = looks[k] ? `: ${looks[k].replace(/[.\s]+$/, "")}` : "";
    const lead = `${who.charAt(0).toUpperCase()}${who.slice(1)} becomes the ${noun} shown in ${shown.join(" and ")}`;
    if (kinds[k] && kinds[k] !== "person" && kinds[k] !== "face") return `${lead}${look}.`;
    const clothes = wearing[k] ? `wearing ${wearing[k].replace(/[.\s]+$/, "")}` : "in the clothes from those pictures";
    if (wearing[k]) costumes.push(`${who} → ${clothes}`);
    // Hands too: Pigeongoo kept the man's tattooed human hands when only the face, hair and skin were named.
    return `${lead}, with that one's own face, head, hair, skin, hands and build${look}, ${clothes}. Nothing of the original person's face, hair, hands, wig or headwear stays.`;
  });
  const change = typeof extra.instruction === "string" && extra.instruction.trim() ? extra.instruction.trim() : job.prompt.trim();
  if (!parts.length && !change) throw new EngineError("Say what changes in the clip, or add who goes into it.");
  const what = focus ? "a close-up of part of a frame from a video" : "a frame from a video";
  const keep = `Keep everything else in image 1 exactly as it is: the place, the light, the other people, the framing and any text over the picture.`;
  const prompt = parts.length
    ? [
        `Image 1 is ${what}.`,
        ...parts,
        "Each takes exactly the pose, size and place in the frame of what it replaces: the same turn of the body and head, the same arms, hands and legs, holding and touching what it touched; a vehicle or object keeps the same angle, perspective and shadow.",
        keep,
      ].join(" ")
    : `Image 1 is ${what}. ${change.replace(/[.\s]+$/, "")}. ${keep}`;
  const part = focus ?? { x: 0, y: 0, w: W, h: H };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-ripple-"));
  let edited: Buffer | null = null;
  try {
    const file = path.join(dir, "frame.png");
    await fs.writeFile(file, focus ? await sharp(frame).extract({ left: part.x, top: part.y, width: part.w, height: part.h }).png().toBuffer() : frame);
    const shape = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / (part.w / part.h))) < Math.abs(Math.log(best.w / best.h / (part.w / part.h))) ? a : best)).id;
    const draw = (words: string) => tools.edit!(words, [file, ...pictures], shape, { prefer: RIPPLE.editors, stage: focus ? "Redrawing the subject up close" : "Redrawing the frame" });
    // All at once: each queues on the GPU while the others' pictures travel.
    const takes = (await Promise.all(Array.from({ length: Math.max(1, tries) }, () => draw(prompt)))).filter((take): take is Buffer => Boolean(take));
    edited = takes[0] ?? null;
    // Checked by a vision model when one is connected: the best take kept, and drawn once more when it still shows the original.
    const seen = takes.length && pictures.length ? await bestTake(file, takes, pictures[0], whom.join(" and "), costumes.join("; "), dir, tools.signal) : null;
    if (seen) {
      edited = takes[seen.take];
      if (!seen.replaced) {
        // One more take, told what was left, then the better of it and the best so far.
        tools.note?.(`The redrawn frame still showed ${seen.left || "the original"}: drawing it again`);
        const again = await draw(`${prompt} The last try left ${seen.left || "the original person's face and hair"} in place: change that too.`);
        const better = again ? await bestTake(file, [edited, again], pictures[0], whom.join(" and "), costumes.join("; "), dir, tools.signal) : null;
        if (again) edited = better ? [edited, again][better.take] : again;
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!edited) throw new EngineError("No picture model is connected to redraw the clip's frame.", "Install FLUX 3 Klein on the Local page, or connect one.");
  return laidBack(frame, edited, part, Boolean(focus));
}

/**
 * An edited part of a frame back where it came from: in the part's shape, or cut to the nearest shape Crackio renders
 * (centred). A zoomed part fades in over its outer 6%, so its edges meet the frame unseen.
 */
async function laidBack(frame: Buffer, edited: Buffer, part: Box, zoomed: boolean) {
  const { width = part.w, height = part.h } = await sharp(edited).metadata();
  const r = width / height;
  const [w, h] = Math.abs(Math.log(r / (part.w / part.h))) < 0.02 ? [part.w, part.h] : r > part.w / part.h ? [part.w, Math.round(part.w / r)] : [Math.round(part.h * r), part.h];
  let laid = await sharp(edited).rotate().removeAlpha().resize(w, h, { fit: "fill" }).png().toBuffer();
  if (zoomed) {
    const f = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const fade = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><filter id="b"><feGaussianBlur stdDeviation="${f / 2}"/></filter></defs><rect x="${f}" y="${f}" width="${w - 2 * f}" height="${h - 2 * f}" fill="white" filter="url(#b)"/></svg>`,
    );
    laid = await sharp(laid).ensureAlpha().composite([{ input: fade, blend: "dest-in" }]).png().toBuffer();
  }
  return sharp(frame).composite([{ input: laid, left: part.x + Math.round((part.w - w) / 2), top: part.y + Math.round((part.h - h) / 2) }]).png().toBuffer();
}

const EDIT_CHECK = `You compare takes of the same edit of a video frame. Image 1 is the original frame and the next images are takes of the edit.
Pick the take that makes the change asked for below most completely and convincingly, keeping the exact pose, size, place and light of what changed and the rest of the frame unchanged, with no extra figures or objects. For a removal nothing of what was removed may be left (no outline, shadow or smudge), and what was behind it must look natural.
Answer with JSON only: {"best": the take's image number, "done": true or false for that take, "left": "what still isn't as asked, in a few words"}`;

/** The best of the takes of a change in words, read by a vision model next to the original. Null when none answers. */
async function bestEdit(frame: string, takes: Buffer[], asked: string, dir: string, signal: AbortSignal) {
  const files = await Promise.all(
    takes.map(async (take, k) => {
      const file = path.join(dir, `edit-${k}.png`);
      await fs.writeFile(file, take);
      return file;
    }),
  );
  const { askText } = await import("@/lib/engines/refine");
  const answer = await askText({
    instructions: EDIT_CHECK,
    text: `The change asked for: ${asked} Takes: ${files.map((_, k) => `image ${k + 2}`).join(", ")}.`,
    references: [{ path: frame, label: "the original frame" }, ...files.map((f, k) => ({ path: f, label: `take ${k + 1}` }))],
    imageEdge: 1024,
    detail: "high",
    prefer: RIPPLE.lookers,
    signal,
    timeoutMs: 60_000,
  }).catch(() => null);
  const read = answer ? jsonObject<{ best?: unknown; done?: unknown; left?: unknown }>(answer) : null;
  if (typeof read?.done !== "boolean") return null;
  const k = typeof read.best === "number" ? Math.round(read.best) - 2 : 0;
  return { take: Math.min(takes.length - 1, Math.max(0, k)), done: read.done, left: typeof read.left === "string" ? read.left.trim() : "" };
}

const POSE = `Image 1 is part of a frame from a video. Describe the exact body position of the one named below in one sentence of at most 45 words, so an artist could redraw someone else in exactly that position: which way the body and head face, where each arm, hand, leg and foot is (raised, bent, stretched, mid-kick, mid-step), and anything they hold, carry or touch (a ball at the right foot, a cup in the left hand). Answer with the sentence only.`;

/**
 * The pose of who's being replaced, in words, from the picture being redrawn: picture models given a character's sheet
 * tend to draw it standing as on the sheet (Özil: the grandma mid-kick became Pigeongoo standing with the ball gone, and
 * Ripple froze him there and made up a player beside him). Empty when no vision model answers.
 */
async function poseOf(file: string, who: string, signal: AbortSignal) {
  const { askText } = await import("@/lib/engines/refine");
  const answer = await askText({ instructions: POSE, text: `The one: ${who}.`, references: [{ path: file, label: "the picture" }], imageEdge: 768, prefer: RIPPLE.lookers, signal, timeoutMs: 30_000 }).catch(() => null);
  return answer?.trim().replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 320) ?? "";
}

/**
 * Who it is by their looks alone, without where they are or what they're doing: "the man in the beige cardigan" from
 * "… raising his hand in the center of the frame" (at 13 s it was the other one raising his hand, and he got the pigeon).
 */
const bareWho = (what: string) =>
  what.split(/,\s*who\b|\s+who\s|\s+at the\s|\s+on the (?:left|right)\b|\s+in the (?:left|right|middle|centre|center)\b|\s+(?:standing|sitting|playing|raising|dancing|leaning|holding|looking|pointing|walking|running|jumping|singing|talking|smiling|freestyling|hopping|spinning|kneeling|lying|typing|gesturing|waving|clapping|filming|grooving|bouncing|knocking|skipping)\b/i)[0].trim() || what;

/**
 * How much of the frame outside `box` (grown by a quarter) a redraw changed: a keyframe's change drawn onto someone
 * else (the pigeon on the keyboard player) shows up there.
 */
async function changedOutside(before: Buffer, after: Buffer, box: Box, W: number, H: number) {
  const [w, h] = [160, Math.max(1, Math.round((160 * H) / W))];
  const [a, b] = await Promise.all([before, after].map((p) => sharp(p).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer()));
  const [gx, gy] = [box.w * 0.25, box.h * 0.25];
  const [x0, x1, y0, y1] = [((box.x - gx) * w) / W, ((box.x + box.w + gx) * w) / W, ((box.y - gy) * h) / H, ((box.y + box.h + gy) * h) / H];
  let [outside, changed] = [0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      outside++;
      if (Math.abs(a[y * w + x] - b[y * w + x]) > 40) changed++;
    }
  return outside ? changed / outside : 0;
}

/** Where it is, in a subject's name ("on the right", "in the left side of the frame (x 62–100%…)"): wrong in a close-up. */
const PLACE_WORDS = /,?\s*(?:(?:on|at|in|to)\s+the\s+(?:far\s+)?(?:left|right|middle|center|centre|top|bottom|front|back|background|foreground)(?:\s+(?:side|edge|half|corner))?(?:\s+of\s+the\s+(?:frame|picture|image|shot))?|\(x [^)]*\))/gi;

/** What one change asks the picture model for, in a sentence or two; `shown` names the pictures of what it becomes. */
function editSentence(e: Edit, who: string, shown: string[]) {
  const Who = `${who.charAt(0).toUpperCase()}${who.slice(1)}`;
  // A held thing came back as another one (a white bottle for the amber one) until the hand was told it's empty.
  if (e.to === "remove") return `Remove ${who} completely: it is gone, as if it had never been there. Show what was behind it, continuing the background, the floor and the light naturally, with no outline, shadow or smudge left, and nothing else put in its place. Anyone who held or touched it keeps their hand exactly where it was, now empty, fingers relaxed.`;
  if (e.to === "words") {
    const w = e.words.replace(/[.\s]+$/, "");
    return `${Who} ${/^(becomes?|turns?|wears?|is|gets?|has|changes?|looks?|holds?)\b/i.test(w) ? w : `becomes ${w}`}. Only ${who} changes, at exactly the same pose, angle, size and place.`;
  }
  const noun = (e.noun || "character").replace(/^(a|an|the)\s+/i, "");
  const look = e.look ? `: ${e.look.replace(/[.\s]+$/, "")}` : "";
  const lead = `${Who} becomes the ${noun} shown in ${shown.join(" and ")}`;
  if (e.kind && e.kind !== "person" && e.kind !== "face") return `${lead}${look}, at exactly the same angle, perspective, size and place, with the same shadow.`;
  const clothes = e.wearing ? `wearing ${e.wearing.replace(/[.\s]+$/, "")}` : "dressed head to toe in the outfit from those pictures (top, trousers or skirt, legs and shoes)";
  // Hands in view: a scarecrow drawn with straw over its hands had nothing for the video to move (Alors on Danse: the
  // keyboard player's hands stayed still while the original's played).
  return `${lead}, with that one's own face, head, hair, skin, hands and build${look}, ${clothes}. Nothing of the original person's face, hair, hands, wig, headwear or clothes stays, not a skirt, legging or shoe. It takes exactly the pose, size and place of the one it replaces: the same turn of the body and head, the same arms, hands and legs, holding and touching what they touched. Its hands stay in plain view wherever the original's are, never hidden by sleeves, cuffs, straw or fur.`;
}

/**
 * One change drawn into a frame (W×H): the frame (or, with `focus`, the part around the subject) and the pictures of
 * what it becomes go to your picture model, `tries` takes are drawn, a vision model keeps the best and asks for one more
 * when even that one isn't done; the take goes back over the frame, except where `guard` keeps the frame as it was.
 */
async function redrawPart(
  tools: RecipeTools,
  frame: Buffer,
  W: number,
  H: number,
  ask: { sentence: string; pictures: string[]; who: string; costume: string; focus: Box | null; guard: Buffer | null; stage: string; keep?: string; pose?: boolean; strict?: boolean },
  tries: number,
) {
  const { focus } = ask;
  const part = focus ?? { x: 0, y: 0, w: W, h: H };
  const keep = ask.keep ?? "Keep everything else in image 1 exactly as it is: the place, the light, the other people and things, the framing and any text over the picture.";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-ripple-"));
  try {
    const file = path.join(dir, "frame.png");
    await fs.writeFile(file, focus ? await sharp(frame).extract({ left: part.x, top: part.y, width: part.w, height: part.h }).png().toBuffer() : frame);
    const pose = ask.pose ? await poseOf(file, ask.who, tools.signal) : "";
    const held = pose ? ` Their exact position, kept as it is: ${pose.replace(/[.\s]+$/, "")}.` : "";
    const prompt = `Image 1 is ${focus ? "a close-up of part of a frame from a video" : "a frame from a video"}. ${ask.sentence}${held} ${keep}`;
    const shape = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / (part.w / part.h))) < Math.abs(Math.log(best.w / best.h / (part.w / part.h))) ? a : best)).id;
    const draw = (words: string) => tools.edit!(words, [file, ...ask.pictures], shape, { prefer: RIPPLE.editors, stage: ask.stage });
    // All at once: each queues on the GPU while the others' pictures travel.
    const takes = (await Promise.all(Array.from({ length: Math.max(1, tries) }, () => draw(prompt)))).filter((take): take is Buffer => Boolean(take));
    if (!takes.length) throw new EngineError("No picture model is connected to redraw the clip's frame.", "Install FLUX 3 Klein on the Local page, or connect one.");
    // A character is judged against its picture; a change in words against the words.
    const judge = async (list: Buffer[]) => {
      if (!ask.pictures.length) return bestEdit(file, list, ask.sentence, dir, tools.signal);
      const seen = await bestTake(file, list, ask.pictures[0], ask.who, ask.costume, dir, tools.signal);
      return seen && { take: seen.take, done: seen.replaced && seen.pose, left: seen.left || (seen.pose ? "" : "the pose") };
    };
    let edited = takes[0];
    const seen = await judge(takes);
    let confirmed = Boolean(seen?.done);
    if (seen) {
      edited = takes[seen.take];
      if (!seen.done) {
        tools.note?.(`The redrawn frame still showed ${seen.left || "the original"}: drawing it again`);
        const again = await draw(`${prompt} The last try got this wrong: ${seen.left || "part of the original was left"}. Fix that, in exactly the original's pose.`);
        const better = again ? await judge([edited, again]) : null;
        if (again) edited = better ? [edited, again][better.take] : again;
        confirmed = Boolean(better?.done);
      }
    }
    // A keyframe in the wrong pose pulls the clip away from the moves (Alors on Danse: one drawn standing where he
    // leans into the camera turned Pigeongoo's face half human): none at all is better.
    if (ask.strict && !confirmed) throw new EngineError("The redrawn frame wasn't confirmed in the original's pose.");
    const placed = await laidBack(frame, edited, part, Boolean(focus));
    return ask.guard ? keepWhere(frame, placed, ask.guard, W, H) : placed;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The frame (W×H) with every change from the Swap area drawn in, one at a time, each up close when its subject is small
 * (`boxes`: each subject's box on this frame), and kept off everyone else (`guards`): removals first, then characters,
 * then changes in words; a new background (`background`, words) last, over the whole frame.
 */
async function editRedraw(job: EngineJob, tools: RecipeTools, frame: Buffer, W: number, H: number, edits: Edit[], boxes: (Box | null)[], guards: (Buffer | null)[], tries: number, background: string, match?: string | (string | undefined)[], light = false) {
  if (!tools.edit) throw new EngineError("No picture model is connected to redraw the clip's frame.", "Install FLUX 3 Klein on the Local page, or connect one.");
  const extra = job.options?.extra ?? {};
  const views = (Array.isArray(extra.views) ? (extra.views as unknown[]) : []).map((l) => (Array.isArray(l) ? l : []).flatMap((u) => (typeof u === "string" ? (urlToPath(u) ?? []) : [])));
  const rank = { remove: 0, cast: 1, words: 2 };
  let current = frame;
  for (const k of edits.map((_, k) => k).sort((a, b) => rank[edits[a].to] - rank[edits[b].to])) {
    const e = edits[k];
    const focus = boxes[k] && extra.zoom === true ? zoomBox(boxes[k]!, W, H) : null;
    // A later frame (`light`): who it is without where they are or what they do there, which may have changed by then
    // (Alors on Danse: "at the laptop" had the one leaning into the camera drawn back at the laptop).
    const who = (focus ? e.what.replace(PLACE_WORDS, "") : light ? bareWho(e.what) : e.what).trim() || "the one in the middle";
    const own = e.to === "cast" && e.ref !== undefined ? [job.references[e.ref].path, ...(views[e.ref] ?? []).slice(0, 1)] : [];
    // A later frame of the same clip (`match`: the first one redrawn, or each change's own part of it): drawn to look
    // exactly like it.
    const earlier = Array.isArray(match) ? match[k] : match;
    const pictures = earlier ? [...own, earlier] : own;
    const same = earlier ? ` It looks exactly as in image ${pictures.length + 1}, the same ${e.to === "cast" ? "character" : "change"} a moment earlier in this clip: the same face, colours, clothes and details.` : "";
    const sentence = `${editSentence(e, who, own.map((_, i) => `image ${i + 2}`))}${same}`;
    tools.note?.(`${e.to === "remove" ? "Removing" : "Changing"} ${who}${focus ? ", up close" : ""}`);
    const before = current;
    current = await redrawPart(
      tools,
      current,
      W,
      H,
      { sentence, pictures, who, costume: e.to === "cast" && e.wearing ? `${who} → wearing ${e.wearing}` : "", focus, guard: guards[k] ?? null, stage: focus ? "Redrawing the subject up close" : "Redrawing the frame", pose: e.to === "cast", strict: light },
      tries,
    );
    if (light && boxes[k] && (await changedOutside(before, current, boxes[k]!, W, H)) > 0.04) throw new EngineError(`The redraw changed more than ${who}.`);
  }
  if (background) {
    tools.note?.("Changing the background");
    const sentence = `Replace the background with ${background.replace(/[.\s]+$/, "")}: everything behind the people and things in front becomes that, from the same camera angle and framing, while every person and thing in front stays exactly as it is, in the same place, pose, size and light.`;
    current = await redrawPart(tools, current, W, H, { sentence, pictures: [], who: "the background", costume: "", focus: null, guard: null, stage: "Redrawing the background", keep: "Keep the framing and any text over the picture as they are." }, tries);
  }
  return current;
}

/** The clip at LTX's 24 fps (a new file in a folder of its own), or the clip itself when it already is. */
async function at24fps(file: string, fps: number | undefined, signal: AbortSignal) {
  if (fps && Math.abs(fps - LTX.fps) < 0.05) return { file, done: async () => {} };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-ripple-"));
  const out = path.join(dir, "clip.mp4");
  const run = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `fps=${LTX.fps}`, "-an", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", out], { signal, timeoutMs: 5 * 60_000 });
  if (run.code !== 0) throw new EngineError("Couldn't turn the clip into 24 fps for LTX-2.5.");
  return { file: out, done: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/** A batch of n frames in reverse order (ComfyUI has no node for it): one frame at a time, 50 to a batch. */
function reversedFrames(g: Graph, images: Link, n: number): Link {
  const batch = (links: Link[]) => (links.length === 1 ? links[0] : at(g.add("BatchImagesNode", Object.fromEntries(links.map((l, k) => [`images.image${k}`, l])))));
  const groups: Link[] = [];
  for (let start = n - 1; start >= 0; start -= 50) {
    const frames: Link[] = [];
    for (let i = start; i > start - 50 && i >= 0; i--) frames.push(at(g.add("ImageFromBatch", { image: images, batch_index: i, length: 1 })));
    groups.push(batch(frames));
  }
  return batch(groups);
}

type RippleModels = { model: Link; cond: string; vae: Link; audioVae: Link; upscaler: Link | null; steps: number; keyStrength: number };

/**
 * Ripple over `count` frames of `frames` (at `size`, the last frame held at least 16 frames longer), from `anchor`
 * (the edited first one): passes of up to `segment` frames, each later one starting on the frame the last ended with.
 * With an upscaler (sharp), each pass is made at half size and LTX's ×2 latent upscaler takes it to `size` for 3 more
 * steps against the same guide, as LTX-2.5's own two-stage workflows do. The made frames, at `size`.
 */
function ripplePasses(g: Graph, m: RippleModels, frames: Link, anchor: Link, count: number, size: Size, segment: number, masks?: (string | null)[], zone?: Link, keys?: Key[]): Link {
  const half = m.upscaler ? { width: size.width / 2, height: size.height / 2 } : size;
  const sized = (image: Link, s: Size) => (s === size ? image : at(g.add("ImageScale", { image, upscale_method: "area", ...s, crop: "disabled" })));
  const step = segment - 1;
  // The plain way continues each pass from the last one's frames and takes keyframes; masks, inpainting and the sharp
  // stage keep the old passes (each from the last one's final frame).
  const plain = !masks?.length && !zone && !m.upscaler;
  const layout = plain ? continuedPasses(count, segment, RIPPLE.hold) : Array.from({ length: Math.max(1, Math.ceil((count - 1) / step)) }, (_, p) => ({ from: p * step, length: Math.min(segment, Math.ceil(Math.max(1, Math.min(step, count - 1 - p * step)) / 8) * 8 + 1) }));
  let output: Link | null = null;
  let last: { frames: Link; length: number; from: number } | null = null;
  for (let p = 0; p < layout.length; p++) {
    const { from, length } = layout[p];
    // The guide: the clip from this pass's first frame, that frame being the edit (or the last pass's frame there).
    const start = last ? at(g.add("ImageFromBatch", { image: last.frames, batch_index: from - last.from, length: 1 })) : anchor;
    // Inpainting: the clip itself with the subject's zone painted green, every frame; the start frame goes in the latent.
    const green = zone ? at(g.add("EmptyImage", { ...size, batch_size: 1, color: INPAINT.green })) : null;
    const painted = (from: number, n: number) =>
      at(g.add("ImageCompositeMasked", {
        destination: at(g.add("ImageFromBatch", { image: frames, batch_index: from, length: n })),
        source: green!,
        x: 0,
        y: 0,
        resize_source: false,
        mask: at(g.add("ImageToMask", { image: at(g.add("ImageFromBatch", { image: zone!, batch_index: from, length: n })), channel: "red" })),
      }));
    const guide = zone
      ? painted(from, length)
      : at(g.add("BatchImagesNode", { "images.image0": start, "images.image1": at(g.add("ImageFromBatch", { image: frames, batch_index: from + 1, length: length - 1 })) }));
    const silence = at(g.add("LTXVEmptyLatentAudio", { frames_number: length, frame_rate: LTX.fps, batch_size: 1, audio_vae: m.audioVae }));
    const sample = (positive: Link, negative: Link, latent: Link, audio: Link, sigmas: Link) =>
      g.add("LTXVSeparateAVLatent", {
        av_latent: at(g.add("SamplerCustomAdvanced", {
          noise: at(g.add("RandomNoise", { noise_seed: seed() })),
          guider: at(g.add("CFGGuider", { model: m.model, positive, negative, cfg: 1 })),
          sampler: at(g.add("KSamplerSelect", { sampler_name: zone ? "euler_ancestral" : "euler" })),
          sigmas,
          latent_image: at(g.add("LTXVConcatAVLatent", { video_latent: latent, audio_latent: audio })),
        })),
      });
    // With a mask, the latent starts as the guide itself and only the mask's part is made anew: the rest (everyone else,
    // the place) stays the clip's own inside the model, which blends the new one into it, so no edge is pasted.
    const mask = !m.upscaler ? (masks?.[p] ?? null) : null;
    const empty = at(g.add("EmptyLTXVLatentVideo", { ...half, length, batch_size: 1 }));
    // Continuing: this pass begins on the last one's final frames, kept as they are in its latent.
    const kept =
      plain && last ? at(g.add("LTXVImgToVideoInplace", { vae: m.vae, image: at(g.add("ImageFromBatch", { image: last.frames, batch_index: from - last.from, length: RIPPLE.hold })), latent: empty, strength: 1, bypass: false })) : null;
    let guided = g.add("LTXVAddGuide", {
      positive: at(m.cond, 0),
      negative: at(m.cond, 1),
      vae: m.vae,
      latent: mask
        ? at(g.add("VAEEncodeTiled", { pixels: sized(guide, half), vae: m.vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 }))
        : zone
          ? at(g.add("LTXVImgToVideoInplace", { vae: m.vae, image: sized(start, half), latent: empty, strength: last ? 1 : INPAINT.start, bypass: false }))
          : (kept ?? empty),
      image: sized(guide, half),
      frame_idx: 0,
      strength: 1,
    });
    // Keyframes in this pass (past what it keeps): the character redrawn there, which the model moves into on its own.
    for (const key of plain ? (keys ?? []) : []) {
      if (key.frame <= from + (last ? RIPPLE.hold : 0) || key.frame >= from + length - 1) continue;
      guided = g.add("LTXVAddGuide", {
        positive: at(guided, 0),
        negative: at(guided, 1),
        vae: m.vae,
        latent: at(guided, 2),
        image: at(g.add("ImageScale", { image: at(g.add("LoadImage", { image: key.image })), upscale_method: "lanczos", ...size, crop: "disabled" })),
        frame_idx: key.frame - from,
        strength: m.keyStrength,
      });
    }
    const latent = mask
      ? at(g.add("SetLatentNoiseMask", { samples: at(guided, 2), mask: at(g.add("ImageToMask", { image: at(g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file: mask })) }), 0), channel: "red" })) }))
      : at(guided, 2);
    const sigmas = zone ? at(g.add("ManualSigmas", { sigmas: INPAINT.sigmas })) : at(g.add("BasicScheduler", { model: m.model, scheduler: "simple", steps: m.steps, denoise: 1 }));
    const first = sample(at(guided, 0), at(guided, 1), latent, silence, sigmas);
    let video = g.add("LTXVCropGuides", { positive: at(guided, 0), negative: at(guided, 1), latent: at(first, 0) });
    if (m.upscaler) {
      const regided = g.add("LTXVAddGuide", {
        positive: at(video, 0),
        negative: at(video, 1),
        vae: m.vae,
        latent: at(g.add("LTXVLatentUpsampler", { samples: at(video, 2), upscale_model: m.upscaler, vae: m.vae })),
        image: guide,
        frame_idx: 0,
        strength: 1,
      });
      const second = sample(at(regided, 0), at(regided, 1), at(regided, 2), at(first, 1), at(g.add("ManualSigmas", { sigmas: LTX.stage2 })));
      video = g.add("LTXVCropGuides", { positive: at(regided, 0), negative: at(regided, 1), latent: at(second, 0) });
    }
    const made = at(g.add("VAEDecodeTiled", { samples: at(video, 2), vae: m.vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 }));
    if (plain && last && output) {
      // Continued: the frames it kept are the last pass's own, already in; the rest follows on.
      output = at(g.add("BatchImagesNode", { "images.image0": output, "images.image1": at(g.add("ImageFromBatch", { image: made, batch_index: RIPPLE.hold, length: length - RIPPLE.hold })) }));
    } else {
      // Each pass after the first starts on the frame the last one ended with: that frame is kept once.
      output = output ? at(g.add("BatchImagesNode", { "images.image0": output, "images.image1": at(g.add("ImageFromBatch", { image: made, batch_index: 1, length: length - 1 })) })) : made;
    }
    last = { frames: made, length, from };
  }
  return at(g.add("ImageFromBatch", { image: output!, batch_index: 0, length: count }));
}

/**
 * The made frames whole (W×H), with only everyone else put back from the clip: the new one is never cut (laying the
 * made frames in through its outline left a rim of the original and see-through limbs, which looked cheap), and the
 * people around keep their own clothes (the whole frame alone redressed the keeper). Balls stay as made.
 */
function restorePeople(g: Graph, made: Link, frames: Link, outline: Link, others: Link, W: number, H: number, reach: number): Link {
  const here = at(g.add("ImageScale", { image: made, upscale_method: "lanczos", width: W, height: H, crop: "disabled" }));
  const mask = (image: Link) => at(g.add("ImageToMask", { image, channel: "red" }));
  const blur = (m: Link, radius: number, sigma: number) => mask(at(g.add("ImageBlur", { image: at(g.add("MaskToImage", { mask: m })), blur_radius: radius, sigma })));
  const sized = (image: Link, method: string) => at(g.add("ImageScale", { image, upscale_method: method, width: W, height: H, crop: "disabled" }));
  const level = (images: Link, value: number, method: string) => at(g.add("ThresholdMask", { mask: mask(sized(images, method)), value }));
  const picked = level(outline, 0.5, "bilinear");
  // People only (white; balls are grey), scaled without blending so a person's edge doesn't read as a ball.
  const people = level(others, 0.85, "nearest-exact");
  const own = at(g.add("ThresholdMask", { mask: blur(picked, 31, Math.max(1, Math.min(10, reach * 0.06))), value: 0.025 }));
  const back = at(g.add("MaskComposite", { destination: people, source: own, x: 0, y: 0, operation: "subtract" }));
  const soft = blur(at(g.add("ThresholdMask", { mask: blur(back, 7, 2), value: 0.1 })), 9, 3);
  return at(g.add("ImageCompositeMasked", { destination: here, source: frames, x: 0, y: 0, resize_source: false, mask: soft }));
}

/**
 * Where the in/outpainting LoRA may draw (white on black, at `size`): what you picked in each frame, grown by about
 * `reach` (the clip's pixels, scaled to `size`), so the new one has room for its own shape.
 */
function zoneOf(g: Graph, outline: Link, size: Size, H: number, reach: number): Link {
  const mask = (image: Link) => at(g.add("ImageToMask", { image, channel: "red" }));
  const r = (reach * size.height) / H;
  const f = Math.max(1, r / 20);
  const small = at(g.add("ImageScale", { image: outline, upscale_method: "area", width: Math.max(32, Math.round(size.width / f)), height: Math.max(32, Math.round(size.height / f)), crop: "disabled" }));
  const spread = at(g.add("ThresholdMask", { mask: mask(at(g.add("ImageBlur", { image: small, blur_radius: 31, sigma: 10 }))), value: 0.025 }));
  const back = at(g.add("ImageScale", { image: at(g.add("MaskToImage", { mask: spread })), upscale_method: "bilinear", ...size, crop: "disabled" }));
  return at(g.add("MaskToImage", { mask: at(g.add("ThresholdMask", { mask: mask(back), value: 0.5 })) }));
}

/** The made frames laid onto the clip (W×H) through the zone they were made in (softened): the rest is the clip's own. */
function layIn(g: Graph, made: Link, frames: Link, zone: Link, W: number, H: number): Link {
  const here = at(g.add("ImageScale", { image: made, upscale_method: "lanczos", width: W, height: H, crop: "disabled" }));
  const mask = (image: Link) => at(g.add("ImageToMask", { image, channel: "red" }));
  const wide = at(g.add("ImageScale", { image: zone, upscale_method: "bilinear", width: W, height: H, crop: "disabled" }));
  const soft = mask(at(g.add("ImageBlur", { image: at(g.add("MaskToImage", { mask: at(g.add("ThresholdMask", { mask: mask(at(g.add("ImageBlur", { image: wide, blur_radius: 31, sigma: 10 }))), value: 0.05 })) })), blur_radius: 21, sigma: 7 })));
  return at(g.add("ImageCompositeMasked", { destination: frames, source: here, x: 0, y: 0, resize_source: false, mask: soft }));
}

/** A keyframe of a way: its frame (counted along the way) and the redrawn picture on the GPU's side. */
type Key = { frame: number; image: string };

/**
 * A way's keyframes (frames counted along it): about every `every` frames, each on the calmest frame within `window`
 * of there (sharp, never mid-spin) where what you picked shows (`seen`), none in the last `edge` frames, and none where
 * the clip moves more than `limit` (a window with only fast moves gets none).
 */
function keyFrames(n: number, keys: { every: number; window: number; edge: number }, motion?: (k: number) => number, seen?: (k: number) => boolean, limit = Infinity) {
  const out: number[] = [];
  for (let last = 0; ; ) {
    const [lo, hi] = [last + keys.every - keys.window, Math.min(last + keys.every + keys.window, n - 1 - keys.edge)];
    if (lo > hi) return out;
    let [best, score] = [-1, Infinity];
    for (let k = lo; k <= hi; k++) {
      if (seen && !seen(k)) continue;
      let [sum, moved] = [Math.abs(k - (last + keys.every)) * 1e-3, 0];
      for (let j = Math.max(0, k - 4); j <= Math.min(n - 1, k + 4); j++) [sum, moved] = [sum + (motion?.(j) ?? 0), moved + (motion?.(j) ?? 0)];
      if (moved / 9 > limit) continue;
      if (sum < score) [best, score] = [k, sum];
    }
    if (best >= 0) out.push(best);
    last = best >= 0 ? best : hi;
  }
}

/** Passes over n frames of up to `segment` (8k + 1), each after the first starting on the last `hold` of the one before. */
function continuedPasses(n: number, segment: number, hold: number) {
  const out: { from: number; length: number }[] = [];
  for (let from = 0; ; from += out[out.length - 1].length - hold) {
    const length = Math.min(segment, Math.ceil(Math.max(1, n - 1 - from) / 8) * 8 + 1);
    out.push({ from, length });
    if (from + length >= n) return out;
  }
}

/** Ripple's passes over n frames of `segment` at most: where each starts and how many frames it makes (8k + 1). */
function passesOf(n: number, segment: number) {
  const step = segment - 1;
  return Array.from({ length: Math.max(1, Math.ceil((n - 1) / step)) }, (_, p) => ({ from: p * step, length: Math.min(segment, Math.ceil(Math.max(1, Math.min(step, n - 1 - p * step)) / 8) * 8 + 1) }));
}

/**
 * One pass's noise mask, one picture per latent frame (the first frame, then each 8) at the latent's own size (one pixel
 * a 32 px cell, `grid`): where the new one may be made (what you picked over those frames, grown by `reach`), but not
 * on anyone else beyond a little of that reach; then as many black pictures for the guide's latent frames, which stay
 * as they are. Every cell is all made or all kept: half-kept cells came out as coloured halos around the feet. Saved
 * as a small lossless clip.
 */
async function passMask(subject: Buffer[], others: Buffer[], order: number[], from: number, length: number, size: Size, reach: number, grid: Size, file: string, signal: AbortSignal) {
  const frames = (length - 1) / 8 + 1;
  const pick = (k: number) => order[Math.min(order.length - 1, from + k)];
  const union = (lists: Buffer[], ks: number[]) => {
    const out = Buffer.alloc(size.width * size.height);
    for (const k of ks) {
      const m = lists[pick(k)];
      if (m) for (let i = 0; i < out.length; i++) if (m[i] > out[i]) out[i] = m[i];
    }
    return out;
  };
  const out: Buffer[] = [];
  for (let t = 0; t < frames; t++) {
    const ks = t === 0 ? [0] : Array.from({ length: 8 }, (_, j) => 8 * (t - 1) + 1 + j);
    const own = union(subject, ks);
    const zone = await grown(own, size, reach);
    // Everyone else (and the ball) kept right up to the new one's edge: overlapping, both were made anew and smeared.
    const near = await grown(own, size, Math.max(2, reach * 0.12));
    const rest = union(others, ks);
    for (let i = 0; i < zone.length; i++) if (rest[i] >= 128 && !near[i]) zone[i] = 0;
    // Down to the latent's cells: a cell is made when any of it is.
    const cells = Buffer.alloc(grid.width * grid.height);
    for (let i = 0; i < zone.length; i++) {
      if (zone[i] < 128) continue;
      const [x, y] = [i % size.width, Math.floor(i / size.width)];
      cells[Math.min(grid.height - 1, Math.floor((y * grid.height) / size.height)) * grid.width + Math.min(grid.width - 1, Math.floor((x * grid.width) / size.width))] = 255;
    }
    out.push(cells);
  }
  const blank = Buffer.alloc(grid.width * grid.height);
  for (let t = 0; t < frames; t++) out.push(blank);
  return maskClip(out, out.map((_, k) => k), grid, file, signal);
}

/**
 * How far the new ones may reach past the old outlines, in the clip's pixels: a fifth of how tall the subjects usually
 * are (a kicking leg, a cape, a bigger head), between 24 px and 14% of the frame.
 */
function reachOf(masks: Buffer[], size: Size, H: number) {
  const heights = masks.flatMap((m) => {
    const seen = m ? maskBox(m, size) : null;
    return seen ? [seen.box.h] : [];
  });
  heights.sort((a, b) => a - b);
  const typical = (heights.length ? heights[Math.floor(heights.length / 2)] : size.height / 3) * (H / size.height);
  return Math.round(Math.min(H * 0.14, Math.max(24, typical * 0.2)));
}

/**
 * Swap with LTX-2.5 and WepeNerd's Ripple IC-LoRA ("first frame, all frames"): one frame is redrawn with your
 * characters in place (rippleRedraw), and Ripple carries that change through the clip, which guides every frame (in
 * tests a dancer, a talking man and a falling car kept their moves, mouth, place and captions). The guide is the clip
 * with its first frame swapped for the edit; LTX-2.5 distilled, 8 steps, CFG 1, Ripple at 1.35, as its author runs it.
 *
 * With a click on the subject (`extra.picks`), SAM 3.1 outlines it through the whole clip first. The frame where it
 * shows biggest is redrawn (several takes, the best kept; zoomed in around it only with `extra.zoom`), and Ripple runs
 * from there both ways: forward on the clip, backward on the clip played in reverse, each way in one pass, so the
 * whole clip comes from one drawing; on long ways the character is redrawn again about every 4 s and given to the same
 * pass as keyframes. The whole frame is LTX's;
 * `extra.keep` puts everyone else SAM 3.1 finds back from the clip. The Swap area's `extra.edits` work the same way
 * with several subjects, each becoming a character, a change in words or nothing (removed); `extra.background`
 * (words) redraws the rest too.
 * `extra.sharp`: each pass is made at half size and LTX's ×2 latent upscaler finishes it (about 2 MP).
 * Without a click: the first frame is redrawn and Ripple runs forward from it. Long ways get keyframes: the character
 * redrawn again about every 4 s on a calm frame, which LTX moves into within the same pass (RIPPLE.keys).
 */
/** Whether a swap's drawings can be checked: Gemini 3.5 Flash through a Comfy key, or a picture-reading Qwen on a ComfyUI. */
async function canLook() {
  // Loaded here: the text models' modules reach the engines, which load these recipes.
  const [{ listModels }, { localLlm }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/comfy-text")]);
  if ((await listModels()).some((m) => m.id === RIPPLE.lookers[0] && m.available)) return true;
  return Boolean(await localLlm(true).catch(() => null));
}

const RIPPLE_SWAP: Recipe = {
  id: "ltx-2.5-ripple",
  name: "LTX-2.5 Ripple swap",
  output: "video",
  expectedMs: (job) =>
    30_000 +
    (Array.isArray(job.options?.extra?.edits) ? job.options.extra.edits.length * 30_000 : 0) +
    Math.max(1, Math.ceil((seconds(job) * LTX.fps) / (RIPPLE.segment - 1))) * (String(job.options?.resolution) === "540p" ? 45_000 : 80_000) * (job.options?.extra?.sharp === true ? 2.5 : 1),
  units: (job) => (seconds(job) / 5) * (String(job.options?.resolution) === "540p" ? 0.6 : 1) * (job.options?.extra?.sharp === true ? 2.5 : 1),
  async build(job, tools) {
    if (!job.source) throw new EngineError("Pick a clip to swap something in.");
    if (tools.pool) throw new EngineError("LTX-2.5 Ripple runs on one GPU with about 24 GB.", "Run it on a bigger card (Advanced → Run on).");
    // Every drawing is checked (pose, outfit, the right one changed): never swapped unchecked.
    if (!(await canLook())) throw new EngineError("Swap needs a model to check its drawings.", "Install FLUX 3 Klein on the Local page (its Qwen3-VL 4B checks them on your GPU), or add a Comfy API key in Connections.");
    const info = await probe(job.source.path).catch(() => null);
    if (!info?.duration || !info.width || !info.height) throw new EngineError("Couldn't read the clip.");
    const [W, H] = [info.width, info.height];
    const extra = job.options?.extra ?? {};
    const sharp2 = extra.sharp === true;
    // Sharp: LTX's ×2 latent upscaler finishes each pass at the clip's own size (up to about 2 MP); else about 0.9 MP.
    const size = sharp2 ? { width: snap(Math.min(W, Math.sqrt(2.1e6 * (W / H))), 64), height: snap(Math.min(H, Math.sqrt(2.1e6 / (W / H))), 64) } : rippleSize(W / H, job.options?.resolution);
    // LTX makes 24 frames a second: the clip's own frames at that rate, up to 20 s.
    let count = Math.max(9, Math.min(20 * LTX.fps + 1, Math.round(info.duration * LTX.fps)));
    // Who or what was clicked: each change's own subject (the Swap area), or one subject from Templates' clicks.
    const picks = picksOf(job);
    const listed = editsOf(job);
    const slots = listed.length ? null : slotEdits(job, picks);
    const edits = slots ? slots.edits : listed;
    const subjects = slots ? slots.points : listed.map((e) => [e.at]);
    const background = typeof extra.background === "string" ? extra.background.trim().slice(0, 400) : "";
    // Two takes for each subject: a look compares two (Grok takes 4 pictures; with three takes the character's own
    // picture was the one left out), and a wrong pose or outfit is drawn once more.
    const tries = typeof extra.tries === "number" ? Math.min(4, Math.max(1, Math.round(extra.tries))) : subjects.length ? 2 : 1;
    const clip24 = await at24fps(job.source.path, info.fps, tools.signal);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-ripple-"));
    let clipName: string;
    let backName: string | null = null;
    let anchorAt = 0;
    let first: Buffer;
    let outlines: { ahead: string; behind: string | null; othersAhead: string; othersBehind: string | null; reach: number } | null = null;
    // Ripple made only around what you picked (a noise mask per pass), each way; null where it makes the whole frame.
    let noise: { ahead: (string | null)[]; behind: (string | null)[] } | null = null;
    let keys: { ahead: Key[]; behind: Key[] } = { ahead: [], behind: [] };
    try {
      clipName = (await tools.upload(clip24.file, "clip")).name;
      // What you clicked, outlined through the clip; its best frame (unless `extra.best` is false: the clicked one).
      const back = subjects.length ? await backwards(clip24.file, dir, tools.signal) : null;
      if (back) backName = (await tools.upload(back, "clip-back")).name;
      const lookOnce = (reversed: string) =>
        rippleLook(tools, clipName, reversed, count, W, H, subjects).catch((err) => {
          console.warn("[ripple] SAM 3.1 look failed:", (err as Error).message);
          return null;
        });
      // extra.v1 (comparisons): the swap as its first version ran on Özil (02:12 on Oct 29), when SAM's look came back
      // empty: no look, the whole first frame redrawn (two takes), Ripple forward from it over the whole frame.
      const v1 = extra.v1 === true;
      // Without the outline the swap would change the whole frame (everyone's clothes, the ball, the net): once more, then stop.
      const look = backName && !v1 ? ((await lookOnce(backName)) ?? (await lookOnce(backName))) : null;
      if (subjects.length && !look && !v1) throw new EngineError("SAM 3.1 couldn't follow what you picked through the clip.", "Click right on it, on a frame where it shows clearly, and try again.");
      if (look) count = look.count;
      const clicked = Math.min(count - 1, Math.round((subjects[0]?.[0].t ?? 0) * LTX.fps));
      const best = look ? (extra.best === false ? { frame: clicked, boxes: look.masks.map((list) => maskBox(list[clicked], look.small)?.box ?? null) } : bestFrame(look.masks, look.small)) : null;
      anchorAt = look && best ? best.frame : 0;
      const frame = await frameNo(clip24.file, anchorAt, W, H, tools.signal);
      const [sx, sy] = look ? [W / look.small.width, H / look.small.height] : [1, 1];
      const boxes = (best?.boxes ?? []).map((b) => (b ? { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy } : null));
      const why = extra.best === false ? "where you clicked" : subjects.length > 1 ? "where they show best" : "where it shows biggest";
      const given = typeof extra.firstFrame === "string" ? urlToPath(extra.firstFrame) : null;
      if (given && look) {
        // A redrawn frame given with the job (comparing settings on the same drawing).
        first = await sharp(await fs.readFile(given)).resize(W, H, { fit: "fill" }).removeAlpha().png().toBuffer();
      } else if (edits.length && !look && !v1) {
        // A template's one character, nothing clicked: the same redraw (its pose read first, the whole outfit, three
        // takes judged), on the first frame.
        tools.note?.("Redrawing the first frame");
        first = await editRedraw(job, tools, frame, W, H, edits, [], [], 3, background);
      } else if (edits.length && look) {
        tools.note?.(`Redrawing frame ${anchorAt} of ${count}, ${why}`);
        // Each change kept off everyone else in the frame, and off the other subjects.
        const here = look.masks.map((list) => list[anchorAt]);
        const guards = await Promise.all(edits.map((_, k) => guardAt(k, here, look.others[anchorAt], look.small, W, H)));
        first = await editRedraw(job, tools, frame, W, H, edits, boxes, guards, tries, background);
      } else {
        const focus = boxes[0] && extra.zoom === true ? zoomBox(boxes[0], W, H) : null;
        tools.note?.(look ? `Redrawing frame ${anchorAt} of ${count}, ${why}${focus ? ", up close" : ""}` : "Redrawing the first frame");
        first = await rippleRedraw(job, tools, frame, W, H, focus, v1 ? 2 : tries);
      }
      // Keyframes: on a long way the character is redrawn again about every 4 s, on a calm frame where it shows, matched
      // to the first (not for a new background, which each redraw would draw differently, or sharp mode).
      const most = Math.max(count - anchorAt, anchorAt + 1);
      if (edits.length && !sharp2 && !v1 && !background && extra.refresh !== false && most > RIPPLE.keys.every + RIPPLE.keys.edge - RIPPLE.keys.window) {
        const firstFile = path.join(dir, "first.png");
        await fs.writeFile(firstFile, first);
        // Each character's own part of the first drawing (its box and a fifth more around it): the whole frame had the
        // picture model copy the other character into the scene (Alors on Danse: a second Pigeongoo behind the one
        // leaning into the camera, who was then drawn away).
        const matches = await Promise.all(
          edits.map(async (_, k) => {
            const b = boxes[k];
            if (!b) return firstFile;
            const [left, top] = [Math.max(0, Math.floor(b.x - b.w * 0.2)), Math.max(0, Math.floor(b.y - b.h * 0.2))];
            const [width, height] = [Math.min(W - left, Math.ceil(b.w * 1.4)), Math.min(H - top, Math.ceil(b.h * 1.4))];
            if (width < 16 || height < 16) return firstFile;
            const file = path.join(dir, `first-${k}.png`);
            await fs.writeFile(file, await sharp(first).extract({ left, top, width, height }).png().toBuffer());
            return file;
          }),
        );
        const [sx2, sy2] = look ? [W / look.small.width, H / look.small.height] : [1, 1];
        const motion = await motionOf(clip24.file, tools.signal).catch(() => null);
        const firstAreas = look ? look.masks.map((list) => (list[anchorAt] ? (maskBox(list[anchorAt], look.small)?.area ?? 0) : 0)) : [];
        // Where each subject shows at least 40% of its usual size (not turned away, behind someone or out of the frame).
        const areas = look ? look.masks.map((list) => list.map((mask) => (mask ? (maskBox(mask, look.small)?.area ?? 0) : 0))) : null;
        const usual = areas?.map((list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]);
        const make = async (n: number, toFrame: (k: number) => number): Promise<Key[]> => {
          const clipFrame = (k: number) => Math.min(count - 1, Math.max(0, toFrame(k)));
          const frames = keyFrames(n, RIPPLE.keys, motion?.length ? (k) => motion[Math.min(motion.length - 1, clipFrame(k))] : undefined, areas ? (k) => areas.every((list, s) => list[clipFrame(k)] >= 0.4 * usual![s]) : undefined);
          // All at once: each waits mostly on the vision checks, so together they take about as long as one.
          const made = await Promise.all(
            frames.map(async (k): Promise<Key | null> => {
              const at = clipFrame(k);
              const still = await frameNo(clip24.file, at, W, H, tools.signal);
              const boxes2 = look ? look.masks.map((list) => { const b = list[at] ? maskBox(list[at], look.small)?.box : null; return b ? { x: b.x * sx2, y: b.y * sy2, w: b.w * sx2, h: b.h * sy2 } : null; }) : [];
              const guards2 = look ? await Promise.all(edits.map((_, e) => guardAt(e, look.masks.map((list) => list[at]), look.others[at], look.small, W, H))) : [];
              // Each character's crop only where it's about as big as in the first drawing: much closer or farther, the
              // picture model copied the crop's framing (the one leaning into the camera came back at the laptop).
              const near = matches.map((m, e) => {
                const [a0, a1] = [firstAreas[e] ?? 0, areas?.[e]?.[at] ?? 0];
                return !areas || (a0 && a1 / a0 >= 0.6 && a1 / a0 <= 1.6) ? m : undefined;
              });
              const drawn = await editRedraw(job, tools, still, W, H, edits, boxes2, guards2, 1, "", near, true).catch((err) => {
                if (tools.signal?.aborted) throw err;
                console.warn("[ripple] keyframe redraw failed:", (err as Error).message);
                return null;
              });
              return drawn ? { frame: k, image: (await tools.uploadData(drawn, `ripple-key-${at}-${Date.now().toString(36)}.png`)).name } : null;
            }),
          );
          return made.filter((key): key is Key => key !== null);
        };
        tools.note?.("Redrawing the character every 4 s too, so it stays as drawn");
        const [ahead, behind] = await Promise.all([count - anchorAt > 1 ? make(count - anchorAt, (k) => anchorAt + k) : [], anchorAt > 0 ? make(anchorAt + 1, (k) => anchorAt - k) : []]);
        keys = { ahead, behind };
      }
      if (look && (extra.keep === true || extra.latentMask === true || extra.inpaint === true) && !background) {
        const ahead = Array.from({ length: count - anchorAt }, (_, i) => anchorAt + i);
        const behind = Array.from({ length: anchorAt + 1 }, (_, i) => anchorAt - i);
        const union = unionOf(look.masks, look.small);
        const clipOf = async (masks: Buffer[], order: number[], name: string) => (await tools.upload(await maskClip(masks, order, look.small, path.join(dir, `${name}.mp4`), tools.signal), "outline")).name;
        outlines = {
          ahead: await clipOf(union, ahead, "ahead"),
          behind: anchorAt > 0 ? await clipOf(union, behind, "behind") : null,
          othersAhead: await clipOf(look.others, ahead, "others-ahead"),
          othersBehind: anchorAt > 0 ? await clipOf(look.others, behind, "others-behind") : null,
          reach: reachOf(union, look.small, H),
        };
        if (!sharp2 && extra.latentMask === true) {
          // The same reach in the outlines' own pixels, for the noise masks (an experiment: the made part came out a
          // shade lighter than the kept clip around it, as a patch).
          const small = (outlines.reach * look.small.height) / H;
          const masksFor = async (order: number[], name: string) =>
            Promise.all(
              passesOf(order.length, RIPPLE.long).map(async (pass, p) => {
                const file = await passMask(union, look.others, order, pass.from, pass.length, look.small, small, { width: size.width / 32, height: size.height / 32 }, path.join(dir, `${name}-${p}.mp4`), tools.signal);
                return (await tools.upload(file, "outline")).name;
              }),
            );
          noise = { ahead: count - anchorAt > 1 ? await masksFor(ahead, "noise-ahead") : [], behind: anchorAt > 0 ? await masksFor(behind, "noise-behind") : [] };
          tools.note?.(`Making the swap only within ${outlines.reach} px of what you picked; everyone else stays as filmed`);
        }
      }
    } finally {
      await clip24.done();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    const f = await filesFor("ltx-2.5-ripple");
    const g = new Graph();
    const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
    // Inpainting (extra.inpaint, with what you clicked): Lightricks' in/outpainting IC-LoRA in place of Ripple.
    const inpaint = extra.inpaint === true && Boolean(outlines) && !sharp2;
    const lora = inpaint
      ? at(g.add("LoraLoaderModelOnly", { model: at(g.add(...unetLoader(f.model ?? LTX.unet))), lora_name: INPAINT.lora, strength_model: num(extra.strength, 0.3, 2.5, INPAINT.strength) }))
      : at(g.add("LoraLoaderModelOnly", { model: at(g.add(...unetLoader(f.model ?? LTX.unet))), lora_name: f.lora ?? RIPPLE.lora, strength_model: num(extra.strength, 0.3, 2.5, RIPPLE.strength) }));
    // Fast mode: ComfyUI's EasyCache reuses a step's work when the next would barely change it.
    const cache = num(extra.cache, 0, 3, 0);
    const model = cache > 0 ? at(g.add("EasyCache", { model: lora, reuse_threshold: cache, start_percent: 0.15, end_percent: 0.95, verbose: false })) : lora;
    const text = at(g.add("CLIPLoader", { clip_name: f.text ?? LTX.textEncoder, type: "ltxv", device: "default" }));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? LTX.videoVae }));
    const audioVae = at(g.add("VAELoader", { vae_name: f.audio ?? LTX.audioVae }));
    const upscaler = sharp2 ? at(g.add("LatentUpscaleModelLoader", { model_name: f.upscaler ?? LTX.upscaler })) : null;
    // Its own sentence, then what the finished clip shows (Templates' scene words); inpainting: what's drawn in the green.
    const words = (inpaint ? [job.prompt.trim()] : [RIPPLE.prompt, job.prompt.trim()]).filter(Boolean).join(" ").slice(0, 3000);
    const cond = g.add("LTXVConditioning", {
      positive: at(g.add("CLIPTextEncode", { text: words, clip: text })),
      negative: at(g.add("CLIPTextEncode", { text: RIPPLE.negative, clip: text })),
      frame_rate: LTX.fps,
    });
    const models: RippleModels = { model, cond, vae, audioVae, upscaler, steps: Math.round(num(extra.steps, 2, 16, RIPPLE.steps)), keyStrength: num(extra.keyStrength, 0, 1, RIPPLE.keys.strength) };
    // Stretched, never cropped: the made frames go back onto the clip by the same stretch (a few percent at most).
    const sized = (image: Link) => at(g.add("ImageScale", { image, upscale_method: "lanczos", ...size, crop: "disabled" }));
    const loaded = (file: string) => at(g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file })) }), 0);
    // The last frame held a while longer, so a last pass always has its whole guide (the output is cut back to the clip).
    const held = (frames: Link, n: number) =>
      at(g.add("BatchImagesNode", { "images.image0": frames, "images.image1": at(g.add("RepeatImageBatch", { image: at(g.add("ImageFromBatch", { image: frames, batch_index: n - 1, length: 1 })), amount: 16 })) }));
    const anchor = sized(at(g.add("LoadImage", { image: (await tools.uploadData(first, `ripple-first-${Date.now().toString(36)}.png`)).name })));
    const clipFrames = loaded(clipName);
    let output: Link;
    if (!backName) {
      // Forward from the first frame in one pass, with its keyframes.
      output = ripplePasses(g, models, held(sized(clipFrames), count), anchor, count, size, RIPPLE.long, undefined, undefined, keys.ahead);
    } else {
      // Each way from the redrawn frame in one pass (5 s passes in sharp mode, which works at 2 MP).
      const segment = sharp2 ? RIPPLE.segment : RIPPLE.long;
      const way = (frames: Link, from: number, n: number, outline: string | null, others: string | null, masks?: (string | null)[], wayKeys?: Key[]) => {
        const part = at(g.add("ImageFromBatch", { image: frames, batch_index: from, length: n }));
        if (inpaint && outline) {
          const zone = zoneOf(g, held(loaded(outline), n), size, H, outlines?.reach ?? 48);
          return layIn(g, ripplePasses(g, models, held(sized(part), n), anchor, n, size, segment, undefined, zone), part, zone, W, H);
        }
        const made = ripplePasses(g, models, held(sized(part), n), anchor, n, size, segment, masks, undefined, wayKeys);
        // Made within a mask, the frames are used whole: the model kept everyone else, and laying the clip's own pixels
        // back around it showed the VAE's slight colour shift as a rim.
        if (masks?.length) return made;
        return outline && others ? restorePeople(g, made, part, loaded(outline), loaded(others), W, H, outlines?.reach ?? 48) : made;
      };
      const ahead = count - anchorAt > 1 ? way(clipFrames, anchorAt, count - anchorAt, outlines?.ahead ?? null, outlines?.othersAhead ?? null, noise?.ahead, keys.ahead) : null;
      // Backward: the clip played in reverse from the same frame, turned back the right way, without that frame twice.
      const behind = anchorAt > 0 ? way(loaded(backName), count - 1 - anchorAt, anchorAt + 1, outlines?.behind ?? null, outlines?.othersBehind ?? null, noise?.behind, keys.behind) : null;
      const before = behind ? at(g.add("ImageFromBatch", { image: reversedFrames(g, behind, anchorAt + 1), batch_index: 0, length: anchorAt })) : null;
      output = before && ahead ? at(g.add("BatchImagesNode", { "images.image0": before, "images.image1": ahead })) : (ahead ?? reversedFrames(g, behind!, anchorAt + 1));
    }
    const video = g.add("CreateVideo", { images: output, fps: LTX.fps, bit_depth: 8, color_space: "sRGB", codec: "none" });
    g.add("SaveVideo", { video: at(video), filename_prefix: "crackio/ltx-2.5-ripple", ...COMPACT_MP4 });
    return g.nodes;
  },
};

/* ------------------------------------------------------------------ images */

/** About `mp` megapixels in the job's shape, on a grid of 16. */
function imageSize(job: EngineJob, mp = 1) {
  const r = Math.min(3, Math.max(1 / 3, job.width / Math.max(1, job.height)));
  const h = Math.sqrt((mp * 1e6) / r);
  return { width: snap(h * r, 16), height: snap(h, 16) };
}

const count = (job: EngineJob) => Math.min(4, Math.max(1, job.count || 1));

/**
 * Z-Image Turbo (Tongyi-MAI, Apache-2.0; template image_z_image_turbo_int8): 6B, 8 steps at CFG 1 with
 * res_multistep, Qwen3-4B reading the prompt. Photoreal and fast.
 */
const Z_IMAGE: Recipe = {
  id: "z-image-turbo",
  name: "Z-Image Turbo",
  output: "image",
  expectedMs: (job) => 4_000 * count(job),
  units: count,
  // Its makers' largest sizes are the 1536 class (1536², 2048×1152): about 2.4 MP. Past that it breaks up.
  maxMp: 2.4,
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Describe the picture.");
    const { width, height } = tools.size ?? imageSize(job);
    const f = await filesFor("z-image-turbo");
    const g = new Graph();
    const clip = at(g.add(...clipLoader(f.text ?? "qwen_3_4b.safetensors", "lumina2")));
    const positive = at(g.add("CLIPTextEncode", { text: job.prompt, clip }));
    const unet = at(g.add(...unetLoader(f.model ?? "z_image_turbo_int8_convrot.safetensors")));
    const sampled = g.add("KSampler", {
      seed: seed(),
      steps: 8,
      cfg: 1,
      sampler_name: "res_multistep",
      scheduler: "simple",
      denoise: 1,
      model: at(g.add("ModelSamplingAuraFlow", { shift: 3, model: unet })),
      positive,
      negative: at(g.add("ConditioningZeroOut", { conditioning: positive })),
      latent_image: at(g.add("EmptySD3LatentImage", { width, height, batch_size: count(job) })),
    });
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "ae.safetensors" }));
    g.add("SaveImage", { images: at(g.add("VAEDecode", { samples: at(sampled), vae })), filename_prefix: "crackio/z-image-turbo" });
    return g.nodes;
  },
};

/** Alibaba PAI's Fun ControlNet Union 2.1 for Z-Image Turbo (Apache-2.0), distilled for its 8 steps: depth, pose, edges. */
const Z_CONTROL = "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors";

/**
 * The Director's shots (server/director-fresh `runDirectorControl`): Z-Image Turbo drawing the set's depth (`job.depth`,
 * white near) through the Fun ControlNet, a model patch ComfyUI's core loads (ModelPatchLoader) and puts on the model
 * (QwenImageDiffsynthControlnet). The model draws a whole new picture that keeps the set's camera and where everyone
 * stands, where the reference-picture shots copied their pixels: a real film still, not a flat one (the user's A/B on the
 * motorbike scene, Oct 2026). 4 s warm on an RTX 5090 at 1536x864 (nvfp4), against 32 to 46 s for Qwen-Image 2.1's shot.
 */
const Z_IMAGE_DIRECTOR: Recipe = {
  id: "z-image-director",
  name: "Z-Image Director",
  output: "image",
  expectedMs: () => 5_000,
  units: () => 1,
  // The ControlNet learned its control pictures at 512 to 1536 a side: drawn at 2048 the people slid off their marks.
  // Bigger pictures are drawn at 1536 and enlarged (a detail pass would redraw them without the layout).
  maxMp: 1.33,
  maxEdge: 1536,
  detailable: false,
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Describe the shot.");
    const { width, height } = tools.size ?? imageSize(job);
    const f = await filesFor("z-image-director");
    const g = new Graph();
    const clip = at(g.add(...clipLoader(f.text ?? "qwen_3_4b.safetensors", "lumina2")));
    const positive = at(g.add("CLIPTextEncode", { text: job.prompt, clip }));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "ae.safetensors" }));
    let model = at(g.add("ModelSamplingAuraFlow", { shift: 3, model: at(g.add(...unetLoader(f.model ?? "z_image_turbo_int8_convrot.safetensors"))) }));
    if (job.depth?.path) {
      // The depth at the picture's own size; how hard it holds (0.9 kept the camera and the marks, the people real).
      const png = await sharp(await fs.readFile(job.depth.path)).resize(width, height, { fit: "fill" }).png().toBuffer();
      const depth = await tools.uploadData(png, `director-depth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
      const strength = typeof job.options?.control === "number" ? Math.max(0.3, Math.min(1, job.options.control)) : 0.9;
      model = at(
        g.add("QwenImageDiffsynthControlnet", {
          model,
          model_patch: at(g.add("ModelPatchLoader", { name: f.control ?? Z_CONTROL })),
          vae,
          image: at(g.add("LoadImage", { image: depth.name })),
          strength,
        }),
      );
    }
    const sampled = g.add("KSampler", {
      seed: seed(),
      steps: 8,
      cfg: 1,
      sampler_name: "res_multistep",
      scheduler: "simple",
      denoise: 1,
      model,
      positive,
      negative: at(g.add("ConditioningZeroOut", { conditioning: positive })),
      latent_image: at(g.add("EmptySD3LatentImage", { width, height, batch_size: count(job) })),
    });
    g.add("SaveImage", { images: at(g.add("VAEDecode", { samples: at(sampled), vae })), filename_prefix: "crackio/director" });
    return g.nodes;
  },
};

/** Alibaba PAI's Fun ControlNet Union for Qwen-Image 2.1 (Qwen Research License: non-commercial). */
const Q_CONTROL = "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors";
/** Qwen-Image 2.1 Turbo's own schedule (its ComfyUI template). */
const QWEN_TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";

/**
 * The Director's shots that keep who the cast are (server/director-fresh `runDirectorControl`): Qwen-Image 2.1 Turbo
 * drawing the set's depth through its Fun ControlNet, with each person's picture as a reference (`job.references`, up to
 * four) for their face, hair and clothes. The words count the people ("Person 1… from image 1"): without that it drew one
 * of two, or gave the woman the boy's cap. 14 s warm on an RTX 5090 at 1536x864.
 */
const QWEN_DIRECTOR: Recipe = {
  id: "qwen-director",
  name: "Qwen Director",
  output: "image",
  expectedMs: () => 16_000,
  units: () => 1,
  maxMp: 1.33,
  maxEdge: 1536,
  detailable: false,
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Describe the shot.");
    const { width, height } = tools.size ?? imageSize(job);
    const f = await filesFor("qwen-director");
    const g = new Graph();
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "qwen_image_2.1_vae_bf16.safetensors" }));
    const clip = at(g.add(...clipLoader(f.text ?? "qwen3vl_8b_int8_convrot.safetensors", "qwen_image")));
    let model = at(g.add("ModelAttentionBackend", { model: at(g.add(...unetLoader(f.model ?? "qwen_image_2.1_turbo_int8_convrot.safetensors"))), attention: "pytorch attention" }));
    if (job.depth?.path) {
      const png = await sharp(await fs.readFile(job.depth.path)).resize(width, height, { fit: "fill" }).png().toBuffer();
      const depth = await tools.uploadData(png, `director-depth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
      // The user's A/B/C on three sets (cafe, Lena at the Eiffel Tower, the Tesla on the moon), five setups each: the set's
      // view in grey held at 0.7 for the first half won. Held to the end, the stand-ins came through (a bald Lena from the
      // mannequin's head, a boxy car from the box); edges lost the framing.
      const strength = typeof job.options?.control === "number" ? Math.max(0.3, Math.min(1, job.options.control)) : 0.7;
      const until = typeof job.options?.controlEnd === "number" ? Math.max(0.2, Math.min(1, job.options.controlEnd)) : 0.5;
      model = at(
        g.add("QwenImageDiffsynthControlnet", {
          model,
          model_patch: at(g.add("ModelPatchLoader", { name: f.control ?? Q_CONTROL })),
          vae,
          image: at(g.add("LoadImage", { image: depth.name })),
          strength,
          start_percent: 0,
          end_percent: until,
        }),
      );
    }
    model = at(g.add("QwenImage21Cache", { model, device: "auto", dtype: "default" }));
    const images: Record<string, unknown> = {};
    for (const [i, ref] of job.references.slice(0, 4).entries()) images[`images.image_${i + 1}`] = at(g.add("LoadImage", { image: (await picture(ref, tools, "director-ref", 1024)).name }));
    const encoded = g.add("TextEncodeQwenImage21", { prompt: job.prompt, negative_prompt: "", resolution: 1024, clip, vae, ...images });
    const sampled = g.add("SamplerCustomAdvanced", {
      noise: at(g.add("RandomNoise", { noise_seed: seed() })),
      guider: at(g.add("CFGGuider", { cfg: 1, model, positive: at(encoded, 0), negative: at(encoded, 1) })),
      sampler: at(g.add("KSamplerSelect", { sampler_name: "euler" })),
      sigmas: at(g.add("ManualSigmas", { sigmas: QWEN_TURBO_SIGMAS })),
      latent_image: at(g.add("EmptyLatentImage", { width, height, batch_size: count(job) })),
    });
    g.add("SaveImage", { images: at(g.add("VAEDecode", { samples: at(sampled), vae })), filename_prefix: "crackio/director" });
    return g.nodes;
  },
};

/**
 * The size of klein's reference pictures. It reads every one at every step, so four at 1 MP (BFL's template) are five
 * pictures' work: 9.4 min for one edit on a GTX 1060. Where a plain picture takes over 15 s, several references share 1 MP
 * instead: four at 0.25 MP each took 2.5 min there with the same seed, and kept the characters and their details as well
 * (Oct 2026). A fast GPU keeps them whole.
 */
const kleinRefMp = (job: EngineJob, perUnit: number | null) => {
  const n = Math.min(4, job.references.length);
  return n > 1 && (perUnit ?? 0) > 15 ? 1 / n : 1;
};

/**
 * FLUX.2 klein 4B (Black Forest Labs, Apache-2.0; template image_flux2_klein_image_edit_4b_distilled): words alone,
 * or edits from up to four pictures (each a reference latent on both sides of the guidance), 4 steps at CFG 1.
 */
const KLEIN: Recipe = {
  id: "flux2-klein-4b",
  name: "FLUX.2 klein 4B",
  output: "image",
  expectedMs: (job) => 3_000 * count(job) + 1_500 * job.references.length,
  units: (job, referenceMp) => pictureWork({ count: count(job), references: Math.min(4, job.references.length), referenceMp }),
  referenceMp: kleinRefMp,
  // FLUX.2 makes up to 4 MP.
  maxMp: 4.2,
  // Its 4-step schedule takes no detail pass (see `detail`).
  detailable: false,
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Describe the picture, or the change.");
    const { width, height } = tools.size ?? imageSize(job);
    const f = await filesFor("flux2-klein-4b");
    const g = new Graph();
    const clip = at(g.add(...clipLoader(f.text ?? "qwen_3_4b.safetensors", "flux2")));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "flux2-vae.safetensors" }));
    const model = at(g.add(...unetLoader(f.model ?? "flux-2-klein-4b-fp8.safetensors")));
    const text = at(g.add("CLIPTextEncode", { text: job.prompt, clip }));
    let positive = text;
    let negative = at(g.add("ConditioningZeroOut", { conditioning: text }));
    const megapixels = kleinRefMp(job, tools.perUnit ?? null);
    for (const ref of job.references.slice(0, 4)) {
      const image = at(g.add("LoadImage", { image: (await picture(ref, tools, "ref", Math.max(1024, Math.round(2048 * Math.sqrt(megapixels))))).name }));
      const scaled = at(g.add("ImageScaleToTotalPixels", { upscale_method: "lanczos", megapixels, resolution_steps: 1, image }));
      const latent = at(g.add("VAEEncode", { pixels: scaled, vae }));
      positive = at(g.add("ReferenceLatent", { conditioning: positive, latent }));
      negative = at(g.add("ReferenceLatent", { conditioning: negative, latent }));
    }
    const out = g.add("SamplerCustomAdvanced", {
      noise: at(g.add("RandomNoise", { noise_seed: seed() })),
      guider: at(g.add("CFGGuider", { cfg: 1, model, positive, negative })),
      sampler: at(g.add("KSamplerSelect", { sampler_name: "euler" })),
      sigmas: at(g.add("Flux2Scheduler", { steps: 4, width, height })),
      latent_image: at(g.add("EmptyFlux2LatentImage", { width, height, batch_size: count(job) })),
    });
    g.add("SaveImage", { images: at(g.add("VAEDecode", { samples: at(out), vae })), filename_prefix: "crackio/flux2-klein" });
    return g.nodes;
  },
};

/**
 * SeedVR2 (ByteDance, Apache-2.0; templates utility_seedvr2_3b/7b_int8_upscale_image, utility_seedvr2_3b_int8_upscale_video):
 * one-step diffusion restoration at the target size, tiled through its VAE. Pictures 2× by default, 4× when asked, at
 * most 4K on the long side. Clips the same way, frame after frame in one pass that keeps them steady, in chunks that fit
 * the GPU (SeedVR2TemporalChunk "auto" reads its free memory) crossfaded where they meet, with the clip's sound and frame
 * rate. 3B and 7B run the same graph: 7B keeps finer detail, in twice the memory.
 */
function seedvr2(id: "seedvr2-3b" | "seedvr2-7b", name: string, file: string): Recipe {
  return {
    id,
    name,
    output: "image",
    expectedMs: (job) => (job.source ? 120_000 : id === "seedvr2-7b" ? 20_000 : 12_000),
    // It restores the picture at the size it ends at: a megapixel of result is a unit.
    units: (job) => {
      const s = upscaleSource(job);
      if (!s) return 1;
      const factor = Math.max(1, Math.min(Number(job.options?.scale ?? 2) || 2, 4, 3840 / Math.max(s.width, s.height)));
      return (s.width * s.height * factor ** 2) / 1e6;
    },
    async build(job, tools) {
      const f = await filesFor(id);
      const g = new Graph();
      const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "seedvr2_ema_vae_fp16.safetensors" }));
      const model = at(g.add("UNETLoader", { unet_name: f.model ?? file, weight_dtype: "default" }));
      const restore = async (resized: Link, temporal: number) => {
        const tiles = { tile_size: 512, overlap: 128, temporal_size: temporal, temporal_overlap: 8 };
        // Encoded in 512-pixel tiles, as SeedVR2's templates do: whole frames encoded faster (31 s against 50 s for a 5 s
        // clip at 1920×800) but came out measurably further from the real footage (LPIPS 0.117 against 0.106).
        let latent = at(g.add("VAEEncodeTiled", { ...tiles, pixels: at(g.add("SeedVR2Preprocess", { resized_images: resized })), vae }));
        // A clip in chunks the GPU holds (one chunk when it all fits), two latent frames shared and crossfaded between them.
        // The chunk size comes from the memory free right then, so everything else leaves the GPU first: other jobs' models
        // there had cut a 5 s clip's chunks from 85 frames to 37, more seams and a slower run.
        if (temporal < 4096 && (await tools.hasNode?.("CrackioFreeMemory"))) latent = at(g.add("CrackioFreeMemory", { samples: latent }));
        const chunks = temporal < 4096 ? g.add("SeedVR2TemporalChunk", { latent, temporal_overlap: 2, chunking_mode: "auto" }) : null;
        const input = chunks ? at(chunks, 0) : latent;
        const cond = g.add("SeedVR2Conditioning", { model, vae_conditioning: input });
        const sampled = at(g.add("KSampler", { seed: seed(), steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model, positive: at(cond, 0), negative: at(cond, 1), latent_image: input }));
        const merged = chunks ? at(g.add("SeedVR2TemporalMerge", { latents: sampled, temporal_overlap: at(chunks, 1) })) : sampled;
        // Decoded by ComfyUI's own sizing on an NVIDIA card: whole frames when they fit, else the biggest tiles that do (its
        // SeedVR2 memory estimate is measured). The same 5 s clip took 166 s instead of 205 s, practically as close to the
        // real footage (LPIPS 0.108 against 0.106). On a Mac, 512-pixel tiles: its shared memory overruns otherwise.
        const decoded = tools.vramGb ? at(g.add("VAEDecode", { samples: merged, vae })) : at(g.add("VAEDecodeTiled", { ...tiles, samples: merged, vae }));
        // Colours matched back to the original in CIELAB (the node's own default): left alone, SeedVR2 warms them.
        return at(g.add("SeedVR2PostProcessing", { color_correction_method: "lab", images: decoded, original_resized_images: resized }));
      };
      if (job.source) {
        // Its weights in RAM while the VAE has the GPU: 7B's int8 file 7.8 GB, 3B's fp16 6.3.
        const clip = await clipToUpscale(job, tools, id === "seedvr2-7b" ? 7.8 : 6.3);
        const parts = g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file: clip.name })) });
        const resized = at(g.add("ResizeImageMaskNode", { input: at(parts, 0), resize_type: "scale by multiplier", "resize_type.multiplier": clip.factor, scale_method: "lanczos" }));
        const video = g.add("CreateVideo", { fps: at(parts, 2), bit_depth: 8, color_space: "sRGB", codec: "none", images: await restore(resized, 64), audio: at(parts, 1) });
        g.add("SaveVideo", { video: at(video), filename_prefix: `crackio/${id}`, ...UPSCALED_MP4 });
        return g.nodes;
      }
      const ref = job.references[0];
      if (!ref) throw new EngineError("Pick the picture to upscale.");
      const { width = 1, height = 1 } = await sharp(ref.path).metadata();
      const asked = Number(job.options?.scale ?? 2) || 2;
      const factor = Math.max(1, Math.min(asked, 4, 3840 / Math.max(width, height)));
      const load = g.add("LoadImage", { image: (await picture(ref, tools, "up", 4096)).name });
      const resized = at(
        g.add("ResizeImageMaskNode", { input: at(g.add("JoinImageWithAlpha", { image: at(load, 0), alpha: at(load, 1) })), resize_type: "scale by multiplier", "resize_type.multiplier": factor, scale_method: "lanczos" }),
      );
      g.add("SaveImage", { images: await restore(resized, 4096), filename_prefix: `crackio/${id}` });
      return g.nodes;
    },
  };
}

const SEEDVR2: Recipe = seedvr2("seedvr2-3b", "SeedVR2 3B", "seedvr2_3b_int8_convrot.safetensors");
const SEEDVR2_7B: Recipe = seedvr2("seedvr2-7b", "SeedVR2 7B", "seedvr2_7b_int8_convrot.safetensors");

/**
 * The size of the picture an upscale starts from, when the job says (`options.sourceWidth`/`sourceHeight`: the engine
 * reads it from the picture, the time line from the one on screen). Clips have their own sizing.
 */
function upscaleSource(job: EngineJob) {
  const width = Number(job.options?.sourceWidth);
  const height = Number(job.options?.sourceHeight);
  return job.kind === "upscale" && !job.source && width > 0 && height > 0 ? { width, height } : null;
}

/** An upscaled clip as an MP4 that keeps the detail it gained (CRF 17, where Crackio's other clips use 22). */
const UPSCALED_MP4 = { format: "auto", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 17 };

/** The video heights the Upscale tool offers, by name. */
const CLIP_HEIGHTS: Record<string, number> = { "1080p": 1080, "1440p": 1440, "2160p": 2160, "4k": 2160 };

/**
 * A clip to upscale: uploaded to the ComfyUI, and the factor that brings its short side to the height asked (1080p, 1440p,
 * 2160p) or the scale asked; never past 4× or a 4K frame (3840 on the long side).
 *
 * With `modelGb` (a model that moves out of the GPU while its VAE works, its weights then in RAM), the RAM the run needs
 * is checked before anything goes up. ComfyUI holds the frames as 32-bit floats, several copies at their new size: a 5 s
 * clip to 1080p with SeedVR2 7B got ComfyUI killed 18 minutes in on a rented RTX 4060 Ti held to 21 GB of RAM, and
 * finished on a 4070 with 30 (Oct 2026).
 */
async function clipToUpscale(job: EngineJob, tools: RecipeTools, modelGb = 0) {
  const info = await probe(job.source!.path);
  const w = info.width ?? 1280;
  const h = info.height ?? 720;
  const height = CLIP_HEIGHTS[String(job.options?.resolution ?? "").toLowerCase()];
  const asked = height ? height / Math.min(w, h) : Number(job.options?.scale ?? 2) || 2;
  const factor = Math.round(Math.max(1, Math.min(asked, 4, 3840 / Math.max(w, h))) * 1000) / 1000;
  if (modelGb && tools.ramGb) {
    const frames = Math.ceil((info.duration ?? 5) * (info.fps || 24));
    const need = (frames * w * h * factor ** 2 * 3 * 4 * 5) / 1024 ** 3 + modelGb + 4;
    if (need > tools.ramGb) {
      throw new EngineError(
        `Upscaling this clip to ${Math.round(Math.min(w, h) * factor)}p takes about ${Math.ceil(need)} GB of RAM, and this machine has ${Math.round(tools.ramGb)} GB.`,
        "Pick a lower resolution or a shorter clip, or Real-ESRGAN, which needs far less.",
      );
    }
  }
  const uploaded = await tools.upload(job.source!.path, "clip");
  return { name: uploaded.name, factor, width: w, height: h, seconds: info.duration ?? 5 };
}

/** Wan's own negative prompt (its training captions are Chinese). */
const WAN_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/** Wan 2.2 5B's two sizes: 720p, and the 540p small GPUs and Macs run (above 960×544 it stays sharp; the model learned 720p). */
const wanSize = (job: EngineJob, ratio: number) => {
  const small = String(job.options?.resolution) === "540p";
  const [long, short] = small ? [1024, 576] : [1280, 704];
  return ratio >= 1 ? { width: long, height: short } : { width: short, height: long };
};

/**
 * Wan 2.2 TI2V 5B (Alibaba, Apache-2.0; template video_wan2_2_5B_ti2v): words or a start frame, 24 fps, up to 121
 * frames (5 s). With the FastWan LoRA (FastVideo's few-step distill) it runs 3 steps at CFG 1 (euler, shift 8) instead
 * of the template's 20 at CFG 5 (uni_pc): about 13× less work. GGUF versions (ComfyUI-GGUF) and a GGUF UMT5 fit 6–8 GB
 * cards and 16 GB Macs; the tiny lighttaew2_2 decoder turns the latents into frames in a fraction of the full VAE's
 * memory and time (on a 4 GB card the full one took 17 of 29 minutes). The full VAE still encodes a start frame. No sound.
 */
const WAN5B: Recipe = {
  id: "wan2.2-5b",
  name: "Wan 2.2 5B",
  output: "video",
  expectedMs: (job) => Math.max(40_000, seconds(job) * 6_000),
  // 5 s at 720p is one unit; 540p is 65% of its tokens, and attention makes time grow a little faster than tokens.
  units: (job) => Math.pow((Math.min(5, seconds(job)) / 5) * (String(job.options?.resolution) === "540p" ? 0.655 : 1), 1.3),
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Write what happens in the clip.");
    const ratio = await ratioOf(job);
    const { width, height } = wanSize(job, ratio);
    const length = Math.round((Math.min(5, Math.max(1, seconds(job))) * 24) / 4) * 4 + 1;
    const f = await filesFor("wan2.2-5b");
    const fast = Boolean(f.lora);
    const g = new Graph();
    const clip = at(g.add(...clipLoader(f.text ?? "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan")));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "wan2.2_vae.safetensors" }));
    let unet = at(g.add(...unetLoader(f.model ?? "wan2.2_ti2v_5B_fp16.safetensors")));
    if (fast) unet = at(g.add("LoraLoaderModelOnly", { lora_name: f.lora, strength_model: 1, model: unet }));
    const model = at(g.add("ModelSamplingSD3", { shift: 8, model: unet }));
    const start = job.start ? at(g.add("LoadImage", { image: (await picture(job.start, tools, "start", 1536)).name })) : null;
    const latent = at(g.add("Wan22ImageToVideoLatent", { width, height, length, batch_size: 1, vae, ...(start ? { start_image: start } : {}) }));
    const positive = at(g.add("CLIPTextEncode", { text: job.prompt, clip }));
    // FastWan's own schedule (FastVideo: 3 DMD steps at timesteps 1000, 757, 522), each step predicting the clean clip and
    // noising it again for the next: ComfyUI's lcm sampler. A scheduler's even 3 steps (shift 8: 1.0, 0.94, 0.80) leave
    // most of the work to one last jump, and the end of the clip goes soft and drifts. At CFG 1 the negative side isn't
    // computed: an empty one saves encoding Wan's long negative prompt.
    const sampled = fast
      ? at(
          g.add("SamplerCustomAdvanced", {
            noise: at(g.add("RandomNoise", { noise_seed: seed() })),
            guider: at(g.add("CFGGuider", { cfg: 1, model, positive, negative: at(g.add("ConditioningZeroOut", { conditioning: positive })) })),
            sampler: at(g.add("KSamplerSelect", { sampler_name: "lcm" })),
            sigmas: at(g.add("ManualSigmas", { sigmas: "1.0, 0.757, 0.522, 0.0" })),
            latent_image: latent,
          }),
        )
      : at(
          g.add("KSampler", {
            seed: seed(),
            steps: 20,
            cfg: 5,
            sampler_name: "uni_pc",
            scheduler: "simple",
            denoise: 1,
            model,
            positive,
            negative: at(g.add("CLIPTextEncode", { text: WAN_NEGATIVE, clip })),
            latent_image: latent,
          }),
        );
    // The tiny decoder when it's there; the full VAE decodes in tiles otherwise, so it fits beside the model.
    const frames = f.tiny
      ? at(g.add("VAEDecode", { samples: sampled, vae: at(g.add("VAELoader", { vae_name: f.tiny })) }))
      : at(g.add("VAEDecodeTiled", { samples: sampled, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 }));
    const video = g.add("CreateVideo", { images: frames, fps: 24, bit_depth: 8, color_space: "sRGB", codec: "none" });
    g.add("SaveVideo", { video: at(video), filename_prefix: "crackio/wan2.2-5b", ...COMPACT_MP4 });
    return g.nodes;
  },
};

/**
 * FLUX 3 Image Klein (Black Forest Labs; FLUX Kommunity licence, free commercial use under $5M a year; templates
 * image_flux3_klein_distilled_t2i / _image_edit): 5.6B with Qwen3-VL-4B reading the prompt. From words, 15 steps
 * of er_sde; edits from up to 10 pictures (ReferenceMultiLatent, the first sets the size), 16 steps of euler; CFG 1.
 * BFL's own templates add a 9B prompt upsampler; Crackio's prompt writer does that job instead.
 */
const FLUX3_KLEIN: Recipe = {
  id: "flux3-klein",
  name: "FLUX 3 Klein",
  output: "image",
  expectedMs: (job) => 5_000 * count(job) + (job.references.length ? 4_000 : 0),
  units: (job) => pictureWork({ count: count(job), references: Math.min(10, job.references.length) }),
  // BFL makes its pictures from words up to 16.8 MP (4K natively: 3840×2160 took 24–32 s on an RTX 5090). With reference
  // pictures it stays at 2.4 MP, where the Director's 2K shots look right: its references are read at the picture's own
  // size, and at 4.2 MP (BFL's limit) four of them made the Director's 4K shot oversaturated in 212 s. A slow GPU stops at
  // 4.2 MP; the detail pass draws the rest in.
  maxMp: 4.2,
  nativeMp: (job, perUnit) => (job.references.length ? 2.4 : (perUnit ?? 0) > DETAIL_PASS.slowest ? 4.2 : 16.8),
  async build(job, tools) {
    if (!job.prompt.trim()) throw new EngineError("Describe the picture, or the change.");
    const f = await filesFor("flux3-klein");
    const g = new Graph();
    const model = at(g.add("UNETLoader", { unet_name: f.model ?? "flux3-image-klein-int8-convrot.safetensors", weight_dtype: "default" }));
    const clip = at(g.add("CLIPLoader", { clip_name: f.text ?? "qwen3vl_4b_int8_convrot.safetensors", type: "flux3", device: "default" }));
    const vae = at(g.add("VAELoader", { vae_name: f.vae ?? "flux2-vae.safetensors" }));
    const text = at(g.add("CLIPTextEncode", { text: job.prompt, clip }));
    const refs = job.references.slice(0, 10);
    let sampled: string;
    let big = false;
    if (refs.length) {
      const images: Record<string, Link> = {};
      for (const [k, ref] of refs.entries()) images[`images.image${k}`] = at(g.add("LoadImage", { image: (await picture(ref, tools, "ref", 2048)).name }));
      // The first picture sets the shape; the size is the one asked for (about 1 MP by default).
      const megapixels = tools.size ? Math.round((tools.size.width * tools.size.height) / 1e4) / 100 : 1;
      const multi = g.add("ReferenceMultiLatent", { resolution: "resize", "resolution.megapixels": megapixels, positive: text, negative: at(g.add("ConditioningZeroOut", { conditioning: text })), vae, ...images });
      // References only (who, what, where): a new picture at the size asked; else the first picture's, to edit it.
      const size = tools.size ?? imageSize(job);
      const latent = !job.references.some((r) => r.role === "edit-target")
        ? at(g.add("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: count(job) }))
        : count(job) > 1
          ? at(g.add("RepeatLatentBatch", { samples: at(multi, 2), amount: count(job) }))
          : at(multi, 2);
      sampled = g.add("KSampler", { seed: seed(), steps: 16, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model, positive: at(multi, 0), negative: at(multi, 1), latent_image: latent });
    } else {
      const { width, height } = tools.size ?? imageSize(job);
      const mp = (width * height) / 1e6;
      big = mp > 4.3;
      // Its fixed schedule (mu 1.94) repeats things past 4 MP (three shop signs at 3840×2160); a stronger shift that grows
      // with the size, as FLUX's own does, kept one layout there (mu 2.6).
      const mu = Math.round((1.94 + 0.09 * (mp - 1)) * 100) / 100;
      sampled = g.add("KSampler", {
        seed: seed(),
        steps: 15,
        cfg: 1,
        sampler_name: "er_sde",
        scheduler: "simple",
        denoise: 1,
        model: big ? at(g.add("ModelSamplingFlux", { model, max_shift: mu, base_shift: mu, width, height })) : model,
        positive: text,
        negative: at(g.add("CLIPTextEncode", { text: "", clip })),
        latent_image: at(g.add("EmptyFlux2LatentImage", { width, height, batch_size: count(job) })),
      });
    }
    const decoded = big ? g.add("VAEDecodeTiled", { samples: at(sampled), vae, tile_size: 1024, overlap: 64, temporal_size: 64, temporal_overlap: 8 }) : g.add("VAEDecode", { samples: at(sampled), vae });
    g.add("SaveImage", { images: at(decoded), filename_prefix: "crackio/flux3-klein" });
    return g.nodes;
  },
};

/**
 * A ×4 pixel-to-pixel upscaler (ComfyUI's own loader, spandrel: ESRGAN, RealPLKSR, DAT…): it sharpens what's there and
 * invents nothing. 2× is its 4× scaled back down. Clips frame by frame (see `ganClipSize` for the size it works at).
 */
function gan(id: string, name: string, file: string, prefix: string): Recipe {
  return {
    id,
    name,
    output: "image",
    expectedMs: () => 3_000,
    // It runs ×4 on the picture as it comes (up to 4096 px on its long side): 4× its megapixels are a unit's worth, the
    // same as SeedVR2 making a 1 MP result.
    units: (job) => {
      const s = upscaleSource(job);
      if (!s) return 1;
      const fit = Math.min(1, 4096 / Math.max(s.width, s.height));
      return (4 * s.width * s.height * fit ** 2) / 1e6;
    },
    async build(job, tools) {
      const f = await filesFor(id);
      const g = new Graph();
      const loader = () => at(g.add("UpscaleModelLoader", { model_name: f.model ?? file }));
      if (job.source) {
        const clip = await clipToUpscale(job, tools);
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
        const [w, h] = [even(clip.width * clip.factor), even(clip.height * clip.factor)];
        const inner = ganClipSize(clip.width, clip.height, w, h);
        const parts = g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file: clip.name })) });
        const frames = inner.width === clip.width && inner.height === clip.height ? at(parts, 0) : at(g.add("ImageScale", { image: at(parts, 0), upscale_method: "lanczos", width: inner.width, height: inner.height, crop: "disabled" }));
        const up = at(g.add("ImageUpscaleWithModel", { upscale_model: loader(), image: frames }));
        const sized = at(g.add("ImageScale", { image: up, upscale_method: "lanczos", width: w, height: h, crop: "disabled" }));
        const video = g.add("CreateVideo", { fps: at(parts, 2), bit_depth: 8, color_space: "sRGB", codec: "none", images: sized, audio: at(parts, 1) });
        g.add("SaveVideo", { video: at(video), filename_prefix: `crackio/${prefix}`, ...UPSCALED_MP4 });
        return g.nodes;
      }
      const ref = job.references[0];
      if (!ref) throw new EngineError("Pick the picture to upscale.");
      const image = at(g.add("LoadImage", { image: (await picture(ref, tools, "up", 4096)).name }));
      const up = at(g.add("ImageUpscaleWithModel", { upscale_model: loader(), image }));
      const factor = Number(job.options?.scale ?? 4) || 4;
      const out = factor >= 4 ? up : at(g.add("ImageScaleBy", { image: up, upscale_method: "lanczos", scale_by: factor / 4 }));
      g.add("SaveImage", { images: out, filename_prefix: `crackio/${prefix}` });
      return g.nodes;
    },
  };
}

/**
 * The size a clip's frames go through a ×4 upscaler at: as much of the clip as gives a frame up to 1.5 times the size
 * asked on each side (then fitted down, finer for it), at most about 4K. Shrinking the frames to a quarter of the size
 * asked first threw detail away: on a 5 s clip shrunk to 864×360 and brought back to 1920×800, the whole frames came
 * out clearly closer to the original ones (PSNR 32.3 vs 29.6 dB, LPIPS 0.131 vs 0.162) and steadier, in three times the
 * time.
 */
function ganClipSize(width: number, height: number, w: number, h: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const area = width * height;
  const inner = Math.min(16 * area, Math.max(w * h, Math.min(w * h * 2.25, 8.4e6)));
  const s = Math.sqrt(inner / (16 * area));
  return { width: even(width * s), height: even(height * s) };
}

/** Real-ESRGAN ×4plus (BSD-3; template utility-gan_upscaler): a 67 MB upscaler that runs on any machine. */
const ESRGAN: Recipe = gan("realesrgan-x4", "Real-ESRGAN", "RealESRGAN_x4plus.safetensors", "realesrgan");
/** Phips's 4xNomos2_hq_dat2 (CC-BY-4.0): DAT2 trained on clean pictures, for AI renders. */
const NOMOS2_HQ: Recipe = gan("nomos2-hq", "Nomos2 HQ", "4xNomos2_hq_dat2.safetensors", "nomos2-hq");
/** Phips's 4xNomosWebPhoto_RealPLKSR (CC-BY-4.0): fast, for real photos with web compression. */
const NOMOS_WEBPHOTO: Recipe = gan("nomos-webphoto", "Nomos WebPhoto", "4xNomosWebPhoto_RealPLKSR.safetensors", "nomos-webphoto");

/**
 * FlashVSR+ (Shanghai AI Lab, Tsinghua, CUHK; Apache-2.0; custom node smthemex/ComfyUI_FlashVSR): one-step streaming
 * video super-resolution on Wan 2.1 1.3B, distilled from a 14B teacher and built for 4×. Clips only. The frames are
 * sized (lanczos) to sides in multiples of 32, at the scale that keeps the most of the clip the card holds, run at 4×
 * and fitted (lanczos) to the size asked: nothing is cropped, and any stretch from the rounding is undone. Sized here,
 * since the node's own resize crops to the shape and uses nearest-neighbour. It runs on its Triton attention kernel (the
 * bridge installs it, and its marker node says it loaded): PyTorch's own attention, its fallback, refuses clips this size.
 */
const FLASHVSR: Recipe = {
  id: "flashvsr-plus",
  name: "FlashVSR+",
  output: "video",
  expectedMs: () => 100_000,
  async build(job, tools) {
    if (!job.source) throw new EngineError("FlashVSR+ upscales clips.", "For a picture, pick SeedVR2 or Real-ESRGAN.");
    // Without its Triton kernel it falls back to PyTorch attention built from dense masks, which refuses clips this size
    // ("would allocate too many mask entries"): say so before the clip goes up.
    if (!(await tools.hasNode?.("CrackioFlashVSRTriton"))) {
      throw new EngineError("FlashVSR+ needs its Triton attention kernel on this machine, and it isn't loaded.", "Restart that machine's ComfyUI if FlashVSR+ was just installed (or install it again from the Local page); else pick SeedVR2 or Real-ESRGAN.");
    }
    const f = await filesFor("flashvsr-plus");
    // Its 6.5 GB of weights sit in RAM between steps (offload), next to frames rendered up to 1.5× the size asked: a 5 s
    // clip to 1080p got ComfyUI killed on a rented RTX 4060 Ti held to 21 GB of RAM (Oct 2026).
    const clip = await clipToUpscale(job, tools, 9);
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const [w, h] = [even(clip.width * clip.factor), even(clip.height * clip.factor)];
    // It renders 4× whatever it's given: a frame up to 1.5 times the size asked on each side (finer once fitted down),
    // within what the card holds, from no more than the clip has.
    const vram = tools.vramGb ?? 24;
    const budget = vram >= 30 ? 8.4e6 : vram >= 20 ? 6e6 : 4e6;
    const area = clip.width * clip.height;
    const inner = Math.min(16 * area, Math.max(w * h, Math.min(w * h * 2.25, budget)));
    const s = Math.sqrt(inner / (16 * area));
    const side = (n: number) => Math.max(64, Math.round((n * s) / 32) * 32);
    const [lqW, lqH] = [side(clip.width), side(clip.height)];
    const g = new Graph();
    const parts = g.add("GetVideoComponents", { video: at(g.add("LoadVideo", { file: clip.name })) });
    const sized = at(g.add("ImageScale", { image: at(parts, 0), upscale_method: "lanczos", width: lqW, height: lqH, crop: "disabled" }));
    const model = at(
      g.add("FlashVSR_SM_Model", {
        dit: f.model ?? "flashvsr_plus_turbo_dit.safetensors",
        proj_pt: f.proj ?? "flashvsr_plus_turbo_lq_proj_in.safetensors",
        emb_pt: f.prompt ?? "posi_prompt_plus.pth",
        version: "plus_turbo",
        tiny_long: false,
        // Its model leaves the GPU after the clip: ComfyUI can't see or unload it, and held there it shrank the next
        // SeedVR2 job's chunks (27 GiB free became 19).
        offload: true,
        plus_temporal: "4",
        plus_attn: "triton_block_sparse",
      }),
    );
    const vae = at(g.add("FlashVSR_SM_Vae", { vae: "none", tcd_encoder: f.decoder ?? "TCDecoder_plus.ckpt", lite_vae: "none" }));
    // Its seed is a 32-bit int (ComfyUI refuses the 48-bit ones other nodes take).
    const latent = at(g.add("FlashVSR_SM_KSampler", { model, image: sized, width: lqW, height: lqH, seed: seed() % 2_147_483_647, scale: 4, kv_ratio: 3.5, local_range: 11, steps: 1, cfg: 1, sparse_ratio: 2 }));
    // Its own colour fix (wavelet: the clip's low frequencies, FlashVSR+'s detail).
    const frames = at(g.add("FlashVSR_SM_Decoder", { vae, latent, full_tiled: true, color_fix: true, fix_method: "wavelet" }));
    const fitted = at(g.add("ImageScale", { image: frames, upscale_method: "lanczos", width: w, height: h, crop: "disabled" }));
    const video = g.add("CreateVideo", { fps: at(parts, 2), bit_depth: 8, color_space: "sRGB", codec: "none", images: fitted, audio: at(parts, 1) });
    g.add("SaveVideo", { video: at(video), filename_prefix: "crackio/flashvsr-plus", ...UPSCALED_MP4 });
    return g.nodes;
  },
};

const RECIPES: Recipe[] = [LTX_VIDEO, SCAIL_SWAP, RIPPLE_SWAP, Z_IMAGE, Z_IMAGE_DIRECTOR, QWEN_DIRECTOR, KLEIN, FLUX3_KLEIN, SEEDVR2, SEEDVR2_7B, ESRGAN, NOMOS2_HQ, NOMOS_WEBPHOTO, FLASHVSR, WAN5B];

/* ------------------------------------------------------------------ ComfyUI's official templates */

const ASPECT_OPTIONS: [string, number][] = [
  ["1:1 (Square)", 1],
  ["2:3 (Portrait Photo)", 2 / 3],
  ["3:2 (Photo)", 3 / 2],
  ["3:4 (Portrait Standard)", 3 / 4],
  ["4:3 (Standard)", 4 / 3],
  ["9:16 (Portrait Widescreen)", 9 / 16],
  ["16:9 (Widescreen)", 16 / 9],
  ["21:9 (Ultrawide)", 21 / 9],
];
const nearestAspect = (ratio: number) => ASPECT_OPTIONS.reduce((best, o) => (Math.abs(Math.log(o[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? o : best))[0];

/**
 * Any open model in ComfyUI's official templates, run from its own graph (see comfy-local-templates and
 * server/local-templates): the variant whose files are installed, the template for what the job brings (words,
 * a picture to edit, a start frame, start and end frames, a clip to upscale), its inputs filled, its switches settled.
 */
/** What a version of a template model would run for a job (its templates by mode), or nothing when it can't do the job. */
function modeFor(modes: Partial<Record<TemplateMode, string>>, job: EngineJob, clip: boolean): TemplateMode | undefined {
  if (job.kind === "upscale") return job.source && modes.vupscale ? "vupscale" : modes.upscale ? "upscale" : undefined;
  if (clip) {
    // A reference sheet beside (or instead of) the start frame guides the whole clip (Cast's sheets, in one picture).
    if (modes.r2v && clipReferences(job).length) return "r2v";
    if (job.start && job.end && modes.flf2v) return "flf2v";
    if (job.start) return modes.i2v ? "i2v" : undefined;
    return modes.t2v ? "t2v" : undefined;
  }
  if (job.references.length) return modes.edit ? "edit" : undefined;
  return modes.t2i ? "t2i" : undefined;
}

/** The pictures a clip job carries beside its start and end frames (who and what it shows). */
function clipReferences(job: EngineJob) {
  return job.references.filter((r) => r.path !== job.start?.path && r.path !== job.end?.path && !/start frame|end frame/i.test(r.label ?? ""));
}

/**
 * Reference to video (LTX-2.3's IC-LoRA "ingredients"): the reference sheet is fitted to the clip's size, and a start frame,
 * when there is one, replaces the template's blank first picture so the clip opens on it.
 */
function referenceGraph(graph: ApiGraph, size: { width: number; height: number } | undefined, start: string | undefined): ApiGraph {
  const g: ApiGraph = structuredClone(graph);
  for (const n of Object.values(g)) {
    if (n.class_type === "ResizeAndPadImage" && size) Object.assign(n.inputs, { target_width: size.width, target_height: size.height });
  }
  if (start) {
    const id = "crackio_start_frame";
    g[id] = { class_type: "LoadImage", inputs: { image: start } };
    for (const n of Object.values(g)) {
      if (n.class_type !== "LTXVImgToVideoInplace") continue;
      n.inputs.image = [id, 0];
      n.inputs.bypass = false;
    }
  }
  return g;
}

/**
 * A template graph run with a GGUF version of its model (local-templates GGUF_EXTRAS): its loader of `from` takes the GGUF
 * file, split with another computer when the job pooled. Pooled, Qwen-Image 2.1 also runs without its prefix cache,
 * which runs blocks on cached rows only, and several pictures sample in two lanes side by side (Crackio Lanes Sampler):
 * while one waits on the other computer's blocks, the next runs its first ones here, so neither computer waits.
 */
function swapModel(graph: ApiGraph, from: string, to: string, pool: RecipeTools["pool"], pictures = 1): ApiGraph {
  const g = structuredClone(graph);
  for (const n of Object.values(g)) {
    if (n.class_type !== "UNETLoader" || n.inputs.unet_name !== from) continue;
    const [type, inputs] = modelLoader(to, pool);
    n.class_type = type;
    n.inputs = inputs;
  }
  if (!pool) return g;
  for (const [id, n] of Object.entries(g)) {
    if (n.class_type !== "QwenImage21Cache") continue;
    for (const other of Object.values(g)) for (const [k, v] of Object.entries(other.inputs)) if (isLink(v) && v[0] === id) other.inputs[k] = n.inputs.model;
    delete g[id];
  }
  if (pictures > 1) for (const n of Object.values(g)) if (n.class_type === "KSamplerSelect") Object.assign(n, { class_type: "CrackioLanesSampler", inputs: { ...n.inputs, lanes: 2 } });
  return g;
}

/**
 * What template models render natively, from their makers (research, Oct 29): FLUX.2 up to 4 MP; Qwen-Image 2.1's sizes
 * are 2048² and 2752×1536; Z-Image's largest official class is 1536 (about 2.4 MP); Ideogram 4, Krea 2, Mage-Flow and
 * HiDream-O1 go up to 2048 a side; MOSS-Image is best at 1 to 2 MP; SDXL only near 1 MP.
 */
const TEMPLATE_NATIVE: Record<string, { mp: number; edge?: number }> = {
  "flux2-dev": { mp: 4.2 },
  "flux2-klein-9b": { mp: 4.2 },
  "flux2-klein-9b-edit": { mp: 4.2 },
  "qwen-image-2.1": { mp: 4.25 },
  "z-image": { mp: 2.4 },
  "ideogram-4": { mp: 4.2, edge: 2048 },
  "krea-2": { mp: 4.2, edge: 2048 },
  "mage-flow": { mp: 4.2, edge: 2048 },
  "mage-flow-edit": { mp: 4.2, edge: 2048 },
  "hidream-o1": { mp: 4.2, edge: 2048 },
  "moss-image": { mp: 2.1 },
  sdxl: { mp: 1.05 },
};

/** The most megapixels a template's model renders well: known, else twice its template's own size, up to about 2. */
function templateMaxMp(key: string, model: LocalModel) {
  if (TEMPLATE_NATIVE[key]) return TEMPLATE_NATIVE[key].mp;
  const name = model.variants.map((v) => v.templates?.t2i ?? v.templates?.edit).find(Boolean);
  const native = (name && nativeMp(name)) || 1;
  return Math.max(native, Math.min(2.1, native * 2));
}

/** How many pictures a template reads: its own LoadImage nodes, or more when its encoder grows (comfy-local-templates). */
const roomFor = (name: string) => Math.max(1, templateIO(name).images.length, growsImages(templateGraph(name)) ? grownRoom(templateGraph(name)) : 0);

function templateRecipe(key: string): Recipe | null {
  const model = templateModels().find((m) => m.crackio === `local:tpl:${key}`);
  if (!model) return null;
  const clip = model.unit === "clip" || model.variants.some((v) => v.templates?.vupscale && !v.templates?.upscale);
  // How many pictures its edit template takes.
  const editPictures = () => {
    const name = model.variants.find((v) => v.templates?.edit)?.templates?.edit;
    return name ? roomFor(name) : 0;
  };
  // An installed version that can do this job (a family's turbo version may only make pictures from words).
  const pick = async (job: EngineJob) => {
    const have = await installedFiles().catch(() => new Set<string>());
    const installed = model.variants.filter((v) => v.files.every((f) => have.has(`${f.folder}/${f.name}`)));
    const able = installed.filter((v) => modeFor(v.templates ?? {}, job, clip));
    // A version asked for by name, when it's installed and does the job; or, asked for the best, the full model over its
    // turbo when both are in (Qwen-Image 2.1: 25 steps against 8, finer skin and hair, about twice the time).
    const wanted = job.options?.variant ? able.find((v) => v.id === job.options!.variant) : undefined;
    const full = job.options?.quality === "best" ? able.find((v) => !/turbo|lightning|distill/i.test(v.id)) : undefined;
    return wanted ?? full ?? able[0] ?? installed[0] ?? model.variants[0];
  };
  return {
    id: `tpl:${key}`,
    name: model.name,
    output: clip ? "video" : "image",
    expectedMs: (job) => Math.max(5_000, (model.variants[0]?.seconds5090 ?? 20) * 2_000 * (clip ? Math.max(1, seconds(job) / 5) : count(job))),
    // An edit reads its pictures (about 1 MP each in the templates) next to the one it makes.
    units: (job) => (clip ? seconds(job) / 5 : job.kind === "upscale" ? count(job) : pictureWork({ count: count(job), references: Math.min(job.references.length, editPictures()) })),
    ...(clip ? {} : { maxMp: templateMaxMp(key, model), ...(TEMPLATE_NATIVE[key]?.edge ? { maxEdge: TEMPLATE_NATIVE[key].edge } : {}) }),
    // Every version's picture graph takes the detail pass, or none is promised (Qwen-Image 2.1 Turbo's few-step list doesn't).
    detailable: !clip && model.variants.every((v) => [v.templates?.t2i, v.templates?.edit].every((name) => !name || detail(templateGraph(name), { width: 64, height: 64 }, 0.3, 10, null) !== null)),
    async build(job, tools) {
      const variant = await pick(job);
      const modes = variant.templates ?? {};
      const mode = modeFor(modes, job, clip);
      if (!mode) {
        // Another version of the model does it: say which to install.
        const other = model.variants.find((v) => modeFor(v.templates ?? {}, job, clip));
        if (other) throw new EngineError(`The ${model.name} version installed (${variant.label}) can't do this: install its ${other.label} version on the Local page.`);
        if (clip && !job.start && modes.i2v) throw new EngineError(`${model.name} starts from a picture: add a start frame.`);
        if (clip && job.start && modes.t2v) throw new EngineError(`${model.name} makes clips from words only: remove the start frame.`);
        if (!clip && !job.references.length && modes.edit) throw new EngineError(`${model.name} edits pictures: add the one to change.`);
        if (!clip && job.references.length && modes.t2i) throw new EngineError(`${model.name} makes pictures from words only: remove the reference pictures.`);
        throw new EngineError(`${model.name} can't do this kind of job.`);
      }
      const name = modes[mode]!;
      const io = templateIO(name);
      const pictures: EngineReference[] =
        mode === "flf2v" ? [job.start!, job.end!] : mode === "i2v" ? [job.start!] : mode === "r2v" ? clipReferences(job).slice(0, 1) : mode === "edit" || mode === "upscale" ? job.references : [];
      // Shape: a ~1 MP picture in the job's aspect, or a clip at 720p (480p when asked), never past the size the template was
      // made for (a 480p model at 720p is twice the work and memory for no more detail).
      const ratio = clip ? await ratioOf(job) : job.width / Math.max(1, job.height);
      // Pictures at the size planned from the resolution asked (comfy-local), else about 1 MP.
      // (A reference-to-video template's only literal size is its blank first picture's: its clip is the guide's size, 720p.)
      const mp = clip ? Math.min(String(job.options?.resolution) === "480p" ? 0.4 : 0.9, mode === "r2v" ? 0.9 : (nativeMp(name) ?? 0.9)) : tools.size ? (tools.size.width * tools.size.height) / 1e6 : 1;
      const h = Math.sqrt((mp * 1e6) / ratio);
      const grid = clip ? (Object.values(templateGraph(name)).some((n) => /LTXV/.test(n.class_type)) ? 64 : 32) : 16;
      const size = mode === "upscale" || mode === "vupscale" ? undefined : !clip && tools.size ? tools.size : { width: snap(h * ratio, grid), height: snap(h, grid) };
      // A growing encoder (Qwen-Image 2.1's) reads every picture at its own size at every step, and makes the result the
      // size of the first: that one goes up at the size planned, and the others (references) smaller on a slow GPU,
      // where a plain picture takes over 15 s (as klein's do, see kleinRefMp).
      const grows = mode === "edit" && growsImages(templateGraph(name));
      // Pictures that are all references (who, what, where) make a new picture at the size asked; otherwise the first is
      // the one to edit, and sets the size.
      const editing = grows && job.references.some((r) => r.role === "edit-target");
      const images: string[] = [];
      for (const [i, ref] of pictures.slice(0, roomFor(name)).entries()) {
        const fit = grows && size ? (i === 0 && editing ? Math.round(Math.sqrt(size.width * size.height) * Math.sqrt(Math.max(ratio, 1 / ratio))) : (tools.perUnit ?? 0) > 15 ? 640 : 1024) : 2048;
        images.push((await picture(ref, tools, "in", fit, editing && i === 0)).name);
      }
      if (io.images.length && !images.length) throw new EngineError("Add a picture first.");
      const video = mode === "vupscale" && job.source ? (await tools.upload(job.source.path, "clip")).name : undefined;
      const f = fillFor(job, images, video, `crackio/${key}`, size);
      const grown = growImages(settle(fill(templateGraph(name), io, { ...f, aspect: nearestAspect(ratio), megapixels: mp })), images.slice(io.images.length));
      const free = grows && !editing && size ? freeLatent(grown, size, count(job)) : grown;
      // Only part of the picture may change (the Director's unseen parts): the sampler starts from it, noise-masked.
      const masked = mode === "edit" && job.mask ? maskLatent(free, (await tools.upload(job.mask.path, "mask")).name, io.images[0]?.id) : free;
      // Or redrawn over itself (the Director's plate): the layout kept, every surface drawn fresh.
      const denoise = job.options?.denoise;
      const filled = mode === "edit" && !job.mask && typeof denoise === "number" && denoise > 0 && denoise < 1 ? redrawLatent(masked, denoise, io.images[0]?.id) : masked;
      const referenced = mode === "r2v" ? referenceGraph(filled, size, job.start ? (await picture(job.start, tools, "start", 2048)).name : undefined) : filled;
      const gguf = variant.files.find((x) => x.role === "model")?.name;
      const graph = variant.replaces && gguf ? swapModel(referenced, variant.replaces, gguf, tools.pool, clip ? 1 : count(job)) : referenced;
      // Templates are made for stock ComfyUI: a ComfyUI started with SageAttention turns some of them black (Z-Image base).
      return (await tools.hasNode?.("ModelAttentionBackend")) ? stockAttention(graph) : graph;
    },
  };
}

/**
 * The size a picture renders at and the size it ends at: the resolution asked (local/resolution), made natively up to what
 * the model renders well (`maxMp`), the rest by drawing its detail in (`detail`, on a GPU as quick as `perUnit` says) or
 * enlarging. Null for clips, upscales, and jobs that ask for no resolution (they render at about 1 MP, as before).
 */
export function picturePlan(recipe: Recipe, job: EngineJob, perUnit?: number | null) {
  if (recipe.output !== "image" || job.kind === "upscale") return null;
  const asked = String(job.options?.resolution ?? "");
  if (!IMAGE_RESOLUTIONS.some((r) => r.value === asked)) return null;
  const ratio = job.width / Math.max(1, job.height);
  const target = imagePixels(asked, ratio);
  const max = recipe.nativeMp?.(job, perUnit) ?? recipe.maxMp ?? 2.1;
  const edge = recipe.maxEdge ?? Infinity;
  const capped = pixelsAt(max, ratio, edge);
  const native = target.mp <= max * 1.02 && Math.max(target.width, target.height) <= edge ? target : { ...capped, mp: (capped.width * capped.height) / 1e6 };
  const factor = Math.sqrt(target.mp / native.mp);
  // More than a lanczos fit hides.
  return { native, target, factor, detail: recipe.detailable !== false && factor > 1.15 && (perUnit ?? 0) <= DETAIL_PASS.slowest };
}

/** A job's work in the Local catalog's units at the size it renders at (a recipe's own units count pictures of about 1 MP). */
export function jobUnits(recipe: Recipe, job: EngineJob, referenceMp?: number, perUnit?: number | null) {
  const base = recipe.units?.(job, referenceMp) ?? 1;
  const plan = picturePlan(recipe, job, perUnit);
  if (!plan) return base;
  return base * plan.native.mp ** WORK_POWER + (plan.detail ? count(job) * DETAIL_PASS.work * plan.target.mp ** WORK_POWER : 0);
}

export const recipeFor = (model: string) => RECIPES.find((r) => r.id === model) ?? (model.startsWith("tpl:") ? templateRecipe(model.slice(4)) : null);
