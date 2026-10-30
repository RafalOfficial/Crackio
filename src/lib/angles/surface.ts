import { MathUtils, Vector3 } from "three";
import { photoCamera, sampleDepth, unitDepth, unproject, type DepthMap } from "@/lib/director/reconstruct";
import type { PlaceView } from "@/lib/director/types";
import type { SubjectMask } from "@/lib/director/vision";

/**
 * Surfaces for camera moves around a photo, beyond what Director's set needs. A depth map only
 * knows the side the camera saw: seen from elsewhere, the gaps behind things become long stretched
 * "curtains" and a person turns into a paper relief. Here the curtains are opened into holes and
 * the subject becomes a solid: the photo's own surface in front (from the original camera nothing
 * changes) and a back pushed away along the camera's rays, thickest in the middle and closing at
 * the outline. Pure math, set coordinates at scale 1 like placeSurface.
 */

/**
 * placeSurface's triangles minus the curtains: quads across a jump in depth, where something stands
 * in front of something farther away. Jumps are measured in inverse depth (what the depth model
 * actually estimates), so the model's noise in the sky or on far water doesn't count, and a step
 * counts only when it's much bigger than the steps three cells before and after it, so a floor
 * running off to the horizon (big but steady steps) stays whole while the gap behind a person opens.
 */
export function openCurtains(positions: Float32Array, index: Uint32Array, view: PlaceView) {
  // placeSurface's first triangle is (0, W, 1): the grid's width.
  const W = index[1];
  const count = positions.length / 3;
  const H = Math.floor(count / W);
  const { position: origin, forward } = photoCamera(view);
  // 1 at the nearest surface, 1/ratio at the farthest.
  const L = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const z =
      (positions[k * 3] - origin.x) * forward.x + (positions[k * 3 + 1] - origin.y) * forward.y + (positions[k * 3 + 2] - origin.z) * forward.z;
    L[k] = view.near / Math.max(1e-4, z);
  }
  const isJump = (g: number, before: number | null, after: number | null) => {
    const ref = Math.min(before ?? Infinity, after ?? Infinity);
    return g > 0.05 && g > 2.5 * (Number.isFinite(ref) ? ref : 0) + 0.015;
  };
  // Edge k→k+1 and edge k→k+W.
  const right = new Uint8Array(count);
  const down = new Uint8Array(count);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (i < W - 1) {
        const before = i >= 3 ? Math.abs(L[k - 2] - L[k - 3]) : null;
        const after = i + 4 < W ? Math.abs(L[k + 4] - L[k + 3]) : null;
        right[k] = isJump(Math.abs(L[k + 1] - L[k]), before, after) ? 1 : 0;
      }
      if (j < H - 1) {
        const before = j >= 3 ? Math.abs(L[k - 2 * W] - L[k - 3 * W]) : null;
        const after = j + 4 < H ? Math.abs(L[k + 4 * W] - L[k + 3 * W]) : null;
        down[k] = isJump(Math.abs(L[k + W] - L[k]), before, after) ? 1 : 0;
      }
    }
  }
  const out = new Uint32Array(index.length);
  let t = 0;
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      if (right[a] || right[c] || down[a] || down[b]) continue;
      out.set([a, c, b, b, c, d], t);
      t += 6;
    }
  }
  return out.slice(0, t);
}

/** Bilinear coverage of the mask at u, v (0…1). */
export function sampleMask(mask: SubjectMask, u: number, v: number) {
  const x = MathUtils.clamp(u, 0, 1) * (mask.width - 1);
  const y = MathUtils.clamp(v, 0, 1) * (mask.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = mask.data;
  const w = mask.width;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bottom = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return (top * (1 - fy) + bottom * fy) / 255;
}

/** The subject's bounding box in the photo (0…1), or null when the mask is empty. */
function maskBox(mask: SubjectMask) {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x] < 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX / (mask.width - 1), y: minY / (mask.height - 1), w: (maxX - minX) / (mask.width - 1), h: (maxY - minY) / (mask.height - 1) };
}

/**
 * The middle of the subject, for the camera to orbit: where its coverage balances in the photo, at
 * the median depth of its solid interior (the balance point itself can fall in a gap, like the
 * space inside a headphone band). Null when the mask found no subject.
 */
export function subjectAnchor(depth: DepthMap, mask: SubjectMask, view: PlaceView, aspect: number) {
  let su = 0;
  let sv = 0;
  let total = 0;
  const disparities: number[] = [];
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const a = mask.data[y * mask.width + x];
      if (a < 128) continue;
      const u = x / (mask.width - 1);
      const v = y / (mask.height - 1);
      su += u * a;
      sv += v * a;
      total += a;
      if (a > 242 && (x & 3) === 0 && (y & 3) === 0) disparities.push(sampleDepth(depth, u, v));
    }
  }
  if (!total || disparities.length < 8) return null;
  disparities.sort((p, q) => p - q);
  const u = su / total;
  const v = sv / total;
  const z = unitDepth(disparities[Math.floor(disparities.length / 2)], view.far / view.near) * view.near;
  const tanV = Math.tan(MathUtils.degToRad(view.fov / 2));
  const { position, quaternion } = photoCamera(view);
  return { u, v, point: unproject(u, v, z, tanV, tanV * aspect).applyQuaternion(quaternion).add(position) };
}

