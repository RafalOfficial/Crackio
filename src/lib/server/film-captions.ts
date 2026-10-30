import "server-only";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import type { Transcript } from "./speech";

/**
 * Captions the way creators burn them in: a few words at a time, bold white with a dark edge, in the
 * middle of the lower half (clear of the platforms' own buttons), timed to the words actually said.
 * They come from the clip's transcript, never from the video model, so they're never garbled.
 */

/** Bold faces found on most computers, heaviest first. */
const FONTS = [
  "C:/Windows/Fonts/seguibl.ttf",
  "C:/Windows/Fonts/ariblk.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Black.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
];

export const captionFont = () => FONTS.find((f) => existsSync(f)) ?? null;

export type Caption = { text: string; start: number; end: number };

/** The words in short lines: at most three words (or about 18 letters), broken at pauses and sentence ends. */
export function captionLines(said: Transcript): Caption[] {
  const out: Caption[] = [];
  let line: Transcript["words"] = [];
  const flush = () => {
    if (!line.length) return;
    const text = line
      .map((w) => w.text)
      .join(" ")
      .replace(/[.,;:—–-]+$/u, "")
      .trim();
    if (text) out.push({ text, start: line[0].start, end: line.at(-1)!.end });
    line = [];
  };
  for (let i = 0; i < said.words.length; i++) {
    const w = said.words[i];
    const prev = line.at(-1);
    const letters = line.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (w.start - prev.end > 0.35 || line.length >= 3 || letters > 18)) flush();
    line.push(w);
    if (/[.!?…]$/u.test(w.text)) flush();
  }
  flush();
  // Each line stays up until the next one starts (or a beat after its last word), never overlapping.
  return out.map((c, i) => ({ ...c, end: Math.min(out[i + 1]?.start ?? c.end + 0.4, c.end + 0.4) }));
}

/** Escape a path for an ffmpeg filter argument. */
const filterPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** The clip with its captions burned in; the clip as it was when there's no font or nothing was said. */
export async function burnCaptions(video: Buffer, said: Transcript | null, { offset = 0 }: { offset?: number } = {}): Promise<Buffer> {
  const font = captionFont();
  if (!font || !said?.words.length) return video;
  const lines = captionLines(said);
  if (!lines.length) return video;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-captions-"));
  try {
    const src = path.join(dir, "in.mp4");
    await fs.writeFile(src, video);
    const info = await probe(src);
    const W = info.width ?? 1080;
    const H = info.height ?? 1920;
    const tall = H > W;
    const size = Math.round((tall ? W : H * 0.75) * 0.062);
    const y = tall ? 0.64 : 0.76;
    const filters: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const file = path.join(dir, `c${i}.txt`);
      await fs.writeFile(file, lines[i].text);
      const a = Math.max(0, lines[i].start + offset).toFixed(3);
      const b = Math.max(0, lines[i].end + offset).toFixed(3);
      filters.push(
        `drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(size * 0.11))}:bordercolor=black@0.9:shadowcolor=black@0.35:shadowx=0:shadowy=${Math.round(size * 0.06)}:x=(w-text_w)/2:y=h*${y}-text_h/2:enable='between(t,${a},${b})'`,
      );
    }
    const out = path.join(dir, "out.mp4");
    const run = await runFfmpeg(["-y", "-i", src, "-vf", filters.join(","), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out]);
    if (run.code !== 0) {
      console.warn(`[film] captions failed: ${run.stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
      return video;
    }
    return fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
