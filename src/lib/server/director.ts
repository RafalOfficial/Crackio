import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { saveUpload, urlToPath } from "./media";
import { withSubjectMatte } from "./vision";
import { briefPictures, buildPlacePrompt, cameraWords, compileBrief, compileScene, finishPrompt, lightingPhrase, onceRule, planPictures, swapPrompt, type ShotPicture } from "@/lib/director/compile";
import { subjectViews, viewPrompt, type SubjectView } from "@/lib/director/views";
import { angleDelta, frameElements, horizontalFov, shotCamera, verticalFov } from "@/lib/director/camera";
import { photoCamera } from "@/lib/director/reconstruct";
import { LEGACY_SHEET_VIEWS } from "@/lib/cast/types";
import { loadCharacter } from "./cast-store";
import { sheetViews, viewsOf } from "./cast-sheet";
import { sizeFor, type AspectId } from "@/lib/shot";
import { imageSlots, type Caps } from "@/lib/models/caps";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import type { ElementKind, PlaceView, Scene, SceneElement } from "@/lib/director/types";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineReference, type EngineResult } from "@/lib/engines/types";
import type { Generation } from "@/lib/generations/types";

/**
 * A Director take, fitted to the model it runs on. The page sends the set (scene), the blocking frame it rendered
 * and every subject's picture; here each subject gets a clean picture of its own (the cut-out on a plain light
 * background, nothing else in it), as many as the model takes, and the prompt is written for exactly the pictures
 * sent, numbered in their order. Models that take fewer pictures get the cast on one sheet; models that take none
 * get words only.
 */
const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director");
/** Bump when cards, sheets or reads change. */
const VERSION = 3;
const CARD_EDGE = 1024;
const BACKGROUND = { r: 236, g: 236, b: 236, alpha: 1 };

/** How many pictures a model takes: its schema's slots, else the catalog's count, within its engine's own limit. */
export function pictureSlots(def: { caps?: Caps | null; maxRefs: number; via?: string | null; model: string }) {
  const n = def.caps ? imageSlots(def.caps) : def.maxRefs;
  return n;
}

async function cachedFile(key: string, make: () => Promise<Buffer>) {
  const file = path.join(DIR, `${createHash("sha1").update(`${VERSION}|${key}`).digest("hex")}.png`);
  try {
    await fs.access(file);
    return file;
  } catch {
    const png = await make();
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(file, png);
    return file;
  }
}

/** A subject's picture for the model: trimmed to the subject with some room around it, on a plain light background. */
async function card(file: string, cutout: boolean) {
  const stat = await fs.stat(file);
  return cachedFile(`card|${file}|${stat.size}|${stat.mtimeMs}|${cutout}`, async () => {
    if (!cutout) return sharp(file).rotate().resize({ width: CARD_EDGE, height: CARD_EDGE, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] <= 24) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) [minX, minY, maxX, maxY] = [0, 0, info.width - 1, info.height - 1];
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const pad = Math.round(Math.max(w, h) * 0.08);
    const trimmed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .extract({ left: minX, top: minY, width: w, height: h })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return sharp(trimmed).flatten({ background: BACKGROUND }).resize({ width: CARD_EDGE, height: CARD_EDGE, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  });
}

/** A card padded with its own background to an aspect ratio, the subject centered (for drawings in that shape). */
async function framedCard(file: string, aspect: AspectId) {
  const stat = await fs.stat(file);
  return cachedFile(`framed|${file}|${stat.size}|${aspect}`, async () => {
    const m = await sharp(file).metadata();
    const w = m.width ?? 1024;
    const h = m.height ?? 1024;
    const [aw, ah] = aspect.split(":").map(Number);
    const ratio = aw / ah;
    const W = Math.max(w, Math.round(h * ratio));
    const H = Math.max(h, Math.round(w / ratio));
    const left = Math.floor((W - w) / 2);
    const top = Math.floor((H - h) / 2);
    return sharp(file)
      .extend({ left, right: W - w - left, top, bottom: H - h - top, background: BACKGROUND })
      .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  });
}

/** Several subjects' pictures side by side at the same height, for a model with fewer slots than subjects. */
async function sheet(cards: string[]) {
  const stats = await Promise.all(cards.map((c) => fs.stat(c)));
  return cachedFile(`sheet|${cards.join("|")}|${stats.map((s) => s.size).join(",")}`, async () => {
    const H = 768;
    const gap = 40;
    const tiles = await Promise.all(
      cards.map(async (c) => {
        const buf = await sharp(c).resize({ height: H, width: Math.round(H * 1.6), fit: "inside" }).png().toBuffer();
        const meta = await sharp(buf).metadata();
        return { buf, width: meta.width ?? H, height: meta.height ?? H };
      }),
    );
    const width = tiles.reduce((s, t) => s + t.width, 0) + gap * (tiles.length + 1);
    let x = gap;
    const composite = tiles.map((t) => {
      const at = { input: t.buf, left: x, top: gap + Math.round((H - t.height) / 2) };
      x += t.width + gap;
      return at;
    });
    const png = await sharp({ create: { width, height: H + gap * 2, channels: 3, background: BACKGROUND } }).composite(composite).png().toBuffer();
    return sharp(png).resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  });
}

/**
 * A Director take as a brief (since the 2026-10-28 study): each subject's own picture (people and pets as their Cast
 * sheet, things as their photo), the location photo, and a camera-first brief written from the set. No 3D frame:
 * among the references models ignore it, alone they copy it. Null for older takes.
 */
export async function briefInputs(gen: Generation, slots: number): Promise<{ references: EngineReference[]; prompt: string } | null> {
  const scene = gen.params?.scene as Scene | undefined;
  if (gen.params?.director !== 3 || !scene) return null;
  const { prompt, subjects, place } = compileBrief(scene, Math.max(1, slots));
  const references: EngineReference[] = [];
  for (const s of subjects) {
    const file = urlToPath(s.url);
    if (!file) throw new EngineError(`Crackio can't find ${s.el.name}'s picture.`, "Add them again.");
    references.push({ path: file, label: s.sheet ? `${s.el.name}, reference sheet` : s.el.name, role: s.el.kind === "product" ? "product" : "subject" });
  }
  const placeFile = place ? urlToPath(place.url) : null;
  if (placeFile) references.push({ path: placeFile, label: scene.place.text || "the location", role: "place" });
  return { references, prompt };
}

/**
 * The pictures and prompt for a Director take on a model that takes `slots` pictures, or null for takes made before
 * the blocking frame (they run as they were sent).
 */
export async function directorInputs(gen: Generation, slots: number): Promise<{ references: EngineReference[]; prompt: string } | null> {
  const scene = gen.params?.scene as Scene | undefined;
  const blockingUrl = gen.params?.blockingUrl;
  if (gen.params?.director !== 2 || !scene || typeof blockingUrl !== "string") return null;
  const blocking = urlToPath(blockingUrl);
  if (!blocking) return null;

  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const cardOf = async (id: string) => {
    const image = byId.get(id)?.image;
    const file = image ? urlToPath(image.url) : null;
    return file ? card(file, image!.cutout) : null;
  };

  // A picture that can't be found is left out, and the prompt is written for the ones that are sent.
  const sent: ShotPicture[] = [];
  const references: EngineReference[] = [];
  for (const p of planPictures(scene, slots)) {
    if (p.role === "blocking") {
      sent.push(p);
      references.push({ path: blocking, label: "the blocking frame", role: "guide" });
    } else if (p.role === "place") {
      const file = scene.place.image ? urlToPath(scene.place.image.url) : null;
      if (!file) continue;
      sent.push(p);
      references.push({ path: file, label: "the location", role: "place" });
    } else {
      const found = (await Promise.all(p.ids.map(async (id) => ({ id, file: await cardOf(id).catch(() => null) })))).filter((c): c is { id: string; file: string } => Boolean(c.file));
      if (!found.length) continue;
      sent.push({ role: "cast", ids: found.map((c) => c.id) });
      const file = found.length === 1 ? found[0].file : await sheet(found.map((c) => c.file));
      references.push({ path: file, label: found.map((c) => byId.get(c.id)?.name ?? "subject").join(", "), role: "subject" });
    }
  }
  return { references, prompt: compileScene(scene, { pictures: sent }).prompt };
}

const READ = `You look at a photo of one subject that will be staged in a film shot, and say what it is, so an image model can redraw exactly this subject from any angle.
Answer with JSON only: {"kind": "...", "noun": "...", "identity": "...", "height": 0, "view": "..."}
- kind: "person", "animal", "vehicle" (cars, motorbikes, bicycles, boats, planes), "product" (things shown as a product: bottles, shoes, watches, phones, bags, cosmetics, packaging) or "object" (anything else: furniture, plants, props).
- noun: a short noun phrase for exactly this subject with its most telling look, 3 to 9 words: "a man in a flat cap and black face mask", "a matte black Tesla Cybertruck", "a golden retriever", "a frosted glass perfume bottle".
- identity, 35 to 70 words: what makes it look like itself, in concrete visual words. A person: face, skin tone in plain color words (light, olive, brown, dark), hair, facial hair, build, then clothing and accessories with colors and materials. A vehicle: make and model when you recognize it, body shape, color and finish, wheels, lights. A product: shape, proportions, materials, colors, graphics, logos and lettering (quote short text exactly). An animal: species, breed, coat colors and markings, build. Never name an ethnicity, race or nationality, and nothing about personality, mood or the photo's background.
- height: its real height in meters as it would stand in a scene (a person 1.5 to 1.95, a car 1.3 to 1.9, a dog 0.3 to 0.8, a bottle 0.1 to 0.35).
- view: which way it is turned in the photo, judged by where its front (face, headlights, label) points in the image:
  "front" (its front faces the camera), "front-left" (we see its front, and it points toward the image's left), "left" (side-on, its front points to the image's left), "back-left" (mostly its back, its front points away and to the image's left), "back" (its back faces the camera), "back-right", "right", "front-right" (the same, toward the image's right).`;

export type SubjectRead = { kind: ElementKind; noun: string; identity: string; height: number | null; around: number | null };
/** Where the photo camera is around a subject turned each way: one facing image left was shot from its left. */
const AROUND: Record<string, number> = { front: 0, "front-left": 45, left: 90, "back-left": 135, back: 180, "back-right": -135, right: -90, "front-right": -45 };
const KINDS: ElementKind[] = ["person", "animal", "vehicle", "product", "object"];

/** What a cast picture shows (read once by a vision model, cached by the picture), or null without one. */
export async function readSubject(file: string): Promise<SubjectRead | null> {
  const bytes = await fs.readFile(file);
  const cache = path.join(DIR, "read", `${createHash("sha1").update(bytes).update(`|${VERSION}`).digest("hex")}.json`);
  try {
    return JSON.parse(await fs.readFile(cache, "utf8")) as SubjectRead;
  } catch {
    /* not read yet */
  }
  const answer = await askText({
    instructions: READ,
    text: "What is this subject?",
    references: [{ path: file, label: "the subject" }],
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    imageEdge: 1024,
    detail: "high",
    effort: "low",
    timeoutMs: 45_000,
  }).catch(() => null);
  const raw = answer ? jsonObject<Partial<{ kind: string; noun: string; identity: string; height: number; view: string }>>(answer) : null;
  if (!raw) return null;
  const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, n) : "");
  const kind = KINDS.find((k) => k === raw.kind);
  const noun = tidy(raw.noun, 90);
  if (!kind || !noun) return null;
  const height = typeof raw.height === "number" && raw.height > 0.03 && raw.height < 12 ? Math.round(raw.height * 100) / 100 : null;
  const around = typeof raw.view === "string" && raw.view.toLowerCase() in AROUND ? AROUND[raw.view.toLowerCase()] : null;
  const read: SubjectRead = { kind, noun, identity: tidy(raw.identity, 700), height, around };
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, JSON.stringify(read));
  return read;
}

