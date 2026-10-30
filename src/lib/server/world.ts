import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import { urlToPath } from "./media";
import { lineUp, pushPull } from "./director";
import { askText } from "@/lib/engines/refine";
import { sizeFor } from "@/lib/shot";
import { EngineError, type Engine, type EngineContext, type EngineJob } from "@/lib/engines/types";
import type { PlaceView, WorldDepth, WorldLight } from "@/lib/director/types";

/**
 * The place as one picture all around its photo's spot: an equirectangular panorama cropped to 21:9 (all the way round,
 * 77 degrees up and down), drawn by a model in one go from the photo projected where its camera pointed. Measured on
 * 2026-10-28 (the user's gas station): nine views built one after another came out as different worlds side by side
 * (their light and colors drifted, the sky met in panels); one panorama, on Grok 2.0, FLUX 3 Klein and Qwen-Image-Edit
 * 2511 alike, is one world with one light. The seam where its ends meet is filled after, and it is turned so the photo's
 * place stands where the photo has it.
 */
const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "world");
const VERSION = 7;
/** The panorama as drawn: 2560 x 1097 (21:9, the widest shape the engines take), 154 degrees of latitude. */
export const WORLD_W = 2560;
export const WORLD_H = Math.round((WORLD_W * 9) / 21);
const LAT = Math.PI * (WORLD_H / (WORLD_W / 2));
const rad = (d: number) => (d * Math.PI) / 180;

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A camera turned by yaw (left), pitch (up) and roll: its forward, right and up. */
function basis(yaw: number, pitch: number, roll: number) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const f: Vec = [-sy * cp, sp, -cy * cp];
  const r0: Vec = [cy, 0, -sy];
  const u0: Vec = [sy * sp, cp, cy * sp];
  const r = r0.map((v, i) => v * cr + u0[i] * sr) as Vec;
  const u = u0.map((v, i) => -r0[i] * sr + v * cr) as Vec;
  return { f, r, u };
}

/** The direction of a panorama pixel: longitude 0 is the photo's forward (the middle column), latitude 0 the horizon. */
function direction(x: number, y: number, W: number, H: number): Vec {
  const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
  const lat = LAT / 2 - ((y + 0.5) / H) * LAT;
  return [Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];
}

/**
 * The photo itself put back where its camera pointed, at the finished world's size: the model redraws it while it draws
 * around it (darker and softer, shelves and chairs reinvented: the user's convenience store, the cafe), and it is the
 * sharpest picture of the place there is, about four times a world's detail per degree. Its edges fade into the
 * drawing, and across the fade it takes on the drawing's tone, so no frame shows where it ends.
 */
