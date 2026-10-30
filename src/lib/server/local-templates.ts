import "server-only";
import fs from "node:fs";
import path from "node:path";
import { analyze, filesUsed, fill, grownRoom, growsImages, settle, type ApiGraph, type TemplateIO } from "@/lib/engines/comfy-local-templates";
import { familyOf } from "@/lib/local/families";
import { LOCAL_MODELS } from "@/lib/local/catalog";
import { noteFor } from "@/lib/models/notes";
import type { LocalFile, LocalModel, LocalTask, LocalVariant, TemplateMode } from "@/lib/local/types";
import { aspectChoice, type AspectChoice, type Caps } from "@/lib/models/caps";
import type { ModelDef } from "@/lib/models/catalog";
import { DEFAULT_RESOLUTION, IMAGE_RESOLUTIONS, tuningFor } from "@/lib/local/resolution";

/**
 * Every open model in ComfyUI's official templates, as Local-page models Crackio can install and run. The templates
 * (comfyui/templates: metadata, exact files, and the API graph ComfyUI's frontend makes of each) are grouped by the
 * family of their main model file and by what they make; each precision (int8, fp8, bf16…) and flavour (turbo,
 * distilled, base) is a variant, and each variant knows which template runs which job: words or pictures in, a picture
 * or a clip out. Hand-tuned recipes (local/catalog.ts) take precedence over templates of the same family and kind.
 */

const DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "comfyui", "templates");

export type TemplateMeta = {
  name: string;
  title: string;
  description: string;
  category: string;
  mediaType: "image" | "video";
  tags: string[];
  family: string;
  date: string | null;
  usage: number;
  minComfyUIVersion: string | null;
  thumbnail: string | null;
  files: (LocalFile & { sha256?: string | null })[];
  customNodes: string[];
};

const g = globalThis as unknown as {
  __crackioTemplateIndexAt?: { mtime: number; index: TemplateMeta[] };
  __crackioTemplateGraphs?: Map<string, ApiGraph>;
};

/** The templates' metadata, read again when index.json changes. */
export function templateIndex(): TemplateMeta[] {
  const file = path.join(DIR, "index.json");
  const mtime = fs.statSync(file).mtimeMs;
  const hit = g.__crackioTemplateIndexAt;
  if (hit && hit.mtime === mtime) return hit.index;
  const index = JSON.parse(fs.readFileSync(file, "utf8")) as TemplateMeta[];
  g.__crackioTemplateIndexAt = { mtime, index };
  if (hit) models = null;
  return index;
}

export function templateGraph(name: string): ApiGraph {
  const graphs = (g.__crackioTemplateGraphs ??= new Map());
  let graph = graphs.get(name);
  if (!graph) {
    if (!/^[\w.\-]+$/.test(name)) throw new Error("Bad template name.");
    graph = JSON.parse(fs.readFileSync(path.join(DIR, "api", `${name}.json`), "utf8")) as ApiGraph;
    graphs.set(name, graph);
  }
  return graph;
}

// Derived from the code as much as the data, so these live with the module (a code change rebuilds them).
const ios = new Map<string, TemplateIO>();
let models: LocalModel[] | null = null;

/**
 * The size a template renders at, in megapixels (its own width times height), or null when it doesn't say: a video model
 * made for 480p gets slower, heavier and no sharper when asked for 720p.
 */
export function nativeMp(name: string): number | null {
  const io = templateIO(name);
  const g = templateGraph(name);
  const value = (s: { id: string; input: string } | undefined) => (s ? Number(g[s.id]?.inputs?.[s.input]) : NaN);
  const w = value(io.widths[0]);
  const h = value(io.heights[0]);
  return w > 0 && h > 0 ? (w * h) / 1e6 : null;
}

export function templateIO(name: string): TemplateIO {
  const all = ios;
  let io = all.get(name);
  if (!io) {
    io = analyze(templateGraph(name));
    all.set(name, io);
  }
  return io;
}