/* ------------------------------------------------------------------ composed shots */

/** Share of a plate that's the flat "unknown" gray (capture.ts UNKNOWN_GRAY, #8a8a8a). */
async function unknownShare(file: string | Buffer) {
  const { data, info } = await sharp(file).resize(192, 108, { fit: "fill", kernel: "nearest" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let gray = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.abs(data[i] - 138) <= 3 && Math.abs(data[i + 1] - 138) <= 3 && Math.abs(data[i + 2] - 138) <= 3) gray++;
  }
  return gray / (data.length / info.channels);
}

/**
 * The plate with what the location photo never showed (flat gray) filled in by the shot's model, keeping the rest:
 * a composite on a whole place reads as a photograph, and the last pass has less to invent. Null when there's
 * nothing to fill.
 */
/**
 * The plate with its unseen parts made whole: where the set is torn into gray shreds (a car seen from far off the
 * photo's angle, its stretched paint between the holes), the whole patch goes gray, so the model draws it fresh.
 * Open edit models keep shreds and smears as they are (the user's gas station on Qwen-Image-Edit 2511 and FLUX.2 klein:
 * a melted second hood in front); Grok redraws them, but needs no help.
 */
async function solidUnknown(file: string) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const mask = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) if (Math.abs(data[i * 3] - 138) <= 3 && Math.abs(data[i * 3 + 1] - 138) <= 3 && Math.abs(data[i * 3 + 2] - 138) <= 3) mask[i] = 255;
  const near = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(4, W / 160)).extractChannel(0).raw().toBuffer();
  let changed = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] || near[i] < 100) continue;
    data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = 138;
    changed++;
  }
  if (changed < W * H * 0.002) return file;
  const out = path.join(DIR, `solid-${createHash("sha1").update(data).digest("hex").slice(0, 16)}.png`);
  await fs.mkdir(DIR, { recursive: true });
  await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
  return out;
}

async function fillPlate(given: string, scene: Scene, job: EngineJob, engine: Engine, ctx: EngineContext, things: string[], clean = false) {
  const photo = scene.place.image ? urlToPath(scene.place.image.url) : null;
  const setting = photo ? await settingOf(photo, scene.place.text) : scene.place.text;
  const local = job.via === "comfy-local";
  let plate = given;
  if ((await unknownShare(given)) >= 0.01) {
    plate = await solidUnknown(given);
    // Mostly unseen (a camera far above or below where the photo was taken): the model draws most of it, so it's told
    // the camera too. Measured on Grok 2.0: a plate 95% gray under a camera looking steeply down came back at eye level.
    const camera = (await unknownShare(plate)) > 0.3 ? cameraWords(scene) : undefined;
    // A cloud model redraws the whole picture as it fills (told to); a local one fills only the holes, then redraws.
    const filled = await fillUnknown(plate, { setting, camera, things, redraw: !local && !clean }, job, engine, ctx);
    if (!local || clean) return filled;
    plate = filled;
  }
  // A plate from the surround is real pictures' pixels already: redrawn, it only came back painted (FLUX 3 Klein).
  return clean ? plate : redrawPlate(plate, things, job, engine, ctx);
}

/**
 * The plate made one photograph: the same camera, layout and things, every surface drawn fresh. The 3D set it was
 * rendered from shows seams between the place's views, smears and melted shapes where the camera left the photo's spot;
 * an edit keeps all of it (the user's take: the sky in square panels, the Mustang melting). A cloud model redraws the
 * whole picture, lined up again after; a local one redraws it over itself at half strength (`redrawLatent`).
 */
async function redrawPlate(file: string, things: string[], job: EngineJob, engine: Engine, ctx: EngineContext) {
  const local = job.via === "comfy-local";
  // Its light too: FLUX 3 Klein, told only to keep the layout, turned the user's sunset into pale daylight.
  const prompt = `Redraw this picture as one natural photograph taken by a real camera, keeping exactly the camera, the horizon and the place: every building, vehicle, object, the ground, water and sky where they are now and as large, in the same light, colors and time of day. ${REDRAW} ${onceRule(things, false)} One seamless photograph, no text.`;
  const stat = await fs.stat(file);
  return cachedFile(`redraw|${file}|${stat.size}|${job.model}|${prompt}`, async () => {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { outputs } = await engine.run(
      {
        ...job,
        prompt,
        userPrompt: prompt,
        refine: false,
        count: 1,
        references: [{ path: file, label: "the place", role: "edit-target" }],
        options: local ? { ...job.options, denoise: 0.55 } : job.options,
        guide: undefined,
        depth: undefined,
        layout: undefined,
      },
      ctx,
    );
    if (!outputs[0]) throw new EngineError("The model returned nothing.");
    if (local) return sharp(outputs[0].data).resize(info.width, info.height, { fit: "fill" }).png().toBuffer();
    const aligned = await lineUp(data, outputs[0].data, Buffer.alloc(info.width * info.height), info.width, info.height);
    return sharp(aligned, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  });
}

/** What redrawing a plate fixes, said as what a photograph has instead. */
const REDRAW = "Draw every surface fresh and real: one continuous sky with no panels, seams, tiles or straight edges across it; anything stretched, smeared, blurred, doubled or melted becomes a real, sharp, solid surface or object, the way it would look in a photo.";

const THINGS = `List the vehicles, people, animals and other large movable things this photo shows, each with how many there are, as JSON only: {"things": ["one red Ford Mustang convertible", "two pedestrians"]}. Name vehicles by make, model and color when you can. Leave out buildings, structures, plants, terrain, water and sky. An empty list when there are none.`;

/** The countable things a place photo shows ("one red Ford Mustang convertible"), read once per photo. */
async function placeThings(photo: string): Promise<string[]> {
  const bytes = await fs.readFile(photo);
  const file = path.join(DIR, "things", `${createHash("sha1").update(bytes).update(`|${VERSION}`).digest("hex")}.json`);
  const hit = await fs.readFile(file, "utf8").catch(() => null);
  if (hit) return JSON.parse(hit) as string[];
  const answer = await askText({ instructions: THINGS, text: "List the things.", references: [{ path: photo, label: "the place" }], imageEdge: 1024, detail: "low", effort: "low", timeoutMs: 60_000 }).catch(() => null);
  if (!answer) return [];
  const raw = jsonObject<{ things?: unknown[] }>(answer);
  const things = (raw?.things ?? []).flatMap((t) => (typeof t === "string" && t.trim() ? [t.trim().replace(/\.$/, "").slice(0, 80)] : [])).slice(0, 8);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(things));
  return things;
}

