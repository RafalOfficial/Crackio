import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import { urlToPath } from "./media";
import { estimateDepth } from "./vision";
import { kelvinToRgb } from "@/lib/director/vocab";

/**
 * How far everything in a place's 360 world is from where it was made, so the stage can build it as a real place you
 * walk into (Stage3D `WalkIn`) instead of a backdrop that moves with the camera: shelves come closer as you walk up to
 * them, and people stand on its floor.
 *
 * The world is looked at in 14 overlapping ordinary views; Depth Anything V2 reads each (its depth has no scale), and
 * each view is put to scale by its floor: the camera stood at a known height over a flat floor, so the floor's true
 * distance is known in every direction below the horizon. Views without a floor in sight take their scale from the
 * views they overlap. Then the floor is laid exactly flat (and a ceiling, when the place has one), the sky is put far
 * away, and the rest keeps its estimated distance.
 *
 * And the place's light: the sun when it's in the sky; outdoors without it, the bright side of the sky; indoors a soft
 * light from above on the bright side (a window, the lamps), never a hard sun through a ceiling or wall.
 */

const VERSION = 8;
const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "world-depth");
/** The map's width (its height follows the world's shape). */
const MAP_W = 1024;
/** Nearest distance the map holds, meters. */
const R_MIN = 0.2;
/** The sky and anything farther than this: meters. */
const FAR = 300;
/**
 * The views: Depth Anything's own size each. Wide ones down and up cover everything; a ring of narrow ones along the
 * horizon reads it at twice the detail and counts most there (wide, a cafe's chairs 9 m away were a few pixels, read as
 * floor, and smeared over it once the camera moved).
 */
const S = 518;
const VIEWS = [
  ...Array.from({ length: 8 }, (_, i) => ({ yaw: i * 45, pitch: -25, fov: 100, weight: 1 })),
  ...Array.from({ length: 6 }, (_, i) => ({ yaw: i * 60 + 30, pitch: 35, fov: 100, weight: 1 })),
  ...Array.from({ length: 12 }, (_, i) => ({ yaw: i * 30 + 15, pitch: -12, fov: 58, weight: 3 })),
];

export const FLOOR = 1;
export const CEILING = 2;
export const SKY = 3;

export type WorldDepth = {
  url: string;
  width: number;
  height: number;
  /** A value q (16 bits: red, green) stands for the distance rMin * 65535 / q; blue is what it is (1 floor, 2 ceiling, 3 sky). */
  rMin: number;
  /** The eye's height over the floor the world was made from, meters. */
  eye: number;
  /** A flat ceiling's height over the floor, when the place has one. */
  ceiling: number | null;
  indoor: boolean;
  version: number;
};

