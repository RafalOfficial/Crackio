import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { fitPlaceView, photoCamera, photoFov, surfacePoint, type DepthMap } from "@/lib/director/reconstruct";
import type { PlaceView } from "@/lib/director/types";
import type { SubjectMask } from "@/lib/director/vision";
import { subjectAnchor } from "./surface";

/**
 * The Angles camera. The photo becomes Director's soft 3D set (see reconstruct.ts) and the camera
 * orbits a point of it (the main subject unless you pick another), starting exactly where the photo
 * was taken. Pure math, shared by the 3D view, the guide render and the prompt.
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

const fitted = new WeakMap<DepthMap, PlaceView>();

/** How the photo was taken, worked out once per depth map (the 3D view, controls and guide all ask). */
export function placeFor(depth: DepthMap, aspect: number) {
  let place = fitted.get(depth);
  if (!place) {
    place = fitPlaceView(depth, aspect);
    fitted.set(depth, place);
  }
  return place;
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