const SAME = `Image 1 is a photo of a place. Image 2 shows one subject: a vehicle, an animal or an object. Does image 1 already show that same subject, or one that looks the same (the same make, model and color; the same kind of animal or object in the same colors)? Answer only yes or no.`;

/**
 * Whether the place photo already shows a subject (the car staged is the photo's own car): it then stays where the
 * photo has it, as the only one. Read once per pair; people come from Cast and are never matched.
 */
async function alreadyInPlace(photo: string, el: SceneElement, placeUrl: string) {
  if (el.kind === "person") return false;
  if (el.image?.sourceUrl && el.image.sourceUrl === placeUrl) return true;
  const subject = el.image ? urlToPath(el.image.url) : el.cast?.sheet ? urlToPath(el.cast.sheet) : null;
  if (!subject) return false;
  const key = createHash("sha1").update(await fs.readFile(photo)).update(await fs.readFile(subject)).update(`|${VERSION}`).digest("hex");
  const file = path.join(DIR, "same", `${key}.txt`);
  const hit = await fs.readFile(file, "utf8").catch(() => null);
  if (hit) return hit === "yes";
  // The question in the message itself: as the instructions under a bare question, Grok wrote a picture prompt back.
  const answer = await askText({ instructions: "You look at pictures and answer questions about them with one word.", text: SAME, references: [{ path: photo, label: "image 1: the place" }, { path: subject, label: "image 2: the subject" }], imageEdge: 1024, detail: "low", effort: "low", timeoutMs: 60_000 }).catch(() => null);
  if (!answer) return false;
  const same = /^\W*yes/i.test(answer);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, same ? "yes" : "no");
  return same;
}

/**
 * The prompt that fills a view's unknown (flat gray) parts. Only what borders them carries on: a landmark seen elsewhere
 * in the place (a gas station on the photo's right) must not reappear where the camera turned away from it, so neither
 * the place's other features nor its photo go with it. One picture, so the model keeps the rest exactly.
 */
export function fillPrompt(setting: string, camera?: string, things?: string[], marker: "green" | "soft" = "green", edge?: string, removed?: string[]) {
  // The setting only says what the unseen parts are made of: worded as what the view shows, Grok 2.0 redrew the whole
  // view to match it and the user's gas station vanished from its own photo.
  const around = `the surroundings here are ${setting.trim() || "the same place"}`;
  const shot = camera ? ` The photo is ${camera}.` : "";
  return [
    marker === "green"
      ? `The bright green areas of this photo are parts nobody has seen yet.${shot} Fill every bright green area with the natural continuation of what borders it (${around}): the same ground, terrain, sky, water, plants or walls carrying on, with matching perspective, scale and light.`
      : `The soft, blurred patches of this photo are only a guess at parts nobody has seen yet.${shot} Redraw them as the natural, sharp continuation of what borders them (${around}): the same ground, terrain, sky, water, plants or walls carrying on, with matching perspective, scale and light.`,
    // What the rest of the photo shows where the unseen part begins: measured on FLUX 3 Klein, a view turned away from
    // the user's gas station, told only the landmark-free setting, came back as a cave beside the station's shop.
    edge ? `Right where it begins, the photo shows ${edge}: carry exactly that on across it first, the same surfaces, colors and light, before anything else.` : "",
    // Lifting a car out of its photo: told only to fill, Grok 2.0 drew another car into the car-shaped hole.
    removed?.length
      ? `The ${marker === "green" ? "green" : "blurred"} areas are where ${removed.join(" and ")} stood; ${removed.length > 1 ? "they are" : "it is"} gone now. Show only what was behind: the empty ground and the place carrying on, with no vehicle, person, animal or object there.`
      : "",
    `Add no buildings, structures, signs, vehicles, people or animals, unless they carry on one that the ${marker === "green" ? "green" : "blurred"} area cuts off at its edge; never repeat or move anything already in the picture.`,
    things ? onceRule(things, false) : "",
    `Keep everything ${marker === "green" ? "that isn't green" : "else"} exactly as it is, every building, vehicle and object where it stands, and the same camera${camera ? ` angle, looking ${/down/.test(camera) ? "down" : /up/.test(camera) ? "up" : "straight ahead"} exactly as much` : ""}, framing and horizon. One seamless photograph, no text.`,
  ]
    .filter(Boolean)
    .join(" ");
}

const SETTING = `In 6 to 14 words, describe only the natural setting around where this photo was taken: the terrain, the ground's surface, water, vegetation, the sky and the time of day. Never name buildings, structures, vehicles, signs, people or objects. Answer with the words only, no full stop.`;

/**
 * The setting around a place photo without its landmarks ("a rocky coastline above the sea at dusk, wet asphalt"):
 * what fills its unseen sides. Naming the place ("a gas station by the sea") makes models draw the gas station again
 * wherever the camera turns. Read once per photo; the place's own words when no vision model answers.
 */
async function settingOf(photo: string, fallback: string) {
  const bytes = await fs.readFile(photo);
  const file = path.join(DIR, "setting", `${createHash("sha1").update(bytes).update(`|${VERSION}`).digest("hex")}.txt`);
  const hit = await fs.readFile(file, "utf8").catch(() => null);
  if (hit) return hit;
  const answer = await askText({ instructions: SETTING, text: "Describe the setting.", references: [{ path: photo, label: "the place" }], imageEdge: 768, detail: "low", effort: "low", timeoutMs: 45_000 }).catch(() => null);
  const setting = answer?.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, 160);
  if (!setting) return fallback;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, setting);
  return setting;
}

/**
 * A view's unseen parts filled by the shot's model. Measured 2026-10-28 on the user's studio and gas station plates:
 * Grok 2.0 fills bright green areas completely (flat gray ones it sometimes hands back, and a gray studio wall reads as
 * one); Qwen-Image-Edit 2511 and FLUX.2 klein keep either marker as it is. So cloud models get the green marker, and
 * local ones a soft guess of the place (what surrounds each hole, blended in) that they redraw only where the mask
 * lets them (comfy-local-templates `maskLatent`).
 */
/**
 * What a fill is told, and whether the photo's own pixels must come back exactly where it showed the place (`exact`):
 * views and photos that join the 3D set must meet each other seamlessly; a shot's plate is better redrawn whole, smears
 * and all, so the take doesn't keep them.
 */
type FillWords = { setting: string; camera?: string; things?: string[]; edge?: string; exact?: boolean; removed?: string[]; redraw?: boolean; bridge?: boolean };

async function fillUnknown(file: string, words: FillWords, job: EngineJob, engine: Engine, ctx: EngineContext) {
  const stat = await fs.stat(file);
  const local = job.via === "comfy-local";
  const prompt =
    fillPrompt(words.setting, words.camera, words.things, local ? "soft" : "green", words.edge, words.removed) +
    (words.redraw ? ` Then make the whole picture one natural photograph while keeping its layout: ${REDRAW}` : "") +
    // The last view around, between both chains' ends: Grok 2.0 met their different light with a hard line in the sky.
    (words.bridge ? " Its left and right sides differ a little in color and light: blend from one into the other gradually across the middle, the sky, water and ground running on smoothly, with no line or step anywhere." : "");
  return cachedFile(`fill|${file}|${stat.size}|${job.model}|${prompt}`, async () => {
    const { data, hole, width: W, height: H } = await unseenOf(file);
    const scratch = (name: string) => path.join(DIR, `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`);
    const made: string[] = [];
    const save = async (input: Buffer, channels: 1 | 3) => {
      const out = scratch("fill-in");
      await sharp(input, { raw: { width: W, height: H, channels } }).png().toFile(out);
      made.push(out);
      return out;
    };
    const run = async (input: string, text: string, mask?: string) => {
      const { outputs } = await engine.run(
        { ...job, prompt: text, userPrompt: text, refine: false, count: 1, references: [{ path: input, label: "the view to fill", role: "edit-target" }], mask: mask ? { path: mask, label: "where to redraw" } : undefined, guide: undefined, depth: undefined, layout: undefined },
        ctx,
      );
      if (!outputs[0]) throw new EngineError("The model returned nothing.");
      return sharp(outputs[0].data).resize(W, H, { fit: "fill" }).png().toBuffer();
    };
    await fs.mkdir(DIR, { recursive: true });
    try {
      if (local) {
        // The mask a little wider than the holes, so the seams are redrawn too.
        const wide = await sharp(hole, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(2, W / 400)).extractChannel(0).raw().toBuffer();
        for (let i = 0; i < wide.length; i++) wide[i] = wide[i] > 24 ? 255 : 0;
        const drawn = await run(await save(pushPull(data, hole, W, H), 3), prompt, await save(wide, 1));
        // Where the photo showed the place, its own pixels exactly (a local fill keeps them but for its VAE's round trip).
        return words.exact ? keepKnown(drawn, data, wide, W, H) : drawn;
      }
      const original = Buffer.from(data);
      for (let i = 0; i < W * H; i++) {
        if (!hole[i]) continue;
        data[i * 3] = 0;
        data[i * 3 + 1] = 255;
        data[i * 3 + 2] = 0;
      }
      const marked = await save(data, 3);
      let drawn = await run(marked, prompt);
      if ((await greenShare(drawn)) > 0.01) {
        // Once more on what came back, told plainly.
        const again = scratch("fill-again");
        await fs.writeFile(again, drawn);
        made.push(again);
        drawn = await run(again, `${prompt} Not a single green area may remain anywhere in the picture.`);
      }
      // Lined up with the photo, then (for the set) the photo's own pixels wherever it showed the place.
      const wide = await sharp(hole, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(2, W / 400)).extractChannel(0).raw().toBuffer();
      for (let i = 0; i < wide.length; i++) wide[i] = wide[i] > 24 ? 255 : 0;
      const aligned = await lineUp(original, drawn, wide, W, H);
      return words.exact ? keepKnown(aligned, original, wide, W, H) : sharp(aligned, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    } finally {
      await Promise.all(made.map((f) => fs.rm(f, { force: true })));
    }
  });
}

/** A plate's unseen parts (flat UNKNOWN gray, #8a8a8a): its pixels and a mask, 255 there. */
async function unseenOf(file: string) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const hole = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < hole.length; i++) if (Math.abs(data[i * 3] - 138) <= 3 && Math.abs(data[i * 3 + 1] - 138) <= 3 && Math.abs(data[i * 3 + 2] - 138) <= 3) hole[i] = 255;
  return { data, hole, width: info.width, height: info.height };
}

