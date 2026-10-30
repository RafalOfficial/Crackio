import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Vector3 } from "three";
import { DATA_DIR } from "./paths";
import { saveUpload, urlToPath } from "./media";
import { sheetViews, viewsOf } from "./cast-sheet";
import { loadCharacter } from "./cast-store";
import { estimateDepth } from "./vision";
import { LEGACY_SHEET_VIEWS } from "@/lib/cast/types";
import { angleDelta, frameElements, shotCamera, yawTowardCamera, type Framing } from "@/lib/director/camera";
import { cameraWords } from "@/lib/director/compile";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { subjectViews } from "@/lib/director/views";
import { poseOf } from "@/lib/director/standin";
import { ELEMENT_DEFAULTS, STYLES } from "@/lib/director/vocab";
import type { Scene, SceneElement } from "@/lib/director/types";
import type { Generation } from "@/lib/generations/types";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineReference, type EngineResult } from "@/lib/engines/types";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director");

/**
 * The shot drawn fresh from the pieces: the model gets the shot's shape, not its pixels. A depth map of the set fixes the
 * camera, the ground and where everyone stands and how big; the place's photo shows what the place looks like; the
 * cast's own pictures, from the sides the camera sees, show who they are; the words say the rest. Everything is drawn
 * new, so nothing soft or digital from a world texture is copied into the shot (the user: "it's basically a copy paste
 * machine ... it has no breathing space"). Measured 2026-10-29 on the user's cafe, Qwen-Image 2.1: the same cafe, the
 * two people where the set has them, a real photograph, where the plate and swap came back digital.
 *
 * `structure: "place"` reads the depth of the camera view itself (the world's buildings too, from its picture) where
 * "stage" uses the set's own depth (the ground and the cast): the place is then only described.
 */
