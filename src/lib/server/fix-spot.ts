import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { UPLOADS_DIR } from "./paths";
import { saveUpload, urlToPath } from "./media";
import { editView } from "./director";
import { photoBasis } from "./world";
import { EngineError } from "@/lib/engines/types";

/**
 * Fix this spot (Director v2, after the challenge winner's "cut out and put back"): the part of the place the Camera
 * looks at is cut out of the 360 world as a flat picture, changed by an image model as you say, and put back exactly
 * where it was cut from, its edges faded into what was there. The cut and the return are the same lens maths run both
 * ways, so the fix lands on the very pixels it came from; nothing else in the world changes.
 *
 * Directions are the stage's (and the world shader's): longitude 0 looks down -z, latitude 0 is the horizon, and the
 * world picture spans all longitudes and `lat = π·H/(W/2)` of latitude (21:9 worlds: ±77°; a 2:1 world: the whole sphere).
 */

type V = [number, number, number];
export type Look = { forward: V; right: V; up: V; vfov: number; aspect: number };

const norm = (v: V): V => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Bilinear sample of an RGB raw image (wrapping across longitude when `wrap`). */
function sample(src: Buffer, W: number, H: number, fx: number, fy: number, wrap: boolean, out: number[]) {
  let x0 = Math.floor(fx);
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const tx = fx - x0;
  const ty = Math.max(0, Math.min(1, fy - y0));
  const y1 = Math.min(H - 1, y0 + 1);
  let x1 = x0 + 1;
  if (wrap) {
    x0 = ((x0 % W) + W) % W;
    x1 = ((x1 % W) + W) % W;
  } else {
    x0 = Math.max(0, Math.min(W - 1, x0));
    x1 = Math.max(0, Math.min(W - 1, x1));
  }
  for (let c = 0; c < 3; c++) {
    const a = src[(y0 * W + x0) * 3 + c];
    const b = src[(y0 * W + x1) * 3 + c];
    const d = src[(y1 * W + x0) * 3 + c];
    const e = src[(y1 * W + x1) * 3 + c];
    out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
}

/** The world's direction at a pixel, and the pixel of a direction. */
function erp(W: number, H: number) {
  const span = Math.PI * (H / (W / 2));
  return {
    span,
    dirAt(x: number, y: number): V {
      const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
      const lat = span / 2 - ((y + 0.5) / H) * span;
      return [Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];
    },
    pixelOf(d: V): [number, number] {
      const lon = Math.atan2(d[0], -d[2]);
      const lat = Math.asin(Math.max(-1, Math.min(1, d[1])));
      return [((lon + Math.PI) / (2 * Math.PI)) * W - 0.5, (span / 2 - lat) / span * H - 0.5];
    },
  };
}

/** The flat picture the Camera sees of the world: `w` x `h`, through `look`. */
function cut(world: Buffer, W: number, H: number, look: Look, w: number, h: number) {
  const f = norm(look.forward);
  const r = norm(look.right);
  const u = norm(look.up);
  const tv = Math.tan(((look.vfov * Math.PI) / 180) / 2);
  const th = tv * look.aspect;
  const map = erp(W, H);
  const out = Buffer.alloc(w * h * 3);
  const px = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const sy = (1 - (2 * (y + 0.5)) / h) * tv;
    for (let x = 0; x < w; x++) {
      const sx = ((2 * (x + 0.5)) / w - 1) * th;
      const d = norm([f[0] + r[0] * sx + u[0] * sy, f[1] + r[1] * sx + u[1] * sy, f[2] + r[2] * sx + u[2] * sy]);
      const [fx, fy] = map.pixelOf(d);
      sample(world, W, H, fx, fy, true, px);
      const o = (y * w + x) * 3;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
    }
  }
  return out;
}

/** The changed picture put back into the world where it was cut from, its border faded over the last `feather` of it. */
function putBack(world: Buffer, W: number, H: number, look: Look, edit: Buffer, w: number, h: number, feather = 0.12) {
  const f = norm(look.forward);
  const r = norm(look.right);
  const u = norm(look.up);
  const tv = Math.tan(((look.vfov * Math.PI) / 180) / 2);
  const th = tv * look.aspect;
  const map = erp(W, H);
  const px = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = map.dirAt(x, y);
      const z = dot(d, f);
      if (z <= 0.01) continue;
      const nx = dot(d, r) / z / th;
      const ny = dot(d, u) / z / tv;
      if (Math.abs(nx) >= 1 || Math.abs(ny) >= 1) continue;
      // How far inside the frame: 0 at its edge, 1 past the feather.
      const inside = Math.min(1 - Math.abs(nx), 1 - Math.abs(ny)) / feather;
      const k = inside >= 1 ? 1 : inside * inside * (3 - 2 * inside);
      sample(edit, w, h, ((nx + 1) / 2) * w - 0.5, ((1 - ny) / 2) * h - 0.5, false, px);
      const o = (y * W + x) * 3;
      world[o] = Math.round(world[o] * (1 - k) + px[0] * k);
      world[o + 1] = Math.round(world[o + 1] * (1 - k) + px[1] * k);
      world[o + 2] = Math.round(world[o + 2] * (1 - k) + px[2] * k);
    }
  }
}

