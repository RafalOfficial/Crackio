import "server-only";
import type { EngineJob } from "./types";

/**
 * ComfyUI's official templates, run from Crackio. Each template ships as the API graph ComfyUI's own frontend makes
 * of it (comfyui/templates/api, MIT, from Comfy-Org/workflow_templates); this file finds where a graph takes its
 * inputs and fills them from a job:
 * - the prompt: the text that reaches a sampler's `positive` side, through encoders, switches and primitives;
 * - pictures and clips: its LoadImage / LoadVideo nodes, in order;
 * - shape and length: Width / Height / Duration primitives, Resolution Selectors, literal latent sizes and frame counts;
 * - seeds, the save nodes' file names;
 * - its own switches: prompt enhancers go off (Crackio writes the prompt), speed LoRA toggles follow the quality asked.
 */

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ApiGraph = Record<string, ApiNode>;
type Spot = { id: string; input: string };

export type TemplateIO = {
  /** Where the prompt goes (a primitive's value, or an encoder's literal text). */
  prompt: Spot[];
  images: { id: string; title: string }[];
  videos: string[];
  audios: string[];
  /** Switches whose "true" side is a prompt enhancer (an LLM that rewrites the prompt). */
  enhancers: Spot[];
  /** Booleans that turn on a few-step speed LoRA. */
  fast: string[];
  /** A boolean that turns an image-to-video template into text-to-video. */
  textToVideo: string | null;
  /** A boolean that turns a text-to-image template into an editor of the picture it's given (HiDream-O1). */
  editSwitch: string | null;
  widths: Spot[];
  heights: Spot[];
  resolutions: string[];
  durations: Spot[];
  /** Literal frame counts on latent nodes, with the step they must align to (4n+1 for Wan, 8n+1 for LTX). */
  lengths: (Spot & { align: number })[];
  /** The most frames the template makes, when its length is capped ("min(a * 16 + 1, 81)": Causal Forcing's 5 s). */
  maxFrames: number | null;
  fps: number | null;
  seeds: Spot[];
  saves: string[];
  /** Upscale factors (a "scale by multiplier" resize, an ImageScaleBy) an upscaler template hard-codes. */
  scales: Spot[];
  /** How many denoising steps the default path takes, and whether it runs guidance (CFG above 1). */
  steps: number | null;
  cfg: number | null;
  /** The steps come from a fixed list of noise levels (ManualSigmas), which a step count can't change. */
  stepsFixed: boolean;
};

export const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
const title = (n: ApiNode | undefined) => n?._meta?.title ?? "";
const ENCODER = /TextEncode|CLIPTextEncode/;
const GENERATOR = /^TextGenerate/;
/** Nodes that set the output's size: latents, video conditioning (ARVideoI2V's "I2V" too), and FLUX.2's size-aware scheduler. */
const LATENT_SIZE = /Latent|ToVideo|Empty|[IT]2V$|^Flux2Scheduler$/;
const SAVE = /^(SaveImage|SaveImageAdvanced|SaveVideo|SaveAnimatedWEBP|SaveAnimatedPNG|SaveWEBM)$/;

/** Literal value of an input, following one primitive link (a PrimitiveInt's value, say). */
function literal(g: ApiGraph, v: unknown): unknown {
  if (!isLink(v)) return v;
  const n = g[v[0]];
  if (n && /^Primitive/.test(n.class_type)) return n.inputs.value;
  return undefined;
}

/** Every place the text reaching an encoder's input could come from: primitives' values and literal strings. */
function textCandidates(g: ApiGraph, id: string, input: string, io: TemplateIO, seen = new Set<string>()): Spot[] {
  const v = g[id]?.inputs[input];
  if (typeof v === "string") return [{ id, input }];
  if (!isLink(v) || seen.has(v[0])) return [];
  seen.add(v[0]);
  const src = g[v[0]];
  if (!src) return [];
  const c = src.class_type;
  if (/^PrimitiveString/.test(c)) return [{ id: v[0], input: "value" }];
  if (c === "ComfySwitchNode") {
    const onTrue = src.inputs.on_true;
    // An enhancer on the "true" side: switch it off and follow the raw text.
    if (isLink(onTrue) && GENERATOR.test(g[onTrue[0]]?.class_type ?? "")) {
      io.enhancers.push({ id: v[0], input: "switch" });
      return textCandidates(g, v[0], "on_false", io, seen);
    }
    const on = literal(g, src.inputs.switch);
    return textCandidates(g, v[0], on === true ? "on_true" : "on_false", io, seen);
  }
  if (GENERATOR.test(c)) return textCandidates(g, v[0], "prompt", io, seen);
  // Text plumbing (previews, concatenation, find-and-replace): every string input it's built from.
  if (/^(PreviewAny|String\w*|Text\w*)$/.test(c)) {
    return Object.entries(src.inputs).flatMap(([k, x]) => (isLink(x) || (typeof x === "string" && /string|text|source|replace/.test(k)) ? textCandidates(g, v[0], k, io, seen) : []));
  }
  return [];
}