async function photoInto(world: Buffer, FW: number, FH: number, photo: string, view: PlaceView) {
  const { data: src, info } = await sharp(photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tv = Math.tan(rad(view.fov / 2));
  const th = tv * (info.width / info.height);
  const B = basis(0, rad(view.pitch), rad(-view.roll));
  // The footprint: the photo's border as directions, to longitude and latitude, with a margin.
  let [x0, x1, y0, y1] = [FW, 0, FH, 0];
  for (let k = 0; k <= 64; k++) {
    const t = (k / 64) * 2 - 1;
    for (const [px, py] of [[t, -1], [t, 1], [-1, t], [1, t]]) {
      const d = B.f.map((f, i) => f + B.r[i] * px * th + B.u[i] * py * tv);
      const len = Math.hypot(d[0], d[1], d[2]);
      const lon = Math.atan2(d[0] / len, -d[2] / len);
      const lat = Math.asin(d[1] / len);
      const x = ((lon + Math.PI) / (2 * Math.PI)) * FW;
      const y = ((LAT / 2 - lat) / LAT) * FH;
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  }
  [x0, x1, y0, y1] = [Math.max(0, Math.floor(x0) - 4), Math.min(FW, Math.ceil(x1) + 4), Math.max(0, Math.floor(y0) - 4), Math.min(FH, Math.ceil(y1) + 4)];
  // The photo's pixel a world pixel shows (bilinear), and how far toward the photo's edge it is (0 middle, 1 edge).
  const at = (x: number, y: number) => {
    const d = direction(x, y, FW, FH);
    const z = dot(d, B.f);
    if (z <= 1e-4) return null;
    const px = dot(d, B.r) / z / th;
    const py = dot(d, B.u) / z / tv;
    const edge = Math.max(Math.abs(px), Math.abs(py));
    if (edge >= 1) return null;
    const fx = Math.min(info.width - 1.001, Math.max(0, (px * 0.5 + 0.5) * info.width - 0.5));
    const fy = Math.min(info.height - 1.001, Math.max(0, (0.5 - py * 0.5) * info.height - 0.5));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ax = fx - ix;
    const ay = fy - iy;
    const c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p00 = src[(iy * info.width + ix) * 3 + k];
      const p10 = src[(iy * info.width + ix + 1) * 3 + k];
      const p01 = src[((iy + 1) * info.width + ix) * 3 + k];
      const p11 = src[((iy + 1) * info.width + ix + 1) * 3 + k];
      c[k] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
    }
    return { c, edge };
  };
  const FADE = 0.86;
  // The drawing's tone against the photo's, in the fade band.
  const shift = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const s = at(x, y);
      if (!s || s.edge < FADE) continue;
      const o = (y * FW + x) * 3;
      for (let k = 0; k < 3; k++) shift[k] += world[o + k] - s.c[k];
      n++;
    }
  }
  for (let k = 0; k < 3; k++) shift[k] = n ? Math.max(-40, Math.min(40, shift[k] / n)) : 0;
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const s = at(x, y);
      if (!s) continue;
      const keep = 1 - smooth(FADE, 1, s.edge);
      const toned = smooth(0.45, FADE, s.edge);
      const o = (y * FW + x) * 3;
      for (let k = 0; k < 3; k++) {
        const p = Math.min(255, Math.max(0, s.c[k] + shift[k] * toned));
        world[o + k] = Math.round(world[o + k] * (1 - keep) + p * keep);
      }
    }
  }
}

/** The photo projected where its camera pointed; everything else bright green (the part to draw), and a mask of the photo. */
async function canvasOf(photo: string, view: PlaceView) {
  const { data: src, info } = await sharp(photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tv = Math.tan(rad(view.fov / 2));
  const th = tv * (info.width / info.height);
  const B = basis(0, rad(view.pitch), rad(-view.roll));
  const out = Buffer.alloc(WORLD_W * WORLD_H * 3);
  const known = Buffer.alloc(WORLD_W * WORLD_H);
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const d = direction(x, y, WORLD_W, WORLD_H);
      const o = y * WORLD_W + x;
      const z = dot(d, B.f);
      const px = z > 1e-4 ? dot(d, B.r) / z / th : 9;
      const py = z > 1e-4 ? dot(d, B.u) / z / tv : 9;
      if (Math.abs(px) < 1 && Math.abs(py) < 1) {
        const sx = Math.min(info.width - 1, Math.max(0, Math.round((px * 0.5 + 0.5) * info.width - 0.5)));
        const sy = Math.min(info.height - 1, Math.max(0, Math.round((0.5 - py * 0.5) * info.height - 0.5)));
        const i = (sy * info.width + sx) * 3;
        out[o * 3] = src[i];
        out[o * 3 + 1] = src[i + 1];
        out[o * 3 + 2] = src[i + 2];
        known[o] = 255;
      } else {
        out[o * 3 + 1] = 255;
      }
    }
  }
  return { rgb: out, known };
}

/**
 * The faces of a cube looked at from the extend's spot, in the order the Director captures them (extend.ts): ahead,
 * right, behind, left, up, down; each a 90 degree camera's forward, right and up in the world's own frame (ahead is
 * longitude 0).
 */
const CUBE: { f: Vec; r: Vec; u: Vec }[] = [
  { f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0] },
  { f: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { f: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0] },
  { f: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { f: [0, -1, 0], r: [1, 0, 0], u: [0, 0, -1] },
];
/** What the set renders where its place was never seen (capture.ts' UNKNOWN_GRAY). */
const isUnseen = (r: number, g: number, b: number) => Math.abs(r - 138) <= 3 && Math.abs(g - 138) <= 3 && Math.abs(b - 138) <= 3;

/**
 * An extend's canvas: the place as it already was, seen all around from the new spot (`around`: the set's six views
 * from there, gray where its world never saw), with the new photo ahead (the view from here, drawn on as asked). Only
 * the gray, and a band round the photo's edge so it blends into what was there, is left to draw: the buildings beside
 * you and the sky behind stay the place you had (the user: extend INTO the place, not a new one).
 */