/** How much of a picture still shows the green marker. */
async function greenShare(input: string | Buffer) {
  const { data, info } = await sharp(input).resize(192, 108, { fit: "fill", kernel: "nearest" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] < 90 && data[i + 1] > 170 && data[i + 2] < 90) n++;
  return n / (data.length / info.channels);
}

/**
 * Holes filled with what surrounds them, blended smoothly (push-pull): each coarser level averages the known pixels
 * below it, and every hole takes its color from the next coarser level. A soft guess of the place, never flat gray.
 */
export function pushPull(rgb: Buffer, hole: Buffer, W: number, H: number) {
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array };
  const base: Level = { w: W, h: H, c: new Float32Array(W * H * 3), a: new Float32Array(W * H) };
  for (let i = 0; i < W * H; i++) {
    if (hole[i]) continue;
    base.a[i] = 1;
    for (let k = 0; k < 3; k++) base.c[i * 3 + k] = rgb[i * 3 + k];
  }
  const levels = [base];
  for (let cur = base; cur.w > 1 || cur.h > 1; ) {
    const w = Math.max(1, Math.ceil(cur.w / 2));
    const h = Math.max(1, Math.ceil(cur.h / 2));
    const next: Level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sa = 0;
        const sum = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const j = Math.min(cur.h - 1, 2 * y + dy) * cur.w + Math.min(cur.w - 1, 2 * x + dx);
            sa += cur.a[j];
            for (let k = 0; k < 3; k++) sum[k] += cur.c[j * 3 + k] * cur.a[j];
          }
        }
        const i = y * w + x;
        if (sa > 0) for (let k = 0; k < 3; k++) next.c[i * 3 + k] = sum[k] / sa;
        next.a[i] = Math.min(1, sa);
      }
    }
    levels.push(next);
    cur = next;
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l];
    const coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++) {
      const fy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(coarse.h - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        if (fine.a[i] >= 1) continue;
        const fx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(coarse.w - 1, x0 + 1);
        const tx = fx - x0;
        for (let k = 0; k < 3; k++) {
          const top = coarse.c[(y0 * coarse.w + x0) * 3 + k] * (1 - tx) + coarse.c[(y0 * coarse.w + x1) * 3 + k] * tx;
          const bottom = coarse.c[(y1 * coarse.w + x0) * 3 + k] * (1 - tx) + coarse.c[(y1 * coarse.w + x1) * 3 + k] * tx;
          fine.c[i * 3 + k] = fine.c[i * 3 + k] * fine.a[i] + (top * (1 - ty) + bottom * ty) * (1 - fine.a[i]);
        }
        fine.a[i] = 1;
      }
    }
  }
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) out[i] = Math.max(0, Math.min(255, Math.round(base.c[i])));
  return out;
}

/** A view of the place (rendered by the page from the photo's spot, turned) with its unknown parts filled, by a model. */
export async function fillView(url: string, place: string, model: string, signal: AbortSignal, machine?: string, photoUrl?: string, bridge?: boolean) {
  const file = urlToPath(url);
  if (!file) throw new EngineError("Crackio can't find that view.");
  const photo = photoUrl ? urlToPath(photoUrl) : null;
  const [setting, edge] = await Promise.all([photo ? settingOf(photo, place) : place, edgeOf(file)]);
  const { job, engine } = await imageJob(model, machine);
  const filled = await fillUnknown(file, { setting, edge: edge ?? undefined, exact: true, bridge }, job, engine, { signal, progress: () => undefined });
  return saveUpload(await fs.readFile(filled));
}

const EDGE = `This picture is part of a photo; its flat gray part hasn't been seen yet. In 8 to 22 words, say what the rest of the picture shows right where it meets the gray: the things cut off there (name them plainly, with their colors), the ground and the sky. Never mention the gray. Answer with the words only, no full stop.`;

/**
 * What a view shows where its unseen part begins ("the end of a white-and-red gas station shop with a lit window, wet
 * asphalt, a pink dusk sky"), read once per view: that is what the fill carries on first. The landmark-free setting only
 * says what lies beyond.
 */
async function edgeOf(file: string) {
  const bytes = await fs.readFile(file);
  const cache = path.join(DIR, "edge", `${createHash("sha1").update(bytes).update(`|${VERSION}`).digest("hex")}.txt`);
  const hit = await fs.readFile(cache, "utf8").catch(() => null);
  if (hit !== null) return hit || null;
  const answer = await askText({ instructions: EDGE, text: "What is at the edge of the gray?", references: [{ path: file, label: "the view" }], imageEdge: 1024, detail: "low", effort: "low", timeoutMs: 45_000 }).catch(() => null);
  const edge = answer?.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, 220) ?? "";
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, edge);
  return edge || null;
}

/**
 * A model's whole-picture edit lined up with the picture it was given: Grok 2.0 hands edits back zoomed or shifted by a
 * few percent (the gas station's shop slid off the edge of the cleaned photo), which would tear the 3D set where the
 * photo's own pixels meet the drawn ones. The zoom and shift are found by trying them on small grayscale copies over the
 * parts both show (`hole` marks the rest), coarse then fine, and the drawing is warped to match. Unchanged when no zoom
 * or shift fits better than none.
 */