/** The one place the user's words go: a lone candidate, else the one titled like a user prompt (never a system prompt or template). */
function textSource(g: ApiGraph, id: string, input: string, io: TemplateIO): Spot[] {
  const all = textCandidates(g, id, input, io);
  if (all.length <= 1) return all;
  const score = (s: Spot) => {
    const t = s.id === id ? "" : title(g[s.id]);
    if (/system|template|negative|trigger|find/i.test(t) || /find/i.test(s.input)) return -1;
    if (/user/i.test(t)) return 3;
    if (/prompt|caption|positive|text/i.test(t)) return 2;
    return 1;
  };
  const best = Math.max(...all.map(score));
  return best < 0 ? [] : all.filter((s) => score(s) === best).slice(0, 1);
}

/** The encoders on a sampler's positive (or negative) side, walking back through conditioning nodes. */
function encoders(g: ApiGraph, start: unknown, side: "positive" | "negative", seen = new Set<string>()): string[] {
  if (!isLink(start) || seen.has(start[0])) return [];
  seen.add(start[0]);
  const n = g[start[0]];
  if (!n) return [];
  // Encoders, and model nodes that encode their own prompt (MiniMax H3's image-to-video takes the CLIP and the words).
  if (ENCODER.test(n.class_type) || (n.inputs.clip !== undefined && (n.inputs.prompt !== undefined || n.inputs.text !== undefined))) return [start[0]];
  // Nodes that carry both sides (guiders, LTX conditioning, crop guides): follow the same side; otherwise every
  // conditioning-like input (reference latents, zero-outs, reference methods).
  if (n.inputs.positive !== undefined || n.inputs.negative !== undefined) return encoders(g, n.inputs[side], side, seen);
  return Object.entries(n.inputs)
    .filter(([k, v]) => isLink(v) && /cond|positive|negative/i.test(k))
    .flatMap(([, v]) => encoders(g, v, side, seen));
}

/** Nodes that load a diffusion model, and the output that carries it. */
const MODEL_LOADERS: Record<string, number> = { UNETLoader: 0, UnetLoaderGGUF: 0, CrackioPoolLoaderGGUF: 0, CheckpointLoaderSimple: 0, ImageOnlyCheckpointLoader: 0, DiffusersLoader: 0 };

/**
 * Every diffusion model the graph loads, set to PyTorch's own attention (core `ModelAttentionBackend`, ComfyUI 0.4+): what
 * a stock ComfyUI runs, whatever attention this one was started with.
 */
export function stockAttention(g: ApiGraph): ApiGraph {
  const out: ApiGraph = structuredClone(g);
  for (const [id, n] of Object.entries(g)) {
    const slot = MODEL_LOADERS[n.class_type];
    if (slot === undefined) continue;
    const patched = `${id}:attention`;
    for (const node of Object.values(out)) {
      for (const [key, v] of Object.entries(node.inputs)) if (isLink(v) && v[0] === id && v[1] === slot) node.inputs[key] = [patched, 0];
    }
    out[patched] = { class_type: "ModelAttentionBackend", inputs: { model: [id, slot], attention: "pytorch attention" } };
  }
  return out;
}

/**
 * A graph for a Mac (PyTorch's MPS). `tuning`: every diffusion model goes through the bridge's Crackio Mac Tuning, which
 * computes it in what the chip runs fastest (fp16 on M1 and M2, whose GPUs run ComfyUI's bf16 at half speed: FLUX.2 klein
 * went from 28 to 17 s a step on an M2 Air) and rests between steps while macOS says the Mac is hot (a MacBook Air has no
 * fan). And uni_pc samplers become euler: MPS has no float64, and uni_pc's coefficients come out wrong there, blowing out
 * Wan clips (ComfyUI #16573, open in Oct 2026).
 */
export function forMac(g: ApiGraph, tuning: boolean): ApiGraph {
  const out: ApiGraph = structuredClone(g);
  for (const n of Object.values(out)) if (typeof n.inputs.sampler_name === "string" && n.inputs.sampler_name.startsWith("uni_pc")) n.inputs.sampler_name = "euler";
  if (!tuning) return out;
  for (const [id, n] of Object.entries(g)) {
    const slot = MODEL_LOADERS[n.class_type];
    if (slot === undefined) continue;
    const patched = `${id}:mac`;
    for (const node of Object.values(out)) {
      for (const [key, v] of Object.entries(node.inputs)) if (isLink(v) && v[0] === id && v[1] === slot) node.inputs[key] = [patched, 0];
    }
    out[patched] = { class_type: "CrackioMacTuning", inputs: { model: [id, slot] } };
  }
  return out;
}