/** Templates that are demos of something else (a control image, a mask, a LoRA, a song), not a general tool. */
const SPECIAL = /controlnet|inpainting|outpainting|style reference|motion control|audio to video|lip sync|voice cloning|pose|depth|normal|albedo|segmentation|layer|remove background|frame interpolation|relight|3d|reference to video|style transfer|video edit|portrait/i;

/** What a template does, from its tags and what it takes; null for the ones Crackio's tools can't drive. */
export function modeOf(t: TemplateMeta, io: TemplateIO): TemplateMode | null {
  const tags = t.tags.map((x) => x.toLowerCase());
  const has = (x: string) => tags.includes(x);
  // LTX-2.3's IC-LoRA "ingredients": one composite reference sheet guides the whole clip (Cast's sheets, in one picture).
  if (/ic_lora_ingredients/i.test(t.name) && io.images.length === 1 && io.prompt.length && !io.videos.length && !t.customNodes.length) return "r2v";
  if (/\.app$|^templates[-_]|lora/i.test(t.name) || t.customNodes.length || io.audios.length) return null;
  if (has("character replacement")) return null; // SCAIL-2 runs from Crackio's own recipe
  if (has("video upscale")) return io.videos.length ? "vupscale" : null;
  if (has("image upscale")) return io.images.length === 1 && !io.prompt.length ? "upscale" : null;
  if (tags.some((x) => SPECIAL.test(x))) return null;
  if (!io.prompt.length || io.videos.length) return null;
  // The index's media type is its preview's; what the graph saves says what it makes.
  const video = Object.values(templateGraph(t.name)).some((n) => /^(SaveVideo|CreateVideo|SaveWEBM|SaveAnimatedWEBP)$/.test(n.class_type));
  if (video) {
    if (has("flf2v") && io.images.length === 2) return "flf2v";
    if (io.images.length === 1 && (has("image to video") || has("video"))) return "i2v";
    if (io.images.length === 0 && (has("text to video") || has("video"))) return "t2v";
    return null;
  }
  if (has("image edit") && io.images.length >= 1) return "edit";
  if (io.images.length === 0 && (has("text to image") || has("image"))) return "t2i";
  return null;
}

const KIND: Record<TemplateMode, "image" | "video" | "upscale"> = { t2i: "image", edit: "image", t2v: "video", i2v: "video", flf2v: "video", r2v: "video", upscale: "upscale", vupscale: "upscale", swap: "video" };
const TASKS: Record<TemplateMode, LocalTask> = { t2i: "image", edit: "edit", t2v: "video", i2v: "video", flf2v: "video", r2v: "video", upscale: "upscale", vupscale: "upscale", swap: "swap" };

type Precision = "int8" | "fp8" | "nvfp4" | "bf16" | "fp16" | "gguf" | "default";

function precisionOf(file: string): Precision {
  if (/int8/i.test(file)) return "int8";
  if (/nvfp4|fp4/i.test(file)) return "nvfp4";
  if (/fp8|e4m3/i.test(file)) return "fp8";
  if (/\.gguf$/i.test(file)) return "gguf";
  if (/bf16/i.test(file)) return "bf16";
  if (/fp16|f16/i.test(file)) return "fp16";
  return "default";
}

/**
 * Models nobody published a time for, corrected by the one each is built on: what the benchmarks of that model show next
 * to this formula (local/benchmarks, reported timings; scripts/local/reported-times.json), at this one's size. Against 36
 * timed picture versions the formula is right on the median (×0.7–1 between quartiles); clips it puts ~1.7× long, mostly
 * by not counting a template's size and frames, so these carry it.
 */
