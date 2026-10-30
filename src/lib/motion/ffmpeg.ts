import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/**
 * ffmpeg on this computer: a current build from ffmpeg-static (6.x, with xfade, VP9 alpha and
 * libass), falling back to the older @ffmpeg-installer build, or FFMPEG_PATH if you set one.
 */
let resolved: string | null = null;

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (resolved) return resolved;
  // Resolved from the project at runtime: the binaries live outside the bundle.
  const req = createRequire(path.join(process.cwd(), "package.json"));
  for (const load of [() => req("ffmpeg-static") as string, () => (req("@ffmpeg-installer/ffmpeg") as { path: string }).path]) {
    try {
      const p = load();
      if (p && existsSync(p)) return (resolved = p);
    } catch {
      /* try the next one */
    }
  }
  return (resolved = "ffmpeg");
}

export type FfmpegRun = { code: number; stderr: string; stdout: Buffer };

/**
 * Runs ffmpeg with an argument list (no shell). Killed on abort or after `timeoutMs`. `background`
 * work (previews) runs at a lower priority, so it never competes with what you're doing.
 */
export function runFfmpeg(
  args: string[],
  { cwd, signal, timeoutMs = 20 * 60_000, background = false }: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; background?: boolean } = {},
): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    // Ignored by the bundler: a command it can't see, run from the project folder, reads to it as
    // "any file in the project", and production builds then traced every file there.
    const proc = spawn(/*turbopackIgnore: true*/ ffmpegPath(), args, { cwd, windowsHide: true });
    if (background && proc.pid) {
      try {
        os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* not allowed here: it just runs at normal priority */
      }
    }
    const out: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const kill = () => proc.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ code: code ?? 1, stderr, stdout: Buffer.concat(out) });
    });
    proc.stdin.end();
  });
}

export type MediaKind = "image" | "video" | "audio" | "text" | "other";
export type MediaInfo = { kind: MediaKind; width?: number; height?: number; duration?: number; fps?: number; audio?: boolean; bytes: number };

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;
const TEXT = /\.(txt|srt|ass|vtt|svg|json|css|html|md|csv|lrc)$/i;

export const kindOf = (name: string): MediaKind =>
  IMAGE.test(name) ? "image" : VIDEO.test(name) ? "video" : AUDIO.test(name) ? "audio" : TEXT.test(name) ? "text" : "other";

/** What a file is: its size, and for media its dimensions, length, frame rate and sound. */
export async function probe(file: string): Promise<MediaInfo> {
  const bytes = (await fs.stat(file)).size;
  const kind = kindOf(file);
  if (kind === "image") {
    const m = await sharp(file).metadata().catch(() => null);
    return { kind, width: m?.width, height: m?.height, bytes };
  }
  if (kind === "video" || kind === "audio") {
    const { stderr } = await runFfmpeg(["-hide_banner", "-i", file], { timeoutMs: 20_000 });
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : undefined;
    const video = /Stream #[^\n]*Video:[^\n]*/.exec(stderr)?.[0];
    const dims = video ? /, (\d{2,5})x(\d{2,5})[, []/.exec(video) : null;
    const fps = video ? /(\d+(?:\.\d+)?) fps/.exec(video)?.[1] : undefined;
    const audio = /Stream #[^\n]*Audio:/.test(stderr);
    if (dims) return { kind: "video", width: Number(dims[1]), height: Number(dims[2]), duration, fps: fps ? Number(fps) : undefined, audio, bytes };
    if (audio) return { kind: "audio", duration, audio, bytes };
    return { kind: "other", bytes };
  }
  return { kind, bytes };
}

/** One frame of a video as a JPEG, `width` pixels wide. */
export async function frameAt(file: string, t: number, width = 480): Promise<Buffer> {
  const grab = (at: number) =>
    runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", Math.max(0, at).toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"], {
      timeoutMs: 30_000,
    });
  let r = await grab(t);
  // Asking for the very last frame can come back empty; step back a little.
  if (!r.stdout.length && t > 0.2) r = await grab(t - 0.2);
  if (!r.stdout.length) throw new Error(`No frame at ${t.toFixed(2)} s.`);
  return r.stdout;
}

/** Evenly spaced times across a clip, never the exact last frame. */
export function frameTimes(duration: number, count: number): number[] {
  const n = Math.max(1, Math.min(count, 16));
  if (n === 1) return [Math.min(duration / 2, Math.max(0, duration - 0.1))];
  return Array.from({ length: n }, (_, i) => Math.min(duration - 0.05, (duration * (i + 0.5)) / n));
}

/** Frames of a video in a grid, left to right, top to bottom, as one JPEG. */
export async function contactSheet(file: string, info: MediaInfo, times: number[]): Promise<Buffer> {
  const tall = (info.height ?? 1) > (info.width ?? 1);
  const cols = Math.min(times.length, tall ? 6 : 4);
  const width = tall ? 256 : 384;
  const frames = (await Promise.all(times.map((t) => frameAt(file, t, width).catch(() => null)))).filter((f): f is Buffer => Boolean(f));
  if (!frames.length) throw new Error("Couldn't read any frames from this video.");
  const height = (await sharp(frames[0]).metadata()).height ?? width;
  const gap = 6;
  const rows = Math.ceil(frames.length / cols);
  return sharp({ create: { width: cols * width + (cols - 1) * gap, height: rows * height + (rows - 1) * gap, channels: 3, background: "#101012" } })
    .composite(frames.map((input, i) => ({ input, left: (i % cols) * (width + gap), top: Math.floor(i / cols) * (height + gap) })))
    .jpeg({ quality: 74 })
    .toBuffer();
}

/** The sound of a file drawn as a waveform, for timing cuts to music. */
export async function waveform(file: string): Promise<Buffer> {
  const r = await runFfmpeg(
    ["-hide_banner", "-loglevel", "error", "-i", file, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1400x260:colors=0xffb48a", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"],
    { timeoutMs: 60_000 },
  );
  if (!r.stdout.length) throw new Error("Couldn't draw this file's sound.");
  return sharp(r.stdout).flatten({ background: "#101012" }).jpeg({ quality: 80 }).toBuffer();
}

export const toDataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;
