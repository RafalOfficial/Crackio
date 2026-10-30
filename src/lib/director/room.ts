import { Vector3 } from "three";
import { cameraPosition, focusPoint } from "./camera";
import type { CameraRig, Scene } from "./types";

/**
 * The place's room: where the camera can be and still see the place, set by the stage once the place is measured
 * (Stage3D's WalkIn). Within `reach` of `center` in each direction (one entry per longitude: the walls, less a margin),
 * over the floor, under `top` while walking (a little above the eye the place was made from) and under the ceiling, if
 * there is one, for every other move. Zoomed or swung out past the walls, the camera saw the place from outside: a
 * tunnel, a smeared floor, then black (the user: "morphing into different dimensions of that one image").
 */
export type Room = {
  center: Vector3;
  /** How far walking may go each way: up to the shelves and counters (one entry per longitude). */
  reach: Float32Array;
  /** How far any other move may take the camera: up to the walls. */
  walls: Float32Array;
  /**
   * How far the world's measuring saw in every direction from `center` (its depth map: `w` x `h` over all longitudes
   * and `span` of latitude, place units; `scale` to the stage's), out to `far`: the camera stays in front of all of it,
   * where the world shows what it saw. Past a counter or a shelf, it saw their insides and backs, which the 360 never did.
   */
  seen?: { w: number; h: number; r: Float32Array; span: number; far: number; scale: number };
  top: number;
  ceiling: number | null;
  /** The world it was measured from (its depth map). */
  key: string;
};
export const room: { current: Room | null } = { current: null };

/** The lens scrolling hands over at: in and out from here it moves the camera, past the room's limits the lens. */
const NORMAL_FOCAL = 35;
/** The closest scrolling brings the camera to what it looks at, meters. */
const CLOSEST = 0.5;

/** Whether a point is in the room: in front of everything the world saw (else within its walls), over the floor. */
export function inRoom(p: Vector3) {
  const r = room.current;
  if (!r) return true;
  if (p.y < 0.25 || p.y > (r.ceiling !== null ? r.ceiling - 0.3 : Infinity)) return false;
  const dx = p.x - r.center.x;
  const dy = p.y - r.center.y;
  const dz = p.z - r.center.z;
  const s = r.seen;
  if (s) {
    const d = Math.hypot(dx, dy, dz) / s.scale;
    if (d < 0.3) return true;
    const x = (((Math.floor((Math.atan2(dx, -dz) / (2 * Math.PI) + 0.5) * s.w) % s.w) + s.w) % s.w);
    const y = Math.min(s.h - 1, Math.max(0, Math.floor((0.5 - Math.asin(dy / (d * s.scale)) / s.span) * s.h)));
    // Half a meter short of what it saw, so the camera never stands in a surface.
    return d <= Math.min(s.r[y * s.w + x] - 0.5, s.far);
  }
  const n = r.walls.length;
  const col = (((Math.floor((Math.atan2(dx, -dz) / (2 * Math.PI) + 0.5) * n) % n) + n) % n);
  return Math.hypot(dx, dz) <= r.walls[col];
}

/**
 * The rig with its camera in the room: brought in along its line toward what it looks at, to the farthest point on it
 * within the walls (a game camera's spring arm), so it slides along a wall instead of passing through it. Left as it
 * is when nothing on that line is in the room.
 */
export function keptInRoom(scene: Scene, rig: CameraRig): CameraRig {
  // Only this world's room: an extended place moves everything before its own world is built.
  if (!room.current || room.current.key !== scene.place.world?.depth?.url) return rig;
  const target = focusPoint({ ...scene, camera: rig });
  const at = (d: number) => cameraPosition({ ...rig, distance: d }, target);
  if (inRoom(at(rig.distance))) return rig;
  const step = Math.max(0.02, rig.distance / 300);
  for (let d = rig.distance - step; d > 0; d -= step) {
    if (!inRoom(at(d))) continue;
    // Then to the centimeter, between there and the step past it.
    let lo = d;
    let hi = d + step;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (inRoom(at(mid))) lo = mid;
      else hi = mid;
    }
    return { ...rig, distance: Math.max(0.3, Math.floor(lo * 100) / 100) };
  }
  return rig;
}

/**
 * A scroll's zoom: the camera moves in or out along its line, and where it can't go on (at a wall, or right up to what
 * it looks at) the lens zooms instead, so the subject keeps growing or shrinking and the place never breaks. Scrolled
 * back, the lens returns to normal first. `delta` is the wheel's (positive: out).
 */
export function zoomed(scene: Scene, delta: number): Partial<CameraRig> {
  const cam = scene.camera;
  const k = 1 + delta * 0.001;
  // 18 mm at the widest: wider, the floor right under the camera (the picture's weakest part) filled the frame's bottom.
  const lens = (f: number) => Math.round(Math.min(135, Math.max(18, f)) * 10) / 10;
  if (k > 1) {
    if (cam.focal > NORMAL_FOCAL + 0.5) return { focal: lens(Math.max(NORMAL_FOCAL, cam.focal / k)) };
    const want = Math.min(150, cam.distance * k);
    const can = keptInRoom(scene, { ...cam, distance: want }).distance;
    // The subject's size goes as the lens over the distance: what moving back to `want` would have done.
    return can >= want - 0.01 ? { distance: want } : { distance: can, focal: lens((cam.focal * can) / want) };
  }
  if (cam.focal < NORMAL_FOCAL - 0.5) return { focal: lens(Math.min(NORMAL_FOCAL, cam.focal / k)) };
  const want = cam.distance * k;
  if (want >= CLOSEST) return { distance: want };
  const near = Math.min(cam.distance, CLOSEST);
  return { distance: near, focal: lens((cam.focal * near) / want) };
}
