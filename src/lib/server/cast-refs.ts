import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { loadCharacter, saveCharacter } from "./cast-store";
import { sheetViews, viewsOf } from "./cast-sheet";
import { withSubjectMatte } from "./vision";
import { saveUpload, urlToPath } from "./media";
import { DATA_DIR } from "./paths";
import { pictureSlots } from "./director";
import { askText, refinePrompt } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { engineFor } from "@/lib/engines";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput, type EngineReference, type EngineResult } from "@/lib/engines/types";
import { listModels } from "@/lib/models/resolve";
import { pickAuto } from "@/lib/models/auto";
import { getSettings } from "./settings";
import type { ModelAvailability } from "@/lib/models/catalog";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { FIGURE_LOOKS, MENTION, castFits, castNoun, formatHeight, framePrefer, type Character, type SheetView } from "@/lib/cast/types";

/**
 * "@mia" in a plain Image or Video job, once its model is known: Mia goes in as a few separate pictures of herself (her
 * own photo first), the way the model takes pictures. The prompt opens with one line on which pictures are her and the
 * small details to keep, and closes with how many of each there are, the framing asked for and the sizes that matter.
 *
 * - Pictures: each member's pictures after yours, everyone's first one before anyone's second; a model that takes none
 *   is told in words.
 * - Clips on a model that takes reference pictures (Grok's, Kling's…): the pictures go in and the model builds the shot;
 *   a first frame is drawn first only when you ask for one.
 * - Clips on a model that takes none, with no start frame: the first frame is drawn with the cast, checked, then animated.
 * - Clips from your own start frame on a model that takes no references: in words.
 */

/**
 * How a job sends its cast. "refs", the default: separate pictures, the member's own photo first (Crackio's cast
 * benchmark, Oct 29 2026, judged side by side against the members' photos: Grok Imagine 2.0 preferred it in 22 of 26
 * comparisons over the sheet; Grok Video 1.5 held identity to the clip's end, 7.5 against 5.3, at half the time). "auto"
 * is the sheet way that came before: every member's reference sheet in one picture, the face too for close shots. The
 * others are for the benchmark ("legacy" is how Cast sent it before that: face and sheet while five pictures fit, else
 * the face only, and no words about them).
 */
export type CastMode = "auto" | "refs" | "sheet+portrait" | "sheet" | "front" | "portrait" | "views" | "words" | "legacy";
const MODES: CastMode[] = ["auto", "refs", "sheet+portrait", "sheet", "front", "portrait", "views", "words", "legacy"];

/** A shot close enough that faces (or an object's details) fill a good part of it. */
const closeShot = (text: string) => /\b(close[- ]?ups?|closeups?|portraits?|head ?shots?|faces?|selfies?|macro|details?|extreme close)\b/i.test(text);

type Picture = { path: string; label: string; says: string; who: Character[] };

const usable = (c: Character | null): c is Character => Boolean(c && (c.sheet || c.portrait || c.photos.length));

/** The cast a job mentions (`params.cast` entries that carry a handle), as they are now. */
export function castOfJob(gen: Pick<Generation, "params" | "tool">): Character[] {
  if (gen.tool === "cast") return [];
  const list = Array.isArray(gen.params?.cast) ? (gen.params.cast as unknown[]) : [];
  const ids = list.flatMap((x) => (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && typeof (x as { handle?: unknown }).handle === "string" ? [(x as { id: string }).id] : []));
  return [...new Set(ids)].map(loadCharacter).filter(usable);
}

/** "@mia" → "Mia" in a prompt, and "@bluebird" → "the sky-blue delivery van" (see `called`), or "a @bluebird" → "a sky-blue delivery van". */
export function withNames(text: string, cast: Character[]) {
  return text.replace(MENTION, (all, lead: string, handle: string, at: number) => {
    const c = cast.find((x) => x.handle === handle.toLowerCase());
    if (!c) return all;
    // A thing already has its word in front ("a @bluebird", "his @pack"): it doesn't get a second one.
    const own = c.kind === "object" && /\b(a|an|the|this|that|his|her|their|its|my|your|our)\s*$/i.test(text.slice(0, at + lead.length));
    return `${lead}${own ? called(c).replace(/^the /, "") : called(c)}`;
  });
}

const what = (c: Character) => c.noun ?? `${/^[aeiou]/i.test(castNoun(c.kind)) ? "an" : "a"} ${castNoun(c.kind)}`;
/**
 * What models are told to call each one: people, animals and characters by name, things by what they are. A thing's
 * name only means something to you: an image model read "Strummer standing nearby" as a second man and painted
 * "BLUEBIRD" over a flower shop (Crackio's clip benchmark, Oct 28 2026).
 */
const called = (c: Character) => (c.kind === "object" ? `the ${what(c).replace(/^(a|an|the) /i, "")}` : c.name);
const Called = (c: Character) => called(c).replace(/^t/, "T");
/** Who a picture shows: "Juno (a freckled woman…)", or "the sky-blue delivery van". */
const who = (c: Character) => (c.kind === "object" ? called(c) : `${c.name} (${what(c)})`);
const viewWords = (views: SheetView[]) => {
  const words = views.map((v) => (v === "three-quarter" ? "three-quarter view" : v === "side" ? "side" : v));
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
};
const sheetName = (c: Character) => (c.kind === "object" ? `the reference sheet of ${called(c)}` : `${c.name}'s reference sheet: ${what(c)}`);
const sheetSays = (c: Character) =>
  c.sheetLayout === "rows"
    ? `${sheetName(c)}, drawn whole from the front and the back on the top row and from the side, its whole length, on the row below, on a plain backdrop`
    : `${sheetName(c)}, drawn whole from the ${viewWords(viewsOf(c))} on a plain backdrop`;
const faceSays = (c: Character) => (c.kind === "object" ? `a clean shot of ${called(c)}` : `a close-up of ${c.name}'s face`);
const fileOf = (url: string | undefined) => (url ? urlToPath(url) : null);

const CACHE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "cast");

async function cached(key: string, make: () => Promise<Buffer>) {
  const file = path.join(/*turbopackIgnore: true*/ CACHE, `${createHash("sha1").update(key).digest("hex").slice(0, 24)}.png`);
  try {
    await fs.access(file);
  } catch {
    const png = await make();
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(file, png);
  }
  return file;
}

/** Several sheets in one picture, one under the other, for a model that takes fewer pictures than there are people. */
async function board(files: string[]) {
  const stamps = await Promise.all(files.map((f) => fs.stat(f).then((s) => `${f}:${s.mtimeMs}`)));
  return cached(`board|${stamps.join("|")}`, async () => {
    const width = 1536;
    const rows = await Promise.all(files.map((f) => sharp(f).resize({ width }).png().toBuffer({ resolveWithObject: true })));
    const gap = 24;
    const height = rows.reduce((h, r) => h + r.info.height, 0) + gap * (rows.length - 1);
    let top = 0;
    const layers = rows.map((r) => {
      const layer = { input: r.data, left: 0, top };
      top += r.info.height + gap;
      return layer;
    });
    return sharp({ create: { width, height, channels: 3, background: "#d6d6d6" } }).composite(layers).png().toBuffer();
  });
}

/**
 * Everyone's reference sheet in one composite picture, the way LTX-2.3's IC-LoRA "ingredients" was trained (a reference
 * sheet inventorying the characters and props): each member's sheet, a person's face close-up beside it, in a grid of
 * two (three past four members) on a plain backdrop. Returns where each one sits, for the prompt.
 */
