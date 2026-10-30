import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { aspectById } from "@/lib/shot";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput, type EngineReference } from "@/lib/engines/types";
import { CAMERAS, FINISHES, FORMATS, LIGHTS, MOMENTS, PEOPLE_MOMENTS, SCENES, WHO, byId, type ProductRead, type ShotCheck, type ShotPlan, type StudioSpec } from "@/lib/product/vocab";

/**
 * Product Studio, carried out in three steps:
 *  1. Read the product: a vision model works out what it is, how people really use it, where it
 *     belongs and what would look wrong (a capsule bottle half-buried in sand). Read once per photo.
 *  2. Direct: an art director fits every pick to that product. The picks are suggestions; the
 *     product leads. Each take gets its own idea and its own prompt.
 *  3. Shoot: every take renders on the picked image model with the product photos attached.
 */

const DIR = path.join(DATA_DIR, "cache", "product");
/** Bump when the reading instructions change. */
const READ_VERSION = 1;

/** Careful vision models first: the whole shoot leans on this reading. */
/** A hosted model on your Comfy key (it sees pictures well), else the open one on your own GPU. */
const READERS = ["comfy:google/gemini-3.5-flash", "local:text"];
const DIRECTORS = READERS;

const READ_INSTRUCTIONS = `You are a senior product photographer and brand strategist studying a client's product photo before a shoot. Work out exactly what the product is and how people really use it, so every picture shows it the way its buyers would meet it.
Look closely; read every legible word. If more than one photo is given, they show the same product from other angles.
Answer with JSON only:
{
 "name": "a short, specific noun phrase: what it is, its size and packaging ('a 500 ml sports drink in a translucent ice-blue plastic bottle')",
 "kind": "one or two words for a label chip ('Sports drink', 'Supplement', 'T-shirt', 'Serum', 'Sneakers', 'Headphones')",
 "category": "one of: drink, food, supplement, skincare, makeup, haircare, fragrance, apparel, footwear, accessory, jewelry, bag, eyewear, watch, electronics, home, kitchenware, furniture, toy, pet, baby, fitness, outdoor, tool, vehicle, stationery, book, cleaning, health, other",
 "brand": "the brand name exactly as printed, or ''",
 "text": "every legible word on the product and packaging in reading order, exactly as printed, separated by ' / ' ('' if none). Never invent words you can't read.",
 "look": "35–60 words: shape and proportions, every color (name it precisely), materials and finish, cap or closure, how the label or print sits, anything distinctive",
 "size": "its real-world size in centimetres and in human terms ('about 23 cm tall; one hand wraps around it')",
 "use": "one sentence: how it is used, eaten, drunk, applied or worn, when, and by whom",
 "states": ["2–4 ways it can appear, most appealing first ('cap off, being sipped', 'sealed, beaded with condensation', 'poured over ice in a glass')"],
 "hands": "how a hand naturally holds it",
 "rests": "how and where it naturally rests ('standing upright on a table, counter or gym bench')",
 "never": ["3–6 placements or treatments that would look wrong, unappetizing, unsafe or damaging for this product ('lying on wet sand', 'floating in the sea', 'on a gym floor')"],
 "settings": ["4–8 settings it naturally belongs in"],
 "props": ["4–8 props that belong with it and show what it's for"],
 "people": "who typically buys and uses it (age range, lifestyle, style)",
 "palette": ["2–4 main colors of the product, plain names"]
}`;