export function analyze(g: ApiGraph): TemplateIO {
  const io: TemplateIO = {
    prompt: [],
    images: [],
    videos: [],
    audios: [],
    enhancers: [],
    fast: [],
    textToVideo: null,
    editSwitch: null,
    widths: [],
    heights: [],
    resolutions: [],
    durations: [],
    lengths: [],
    maxFrames: null,
    fps: null,
    seeds: [],
    saves: [],
    scales: [],
    steps: null,
    cfg: null,
    stepsFixed: false,
  };
  const positive = new Set<string>();
  // Steps from a scheduler or sampler (a count Crackio can change), or only from fixed lists of noise levels.
  let scheduled = false;
  let listed = false;
  for (const [id, n] of Object.entries(g)) {
    const c = n.class_type;
    const t = title(n);
    if (c === "LoadImage") io.images.push({ id, title: t });
    else if (c === "LoadVideo") io.videos.push(id);
    else if (c === "LoadAudio") io.audios.push(id);
    else if (SAVE.test(c)) io.saves.push(id);
    else if (c === "ResolutionSelector") io.resolutions.push(id);
    else if (c === "PrimitiveBoolean") {
      // Speed LoRAs ("4steps", "8 steps", lightning, lightx2v, a misspelt "Distll"), prompt rewriters (Crackio writes
      // the prompt), and the mode switches.
      if (/\d+\s*-?\s*steps?|lightning|lightx2v|turbo lora|dis?t+i?l+(ed)?\s*lora|speed/i.test(t)) io.fast.push(id);
      else if (/prompt\s*(enhance|refine)|refine\s*prompt|enhancement/i.test(t)) io.enhancers.push({ id, input: "value" });
      else if (/text\s*to\s*video/i.test(t)) io.textToVideo = id;
      else if (/switch to image edit|image edit mode/i.test(t)) io.editSwitch = id;
    } else if (/^Primitive(Int|Float)$/.test(c)) {
      if (/^width$/i.test(t.trim())) io.widths.push({ id, input: "value" });
      else if (/^height$/i.test(t.trim())) io.heights.push({ id, input: "value" });
      else if (/duration|seconds/i.test(t)) io.durations.push({ id, input: "value" });
      else if (/^(fps|frame ?rate)/i.test(t.trim())) io.fps = Number(n.inputs.value) || io.fps;
    }
    if (c === "CreateVideo" && typeof n.inputs.fps === "number") io.fps ??= n.inputs.fps;
    if (c === "ComfyMathExpression" && typeof n.inputs.expression === "string") {
      const cap = /min\([^,]*,\s*(\d+)\s*\)/.exec(n.inputs.expression)?.[1];
      if (cap) io.maxFrames = Math.max(io.maxFrames ?? 0, Number(cap));
    }
    if (c === "ResizeImageMaskNode" && n.inputs.resize_type === "scale by multiplier" && typeof n.inputs["resize_type.multiplier"] === "number") io.scales.push({ id, input: "resize_type.multiplier" });
    if (c === "ImageScaleBy" && typeof n.inputs.scale_by === "number") io.scales.push({ id, input: "scale_by" });
    if (LATENT_SIZE.test(c)) {
      if (typeof n.inputs.width === "number") io.widths.push({ id, input: "width" });
      if (typeof n.inputs.height === "number") io.heights.push({ id, input: "height" });
      for (const key of ["length", "num_frames", "frames_number", "video_length"]) {
        if (typeof n.inputs[key] === "number") io.lengths.push({ id, input: key, align: /LTXV/.test(c) ? 8 : 4 });
      }
    }
    for (const key of ["seed", "noise_seed"]) if (typeof n.inputs[key] === "number") io.seeds.push({ id, input: key });
    // Sampling: the steps and guidance of the default path.
    if (/^KSampler|^SamplerCustom$|^BasicScheduler$|Scheduler$/.test(c)) {
      const s = literal(g, n.inputs.steps);
      if (typeof s === "number") {
        if (io.steps === null) io.steps = s;
        scheduled = true;
      }
    }
    if (c === "ManualSigmas" && typeof n.inputs.sigmas === "string") {
      io.steps = (io.steps ?? 0) + n.inputs.sigmas.split(",").length - 1;
      listed = true;
    }
    if (/^KSampler|Guider$|^SamplerCustom$/.test(c) && io.cfg === null) {
      const v = literal(g, n.inputs.cfg);
      if (typeof v === "number") io.cfg = v;
    }
    // Samplers and guiders: their positive side (a single-conditioning guider's only one; a dual-CFG guider's first).
    for (const key of /Guider$|^KSampler|^SamplerCustom/.test(c) ? ["positive", "conditioning", "cond1"] : ["positive"]) {
      for (const e of encoders(g, n.inputs[key], "positive")) positive.add(e);
    }
  }
  for (const id of positive) {
    const n = g[id];
    for (const key of ["text", "prompt", "t5xxl", "clip_l"]) if (n.inputs[key] !== undefined) io.prompt.push(...textSource(g, id, key, io));
  }
  io.stepsFixed = listed && !scheduled;
  // The same spot can be reached twice (two encoders sharing a primitive).
  io.prompt = io.prompt.filter((s, i, all) => all.findIndex((x) => x.id === s.id && x.input === s.input) === i);
  io.images.sort((a, b) => order(a.title) - order(b.title) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return io;
}

/** First frames first, last frames last: titles say which picture is which. */
function order(t: string) {
  if (/start|first/i.test(t)) return 0;
  if (/end|last/i.test(t)) return 2;
  return 1;
}

export type Fill = {
  prompt: string;
  /** Uploaded file names, in ComfyUI's input folder. */
  images: string[];
  video?: string;
  width?: number;
  height?: number;
  seconds?: number;
  count?: number;
  /** "fast" turns a template's few-step speed LoRA on. */
  quality?: "fast" | "best";
  /** An upscaler's factor. */
  scale?: number;
  /** For Resolution Selector nodes: one of its aspect options, and the megapixels. */
  aspect?: string;
  megapixels?: number;
  /** Where the save nodes write. */
  prefix: string;
};

const seed = () => Math.floor(Math.random() * 2 ** 48);

/** The template's graph with a job's inputs in it (a copy). */
export function fill(graph: ApiGraph, io: TemplateIO, f: Fill): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const set = (s: Spot, v: unknown) => {
    if (g[s.id]) g[s.id].inputs[s.input] = v;
  };
  for (const s of io.prompt) set(s, f.prompt);
  for (const s of io.enhancers) set(s, false);
  for (const id of io.fast) set({ id, input: "value" }, f.quality !== "best");
  if (io.textToVideo) set({ id: io.textToVideo, input: "value" }, f.images.length === 0);
  if (io.editSwitch) set({ id: io.editSwitch, input: "value" }, f.images.length > 0);
  // Pictures in order; a template that takes more than were given repeats the last one.
  io.images.forEach((img, i) => {
    const name = f.images[Math.min(i, f.images.length - 1)];
    if (name) set({ id: img.id, input: "image" }, name);
  });
  if (f.video) for (const id of io.videos) set({ id, input: "file" }, f.video);
  if (f.width && f.height) {
    for (const s of io.widths) set(s, f.width);
    for (const s of io.heights) set(s, f.height);
  }
  if (f.scale) for (const s of io.scales) set(s, f.scale);
  for (const id of io.resolutions) {
    if (f.aspect) set({ id, input: "aspect_ratio" }, f.aspect);
    if (f.megapixels) set({ id, input: "megapixels" }, f.megapixels);
  }
  if (f.seconds) {
    for (const s of io.durations) set(s, f.seconds);
    const fps = io.fps ?? 24;
    for (const s of io.lengths) set(s, Math.max(s.align + 1, Math.round((f.seconds * fps) / s.align) * s.align + 1));
  }
  if (f.count) {
    for (const [, n] of Object.entries(g)) if (LATENT_SIZE.test(n.class_type) && typeof n.inputs.batch_size === "number" && !/Video|LTXV|Wan|Hunyuan/.test(n.class_type)) n.inputs.batch_size = f.count;
  }
  for (const s of io.seeds) set(s, seed());
  for (const id of io.saves) set({ id, input: "filename_prefix" }, f.prefix);
  return g;
}

