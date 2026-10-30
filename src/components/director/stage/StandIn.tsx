"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeElements } from "@react-three/fiber";
import {
  CapsuleGeometry,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  type Group,
  LatheGeometry,
  Matrix4,
  type Mesh,
  Quaternion,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  type Texture,
  Vector2,
  Vector3,
} from "three";
import type { SceneElement } from "@/lib/director/types";
import { useDirector } from "@/lib/director/store";
import { ANKLE, BODIES, FOREARM, poseOf, SHIN, standInSize, THIGH, twoWheeled, UPPER_ARM, type Pose } from "@/lib/director/standin";
import { STANDIN, SUBJECT, VIEW_MODEL } from "./capture";
import { HELPER_LAYER } from "./post";

/**
 * A subject's stand-in on set: a plain figure with real 3D shape in its cast color. The image model sees these in
 * the blocking frame instead of photo cut-outs, so nothing flat or squashed reaches it: it gets where each subject
 * stands, how big it is in frame and which way it faces, and draws the subject itself from its own picture.
 *
 * Shapes are built at unit height (feet on the floor, facing +z) and scaled to the element.
 */

type Part = {
  geometry: BufferGeometry;
  position: Vector3;
  quaternion?: Quaternion;
  scale?: Vector3;
  /** A fixed color (wheels, lights), else the stand-in's own color, darkened by `shade` (0 = as is). */
  color?: string;
  shade?: number;
};

const Y = new Vector3(0, 1, 0);
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const sphere = new SphereGeometry(1, 24, 16);
const box = new BoxGeometry(1, 1, 1);
const wheel = new CylinderGeometry(1, 1, 1, 24).rotateZ(Math.PI / 2);
const capsules = new Map<string, CapsuleGeometry>();

/** A rounded limb from a to b. */
function limb(a: Vector3, b: Vector3, r: number): Part {
  const d = b.clone().sub(a);
  const length = Math.max(0.001, d.length() - 2 * r);
  const key = `${r.toFixed(3)}:${length.toFixed(3)}`;
  let geometry = capsules.get(key);
  if (!geometry) capsules.set(key, (geometry = new CapsuleGeometry(r, length, 4, 12)));
  return { geometry, position: a.clone().add(b).multiplyScalar(0.5), quaternion: new Quaternion().setFromUnitVectors(Y, d.normalize()) };
}

const ball = (c: Vector3, r: number, sx = 1, sy = 1, sz = 1): Part => ({ geometry: sphere, position: c, scale: v(r * sx, r * sy, r * sz) });
const block = (c: Vector3, w: number, h: number, d: number, extra: Partial<Part> = {}): Part => ({ geometry: box, position: c, scale: v(w, h, d), ...extra });

const X = new Vector3(1, 0, 0);
const lathes = new Map<string, LatheGeometry>();

/** A limb from a to b that swells and thins like a real one: its radius at points along it ([0 to 1, radius]), rounded ends. */
function taper(a: Vector3, b: Vector3, radii: [number, number][]): Part {
  const d = b.clone().sub(a);
  const length = Math.max(0.001, d.length());
  const key = `${radii.join(";")}@${length.toFixed(3)}`;
  let geometry = lathes.get(key);
  if (!geometry) {
    const arc = (r: number, y: number, from: number) =>
      Array.from({ length: 5 }, (_, i) => new Vector2(r * Math.cos(from + (i * Math.PI) / 8), y + r * Math.sin(from + (i * Math.PI) / 8)));
    const points = [...arc(radii[0][1], 0, -Math.PI / 2), ...radii.slice(1, -1).map(([t, r]) => new Vector2(r, t * length)), ...arc(radii[radii.length - 1][1], length, 0)];
    lathes.set(key, (geometry = new LatheGeometry(points, 16)));
  }
  return { geometry, position: a.clone(), quaternion: new Quaternion().setFromUnitVectors(Y, d.normalize()) };
}

/** A ring of a lofted part: at height y, its half-width, how far its front (+z) and back reach, how square it is (2: round). */
type Ring = { y: number; x: number; front: number; back: number; z?: number; n?: number };