const DIRECTOR_INSTRUCTIONS = `You are the art director and photographer of a product studio. You get a product (its photo and a careful reading of it) and a brief: the moment, the setting, the camera, the light, the finish, who appears, the frame and the client's notes. You write the exact prompt an image model renders, one per shot. The pictures must be good enough to post as an ad the moment they're made.

THE PRODUCT LEADS. THE BRIEF SUGGESTS.
Every choice in the brief names a world and a feeling, never a literal recipe. Put the product into that world the way its real buyers would meet it there, doing what it really does. Three clients pick "Beach":
- a sports drink: cap off, being sipped by someone on a towel after a swim, condensation on the bottle; or standing in an ice bucket on a beach-bar counter.
- longevity capsules: on a shaded beach-café table beside a glass of water and sunglasses, or two capsules in an open palm; never half-buried in sand.
- a t-shirt: worn by someone walking the boardwalk, the fabric moving in the breeze, or hung over a lounger; never lying on wet sand.
The same thinking everywhere: in a gym a capsule bottle sits on the bench beside a water bottle and a towel, not on the floor; sneakers in a kitchen are worn by someone making coffee, not standing on the counter; a serum in a forest sits on a clean flat stone, dry, catching a beam of light.

ANY PRODUCT: it can be anything people sell: food, dishes and drinks, beauty, fashion, jewelry, tech, home and furniture, tools, toys, pet supplies, vehicles. When a moment can't physically apply to it (In hand for a sofa or a bicycle), keep its spirit: a hand resting on it, someone using it, the product where it naturally stands. Scale the setting to the product (a sofa in a room, a car on a road, a ring on a hand). Food and dishes look fresh and appetizing, as served. Products for babies or children are shown with a parent's hands or in use, never with a child as the focus. Alcohol appears only with adults who clearly look over 25. Apps and digital products appear on a real device's screen.

COMMON SENSE (unless the client's notes ask otherwise):
- Anything eaten, drunk, swallowed or put on skin is never set on sand, soil, the ground, a floor or in water. It rests on a clean surface (table, counter, tray, towel, shelf, bench) or is held.
- Clothing is worn, or hung or folded neatly, never crumpled on the ground. Footwear is worn, or set as a pair.
- Electronics stay clean and dry: in use, or on a surface.
- Opened the real way: a cap unscrewed and held or set beside it, a lid lifted, a dropper drawn. Poured liquid is the product's real color.
- Real scale: use the product's real size against hands, faces, cups and furniture.
- Everything rests with real contact shadows. Nothing floats unless the moment is In motion or Ingredients.
- Exactly one unit of the product unless the moment calls for several. Never a stray duplicate.
- Never add another brand, logo, sticker, price tag, caption, watermark or any words except the product's own printing and text the client asked for.
- Never invent packaging, colors, flavors or variants the product doesn't have.

MOMENT, SETTING, CAMERA, LIGHT, FINISH, WHO: honor each one precisely, written in plain photographic words: camera height, angle and distance, lens and aperture; where the light comes from and its quality; the capture and grade. "Best fit" means you choose what serves this product best. When two choices clash (night city with golden hour), keep the setting and bend the rest so both are true (the city at dusk, neon just switching on).
Image models ignore jargon and style names and follow what is visible, so write the camera as what the frame shows (where the horizon or backdrop line falls, which faces of the product we see, how much of the surface around it shows, how big it is in the frame) and the finish as its visible traits (grain, contrast, how deep the focus is, the color, the framing). The finish must be unmistakable in the picture.

PEOPLE: real, believable people with natural skin texture and relaxed, genuine expressions; anatomically correct hands with five fingers and a natural grip; clothes that suit the setting and the product's audience. They look at the product or into the scene, not at the camera, unless the moment is Creator. If a person reference image is listed, that person is the one in the picture.
CASTING: cast a specific, believable person for everyone in the shot, fitted to the product's real audience, in a few concrete words: age, skin tone, hair, build, style ("a woman in her late twenties with a short curly bob and freckles, in a faded denim shirt"). Image models fall back on one generic stock model when the person is vague, so never leave it vague, and vary age, ethnicity, hair and style from shot to shot. No stock poses: no hand on the chin, no smiling down at the product, no product held up beside the face (except in Creator). People are caught doing something real.
Brand-safe, always: people dressed the way any brand would run them. At a beach or pool that means a linen shirt or cover-up, shorts, a sundress or a one-piece under an open shirt; for workouts, a fitted tee, tank or zip top. Never write about swimwear, underwear, bare skin or bodies. Keep the framing on the product, the hands and the face.

FIDELITY: the product is the exact one in image 1 (and any other product images): same shape, proportions, colors, materials, closure, label layout, logo and every printed word. Name it plainly and quote its main label words exactly, so the model keeps them. Take only the product from the photos, never their background, surface or lighting. If the brief says the image model can't see the photos, describe the product fully in words from the reading instead.

MAKE IT POSTABLE: it must read as a real photograph from a professional shoot (or from a real phone, for Creator and Phone photo), never a render. True-to-life color, real materials, small natural imperfections (a crease, a drop of water, a little texture on stone), believable depth of field. Steer away from what makes images look AI-made: plastic or waxy skin, extra or fused fingers, warped or misspelled labels, impossible reflections, everything perfectly symmetrical, oversaturated color, glowing edges, haze for no reason, props piled up. One to four props at most, each telling the story. The product is the clear subject and its label is readable.
Contact is where image models fail most: lips on a spout, fingertips on a tiny part, a capsule at the lips. Prefer the beat just before or just after it (the bottle lowered from her lips with the spout open, a capsule resting in an open palm beside the glass) unless the client's notes ask for the exact moment. Keep grips simple: a whole hand around the body of the product.

FRAME: compose for the aspect ratio given. The product and its label are clearly visible and never cut off by the edge (except in a Close-up) and never tiny. With copy space, keep a calm, empty third of the frame (say which side) free for a headline.

TEXT ON THE PICTURE: none, unless the brief gives a headline or the client's notes ask for words on the image. Then set exactly those words (same spelling, letters and case; quote them) in the calm area, in bold, clean typography that suits the product, large and legible, never over the product.

NOTES: the client's own words win over everything else in the brief. Translate them faithfully, but keep any words they want on the picture exactly as written.

SEVERAL SHOTS: each one a genuinely different idea within the same brief (a different beat of the moment, another composition or framing, another spot in the setting), never the same picture twice. Keep the setting, light and finish consistent across them.

WRITE each prompt as one paragraph of natural English, 90–160 words, present tense, in this order: what the photograph shows and the moment; the product (from image 1, named, main label words quoted); the setting as you adapted it; camera; light; finish and capture details. End with exactly: "Keep the product exactly as in image 1: same shape, colors, label and text." followed by "No added text or logos." (or, when the picture carries the client's own words, "No other text or logos."). Refer to pictures as "image 1", "image 2"… as listed.
Give each shot an "idea": at most 10 plain words a shopper would understand ("Mid-sip on a beach towel after a swim").

Answer with JSON only: {"shots":[{"idea":"...","prompt":"..."}]}`;