const BUILT_ON: Record<string, number> = {
  // FLUX.1 dev's weights and steps: 0.92× the formula there.
  "flux1-krea": 0.92,
  // HiDream-I1's backbone: 0.53–0.55×.
  "hidream-e1": 0.55,
  // HunyuanVideo 1.5 at 640×640, 81 frames (2.6× the formula at 720p, 121 frames; a quarter of the tokens).
  "capybara-video": 0.7,
  // Wan 2.2 14B's at 512×512 (0.76× the formula at 640×640), in fp16.
  "wan-vace-video": 0.36,
};

/** Speed next to int8_convrot on an RTX 50 (measured on Krea 2: int8 2.56 s, fp8 3.91 s, bf16 4.84 s). */
const SLOWER: Record<Precision, number> = { int8: 1, nvfp4: 1.25, fp8: 1.45, bf16: 1.9, fp16: 1.9, gguf: 2.3, default: 1.7 };
/** Bytes per parameter, to tell a model's size from its file. */
const BYTES: Record<Precision, number> = { int8: 1, nvfp4: 0.55, fp8: 1, bf16: 2, fp16: 2, gguf: 0.7, default: 2 };
const REQUIRES: Partial<Record<Precision, LocalVariant["requires"]>> = {
  int8: { backends: ["cuda"], compute: 7.5 },
  fp8: { backends: ["cuda", "rocm", "xpu"] },
  nvfp4: { backends: ["cuda"], compute: 12.0 },
};
const LABEL: Record<Precision, string> = { int8: "INT8", fp8: "FP8", nvfp4: "NVFP4", bf16: "BF16", fp16: "FP16", gguf: "GGUF", default: "Full" };

/**
 * GGUF versions Crackio adds to template models (unsloth's quants), by the version they copy: the same templates, with
 * the model file swapped for the GGUF one. They run on cards the templates' int8 files don't suit (a GTX 1060), and they
 * pool: split across two computers when one GPU can't hold them (comfyui/crackio_bridge/pool.py).
 */
const GGUF_EXTRAS: Record<string, { from: string; id: string; label: string; needGb: number; fidelity: number; file: LocalFile }[]> = {
  "qwen-image-2.1": [
    {
      from: "int8-turbo",
      id: "gguf-q8-turbo",
      label: "GGUF Q8 Turbo",
      needGb: 10,
      fidelity: 0.99,
      file: { folder: "diffusion_models", name: "qwen-image-2.1-turbo-Q8_0.gguf", url: "https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF/resolve/main/qwen-image-2.1-turbo-Q8_0.gguf", bytes: 7_640_860_480, sha256: "399d2ddc3636f36456e2f5bfa57187da4e38721bc046430317f42a9eab5b1712", role: "model" },
    },
    {
      from: "int8-turbo",
      id: "gguf-q6-turbo",
      label: "GGUF Q6 Turbo",
      needGb: 8.5,
      fidelity: 0.98,
      file: { folder: "diffusion_models", name: "qwen-image-2.1-turbo-Q6_K.gguf", url: "https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF/resolve/main/qwen-image-2.1-turbo-Q6_K.gguf", bytes: 6_271_551_296, sha256: "f4560fb47ad863ffed7e32737d3c42988c44bd0c459606777d7ffe2e895d0a70", role: "model" },
    },
  ],
};

/** A model's GGUF versions (GGUF_EXTRAS): its template version's files and jobs, the GGUF model file in place of its own. */
function ggufExtras(key: string, variants: LocalVariant[]): LocalVariant[] {
  return (GGUF_EXTRAS[key] ?? []).flatMap((x) => {
    const base = variants.find((v) => v.id === x.from);
    const own = base?.files.find((f) => f.role === "model");
    if (!base || !own) return [];
    return [
      {
        ...base,
        id: x.id,
        label: x.label,
        needGb: x.needGb,
        fidelity: x.fidelity,
        seconds5090: Math.round(((base.seconds5090 * SLOWER.gguf) / SLOWER.int8) * 10) / 10,
        // Its text encoder stays the template's int8 one, which runs on any NVIDIA card (it ran on a GTX 1060).
        requires: { backends: ["cuda"], customNodes: ["ComfyUI-GGUF"] },
        files: base.files.map((f) => (f.role === "model" ? x.file : f)),
        replaces: own.name,
        pool: true,
      },
    ];
  });
}

