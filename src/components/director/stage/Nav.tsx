"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { DoubleSide, MathUtils, type Object3D, type PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";
import { DEFAULT_CAMERA, useDirector } from "@/lib/director/store";
import { cameraPosition, focusPoint, orbitFrom, verticalFov } from "@/lib/director/camera";
import { room } from "@/lib/director/room";
import { photoCamera } from "@/lib/director/reconstruct";
import { FEEL, useFeel } from "@/lib/director/feel";
import { aspectById } from "@/lib/shot";
import { walking } from "../walk";
import { notice } from "../v2/notice";
import { useStageView } from "./view";
import { NO_DEPTH } from "./capture";
import { HELPER_LAYER } from "./post";

/**
 * Director v2's camera controls: ONE set of moves for both tabs. In the Set tab they move your eyes (never saved, never
 * undone, never in the shot); in the Camera tab the same moves move the Camera itself, one undo step per gesture.
 *
 *   drag            orbit round what you look at   (Look first: turn your head)
 *   Alt-drag, middle  the other one of the two
 *   right-drag      slide; the point under the pointer stays under it
 *   wheel           move toward what's under the pointer; Alt+wheel or a pinch: the lens
 *   W A S D, Q E    move level / down and up (Shift: faster); arrows turn when nothing is picked
 *   double-click    look at that spot (it becomes what you swing round)
 *
 * Moves follow the hand 1:1; only one-shot moves (Home, frame, focus) glide, and any touch stops a glide where it is.
 * Speeds scale with the distance to what you look at, so they feel the same in a room and in a street. A fence keeps
 * you near the place (it was made from one spot; far away it stops looking right) and Home always brings you back.
 */

type Pose = { pos: Vector3; target: Vector3; fov: number };
type Op = "orbit" | "look" | "pan";

const rad = MathUtils.degToRad;
const UP = new Vector3(0, 1, 0);
const floorPlane = new Plane(new Vector3(0, 1, 0), 0);

/** Your eyes in the Set tab. */
export const eyes: Pose & { ready: boolean } = { pos: new Vector3(0, 2.4, 7), target: new Vector3(0, 1, 0), fov: FEEL.fovDefault, ready: false };

/** What the stage's buttons (knobs, Home, Frame, Camera to view, lens) ask of the controller. Filled while it's mounted. */
export const nav = {
  drag: (_op: Op, _dx: number, _dy: number) => {},
  end: () => {},
  home: () => {},
  frame: () => {},
  cameraToView: () => {},
  lens: (_steps: number) => {},
  /** The lens number shown: the view's degrees (Set tab) or the Camera's mm. */
  lensValue: (): number => FEEL.fovDefault,
};

/** The Camera's pose as eyes would hold it. */
function shotPose(): Pose {
  const s = useDirector.getState().scene;
  const target = focusPoint(s);
  const a = aspectById(s.aspect);
  return { pos: cameraPosition(s.camera, target), target, fov: verticalFov(s.camera.focal, a.w / a.h) };
}

/** Writes a pose into the Camera: where it stands and what it looks at (it stops following a subject). */
function writeShot(pos: Vector3, target: Vector3) {
  const o = orbitFrom(pos, target);
  useDirector.getState().setCamera(
    { azimuth: o.azimuth, elevation: o.elevation, distance: Math.round(o.distance * 1000) / 1000, focusHeight: Math.round(target.y * 1000) / 1000, free: { x: target.x, z: target.z } },
    true,
  );
}

/** Where the place is centered (where it was made from): the fence's middle. */
function fenceCenter() {
  return room.current?.center ?? new Vector3(0, 0, 0);
}

/**
 * How far from the middle you can go: FEEL's fence, or more where the photo was taken farther out than that (with room to
 * back off past it). A test place with a knight (Storyboard, Nov 14) has its middle 83 m from its camera: with the fence at
 * 45 m every step back was "farther", so the view went forward only.
 */
function fenceRadius() {
  const s = useDirector.getState().scene;
  const view = s.place.image?.view;
  const photo = view ? photoCamera(view, s.place.scale ?? 1).position.distanceTo(fenceCenter()) : 0;
  return Math.max(FEEL.fence, photo * 1.6 + 10);
}

