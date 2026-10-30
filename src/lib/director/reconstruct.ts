import { MathUtils, Quaternion, Vector3 } from "three";
import type { CameraRig, PlaceView } from "./types";
import { verticalFov } from "./camera";

/**
 * Photo → 3D set. A location photo's depth map (from Depth Anything) is unprojected into a
 * relief seen from the camera that took the photo. The floor is found in the point cloud, so
 * the set is level, the floor sits at y = 0, and people placed on it stand on the photo's floor.
 * Everything here is pure math: no React, no WebGL.
 */

/** Relative depth from the vision service: 0 = farthest, 1 = nearest (normalized disparity). */
export type DepthMap = { width: number; height: number; data: Float32Array };

/** Photos are assumed to be shot on a 32mm (full-frame equivalent) lens, between a phone and a 35mm. */
const PHOTO_FOCAL = 32;
/** Height of a hand-held camera, which gives the set its scale in meters. */
const EYE = 1.6;
/** How far beyond the photo's edges the set keeps going, as a share of the photo. */
export const PLACE_MARGIN = 0.14;

const FULL_FRAME_DIAGONAL = Math.hypot(36, 24);
const deg = MathUtils.radToDeg;
const rad = MathUtils.degToRad;

export function photoFov(aspect: number) {
  return verticalFov(PHOTO_FOCAL, aspect);
}