async function ingredientsSheet(cast: Character[], aspect: number) {
  const H = 640;
  const GAP = 32;
  const cells = await Promise.all(
    cast.map(async (c) => {
      const parts = [fileOf(c.sheet) ?? fileOf(c.portrait) ?? fileOf(c.photos[0]), c.kind !== "object" && c.sheet ? fileOf(c.portrait) : null].filter((f): f is string => Boolean(f));
      const tiles = await Promise.all(parts.map((f) => sharp(f).resize({ height: H }).png().toBuffer({ resolveWithObject: true })));
      return { c, parts, tiles, width: tiles.reduce((w, t) => w + t.info.width, 0) + GAP * (tiles.length - 1) };
    }),
  );
  const boxW = Math.max(...cells.map((x) => x.width));
  // The grid closest to the clip's own shape: the guide is padded to the clip's size, and the model copies any padding
  // it's shown (a wide strip of sheets came back as a letterboxed clip).
  const shapeOf = (n: number) => (GAP + n * (boxW + GAP)) / (GAP + Math.ceil(cast.length / n) * (H + GAP));
  const cols = [1, 2, 3].filter((n) => n <= Math.max(1, cast.length)).sort((a, b) => Math.abs(Math.log(shapeOf(a) / aspect)) - Math.abs(Math.log(shapeOf(b) / aspect)))[0];
  const rows = Math.ceil(cast.length / cols);
  const names = (r: number, k: number) => {
    const col = cols === 1 ? "" : cols === 2 ? ["Left", "Right"][k] : ["Left", "Center", "Right"][k];
    const row = rows === 1 ? "" : rows === 2 ? ["Top", "Bottom"][r] : ["Top", "Middle", "Bottom"][r];
    return [row, col].filter(Boolean).join(" ") || "Center";
  };
  const stamps = await Promise.all(cells.flatMap((x) => x.parts).map((f) => fs.stat(f).then((s) => `${f}:${s.mtimeMs}`)));
  const file = await cached(`ingredients2|${cols}|${aspect.toFixed(3)}|${stamps.join("|")}`, async () => {
    const gridW = GAP + cols * (boxW + GAP);
    const gridH = GAP + rows * (H + GAP);
    // The whole picture in the clip's shape, the grid centered on the backdrop's own gray.
    const width = Math.round(Math.max(gridW, gridH * aspect));
    const height = Math.round(Math.max(gridH, gridW / aspect));
    const ox = Math.round((width - gridW) / 2);
    const oy = Math.round((height - gridH) / 2);
    const layers: { input: Buffer; left: number; top: number }[] = [];
    cells.forEach((x, i) => {
      const r = Math.floor(i / cols);
      const k = i % cols;
      let left = ox + GAP + k * (boxW + GAP) + Math.round((boxW - x.width) / 2);
      for (const t of x.tiles) {
        layers.push({ input: t.data, left, top: oy + GAP + r * (H + GAP) });
        left += t.info.width + GAP;
      }
    });
    return sharp({ create: { width, height, channels: 3, background: "#d9d9d9" } })
      .composite(layers)
      .png()
      .toBuffer();
  });
  return { path: file, regions: cells.map((x, i) => ({ c: x.c, where: names(Math.floor(i / cols), i % cols) })) };
}

/** One view cut from a sheet (front, side, back), as a picture of its own. */
async function view(c: Character, i: number) {
  const sheet = fileOf(c.sheet);
  if (!sheet) return null;
  const stat = await fs.stat(sheet);
  return cached(`view3|${sheet}|${stat.mtimeMs}|${c.sheetLayout ?? ""}|${i}`, async () => (await sheetViews(sheet, c))[i]);
}

/** The pictures that carry the cast, fitted to `room` pictures. */
async function pictures(cast: Character[], room: number, mode: CastMode, close = false): Promise<Picture[]> {
  if (room <= 0 || mode === "words") return [];
  const sheetOf = (c: Character): Picture | null => {
    const file = fileOf(c.sheet);
    if (file) return { path: file, label: sheetSays(c), says: sheetSays(c), who: [c] };
    const face = fileOf(c.portrait) ?? fileOf(c.photos[0]);
    return face ? { path: face, label: faceSays(c), says: faceSays(c), who: [c] } : null;
  };
  const faceOf = (c: Character): Picture | null => {
    const file = fileOf(c.portrait);
    return file ? { path: file, label: faceSays(c), says: faceSays(c), who: [c] } : null;
  };

  if (mode === "portrait") return cast.map((c) => faceOf(c) ?? sheetOf(c)).filter((p): p is Picture => Boolean(p)).slice(0, room);
  if (mode === "views") {
    // Every front first, then the sides, then the backs, while there's room.
    const out: Picture[] = [];
    for (let i = 0; i < Math.max(...cast.map((c) => viewsOf(c).length)); i++) {
      for (const c of cast) {
        const name = viewsOf(c)[i];
        if (!name) continue;
        const file = await view(c, i).catch(() => null);
        const says = `${who(c)} seen from the ${name === "three-quarter" ? "front at three-quarters" : name}`;
        if (file && out.length < room) out.push({ path: file, label: says, says, who: [c] });
      }
    }
    return out;
  }

  // "front": each one's front view cut from the sheet, one figure per picture (for models that draw a sheet's subject twice).
  const frontOf = async (c: Character): Promise<Picture | null> => {
    const file = await view(c, 0).catch(() => null);
    const says = `${who(c)} seen from the front`;
    return file ? { path: file, label: says, says, who: [c] } : sheetOf(c);
  };
  const sheets = (mode === "front" ? await Promise.all(cast.map(frontOf)) : cast.map(sheetOf)).filter((p): p is Picture => Boolean(p));
  if (!sheets.length) return [];
  let out: Picture[];
  if (sheets.length <= room) out = sheets;
  else {
    // Fewer pictures than people: the first ones get their own, the rest share the last picture.
    const own = sheets.slice(0, room - 1);
    const shared = sheets.slice(room - 1);
    const together = await board(shared.map((p) => p.path));
    const says = `reference sheets of ${shared.map((p, i) => `${who(p.who[0])}, ${i === 0 ? "at the top" : i === shared.length - 1 ? "at the bottom" : "next"}`).join("; ")}, each drawn whole from several sides on a plain backdrop`;
    out = [...own, { path: together, label: says, says, who: shared.flatMap((p) => p.who) }];
  }
  if (mode === "sheet+portrait" || (mode === "auto" && close)) {
    // Faces while there's room: people and characters first, then animals, then objects' hero shots.
    const order = [...cast].sort((a, b) => rank(a) - rank(b));
    for (const c of order) {
      if (out.length >= room) break;
      const face = faceOf(c);
      if (face && out.every((p) => p.path !== face.path)) out.push(face);
    }
  }
  return out;
}

const rank = (c: Character) => ({ person: 0, character: 1, pet: 2, object: 3 })[c.kind];

const VEHICLE = /\b(car|hatchback|sedan|saloon|coupe|convertible|wagon|van|truck|pickup|suv|jeep|bus|minibus|camper|limousine|taxi|tractor)\b/i;

/** How tall something is next to a person, in words a picture model can see: "up to about Mara's chest", "a fifth of her height". */
function against(h: number, p: Character, c?: Character) {
  const r = h / p.height!;
  // A vehicle is measured by its roof: "its roof comes up to her shoulders" is what a picture model can check.
  const top = c && VEHICLE.test(`${c.noun ?? ""} ${c.traits ?? ""}`) ? "its roof comes up to" : "up to";
  if (r > 1.12) return `about ${(Math.round(r * 10) / 10).toString()} times ${p.name}'s height`;
  if (r > 0.92) return `about as tall as ${p.name}`;
  if (r > 0.78) return `${top} about ${p.name}'s shoulders`;
  if (r > 0.62) return `${top} about ${p.name}'s chest`;
  if (r > 0.45) return `${top} about ${p.name}'s waist`;
  if (r > 0.27) return `about ${r > 0.4 ? "two-fifths" : r > 0.3 ? "a third" : "a quarter"} of ${p.name}'s height`;
  if (r > 0.15) return `about ${r > 0.22 ? "a quarter" : r > 0.18 ? "a fifth" : "a sixth"} of ${p.name}'s height`;
  return `much smaller than ${p.name}, about ${Math.max(1, Math.round(r * 100))}% of ${p.name}'s height`;
}

/**
 * "Real sizes: Mara is about 1.68 m tall, Sigeon about 33 cm…"; with `relative`, each one is also set against the
 * tallest person or character in the shot ("Sigeon … about a fifth of Mara's height").
 */
