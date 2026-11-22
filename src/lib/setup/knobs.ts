import { builtinCaps } from "@/lib/models/builtin-caps";
import { DEFAULT_RESOLUTION, IMAGE_RESOLUTIONS } from "@/lib/local/resolution";
import type { LocalModel } from "@/lib/local/types";
import type { Caps } from "@/lib/models/caps";
import type { ApiQuote } from "./api-prices";

/**
 * The settings Settings' estimate offers for a model's usual job, in the model's own terms: a clip's length and size, a
 * picture's size and how many, an upscale's picture and factor. Client-safe; the server reads the same caps the tools do
 * (models/builtin-caps), so an estimate is only ever offered for a job the tool can really run.
 */

export type JobKind = "image" | "video" | "upscale" | "swap" | "voice";

export type Knobs = {
  kind: JobKind;
  /** A clip's length in seconds (clips, swaps, clip upscales). */
  seconds?: { min: number; max: number; default: number };
  /** Sizes to make it at, smallest first, and the one the tool starts on. */
  resolutions?: { value: string; label: string }[];
  resolution?: string;
  /** Pictures in one go. */
  count?: { min: number; max: number };
  /** A picture upscale: the picture going in, and how much bigger it comes out. */
  sources?: UpscaleSource[];
  scales?: number[];
  /** Upscales clips, frame by frame, rather than pictures. */
  clip?: boolean;
  /** The tool edits a picture you give it (Retouch, Relight, Cast…): the model reads it beside the one it makes. */
  edit?: boolean;
};

export type UpscaleSource = { value: string; label: string; width: number; height: number };

/** Pictures an upscale estimate can start from: a phone-sized picture, Full HD, and a 2K screen. */
export const UPSCALE_SOURCES: UpscaleSource[] = [
  { value: "1mp", label: "1 MP", width: 1024, height: 1024 },
  { value: "fhd", label: "Full HD", width: 1920, height: 1080 },
  { value: "2k", label: "2K", width: 2560, height: 1440 },
];

/**
 * Estimates show a little more time than the math says (and the cost of it): a rented GPU can be a little slower than the
 * one benchmarked, and a promise kept beats one missed. 7%: the middle of a 5–10% margin.
 */
export const SAFETY = 1.07;

/** A voice job: seconds of speech (a line is 3–10 s, a scene a minute or more). */
export const VOICE_KNOBS: Knobs = { kind: "voice", seconds: { min: 5, max: 180, default: 30 } };

/**
 * `task`: what the tool's part uses it for ("edit" for the picture editors), when not the model's main job. `known`:
 * what the model takes when the caller has read it (a template model's caps come from its templates, on the server);
 * the hand-tuned models' are built in.
 */
export function knobsFor(model: Pick<LocalModel, "crackio" | "id" | "tasks" | "unit">, task?: string, known?: Caps | null): Knobs {
  const id = model.crackio ?? `local:${model.id}`;
  if (model.tasks.includes("swap")) {
    const caps = builtinCaps({ id, kind: "video", family: "comfy-local", maxRefs: 0 });
    const res = caps?.resolution?.choices ?? [{ value: "720p", label: "720p" }];
    return {
      kind: "swap",
      seconds: { min: 1, max: caps?.video?.limits?.maxDuration ?? 20, default: 5 },
      resolutions: res.map((c) => ({ value: String(c.value), label: c.label })),
      resolution: String(caps?.resolution?.default ?? res.at(-1)?.value ?? "720p"),
    };
  }
  if (model.tasks.includes("upscale")) {
    if (model.unit === "clip") return { kind: "upscale", clip: true, seconds: { min: 1, max: 20, default: 5 } };
    return { kind: "upscale", sources: UPSCALE_SOURCES, scales: [2, 4] };
  }
  if (model.unit === "clip") {
    const caps = known ?? builtinCaps({ id, kind: "video", family: "comfy-local", maxRefs: 0 });
    const d = caps?.duration;
    const res = caps?.resolution?.choices ?? [{ value: "720p", label: "720p" }];
    return {
      kind: "video",
      seconds: d && d.mode === "range" ? { min: d.min ?? 1, max: d.max ?? 10, default: typeof d.default === "number" ? d.default : 5 } : { min: 1, max: 10, default: 5 },
      resolutions: res.map((c) => ({ value: String(c.value), label: c.label })),
      resolution: String(caps?.resolution?.default ?? res[0]?.value ?? "720p"),
    };
  }
  return {
    kind: "image",
    resolutions: IMAGE_RESOLUTIONS.map((r) => ({ value: r.value, label: r.label })),
    resolution: DEFAULT_RESOLUTION,
    count: { min: 1, max: 4 },
    ...(task === "edit" && model.tasks.includes("edit") ? { edit: true } : {}),
  };
}

/** One job to estimate: the knobs' values. */
export type JobSpec = {
  kind: JobKind;
  seconds?: number;
  resolution?: string;
  count?: number;
  scale?: number;
  source?: { width: number; height: number };
  clip?: boolean;
  /** Pictures it reads (an edit's photo). */
  references?: number;
};

/** The job a model's knobs start on. */
export function defaultJob(k: Knobs): JobSpec {
  return {
    kind: k.kind,
    ...(k.seconds ? { seconds: k.seconds.default } : {}),
    ...(k.resolution ? { resolution: k.resolution } : {}),
    ...(k.count ? { count: 1 } : {}),
    ...(k.scales ? { scale: 2 } : {}),
    ...(k.sources ? { source: { width: k.sources[0].width, height: k.sources[0].height } } : {}),
    ...(k.clip ? { clip: true } : {}),
    ...(k.edit ? { references: 1 } : {}),
  };
}

/** The job in words: "a 5 s clip at 720p", "2 pictures at 2K", "a Full HD picture made 4×". */
export function jobWords(j: JobSpec, k?: Knobs) {
  const res = j.resolution ? (k?.resolutions?.find((r) => r.value === j.resolution)?.label ?? j.resolution) : null;
  if (j.kind === "video") return `a ${j.seconds ?? 5} s clip${res ? ` at ${res}` : ""}`;
  if (j.kind === "swap") return `a ${j.seconds ?? 5} s swap${res ? ` at ${res}` : ""}`;
  if (j.kind === "voice") return `${j.seconds ?? 30} s of speech`;
  if (j.kind === "upscale") {
    if (j.clip) return `${j.seconds ?? 5} s of clip upscaled`;
    const src = k?.sources?.find((s) => s.width === j.source?.width && s.height === j.source?.height)?.label;
    return `a ${src ? `${src} ` : ""}picture made ${j.scale ?? 2}×`;
  }
  const n = j.count ?? 1;
  if (j.references) return `${n === 1 ? "an edit" : `${n} edits`} of a photo${res ? ` at ${res}` : ""}`;
  return `${n === 1 ? "a picture" : `${n} pictures`}${res ? ` at ${res}` : ""}`;
}

/** One estimate from /api/setup/estimate: the job's time on a machine with one version, its cost there, and the API's. */
export type SetupEstimate = {
  /** A run with the model loaded, as the math says, and as shown (SAFETY more). */
  seconds: number;
  shown: number;
  low: number;
  high: number;
  /** What the first run adds while the model loads. */
  load: number;
  /** Where the time comes from: "40 runs here", "benchmarked on an RTX 4090". */
  basis: string;
  measured: boolean;
  gpu: string;
  /** Rented or paid per job: dollars an hour, its cloud, and the job's cost at the time shown (and with loading). */
  price: { perHour: number; from: string; job: number; firstJob: number } | null;
  api: ApiQuote | null;
};
