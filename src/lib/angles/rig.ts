import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { photoCamera, photoFov, sampleDepth, surfacePoint, unitDepth, unproject, type DepthMap } from "@/lib/director/reconstruct";
import type { PlaceView } from "@/lib/director/types";
import type { Geometry, SubjectMask } from "@/lib/director/vision";
import { subjectAnchor } from "./surface";

/**
 * The Angles camera. The photo, measured in meters with the lens it was taken with (MoGe, server/vision
 * `estimateGeometry`), becomes Director's soft 3D set (see reconstruct.ts) and the camera orbits a point of it
 * (the main subject unless you pick another), starting exactly where the photo was taken. Pure math, shared by
 * the 3D view, the guide render and the prompt.
 */
export type AngleView = {
  /** Degrees around the orbit point. Positive = the camera moves to its right. */
  azimuth: number;
  /** Camera height as an angle seen from the orbit point: 0 = level, 90 = straight overhead. Unset = the photo's own. */
  elevation?: number;
  /** -1 = much farther back … 1 = much closer. */
  zoom: number;
  /** The point to orbit, in the photo (0…1 from the top-left). Unset = the main subject. */
  pivot?: { u: number; v: number };
};

/** A view with the photo's own height filled in: what the camera actually does. */
export type AngleShot = { azimuth: number; elevation: number; zoom: number };

export const MIN_ELEVATION = -70;
export const MAX_ELEVATION = 89.5;

const deg = MathUtils.radToDeg;
const rad = MathUtils.degToRad;

export const wrapDegrees = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Distance from the orbit point for a zoom setting: about 2.4× closer at +1, 2.4× farther at -1. */
export const zoomFactor = (zoom: number) => Math.pow(2, -zoom * 1.25);

const fitted = new WeakMap<Geometry, PlaceView>();

/** How the photo was taken, worked out once per measured photo (the 3D view, controls and guide all ask). */
export function placeFor(geometry: Geometry, aspect: number) {
  let place = fitted.get(geometry);
  if (!place) {
    place = levelPlace(geometry, aspect);
    fitted.set(geometry, place);
  }
  return place;
}

/** A floor plane in camera space (y up, the camera looking down -z): n·p + c = 0, c = the camera's height above it. */
type Plane = { n: Vector3; c: number };