async function canvasAround(around: string[], photo: string, view: PlaceView) {
  const faces = await Promise.all(around.map((f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  const { data: src, info } = await sharp(photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tv = Math.tan(rad(view.fov / 2));
  const th = tv * (info.width / info.height);
  const B = basis(0, rad(view.pitch), rad(-view.roll));
  const out = Buffer.alloc(WORLD_W * WORLD_H * 3);
  const known = Buffer.alloc(WORLD_W * WORLD_H);
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const d = direction(x, y, WORLD_W, WORLD_H);
      const o = y * WORLD_W + x;
      // The new photo, where its camera points (its outer 6% left to draw: the seam into what was there).
      const z = dot(d, B.f);
      const px = z > 1e-4 ? dot(d, B.r) / z / th : 9;
      const py = z > 1e-4 ? dot(d, B.u) / z / tv : 9;
      if (Math.abs(px) < 1 && Math.abs(py) < 1) {
        if (Math.max(Math.abs(px), Math.abs(py)) < 0.94) {
          const sx = Math.min(info.width - 1, Math.max(0, Math.round((px * 0.5 + 0.5) * info.width - 0.5)));
          const sy = Math.min(info.height - 1, Math.max(0, Math.round((0.5 - py * 0.5) * info.height - 0.5)));
          const i = (sy * info.width + sx) * 3;
          out[o * 3] = src[i];
          out[o * 3 + 1] = src[i + 1];
          out[o * 3 + 2] = src[i + 2];
          known[o] = 255;
        } else out[o * 3 + 1] = 255;
        continue;
      }
      // Elsewhere, the place as it was, from here.
      let k = 0;
      for (let j = 1; j < 6; j++) if (dot(d, CUBE[j].f) > dot(d, CUBE[k].f)) k = j;
      const face = faces[k];
      const c = CUBE[k];
      const fz = dot(d, c.f);
      const fx = Math.min(face.info.width - 1, Math.max(0, Math.round(((dot(d, c.r) / fz) * 0.5 + 0.5) * face.info.width - 0.5)));
      const fy = Math.min(face.info.height - 1, Math.max(0, Math.round((0.5 - (dot(d, c.u) / fz) * 0.5) * face.info.height - 0.5)));
      const i = (fy * face.info.width + fx) * 3;
      const [r, g, b] = [face.data[i], face.data[i + 1], face.data[i + 2]];
      if (isUnseen(r, g, b)) {
        out[o * 3 + 1] = 255;
        continue;
      }
      out[o * 3] = r;
      out[o * 3 + 1] = g;
      out[o * 3 + 2] = b;
      known[o] = 255;
    }
  }
  return { rgb: out, known };
}

/** The panorama turned (rolled sideways) by `dx` pixels. */
function roll(rgb: Buffer, W: number, H: number, dx: number) {
  const out = Buffer.alloc(rgb.length);
  const s = ((dx % W) + W) % W;
  for (let y = 0; y < H; y++) {
    const row = y * W * 3;
    rgb.copy(out, row + s * 3, row, row + (W - s) * 3);
    rgb.copy(out, row, row + (W - s) * 3, row + W * 3);
  }
  return out;
}

/**
 * How far the drawn panorama is turned from the photo: the sideways roll whose photo-shaped part matches the photo best
 * (small grayscale copies). Models redraw the photo's place a little to one side.
 */
async function turnToPhoto(rgb: Buffer, canvas: Buffer, known: Buffer) {
  const w = 512;
  const h = Math.round((w * WORLD_H) / WORLD_W);
  const small = async (b: Buffer, channels: 1 | 3) => sharp(b, { raw: { width: WORLD_W, height: WORLD_H, channels } }).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer();
  const [a, b, m] = await Promise.all([small(canvas, 3), small(rgb, 3), small(known, 1)]);
  let best = { dx: 0, e: Infinity };
  for (let dx = -Math.round(w / 6); dx <= Math.round(w / 6); dx++) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (m[y * w + x] < 200) continue;
        const sx = (((x - dx) % w) + w) % w;
        sum += Math.abs(a[y * w + x] - b[y * w + sx]);
        n++;
      }
    }
    if (n && sum / n < best.e) best = { dx, e: sum / n };
  }
  return Math.round((best.dx * WORLD_W) / w);
}

