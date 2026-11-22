/**
 * The shot's timeline (Director v2): keys for the camera and for each element over the length of a shot, and what any
 * frame between them looks like. Pure maths (no React, no three.js), so the stage, the store, a renderer and a test all
 * read a frame the same way.
 *
 * A fresh set is a still: it has no timeline. The first key gives the shot DEFAULT_LENGTH frames. Frames run from 0 to
 * `length` (the last frame is the end of the shot) at `fps`. Keys sit on whole frames, sorted, one per frame per lane.
 * Between two keys a lane moves the way the earlier key's ease says. The easing maths follows comfyui_pano_suite's
 * scene_eval.py (MIT): CSS-style cubic-bezier solved by bisection, and a "smooth" curve through the keys whose speeds are
 * limited the Fritsch–Carlson way, so it never overshoots a key or turns back between two.
 */
import type { CameraRig, Pose, Scene, SceneElement } from "./types";

/** How a lane gets from one key to the next. A stretch between two keys moves the way its first key says. */
export type Ease = "ease" | "smooth" | "linear" | "hold" | "in" | "out";

export type CameraKey = {
  /** Frame. */
  t: number;
  cam: Pick<CameraRig, "azimuth" | "elevation" | "distance" | "focal" | "roll" | "focusHeight" | "focusId" | "free" | "aperture">;
  ease: Ease;
};
export type CameraValue = CameraKey["cam"];

export type ElementKey = { t: number; v: Pick<SceneElement, "x" | "z" | "yaw" | "lift"> & { pose?: Pose }; ease: Ease };
export type ElementValue = ElementKey["v"];

export type Timeline = {
  fps: number;
  /** The shot's length in frames: it runs from frame 0 to frame `length`. */
  length: number;
  camera: CameraKey[];
  /** Keys per element id. An element without keys has no entry. */
  elements: Record<string, ElementKey[]>;
};

/** Keys picked in the timeline: frames per lane. */
export type KeySelection = { camera?: readonly number[]; elements?: Readonly<Record<string, readonly number[]>> };

export const DEFAULT_FPS = 24;
/** 5 s: what the first key gives a still. */
export const DEFAULT_LENGTH = 120;
export const DEFAULT_EASE: Ease = "ease";
/** How short and how long a shot can be, seconds. */
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 20;
const MIN_FPS = 1;
const MAX_FPS = 120;

/** The eases in the order the timeline offers them, with their names on screen. */
export const EASES: readonly { id: Ease; label: string; plain: string }[] = [
  { id: "ease", label: "Ease", plain: "Starts and stops gently at each key (the default)" },
  { id: "smooth", label: "Smooth", plain: "Flows through the keys without stopping at them" },
  { id: "linear", label: "Linear", plain: "One steady speed from key to key" },
  { id: "hold", label: "Cut", plain: "Stays as this key is, then jumps to the next one: a cut" },
  { id: "in", label: "In", plain: "Starts slowly and speeds up into the next key" },
  { id: "out", label: "Out", plain: "Leaves at full speed and slows into the next key" },
];
const EASE_IDS = new Set<string>(EASES.map((e) => e.id));

/* ---------------------------------------------------------------- time ---------------------------------------------- */

export const framesToSeconds = (frame: number, fps: number) => frame / Math.max(1, fps);
export const secondsToFrames = (seconds: number, fps: number) => Math.round(seconds * Math.max(1, fps));

