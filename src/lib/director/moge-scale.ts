import { sampleDepth, unitDepth, type DepthMap } from "./reconstruct";
import type { PlaceView } from "./types";

/**
 * The challenge winner's 3D World measures a photo with MoGe (3, ViT-G) in meters; the Director's set has its own
 * units (its depth, scaled so the photo's camera stands 1.6 above its floor). These tie the two, so a Camera framed on
 * the set lands on the same picture in their render (server/director-real `studioState`).
 */

/**
 * MoGe's meters per set unit for one photo: the median of MoGe's distance over the set's, pixel for pixel on a 64×32
 * grid, MoGe's sky (and what it couldn't measure, at its far end) left out. An astronaut test photo: 0.45.
 */
export function mogeMeters(set: DepthMap, view: PlaceView, moge: DepthMap, near: number, far: number) {
  const ratio = view.far / view.near;
  const found: number[] = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const [u, v] = [(x + 0.5) / 64, (y + 0.5) / 32];
      const dm = sampleDepth(moge, u, v);
      if (dm < 0.02) continue;
      const zMoge = 1 / (dm / near + (1 - dm) / far);
      const zSet = unitDepth(sampleDepth(set, u, v), ratio) * view.near;
      if (zSet > 0 && Number.isFinite(zMoge)) found.push(zMoge / zSet);
    }
  }
  if (found.length < 50) return 1;
  found.sort((p, q) => p - q);
  return Math.max(0.05, Math.min(20, found[Math.floor(found.length / 2)]));
}

/** The set's view of the photo with MoGe's depths (its near and far in set units): what the Director's 3D photo is built on. */
export const mogeView = (view: PlaceView, near: number, far: number, meters: number): PlaceView => ({ ...view, near: near / meters, far: far / meters });

/** Each place photo's MoGe meters per set unit, once its 3D photo is built (Stage3D PhotoSet), for Shoot to send. */
export const photoMeters = new Map<string, number>();

/**
 * How deep a measured photo is for how far it is: the distance between its nearest and its farthest twentieth over its
 * middle distance. Places come out about 0.8 and up (an astronaut on a beach, a street); a flat canvas near 0.
 */
function spreadOf(depths: number[]) {
  if (depths.length < 50) return null;
  depths.sort((p, q) => p - q);
  const at = (q: number) => depths[Math.floor(q * (depths.length - 1))];
  return (at(0.95) - at(0.05)) / Math.max(1e-6, at(0.5));
}

/** The depth spread of a MoGe-3 mesh (server/photo-mesh: meters in the photo camera's frame, looking down -z). */
export function meshSpread(positions: ArrayLike<number>) {
  const count = Math.floor(positions.length / 3);
  const step = Math.max(1, Math.floor(count / 4000));
  const depths: number[] = [];
  for (let i = 0; i < count; i += step) {
    const z = -positions[i * 3 + 2];
    if (z > 0 && Number.isFinite(z)) depths.push(z);
  }
  return spreadOf(depths);
}

/** The depth spread of MoGe-2's measuring of a photo (server/vision `geometry`), its sky left out. */
export function mapSpread(moge: DepthMap, near: number, far: number) {
  const depths: number[] = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const dm = sampleDepth(moge, (x + 0.5) / 64, (y + 0.5) / 32);
      if (dm < 0.02) continue;
      const z = 1 / (dm / near + (1 - dm) / far);
      if (z > 0 && Number.isFinite(z)) depths.push(z);
    }
  }
  return spreadOf(depths);
}

/**
 * Whether MoGe-3 measured a photo as a flat picture where MoGe-2 saw a place in it. A painted test beach (an anime
 * boy on an upturned car, Nov 13) came back from MoGe-3 as a canvas 4.5 m away and 0.05 deep, where MoGe-2 had 0.38 of
 * relief: on the stage it turned 3D, then flat half a minute later when the mesh came. A flat thing that is flat (a
 * poster, a wall) is flat to both, and stays as MoGe-3 has it.
 */
export const meshFlat = (mesh: number | null, mogeTwo: number | null) => mesh !== null && mogeTwo !== null && mesh < 0.15 && mogeTwo >= Math.max(0.15, 2 * mesh);

/**
 * Place photos whose MoGe-3 mesh the stage left out for being flat (meshFlat): Shoot sends it, and a moved Camera is
 * then re-shot from the stage's own view of the photo in 3D instead of the winner's render, which measures with MoGe-3
 * again and would turn it back into a flat card.
 */
export const flatPhotos = new Set<string>();

/**
 * MoGe's meters per set unit from the MoGe-3 mesh itself (server/photo-mesh): each sampled point's distance along the
 * view axis (-z, the photo camera's frame) over the set's depth at its pixel (`uv`, top-left origin), the median.
 */
export function meshMeters(positions: ArrayLike<number>, uvs: ArrayLike<number>, set: DepthMap, view: PlaceView) {
  const ratio = view.far / view.near;
  const count = Math.floor(positions.length / 3);
  const step = Math.max(1, Math.floor(count / 4000));
  const found: number[] = [];
  for (let i = 0; i < count; i += step) {
    const z = -positions[i * 3 + 2];
    if (!(z > 0)) continue;
    const zSet = unitDepth(sampleDepth(set, uvs[i * 2], uvs[i * 2 + 1]), ratio) * view.near;
    if (zSet > 0) found.push(z / zSet);
  }
  if (found.length < 50) return 1;
  found.sort((p, q) => p - q);
  return Math.max(0.05, Math.min(20, found[Math.floor(found.length / 2)]));
}
