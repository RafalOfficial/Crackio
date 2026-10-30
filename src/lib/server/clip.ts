import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe, runFfmpeg } from "@/lib/motion/ffmpeg";
import type { EngineOutput } from "@/lib/engines/types";
import { saveFileUpload } from "./media";

export class ClipError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The part of a clip a clip editor gets: from `start`, at most `maxSeconds`, scaled to fit in a
 * `box`-pixel square, as an mp4 with its sound (saved as an upload). A part shorter than the model
 * takes is refused, or with `pad`, held on its last frame until it's long enough (`length` stays
 * the real length, so the result can be cut back to it). `fps` caps the frame rate, for models that
 * bill by the frame.
 */
export async function prepareClip(
  file: string,
  { start = 0, maxSeconds, minSeconds, box, pad = false, fps, model = "This model" }: { start?: number; maxSeconds: number; minSeconds?: number; box: number; pad?: boolean; fps?: number; model?: string },
): Promise<{ url: string; start: number; length: number; padded: number; width: number; height: number }> {
  const info = await probe(file).catch(() => null);
  if (!info?.duration || !info.width || !info.height) throw new ClipError("That file doesn't look like a video Crackio can read.", 422);
  const from = Math.min(start, Math.max(0, info.duration - 1));
  const length = Math.min(maxSeconds, info.duration - from);
  const short = minSeconds ? Math.max(0, minSeconds + 0.1 - length) : 0;
  if (short > 0 && !pad) throw new ClipError(`${model} needs at least ${minSeconds} s of clip; this part is ${length.toFixed(1)} s.`);
  const padded = short > 0 ? short : 0;
  const rate = fps && (!info.fps || info.fps > fps) ? fps : null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-clip-"));
  try {
    const out = path.join(dir, "clip.mp4");
    // Square pixels: rounding the size to even numbers otherwise leaves them a hair off square.
    const scale = `scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
    const run = await runFfmpeg([
      "-y",
      "-ss", from.toFixed(2),
      "-i", file,
      "-t", length.toFixed(2),
      // Held on the last frame (and silence) when the model needs a longer clip.
      "-vf", [scale, rate ? `fps=${rate}` : "", padded ? `tpad=stop_mode=clone:stop_duration=${padded.toFixed(2)}` : ""].filter(Boolean).join(","),
      ...(padded ? ["-af", `apad=pad_dur=${padded.toFixed(2)}`] : []),
      "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      out,
    ]);
    if (run.code !== 0) throw new ClipError("Couldn't prepare the clip.", 422);
    const { url } = await saveFileUpload(await fs.readFile(out), "mp4", "video");
    return { url, start: from, length, padded, width: info.width, height: info.height };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * A swap's result with the clip's own sound laid back under it, cut to `length` seconds (the clip
 * before any padding). Models that keep the sound still re-encode or drift it; this keeps it exact.
 */
export async function withSourceSound(out: EngineOutput, sourcePath: string, length?: number): Promise<EngineOutput> {
  const info = await probe(sourcePath).catch(() => null);
  if (!info) return out;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-sound-"));
  try {
    const edited = path.join(dir, "edited.mp4");
    const mixed = path.join(dir, "mixed.mp4");
    await fs.writeFile(edited, out.data);
    const cut = length ? ["-t", length.toFixed(2)] : [];
    const args = info.audio
      ? ["-y", "-i", edited, "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0", ...cut, "-c:v", length ? "libx264" : "copy", ...(length ? ["-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"] : []), "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mixed]
      : length
        ? ["-y", "-i", edited, ...cut, "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", mixed]
        : null;
    if (!args) return out;
    const run = await runFfmpeg(args);
    return run.code === 0 ? { ...out, data: await fs.readFile(mixed), mime: "video/mp4" } : out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