const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
const list = (v: unknown, n: number, each = 120) => (Array.isArray(v) ? v.map((x) => tidy(x, each)).filter(Boolean).slice(0, n) : []);

function toRead(raw: Record<string, unknown> | null): ProductRead | null {
  if (!raw) return null;
  const read: ProductRead = {
    name: tidy(raw.name, 160).replace(/\.$/, ""),
    kind: tidy(raw.kind, 32).replace(/\.$/, ""),
    category: tidy(raw.category, 24).toLowerCase(),
    brand: tidy(raw.brand, 60),
    text: tidy(raw.text, 400),
    look: tidy(raw.look, 700),
    size: tidy(raw.size, 200),
    use: tidy(raw.use, 300),
    states: list(raw.states, 4),
    hands: tidy(raw.hands, 200),
    rests: tidy(raw.rests, 200),
    never: list(raw.never, 6),
    settings: list(raw.settings, 8, 60),
    props: list(raw.props, 8, 60),
    people: tidy(raw.people, 200),
    palette: list(raw.palette, 4, 30),
  };
  return read.name && read.use ? read : null;
}

const g = globalThis as unknown as { __crackioProductReads?: Map<string, Promise<ProductRead | null>> };
const reading = (g.__crackioProductReads ??= new Map());

/** What the product in these photos is and how it's used (front photo first). Cached by the photos' bytes. */
export async function readProduct(files: string[], signal?: AbortSignal): Promise<ProductRead | null> {
  if (!files.length) return null;
  const hash = createHash("sha1");
  for (const f of files) hash.update(await fs.readFile(f)).update("|");
  const key = hash.update(`v${READ_VERSION}`).digest("hex");
  const file = path.join(DIR, `${key}.json`);
  const hit = await fs
    .readFile(file, "utf8")
    .then((t) => JSON.parse(t) as { read: ProductRead })
    .catch(() => null);
  if (hit?.read) return hit.read;
  // The page asks as soon as you add a photo, and the shoot may ask again before that's back: one reading.
  const running = reading.get(key);
  if (running) return running;
  const job = (async () => {
    const answer = await askText({
      instructions: READ_INSTRUCTIONS,
      text: "Read this product.",
      references: files.map((p, i) => ({ path: p, label: i === 0 ? "the product" : "the same product from another angle" })),
      prefer: READERS,
      imageEdge: 1024,
      detail: "high",
      effort: "low",
      timeoutMs: 90_000,
      signal,
    }).catch(() => null);
    const read = answer ? toRead(jsonObject(answer)) : null;
    if (read) {
      await fs.mkdir(DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify({ version: READ_VERSION, read }));
    }
    return read;
  })();
  reading.set(key, job);
  try {
    return await job;
  } finally {
    reading.delete(key);
  }
}

