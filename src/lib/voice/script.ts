import type { VoiceModelId } from "./models";

/**
 * A Voice script is written the way Fish Audio Drama 3 reads it: sounds as [laughs] where they happen, and words said a
 * certain way inside <whisper>…</whisper>. The editor shows them as chips; other models get the words without them.
 */

export type PointTag = "laughs" | "chuckles" | "sighs" | "gasps" | "breath" | "pause";
export type SpanTag = "whisper" | "slow" | "emphasis";

/** The chips under the script, in order: what each adds, and its short name on the chip. */
export const POINT_TAGS: { tag: PointTag; label: string; text: string }[] = [
  { tag: "laughs", label: "Laugh", text: "[laughs]" },
  { tag: "chuckles", label: "Chuckle", text: "[chuckles]" },
  { tag: "sighs", label: "Sigh", text: "[sighs]" },
  { tag: "gasps", label: "Gasp", text: "[gasps]" },
  { tag: "breath", label: "Breath", text: "[breath]" },
  { tag: "pause", label: "Pause", text: "[pause]" },
];
export const SPAN_TAGS: { tag: SpanTag; label: string }[] = [
  { tag: "whisper", label: "Whisper" },
  { tag: "slow", label: "Slower" },
  { tag: "emphasis", label: "Stress" },
];

/** One line of a conversation: who says it (their place in the cast) and what. */
export type SceneLine = { speaker: number; text: string };

const POINT = /\[(laughs|chuckles|sighs|gasps|breath|pause)\]/gi;
const SPAN = /<\/?(whisper|slow|emphasis)>/gi;

/** The words alone: what is actually said, for timing each word and checking that none were skipped. */
export function wordsOf(script: string) {
  return script.replace(POINT, " ").replace(SPAN, "").replace(/\[[^\]]*\]/g, " ").replace(/<\|speaker:\d+\|>/g, " ").replace(/\s+/g, " ").trim();
}

/** The script as a model takes it, with how it's said in front. */
export function forModel(model: VoiceModelId, script: string, direction: string) {
  const how = direction.trim().replace(/[[\]()]/g, "");
  if (model === "local:voice:drama3") return `${how ? `[${how}] ` : ""}${script.trim()}`;
  if (model === "local:voice:voxcpm2") return `${how ? `(${how})` : ""}${wordsOf(script)}`;
  return wordsOf(script);
}

/** A conversation as Drama 3 takes it: each line marked with its speaker. */
export function sceneForDrama(lines: SceneLine[], direction: string) {
  const how = direction.trim().replace(/[[\]()]/g, "");
  const body = lines
    .filter((l) => l.text.trim())
    .map((l) => `<|speaker:${l.speaker}|>${l.text.trim()}`)
    .join("\n");
  return `${how ? `[${how}] ` : ""}${body}`;
}

/** About how long it takes to say: 15 characters a second, a beat for each sound. */
export function secondsOf(script: string) {
  const words = wordsOf(script);
  const sounds = (script.match(POINT) ?? []).length;
  return Math.max(1, Math.round(words.length / 15 + sounds * 0.7));
}

/** How far apart two scripts are, word by word (0 = the same words): a take that skipped words reads well above 0.2. */
export function missedShare(said: string, heard: string) {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  const a = norm(said);
  const b = norm(heard);
  if (!a.length) return 0;
  // Edit distance over words, then as a share of the script's words.
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] / a.length;
}