/** Turbo, distilled, base… from a template's name: models that come in more than one flavour. */
function flavourOf(name: string) {
  return /turbo/i.test(name) ? "turbo" : /distilled|_sd_|fast/i.test(name) ? "distilled" : /_base|base_|_full/i.test(name) ? "base" : /_dev/i.test(name) ? "dev" : "";
}

const GB = 1024 ** 3;

/** A template's description cut to a sentence or two, never mid-sentence. */
function sentences(text: string, max = 200) {
  let out = "";
  for (const part of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
    if (out && `${out} ${part}`.length > max) break;
    out = out ? `${out} ${part}` : part;
    if (out.length >= 90) break;
  }
  return out.length > max ? `${out.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "")}…` : out;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A rough RTX 5090 time per unit, from the model's size, its steps and guidance and its precision; labelled an estimate
 * on the page until a run measures it. Images: one ~1 MP picture. Clips: 5 s at the template's own size.
 */
function estimate(kind: "image" | "video" | "upscale", billions: number, io: TemplateIO, precision: Precision) {
  const steps = Math.max(1, io.steps ?? 20);
  const guided = (io.cfg ?? 1) > 1 ? 1.9 : 1;
  if (kind === "image") return round1(0.6 + 0.026 * billions * steps * guided * SLOWER[precision]);
  if (kind === "upscale") return round1(3 + 0.8 * billions * SLOWER[precision]);
  return Math.round(6 * Math.pow(billions, 0.8) * (steps / 10) * guided * SLOWER[precision]);
}

function buildTemplateModels(): LocalModel[] {
  const curated = new Set(LOCAL_MODELS.map((m) => m.id));
  type Group = { info: ReturnType<typeof familyOf>; kind: "image" | "video" | "upscale"; variants: Map<string, { v: LocalVariant; usage: number }>; tasks: Set<LocalTask>; templates: TemplateMeta[] };
  const groups = new Map<string, Group>();
  for (const t of templateIndex()) {
    const io = templateIO(t.name);
    const mode = modeOf(t, io);
    if (!mode) continue;
    const models = t.files.filter((f) => f.role === "model").sort((a, b) => b.bytes - a.bytes);
    const main = models[0];
    if (!main) continue;
    const info = familyOf(main.name, t.family);
    const kind = KIND[mode];
    // Hand-tuned recipes for these already (same family, same kind of output).
    if (curated.has(info.key) && LOCAL_MODELS.find((m) => m.id === info.key)?.tasks.some((x) => KIND[x === "image" ? "t2i" : x === "edit" ? "edit" : x === "video" ? "t2v" : x === "upscale" ? "upscale" : "swap"] === kind)) continue;
    // A family whose editor is its own checkpoint (Boogu, Mage-Flow, LongCat, klein 9B KV) is two models: installing one
    // version shouldn't leave you with only half of what the card promised.
    const editor = mode === "edit" && /edit|[-_]kv[-_]/i.test(main.name) && !/edit/i.test(info.key);
    const base = kind === "image" || info.key.endsWith(`-${kind}`) ? info.key : `${info.key}-${kind}`;
    const key = editor ? `${base}-edit` : base;
    const named = editor ? { ...info, name: `${info.name} Edit`, quality: info.quality } : info;
    const group: Group = groups.get(key) ?? { info: named, kind, variants: new Map(), tasks: new Set(), templates: [] };
    groups.set(key, group);
    group.tasks.add(TASKS[mode]);
    group.templates.push(t);
    const precision = precisionOf(main.name);
    // Reference to video is its own version: its files (another checkpoint, the IC-LoRA) don't join the family's others.
    const flavour = mode === "r2v" ? "reference" : flavourOf(t.name);
    const vid = `${precision}${flavour ? `-${flavour}` : ""}`;
    const prev = group.variants.get(vid);
    const billions = main.bytes / GB / BYTES[precision];
    const seconds = round1(estimate(kind, billions, io, precision) * (BUILT_ON[key] ?? 1));
    const working = (main.bytes / GB) * (main.folder === "checkpoints" ? 0.8 : 1);
    const needGb = round1(working + (kind === "video" ? 6 : kind === "upscale" ? 3 : 2.5));
    const v: LocalVariant = prev?.v ?? {
      id: vid,
      label: `${LABEL[precision]}${flavour ? ` ${flavour[0].toUpperCase()}${flavour.slice(1)}` : ""}`,
      files: [],
      needGb,
      fidelity: precision === "nvfp4" ? 0.95 : precision === "int8" || precision === "fp8" ? 0.99 : 1,
      seconds5090: seconds,
      ...(io.steps ? { steps: io.steps } : {}),
      requires: REQUIRES[precision],
      templates: {},
    };
    // The busiest template for each job; files are the union of what the variant's templates really load once their
    // switches are settled for Crackio (prompt enhancers off, speed LoRAs on), so an unused 9B prompt LLM isn't fetched.
    if (!v.templates![mode] || (prev?.usage ?? 0) < t.usage) v.templates![mode] = t.name;
    // An editor with a switch back to text-to-image does both.
    if (mode === "edit" && io.editSwitch && !v.templates!.t2i) {
      v.templates!.t2i = t.name;
      group.tasks.add("image");
    }
    const used = filesUsed(settle(fill(templateGraph(t.name), io, { prompt: "-", images: io.images.map(() => "x.png"), prefix: "x" })), t.files.map((f) => f.name));
    for (const f of t.files) {
      if (!used.has(f.name) || v.files.some((x) => x.folder === f.folder && x.name === f.name)) continue;
      v.files.push({ folder: f.folder, name: f.name, url: f.url, bytes: f.bytes, role: f.role, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.sizeEstimated ? { sizeEstimated: true } : {}) });
    }
    v.needGb = Math.max(v.needGb, needGb);
    v.seconds5090 = mode === "t2i" || mode === "t2v" || mode === "upscale" || mode === "vupscale" ? seconds : (v.seconds5090 ?? seconds);
    group.variants.set(vid, { v, usage: Math.max(prev?.usage ?? 0, t.usage) });
  }

  const out: LocalModel[] = [];
  for (const [key, group] of groups) {
    const ts = group.templates.sort((a, b) => b.usage - a.usage);
    const released = ts.map((t) => t.date ?? "").sort().at(-1) || undefined;
    // Best first: what runs fastest on NVIDIA leads, full precision (runs everywhere, Macs too) follows.
    const order: Precision[] = ["int8", "nvfp4", "fp8", "default", "bf16", "fp16", "gguf"];
    const sorted = [...group.variants.values()].map((x) => x.v).sort((a, b) => order.indexOf(a.id.split("-")[0] as Precision) - order.indexOf(b.id.split("-")[0] as Precision));
    const variants = [...sorted, ...ggufExtras(key, sorted)];
    const lead = ts[0];
    // One family can make pictures and clips (Capybara): the clip one says so.
    const twin = [...groups.entries()].some(([k, x]) => k !== key && x.info.key === group.info.key);
    const sound = group.kind === "video" && ts.some((t) => Object.values(templateGraph(t.name)).some((n) => /Audio.*Decode|Decode.*Audio/.test(n.class_type)));
    out.push({
      id: `tpl-${key}`,
      name: twin && group.kind !== "image" && !/video/i.test(group.info.name) ? `${group.info.name} (${group.kind})` : group.info.name,
      maker: group.info.maker,
      tasks: [...group.tasks],
      blurb: group.info.blurb ?? sentences(lead.description || lead.title),
      quality: group.info.quality ?? 60,
      qualityKnown: group.info.quality !== undefined,
      unit: group.kind === "video" ? "clip" : "image",
      ...(sound ? { audio: true } : {}),
      licence: group.info.licence,
      variants,
      crackio: `local:tpl:${key}`,
      source: "template",
      released,
      usage: ts.reduce((n, t) => n + t.usage, 0),
      thumb: lead.name,
      ...(group.info.excludes ? { excludes: group.info.excludes } : {}),
      ...(group.info.gated ? { gated: { repo: new URL(variants[0].files.find((f) => f.role === "model")?.url ?? "https://huggingface.co").pathname.split("/").slice(1, 3).join("/") } } : {}),
    });
  }
  return out;
}