/** The reading, written out for the director. */
function readingText(read: ProductRead | null, identity?: string) {
  const lines = read
    ? [
        `- What it is: ${read.name}${read.kind ? ` (${read.kind})` : ""}; category: ${read.category || "other"}`,
        read.brand ? `- Brand: ${read.brand}` : "",
        read.text ? `- Printed on it: ${read.text}` : "- Printed on it: nothing legible",
        `- Look: ${read.look}`,
        read.size ? `- Size: ${read.size}` : "",
        `- How it's used: ${read.use}`,
        read.states.length ? `- Ways it can appear: ${read.states.join("; ")}` : "",
        read.hands ? `- Held: ${read.hands}` : "",
        read.rests ? `- Rests: ${read.rests}` : "",
        read.never.length ? `- Would look wrong: ${read.never.join("; ")}` : "",
        read.settings.length ? `- Belongs in: ${read.settings.join(", ")}` : "",
        read.props.length ? `- Props that fit: ${read.props.join(", ")}` : "",
        read.people ? `- Who uses it: ${read.people}` : "",
        read.palette.length ? `- Its colors: ${read.palette.join(", ")}` : "",
      ]
    : ["- (No reading available: look at image 1 and work it out yourself.)"];
  const told = identity?.trim() ? [`The client says the product is: "${identity.trim()}". Trust this over the reading wherever they differ.`] : [];
  return [...lines.filter(Boolean), ...told].join("\n");
}

type PlanInput = {
  read: ProductRead | null;
  spec: StudioSpec;
  notes: string;
  /** Every picture the image model gets, in order, with what it shows. */
  pictures: { label: string }[];
  productFiles: string[];
  aspect: string;
  count: number;
  /** Whether the image model sees the photos (some only take words). */
  seesImages: boolean;
  signal?: AbortSignal;
};

const CAST_NOUN = { person: "person", pet: "animal", character: "character" } as const;

/** Who appears: someone from the client's Cast (shown in the pictures), someone they described, or a quick pick. */
function whoLine(spec: StudioSpec, pictures: { label: string }[]) {
  const people = PEOPLE_MOMENTS.includes(spec.moment);
  if (spec.who === "cast" && spec.cast) {
    const noun = CAST_NOUN[spec.cast.kind] ?? "person";
    const shown = pictures.flatMap((p, i) => (p.label.startsWith(`${spec.cast!.name},`) ? [`image ${i + 1}`] : []));
    return `- Who: ${spec.cast.name}, the client's own ${noun}${shown.length ? ` (${shown.join(" and ")})` : ""}. This exact ${noun} is the one in the picture, recognizably the same: same face, features, hair or coat, skin tone and build${spec.cast.traits ? ` (${spec.cast.traits.replace(/\.$/, "")})` : ""}. Dress and pose them for this shot; never swap them for someone else. Name them in the prompt by the image numbers, not by name.`;
  }
  if (spec.who === "custom" && spec.whoText?.trim()) {
    return `- Who: exactly the person the client describes: "${spec.whoText.trim().slice(0, 400)}". Keep every detail they give; fill in the rest so it fits the product's audience.`;
  }
  if (!people) return "- Who: nobody, unless the moment needs a hand.";
  const o = byId(WHO, spec.who === "cast" || spec.who === "custom" ? "auto" : spec.who);
  return `- Who: ${o.label}. ${o.brief}`;
}

