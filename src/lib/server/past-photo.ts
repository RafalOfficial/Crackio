import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Quaternion, Vector3 } from "three";
import { shotCamera } from "@/lib/director/camera";
import { photoCamera } from "@/lib/director/reconstruct";
import type { Scene } from "@/lib/director/types";

/** The kept shot's "nothing known here" gray (stage/capture LOOK_KEY, #949494). */
const KEY = 148;
/**
 * How far past the photo's view the continuation reaches before it's all gray again (its half-size is 1). At 0.5 one
 * of two test re-shoots looking up past the top drew a beach with a second horizon in the gray left above; at 1
 * the sky carried on (Nov 13, RunPod 4090, 2K).
 */
const REACH = 1;
/** The size the continuation's colors are worked out at (it's soft: nothing finer is needed). */
const GRID = 512;

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/**
 * Push-pull: every unknown pixel takes the colors of the known ones around it, the nearer the more (a pyramid of
 * averages, filled back down). `known` is 1 where the picture shows something.
 */
function pushPull(rgb: Float32Array, known: Float32Array, w: number, h: number) {
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array };
  const levels: Level[] = [{ w, h, c: rgb, a: known }];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const p = levels.at(-1)!;
    const lw = Math.max(1, p.w >> 1);
    const lh = Math.max(1, p.h >> 1);
    const n: Level = { w: lw, h: lh, c: new Float32Array(lw * lh * 3), a: new Float32Array(lw * lh) };
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const k = Math.min(p.h - 1, y * 2 + dy) * p.w + Math.min(p.w - 1, x * 2 + dx);
            const wk = p.a[k];
            a += wk;
            r += p.c[k * 3] * wk;
            g += p.c[k * 3 + 1] * wk;
            b += p.c[k * 3 + 2] * wk;
          }
        }
        const k = y * lw + x;
        n.a[k] = Math.min(1, a);
        if (a > 0) {
          n.c[k * 3] = r / a;
          n.c[k * 3 + 1] = g / a;
          n.c[k * 3 + 2] = b / a;
        }
      }
    }
    levels.push(n);
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li];
    const C = levels[li + 1];
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const k = y * L.w + x;
        if (L.a[k] >= 1) continue;
        const fx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const fy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(C.w - 1, x0 + 1);
        const y1 = Math.min(C.h - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        for (let ch = 0; ch < 3; ch++) {
          const top = C.c[(y0 * C.w + x0) * 3 + ch] * (1 - tx) + C.c[(y0 * C.w + x1) * 3 + ch] * tx;
          const bottom = C.c[(y1 * C.w + x0) * 3 + ch] * (1 - tx) + C.c[(y1 * C.w + x1) * 3 + ch] * tx;
          L.c[k * 3 + ch] = L.c[k * 3 + ch] * L.a[k] + (top * (1 - ty) + bottom * ty) * (1 - L.a[k]);
        }
        L.a[k] = 1;
      }
    }
  }
  return rgb;
}

/**
 * The Camera's view of a flat painting's 3D set (Stage3D PhotoSet on MoGe-2) with the gray past the photo's own view
 * carried on softly from its edges, fading back to gray: the re-shoot's guide (server/director-real, `photoFlat`). With
 * flat gray there, Qwen-Image 2.1 + AnyAngle kept the photo's border as the edge of a picture standing in a new place it
 * drew around it (an anime beach test, looking up past the top of the photo, Nov 13: a sea and a horizon above the
 * boy's sky). Gaps inside the photo's view (behind what stands in it) stay gray. Past its view means past the set's far
 * plane's edge as the Camera sees it: MoGe-2's sky and farthest things sit on that plane (`far` set units away).
 */
export async function carryPastPhoto(setFile: string, scene: Scene, far: number, outDir: string) {
  const image = scene.place.image;
  if (!image?.view || !(far > 0)) return null;
  const { data: full, info } = await sharp(setFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const isKey = (buf: Buffer | Uint8Array, i: number) => Math.abs(buf[i] - KEY) <= 3 && Math.abs(buf[i + 1] - KEY) <= 3 && Math.abs(buf[i + 2] - KEY) <= 3;

  const cam = shotCamera(scene);
  const pc = photoCamera(image.view, scene.place.scale ?? 1);
  const toPhoto = pc.quaternion.clone().invert();
  const turn = toPhoto.clone().multiply(cam.quaternion as Quaternion);
  const origin = cam.position.clone().sub(pc.position).applyQuaternion(toPhoto);
  const F = far * (scene.place.scale ?? 1);
  const tanV = Math.tan((image.view.fov * Math.PI) / 360);
  const tanH = tanV * (image.width / image.height);
  const camTanV = Math.tan((cam.fov * Math.PI) / 360);
  const camTanH = camTanV * cam.aspect;
  const ray = new Vector3();
  /** How far past the photo's view the pixel looks (1 = its border), measured on the set's far plane. */
  const past = (x: number, y: number) => {
    ray.set(((2 * x) / W - 1) * camTanH, (1 - (2 * y) / H) * camTanV, -1).applyQuaternion(turn);
    if (ray.z > -1e-6) return Infinity;
    const t = (-F - origin.z) / ray.z;
    if (t <= 0) return Infinity;
    return Math.max(Math.abs((origin.x + t * ray.x) / F / tanH), Math.abs((origin.y + t * ray.y) / F / tanV));
  };

  // Is there any? (Most re-shoots stay inside the photo's view.)
  let any = false;
  for (let y = 0; y < H && !any; y += 8) for (let x = 0; x < W && !any; x += 8) if (isKey(full, (y * W + x) * 3) && past(x + 0.5, y + 0.5) > 1) any = true;
  if (!any) return null;

  // The colors to carry on: the view's own known pixels pushed and pulled into its gray, on a small grid.
  const { data: small } = await sharp(setFile).removeAlpha().resize(GRID, GRID, { kernel: "nearest", fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const rgb = new Float32Array(GRID * GRID * 3);
  const known = new Float32Array(GRID * GRID);
  for (let k = 0; k < GRID * GRID; k++) {
    if (isKey(small, k * 3)) continue;
    known[k] = 1;
    for (let ch = 0; ch < 3; ch++) rgb[k * 3 + ch] = small[k * 3 + ch];
  }
  pushPull(rgb, known, GRID, GRID);
  const grid = Buffer.alloc(GRID * GRID * 3);
  for (let k = 0; k < grid.length; k++) grid[k] = Math.round(rgb[k]);
  const { data: fill } = await sharp(grid, { raw: { width: GRID, height: GRID, channels: 3 } }).resize(W, H, { kernel: "cubic", fit: "fill" }).blur(1.5).raw().toBuffer({ resolveWithObject: true });

  const out = Buffer.from(full);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (!isKey(full, i)) continue;
      const e = past(x + 0.5, y + 0.5);
      if (!(e > 1)) continue;
      const a = 1 - smooth(1, 1 + REACH, e);
      if (a <= 0) continue;
      for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.round(KEY * (1 - a) + fill[i + ch] * a);
    }
  }
  await fs.mkdir(/*turbopackIgnore: true*/ outDir, { recursive: true });
  const file = path.join(/*turbopackIgnore: true*/ outDir, `past-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  await fs.writeFile(/*turbopackIgnore: true*/ file, await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
  return file;
}