export async function lineUp(original: Buffer, drawn: Buffer, hole: Buffer, W: number, H: number) {
  const gray = async (input: Buffer, raw: boolean, w: number, h: number) =>
    new Float32Array(await (raw ? sharp(input, { raw: { width: W, height: H, channels: 3 } }) : sharp(input)).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer());
  const fit = async (w: number, scales: number[], shifts: number[], seed: { s: number; dx: number; dy: number }) => {
    const h = Math.max(8, Math.round((w * H) / W));
    const a = await gray(original, true, w, h);
    const b = await gray(drawn, false, w, h);
    const known = await sharp(hole, { raw: { width: W, height: H, channels: 1 } }).resize(w, h, { fit: "fill", kernel: "nearest" }).extractChannel(0).raw().toBuffer();
    const cx = w / 2;
    const cy = h / 2;
    const k = w / W;
    const error = (s: number, dx: number, dy: number) => {
      let sum = 0;
      let n = 0;
      for (let y = 1; y < h - 1; y += 2) {
        for (let x = 1; x < w - 1; x += 2) {
          if (known[y * w + x]) continue;
          const px = Math.round(cx + s * (x - cx) + dx * k);
          const py = Math.round(cy + s * (y - cy) + dy * k);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          sum += Math.abs(a[y * w + x] - b[py * w + px]);
          n++;
        }
      }
      return n > (w * h) / 16 ? sum / n : Infinity;
    };
    let best = { ...seed, e: error(seed.s, seed.dx, seed.dy) };
    const none = error(1, 0, 0);
    for (const ds of scales) {
      for (const ox of shifts) {
        for (const oy of shifts) {
          const e = error(seed.s + ds, seed.dx + ox, seed.dy + oy);
          if (e < best.e) best = { s: seed.s + ds, dx: seed.dx + ox, dy: seed.dy + oy, e };
        }
      }
    }
    return { ...best, none };
  };
  const span = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
  // Shifts in full-size pixels: up to 6% of the width, then within a few pixels.
  const coarse = await fit(160, span(-0.08, 0.08, 0.01), span(-0.06 * W, 0.06 * W, W / 160), { s: 1, dx: 0, dy: 0 });
  const fine = await fit(480, span(-0.0075, 0.0075, 0.0025), span(-(3 * W) / 480, (3 * W) / 480, W / 480), coarse);
  if (!(fine.e < fine.none * 0.92) || (Math.abs(fine.s - 1) < 0.002 && Math.abs(fine.dx) < 1 && Math.abs(fine.dy) < 1)) {
    return sharp(drawn).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  }
  const src = await sharp(drawn).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.min(W - 1, Math.max(0, W / 2 + fine.s * (x - W / 2) + fine.dx));
      const py = Math.min(H - 1, Math.max(0, H / 2 + fine.s * (y - H / 2) + fine.dy));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const tx = px - x0;
      const ty = py - y0;
      for (let c = 0; c < 3; c++) {
        const top = src[(y0 * W + x0) * 3 + c] * (1 - tx) + src[(y0 * W + x1) * 3 + c] * tx;
        const bottom = src[(y1 * W + x0) * 3 + c] * (1 - tx) + src[(y1 * W + x1) * 3 + c] * tx;
        out[(y * W + x) * 3 + c] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  console.log(`[director] lined up a fill: zoom ${fine.s.toFixed(4)}, shift ${fine.dx.toFixed(1)}, ${fine.dy.toFixed(1)} px (error ${fine.none.toFixed(1)} → ${fine.e.toFixed(1)})`);
  return out;
}

/** A fill with the photo's own pixels put back wherever it wasn't asked to draw (`wide` is where it was), feathered. */
async function keepKnown(drawn: Buffer, original: Buffer, wide: Buffer, W: number, H: number) {
  const fill = Buffer.from(drawn.length === W * H * 3 ? drawn : await sharp(drawn).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer());
  // The drawn parts in the photo's own tone: their mean color matched to the photo's on a rim just outside them.
  const rim = await sharp(wide, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(4, W / 90)).extractChannel(0).raw().toBuffer();
  const sum = [0, 0, 0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (wide[i] || rim[i] < 8) continue;
    for (let k = 0; k < 3; k++) {
      sum[k] += original[i * 3 + k];
      sum[3 + k] += fill[i * 3 + k];
    }
    n++;
  }
  if (n > 200) {
    // Only near the seam, fading into the drawn part: shifted all through, a dark rim (the coast's ground) darkened a
    // view's whole sky, and the next view built on it darker still, until one came out black (FLUX 3 Klein's 360).
    const shift = [0, 1, 2].map((k) => Math.max(-24, Math.min(24, (sum[k] - sum[3 + k]) / n)));
    const near = await sharp(Buffer.from(wide.map((v) => 255 - v)), { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(4, W / 40)).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < W * H; i++) {
      if (!wide[i]) continue;
      const t = near[i] / 255;
      for (let k = 0; k < 3; k++) fill[i * 3 + k] = Math.max(0, Math.min(255, Math.round(fill[i * 3 + k] + shift[k] * t)));
    }
  }
  // The drawn parts reach a little into the photo's, fading over a wide band: a narrow edge left a visible line where
  // the photo's light met the model's (the 360 views, Grok 2.0).
  const reach = await sharp(wide, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(3, W / 80)).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < reach.length; i++) reach[i] = reach[i] > 8 ? 255 : 0;
  const soft = await sharp(reach, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(3, W / 90)).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const t = soft[i] / 255;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(fill[i * 3 + k] * t + original[i * 3 + k] * (1 - t));
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/* ------------------------------------------------------------------ the place's own things */

const FIND = `Find the vehicles, people, animals and large movable objects standing in this photo's scene: things someone could move or stage, not buildings, signs, fuel pumps, plants, terrain or anything built in. Answer with JSON only: {"things": [{"kind": "vehicle", "box": [x0, y0, x1, y1]}]}. kind: "vehicle", "person", "animal" or "object". box: its whole visible outline, in thousandths of the photo's width and height (0 to 1000, x0 and y0 the top-left corner). At most 4, the biggest first; leave out any shorter than a twentieth of the photo's height. An empty list when there are none.`;

export type PlaceThing = { kind: ElementKind; box: [number, number, number, number]; cutout: { url: string; width: number; height: number }; read: SubjectRead | null };
export type LiftedPlace = { things: PlaceThing[]; clean: { url: string; width: number; height: number } | null };

/**
 * The movable things a place photo shows (a parked car, a person), lifted out of it: each cut out as its own subject,
 * and the photo with them removed (what's behind them filled in by the place's model). On the 3D set a photo's car is
 * only a relief of the one side the photo saw: from anywhere else it smears and melts (the user's gas station Mustang).
 * As a subject it gets a stand-in and is drawn whole from the camera's angle, like anything staged.
 */
export async function liftThings(photoUrl: string, place: string, model: string, signal: AbortSignal, machine?: string): Promise<LiftedPlace> {
  const photo = urlToPath(photoUrl);
  if (!photo) throw new EngineError("Crackio can't find that photo.");
  const bytes = await fs.readFile(photo);
  const cache = path.join(DIR, "lift", `${createHash("sha1").update(bytes).update(`|${model}|${VERSION}`).digest("hex")}.json`);
  const hit = await fs.readFile(cache, "utf8").catch(() => null);
  if (hit) return JSON.parse(hit) as LiftedPlace;
  const done = async (lifted: LiftedPlace) => {
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify(lifted));
    return lifted;
  };

  const answer = await askText({
    instructions: FIND,
    text: "Find the things.",
    references: [{ path: photo, label: "the place" }],
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    imageEdge: 1280,
    detail: "high",
    effort: "low",
    timeoutMs: 60_000,
  }).catch(() => null);
  if (!answer) throw new EngineError("No vision model answered.", "Connect ChatGPT or Grok in Connections.");
  const raw = jsonObject<{ things?: { kind?: string; box?: unknown }[] }>(answer);
  // Some vision models answer in percent whatever they're asked: boxes that all fit in 0-100 are read that way.
  const all = (raw?.things ?? []).flatMap((t) => (Array.isArray(t.box) ? t.box.map(Number) : []));
  const scale = all.length && all.every((v) => v <= 100) ? 10 : 1;
  const { data: rgb, info } = await sharp(photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const boxes = (raw?.things ?? [])
    .flatMap((t) => {
      const b = Array.isArray(t.box) ? t.box.map(Number) : [];
      if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return [];
      const [x0, y0, x1, y1] = b.map((v) => Math.max(0, Math.min(1000, v * scale)));
      if (x1 - x0 < 15 || y1 - y0 < 50) return [];
      const kind = KINDS.find((k) => k === t.kind) ?? "object";
      return [{ kind, box: [x0, y0, x1, y1] as [number, number, number, number] }];
    })
    .slice(0, 4);
  if (!boxes.length) return done({ things: [], clean: null });

  // Each one cut out of a crop around it; its matte, put back on the photo, says what the clean photo loses.
  const hole = Buffer.alloc(W * H);
  const things: PlaceThing[] = [];
  await fs.mkdir(DIR, { recursive: true });
  for (const t of boxes) {
    const mx = (t.box[2] - t.box[0]) * 0.12;
    const my = (t.box[3] - t.box[1]) * 0.12;
    const left = Math.max(0, Math.floor(((t.box[0] - mx) / 1000) * W));
    const top = Math.max(0, Math.floor(((t.box[1] - my) / 1000) * H));
    const width = Math.min(W - left, Math.ceil(((t.box[2] - t.box[0] + 2 * mx) / 1000) * W));
    const height = Math.min(H - top, Math.ceil(((t.box[3] - t.box[1] + 2 * my) / 1000) * H));
    if (width < 16 || height < 16) continue;
    const crop = path.join(DIR, `lift-${Date.now().toString(36)}-${things.length}.png`);
    await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).extract({ left, top, width, height }).png().toFile(crop);
    try {
      const cut = await withSubjectMatte(crop);
      if (!cut) continue;
      const alpha = await sharp(cut).ensureAlpha().extractChannel(3).raw().toBuffer();
      let solid = 0;
      // Its thin parts too (a windshield's frame stayed floating at 80), and the ground just below it (its contact
      // shadow stayed as dark slabs under where the wheels were).
      const below = Math.round(H * 0.035);
      for (let x = 0; x < width; x++) {
        let lowest = -1;
        for (let y = 0; y < height; y++) {
          if (alpha[y * width + x] < 30) continue;
          hole[(top + y) * W + left + x] = 255;
          if (alpha[y * width + x] >= 80) solid++;
          lowest = y;
        }
        for (let y = lowest + 1; lowest >= 0 && y <= lowest + below && top + y < H; y++) hole[(top + y) * W + left + x] = 255;
      }
      if (solid < width * height * 0.08) continue;
      const saved = await saveUpload(await sharp(cut).trim({ threshold: 1 }).png().toBuffer());
      const file = urlToPath(saved.url);
      const read = file ? await readSubject(file) : null;
      things.push({ kind: read?.kind ?? t.kind, box: t.box, cutout: { url: saved.url, width: saved.width, height: saved.height }, read });
    } finally {
      await fs.rm(crop, { force: true });
    }
  }
  if (!things.length) return done({ things: [], clean: null });

  // The photo without them: their mattes a little wider (soft rims, contact shadows' edges), filled like any unseen part.
  const wide = await sharp(hole, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(4, W / 110)).extractChannel(0).raw().toBuffer();
  const marked = Buffer.from(rgb);
  for (let i = 0; i < W * H; i++) if (wide[i] > 16) marked[i * 3] = marked[i * 3 + 1] = marked[i * 3 + 2] = 138;
  const markedFile = path.join(DIR, `lift-marked-${Date.now().toString(36)}.png`);
  await sharp(marked, { raw: { width: W, height: H, channels: 3 } }).png().toFile(markedFile);
  try {
    const { job, engine } = await imageJob(model, machine);
    const removed = things.map((t) => t.read?.noun ?? `a ${t.kind}`);
    // The photo's own pixels around the hole, exactly: Grok 2.0's whole redraw moved the gas station, which the set is
    // built on; the hole's tone is matched to its rim so the car's outline doesn't stay as a lighter patch.
    const filled = await fillUnknown(markedFile, { setting: await settingOf(photo, place), exact: true, removed }, job, engine, { signal, progress: () => undefined });
    const clean = await saveUpload(await fs.readFile(filled));
    return done({ things, clean: { url: clean.url, width: clean.width, height: clean.height } });
  } finally {
    await fs.rm(markedFile, { force: true });
  }
}