/** Encoders that take any number of pictures as `images.image_N` (Qwen-Image 2.1's takes 16): a template wires a few. */
const GROWING: Record<string, { input: (k: number) => string; wired: RegExp; max: number }> = {
  TextEncodeQwenImage21: { input: (k) => `images.image_${k}`, wired: /^images\.image_\d+$/, max: 16 },
  TextEncodeQwenImageEditPlus: { input: (k) => `image${k}`, wired: /^image\d$/, max: 3 },
};
/** How many pictures an edit template's model reads at most, once Crackio wires more into a growing encoder. */
export const GROWN_PICTURES = 5;

export function growsImages(graph: ApiGraph) {
  return Object.values(graph).some((n) => n.class_type in GROWING);
}

/** The most pictures a template's growing encoders take (Crackio wires at most GROWN_PICTURES). */
export function grownRoom(graph: ApiGraph) {
  const limits = Object.values(graph).flatMap((n) => (n.class_type in GROWING ? [GROWING[n.class_type].max] : []));
  return limits.length ? Math.min(GROWN_PICTURES, ...limits) : 0;
}

/**
 * Pictures past the template's own LoadImage nodes, wired into its growing encoders after the ones it has
 * (`images.image_3`, `images.image_4`…), in order. A copy; graphs without such an encoder come back as they are.
 */
export function growImages(graph: ApiGraph, names: string[]): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const encoders = Object.values(g).filter((n) => n.class_type in GROWING);
  if (!encoders.length || !names.length) return g;
  const ids = names.map((name, k) => {
    const id = `crackio_picture_${k + 1}`;
    g[id] = { class_type: "LoadImage", inputs: { image: name } };
    return id;
  });
  for (const n of encoders) {
    const kind = GROWING[n.class_type];
    const wired = Object.keys(n.inputs).filter((k) => kind.wired.test(k)).length;
    ids.forEach((id, k) => {
      if (wired + k + 1 <= kind.max) n.inputs[kind.input(wired + k + 1)] = [id, 0];
    });
  }
  return g;
}

/**
 * A growing encoder's job when nothing is to be edited (every picture a reference: who, what, where): the result is
 * made at the size asked, on an empty latent, instead of on the first picture's (which sets the size for an edit).
 */
