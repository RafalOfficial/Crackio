import { MathUtils, PerspectiveCamera, Vector3 } from "three";
import type { CameraRig, Scene, SceneElement } from "./types";
import { aspectById } from "@/lib/shot";

const FULL_FRAME_DIAGONAL = Math.hypot(36, 24); // 43.27 mm

/** Vertical field of view (degrees) for a full-frame focal length at a given aspect ratio. */
export function verticalFov(focal: number, aspect: number) {
  const halfDiag = Math.atan(FULL_FRAME_DIAGONAL / (2 * focal));
  const halfV = Math.atan(Math.tan(halfDiag) / Math.sqrt(aspect * aspect + 1));
  return MathUtils.radToDeg(2 * halfV);
}

export function horizontalFov(focal: number, aspect: number) {
  const v = MathUtils.degToRad(verticalFov(focal, aspect));
  return MathUtils.radToDeg(2 * Math.atan(Math.tan(v / 2) * aspect));
}

export function focusPoint(scene: Scene): Vector3 {
  const { camera, elements } = scene;
  if (camera.free) return new Vector3(camera.free.x, camera.focusHeight, camera.free.z);
  const el = elements.find((e) => e.id === camera.focusId) ?? elements[0];
  if (!el) return new Vector3(0, camera.focusHeight, 0);
  return new Vector3(el.x, camera.focusHeight, el.z);
}

/** Camera position from its orbit around the focus point. */
export function cameraPosition(rig: CameraRig, target: Vector3): Vector3 {
  const az = MathUtils.degToRad(rig.azimuth);
  const el = MathUtils.degToRad(rig.elevation);
  const horizontal = rig.distance * Math.cos(el);
  return new Vector3(
    target.x + horizontal * Math.sin(az),
    Math.max(0.05, target.y + rig.distance * Math.sin(el)),
    target.z + horizontal * Math.cos(az),
  );
}

/** The camera's height above the ground (meters). */
export function cameraHeight(rig: CameraRig) {
  return Math.max(0.05, rig.focusHeight + rig.distance * Math.sin(MathUtils.degToRad(rig.elevation)));
}

/**
 * The camera raised or lowered to a height without turning it (a pedestal move): the point it orbits moves up or down
 * with it, so the angle, distance and framing direction stay the same.
 */
export function pedestalTo(rig: CameraRig, height: number) {
  const h = MathUtils.clamp(height, 0.05, 150);
  return { focusHeight: Math.round((h - rig.distance * Math.sin(MathUtils.degToRad(rig.elevation))) * 1000) / 1000 };
}

/** A three.js camera configured exactly like the scene's shot camera. */
export function shotCamera(scene: Scene): PerspectiveCamera {
  const a = aspectById(scene.aspect);
  const aspect = a.w / a.h;
  const cam = new PerspectiveCamera(verticalFov(scene.camera.focal, aspect), aspect, 0.05, 500);
  const target = focusPoint(scene);
  cam.position.copy(cameraPosition(scene.camera, target));
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.rotateZ(MathUtils.degToRad(-scene.camera.roll));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

export type Framing = {
  element: SceneElement;
  /** Horizontal center in frame, -1 (left edge) … 1 (right edge). */
  cx: number;
  /** Vertical position of the element's top and bottom in frame, -1 (bottom) … 1 (top). */
  top: number;
  bottom: number;
  /** Visible share of the element's height, 0…1. */
  visible: number;
  /** Element height relative to frame height (can exceed 1 when cropped). */
  span: number;
  /** Meters from the camera. */
  depth: number;
  inFrame: boolean;
  behindCamera: boolean;
};

/** Where every element lands in the frame. */
export function frameElements(scene: Scene, cam = shotCamera(scene)): Framing[] {
  return scene.elements.map((element) => {
    const base = new Vector3(element.x, element.lift, element.z);
    const top = new Vector3(element.x, element.lift + element.height, element.z);
    const mid = new Vector3(element.x, element.lift + element.height / 2, element.z);
    const depth = cam.position.distanceTo(mid);
    const toMid = mid.clone().sub(cam.position);
    const forward = new Vector3();
    cam.getWorldDirection(forward);
    const behindCamera = toMid.dot(forward) <= 0;

    const pb = base.clone().project(cam);
    const pt = top.clone().project(cam);
    const pm = mid.clone().project(cam);
    const topY = Math.max(pb.y, pt.y);
    const bottomY = Math.min(pb.y, pt.y);
    const span = (topY - bottomY) / 2;
    // Share of the element's real height inside the frame, sampled along it: perspective (a low
    // camera, a wide lens) makes the projection uneven, so the ends alone would misjudge it.
    const toPoint = new Vector3();
    let inside = 0;
    const N = 48;
    for (let k = 0; k < N; k++) {
      toPoint.set(element.x, element.lift + ((k + 0.5) / N) * element.height, element.z);
      if (toPoint.clone().sub(cam.position).dot(forward) <= 0.05) continue;
      const q = toPoint.project(cam);
      if (Math.abs(q.y) <= 1 && Math.abs(q.x) <= 1.15) inside++;
    }
    const visible = inside / N;
    const inFrame = !behindCamera && Math.abs(pm.x) <= 1.15 && visible > 0.05;

    return { element, cx: pm.x, top: topY, bottom: bottomY, visible, span, depth, inFrame, behindCamera };
  });
}

/** Orbit angles and distance that put the camera at `position` looking at `target`. */
export function orbitFrom(position: Vector3, target: Vector3) {
  const d = position.clone().sub(target);
  const distance = Math.max(0.2, d.length());
  return {
    azimuth: MathUtils.radToDeg(Math.atan2(d.x, d.z)),
    elevation: MathUtils.radToDeg(Math.asin(MathUtils.clamp(d.y / distance, -1, 1))),
    distance,
  };
}

/** Signed angle (degrees, -180…180) from `a` to `b`. */
export function angleDelta(a: number, b: number) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Direction from an element toward the camera, as a yaw in degrees. */
export function yawTowardCamera(el: SceneElement, camPos: Vector3) {
  return MathUtils.radToDeg(Math.atan2(camPos.x - el.x, camPos.z - el.z));
}
