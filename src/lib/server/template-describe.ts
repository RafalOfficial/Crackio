import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "@/lib/server/paths";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import type { SlotKind } from "@/lib/templates/types";

/**
 * What's in a photo you put into a template, written for a video model: who they are (face, hair,
 * build), what they wear, or what the pet, product or place looks like. Models that take pictures
 * get it beside the photo, so the swap matches it; Grok's clip editor, which takes words only, gets
 * nothing else. Read once per photo.
 */
const DIR = path.join(DATA_DIR, "cache", "templates", "describe");
/** Bump when the instructions change. */
const VERSION = 3;

export type PhotoDescription = {
  /** A short noun for who or what it is: "a woman", "a golden retriever", "a perfume bottle". */
  noun: string;
  /** Identity: everything that makes them look like themselves (face, hair, skin, build), or the thing itself. */
  look: string;
  /** The 4–8 traits that show most at video resolution, comma-separated: the checklist for models that also see the photo. */
  traits: string;
  /** People: what they're wearing in the photo, kept apart so a trend's costume can replace it. */
  wearing: string;
};

const SHAPE = `- traits: 4–8 short comma-separated traits from "look", the ones that still show in a small, moving video first (for a person: hair, facial hair, glasses, skin tone, build, one standout feature).
Leave out what the photo doesn't show; never write that something isn't visible.
Answer with JSON only: {"noun": "...", "look": "...", "traits": "...", "wearing": "..."}`;

const INSTRUCTIONS: Record<SlotKind, string> = {
  person: `You describe the main person in a photo so a video model can put exactly this person into another clip without seeing the photo.
- noun: a short noun phrase ("a woman in her late twenties", "a man in his fifties", "a teenage boy").
- look (60–90 words): what makes them recognizable: face shape, skin tone, eyes (color, shape), eyebrows, nose, lips, facial hair, hair (color, length, texture, style, parting), glasses, freckles, moles, piercings or tattoos that show, body build and height impression. Concrete, visual words only; no guesses about ethnicity, personality or mood.
- wearing (15–35 words): their clothes, shoes and accessories as seen, with colors and materials.
${SHAPE}`,
  face: `You describe the face of the main person in a photo so a video model can put exactly this face onto someone else in a clip without seeing the photo.
- noun: a short noun phrase ("a woman in her thirties").
- look (50–80 words): face shape, skin tone, eyes (color, shape), eyebrows, nose, lips, facial hair, hair (color, length, texture, style), glasses, freckles, moles or piercings. Concrete, visual words only; no guesses about ethnicity, personality or mood.
- wearing: "".
${SHAPE}`,
  pet: `You describe the animal in a photo so a video model can put exactly this animal into another clip without seeing the photo.
- noun: species and likely breed ("a golden retriever", "a grey tabby cat").
- look (40–70 words): size and build, coat colors, patterns and markings (where they are), fur length, eye color, ears, muzzle, tail, and anything distinctive.
- wearing: collar, harness or clothes, or "".
${SHAPE}`,
  object: `You describe the main object or product in a photo so a video model can put exactly this object into another clip without seeing the photo.
- noun: what it is ("a frosted glass perfume bottle", "a red sneaker").
- look (40–70 words): shape and proportions, colors, materials and finish, patterns, graphics, logos and lettering (quote short text exactly), and its real-world size.
- wearing: "".
${SHAPE}`,
  place: `You describe the place in a photo so a video model can move a clip's action into exactly this place without seeing the photo.
- noun: what kind of place it is ("a rooftop terrace", "a neon-lit arcade").
- look (50–80 words): layout and depth, the key features and landmarks, surfaces and materials, colors, lighting, time of day and weather.
- wearing: "".
${SHAPE}`,
};

async function cached(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as { version: number; description: PhotoDescription };
  } catch {
    return null;
  }
}

/** The description of a photo for a slot of this kind (cached by the photo's bytes). */
export async function describePhoto(photo: string, kind: SlotKind): Promise<PhotoDescription | null> {
  const bytes = await fs.readFile(photo);
  const key = createHash("sha1").update(bytes).update(`|${kind}|${VERSION}`).digest("hex");
  const file = path.join(DIR, `${key}.json`);
  const hit = await cached(file);
  if (hit?.version === VERSION) return hit.description;

  const answer = await askText({
    instructions: INSTRUCTIONS[kind],
    text: "Describe the photo.",
    references: [{ path: photo, label: "the photo" }],
    // A careful vision model that sees the photo large: the swap is only as close as this description.
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    imageEdge: 1024,
    detail: "high",
    effort: "low",
    timeoutMs: 60_000,
  }).catch(() => null);
  if (!answer) return null;
  const raw = jsonObject<Partial<PhotoDescription>>(answer);
  if (!raw) return null;
  const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, n) : "");
  const description: PhotoDescription = { noun: tidy(raw.noun, 80) || "the subject", look: tidy(raw.look, 900), traits: tidy(raw.traits, 300), wearing: tidy(raw.wearing, 400) };
  if (!description.look) return null;
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: VERSION, description }));
  return description;
}
