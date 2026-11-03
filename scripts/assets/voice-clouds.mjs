#!/usr/bin/env node
// Draws the clouds inside Voice's orbs: white, soft-edged and see-through, on transparent tiles
// that repeat seamlessly, so an orb can drift them past its sky forever with one CSS transform
// (components/voice/Orb.tsx, .voice-orb in globals.css). Two layers: big slow clouds, and thin
// fast wisps that cross them in another direction.
//
// Writes
//   public/assets/voice/clouds-1.webp      big clouds, 512 px tile
//   public/assets/voice/clouds-2.webp      wisps, 512 px tile
//   public/assets/voice/clouds-soft.webp   the big clouds blurred ahead of time (Voice's backdrop haze)
//   public/assets/voice/grain.png          fine grain, so the backdrop's dark gradients don't band
//
// Usage: node scripts/assets/voice-clouds.mjs
//
// The noise is periodic gradient noise (every octave's lattice wraps at the tile's edge), summed
// in octaves and bent by a second noise field, so the clouds don't look like a grid of blobs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../public/assets/voice");
const SIZE = 512;

/** A small seeded random generator (mulberry32), so the art comes out the same every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gradient (Perlin) noise that wraps every `period` cells across one tile; 0..1. */
function noiseField(seed, period) {
  const rnd = random(seed);
  const gx = new Float32Array(period * period);
  const gy = new Float32Array(period * period);
  for (let k = 0; k < period * period; k++) {
    const a = rnd() * Math.PI * 2;
    gx[k] = Math.cos(a);
    gy[k] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (ix, iy, dx, dy) => {
    const k = (iy % period) * period + (ix % period);
    return gx[k] * dx + gy[k] * dy;
  };
  return (u, v) => {
    // u, v in tile units (0..1 is one tile); the lattice repeats every tile.
    const x = (((u % 1) + 1) % 1) * period;
    const y = (((v % 1) + 1) % 1) * period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const dx = x - x0;
    const dy = y - y0;
    const fx = fade(dx);
    const fy = fade(dy);
    const a = dot(x0, y0, dx, dy);
    const b = dot(x0 + 1, y0, dx - 1, dy);
    const c = dot(x0, y0 + 1, dx, dy - 1);
    const d = dot(x0 + 1, y0 + 1, dx - 1, dy - 1);
    const n = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    return 0.5 + n * 0.75;
  };
}

/** Octaves of noise, each twice as fine and half as strong; 0..1. */
function fbm(seed, base, octaves) {
  const fields = Array.from({ length: octaves }, (_, i) => noiseField(seed + i * 101, base * 2 ** i));
  const total = fields.reduce((s, _, i) => s + 0.5 ** i, 0);
  return (u, v) => fields.reduce((s, f, i) => s + f(u, v) * 0.5 ** i, 0) / total;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One tile of clouds. `base`: how many big cells across the tile (fewer = bigger clouds); `from`/`to`: the density
 * where a cloud starts and where it's solid; `alpha`: the most opaque it gets; `warp`: how much the shapes bend.
 */
async function tile(file, { seed, base, octaves, from, to, alpha, warp }) {
  const shape = fbm(seed, base, octaves);
  const bendX = fbm(seed + 7, base, 3);
  const bendY = fbm(seed + 13, base, 3);
  const detail = fbm(seed + 29, base * 4, 3);
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const u = i / SIZE;
      const v = j / SIZE;
      // Bent by a smooth field that wraps too, so the tile still repeats.
      const d = shape(u + (bendX(u, v) - 0.5) * warp, v + (bendY(u, v) - 0.5) * warp);
      const a = smooth(from, to, d);
      // Denser middles are a touch brighter; thin edges a touch grey, like real cumulus.
      const lit = 0.9 + 0.1 * smooth(from, to + 0.08, d) * (0.7 + 0.3 * detail(u, v));
      const k = (j * SIZE + i) * 4;
      px[k] = Math.round(255 * lit);
      px[k + 1] = Math.round(255 * lit);
      px[k + 2] = Math.round(255 * Math.min(1, lit + 0.015));
      px[k + 3] = Math.round(255 * a * alpha);
    }
  }
  await sharp(px, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toFile(path.join(out, file));
  const { size } = await fs.stat(path.join(out, file));
  console.log(`${file}  ${(size / 1024).toFixed(0)} KB`);
}

await fs.mkdir(out, { recursive: true });
await tile("clouds-1.webp", { seed: 11, base: 2, octaves: 5, from: 0.44, to: 0.62, alpha: 0.97, warp: 0.12 });
await tile("clouds-2.webp", { seed: 47, base: 4, octaves: 4, from: 0.53, to: 0.7, alpha: 0.6, warp: 0.18 });

// The haze: the big clouds blurred once here, not by the browser on every frame. Blurred as a 3 × 3 mosaic and cut
// from the middle, so the tile still repeats without a seam.
{
  const tile = await sharp(path.join(out, "clouds-1.webp")).toBuffer();
  const mosaic = await sharp({ create: { width: SIZE * 3, height: SIZE * 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ input: tile, left: x * SIZE, top: y * SIZE }))))
    .png()
    .toBuffer();
  await sharp(mosaic).blur(22).extract({ left: SIZE, top: SIZE, width: SIZE, height: SIZE }).webp({ quality: 70, alphaQuality: 70 }).toFile(path.join(out, "clouds-soft.webp"));
  console.log(`clouds-soft.webp  ${((await fs.stat(path.join(out, "clouds-soft.webp"))).size / 1024).toFixed(0)} KB`);
}

// Grain: specks of white and black, barely there.
{
  const G = 160;
  const rnd = random(5);
  const px = Buffer.alloc(G * G * 4);
  for (let k = 0; k < G * G; k++) {
    const light = rnd() < 0.5;
    px.set([light ? 255 : 0, light ? 255 : 0, light ? 255 : 0, Math.round(rnd() * 16)], k * 4);
  }
  await sharp(px, { raw: { width: G, height: G, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(out, "grain.png"));
  console.log(`grain.png  ${((await fs.stat(path.join(out, "grain.png"))).size / 1024).toFixed(0)} KB`);
}