/** Bilinear sample of the depth map at u, v in 0…1 (clamped). */
export function sampleDepth(map: DepthMap, u: number, v: number) {
  const x = MathUtils.clamp(u, 0, 1) * (map.width - 1);
  const y = MathUtils.clamp(v, 0, 1) * (map.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = map.data;
  const w = map.width;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bottom = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Depth along the view axis, in units where the nearest surface is at 1 and the farthest at `ratio`. */
export function unitDepth(disparity: number, ratio: number) {
  return 1 / (disparity * (1 - 1 / ratio) + 1 / ratio);
}

export function unproject(u: number, v: number, z: number, tanV: number, tanH: number, out = new Vector3()) {
  return out.set((2 * u - 1) * tanH * z, (1 - 2 * v) * tanV * z, -z);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Plane = { n: Vector3; c: number };

/** Smallest-eigenvalue direction of a symmetric 3×3 matrix (Jacobi rotations). */
function smallestEigenvector(m: number[][]) {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) [p, q, max] = [0, 2, Math.abs(a[0][2])];
    if (Math.abs(a[1][2]) > max) [p, q, max] = [1, 2, Math.abs(a[1][2])];
    if (max < 1e-12) break;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k];
      const aqk = a[q][k];
      a[p][k] = c * apk - s * aqk;
      a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return new Vector3(v[0][best], v[1][best], v[2][best]).normalize();
}

/** A floor candidate must face up, sit below the camera and imply a believable camera tilt. */
function plausibleFloor(n: Vector3, c: number) {
  if (c <= 0) return false;
  const pitch = deg(Math.asin(MathUtils.clamp(-n.z, -1, 1)));
  const roll = deg(Math.atan2(n.x, n.y));
  return n.y > 0.25 && pitch > -78 && pitch < 38 && Math.abs(roll) < 22;
}

/** Most photos are taken close to level: a steeply tilted floor needs clearly more support to win. */
const tiltPenalty = (n: Vector3) => 0.004 * Math.abs(deg(Math.asin(MathUtils.clamp(-n.z, -1, 1))));

function fitFloor(points: Vector3[], random: () => number): { plane: Plane; inliers: number; score: number } | null {
  if (points.length < 30) return null;
  const tol = 0.028;
  const count = (n: Vector3, c: number) => {
    let k = 0;
    for (const p of points) if (Math.abs(n.dot(p) + c) < tol * p.length()) k++;
    return k;
  };
  let best: { plane: Plane; inliers: number; score: number } | null = null;
  const ab = new Vector3();
  const ac = new Vector3();
  for (let i = 0; i < 180; i++) {
    const a = points[Math.floor(random() * points.length)];
    const b = points[Math.floor(random() * points.length)];
    const c3 = points[Math.floor(random() * points.length)];
    const n = ab.subVectors(b, a).clone().cross(ac.subVectors(c3, a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    if (n.y < 0) n.negate();
    const c = -n.dot(a);
    if (!plausibleFloor(n, c)) continue;
    const k = count(n, c);
    const score = k / points.length - tiltPenalty(n);
    if (!best || score > best.score) best = { plane: { n, c }, inliers: k, score };
  }
  if (!best) return null;

  // Least-squares refit on the inliers.
  const { n, c } = best.plane;
  const inl = points.filter((p) => Math.abs(n.dot(p) + c) < tol * p.length());
  const centroid = inl.reduce((s, p) => s.add(p), new Vector3()).divideScalar(inl.length);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of inl) {
    const d = [p.x - centroid.x, p.y - centroid.y, p.z - centroid.z];
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[r][q] += d[r] * d[q];
  }
  const rn = smallestEigenvector(cov);
  if (rn.y < 0) rn.negate();
  const rc = -rn.dot(centroid);
  if (plausibleFloor(rn, rc)) {
    const k = count(rn, rc);
    if (k >= best.inliers * 0.95) best = { plane: { n: rn, c: rc }, inliers: k, score: k / points.length - tiltPenalty(rn) };
  }
  return best;
}

/**
 * Recover how the photo was taken: lens, tilt, roll, camera height and the depth range that
 * makes its floor flat. Deterministic, so the same photo always builds the same set.
 */
export function fitPlaceView(depth: DepthMap, aspect: number): PlaceView {
  const fov = photoFov(aspect);
  const tanV = Math.tan(rad(fov / 2));
  const tanH = tanV * aspect;

  // Floor candidates live in the lower half of the picture.
  const samples: { u: number; v: number; d: number }[] = [];
  const cols = 48;
  const rows = 30;
  for (let j = 0; j < rows; j++) {
    const v = 0.5 + (j / (rows - 1)) * 0.47;
    for (let i = 0; i < cols; i++) {
      const u = 0.03 + (i / (cols - 1)) * 0.94;
      samples.push({ u, v, d: sampleDepth(depth, u, v) });
    }
  }

  // The depth model knows order, not distance: try depth ranges and keep the one with the flattest floor.
  let best: { ratio: number; plane: Plane; score: number } | null = null;
  for (const ratio of [3, 4.5, 6.5, 9, 13, 19, 28, 42, 64]) {
    const pts = samples.map((s) => unproject(s.u, s.v, unitDepth(s.d, ratio), tanV, tanH));
    const fit = fitFloor(pts, mulberry32(0x5eed + ratio * 97));
    if (!fit) continue;
    const score = fit.score - 0.025 * Math.abs(Math.log(ratio / 12));
    if (!best || score > best.score) best = { ratio, plane: fit.plane, score };
  }

  const centerDepth = (ratio: number) => {
    const ds: number[] = [];
    for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) ds.push(unitDepth(sampleDepth(depth, 0.4 + i * 0.033, 0.38 + j * 0.04), ratio));
    ds.sort((x, y) => x - y);
    return ds[Math.floor(ds.length / 2)];
  };

  if (!best || best.score < 0.2) {
    // No floor in sight (a close-up, a wall): a level camera at eye height, the middle of the picture ~5.5 m away.
    const ratio = 10;
    const scale = 5.5 / centerDepth(ratio);
    return { fov, height: EYE, pitch: 0, roll: 0, pivot: 5.5, near: scale, far: scale * ratio, floor: false };
  }

  const { n, c } = best.plane;
  const scale = EYE / c;
  const pitch = deg(Math.asin(MathUtils.clamp(-n.z, -1, 1)));
  const alpha = Math.atan2(n.x, n.y);
  const q = photoQuaternion(pitch, alpha);

  const base: PlaceView = { fov, height: EYE, pitch, roll: -deg(alpha), pivot: 5, near: scale, far: scale * best.ratio, floor: true };
  const cosPitch = Math.cos(rad(pitch));

  // The set's center is where a person will stand: a patch of floor the photo actually shows,
  // straight down the middle of the picture, where someone would look a natural size.
  let spot: { pivot: number; cost: number } | null = null;
  const p = new Vector3();
  for (let v = 0.97; v >= 0.45; v -= 0.01) {
    unproject(0.5, v, unitDepth(sampleDepth(depth, 0.5, v), best.ratio), tanV, tanH, p);
    if (Math.abs(n.dot(p) + c) > 0.035 * p.length()) continue; // not floor here (a wall, a rock, a person)
    const world = p.clone().multiplyScalar(scale).applyQuaternion(q);
    const horizontal = Math.hypot(world.x, world.z);
    if (horizontal < 1.4) continue;
    const pivot = horizontal / cosPitch;
    const cost = Math.abs(personShare({ ...base, pivot }) - 0.42) + 0.2 * Math.abs(v - 0.8);
    if (!spot || cost < spot.cost) spot = { pivot, cost };
  }
  let pivot = spot?.pivot ?? 0;
  if (!spot) {
    // No clear floor down the middle: use where the ray a bit below center meets the floor plane.
    const dir = new Vector3(0, (1 - 2 * 0.78) * tanV, -1).applyQuaternion(q);
    let horizontal = dir.y < -1e-3 ? (EYE / -dir.y) * Math.hypot(dir.x, dir.z) : 5;
    horizontal = MathUtils.clamp(horizontal, 2.2, 9);
    const tilt = Math.tan(rad(pitch));
    if (EYE + horizontal * tilt < 0.15) horizontal = (EYE - 0.15) / -tilt;
    pivot = horizontal / cosPitch;
  }

  const view: PlaceView = { ...base, pivot };
  // Eye height is a guess. Photos taken from above (a cliff, a drone, a balcony) would put a person
  // right under the lens and enormous; there the place must be bigger, so grow it until someone
  // standing at the set's center looks like a person in the middle distance.
  const share = personShare(view);
  const grow = share > 0.55 ? Math.min(60, share / 0.42) : 1;
  return grow > 1 ? { ...view, height: EYE * grow, pivot: pivot * grow, near: view.near * grow, far: view.far * grow } : view;
}

/** How much of the photo's height a 1.72 m person standing at the set's center would fill. */
function personShare(view: PlaceView) {
  const { position, quaternion } = photoCamera(view);
  const tanV = Math.tan(rad(view.fov / 2));
  const toNdc = (y: number) => {
    const local = new Vector3(0, y, 0).sub(position).applyQuaternion(quaternion.clone().invert());
    return local.z < -1e-3 ? local.y / (-local.z * tanV) : Infinity;
  };
  const feet = toNdc(0);
  const head = toNdc(1.72);
  return Number.isFinite(feet) && Number.isFinite(head) ? Math.abs(head - feet) / 2 : 1;
}

/** Orientation of the photo camera: level yaw toward -z, then tilt, then roll. */
function photoQuaternion(pitchDeg: number, rollRad: number) {
  const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rad(pitchDeg));
  const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rollRad);
  return qx.multiply(qz);
}