/** Every template-based model (built once per server start). */
export function templateModels(): LocalModel[] {
  return (models ??= buildTemplateModels());
}

/** What the official templates say about a hand-tuned model's family: its preview, release date and how much it's used. */
function curatedMeta(id: string): Pick<LocalModel, "thumb" | "released" | "usage"> {
  const ts = templateIndex()
    .filter((t) => {
      const main = t.files.filter((f) => f.role === "model").sort((a, b) => b.bytes - a.bytes)[0];
      return main && familyOf(main.name, t.family).key === id && !/\.app$|lora/i.test(t.name);
    })
    .sort((a, b) => b.usage - a.usage);
  if (!ts.length) return {};
  return { thumb: ts[0].name, released: ts.map((t) => t.date ?? "").sort().at(-1) || undefined, usage: ts.reduce((n, t) => n + t.usage, 0) };
}

let curated: LocalModel[] | null = null;

/** Hand-tuned models first, then every template-based one. */
export function allLocalModels(): LocalModel[] {
  curated ??= LOCAL_MODELS.map((m) => ({ ...curatedMeta(m.id), ...m, source: "curated" as const, qualityKnown: true }));
  return [...curated, ...templateModels()].map(withNote);
}

/**
 * A model's quality and release from the research notes (lib/models/notes), so the Local page and the model library show
 * the same number on one scale with the cloud models. A model the research found nothing comparable for shows none.
 */