/** Distance (in grid cells) from every inside cell to the nearest outside one. Two-pass chamfer. */
function insideDistance(inside: Uint8Array, w: number, h: number) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  }
  return d;
}

/** One 3×3 box blur, edges clamped. */
function blur(values: Float32Array, w: number, h: number) {
  const out = new Float32Array(values.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += values[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** The subject as a solid (see above), over a grid covering the mask's bounding box. */
export function subjectSurface(depth: DepthMap, mask: SubjectMask, view: PlaceView, aspect: number, columnsPerPhoto = 260) {
  const found = maskBox(mask);
  if (!found) return null;
  // A couple of cells of margin, so the outline isn't cut by the grid's edge.
  const cell = 1 / columnsPerPhoto;
  const box = {
    x: Math.max(0, found.x - 2 * cell),
    y: Math.max(0, found.y - 2 * cell * aspect),
    w: 0,
    h: 0,
  };
  box.w = Math.min(1, found.x + found.w + 2 * cell) - box.x;
  box.h = Math.min(1, found.y + found.h + 2 * cell * aspect) - box.y;
  const W = Math.max(8, Math.round(box.w * columnsPerPhoto)) + 1;
  const H = Math.max(8, Math.round((box.h * columnsPerPhoto) / aspect)) + 1;
  const n = W * H;
  const uOf = (i: number) => box.x + (i / (W - 1)) * box.w;
  const vOf = (j: number) => box.y + (j / (H - 1)) * box.h;

  const inside = new Uint8Array(n);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) inside[j * W + i] = sampleMask(mask, uOf(i), vOf(j)) > 0.5 ? 1 : 0;
  const dist = insideDistance(inside, W, H);

  // Depth: the depth map blurs across the outline, so only the interior is trusted and its depth is
  // carried outward to the edge (breadth-first, each cell taking its neighbor's).
  const ratio = view.far / view.near;
  const zs = new Float32Array(n).fill(-1);
  const queue: number[] = [];
  let trust = 2.5;
  for (let attempt = 0; attempt < 2 && !queue.length; attempt++, trust = 1) {
    for (let k = 0; k < n; k++) {
      if (dist[k] < trust) continue;
      zs[k] = unitDepth(sampleDepth(depth, uOf(k % W), vOf(Math.floor(k / W))), ratio) * view.near;
      queue.push(k);
    }
  }
  if (!queue.length) return null;
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const i = k % W;
    const neighbors = [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W];
    for (const m of neighbors) {
      if (m < 0 || m >= n || zs[m] >= 0) continue;
      zs[m] = zs[k];
      queue.push(m);
    }
  }

  // Smoothed, so folds and an arm in front of the body don't tear the solid open. Depth only moves
  // points along their own rays, so from the original camera the subject looks exactly the same.
  let smooth = zs;
  for (let pass = 0; pass < 6; pass++) smooth = blur(smooth, W, H);
  zs.set(smooth);

  // Thickness: about 1.25× the distance to the outline, in meters, softened into a rounded body.
  const tanV = Math.tan(MathUtils.degToRad(view.fov / 2));
  const tanH = tanV * aspect;
  let thick = new Float32Array(n);
  for (let k = 0; k < n; k++) thick[k] = inside[k] ? 1.25 * dist[k] * ((2 * tanH * zs[k] * box.w) / (W - 1)) : 0;
  thick = blur(blur(thick, W, H), W, H);

  const { position: origin, quaternion } = photoCamera(view);
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const back = new Float32Array(n * 2);
  const p = new Vector3();
  const ray = new Vector3();
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const u = uOf(i);
      const v = vOf(j);
      unproject(u, v, zs[k], tanV, tanH, p).applyQuaternion(quaternion).add(origin);
      ray.copy(p).sub(origin).normalize();
      positions.set([p.x, p.y, p.z], k * 3);
      p.addScaledVector(ray, thick[k]);
      positions.set([p.x, p.y, p.z], (n + k) * 3);
      uvs.set([u, 1 - v], k * 2);
      uvs.set([u, 1 - v], (n + k) * 2);
      back[n + k] = 1;
    }
  }

  // Both sheets wind the same way; the shader shows the back's side as unseen whichever way it faces.
  const index = new Uint32Array((W - 1) * (H - 1) * 12);
  let t = 0;
  for (const offset of [0, n]) {
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const a = offset + j * W + i;
        const b = a + 1;
        const c = a + W;
        const d = c + 1;
        index.set([a, c, b, b, c, d], t);
        t += 6;
      }
    }
  }
  return { positions, uvs, back, index };
}
