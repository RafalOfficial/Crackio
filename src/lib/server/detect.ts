import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { askText } from "@/lib/engines/refine";
import { DATA_DIR } from "./paths";

/**
 * Crackio's eyes for pointing at things (Retouch, Recast): a picture, and every separate thing in
 * it with a box around it; then, for one thing, its main parts (a pigeon's head, beak, eye, wings,
 * legs). It runs on Gemini 3.5 Flash on your Comfy key when you have one (the next text model that sees otherwise). Parts are found on a close, enlarged crop of the thing, which also tightens the
 * thing's own box. Answers are cached per picture.
 */

/** x0, y0, x1, y1 in 0–1000 of the picture (x from the left edge, y from the top). */
export type Box = [number, number, number, number];
export type Thing = { id: string; label: string; detail: string; box: Box };

const CACHE = path.join(DATA_DIR, "cache", "detect");
/** Bump when the prompts or the reading change, so pictures are looked at again. */
const VERSION = 2;
/** The sharpest-eyed model first: how precise the boxes are decides how precise the edit is. */
const EYES = ["comfy:google/gemini-3.5-flash"];

const THINGS = `You map a picture for a precise photo editor, so a person can point at any single thing in it and change just that.
Find the separate, editable things in the picture:
- Singular things: one person, one animal, one car, one lamp, one cup. Never one item for a group whose members can be told apart: three pigeons are three items.
- Whole things only (a person, not their shirt; a bike, not its wheel): their parts are found later.
- Include the main background regions (sky, wall, floor, road, grass, water, table top) and the distinct objects on them.
- Skip things too small or too hidden to edit.
- The most prominent first, up to 24.
For each: {"label": "one to three words, e.g. pigeon", "detail": "a short description that tells it apart from similar things: color, material, where it is, e.g. grey pigeon on the left", "box": [x0, y0, x1, y1]}.
The box hugs the visible pixels of that one thing, in 0-1000 coordinates of the whole picture (x0, x1 from the left edge; y0, y1 from the top edge).
Answer with JSON only: {"things": [...]}`;

const PARTS = (label: string, detail: string) => `The picture is a close crop around one thing: the ${label} (${detail}).
List its main visible parts that a person might want to change on their own: the parts anyone would name, not fine detail (no single feathers, strands, threads or wrinkles).
- For a person: hair, face, eyes, mouth, each piece of clothing, hands, shoes, bag, glasses, jewelry. For an animal: head, eyes, beak or mouth, body, wings, legs, feet, tail. For a car: body, windows, wheels, lights, doors, mirrors. For anything else, the same kind of parts.
- 3 to 10 parts, the most visible first. Skip parts that are hidden or too small to edit.
- Matching parts close together can be one item ("eyes"); far apart, separate ("left wing", "right wing").
- Only parts of this ${label}, nothing around it.
Also give the box of the whole ${label} as it shows in this crop.
Boxes hug the visible pixels, in 0-1000 coordinates of this crop (x0, x1 from the left edge; y0, y1 from the top edge).
Answer with JSON only: {"whole": [x0, y0, x1, y1], "parts": [{"label": "one to three words", "detail": "a short description, e.g. orange beak", "box": [x0, y0, x1, y1]}]}`;

