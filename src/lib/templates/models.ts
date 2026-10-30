import type { Caps } from "@/lib/models/caps";
import type { SlotKind, Template } from "./types";

/**
 * Which models each kind of template runs best on, and how each model wants to be spoken to.
 * Until you pick one, a swap runs on the swap on your own ComfyUI when it can, else the first model in its list that
 * can run here (.research/templates-swap-pricing.md, Oct 2026): Kling 3.0 Omni's clip editor at 720p on Comfy Router,
 * $0.126 a second for up to 10 s, so at most $1.26 a template; then Genjutsu (whole clips, top quality).
 * The model picker lists these first; its Custom tab still lists every model that fits.
 */

const GENJUTSU = "comfy:higgsfield/higgsfield-genjutsu-motion-transfer-v1.0";
const KLING_OMNI = "comfy:kling/kling-v3-omni";

/** Swap models by what the template swaps (the first slot's kind; two people use the person list). */
const SWAP: Record<SlotKind, string[]> = {
  person: [KLING_OMNI, GENJUTSU],
  face: [KLING_OMNI, GENJUTSU],
  pet: [KLING_OMNI, GENJUTSU],
  object: [KLING_OMNI, GENJUTSU],
  place: [KLING_OMNI, GENJUTSU],
};

/** Why a model is on a template's list, shown beside it in the picker. */
export const SWAP_TAGS: Record<string, string> = {
  [KLING_OMNI]: "Best value",
  [GENJUTSU]: "Top quality",
};

export function swapModels(t: Template): string[] {
  return SWAP[t.slots[0]?.kind ?? "person"];
}

/** Image-to-video models that keep a face from the first frame (effects): the open ones on your own GPU first. */
export const EFFECT_MODELS = ["local:ltx-2.5", "local:wan2.2-5b", "comfy:kling/kling-v3-omni"];

/**
 * How a model names its inputs in the prompt.
 * - kling: `<<<video_1>>>`, `<<<image_1>>>` (Kling on Comfy Router, and Genjutsu)
 * - at: `@Video1`, `@Image1` (fal's Kling, Seedance and HappyHorse)
 * - positional: `Video 1`, `Image 1` (Wan 3.0, Seedance and MiniMax on Router)
 * - plain: "the input video", "reference image 1"
 * - ordinal: no tags; "the first reference photo" (MiniMax H3 Recast maps photos left to right)
 * - words: no pictures at all (Grok's clip editor): every photo is described
 * - none: the model ignores the prompt (Wan Animate, PixVerse Swap)
 * - scene: no tags; the finished clip described, place by place (SCAIL-2 on your own ComfyUI)
 */
export type RefSyntax = "kling" | "at" | "positional" | "plain" | "ordinal" | "words" | "none" | "scene";

export type ModelProfile = {
  syntax: RefSyntax;
  /** The model follows "state what should appear" better than "no …" (MiniMax). */
  positive?: boolean;
  /** Longest prompt worth sending. */
  maxChars?: number;
  /** Shortest clip it takes; shorter clips are padded with their last frame, and the result is cut back. */
  minSeconds?: number;
  /** Longest clip it really takes, when that's less than its published limit. */
  maxSeconds?: number;
  /** Request fields that help templates (checked against each model's published schema). */
  extra?: Record<string, unknown>;
  /** Per slot kind, when the model needs to be told what it's swapping. */
  extraFor?: Partial<Record<SlotKind, Record<string, unknown>>>;
  /** Template resolution, when the default costs much more than it helps. */
  resolution?: string;
  /** Frame rate the clip is sent at, for models that bill by the frame. */
  fps?: number;
};

const PROFILES: [RegExp, ModelProfile][] = [
  // Longer clips are cut to their first 30 s.
  [/^comfy:higgsfield\/higgsfield-genjutsu/, { syntax: "kling", minSeconds: 4, maxSeconds: 30, resolution: "480p" }],
  // Standard (720p) costs three quarters of Pro (1080p).
  [/^comfy:kling\//, { syntax: "kling", maxChars: 2500, minSeconds: 3, resolution: "std" }],
  [/^comfy:(wan|byteplus|minimax)\//, { syntax: "positional", maxChars: 800 }],
  [/^comfy:runway\//, { syntax: "plain", maxChars: 1000 }],
  // SCAIL-2 on your own ComfyUI: Wan's own 16 fps (fewer 81-frame segments), its prompt describes the result, 704p (its authors' size).
  [/^local:scail-2/, { syntax: "scene", maxChars: 1500, maxSeconds: 15, fps: 16, resolution: "704p" }],
  // LTX-2.5 + Ripple on your own ComfyUI: LTX's own 24 fps, 5 s a pass (each continuing from the last), its prompt describes the result.
  [/^local:ltx-2\.5-ripple/, { syntax: "scene", maxChars: 1500, maxSeconds: 15, fps: 24, resolution: "720p" }],
];

/** How to speak to a model: its own reference syntax when known, else plain words for picture models. */
export function profileOf(id: string, takesPictures: boolean): ModelProfile {
  const hit = PROFILES.find(([re]) => re.test(id))?.[1];
  if (hit) return hit;
  return { syntax: takesPictures ? "plain" : "words" };
}

/** The longest clip a model edits, in seconds: what it really takes, else its published limit; null when none is listed. */
export function clipLimit(id: string, caps: Caps | null | undefined): number | null {
  const real = PROFILES.find(([re]) => re.test(id))?.[1].maxSeconds;
  const listed = caps?.video?.limits?.maxDuration;
  return real && listed ? Math.min(real, listed) : (real ?? listed ?? null);
}

const secs = (s: number) => (Number.isInteger(s) ? `${s}` : s.toFixed(1));

/** For the model picker: how much of a clip `length` seconds long a model that takes up to `limit` seconds edits. */
export function clipFit(limit: number | null, length: number | null): { text: string; whole: boolean | null } {
  if (!length) return { text: limit === null ? "No length limit listed" : `Up to ${secs(limit)} s`, whole: null };
  const clip = secs(Math.round(length * 10) / 10);
  if (limit === null) return { text: `Whole ${clip} s clip · no limit listed`, whole: true };
  if (limit + 0.05 >= length) return { text: `Whole ${clip} s clip · up to ${secs(limit)} s`, whole: true };
  return { text: `Up to ${secs(limit)} s: ${secs(limit)} of this ${clip} s clip`, whole: false };
}