/** A closed surface through rings, bottom to top: a torso is wider than deep, fuller at the chest and the seat. */
function loft(rings: Ring[], around = 28) {
  const position: number[] = [];
  const index: number[] = [];
  for (const ring of rings) {
    const e = 2 / (ring.n ?? 2);
    for (let i = 0; i < around; i++) {
      const c = Math.cos((i / around) * Math.PI * 2);
      const s = Math.sin((i / around) * Math.PI * 2);
      position.push(ring.x * Math.sign(c) * Math.abs(c) ** e, ring.y, (s >= 0 ? ring.front : ring.back) * Math.sign(s) * Math.abs(s) ** e + (ring.z ?? 0));
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < around; i++) {
      const a = r * around + i;
      const b = r * around + ((i + 1) % around);
      index.push(a, a + around, b, b, a + around, b + around);
    }
  }
  // Closed at both ends.
  const bottom = position.length / 3;
  const top = (rings.length - 1) * around;
  position.push(0, rings[0].y, rings[0].z ?? 0, 0, rings[rings.length - 1].y, rings[rings.length - 1].z ?? 0);
  for (let i = 0; i < around; i++) index.push(bottom, i, (i + 1) % around, bottom + 1, top + ((i + 1) % around), top + i);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/*
 * A person at unit height, built like a real adult so image and pose models read a body, not sticks: a torso fuller at
 * the chest and the seat than at the waist, shoulders sloping into a neck, a head with a jaw, chin, nose and ears,
 * limbs that swell and thin, kneecaps in front and calves behind, hands with a thumb, and shoes flat on the floor.
 * (Capsule arms and ball hands came back as cylinder hands.) Lengths in body heights, from adult averages.
 */
const THIGH_SHAPE: [number, number][] = [[0, 0.06], [0.15, 0.058], [0.45, 0.051], [0.8, 0.041], [1, 0.037]];
const SHIN_SHAPE: [number, number][] = [[0, 0.035], [0.2, 0.033], [0.45, 0.029], [0.75, 0.023], [1, 0.02]];
const UPPER_ARM_SHAPE: [number, number][] = [[0, 0.033], [0.35, 0.03], [0.6, 0.029], [0.88, 0.025], [1, 0.024]];
const FOREARM_SHAPE: [number, number][] = [[0, 0.024], [0.2, 0.026], [0.5, 0.022], [0.85, 0.017], [1, 0.016]];

/** Crotch to neck: the seat behind the hips, the waist, the chest, shoulders sloping up into the neck. */
const TORSO: Ring[] = [
  { y: 0.455, x: 0.05, front: 0.03, back: 0.04 },
  { y: 0.475, x: 0.085, front: 0.048, back: 0.062 },
  { y: 0.5, x: 0.098, front: 0.054, back: 0.074 },
  { y: 0.53, x: 0.1, front: 0.056, back: 0.076 },
  { y: 0.565, x: 0.096, front: 0.055, back: 0.066 },
  { y: 0.6, x: 0.088, front: 0.055, back: 0.056 },
  { y: 0.63, x: 0.083, front: 0.056, back: 0.052 },
  { y: 0.665, x: 0.087, front: 0.06, back: 0.054 },
  { y: 0.705, x: 0.096, front: 0.067, back: 0.059, n: 2.4 },
  { y: 0.745, x: 0.103, front: 0.068, back: 0.062, n: 2.5 },
  { y: 0.78, x: 0.104, front: 0.06, back: 0.06, n: 2.6 },
  { y: 0.8, x: 0.096, front: 0.048, back: 0.052, n: 2.6 },
  { y: 0.818, x: 0.072, front: 0.04, back: 0.046, n: 2.4 },
  { y: 0.836, x: 0.045, front: 0.033, back: 0.038 },
  { y: 0.846, x: 0.036, front: 0.03, back: 0.034 },
];
let torsoGeometry: BufferGeometry | null = null;

/** Chin to crown: the jaw narrowing to the chin in front, the back of the skull fuller than the face. */
const HEAD: Ring[] = [
  { y: 0.866, x: 0.012, front: 0.012, back: 0.004, z: 0.03 },
  { y: 0.872, x: 0.022, front: 0.016, back: 0.02, z: 0.025 },
  { y: 0.885, x: 0.034, front: 0.021, back: 0.035, z: 0.018 },
  { y: 0.9, x: 0.039, front: 0.034, back: 0.045, z: 0.012 },
  { y: 0.915, x: 0.04, front: 0.042, back: 0.052, z: 0.006 },
  { y: 0.932, x: 0.042, front: 0.047, back: 0.058, z: 0.002 },
  { y: 0.95, x: 0.044, front: 0.05, back: 0.06 },
  { y: 0.968, x: 0.043, front: 0.046, back: 0.058, z: -0.003 },
  { y: 0.984, x: 0.036, front: 0.036, back: 0.047, z: -0.006 },
  { y: 0.995, x: 0.022, front: 0.02, back: 0.028, z: -0.008 },
  { y: 1, x: 0.006, front: 0.005, back: 0.008, z: -0.008 },
];
let headGeometry: BufferGeometry | null = null;

/** A shoe at its ankle joint, toes along +z: along the foot, its half-width, its top and its bottom (cut flat at the sole). */
const SHOE: [number, number, number, number][] = [
  [-0.043, 0.01, -0.014, -0.04],
  [-0.037, 0.021, 0, -0.05],
  [-0.022, 0.027, 0.02, -0.05],
  [-0.005, 0.029, 0.03, -0.05],
  [0.015, 0.03, 0.022, -0.05],
  [0.04, 0.031, 0.006, -0.05],
  [0.065, 0.032, -0.008, -0.05],
  [0.09, 0.03, -0.017, -0.05],
  [0.108, 0.024, -0.022, -0.05],
  [0.12, 0.011, -0.027, -0.047],
];
let shoeGeometry: BufferGeometry | null = null;
function shoe() {
  if (shoeGeometry) return shoeGeometry;
  // Lofted along the foot, then turned so the foot runs along +z with each ring's back side up.
  const g = loft(SHOE.map(([along, x, top, bottom]) => ({ y: along, x, front: (top - bottom) / 2, back: (top - bottom) / 2, z: -(top + bottom) / 2 })), 20).rotateX(Math.PI / 2);
  // A flat sole: the shoe stands on the floor instead of touching it at a point.
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) p.setY(i, Math.max(-ANKLE, p.getY(i)));
  g.computeVertexNormals();
  return (shoeGeometry = g);
}

