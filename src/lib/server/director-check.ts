import "server-only";
import sharp from "sharp";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { getGeneration, saveGeneration } from "./db";
import { urlToPath } from "./media";
import { estimateDepth } from "./vision";
import { footprints } from "@/lib/director/layout";
import type { Scene } from "@/lib/director/types";

/**
 * How close a Director take came to its plan, measured, not judged by eye:
 * - where each subject landed and how big it is: its box in the result (found by a vision model) against its
 *   silhouette in the plan (the stand-in, projected through the shot's camera);
 * - the camera itself: the depth of the result (read by the local depth model) against the depth of the planned set,
 *   compared as a rank correlation, so the scale doesn't matter, only what's near and far where.
 */
type Box = [number, number, number, number]; // x0, y0, x1, y1 as shares of the frame (0…1)

export type TakeCheck = {
  subjects: { id: string; name: string; planned: Box; found: Box | null; iou: number; shift: number; size: number }[];
  /** Rank correlation of the result's depth with the plan's, -1…1. */
  depth: number | null;
  /** 0…100: how close the take is to the plan overall. */
  score: number;
  checkedAt: number;
};

const GRID_W = 48;
const GRID_H = 27;

/** A depth picture (white = near) on a coarse grid, by area. */
async function plannedDepth(file: string) {
  const { data } = await sharp(file).greyscale().resize(GRID_W, GRID_H, { fit: "fill", kernel: "cubic" }).raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data, (v) => v / 255);
}

async function resultDepth(file: string) {
  const d = await estimateDepth(file);
  const bin = Buffer.from(d.data, "base64");
  const full = new Float32Array(d.width * d.height);
  for (let i = 0; i < full.length; i++) full[i] = bin.readUInt16LE(i * 2) / 65535;
  const out = new Float32Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx / GRID_W) * d.width);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / GRID_W) * d.width));
      const y0 = Math.floor((gy / GRID_H) * d.height);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / GRID_H) * d.height));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += full[y * d.width + x];
      out[gy * GRID_W + gx] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Spearman's rank correlation. */
function rankCorrelation(a: Float32Array, b: Float32Array) {
  const rank = (v: Float32Array) => {
    const idx = Array.from(v.keys()).sort((i, j) => v[i] - v[j]);
    const r = new Float32Array(v.length);
    idx.forEach((i, k) => (r[i] = k));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) ** 2;
    db += (rb[i] - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}

const iou = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const area = (x: Box) => (x[2] - x[0]) * (x[3] - x[1]);
  return inter / Math.max(1e-6, area(a) + area(b) - inter);
};

const FIND = `You find things in a picture and give their bounding boxes.
For each thing listed, give the smallest box around all of it that is visible in the picture, as [ymin, xmin, ymax, xmax] on a 0 to 1000 scale (0,0 is the top-left corner, 1000,1000 the bottom-right). If it isn't in the picture, give null.
Answer with JSON only: {"boxes": {"<id>": [ymin, xmin, ymax, xmax] or null, ...}}`;

async function findBoxes(file: string, things: { id: string; what: string }[]) {
  const answer = await askText({
    instructions: FIND,
    text: things.map((t) => `${t.id}: ${t.what}`).join("\n"),
    references: [{ path: file, label: "the picture" }],
    imageEdge: 1024,
    detail: "high",
    effort: "low",
    timeoutMs: 60_000,
  }).catch(() => null);
  const raw = answer ? jsonObject<{ boxes?: Record<string, unknown> }>(answer) : null;
  const out = new Map<string, Box | null>();
  for (const t of things) {
    const b = raw?.boxes?.[t.id];
    out.set(t.id, Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number") ? [b[1] / 1000, b[0] / 1000, b[3] / 1000, b[2] / 1000] : null);
  }
  return out;
}

/** Check a finished Director take against its plan, and keep the result on the take. */
export async function checkTake(id: string): Promise<TakeCheck> {
  const gen = getGeneration(id);
  if (!gen || gen.tool !== "director" || gen.status !== "done" || !gen.outputs[0]) throw new Error("Only a finished Director take can be checked.");
  const result = urlToPath(gen.outputs[0].url);
  const scene = gen.params?.scene as Scene | undefined;
  const comp = gen.params?.comp as { boxes?: { id: string; box: [number, number, number, number] }[] } | undefined;
  const depthUrl = gen.params?.depthUrl;
  if (!result || !scene) throw new Error("This take has no plan to check against.");
  const plannedSize = await sharp(urlToPath(String(gen.params?.blockingUrl ?? gen.params?.guideUrl ?? "")) ?? result).metadata();
  const W = plannedSize.width ?? 1536;
  const H = plannedSize.height ?? 864;

  // The stand-ins' silhouettes the page measured; takes from before that, each subject's footprint from the scene.
  const measured = comp?.boxes?.map((b) => ({ id: b.id, box: [b.box[0] / W, b.box[1] / H, b.box[2] / W, b.box[3] / H] as Box }));
  const spots = measured ?? footprints(scene).flatMap((f) => (f.box ? [{ id: f.id, box: f.box }] : []));
  const subjects = spots.flatMap((b) => {
    const el = scene.elements.find((e) => e.id === b.id);
    // In the frame only: what the plan shows of it.
    const planned: Box = [Math.max(0, b.box[0]), Math.max(0, b.box[1]), Math.min(1, b.box[2]), Math.min(1, b.box[3])];
    if (!el || planned[2] - planned[0] < 0.01 || planned[3] - planned[1] < 0.01) return [];
    return [{ el, planned }];
  });
  const [found, depth] = await Promise.all([
    findBoxes(
      result,
      subjects.map(({ el }) => ({ id: el.id, what: el.read?.noun ?? `the ${el.kind} (${el.name})` })),
    ),
    typeof depthUrl === "string" && urlToPath(depthUrl)
      ? Promise.all([plannedDepth(urlToPath(depthUrl)!), resultDepth(result)]).then(([a, b]) => rankCorrelation(a, b)).catch(() => null)
      : Promise.resolve(null),
  ]);

  const rows = subjects.map(({ el, planned }) => {
    const box = found.get(el.id) ?? null;
    if (!box) return { id: el.id, name: el.name, planned, found: null, iou: 0, shift: 1, size: 1 };
    const cx = (b: Box) => (b[0] + b[2]) / 2;
    const cy = (b: Box) => (b[1] + b[3]) / 2;
    const shift = Math.hypot(cx(box) - cx(planned), cy(box) - cy(planned));
    const size = Math.abs(Math.log(Math.max(0.01, box[3] - box[1]) / Math.max(0.01, planned[3] - planned[1])));
    return { id: el.id, name: el.name, planned, found: box, iou: iou(box, planned), shift, size };
  });
  // Placement (overlap), size (how far the camera is) and the camera's view of the whole set (depth), weighed equally.
  const placement = rows.length ? rows.reduce((s, r) => s + r.iou, 0) / rows.length : 1;
  const sizing = rows.length ? rows.reduce((s, r) => s + Math.max(0, 1 - r.size / Math.log(2)), 0) / rows.length : 1;
  const camera = depth === null ? placement : Math.max(0, depth);
  const check: TakeCheck = { subjects: rows, depth, score: Math.round(((placement + sizing + camera) / 3) * 100), checkedAt: Date.now() };
  const now = getGeneration(id);
  if (now) saveGeneration({ ...now, params: { ...now.params, check } });
  return check;
}
