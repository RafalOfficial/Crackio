/**
 * What a model accepts: which pictures and clips it takes, the lengths, resolutions and shapes it
 * allows, and whether it makes sound. Read from the schema a provider publishes for each model
 * (fal, Comfy Router) or written down for Crackio's built-in models. Tools build their controls
 * from it and engines build the request from it, so Crackio never sends a value the model refuses.
 */

import type { Tuning } from "@/lib/local/resolution";

export type CapChoice = { value: string | number; label: string; /** Pixel height, when the value doesn't say it ("pro" → 1080). */ height?: number };

/** One shape a model can make. `ratio` is width / height, or null for "follow the input". */
export type AspectChoice = { value: string; label: string; ratio: number | null };

/** What a model accepts in a picture or clip input (from fal's `x-fal` limits). */
export type MediaLimits = {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Width / height. */
  minRatio?: number;
  maxRatio?: number;
  maxBytes?: number;
  /** Seconds, for clips. */
  minDuration?: number;
  maxDuration?: number;
  minFps?: number;
  maxFps?: number;
  /** Edges must be multiples of this. */
  multipleOf?: number;
  maxArea?: number;
};

export type MediaInput = {
  field: string;
  required: boolean;
  /** Sent as a list of URLs rather than one. */
  array: boolean;
  min: number;
  max: number;
  limits?: MediaLimits;
  /** The model fetches pictures from a link only (no inline data). */
  urlOnly?: boolean;
};

/**
 * How long a clip can be. `list`: only these lengths. `range`: any length between min and max.
 * `frames`: the model counts frames, not seconds (open models like LTX and Wan).
 */
export type DurationCap =
  | {
      field: string;
      mode: "list";
      seconds: number[];
      /** How lengths are written: "5", 5, or "5s". */
      encode: "string" | "number" | "suffix";
      /** The value that lets the model pick the length itself, when it has one ("auto"). */
      auto: string | null;
      default: number | "auto" | null;
    }
  | {
      field: string;
      mode: "range";
      min: number;
      max: number;
      integer: boolean;
      encode: "string" | "number";
      /** The model can pick the length itself. */
      auto: boolean;
      /** What "pick it yourself" is sent as (null, or -1 for Seedance and Wan). */
      autoValue?: number | string | null;
      default: number | "auto" | null;
    }
  | {
      field: string;
      mode: "frames";
      min: number;
      max: number;
      fps: number;
      /** Frame counts these models take: 8n+1 (LTX), 4n+1 (Wan, Hunyuan) or any. */
      snap: 1 | 4 | 8;
      default: number | null;
    };

export type Caps = {
  output: "image" | "video";
  prompt: { field: string; required: boolean; maxLength?: number } | null;
  negative: string | null;
  /** The main picture: what an edit changes, or a clip's first frame. */
  image: MediaInput | null;
  /** More pictures the model takes beside the main one (people, products, styles). */
  refs: MediaInput | null;
  /** A clip's last frame. */
  end: MediaInput | null;
  /** A clip to edit or restyle. */
  video: MediaInput | null;
  /** A black-and-white picture of where to paint (white changes), for inpainting models. */
  mask?: MediaInput | null;
  /**
   * Pictures pinned at moments of the clip (FLUX 3's keyframes): a list of objects, each with a
   * picture (`image`) and where it goes (`at`: a frame number at `fps`, or seconds).
   */
  keyframes?: { field: string; image: string; at: string; unit: "frame" | "second"; fps: number; min: number; max: number; required: boolean } | null;
  duration: DurationCap | null;
  /** Output resolution ("720p", "1080p", "2K"). */
  resolution: { field: string; choices: CapChoice[]; default: string | number | null } | null;
  /** Image quality setting ("low", "medium", "high"), for models that have one. */
  quality: { field: string; choices: CapChoice[]; default: string | number | null } | null;
  aspect: { field: string; choices: AspectChoice[]; default: string | null } | null;
  /**
   * fal's `image_size` / `video_size`: named presets, or any width and height when `custom` is
   * true. Presets map to shapes; "auto" ones follow the input.
   */
  size: { field: string; presets: AspectChoice[]; custom: boolean; default: string | null } | null;
  /** Sound on or off; `values` when the model spells it as words ("on" / "off"). */
  audio: { field: string; default: boolean; values?: [string, string] } | null;
  count: { field: string; min: number; max: number } | null;
  /** Upscale factor. */
  scale: { field: string; choices: number[] | null; min: number; max: number; default: number | null; encode: "string" | "number" } | null;
  seed: string | null;
  /** Open models on your own ComfyUI: their Advanced section (steps, guidance, negative prompt, seed). */
  tuning?: Tuning | null;
  /** Required fields Crackio fills with their default. */
  fixed: Record<string, unknown>;
  /** Required inputs Crackio can't send (masks, audio, poses…): the model can't run from Crackio yet. */
  missing: string[];
};

