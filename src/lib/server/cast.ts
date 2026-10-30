import "server-only";
import { nanoid } from "nanoid";
import { getGeneration, saveGeneration } from "./db";
import { runner } from "./runner";
import { saveUpload, urlToPath } from "./media";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { listModels } from "@/lib/models/resolve";
import { pickAuto } from "@/lib/models/auto";
import { getSettings } from "./settings";
import { allCharacters, characterByHandle, freeHandle, loadCharacter, removeCharacter, saveCharacter } from "./cast-store";
import { assembleSheet, sheetLayoutOf } from "./cast-sheet";
import type { Generation, ReferenceRef } from "@/lib/generations/types";
import type { AspectId } from "@/lib/shot";
import {
  CAST_PREFER,
  MENTION,
  FIGURE_LOOKS,
  SHEET_VIEWS,
  VIEW_LABELS,
  castFits,
  castNoun,
  defaultViews,
  formatHeight,
  isLong,
  mentionedHandles,
  tidyViews,
  type CastKind,
  type Character,
  type SheetView,
} from "@/lib/cast/types";

/**
 * Cast: people, animals, characters and objects that look like themselves in every shot. Photos (or a description)
 * become a reference sheet (the whole subject from each side that looks different) and a portrait (a face close-up; an
 * object's clean hero shot), made as ordinary generations; @handle in any prompt then brings them along as references
 * (server/cast-refs), with their real size. Each view is drawn as a picture of its own, in a frame shaped for it, and
 * Crackio lays the sheet out from them at one scale: a model asked for three views in one picture squeezes whichever
 * doesn't fit (a van's side, an umbrella's "side").
 */

const g = globalThis as unknown as { __crackioCastLearning?: Set<string>; __crackioCastSyncing?: Map<string, Promise<Character>> };
const learning = (g.__crackioCastLearning ??= new Set());
const syncing = (g.__crackioCastSyncing ??= new Map());

/* ------------------------------------------------------------------ prompts */

const keep = (c: Pick<Character, "notes">) => (c.notes?.trim() ? ` Always keep: ${c.notes.trim().replace(/\.$/, "")}.` : "");
/** Face coverings are the first thing a portrait "helpfully" removes (a masked man came back unmasked). */
const COVERINGS = "exactly what they wear on the head and face: keep any mask, hat, hood, helmet or glasses as it is, and never show more of the face than the references do";

/** Where the camera stands for each view: a figure faces it; a thing points. */
const SEEN: Record<SheetView, { figure: string; thing: string }> = {
  front: { figure: "seen straight from the front, facing the camera", thing: "seen straight from the front" },
  "three-quarter": { figure: "seen from a three-quarter angle, turned halfway toward the left of the picture", thing: "seen from a three-quarter angle, turned halfway toward the left of the picture" },
  side: { figure: "seen exactly from the side, in profile, facing the left of the picture", thing: "seen exactly from the side, in profile, pointing to the left of the picture" },
  back: { figure: "seen straight from behind, the back to the camera", thing: "seen straight from behind, its rear facing the camera (a vehicle's tail lights and rear bumper, a bag's back panel) and its front out of sight" },
};

/**
 * One view of the subject, alone in a picture shaped for it (see `viewAspect`): the whole subject with room around it,
 * so no model has to squeeze it in beside other views. Its real size goes along, so a car's side stays as long as a car.
 */