export type WorldLight = { azimuth: number; elevation: number; softness: number; kelvin: number; sun: boolean };

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A direction for a longitude (0: the photo's forward, -z; 90: +x) and a latitude, radians. */
const direction = (lon: number, lat: number): Vec => [Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];

type Erp = { data: Buffer; width: number; height: number; span: number };

/** The world's color in a direction (bilinear; it wraps around and keeps its top and bottom rows past its edges). */
function sample(e: Erp, d: Vec, out: Vec) {
  const lon = Math.atan2(d[0], -d[2]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1])));
  const x = (lon / (2 * Math.PI) + 0.5) * e.width - 0.5;
  const y = Math.max(0, Math.min(e.height - 1.001, (0.5 - lat / e.span) * e.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = ((x0 % e.width) + e.width) % e.width;
  const xb = (xa + 1) % e.width;
  for (let c = 0; c < 3; c++) {
    const p = (yy: number, xx: number) => e.data[(yy * e.width + xx) * 3 + c];
    const top = p(y0, xa) * (1 - fx) + p(y0, xb) * fx;
    const bottom = p(y0 + 1, xa) * (1 - fx) + p(y0 + 1, xb) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

type View = { f: Vec; r: Vec; u: Vec; t: number; D: Float32Array; w: number; h: number; a: number; b: number; ok: boolean; byFloor?: boolean; weight: number };

function basis(yaw: number, pitch: number) {
  const f = direction((yaw * Math.PI) / 180, (pitch * Math.PI) / 180);
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return { f, r, u };
}

/** The direction through a view's pixel (x, y from its top left, in pixels of a w x h map). */
function ray(v: Pick<View, "f" | "r" | "u" | "t">, x: number, y: number, w: number, h: number): Vec {
  const nx = ((x + 0.5) / w) * 2 - 1;
  const ny = 1 - ((y + 0.5) / h) * 2;
  return norm([v.f[0] + (v.r[0] * nx + v.u[0] * ny) * v.t, v.f[1] + (v.r[1] * nx + v.u[1] * ny) * v.t, v.f[2] + (v.r[2] * nx + v.u[2] * ny) * v.t]);
}

/** Where a direction lands in a view (-1…1 across), or null when it's outside. */
function project(v: View, d: Vec): [number, number, number] | null {
  const c = dot(d, v.f);
  if (c <= 0.05) return null;
  const x = dot(d, v.r) / c / v.t;
  const y = dot(d, v.u) / c / v.t;
  if (Math.abs(x) >= 1 || Math.abs(y) >= 1) return null;
  return [x, y, c];
}

/** A view's depth reading at (-1…1, -1…1), bilinear. */
function depthAt(v: View, x: number, y: number) {
  const px = Math.max(0, Math.min(v.w - 1.001, ((x + 1) / 2) * v.w - 0.5));
  const py = Math.max(0, Math.min(v.h - 1.001, ((1 - y) / 2) * v.h - 0.5));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const p = (yy: number, xx: number) => v.D[yy * v.w + xx];
  return (p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx) * (1 - fy) + (p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx) * fy;
}

/** Distance along the ray from a calibrated view's reading. */
function distanceOf(v: View, D: number, c: number) {
  const inv = (D - v.b) / v.a;
  return inv > 1 / (FAR * 4) ? Math.min(FAR, 1 / (inv * c)) : FAR;
}

/**
 * The line D = a·g + b most of the pairs agree on (RANSAC, then least squares over the ones that agree): a view's depth
 * reading D against the true inverse depth g of the same pixels.
 */
function fitLine(g: Float32Array, D: Float32Array, n: number, tolerance: number) {
  let best = { a: 0, b: 0, count: 0 };
  // Scored on up to 6000 of the pairs (the fit at the end uses them all).
  const step = Math.max(1, Math.floor(n / 6000));
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < 400 && n > 1; it++) {
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    if (Math.abs(g[i] - g[j]) < 1e-4) continue;
    const a = (D[j] - D[i]) / (g[j] - g[i]);
    if (a <= 0) continue;
    const b = D[i] - a * g[i];
    let count = 0;
    for (let k = 0; k < n; k += step) if (Math.abs(D[k] - (a * g[k] + b)) < tolerance) count += step;
    if (count > best.count) best = { a, b, count };
  }
  for (let round = 0; round < 2 && best.count > 2; round++) {
    let sg = 0,
      sd = 0,
      sgg = 0,
      sgd = 0,
      m = 0;
    for (let k = 0; k < n; k++) {
      if (Math.abs(D[k] - (best.a * g[k] + best.b)) >= tolerance) continue;
      sg += g[k];
      sd += D[k];
      sgg += g[k] * g[k];
      sgd += g[k] * D[k];
      m++;
    }
    const den = m * sgg - sg * sg;
    if (m < 3 || Math.abs(den) < 1e-12) break;
    const a = (m * sgd - sg * sd) / den;
    if (a <= 0) break;
    best = { a, b: (sd - a * sg) / m, count: m };
  }
  return best;
}

/** Where everything in the world is, and its light; made once per world and kept. */
export async function worldDepth(worldUrl: string, eye: number): Promise<{ depth: WorldDepth; light: WorldLight }> {
  const file = urlToPath(worldUrl);
  if (!file) throw new Error("Crackio can't find the place's world.");
  const height = Math.max(0.3, Math.min(30, eye || 1.6));
  const key = createHash("sha1").update(await fs.readFile(file)).update(JSON.stringify([height, VERSION])).digest("hex");
  const cache = path.join(DIR, `${key}.json`);
  const hit = await fs.readFile(cache, "utf8").catch(() => null);
  if (hit) {
    const kept = JSON.parse(hit) as { depth: WorldDepth; light: WorldLight };
    if (urlToPath(kept.depth.url) && (await fs.stat(urlToPath(kept.depth.url)!).catch(() => null))) return kept;
  }
  await fs.mkdir(DIR, { recursive: true });

  const meta = await sharp(file).metadata();
  const span = 2 * Math.PI * ((meta.height ?? 1) / (meta.width ?? 2));
  const EW = 2048;
  const EH = Math.round((EW * (meta.height ?? 1)) / (meta.width ?? 2));
  const erp: Erp = { data: await sharp(file).resize(EW, EH, { fit: "fill" }).removeAlpha().raw().toBuffer(), width: EW, height: EH, span };

  // 1. The views, read one by one.
  const views: View[] = [];
  const rgb: Vec = [0, 0, 0];
  for (const spec of VIEWS) {
    const b = { ...basis(spec.yaw, spec.pitch), t: Math.tan(((spec.fov / 2) * Math.PI) / 180) };
    const img = Buffer.alloc(S * S * 3);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        sample(erp, ray(b, x, y, S, S), rgb);
        const i = (y * S + x) * 3;
        img[i] = rgb[0];
        img[i + 1] = rgb[1];
        img[i + 2] = rgb[2];
      }
    }
    const tmp = path.join(DIR, `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
    await sharp(img, { raw: { width: S, height: S, channels: 3 } }).png().toFile(tmp);
    try {
      const d = await estimateDepth(tmp);
      const raw = Buffer.from(d.data, "base64");
      const D = new Float32Array(d.width * d.height);
      for (let i = 0; i < D.length; i++) D[i] = raw.readUInt16LE(i * 2) / 65535;
      views.push({ ...b, D, w: d.width, h: d.height, a: 0, b: 0, ok: false, weight: spec.weight });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  // 2. Each view to scale by its floor: below the horizon, a flat floor `height` under the eye is at depth
  // height / (-dir.y) along the ray, so its true inverse depth (in the view's own depth axis) is known.
  const g = new Float32Array(S * S);
  const Dv = new Float32Array(S * S);
  // (The views looking down: the ones looking up see only a sliver of floor at their bottom edge.)
  for (const v of views) {
    if (v.f[1] > 0) continue;
    let n = 0;
    for (let y = 0; y < v.h; y += 2) {
      for (let x = 0; x < v.w; x += 2) {
        const d = ray(v, x, y, v.w, v.h);
        if (d[1] > -0.14) continue;
        g[n] = -d[1] / (height * dot(d, v.f));
        Dv[n] = v.D[y * v.w + x];
        n++;
      }
    }
    if (n < 2000) continue;
    const fit = fitLine(g, Dv, n, 0.02);
    if (fit.count >= Math.max(300, n * 0.3)) Object.assign(v, { a: fit.a, b: fit.b, ok: true, byFloor: true });
  }
  if (!views.some((v) => v.ok)) throw new Error("No floor found in the place to measure it by.");
  // Views with no floor in sight (looking up, or at a counter right in front) take their scale from those they overlap.
  for (let pass = 0; pass < 3; pass++) {
    for (const v of views) {
      if (v.ok) continue;
      let n = 0;
      for (let y = 0; y < v.h; y += 3) {
        for (let x = 0; x < v.w; x += 3) {
          const d = ray(v, x, y, v.w, v.h);
          for (const m of views) {
            if (!m.ok || m === v) continue;
            const p = project(m, d);
            if (!p) continue;
            const r = distanceOf(m, depthAt(m, p[0], p[1]), p[2]);
            if (r >= FAR) break;
            g[n] = 1 / (r * dot(d, v.f));
            Dv[n] = v.D[y * v.w + x];
            n++;
            break;
          }
          if (n >= g.length) break;
        }
      }
      if (n < 300) continue;
      const fit = fitLine(g, Dv, n, 0.025);
      if (fit.count >= n * 0.3) Object.assign(v, { a: fit.a, b: fit.b, ok: true });
    }
  }
  const used = views.filter((v) => v.ok);

  // 3. One distance per direction: the views blended (in log distance, so one view reading far too near can't pull it
  // all in), each most where it looks straight at it, and the ones measured by their own floor most of all.
  const W = MAP_W;
  const H = Math.round((W * EH) / EW);
  const dist = new Float32Array(W * H).fill(NaN);
  const dirs = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * span;
    for (let x = 0; x < W; x++) {
      const d = direction(((x + 0.5) / W - 0.5) * 2 * Math.PI, lat);
      const i = y * W + x;
      dirs.set(d, i * 3);
      let logs = 0;
      let total = 0;
      for (const v of used) {
        const p = project(v, d);
        if (!p) continue;
        const w = ((1 - Math.max(Math.abs(p[0]), Math.abs(p[1]))) ** 2 + 1e-4) * (v.byFloor ? 4 : 1) * v.weight;
        logs += w * Math.log(distanceOf(v, depthAt(v, p[0], p[1]), p[2]));
        total += w;
      }
      if (total > 0) dist[i] = Math.exp(logs / total);
    }
  }
  // Directions no view saw (a corner past every frustum): the nearest seen one above or below.
  for (let x = 0; x < W; x++) {
    let last = NaN;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (Number.isNaN(dist[i])) dist[i] = last;
      else last = dist[i];
    }
    last = NaN;
    for (let y = H - 1; y >= 0; y--) {
      const i = y * W + x;
      if (Number.isNaN(dist[i])) dist[i] = last;
      else last = dist[i];
    }
  }
  for (let i = 0; i < dist.length; i++) if (Number.isNaN(dist[i])) dist[i] = FAR;

  // 4. What each direction is. The floor: anything below the horizon reaching about as far as the floor there (or past
  // it, which can't be) is the floor, laid exactly flat; specks the reading left in it go too.
  const cls = new Uint8Array(W * H);
  for (let i = 0; i < dist.length; i++) {
    const dy = dirs[i * 3 + 1];
    if (dy < -0.004 && dist[i] >= (height / -dy) * 0.9) cls[i] = FLOOR;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = cls.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // (Only what reads close to the floor anyway: a chair among floor isn't a speck.)
        if (cls[i] === FLOOR || dirs[i * 3 + 1] >= -0.004 || dist[i] < (height / -dirs[i * 3 + 1]) * 0.8) continue;
        let n = 0;
        for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) if ((yy || xx) && cls[(y + yy) * W + ((x + xx + W) % W)] === FLOOR) n++;
        if (n >= 6) next[i] = FLOOR;
      }
    }
    cls.set(next);
  }
  for (let i = 0; i < dist.length; i++) if (cls[i] === FLOOR) dist[i] = Math.min(FAR, height / -dirs[i * 3 + 1]);

  // Everything standing on the floor put to scale by where it meets it: the reading's distances keep their shape up each
  // column, scaled so a thing's foot is where the floor under it ends (the reading put a cafe 15 m away at 4 m, in
  // front of the cast; where a wall meets the floor is exact). Each spot takes the scale of the first foot below it;
  // the top run of each column (walls, buildings) takes its neighbors' too, so one bad foot can't bend a wall.
  {
    const latOf = (y: number) => (0.5 - (y + 0.5) / H) * span;
    const scale = new Float32Array(W * H).fill(NaN);
    const topScale = new Float32Array(W).fill(NaN);
    for (let x = 0; x < W; x++) {
      let k = NaN;
      for (let y = H - 1; y >= 0; y--) {
        const i = y * W + x;
        if (cls[i] === FLOOR) {
          k = NaN;
          // The pixel above a floor pixel that isn't floor: a foot.
          const j = i - W;
          if (y > 0 && cls[j] !== FLOOR && dirs[i * 3 + 1] < -0.004) {
            const reach = (height / -dirs[i * 3 + 1]) * Math.cos(latOf(y));
            const truth = reach / Math.cos(latOf(y - 1));
            k = Math.max(0.3, Math.min(10, truth / Math.max(0.05, dist[j])));
          }
          continue;
        }
        scale[i] = k;
      }
      // The top run's scale: the one above the column's highest floor.
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (cls[i] === FLOOR) break;
        if (!Number.isNaN(scale[i])) topScale[x] = scale[i];
      }
    }
    // Walls are smooth: the top runs' scales evened out across neighboring columns (a median), gaps filled.
    const even = new Float32Array(W).fill(NaN);
    const near: number[] = [];
    for (let x = 0; x < W; x++) {
      near.length = 0;
      for (let k = -8; k <= 8; k++) {
        const v = topScale[(x + k + W) % W];
        if (!Number.isNaN(v)) near.push(v);
      }
      if (near.length) even[x] = near.sort((a, b) => a - b)[near.length >> 1];
    }
    for (let x = 0; x < W; x++) {
      if (!Number.isNaN(even[x])) continue;
      for (let k = 1; k < W / 2; k++) {
        const v = even[(x + k) % W];
        const u = even[(x - k + W) % W];
        if (!Number.isNaN(v) || !Number.isNaN(u)) {
          even[x] = Number.isNaN(v) ? u : v;
          break;
        }
      }
    }
    for (let x = 0; x < W; x++) {
      let top = true;
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (cls[i] === FLOOR) {
          top = false;
          continue;
        }
        const k = top ? even[x] : scale[i];
        if (!Number.isNaN(k)) dist[i] = Math.min(FAR, dist[i] * k);
      }
    }
  }

  // Straight walls: fronts and room walls are flat and upright, and the reading's waves in them came out as bent
  // facades once the camera walked off (the image model drew them bent). Where each column's wall meets the floor is
  // a point on the floor plan; runs of them are split into straight stretches (Douglas-Peucker) and each stretch's
  // wall laid on its line, upright: what stands on it within about 15% of it (not an awning or a tree well before it)
  // eased onto that plane.
  {
    const latOf = (y: number) => (0.5 - (y + 0.5) / H) * span;
    const lonOf = (x: number) => ((x + 0.5) / W - 0.5) * 2 * Math.PI;
    const foot = new Float32Array(W).fill(NaN);
    const top = new Int32Array(W).fill(-1);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (cls[i] !== FLOOR) continue;
        if (y > 0 && dirs[i * 3 + 1] < -0.004) {
          foot[x] = (height / -dirs[i * 3 + 1]) * Math.cos(latOf(y));
          top[x] = y;
        }
        break;
      }
    }
    const px = (x: number) => [foot[x] * Math.sin(lonOf(x)), -foot[x] * Math.cos(lonOf(x))];
    const plane = new Float32Array(W).fill(NaN);
    // Splits a run of columns where it bends more than a few percent of its distance.
    const split = (a: number, b: number, out: [number, number][]) => {
      const [ax, az] = px(a);
      const [bx, bz] = px(b);
      const len = Math.hypot(bx - ax, bz - az) || 1e-6;
      let worst = -1;
      let at = -1;
      for (let x = a + 1; x < b; x++) {
        const [qx, qz] = px(x);
        const d = Math.abs((bx - ax) * (az - qz) - (ax - qx) * (bz - az)) / len;
        if (d > worst) [worst, at] = [d, x];
      }
      if (at > 0 && worst > Math.max(0.15, 0.03 * foot[at])) {
        split(a, at, out);
        split(at, b, out);
      } else out.push([a, b]);
    };
    let x = 0;
    while (x < W) {
      if (Number.isNaN(foot[x]) || foot[x] > 40) {
        x++;
        continue;
      }
      let end = x;
      while (end + 1 < W && !Number.isNaN(foot[end + 1]) && foot[end + 1] <= 40 && Math.abs(foot[end + 1] / foot[end] - 1) < 0.25) end++;
      const parts: [number, number][] = [];
      if (end - x >= 6) split(x, end, parts);
      for (const [a, b] of parts) {
        if (b - a < 6) continue;
        // The stretch's line: through its points' mean, along their main direction.
        let mx = 0;
        let mz = 0;
        for (let k = a; k <= b; k++) {
          const [qx, qz] = px(k);
          mx += qx;
          mz += qz;
        }
        const n = b - a + 1;
        mx /= n;
        mz /= n;
        let sxx = 0;
        let sxz = 0;
        let szz = 0;
        for (let k = a; k <= b; k++) {
          const [qx, qz] = px(k);
          sxx += (qx - mx) ** 2;
          sxz += (qx - mx) * (qz - mz);
          szz += (qz - mz) ** 2;
        }
        const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
        const [ux, uz] = [Math.cos(angle), Math.sin(angle)];
        for (let k = a; k <= b; k++) {
          // Where this column's ray meets the line.
          const [rx, rz] = [Math.sin(lonOf(k)), -Math.cos(lonOf(k))];
          const den = rx * uz - rz * ux;
          if (Math.abs(den) < 1e-4) continue;
          const t = (mx * uz - mz * ux) / den;
          if (t > 0.3 && Math.abs(t / foot[k] - 1) < 0.2) plane[k] = t;
        }
      }
      x = end + 1;
    }
    for (let x2 = 0; x2 < W; x2++) {
      if (Number.isNaN(plane[x2]) || top[x2] <= 0) continue;
      for (let y = 0; y < top[x2]; y++) {
        const i = y * W + x2;
        if (cls[i]) continue;
        const c = Math.cos(latOf(y));
        // Eased onto it, not snapped (snapped at a line, neighbors either side of it tore the cafe's front into blocks).
        const off = Math.abs((dist[i] * c) / foot[x2] - 1);
        const w = 1 - Math.min(1, Math.max(0, (off - 0.06) / 0.12));
        if (w > 0) dist[i] = Math.min(FAR, dist[i] + (plane[x2] / c - dist[i]) * w * w * (3 - 2 * w));
      }
    }
  }

  // A flat ceiling: most of what's well above the eye at one height.
  let ceiling: number | null = null;
  {
    const BIN = 0.05;
    const bins = new Float32Array(Math.ceil(10 / BIN));
    let n = 0;
    for (let i = 0; i < dist.length; i++) {
      const dy = dirs[i * 3 + 1];
      if (dy < 0.34 || dist[i] > 40) continue;
      const above = dist[i] * dy;
      if (above < 0.3 || above >= 10) continue;
      bins[Math.floor(above / BIN)]++;
      n++;
    }
    let best = -1;
    let bestCount = 0;
    for (let k = 2; k < bins.length - 2; k++) {
      const c = bins[k - 2] + bins[k - 1] + bins[k] + bins[k + 1] + bins[k + 2];
      if (c > bestCount) [best, bestCount] = [k, c];
    }
    if (n > 800 && bestCount >= n * 0.35) {
      const above = (best + 0.5) * BIN;
      ceiling = height + above;
      const tolerance = Math.max(0.15, above * 0.12);
      for (let i = 0; i < dist.length; i++) {
        const dy = dirs[i * 3 + 1];
        if (dy < 0.14 || cls[i]) continue;
        // Eased onto it near its edge (snapped at a line, the studio's ceiling met its walls in a jagged staircase).
        const off = Math.abs(dist[i] * dy - above) / tolerance;
        if (off >= 1.6) continue;
        if (off < 1) cls[i] = CEILING;
        const w = 1 - Math.max(0, (off - 0.8) / 0.8);
        dist[i] += (above / dy - dist[i]) * w * w * (3 - 2 * w);
      }
    }
  }

  // The sky: far away, past everything.
  for (let i = 0; i < dist.length; i++) {
    if (cls[i]) continue;
    if (dist[i] > 120 && dirs[i * 3 + 1] > -0.01) {
      dist[i] = FAR;
      cls[i] = SKY;
    }
  }

  // The rest: a little of the reading's noise taken out (a median of each spot's like neighbors).
  {
    const src = dist.slice();
    const near: number[] = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cls[i]) continue;
        near.length = 0;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            const j = (y + yy) * W + ((x + xx + W) % W);
            if (!cls[j]) near.push(src[j]);
          }
        }
        near.sort((a, b) => a - b);
        dist[i] = near[near.length >> 1];
      }
    }
  }

  // 5. Saved as a picture: 16 bits of inverse distance, and what each spot is.
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < dist.length; i++) {
    const q = Math.max(1, Math.min(65535, Math.round((65535 * R_MIN) / Math.max(R_MIN, dist[i]))));
    px[i * 4] = q >> 8;
    px[i * 4 + 1] = q & 255;
    px[i * 4 + 2] = cls[i];
    px[i * 4 + 3] = 255;
  }
  const name = `${nanoid(12)}.png`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name), await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer());

  let upper = 0;
  let skyUp = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dirs[i * 3 + 1] < 0.26) continue;
    upper++;
    if (cls[i] === SKY) skyUp++;
  }
  const indoor = ceiling !== null || skyUp < upper * 0.08;
  const depth: WorldDepth = { url: `/api/media/uploads/${name}`, width: W, height: H, rMin: R_MIN, eye: height, ceiling, indoor, version: VERSION };
  const light = await lightOf(erp, cls, dirs, W, H, indoor);
  await fs.writeFile(cache, JSON.stringify({ depth, light }));
  return { depth, light };
}

/** The place's main light, in the Director's terms (azimuth around the set like the camera's, elevation, softness, color). */
async function lightOf(erp: Erp, cls: Uint8Array, dirs: Float32Array, W: number, H: number, indoor: boolean): Promise<WorldLight> {
  const img = await sharp(erp.data, { raw: { width: erp.width, height: erp.height, channels: 3 } }).resize(W, H, { fit: "fill" }).raw().toBuffer();
  const lum = new Float32Array(W * H);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * img[i * 3] + 0.7152 * img[i * 3 + 1] + 0.0722 * img[i * 3 + 2];
  const angles = (d: Vec) => {
    const l = Math.hypot(d[0], d[2]) || 1e-6;
    return { azimuth: Math.round((Math.atan2(d[0], d[2]) * 180) / Math.PI), elevation: Math.round((Math.atan2(d[1], l) * 180) / Math.PI) };
  };
  // The color of the brightest hundredth, as a color temperature.
  const kelvinOf = (pick: (i: number) => boolean) => {
    const order = Array.from(lum.keys())
      .filter(pick)
      .sort((a, b) => lum[b] - lum[a]);
    const top = order.slice(0, Math.max(20, Math.floor(order.length / 100)));
    let [r, gg, b] = [0, 0, 0];
    for (const i of top) {
      r += img[i * 3];
      gg += img[i * 3 + 1];
      b += img[i * 3 + 2];
    }
    const s = r + gg + b || 1;
    let best = 5600;
    let err = Infinity;
    for (let k = 2500; k <= 9000; k += 100) {
      const [kr, kg, kb] = kelvinToRgb(k);
      const ks = kr + kg + kb;
      const e = (kr / ks - r / s) ** 2 + (kg / ks - gg / s) ** 2 + (kb / ks - b / s) ** 2;
      if (e < err) [best, err] = [k, e];
    }
    return best;
  };
  // A direction from the brightest spots, each weighted by how bright it is (steeply).
  const toward = (pick: (i: number) => boolean, power: number) => {
    const sum: Vec = [0, 0, 0];
    for (let i = 0; i < lum.length; i++) {
      if (!pick(i)) continue;
      const w = (lum[i] / 255) ** power;
      sum[0] += dirs[i * 3] * w;
      sum[1] += dirs[i * 3 + 1] * w;
      sum[2] += dirs[i * 3 + 2] * w;
    }
    return norm(sum);
  };
  const up = (i: number) => dirs[i * 3 + 1] > 0.03;

  if (indoor) {
    // Indoors: soft, from above, on the side the light comes from (windows, lamps): a sun can't shine through a roof.
    const side = toward((i) => dirs[i * 3 + 1] > -0.1, 8);
    const a = angles(side);
    return { azimuth: a.azimuth, elevation: Math.max(55, Math.min(80, a.elevation)), softness: 0.75, kelvin: Math.max(2700, Math.min(6500, kelvinOf((i) => dirs[i * 3 + 1] > -0.1))), sun: false };
  }

  // Outdoors at night (a dark sky): soft light from the bright signs and windows, never a sun (the Tokyo alley's neon
  // sign was taken for one).
  let skySum = 0;
  let skyN = 0;
  for (let i = 0; i < lum.length; i++) {
    if (cls[i] !== SKY && !(dirs[i * 3 + 1] > 0.5)) continue;
    skySum += lum[i];
    skyN++;
  }
  if (skyN && skySum / skyN < 70) {
    const a = angles(toward((i) => dirs[i * 3 + 1] > -0.1, 8));
    return { azimuth: a.azimuth, elevation: Math.max(20, Math.min(50, a.elevation + 10)), softness: 0.6, kelvin: Math.max(2700, Math.min(8000, kelvinOf((i) => dirs[i * 3 + 1] > -0.1))), sun: false };
  }
  // Outdoors by day: the sun, when it's a small, blown-out spot in the sky.
  let peak = 0;
  for (let i = 0; i < lum.length; i++) if (up(i) && lum[i] > peak) peak = lum[i];
  let spot = 0;
  let upper = 0;
  for (let i = 0; i < lum.length; i++) {
    if (!up(i)) continue;
    upper++;
    if (lum[i] >= Math.max(240, peak * 0.97)) spot++;
  }
  const kelvin = Math.max(3000, Math.min(8000, kelvinOf(up)));
  if (peak >= 245 && spot > 0 && spot < upper * 0.006) {
    const a = angles(toward((i) => up(i) && lum[i] >= Math.max(240, peak * 0.97), 1));
    return { azimuth: a.azimuth, elevation: Math.max(5, a.elevation), softness: 0.2, kelvin, sun: true };
  }
  // No sun in sight: the bright side of the sky. An even sky is overcast: soft light from high up.
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < lum.length; i++) {
    if (cls[i] !== SKY) continue;
    sum += lum[i];
    sq += lum[i] * lum[i];
    n++;
  }
  const mean = n ? sum / n : 0;
  const even = n > 0 && Math.sqrt(Math.max(0, sq / n - mean * mean)) < mean * 0.08;
  const a = angles(toward((i) => cls[i] === SKY || up(i), 6));
  return { azimuth: a.azimuth, elevation: even ? 60 : Math.max(15, Math.min(60, a.elevation + 15)), softness: even ? 0.85 : 0.5, kelvin, sun: false };
}