export function freeLatent(graph: ApiGraph, size: { width: number; height: number }, count = 1): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const encoders = new Set(Object.entries(g).filter(([, n]) => n.class_type in GROWING).map(([id]) => id));
  for (const n of Object.values(g)) {
    // Any sampler (KSampler, SamplerCustomAdvanced…) whose latent comes from the encoder.
    const latent = n.inputs.latent_image;
    if (!isLink(latent) || !encoders.has(String(latent[0]))) continue;
    const id = `crackio_latent_${Object.keys(g).length}`;
    g[id] = { class_type: "EmptyLatentImage", inputs: { width: size.width, height: size.height, batch_size: count } };
    n.inputs.latent_image = [id, 0];
  }
  return g;
}

/**
 * An edit that may only change part of the picture (the Director's unseen parts): every sampler starts from the picture
 * itself, noise-masked so only the mask's white parts are redrawn (ComfyUI's SetLatentNoiseMask). The picture comes from
 * the graph's own VAEEncode (Qwen-Image-Edit, FLUX.2 klein), or is encoded from the first picture (`imageId`) with the
 * graph's VAE when it has none (FLUX 3 Klein reads its pictures as references only). Unchanged when neither is there.
 */
export function maskLatent(graph: ApiGraph, maskName: string, imageId?: string): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const samplers = Object.values(g).filter((n) => isLink(n.inputs.latent_image));
  if (!samplers.length) return g;
  const encoded = encodedPicture(g, imageId);
  if (!encoded) return g;
  g.crackio_mask = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
  g.crackio_masked = { class_type: "SetLatentNoiseMask", inputs: { samples: [encoded, 0], mask: ["crackio_mask", 0] } };
  for (const n of samplers) n.inputs.latent_image = ["crackio_masked", 0];
  return g;
}

/** The graph's own encoding of its first picture (its VAEEncode), or one added from `imageId` with its VAE; null without. */
function encodedPicture(g: ApiGraph, imageId?: string) {
  const own = Object.keys(g).find((id) => g[id].class_type === "VAEEncode");
  if (own) return own;
  const vae = Object.keys(g).find((id) => g[id].class_type === "VAELoader");
  if (!vae || !imageId || !g[imageId]) return null;
  g.crackio_encoded = { class_type: "VAEEncode", inputs: { pixels: [imageId, 0], vae: [vae, 0] } };
  return "crackio_encoded";
}

/**
 * A picture redrawn over itself (image to image): every sampler starts from the picture, noised `denoise` (0 to 1) of
 * the way, so the layout stays and every surface is drawn fresh. For the Director's plate: its 3D set shows seams between
 * views and smears on objects, which an edit copies as they are. KSamplers take the strength; custom samplers run the
 * tail of their schedule (SplitSigmasDenoise). Unchanged without a picture to start from.
 */
export function redrawLatent(graph: ApiGraph, denoise: number, imageId?: string): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const samplers = Object.entries(g).filter(([, n]) => isLink(n.inputs.latent_image));
  const encoded = samplers.length ? encodedPicture(g, imageId) : null;
  if (!encoded) return g;
  for (const [id, n] of samplers) {
    n.inputs.latent_image = [encoded, 0];
    if ("denoise" in n.inputs) n.inputs.denoise = denoise;
    else if (isLink(n.inputs.sigmas)) {
      const split = `crackio_redraw_${id.replace(/\W/g, "_")}`;
      g[split] = { class_type: "SplitSigmasDenoise", inputs: { sigmas: n.inputs.sigmas, denoise } };
      n.inputs.sigmas = [split, 1];
    }
  }
  return g;
}

/**
 * The graph as it will run: every switch settled (its consumers wired straight to the chosen side) and every node the
 * save nodes don't need dropped, previews included. A template's prompt enhancer and its other branches go with
 * them, so their model files aren't needed at all.
 */
export function settle(graph: ApiGraph): ApiGraph {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  // Switches first, repeatedly: a switch can feed another.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, n] of Object.entries(g)) {
      if (n.class_type !== "ComfySwitchNode") continue;
      const on = literal(g, n.inputs.switch);
      if (typeof on !== "boolean") continue;
      const chosen = n.inputs[on ? "on_true" : "on_false"];
      for (const other of Object.values(g)) {
        for (const [k, v] of Object.entries(other.inputs)) if (isLink(v) && v[0] === id) other.inputs[k] = chosen;
      }
      delete g[id];
      changed = true;
    }
  }
  // Everything the saves depend on.
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !g[id]) return;
    keep.add(id);
    for (const v of Object.values(g[id].inputs)) if (isLink(v)) visit(v[0]);
  };
  for (const [id, n] of Object.entries(g)) if (SAVE.test(n.class_type)) visit(id);
  for (const id of Object.keys(g)) if (!keep.has(id)) delete g[id];
  return g;
}

/** A literal input, or the primitive it's wired to: where a value really lives. */
function valueSpot(g: ApiGraph, id: string, input: string): Spot | null {
  const v = g[id]?.inputs[input];
  if (typeof v === "number" || typeof v === "string") return { id, input };
  if (isLink(v) && /^Primitive/.test(g[v[0]]?.class_type ?? "")) return { id: v[0], input: "value" };
  return null;
}