function viewPrompt(c: Character, view: SheetView, refs: string) {
  // What it is, in words too: from the front picture alone, a puppy's side view grew into a grown dog.
  const said = (c.description?.trim() || c.noun)?.replace(/\.$/, "").replace(/^(A|An|The) /, (m) => m.toLowerCase());
  const is = said ? ` It is ${said}.` : "";
  // What this side shows, so the model turns it rather than drawing the front it was given again.
  const looks = view === "front" ? undefined : c.kind === "object" ? c.viewLooks?.[view] : FIGURE_LOOKS[c.kind][view];
  const shows = looks ? ` From this side the picture shows ${looks.replace(/\.$/, "")}.` : "";
  const size = c.height
    ? ` It is about ${formatHeight(c.height)} tall${c.length && c.length > c.height * 1.4 ? ` and ${formatHeight(c.length)} long` : ""}: keep those true proportions.`
    : "";
  const backdrop = "on a seamless light-grey studio backdrop";
  switch (c.kind) {
    case "pet":
      return `Full-body studio reference photo of the exact same animal as in ${refs}, ${SEEN[view].figure.replace("the back", "its back")}, standing naturally, the whole animal in the picture with clear space all around it, centered, ${backdrop}.${shows} Identical species, breed, size, fur or feathers, colors, markings, eye color and any collar, true to the references. Soft, even studio light, sharp detail, photorealistic. Only this one animal; no text, no props.${is}${size}${keep(c)}`;
    case "character":
      return `Full-body turnaround drawing of the exact same character as in ${refs}, ${SEEN[view].figure}, the whole character in the picture from top to bottom with clear space all around, centered, on a plain light backdrop.${shows} Keep the exact design, proportions, colors, materials, outfit and art style of the references. Even, neutral light. Only this one character; no text.${is}${keep(c)}`;
    case "object":
      return `Studio reference photo of the exact same object as in ${refs}, ${SEEN[view].thing}, the camera level with its middle, the whole object in the picture with clear space all around it, centered, ${backdrop}.${shows} Identical shape, true proportions, materials, colors, finish, logos and lettering, true to the references; never stretched or squeezed. Soft, even studio light, sharp detail, photorealistic. Only this one object; no text, no props, no people.${is}${size}${keep(c)}`;
    default:
      return `Full-length studio reference photo of the exact same person as in ${refs}, ${SEEN[view].figure}, standing relaxed with arms at their sides, the whole body from the top of the head to the feet in the picture with clear space above and below, centered, ${backdrop}.${shows} Their face (identical to the references), hairstyle, skin tone, body shape, clothing, shoes and accessories exactly as in the references, including ${COVERINGS}. Soft, even studio light, sharp focus, photorealistic, natural skin texture. Only this one person; no text, nothing else in the picture.${is}${keep(c)}`;
  }
}

/** Each view's frame, shaped for what it shows with room to spare: a standing figure is tall, a car's side is long. */
function viewAspect(c: Character, view: SheetView): AspectId {
  if (c.kind === "person" || c.kind === "character") return "2:3";
  if (c.kind === "pet") return view === "side" ? "3:2" : "4:5";
  if (c.long) return view === "side" ? "21:9" : view === "three-quarter" ? "16:9" : "1:1";
  return "1:1";
}

function portraitPrompt(c: Character) {
  const fromText = !c.photos.length;
  const who = fromText ? `${c.description?.trim().replace(/\.$/, "")}.` : "";
  switch (c.kind) {
    case "pet":
      return fromText
        ? `${who} Portrait of this animal facing the camera, head and upper body, on a plain light-grey studio backdrop, soft even light, sharp detail in the fur or feathers and the eyes, photorealistic. No text.${keep(c)}`
        : `Portrait of the exact same animal from the reference pictures, facing the camera, head and upper body, on a plain light-grey studio backdrop. Same species, breed, fur or feathers, markings and eyes as the references. Soft, even light, sharp detail, photorealistic. No text.${keep(c)}`;
    case "character":
      return fromText
        ? `${who} Front-facing portrait of this character from the chest up, on a plain light backdrop, even light, a clean and consistent design. No text.${keep(c)}`
        : `Front-facing portrait of the exact same character from the reference pictures, from the chest up, on a plain light backdrop. Keep the exact design, colors, materials and art style, and ${COVERINGS}. Even light. No text.${keep(c)}`;
    case "object":
      return fromText
        ? `${who} Clean product photo of this object at a three-quarter angle from the front, the whole object in view with space around it, on a seamless light-grey studio backdrop. Soft, even studio light, sharp detail, photorealistic. No text, no props, no people.${keep(c)}`
        : `Clean product photo of the exact same object from the reference pictures, at a three-quarter angle from the front, the whole object in view with space around it, on a seamless light-grey studio backdrop. Identical shape, proportions, materials, colors, finish, logos and lettering. Soft, even studio light, sharp detail, photorealistic. No text, no props, no people.${keep(c)}`;
    default:
      return fromText
        ? `${who} Head-and-shoulders portrait of this person looking at the camera with a relaxed, natural expression, on a plain light-grey studio backdrop. Soft, even light, 85mm lens, photorealistic, natural skin texture. No text.${keep(c)}`
        : `Head-and-shoulders portrait of the exact same person from the reference pictures, looking at the camera with a relaxed, natural expression, on a plain light-grey studio backdrop. Same face, eyes, hairstyle, skin tone and features as the references, and ${COVERINGS}. Soft, even light, 85mm lens, photorealistic, natural skin texture. No text.${keep(c)}`;
  }
}

