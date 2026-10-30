import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { allCharacters } from "./cast-store";
import { urlToPath } from "./media";
import { LEGACY_SHEET_VIEWS, type Character } from "@/lib/cast/types";

/** A Cast sheet's views: which ones it shows, and each cut out on its own. */

/** The views on a character's sheet, front first (left to right, or front and back above the side on a long thing's). */
export const viewsOf = (c: Pick<Character, "views">) => c.views ?? LEGACY_SHEET_VIEWS;

type Box = { left: number; top: number; width: number; height: number };
type Look = { width: number; height: number; w: number; h: number; px: (x: number, y: number, c: number) => number };

/** The sheet at 512 px wide, as raw pixels to look for figures in. */
async function look(src: Buffer): Promise<Look> {
  const { width = 0, height = 0 } = await sharp(src).metadata();
  const w = 512;
  const h = Math.max(1, Math.round((height / Math.max(1, width)) * w));
  const { data } = await sharp(src).resize(w, h).removeAlpha().toColourspace("srgb").blur(0.6).raw().toBuffer({ resolveWithObject: true });
  return { width, height, w, h, px: (x, y, c) => data[(y * w + x) * 3 + c] };
}

/** Three views side by side: cut in the gaps between the figures. */
function columns({ width, height, w, h, px }: Look): Box[] {
  // A figure differs in color from its column's own backdrop (the band above it: sheets leave room over every figure),
  // or has edges; a vignette, a gradient or a pale car against pale gray doesn't fool both. Floor shadows are left out.
  const top = Math.max(2, Math.round(h * 0.06));
  const ink = (x: number) => {
    const bg = [0, 1, 2].map((c) => {
      let s = 0;
      for (let y = 0; y < top; y++) s += px(x, y, c);
      return s / top;
    });
    let n = 0;
    for (let y = top; y < Math.round(h * 0.86); y++) {
      const far = Math.abs(px(x, y, 0) - bg[0]) + Math.abs(px(x, y, 1) - bg[1]) + Math.abs(px(x, y, 2) - bg[2]);
      const edge = Math.abs(px(x, y, 1) - px(x, y - 1, 1)) + (x > 0 ? Math.abs(px(x, y, 1) - px(x - 1, y, 1)) : 0);
      if (far > 40 || edge > 16) n++;
    }
    return n;
  };
  const raw = Array.from({ length: w }, (_, x) => ink(x));
  const profile = raw.map((_, x) => {
    const near = raw.slice(Math.max(0, x - 2), x + 3);
    return near.reduce((a, b) => a + b, 0) / near.length;
  });
  const emptiest = (from: number, to: number) => {
    let cut = Math.round(w * from);
    for (let x = Math.round(w * from); x <= Math.round(w * to); x++) if (profile[x] < profile[cut]) cut = x;
    return cut;
  };
  // The two widest quiet stretches between figures (a car's side view is wide and pushes the gaps off-center); the
  // quietest column on each side of the middle when the figures nearly touch.
  const quiet = Math.max(2, h * 0.01);
  const gaps: { from: number; to: number }[] = [];
  for (let x = 1; x < w; x++) {
    if (profile[x] > quiet) continue;
    const from = x;
    while (x < w && profile[x] <= quiet) x++;
    if (from > w * 0.03 && x < w * 0.97) gaps.push({ from, to: x });
  }
  const widest = [...gaps]
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .slice(0, 2)
    .map((gp) => Math.round((gp.from + gp.to) / 2))
    .sort((a, b) => a - b);
  const mids = widest.length === 2 && widest[1] - widest[0] > w * 0.15 ? widest : [emptiest(0.15, 0.5), emptiest(0.5, 0.85)];
  const cuts = [0, ...mids.map((x) => Math.round((x / w) * width)), width];
  return [0, 1, 2].map((i) => ({ left: cuts[i], top: 0, width: Math.max(1, cuts[i + 1] - cuts[i]), height }));
}