function withNote(m: LocalModel): LocalModel {
  const note = m.crackio ? noteFor(m.crackio) : undefined;
  if (!note) return m;
  // Unscored models sort below the scored ones: their old placeholder (60 on the open-only scale) would outrank most of them.
  return { ...m, quality: note.quality ?? Math.min(m.quality, 25), qualityKnown: note.quality !== undefined, released: note.released ?? m.released };
}

/* ------------------------------------------------------------------ in Crackio's model pickers */

const shapes = (ids: string[]) => ids.map(aspectChoice).filter((c): c is AspectChoice => c !== null);
const NONE = {
  negative: null,
  refs: null,
  end: null,
  video: null,
  duration: null,
  resolution: null,
  quality: null,
  aspect: null,
  size: null,
  audio: null,
  count: null,
  scale: null,
  seed: null,
  fixed: {},
  missing: [],
} satisfies Partial<Caps>;

/** What a template-based model accepts, from the jobs its templates do and the inputs they take. */
function capsOf(m: LocalModel): Caps {
  const modes = new Set(m.variants.flatMap((v) => Object.keys(v.templates ?? {})) as TemplateMode[]);
  const first = (mode: TemplateMode) => m.variants.map((v) => v.templates?.[mode]).find(Boolean);
  const fast = [...modes].some((mode) => templateIO(first(mode)!).fast.length > 0);
  const quality = fast ? { field: "quality", choices: [{ value: "fast", label: "Fast" }, { value: "best", label: "Best" }], default: "fast" } : null;
  // The Advanced section, from the graph its main job runs.
  const main = (["t2i", "t2v", "i2v", "edit", "r2v"] as TemplateMode[]).map(first).find(Boolean);
  const io = main ? templateIO(main) : null;
  const tuning = io ? tuningFor(io.steps, io.cfg, io.stepsFixed) : null;
  if (modes.has("upscale") || modes.has("vupscale")) {
    return { ...NONE, output: modes.has("vupscale") && !modes.has("upscale") ? "video" : "image", prompt: null, image: { field: "image", required: true, array: false, min: 1, max: 1 } };
  }
  if (m.unit === "clip") {
    // Up to the size the model was made for: a 480p model isn't offered 720p.
    const native = Math.max(...[...modes].map((mode) => nativeMp(first(mode)!) ?? 0.9));
    const sizes = native < 0.6 ? ["480p"] : ["480p", "720p"];
    // As long as the model goes: a template that stops at 81 frames of 16 fps makes 5 s, whatever is asked.
    const ios = [...modes].map((mode) => templateIO(first(mode)!));
    const capped = ios.map((io) => (io.maxFrames && io.fps ? Math.floor((io.maxFrames - 1) / io.fps) : 10));
    const longest = Math.max(1, Math.min(10, ...capped));
    return {
      ...NONE,
      output: "video",
      prompt: { field: "prompt", required: true },
      image: modes.has("i2v") || modes.has("flf2v") ? { field: "start_image", required: !modes.has("t2v"), array: false, min: 0, max: 1 } : null,
      end: modes.has("flf2v") ? { field: "end_image", required: false, array: false, min: 0, max: 1 } : null,
      // One composite reference sheet (Cast puts everyone's sheet in one picture).
      refs: modes.has("r2v") ? { field: "reference", required: false, array: false, min: 0, max: 1 } : null,
      duration: { field: "duration", mode: "range", min: 1, max: longest, integer: true, encode: "number", auto: false, default: Math.min(5, longest) },
      resolution: { field: "resolution", choices: sizes.map((v) => ({ value: v, label: v })), default: sizes.at(-1)! },
      aspect: modes.has("t2v") || modes.has("r2v") ? { field: "aspect", choices: shapes(["16:9", "9:16", "1:1", "4:3", "3:4"]), default: "16:9" } : null,
      quality,
      tuning,
    };
  }
  const edit = first("edit");
  return {
    ...NONE,
    output: "image",
    prompt: { field: "prompt", required: true },
    // An encoder that grows takes more pictures than its template wires (comfy-local-templates `growImages`).
    image: edit
      ? { field: "images", required: !modes.has("t2i"), array: true, min: modes.has("t2i") ? 0 : 1, max: Math.max(1, templateIO(edit).images.length, growsImages(templateGraph(edit)) ? grownRoom(templateGraph(edit)) : 0) }
      : null,
    count: { field: "n", min: 1, max: 4 },
    resolution: { field: "resolution", choices: IMAGE_RESOLUTIONS, default: DEFAULT_RESOLUTION },
    quality,
    tuning,
  };
}

export type TemplateDef = { def: ModelDef; caps: Caps; model: LocalModel };

/** Every template-based model as a model definition (`local:tpl:…`), for the pickers once it's installed. */
export function templateDefs(): TemplateDef[] {
  return templateModels().map((m) => {
    const caps = capsOf(m);
    const kind = m.tasks.includes("upscale") ? "upscale" : m.unit === "clip" ? "video" : "image";
    const def: ModelDef = {
      id: m.crackio!,
      kind,
      providers: ["comfy-local"],
      model: m.crackio!.replace(/^local:/, ""),
      name: `${m.name} (your GPU)`,
      vendor: m.maker || "Open model",
      maxRefs: caps.image?.max ?? 0,
      speed: (m.variants[0]?.seconds5090 ?? 30) < (m.unit === "clip" ? 60 : 4) ? "fast" : (m.variants[0]?.seconds5090 ?? 30) < (m.unit === "clip" ? 180 : 12) ? "medium" : "slow",
      bestFor: m.blurb,
      family: "comfy-local",
      runnable: true,
    };
    return { def, caps, model: m };
  });
}