async function cached<T>(key: string, make: () => Promise<T | null>): Promise<T | null> {
  const file = path.join(CACHE, `${createHash("sha1").update(`${VERSION}:${key}`).digest("hex")}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    /* not looked at yet */
  }
  const out = await make();
  if (out !== null) {
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(file, JSON.stringify(out)).catch(() => {});
  }
  return out;
}

const clamp = (n: number) => Math.round(Math.min(1000, Math.max(0, n)));

/** A box from the model's answer, in order and inside the picture; null when it isn't one. */
function toBox(raw: unknown): Box | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const n = raw.map((v) => Number(v));
  if (n.some((v) => !Number.isFinite(v))) return null;
  // Some answers come in 0–1; scale those up.
  const scale = n.every((v) => v >= 0 && v <= 1) ? 1000 : 1;
  const [a, b, c, d] = n.map((v) => clamp(v * scale));
  const box: Box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return box[2] - box[0] >= 4 && box[3] - box[1] >= 4 ? box : null;
}

const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
function overlap(a: Box, b: Box) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / (area(a) + area(b) - inter || 1);
}

function json(answer: string): Record<string, unknown> | null {
  try {
    return JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The things in an answer: labeled, boxed, and without repeats. */
function readThings(list: unknown, idPrefix: string, max: number): Thing[] {
  const out: Thing[] = [];
  for (const raw of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    const box = toBox(raw?.box);
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, 40) : "";
    if (!box || !label) continue;
    const detail = typeof raw.detail === "string" && raw.detail.trim() ? raw.detail.trim().slice(0, 120) : label;
    // The same thing twice (same name, nearly the same box) is one thing.
    if (out.some((t) => t.label.toLowerCase() === label.toLowerCase() && overlap(t.box, box) > 0.8)) continue;
    out.push({ id: `${idPrefix}${out.length + 1}`, label, detail, box });
    if (out.length >= max) break;
  }
  return out;
}

/** The separate things in a picture, most prominent first. */
export async function detectThings(file: string, signal?: AbortSignal): Promise<{ things: Thing[] } | null> {
  const bytes = await fs.readFile(file);
  return cached(`things:${createHash("sha1").update(bytes).digest("hex")}`, async () => {
    const answer = await askText({
      instructions: THINGS,
      text: "Find the things in this picture.",
      references: [{ path: file, label: "the picture" }],
      prefer: EYES,
      effort: "high",
      imageEdge: 1536,
      detail: "high",
      timeoutMs: 180_000,
      signal,
    }).catch(() => null);
    const j = answer ? json(answer) : null;
    if (!j) return null;
    return { things: readThings(j.things ?? j.objects, "t", 24) };
  });
}

/** The crop around a box that parts are looked for in: the box and a margin, a little square-ish, inside the picture. */
function cropAround(box: Box, width: number, height: number) {
  const [x0, y0, x1, y1] = [(box[0] / 1000) * width, (box[1] / 1000) * height, (box[2] / 1000) * width, (box[3] / 1000) * height];
  const w = x1 - x0;
  const h = y1 - y0;
  // A margin of a fifth (more for small things) so edges and the thing's own outline are in view.
  const pad = Math.max(w, h) * 0.2 + Math.min(width, height) * 0.02;
  const left = Math.max(0, Math.floor(x0 - pad));
  const top = Math.max(0, Math.floor(y0 - pad));
  const right = Math.min(width, Math.ceil(x1 + pad));
  const bottom = Math.min(height, Math.ceil(y1 + pad));
  return { left, top, width: Math.max(8, right - left), height: Math.max(8, bottom - top) };
}

/**
 * The main parts of one thing, found on an enlarged crop around it, with boxes in the whole
 * picture's coordinates; and the thing's own box, tightened from the close look.
 */
export async function detectParts(file: string, parent: { id: string; label: string; detail: string; box: Box }, signal?: AbortSignal): Promise<{ box: Box; parts: Thing[] } | null> {
  const bytes = await fs.readFile(file);
  const key = `parts:${createHash("sha1").update(bytes).digest("hex")}:${parent.box.map(Math.round).join(",")}:${parent.label.toLowerCase()}`;
  return cached(key, async () => {
    const img = sharp(bytes, { failOn: "none" }).rotate();
    const meta = await img.metadata();
    const W = meta.autoOrient?.width ?? meta.width ?? 0;
    const H = meta.autoOrient?.height ?? meta.height ?? 0;
    if (!W || !H) return null;
    const crop = cropAround(parent.box, W, H);
    // Small things are enlarged so the model sees them up close.
    const long = Math.max(crop.width, crop.height);
    const target = Math.min(1536, Math.max(1024, long));
    const data = await img.extract(crop).resize({ width: crop.width >= crop.height ? target : undefined, height: crop.height > crop.width ? target : undefined, kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
    await fs.mkdir(CACHE, { recursive: true });
    const tmp = path.join(CACHE, `crop-${createHash("sha1").update(key).digest("hex")}.jpg`);
    await fs.writeFile(tmp, data);
    try {
      const answer = await askText({
        instructions: PARTS(parent.label, parent.detail),
        text: `Find the main parts of the ${parent.label}.`,
        references: [{ path: tmp, label: `a close crop of the ${parent.label}` }],
        prefer: EYES,
        effort: "high",
        imageEdge: 1536,
        detail: "high",
        timeoutMs: 150_000,
        signal,
      }).catch(() => null);
      const j = answer ? json(answer) : null;
      if (!j) return null;
      // Crop coordinates (0–1000 of the crop) back into the whole picture's.
      const back = (b: Box): Box => [
        clamp(((crop.left + (b[0] / 1000) * crop.width) / W) * 1000),
        clamp(((crop.top + (b[1] / 1000) * crop.height) / H) * 1000),
        clamp(((crop.left + (b[2] / 1000) * crop.width) / W) * 1000),
        clamp(((crop.top + (b[3] / 1000) * crop.height) / H) * 1000),
      ];
      const whole = toBox(j.whole);
      // The close look's box for the whole thing, unless it wandered off to something else.
      const tight = whole ? back(whole) : null;
      const box = tight && overlap(tight, parent.box) > 0.35 ? tight : parent.box;
      const parts = readThings(j.parts, `${parent.id}.`, 10)
        .map((p) => ({ ...p, box: back(p.box) }))
        // A "part" as big as the whole thing is the thing again.
        .filter((p) => area(p.box) < area(box) * 0.92);
      return { box, parts };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
}