/**
 * A long thing's sheet (a car, a van, a boat): front and back on the top row, the side across the whole row below,
 * cut at the quiet band between the rows and between the two on top. Null when it wasn't drawn that way: a band only
 * counts with two figures above it and one long one below (on the 27 sheets in Crackio's cast, Oct 28 2026, it found
 * all four two-row sheets, one with a band a single row high and one on a heavily vignetted backdrop, and none of the rest).
 */
function rows({ width, height, w, h, px }: Look): Box[] | null {
  // A figure differs from its column's backdrop (the band above everything) and its row's (the row's two ends), or has
  // edges: a backdrop shaded from top to bottom, or darker at the sides, differs from one of them only.
  const top = Math.max(2, Math.round(h * 0.04));
  const end = Math.max(2, Math.round(w * 0.02));
  const colBg = Array.from({ length: w }, (_, x) =>
    [0, 1, 2].map((c) => {
      let s = 0;
      for (let y = 0; y < top; y++) s += px(x, y, c);
      return s / top;
    }),
  );
  const ink = new Uint8Array(w * h);
  const edges = new Uint8Array(w * h);
  for (let y = top; y < h; y++) {
    const rowBg = [0, 1, 2].map((c) => {
      let s = 0;
      for (let x = 0; x < end; x++) s += px(x, y, c) + px(w - 1 - x, y, c);
      return s / (2 * end);
    });
    for (let x = 1; x < w; x++) {
      const far = (bg: number[]) => Math.abs(px(x, y, 0) - bg[0]) + Math.abs(px(x, y, 1) - bg[1]) + Math.abs(px(x, y, 2) - bg[2]);
      const edge = Math.abs(px(x, y, 1) - px(x, y - 1, 1)) + Math.abs(px(x, y, 1) - px(x - 1, y, 1));
      if (edge > 16) edges[y * w + x] = 1;
      if (edge > 16 || (far(colBg[x]) > 40 && far(rowBg) > 40)) ink[y * w + x] = 1;
    }
  }
  const rowInk = Array.from({ length: h }, (_, y) => {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x];
    return n;
  });
  const sorted = rowInk.slice(top).sort((a, b) => a - b);
  const quietRow = Math.max(3, w * 0.012, sorted[Math.floor(sorted.length / 2)] * 0.06);
  const sum = (a: number, b: number) => rowInk.slice(a, b).reduce((s, n) => s + n, 0);
  const down = (y0: number, y1: number, mask = ink) =>
    Array.from({ length: w }, (_, x) => {
      let n = 0;
      for (let y = y0; y < y1; y++) n += mask[y * w + x];
      return n;
    });

  type Band = { from: number; to: number; split: { from: number; to: number } };
  const bands: Band[] = [];
  for (let y = Math.round(h * 0.28); y <= Math.round(h * 0.75); y++) {
    if (rowInk[y] > quietRow) continue;
    const from = y;
    while (y < h - 1 && rowInk[y + 1] <= quietRow) y++;
    const to = y;
    if (sum(top, from) < w * h * 0.05 || sum(to + 1, h) < w * h * 0.05) continue;
    // Above: front and back, with a quiet stretch of columns between them near the middle (edges only: a studio
    // light pooled between the two reads as a figure to the backdrop test).
    const above = down(top, from, edges);
    const quiet = Math.max(2, (from - top) * 0.02);
    let split: Band["split"] | null = null;
    for (let x = 1; x < w; x++) {
      if (above[x] > quiet) continue;
      const start = x;
      while (x < w && above[x] <= quiet) x++;
      const mid = (start + x) / 2;
      if (mid > w * 0.25 && mid < w * 0.75 && (!split || x - start > split.to - split.from)) split = { from: start, to: x };
    }
    if (!split) continue;
    // Below: one long side view, unbroken across most of the width.
    const below = down(to + 1, h);
    const solid = Math.max(2, (h - to) * 0.02);
    let longest = 0;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = below[x] > solid ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    if (longest >= w * 0.45) bands.push({ from, to, split });
  }
  if (!bands.length) return null;
  const off = (b: Band) => Math.abs((b.from + b.to) / 2 - h / 2);
  const best = bands.sort((a, b) => b.to - b.from - (a.to - a.from) || off(a) - off(b))[0];
  const X = Math.round(((best.split.from + best.split.to) / 2 / w) * width);
  const Y = Math.round(((best.from + best.to) / 2 / h) * height);
  return [
    { left: 0, top: 0, width: Math.max(1, X), height: Math.max(1, Y) },
    { left: 0, top: Y, width, height: Math.max(1, height - Y) },
    { left: X, top: 0, width: Math.max(1, width - X), height: Math.max(1, Y) },
  ];
}