/** A hand at the wrist, along the forearm: a palm, the fingers together and curled a little toward it, and a thumb. */
function hand(wrist: Vector3, along: Vector3, s: number, palm: "in" | "down" = "in"): Part[] {
  const y = along.clone().normalize();
  // The palm faces the body, or down onto the lap.
  const x = palm === "down" ? v(0, -1, 0) : v(-s, 0, 0);
  x.addScaledVector(y, -x.dot(y));
  if (x.lengthSq() < 1e-4) x.set(0, 0, 1).addScaledVector(y, -y.z);
  x.normalize();
  const z = x.clone().cross(y);
  // The thumb on the side toward the front and the body (on top, for a fist held forward).
  const thumb = z.dot(v(-0.5 * s, 0.5, 1)) >= 0 ? 1 : -1;
  const turn = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
  const at = (lx: number, ly: number, lz: number) => v(lx, ly, lz).applyQuaternion(turn).add(wrist);
  return [
    { ...ball(at(0, 0.032, 0), 1, 0.011, 0.034, 0.025), quaternion: turn },
    { ...ball(at(0.008, 0.084, 0), 1, 0.01, 0.028, 0.023), quaternion: turn.clone().multiply(new Quaternion().setFromAxisAngle(v(0, 0, 1), -0.3)) },
    taper(at(0.004, 0.012, 0.018 * thumb), at(0.013, 0.056, 0.027 * thumb), [[0, 0.0095], [1, 0.007]]),
  ];
}

