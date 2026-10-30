import { MathUtils, Vector3 } from "three";
import type { ElementKind, Scene, SceneElement } from "./types";
import { angleDelta, frameElements, shotCamera, yawTowardCamera } from "./camera";
import { poseOf } from "./standin";

/**
 * How the shot's camera sees each subject: from which side, how far above or below, how much of it, from how close.
 * Each subject is drawn fresh from exactly this angle (from its own photo), then placed where its stand-in stands,
 * so the picture is put together from pieces that are already right before the last pass blends them.
 */
export type SubjectView = {
  id: string;
  /** Where the camera is around the subject, degrees: 0 = in front of it, -90 = at its right side, 90 = at its left, ±180 = behind. */
  around: number;
  /** Degrees the camera is above (+) or below (-) the subject's middle. */
  above: number;
  /** Share of the subject's height inside the frame, from its top (1 = all of it). */
  visible: number;
  /** Meters from the camera to the subject's middle. */
  distance: number;
  /** Which way its front points in the frame. */
  facing: "toward" | "away" | "left" | "right";
};

const middle = (el: SceneElement) => el.lift + el.height * (el.kind === "person" ? 0.72 : 0.5);

export function subjectViews(scene: Scene): SubjectView[] {
  const cam = shotCamera(scene);
  const camRight = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  return frameElements(scene, cam)
    .filter((f) => f.inFrame)
    .map(({ element: el, visible, top, bottom }) => {
      const around = angleDelta(el.yaw, yawTowardCamera(el, cam.position));
      const flat = Math.hypot(cam.position.x - el.x, cam.position.z - el.z);
      const above = MathUtils.radToDeg(Math.atan2(cam.position.y - middle(el), Math.max(0.01, flat)));
      const yaw = MathUtils.degToRad(el.yaw);
      const side = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).dot(camRight);
      const facing = Math.abs(around) < 35 ? "toward" : Math.abs(around) > 145 ? "away" : side > 0 ? "right" : "left";
      // Cut by the frame's bottom edge (a close-up): what shows is the part from its top down.
      const fromTop = bottom < -1 && top > -1 ? Math.min(1, (top + 1) / Math.max(0.001, top - bottom)) : visible;
      return { id: el.id, around, above, visible: fromTop, distance: cam.position.distanceTo(new Vector3(el.x, middle(el), el.z)), facing };
    });
}

/**
 * Which way it's turned, in frame terms models can't read backwards: "turned three-quarters toward frame left: we see
 * their front and their left side". The camera on a subject's left (around > 0) sees it facing frame left.
 */
export function turnPhrase(around: number, kind: ElementKind) {
  const a = Math.abs(around);
  const dir = around > 0 ? "left" : "right";
  const own = kind === "person" || kind === "animal" ? "their" : "its";
  const side = `${own} ${dir} side`;
  if (kind === "vehicle" || kind === "product" || kind === "object") {
    if (a < 22.5) return "seen head-on from the front, its front facing the camera";
    if (a < 67.5) return `in a three-quarter front view, its front pointing toward frame ${dir}: we see its front and ${side}`;
    if (a < 112.5) return `exactly side-on, its front pointing to frame ${dir}: we see only ${side}`;
    if (a < 157.5) return `in a three-quarter rear view, its front pointing away and toward frame ${dir}: we see its back and ${side}`;
    return "seen from directly behind, its back facing the camera";
  }
  if (a < 22.5) return "facing the camera, seen straight from the front";
  if (a < 67.5) return `turned three-quarters toward frame ${dir}: we see ${own} front and ${side}`;
  if (a < 112.5) return `in profile, facing frame ${dir}: we see only ${side}`;
  if (a < 157.5) return `turned away from the camera toward frame ${dir}: we see ${own} back and ${side}`;
  return "with their back to the camera, seen from directly behind";
}

function abovePhrase(above: number) {
  const a = Math.round(Math.abs(above) / 5) * 5;
  if (above > 50) return `the camera high above, looking steeply down at about ${a} degrees`;
  if (above > 22) return `the camera above, looking down at about ${a} degrees`;
  if (above > 8) return `the camera slightly above, looking down about ${a} degrees`;
  if (above > -8) return "the camera at eye level";
  if (above > -25) return `the camera slightly below, looking up about ${a} degrees`;
  return `the camera low below, looking steeply up at about ${a} degrees`;
}

const KEEP: Record<ElementKind, string> = {
  person: "their face, hair, skin tone, build, clothing, accessories and colors",
  animal: "its breed, coat colors, markings and build",
  vehicle: "its exact make and model, body shape, color, wheels and lights",
  product: "its exact shape, proportions, materials, colors, label and lettering",
  object: "its shape, materials and colors",
};

const NOUN: Record<ElementKind, string> = { person: "person", animal: "animal", vehicle: "vehicle", product: "product", object: "object" };

/**
 * The prompt that draws one subject from the shot's angle, from its photo (image 1): always all of it, head to feet
 * (the frame crops it where the shot does), on a plain background so it can be cut out, lit from the shot's side.
 */
export function viewPrompt(el: SceneElement, view: Pick<SubjectView, "around" | "above">, light: string) {
  const noun = NOUN[el.kind];
  const whole = el.kind === "person" ? "the whole person in view from the top of the head to the feet, with a little space around" : `the whole ${noun} in view with a little space around it`;
  const pose = el.kind === "person" || el.kind === "animal" ? (el.action?.trim() ? `${el.action.trim()}.` : `${poseOf(el)[0].toUpperCase()}${poseOf(el).slice(1)} naturally.`) : "";
  return [
    `Image 1 shows a ${noun}${el.read?.noun ? `: ${el.read.noun}` : ""}. Make a new photograph of exactly this ${noun} from a different camera angle.`,
    `New angle: ${turnPhrase(view.around, el.kind)}; ${abovePhrase(view.above)}.`,
    `Framing: ${whole}.`,
    pose,
    `Keep ${KEEP[el.kind]} exactly as in image 1; only the angle${el.kind === "person" || el.kind === "animal" ? " and pose" : ""} change.`,
    `${light}.`,
    "Plain, evenly lit light gray studio background, nothing else in the picture, no text.",
  ]
    .filter(Boolean)
    .join(" ");
}
