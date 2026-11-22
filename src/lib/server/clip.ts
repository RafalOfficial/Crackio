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
 * The frame rate a Ripple swap is made at: the clip's own up to 30 a second, or an even part of a faster one (60 → 30,
 * 50 → 25), so every kept frame is evenly spaced; LTX's own 24 below that, when it's unknown, or when `seconds` of it
 * would run past 480 frames (each way in one pass, RIPPLE.long). Most phones film at 30: made at 24, every fifth frame
 * was dropped, a stutter on every move all over the picture (the truck clip, 30.04 fps). A rate within 1% of a usual one
 * is taken as that one (a phone's variable rate averages 29.87). Quality picked over speed: truck × Freya at 30 fps kept
 * all 447 frames, with the LTX step at 470 s instead of 322 s on the 5090 (the whole card, no more).
 */
export function swapRate(fps: number | undefined, seconds: number): number {
  if (!fps || fps < 23.5) return 24;
  const even = [1, 2, 3, 4].map((d) => fps / d).find((r) => r <= 30.3);
  if (!even || even < 23.5) return 24;
  const off = (r: number) => Math.abs(even / r - 1);
  const usual = [23.976, 24, 25, 29.97, 30].reduce((a, b) => (off(b) < off(a) ? b : a));
  const rate = off(usual) < 0.01 ? usual : Math.round(even * 100) / 100;
  return seconds * rate <= 480 ? rate : 24;
}

/**
 * The part of a clip a clip editor gets: from `start`, at most `maxSeconds`, scaled to fit in a
 * `box`-pixel square, as an mp4 with its sound (saved as an upload). A part shorter than the model
 * takes is refused, or with `pad`, held on its last frame until it's long enough (`length` stays
 * the real length, so the result can be cut back to it). `fps` caps the frame rate, for models that
 * bill by the frame; with `steady`, the part is made at exactly that rate (a phone's variable rate
 * evened out), for models that work frame by frame against the clip's own frames.
 */
export async function prepareClip(
  file: string,
  { start = 0, maxSeconds, minSeconds, box, pad = false, fps, steady = false, model = "This model" }: { start?: number; maxSeconds: number; minSeconds?: number; box: number; pad?: boolean; fps?: number; steady?: boolean; model?: string },
): Promise<{ url: string; start: number; length: number; padded: number; width: number; height: number }> {
  const info = await probe(file).catch(() => null);
  if (!info?.duration || !info.width || !info.height) throw new ClipError("That file doesn't look like a video Crackio can read.", 422);
  const from = Math.min(start, Math.max(0, info.duration - 1));
  const length = Math.min(maxSeconds, info.duration - from);
  const short = minSeconds ? Math.max(0, minSeconds + 0.1 - length) : 0;
  if (short > 0 && !pad) throw new ClipError(`${model} needs at least ${minSeconds} s of clip; this part is ${length.toFixed(1)} s.`);
  const padded = short > 0 ? short : 0;
  const rate = fps && (steady || !info.fps || info.fps > fps) ? fps : null;

  const dir = await fs.mkdtemp(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ os.tmpdir(), "crackio-clip-"));
  try {
    const out = path.join(/*turbopackIgnore: true*/ dir, "clip.mp4");
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
    const { url } = await saveFileUpload(await fs.readFile(/*turbopackIgnore: true*/ out), "mp4", "video");
    return { url, start: from, length, padded, width: info.width, height: info.height };
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * A swap's result with the clip's own sound laid back under it, cut to `length` seconds (the clip
 * before any padding). Models that keep the sound still re-encode or drift it; this keeps it exact.
 */
export async function withSourceSound(out: EngineOutput, sourcePath: string, length?: number): Promise<EngineOutput> {
  const info = await probe(sourcePath).catch(() => null);
  if (!info) return out;
  const dir = await fs.mkdtemp(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ os.tmpdir(), "crackio-sound-"));
  try {
    const edited = path.join(/*turbopackIgnore: true*/ dir, "edited.mp4");
    const mixed = path.join(/*turbopackIgnore: true*/ dir, "mixed.mp4");
    await fs.writeFile(/*turbopackIgnore: true*/ edited, out.data);
    const cut = length ? ["-t", length.toFixed(2)] : [];
    const args = info.audio
      ? ["-y", "-i", edited, "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0", ...cut, "-c:v", length ? "libx264" : "copy", ...(length ? ["-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"] : []), "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mixed]
      : length
        ? ["-y", "-i", edited, ...cut, "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", mixed]
        : null;
    if (!args) return out;
    const run = await runFfmpeg(args);
    return run.code === 0 ? { ...out, data: await fs.readFile(/*turbopackIgnore: true*/ mixed), mime: "video/mp4" } : out;
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// The colour names ffmpeg prints for a stream and takes back as encoder options (others are left unsaid).
const COLOUR_NAMES = {
  matrix: ["bt709", "fcc", "bt470bg", "smpte170m", "smpte240m", "ycgco", "bt2020nc", "bt2020c"],
  primaries: ["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020"],
  transfer: ["bt709", "gamma22", "gamma28", "smpte170m", "smpte240m", "linear", "iec61966-2-1", "bt2020-10", "bt2020-12", "smpte2084", "arib-std-b67"],
};

/** A video's colour tags (matrix, primaries, transfer, range) as encoder options, so what's made from it says the same. */
async function colourTags(file: string): Promise<string[]> {
  const { stderr } = await runFfmpeg(["-hide_banner", "-i", file], { timeoutMs: 20_000 });
  const video = /Stream #[^\n]*Video:[^\n]*/.exec(stderr)?.[0] ?? "";
  // "yuv420p(tv, bt709, progressive)" or "yuv420p(tv, unknown/bt709/bt709, progressive)".
  const parts = (/, \w+\(([^)]*)\)/.exec(video)?.[1] ?? "").split(",").map((s) => s.trim());
  const range = parts.find((p) => p === "tv" || p === "pc");
  const named = parts.find((p) => p !== range && !/progressive|first|coded/.test(p));
  const [matrix, primaries, transfer] = named ? (named.includes("/") ? named.split("/") : [named, named, named]) : [];
  return [
    ...(matrix && COLOUR_NAMES.matrix.includes(matrix) ? ["-colorspace", matrix] : []),
    ...(primaries && COLOUR_NAMES.primaries.includes(primaries) ? ["-color_primaries", primaries] : []),
    ...(transfer && COLOUR_NAMES.transfer.includes(transfer) ? ["-color_trc", transfer] : []),
    ...(range ? ["-color_range", range] : []),
  ];
}

/**
 * A Ripple swap made inside a 720p copy, laid onto `big` (the same part of the clip at its own size, up to 1080p). The
 * outline is grown and feathered the way layOnto does it in the graph, scaled to that size. The swapped people keep the
 * detail they were made with, and everything else keeps the clip's own pixels at full size. On talk × Marco (a 1080p
 * clip), the crowd's hair and the ring light's lettering were as sharp as the original's, where the 720p take had them
 * soft. It takes about 30 s on the PC. Any failure hands the take back as it was.
 * It all stays in YUV: the made frames are already in the clip's own YUV numbers (ComfyUI's read and write of the copy
 * round-trip them), and laying an RGB layer made ffmpeg turn the whole clip into RGB and back with its default BT.601
 * matrix, untagged: on talk × Marco the red ceiling came out Y +8, U −6 where nothing was swapped.
 * The made people are sharpened a little (ffmpeg's CAS at 0.5, brightness only, so no colour fringes): made in the
 * 720p copy, Marco's face had 15% less fine detail than the real people around him (0.156 against 0.183), and this
 * brings it to 0.181. At 0.85 (+40%) it looked processed.
 */
export async function finishAtSize(out: EngineOutput, big: string, mask: { file: string; reach: number; height: number }): Promise<EngineOutput> {
  const info = await probe(big).catch(() => null);
  if (!info?.width || !info.height || !mask.height) return out;
  const tags = await colourTags(big).catch(() => []);
  const dir = await fs.mkdtemp(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ os.tmpdir(), "crackio-finish-"));
  try {
    const made = path.join(/*turbopackIgnore: true*/ dir, "made.mp4");
    const done = path.join(/*turbopackIgnore: true*/ dir, "done.mp4");
    await fs.writeFile(/*turbopackIgnore: true*/ made, out.data);
    const [W, H] = [info.width, info.height];
    const k = H / mask.height;
    const grow = (Math.max(1, Math.min(10, mask.reach * 0.06)) * k).toFixed(2);
    const soft = (5 * k).toFixed(2);
    // Alpha over the clip, not maskedmerge: maskedmerge took the colour planes at half (a teal rim round Marco).
    const run = await runFfmpeg([
      "-y",
      "-i", made,
      "-i", big,
      "-i", mask.file,
      "-filter_complex",
      [
        "[1:v]setpts=PTS-STARTPTS,format=yuv420p[clip]",
        `[2:v]setpts=PTS-STARTPTS,format=gray,scale=${W}:${H}:flags=bilinear,lut=y='if(gt(val,127),255,0)',gblur=sigma=${grow},lut=y='if(gt(val,6),255,0)',gblur=sigma=${soft}[mask]`,
        `[0:v]setpts=PTS-STARTPTS,scale=${W}:${H}:flags=lanczos,format=yuv420p,cas=strength=0.5:planes=1[made]`,
        "[made][mask]alphamerge[top]",
        "[clip][top]overlay=format=yuv420:shortest=1[v]",
      ].join(";"),
      "-map", "[v]",
      "-map", "0:a?",
      "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", ...tags,
      "-c:a", "copy",
      "-movflags", "+faststart",
      done,
    ]);
    return run.code === 0 ? { ...out, data: await fs.readFile(/*turbopackIgnore: true*/ done), mime: "video/mp4", width: W, height: H } : out;
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