/** The lowest point of the parts as placed. */
function lowest(parts: Part[]) {
  let min = Infinity;
  const p = new Vector3();
  for (const part of parts) {
    const pos = part.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      if (part.scale) p.multiply(part.scale);
      if (part.quaternion) p.applyQuaternion(part.quaternion);
      min = Math.min(min, p.y + part.position.y);
    }
  }
  return min;
}

const people = new Map<Pose, Part[]>();

/** A person posed, at unit height, facing +z, set down so their lowest point (a sole, a knee, their back) is on the floor. */
function personParts(pose: Pose): Part[] {
  const known = people.get(pose);
  if (known) return known;
  const body = BODIES[pose];
  const parts: Part[] = [];
  body.legs.forEach((leg, i) => {
    const s = i ? 1 : -1;
    const out = Math.sin((leg.out ?? 0) * s);
    const hip = v(0.055 * s, 0.5, 0);
    const thigh = v(out, -Math.cos(leg.hip), Math.sin(leg.hip)).normalize();
    const knee = hip.clone().addScaledVector(thigh, THIGH);
    const bend = leg.hip - leg.knee;
    const shin = v(out, -Math.cos(bend), Math.sin(bend)).normalize();
    const ankle = knee.clone().addScaledVector(shin, SHIN);
    parts.push(
      taper(hip, knee, THIGH_SHAPE),
      taper(knee, ankle, SHIN_SHAPE),
      // The kneecap in front and the calf's swell behind: which way a leg faces.
      ball(knee.clone().add(v(0, Math.sin(leg.hip), Math.cos(leg.hip)).multiplyScalar(0.02)), 0.021),
      {
        ...ball(knee.clone().addScaledVector(shin, 0.08).add(v(0, Math.sin(bend), Math.cos(bend)).multiplyScalar(-0.011)), 1, 0.03, 0.06, 0.029),
        quaternion: new Quaternion().setFromUnitVectors(Y, shin),
      },
      { geometry: shoe(), position: ankle.clone(), quaternion: new Quaternion().setFromEuler(new Euler(leg.foot, 0.1 * s, 0, "YXZ")) },
    );
  });
  // The upper body, built standing and then leaned forward or back from the hips.
  const upper: Part[] = [
    { geometry: (torsoGeometry ??= loft(TORSO)), position: v(0, 0, 0) },
    taper(v(0, 0.818, -0.012), v(0, 0.9, 0.002), [[0, 0.036], [0.5, 0.032], [1, 0.032]]),
    { geometry: (headGeometry ??= loft(HEAD)), position: v(0, 0, 0) },
    // A nose standing out most at its tip, and flat ears: which way the face looks.
    { ...ball(v(0, 0.922, 0.049), 1, 0.0065, 0.014, 0.009), quaternion: new Quaternion().setFromAxisAngle(X, -0.35) },
    ...[-1, 1].map((s) => ball(v(0.042 * s, 0.93, -0.006), 1, 0.006, 0.016, 0.011)),
  ];
  body.arms.forEach((arm, i) => {
    const s = i ? 1 : -1;
    const shoulder = v(0.097 * s, 0.775, 0);
    const d1 = v(s * Math.sin(arm.out), -Math.cos(arm.swing) * Math.cos(arm.out), Math.sin(arm.swing) * Math.cos(arm.out)).normalize();
    const elbow = shoulder.clone().addScaledVector(d1, UPPER_ARM);
    // The elbow bends the forearm forward, in the plane of the upper arm and the way the body faces.
    const ahead = v(0, 0, 1).addScaledVector(d1, -d1.z);
    if (ahead.lengthSq() < 1e-4) ahead.set(0, 1, 0);
    ahead.normalize();
    const d2 = d1.clone().multiplyScalar(Math.cos(arm.elbow)).addScaledVector(ahead, Math.sin(arm.elbow));
    const wrist = elbow.clone().addScaledVector(d2, FOREARM);
    upper.push(ball(v(0.097 * s, 0.772, 0), 1, 0.034, 0.036, 0.039), taper(shoulder, elbow, UPPER_ARM_SHAPE), taper(elbow, wrist, FOREARM_SHAPE), ...hand(wrist, d2, s, arm.palm));
  });
  const lean = new Quaternion().setFromAxisAngle(X, body.lean);
  const pivot = v(0, 0.5, 0);
  for (const p of upper) {
    p.position = p.position.clone().sub(pivot).applyQuaternion(lean).add(pivot);
    p.quaternion = lean.clone().multiply(p.quaternion ?? new Quaternion());
  }
  parts.push(...upper);
  if (pose === "lying") {
    // On their back along the way they face, the body centered on their spot.
    const down = new Quaternion().setFromAxisAngle(X, -Math.PI / 2);
    for (const p of parts) {
      p.position = p.position.clone().applyQuaternion(down).add(v(0, 0, 0.5));
      p.quaternion = down.clone().multiply(p.quaternion ?? new Quaternion());
    }
  }
  const floor = lowest(parts);
  for (const p of parts) p.position = p.position.clone().setY(p.position.y - floor);
  people.set(pose, parts);
  return parts;
}