/** The Cast member a sheet belongs to (callers like the Director only have the file). */
function ownerOf(sheetPath: string) {
  const name = path.basename(sheetPath);
  return allCharacters().find((c) => c.sheet && path.basename(c.sheet) === name);
}

/** Whether a finished sheet came out in two rows, as a long thing's sheet is asked to (a model may still draw a row of three). */
export async function sheetLayoutOf(sheetPath: string): Promise<Character["sheetLayout"]> {
  return rows(await look(await fs.readFile(sheetPath))) ? "rows" : undefined;
}

/* ------------------------------------------------------------------ views drawn one by one */

type Rgb = { r: number; g: number; b: number };

/**
 * Where the subject is in a picture of it alone on a plain backdrop, and the backdrop's color. The subject is where the
 * picture has edges stronger than the backdrop's own grain (its outline, its details); a backdrop shaded toward the
 * corners, a soft floor shadow or paper texture has none that strong. Rows and columns count from two such pixels on,
 * and the subject is the longest stretch of them (small gaps allowed), so a stray speck doesn't stretch the box.
 */
async function subject(src: Buffer): Promise<{ box: Box; backdrop: Rgb }> {
  const { width, height, w, h, px } = await look(src);
  const grad = (x: number, y: number) => Math.abs(px(x, y, 1) - px(x, y - 1, 1)) + Math.abs(px(x, y, 1) - px(x - 1, y, 1));
  // The backdrop: the picture's border, its color and how grainy it is.
  const border: number[][] = [];
  const grain: number[] = [];
  for (let x = 1; x < w; x++)
    for (const y of [1, 2, h - 2, h - 1]) {
      border.push([px(x, y, 0), px(x, y, 1), px(x, y, 2)]);
      grain.push(grad(x, y));
    }
  for (let y = 1; y < h; y++)
    for (const x of [1, 2, w - 2, w - 1]) {
      border.push([px(x, y, 0), px(x, y, 1), px(x, y, 2)]);
      grain.push(grad(x, y));
    }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const backdrop = { r: median(border.map((p) => p[0])), g: median(border.map((p) => p[1])), b: median(border.map((p) => p[2])) };
  const noise = [...grain].sort((a, b) => a - b)[Math.floor(grain.length * 0.95)] ?? 0;
  const edge = Math.max(18, noise * 2.5);
  // Very different colors count too (a black handle, a red car): no backdrop shading gets that far from the border.
  const far = (x: number, y: number) => Math.abs(px(x, y, 0) - backdrop.r) + Math.abs(px(x, y, 1) - backdrop.g) + Math.abs(px(x, y, 2) - backdrop.b) > 120;
  const rowsOn = new Array<number>(h).fill(0);
  const colsOn = new Array<number>(w).fill(0);
  for (let y = 1; y < h; y++)
    for (let x = 1; x < w; x++)
      if (grad(x, y) > edge || far(x, y)) {
        rowsOn[y]++;
        colsOn[x]++;
      }
  const span = (counts: number[], gap: number) => {
    let best: [number, number] | null = null;
    let start = -1;
    let last = -1;
    for (let i = 0; i <= counts.length; i++) {
      const on = i < counts.length && counts[i] >= 2;
      if (on) {
        if (start < 0 || i - last > gap) start = i;
        last = i;
        if (!best || last - start > best[1] - best[0]) best = [start, last];
      }
    }
    return best;
  };
  const ys = span(rowsOn, Math.max(2, Math.round(h * 0.03)));
  const xs = span(colsOn, Math.max(2, Math.round(w * 0.03)));
  if (!ys || !xs) return { box: { left: 0, top: 0, width, height }, backdrop };
  const sx = width / w;
  const sy = height / h;
  const left = Math.max(0, Math.floor((xs[0] - 1) * sx));
  const top = Math.max(0, Math.floor((ys[0] - 1) * sy));
  const right = Math.min(width, Math.ceil((xs[1] + 2) * sx));
  const bottom = Math.min(height, Math.ceil((ys[1] + 2) * sy));
  return { box: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }, backdrop };
}