/** A move from `from` to `to` that stays inside the fence; when it would leave, it doesn't happen and the line says so. */
function fenced(from: Vector3, to: Vector3) {
  const c = fenceCenter();
  if (to.y < FEEL.floor) to.y = FEEL.floor;
  const far = to.distanceTo(c);
  if (far > fenceRadius() && far > from.distanceTo(c)) {
    notice("The view can't go farther · Home brings you back", "info");
    return false;
  }
  return true;
}

function orbitPose(p: Pose, dx: number, dy: number) {
  const off = p.pos.clone().sub(p.target);
  const r = Math.max(FEEL.closest, off.length());
  let theta = Math.atan2(off.x, off.z);
  let phi = Math.asin(MathUtils.clamp(off.y / r, -1, 1));
  theta -= rad(dx * FEEL.orbitPerPx);
  phi = MathUtils.clamp(phi + rad(dy * FEEL.orbitPerPx), rad(-80), rad(FEEL.pitchLimit));
  off.set(r * Math.cos(phi) * Math.sin(theta), r * Math.sin(phi), r * Math.cos(phi) * Math.cos(theta));
  p.pos.copy(p.target).add(off);
  if (p.pos.y < FEEL.floor) p.pos.y = FEEL.floor;
}

/** Turns the head: the world under the pointer follows it (a grab, like Street View). */
function lookPose(p: Pose, dx: number, dy: number, w: number, h: number) {
  const dir = p.target.clone().sub(p.pos);
  const d = Math.max(FEEL.closest, dir.length());
  dir.normalize();
  let yaw = Math.atan2(dir.x, -dir.z);
  let pitch = Math.asin(MathUtils.clamp(dir.y, -1, 1));
  const v = rad(p.fov);
  const hfov = 2 * Math.atan(Math.tan(v / 2) * (w / Math.max(1, h)));
  yaw -= (dx / Math.max(1, w)) * hfov;
  pitch = MathUtils.clamp(pitch + (dy / Math.max(1, h)) * v, rad(-FEEL.pitchLimit), rad(FEEL.pitchLimit));
  dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  p.target.copy(p.pos).addScaledVector(dir, d);
}

/** Slides the view; the grabbed point (`depth` meters away along the view) stays under the pointer. */
function panPose(p: Pose, dx: number, dy: number, h: number, depth: number) {
  const dir = p.target.clone().sub(p.pos).normalize();
  const right = new Vector3().crossVectors(dir, UP).normalize();
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  const up = new Vector3().crossVectors(right, dir).normalize();
  const k = (2 * depth * Math.tan(rad(p.fov) / 2)) / Math.max(1, h);
  const move = right.multiplyScalar(-dx * k).addScaledVector(up, dy * k);
  const to = p.pos.clone().add(move);
  if (!fenced(p.pos, to)) return;
  const dy2 = to.y - (p.pos.y + move.y);
  p.pos.copy(to);
  p.target.add(move).setY(p.target.y + dy2);
}

/** Toward (`steps` > 0) or away from `hit`; the point stays under the pointer. */
function dollyPose(p: Pose, steps: number, hit: Vector3) {
  const f = Math.pow(FEEL.wheelStep, -steps);
  const pos = hit.clone().add(p.pos.clone().sub(hit).multiplyScalar(f));
  const target = hit.clone().add(p.target.clone().sub(hit).multiplyScalar(f));
  if (steps > 0 && pos.distanceTo(hit) < FEEL.closest) return false;
  if (steps < 0 && pos.distanceTo(target) > FEEL.farthest) return false;
  if (!fenced(p.pos, pos)) return false;
  const lift = pos.y - (hit.y + (p.pos.y - hit.y) * f);
  p.pos.copy(pos);
  p.target.copy(target).setY(target.y + lift);
  return true;
}