/** A floor must face up, lie below the camera and imply a believable tilt and roll. */
function plausible(n: Vector3, c: number) {
  if (c <= 0 || n.y < 0.25) return false;
  const pitch = deg(Math.asin(MathUtils.clamp(-n.z, -1, 1)));
  return pitch > -80 && pitch < 40 && Math.abs(deg(Math.atan2(n.x, n.y))) < 25;
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

/**
 * The floor among the photo's measured points (RANSAC, then a least-squares refit on its inliers): the biggest plane
 * that could be one, a steep tilt needing more support (most photos are taken near level).
 */
function floorPlane(points: Vector3[]): Plane | null {
  if (points.length < 30) return null;
  const random = mulberry32(0x5eed);
  const near = (n: Vector3, c: number, p: Vector3) => Math.abs(n.dot(p) + c) < 0.02 * p.length() + 0.01;
  const support = (n: Vector3, c: number) => points.reduce((k, p) => k + (near(n, c, p) ? 1 : 0), 0) / points.length;
  const tilt = (n: Vector3) => 0.003 * Math.abs(deg(Math.asin(MathUtils.clamp(-n.z, -1, 1))));
  let best: { plane: Plane; score: number } | null = null;
  const ab = new Vector3();
  const ac = new Vector3();
  for (let i = 0; i < 240; i++) {
    const a = points[Math.floor(random() * points.length)];
    const b = points[Math.floor(random() * points.length)];
    const c3 = points[Math.floor(random() * points.length)];
    const n = ab.subVectors(b, a).clone().cross(ac.subVectors(c3, a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    if (n.y < 0) n.negate();
    const c = -n.dot(a);
    if (!plausible(n, c)) continue;
    const score = support(n, c) - tilt(n);
    if (!best || score > best.score) best = { plane: { n, c }, score };
  }
  if (!best || best.score < 0.18) return null;
  // Refit through the inliers' centroid along their least-spread direction (power iteration on the inverse spread).
  const inliers = points.filter((p) => near(best.plane.n, best.plane.c, p));
  const mid = inliers.reduce((s, p) => s.add(p), new Vector3()).divideScalar(inliers.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of inliers) {
    const dx = p.x - mid.x, dy = p.y - mid.y, dz = p.z - mid.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  // The normal is the covariance's smallest eigenvector: the largest of its inverse (adjugate), by power iteration.
  const adj = [
    [yy * zz - yz * yz, xz * yz - xy * zz, xy * yz - xz * yy],
    [xz * yz - xy * zz, xx * zz - xz * xz, xy * xz - xx * yz],
    [xy * yz - xz * yy, xy * xz - xx * yz, xx * yy - xy * xy],
  ];
  let v = best.plane.n.clone();
  for (let it = 0; it < 32; it++) {
    const w = new Vector3(adj[0][0] * v.x + adj[0][1] * v.y + adj[0][2] * v.z, adj[1][0] * v.x + adj[1][1] * v.y + adj[1][2] * v.z, adj[2][0] * v.x + adj[2][1] * v.y + adj[2][2] * v.z);
    if (w.lengthSq() < 1e-24) break;
    v = w.normalize();
  }
  if (v.y < 0) v.negate();
  const refit = { n: v, c: -v.dot(mid) };
  return plausible(refit.n, refit.c) && support(refit.n, refit.c) >= support(best.plane.n, best.plane.c) * 0.95 ? refit : best.plane;
}

/**
 * Where the photo was taken from, in meters: the lens MoGe measured, the floor found in its points (the camera's
 * height, tilt and roll), and the depth range of the measurement. A roll under 2° is noise on a level shot: kept, it
 * would tilt the horizon more and more as the camera orbits. With no floor in sight (a close-up, a plain backdrop) the
 * camera is taken as level.
 */
function levelPlace({ depth, fov, near, far }: Geometry, aspect: number): PlaceView {
  const ratio = far / near;
  const tanV = Math.tan(rad(fov / 2));
  const tanH = tanV * aspect;
  const point = (u: number, v: number) => {
    const d = sampleDepth(depth, u, v);
    return d < 1e-4 ? null : unproject(u, v, unitDepth(d, ratio) * near, tanV, tanH);
  };
  const lower: Vector3[] = [];
  for (let j = 0; j < 32; j++) {
    for (let i = 0; i < 48; i++) {
      const p = point(0.02 + (i / 47) * 0.96, 0.45 + (j / 31) * 0.53);
      if (p) lower.push(p);
    }
  }
  // The middle of the picture, for where the set's center sits when there's no floor to stand it on.
  const middle: number[] = [];
  for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) middle.push(-(point(0.4 + i * 0.033, 0.38 + j * 0.04)?.z ?? far));
  middle.sort((a, b) => a - b);
  const ahead = Math.max(near * 1.2, middle[Math.floor(middle.length / 2)]);

  const floor = floorPlane(lower);
  if (!floor) return { fov, height: 1.6, pitch: 0, roll: 0, pivot: ahead, near, far, floor: false };
  const { n, c } = floor;
  const pitch = deg(Math.asin(MathUtils.clamp(-n.z, -1, 1)));
  const roll = -deg(Math.atan2(n.x, n.y));
  // The set's center: the floor below the middle of the picture, as far away as what stands there.
  return { fov, height: c, pitch, roll: Math.abs(roll) < 2 ? 0 : roll, pivot: ahead, near, far, floor: true };
}

/** Until the depth map arrives: a level camera with the photo as a card six meters away. */
export function provisionalPlace(aspect: number): PlaceView {
  return { fov: photoFov(aspect), height: 1.6, pitch: 0, roll: 0, pivot: 6, near: 3, far: 40, floor: false };
}

/** What the camera orbits: where it is in the photo (0…1 from the top-left) and in the set. */
export type Orbit = { u: number; v: number; kind: "picked" | "subject" | "middle"; point: Vector3 };

/** The point you picked, else the main subject (when the matte found one), else the middle of the picture. */
export function orbitFor(place: PlaceView, depth: DepthMap | null, aspect: number, mask: SubjectMask | null, picked?: { u: number; v: number }): Orbit {
  if (!depth) {
    const photo = photoCamera(place);
    return { u: 0.5, v: 0.5, kind: "middle", point: photo.position.clone().addScaledVector(photo.forward, place.pivot) };
  }
  if (picked) return { ...picked, kind: "picked", point: surfacePoint(depth, place, aspect, picked.u, picked.v) };
  const subject = mask ? subjectAnchor(depth, mask, place, aspect) : null;
  if (subject) return { ...subject, kind: "subject" };
  return { u: 0.5, v: 0.5, kind: "middle", point: surfacePoint(depth, place, aspect, 0.5, 0.5) };
}

/** Where the photo was taken from, seen from the orbit point. */
export type AngleBase = {
  place: PlaceView;
  pivot: Vector3;
  radius: number;
  azimuth: number;
  elevation: number;
  /** The photo camera's aim (yaw, pitch, roll; "YXZ"). */
  aim: Euler;
};

export function angleBase(place: PlaceView, pivot: Vector3): AngleBase {
  const photo = photoCamera(place);
  const offset = photo.position.clone().sub(pivot);
  const radius = Math.max(0.05, offset.length());
  return {
    place,
    pivot,
    radius,
    azimuth: deg(Math.atan2(offset.x, offset.z)),
    elevation: deg(Math.asin(MathUtils.clamp(offset.y / radius, -1, 1))),
    aim: new Euler().setFromQuaternion(photo.quaternion, "YXZ"),
  };
}

export function resolveShot(base: AngleBase, view: AngleView): AngleShot {
  return {
    azimuth: wrapDegrees(view.azimuth),
    elevation: MathUtils.clamp(view.elevation ?? base.elevation, MIN_ELEVATION, MAX_ELEVATION),
    zoom: MathUtils.clamp(view.zoom, -1, 1),
  };
}

/**
 * The camera for a shot. The photo camera is carried around the orbit point rigidly, so at the
 * photo's own angle it is exactly the photo camera and the orbit point stays put in the frame.
 */
export function angleCamera(base: AngleBase, shot: AngleShot) {
  const az = rad(base.azimuth + shot.azimuth);
  const el = rad(shot.elevation);
  const distance = base.radius * zoomFactor(shot.zoom);
  const position = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(distance).add(base.pivot);
  const pitch = MathUtils.clamp(base.aim.x - rad(shot.elevation - base.elevation), rad(-89.9), rad(89.9));
  const quaternion = new Quaternion().setFromEuler(new Euler(pitch, base.aim.y + rad(shot.azimuth), base.aim.z, "YXZ"));
  return { position, quaternion, fov: base.place.fov, distance };
}

/** Everything the prompt says about the move, in degrees and meters. */
export type AngleFacts = {
  /** -180…180; positive = the camera went to its right. */
  azimuth: number;
  /** Camera height seen from the subject, before and after (degrees above level). */
  elevation: number;
  photoElevation: number;
  /** Where the camera points, before and after (degrees; negative = looking down). */
  pitch: number;
  photoPitch: number;
  /** Camera height above the ground in meters, when the photo shows the ground. */
  height: number | null;
  photoHeight: number | null;
  /** New distance to the subject over the original one. */
  distance: number;
  /** What the camera orbits. */
  orbit: Pick<Orbit, "u" | "v" | "kind">;
};

export function angleFacts(base: AngleBase, shot: AngleShot, orbit: Pick<Orbit, "u" | "v" | "kind">): AngleFacts {
  const cam = angleCamera(base, shot);
  const aim = new Euler().setFromQuaternion(cam.quaternion, "YXZ");
  return {
    azimuth: shot.azimuth,
    elevation: shot.elevation,
    photoElevation: base.elevation,
    pitch: deg(aim.x),
    photoPitch: deg(base.aim.x),
    height: base.place.floor ? cam.position.y : null,
    photoHeight: base.place.floor ? photoCamera(base.place).position.y : null,
    distance: zoomFactor(shot.zoom),
    orbit: { u: orbit.u, v: orbit.v, kind: orbit.kind },
  };
}