/** The place's world (server/world): one 360 picture from its photo, by `model`. `fresh` draws it again. */
export async function placeWorld(photoUrl: string, view: PlaceView, place: string, model: string, signal: AbortSignal, machine?: string, fresh?: boolean, around?: string[]) {
  const photo = urlToPath(photoUrl);
  if (!photo) throw new EngineError("Crackio can't find the place's photo.");
  const { job, engine } = await imageJob(model, machine);
  // Drawn at its own size (2560 x 1097) by the model's quick version, whatever size the place photo was made at: asked
  // for 4K and the full model, the drawing took twice as long, and it's sharpened to 8K after anyway.
  // A place made from words is what the words say; a photo of your own is read (14 s).
  const setting = place.trim() || (await settingOf(photo, place));
  const { buildWorld } = await import("./world");
  // An extend's: the set's six views from the new spot (the place it had all around), on disk.
  const faces = around?.map((u) => urlToPath(u)).filter((p): p is string => Boolean(p));
  return buildWorld(photoUrl, view, setting, place, job, engine, { signal, progress: () => undefined }, fresh ? Date.now().toString(36) : "", faces?.length === 6 ? faces : undefined);
}

/** One view of the place changed as you say ("make this side a pine forest"), keeping its camera and the edges it shares. */
export async function editView(url: string, words: string, model: string, signal: AbortSignal, machine?: string) {
  const file = urlToPath(url);
  if (!file) throw new EngineError("Crackio can't find that view.");
  const { job, engine } = await imageJob(model, machine);
  const prompt = `${words.trim().replace(/\.?$/, ".")} Keep the camera, horizon, perspective and light exactly as they are, and keep the picture's left and right edges as they are: they meet the views beside it. One natural photograph, no text.`;
  const meta = await sharp(file).metadata();
  const { outputs } = await engine.run(
    { ...job, prompt, userPrompt: prompt, refine: false, count: 1, references: [{ path: file, label: "the view", role: "edit-target" }], guide: undefined, depth: undefined, layout: undefined },
    { signal, progress: () => undefined },
  );
  if (!outputs[0]) throw new EngineError("The model returned nothing.");
  return saveUpload(await sharp(outputs[0].data).resize(meta.width, meta.height, { fit: "fill" }).png().toBuffer());
}

/** A subject's whole silhouette in the frame (pixels, past its edges when cut off) and how far it is (capture.ts). */
type CompBox = { id: string; box: [number, number, number, number]; distance: number; color?: [number, number, number] };
type CompPasses = { plateUrl: string; boxes: CompBox[] };

/** The passes a composed shot needs, when the take brought them. */
function compPasses(gen: Generation): CompPasses | null {
  const c = gen.params?.comp as Partial<CompPasses> | undefined;
  return gen.params?.director === 2 && typeof c?.plateUrl === "string" && Array.isArray(c.boxes) ? (c as CompPasses) : null;
}

/** Whether a take is composed: it brought the passes and the model takes pictures (it draws each subject from one). */
export function canCompose(gen: Generation, slots: number) {
  return slots >= 1 && compPasses(gen) !== null && gen.params?.compose !== false;
}

/**
 * One subject drawn from an angle by a model, from its photo, on a plain background, then cut out and trimmed.
 * Cached by the photo, the angle (to 15 degrees around, 10 above), the light and the model.
 */
async function drawFromAngle(el: SceneElement, view: Pick<SubjectView, "around" | "above">, card: string, light: string, job: EngineJob, engine: Engine, ctx: EngineContext) {
  // Angles to 15 degrees: what a model can tell apart, and drawings get reused between shots.
  const rounded = { around: Math.round(view.around / 15) * 15, above: Math.round(view.above / 10) * 10 };
  const prompt = viewPrompt(el, rounded, light);
  const stat = await fs.stat(card);
  const file = await cachedFile(`view|${card}|${stat.size}|${job.model}|${prompt}`, async () => {
    const aspect: AspectId = el.kind === "person" ? "2:3" : el.kind === "vehicle" ? "16:9" : "1:1";
    const size = sizeFor(aspect);
    // The photo goes in already in the drawing's shape: edits come back in the shape they're given, and a result in
    // another shape is cropped to the one asked for (a tall person loses their head).
    const framed = await framedCard(card, aspect);
    const { outputs } = await engine.run(
      { ...job, prompt, userPrompt: prompt, refine: false, aspect, width: size.width, height: size.height, count: 1, references: [{ path: framed, label: el.name, role: "subject" }], guide: undefined, depth: undefined, layout: undefined },
      ctx,
    );
    if (!outputs[0]) throw new EngineError(`The model drew nothing for ${el.name}.`);
    const raw = path.join(DIR, `raw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`);
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(raw, await sharp(outputs[0].data).png().toBuffer());
    try {
      const cut = (await withSubjectMatte(raw)) ?? (await fs.readFile(raw));
      return sharp(cut).trim({ threshold: 1 }).png().toBuffer();
    } finally {
      await fs.rm(raw, { force: true });
    }
  });
  return { file, prompt };
}

/**
 * The composite: each subject's drawing (all of it) placed over the plate on its stand-in's whole silhouette, scaled
 * to its height and cropped by the frame where the shot crops it, the farthest first.
 */
async function composite(plate: string, boxes: CompBox[], drawn: Map<string, string>) {
  const meta = await sharp(plate).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 864;
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (const b of [...boxes].filter((x) => drawn.has(x.id)).sort((a, c) => c.distance - a.distance)) {
    const file = drawn.get(b.id)!;
    const m = await sharp(file).metadata();
    const w = m.width ?? 1;
    const h = m.height ?? 1;
    const [x0, y0, x1, y1] = b.box;
    const scale = (y1 - y0) / h;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const left = Math.round((x0 + x1) / 2 - tw / 2);
    const top = Math.round(y0);
    // Only the part inside the frame (sharp can't place a layer past the picture's edges).
    const cx0 = Math.max(0, left);
    const cy0 = Math.max(0, top);
    const cx1 = Math.min(W, left + tw);
    const cy1 = Math.min(H, top + th);
    if (cx1 - cx0 < 2 || cy1 - cy0 < 2) continue;
    const input = await sharp(file)
      .resize(tw, th, { fit: "fill" })
      .extract({ left: cx0 - left, top: cy0 - top, width: cx1 - cx0, height: cy1 - cy0 })
      .png()
      .toBuffer();
    layers.push({ input, left: cx0, top: cy0 });
  }
  return sharp(plate).composite(layers).png().toBuffer();
}

/**
 * A composed Director shot. The camera view of photo cut-outs gives the right framing with flat, squashed subjects;
 * stand-ins give real subjects that models then move around. So: every subject is drawn fresh, from its own photo,
 * from exactly the angle the camera sees it; each drawing goes where its stand-in stands, at its size, over the place
 * as the camera sees it; and the last pass only blends that composite into one photograph, keeping it as it is.
 */