const READ = `You look at reference pictures of one recurring subject (a person, an animal, a designed character or an object) so image and video models can draw it again in new shots, true to its look and its real size.
Answer with JSON only: {"noun": "...", "traits": "...", "height": 0, "length": 0}
- noun: 3 to 8 words naming exactly this subject by its most telling look: "a woman with a copper bob and freckles", "a grey city pigeon", "a quilted teal leather handbag", "a mint-green vintage hatchback".
- traits: one sentence, 25 to 60 words, of its lasting look in concrete visual words. A person: apparent age range, face shape, eye color, hair color, length and style, skin tone in plain color words (light, olive, brown, dark), build, and distinctive features (freckles, glasses, tattoos, facial hair, a mask or anything covering the face). An animal: species, breed, coat or feather colors and markings, eye color, build. A designed character: its shape, colors, materials and art style. An object: what it is, its shape and proportions, materials, colors, finish, and any logos or lettering (quote short text exactly). Include signature accessories they always have. Leave out a real person's ordinary clothing, and the pose, expression, background and lighting. Never name an ethnicity, race or nationality. No names, no preamble.
- height: its real height in meters, standing or sitting as it normally does: an adult 1.5 to 1.95, a child 0.9 to 1.5, a pigeon 0.3, a cat 0.25, a large dog 0.7, a handbag 0.2 to 0.4, a sneaker 0.12, a bottle 0.1 to 0.35, a car 1.3 to 1.9, a bus 3. A designed character: the size it is meant to be in its world.
- length: for an object much longer than it is tall (a vehicle, a boat, a sofa, a bench), its real length in meters along its longest side: a small hatchback 3.5 to 4, a sedan 4.5 to 5, an SUV 4.5 to 5, a van 4.8 to 6, a bus 12, a bicycle 1.8, a sofa 2. Otherwise 0.`;

const PLAN = `You plan the reference pictures of one object so image and video models can draw it again in new shots. Each view becomes a picture of its own, so choose the fewest views that show everything that looks different from another side.
Views: "front", "three-quarter" (the front turned halfway), "side" (in profile), "back".
- Something that looks the same all the way round (an umbrella, a ball, a bottle, a vase, a lamp, a cup, a potted plant): front only.
- Something big (a car, a van, a boat, a tank, a building): front and side, plus back only when its back looks clearly different and a shot might show it (a van's rear doors and ladder).
- A flat thing (a poster, a phone, a painting, a book, a card): front, plus back when its back has its own design.
- Anything else: front and side, plus back when it looks clearly different from the front.
Answer with JSON only: {"views": ["front", ...], "why": "...", "looks": {"side": "...", "back": "..."}}
- why: one plain sentence under 16 words for the person adding it, like "It looks the same from every side, so one view shows it best."
- looks: for each view but the front, what that side of it shows, in 8 to 25 plain words, saying only what IS there: a guitar's back "the plain wooden back of the body and the back of the neck with its tuning pegs", a backpack's back "the padded back panel and both shoulder straps", a van's back "the two rear doors, the tail lights and the ladder". Leave out views you didn't choose.`;

/* ------------------------------------------------------------------ building */

/** The model Cast's Auto runs: the same rule the picker shows (your default, then Cast's favorites), among models that take pictures. */
export async function castAutoModel() {
  const models = (await listModels()).filter((m) => m.kind === "image");
  return pickAuto("image", models, (await getSettings()).models ?? {}, CAST_PREFER, castFits);
}

/** The model for one of a character's pictures: yours or Auto's, except that a first picture from words needs one that draws without a picture (an editor like FLUX.2 klein Edit can't). */
async function modelFor(c: Character, withPictures: boolean) {
  const chosen = c.model ?? (await castAutoModel())?.id;
  if (withPictures) return chosen ?? "auto";
  const models = (await listModels()).filter((m) => m.kind === "image");
  const drawsFromWords = (m: { caps?: { image?: { required?: boolean } | null } | null }) => !m.caps?.image?.required;
  const own = models.find((m) => m.id === chosen);
  if (own && drawsFromWords(own)) return own.id;
  return pickAuto("image", models, (await getSettings()).models ?? {}, CAST_PREFER, drawsFromWords)?.id ?? "auto";
}

/**
 * Which views to draw: only the sides that look different. People, animals and characters do from every side (front,
 * side, back); for a thing, a text model looks at the photo or the words (an umbrella is the same all round: front only;
 * a car: front and side). Without a text model, the same rules by its words.
 */