/** W A S D Q E for `dt` seconds: level forward/back, sideways, straight down/up. */
function walkPose(p: Pose, keys: Set<string>, dt: number) {
  const dir = p.target.clone().sub(p.pos);
  const fwd = new Vector3(dir.x, 0, dir.z);
  if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new Vector3(-fwd.z, 0, fwd.x);
  const v = new Vector3();
  if (keys.has("KeyW")) v.add(fwd);
  if (keys.has("KeyS")) v.sub(fwd);
  if (keys.has("KeyD")) v.add(right);
  if (keys.has("KeyA")) v.sub(right);
  const flat = v.length();
  if (flat > 1) v.divideScalar(flat);
  if (keys.has("KeyE")) v.y += 1;
  if (keys.has("KeyQ")) v.y -= 1;
  if (v.lengthSq() < 1e-8) return false;
  const speed = MathUtils.clamp(dir.length() * FEEL.keySpeed, FEEL.keySpeedMin, FEEL.keySpeedMax) * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? FEEL.fast : 1);
  const move = v.multiplyScalar(speed * dt);
  const to = p.pos.clone().add(move);
  if (!fenced(p.pos, to)) return false;
  const lift = to.y - (p.pos.y + move.y);
  p.pos.copy(to);
  p.target.add(move).setY(p.target.y + lift);
  return true;
}

/** Arrow keys turn the head. */
function turnPose(p: Pose, keys: Set<string>, dt: number) {
  const a = rad(FEEL.turnPerSecond) * dt;
  let yaw = 0;
  let pitch = 0;
  if (keys.has("ArrowLeft")) yaw -= a;
  if (keys.has("ArrowRight")) yaw += a;
  if (keys.has("ArrowUp")) pitch += a * 0.7;
  if (keys.has("ArrowDown")) pitch -= a * 0.7;
  if (!yaw && !pitch) return false;
  const dir = p.target.clone().sub(p.pos);
  const d = dir.length();
  dir.normalize();
  const y = Math.atan2(dir.x, -dir.z) + yaw;
  const pt = MathUtils.clamp(Math.asin(MathUtils.clamp(dir.y, -1, 1)) + pitch, rad(-FEEL.pitchLimit), rad(FEEL.pitchLimit));
  dir.set(Math.sin(y) * Math.cos(pt), Math.sin(pt), -Math.cos(y) * Math.cos(pt));
  p.target.copy(p.pos).addScaledVector(dir, d);
  return true;
}

/** Where your eyes start (and Home brings them): behind and above the Camera, looking at what it frames. */
function startEyes(): Pose {
  const s = useDirector.getState().scene;
  const target = focusPoint(s);
  const shot = cameraPosition(s.camera, target);
  const back = shot.clone().sub(target).setY(0);
  if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
  back.normalize();
  // Close behind and a little above it, like standing behind the camera operator: near where the place was made from,
  // where it looks right (from high above, a 360 place's measured walls come apart).
  const pos = shot
    .clone()
    .addScaledVector(back, 1.4 + s.camera.distance * 0.2)
    .add(new Vector3(0, 0.9 + s.camera.distance * 0.12, 0));
  return { pos, target: new Vector3(target.x, Math.min(target.y, 1.2), target.z), fov: FEEL.fovDefault };
}

const KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const typing = (t: EventTarget | null) => Boolean((t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog] input"));

function noDepth(o: Object3D | null) {
  for (let x = o; x; x = x.parent) if (x.userData?.[NO_DEPTH]) return true;
  return false;
}

export function Nav() {
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const scout = useStageView((s) => s.scout);
  const keys = useRef(new Set<string>());
  const drag = useRef<{ op: Op; x: number; y: number; depth: number; moved: boolean; az: number; el: number; dist: number; button: number; onSomeone?: boolean } | null>(null);
  const glide = useRef<{ from: Pose; to: Pose; t: number } | null>(null);
  const wheel = useRef<{ hit: Vector3 | null; at: number; idle: ReturnType<typeof setTimeout> | null }>({ hit: null, at: 0, idle: null });
  const keyStep = useRef(false);
  // Fingers on a touch screen: one drags like a mouse; with two down (`two`), they pinch and slide, and the move stays
  // theirs (`held`) until every finger is off, so lifting one doesn't turn the rest of it into a swing.
  const touch = useRef<{ pts: Map<number, { x: number; y: number }>; two: { dist: number; mx: number; my: number; depth: number; hit: Vector3 | null } | null; held: boolean }>({
    pts: new Map(),
    two: null,
    held: false,
  });

  const tab = () => (useStageView.getState().scout ? "set" : "camera");

  /** The surface under a screen point: the place, a subject or the floor; null over open sky. */
  const hitAt = (clientX: number, clientY: number): Vector3 | null => {
    const { camera, gl, scene } = get();
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, camera);
    ray.layers.set(0);
    ray.far = FEEL.fence * 2;
    const hits = ray.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (!h.object.visible || noDepth(h.object)) continue;
      return h.point.clone();
    }
    const p = new Vector3();
    return ray.ray.intersectPlane(floorPlane, p) && p.distanceTo(ray.ray.origin) < FEEL.fence ? p : null;
  };

  /** The pose being moved (your eyes, or the Camera's), as a copy. */
  const current = (): Pose => (tab() === "set" ? { pos: eyes.pos.clone(), target: eyes.target.clone(), fov: eyes.fov } : shotPose());
  const commitPose = (p: Pose) => {
    if (tab() === "set") {
      eyes.pos.copy(p.pos);
      eyes.target.copy(p.target);
      eyes.fov = p.fov;
      invalidate();
    } else writeShot(p.pos, p.target);
  };

  // Gestures (from the catcher below, the knobs, the keys) begin an undo step on the Camera the first time they move it.
  const begin = () => {
    glide.current = null;
    if (tab() === "camera") {
      useDirector.getState().checkpoint();
      walking.active = true;
    }
  };
  const finish = () => {
    walking.active = false;
    invalidate();
  };

  const apply = (op: Op, dx: number, dy: number, depth?: number) => {
    const { size } = get();
    if (op === "orbit" && tab() === "camera") {
      // The Camera swings round what it frames (a subject keeps being framed).
      const d = drag.current;
      const cam = useDirector.getState().scene.camera;
      const az = (d ? d.az : cam.azimuth) - (d ? dx : dx) * FEEL.orbitPerPx;
      const el = MathUtils.clamp((d ? d.el : cam.elevation) + dy * FEEL.orbitPerPx, -80, FEEL.pitchLimit);
      // At the distance it started at, where the room allows: swung toward a wall it comes in, and back out after.
      useDirector.getState().setCamera({ azimuth: az, elevation: el, distance: d ? d.dist : cam.distance }, true);
      return;
    }
    const p = current();
    if (op === "orbit") orbitPose(p, dx, dy);
    else if (op === "look") lookPose(p, dx, dy, size.width, size.height);
    else panPose(p, dx, dy, size.height, depth ?? p.pos.distanceTo(p.target));
    commitPose(p);
  };

  // The stage's buttons reach the controller through `nav`.
  useEffect(() => {
    nav.drag = (op, dx, dy) => {
      if (!drag.current) {
        begin();
        const cam = useDirector.getState().scene.camera;
        drag.current = { op, x: 0, y: 0, depth: current().pos.distanceTo(current().target), moved: true, az: cam.azimuth, el: cam.elevation, dist: cam.distance, button: -1 };
      }
      const d = drag.current;
      if (op === "orbit" && tab() === "camera") {
        d.x += dx;
        d.y += dy;
        apply(op, d.x, d.y);
      } else apply(op, dx, dy, d.depth);
    };
    nav.end = () => {
      drag.current = null;
      finish();
    };
    nav.home = () => {
      if (tab() === "set") {
        glideTo(startEyes());
        return;
      }
      const s = useDirector.getState();
      s.checkpoint();
      if (s.scene.place.image?.view) s.toPhotoView();
      else if (s.scene.elements.length) s.focusOn(s.selectedId ?? s.scene.elements[0].id);
      else s.setCamera({ ...DEFAULT_CAMERA }, true);
      notice("Camera back to the start", "done");
    };
    nav.frame = () => frameSelection();
    nav.cameraToView = () => {
      if (tab() !== "set") return;
      const s = useDirector.getState();
      const shot = shotPose();
      if (shot.pos.distanceTo(eyes.pos) < 0.005 && shot.target.clone().sub(shot.pos).normalize().distanceTo(eyes.target.clone().sub(eyes.pos).normalize()) < 0.001) {
        notice("The Camera is already here", "info");
        return;
      }
      s.checkpoint();
      writeShot(eyes.pos, eyes.target);
      useStageView.setState({ preview: true });
      notice("Camera moved to this view", "done");
    };
    nav.lens = (steps) => lensBy(steps);
    nav.lensValue = () => (tab() === "set" ? eyes.fov : useDirector.getState().scene.camera.focal);
  });

  const glideTo = (to: Pose) => {
    glide.current = { from: { pos: eyes.pos.clone(), target: eyes.target.clone(), fov: eyes.fov }, to, t: 0 };
    invalidate();
  };

  const frameSelection = () => {
    const s = useDirector.getState();
    const els = s.selectedId ? s.scene.elements.filter((e) => e.id === s.selectedId) : s.scene.elements;
    if (!els.length) {
      notice("Nothing to frame · add someone first", "info");
      return;
    }
    if (tab() === "camera") {
      s.checkpoint();
      s.focusOn(els[0].id);
      return;
    }
    // The picked ones (or the whole cast) fill the view, seen from where you are.
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const e of els) {
      min.min(new Vector3(e.x - e.height * 0.3, e.lift, e.z - e.height * 0.3));
      max.max(new Vector3(e.x + e.height * 0.3, e.lift + e.height, e.z + e.height * 0.3));
    }
    const center = min.clone().add(max).multiplyScalar(0.5);
    const r = Math.max(0.4, min.distanceTo(max) / 2);
    const dir = eyes.pos.clone().sub(eyes.target).normalize();
    const dist = (r / Math.sin(rad(eyes.fov) / 2)) * 1.15;
    glideTo({ pos: center.clone().addScaledVector(dir, dist), target: center, fov: eyes.fov });
  };

  const lensBy = (steps: number) => {
    if (tab() === "set") {
      eyes.fov = Math.round(MathUtils.clamp(eyes.fov - steps * FEEL.fovStep, FEEL.fovMin, FEEL.fovMax));
      invalidate();
      return;
    }
    const w = wheel.current;
    if (!w.idle) useDirector.getState().checkpoint();
    const cam = useDirector.getState().scene.camera;
    const focal = Math.round(MathUtils.clamp(cam.focal * Math.pow(FEEL.focalStep, steps), FEEL.focalMin, FEEL.focalMax) * 10) / 10;
    useDirector.getState().setCamera({ focal }, true);
  };

  // The wheel, natively: a pinch arrives as ctrl+wheel and the page must not zoom; nor must the page scroll.
  useEffect(() => {
    const el = get().gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const w = wheel.current;
      const resting = !w.idle;
      if (w.idle) clearTimeout(w.idle);
      w.idle = setTimeout(() => {
        w.idle = null;
        walking.active = false;
        invalidate();
      }, 180);
      if (e.ctrlKey || e.altKey) {
        // A pinch's steps are small: a few pixels each.
        const steps = -px / (e.ctrlKey && !e.altKey ? FEEL.pinchPx : 100);
        if (resting && tab() === "camera") useDirector.getState().checkpoint();
        lensBy(steps);
        return;
      }
      glide.current = null;
      // Aim at what's under the pointer once per scroll (the place can be big to test against).
      if (resting || performance.now() - w.at > 250) {
        w.hit = hitAt(e.clientX, e.clientY);
        w.at = performance.now();
      }
      const p = current();
      const hit =
        w.hit ??
        (() => {
          // Over open sky: toward a point straight ahead at the distance you look at.
          const { camera } = get();
          const rect = el.getBoundingClientRect();
          const ray = new Raycaster();
          ray.setFromCamera(new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
          return ray.ray.at(p.pos.distanceTo(p.target), new Vector3());
        })();
      if (resting && tab() === "camera") useDirector.getState().checkpoint();
      if (tab() === "camera") walking.active = true;
      if (dollyPose(p, -px / 100, hit)) commitPose(p);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [get, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Two fingers (a phone, a tablet): spreading them moves toward the point between them as far as they spread (the
  // wheel's move, 1:1), and moving them together slides the view. Their own listeners run before the stage's catcher.
  useEffect(() => {
    const el = get().gl.domElement;
    const pair = () => {
      const [a, b] = [...touch.current.pts.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const t = touch.current;
      t.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (t.pts.size !== 2) return;
      // The one-finger move so far stays where it got to.
      drag.current = null;
      t.held = true;
      const { dist, mx, my } = pair();
      const hit = hitAt(mx, my);
      const p = current();
      const dir = p.target.clone().sub(p.pos).normalize();
      const depth = hit ? MathUtils.clamp(hit.clone().sub(p.pos).dot(dir), 0.3, FEEL.fence) : p.pos.distanceTo(p.target);
      begin();
      t.two = { dist, mx, my, depth, hit };
    };
    const move = (e: PointerEvent) => {
      const t = touch.current;
      if (e.pointerType !== "touch" || !t.pts.has(e.pointerId)) return;
      t.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = t.two;
      if (!g || t.pts.size !== 2) return;
      const { dist, mx, my } = pair();
      const steps = Math.log(dist / Math.max(1, g.dist)) / Math.log(FEEL.wheelStep);
      if (Math.abs(steps) > 0.005) {
        const p = current();
        if (dollyPose(p, steps, g.hit ?? p.target.clone())) commitPose(p);
      }
      if (mx !== g.mx || my !== g.my) apply("pan", mx - g.mx, my - g.my, g.depth);
      t.two = { ...g, dist, mx, my };
    };
    const up = (e: PointerEvent) => {
      const t = touch.current;
      if (!t.pts.delete(e.pointerId)) return;
      if (t.two && t.pts.size < 2) {
        t.two = null;
        finish();
      }
      if (!t.pts.size) t.held = false;
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [get]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys: held ones move every frame (useFrame below); F frames, Home goes home. Typing in a box never moves anything.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey) return;
      if (e.code === "Home") {
        e.preventDefault();
        nav.home();
        return;
      }
      if (e.code === "KeyF" && !e.repeat) {
        nav.frame();
        return;
      }
      if (!KEYS.has(e.code)) return;
      // Arrows nudge whoever is picked (the workspace's shortcuts); with nobody picked they turn the view.
      if (e.code.startsWith("Arrow") && useDirector.getState().selectedId) return;
      if (e.code.startsWith("Arrow")) e.preventDefault();
      if (!keys.current.size || [...keys.current].every((k) => k.startsWith("Shift"))) keyStep.current = false;
      keys.current.add(e.code);
      invalidate();
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.code);
      if (e.key === "Meta") keys.current.clear();
      if (![...keys.current].some((k) => !k.startsWith("Shift"))) finish();
    };
    const release = () => {
      keys.current.clear();
      drag.current = null;
      finish();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    window.addEventListener("contextmenu", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
      window.removeEventListener("contextmenu", release);
    };
  }, [invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another place (or a set loaded from your places): your eyes start again behind its Camera.
  const placeUrl = useDirector((s) => s.scene.place.image?.url ?? "");
  useEffect(() => {
    if (!eyes.ready) return;
    const s = startEyes();
    eyes.pos.copy(s.pos);
    eyes.target.copy(s.target);
    eyes.fov = s.fov;
    glide.current = null;
    invalidate();
  }, [placeUrl, invalidate]);

  // Your eyes start behind the Camera the first time the Set tab opens.
  useEffect(() => {
    if (scout && !eyes.ready) {
      const s = startEyes();
      eyes.pos.copy(s.pos);
      eyes.target.copy(s.target);
      eyes.fov = s.fov;
      eyes.ready = true;
    }
    // Scouting, the Camera standing on set (a helper) can be grabbed.
    const { raycaster } = get();
    if (scout) raycaster.layers.enable(HELPER_LAYER);
    else raycaster.layers.disable(HELPER_LAYER);
    invalidate();
  }, [scout, get, invalidate]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    let moving = false;
    // Keys held: move (and turn) whichever pose this tab moves.
    const held = keys.current;
    if ([...held].some((k) => !k.startsWith("Shift"))) {
      if (!keyStep.current) {
        begin();
        keyStep.current = true;
      }
      const p = current();
      const walked = walkPose(p, held, dt);
      const turned = turnPose(p, held, dt);
      if (walked || turned) commitPose(p);
      moving = true;
    }
    if (useStageView.getState().scout) {
      const g = glide.current;
      if (g) {
        g.t = Math.min(1, g.t + dt / FEEL.ease);
        const k = 1 - Math.pow(1 - g.t, 3);
        eyes.pos.lerpVectors(g.from.pos, g.to.pos, k);
        eyes.target.lerpVectors(g.from.target, g.to.target, k);
        eyes.fov = MathUtils.lerp(g.from.fov, g.to.fov, k);
        if (g.t >= 1) glide.current = null;
        moving = true;
      }
      const cam = state.camera as PerspectiveCamera;
      cam.position.copy(eyes.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(eyes.target);
      cam.fov = eyes.fov;
      cam.aspect = state.size.width / Math.max(1, state.size.height);
      cam.near = 0.05;
      cam.far = 2000;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }
    if (moving) state.invalidate();
  }, -1);

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    const n = e.nativeEvent;
    if (touch.current.held) return;
    if (n.button === 1) n.preventDefault();
    const scheme = useFeel.getState().scheme;
    const primary: Op = scheme === "orbit" ? "orbit" : "look";
    const secondary: Op = scheme === "orbit" ? "look" : "orbit";
    const op: Op = n.button === 2 ? "pan" : n.button === 1 || n.altKey ? secondary : primary;
    let depth = current().pos.distanceTo(current().target);
    if (op === "pan") {
      const hit = hitAt(n.clientX, n.clientY);
      if (hit) {
        const p = current();
        const dir = p.target.clone().sub(p.pos).normalize();
        depth = MathUtils.clamp(hit.clone().sub(p.pos).dot(dir), 0.3, FEEL.fence);
      }
    }
    const cam = useDirector.getState().scene.camera;
    const onSomeone = e.intersections.some((i) => i.eventObject !== e.eventObject);
    drag.current = { op, x: n.clientX, y: n.clientY, depth, moved: false, az: cam.azimuth, el: cam.elevation, dist: cam.distance, button: n.button, onSomeone };
    (e.target as unknown as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || d.button < 0 || touch.current.held) return;
    const n = e.nativeEvent;
    const dx = n.clientX - d.x;
    const dy = n.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < FEEL.clickSlop) return;
      d.moved = true;
      begin();
      // The Camera tab's orbit counts from where the gesture started; every other move from the last event.
      if (!(d.op === "orbit" && tab() === "camera")) {
        d.x = n.clientX;
        d.y = n.clientY;
        return;
      }
    }
    document.body.style.cursor = d.op === "pan" ? "grabbing" : d.op === "look" ? "move" : "grabbing";
    if (d.op === "orbit" && tab() === "camera") {
      apply("orbit", dx, dy);
      return;
    }
    apply(d.op, dx, dy, d.depth);
    d.x = n.clientX;
    d.y = n.clientY;
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
    document.body.style.cursor = "";
    if (d && !d.moved && d.button === 0 && !d.onSomeone) useDirector.getState().select(null);
    finish();
  };
  const onDouble = (e: ThreeEvent<MouseEvent>) => {
    const hit = hitAt(e.nativeEvent.clientX, e.nativeEvent.clientY);
    if (!hit) {
      notice("Nothing to focus on there", "info");
      return;
    }
    if (tab() === "set") {
      glideTo({ pos: eyes.pos.clone(), target: hit, fov: eyes.fov });
      return;
    }
    const s = useDirector.getState();
    s.checkpoint();
    writeShot(shotPose().pos, hit);
  };

  return (
    <mesh
      userData={{ [NO_DEPTH]: true }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onDouble}
      onContextMenu={(e) => e.nativeEvent.preventDefault()}
    >
      <sphereGeometry args={[900, 16, 12]} />
      <meshBasicMaterial side={DoubleSide} colorWrite={false} depthWrite={false} />
    </mesh>
  );
}

/** The lens as shown on the stage: "55°" for your eyes, "35 mm" for the Camera. */
export function lensLabel(scout: boolean, value: number) {
  return scout ? `${Math.round(value)}°` : `${Math.round(value)} mm`;
}

