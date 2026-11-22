import { MathUtils } from "three";
import { sampleDepth, unitDepth, type DepthMap } from "./reconstruct";
import type { PlaceView } from "./types";

/**
 * The place photo's view once Small extend grew it (server/grow-photo): the same camera with a wider lens (the photo is
 * the middle of the grown one, so tan(fov/2) grows by as much as the picture did), and the depth range that puts what
 * the photo shows where the set had it. The grown photo's depth map is Depth Anything's again, on the bigger picture,
 * so its 0…1 are another picture's: 1/z is a straight line in its disparity (`unitDepth`), fitted through the photo's
 * part against the old set's distances, the worst fifth left out twice (what the bigger picture saw differently).
 */
export function grownView(view: PlaceView, before: DepthMap, after: DepthMap, grow: { x: number; y: number }): PlaceView {
  const fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(view.fov / 2)) * grow.y));
  const ratio = view.far / view.near;
  let pts: { d: number; w: number }[] = [];
  for (let j = 0; j < 32; j++) {
    for (let i = 0; i < 48; i++) {
      const u = 0.03 + (i / 47) * 0.94;
      const v = 0.03 + (j / 31) * 0.94;
      const z = unitDepth(sampleDepth(before, u, v), ratio) * view.near;
      if (!(z > 0) || !Number.isFinite(z)) continue;
      pts.push({ d: sampleDepth(after, 0.5 + (u - 0.5) / grow.x, 0.5 + (v - 0.5) / grow.y), w: 1 / z });
    }
  }
  const line = (ps: { d: number; w: number }[]) => {
    const n = ps.length;
    const md = ps.reduce((s, p) => s + p.d, 0) / n;
    const mw = ps.reduce((s, p) => s + p.w, 0) / n;
    let sdd = 0;
    let sdw = 0;
    for (const p of ps) {
      sdd += (p.d - md) ** 2;
      sdw += (p.d - md) * (p.w - mw);
    }
    const b = sdd > 1e-9 ? sdw / sdd : 0;
    return { a: mw - b * md, b };
  };
  if (pts.length < 100) return { ...view, fov };
  let fit = line(pts);
  for (let k = 0; k < 2; k++) {
    const off = pts.map((p) => Math.abs(p.w - (fit.a + fit.b * p.d)));
    const cut = [...off].sort((x, y) => x - y)[Math.floor(off.length * 0.8)];
    pts = pts.filter((_, i) => off[i] <= cut);
    fit = line(pts);
  }
  // Disparity 1 is the nearest (1/near = a + b), 0 the farthest (1/far = a); farthest at most 200 times the nearest.
  if (!(fit.b > 0)) return { ...view, fov };
  const near = 1 / (fit.a + fit.b);
  const far = 1 / Math.max(fit.a, (fit.a + fit.b) / 200);
  return near > 0 && far > near ? { ...view, fov, near, far } : { ...view, fov };
}
