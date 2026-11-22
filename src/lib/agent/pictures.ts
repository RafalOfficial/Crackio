import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "@/lib/server/paths";
import { frameAt, probe } from "@/lib/motion/ffmpeg";

/**
 * What an agent's model looks at: small JPEGs, never the full file. One picture comes at about 768 px on its long side
 * (roughly 450 tokens at 16:9 for a model that counts a token per ~750 pixels); several come as one labelled sheet; a
 * clip comes as a sheet of its frames with the time on each. They're kept in data/cache/agent and served at
 * /api/agent/file/<name>, which the stdio program turns into a local path.
 */
export const SHOWN_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "agent");

export type Shown = { url: string; file: string; width: number; height: number; bytes: number; label?: string };

/** About how many tokens a picture costs a model that sees it (Claude's count: pixels / 750). */
export const tokensOf = (s: Pick<Shown, "width" | "height">) => Math.round((s.width * s.height) / 750);

async function keep(jpeg: Buffer, key: string, label?: string): Promise<Shown> {
  await fs.mkdir(/*turbopackIgnore: true*/ SHOWN_DIR, { recursive: true });
  const name = `${createHash("sha1").update(key).digest("hex").slice(0, 20)}.jpg`;
  const file = path.join(/*turbopackIgnore: true*/ SHOWN_DIR, name);
  await fs.writeFile(/*turbopackIgnore: true*/ file, jpeg);
  const meta = await sharp(jpeg).metadata();
  return { url: `/api/agent/file/${name}`, file, width: meta.width ?? 0, height: meta.height ?? 0, bytes: jpeg.length, ...(label ? { label } : {}) };
}

/** A JPEG made elsewhere (the Director's camera view), kept like any other preview. */
export const shownFrom = (jpeg: Buffer, key: string, label?: string) => keep(jpeg, key, label);

/** The file behind a /api/agent/file/<name> address, or null for anything else. */
export function shownPath(name: string): string | null {
  return /^[a-f0-9]{20}\.jpg$/.test(name) ? path.join(/*turbopackIgnore: true*/ SHOWN_DIR, name) : null;
}

const stamp = async (file: string) => {
  const st = await fs.stat(/*turbopackIgnore: true*/ file);
  return `${file}|${st.size}|${st.mtimeMs}`;
};

/** A region of a picture, in fractions of its width and height (0–1). */
export type Crop = { x: number; y: number; w: number; h: number };