function sizes(cast: Character[], on = true, relative = false) {
  if (!on) return "";
  const sized = cast.filter((c) => c.height);
  if (!sized.length) return "";
  // A car is as much its length as its height: "about 1.8 m tall and 4.6 m long".
  const long = (c: Character, p?: Character) =>
    c.length && c.length > c.height! * 1.4 ? ` and ${formatHeight(c.length)} long${p ? `, about ${Math.round((c.length / p.height!) * 2) / 2} times as long as ${p.name} is tall` : ""}` : "";
  if (sized.length === 1 && cast.length === 1) {
    const c = sized[0];
    return `${Called(c)} is about ${formatHeight(c.height!)} tall${long(c)} in real life: draw ${c.kind === "object" ? "it" : "them"} true to that size against everything around ${c.kind === "object" ? "it" : "them"}.`;
  }
  const person = relative ? sized.filter((c) => c.kind === "person" || c.kind === "character").sort((a, b) => b.height! - a.height!)[0] : undefined;
  const list = sized.map((c, i) => `${i === 0 ? `${Called(c)} is` : called(c)} about ${formatHeight(c.height!)} tall${person && c !== person ? `${long(c, person)} (${against(c.height!, person, c)})` : long(c)}`);
  return `Real sizes: ${list.join(", ")}. Keep everyone true to these sizes against each other and their surroundings.`;
}

/** What the prompt says about the pictures, the cast's look and size. `tag` names picture k (0-based) as the model knows it. */
function note(cast: Character[], pics: Picture[], tag: (k: number) => string, video: boolean, sized = true, relative = false) {
  const parts: string[] = [];
  if (pics.length) {
    parts.push(`${pics.map((p, k) => `${tag(k)} is ${p.says}`).join("; ")}.`);
    const many = cast.length > 1;
    parts.push(
      `These pictures only show what ${many ? "each of them looks" : `${called(cast[0])} looks`} like: ${video ? "in the clip" : "in the picture"}, ${many ? "each appears" : `${called(cast[0])} appears`} once (unless the request says otherwise), in the scene's own light, never the sheet's layout, backdrop or side-by-side views.`,
    );
  }
  // Anyone who isn't in a picture is told in words.
  for (const c of cast.filter((x) => !pics.some((p) => p.who.includes(x)))) {
    parts.push(c.kind === "object" ? `${Called(c)}${c.traits ? `: ${c.traits.replace(/\.$/, "")}` : ""}.` : `${c.name} is ${what(c)}${c.traits ? `: ${c.traits.replace(/\.$/, "")}` : ""}.`);
  }
  const s = sizes(cast, sized, relative);
  if (s) parts.push(s);
  return parts.join(" ");
}

/**
 * The way a job sends its cast: as asked (the benchmark's `castMode`), else "refs". Qwen-Image 2.1 is the exception: it
 * reads separate photos as pictures to edit and gave everyone their photo's pose (standing, facing the camera, in the
 * photo's crop); with the sheet it stages the shot as asked (side by side, Oct 29 2026: the sheet won 16 to 10 overall
 * though the photos won identity 20 to 5).
 */
const modeOf = (gen: Pick<Generation, "params">, def?: Pick<ModelAvailability, "model">): CastMode => {
  const m = gen.params?.castMode;
  if (MODES.includes(m as CastMode)) return m as CastMode;
  return def && /qwen-image-2\./.test(def.model) ? "auto" : "refs";
};

/** The words of a job with the cast named, refined the way its engine would have (it then skips refining). */
async function words(job: EngineJob, cast: Character[], references: EngineReference[], ctx: EngineContext, kind: "image" | "video") {
  if (!job.refine) return withNames(job.prompt, cast);
  ctx.progress(0.03, "Reading the brief");
  const text = withNames(job.userPrompt, cast);
  return (await refinePrompt({ text, references, aspect: job.aspect, signal: ctx.signal, kind })).prompt;
}

/** Cast as it was sent before (the benchmark's baseline): face and sheet while five pictures fit, else the face; the engine refines. */
function legacyJob(job: EngineJob, cast: Character[], room: number): EngineJob {
  const roomy = job.references.length + cast.length * 2 <= 5;
  const references = [...job.references];
  for (const c of cast) {
    const label = `${c.name}, the ${castNoun(c.kind)} to keep consistent${c.traits ? ` (${c.traits.replace(/\.$/, "")})` : ""}`;
    const face = c.portrait ?? c.photos[0];
    for (const url of roomy ? [face, c.sheet] : [face ?? c.sheet]) {
      const file = fileOf(url);
      if (file && references.length - job.references.length < room) references.push({ path: file, label, role: "subject" });
    }
  }
  return { ...job, references, prompt: withNames(job.prompt, cast), userPrompt: withNames(job.userPrompt, cast) };
}

/* ------------------------------------------------------------------ "refs": a cast the way the big apps send one */

/*
 * Each member goes in as a few separate pictures of itself, the way Kling's elements, Vidu's subjects, Veo's ingredients
 * and Grok's references work. Its own photo comes first, lifted off its background (nothing redrawn, so nothing is
 * lost). Then a second look: another photo, the face up close, or a long thing's side. A side view goes in only when
 * the shot shows that side.
 * One line per member says which pictures are whom, numbered the way the model numbers them, and names in words the
 * small details pictures lose.
 * Crackio's research (Oct 29 2026): Black Forest Labs says FLUX reads a collage as a layout; Seedance guides report
 * multi-view sheets read as "several different people"; every big app keeps the user's own photo first.
 */

/** How a model calls the pictures it's sent: Qwen-Image 2.1 reads <image1>, Qwen's editor "picture 1", most others "image 1". */
export function pictureTag(def: Pick<ModelAvailability, "via" | "family" | "model">): (i: number) => string {
  if (/qwen-image-2\./.test(def.model)) return (i) => `<image${i + 1}>`;
  if (/qwen-image-edit/.test(def.model)) return (i) => `picture ${i + 1}`;
  return (i) => `image ${i + 1}`;
}

type RefPicture = { path: string; who: Character; role: "photo" | "face" | "hero" | SheetView };

/** Light grey: green and white backdrops bleed into the scenes drawn from them, grey doesn't. */
const GREY = { r: 210, g: 210, b: 210 };

/** A photo's subject on plain light grey, trimmed to it: the photo's own pixels, nothing redrawn. Null when no subject stands out. */
async function lifted(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  return cached(`lift1|${file}|${stat.mtimeMs}`, async () => {
    const matted = await withSubjectMatte(file);
    if (!matted) throw new Error("no clear subject");
    const { data, info } = await sharp(matted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let [x0, y0, x1, y1] = [info.width, info.height, -1, -1];
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++)
        if (data[(y * info.width + x) * 4 + 3] > 128) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    if (x1 < 0) throw new Error("no clear subject");
    const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
    const pad = Math.round(Math.max(w, h) * 0.06);
    const subject = await sharp(matted).extract({ left: x0, top: y0, width: w, height: h }).png().toBuffer();
    const placed = await sharp({ create: { width: w + pad * 2, height: h + pad * 2, channels: 3, background: GREY } })
      .composite([{ input: subject, left: pad, top: pad }])
      .png()
      .toBuffer();
    return sharp(placed).resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  }).catch(() => null);
}

/** One side of a member as a picture of its own: drawn on its own, or cut from a sheet drawn as one picture. */
async function sidePicture(c: Character, side: SheetView) {
  const own = fileOf(c.viewPictures?.[side]);
  if (own) return own;
  const i = viewsOf(c).indexOf(side);
  return i >= 0 ? view(c, i).catch(() => null) : null;
}

const BACK = /\b(from behind|from the back|back view|rear view|walks? away|walking away|back to (the )?camera|turned away|over (his|her|their|its) shoulder)\b/i;
const SIDE = /\b(in profile|profile view|side view|from the side|side-on)\b/i;