export async function runDirectorFresh(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult & { plateUrl: string; swapUrl: string }> {
  const scene = gen.params?.scene as Scene;
  const depthFile = typeof gen.params?.depthUrl === "string" ? urlToPath(gen.params.depthUrl) : null;
  const blocking = typeof gen.params?.blockingUrl === "string" ? urlToPath(gen.params.blockingUrl) : null;
  if (!depthFile || !blocking) throw new EngineError("This shot is missing its depth.", "Shoot it again.");
  ctx.progress(0.03, "Reading the shot");
  const meta = await sharp(depthFile).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 864;

  // 1. The shape of the shot: the set's depth, softened so the stand-ins read as bodies, not mannequins (Qwen-Image-Edit
  // 2511 drew wooden dolls from a sharp one); or the depth of the whole view, buildings included.
  const structure = gen.params?.structure === "place" ? "place" : "stage";
  const shape = path.join(DIR, `fresh-depth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
  await fs.mkdir(DIR, { recursive: true });
  if (structure === "place") {
    const d = await estimateDepth(blocking);
    const raw = Buffer.from(d.data, "base64");
    const px = Buffer.alloc(d.width * d.height);
    for (let i = 0; i < d.width * d.height; i++) px[i] = raw.readUInt16LE(i * 2) >> 8;
    await sharp(px, { raw: { width: d.width, height: d.height, channels: 1 } }).resize(W, H, { fit: "fill", kernel: "lanczos3" }).blur(1.5).png().toFile(shape);
  } else if (gen.params?.figures === true) {
    // The stand-ins as they are, lightly blurred: their pose too.
    await sharp(depthFile).blur(Math.max(2, W / 160)).png().toFile(shape);
  } else if (gen.params?.figures === "soft") {
    // Each stand-in melted into a soft glow: where a body is and how near stays, its pose doesn't. On Qwen-Image 2.1
    // it kept Kai on his mark and gave Noor open, gesturing hands.
    await sharp(await softFigures(depthFile, gen, W)).png().toFile(shape);
  } else {
    // The ground alone: the stand-ins taken out of the set's depth (each of their pixels given its row's ground), so
    // the camera's height and angle stay and nobody's body is shaped by a mannequin's. The user's pick of three on
    // Qwen-Image 2.1 (sharp stand-ins stood Kai stiff like the mannequin and twisted Noor's hands); FLUX 3 places
    // everyone by its layout boxes. By default ("auto") those with a pose to hold keep their stand-in: on the 9-shot
    // benchmark (3 scenes x 3 ways) only the stand-ins got "Kai sitting at a table reading, Noor walking past" (with
    // none, Kai stood and a stranger read the paper), while standing people acted best free.
    const keep = gen.params?.figures === "auto" ? posedColors(gen) : [];
    await sharp(await withoutFigures(depthFile, gen, keep)).blur(Math.max(2, W / 160)).png().toFile(shape);
  }

  // 2. The pieces: the place's photo, and the cast in one picture, left to right as they stand in the frame.
  const cam = shotCamera(scene);
  const framed = frameElements(scene, cam)
    .filter((f) => f.inFrame)
    .sort((a, b) => a.cx - b.cx);
  const seen = new Map(subjectViews(scene).map((v) => [v.id, v.around]));
  const pictures: { f: Framing; file: string }[] = [];
  for (const f of framed) {
    const file = await matchedView(f.element, seen.get(f.element.id) ?? 0).catch(() => null);
    if (file) pictures.push({ f, file });
  }
  // FLUX reads a collage as a layout, so it gets each member as a picture of their own (FLUX 3 Klein: 16 to 10 for
  // separate pictures, the Cast session's side-by-sides); Qwen-Image 2.1 copies each separate photo's pose, so it gets
  // them on one sheet.
  const separate = /flux/i.test(`${gen.model ?? ""} ${job.model}`);
  const castSheet = pictures.length && !separate ? await sheetOf(pictures.map((p) => p.file)) : null;
  // The place as this camera sees it in its world (rough is fine: it's drawn fresh), so the background turns with the
  // camera: given the place's photo, a shot down the side street came back with the photo's cafe front behind it
  // (Qwen-Image 2.1, the user's cafe). `reference: "photo"` gives the photo instead.
  const comp = gen.params?.comp as { plateUrl?: string } | undefined;
  const view = scene.place.world && gen.params?.reference !== "photo" && comp?.plateUrl ? urlToPath(comp.plateUrl) : null;
  const place = view ?? (scene.place.image ? urlToPath(scene.place.image.url) : null);
  const references: EngineReference[] = [{ path: shape, label: "the shot's depth", role: "edit-target" }];
  if (place) references.push({ path: place, label: "the place", role: "subject" });
  if (castSheet) references.push({ path: castSheet, label: "the cast", role: "subject" });
  const firstCast = references.length + 1;
  if (separate) for (const p of pictures) references.push({ path: p.file, label: p.f.element.name, role: "subject" });

  // FLUX 3 reads where each subject is as boxes after the words (its layout prompt: what ComfyUI's Flux3LayoutPrompt
  // writes, [ymin, xmin, ymax, xmax] on a 0 to 1000 grid, cited in the words as <obj_N>): each one's place and real
  // size in the frame, where FLUX 3 Klein framed the cast tighter than the set and drifted.
  const flux3 = /flux3|flux-3/i.test(`${gen.model ?? ""} ${job.model}`);
  const boxes = ((gen.params?.comp as { boxes?: { id: string; box: [number, number, number, number] }[] } | undefined)?.boxes ?? []);
  const grid = (v: number, M: number) => Math.round((Math.max(0, Math.min(M, v)) / M) * 1000);
  const layout = flux3
    ? framed.flatMap((f) => {
        const b = boxes.find((x) => x.id === f.element.id);
        if (!b) return [];
        const [x0, y0, x1, y1] = b.box;
        return [{ el: f.element.id, bbox: [grid(y0, H), grid(x0, W), grid(y1, H), grid(x1, W)] as [number, number, number, number], desc: nounOf(f.element) }];
      })
    : [];
  const tags = new Map(layout.map((l, i) => [l.el, `obj_${i + 1}`]));
  ctx.progress(0.04, "Directing the cast");
  const beats = await actingBeats(scene, framed, cam.position);
  const prompt = freshPrompt(scene, framed, cam.position, {
    place: place ? 2 : null,
    view: Boolean(view),
    cast: castSheet ? references.length : null,
    each: separate && pictures.length ? firstCast : null,
    pictured: new Set(pictures.map((p) => p.f.element.id)),
    beats,
    keep: keepNotes(framed),
    tags,
  });
  const fullPrompt = layout.length ? `${prompt} ${JSON.stringify(layout.map((l, i) => ({ id: `obj_${i + 1}`, bbox: l.bbox, desc: l.desc })))}` : prompt;
  // The stand-ins are never drawn: in Qwen-Image 2.1's negative words too, for photographic styles and leaving out what
  // the shot asks for ("a shop window of mannequins"). FLUX runs at CFG 1, where negative words do nothing.
  const asked = `${scene.notes} ${framed.map((f) => `${f.element.name} ${f.element.look ?? ""} ${f.element.action ?? ""}`).join(" ")}`.toLowerCase();
  const never = (PHOTO_STYLES.includes((STYLES.find((x) => x.id === scene.style) ?? STYLES[0]).id) ? ["mannequin", "doll", "statue", "grey clay figure", "3D render"] : []).filter(
    (w) => !asked.includes(w.split(" ")[0].toLowerCase()),
  );
  if (!separate && never.length) job.options = { ...job.options, negative: [typeof job.options?.negative === "string" ? job.options.negative : "", never.join(", ")].filter(Boolean).join(", ") };
  try {
    const { outputs } = await engine.run(
      { ...job, prompt: fullPrompt, userPrompt: fullPrompt, refine: false, references, guide: undefined, depth: undefined, layout: undefined },
      { signal: ctx.signal, progress: (v) => ctx.progress(0.05 + v * 0.93, "Drawing the shot") },
    );
    if (!outputs.length) throw new EngineError("The model returned no picture.");
    // Faces drawn small come back soft or wrong (the user's crop: closed, smeared eyes on a laughing boy): each one is
    // drawn again up close and put back.
    // Off unless asked for: a patch redrawn at half strength moved hands and cups, and the blend left them ghosted
    // (2K alone drew the faces clean).
    const faces = gen.params?.faces !== true ? [] : framed.filter((f) => f.element.kind === "person" && boxes.some((b) => b.id === f.element.id));
    const finished: typeof outputs = [];
    for (const [i, out] of outputs.entries()) {
      ctx.progress(0.9 + (0.08 * i) / outputs.length, "Drawing the faces up close");
      finished.push(faces.length ? { ...out, data: await withFaces(out.data, faces, boxes, W, H, beats, job, engine, ctx.signal).catch(() => out.data) } : out);
    }
    const shapeSaved = await saveUpload(await fs.readFile(shape));
    return { outputs: finished, usedPrompt: fullPrompt, plateUrl: shapeSaved.url, swapUrl: shapeSaved.url };
  } finally {
    await fs.rm(shape, { force: true });
  }
}

/**
 * A face pass: each person's head, found from where the set has them (their stand-in's box: the head is the top
 * seventh of a standing body), cut out with room around it, drawn again at about a megapixel at half strength with
 * their Cast portrait for the likeness, and blended back. Faces already drawn big enough are left alone.
 */
async function withFaces(
  picture: Buffer,
  faces: Framing[],
  boxes: { id: string; box: [number, number, number, number] }[],
  W: number,
  H: number,
  beats: Map<string, string>,
  job: EngineJob,
  engine: Engine,
  signal: AbortSignal,
) {
  const meta = await sharp(picture).metadata();
  const OW = meta.width ?? W;
  const OH = meta.height ?? H;
  const sx = OW / W;
  const sy = OH / H;
  let img = await sharp(picture).removeAlpha().png().toBuffer();
  for (const f of faces) {
    const b = boxes.find((x) => x.id === f.element.id);
    if (!b) continue;
    const [x0, y0, x1, y1] = b.box;
    if (y0 < 0) continue; // the head is out of frame
    const body = (y1 - y0) * sy;
    const head = body * 0.15;
    if (head > 300 || head < 18) continue; // big enough already, or too small to matter
    const side = Math.round(Math.min(OW, OH, head * 2.8));
    const cx = ((x0 + x1) / 2) * sx;
    const cy = y0 * sy + body * 0.085;
    const left = Math.round(Math.max(0, Math.min(OW - side, cx - side / 2)));
    const top = Math.round(Math.max(0, Math.min(OH - side, cy - side * 0.45)));
    const crop = await sharp(img).extract({ left, top, width: side, height: side }).resize(1024, 1024, { kernel: "lanczos3" }).png().toBuffer();
    const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const cropFile = path.join(DIR, `face-${tag}.png`);
    await fs.writeFile(cropFile, crop);
    const portrait = f.element.cast?.portrait ? urlToPath(f.element.cast.portrait) : null;
    const noun = nounOf(f.element);
    const beat = beats.get(f.element.id);
    const prompt =
      `A close-up of the face of the ${noun}${beat ? `: ${beat.replace(/\.?$/, "")}` : ""}. Keep image 1 as it is: the same head angle, pose, expression, light and background. ` +
      `Draw the face sharp and real: clear, open eyes looking where they look, natural skin and teeth, real hair.${portrait ? " They look exactly like image 2: the same face, hair and skin." : ""} No text.`;
    try {
      const { outputs } = await engine.run(
        {
          ...job,
          prompt,
          userPrompt: prompt,
          refine: false,
          count: 1,
          aspect: "1:1",
          width: 1024,
          height: 1024,
          references: [{ path: cropFile, label: "the face", role: "edit-target" }, ...(portrait ? [{ path: portrait, label: f.element.name, role: "subject" as const }] : [])],
          options: { ...job.options, denoise: 0.45 },
          guide: undefined,
          depth: undefined,
          layout: undefined,
          mask: undefined,
        },
        { signal, progress: () => undefined },
      );
      if (!outputs[0]) continue;
      const redrawn = await sharp(outputs[0].data).resize(side, side, { fit: "fill", kernel: "lanczos3" }).removeAlpha().png().toBuffer();
      // Blended in through a soft round mask, so no square edge shows.
      const r = side / 2;
      const mask = Buffer.from(
        `<svg width="${side}" height="${side}"><defs><radialGradient id="g"><stop offset="62%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient></defs><rect width="100%" height="100%" fill="#000"/><circle cx="${r}" cy="${r}" r="${r}" fill="url(#g)"/></svg>`,
      );
      const alpha = await sharp(mask).resize(side, side).greyscale().raw().toBuffer();
      const patch = await sharp(redrawn).joinChannel(alpha, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
      img = await sharp(img).composite([{ input: patch, left, top }]).png().toBuffer();
    } finally {
      await fs.rm(cropFile, { force: true });
    }
  }
  return img;
}