/** One picture, its long side at most `edge` pixels; `crop` shows only that part of it (at up to `edge` again). */
export async function small(file: string, edge = 768, crop?: Crop): Promise<Shown> {
  let img = sharp(file, { failOn: "none" }).rotate();
  if (crop) {
    const meta = await sharp(file, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
    const W = meta.info.width;
    const H = meta.info.height;
    const left = Math.min(W - 1, Math.max(0, Math.round(crop.x * W)));
    const top = Math.min(H - 1, Math.max(0, Math.round(crop.y * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(crop.w * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(crop.h * H)));
    img = sharp(meta.data).extract({ left, top, width, height });
  }
  const jpeg = await img.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).flatten({ background: "#808080" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  return keep(jpeg, `small|${await stamp(file)}|${edge}|${crop ? JSON.stringify(crop) : ""}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A label in a dark tag, for a tile's top-left corner. */
function tag(text: string, size = 22): Buffer {
  const h = Math.round(size * 1.5);
  const w = Math.round(size * 0.62 * text.length + size);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="6" fill="#000000" fill-opacity="0.72"/><text x="${Math.round(size * 0.5)}" y="${Math.round(h * 0.72)}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="700" fill="#ffffff">${esc(text)}</text></svg>`,
  );
}

/** A box in 0–1000 of the picture: x0, y0, x1, y1 (x from the left edge, y from the top). */
export type Box1000 = [number, number, number, number];

const HUES = ["#ff5a5f", "#2ec4b6", "#ffbf00", "#7b61ff", "#3da5ff", "#ff7ac6", "#8bd346", "#ff8c42"];

/**
 * A picture with a numbered box round each thing: what an agent picks things from (Retouch's finds, the people in a
 * Swap frame). One picture however many things there are.
 */
export async function overlay(file: string, items: { box: Box1000; label: string }[], edge = 1024, within?: Box1000): Promise<Shown> {
  // `within`: a close-up. Only that part of the picture is shown (with a little room round it), enlarged to `edge`, and
  // the boxes are drawn where they fall inside it: a thing's parts are seen far larger than on the whole picture.
  let source = sharp(file, { failOn: "none" }).rotate();
  if (within) {
    const full = await sharp(file, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
    const [FW, FH] = [full.info.width, full.info.height];
    const pad = 0.06;
    const bw = within[2] - within[0];
    const bh = within[3] - within[1];
    const x0 = Math.max(0, within[0] - bw * pad);
    const y0 = Math.max(0, within[1] - bh * pad);
    const x1 = Math.min(1000, within[2] + bw * pad);
    const y1 = Math.min(1000, within[3] + bh * pad);
    const left = Math.round((x0 / 1000) * FW);
    const top = Math.round((y0 / 1000) * FH);
    const width = Math.max(8, Math.min(FW - left, Math.round(((x1 - x0) / 1000) * FW)));
    const height = Math.max(8, Math.min(FH - top, Math.round(((y1 - y0) / 1000) * FH)));
    source = sharp(full.data).extract({ left, top, width, height });
    // The boxes in the close-up's own 0–1000.
    const fit = (v: number, a: number, b: number) => Math.min(1000, Math.max(0, ((v - a) / Math.max(1, b - a)) * 1000));
    items = items.map((it) => ({ ...it, box: [fit(it.box[0], x0, x1), fit(it.box[1], y0, y1), fit(it.box[2], x0, x1), fit(it.box[3], y0, y1)] as Box1000 }));
  }
  const base = await source.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: !within }).flatten({ background: "#808080" }).toBuffer({ resolveWithObject: true });
  const W = base.info.width;
  const H = base.info.height;
  const size = Math.max(14, Math.round(Math.min(W, H) / 34));
  const shapes = items
    .map((it, i) => {
      const [x0, y0, x1, y1] = [(it.box[0] / 1000) * W, (it.box[1] / 1000) * H, (it.box[2] / 1000) * W, (it.box[3] / 1000) * H];
      const hue = HUES[i % HUES.length];
      const tw = Math.round(size * 0.62 * it.label.length + size * 0.8);
      const th = Math.round(size * 1.4);
      // The number sits inside the box's top-left corner, pulled in where the box touches the picture's edge.
      const tx = Math.min(Math.max(0, x0), W - tw);
      const ty = Math.min(Math.max(0, y0), H - th);
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${Math.max(2, y1 - y0).toFixed(1)}" fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="5"/><rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${Math.max(2, y1 - y0).toFixed(1)}" fill="none" stroke="${hue}" stroke-width="2.5"/><rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw}" height="${th}" fill="${hue}"/><text x="${(tx + size * 0.4).toFixed(1)}" y="${(ty + th * 0.76).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="700" fill="#000000">${esc(it.label)}</text>`;
    })
    .join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes}</svg>`);
  const jpeg = await sharp(base.data).composite([{ input: svg, left: 0, top: 0 }]).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return keep(jpeg, `overlay|${await stamp(file)}|${edge}|${JSON.stringify(items)}|${within ? within.join(",") : ""}`);
}

export type Tile = { file?: string; jpeg?: Buffer; label: string };

/**
 * Columns for `n` tiles of one shape: the grid with no empty cells (or the fewest) whose sheet comes nearest a screen's
 * shape, so the tiles are as large as the sheet allows.
 */
export function gridFor(n: number, ratio: number): number {
  let best = 1;
  let score = Infinity;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const s = (c * rows - n) * 0.5 + Math.abs(Math.log((c * ratio) / rows / 1.6));
    if (s < score - 1e-9) {
      score = s;
      best = c;
    }
  }
  return best;
}

/**
 * Several pictures as one sheet, each with its label in the corner, left to right, top to bottom. The whole sheet stays
 * within `edge` pixels on its long side, so it costs about what one large picture does.
 */
export async function sheet(tiles: Tile[], { edge = 1280, cols }: { edge?: number; cols?: number } = {}): Promise<Shown> {
  const n = tiles.length;
  if (!n) throw new Error("Nothing to show.");
  const first = tiles[0].jpeg ? await sharp(tiles[0].jpeg).metadata() : await sharp(tiles[0].file!, { failOn: "none" }).metadata();
  const ratio = (first.width ?? 1) / (first.height ?? 1);
  const c = cols ?? gridFor(n, ratio);
  const rows = Math.ceil(n / c);
  const gap = 6;
  // The tile size at which the sheet's long side comes to `edge`.
  const byWidth = (edge - (c - 1) * gap) / c;
  const byHeight = ((edge - (rows - 1) * gap) / rows) * ratio;
  const tw = Math.max(96, Math.floor(Math.min(byWidth, byHeight)));
  const th = Math.max(54, Math.round(tw / ratio));
  const size = Math.max(14, Math.min(24, Math.round(tw / 14)));
  const made = await Promise.all(
    tiles.map(async (t) => {
      const base = sharp(t.jpeg ?? t.file!, { failOn: "none" }).rotate().resize({ width: tw, height: th, fit: "contain", background: "#101012" }).flatten({ background: "#101012" });
      return base.composite([{ input: tag(t.label, size), left: 6, top: 6 }]).jpeg({ quality: 82 }).toBuffer();
    }),
  );
  const jpeg = await sharp({ create: { width: c * tw + (c - 1) * gap, height: rows * th + (rows - 1) * gap, channels: 3, background: "#101012" } })
    .composite(made.map((input, i) => ({ input, left: (i % c) * (tw + gap), top: Math.floor(i / c) * (th + gap) })))
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  const key = `sheet|${edge}|${c}|${(await Promise.all(tiles.map(async (t) => `${t.label}:${t.file ? await stamp(t.file) : createHash("sha1").update(t.jpeg!).digest("hex")}`))).join("|")}`;
  return keep(jpeg, key);
}

const clock = (t: number) => (t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}` : `${t.toFixed(1)}s`);

/**
 * A clip as a sheet of its frames, `rate` frames a second (0.5 to 4), at most 16 tiles, the time on each. A clip too
 * long for that at the rate asked is sampled evenly instead, and the answer says at what rate.
 */
export async function frameSheet(file: string, { rate = 1, from = 0, to, edge = 1280 }: { rate?: number; from?: number; to?: number; edge?: number } = {}): Promise<Shown & { times: number[]; rate: number; duration: number }> {
  const info = await probe(file);
  const duration = info.duration ?? 0;
  if (info.kind !== "video" || !duration) throw new Error("That file isn't a clip Crackio can read.");
  const start = Math.min(Math.max(0, from), Math.max(0, duration - 0.1));
  const end = Math.min(duration, to && to > start ? to : duration);
  const span = Math.max(0.1, end - start);
  const r = Math.min(4, Math.max(0.5, rate));
  const count = Math.max(1, Math.min(16, Math.round(span * r)));
  const used = count / span;
  // Each tile is the middle of its slice of the clip, so the first and last frames aren't the only ones seen.
  const times = Array.from({ length: count }, (_, i) => Math.min(end - 0.05, start + (span * (i + 0.5)) / count));
  const tall = (info.height ?? 1) > (info.width ?? 1);
  const frames = await Promise.all(times.map((t) => frameAt(file, t, tall ? 360 : 512).catch(() => null)));
  const tiles = frames.flatMap((jpeg, i) => (jpeg ? [{ jpeg, label: clock(times[i]) }] : []));
  if (!tiles.length) throw new Error("Couldn't read any frames from this clip.");
  const shown = await sheet(tiles, { edge });
  return { ...shown, times: times.map((t) => Math.round(t * 100) / 100), rate: Math.round(used * 100) / 100, duration: Math.round(duration * 100) / 100 };
}

/** One frame of a clip, at up to `edge` pixels on its long side. */
export async function frameOf(file: string, t: number, edge = 768, crop?: Crop): Promise<Shown> {
  const info = await probe(file);
  const at = Math.min(Math.max(0, t), Math.max(0, (info.duration ?? 0) - 0.05));
  const full = await frameAt(file, at, 0, 3);
  const cut = crop
    ? await (async () => {
        const m = await sharp(full).metadata();
        const W = m.width ?? 1;
        const H = m.height ?? 1;
        const left = Math.min(W - 1, Math.max(0, Math.round(crop.x * W)));
        const top = Math.min(H - 1, Math.max(0, Math.round(crop.y * H)));
        return sharp(full).extract({ left, top, width: Math.max(1, Math.min(W - left, Math.round(crop.w * W))), height: Math.max(1, Math.min(H - top, Math.round(crop.h * H))) }).toBuffer();
      })()
    : full;
  const jpeg = await sharp(cut).resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  return keep(jpeg, `frame|${await stamp(file)}|${at.toFixed(3)}|${edge}|${crop ? JSON.stringify(crop) : ""}`);
}