export async function planViews(input: { kind: CastKind; name?: string; description?: string; notes?: string; photo?: string }): Promise<{ views: SheetView[]; why?: string; looks?: Partial<Record<SheetView, string>> }> {
  const words = `${input.name ?? ""} ${input.description ?? ""} ${input.notes ?? ""}`;
  if (input.kind !== "object") return { views: defaultViews(input.kind, words), why: `${input.kind === "pet" ? "Animals" : input.kind === "character" ? "Characters" : "People"} look different from every side.` };
  const photo = input.photo ? urlToPath(input.photo) : null;
  const answer = await askText({
    instructions: PLAN,
    text: `Plan the views of ${input.name ? `"${input.name}"` : "this object"}.${input.description ? ` It looks like: ${input.description}` : ""}${input.notes ? ` Always keep: ${input.notes}` : ""}`,
    references: photo ? [{ path: photo, label: "the object" }] : [],
    imageEdge: 768,
    timeoutMs: 45_000,
  }).catch(() => null);
  const raw = answer ? jsonObject<{ views?: unknown; why?: unknown; looks?: unknown }>(answer) : null;
  const views = Array.isArray(raw?.views) ? tidyViews(raw.views.filter((v): v is string => typeof v === "string")) : [];
  if (!views.length) return { views: defaultViews(input.kind, words) };
  const told = raw?.looks && typeof raw.looks === "object" ? (raw.looks as Record<string, unknown>) : {};
  const looks = Object.fromEntries(
    views.flatMap((v) => (v !== "front" && typeof told[v] === "string" && told[v].trim() ? [[v, told[v].replace(/\s+/g, " ").trim().slice(0, 200)]] : [])),
  ) as Partial<Record<SheetView, string>>;
  return { views, why: typeof raw?.why === "string" ? raw.why.replace(/\s+/g, " ").trim().slice(0, 140) || undefined : undefined, ...(Object.keys(looks).length ? { looks } : {}) };
}

async function enqueue(c: Character, part: "portrait" | "view", references: ReferenceRef[], view: SheetView = "front") {
  const aspect: AspectId = part === "view" ? viewAspect(c, view) : c.kind === "object" ? (c.long ? "3:2" : "1:1") : "4:5";
  const model = await modelFor(c, references.length > 0);
  const refs = references.length > 1 || !c.photos.length ? "the reference pictures" : "the reference photo";
  const gen: Generation = {
    id: nanoid(14),
    tool: "cast",
    engine: "auto",
    model,
    status: "queued",
    prompt: part === "view" ? `${c.name} · ${VIEW_LABELS[view].toLowerCase()} view` : `${c.name} · ${c.kind === "object" ? "hero shot" : "portrait"}`,
    compiledPrompt: part === "view" ? viewPrompt(c, view, refs) : portraitPrompt(c),
    aspect,
    count: 1,
    references,
    outputs: [],
    params: { kind: "image", refine: false, cast: [{ id: c.id, part, ...(part === "view" ? { view } : {}) }], options: { longEdge: 1536, resolution: "2k" } },
    progress: 0,
    stage: "Queued",
    createdAt: Date.now(),
  };
  saveGeneration(gen);
  runner().enqueue(gen.id);
  return gen.id;
}

const photoRefs = (c: Character): ReferenceRef[] =>
  c.photos.map((url, i) => ({ url, label: `${c.name}, photo ${i + 1} of ${c.photos.length}`, role: c.kind === "object" ? ("product" as const) : ("subject" as const) }));

/**
 * From photos, the front view comes first; the other views are drawn from it and the photos (so they agree), and the
 * portrait from the photos and the front view (a portrait drawn alone from a masked man's photo came back unmasked).
 * From a description, the portrait comes first, then the front view from it, then the others.
 */
async function startBuild(c: Character): Promise<Character["jobs"]> {
  return c.photos.length ? { views: { front: await enqueue(c, "view", photoRefs(c), "front") } } : { portrait: await enqueue(c, "portrait", []) };
}

/** The sheet, laid out from the finished views; saved as a picture of its own. */
async function layOut(c: Character, views: SheetView[]) {
  const files = views.map((v) => urlToPath(c.viewPictures?.[v] ?? "")).filter((f): f is string => Boolean(f));
  if (files.length !== views.length) throw new Error("a view's picture is missing");
  const { data, layout } = await assembleSheet(files);
  const saved = await saveUpload(data);
  return { url: saved.url, layout };
}