/** "MM:SS.FF", minutes, seconds and the frame within the second, like an editor's timecode: frame 58 at 24 fps is "00:02.10". */
export function timecode(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps) || 1);
  const f = Math.max(0, Math.round(frame) || 0);
  const secs = Math.floor(f / rate);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}.${pad(f % rate)}`;
}

/** A whole frame inside the shot (0…length). */
export function clampFrame(tl: Pick<Timeline, "length">, frame: number) {
  const f = Math.round(frame);
  return Number.isFinite(f) ? Math.min(Math.max(0, tl.length), Math.max(0, f)) : 0;
}

/* ------------------------------------------------------------- shape and guards ------------------------------------- */

export function emptyTimeline(length = DEFAULT_LENGTH, fps = DEFAULT_FPS): Timeline {
  return { fps, length, camera: [], elements: {} };
}

/** Whether anything is keyed: a timeline without keys is still a still. */
export function hasKeys(tl: Timeline | null | undefined): tl is Timeline {
  if (!tl) return false;
  if (tl.camera.length) return true;
  for (const id in tl.elements) if (tl.elements[id]?.length) return true;
  return false;
}

/** Every frame that has a key in any lane, sorted. */
export function allKeyTimes(tl: Timeline | null | undefined): number[] {
  if (!tl) return [];
  const times = new Set<number>(tl.camera.map((k) => k.t));
  for (const id in tl.elements) for (const k of tl.elements[id]) times.add(k.t);
  return [...times].sort((a, b) => a - b);
}

/**
 * The timeline within its limits: fps and length in range (1 to 20 s), and keys past the end pulled onto the last frame,
 * the latest winning there, so a shortened shot still ends where it ended. The same object when nothing was out.
 */
export function withinLength(tl: Timeline): Timeline {
  const fps = clampInt(tl.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const length = clampInt(tl.length, MIN_SECONDS * fps, MAX_SECONDS * fps, Math.min(DEFAULT_LENGTH, MAX_SECONDS * fps));
  const camera = pullIn(tl.camera, length);
  let changed = false;
  const elements: Record<string, ElementKey[]> = {};
  for (const id in tl.elements) {
    const keys = pullIn(tl.elements[id], length);
    if (keys !== tl.elements[id]) changed = true;
    if (keys.length) elements[id] = keys;
    else changed = true;
  }
  if (fps === tl.fps && length === tl.length && camera === tl.camera && !changed) return tl;
  return { ...tl, fps, length, camera, elements: changed ? elements : tl.elements };
}

/** The same shot at another frame rate: keys and length keep their seconds. */
export function withFps(tl: Timeline, fps: number): Timeline {
  const f = clampInt(fps, MIN_FPS, MAX_FPS, tl.fps);
  if (f === tl.fps) return tl;
  const r = f / tl.fps;
  const re = <K extends Keyed>(keys: K[]) => dedupe(keys.map((k) => ({ ...k, t: Math.round(k.t * r) })));
  const elements: Record<string, ElementKey[]> = {};
  for (const id in tl.elements) elements[id] = re(tl.elements[id]);
  return withinLength({ fps: f, length: Math.round(tl.length * r), camera: re(tl.camera), elements });
}

/**
 * A timeline read back from storage or an old take, made safe: broken keys dropped, frames whole, keys sorted and one
 * per frame, lanes of elements that aren't on the set (`ids`, when given) gone. Undefined when it isn't a timeline.
 */
export function cleanTimeline(raw: unknown, ids?: readonly string[]): Timeline | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const fps = clampInt(o.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const length = clampInt(o.length, MIN_SECONDS * fps, MAX_SECONDS * fps, DEFAULT_LENGTH);
  const keys = <K extends Keyed>(list: unknown, value: (k: Record<string, unknown>) => Omit<K, "t" | "ease"> | null): K[] => {
    if (!Array.isArray(list)) return [];
    const out: K[] = [];
    for (const k of list) {
      if (!k || typeof k !== "object") continue;
      const r = k as Record<string, unknown>;
      if (!isNum(r.t)) continue;
      const v = value(r);
      if (!v) continue;
      out.push({ ...v, t: Math.max(0, Math.round(r.t)), ease: typeof r.ease === "string" && EASE_IDS.has(r.ease) ? (r.ease as Ease) : DEFAULT_EASE } as K);
    }
    return dedupe(out.sort(byT));
  };
  const camera = keys<CameraKey>(o.camera, (k) => {
    const cam = cleanCamera(k.cam);
    return cam ? { cam } : null;
  });
  const elements: Record<string, ElementKey[]> = {};
  const lanes = o.elements && typeof o.elements === "object" ? (o.elements as Record<string, unknown>) : {};
  const known = ids ? new Set(ids) : null;
  for (const id in lanes) {
    if (known && !known.has(id)) continue;
    const list = keys<ElementKey>(lanes[id], (k) => {
      const v = cleanElement(k.v);
      return v ? { v } : null;
    });
    if (list.length) elements[id] = list;
  }
  return withinLength({ fps, length, camera, elements });
}

/* ---------------------------------------------------------------- easing -------------------------------------------- */

const BEZIERS = { ease: [0.42, 0, 0.58, 1], in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1] } as const;

/** One coordinate of a cubic Bézier from 0 to 1 with inner control values `a` and `b`, at `s`. */
function bez(a: number, b: number, s: number) {
  const r = 1 - s;
  return 3 * r * r * s * a + 3 * r * s * s * b + s * s * s;
}

/**
 * CSS cubic-bezier(x1, y1, x2, y2) at time `u` (0…1). x(s) only climbs because x1 and x2 are within 0…1, so halving
 * the interval finds the s for `u` on any curve, flat or steep, where Newton's method can stall.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number) {
  if (!(u > 0)) return 0;
  if (u >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/** How far along a stretch is (0…1) at `u` of its time. "smooth" has its own curve (see `between`); here it is even. */
export function easeProgress(ease: Ease, u: number) {
  const x = Math.min(1, Math.max(0, u));
  if (ease === "hold") return x >= 1 ? 1 : 0;
  if (ease === "linear" || ease === "smooth") return x;
  const [a, b, c, d] = BEZIERS[ease] ?? BEZIERS.ease;
  return cubicBezier(a, b, c, d, x);
}

type Keyed = { t: number; ease: Ease };
type Kind = "lin" | "log" | "ang";

/** The short way round from angle `a` to angle `b`, degrees (-180…180). */
function turn(a: number, b: number) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Cubic Hermite from p0 to p1 with end slopes m0, m1 (already times the stretch's length), at s (0…1). */
function hermite(p0: number, p1: number, m0: number, m1: number, s: number) {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (3 * s2 - 2 * s3) * p1 + (s3 - s2) * m1;
}

/**
 * The speed (per frame) a smooth curve passes key b with, from its neighbours a and c: the slope of the parabola through
 * the three (weighted by their times), zero where the lane turns back at b, and at most three times the slower side's
 * slope (Fritsch–Carlson), so neither stretch overshoots its keys.
 */
function tangent(ta: number, va: number, tb: number, vb: number, tc: number, vc: number) {
  const h0 = tb - ta;
  const h1 = tc - tb;
  if (!(h0 > 0 && h1 > 0)) return 0;
  const d0 = (vb - va) / h0;
  const d1 = (vc - vb) / h1;
  if (!(d0 * d1 > 0)) return 0;
  const m = (d0 * h1 + d1 * h0) / (h0 + h1);
  const limit = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.abs(m) > limit ? Math.sign(m) * limit : m;
}

/**
 * One number of a lane between key i and key i + 1, `u` (0…1) of the way in time, as key i's ease says. `at(j)` reads
 * that number off key j. Angles go the short way round, and sizes (distance, lens, f-stop) change evenly in ratio. A
 * smooth stretch flows through a key only when the stretch on its other side is smooth too; elsewhere it starts or
 * stops there gently, like the default ease, so it joins any other stretch without a jolt.
 */
function between<K extends Keyed>(keys: readonly K[], i: number, u: number, at: (j: number) => number, kind: Kind) {
  const a = at(i);
  const b = at(i + 1);
  const into = kind === "log" ? (v: number) => Math.log(Math.max(1e-6, v)) : (v: number) => v;
  const v0 = into(a);
  const v1 = kind === "ang" ? a + turn(a, b) : into(b);
  const ease = keys[i].ease;
  let v: number;
  if (ease !== "smooth") v = v0 + (v1 - v0) * easeProgress(ease, u);
  else {
    const t0 = keys[i].t;
    const t1 = keys[i + 1].t;
    let m0 = 0;
    let m1 = 0;
    if (i > 0 && keys[i - 1].ease === "smooth") {
      const p = at(i - 1);
      m0 = tangent(keys[i - 1].t, kind === "ang" ? a - turn(p, a) : into(p), t0, v0, t1, v1);
    }
    if (i + 2 < keys.length && keys[i + 1].ease === "smooth") {
      const n = at(i + 2);
      m1 = tangent(t0, v0, t1, v1, keys[i + 2].t, kind === "ang" ? v1 + turn(b, n) : into(n));
    }
    v = hermite(v0, v1, m0 * (t1 - t0), m1 * (t1 - t0), u);
  }
  return kind === "log" ? Math.exp(v) : v;
}

/** Where frame `t` falls: on a key (or held at one), or `u` of the way from key i to the next. */
function locate(keys: readonly Keyed[], t: number): { at: number } | { i: number; u: number } {
  const n = keys.length;
  if (!(t > keys[0].t)) return { at: 0 };
  if (t >= keys[n - 1].t) return { at: n - 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  if (keys[lo].t === t || keys[lo].ease === "hold") return { at: lo };
  return { i: lo, u: (t - keys[lo].t) / (keys[lo + 1].t - keys[lo].t) };
}

/* ------------------------------------------------------------------ values ------------------------------------------ */

/** The keyed part of a camera rig, copied. */
export function cameraValue(rig: CameraRig): CameraValue {
  return {
    azimuth: rig.azimuth,
    elevation: rig.elevation,
    distance: rig.distance,
    focal: rig.focal,
    roll: rig.roll,
    focusHeight: rig.focusHeight,
    focusId: rig.focusId ?? null,
    free: rig.free ? { x: rig.free.x, z: rig.free.z } : null,
    aperture: rig.aperture,
  };
}

/** The keyed part of an element (where it stands, faces, how high, its pose), copied. */
export function elementValue(el: Pick<SceneElement, "x" | "z" | "yaw" | "lift" | "pose">): ElementValue {
  return { x: el.x, z: el.z, yaw: el.yaw, lift: el.lift, pose: el.pose };
}

/** Where an element's position is for the camera: the point it looks at when it frames `focusId`. */
export type FocusResolver = (focusId: string | null) => { x: number; z: number } | null | undefined;

/** What `focusPoint` (camera.ts) looks at on this set: the framed element, else the first one, else the set's middle. */
export function focusResolver(elements: readonly Pick<SceneElement, "id" | "x" | "z">[]): FocusResolver {
  return (id) => {
    const el = (id !== null ? elements.find((e) => e.id === id) : undefined) ?? elements[0];
    return el ? { x: el.x, z: el.z } : null;
  };
}

/**
 * The camera at frame `t` (null when the camera has no keys). Before the first key it is the first key, after the last
 * the last. Between two keys that frame the same subject (neither walked to a free point) it keeps framing that subject,
 * so it follows them as they move; otherwise the points the two keys look at (`where` finds an element's) are blended
 * and the camera looks at a free point between them.
 */
export function cameraAt(tl: Timeline | null | undefined, t: number, where?: FocusResolver): CameraRig | null {
  const keys = tl?.camera;
  if (!keys?.length) return null;
  const spot = locate(keys, t);
  if ("at" in spot) return cameraValue(keys[spot.at].cam);
  const { i, u } = spot;
  const A = keys[i].cam;
  const B = keys[i + 1].cam;
  const num = (get: (c: CameraValue) => number, kind: Kind) => between(keys, i, u, (j) => get(keys[j].cam), kind);
  const rig: CameraRig = {
    azimuth: num((c) => c.azimuth, "ang"),
    elevation: num((c) => c.elevation, "lin"),
    distance: num((c) => c.distance, "log"),
    focal: num((c) => c.focal, "log"),
    aperture: num((c) => c.aperture, "log"),
    roll: num((c) => c.roll, "ang"),
    focusHeight: num((c) => c.focusHeight, "lin"),
    focusId: A.focusId ?? null,
    free: null,
  };
  if (!(A.focusId === B.focusId && !A.free && !B.free)) {
    const seen = new Map<CameraValue, { x: number; z: number }>();
    const point = (c: CameraValue) => {
      let p = seen.get(c);
      if (!p) {
        p = c.free ?? where?.(c.focusId ?? null) ?? { x: 0, z: 0 };
        seen.set(c, p);
      }
      return p;
    };
    rig.free = { x: num((c) => point(c).x, "lin"), z: num((c) => point(c).z, "lin") };
  }
  return rig;
}

/** An element's keyed values at frame `t` (null without keys). Its pose holds: the earlier key's until the next key. */
export function elementAt(keys: readonly ElementKey[] | null | undefined, t: number): ElementValue | null {
  if (!keys?.length) return null;
  const spot = locate(keys, t);
  if ("at" in spot) return elementValue(keys[spot.at].v);
  const { i, u } = spot;
  const num = (get: (v: ElementValue) => number, kind: Kind) => between(keys, i, u, (j) => get(keys[j].v), kind);
  return { x: num((v) => v.x, "lin"), z: num((v) => v.z, "lin"), yaw: num((v) => v.yaw, "ang"), lift: num((v) => v.lift, "lin"), pose: keys[i].v.pose };
}

/**
 * The set at frame `t`: every keyed element where its keys put it, then the camera (following them). Unkeyed things, and
 * anything that didn't change, keep their objects, so nothing re-renders for nothing; the same scene when nothing moved.
 */
export function sceneAt(scene: Scene, t: number): Scene {
  const tl = scene.timeline;
  if (!hasKeys(tl)) return scene;
  let moved = false;
  const list = scene.elements.map((e) => {
    const v = elementAt(tl.elements[e.id], t);
    if (!v || (e.x === v.x && e.z === v.z && e.yaw === v.yaw && e.lift === v.lift && e.pose === v.pose)) return e;
    moved = true;
    return { ...e, x: v.x, z: v.z, yaw: v.yaw, lift: v.lift, pose: v.pose };
  });
  const elements = moved ? list : scene.elements;
  const rig = cameraAt(tl, t, focusResolver(elements));
  const camera = rig && !sameRig(scene.camera, rig) ? { ...scene.camera, ...rig } : scene.camera;
  if (elements === scene.elements && camera === scene.camera) return scene;
  return { ...scene, elements, camera };
}

function sameRig(a: CameraRig, b: CameraRig) {
  return (
    a.azimuth === b.azimuth &&
    a.elevation === b.elevation &&
    a.distance === b.distance &&
    a.focal === b.focal &&
    a.aperture === b.aperture &&
    a.roll === b.roll &&
    a.focusHeight === b.focusHeight &&
    (a.focusId ?? null) === (b.focusId ?? null) &&
    !a.free === !b.free &&
    (!a.free || !b.free || (a.free.x === b.free.x && a.free.z === b.free.z))
  );
}

/**
 * The timeline carried along when the whole set moves (a place photo re-centered, a place extended): every element key
 * and every free point the camera looks at go through `move`, and facings and camera angles turn by `turnBy` degrees,
 * so keyed things stay where they were on the set.
 */
export function movedTimeline(tl: Timeline, move: (p: { x: number; z: number }) => { x: number; z: number }, turnBy = 0): Timeline {
  const wrap = (a: number) => ((((a % 360) + 540) % 360) - 180);
  const elements: Record<string, ElementKey[]> = {};
  for (const id in tl.elements) {
    elements[id] = tl.elements[id].map((k) => {
      const p = move({ x: k.v.x, z: k.v.z });
      return { ...k, v: { ...k.v, x: p.x, z: p.z, yaw: turnBy ? Math.round(wrap(k.v.yaw + turnBy)) : k.v.yaw } };
    });
  }
  const camera = tl.camera.map((k) => ({
    ...k,
    cam: { ...k.cam, azimuth: turnBy ? Math.round(wrap(k.cam.azimuth + turnBy) * 100) / 100 : k.cam.azimuth, free: k.cam.free ? move(k.cam.free) : (k.cam.free ?? null) },
  }));
  return { ...tl, camera, elements };
}

/* ------------------------------------------------------------- editing keys ----------------------------------------- */

const byT = (a: Keyed, b: Keyed) => a.t - b.t;

/** Sorted keys with one per frame: of two on a frame, the later in the list stays. */
function dedupe<K extends Keyed>(keys: K[]): K[] {
  const out: K[] = [];
  for (const k of keys) {
    if (out.length && out[out.length - 1].t === k.t) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

function pullIn<K extends Keyed>(keys: K[], length: number): K[] {
  if (keys.every((k) => k.t >= 0 && k.t <= length && Number.isInteger(k.t))) return keys;
  return dedupe(keys.map((k) => (k.t >= 0 && k.t <= length && Number.isInteger(k.t) ? k : { ...k, t: Math.min(length, Math.max(0, Math.round(k.t) || 0)) })).sort(byT));
}

/** The index of the key on frame `t`, or -1. */
export function keyIndex(keys: readonly Keyed[], t: number) {
  const f = Math.round(t);
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t === f) return mid;
    if (keys[mid].t < f) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function keyAt<K extends Keyed>(keys: readonly K[], t: number): K | undefined {
  const i = keyIndex(keys, t);
  return i >= 0 ? keys[i] : undefined;
}

/** The keys with `key` in place: replacing the one on its frame, or added in order. */
export function setKey<K extends Keyed>(keys: readonly K[], key: K): K[] {
  const k = Number.isInteger(key.t) ? key : { ...key, t: Math.round(key.t) };
  const i = keyIndex(keys, k.t);
  if (i >= 0) return keys.map((o, j) => (j === i ? k : o));
  return [...keys, k].sort(byT);
}

export function removeKey<K extends Keyed>(keys: readonly K[], t: number): K[] {
  const i = keyIndex(keys, t);
  return i < 0 ? (keys as K[]) : keys.filter((_, j) => j !== i);
}

export function removeKeys<K extends Keyed>(keys: readonly K[], ts: readonly number[]): K[] {
  const drop = new Set(ts.map((t) => Math.round(t)));
  return keys.some((k) => drop.has(k.t)) ? keys.filter((k) => !drop.has(k.t)) : (keys as K[]);
}

/**
 * The ease a new key on frame `t` gets: inside a stretch it takes that stretch's ease, so both halves move as the whole
 * did; before the first key or after the last it gets the default (the old last key's ease now runs the new stretch).
 */
export function inheritedEase(keys: readonly Keyed[], t: number): Ease {
  if (!keys.length || t <= keys[0].t || t >= keys[keys.length - 1].t) return keyAt(keys, t)?.ease ?? DEFAULT_EASE;
  const i = keys.findIndex((k, j) => k.t <= t && keys[j + 1]?.t > t);
  return i >= 0 ? keys[i].ease : DEFAULT_EASE;
}

/**
 * The keys on frames `ts` moved `dt` frames together, stopped at the shot's ends as a block (so they keep their spacing).
 * A moved key replaces one it lands on.
 */
export function moveKeys<K extends Keyed>(keys: readonly K[], ts: readonly number[], dt: number, length: number): K[] {
  const pick = new Set(ts.map((t) => Math.round(t)));
  const moving = keys.filter((k) => pick.has(k.t));
  if (!moving.length) return keys as K[];
  const d = Math.round(Math.min(length - moving[moving.length - 1].t, Math.max(-moving[0].t, dt)));
  if (!d) return keys as K[];
  const moved = moving.map((k) => ({ ...k, t: k.t + d }));
  const landing = new Set(moved.map((k) => k.t));
  return [...keys.filter((k) => !pick.has(k.t) && !landing.has(k.t)), ...moved].sort(byT);
}

/** The stretches an ease change reaches: a single key's own (to the next key); several keys', every one from the first to the last. */
function easeRange(keys: readonly Keyed[], ts: readonly number[]) {
  const idx = ts.map((t) => keyIndex(keys, t)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!idx.length) return null;
  return { from: idx[0], to: idx.length === 1 ? idx[0] : idx[idx.length - 1] - 1 };
}

export function setEase<K extends Keyed>(keys: readonly K[], ts: readonly number[], ease: Ease): K[] {
  const r = easeRange(keys, ts);
  if (!r) return keys as K[];
  let changed = false;
  const out = keys.map((k, i) => {
    if (i < r.from || i > r.to || k.ease === ease) return k;
    changed = true;
    return { ...k, ease };
  });
  return changed ? out : (keys as K[]);
}

/** The ease of the stretches `setEase` would change; "mixed" when they differ, null when no key is picked. */
export function easeOf(keys: readonly Keyed[], ts: readonly number[]): Ease | "mixed" | null {
  const r = easeRange(keys, ts);
  if (!r) return null;
  const eases = new Set(keys.slice(r.from, r.to + 1).map((k) => k.ease));
  return eases.size === 1 ? [...eases][0] : "mixed";
}

/** The key nearest frame `t` (the earlier on a tie), or null. */
export function nearestKey<K extends Keyed>(keys: readonly K[], t: number): K | null {
  let best: K | null = null;
  for (const k of keys) if (!best || Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
  return best;
}

const frameOf = (x: number | { t: number }) => (typeof x === "number" ? x : x.t);

/** The last key frame before frame `t` in a sorted lane (its keys, or frames as from `allKeyTimes`), or null. */
export function prevKeyTime(keys: readonly (number | { t: number })[], t: number): number | null {
  for (let i = keys.length - 1; i >= 0; i--) if (frameOf(keys[i]) < t) return frameOf(keys[i]);
  return null;
}

/** The first key frame after frame `t` in a sorted lane (its keys, or frames as from `allKeyTimes`), or null. */
export function nextKeyTime(keys: readonly (number | { t: number })[], t: number): number | null {
  for (const x of keys) if (frameOf(x) > t) return frameOf(x);
  return null;
}

/* ------------------------------------------------------- picked keys, across lanes ---------------------------------- */

function eachLane(tl: Timeline, sel: KeySelection, fn: (keys: readonly Keyed[], ts: readonly number[]) => void) {
  if (sel.camera?.length) fn(tl.camera, sel.camera);
  for (const id in sel.elements ?? {}) {
    const ts = sel.elements?.[id];
    if (ts?.length && tl.elements[id]) fn(tl.elements[id], ts);
  }
}

/** How far the picked keys can really move by `dt`: all together, stopped at the shot's ends. */
export function selectionShift(tl: Timeline, sel: KeySelection, dt: number): number {
  let lo = -Infinity;
  let hi = Infinity;
  eachLane(tl, sel, (keys, ts) => {
    for (const t of ts) {
      if (keyIndex(keys, t) < 0) continue;
      lo = Math.max(lo, -Math.round(t));
      hi = Math.min(hi, tl.length - Math.round(t));
    }
  });
  if (lo === -Infinity) return 0;
  return Math.round(Math.min(hi, Math.max(lo, dt))) || 0;
}

export function moveSelection(tl: Timeline, sel: KeySelection, dt: number): Timeline {
  const d = selectionShift(tl, sel, dt);
  if (!d) return tl;
  const elements = { ...tl.elements };
  for (const id in sel.elements ?? {}) if (elements[id]) elements[id] = moveKeys(elements[id], sel.elements?.[id] ?? [], d, tl.length);
  return { ...tl, camera: moveKeys(tl.camera, sel.camera ?? [], d, tl.length), elements };
}

export function deleteSelection(tl: Timeline, sel: KeySelection): Timeline {
  const camera = removeKeys(tl.camera, sel.camera ?? []);
  let changed = camera !== tl.camera;
  const elements = { ...tl.elements };
  for (const id in sel.elements ?? {}) {
    if (!elements[id]) continue;
    const keys = removeKeys(elements[id], sel.elements?.[id] ?? []);
    if (keys === elements[id]) continue;
    changed = true;
    if (keys.length) elements[id] = keys;
    else delete elements[id];
  }
  return changed ? { ...tl, camera, elements } : tl;
}

export function easeSelection(tl: Timeline, sel: KeySelection, ease: Ease): Timeline {
  const camera = setEase(tl.camera, sel.camera ?? [], ease);
  let changed = camera !== tl.camera;
  const elements = { ...tl.elements };
  for (const id in sel.elements ?? {}) {
    if (!elements[id]) continue;
    const keys = setEase(elements[id], sel.elements?.[id] ?? [], ease);
    if (keys !== elements[id]) {
      elements[id] = keys;
      changed = true;
    }
  }
  return changed ? { ...tl, camera, elements } : tl;
}

/** The ease shown for the picked keys: theirs when every lane agrees, "mixed" when not, null when nothing is picked. */
export function selectionEase(tl: Timeline, sel: KeySelection): Ease | "mixed" | null {
  let out: Ease | "mixed" | null = null;
  eachLane(tl, sel, (keys, ts) => {
    const e = easeOf(keys, ts);
    if (e === null) return;
    out = out === null || out === e ? e : "mixed";
  });
  return out;
}

/* ----------------------------------------------------------------- camera moves ------------------------------------- */

export type CameraMoveKind =
  | "push-in"
  | "pull-out"
  | "orbit-left"
  | "orbit-right"
  | "crane-up"
  | "crane-down"
  | "truck-left"
  | "truck-right"
  | "tilt-up"
  | "tilt-down"
  | "dolly-zoom";

export const CAMERA_MOVES: readonly { id: CameraMoveKind; label: string; plain: string }[] = [
  { id: "push-in", label: "Push in", plain: "Moves in closer to the subject" },
  { id: "pull-out", label: "Pull out", plain: "Backs away to show more of the place" },
  { id: "orbit-left", label: "Orbit left", plain: "Circles the subject to the left" },
  { id: "orbit-right", label: "Orbit right", plain: "Circles the subject to the right" },
  { id: "crane-up", label: "Crane up", plain: "Rises and looks down on the scene" },
  { id: "crane-down", label: "Crane down", plain: "Sinks low and looks up" },
  { id: "truck-left", label: "Truck left", plain: "Slides sideways to the left, facing the same way" },
  { id: "truck-right", label: "Truck right", plain: "Slides sideways to the right, facing the same way" },
  { id: "tilt-up", label: "Tilt up", plain: "Stays where it stands and tilts up" },
  { id: "tilt-down", label: "Tilt down", plain: "Stays where it stands and tilts down" },
  { id: "dolly-zoom", label: "Dolly zoom", plain: "Moves in while the lens widens: the subject keeps its size, the world stretches" },
];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const DISTANCE = [0.4, 150] as const;
const FOCAL = [14, 200] as const;
const ELEVATION = [-85, 85] as const;

/** The camera's height above the floor. */
const heightOf = (c: CameraValue) => c.focusHeight + c.distance * Math.sin(rad(c.elevation));

/**
 * A ready-made camera move over the whole shot: two keys, frame 0 the camera as it is and frame `length` the camera
 * moved, eased in and out. `focus` is the point the camera looks at now (camera.ts focusPoint); without it, its free
 * point, else the `subject`'s spot. Every move keeps the camera at least 0.2 m above the floor (or as high as it was).
 */
export function cameraMove(
  kind: CameraMoveKind,
  rig: CameraRig,
  opts: { length: number; subject?: { x: number; z: number; height: number; lift: number }; focus?: { x: number; z: number }; strength?: number },
): CameraKey[] {
  const start = cameraValue(rig);
  let end: CameraValue = { ...start, free: start.free ? { ...start.free } : null };
  const d = start.distance;
  // How far the move goes: 1 for a set, less for a video (Director video mode: footage covers only what its own camera
  // saw, and a 40-degree orbit left it mostly unseen gray, Nov 14).
  const k = clamp(opts.strength ?? 1, 0.1, 1);
  switch (kind) {
    case "push-in":
      end.distance = clamp(d * (1 - 0.4 * k), ...DISTANCE);
      break;
    case "pull-out":
      end.distance = clamp(d * (1 + 0.65 * k), ...DISTANCE);
      break;
    case "orbit-left":
      end.azimuth = start.azimuth - 40 * k;
      break;
    case "orbit-right":
      end.azimuth = start.azimuth + 40 * k;
      break;
    case "crane-up":
      end.elevation = clamp(start.elevation + 22 * k, ...ELEVATION);
      end.focusHeight = start.focusHeight + 0.4 * k;
      break;
    case "crane-down":
      end.elevation = clamp(start.elevation - 18 * k, ...ELEVATION);
      end.focusHeight = Math.max(0, start.focusHeight - 0.3 * k);
      break;
    case "truck-left":
    case "truck-right": {
      // Sideways along the camera's own right, the point it looks at sliding with it: framing stays, the set slides by.
      const p = opts.focus ?? start.free ?? opts.subject ?? { x: 0, z: 0 };
      const side = (kind === "truck-right" ? 1.5 : -1.5) * k;
      const az = rad(start.azimuth);
      end.free = { x: p.x + side * Math.cos(az), z: p.z - side * Math.sin(az) };
      break;
    }
    case "tilt-up":
    case "tilt-down": {
      // A tilt turns the camera where it stands: the point it looks at goes 0.8 m up or down, the camera stays put.
      const across = d * Math.cos(rad(start.elevation));
      const focusHeight = Math.max(0, start.focusHeight + (kind === "tilt-up" ? 0.8 : -0.8));
      const above = d * Math.sin(rad(start.elevation)) - (focusHeight - start.focusHeight);
      end.focusHeight = focusHeight;
      end.distance = clamp(Math.hypot(across, above), ...DISTANCE);
      end.elevation = clamp(deg(Math.atan2(above, across)), ...ELEVATION);
      break;
    }
    case "dolly-zoom": {
      // In and wider by the same ratio, so the subject keeps its size; when the lens can't go wider, out and longer.
      let r = Math.max(0.6, FOCAL[0] / start.focal, DISTANCE[0] / d);
      if (r > 0.95) r = Math.min(1 / 0.6, FOCAL[1] / start.focal, DISTANCE[1] / d);
      end.focal = clamp(start.focal * r, ...FOCAL);
      end.distance = clamp(d * r, ...DISTANCE);
      break;
    }
  }
  // A crane down that hits the floor sinks as far as it can without ending flatter than it began.
  end = tidy(aboveFloor(tidy(end), Math.min(0.2, heightOf(start)), kind === "crane-down" ? start.elevation : ELEVATION[1]));
  const t = Math.max(1, Math.round(opts.length));
  return [
    { t: 0, cam: start, ease: DEFAULT_EASE },
    { t, cam: end, ease: DEFAULT_EASE },
  ];
}

/**
 * The camera kept at `floor` or higher: swung up round the point it looks at (to `most` degrees at the steepest) and,
 * when that isn't enough, raised together with that point.
 */
function aboveFloor(c: CameraValue, floor: number, most: number): CameraValue {
  if (heightOf(c) >= floor - 1e-9) return c;
  // Rounded up, so tidying the numbers afterwards can't take it under the floor again.
  const need = Math.ceil(deg(Math.asin(clamp((floor - c.focusHeight) / c.distance, -1, 1))) * 100) / 100;
  const swung = { ...c, elevation: Math.min(Math.max(most, c.elevation), Math.max(c.elevation, need)) };
  const short = floor - heightOf(swung);
  return short > 1e-9 ? { ...swung, focusHeight: Math.ceil((swung.focusHeight + short) * 1000) / 1000 } : swung;
}

function tidy(c: CameraValue): CameraValue {
  const r = (v: number, k: number) => Math.round(v * k) / k;
  return {
    ...c,
    azimuth: r(c.azimuth, 100),
    elevation: r(c.elevation, 100),
    distance: r(c.distance, 1000),
    focal: r(c.focal, 10),
    focusHeight: r(c.focusHeight, 1000),
    free: c.free ? { x: r(c.free.x, 1000), z: r(c.free.z, 1000) } : null,
  };
}

/* ------------------------------------------------------------------ helpers ----------------------------------------- */

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = isNum(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

function cleanCamera(raw: unknown): CameraValue | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const { azimuth, elevation, distance, focal, roll, focusHeight, aperture } = c;
  if (!isNum(azimuth) || !isNum(elevation) || !isNum(distance) || !isNum(focal) || !isNum(roll) || !isNum(focusHeight) || !isNum(aperture)) return null;
  if (!(distance > 0 && focal > 0 && aperture > 0)) return null;
  const f = c.free as Record<string, unknown> | null | undefined;
  const free = f && typeof f === "object" && isNum(f.x) && isNum(f.z) ? { x: f.x, z: f.z } : null;
  return { azimuth, elevation, distance, focal, roll, focusHeight, aperture, focusId: typeof c.focusId === "string" ? c.focusId : null, free };
}

function cleanElement(raw: unknown): ElementValue | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!isNum(v.x) || !isNum(v.z) || !isNum(v.yaw) || !isNum(v.lift)) return null;
  return { x: v.x, z: v.z, yaw: v.yaw, lift: v.lift, pose: typeof v.pose === "string" ? (v.pose as Pose) : undefined };
}