const STEPPED = /^KSampler(Advanced)?$|^SamplerCustom$|Scheduler$/;
const GUIDED = /^KSampler(Advanced)?$|^SamplerCustom$|^CFGGuider$/;

/**
 * LoRAs you chose (`file` as ComfyUI lists it in models/loras, `strength`) put on a graph's model: a chain of
 * LoraLoaderModelOnly after each loader of the model, and everything that took the model from the loader takes it from
 * the chain. One place for every model and tool, where until now each recipe wired its own (the swap's SCAIL LoRAs).
 * `match`: a file made for one of the graph's models only (a Wan 2.2 A14B pair's high-noise half) goes on the loaders
 * whose file matches it.
 */
export function withLoras(graph: ApiGraph, loras: { file: string; strength: number; match?: string }[]): ApiGraph {
  if (!loras.length) return graph;
  const g: ApiGraph = structuredClone(graph);
  for (const id of Object.keys(g).filter((k) => g[k].class_type in MODEL_LOADERS)) {
    const out = MODEL_LOADERS[g[id].class_type];
    const loads = Object.values(g[id].inputs)
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    const mine = loras.filter((l) => !l.match || matches(l.match, loads));
    if (!mine.length) continue;
    const chain = mine.map((_, i) => `crackio:lora:${id}:${i}`);
    mine.forEach((l, i) => {
      g[chain[i]] = { class_type: "LoraLoaderModelOnly", inputs: { model: i ? [chain[i - 1], 0] : [id, out], lora_name: l.file, strength_model: l.strength } };
    });
    const last: [string, number] = [chain[chain.length - 1], 0];
    for (const [nid, n] of Object.entries(g)) {
      if (chain.includes(nid)) continue;
      for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && String(v[0]) === id && v[1] === out) n.inputs[k] = last;
    }
  }
  return g;
}

/** A LoRA's `match` against what a loader loads; a pattern that doesn't parse matches nothing. */
function matches(pattern: string, text: string) {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

/**
 * A job's Advanced options in any graph Crackio runs (a tuned recipe's or a template's), on a copy:
 * - steps: the main sampling pass (the one with the most steps; a refining pass after it keeps its own). Samplers that
 *   split one schedule between them (KSamplerAdvanced's start and end steps, Wan 2.2's two experts) split the new one alike;
 * - guidance on every sampler and guider;
 * - the seed on every noise source;
 * - the negative prompt on every sampler's negative side: the text of its encoder, or, where the negative side is the
 *   positive one zeroed out (CFG 1 models), an encoder like the positive one with these words.
 */
export function tune(graph: ApiGraph, t: { steps?: number; cfg?: number; seed?: number; negative?: string }): ApiGraph {
  const g: ApiGraph = structuredClone(graph);
  const set = (s: Spot | null, v: unknown) => s && g[s.id] && (g[s.id].inputs[s.input] = v);
  if (t.steps && t.steps > 0) {
    const stepped = Object.keys(g)
      .filter((id) => STEPPED.test(g[id].class_type))
      .map((id) => ({ id, spot: valueSpot(g, id, "steps") }))
      .map((x) => ({ ...x, steps: x.spot ? Number(g[x.spot.id].inputs[x.spot.input]) : NaN }))
      .filter((x): x is { id: string; spot: Spot; steps: number } => x.spot !== null && x.steps > 0);
    const main = stepped.sort((a, b) => b.steps - a.steps)[0];
    if (main) {
      const steps = Math.round(t.steps);
      const scale = steps / main.steps;
      for (const x of stepped) {
        if (x.steps !== main.steps || (x.id !== main.id && g[x.id].class_type !== "KSamplerAdvanced")) continue;
        set(x.spot, steps);
        for (const key of ["start_at_step", "end_at_step"]) {
          const at = g[x.id].inputs[key];
          if (typeof at === "number" && at < 10_000) g[x.id].inputs[key] = Math.round(at * scale);
        }
      }
    }
  }
  if (typeof t.cfg === "number" && t.cfg > 0) {
    for (const id of Object.keys(g)) {
      if (GUIDED.test(g[id].class_type)) set(valueSpot(g, id, "cfg"), t.cfg);
      // LTX's guider keeps the picture's guidance and the sound's apart: the picture's changes.
      else if (g[id].class_type === "LTXVDualCFGGuider") set(valueSpot(g, id, "video_cfg"), t.cfg);
    }
  }
  if (typeof t.seed === "number" && t.seed >= 0) {
    for (const id of Object.keys(g)) for (const key of ["seed", "noise_seed"]) if (g[id].inputs[key] !== undefined) set(valueSpot(g, id, key), Math.floor(t.seed));
  }
  if (t.negative?.trim()) {
    const words = t.negative.trim();
    // Encoders the positive side reads are never rewritten: a sampler fed the same words on both sides gets its own.
    const positives = new Set(Object.values(graph).flatMap((n) => (n.inputs.positive !== undefined ? encoders(graph, n.inputs.positive, "positive") : [])));
    const textKey = (n: ApiNode) => (n.inputs.text !== undefined ? "text" : n.inputs.prompt !== undefined ? "prompt" : null);
    // Encoders with a negative field of their own (Qwen-Image 2.1's) make both sides: the words go there.
    const ownField = Object.keys(graph).filter((id) => ENCODER.test(graph[id].class_type) && graph[id].inputs.negative_prompt !== undefined);
    for (const id of ownField) set(valueSpot(g, id, "negative_prompt"), words);
    for (const id of Object.keys(graph)) {
      const neg = graph[id].inputs.negative;
      if (!isLink(neg)) continue;
      const side = negativeSide(graph, neg);
      for (const e of side.encoders) {
        if (ownField.includes(e)) continue;
        const key = textKey(graph[e]);
        if (!key) continue;
        if (!positives.has(e)) set(valueSpot(g, e, key), words);
        else if (neg[0] === e) {
          g[`${e}:negative`] = { class_type: graph[e].class_type, inputs: { ...graph[e].inputs, [key]: words } };
          g[id].inputs.negative = [`${e}:negative`, neg[1]];
        }
      }
      // The positive side zeroed out (CFG 1 models): in its place, an encoder like the positive one with these words.
      for (const zero of side.zeroed) {
        const from = graph[zero].inputs.conditioning;
        const source = isLink(from) ? graph[from[0]] : undefined;
        const key = source && ENCODER.test(source.class_type) ? textKey(source) : null;
        if (source && key) g[zero] = { class_type: source.class_type, inputs: { ...source.inputs, [key]: words } };
      }
    }
  }
  return g;
}

/**
 * What a sampler's negative side is made of, walking back through conditioning nodes: its own encoders, and the
 * ConditioningZeroOut nodes that empty the positive side for it. The walk stops at both: behind a zero-out is the positive
 * prompt.
 */
function negativeSide(g: ApiGraph, start: unknown): { encoders: string[]; zeroed: string[] } {
  const out = { encoders: [] as string[], zeroed: [] as string[] };
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (!isLink(v) || seen.has(v[0])) return;
    seen.add(v[0]);
    const n = g[v[0]];
    if (!n) return;
    if (n.class_type === "ConditioningZeroOut") return void out.zeroed.push(v[0]);
    if (ENCODER.test(n.class_type) || (n.inputs.clip !== undefined && (n.inputs.prompt !== undefined || n.inputs.text !== undefined))) return void out.encoders.push(v[0]);
    if (n.inputs.positive !== undefined || n.inputs.negative !== undefined) return walk(n.inputs.negative);
    for (const [k, x] of Object.entries(n.inputs)) if (isLink(x) && /cond|negative/i.test(k)) walk(x);
  };
  walk(start);
  return out;
}