/** Where the photo was taken from, in set coordinates (the set's center spot is the origin). */
export function photoCamera(view: PlaceView, scale = 1) {
  const horizontal = view.pivot * Math.cos(rad(view.pitch));
  const position = new Vector3(0, view.height, horizontal).multiplyScalar(scale);
  const quaternion = photoQuaternion(view.pitch, rad(-view.roll));
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
  return { position, quaternion, forward };
}

/** Focal length that shows the photo edge to edge in a frame of another aspect ratio. */
export function focalForPhoto(view: PlaceView, photoAspect: number, frameAspect: number) {
  const tanV = Math.tan(rad(view.fov / 2));
  const frameTanV = frameAspect >= photoAspect ? (tanV * photoAspect) / frameAspect : tanV;
  const tanHalfDiagonal = frameTanV * Math.sqrt(frameAspect * frameAspect + 1);
  return FULL_FRAME_DIAGONAL / (2 * tanHalfDiagonal);
}

/** The camera rig that looks exactly through the photo's camera. */
export function photoRig(view: PlaceView, photoAspect: number, frameAspect: number, scale = 1): Partial<CameraRig> {
  const horizontal = view.pivot * Math.cos(rad(view.pitch));
  return {
    azimuth: 0,
    elevation: -view.pitch,
    distance: view.pivot * scale,
    focusHeight: (view.height + horizontal * Math.tan(rad(view.pitch))) * scale,
    roll: view.roll,
    focal: Math.round(focalForPhoto(view, photoAspect, frameAspect) * 10) / 10,
  };
}