/**
 * The subject cut out with up to `room` (a share of its height) of its own picture on every side; less where the picture
 * ends (a flat fill past the edge showed as a band). `above` and `below` say how much room it got over and under it.
 */
async function cutOut(src: Buffer, room: number) {
  const { box, backdrop } = await subject(src);
  const { width = 0, height = 0 } = await sharp(src).metadata();
  const pad = Math.round(box.height * room);
  const left = Math.max(0, box.left - pad);
  const top = Math.max(0, box.top - pad);
  const right = Math.min(width, box.left + box.width + pad);
  const bottom = Math.min(height, box.top + box.height + pad);
  const data = await sharp(src).extract({ left, top, width: right - left, height: bottom - top }).removeAlpha().png().toBuffer();
  return { data, subjectHeight: box.height, above: box.top - top, below: bottom - (box.top + box.height), backdrop };
}

/**
 * A sheet laid out by Crackio from views drawn one by one, each in a frame shaped for it: every view at the same scale
 * (the subject the same height in each, as it is in life), each on its own panel side by side; when a long side view would
 * make a strip of it, the side gets a row of its own under the others. Nothing is squeezed to fit, because nothing has to
 * fit. (Panels, not one blended backdrop: views drawn apart are lit a little differently, and blending them showed seams.)
 */
