import { sampleDepth, type DepthMap } from "./reconstruct";

/**
 * Cutout → a shallow 3D relief, so a person or object has some body when the camera swings
 * around them instead of turning into a paper-thin card. The silhouette is "inflated" from its
 * outline (rounder in the middle, thin at the edges) and the depth model adds the real shape:
 * a nose, folded arms, a car's hood. The back is the same silhouette, a little flatter.
 */
export type ReliefInput = {
  /** Coverage per grid vertex, 0…1, row by row from the top of the subject. */
  alpha: Float32Array;
  columns: number;
  rows: number;
  /** Size of the subject in meters. */
  width: number;
  height: number;
  /** Total front-to-back thickness at the thickest point, meters. */
  thickness: number;
  /** Region of the image the grid covers (0…1, from the top-left), for texture coordinates. */
  box: { x: number; y: number; w: number; h: number };
  /** Depth of the whole image (1 = nearest), if the vision service made one. */
  depth?: DepthMap | null;
  /** Photos without transparency stay flat cards. */
  flat?: boolean;
};

/** Distance (in grid cells) from every inside cell to the nearest outside cell. Two-pass chamfer. */
function insideDistance(mask: Uint8Array, w: number, h: number) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  }
  return d;
}

export function reliefSurface(input: ReliefInput) {
  const { alpha, columns: W, rows: H, width, height, thickness, box, depth, flat } = input;
  const n = W * H;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = alpha[i] > 0.5 ? 1 : 0;

  const dist = insideDistance(mask, W, H);
  let maxDist = 1;
  for (let i = 0; i < n; i++) if (dist[i] > maxDist) maxDist = dist[i];
  const core = Math.max(1.5, maxDist * 0.6);

  // The depth model's view of the subject, normalized inside the silhouette.
  const shape = new Float32Array(n);
  if (depth && !flat) {
    const inside: number[] = [];
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        shape[k] = sampleDepth(depth, box.x + (i / (W - 1)) * box.w, box.y + (j / (H - 1)) * box.h);
        if (mask[k]) inside.push(shape[k]);
      }
    }
    inside.sort((a, b) => a - b);
    const lo = inside[Math.floor(inside.length * 0.05)] ?? 0;
    const hi = inside[Math.floor(inside.length * 0.95)] ?? 1;
    const span = Math.max(1e-4, hi - lo);
    for (let k = 0; k < n; k++) shape[k] = Math.min(1, Math.max(0, (shape[k] - lo) / span));
  } else {
    shape.fill(0.5);
  }

  const front = new Float32Array(n * 3);
  const back = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const half = thickness / 2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x = (i / (W - 1) - 0.5) * width;
      const y = (1 - j / (H - 1)) * height;
      let zf = 0;
      let zb = 0;
      if (mask[k]) {
        if (flat) {
          zf = 0.01;
          zb = -0.01;
        } else {
          const t = Math.min(1, dist[k] / core);
          const round = Math.sqrt(1 - (1 - t) * (1 - t));
          zf = half * round * (0.55 + 0.45 * shape[k]);
          zb = -half * 0.8 * round;
        }
      }
      front.set([x, y, zf], k * 3);
      back.set([x, y, zb], k * 3);
      uvs[k * 2] = box.x + (i / (W - 1)) * box.w;
      uvs[k * 2 + 1] = 1 - (box.y + (j / (H - 1)) * box.h);
    }
  }

  const frontIndex = new Uint32Array((W - 1) * (H - 1) * 6);
  const backIndex = new Uint32Array((W - 1) * (H - 1) * 6);
  let t = 0;
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      frontIndex.set([a, c, b, b, c, d], t);
      backIndex.set([a, b, c, b, d, c], t);
      t += 6;
    }
  }
  return { front, back, uvs, frontIndex, backIndex };
}
