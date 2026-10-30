import { durationTicks, type Caps } from "@/lib/models/caps";
import type { FilmSpec } from "./film";

/**
 * What a Video take asks of a model, and whether a model can do it, in plain words: the picks stay
 * yours, and Crackio says which models make them (and what a model you keep will do instead).
 * Model quirks come from the providers' docs and Crackio's research (.research/product-video-ugc.md).
 */
export type FilmAsk = Pick<FilmSpec, "style" | "words" | "story" | "loop" | "seconds" | "language"> & { cast: boolean; voice: boolean; pictures: number };

export type FilmFit = {
  /** Every pick works on this model. */
  ok: boolean;
  /** What won't, each as a short plain sentence. */
  missing: string[];
  /** Notes that aren't problems ("made in 2 parts", "renders at 720p"). */
  notes: string[];
};

/** Models with preset voices (none of the ones Crackio runs today). */
const VOICES = new Set<string>();
/** Kling 3 speaks these; other languages come out in English. */
const KLING_LANGS = new Set(["en-US", "en-GB", "es", "es-MX", "ja", "ko"]);
/** Seedance 2.5's speech languages leave out German, French and Polish. */
const SEEDANCE_SKIPS = new Set(["de", "fr", "pl"]);

/**
 * Whether a model makes sound. A model's settings only show a sound switch when sound can be turned
 * off, so models that always make it (MiniMax H3 and HeyGen Video on it, Veo, Seedance, Wan 3…) show
 * none: they're known by family here. Anything else unknown is "unknown", never assumed silent.
 */
const SPEAKS = /minimax|hailuo|heygen|veo|seedance|kling|wan-?3|wan2\.[5-9]|ltx|grok|sora|happyhorse/i;
const SILENT = /wan-?2\.[0-2]|wan2\.[0-2]|hunyuan|luma|ray-?\d|pika|cogvideo|mochi|stable-video|scail/i;

export function soundOf(id: string | null, caps: Caps | null): "yes" | "no" | "unknown" {
  if (caps?.audio) return "yes";
  const m = (id ?? "").toLowerCase();
  if (SILENT.test(m)) return "no";
  if (SPEAKS.test(m)) return "yes";
  return "unknown";
}

export function filmFit(id: string | null, caps: Caps | null, ask: FilmAsk): FilmFit {
  const missing: string[] = [];
  const notes: string[] = [];
  if (!caps) return { ok: true, missing, notes };
  const m = (id ?? "").toLowerCase();
  const people = ask.style === "creator" || ask.style === "lifestyle";
  const talks = ask.style === "creator" && ask.words !== "none";
  if (!caps.image && !caps.keyframes) missing.push("Can't start from your picture");
  const sound = soundOf(id, caps);
  if (talks && sound === "no") missing.push("Silent: nobody can talk");
  else if (talks && sound === "unknown") notes.push("Its settings don't say it makes sound: it may come out silent");
  else if (sound === "no") notes.push("Silent clip");
  if (people && m.includes("seedance")) missing.push("Refuses realistic people: use it for product shots");
  if (talks && m.includes("kling") && !KLING_LANGS.has(ask.language)) missing.push("Kling speaks English, Spanish, Japanese, Korean and Chinese only");
  if (talks && m.includes("seedance") && SEEDANCE_SKIPS.has(ask.language)) missing.push("Seedance doesn't speak this language");
  // Grok through Comfy Router takes a start picture or references, not both, and no end frame or voices.
  const routerGrok = m.startsWith("comfy:") && m.includes("grok");
  if (ask.cast) {
    if (!caps.refs || routerGrok) missing.push("Can't take a Cast person with your picture: they'd come out as a lookalike");
    else notes.push("Your Cast person goes in as a reference");
  }
  if (ask.voice) {
    if (!id || !VOICES.has(id)) missing.push("No preset voices: the model picks one");
    else notes.push("Preset voice: renders at 720p");
  }
  if (ask.loop && ask.style === "living" && (!caps.end || routerGrok)) missing.push("Can't land on an end frame, so it won't loop exactly");
  const max = caps.duration ? durationTicks(caps.duration).max : null;
  if (max && ask.style !== "campaign" && ask.seconds > max) notes.push(`Filmed as ${Math.ceil(ask.seconds / max)} parts of up to ${max} s, joined`);
  if (max && ask.style === "campaign" && ask.seconds / Math.max(1, ask.pictures) > max) notes.push(`Each shot up to ${max} s`);
  return { ok: missing.length === 0, missing, notes };
}