export type World = { url: string; width: number; height: number; depth?: WorldDepth; light?: WorldLight };

/**
 * The look for a place drawn inside a ball (Grok 2.0 once drew one in the middle of the panorama). Asked in the message
 * itself: as the instructions, under a bare "Is it?", Grok answered with a picture prompt, and asked whether the horizon
 * and lines were straight, it failed real panoramas (their straight lines curve). Measured on 14 built worlds and a
 * tiny planet made from one: all 14 no, the planet yes, 5 to 8 s each.
 */
export const GLOBE = {
  instructions: "You look at pictures and answer questions about them with one word.",
  question:
    "Is the place in this picture drawn inside a round shape within the picture: a glass sphere, crystal ball, globe, fisheye circle or tiny planet? (A wide panorama whose straight lines curve gently is not that.) Answer only yes or no.",
};

/** Whether a drawn panorama is an ordinary one, not a place inside a ball (a vision model's look); yes when none answers. */
async function flatPanorama(rgb: Buffer) {
  const file = path.join(DIR, `check-${Date.now().toString(36)}.jpg`);
  await sharp(rgb, { raw: { width: WORLD_W, height: WORLD_H, channels: 3 } }).resize(1280).jpeg({ quality: 85 }).toFile(file);
  try {
    const answer = await askText({ instructions: GLOBE.instructions, text: GLOBE.question, references: [{ path: file, label: "the panorama" }], imageEdge: 1280, detail: "low", effort: "low", timeoutMs: 45_000 }).catch(() => null);
    return !answer || !/^\W*yes/i.test(answer);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The place's world from its photo (see the module comment), by `job`'s model. Cached per photo, view and model. */
/** Whether a pixel is the green marker: bright, pure green, which no real place shows across a panorama. */
const isGreen = (rgb: Buffer, i: number) => rgb[i + 1] > 170 && rgb[i] < 110 && rgb[i + 2] < 110 && rgb[i + 1] - Math.max(rgb[i], rgb[i + 2]) > 90;

/** The share of a drawn panorama still the green marker (sampled). */
function greenLeft(rgb: Buffer) {
  let n = 0;
  let all = 0;
  for (let i = 0; i < rgb.length; i += 3 * 7) {
    all++;
    if (isGreen(rgb, i)) n++;
  }
  return n / Math.max(1, all);
}

/** Where a drawn panorama is still green, grown a little past the marker's soft edge (255 = to draw). */
function greenMask(rgb: Buffer) {
  const W = WORLD_W;
  const H = WORLD_H;
  const m = Buffer.alloc(W * H);
  for (let p = 0; p < W * H; p++) if (isGreen(rgb, p * 3)) m[p] = 255;
  const grow = 6;
  const out = Buffer.from(m);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m[y * W + x]) continue;
      for (let dy = -grow; dy <= grow; dy += 3) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -grow; dx <= grow; dx += 3) out[yy * W + ((x + dx + W) % W)] = 255;
      }
    }
  }
  return out;
}

/** The sharpened world's width: any WebGL texture up to 8K, about 23 pixels a degree. */
const SHARP_W = 8192;

/**
 * The world four times as sharp, by Real-ESRGAN on a GPU of yours (about a minute on a 5090, with the transfer). A 35 mm
 * shot sees about a seventh of the world's width, so the doubled 5120 one came out soft in every shot (the user's
 * alley). Nothing when no machine can run it, or it takes too long.
 */