export async function runDirectorComp(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult & { compUrl: string; views: Record<string, { url: string; prompt: string }> }> {
  const scene = gen.params?.scene as Scene;
  const passes = compPasses(gen)!;
  const plate = urlToPath(passes.plateUrl);
  if (!plate) throw new EngineError("Crackio can't find this shot's plate.", "Shoot it again.");
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const views = new Map(subjectViews(scene).map((v) => [v.id, v]));
  const subjects = passes.boxes.map((b) => byId.get(b.id)).filter((e): e is SceneElement => Boolean(e?.image && views.has(e.id)));

  ctx.progress(0.04, subjects.length ? `Drawing ${subjects.map((e) => e.name).join(", ")} from the camera's angle` : "Setting up the shot");
  let finished = 0;
  // The place's unknown parts filled at the same time, so the composite reads as a photograph.
  const filling = fillPlate(plate, scene, job, engine, { signal: ctx.signal, progress: () => undefined }, []).then((f): string | null => f).catch((err: Error) => {
    if (ctx.signal.aborted) throw err;
    console.warn(`[director] filling the plate failed: ${err.message}`);
    return null;
  });
  const drawnList = await Promise.all(
    subjects.map(async (el) => {
      const photo = urlToPath(el.image!.url);
      if (!photo) return null;
      const subjectCard = await card(photo, el.image!.cutout);
      const step: EngineContext = { signal: ctx.signal, progress: () => undefined };
      // A drawing from all around it that's near enough this angle (what the camera view showed you) is used as it is.
      const need = views.get(el.id)!;
      const near = el.views
        ?.map((v) => ({ v, off: Math.abs(((((v.around - need.around) % 360) + 540) % 360) - 180) }))
        .filter(({ v, off }) => off <= 22.5 && Math.abs(v.above - need.above) <= 15)
        .sort((a, b) => a.off - b.off)[0]?.v;
      const nearFile = near ? urlToPath(near.url) : null;
      if (nearFile) {
        ctx.progress(0.05 + 0.45 * (++finished / subjects.length), `${el.name}: the drawing from that side`);
        return { el, card: subjectCard, view: { file: nearFile, prompt: `(the drawing from ${near!.around} degrees)` } };
      }
      const light = lightingPhrase(scene).replace(/^Lighting: /, "Light it the same way as the shot: ");
      const view = await drawFromAngle(el, need, subjectCard, light, job, engine, step).catch((err: Error) => {
        if (ctx.signal.aborted) throw err;
        console.warn(`[director] drawing ${el.name} from the camera's angle failed: ${err.message}`);
        return null;
      });
      ctx.progress(0.05 + 0.45 * (++finished / subjects.length), `Drew ${el.name} from the camera's angle`);
      return { el, card: subjectCard, view };
    }),
  );
  const drawn = drawnList.filter((d): d is NonNullable<typeof d> => Boolean(d));
  const filled = await filling;
  // A subject that couldn't be drawn goes in as its photo, as seen from the front.
  const files = new Map(drawn.map((d) => [d.el.id, d.view?.file ?? d.card]));
  ctx.progress(0.5, "Putting the shot together");
  const comp = await saveUpload(await composite(filled ?? plate, passes.boxes, files));

  // The last pass: the composite alone (see finishPrompt).
  const references: EngineReference[] = [{ path: urlToPath(comp.url)!, label: "the composite", role: "edit-target" }];
  const prompt = finishPrompt(scene);
  const result = await engine.run(
    { ...job, prompt, userPrompt: prompt, refine: false, references, guide: undefined, depth: undefined, layout: undefined },
    { signal: ctx.signal, progress: (v, stage) => ctx.progress(0.52 + v * 0.46, stage) },
  );
  const viewsOut: Record<string, { url: string; prompt: string }> = {};
  for (const d of drawn) {
    if (!d.view) continue;
    const saved = await saveUpload(await fs.readFile(d.view.file));
    viewsOut[d.el.id] = { url: saved.url, prompt: d.view.prompt };
  }
  return { ...result, usedPrompt: result.usedPrompt ?? prompt, compUrl: comp.url, views: viewsOut };
}

/* ------------------------------------------------------------------ turnarounds */

/** Every subject is drawn once from all around it at about eye level, so the camera view can show it from any side. */
export const TURNAROUND = [0, 45, 90, 135, 180, -135, -90, -45].map((around) => ({ around, above: 10 }));

export type Drawing = { around: number; above: number; url: string; width: number; height: number };

/** An image job for a model, as the runner builds one (no prompt or pictures yet). */
async function imageJob(model: string, machine?: string) {
  const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry")]);
  const def = await resolveModel("image", model);
  const engine = def.via ? engineFor(def.via) : null;
  if (!engine) throw new EngineError(`${def.name} has no engine connected.`, "Open Connections.");
  const { width, height } = sizeFor("1:1");
  const job: EngineJob = {
    kind: "image",
    model: def.model,
    via: def.via ?? undefined,
    family: def.family,
    caps: def.caps ?? undefined,
    options: machine ? { machine } : undefined,
    prompt: "",
    userPrompt: "",
    refine: false,
    aspect: "1:1",
    width,
    height,
    count: 1,
    references: [],
    mode: "image",
  };
  return { job, engine, def };
}

/**
 * A subject drawn from every side (TURNAROUND), in soft, even light, by the model you shoot with: what the camera view
 * shows instead of a flat photo card. Drawings that fail are left out.
 */
export async function drawTurnaround(el: SceneElement, model: string, signal: AbortSignal, machine?: string): Promise<Drawing[]> {
  const photo = el.image ? urlToPath(el.image.url) : null;
  if (!photo) throw new EngineError("This subject has no picture to draw from.");
  const { job, engine } = await imageJob(model, machine);
  const subjectCard = await card(photo, el.image!.cutout);
  const light = "Light it with soft, even studio light";
  const ctx: EngineContext = { signal, progress: () => undefined };
  const drawn = await Promise.all(
    TURNAROUND.map(async (angle) => {
      const view = await drawFromAngle(el, angle, subjectCard, light, job, engine, ctx).catch((err: Error) => {
        if (signal.aborted) throw err;
        console.warn(`[director] drawing ${el.name} at ${angle.around} degrees failed: ${err.message}`);
        return null;
      });
      if (!view) return null;
      const saved = await saveUpload(await fs.readFile(view.file));
      return { ...angle, url: saved.url, width: saved.width, height: saved.height };
    }),
  );
  return drawn.filter((d): d is Drawing => Boolean(d));
}

/** Where the camera stands around a subject for each Cast sheet view (side views are drawn facing frame left). */
const SHEET_AROUND: Record<string, number> = { front: 0, "three-quarter": 45, side: 90, back: 180 };

/**
 * A Cast member's sheet as drawings for the stage (like `drawTurnaround`'s, no model run): each view cut out and
 * trimmed, the side views mirrored for the other side, so the camera view shows which way they face.
 */
export async function castSheetDrawings(sheetUrl: string, names: readonly string[]): Promise<Drawing[]> {
  const sheet = urlToPath(sheetUrl);
  if (!sheet) throw new EngineError("Crackio can't find that Cast sheet.");
  const stat = await fs.stat(sheet);
  const views = await sheetViews(sheet);
  const drawings: Drawing[] = [];
  for (let i = 0; i < Math.min(views.length, names.length); i++) {
    const around = SHEET_AROUND[names[i]];
    if (around === undefined) continue;
    const file = await cachedFile(`sheet-drawing|${sheet}|${stat.size}|${stat.mtimeMs}|${i}`, async () => {
      const raw = path.join(DIR, `sheet-view-${Date.now().toString(36)}-${i}.png`);
      await fs.mkdir(DIR, { recursive: true });
      await fs.writeFile(raw, views[i]);
      try {
        const cut = (await withSubjectMatte(raw)) ?? views[i];
        return sharp(cut).trim({ threshold: 1 }).png().toBuffer();
      } finally {
        await fs.rm(raw, { force: true });
      }
    });
    const saved = await saveUpload(await fs.readFile(file));
    drawings.push({ around, above: 0, url: saved.url, width: saved.width, height: saved.height });
    if (around % 180 !== 0) {
      const mirrored = await saveUpload(await sharp(file).flop().png().toBuffer());
      drawings.push({ around: -around, above: 0, url: mirrored.url, width: mirrored.width, height: mirrored.height });
    }
  }
  return drawings;
}

/* ------------------------------------------------------------------ plate shots */

/**
 * A Director take on the real place (director 4): the place as this camera sees it (the plate; its unseen parts filled
 * with the setting, or on an empty stage the place built from its words), the stand-ins set on it, then one edit
 * swapping them for the subjects, each from its own picture. Every pass edits one coherent picture, which models keep:
 * the camera, the framing and the place are the ones you set.
 */
export async function runDirectorPlate(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext, slots: number): Promise<EngineResult & { plateUrl: string; swapUrl: string }> {
  const scene = gen.params?.scene as Scene;
  const comp = gen.params?.comp as { plateUrl?: string; idsUrl?: string; boxes?: CompBox[] } | undefined;
  const plate = comp?.plateUrl ? urlToPath(comp.plateUrl) : null;
  const ids = comp?.idsUrl ? urlToPath(comp.idsUrl) : null;
  const blocking = typeof gen.params?.blockingUrl === "string" ? urlToPath(gen.params.blockingUrl) : null;
  if (!plate || !ids || !blocking) throw new EngineError("This shot is missing its plate.", "Shoot it again.");
  const step = (from: number, to: number, stage: string): EngineContext => ({ signal: ctx.signal, progress: (v) => ctx.progress(from + v * (to - from), stage) });

  // What the place photo already shows, each only once: its cars, people and objects, and any subject that is one of them.
  ctx.progress(0.02, "Looking at the place");
  const photo = scene.place.image ? urlToPath(scene.place.image.url) : null;
  const things = photo ? await placeThings(photo) : [];
  const kept = new Set<string>();
  if (photo && scene.place.image) {
    const placeUrl = scene.place.image.url;
    const found = await Promise.all(scene.elements.map(async (el) => ((await alreadyInPlace(photo, el, placeUrl).catch(() => false)) ? el.id : null)));
    for (const id of found) if (id) kept.add(id);
  }

  // 1. The place as this camera sees it, by the place's own model when you chose one.
  ctx.progress(0.03, scene.place.image ? "Filling in what the photo doesn't show" : "Building the place");
  const placeModel = typeof gen.params?.placeModel === "string" && gen.params.placeModel !== "auto" && gen.params.placeModel !== job.model ? gen.params.placeModel : null;
  const maker = placeModel ? await imageJob(placeModel, typeof job.options?.machine === "string" ? job.options.machine : undefined) : { job, engine };
  // A world's view is a guide, not the picture: one panorama spread over the whole circle holds about a quarter of a
  // photo's detail, and shots kept its softness and the sharpener's invented grids (the user: "the quality of it can be
  // bad.. then the output WILL also be bad"). Redrawn fresh at the shot's size, it keeps the place's layout and light.
  // Within the place photo the world is the photo itself (server/world photoInto): kept exactly, as sharp as it is.
  const clean = gen.params?.surround === true && (!scene.place.world || withinPhoto(scene));
  const filled = scene.place.image
    ? await fillPlate(plate, scene, maker.job, maker.engine, step(0.03, 0.28, "Drawing the place from your camera"), things, clean)
    : await cachedFile(`build|${plate}|${maker.job.model}|${buildPlacePrompt(scene)}`, async () => {
        const prompt = buildPlacePrompt(scene);
        const meta = await sharp(plate).metadata();
        const { outputs } = await maker.engine.run(
          { ...maker.job, prompt, userPrompt: prompt, refine: false, count: 1, references: [{ path: plate, label: "the floor grid", role: "edit-target" }], guide: undefined, depth: undefined, layout: undefined },
          step(0.03, 0.28, "Building the place"),
        );
        if (!outputs[0]) throw new EngineError("The model returned no place.");
        return sharp(outputs[0].data).resize(meta.width, meta.height, { fit: "fill" }).png().toBuffer();
      });
  const plateSaved = await saveUpload(await fs.readFile(filled));

  // 2. The stand-ins on it, where the ID pass has them: none for a subject the place already shows, or one the prompt
  // doesn't name (a chair's corner in the frame while the chair itself is out of it would stay a colored block).
  const named = new Set(frameElements(scene).filter((f) => f.inFrame).map((f) => f.element.id));
  const skip = (comp?.boxes ?? []).filter((b) => (kept.has(b.id) || !named.has(b.id)) && Array.isArray(b.color)).map((b) => b.color!);
  const overlay = await standInsOver(filled, blocking, ids, skip, plate);
  const overlaySaved = await saveUpload(overlay);
  const swapIn = path.join(DIR, `swap-in-${Date.now().toString(36)}.png`);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(swapIn, overlay);

  // 3. One edit swaps each stand-in for its subject: its own picture beside the shot, from the side the camera sees it,
  // for as many as the model takes; the rest in words. Measured on Grok 2.0 (the user's gas station shot): the swap and
  // the likeness in one pass keep the subject's facing, size and spot; a separate likeness pass after the swap turned a
  // profile toward the camera.
  const { subjects } = briefPictures(scene, 99);
  const seen = new Map(subjectViews(scene).map((v) => [v.id, v.around]));
  const pictures = new Map<string, { image: number; sheet?: boolean; matched?: boolean }>();
  const references: EngineReference[] = [{ path: swapIn, label: "the shot with stand-ins", role: "edit-target" }];
  for (const s of subjects) {
    if (references.length >= slots) break;
    if (kept.has(s.el.id)) continue;
    const pic = await matchedView(s.el, seen.get(s.el.id) ?? 0).catch(() => null);
    if (!pic) continue;
    references.push({ path: pic.path, label: pic.matched ? `${s.el.name}, from this side` : s.sheet ? `${s.el.name}, reference sheet` : s.el.name, role: "subject" });
    pictures.set(s.el.id, { image: references.length, sheet: s.sheet && !pic.matched, matched: pic.matched });
  }
  const swap = swapPrompt(scene, pictures, { things, kept });
  try {
    const { outputs } = await engine.run(
      { ...job, prompt: swap, userPrompt: swap, refine: false, references, guide: undefined, depth: undefined, layout: undefined },
      step(0.28, 0.98, "Putting your cast in the shot"),
    );
    if (!outputs.length) throw new EngineError("The model returned no picture.");
    return { outputs, usedPrompt: swap, plateUrl: plateSaved.url, swapUrl: overlaySaved.url };
  } finally {
    await fs.rm(swapIn, { force: true });
  }
}

/** Whether the shot looks only at what the place photo shows (its world there is the photo's own pixels). */
function withinPhoto(scene: Scene) {
  const image = scene.place.image;
  if (!image?.view) return false;
  const cam = shotCamera(scene);
  const photo = photoCamera(image.view, scene.place.scale ?? 1);
  const f = cam.getWorldDirection(cam.position.clone());
  const yaw = (v: { x: number; z: number }) => (Math.atan2(v.x, -v.z) * 180) / Math.PI;
  const pitch = (v: { y: number }) => (Math.asin(Math.max(-1, Math.min(1, v.y))) * 180) / Math.PI;
  const photoV = image.view.fov;
  const photoH = (2 * Math.atan(Math.tan((photoV * Math.PI) / 360) * (image.width / image.height)) * 180) / Math.PI;
  const aspect = cam.aspect;
  const shotH = horizontalFov(scene.camera.focal, aspect);
  const shotV = verticalFov(scene.camera.focal, aspect);
  return Math.abs(angleDelta(yaw(f), yaw(photo.forward))) + shotH / 2 <= photoH / 2 + 2 && Math.abs(pitch(f) - pitch(photo.forward)) + shotV / 2 <= photoV / 2 + 2;
}

/**
 * A subject's own picture from the side the camera sees it (`around`, as in `subjectViews`): its Cast sheet's front,
 * side or back view (the side view, drawn facing left, turned to face the way it faces here), or the drawing made from
 * the nearest side, or else its photo. Measured on Grok 2.0: with the matching view the model keeps the subject's pose;
 * a whole sheet leads with the front view, which pulls faces toward the camera.
 */
async function matchedView(el: SceneElement, around: number): Promise<{ path: string; matched: boolean } | null> {
  const sheet = el.cast?.sheet ? urlToPath(el.cast.sheet) : null;
  if (sheet) {
    const member = el.cast?.id ? loadCharacter(el.cast.id) : null;
    const names = member ? viewsOf(member) : LEGACY_SHEET_VIEWS;
    const a = Math.abs(around);
    const want = a < 30 ? "front" : a < 60 && names.includes("three-quarter") ? "three-quarter" : a < 45 ? "front" : a < 140 || !names.includes("back") ? "side" : "back";
    const i = names.indexOf(want);
    if (i < 0) return { path: sheet, matched: false };
    const flip = (want === "side" || want === "three-quarter") && around < 0;
    const stat = await fs.stat(sheet);
    const file = await cachedFile(`sheet-view|${sheet}|${stat.size}|${stat.mtimeMs}|${i}|${flip}`, async () => {
      const view = sharp((await sheetViews(sheet))[i]);
      return (flip ? view.flop() : view).png().toBuffer();
    });
    return { path: file, matched: true };
  }
  if (el.views?.length) {
    const best = el.views.reduce((b, v) => (Math.abs(angleDelta(v.around, around)) < Math.abs(angleDelta(b.around, around)) ? v : b));
    const file = urlToPath(best.url);
    if (file) return { path: file, matched: true };
  }
  // Else its cut-out on a plain backdrop: its photo's own background leaks into the shot (Grok 2.0: a man photographed
  // against a dark wall turned the lantern-lit street behind him into that wall).
  const cut = el.image ? urlToPath(el.image.url) : null;
  return cut ? { path: await card(cut, el.image!.cutout), matched: false } : null;
}

/**
 * The blocking render's stand-ins (where the ID pass marks a subject) laid over the filled plate, but those in `skip` (ID
 * colors), and their shadows on the ground with them: where the blocking render is darker than the raw plate (the same
 * set without the stand-ins), the plate darkens as much. Without a shadow under her feet, FLUX 3 Klein drew a woman
 * staged in a studio hovering over its floor.
 */
async function standInsOver(plate: string, blocking: string, ids: string, skip: [number, number, number][] = [], raw?: string) {
  const meta = await sharp(blocking).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 864;
  const base = await sharp(plate).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const figures = await sharp(blocking).removeAlpha().raw().toBuffer();
  const mask = await sharp(ids).resize(W, H, { fit: "fill", kernel: "nearest" }).removeAlpha().raw().toBuffer();
  if (raw) {
    const bare = await sharp(raw).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const lum = (b: Buffer, i: number) => 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2];
    for (let i = 0; i < W * H; i++) {
      if (mask[i * 3] > 127 || mask[i * 3 + 1] > 127 || mask[i * 3 + 2] > 127) continue;
      const before = lum(bare, i);
      if (before < 12) continue;
      const shade = Math.max(0.35, Math.min(1, lum(figures, i) / before));
      if (shade > 0.97) continue;
      for (let k = 0; k < 3; k++) base[i * 3 + k] = Math.round(base[i * 3 + k] * shade);
    }
  }
  for (let i = 0; i < W * H; i++) {
    // Any ID color (pure channels) is a subject; black is the place.
    const r = mask[i * 3] > 127;
    const gr = mask[i * 3 + 1] > 127;
    const b = mask[i * 3 + 2] > 127;
    if ((r || gr || b) && !skip.some(([sr, sg, sb]) => sr > 127 === r && sg > 127 === gr && sb > 127 === b)) {
      base[i * 3] = figures[i * 3];
      base[i * 3 + 1] = figures[i * 3 + 1];
      base[i * 3 + 2] = figures[i * 3 + 2];
    }
  }
  return sharp(base, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