/** The side a shot shows a member from, when its words near the member say so ("walks away", "in profile"). */
function sideOf(c: Character, text: string): SheetView | null {
  const at = text.toLowerCase().indexOf(`@${c.handle}`);
  const near = at < 0 ? text : text.slice(Math.max(0, at - 50), at + c.handle.length + 60);
  return BACK.test(near) ? "back" : SIDE.test(near) ? "side" : null;
}

/** A shot that shows people whole: a face close-up among its pictures pulls the camera in (Grok cut a full-body shot at the waist). */
const WIDE = /\b(full[- ]body|full[- ]length|head[- ]to[- ]toe|(?:medium[- ]wide|wide|long|establishing) shot)\b/i;
const FRAMING = /\b(extreme close[- ]?up|medium close[- ]?up|close[- ]?up|full[- ]body|full[- ]length|head[- ]to[- ]toe|(?:medium[- ]wide|medium|wide|long|establishing|cowboy|over[- ]the[- ]shoulder) shot)\b/gi;

/** The framing the words ask for ("full-body wide shot", "close-up"), said again last: a reference photo pulls the camera toward its own crop. */
function framing(text: string) {
  const asked = [...new Set([...text.matchAll(FRAMING)].map((m) => m[1].toLowerCase()))];
  return asked.length ? `Keep the framing: ${asked.join(" ")}.` : "";
}

/** A member's pictures, the one that matters most first (`wide`: no face close-up). */
async function memberPictures(c: Character, side: SheetView | null, wide = false): Promise<RefPicture[]> {
  const out: RefPicture[] = [];
  const add = (file: string | null | undefined, role: RefPicture["role"]) => {
    if (file && !out.some((p) => p.path === file)) out.push({ path: file, who: c, role });
  };
  const photos = c.photos.map(fileOf).filter((f): f is string => Boolean(f));
  // Its own photo, as it is; its drawn front view when it was made from words.
  if (photos[0]) add((await lifted(photos[0])) ?? photos[0], "photo");
  else add((await sidePicture(c, "front")) ?? fileOf(c.portrait), "front");
  // A second look: a long thing's whole side, another photo, the face up close (a thing's clean shot). None for someone
  // in a wide shot: a closer look of them pulls the camera in.
  const close = !wide || c.kind === "object";
  if (c.kind === "object" && (c.long || c.sheetLayout === "rows") && !photos[1]) add(await sidePicture(c, "side"), "side");
  else if (close && photos[1]) add((await lifted(photos[1])) ?? photos[1], "photo");
  else if (close && c.kind !== "object") add(fileOf(c.portrait), "face");
  else if (c.kind === "object" && !photos[0]) add(fileOf(c.portrait), "hero");
  // The side the shot shows, when it isn't the front.
  if (side) add(await sidePicture(c, side), side);
  return out;
}

const pictureLabel = (p: RefPicture) => {
  const c = p.who;
  const name = c.kind === "object" ? called(c) : c.name;
  if (p.role === "photo") return `a photo of ${name}`;
  if (p.role === "face") return `${c.name}'s face up close`;
  if (p.role === "hero") return `another view of ${name}`;
  return `${name} seen from the ${p.role === "three-quarter" ? "front at three-quarters" : p.role}`;
};

/** Pictures for everyone within `room`: each member's first before anyone's second (Krea and Kling cut down the same way). */
function allot(lists: RefPicture[][], room: number, most = 3) {
  const take = lists.map(() => 0);
  for (let round = 0, left = room; round < most && left > 0; round++)
    for (let i = 0; i < lists.length && left > 0; i++)
      if (lists[i].length > round) {
        take[i]++;
        left--;
      }
  return lists.flatMap((l, i) => l.slice(0, take[i]));
}

const KEEP = `You read the description of a recurring subject and pick the few small details that make it recognizable and that a picture model tends to drop or change: jewelry, logos and printed words, patterns, marks and scars, distinctive accessories, an unusual color on a small part. Not its overall shape, main colors, hair or clothes in general.
Only what is there, never what isn't. Put any printed words in single quotes, as in: silver chain with an 'I LOVE NY' pendant.
Answer with one to three short noun phrases separated by semicolons, under 120 characters in all, or exactly: nothing to add`;

/** The member's small must-keep details in words ("silver chain with an 'I POOP ALONE' pendant"), read once from its traits. */
async function keepOf(c: Character, signal: AbortSignal): Promise<string> {
  if (!c.traits) return "";
  if (c.keep?.from === c.traits) return c.keep.details;
  const answer = await askText({ instructions: KEEP, text: c.traits, signal, timeoutMs: 30_000 }).catch(() => null);
  if (!answer) return "";
  const details = /^nothing to add/i.test(answer.trim()) ? "" : answer.trim().replace(/\.$/, "").replace(/\s*;\s*/g, ", ").slice(0, 160);
  const fresh = loadCharacter(c.id);
  if (fresh) saveCharacter({ ...fresh, keep: { from: c.traits, details } });
  return details;
}

/** "Juno is the freckled woman in image 1; image 2 shows Juno's face up close. Keep exactly as pictured on Juno: …" */
function roleLine(c: Character, mine: { p: RefPicture; k: number }[], tag: (k: number) => string, keep: string) {
  const it = c.kind === "object" ? "it" : c.name;
  const [first, ...more] = mine;
  const parts = [c.kind === "object" ? `${Called(c)} is the one in ${tag(first.k)}` : `${c.name} is the ${what(c).replace(/^(a|an|the) /i, "")} in ${tag(first.k)}`];
  for (const { p, k } of more)
    parts.push(
      p.role === "face"
        ? `${tag(k)} shows ${c.name}'s face up close`
        : p.role === "photo"
          ? `${tag(k)} is another photo of ${it}`
          : p.role === "hero"
            ? `${tag(k)} is another view of it`
            : `${tag(k)} shows ${it} from the ${p.role}`,
    );
  const details = [keep, c.notes?.trim().replace(/\.$/, "")].filter(Boolean).join("; ");
  return `${parts.join("; ")}.${details ? ` Keep exactly as pictured on ${c.kind === "object" ? called(c) : c.name}: ${details}.` : ""}`;
}

/** Someone in words alone (no room for a picture): what they are and the details to keep. */
const inWords = (c: Character, keep: string) =>
  `${c.kind === "object" ? Called(c) : `${c.name} is ${what(c)}`}${keep || c.notes ? `, with ${[keep, c.notes?.trim().replace(/\.$/, "")].filter(Boolean).join("; ")}` : ""}.`;

/**
 * Sizes, only where they'd go wrong: each member set against the tallest person when it's clearly bigger or smaller
 * ("about a fifth of Mara's height"), things worn or carried too (Grok Video drew a backpack bigger than its wearer when
 * nothing said its size); with no person, a small or huge thing's real size. Pictures don't carry scale.
 */
function scaleLine(cast: Character[]) {
  const person = cast.filter((c) => c.height && (c.kind === "person" || c.kind === "character")).sort((a, b) => b.height! - a.height!)[0];
  if (person) {
    const said = cast.filter((c) => c !== person && c.height && Math.abs(Math.log(c.height / person.height!)) > Math.log(1.18));
    return said.length ? `True sizes: ${said.map((c) => `${called(c)} is ${against(c.height!, person, c)}`).join("; ")}.` : "";
  }
  const odd = cast.filter((c) => c.height && (c.height < 0.6 || c.height > 2.4));
  return odd.length ? `True sizes: ${odd.map((c) => `${called(c)} is about ${formatHeight(c.height!)} tall${c.length && c.length > c.height! * 1.4 ? ` and ${formatHeight(c.length)} long` : ""}`).join("; ")}.` : "";
}

const once = (cast: Character[]) => (cast.length === 1 ? `${Called(cast[0])} appears once.` : `${list(cast.map((c, i) => (i ? called(c) : Called(c))))} each appear once.`);

