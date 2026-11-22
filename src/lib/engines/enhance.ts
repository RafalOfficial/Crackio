import "server-only";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { lfm3Text } from "./comfy-text";
import { toDataUrl } from "./util";
import type { EngineReference } from "./types";

/**
 * Crackio's prompt enhancer: LFM3-VL 2B with Crackio's own fine-tune (lib/local/lfm3 `enhance`, trained on 6,041
 * request → prompt pairs), on your GPU. It restates what you asked in clean English, keeps every detail, adds only how
 * it looks (framing, light, tones, mood) and returns an already detailed prompt as it is. It runs with the words below
 * and no others: they are the instructions it was trained with (data/lfm3/runs/enhance-v4/system.txt), so a changed
 * line here is a model it has never seen. A new version of the fine-tune brings its own.
 */
export const ENHANCE_INSTRUCTIONS = `You write prompts for an image or video model. Rewrite the request below as one precise English prompt.
Rules:
- First restate the request itself in clean English, keeping every detail it gives (subjects, counts, colors, materials, names, places, actions, style, text, camera hints) in the request's own words. Translate faithfully, fix typos, and copy anything you are unsure about exactly as written. Never swap a word for a different or more specific one.
- Add no things: no new objects, props, people, animals, places, backgrounds, text or brands, no action, pose or expression that wasn't asked, no hair, clothes or age for a person, no color, material or size for a thing, and no camera gear (lens, mm, f-stop).
- Then add only how it looks: framing and angle in plain words, light and time of day, overall tones, mood. Name a style or medium (photograph, illustration, render) only if the request does. For non-photo styles (anime, cartoon, pixel art, logo, 3D, comic) use that style's own terms and never camera words. For video, add one camera behaviour and, if no motion is given, only the plain natural motion of what is named.
- If the request is already a detailed prompt, return it unchanged.
- Natural prose, 2 to 4 sentences (1 to 3 for video). No lists, no quotation marks, no preamble.
- If reference images are listed, refer to them as "the person in image 1", "the product in image 2", and so on, and describe nothing about them that the request doesn't state.
Output only the prompt.`;

/** A request that says it's for a clip already. Every video request it learned from does ("video of…", "animate…"). */
const SAYS_VIDEO = /\b(video|clip|footage|animat\w*|film\w*|time-?lapse|loop|slow[- ]?mo\w*)\b/i;

/**
 * The request as the enhancer learned to read it: each reference picture as one line of words (it was trained on
 * descriptions, not on pictures), then "Request: …" on one line, a clip's saying it's a video.
 */
export function enhanceMessage(text: string, described: string[] = [], kind: "image" | "video" = "image") {
  const words = text.replace(/\s+/g, " ").trim();
  const request = kind === "video" && !SAYS_VIDEO.test(words) ? `video of ${words}` : words;
  const refs = described.map((d, i) => `- image ${i + 1}: ${d}`).join("\n");
  return `${refs ? `Reference images:\n${refs}\n\n` : ""}Request: ${request}`;
}

const DESCRIBE = `Say what this picture shows in one short phrase of at most 14 words: the main subject with what is most visible about it, then where it is. Lower case, no full stop, no sentence, no preamble. Examples: "portrait of a smiling woman with curly hair wearing a denim jacket", "matte black wireless headphones on a desk".`;

/** What each picture was called, by file and its last change: a prompt written again doesn't look at them again. */
const described = ((globalThis as unknown as { __crackioDescribed?: Map<string, string> }).__crackioDescribed ??= new Map<string, string>());

/** One reference picture in a few words (LFM3-VL itself looks at it), or the name it was given when that fails. */
async function describe(ref: Partial<EngineReference> & { label?: string; role?: string }, signal: AbortSignal): Promise<string> {
  const fallback = (ref.label ?? ref.role ?? "a picture").replace(/\s+/g, " ").trim() || "a picture";
  if (!ref.path) return fallback;
  const stat = await fs.stat(/*turbopackIgnore: true*/ ref.path).catch(() => null);
  const key = `${ref.path}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}`;
  const known = described.get(key);
  if (known) return known;
  try {
    const png = Buffer.from((await toDataUrl(ref as EngineReference, 512)).split(",")[1] ?? "", "base64");
    const jpeg = await sharp(png).jpeg({ quality: 88 }).toBuffer();
    const said = (await lfm3Text({ system: "You describe pictures in a few plain words.", prompt: DESCRIBE, images: [jpeg], maxTokens: 48, signal }))
      .replace(/\s+/g, " ")
      .replace(/^["'“‘]+|["'”’.]+$/g, "")
      .trim();
    // A phrase, not an essay or a refusal: anything else falls back to the picture's name.
    if (said.length < 4 || said.split(" ").length > 24) return fallback;
    if (described.size > 500) described.clear();
    described.set(key, said);
    return said;
  } catch {
    return fallback;
  }
}

/** Your words as a full prompt, by Crackio's prompt enhancer on your GPU (throws when it can't answer). */
export async function enhance(input: {
  text: string;
  references?: (Partial<EngineReference> & { label?: string; role?: string })[];
  kind?: "image" | "video";
  signal: AbortSignal;
}): Promise<string> {
  const refs = (input.references ?? []).slice(0, 6);
  const words: string[] = [];
  // One after the other: they share the one model on the card.
  for (const r of refs) words.push(await describe(r, input.signal));
  return lfm3Text({ system: ENHANCE_INSTRUCTIONS, prompt: enhanceMessage(input.text, words, input.kind), maxTokens: 512, lora: "enhance", signal: input.signal });
}