/**
 * The set's depth with each stand-in melted into a soft glow: where a body is and how near, not its arms or its pose
 * (the ground as it is, the figures heavily blurred over it).
 */
async function softFigures(depthFile: string, gen: Generation, W: number) {
  const ground = await sharp(await withoutFigures(depthFile, gen)).blur(Math.max(2, W / 160)).raw().toBuffer();
  const { data, info } = await sharp(depthFile).greyscale().blur(Math.max(4, W / 40)).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(ground.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(ground[i], data[i]);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
}

/** The set's depth with its stand-ins taken out (the ID pass marks them): each of their pixels takes its row's ground. */
async function withoutFigures(depthFile: string, gen: Generation, keep: [number, number, number][] = []) {
  const idsUrl = (gen.params?.comp as { idsUrl?: string } | undefined)?.idsUrl;
  const ids = idsUrl ? urlToPath(idsUrl) : null;
  const { data, info } = await sharp(depthFile).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (!ids) return sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  const W = info.width;
  const H = info.height;
  const mask = await sharp(ids).resize(W, H, { fit: "fill", kernel: "nearest" }).removeAlpha().raw().toBuffer();
  // Grown a little: the stand-ins' soft edges. Those in `keep` (their ID colors) stay.
  const kept = (i: number) => keep.some(([r, g, b]) => (mask[i * 3] > 127) === r > 127 && (mask[i * 3 + 1] > 127) === g > 127 && (mask[i * 3 + 2] > 127) === b > 127);
  const hit = (i: number) => (mask[i * 3] > 127 || mask[i * 3 + 1] > 127 || mask[i * 3 + 2] > 127) && !kept(i);
  const out = Buffer.from(data);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    // The ground on this row: its brightest value outside the stand-ins (the floor is level, so a row is one depth).
    let ground = -1;
    for (let x = 0; x < W; x++) if (!hit(row + x)) ground = Math.max(ground, data[row + x]);
    if (ground < 0) continue;
    for (let x = 0; x < W; x++) {
      let near = false;
      for (let d = -3; d <= 3 && !near; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < W && hit(row + xx)) near = true;
      }
      if (near) out[row + x] = ground;
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

/** The ID-pass colors of the people and animals whose action is a pose to hold (sitting, walking, kneeling, ...). */
function posedColors(gen: Generation) {
  const comp = gen.params?.comp as { boxes?: { id: string; color?: [number, number, number] }[] } | undefined;
  const elements = (gen.params?.scene as Scene | undefined)?.elements ?? [];
  return (comp?.boxes ?? []).flatMap((b) => {
    const el = elements.find((e) => e.id === b.id);
    return el && b.color && (el.kind === "person" || el.kind === "animal") && poseOf(el) !== "standing" ? [b.color] : [];
  });
}

/** The cast's pictures side by side on one plain sheet, the order they stand in the frame. */
async function sheetOf(files: string[]) {
  const key = createHash("sha1").update(files.join("|")).digest("hex").slice(0, 20);
  const out = path.join(DIR, `fresh-cast-${key}.png`);
  try {
    await fs.access(out);
    return out;
  } catch {
    const tiles = await Promise.all(files.map((f) => sharp(f).flatten({ background: "#d9d9d9" }).resize(null, 1024).png().toBuffer()));
    const widths = await Promise.all(tiles.map(async (t) => (await sharp(t).metadata()).width ?? 400));
    const gap = 40;
    const W = widths.reduce((a, b) => a + b, 0) + gap * (tiles.length - 1);
    let x = 0;
    const layers = tiles.map((t, i) => {
      const layer = { input: t, left: x, top: 0 };
      x += widths[i] + gap;
      return layer;
    });
    await sharp({ create: { width: W, height: 1024, channels: 3, background: "#d9d9d9" } })
      .composite(layers)
      .png()
      .toFile(out);
    return out;
  }
}

/**
 * The Director's ControlNet shot (model Z-Image Director, engines/comfy-local-recipes `Z_IMAGE_DIRECTOR`): no pictures
 * go in, so nothing is copied. The model draws a whole new film still that follows a depth map of the shot through
 * the Fun ControlNet, and words say who is where: the user's pick over the reference-picture shots (Oct 2026, "it's
 * cinematic, it looks real, it doesn't look flat").
 *
 * The depth is the whole view's (Depth Anything on the set as the camera sees it: the place's buildings and the
 * stand-ins), so the place keeps its shape; a set with no place gives its own depth (the ground and the stand-ins). The
 * words give everyone's spot, size and turn from the set (the same words as the fresh shot), and what each person looks
 * like: their reading, and their clothes read from their picture.
 */
export async function runDirectorControl(job: EngineJob, gen: Generation, engine: Engine, ctx: EngineContext): Promise<EngineResult & { plateUrl: string; swapUrl: string }> {
  const scene = gen.params?.scene as Scene;
  const depthFile = typeof gen.params?.depthUrl === "string" ? urlToPath(gen.params.depthUrl) : null;
  const blocking = typeof gen.params?.blockingUrl === "string" ? urlToPath(gen.params.blockingUrl) : null;
  if (!depthFile || !blocking) throw new EngineError("This shot is missing its depth.", "Shoot it again.");
  ctx.progress(0.03, "Reading the shot");
  const meta = await sharp(depthFile).metadata();
  const W = meta.width ?? 1536;
  const H = meta.height ?? 864;
  const control = path.join(DIR, `control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
  await fs.mkdir(DIR, { recursive: true });
  if (/qwen-director/.test(`${job.model} ${gen.model ?? ""}`)) {
    // Qwen Director follows the set as the camera sees it, in grey (the place and the stand-ins' light and shade), held
    // for the first half of the steps (engines QWEN_DIRECTOR): the winner of the user's A/B/C over depth and edges.
    await sharp(blocking).greyscale().resize(W, H, { fit: "fill" }).png().toFile(control);
  } else if (scene.place.image) {
    const d = await estimateDepth(blocking);
    const raw = Buffer.from(d.data, "base64");
    const px = Buffer.alloc(d.width * d.height);
    for (let i = 0; i < d.width * d.height; i++) px[i] = raw.readUInt16LE(i * 2) >> 8;
    // Softened a little (2 px at 1536 wide) so the stand-ins read as bodies to draw, not shapes to trace.
    await sharp(px, { raw: { width: d.width, height: d.height, channels: 1 } }).resize(W, H, { fit: "fill", kernel: "lanczos3" }).blur(Math.max(1, W / 768)).png().toFile(control);
  } else {
    await sharp(depthFile).greyscale().blur(Math.max(1.5, W / 512)).png().toFile(control);
  }

  const cam = shotCamera(scene);
  const framed = frameElements(scene, cam)
    .filter((f) => f.inFrame)
    .sort((a, b) => a.cx - b.cx);
  const seen = new Map(subjectViews(scene).map((v) => [v.id, v.around]));
  ctx.progress(0.04, "Directing the cast");
  // The place as this camera sees it (its view in the world, else its photo), read into words: with only "a Parisian
  // cafe terrace", the depth's tall building came back as a close wall and the shot far tighter than the set.
  const comp = gen.params?.comp as { plateUrl?: string } | undefined;
  const view = scene.place.world && comp?.plateUrl ? urlToPath(comp.plateUrl) : null;
  const placeFile = view ?? (scene.place.image ? urlToPath(scene.place.image.url) : null);
  // The shot sheet's words ("Wide shot · Eye level · 35mm · f/2.8"): its first is the style, said in full below.
  const sheet = ((gen.params?.sheet as { value?: string }[] | undefined) ?? []).map((x) => x.value?.trim()).filter((v): v is string => Boolean(v)).slice(1);
  // No acting beats here: one more sentence per person made riders wave and doubled them.
  const [looks, place] = await Promise.all([looksOf(framed, seen), placeFile ? placeOf(placeFile) : Promise.resolve(null)]);
  // Qwen Director takes each subject's own picture (up to four, left to right): people keep their faces and clothes,
  // and things look like themselves (a Tesla Roadster's photo left out came back as a generic white car).
  const pictures: EngineReference[] = [];
  const refs = new Map<string, number>();
  if (/qwen-director/.test(`${job.model} ${gen.model ?? ""}`))
    for (const f of framed) {
      if (pictures.length >= 4 || (!PEOPLE.has(f.element.kind) && !f.element.image)) continue;
      const file = (await matchedView(f.element, seen.get(f.element.id) ?? 0).catch(() => null)) ?? (f.element.image ? urlToPath(f.element.image.sourceUrl ?? f.element.image.url) : null);
      if (!file) continue;
      pictures.push({ path: file, label: f.element.name, role: "subject" });
      refs.set(f.element.id, pictures.length);
    }
  const prompt = controlPrompt(scene, framed, cam.position, { looks, keep: keepNotes(framed), place, sheet, refs });
  try {
    const { outputs } = await engine.run(
      { ...job, prompt, userPrompt: prompt, refine: false, references: pictures, depth: { path: control, label: "the shot's depth", role: "subject" }, guide: undefined, layout: undefined },
      { signal: ctx.signal, progress: (v) => ctx.progress(0.05 + v * 0.93, "Drawing the shot") },
    );
    if (!outputs.length) throw new EngineError("The model returned no picture.");
    const saved = await saveUpload(await fs.readFile(control));
    return { outputs, usedPrompt: prompt, plateUrl: saved.url, swapUrl: saved.url };
  } finally {
    await fs.rm(control, { force: true });
  }
}

/** The place in a picture, in a set designer's words, read once per picture. */
const PLACES = new Map<string, string>();
const PLACE_ASK = `Describe the place in this picture for a set designer, as the camera sees it, in under 50 words: the buildings (how many floors, materials, colours), shopfronts, awnings and signs, furniture, the ground, the light and time of day. Never mention people, vehicles or flat coloured shapes. Plain sentences, no list.`;

async function placeOf(file: string) {
  const known = PLACES.get(file);
  if (known) return known;
  const answer = await askText({
    instructions: PLACE_ASK,
    text: "The place.",
    references: [{ path: file, label: "the place", role: "subject" }],
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    effort: "low",
    timeoutMs: 30_000,
  }).catch(() => null);
  const words = answer?.trim().replace(/\s+/g, " ").replace(/\.?$/, "") ?? "";
  if (!words || words.length > 600) return null;
  PLACES.set(file, words);
  return words;
}

/** What each person or animal in the shot looks like from their picture (hair, clothes), read once per picture. */
const LOOKS = new Map<string, string>();
const LOOKS_ASK = `For each picture, in order, describe the person or animal in it for a casting note: apparent age, skin tone, hair (colour, length, style) and every visible piece of clothing, footwear and accessory with its colour, in under 35 words. Never describe the background, the pose or the face's shape. Answer as JSON only: {"looks": ["...", "..."]}, one per picture.`;

async function looksOf(framed: Framing[], seen: Map<string, number>) {
  const out = new Map<string, string>();
  const todo: { id: string; file: string }[] = [];
  for (const f of framed) {
    if (!PEOPLE.has(f.element.kind)) continue;
    const el = f.element;
    const file = (await matchedView(el, seen.get(el.id) ?? 0).catch(() => null)) ?? (el.image ? urlToPath(el.image.sourceUrl ?? el.image.url) : null);
    if (!file) continue;
    const known = LOOKS.get(file);
    if (known) out.set(el.id, known);
    else todo.push({ id: el.id, file });
  }
  if (!todo.length) return out;
  const answer = await askText({
    instructions: LOOKS_ASK,
    text: todo.map((_, i) => `Picture ${i + 1}`).join(", "),
    references: todo.map((t, i) => ({ path: t.file, label: `picture ${i + 1}`, role: "subject" })),
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    effort: "low",
    timeoutMs: 30_000,
  }).catch(() => null);
  const read = answer ? jsonObject<{ looks?: unknown }>(answer)?.looks : null;
  if (Array.isArray(read))
    todo.forEach((t, i) => {
      const words = typeof read[i] === "string" ? (read[i] as string).trim().replace(/\.$/, "") : "";
      if (!words) return;
      LOOKS.set(t.file, words);
      out.set(t.id, words);
    });
  return out;
}

/**
 * The ControlNet shot's words: the style and camera, the place, then each subject with who they are, what they wear, and
 * where they are, how big and which way they're turned (the depth holds the camera and the shapes; without the spots and
 * sizes in words, the woman waving at the edge of the motorbike shot came back huge in the foreground).
 */
function controlPrompt(scene: Scene, framed: Framing[], camPos: Vector3, pieces: { looks: Map<string, string>; keep?: Map<string, string>; place?: string | null; sheet?: string[]; refs?: Map<string, number> }) {
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const realistic = PHOTO_STYLES.includes(style.id);
  // What each thing is called: its reading's noun, or for a thing its own name ("motorbike", not "vehicle").
  const thing = (el: SceneElement) => (el.read?.noun || PEOPLE.has(el.kind) ? nounOf(el) : el.name.trim().toLowerCase() || nounOf(el));
  // Names mean nothing to the model (it drew a second rider for "Kai"): each becomes what they are.
  const named = (t: string) =>
    scene.elements.reduce((out, el) => (el.name.trim().length > 1 ? out.replace(new RegExp(`\\b(?:the |a |an )?${el.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), `the ${thing(el)}`) : out), t);
  // Who someone is, short: the casting note read from their picture, else the reading's first clause (a long reading
  // drowned the layout words).
  const who = (el: SceneElement) => [pieces.looks.get(el.id) ?? el.read?.identity?.split(/[.;]/)[0]?.trim(), el.look?.trim(), pieces.keep?.get(el.id)].filter(Boolean).join(", ");
  // A rider and what they ride are one subject: on their own, the motorbike came back with a second rider.
  const ridden = new Map<string, Framing>();
  for (const f of framed)
    if (PEOPLE.has(f.element.kind) && f.element.lift > 0.05) {
      const ride = framed.find((o) => o !== f && (o.element.kind === "vehicle" || o.element.kind === "animal") && Math.hypot(o.element.x - f.element.x, o.element.z - f.element.z) < 0.6);
      if (ride) ridden.set(f.element.id, ride);
    }
  const rides = new Set([...ridden.values()].map((r) => r.element.id));
  const s: string[] = [`${style.phrase}. ${pieces.sheet?.length ? `${capitalize(pieces.sheet.join(", ").toLowerCase())}, ` : ""}${cameraWords(scene)}.`];
  // With no place picture, the shot's words say where (a place's words left from before, "a busy highway", fought "the
  // Eiffel Tower in the background"): its own words only fill in when the shot has none.
  const words = scene.place.image || !scene.notes.trim() ? scene.place.text.trim() : "";
  // With pictures (Qwen Director) the people are counted and each tied to their picture, and the place comes after them:
  // told only "the boy from image 1… the woman from image 2" after a long place, it drew one person wearing both.
  const counted = Boolean(pieces.refs?.size);
  const placeLine = words || pieces.place ? `The place: ${[words, pieces.place].filter(Boolean).join(". ")}.` : "";
  if (placeLine && !counted) s.push(placeLine);
  const crowd = framed.filter((f) => PEOPLE.has(f.element.kind)).length;
  if (counted) s.push(`Exactly ${crowd} ${crowd === 1 ? "person" : "people"} in the foreground${crowd > 1 ? ", each a different person who appears once" : ""}.`);
  let nth = 0;
  for (const f of framed) {
    const el = f.element;
    if (rides.has(el.id)) continue;
    const ride = ridden.get(el.id);
    const pictured = pieces.refs?.get(el.id);
    const traits = who(el);
    const turn = PEOPLE.has(el.kind) ? orientation(f, framed, camPos) : facing(el, camPos);
    // The shot's words are the newest: where they name someone, what they say is what that person does, not an action
    // left from an earlier Arrange ("riding the motorbike" stayed after the words said "taking a selfie").
    const told = scene.notes.toLowerCase().includes(el.name.trim().toLowerCase()) && el.name.trim().length > 1;
    const doing = el.action?.trim() && !told ? named(el.action.trim()) : ride ? `riding the ${thing(ride.element)}` : "";
    // A rider is said plainly: seated on it, hands on it (Qwen drew no motorbike at all from "riding the motorbike").
    const seated = ride && counted ? `, seated on the ${thing(ride.element)} with both hands on the handlebars` : "";
    const on = ride && !/\b(rid|on|astride)/i.test(doing) ? `, on the ${thing(ride.element)}` : "";
    // A selfie is said in full (the stand-in holds the arm out; words that only say "taking a selfie" got a hand on a hip).
    const arms = PEOPLE.has(el.kind) && poseOf({ ...el }, scene.notes) === "selfie" && !/\barm\b/i.test(doing) ? ", her right arm held out toward the camera with the phone in that hand at eye level".replace("her ", el.read?.noun && /\b(man|boy|guy|father|grandfather|he)\b/i.test(el.read.noun) ? "his " : "her ") : "";
    const lead = counted && PEOPLE.has(el.kind) ? `Person ${++nth}, ${whereIn(f, framed)}` : capitalize(whereIn(f, framed));
    const one = pictured ? `the ${thing(el)} from image ${pictured}` : `a ${thing(el)}`;
    s.push(`${lead}, ${sizeOf(f, el)}: ${one}${traits ? ` (${traits})` : ""}${on}${seated}, ${turn}${doing ? `, ${doing}` : ""}${arms}.`);
  }
  if (placeLine && counted) s.push(placeLine);
  if (scene.notes.trim()) s.push(named(scene.notes.trim()).replace(/\.?$/, "."));
  const people = framed.filter((f) => PEOPLE.has(f.element.kind));
  if (people.length > 1) s.push("They are caught mid-moment, reacting to each other: relaxed, natural body language, real expressions, not posing.");
  else if (people.length === 1) s.push("Caught mid-moment: relaxed, natural body language and a real expression, not posing.");
  if (framed.length) s.push(`Every shape in the layout is the real thing: ${people.length ? "each person real and fully detailed (face, hair, skin, clothes), " : ""}never a mannequin, statue or grey shape.`);
  if (!/(empty|alone|deserted|nobody|no one|abandoned)/i.test(scene.notes)) s.push("Around them the place has its usual life: other people and passers-by in the background.");
  if (people.length) s.push("Each of the people named here appears exactly once.");
  s.push(`${realistic ? "Real light on real materials, natural depth of field" : "One coherent picture"}, no text.`);
  return s.join(" ");
}

const PEOPLE = new Set(["person", "animal"]);
/** The styles that are photographs: their pictures want real light on real materials, and no doll or render look. */
const PHOTO_STYLES: string[] = ["photo", "cinematic", "documentary", "editorial", "product", "analog"];

/**
 * The words: where everyone is and roughly which way they're turned, what they're doing, and that they're caught in a
 * moment, not posing. Exact geometry ("full side profile: one eye and the right ear show") and the cast's own sheet
 * poses came back as people standing stiff where they were put (the user: "like someone copied the side photo of their
 * cast images"); where the model had to turn them itself, they held a coffee and looked round at each other.
 */
function freshPrompt(
  scene: Scene,
  framed: Framing[],
  camPos: Vector3,
  pieces: {
    place: number | null;
    view?: boolean;
    cast: number | null;
    each?: number | null;
    pictured: Set<string>;
    beats?: Map<string, string>;
    keep?: Map<string, string>;
    tags?: Map<string, string>;
  },
) {
  const style = STYLES.find((x) => x.id === scene.style) ?? STYLES[0];
  const realistic = PHOTO_STYLES.includes(style.id);
  const n = framed.length;
  const s: string[] = [
    n
      ? `Image 1 is a depth map of the shot (white is near): keep its camera and where ${n === 1 ? "the subject is" : `the ${n} subjects are`} and how big.`
      : "Image 1 is a depth map of the shot (white is near): keep its camera.",
  ];
  // The set's smooth grey shapes only mark where things stand: said what they become, or the model can draw the stand-in
  // itself (a mannequin, a stick man). What the openfield Director's look frames taught: name the real thing.
  if (n) s.push(`Its smooth grey shapes only mark where things stand: draw each ${framed.some((f) => PEOPLE.has(f.element.kind)) ? "person as a real, fully detailed person (face, hair, skin, clothes) and each thing" : "thing"} as the real thing, never as a mannequin, doll, statue or grey shape.`);
  const words = scene.place.text.trim();
  if (pieces.place && pieces.view) {
    s.push(`Image ${pieces.place} is a rough view of the place${words ? `, ${words},` : ""} from this camera: draw this same view fresh, sharp and real.`);
  } else if (pieces.place) {
    s.push(`Image ${pieces.place} shows the place${words ? `, ${words}` : ""}: the same place and light, seen from this camera and drawn fresh.`);
  } else {
    s.push(`The place, drawn fresh, is ${words || "a fitting location for the shot"}.`);
  }
  const pictured = framed.filter((f) => pieces.pictured.has(f.element.id));
  if (pieces.cast && pictured.length) {
    const order = pictured.map((f) => `the ${nounOf(f.element)}`);
    s.push(
      pictured.length === 1
        ? `Image ${pieces.cast} shows who ${order[0]} is: keep their face, hair, skin and clothes exactly.`
        : `Image ${pieces.cast} shows who they are, from left to right ${list(order)}: keep their faces, hair, skin and clothes exactly.`,
    );
  } else if (pieces.each && pictured.length) {
    s.push(`${list(pictured.map((f, i) => `image ${pieces.each! + i} is the ${nounOf(f.element)}`)).replace(/^i/, "I")}: keep their faces, hair, skin and clothes exactly.`);
  }
  // The Cast session's line: it stopped Grok and FLUX copying the reference pictures' poses.
  if (pictured.length) s.push("The pictures show how they look; the request decides their pose, action, expression and framing.");
  for (const f of framed) {
    const el = f.element;
    const look = el.look?.trim();
    const traits = [pieces.pictured.has(el.id) ? "" : el.read?.identity, look, pieces.keep?.get(el.id)].filter(Boolean).join("; ");
    const turn = PEOPLE.has(el.kind) ? orientation(f, framed, camPos) : facing(el, camPos);
    const beat = pieces.beats?.get(el.id);
    const tag = pieces.tags?.get(el.id);
    s.push(`${tag ? `<${tag}>, ` : ""}${tag ? `the ${nounOf(el)}` : capitalize(`the ${nounOf(el)}`)}${traits ? ` (${traits})` : ""}${tag ? "," : ""} is ${whereIn(f, framed)}, ${sizeOf(f, el)}, ${turn}${el.action?.trim() ? `, ${el.action.trim()}` : ""}.${beat ? ` ${beat.replace(/\.?$/, ".")}` : ""}`);
  }
  s.push(`${capitalize(cameraWords(scene))}.`);
  if (scene.notes.trim()) s.push(scene.notes.trim().replace(/\.?$/, "."));
  const people = framed.filter((f) => PEOPLE.has(f.element.kind));
  if (people.length > 1) s.push("They are caught mid-moment, reacting to each other: relaxed, natural body language, real expressions, mid-gesture, not posing.");
  else if (people.length === 1) s.push("Caught mid-moment: relaxed, natural body language and a real expression, not posing.");
  if (framed.some((f) => f.element.kind === "person") && (scene.notes.trim() || framed.some((f) => f.element.action?.trim()))) {
    s.push("Anything a person holds or uses is clearly visible and real in their hand.");
  }
  // A place with nobody else in it looked like a set (the user: "why is everything with no other people? ... it looks
  // lonely"): its usual life goes on, unless the notes say it's empty.
  if (!/(empty|alone|deserted|nobody|no one|abandoned)/i.test(scene.notes)) s.push("Around them the place has its usual life: other people and passers-by in the background.");
  if (n) s.push("Each of the people named here appears exactly once.");
  s.push(`${style.phrase}. A candid, natural ${realistic ? "photograph" : "picture"}${realistic ? ", real light on real materials" : ""}, no text.`);
  return s.join(" ");
}

/** What each Cast member must always keep, in words: their notes ("round glasses") and the small details pictures lose. */
function keepNotes(framed: Framing[]) {
  const out = new Map<string, string>();
  for (const f of framed) {
    const id = f.element.cast?.id;
    const member = id ? loadCharacter(id) : null;
    const words = [member?.notes?.trim(), member?.keep?.details?.trim()].filter(Boolean).join("; ");
    if (words) out.set(f.element.id, `always ${words}`);
  }
  return out;
}

const BEATS = `You direct actors for one film still. For each person listed, write one short sentence (under 20 words) saying what they are doing in this exact moment: a natural action, gesture or expression, using a prop only when it fits the notes. Keep where they are and which way they face. Make them react to each other when there are several. Never describe their looks or clothes. Answer as JSON only: {"beats": ["...", "..."]}, one per person, in the order given.`;

/**
 * What each person is doing in this moment, from the notes, by your text model: a director's acting notes. Told only
 * "share a coffee and laugh", models stood the cast still and smiling where they were put; given "holds a paper cup and
 * laughs at something she said; she talks with one hand raised", they acted it (FLUX 3 Klein, Qwen-Image 2.1).
 * Nothing without a text model, or for a shot with nobody in it.
 */
async function actingBeats(scene: Scene, framed: Framing[], camPos: Vector3) {
  const people = framed.filter((f) => f.element.kind === "person" || f.element.kind === "animal");
  const beats = new Map<string, string>();
  if (!people.length) return beats;
  const lines = people.map((f, i) => `${i + 1}. the ${nounOf(f.element)}, ${whereIn(f, framed)}, ${orientation(f, framed, camPos)}${f.element.action?.trim() ? `, ${f.element.action.trim()}` : ""}`);
  const text = `Place: ${scene.place.text.trim() || "the place in the shot"}.\nNotes: ${scene.notes.trim() || "(none: pick something natural for the place)"}\nPeople:\n${lines.join("\n")}`;
  const answer = await askText({ instructions: BEATS, text, effort: "low", timeoutMs: 25_000 }).catch(() => null);
  const list = answer ? (jsonObject(answer) as { beats?: unknown } | null)?.beats : null;
  if (Array.isArray(list)) {
    people.forEach((f, i) => {
      const b = list[i];
      if (typeof b === "string" && b.trim()) beats.set(f.element.id, b.trim().slice(0, 200));
    });
  }
  return beats;
}

/** Which way a person is turned, in plain words: toward the other person when they face them. */
function orientation(f: Framing, all: Framing[], camPos: Vector3) {
  const el = f.element;
  const around = angleDelta(el.yaw, yawTowardCamera(el, camPos));
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  if (a >= 157.5) return "with their back to the camera";
  if (a >= 112.5) return `turned away from the camera, toward the ${dir}`;
  if (a < 22.5) return "facing the camera";
  const other = all.find((g) => g !== f && PEOPLE.has(g.element.kind) && (dir === "right" ? g.cx > f.cx : g.cx < f.cx));
  if (other) return `turned toward the ${nounOf(other.element)}`;
  return a < 67.5 ? `turned three-quarters toward the ${dir}` : `in profile, facing the ${dir}`;
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const nounOf = (el: SceneElement) => (el.read?.noun ?? ELEMENT_DEFAULTS[el.kind].noun).replace(/^(a|an|the)\s+/i, "");

/** Where it stands in the frame: left of center, in the middle, nearer the camera. */
function whereIn(f: Framing, all: Framing[]) {
  const side = f.cx < -0.55 ? "on the left" : f.cx < -0.15 ? "left of center" : f.cx <= 0.15 ? "in the middle" : f.cx <= 0.55 ? "right of center" : "on the right";
  const nearest = all.length > 1 && all.every((g) => g === f || g.depth > f.depth + 0.4);
  return `${side} of the frame${nearest ? ", nearest the camera" : ""}`;
}

/** How much of it the frame holds. */
function sizeOf(f: Framing, el: SceneElement) {
  if (!PEOPLE.has(el.kind)) return f.visible > 0.97 ? "seen whole" : "partly cut off by the frame";
  if (f.visible > 0.97) return el.kind === "person" ? "the whole body in view from head to toe" : "its whole body in view";
  if (f.visible > 0.66) return "framed from mid-thigh up";
  if (f.visible > 0.45) return "framed from the waist up";
  if (f.visible > 0.28) return "framed from the chest up";
  return "a close-up of the face";
}

/** Which way it faces, as what the camera sees of it (as director-real). */
function facing(el: SceneElement, camPos: Vector3) {
  const around = angleDelta(el.yaw, yawTowardCamera(el, camPos));
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  if (el.kind === "person") {
    if (a < 22.5) return "facing the camera";
    if (a < 67.5) return `turned three-quarters toward the ${dir} edge of the frame: more of the ${dir} side of their face shows; they are not looking at the camera`;
    if (a < 112.5) return `in full side profile facing the ${dir} edge of the frame: one eye and their ${dir} ear show, their nose points at the ${dir} edge`;
    if (a < 157.5) return `turned mostly away from the camera toward the ${dir}: we see the back of their head and their ${dir} shoulder, not their face`;
    return "with their back to the camera: we see the back of their head and body, not their face";
  }
  if (el.kind === "vehicle") {
    if (a < 22.5) return "its front pointing straight at the camera";
    if (a < 67.5) return `seen at a three-quarter angle, its front pointing toward the ${dir} edge of the frame`;
    if (a < 112.5) return `seen side-on, its front pointing at the ${dir} edge of the frame`;
    if (a < 157.5) return `seen from behind at an angle, its front pointing away toward the ${dir}`;
    return "seen from directly behind";
  }
  if (a < 22.5) return "its front toward the camera";
  if (a < 112.5) return `its front turned toward the ${dir} edge of the frame`;
  return "turned away from the camera";
}

/** A subject's own picture from the side the camera sees (as director-real's). */
async function matchedView(el: SceneElement, around: number): Promise<string | null> {
  const sheet = el.cast?.sheet ? urlToPath(el.cast.sheet) : null;
  if (sheet) {
    const member = el.cast?.id ? loadCharacter(el.cast.id) : null;
    const names = member ? viewsOf(member) : LEGACY_SHEET_VIEWS;
    const a = Math.abs(around);
    const want = a < 30 ? "front" : a < 60 && names.includes("three-quarter") ? "three-quarter" : a < 45 ? "front" : a < 140 || !names.includes("back") ? "side" : "back";
    const i = names.indexOf(want);
    if (i >= 0) {
      const flip = (want === "side" || want === "three-quarter") && around < 0;
      const stat = await fs.stat(sheet);
      const key = createHash("sha1").update(`sheet-view|${sheet}|${stat.size}|${stat.mtimeMs}|${i}|${flip}`).digest("hex").slice(0, 20);
      const file = path.join(DIR, `${key}.png`);
      try {
        await fs.access(file);
      } catch {
        await fs.mkdir(DIR, { recursive: true });
        const view = sharp((await sheetViews(sheet))[i]);
        await fs.writeFile(file, await (flip ? view.flop() : view).png().toBuffer());
      }
      return file;
    }
  }
  if (el.views?.length) {
    const best = el.views.reduce((b, v) => (Math.abs(angleDelta(v.around, around)) < Math.abs(angleDelta(b.around, around)) ? v : b));
    return urlToPath(best.url);
  }
  return el.image ? urlToPath(el.image.url) : null;
}