function animalParts(pose: Pose): Part[] {
  if (pose === "lying") {
    return [
      ball(v(0, 0.2, 0), 1, 0.2, 0.17, 0.42),
      limb(v(-0.09, 0.05, 0.25), v(-0.09, 0.05, 0.52), 0.05),
      limb(v(0.09, 0.05, 0.25), v(0.09, 0.05, 0.52), 0.05),
      ball(v(-0.14, 0.12, -0.2), 0.11),
      ball(v(0.14, 0.12, -0.2), 0.11),
      limb(v(0, 0.28, 0.33), v(0, 0.42, 0.45), 0.08),
      ball(v(0, 0.48, 0.5), 0.13),
      limb(v(0, 0.45, 0.56), v(0, 0.42, 0.7), 0.06),
      ball(v(-0.07, 0.59, 0.48), 0.04),
      ball(v(0.07, 0.59, 0.48), 0.04),
      limb(v(0, 0.22, -0.42), v(0, 0.08, -0.62), 0.03),
    ];
  }
  if (pose === "sitting") {
    const body = ball(v(0, 0.45, -0.04), 1, 0.2, 0.2, 0.34);
    body.quaternion = new Quaternion().setFromAxisAngle(v(1, 0, 0), -0.6);
    return [
      body,
      limb(v(-0.1, 0.5, 0.18), v(-0.1, 0.03, 0.24), 0.05),
      limb(v(0.1, 0.5, 0.18), v(0.1, 0.03, 0.24), 0.05),
      ball(v(-0.14, 0.13, -0.16), 0.12),
      ball(v(0.14, 0.13, -0.16), 0.12),
      limb(v(0, 0.62, 0.2), v(0, 0.84, 0.3), 0.08),
      ball(v(0, 0.9, 0.34), 0.13),
      limb(v(0, 0.87, 0.4), v(0, 0.84, 0.55), 0.06),
      ball(v(-0.07, 1.0, 0.32), 0.04),
      ball(v(0.07, 1.0, 0.32), 0.04),
      limb(v(0, 0.12, -0.3), v(0, 0.04, -0.52), 0.03),
    ];
  }
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => limb(v(0.11 * sx, 0.5, 0.27 * sz), v(0.11 * sx, 0.03, 0.29 * sz), 0.055)));
  return [
    ball(v(0, 0.55, 0), 1, 0.2, 0.2, 0.42),
    ...legs,
    limb(v(0, 0.62, 0.33), v(0, 0.82, 0.47), 0.08),
    ball(v(0, 0.86, 0.52), 0.13),
    limb(v(0, 0.83, 0.58), v(0, 0.8, 0.74), 0.06),
    ball(v(-0.07, 0.97, 0.5), 0.04),
    ball(v(0.07, 0.97, 0.5), 0.04),
    limb(v(0, 0.62, -0.4), v(0, 0.8, -0.55), 0.03),
  ];
}

