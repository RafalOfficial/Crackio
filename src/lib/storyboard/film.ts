import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { frameAt, probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import { MEDIA_DIR } from "@/lib/server/paths";
import { urlToPath } from "@/lib/server/media";
import { VIDEO_SIZE, type Storyboard } from "./types";

/**
 * The storyboard's cutting room: contact sheets with the time on every frame (what the director
 * reads to decide where a shot ends), the frame at a cut (where the next shot starts), and the
 * film itself, every clip trimmed to its cut.
 */

/** Seconds of a clip on disk. */
export async function clipLength(file: string) {
  return (await probe(file)).duration ?? 0;
}

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

/** Save a picture with the other outputs and return its URL. */
async function keep(data: Buffer, ext: "png" | "jpg") {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const file = `sb_${nanoid(12)}.${ext}`;
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, file), data);
  return `/api/media/out/${file}`;
}

/** A clip's frame at `t` seconds, full size, saved: the next shot starts from it. */
export async function saveFrameAt(clipUrl: string, t: number) {
  const file = urlToPath(clipUrl);
  if (!file) throw new Error("The clip isn't on this computer.");
  const length = await clipLength(file);
  const at = Math.max(0, Math.min(t, length - 0.06));
  const grab = (s: number) => runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", s.toFixed(3), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { timeoutMs: 30_000 });
  let r = await grab(at);
  // The very last frame can come back empty; step back a little.
  if (!r.stdout.length && at > 0.2) r = await grab(at - 0.2);
  if (!r.stdout.length) throw new Error(`No frame at ${at.toFixed(2)} s.`);
  return keep(r.stdout, "png");
}

/** One video from the shots in order: each clip from its in point to its cut; shots without one hold their frame. */
export async function renderFilm(b: Storyboard): Promise<{ data: Buffer; width: number; height: number }> {
  const [W, H] = VIDEO_SIZE[b.aspect] ?? VIDEO_SIZE["16:9"];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-film-"));
  try {
    const inputs: string[] = [];
    const filters: string[] = [];
    let n = 0;
    for (const s of b.shots) {
      const clip = s.clip ? urlToPath(s.clip) : null;
      const still = s.frame ? urlToPath(s.frame) : null;
      const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=24,setsar=1,format=yuv420p`;
      if (clip) {
        const length = await clipLength(clip);
        const from = Math.max(0, s.review?.in ?? 0);
        const to = Math.min(length, s.review?.out ?? length);
        inputs.push("-i", clip);
        filters.push(`[${n}:v:0]trim=start=${from.toFixed(3)}:end=${Math.max(from + 0.3, to).toFixed(3)},setpts=PTS-STARTPTS,${fit}[v${n}]`);
      } else if (still) {
        // One picture becomes the whole shot, with a slow push in.
        const frames = Math.round(s.duration * 24);
        inputs.push("-i", still);
        filters.push(`[${n}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=24,setsar=1,format=yuv420p[v${n}]`);
      } else continue;
      n++;
    }
    if (!n) throw new Error("No shots to put together yet.");
    const out = path.join(dir, "film.mp4");
    const graph = `${filters.join(";")};${Array.from({ length: n }, (_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[out]`;
    const run = await runFfmpeg(["-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    if (run.code !== 0) throw new Error(`ffmpeg couldn't put the film together: ${run.stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    return { data: await fs.readFile(out), width: W, height: H };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