/**
 * Every saved picture brought to width × height, on a copy: Real-ESRGAN ×4 (ComfyUI runs it in tiles), then a lanczos fit to
 * the exact size, cropped to the middle where the shapes differ by a few pixels; a small step up is a lanczos fit alone.
 */
export function enlarge(graph: ApiGraph, size: { width: number; height: number }, factor: number, upscaler: string | null): ApiGraph {
  const g: ApiGraph = structuredClone(graph);
  const model = upscaler && factor > 1.35 ? "crackio:upscaler" : null;
  if (model) g[model] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscaler } };
  let k = 0;
  for (const [id, n] of Object.entries(graph)) {
    if (!/^SaveImage(Advanced)?$/.test(n.class_type) || !isLink(n.inputs.images)) continue;
    let image: [string, number] = n.inputs.images;
    if (model) {
      g[`crackio:up${k}`] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: [model, 0], image } };
      image = [`crackio:up${k}`, 0];
    }
    g[`crackio:fit${k}`] = { class_type: "ImageScale", inputs: { image, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" } };
    g[id].inputs.images = [`crackio:fit${k}`, 0];
    k++;
  }
  return g;
}

const TILES = { tile_size: 1024, overlap: 64, temporal_size: 64, temporal_overlap: 8 };

/** The conditioning under a model's reference pictures (ReferenceMultiLatent, ReferenceLatent): the words alone. */
function wordsOnly(g: ApiGraph, link: unknown): unknown {
  let v = link;
  for (let i = 0; i < 8 && isLink(v); i++) {
    const n = g[v[0]];
    if (n?.class_type === "ReferenceMultiLatent") v = v[1] === 1 ? n.inputs.negative : n.inputs.positive;
    else if (n?.class_type === "ReferenceLatent") v = n.inputs.conditioning;
    else break;
  }
  return v;
}