/** A car's side, drawn as (along, up) points at unit height and length 3, front at +along; extruded across its width. */
const BODY: [number, number][] = [[1.5, 0.2], [1.5, 0.5], [1.4, 0.6], [0.6, 0.68], [-1.2, 0.72], [-1.5, 0.66], [-1.5, 0.22], [-1.36, 0.14], [1.36, 0.14]];
const CABIN: [number, number][] = [[0.62, 0.66], [0.06, 0.98], [-0.72, 0.98], [-1.2, 0.7]];
const profiles = new Map<string, BufferGeometry>();

function profile(points: [number, number][], length: number, width: number) {
  const key = `${points.length}:${length.toFixed(3)}:${width.toFixed(3)}`;
  let geometry = profiles.get(key);
  if (geometry) return geometry;
  const k = length / 3;
  const shape = new Shape(points.map(([z, y]) => new Vector2(z * k, y)));
  const bevel = 0.035;
  geometry = new ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 4 })
    // The shape's x runs along the car (+z is its front), the extrusion across it.
    .rotateY(-Math.PI / 2)
    .translate(width / 2 - bevel, 0, 0);
  profiles.set(key, geometry);
  return geometry;
}

/** A car at unit height: its side profile in the cast color, a dark glass cabin, black wheels, white headlights at the front (+z). */
function vehicleParts(length: number, width: number): Part[] {
  const r = 0.25;
  const wheels = [-1, 1].flatMap((sx) =>
    [-1, 1].flatMap((sz): Part[] => {
      const at = v((width / 2 - 0.06) * sx, r, (length / 3) * 1.02 * sz);
      return [
        { geometry: wheel, position: at, scale: v(0.22, r, r), color: "#1b1b1e" },
        { geometry: wheel, position: at.clone().add(v(0.012 * sx, 0, 0)), scale: v(0.22, r * 0.5, r * 0.5), color: "#77777d" },
      ];
    }),
  );
  return [
    ...wheels,
    { geometry: profile(BODY, length, width), position: v(0, 0, 0) },
    { geometry: profile(CABIN, length, width * 0.86), position: v(0, 0, 0), shade: 0.62 },
    ...[-1, 1].map((sx) => block(v(sx * width * 0.32, 0.5, (length / 3) * 1.5 + 0.05), width * 0.22, 0.06, 0.03, { color: "#f6f6f0" })),
    ...[-1, 1].map((sx) => block(v(sx * width * 0.33, 0.56, -(length / 3) * 1.5 - 0.05), width * 0.2, 0.06, 0.03, { color: "#7a1010" })),
  ];
}

/**
 * A motorbike, scooter or bicycle at unit height (the handlebars' top): two wheels along it, the body and tank between
 * them in the cast color, a dark seat, the bars across, a white headlight at the front (+z) and a red one at the back.
 */
function bikeParts(length: number, width: number): Part[] {
  const r = 0.3;
  const reach = length / 2 - r;
  const wheels = [-1, 1].flatMap((sz): Part[] => [
    { geometry: wheel, position: v(0, r, reach * sz), scale: v(0.12, r, r), color: "#1b1b1e" },
    { geometry: wheel, position: v(0, r, reach * sz), scale: v(0.14, r * 0.42, r * 0.42), color: "#77777d" },
  ]);
  return [
    ...wheels,
    block(v(0, 0.5, 0), width * 0.42, 0.32, length * 0.48),
    block(v(0, 0.76, reach * 0.35), width * 0.46, 0.16, length * 0.24),
    block(v(0, 0.74, -reach * 0.45), width * 0.4, 0.08, length * 0.34, { shade: 0.55 }),
    block(v(0, 0.66, reach * 0.88), 0.07, 0.62, 0.07, { color: "#5a5a60" }),
    block(v(0, 0.97, reach * 0.82), width * 0.95, 0.05, 0.05, { color: "#2a2a2e" }),
    block(v(0, 0.86, reach + 0.04), width * 0.24, 0.1, 0.04, { color: "#f6f6f0" }),
    block(v(0, 0.72, -length / 2 + 0.04), width * 0.22, 0.05, 0.03, { color: "#7a1010" }),
  ];
}