/**
 * The set's surface: a grid over the photo (plus a margin past its edges, where the edge pixels
 * stretch and fade), each vertex pushed out along its pixel's ray to its depth. World units, at
 * scale 1; the set's center spot is the origin and the floor is y = 0.
 */
export function placeSurface(depth: DepthMap, view: PlaceView, aspect: number, columns = 220) {
  const rows = Math.max(8, Math.round(columns / aspect));
  const ratio = view.far / view.near;
  const tanV = Math.tan(rad(view.fov / 2));
  const tanH = tanV * aspect;
  const { position: origin, quaternion } = photoCamera(view);
  const m = PLACE_MARGIN;
  // Below the photo the floor carries on toward (and under) the camera, so it gets a deeper margin.
  const floorMargin = view.floor ? 0.7 : m;
  const extraCols = Math.round(columns * m);
  const extraTop = Math.round(rows * m);
  const extraBottom = Math.round(rows * floorMargin);
  const W = columns + 1 + extraCols * 2;
  const H = rows + 1 + extraTop + extraBottom;
  const positions = new Float32Array(W * H * 3);
  const uvs = new Float32Array(W * H * 2);
  const outside = new Float32Array(W * H);
  const zs = new Float32Array(W * H);
  const p = new Vector3();
  const ray = new Vector3();
  for (let j = 0; j < H; j++) {
    const v = (j - extraTop) / rows;
    for (let i = 0; i < W; i++) {
      const u = (i - extraCols) / columns;
      const cu = MathUtils.clamp(u, 0, 1);
      const cv = MathUtils.clamp(v, 0, 1);
      let z = unitDepth(sampleDepth(depth, cu, cv), ratio) * view.near;
      if (v > 1 && view.floor) {
        // Where this ray meets the floor (y = 0), if that's nearer than the photo's bottom edge.
        unproject(u, v, 1, tanV, tanH, ray).applyQuaternion(quaternion);
        if (ray.y < -1e-4) z = Math.min(z, origin.y / -ray.y);
      }
      unproject(u, v, z, tanV, tanH, p).applyQuaternion(quaternion).add(origin);
      const k = j * W + i;
      zs[k] = z;
      positions[k * 3] = p.x;
      positions[k * 3 + 1] = p.y;
      positions[k * 3 + 2] = p.z;
      uvs[k * 2] = cu;
      uvs[k * 2 + 1] = 1 - cv;
      const side = Math.max(Math.abs(u - cu), v < 0 ? -v : 0) / m;
      const below = v > 1 ? ((v - 1) / floorMargin) * (view.floor ? 0.6 : 1) : 0;
      outside[k] = Math.min(1, Math.max(side, below));
    }
  }
  // Where depth jumps between neighbors (an edge in the photo), the surface is a stretched "curtain"
  // the photo never saw. Marked so it can be drawn as a soft smear instead of sharp streaks.
  const stretch = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let jump = 0;
      if (i > 0) jump = Math.max(jump, Math.abs(Math.log(zs[k] / zs[k - 1])));
      if (i < W - 1) jump = Math.max(jump, Math.abs(Math.log(zs[k] / zs[k + 1])));
      if (j > 0) jump = Math.max(jump, Math.abs(Math.log(zs[k] / zs[k - W])));
      if (j < H - 1) jump = Math.max(jump, Math.abs(Math.log(zs[k] / zs[k + W])));
      // Past the photo's edges there's only smeared border pixels: always soft.
      stretch[k] = Math.min(1, Math.max((jump - 0.07) / 0.25, outside[k] > 0 ? 0.55 + outside[k] : 0));
    }
  }

  const index = new Uint32Array((W - 1) * (H - 1) * 6);
  let t = 0;
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      index[t++] = a;
      index[t++] = c;
      index[t++] = b;
      index[t++] = b;
      index[t++] = c;
      index[t++] = d;
    }
  }
  return { positions, uvs, outside, stretch, index };
}