/** Name, traits and real height from the finished pictures; null when no text model answers. */
async function read(c: Character) {
  const images = [c.sheet, c.portrait, ...c.photos].flatMap((url) => {
    const path = url ? urlToPath(url) : null;
    return path ? [{ path, label: c.name }] : [];
  });
  if (!images.length) return null;
  const answer = await askText({
    instructions: READ,
    text: `Describe ${c.name}, a ${castNoun(c.kind)}.${c.description ? ` It was described as: ${c.description}` : ""}${c.notes ? ` Always keep: ${c.notes}` : ""}`,
    references: images.slice(0, 4),
    imageEdge: 1024,
  });
  const raw = answer ? jsonObject<Partial<{ noun: string; traits: string; height: number; length: number }>>(answer) : null;
  if (!raw) return null;
  const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, n) : "");
  const height = typeof raw.height === "number" && raw.height > 0.01 && raw.height < 60 ? Math.round(raw.height * 100) / 100 : undefined;
  const length = c.kind === "object" && typeof raw.length === "number" && raw.length > 0.3 && raw.length < 120 ? Math.round(raw.length * 100) / 100 : undefined;
  return { noun: tidy(raw.noun, 90) || undefined, traits: tidy(raw.traits, 600) || undefined, height, length };
}

/** Learned in the background once the pictures exist: what it is, how it looks, how big it is. */
function learn(c: Character) {
  if ((c.traits && c.noun && (c.height || c.heightSet)) || learning.has(c.id)) return;
  learning.add(c.id);
  void read(c)
    .then((r) => {
      const now = loadCharacter(c.id);
      if (!r || !now) return;
      saveCharacter({
        ...now,
        noun: now.noun ?? r.noun,
        traits: now.traits ?? r.traits,
        height: now.heightSet ? now.height : (now.height ?? r.height),
        length: now.length ?? r.length,
        updatedAt: Date.now(),
      });
    })
    .catch((err) => console.warn(`[cast] couldn't read ${c.name}: ${(err as Error).message}`))
    .finally(() => learning.delete(c.id));
}

/** Read the pictures again now (the "Rewrite" button): a new noun, traits and, unless you typed it, height. */
export async function redescribeCharacter(id: string) {
  const c = loadCharacter(id);
  if (!c) return null;
  const r = await read(c);
  if (!r?.traits) throw new Error("No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok, or write it yourself.");
  const next: Character = { ...c, noun: r.noun ?? c.noun, traits: r.traits, height: c.heightSet ? c.height : (r.height ?? c.height), updatedAt: Date.now() };
  saveCharacter(next);
  return next;
}

/**
 * Catch a character up with its running generations: the next pictures start once the ones they're drawn from are in,
 * and the sheet is laid out once every view is. One catch-up at a time per member (the page asks every two seconds while
 * it builds; two at once would start a picture twice).
 */
function sync(c: Character): Promise<Character> {
  const running = syncing.get(c.id);
  if (running) return running;
  const next = catchUp(c).finally(() => syncing.delete(c.id));
  syncing.set(c.id, next);
  return next;
}