/**
 * Every saved picture brought to width × height with its detail drawn at that size, on a copy (a "hires fix"): the picture
 * is enlarged, encoded, and its own sampler draws over it lightly, `denoise` of the way, with the same model, prompt and
 * references. An enlarger sharpens what's there; this draws plaster, weave and lettering anew. Measured with FLUX 3 Klein
 * from 4.2 MP to 3840×2160 on an RTX 5090: 8 steps 15 s, 15 steps 26 s, against a smeared Real-ESRGAN. A lanczos fit is
 * enough to draw over at 1.4×; at 2× the light pass can't sharpen a blurry start, so `upscaler` (Real-ESRGAN) enlarges first.
 * It draws from the words alone: the picture already holds who and what its references showed, and reading them again
 * (four at 4.2 MP in a Director shot) oversaturated it and took minutes.
 * KSamplers run `steps` steps at that strength, and custom samplers the same schedule (BasicScheduler on their model) when
 * theirs takes 8 steps or more. A few-step model's own (a fixed list, or FLUX.2 klein's 4) is left alone: Qwen-Image 2.1
 * Turbo came out soft on the tail of its list (2 steps from 0.7) and smeared like paint on any other. Null for those, and
 * when a picture doesn't come straight from a sampler: it's enlarged instead.
 */
export function detail(graph: ApiGraph, size: { width: number; height: number }, denoise: number, steps: number, upscaler: string | null): ApiGraph | null {
  const g: ApiGraph = structuredClone(graph);
  if (upscaler) g["crackio:dupscaler"] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscaler } };
  let k = 0;
  for (const [id, n] of Object.entries(graph)) {
    if (!/^SaveImage(Advanced)?$/.test(n.class_type) || !isLink(n.inputs.images)) continue;
    const decode = g[n.inputs.images[0]];
    if (!decode || !/^VAEDecode(Tiled)?$/.test(decode.class_type) || !isLink(decode.inputs.samples)) return null;
    const [from, slot] = decode.inputs.samples;
    const sampler = g[from];
    if (!sampler || !/^(KSampler|SamplerCustomAdvanced|SamplerCustom)$/.test(sampler.class_type)) return null;
    const vae = decode.inputs.vae;
    let image: [string, number] = n.inputs.images;
    if (upscaler) {
      g[`crackio:dup${k}`] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["crackio:dupscaler", 0], image } };
      image = [`crackio:dup${k}`, 0];
    }
    g[`crackio:dfit${k}`] = { class_type: "ImageScale", inputs: { image, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" } };
    g[`crackio:denc${k}`] = { class_type: "VAEEncodeTiled", inputs: { pixels: [`crackio:dfit${k}`, 0], vae, ...TILES } };
    const inputs: Record<string, unknown> = { ...sampler.inputs, latent_image: [`crackio:denc${k}`, 0] };
    for (const side of ["positive", "negative"]) if (side in inputs) inputs[side] = wordsOnly(g, inputs[side]);
    if (sampler.class_type === "KSampler") Object.assign(inputs, { steps, denoise });
    else {
      const schedule = isLink(sampler.inputs.sigmas) ? g[sampler.inputs.sigmas[0]] : undefined;
      if (!(Number(schedule?.inputs.steps) >= 8)) return null;
      const guider = isLink(sampler.inputs.guider) ? g[sampler.inputs.guider[0]] : undefined;
      const model = sampler.class_type === "SamplerCustom" ? sampler.inputs.model : guider?.inputs.model;
      if (!isLink(model)) return null;
      if (guider) {
        const words = Object.fromEntries(["positive", "negative", "conditioning"].filter((side) => side in guider.inputs).map((side) => [side, wordsOnly(g, guider.inputs[side])]));
        g[`crackio:dguide${k}`] = { class_type: guider.class_type, inputs: { ...guider.inputs, ...words } };
        inputs.guider = [`crackio:dguide${k}`, 0];
      }
      g[`crackio:dsched${k}`] = { class_type: "BasicScheduler", inputs: { model, scheduler: "simple", steps, denoise } };
      inputs.sigmas = [`crackio:dsched${k}`, 0];
    }
    g[`crackio:dsample${k}`] = { class_type: sampler.class_type, inputs };
    g[`crackio:ddec${k}`] = { class_type: "VAEDecodeTiled", inputs: { samples: [`crackio:dsample${k}`, slot], vae, ...TILES } };
    g[id].inputs.images = [`crackio:ddec${k}`, 0];
    k++;
  }
  return k ? g : null;
}

/** The model files a (settled) graph loads, of those a template lists. */
export function filesUsed(g: ApiGraph, names: string[]): Set<string> {
  const wanted = new Set(names);
  const used = new Set<string>();
  for (const n of Object.values(g)) for (const v of Object.values(n.inputs)) if (typeof v === "string" && wanted.has(v)) used.add(v);
  return used;
}

/** What a job asks of a template, in its terms. */
export function fillFor(job: EngineJob, images: string[], video: string | undefined, prefix: string, size?: { width: number; height: number }): Fill {
  return {
    prompt: job.prompt,
    images,
    video,
    ...(size ?? {}),
    seconds: typeof job.options?.duration === "number" ? job.options.duration : undefined,
    count: job.count > 1 ? Math.min(4, job.count) : undefined,
    quality: job.options?.quality === "best" ? "best" : "fast",
    scale: job.kind === "upscale" && typeof job.options?.scale === "number" ? job.options.scale : undefined,
    prefix,
  };
}
