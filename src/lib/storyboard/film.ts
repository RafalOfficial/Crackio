import "server-only";
import sharp from "sharp";
import { frameAt, probe } from "@/lib/motion/ffmpeg";

/**
 * Contact sheets with the time on every frame: what a checker reads to judge a clip and where it ends (Product Video's
 * check uses them).
 */

/* Digits drawn as segments, so the time stamps need no fonts on any computer. */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

function stamp(text: string) {
  const w = 9;
  const h = 16;
  const t = 2.4;
  const parts: string[] = [];
  let x = 8;
  for (const ch of text) {
    if (ch === ".") {
      parts.push(`<rect x="${x}" y="${6 + h - t}" width="${t}" height="${t}"/>`);
      x += 6;
      continue;
    }
    if (ch === "s") {
      // A small "s": three bars and two joins.
      const y0 = 6 + h * 0.45;
      const hh = h * 0.55;
      parts.push(
        `<rect x="${x}" y="${y0}" width="${w * 0.8}" height="${t}"/>`,
        `<rect x="${x}" y="${y0}" width="${t}" height="${hh / 2}"/>`,
        `<rect x="${x}" y="${y0 + hh / 2 - t / 2}" width="${w * 0.8}" height="${t}"/>`,
        `<rect x="${x + w * 0.8 - t}" y="${y0 + hh / 2}" width="${t}" height="${hh / 2}"/>`,
        `<rect x="${x}" y="${y0 + hh - t}" width="${w * 0.8}" height="${t}"/>`,
      );
      x += w + 3;
      continue;
    }
    const on = SEGMENTS[ch] ?? "";
    const y = 6;
    const seg: Record<string, string> = {
      a: `<rect x="${x}" y="${y}" width="${w}" height="${t}"/>`,
      b: `<rect x="${x + w - t}" y="${y}" width="${t}" height="${h / 2}"/>`,
      c: `<rect x="${x + w - t}" y="${y + h / 2}" width="${t}" height="${h / 2}"/>`,
      d: `<rect x="${x}" y="${y + h - t}" width="${w}" height="${t}"/>`,
      e: `<rect x="${x}" y="${y + h / 2}" width="${t}" height="${h / 2}"/>`,
      f: `<rect x="${x}" y="${y}" width="${t}" height="${h / 2}"/>`,
      g: `<rect x="${x}" y="${y + h / 2 - t / 2}" width="${w}" height="${t}"/>`,
    };
    parts.push(...[...on].map((s) => seg[s]));
    x += w + 4;
  }
  const width = x + 4;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h + 12}"><rect width="${width}" height="${h + 12}" rx="5" fill="#000" fill-opacity="0.72"/><g fill="#ffd84a">${parts.join("")}</g></svg>`,
  );
}

/** When to look at a clip: every half second (every second past 8 s), and its very last frame. */
export function sheetTimes(duration: number) {
  const step = duration > 8 ? 1 : 0.5;
  const times: number[] = [];
  for (let t = 0; t < duration - 0.15 && times.length < 15; t += step) times.push(Math.round(t * 10) / 10);
  times.push(Math.max(0, Math.round((duration - 0.06) * 100) / 100));
  return times;
}

/** The clip's frames in a grid, each stamped with its time, as one JPEG. */
export async function timedSheet(file: string, times: number[]) {
  const info = await probe(file);
  const tall = (info.height ?? 1) > (info.width ?? 1);
  const width = tall ? 240 : 400;
  const cols = tall ? 6 : 4;
  const frames = await Promise.all(
    times.map(async (t) => {
      const jpeg = await frameAt(file, t, width).catch(() => null);
      if (!jpeg) return null;
      return sharp(jpeg)
        .composite([{ input: stamp(`${t.toFixed(t % 1 ? (Math.round(t * 100) % 10 ? 2 : 1) : 1)}s`), left: 6, top: 6 }])
        .jpeg({ quality: 82 })
        .toBuffer();
    }),
  );
  const ok = frames.filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (!ok.length) throw new Error("Couldn't read any frames from this clip.");
  const height = (await sharp(ok[0]).metadata()).height ?? width;
  const gap = 6;
  const rows = Math.ceil(ok.length / cols);
  return sharp({ create: { width: cols * width + (cols - 1) * gap, height: rows * height + (rows - 1) * gap, channels: 3, background: "#101012" } })
    .composite(ok.map((input, i) => ({ input, left: (i % cols) * (width + gap), top: Math.floor(i / cols) * (height + gap) })))
    .jpeg({ quality: 84 })
    .toBuffer();
}