/**
 * The point of the set seen at u, v in the photo (0…1 from the top-left), in set coordinates at
 * scale 1. Depth is the median of a small patch, so a click on an edge doesn't land on the wall behind.
 */
export function surfacePoint(depth: DepthMap, view: PlaceView, aspect: number, u: number, v: number) {
  const tanV = Math.tan(rad(view.fov / 2));
  const ratio = view.far / view.near;
  const ds: number[] = [];
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) ds.push(sampleDepth(depth, u + i * 0.006, v + j * 0.006));
  ds.sort((x, y) => x - y);
  const z = unitDepth(ds[Math.floor(ds.length / 2)], ratio) * view.near;
  const { position, quaternion } = photoCamera(view);
  return unproject(u, v, z, tanV, tanV * aspect).applyQuaternion(quaternion).add(position);
}

/** How the shot camera has moved away from the photo's own viewpoint, for the prompt. */
export function moveFromPhoto(view: PlaceView, scale: number, camPos: Vector3, camForward: Vector3) {
  const photo = photoCamera(view, scale);
  const yawOf = (f: Vector3) => Math.atan2(f.x, -f.z);
  const turn = deg(yawOf(camForward) - yawOf(photo.forward));
  const yaw = ((((turn + 180) % 360) + 360) % 360) - 180;
  const pitch = deg(Math.asin(MathUtils.clamp(camForward.y, -1, 1))) - view.pitch;
  const rise = camPos.y - photo.position.y;
  const shift = camPos.clone().sub(photo.position);
  // Forward motion along the photo's line of sight, and sideways motion across it.
  const flatForward = new Vector3(photo.forward.x, 0, photo.forward.z).normalize();
  const flatRight = new Vector3(-flatForward.z, 0, flatForward.x);
  return { yaw, pitch, rise, forward: shift.dot(flatForward), sideways: shift.dot(flatRight) };
}

/**
 * How much of a subject standing at (x, z) the location photo's own surfaces would hide or cut
 * through, seen from where the photo was taken (0 = clear, 1 = inside a wall or a rock). The feet
 * are left out: standing on the floor is meant to touch it.
 */
export function hiddenShare(
  depth: DepthMap,
  view: PlaceView,
  scale: number,
  aspect: number,
  at: { x: number; z: number; height: number; lift: number; width: number },
) {
  const { position, quaternion } = photoCamera(view, scale);
  const inverse = quaternion.clone().invert();
  const right = new Vector3(1, 0, 0).applyQuaternion(quaternion).setY(0).normalize();
  const tanV = Math.tan(rad(view.fov / 2));
  const tanH = tanV * aspect;
  const ratio = view.far / view.near;
  const local = new Vector3();
  let blocked = 0;
  let seen = 0;
  for (const side of [-0.35, 0, 0.35]) {
    for (let k = 0; k < 10; k++) {
      const y = at.lift + at.height * (0.2 + (k / 9) * 0.78);
      local
        .set(at.x + right.x * side * at.width, y, at.z + right.z * side * at.width)
        .sub(position)
        .applyQuaternion(inverse);
      const along = -local.z;
      if (along <= 0.05) continue;
      const u = 0.5 + (local.x / (along * tanH)) * 0.5;
      const v = 0.5 - (local.y / (along * tanV)) * 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      seen++;
      const surface = unitDepth(sampleDepth(depth, u, v), ratio) * view.near * scale;
      if (surface < along + 0.12) blocked++;
    }
  }
  return seen ? blocked / seen : 0;
}