function briefText({ read, spec, notes, pictures, aspect, count, seesImages }: PlanInput) {
  const a = aspectById(aspect);
  const format = FORMATS.find((f) => f.id === aspect);
  const moment = byId(MOMENTS, spec.moment);
  const line = (name: string, o: { label: string; brief: string }) => `- ${name}: ${o.label}. ${o.brief}`;
  return [
    "PRODUCT (read from its photo):",
    readingText(read, spec.identity),
    "",
    seesImages ? "PICTURES THE IMAGE MODEL GETS:" : "THE IMAGE MODEL CAN'T SEE ANY PICTURES: describe the product fully in words.",
    ...(seesImages ? pictures.map((p, i) => `- image ${i + 1}: ${p.label}`) : []),
    "",
    "BRIEF:",
    line("Moment", moment),
    line("Setting", byId(SCENES, spec.scene)),
    line("Camera", byId(CAMERAS, spec.camera)),
    line("Light", byId(LIGHTS, spec.light)),
    line("Finish", byId(FINISHES, spec.finish)),
    whoLine(spec, pictures),
    `- Frame: ${a.id} ${a.w >= a.h ? (a.w === a.h ? "square" : "landscape") : "portrait"}${format ? ` (${format.caption.replace(/\.$/, "").toLowerCase()})` : ""}`,
    `- Copy space: ${spec.headline?.trim() ? `yes: set the headline "${spec.headline.trim()}" there` : spec.copySpace ? "yes, keep a calm empty third of the frame for a headline (leave it empty)" : "no"}`,
    `- Client's notes: ${notes.trim() ? `"${notes.trim()}"` : "none"}`,
    "",
    `Write ${count} ${count === 1 ? "shot" : "different shots"}.`,
  ].join("\n");
}

function toShots(answer: string | null, count: number): ShotPlan[] | null {
  const raw = answer ? jsonObject<{ shots?: { idea?: unknown; prompt?: unknown }[] }>(answer) : null;
  const shots = (raw?.shots ?? [])
    .map((s) => ({ idea: tidy(s.idea, 90).replace(/\.$/, ""), prompt: tidy(s.prompt, 2400) }))
    .filter((s) => s.prompt.length > 60);
  if (!shots.length) return null;
  // Fewer ideas than takes: the last one again (each take still renders on its own).
  return Array.from({ length: count }, (_, i) => shots[Math.min(i, shots.length - 1)]);
}

/** The art director's shot list: one idea and one prompt per take, fitted to this product. */
export async function planShots(input: PlanInput): Promise<ShotPlan[] | null> {
  const ask = (prefer: string[]) =>
    askText({
      instructions: DIRECTOR_INSTRUCTIONS,
      text: briefText(input),
      // The director sees the product too, so the reading never has the last word on what's there.
      references: input.productFiles.slice(0, 2).map((p, i) => ({ path: p, label: i === 0 ? "the product (image 1 for the image model)" : "the same product from another angle" })),
      prefer,
      imageEdge: 768,
      detail: "low",
      effort: "low",
      timeoutMs: 120_000,
      signal: input.signal,
    }).catch(() => null);
  // A malformed answer gets one more try on another model.
  return toShots(await ask(DIRECTORS), input.count) ?? toShots(await ask(DIRECTORS.slice(2).concat(DIRECTORS.slice(0, 2))), input.count);
}