const CAST_WORDS = {
  image: `You write prompts for an image model. Rewrite the person's request below as one precise English image prompt.
Rules:
- Keep every concrete detail they gave (subjects, actions, places, camera hints). Translate faithfully if it isn't in English.
- Do not add new subjects, objects, brands or text they didn't ask for.
- Where they imply it, make explicit: the setting, shot size and camera angle, lighting and time of day, mood.
- The cast is named in the request: people, animals and characters by name, things by what they are. Use each name or description exactly as written, and do not describe how any of them look: their pictures show that.
- Say how what they wear, hold or ride sits on them ("wears the backpack on his back", "holds the umbrella over her head").
- Never mention pictures, images or references.
- Natural prose, 2 to 4 sentences. No lists, no quotation marks, no preamble.
Output only the prompt.`,
  video: `You write prompts for a video model. Rewrite the person's request below as one precise English prompt for a short clip.
Rules:
- Keep every concrete detail they gave. Translate faithfully if it isn't in English. Add nothing they didn't imply.
- Say what moves and how: the action, the camera (static, push in, pull out, pan, orbit, handheld), the pace, and how the shot ends.
- If a start image is given, describe motion that starts from it; don't re-describe the whole picture.
- The cast is named in the request: people, animals and characters by name, things by what they are. Use each name or description exactly as written, and do not describe how any of them look: their pictures show that.
- Say how what they wear, hold or ride sits on them.
- Never mention pictures, images or references.
- One to three sentences of natural prose. No lists, no quotation marks, no preamble.
Output only the prompt.`,
};

/** The scene in the writer's words, with the cast named and never described (their pictures do that). */
async function sceneWords(job: EngineJob, cast: Character[], own: EngineReference[], ctx: EngineContext, kind: "image" | "video") {
  if (!job.refine) return withNames(job.prompt, cast);
  const named = withNames(job.userPrompt, cast);
  ctx.progress(0.03, "Reading the brief");
  const who = cast.map((c) => (c.kind === "object" ? `${called(c)} is a thing` : `${c.name} is ${what(c)}`)).join("; ");
  const out = await refinePrompt({ text: `${named}\n\n(Who's who, for you only: ${who}.)`, references: own, aspect: job.aspect, signal: ctx.signal, kind, instructions: CAST_WORDS[kind] });
  return out.by ? out.prompt : named;
}

/** The cast's lines around the scene: who is in which picture first, then the scene, then counts, framing and sizes. */
function bound(lines: string[], scene: string, cast: Character[], text: string, pictured = true) {
  const after = [once(cast), framing(text), scaleLine(cast)].filter(Boolean).join(" ");
  // Qwen-Image 2.1 gave everyone their photo's pose (standing still, smiling at the camera) until told the photos are looks only.
  const looks = pictured ? " The pictures show how they look; the request decides their pose, action, expression and framing." : "";
  return [`${lines.join(" ")}${looks}`, scene, after].filter(Boolean).join("\n\n");
}

/** A "refs" picture job: each member's pictures after yours, one line per member saying which they are. */
async function refsImageJob(job: EngineJob, def: ModelAvailability, cast: Character[], ctx: EngineContext): Promise<EngineJob> {
  const taken = job.references.length + (job.guide ? 1 : 0);
  const text = job.userPrompt || job.prompt;
  const wide = WIDE.test(text);
  const lists = await Promise.all(cast.map((c) => memberPictures(c, sideOf(c, text), wide)));
  const pics = allot(lists, Math.max(0, pictureSlots(def) - taken));
  const references: EngineReference[] = [...job.references, ...pics.map((p) => ({ path: p.path, label: pictureLabel(p), role: p.who.kind === "object" ? "product" : "subject" }))];
  const tag = (k: number) => pictureTag(def)(taken + k);
  const [scene, keeps] = await Promise.all([sceneWords(job, cast, job.references, ctx, "image"), Promise.all(cast.map((c) => keepOf(c, ctx.signal)))]);
  const lines = cast.map((c, i) => {
    const mine = pics.map((p, k) => ({ p, k })).filter((x) => x.p.who === c);
    return mine.length ? roleLine(c, mine, tag, keeps[i]) : inWords(c, keeps[i]);
  });
  return { ...job, references, prompt: bound(lines, scene, cast, text), refine: false };
}

/**
 * A "refs" clip on a model that takes reference pictures: they go in and the model builds the shot itself, with nothing
 * drawn first to lock a mistake in (xAI's reference-to-video needs no start frame). Beside a start frame when there is
 * one (yours, or the one drawn because you asked for it).
 */
async function refsClipJob(job: EngineJob, def: ModelAvailability, cast: Character[], ctx: EngineContext, room: number): Promise<EngineJob> {
  const text = job.userPrompt || job.prompt;
  const wide = WIDE.test(text);
  const lists = await Promise.all(cast.map((c) => memberPictures(c, sideOf(c, text), wide)));
  const grok = def.family === "grok-video";
  // Grok numbers the start frame <IMAGE_0>, then its references (`room` already counts yours); schema models number
  // their references alone, yours first.
  const yours = job.references.filter((r) => r.path !== job.start?.path).length;
  const before = grok ? (job.start ? 1 : 0) + (job.refImages?.length ?? 0) : yours;
  // Two pictures each at most: more faces of one person lock it but stiffen the motion (Grok users report).
  const pics = allot(lists, Math.max(0, Math.min(grok ? room : room - yours, cast.length * 2)), 2);
  const tag = (k: number) => pictureTag(def)(before + k);
  const [scene, keeps] = await Promise.all([sceneWords(job, cast, job.start ? [job.start] : [], ctx, "video"), Promise.all(cast.map((c) => keepOf(c, ctx.signal)))]);
  const lines = cast.map((c, i) => {
    const mine = pics.map((p, k) => ({ p, k })).filter((x) => x.p.who === c);
    return mine.length ? roleLine(c, mine, tag, keeps[i]) : inWords(c, keeps[i]);
  });
  const prompt = bound(lines, scene, cast, text);
  if (grok) return { ...job, refImages: [...(job.refImages ?? []), ...pics.map((p) => ({ path: p.path, label: pictureLabel(p) }))], prompt, refine: false };
  return { ...job, references: [...job.references, ...pics.map((p) => ({ path: p.path, label: pictureLabel(p), role: "subject" as const }))], prompt, refine: false };
}

/** The words alone, for a clip whose model sees the cast only in its first frame: names, what they are, what to keep. */
async function refsWordsJob(job: EngineJob, cast: Character[], ctx: EngineContext): Promise<EngineJob> {
  const text = job.userPrompt || job.prompt;
  const [scene, keeps] = await Promise.all([sceneWords(job, cast, job.start ? [job.start] : [], ctx, "video"), Promise.all(cast.map((c) => keepOf(c, ctx.signal)))]);
  return { ...job, prompt: bound(cast.map((c, i) => inWords(c, keeps[i])), scene, cast, text, false), refine: false };
}

/** Each member's first picture, for checking a take against. */
const coverFiles = async (cast: Character[]) => (await Promise.all(cast.map(async (c) => (await memberPictures(c, null))[0]?.path))).filter((f): f is string => Boolean(f));

