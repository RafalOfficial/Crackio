"use client";

import { useEffect } from "react";
import { MathUtils, Vector3 } from "three";
import { mainElement, useDirector } from "@/lib/director/store";
import { orbitFrom, shotCamera } from "@/lib/director/camera";
import { room } from "@/lib/director/room";
import { useTakeView } from "./take-view";

/**
 * Walking the shot camera through the place like a game: W A S D move it (along the ground, the way it looks), Q and E
 * lower and raise it, the arrow keys turn it (when nothing on set is picked: then they nudge that), Shift for faster,
 * F to frame the cast again. It eases into and out of every move and keeps its view while it moves: the point it looks
 * at is carried along ahead of it (the rig's `free` point, at the cast's depth so the focus stays on them). Moving it
 * around the cast instead (orbiting with a turn added) swung the view about near them, walked it into the cafe's front
 * and left it stuck (the user: lost after ten seconds).
 */

/** Set while the keys move the camera: the live camera follows exactly instead of easing (Stage3D). */
export const walking = { active: false };

/** Where the camera may go (lib/director/room, set by WalkIn once the place is built). */
export const walkable = room;

const MOVE = new Set(["w", "a", "s", "d", "q", "e"]);
const LOOK = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** A position kept inside the place: not through its walls, under its ceiling, over its floor, nor through anyone. */
function inside(p: Vector3, elements: { x: number; z: number; height: number; lift: number }[]) {
  // People and things on set are solid: walked into, the camera stood inside a coat (the user's studio).
  for (const el of elements) {
    if (p.y > el.lift + el.height + 0.3) continue;
    const room = 0.2 + el.height * 0.18;
    const dx = p.x - el.x;
    const dz = p.z - el.z;
    const d = Math.hypot(dx, dz);
    if (d >= room) continue;
    if (d < 1e-4) {
      p.x = el.x + room;
      continue;
    }
    p.x = el.x + (dx * room) / d;
    p.z = el.z + (dz * room) / d;
  }
  const w = walkable.current;
  if (w) {
    const dx = p.x - w.center.x;
    const dz = p.z - w.center.z;
    const r = Math.hypot(dx, dz);
    const n = w.reach.length;
    const col = (((Math.floor((Math.atan2(dx, -dz) / (2 * Math.PI) + 0.5) * n) % n) + n) % n);
    const max = w.reach[col];
    if (r > max && r > 1e-6) {
      p.x = w.center.x + (dx * max) / r;
      p.z = w.center.z + (dz * max) / r;
    }
  }
  p.y = MathUtils.clamp(p.y, 0.25, w ? w.top : 60);
  return p;
}

export function useWalkKeys() {
  useEffect(() => {
    const held = new Set<string>();
    const velocity = new Vector3();
    let turning = 0;
    let tilting = 0;
    let fast = false;
    let frame = 0;
    let last = 0;
    const axis = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);

    const step = (now: number) => {
      const dt = MathUtils.clamp((now - last) / 1000, 0.001, 0.05);
      last = now;
      const s = useDirector.getState();
      const scene = s.scene;
      const look = !s.selectedId;
      const cam = shotCamera(scene);
      const forward = cam.getWorldDirection(new Vector3());
      const flat = new Vector3(forward.x, 0, forward.z);
      if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
      flat.normalize();
      const right = new Vector3(-flat.z, 0, flat.x);
      // Eased toward what the keys ask for: a walk starts and stops like a dolly, not a jump.
      const speed = fast ? 4 : 1.4;
      const want = new Vector3().addScaledVector(flat, axis("w", "s")).addScaledVector(right, axis("d", "a"));
      if (want.lengthSq() > 1) want.normalize();
      want.multiplyScalar(speed);
      want.y = axis("e", "q") * speed * 0.7;
      const ease = 1 - Math.exp(-dt * 9);
      velocity.lerp(want, ease);
      turning += ((look ? axis("ArrowRight", "ArrowLeft") * (fast ? 100 : 55) : 0) - turning) * ease;
      tilting += ((look ? axis("ArrowUp", "ArrowDown") * (fast ? 70 : 40) : 0) - tilting) * ease;

      const position = inside(cam.position.clone().addScaledVector(velocity, dt), scene.elements);
      const heading = Math.atan2(forward.x, -forward.z) + MathUtils.degToRad(turning * dt);
      const pitch = MathUtils.clamp(Math.asin(MathUtils.clamp(forward.y, -1, 1)) + MathUtils.degToRad(tilting * dt), -1.4, 1.4);
      const view = new Vector3(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch));
      // The point it looks at: as deep as the framed subject is along the view (the focus stays on them); with them
      // behind or beside it, a few meters ahead (a point a meter off made dragging spin the camera on the spot).
      const el = mainElement(scene);
      const ahead = el ? new Vector3(el.x, el.lift + el.height * 0.6, el.z).sub(position).dot(view) : 0;
      const depth = ahead >= 1.5 ? Math.min(ahead, 30) : MathUtils.clamp(scene.camera.distance, 2.5, 30);
      const target = position.clone().addScaledVector(view, depth);
      const round = (v: number) => Math.round(v * 1000) / 1000;
      s.setCamera({ ...orbitFrom(position, target), focusHeight: round(target.y), free: { x: round(target.x), z: round(target.z) } }, true);

      const moving = held.size > 0 || velocity.lengthSq() > 1e-4 || Math.abs(turning) > 0.5 || Math.abs(tilting) > 0.5;
      if (moving) frame = requestAnimationFrame(step);
      else {
        frame = 0;
        walking.active = false;
      }
    };

    const typing = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true]");
    const keyOf = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
    const onDown = (e: KeyboardEvent) => {
      fast = e.shiftKey;
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || useTakeView.getState().viewing) return;
      const key = keyOf(e);
      const s = useDirector.getState();
      // F with nothing picked: back to framing the cast (after walking off somewhere).
      if (key === "f" && !s.selectedId) {
        const el = mainElement(s.scene);
        if (el) {
          e.preventDefault();
          s.focusOn(el.id);
        }
        return;
      }
      if (!MOVE.has(key) && !(LOOK.has(key) && !s.selectedId)) return;
      e.preventDefault();
      if (!frame) s.checkpoint();
      held.add(key);
      if (!frame) {
        walking.active = true;
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      fast = e.shiftKey;
      held.delete(keyOf(e));
    };
    const stop = () => held.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", stop);
      cancelAnimationFrame(frame);
      walking.active = false;
    };
  }, []);
}