/** Without a text model: the picks in plain words, still kept honest about the product. */
export function fallbackShots({ read, spec, notes, count }: Pick<PlanInput, "read" | "spec" | "notes" | "count">): ShotPlan[] {
  const name = read?.name ?? "the product";
  const moment = byId(MOMENTS, spec.moment).phrase;
  const scene = byId(SCENES, spec.scene).phrase;
  const camera = byId(CAMERAS, spec.camera).phrase;
  const light = byId(LIGHTS, spec.light).phrase;
  const finish = byId(FINISHES, spec.finish).phrase || "Realistic commercial product photograph";
  const words = read?.text ? ` Its label reads "${read.text.split(" / ").slice(0, 3).join(" ")}".` : "";
  const prompt = [
    `${finish} of ${name} from image 1${moment ? `, ${moment}` : ""}${scene ? `, ${scene}` : ""}.${words}`,
    camera ? `${camera}.` : "",
    light ? `${light}.` : "",
    "Real-world scale, natural contact shadows, true-to-life materials and color; placed where it would really be used.",
    notes.trim() ? `${notes.trim()}.` : "",
    spec.headline?.trim() ? `Set the headline "${spec.headline.trim()}" in bold, clean type in a calm part of the frame, away from the product.` : spec.copySpace ? "Leave a calm, empty third of the frame for a headline." : "",
    `Keep the product exactly as in image 1: same shape, colors, label and text. ${spec.headline?.trim() || notes.trim() ? "No other text or logos." : "No added text or logos."}`,
  ]
    .filter(Boolean)
    .join(" ");
  return Array.from({ length: count }, () => ({ idea: "", prompt }));
}

/** How image models say their safety filter refused a prompt. */
const REFUSED = /safety|declined|moderat|content.?policy|rejected by/i;

const SAFER_INSTRUCTIONS = `An image model's safety filter refused the product-photo prompt below, misreading it. Rewrite it so it can't be misread, keeping the same idea, product, setting, camera, light, finish and the closing sentence: people fully and modestly dressed (no swimwear, underwear or bare skin mentioned), nothing about bodies beyond hands and faces, and no wording that could read as sexual, violent, medical or about minors. Output only the new prompt.`;

async function saferPrompt(prompt: string, reason: string, signal: AbortSignal) {
  const answer = await askText({
    instructions: SAFER_INSTRUCTIONS,
    text: `The filter said: ${reason.slice(0, 300)}\n\nPrompt:\n${prompt}`,
    prefer: DIRECTORS,
    effort: "low",
    timeoutMs: 60_000,
    signal,
  }).catch(() => null);
  return answer && answer.length > 60 ? answer.slice(0, 2400) : null;
}

const CHECK_INSTRUCTIONS = `You are the client's art buyer checking a product photo before it runs as an ad. Image 1 is the client's own product photo. Image 2 is the new picture. Judge image 2 only on problems a client would actually reject; ignore taste, styling choices and flaws nobody would notice at phone size.
Reject it (pass: false) only for:
- the product isn't the same as in image 1: another shape, proportions, colors, cap or closure, label layout or logo;
- its printed words misspelled, garbled, mirrored or missing where they'd be visible (print too small to read is fine);
- the product duplicated by accident, floating, awkwardly cut off by the frame, or at an impossible size for the hands and things around it;
- hands or people that are wrong: extra, missing or fused fingers, a grip that couldn't hold it, warped faces, limbs or bodies;
- use or placement that makes no sense for this product (a drink sipped with its cap on, capsules lying in sand, a shirt crumpled on a floor);
- text, logos or watermarks that aren't on the product and that the client didn't ask for (words the client asked for are wanted: fail them only when misspelled, garbled or missing);
- obvious AI artifacts: melted or warped objects, smeared details, impossible reflections or shadows;
- when an image 3 is given: the person (or animal) in image 2 clearly isn't the one in image 3 (another face, features, hair or coat, skin tone or build).
The fix is for a re-shoot. When the problem is a hard pose or a point of contact (a sip, a pinch, a grip on a tiny part), don't ask for the same pose again: change the moment to an easier beat that sells just as well (the bottle lowered from her lips, the capsule in an open palm).
Answer with JSON only: {"pass": true or false, "issues": ["each problem in one short plain sentence"], "fix": "one or two sentences telling the image model exactly what to do differently on a re-shoot ('' when it passes)"}`;