/** A picture job with its cast's pictures and words in. */
export async function castImageJob(job: EngineJob, gen: Generation, def: ModelAvailability, cast: Character[], ctx: EngineContext): Promise<EngineJob> {
  const mode = modeOf(gen, def);
  if (mode === "refs") return refsImageJob(job, def, cast, ctx);
  const taken = job.references.length + (job.guide ? 1 : 0);
  if (mode === "legacy") return legacyJob(job, cast, Math.max(0, pictureSlots(def) - taken));
  const pics = await pictures(cast, Math.max(0, pictureSlots(def) - taken), mode, closeShot(job.userPrompt || job.prompt));
  const references: EngineReference[] = [...job.references, ...pics.map((p) => ({ path: p.path, label: p.label, role: p.who.every((c) => c.kind === "object") ? "product" : "subject" }))];
  const prompt = await words(job, cast, references, ctx, "image");
  const said = gen.params?.castNote === false ? "" : note(cast, pics, (k) => `Image ${taken + k + 1}`, false, gen.params?.castSize !== false, gen.params?.castRel !== false);
  // A count up front ("Exactly one Juno and one Tote") is only a benchmark switch: on FLUX.2 klein it made twins far more
  // likely (6 of 6 takes against 2 of 6), as if each name asked for another figure.
  const first = gen.params?.castFirst === true && pics.length ? `Exactly ${list(cast.map((c) => `one ${c.name}`))} in the picture. ` : "";
  return { ...job, references, prompt: `${first}${prompt}${said ? `\n\n${said}` : ""}`, refine: false };
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const CHECK = `You check a picture against the cast it should show.
Image 1 is the picture. Image 2 stacks the cast's reference sheets, top to bottom in the order listed: each sheet shows ONE subject drawn several times (front, side, back).
Count how many separate times each cast member appears in image 1: 0 if missing, 2 or more if the same one is there twice (two figures that look alike count as 2).
Then judge their sizes against each other, from their real heights given below and allowing for perspective (nearer looks bigger): list anyone drawn clearly too big or too small, such as a car whose roof only reaches a person's hip, a pigeon as big as a dog, or a handbag as big as a torso.
Answer with JSON only: {"counts": {"Name": 1}, "wrongSize": ["Name"]}`;

const CHECK_COVERS = `You check a picture against the cast it should show.
Image 1 is the picture. Image 2 shows each cast member once, side by side from left to right in the order listed.
Count how many separate times each cast member appears in image 1: 0 if missing, 2 or more if the same one is there twice (two figures or things that look alike count as 2, wherever they are: a second one in a car, a window or a reflection counts too).
Then judge their sizes against each other, from their real heights given below and allowing for perspective (nearer looks bigger): list anyone drawn clearly too big or too small, such as a car whose roof only reaches a person's hip, a pigeon as big as a dog, or a handbag as big as a torso.
Answer with JSON only: {"counts": {"Name": 1}, "wrongSize": ["Name"]}`;

/** Pictures side by side at one height, for a check that reads them left to right. */
async function row(files: string[]) {
  const stamps = await Promise.all(files.map((f) => fs.stat(f).then((s) => `${f}:${s.mtimeMs}`)));
  return cached(`row|${stamps.join("|")}`, async () => {
    const height = 768;
    const tiles = await Promise.all(files.map((f) => sharp(f).resize({ height }).png().toBuffer({ resolveWithObject: true })));
    const gap = 24;
    let left = 0;
    const layers = tiles.map((t) => {
      const layer = { input: t.data, left, top: 0 };
      left += t.info.width + gap;
      return layer;
    });
    return sharp({ create: { width: left - gap, height, channels: 3, background: "#202020" } }).composite(layers).png().toBuffer();
  });
}

/**
 * How far a picture is from showing each cast member exactly once (0: all there once), read by a vision model next to
 * their sheets (or, given `covers`, each one's first picture); 0 when no vision model answers, so a missing reader never
 * holds a clip up.
 */
async function offCount(data: Buffer, cast: Character[], signal: AbortSignal, covers?: string[]) {
  const sheets = covers ?? cast.map((c) => fileOf(c.sheet) ?? fileOf(c.portrait)).filter((f): f is string => Boolean(f));
  if (!sheets.length) return 0;
  const frame = path.join(/*turbopackIgnore: true*/ CACHE, `check-${createHash("sha1").update(data).digest("hex").slice(0, 20)}.png`);
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(frame, await sharp(data).resize({ width: 1280, height: 1280, fit: "inside" }).png().toBuffer());
  try {
    const answer = await askText({
      instructions: covers ? CHECK_COVERS : CHECK,
      text: `Cast in image 2, ${covers ? "left to right" : "top to bottom"}: ${cast.map((c) => `${c.name} (${what(c)}${c.height ? `, about ${formatHeight(c.height)} tall in real life` : ""})`).join("; ")}.`,
      references: [
        { path: frame, label: "the picture" },
        { path: sheets.length === 1 ? sheets[0] : covers ? await row(sheets) : await board(sheets), label: covers ? "the cast" : "the cast's reference sheets" },
      ],
      imageEdge: 1024,
      detail: "high",
      // Counting look-alikes takes a careful look: at low effort a second van and a second driver went unseen.
      ...(covers ? { effort: "medium" as const } : {}),
      signal,
      timeoutMs: 60_000,
    }).catch(() => null);
    const read = answer ? jsonObject<{ counts?: Record<string, unknown>; wrongSize?: unknown }>(answer) : null;
    const counts = read?.counts;
    if (!counts) return 0;
    // Someone at the wrong size counts as one miss too (a car drawn a metre tall beside a person spoils the shot as much).
    const wrong = Array.isArray(read.wrongSize) ? read.wrongSize.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
    return cast.reduce((off, c) => {
      const n = Number(Object.entries(counts).find(([k]) => k.toLowerCase() === c.name.toLowerCase())?.[1]);
      return (Number.isFinite(n) ? off + Math.abs(n - 1) : off) + (cast.length > 1 && wrong.includes(c.name.toLowerCase()) ? 1 : 0);
    }, 0);
  } finally {
    await fs.rm(frame, { force: true });
  }
}

/** How a clip's first frame is written from its description. */
const OPENING = `You write the prompt for the opening frame of a video shot: one still photograph the clip will start from.
From the shot described below, describe only its first moment, before the action happens: someone who "walks toward the car" stands several steps away from it, a bird that "lands on the table" is perched nearby (a chair back, the table's far edge), a door that "opens" is closed. Put everyone in a calm, clear starting pose (standing, seated, perched), never mid-air or blurred: the clip makes the motion. Give the setting, the light and the camera framing.
Say only what IS in the picture, in positive words: "Pip perches on the chair back beside the table" rather than "Pip has not landed yet"; never "not", "yet" or "has not". Name each of them once.
Keep every concrete detail given and every name exactly as written. Translate faithfully if it isn't in English. Add nothing that isn't implied.
Natural prose, 2 to 4 sentences, no camera moves (it's a still). No lists, no quotation marks, no preamble. Output only the prompt.`;

/**
 * Run a picture job with cast in it, and draw again (once) any take where someone is doubled or missing: open models
 * draw a sheet's subject twice in a busy shot now and then (FLUX.2 klein about one in four). Only shots with two or more
 * of the cast are checked; a lone subject is rarely doubled.
 */
export async function runCastImage(job: EngineJob, gen: Generation, cast: Character[], engine: Engine, ctx: EngineContext): Promise<EngineResult> {
  const first = await engine.run(job, ctx);
  if (cast.length < 2 || gen.params?.castCheck === false) return first;
  const covers = modeOf(gen, job) === "refs" ? await coverFiles(cast) : undefined;
  const outputs: EngineOutput[] = [];
  for (const [i, out] of first.outputs.entries()) {
    ctx.progress(0.95, first.outputs.length > 1 ? `Checking take ${i + 1}` : "Checking the cast");
    const off = await offCount(out.data, cast, ctx.signal, covers);
    if (off === 0 || ctx.signal.aborted) {
      outputs.push(out);
      continue;
    }
    ctx.progress(0.5, "Someone came out twice or not at all: drawing it again");
    const again = (await engine.run({ ...job, count: 1 }, ctx).catch(() => null))?.outputs[0];
    outputs.push(again && (await offCount(again.data, cast, ctx.signal, covers)) < off ? again : out);
  }
  return { ...first, outputs };
}

const SEEN = `You check one reference picture of a subject against its front view.
Image 1 is the new picture; image 2 shows the same subject from the front.
Answer with JSON only: {"seen": "front" | "three-quarter" | "side" | "back"}: which side of the subject image 1 shows. "front" when image 1 shows the same side of it as image 2, even turned a little.`;

/** Which side of a Cast member a picture shows, read next to its front view; null when no vision model answers. */
async function seenFrom(data: Buffer, front: string, signal: AbortSignal, other?: { view: SheetView; looks?: string }) {
  const file = path.join(/*turbopackIgnore: true*/ CACHE, `seen-${createHash("sha1").update(data).digest("hex").slice(0, 20)}.png`);
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, await sharp(data).resize({ width: 1024, height: 1024, fit: "inside" }).png().toBuffer());
  try {
    const answer = await askText({
      instructions: SEEN,
      // What its other side would show, so details alike on both (a backpack's straps) don't decide it.
      text: `Which side of the subject does image 1 show?${other?.looks ? ` Seen from the ${other.view}, it shows ${other.looks.replace(/\.$/, "")}.` : ""}`,
      references: [
        { path: file, label: "the new picture" },
        { path: front, label: "the front view" },
      ],
      imageEdge: 768,
      signal,
      timeoutMs: 60_000,
    }).catch(() => null);
    const seen = answer ? jsonObject<{ seen?: unknown }>(answer)?.seen : null;
    return typeof seen === "string" ? seen.toLowerCase() : null;
  } finally {
    await fs.rm(file, { force: true });
  }
}