/** A product or object: a block of its size, with a lighter panel where its front (its label) is. */
function blockParts(width: number, depth: number): Part[] {
  return [block(v(0, 0.5, 0), width, 1, depth), block(v(0, 0.55, depth / 2 + 0.002), width * 0.62, 0.42, 0.004, { shade: -0.45 })];
}

const vertex = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform vec3 color;
  uniform vec3 lightDir;
  uniform vec3 lightColor;
  uniform float key;
  varying vec3 vNormal;
  void main() {
    float lambert = max(dot(normalize(vNormal), lightDir), 0.0);
    // Flat enough to read as one color, shaded enough to read as a 3D form lit from the key's side.
    gl_FragColor = vec4(color * (0.5 + key * lambert * lightColor * 0.95 + (1.0 - key) * 0.35), 1.0);
  }
`;

function material(hex: string, shade = 0) {
  const c = new Color(hex);
  if (shade > 0) c.lerp(new Color(0, 0, 0), shade);
  else if (shade < 0) c.lerp(new Color(1, 1, 1), -shade);
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { color: { value: c }, lightDir: { value: new Vector3(0, 1, 0) }, lightColor: { value: new Color(1, 1, 1) }, key: { value: 0.5 } },
  });
}

type Light = { dir: Vector3; color: Color; softness: number };
type Handlers = Pick<ThreeElements["mesh"], "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerOver" | "onPointerOut" | "onDoubleClick">;

export function StandIn({ el, color, light, visible, handlers }: { el: SceneElement; color: string; light: Light; visible: boolean; handlers: Handlers }) {
  // The shot’s words pose their arms too ("Lena is taking a selfie"): standin poseOf.
  const notes = useDirector((st) => st.scene.notes);
  const pose = poseOf(el, notes);
  const size = standInSize(el);
  const { parts, scale } = useMemo(() => {
    const scale = v(size.height, size.height, size.height);
    if (el.kind === "person") return { parts: personParts(pose), scale };
    if (el.kind === "animal") return { parts: animalParts(pose), scale };
    if (el.kind === "vehicle") return { parts: (twoWheeled(el) ? bikeParts : vehicleParts)(size.length / size.height, size.width / size.height), scale };
    return { parts: blockParts(size.width / size.height, size.length / size.height), scale };
  }, [el.kind, el.name, pose, size.height, size.width, size.length]);

  const materials = useMemo(() => parts.map((p) => material(p.color ?? color, p.color ? 0 : (p.shade ?? 0))), [parts, color]);
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  // Uniforms change in place through the meshes (three.js materials are mutable, React state isn't).
  const group = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    group.current?.traverse((o) => {
      const u = ((o as Mesh).material as ShaderMaterial | undefined)?.uniforms;
      if (!u?.key) return;
      u.lightDir.value.copy(light.dir);
      u.lightColor.value.copy(light.color);
      u.key.value = 0.62 * (1 - light.softness * 0.5);
    });
    invalidate();
  }, [materials, light.dir, light.color, light.softness, invalidate]);

  return (
    <group ref={group} visible={visible} userData={{ [VIEW_MODEL]: true, [STANDIN]: el.id }} scale={scale}>
      {parts.map((p, i) => (
        <mesh
          key={i}
          geometry={p.geometry}
          material={materials[i]}
          position={p.position}
          quaternion={p.quaternion}
          scale={p.scale}
          castShadow
          userData={{ [SUBJECT]: true }}
          {...handlers}
        />
      ))}
    </group>
  );
}

const photoVertex = /* glsl */ `
  uniform mat4 toBody;
  varying vec3 vBody;
  varying vec3 vBodyNormal;
  varying vec3 vNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vBody = (toBody * world).xyz;
    // Nudged off zero: a sphere's poles have none, and a zero normal came out as black dots on the shoulders.
    vNormal = normalize(mat3(modelMatrix) * normal + vec3(0.0, 1e-4, 0.0));
    vBodyNormal = normalize(mat3(toBody) * vNormal + vec3(0.0, 1e-4, 0.0));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const photoFragment = /* glsl */ `
  uniform sampler2D front;
  uniform sampler2D back;
  uniform float frontAspect;
  uniform float backAspect;
  uniform float hasFront;
  uniform float hasBack;
  uniform vec3 base;
  uniform vec3 lightDir;
  varying vec3 vBody;
  varying vec3 vBodyNormal;
  varying vec3 vNormal;
  // A picture laid on the body straight from its side: feet to head over its height, centered across.
  vec4 laid(sampler2D map, float aspect, float side) {
    vec2 uv = vec2(0.5 + side * vBody.x / aspect, vBody.y);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture2D(map, uv);
  }
  void main() {
    vec4 f = hasFront > 0.5 ? laid(front, frontAspect, 1.0) : vec4(0.0);
    vec4 b = hasBack > 0.5 ? laid(back, backAspect, -1.0) : vec4(0.0);
    // Front where the body faces forward, back behind, blended round the sides; the bare body where neither shows.
    float w = smoothstep(-0.3, 0.3, vBodyNormal.z);
    vec3 bare = mix(base * 0.55, base, w);
    vec3 col = mix(mix(bare, b.rgb, b.a * (1.0 - w)), f.rgb, f.a * w);
    float lambert = 0.7 + 0.3 * max(dot(normalize(vNormal), normalize(lightDir)), 0.0);
    gl_FragColor = vec4(col * lambert, 1.0);
  }
`;