/**
 * The fix put into the photo too, where the two overlap: Director v2's stage shows the photo's own pixels where it looks
 * (Stage3D Surround `photoOver`), over the world's copy, so a fix only in the world didn't show there. Each photo pixel's
 * direction (the photo's camera as it sits in the world, world `photoBasis`) is looked up in the fixed view, its border
 * faded as in `putBack`. Null when the fix doesn't reach the photo.
 */
function intoPhoto(photo: Buffer, PW: number, PH: number, view: PhotoView, look: Look, edit: Buffer, w: number, h: number, feather = 0.12) {
  const B = photoBasis(view);
  const ptv = Math.tan(((view.fov * Math.PI) / 180) / 2);
  const pth = ptv * (PW / PH);
  const f = norm(look.forward);
  const r = norm(look.right);
  const u = norm(look.up);
  const tv = Math.tan(((look.vfov * Math.PI) / 180) / 2);
  const th = tv * look.aspect;
  const px = [0, 0, 0];
  let touched = false;
  for (let y = 0; y < PH; y++) {
    const sy = (1 - (2 * (y + 0.5)) / PH) * ptv;
    for (let x = 0; x < PW; x++) {
      const sx = ((2 * (x + 0.5)) / PW - 1) * pth;
      const d = norm([B.f[0] + B.r[0] * sx + B.u[0] * sy, B.f[1] + B.r[1] * sx + B.u[1] * sy, B.f[2] + B.r[2] * sx + B.u[2] * sy]);
      const z = dot(d, f);
      if (z <= 0.01) continue;
      const nx = dot(d, r) / z / th;
      const ny = dot(d, u) / z / tv;
      if (Math.abs(nx) >= 1 || Math.abs(ny) >= 1) continue;
      const inside = Math.min(1 - Math.abs(nx), 1 - Math.abs(ny)) / feather;
      const k = inside >= 1 ? 1 : inside * inside * (3 - 2 * inside);
      sample(edit, w, h, ((nx + 1) / 2) * w - 0.5, ((1 - ny) / 2) * h - 0.5, false, px);
      const o = (y * PW + x) * 3;
      photo[o] = Math.round(photo[o] * (1 - k) + px[0] * k);
      photo[o + 1] = Math.round(photo[o + 1] * (1 - k) + px[1] * k);
      photo[o + 2] = Math.round(photo[o + 2] * (1 - k) + px[2] * k);
      touched = true;
    }
  }
  return touched;
}

type PhotoView = { fov: number; pitch: number; roll: number };

/**
 * Fixes the spot the Camera looks at: returns the world picture with the fix in it (same size as the world given),
 * the fixed view on its own, and the photo with the fix in it when the fix reached the part the photo shows.
 */
export async function fixSpot(worldUrl: string, look: Look, words: string, model: string, signal: AbortSignal, machine?: string, photo?: { url: string; view: PhotoView }) {
  const file = urlToPath(worldUrl);
  if (!file) throw new EngineError("Crackio can't find the place's picture.");
  if (!(look.vfov > 1 && look.vfov < 170) || !(look.aspect > 0.2 && look.aspect < 5)) throw new EngineError("That view can't be cut out.");
  const { data: world, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  // The cut at about 1.5 MP, in the Camera's shape: what edit models draw well.
  const h = Math.round(Math.sqrt(1_500_000 / look.aspect) / 16) * 16;
  const w = Math.round((h * look.aspect) / 16) * 16;
  const flat = cut(world, W, H, look, w, h);
  const cutFile = await saveUpload(await sharp(flat, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  const fixed = await editView(cutFile.url, words, model, signal, machine);
  const fixedPath = urlToPath(fixed.url);
  if (!fixedPath) throw new EngineError("The fixed view went missing.");
  const { data: edit } = await sharp(fixedPath).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  putBack(world, W, H, look, edit, w, h);
  // Saved at the world's own size (an 8K world stays 8K: uploads are capped at 2560).
  await fs.mkdir(/*turbopackIgnore: true*/ UPLOADS_DIR, { recursive: true });
  const name = `${nanoid(12)}.jpg`;
  await sharp(world, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 93 }).toFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name));
  // The photo the stage shows where it looks, with the fix in it too (same size, its own name: the place's photo stays).
  let fixedPhoto: { url: string; width: number; height: number } | undefined;
  const photoFile = photo ? urlToPath(photo.url) : null;
  if (photo && photoFile) {
    const { data: pic, info: pi } = await sharp(photoFile).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (intoPhoto(pic, pi.width, pi.height, photo.view, look, edit, w, h)) {
      const pname = `${nanoid(12)}.jpg`;
      await sharp(pic, { raw: { width: pi.width, height: pi.height, channels: 3 } }).jpeg({ quality: 95 }).toFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, pname));
      fixedPhoto = { url: `/api/media/uploads/${pname}`, width: pi.width, height: pi.height };
    }
  }
  return { world: { url: `/api/media/uploads/${name}`, width: W, height: H }, view: fixed, before: cutFile, ...(fixedPhoto ? { photo: fixedPhoto } : {}) };
}
