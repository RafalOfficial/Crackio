import { Vector3 } from "three";
import type { Scene, SceneElement } from "./types";
import { shotCamera } from "./camera";

/** One box per element, in the 0–1000 `[ymin, xmin, ymax, xmax]` grid FLUX 3 layouts use. */
export type LayoutBox = { id: string; bbox: [number, number, number, number]; desc: string };

/** Typical width-to-height ratio of each kind of subject, for cutouts without trim data. */
const WIDTH_RATIO: Record<SceneElement["kind"], number> = {
  person: 0.34,
  animal: 1.05,
  object: 0.95,
  product: 0.62,
  vehicle: 2.6,
};

/** Each element's footprint in the frame as shares of it (x0, y0, x1, y1; past 0…1 when cut off), or null behind the camera. */
export function footprints(scene: Scene) {
  const cam = shotCamera(scene);
  const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  return scene.elements.map((el) => {
    const ratio = el.image && !el.image.cutout ? el.image.width / el.image.height : WIDTH_RATIO[el.kind];
    const halfW = (el.height * ratio) / 2;
    const corners = [
      [-halfW, el.lift],
      [halfW, el.lift],
      [-halfW, el.lift + el.height],
      [halfW, el.lift + el.height],
    ].map(([dx, y]) => new Vector3(el.x + right.x * dx, y, el.z + right.z * dx).project(cam));
    if (corners.some((p) => p.z > 1)) return { id: el.id, box: null }; // behind the camera
    const xs = corners.map((p) => (p.x + 1) / 2);
    const ys = corners.map((p) => (1 - p.y) / 2);
    return { id: el.id, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number] };
  });
}

/** Project every element's footprint into the frame and describe it, for layout-aware models. */
export function layoutBoxes(scene: Scene, imageIndex: Map<string, number> = new Map()): LayoutBox[] {
  const boxes: LayoutBox[] = [];
  const spots = new Map(footprints(scene).map((f) => [f.id, f.box]));
  scene.elements.forEach((el) => {
    const spot = spots.get(el.id);
    if (!spot) return;
    const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000);
    const bbox: LayoutBox["bbox"] = [clamp(spot[1]), clamp(spot[0]), clamp(spot[3]), clamp(spot[2])];
    if (bbox[2] - bbox[0] < 8 || bbox[3] - bbox[1] < 8) return; // fully outside the frame
    const idx = imageIndex.get(el.id);
    const parts = [el.name, el.look?.trim(), el.action?.trim(), idx ? `as in image ${idx}` : ""].filter(Boolean);
    boxes.push({ id: `box_${boxes.length + 1}`, bbox, desc: parts.join(", ") });
  });
  return boxes;
}