async function catchUp(c: Character): Promise<Character> {
  if (c.status !== "building") {
    if (c.status === "ready") learn(c);
    return c;
  }
  let next: Character = { ...c, jobs: { ...c.jobs, views: { ...c.jobs.views } }, viewPictures: { ...c.viewPictures } };
  const progress: number[] = [];
  // The portrait (or hero shot), and a one-picture sheet still running from before views were drawn one by one.
  for (const part of ["portrait", "sheet"] as const) {
    const id = next.jobs[part];
    if (!id) continue;
    const gen = getGeneration(id);
    if (!gen) {
      next = { ...next, status: "error", error: `The ${part} job is gone. Rebuild to try again.` };
      continue;
    }
    if (gen.status === "done" && gen.outputs[0]) {
      next[part] = gen.outputs[0].url;
      if (part === "sheet") {
        const file = next.long ? urlToPath(gen.outputs[0].url) : null;
        const sheetLayout = file ? await sheetLayoutOf(file).catch(() => undefined) : undefined;
        next = { ...next, views: SHEET_VIEWS, viewPictures: undefined, builtWith: gen.modelName ?? next.builtWith, sheetLayout };
      }
      delete next.jobs[part];
    } else if (gen.status === "error") {
      next = { ...next, status: "error", error: gen.error ?? `The ${part} didn't render.` };
      delete next.jobs[part];
    } else progress.push(gen.progress ?? 0);
  }
  for (const [view, id] of Object.entries(next.jobs.views ?? {}) as [SheetView, string][]) {
    const gen = getGeneration(id);
    if (!gen) {
      next = { ...next, status: "error", error: `The ${view} view's job is gone. Rebuild to try again.` };
      delete next.jobs.views![view];
    } else if (gen.status === "done" && gen.outputs[0]) {
      next.viewPictures = { ...next.viewPictures, [view]: gen.outputs[0].url };
      if (view === "front") next.builtWith = gen.modelName ?? next.builtWith;
      delete next.jobs.views![view];
    } else if (gen.status === "error") {
      next = { ...next, status: "error", error: gen.error ?? `The ${view} view didn't render.` };
      delete next.jobs.views![view];
    } else progress.push(gen.progress ?? 0);
  }
  const views = next.views ?? SHEET_VIEWS;
  if (next.status === "building" && !next.jobs.sheet) {
    const label = (what: string) => `${next.name}, ${what}`;
    const role = next.kind === "object" ? ("product" as const) : ("subject" as const);
    const front = next.viewPictures?.front;
    // From a description: the front view is drawn from the finished portrait (an object's hero shot).
    if (!front && !next.jobs.views?.front && next.portrait && !next.photos.length) {
      next.jobs.views = { ...next.jobs.views, front: await enqueue(next, "view", [{ url: next.portrait, label: label(next.kind === "object" ? "hero shot" : "portrait"), role }], "front") };
      progress.push(0);
    }
    if (front) {
      // The other sides, each from the front view (so they agree) and the photos or the portrait.
      const from: ReferenceRef[] = [
        { url: front, label: label("front view, the look to keep"), role },
        ...(next.photos.length ? photoRefs(next) : next.portrait ? [{ url: next.portrait, label: label(next.kind === "object" ? "hero shot" : "portrait"), role }] : []),
      ];
      for (const view of views) {
        if (view === "front" || next.viewPictures?.[view] || next.jobs.views?.[view]) continue;
        // A long thing's back is drawn once its side is in, from the side too: from the front alone, a model drew an SUV's
        // front again and called it the back.
        const fromSide = view === "back" && next.long && views.includes("side");
        if (fromSide && !next.viewPictures?.side) continue;
        const refs = fromSide ? [{ url: next.viewPictures!.side!, label: label("side view, showing its rear end"), role }, ...from] : from;
        next.jobs.views = { ...next.jobs.views, [view]: await enqueue(next, "view", refs, view) };
        progress.push(0);
      }
      // From photos: the portrait is drawn from the photos and the front view.
      if (next.photos.length && !next.portrait && !next.jobs.portrait) {
        next.jobs.portrait = await enqueue(next, "portrait", [...photoRefs(next), { url: front, label: label("front view"), role }]);
        progress.push(0);
      }
    }
    // Every view in: Crackio lays the sheet out, every view at one scale.
    if (!next.sheet && views.every((v) => next.viewPictures?.[v])) {
      try {
        const sheet = await layOut(next, views);
        next = { ...next, sheet: sheet.url, sheetLayout: sheet.layout };
      } catch (err) {
        next = { ...next, status: "error", error: `The sheet couldn't be laid out (${(err as Error).message}). Rebuild to try again.` };
      }
    }
  }
  if (next.status === "building" && next.portrait && next.sheet) next = { ...next, status: "ready", error: undefined, previous: undefined };
  // A rebuild that fails gives back what it had: an hour into a project, a broken rebuild mustn't cost you the sheet.
  if (next.status === "error" && next.previous) {
    const why = next.error?.replace(/\.$/, "") ?? "a picture didn't render";
    next = { ...next, ...next.previous, status: "ready", error: `The rebuild didn't finish (${why}). This is the sheet from before.`, previous: undefined, jobs: {} };
  }
  if (!Object.keys(next.jobs.views ?? {}).length) delete next.jobs.views;
  // Progress: the portrait and each view (or the one-picture sheet of a build from before).
  const drawn = Object.keys(next.viewPictures ?? {}).length;
  const onePicture = Boolean(next.jobs.sheet || (next.sheet && !drawn));
  const total = 1 + (onePicture ? 1 : views.length);
  const done = (next.portrait ? 1 : 0) + (onePicture ? (next.sheet ? 1 : 0) : drawn);
  next.progress = next.status === "building" ? Math.min(0.98, (done + progress.reduce((a, b) => a + b, 0)) / total) : undefined;
  if (!drawn) delete next.viewPictures;
  if (JSON.stringify(next) !== JSON.stringify(c)) saveCharacter({ ...next, updatedAt: Date.now() });
  if (next.status === "ready") learn(next);
  return next;
}

/* ------------------------------------------------------------------ public */