/** What a tool needs from a model. */
export type ModelTask = "image" | "edit" | "retouch" | "video" | "video-edit" | "video-swap" | "animate" | "upscale" | "reframe";

export const TASK_LABEL: Record<ModelTask, string> = {
  image: "image",
  edit: "image edit",
  retouch: "image edit",
  video: "video",
  "video-edit": "video edit",
  "video-swap": "swap",
  animate: "image-to-video",
  upscale: "upscale",
  reframe: "reframe",
};

/* ------------------------------------------------------------------ shapes */

/** "16:9" → 1.777…, "2.35:1" → 2.35, "1024x768" → 1.333…; null for anything else. */
export function parseRatio(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(value);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** Shapes of fal's named sizes. "auto" sizes follow the input picture. */
const PRESETS: Record<string, { label: string; ratio: number | null }> = {
  square_hd: { label: "1:1", ratio: 1 },
  square: { label: "1:1", ratio: 1 },
  square_uhd: { label: "1:1", ratio: 1 },
  portrait_4_3: { label: "3:4", ratio: 3 / 4 },
  portrait_16_9: { label: "9:16", ratio: 9 / 16 },
  portrait_3_2: { label: "2:3", ratio: 2 / 3 },
  portrait_hd: { label: "9:16", ratio: 9 / 16 },
  landscape_4_3: { label: "4:3", ratio: 4 / 3 },
  landscape_16_9: { label: "16:9", ratio: 16 / 9 },
  landscape_3_2: { label: "3:2", ratio: 3 / 2 },
  landscape_hd: { label: "16:9", ratio: 16 / 9 },
};

const AUTO_WORDS = /^(auto|adaptive|match_input(_image)?|original|keep|default|none)(_\w+)?$/i;

/** One allowed aspect value as a choice, or null when it isn't a shape at all. */
export function aspectChoice(value: string): AspectChoice | null {
  if (AUTO_WORDS.test(value)) return { value, label: value.toLowerCase().startsWith("auto_") ? `Auto ${value.slice(5)}` : "Auto", ratio: null };
  const preset = PRESETS[value];
  if (preset) return { value, ...preset };
  const ratio = parseRatio(value);
  if (ratio === null) return null;
  return { value, label: value.replace(/\s+/g, "").replace(/x/i, "×"), ratio };
}

/** The closest shape to `ratio` (log scale), preferring real shapes over "auto". */
export function nearestAspect<T extends { ratio: number | null }>(choices: T[], ratio: number): T | null {
  let best: T | null = null;
  let off = Infinity;
  for (const c of choices) {
    if (c.ratio === null) continue;
    const d = Math.abs(Math.log(c.ratio / ratio));
    if (d < off) {
      off = d;
      best = c;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ durations */

/** Whole seconds a model can make, for the length ruler, plus whether it can pick its own length. */
export function durationTicks(d: DurationCap): { seconds: number[]; auto: boolean; min: number; max: number; preferred: number | "auto" | null } {
  if (d.mode === "list") {
    const seconds = [...new Set(d.seconds.filter((s) => s > 0).map((s) => Math.round(s)))].sort((a, b) => a - b);
    return { seconds, auto: d.auto !== null, min: seconds[0] ?? 1, max: seconds.at(-1) ?? 1, preferred: d.default };
  }
  if (d.mode === "range") {
    const lo = Math.max(1, Math.ceil(d.min - 1e-6));
    const hi = Math.max(lo, Math.floor(d.max + 1e-6));
    const seconds = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    return { seconds, auto: d.auto, min: lo, max: hi, preferred: d.default };
  }
  const lo = Math.max(1, Math.ceil(d.min / d.fps - 1e-6));
  const hi = Math.max(lo, Math.floor(d.max / d.fps + 1e-6));
  const seconds = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return { seconds, auto: false, min: lo, max: hi, preferred: d.default ? Math.round(d.default / d.fps) : null };
}

const nearestOf = (list: number[], x: number) => list.reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b), list[0]);

/** The length the model will make for `wanted` seconds ("auto" when it picks), snapped to what it allows. */
export function fitDuration(d: DurationCap, wanted: number | "auto" | undefined): number | "auto" {
  const t = durationTicks(d);
  if (wanted === "auto") return t.auto ? "auto" : (typeof t.preferred === "number" ? t.preferred : t.seconds[Math.floor(t.seconds.length / 2)]);
  if (wanted === undefined || !Number.isFinite(wanted)) {
    if (t.preferred === "auto" && t.auto) return "auto";
    if (typeof t.preferred === "number") return nearestOf(t.seconds, t.preferred);
    return t.seconds.includes(5) ? 5 : t.seconds[0];
  }
  return nearestOf(t.seconds, wanted);
}

/** The request fields for a length, in the model's own spelling. */
export function encodeDuration(d: DurationCap, seconds: number | "auto"): Record<string, unknown> {
  if (d.mode === "list") {
    if (seconds === "auto" && d.auto !== null) return { [d.field]: d.auto };
    const s = nearestOf(d.seconds, seconds === "auto" ? (typeof d.default === "number" ? d.default : d.seconds[0]) : seconds);
    return { [d.field]: d.encode === "number" ? s : d.encode === "suffix" ? `${s}s` : String(s) };
  }
  if (d.mode === "range") {
    if (seconds === "auto") return d.auto ? { [d.field]: d.autoValue ?? null } : {};
    const s = Math.min(d.max, Math.max(d.min, d.integer ? Math.round(seconds) : seconds));
    return { [d.field]: d.encode === "string" ? String(s) : s };
  }
  const s = seconds === "auto" ? (d.default ?? d.min) / d.fps : seconds;
  let frames = Math.round(s * d.fps);
  if (d.snap > 1) frames = Math.round((frames - 1) / d.snap) * d.snap + 1;
  while (frames > d.max) frames -= d.snap;
  while (frames < d.min) frames += d.snap;
  return { [d.field]: frames };
}

/* ------------------------------------------------------------------ resolutions */

/** "1080p" → 1080, "768P" → 768, "2K" → 1440, "4k" → 2160, "1MP" → 1000; null when unknown. */
export function resolutionHeight(value: string | number): number | null {
  if (typeof value === "number") return value;
  const v = value.trim().toLowerCase();
  let m = /^(\d{3,4})p$/.exec(v);
  if (m) return Number(m[1]);
  m = /^(\d+(?:\.\d+)?)k$/.exec(v);
  if (m) return { "0.5": 540, "1": 1080, "1.5": 1440, "2": 1440, "3": 1620, "4": 2160 }[m[1]] ?? Number(m[1]) * 1000;
  m = /^(\d+)x(\d+)$/.exec(v);
  if (m) return Math.min(Number(m[1]), Number(m[2]));
  m = /^(\d+)\s*mp$/.exec(v);
  if (m) return Math.round(Math.sqrt(Number(m[1]) * 1e6));
  m = /^(\d+)(sq)?$/.exec(v);
  if (m) return Number(m[1]);
  return null;
}

/** A readable label for a resolution value: "768P" → "768p", "2k" → "2K". */
export function resolutionLabel(value: string | number) {
  const v = String(value);
  if (/^\d{3,4}p$/i.test(v)) return v.toLowerCase();
  if (/^\d+(\.\d+)?k$/i.test(v)) return v.toUpperCase();
  return v;
}

/** The allowed resolution closest to `wanted` (by height; the lower one on a tie), e.g. 720p → 768P. */
export function fitResolution(choices: CapChoice[], wanted: string | number | undefined, fallback: string | number | null): string | number | null {
  if (!choices.length) return null;
  const exact = choices.find((c) => String(c.value).toLowerCase() === String(wanted ?? "").toLowerCase());
  if (exact) return exact.value;
  const target = wanted === undefined ? null : resolutionHeight(wanted);
  const valid = (v: string | number | null) => v !== null && choices.some((c) => c.value === v);
  if (target === null) return valid(fallback) ? fallback : choices[0].value;
  const known = choices.map((c) => ({ c, h: c.height ?? resolutionHeight(c.value) })).filter((x): x is { c: CapChoice; h: number } => x.h !== null && x.h !== undefined);
  if (!known.length) return valid(fallback) ? fallback : choices[0].value;
  const off = (h: number) => Math.abs(Math.log(h / target));
  return known.reduce((b, x) => (off(x.h) < off(b.h) - 1e-9 || (Math.abs(off(x.h) - off(b.h)) < 1e-9 && x.h < b.h) ? x : b)).c.value;
}

/* ------------------------------------------------------------------ summaries */

/** "3–15 s", "5 or 10 s", "up to 20 s". */
export function durationSummary(d: DurationCap | null) {
  if (!d) return null;
  const t = durationTicks(d);
  if (!t.seconds.length) return null;
  if (d.mode === "list" && t.seconds.length <= 3) return `${t.seconds.join(t.seconds.length === 2 ? " or " : ", ")} s`;
  return t.min === t.max ? `${t.min} s` : `${t.min}–${t.max} s`;
}

/** What a model does, in a few words: "Text → video", "Image → video", "Edit", "Video edit"… */
export function capsBadges(caps: Caps): string[] {
  const out: string[] = [];
  if (caps.output === "video") {
    if (caps.video) out.push("Video edit");
    else if (caps.keyframes) out.push(`Up to ${caps.keyframes.max} keyframes`);
    else if (caps.image?.required) out.push("Image → video");
    else if (caps.image) out.push("Text or image → video");
    else if (caps.refs) out.push("References → video");
    else out.push("Text → video");
    if (caps.end) out.push("Start + end frame");
    if (caps.audio) out.push("Sound");
  } else {
    if (caps.image?.required || (caps.refs?.required && !caps.image)) out.push("Edit");
    else if (caps.image || caps.refs) out.push("Text or image → image");
    else out.push("Text → image");
    const max = (caps.image?.max ?? 0) + (caps.refs?.max ?? 0);
    if (max > 1) out.push(`Up to ${max} images`);
  }
  return out;
}

/** How many pictures a model takes in all. */
export const imageSlots = (caps: Caps) => (caps.image?.max ?? 0) + (caps.refs?.max ?? 0);

/** Whether a model can do what a tool needs. */
export function capsFit(caps: Caps, task: ModelTask): boolean {
  if (caps.missing.length) return false;
  switch (task) {
    case "image":
      return caps.output === "image" && Boolean(caps.prompt);
    case "edit":
      // A model that needs a mask paints only where it's told: Retouch gives it one, other tools can't.
      return caps.output === "image" && Boolean(caps.prompt) && imageSlots(caps) > 0 && !caps.video && !caps.mask?.required;
    case "retouch":
      return caps.output === "image" && Boolean(caps.prompt) && imageSlots(caps) > 0 && !caps.video;
    case "video":
      return caps.output === "video" && !caps.video?.required && Boolean(caps.prompt);
    case "video-edit":
      return caps.output === "video" && Boolean(caps.video) && Boolean(caps.prompt);
    case "video-swap":
      // Templates: a clip plus pictures of who or what goes into it (the prompt can be optional).
      return caps.output === "video" && Boolean(caps.video) && imageSlots(caps) > 0;
    case "animate":
      // Effect templates: your photo is the first frame.
      return caps.output === "video" && !caps.video?.required && Boolean(caps.prompt) && Boolean(caps.image || caps.keyframes);
    case "upscale":
    case "reframe":
      return caps.output === "image" && imageSlots(caps) > 0 && !caps.video;
  }
}