/**
 * A side or back view for a Cast sheet, checked: a model handed the front view tends to draw the front again (a guitar's
 * "side" and "back" and a cat's "back" came out as their fronts). When a vision model says it did, the view is drawn once
 * more, turned round, with the front view last among its references.
 */
export async function runCastView(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult> {
  const asked = (gen.params?.cast as { id?: string; view?: SheetView }[] | undefined)?.[0];
  const first = await engine.run(job, ctx);
  const c = asked?.id ? loadCharacter(asked.id) : null;
  const front = fileOf(c?.viewPictures?.front);
  const view = asked?.view;
  if (!front || (view !== "side" && view !== "back") || !first.outputs[0] || ctx.signal.aborted) return first;
  ctx.progress(0.95, `Checking it shows the ${view}`);
  const looks = c?.kind === "object" ? c.viewLooks?.[view] : c ? FIGURE_LOOKS[c.kind][view] : undefined;
  if ((await seenFrom(first.outputs[0].data, front, ctx.signal, { view, looks })) !== "front") return first;
  ctx.progress(0.5, `That came out as the front again: turning it to the ${view}`);
  const turn = view === "back" ? "Turned all the way round, so the side that faces away in the reference pictures faces the camera: " : "Turned a quarter of the way round, in profile: ";
  const again = await engine.run({ ...job, prompt: `${turn}${job.prompt}`, references: [...job.references.slice(1), ...job.references.slice(0, 1)] }, ctx).catch(() => null);
  return again?.outputs[0] ? again : first;
}

/**
 * How many reference pictures a clip model takes beside (or instead of) a start frame: Grok's as `reference_images`
 * (<IMAGE_1>, <IMAGE_2>…; the start frame is <IMAGE_0>), models driven from their schema (fal, Comfy Router: Kling's
 * elements, Veo's and Seedance's references) through their `refs` field. A clip-swap model's pictures are its people.
 */
const clipRefs = (def: ModelAvailability) => (def.caps?.video ? 0 : (def.caps?.refs?.max ?? 0));

/** The model after `image` in the first frame's line (another way to draw it when `image` keeps doubling someone). */
async function nextFrameModel(image: ModelAvailability, localClip: boolean) {
  // A cloud clip stays in the cloud (a local model may sit on a slow card); a clip on your GPU stays on open models first.
  const models = (await listModels()).filter((m) => m.kind === "image" && m.available && castFits(m) && m.id !== image.id && (localClip || m.via !== "comfy-local"));
  const order = framePrefer(models, localClip);
  return order.map((id) => models.find((m) => m.id === id)).find((m): m is ModelAvailability => Boolean(m)) ?? null;
}

/** The image model that draws a clip's first frame with its cast: Cast's Auto (open models first for a clip on your GPU), unless a job names one. */
async function frameModel(asked: unknown, localClip: boolean): Promise<{ model: ModelAvailability | null; instead?: string }> {
  const models = (await listModels()).filter((m) => m.kind === "image");
  const auto = pickAuto("image", models, (await getSettings()).models ?? {}, framePrefer(models, localClip), castFits);
  if (typeof asked !== "string" || asked === "auto") return { model: auto };
  const m = models.find((x) => x.id === asked);
  if (m?.available && castFits(m)) return { model: m };
  // The model asked for can't draw the cast in (it takes no pictures, or isn't connected): Cast's own pick does, and says so.
  return { model: auto, instead: `${m?.name ?? "The model you picked"} ${!m ? "isn't available" : !m.available ? "isn't connected" : "can't take your cast's pictures"}` };
}

/**
 * A clip job with its cast in: as reference pictures where the model takes them, else a first frame drawn with them
 * when there's no start frame, else in words. Returns the job, and the first frame when one was drawn.
 */
export async function castClipJob(
  job: EngineJob,
  gen: Generation,
  def: ModelAvailability,
  cast: Character[],
  ctx: EngineContext,
): Promise<{ job: EngineJob; startUrl?: string; frameModel?: string; frameNote?: { prompt: string; checks: number[]; instead?: string } }> {
  const mode = modeOf(gen, def);
  const room = clipRefs(def) - (job.refImages?.length ?? 0);
  const takesStart = Boolean(def.caps?.image || def.caps?.keyframes || !def.caps);
  // Classic Grok video takes reference pictures only without a start frame (xAI: it "rejects combining image with reference inputs").
  const refsBeside = (start: EngineReference | undefined) => room > 0 && def.via !== "comfy-local" && !(def.model === "grok-imagine-video" && start);
  // "refs": a model that takes reference pictures gets them and builds the shot itself, nothing drawn first; a first frame
  // is drawn only when you ask for one, or for a model that takes no references.
  if (mode === "refs" && refsBeside(job.start) && gen.params?.castFrame !== true) return { job: await refsClipJob(job, def, cast, ctx, room) };

  let startUrl: string | undefined;
  let frameBy: string | undefined;
  // What the first frame was drawn from, and how far each draw was from showing everyone once (for the take's details).
  let frameNote: { prompt: string; checks: number[]; instead?: string } | undefined;
  let next = job;
  // An open model that takes a reference sheet (LTX-2.3's "ingredients") builds a one-subject shot from the sheet itself,
  // with no first frame (Crackio's video benchmark, Oct 28 2026: 8 of 10 for identity on a close-up). With two or more it
  // left someone out in 3 of 4 clips (identity 4.3), so a group gets a checked first frame and the clip animates that.
  // ("refs" leaves it out: that LoRA was trained on black sheets with a location panel, which Crackio's sheets are not.)
  const sheetModel = mode !== "refs" && def.via === "comfy-local" && room > 0 && mode !== "words" && (cast.length === 1 || gen.params?.castSheet === true);
  // `castFrame: false` (you turned it off): no first frame is drawn; the cast goes in as reference pictures where the clip
  // model takes them on their own, else in words.
  const frameOff = gen.params?.castFrame === false;
  const drawFirst = frameOff ? false : sheetModel ? gen.params?.castFrame === true : true;
  // No start frame, and the model can't be shown the cast any other way (Grok's references need a start frame too, as
  // Crackio sends them): draw the opening frame with the cast, on the image model Cast uses (or the one asked for).
  if (!job.start && takesStart && mode !== "words" && drawFirst) {
    const { model: image, instead } = await frameModel(gen.params?.frameModel, def.via === "comfy-local");
    const engine = image?.via ? engineFor(image.via) : null;
    if (!image || !engine) throw new EngineError("Drawing the first frame with your cast needs an image model that takes pictures.", "Connect one in Connections, or add a start frame.");
    const who = cast.map((c) => c.name).join(" and ");
    ctx.progress(0.02, instead ? `${instead}: drawing the first frame with ${who} on ${image.name}` : `Drawing the first frame with ${who} on ${image.name}`);
    // The first moment of the shot, before its action (drawn from the whole description, a model draws where it ends).
    const asked = withNames(job.userPrompt || job.prompt, cast);
    const opening = job.refine ? (await refinePrompt({ text: asked, aspect: job.aspect, signal: ctx.signal, instructions: OPENING }).catch(() => null))?.prompt : null;
    const stillPrompt = opening && opening !== asked ? opening : `The opening frame of a film shot, as one still photograph: ${asked}`;
    const still: EngineJob = {
      ...job,
      kind: "image",
      mode: "image",
      model: image.model,
      via: image.via ?? undefined,
      family: image.family,
      caps: image.caps ?? undefined,
      options: { ...(image.via === "comfy-local" && job.options?.machine ? { machine: job.options.machine } : {}), resolution: image.via === "comfy-local" ? "1k" : "2k" },
      prompt: stillPrompt,
      userPrompt: stillPrompt,
      refine: false,
      count: 1,
      references: job.references.filter((r) => !/start frame|end frame/i.test(r.label ?? "")),
      refImages: undefined,
      keyframes: undefined,
      start: undefined,
      end: undefined,
    };
    const prepare = async (m: ModelAvailability) =>
      castImageJob({ ...still, model: m.model, via: m.via ?? undefined, family: m.family, caps: m.caps ?? undefined }, gen, m, cast, {
        signal: ctx.signal,
        progress: (v, stage) => ctx.progress(0.02 + v * 0.06, `First frame: ${stage ?? "drawing"}`),
      });
    const drawn = await prepare(image);
    // The clip keeps whatever the first frame shows, a second Juno included: it's checked and drawn again when someone is
    // doubled or missing (the cast benchmark's open-model clips got their doubles from the first frame, not the video model).
    // A model that doubles someone twice in a row tends to keep doing it: the third try goes to the next model in line.
    let best: { data: Buffer; off: number; by: string } | null = null;
    const checks: number[] = [];
    const covers = mode === "refs" ? await coverFiles(cast) : undefined;
    for (let attempt = 0; attempt < 3 && (!best || best.off > 0); attempt++) {
      const other = attempt === 2 ? await nextFrameModel(image, def.via === "comfy-local") : null;
      const [runner, runJob] = other?.via && engineFor(other.via) ? [engineFor(other.via)!, await prepare(other)] : [engine, drawn];
      const { outputs } = await runner.run(runJob, { signal: ctx.signal, progress: (v, stage) => ctx.progress(0.02 + v * 0.06, `First frame: ${stage ?? "drawing"}`) });
      if (!outputs[0]) continue;
      if (gen.params?.castCheck === false) {
        best = { data: outputs[0].data, off: 0, by: image.name };
        break;
      }
      ctx.progress(0.08, attempt ? "Checking the first frame again" : "Checking the first frame");
      const off = await offCount(outputs[0].data, cast, ctx.signal, covers);
      checks.push(off);
      if (!best || off < best.off) best = { data: outputs[0].data, off, by: other?.name ?? image.name };
    }
    if (!best) throw new EngineError("The first frame didn't render.", "Try again, or add a start frame.");
    frameNote = { prompt: stillPrompt, checks, ...(instead ? { instead } : {}) };
    const saved = await saveUpload(best.data);
    const file = urlToPath(saved.url)!;
    startUrl = saved.url;
    frameBy = best.by;
    next = { ...job, start: { path: file, label: "the start frame" }, references: [{ path: file, label: "the start frame", role: "subject" }, ...job.references] };
  }

  // "refs" with a first frame (asked for, or the model takes no references): the pictures go beside it where they can.
  if (mode === "refs") {
    const done = refsBeside(next.start) ? await refsClipJob(next, def, cast, ctx, room) : await refsWordsJob(next, cast, ctx);
    return { job: done, startUrl, frameModel: frameBy, frameNote };
  }

  // An open reference-sheet model: everyone's sheet (and face) in one composite picture, and the prompt split the way
  // its IC-LoRA was trained: what the sheet shows where, then the shot.
  if (sheetModel) {
    const ratio = aspectById(job.aspect);
    const sheet = await ingredientsSheet(cast, ratio.w / ratio.h);
    // No names anywhere: the model wrote "JUNO" across a clip when it read one. Each one is called by what they are.
    const unnamed = (text: string) => cast.reduce((t, c) => t.replace(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), `the ${what(c).replace(/^(a|an|the) /i, "")}`), text);
    const target = unnamed(await words(next, cast, next.start ? [next.start] : [], ctx, "video"));
    const size = unnamed(sizes(cast, gen.params?.castSize !== false, gen.params?.castRel !== false));
    const prompt = `### Reference Sheet Description ${sheet.regions
      .map(({ c, where }) => `**${where} (${c.kind === "object" ? "Prop" : "Character"}):** ${what(c)}${c.traits ? `: ${c.traits.replace(/\.$/, "")}` : ""}. Shown whole from the ${viewWords(viewsOf(c))}${c.kind !== "object" && c.portrait ? `, with a close-up of ${c.kind === "pet" ? "its" : "the"} face` : ""}.`)
      .join(" ")}\n\n### Target Description ${target}${size ? ` ${size}` : ""} One continuous shot with no cuts, from its first frame in the scene itself (never the reference sheet or a close-up from it), with the scene's own background; each of them appears once, exactly as on the reference sheet. No text, captions or labels anywhere in the picture.`;
    const references = [...next.references, { path: sheet.path, label: "the reference sheet", role: "subject" }];
    return { job: { ...next, references, prompt, refine: false }, startUrl, frameModel: frameBy, frameNote };
  }

  // Beside the start frame (or, for a reference-to-video model, instead of one), the cast's pictures as references. (An
  // open model's only reference is the sheet mode above: a group's clip just animates its checked first frame.) With the
  // first frame turned off they go without one, except to Grok, whose references ride beside its start frame.
  const alone = frameOff && def.family !== "grok-video";
  if ((next.start || !takesStart || alone) && room > 0 && mode !== "words" && def.via !== "comfy-local") {
    const close = closeShot(job.userPrompt || job.prompt);
    if (def.family === "grok-video") {
      const pics = await pictures(cast, Math.min(room, cast.length * 2), mode, close);
      const offset = next.refImages?.length ?? 0;
      const refImages = [...(next.refImages ?? []), ...pics.map((p) => ({ path: p.path, label: p.label }))];
      // The prompt writer sees only the start frame: Grok knows the references by tag (<IMAGE_1>…), which the note gives.
      const prompt = await words(next, cast, next.start ? [next.start] : [], ctx, "video");
      const said = gen.params?.castNote === false ? "" : note(cast, pics, (k) => `<IMAGE_${offset + k + 1}>`, true, gen.params?.castSize !== false, gen.params?.castRel !== false);
      return { job: { ...next, refImages, prompt: said ? `${prompt}\n\n${said}` : prompt, refine: false }, startUrl, frameModel: frameBy, frameNote };
    }
    // Schema-driven models take references after the start frame in `job.references` (engines/generic: the start frame
    // fills the picture field, the rest the reference field; a model with no start frame field takes them all as references).
    // A model without a start frame field takes a picture you gave it as one of its references too.
    const taken = next.references.filter((r) => !takesStart || (r !== next.start && r.path !== next.start?.path)).length;
    const pics = await pictures(cast, Math.min(room - taken, cast.length * 2), mode, close);
    if (pics.length) {
      const references = [...next.references, ...pics.map((p) => ({ path: p.path, label: p.label, role: "subject" }))];
      const prompt = await words(next, cast, next.start ? [next.start] : [], ctx, "video");
      const said = gen.params?.castNote === false ? "" : note(cast, pics, (k) => `Reference image ${taken + k + 1}`, true, gen.params?.castSize !== false, gen.params?.castRel !== false);
      return { job: { ...next, references, prompt: said ? `${prompt}\n\n${said}` : prompt, refine: false }, startUrl, frameModel: frameBy, frameNote };
    }
  }

  // Otherwise the start frame shows them (drawn just now, or yours), and the words name them, look and size.
  const prompt = await words(next, cast, next.references, ctx, "video");
  const said = gen.params?.castNote === false ? "" : note(cast, [], () => "", true, gen.params?.castSize !== false, gen.params?.castRel !== false);
  return { job: { ...next, prompt: said ? `${prompt}\n\n${said}` : prompt, refine: false }, startUrl, frameModel: frameBy, frameNote };
}