export async function listCharacters(): Promise<Character[]> {
  return Promise.all(allCharacters().map(sync));
}

export async function getCharacter(id: string) {
  const c = loadCharacter(id);
  return c ? sync(c) : null;
}

export { sheetFrontView, sheetViews, viewsOf } from "./cast-sheet";

export async function createCharacter(input: {
  name: string;
  kind: CastKind;
  photos: string[];
  description?: string;
  notes?: string;
  model?: string;
  height?: number;
  heightSet?: boolean;
  /** Much longer than tall (the page knows it from the photo's reading: a vehicle); else guessed from the words. */
  long?: boolean;
  /** The views to draw, as planned on the page (and maybe changed there); else planned here. */
  views?: string[];
  viewsWhy?: string;
  viewLooks?: Partial<Record<SheetView, string>>;
}) {
  const now = Date.now();
  const long = input.kind === "object" && (input.long ?? isLong(`${input.name} ${input.description ?? ""} ${input.notes ?? ""}`));
  const plan = input.views?.length
    ? { views: tidyViews(input.views), why: input.viewsWhy?.trim() || undefined, looks: input.viewLooks }
    : await planViews({ kind: input.kind, name: input.name, description: input.description, notes: input.notes, photo: input.photos[0] });
  const c: Character = {
    id: nanoid(12),
    name: input.name.trim(),
    handle: freeHandle(input.name),
    kind: input.kind,
    photos: input.photos.slice(0, 4),
    description: input.photos.length ? undefined : input.description?.trim(),
    notes: input.notes?.trim() || undefined,
    ...(long ? { long: true } : {}),
    views: plan.views,
    ...(plan.why ? { viewsWhy: plan.why } : {}),
    ...(plan.looks ? { viewLooks: plan.looks } : {}),
    ...(input.height ? { height: input.height, ...(input.heightSet !== false ? { heightSet: true } : {}) } : {}),
    ...(input.model && input.model !== "auto" ? { model: input.model } : {}),
    status: "building",
    jobs: {},
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  saveCharacter(c);
  const built = { ...c, jobs: await startBuild(c) };
  saveCharacter(built);
  return built;
}

export async function updateCharacter(
  id: string,
  patch: { name?: string; handle?: string; notes?: string; traits?: string; noun?: string; height?: number | null; kind?: CastKind; model?: string | null },
) {
  const c = loadCharacter(id);
  if (!c) return null;
  const next: Character = {
    ...c,
    name: patch.name?.trim() || c.name,
    handle: patch.handle !== undefined ? freeHandle(patch.handle || patch.name || c.name, c.id) : c.handle,
    kind: patch.kind ?? c.kind,
    notes: patch.notes !== undefined ? patch.notes.trim() || undefined : c.notes,
    traits: patch.traits !== undefined ? patch.traits.trim() || undefined : c.traits,
    noun: patch.noun !== undefined ? patch.noun.trim() || undefined : c.noun,
    // A height you type stays; clearing it lets the next reading set it again.
    ...(patch.height !== undefined ? (patch.height ? { height: patch.height, heightSet: true } : { height: undefined, heightSet: undefined }) : {}),
    model: patch.model !== undefined ? (patch.model && patch.model !== "auto" ? patch.model : undefined) : c.model,
    updatedAt: Date.now(),
  };
  saveCharacter(next);
  return next;
}

/**
 * Draw the portrait and the sheet again (after new notes, or when a take came out wrong), with the views asked for, else
 * the ones it has (a sheet from before views were planned gets a plan now). Its height stays if you typed it.
 */
export async function rebuildCharacter(id: string, views?: string[]) {
  const c = loadCharacter(id);
  if (!c) return null;
  const plan: Awaited<ReturnType<typeof planViews>> = views?.length
    ? { views: tidyViews(views), why: c.viewsWhy, looks: c.viewLooks }
    : c.viewPictures && c.views && (c.kind !== "object" || c.viewLooks)
      ? { views: c.views, why: c.viewsWhy, looks: c.viewLooks }
      : await planViews({ kind: c.kind, name: c.name, description: c.description ?? c.noun, notes: c.notes, photo: c.photos[0] ?? c.portrait });
  // A car drawn before Cast knew long things need their own layout gets it now (its reading says what it is).
  const long = c.kind === "object" && (c.long || isLong(`${c.name} ${c.noun ?? ""} ${c.description ?? ""} ${c.notes ?? ""}`));
  const kept = c.sheet || c.portrait ? (c.previous ?? { portrait: c.portrait, sheet: c.sheet, views: c.views, viewsWhy: c.viewsWhy, viewLooks: c.viewLooks, viewPictures: c.viewPictures, sheetLayout: c.sheetLayout, builtWith: c.builtWith, noun: c.noun, traits: c.traits, height: c.height }) : c.previous;
  const reset: Character = {
    ...c,
    previous: kept,
    ...(long ? { long: true } : {}),
    status: "building",
    error: undefined,
    portrait: undefined,
    sheet: undefined,
    views: plan.views,
    viewsWhy: plan.why,
    viewLooks: plan.looks,
    viewPictures: undefined,
    sheetLayout: undefined,
    traits: undefined,
    noun: undefined,
    ...(c.heightSet ? {} : { height: undefined }),
    jobs: {},
    progress: 0,
  };
  const next = { ...reset, jobs: await startBuild(reset), updatedAt: Date.now() };
  saveCharacter(next);
  return next;
}

/** Lay the sheet out again from the views it has (no new pictures): after the layout changes, or to undo a bad one. */
export async function relayoutCharacter(id: string) {
  const c = loadCharacter(id);
  if (!c?.viewPictures || !c.views || c.status !== "ready") return c;
  const sheet = await layOut(c, c.views);
  const next: Character = { ...c, sheet: sheet.url, sheetLayout: sheet.layout, updatedAt: Date.now() };
  saveCharacter(next);
  return next;
}

/** Forget the character. Its takes stay in the Library. */
export function deleteCharacter(id: string) {
  removeCharacter(id);
}

/* ------------------------------------------------------------------ mentions */

type Mentioned = { id: string; name: string; handle: string };

const usable = (c: Character | null): c is Character => Boolean(c && (c.portrait || c.sheet || c.photos.length));

/** The characters a text mentions with @handle (only ones with something to show). */
export function mentionedCast(text: string): Character[] {
  return mentionedHandles(text).map(characterByHandle).filter(usable);
}

/**
 * "@mia" in a request, for jobs whose model is picked later (plain Image and Video jobs): the handles stay in the words
 * and Mia is listed in `cast`, so the runner brings her sheet and portrait along in the way that model takes pictures
 * (server/cast-refs).
 */
export function noteMentions(input: { prompt: string; compiledPrompt?: string }): Mentioned[] {
  return mentionedHandles(`${input.prompt}\n${input.compiledPrompt ?? ""}`)
    .map(characterByHandle)
    .filter(usable)
    .map((c) => ({ id: c.id, name: c.name, handle: c.handle }));
}

/**
 * Turn "@mia" in a request into Mia herself, for tools that read the references they're given (Product Studio's notes,
 * Recast): her sheet and portrait join the references (for images), her name replaces the handle, and her traits ride
 * along so models that see fewer images still draw the same face.
 */
export function resolveMentions(input: { prompt: string; compiledPrompt?: string; references: ReferenceRef[]; kind?: unknown }) {
  const found = mentionedHandles(`${input.prompt}\n${input.compiledPrompt ?? ""}`).map(characterByHandle).filter(usable);
  if (!found.length) return { ...input, cast: [] as Mentioned[] };

  const withImages = !input.kind || input.kind === "image";
  const references = [...input.references];
  if (withImages) {
    // The sheet first (the whole subject from every side), then the face while there's room.
    const roomy = input.references.length + found.length * 2 <= 5;
    for (const c of found) {
      const label = `${c.name}, the ${castNoun(c.kind)} to keep consistent${c.traits ? ` (${c.traits.replace(/\.$/, "")})` : ""}`;
      const picks = roomy ? [c.sheet, c.portrait] : [c.sheet ?? c.portrait ?? c.photos[0]];
      for (const url of picks) if (url && references.length < 16) references.push({ url, label, role: c.kind === "object" ? "product" : "subject" });
    }
  }

  const replace = (text: string, describe: boolean) =>
    text.replace(MENTION, (all, lead: string, handle: string) => {
      const c = found.find((x) => x.handle === handle.toLowerCase());
      if (!c) return all;
      if (!describe) return `${lead}${c.name}`;
      const detail = withImages ? `the ${castNoun(c.kind)} in the reference images` : c.traits?.replace(/\.$/, "");
      return `${lead}${c.name}${detail ? ` (${detail})` : ""}`;
    });

  return {
    prompt: replace(input.prompt, !withImages),
    compiledPrompt: input.compiledPrompt ? replace(input.compiledPrompt, true) : undefined,
    references,
    cast: found.map((c) => ({ id: c.id, name: c.name, handle: c.handle })),
  };
}