const CHECKERS = READERS;
const CHECK_DIR = path.join(DIR, "check");

/** What a client would reject in a take, looked for against the product photo. Null when no vision model answers (the shoot then keeps the take). */
async function checkShot(product: string, out: EngineOutput, read: ProductRead | null, prompt: string, asked: string, signal: AbortSignal, person?: string) {
  await fs.mkdir(CHECK_DIR, { recursive: true });
  const ext = out.mime === "image/jpeg" ? "jpg" : out.mime === "image/webp" ? "webp" : "png";
  const file = path.join(CHECK_DIR, `${createHash("sha1").update(out.data).digest("hex").slice(0, 16)}.${ext}`);
  await fs.writeFile(file, out.data);
  try {
    const answer = await askText({
      instructions: CHECK_INSTRUCTIONS,
      text: [
        `The product: ${read?.name ?? "the one in image 1"}.`,
        read?.text ? `Printed on it: ${read.text}.` : "",
        asked ? `The client asked for: ${asked}` : "",
        `The picture was meant to show: ${prompt.slice(0, 1200)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      references: [
        { path: product, label: "the client's product photo" },
        { path: file, label: "the new picture to check" },
        ...(person ? [{ path: person, label: "the client's own person, who must be the one in the picture" }] : []),
      ],
      prefer: CHECKERS,
      imageEdge: 1024,
      detail: "high",
      effort: "low",
      timeoutMs: 90_000,
      signal,
    }).catch(() => null);
    const raw = answer ? jsonObject<{ pass?: unknown; issues?: unknown; fix?: unknown }>(answer) : null;
    if (!raw || typeof raw.pass !== "boolean") return null;
    return { pass: raw.pass, issues: list(raw.issues, 5, 160), fix: tidy(raw.fix, 400) };
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The re-shoot's prompt: the fix goes just before the closing line about keeping the product true. */
function withFix(prompt: string, fix: string) {
  const at = prompt.indexOf("Keep the product exactly as in image 1");
  return at > 0 ? `${prompt.slice(0, at)}${fix.trim()} ${prompt.slice(at)}` : `${prompt} ${fix.trim()}`;
}

export type ProductShootResult = { outputs: EngineOutput[]; usedPrompt: string; shots: ShotPlan[]; read: ProductRead | null };

/** Read, direct and shoot: every take its own idea, rendered in parallel. */
export async function runProductShoot(
  job: EngineJob,
  spec: StudioSpec,
  engine: Engine,
  ctx: EngineContext,
  opts: { notes: string; seesImages: boolean },
): Promise<ProductShootResult> {
  const seen = new Set<string>();
  job = { ...job, references: job.references.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true))) };
  const products: EngineReference[] = job.references.slice(0, Math.max(1, Math.min(3, spec.productImages || 1)));
  // Someone from your Cast: the check also makes sure it's really them.
  const person = spec.who === "cast" ? job.references.slice(products.length).find((r) => r.role === "subject") : undefined;
  if (!products.length) throw new EngineError("Add a photo of your product first.");
  const count = Math.max(1, Math.min(job.count, 4));

  ctx.progress(0.03, "Reading the product");
  const read = spec.read ?? (await readProduct(products.map((p) => p.path), ctx.signal).catch(() => null));
  if (ctx.signal.aborted) throw new EngineError("Cancelled.");

  ctx.progress(0.08, count > 1 ? "Planning the shots" : "Planning the shot");
  const pictures = job.references.map((r, i) => ({ label: i < products.length ? (i === 0 ? "the product" : "the same product from another angle") : (r.label ?? "a reference") }));
  const plans =
    (await planShots({ read, spec, notes: opts.notes, pictures, productFiles: products.map((p) => p.path), aspect: job.aspect, count, seesImages: opts.seesImages, signal: ctx.signal })) ??
    fallbackShots({ read, spec, notes: opts.notes, count });
  if (ctx.signal.aborted) throw new EngineError("Cancelled.");

  // Each take renders on its own, all at once; the bar shows how far they are together.
  const check = spec.check === true;
  // What the client asked for in their own words, so the check never rejects it (a headline they typed).
  const asked = [opts.notes.trim() ? `"${opts.notes.trim()}"` : "", spec.headline?.trim() ? `the headline "${spec.headline.trim()}" on the picture` : ""].filter(Boolean).join("; ");
  const done = plans.map(() => 0);
  const phase: ("shoot" | "check" | "reshoot" | "done")[] = plans.map(() => "shoot");
  const stage = () =>
    phase.includes("reshoot") ? "Re-shooting a take" : phase.includes("check") ? (count > 1 ? "Checking the takes" : "Checking the shot") : phase.includes("shoot") ? "Shooting" : "Saving";
  const report = (i: number, v: number) => {
    done[i] = Math.max(done[i], v);
    ctx.progress(0.16 + 0.82 * (done.reduce((sum, x) => sum + x, 0) / done.length), stage());
  };
  ctx.progress(0.16, "Shooting");
  const shootOne = (plan: ShotPlan, i: number, from: number, span: number) =>
    engine.run({ ...job, prompt: plan.prompt, userPrompt: plan.prompt, refine: false, count: 1 }, { signal: ctx.signal, progress: (v) => report(i, from + v * span) });
  // A safety filter misreading a harmless shot (a beach, a group of friends): reword it once and retry.
  const shootSafely = async (i: number, from: number, span: number) => {
    try {
      return await shootOne(plans[i], i, from, span);
    } catch (err) {
      if (ctx.signal.aborted || !REFUSED.test((err as Error).message)) throw err;
      const safer = await saferPrompt(plans[i].prompt, (err as Error).message, ctx.signal);
      if (!safer) throw err;
      plans[i] = { ...plans[i], prompt: safer };
      return shootOne(plans[i], i, from, span);
    }
  };
  const results = await Promise.allSettled(
    plans.map(async (_, i) => {
      let result = await shootSafely(i, 0, check ? 0.72 : 1);
      if (!check || !result.outputs[0] || ctx.signal.aborted) return result;
      // The art buyer's look: the take against the product photo, before anyone else sees it.
      phase[i] = "check";
      report(i, 0.76);
      const first = await checkShot(products[0].path, result.outputs[0], read, plans[i].prompt, asked, ctx.signal, person?.path);
      if (!first || first.pass || !first.fix || ctx.signal.aborted) {
        plans[i] = { ...plans[i], ...(first ? { check: { pass: first.pass, issues: first.issues } } : {}) };
        phase[i] = "done";
        return result;
      }
      // Something a client would reject: one re-shoot with the fix, keeping whichever came out better.
      phase[i] = "reshoot";
      const retry: ShotPlan = { ...plans[i], prompt: withFix(plans[i].prompt, first.fix) };
      const second = await shootOne(retry, i, 0.8, 0.14).catch(() => null);
      let verdict: ShotCheck = { pass: false, issues: first.issues, retried: true };
      if (second?.outputs[0] && !ctx.signal.aborted) {
        const again = await checkShot(products[0].path, second.outputs[0], read, retry.prompt, asked, ctx.signal, person?.path);
        if (!again || again.pass || again.issues.length < first.issues.length) {
          result = second;
          plans[i] = retry;
          verdict = { pass: again?.pass ?? true, issues: again?.issues ?? [], retried: true };
        }
      }
      plans[i] = { ...plans[i], check: verdict };
      phase[i] = "done";
      return result;
    }),
  );
  const outputs: EngineOutput[] = [];
  const shots: ShotPlan[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const o of r.value.outputs) {
      outputs.push(o);
      shots.push({ idea: plans[i].idea, prompt: r.value.usedPrompt || plans[i].prompt, ...(plans[i].check ? { check: plans[i].check } : {}) });
    }
  });
  if (!outputs.length) {
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw failed?.reason instanceof Error ? failed.reason : new EngineError("The image model returned nothing.");
  }
  return { outputs, usedPrompt: shots[0].prompt, shots, read };
}