async function sharpened(png: Buffer, machine: string | undefined, signal: AbortSignal): Promise<Buffer | null> {
  const file = path.join(DIR, `sharpen-${Date.now().toString(36)}.png`);
  try {
    const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry")]);
    const def = await resolveModel("upscale", "local:realesrgan-x4");
    const engine = def.via ? engineFor(def.via) : null;
    if (!engine) return null;
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(file, png);
    const meta = await sharp(png).metadata();
    const scale = Math.min(4, SHARP_W / (meta.width ?? WORLD_W));
    const { outputs } = await engine.run(
      {
        kind: "upscale",
        model: def.model,
        via: def.via ?? undefined,
        family: def.family,
        caps: def.caps ?? undefined,
        options: { scale, sourceWidth: meta.width, sourceHeight: meta.height, ...(machine ? { machine } : {}) },
        prompt: "",
        userPrompt: "",
        refine: false,
        aspect: "21:9",
        width: Math.round((meta.width ?? WORLD_W) * scale),
        height: Math.round((meta.height ?? WORLD_H) * scale),
        count: 1,
        references: [{ path: file, label: "the original image", role: "edit-target" }],
        mode: "image",
      },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]), progress: () => undefined },
    );
    return outputs[0]?.data ?? null;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`[world] kept the world as drawn: ${(err as Error).message}`);
    return null;
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function buildWorld(
  photoUrl: string,
  view: PlaceView,
  setting: string,
  place: string,
  job: EngineJob,
  engine: Engine,
  ctx: EngineContext,
  nonce = "",
  around?: string[],
): Promise<World> {
  const photo = urlToPath(photoUrl);
  if (!photo) throw new EngineError("Crackio can't find the place's photo.");
  const key = createHash("sha1")
    .update(await fs.readFile(photo))
    .update(JSON.stringify([view.fov, view.pitch, view.roll, job.model, setting, place, VERSION, nonce, job.options?.resolution ?? null, around ?? null]))
    .digest("hex");
  const cache = path.join(DIR, `${key}.json`);
  const hit = await fs.readFile(cache, "utf8").catch(() => null);
  if (hit) return JSON.parse(hit) as World;
  await fs.mkdir(DIR, { recursive: true });
  // How long each part takes, kept per build (data/cache/world/timings.jsonl): what the place's time estimate is made of.
  const began = Date.now();
  const laps: Record<string, number> = {};
  let mark = began;
  const lap = (name: string) => {
    laps[name] = (laps[name] ?? 0) + (Date.now() - mark) / 1000;
    mark = Date.now();
  };
  const panoJob: EngineJob = { ...job, aspect: "21:9", ...sizeFor("21:9", 2560), count: 1, refine: false, guide: undefined, depth: undefined, layout: undefined };
  // One drawing by the place's model: the whole panorama, or `box`, a square cut from it, at its own size.
  const run = async (rgb: Buffer, prompt: string, from: number, to: number, stage: string, mask?: Buffer, box = { width: WORLD_W, height: WORLD_H }) => {
    const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const file = path.join(DIR, `in-${tag}.png`);
    const maskFile = path.join(DIR, `mask-${tag}.png`);
    await sharp(rgb, { raw: { width: box.width, height: box.height, channels: 3 } }).png().toFile(file);
    if (mask) await sharp(mask, { raw: { width: box.width, height: box.height, channels: 1 } }).png().toFile(maskFile);
    const square = box.width !== WORLD_W;
    try {
      const { outputs } = await engine.run(
        {
          ...panoJob,
          ...(square ? { aspect: "1:1" as const, ...sizeFor("1:1", box.width) } : {}),
          prompt,
          userPrompt: prompt,
          references: [{ path: file, label: "the panorama", role: "edit-target" }],
          mask: mask ? { path: maskFile, label: "where to draw" } : undefined,
        },
        { signal: ctx.signal, progress: (v) => ctx.progress(from + v * (to - from), stage) },
      );
      if (!outputs[0]) throw new EngineError("The model returned nothing.");
      return sharp(outputs[0].data).resize(box.width, box.height, { fit: "fill" }).png().toBuffer();
    } finally {
      await Promise.all([fs.rm(file, { force: true }), fs.rm(maskFile, { force: true })]);
    }
  };
  // Local edit models keep a green marker as it is (measured): they get a soft guess and draw only inside a mask.
  const local = job.via === "comfy-local";

  // 1. The photo where its camera pointed, the rest drawn in one go.
  // An extend keeps the place it had all around (canvasAround); a place of its own starts from its photo.
  const { rgb: canvas, known } = around?.length === 6 ? await canvasAround(around, photo, view) : await canvasOf(photo, view);
  const where = place.trim() ? `${place.trim()}; ` : "";
  const raw = (png: Buffer) => sharp(png).removeAlpha().raw().toBuffer();
  const prompt = [
    "Fill the green spaces according to the image. Outpaint as a seamless 360 equirectangular panorama: one flat photograph unwrapped from all the way around a single spot, like a street-view panorama, with a straight, level horizon across its whole width and the left edge continuing into the right edge.",
    `${where}What the photo shows carries on where it is cut off, and all around is ${setting}, under the same sky; the ground below and the sky above carry on too.`,
    // The floor under the cast comes from below the photo's bottom edge: Grok 2.0 carried a gas station's sea on down
    // into it, and a car staged there stood on the waves.
    "Below the bottom of the photo is the ground the camera stands on: the same floor, paving, road or grass the photo shows at its bottom edge, continuing under the camera all around.",
    // Grok 2.0 once drew the whole place inside a glass sphere in the middle of the panorama.
    "Not a sphere, globe, glass ball, fisheye circle or tiny planet: an ordinary wide photograph. The same light, colors and time of day everywhere. No people, no text.",
  ].join(" ");
  const soft = [
    `A 360 equirectangular panorama of ${setting} where some parts are only a soft, blurred guess.`,
    "Redraw the blurred parts sharp and real, carrying on what the sharp parts show: the same place, floor, walls, ceiling or sky, light and colors, with a straight, level horizon and the left edge continuing into the right edge.",
    "Keep the sharp parts exactly as they are. An ordinary wide photograph, not a sphere or fisheye. No people, no text.",
  ].join(" ");
  // An extend keeps the place it had: a model on your GPU draws only what it never saw (a soft guess there, under a
  // mask), and whatever any model drew over what it had is put back, its edges feathered. Drawn whole from the green
  // canvas, Qwen-Image 2.1 made a new square with other buildings, farther off (the user's café street).
  const extending = around?.length === 6;
  const unseen = Buffer.alloc(WORLD_W * WORLD_H);
  for (let i = 0; i < unseen.length; i++) unseen[i] = known[i] ? 0 : 255;
  const keepWhatWasThere = async (drawn: Buffer) => {
    if (!extending) return drawn;
    const hold = await sharp(known, { raw: { width: WORLD_W, height: WORLD_H, channels: 1 } }).blur(4).raw().toBuffer();
    const out = Buffer.from(drawn);
    for (let i = 0; i < hold.length; i++) {
      // Well inside what it had, fully; toward its edge, a blend into the drawing (never past it: the canvas is green there).
      const t = known[i] ? Math.min(1, Math.max(0, (hold[i] - 128) / 100)) : 0;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(canvas[i * 3 + c] * t + drawn[i * 3 + c] * (1 - t));
    }
    return out;
  };
  const draw = async (again: boolean) => {
    const stage = again ? "Drawing the place all around you again" : "Drawing the place all around you";
    if (extending && local) return keepWhatWasThere(await raw(await run(pushPull(canvas, unseen, WORLD_W, WORLD_H), soft, 0.02, 0.55, stage, unseen)));
    return keepWhatWasThere(await raw(await run(canvas, prompt, 0.02, 0.55, stage)));
  };
  // A model that keeps the green anyway gets what it left as a soft guess from the colors around it, to draw over (what
  // local editors get, which keep any marker).
  const fillLeft = async (drawn: Buffer) => {
    const left = greenMask(drawn);
    const filled = await raw(await run(pushPull(drawn, left, WORLD_W, WORLD_H), soft, 0.4, 0.6, "Drawing the rest of the place", left));
    if (greenLeft(filled) > 0.02) throw new EngineError("The model left part of the place undrawn.", "Draw it again, or pick another model for the place.");
    return filled;
  };

  // 2. The seam behind, where its ends meet: turned to the middle and a band drawn across it, in a square cut around it
  // (the whole panorama sent and drawn again for that band took 37 s), the rest kept.
  const W = WORLD_W;
  const H = WORLD_H;
  const half = Math.floor(W / 2);
  // Wide enough to turn what's on one side into what's on the other (a cliff into open sea) without a line.
  const band = Math.round(W * 0.09);
  const feather = Math.round(W * 0.04);
  const CW = H;
  const x0 = half - Math.floor(CW / 2);
  const mid = half - x0;
  const bandMask = Buffer.alloc(CW * H);
  for (let y = 0; y < H; y++) bandMask.fill(255, y * CW + mid - band, y * CW + mid + band);
  const joinUp = async (drawn: Buffer) => {
    const rolled = roll(drawn, W, H, half);
    const cut = Buffer.alloc(CW * H * 3);
    for (let y = 0; y < H; y++) rolled.copy(cut, y * CW * 3, (y * W + x0) * 3, (y * W + x0 + CW) * 3);
    const marked = local ? pushPull(cut, bandMask, CW, H) : Buffer.from(cut);
    if (!local) {
      for (let y = 0; y < H; y++) {
        for (let x = mid - band; x < mid + band; x++) {
          const o = (y * CW + x) * 3;
          marked[o] = 0;
          marked[o + 1] = 255;
          marked[o + 2] = 0;
        }
      }
    }
    // Lined up with what it was given first: Grok 2.0 hands it back shifted a little, and the band then ghosted.
    const bridged = await lineUp(
      cut,
      await run(
        marked,
        local
          ? "Redraw the soft, blurred vertical band in the middle so the picture is one seamless photograph: carry the scene on either side across it, the same ground, road, terrain, water and sky meeting smoothly with matching perspective, light and colors. Sharp and real, no text."
          : "Fill the bright green vertical band so the picture is one seamless photograph: carry the scene on either side across it, the same ground, road, terrain, water and sky meeting smoothly in the middle with matching perspective, light and colors. Keep everything that isn't green exactly as it is. No text.",
        0.6,
        0.92,
        "Joining the place up behind you",
        local ? bandMask : undefined,
        { width: CW, height: H },
      ),
      bandMask,
      CW,
      H,
    );
    for (let y = 0; y < H; y++) {
      for (let x = half - band - feather; x < half + band + feather; x++) {
        const d = Math.abs(x - half);
        const t = d < band ? 1 : 1 - (d - band) / feather;
        const o = (y * W + x) * 3;
        const q = (y * CW + x - x0) * 3;
        for (let c = 0; c < 3; c++) rolled[o + c] = Math.round(bridged[q + c] * t + rolled[o + c] * (1 - t));
      }
    }
    return roll(rolled, W, H, -half);
  };

  lap("prepare");
  let drawn = await draw(false);
  lap("draw");
  const seamless = await (async () => {
    for (let tries = 0; ; tries++) {
      // A model redrew the user's convenience store photo and left all the green around it green: drawn again (twice
      // at most), then what's still left filled from a soft guess.
      if (greenLeft(drawn) > 0.02 && tries < 2) {
        drawn = await draw(true);
        lap("redraw");
        continue;
      }
      if (greenLeft(drawn) > 0.02) {
        drawn = await fillLeft(drawn);
        lap("fill");
      }
      // Joined up behind while a vision model looks at it (Grok 2.0 once drew the place inside a glass sphere): one
      // that isn't an ordinary flat panorama is drawn again. Looked at first, then joined, the look alone took 106 s.
      const [flat, joined] = await Promise.all([tries < 2 ? flatPanorama(drawn) : Promise.resolve(true), joinUp(drawn)]);
      lap("seam");
      if (flat) return joined;
      drawn = await draw(true);
      lap("redraw");
    }
  })();

  // 3. Turned so the photo's place is where the photo has it, measured (how far everything is, so the set is a place to
  // walk into), and handed over at twice the size. Sharpened to 8K after, while you work (sharpenLater): waited for,
  // sharpening took 52 s from the rented 5090 (nearly all of it the download) and 190 s on a GTX 1060.
  ctx.progress(0.9, "Lining the place up with your photo");
  const turned = roll(seamless, W, H, await turnToPhoto(seamless, canvas, known));
  const flat = await sharp(turned, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const drawnName = `${nanoid(12)}.jpg`;
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, drawnName), await sharp(flat).jpeg({ quality: 92 }).toBuffer());
  lap("turn");
  ctx.progress(0.93, "Measuring the place");
  const { worldDepth } = await import("./world-depth");
  const measured = await worldDepth(`/api/media/uploads/${drawnName}`, view.height).catch((err) => {
    console.warn(`[world] left to measure after: ${(err as Error).message}`);
    return null;
  });
  lap("measure");
  ctx.progress(0.97, "Putting your photo back in the place");
  const world = { ...(await finish(flat, W * 2, photo, view)), ...(measured ? { depth: measured.depth, light: measured.light } : {}) };
  await fs.writeFile(cache, JSON.stringify(world));
  lap("save");
  await fs
    .appendFile(path.join(DIR, "timings.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind: "world", model: job.model, via: job.via, total: (Date.now() - began) / 1000, ...laps })}\n`)
    .catch(() => undefined);
  sharpenLater(world, flat, photo, view, cache, typeof job.options?.machine === "string" ? job.options.machine : undefined);
  return world;
}

/** The world at `width` (sharpened when given, else a lanczos fit), the photo put back into it, saved. */
async function finish(flat: Buffer, width: number, photo: string, view: PlaceView, sharper?: Buffer) {
  const FW = width;
  const FH = Math.round((FW * WORLD_H) / WORLD_W);
  const grown = sharper
    ? await sharp(sharper).resize(FW, FH, { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer()
    : await sharp(flat).resize(FW, FH, { fit: "fill", kernel: "lanczos3" }).sharpen({ sigma: 0.8 }).removeAlpha().raw().toBuffer();
  await photoInto(grown, FW, FH, photo, view);
  // Saved as it is: uploads are capped at 2560 wide.
  const name = `${nanoid(12)}.jpg`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name), await sharp(grown, { raw: { width: FW, height: FH, channels: 3 } }).jpeg({ quality: 90 }).toBuffer());
  return { url: `/api/media/uploads/${name}`, width: FW, height: FH };
}

/** Worlds being sharpened, by the url they were handed over at (kept across module reloads). */
const sharpening = ((globalThis as unknown as { __crackioSharpening?: Map<string, Promise<void>> }).__crackioSharpening ??= new Map());
const sharpFile = (url: string) => path.join(DIR, "sharp", `${path.basename(url).replace(/\.\w+$/, "")}.json`);

/**
 * The world sharpened to 8K by Real-ESRGAN in the background, once it's been handed over: what `sharperWorld` answers
 * for it, and the cached world from then on (a place built again from the same photo is the sharp one).
 */
function sharpenLater(world: World, flat: Buffer, photo: string, view: PlaceView, cache: string, machine: string | undefined) {
  const began = Date.now();
  const work = (async () => {
    let sharp8k: { url: string; width: number; height: number } | null = null;
    try {
      const sharper = await sharpened(flat, machine, new AbortController().signal);
      if (sharper) sharp8k = await finish(flat, SHARP_W, photo, view, sharper);
    } catch (err) {
      console.warn(`[world] stays as handed over: ${(err as Error).message}`);
    }
    await fs.mkdir(path.dirname(sharpFile(world.url)), { recursive: true });
    await fs.writeFile(sharpFile(world.url), JSON.stringify(sharp8k ?? { none: true }));
    if (sharp8k) await fs.writeFile(cache, JSON.stringify({ ...world, ...sharp8k }));
    await fs.appendFile(path.join(DIR, "timings.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind: "sharpen", total: (Date.now() - began) / 1000, done: Boolean(sharp8k) })}\n`).catch(() => undefined);
  })().finally(() => sharpening.delete(world.url));
  sharpening.set(world.url, work);
}

/** The sharp version of a world handed over at `url`: its picture when done, "pending" while it's made, null for none. */
export async function sharperWorld(url: string): Promise<{ url: string; width: number; height: number } | "pending" | null> {
  const done = await fs.readFile(sharpFile(url), "utf8").catch(() => null);
  if (done) {
    const kept = JSON.parse(done) as { url?: string; width?: number; height?: number };
    return kept.url && kept.width && kept.height ? { url: kept.url, width: kept.width, height: kept.height } : null;
  }
  return sharpening.has(url) ? "pending" : null;
}

/** A run's time kept with the world builds' (a place photo's, from server/location). */
export async function keepTime(kind: string, seconds: number, extra: Record<string, unknown> = {}) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.appendFile(path.join(DIR, "timings.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind, total: seconds, ...extra })}
`).catch(() => undefined);
}

/** How long making a place usually takes here, seconds (the middle of the last runs), from the times each run kept. */
export async function typicalTimes() {
  const lines = (await fs.readFile(path.join(DIR, "timings.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const runs = lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as { kind?: string; total: number }];
    } catch {
      return [];
    }
  });
  const middle = (kind: string) => {
    const t = runs.filter((r) => (r.kind ?? "world") === kind).slice(-7).map((r) => r.total).sort((x, y) => x - y);
    return t.length ? t[Math.floor(t.length / 2)] : null;
  };
  return { photo: middle("photo"), world: middle("world") };
}