/**
 * The stand-in's body wearing the subject's own pictures, the front one on its front and the back one on its back:
 * shown while it's moved or turned, so which way it faces is plain (alone, its drawing jumped from side to side every
 * 90 degrees: the user). In the live view only (the helper layer), never in a shot.
 */
export function PhotoBody({
  el,
  front,
  back,
  light,
  onShown,
}: {
  el: SceneElement;
  front: { texture: Texture; aspect: number } | null;
  back: { texture: Texture; aspect: number } | null;
  light: Light;
  /** Told when it's on screen and when it's gone (its drawing stays until then). */
  onShown?: (shown: boolean) => void;
}) {
  useEffect(() => {
    onShown?.(true);
    return () => onShown?.(false);
  }, [onShown]);
  // The shot’s words pose their arms too ("Lena is taking a selfie"): standin poseOf.
  const notes = useDirector((st) => st.scene.notes);
  const pose = poseOf(el, notes);
  const size = standInSize(el);
  const { parts, scale } = useMemo(() => {
    const scale = v(size.height, size.height, size.height);
    if (el.kind === "person") return { parts: personParts(pose), scale };
    if (el.kind === "animal") return { parts: animalParts(pose), scale };
    if (el.kind === "vehicle") return { parts: (twoWheeled(el) ? bikeParts : vehicleParts)(size.length / size.height, size.width / size.height), scale };
    return { parts: blockParts(size.width / size.height, size.length / size.height), scale };
  }, [el.kind, el.name, pose, size.height, size.width, size.length]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: photoVertex,
        fragmentShader: photoFragment,
        uniforms: {
          front: { value: front?.texture ?? null },
          back: { value: back?.texture ?? null },
          frontAspect: { value: front?.aspect ?? 0.4 },
          backAspect: { value: back?.aspect ?? 0.4 },
          hasFront: { value: front ? 1 : 0 },
          hasBack: { value: back ? 1 : 0 },
          base: { value: new Color("#9a9ca3").convertSRGBToLinear() },
          lightDir: { value: new Vector3(0, 1, 0) },
          toBody: { value: new Matrix4() },
        },
      }),
    [front, back],
  );
  useEffect(() => () => material.dispose(), [material]);
  const group = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    // Live view only: the helper layer, which shots don't render.
    group.current?.traverse((o) => o.layers.set(HELPER_LAYER));
    material.uniforms.lightDir.value.copy(light.dir);
    invalidate();
  }, [material, light.dir, parts, invalidate]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    // Its own place in the world, up to date (on its first frame it wasn't yet, and the body rendered black).
    g.updateWorldMatrix(true, false);
    material.uniforms.toBody.value.copy(g.matrixWorld).invert();
  });
  return (
    <group ref={group} scale={scale}>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={material} position={p.position} quaternion={p.quaternion} scale={p.scale} />
      ))}
    </group>
  );
}