export async function assembleSheet(files: string[]): Promise<{ data: Buffer; layout?: "rows" }> {
  const H = 1000;
  const cuts = await Promise.all(files.map(async (file) => cutOut(await fs.readFile(file), 0.1)));
  // Panels a touch apart in tone read as one set: each is matched to their average backdrop.
  const mean = (k: keyof Rgb) => Math.round(cuts.reduce((s, c) => s + c.backdrop[k], 0) / cuts.length);
  const backdrop = { r: mean("r"), g: mean("g"), b: mean("b") };
  // Every panel the same height, with the same room over and under the subject (the least any view had), so the
  // subjects stand level and the same size.
  const above = Math.min(...cuts.map((c) => Math.round((c.above * H) / c.subjectHeight)));
  const below = Math.min(...cuts.map((c) => Math.round((c.below * H) / c.subjectHeight)));
  const tiles: { data: Buffer; width: number; height: number }[] = [];
  for (const cut of cuts) {
    const scale = H / cut.subjectHeight;
    const gain = (k: keyof Rgb) => Math.min(1.2, Math.max(0.83, backdrop[k] / Math.max(1, cut.backdrop[k])));
    const scaled = await sharp(cut.data)
      .resize({ height: Math.round((cut.above + cut.subjectHeight + cut.below) * scale) })
      .linear([gain("r"), gain("g"), gain("b")], [0, 0, 0])
      .toBuffer({ resolveWithObject: true });
    const top = Math.max(0, Math.round(cut.above * scale) - above);
    const resized = await sharp(scaled.data)
      .extract({ left: 0, top, width: scaled.info.width, height: Math.min(scaled.info.height - top, above + H + below) })
      .toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = resized.info;
    const r = Math.round(h * 0.03);
    const corners = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
    const data = await sharp(resized.data).ensureAlpha().composite([{ input: corners, blend: "dest-in" }]).png().toBuffer();
    tiles.push({ data, width: w, height: h });
  }
  const gap = Math.round(H * 0.035);
  const tileH = Math.max(...tiles.map((t) => t.height));
  const rowWidth = tiles.reduce((s, t) => s + t.width, 0) + gap * (tiles.length - 1);
  const widest = tiles.reduce((a, t) => (t.width > a.width ? t : a), tiles[0]);
  const rowsLayout = tiles.length > 1 && rowWidth / tileH > 2.4 && widest.width > tileH * 1.6;
  const placed: { input: Buffer; left: number; top: number }[] = [];
  let innerW: number;
  let innerH: number;
  if (rowsLayout) {
    const upper = tiles.filter((t) => t !== widest);
    const upperW = upper.reduce((s, t) => s + t.width, 0) + gap * (upper.length - 1);
    innerW = Math.max(upperW, widest.width);
    innerH = tileH * 2 + gap;
    let x = Math.round((innerW - upperW) / 2);
    for (const t of upper) {
      placed.push({ input: t.data, left: x, top: tileH - t.height });
      x += t.width + gap;
    }
    placed.push({ input: widest.data, left: Math.round((innerW - widest.width) / 2), top: tileH + gap + (tileH - widest.height) });
  } else {
    innerW = rowWidth;
    innerH = tileH;
    let x = 0;
    for (const t of tiles) {
      placed.push({ input: t.data, left: x, top: tileH - t.height });
      x += t.width + gap;
    }
  }
  // The sheet around the panels: the same backdrop, a shade darker.
  const shade = (v: number) => Math.round(v * 0.86);
  const data = await sharp({ create: { width: innerW + 2 * gap, height: innerH + 2 * gap, channels: 3, background: { r: shade(backdrop.r), g: shade(backdrop.g), b: shade(backdrop.b) } } })
    .composite(placed.map((p) => ({ ...p, left: p.left + gap, top: p.top + gap })))
    .removeAlpha()
    .png()
    .toBuffer();
  return { data, layout: rowsLayout ? "rows" : undefined };
}

/**
 * A character's sheet as one picture per view (front first, then the others in the sheet's order; on sheets from before,
 * a three-quarter view and a profile), each figure on a little of its backdrop. Views drawn one by one are cut from their
 * own pictures; a sheet drawn as one picture is cut in the gaps between its figures (along its rows, for a long thing's).
 * For models that want one full-body figure per picture, like SCAIL-2's swap, and the Director's stage.
 */
export async function sheetViews(sheetPath: string, owner = ownerOf(sheetPath)): Promise<Buffer[]> {
  const drawn = owner?.views?.map((v) => owner.viewPictures?.[v]);
  if (owner && drawn?.length && drawn.every(Boolean)) {
    const files = drawn.map((url) => urlToPath(url!)).filter((f): f is string => Boolean(f));
    if (files.length === drawn.length) return Promise.all(files.map(async (f) => (await cutOut(await fs.readFile(f), 0.06)).data));
  }
  const src = await fs.readFile(sheetPath);
  const seen = await look(src);
  const boxes = (owner?.sheetLayout === "rows" ? rows(seen) : null) ?? columns(seen);
  const { dominant } = await sharp(src).stats();
  const views: Buffer[] = [];
  for (const box of boxes) {
    const part = await sharp(src).extract(box).toBuffer();
    const figure = await sharp(part).trim({ threshold: 24 }).toBuffer();
    const { width: fw = 0, height: fh = 0 } = await sharp(figure).metadata();
    const pad = Math.round(Math.max(fw, fh) * 0.06);
    views.push(await sharp(figure).extend({ top: pad, bottom: pad, left: pad, right: pad, background: dominant }).png().toBuffer());
  }
  return views;
}

/** The sheet's front view on its own (see `sheetViews`). */
export async function sheetFrontView(sheetPath: string): Promise<Buffer> {
  return (await sheetViews(sheetPath))[0];
}
