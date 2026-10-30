import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { kindOf, runFfmpeg } from "@/lib/motion/ffmpeg";
import { previewWidth } from "@/lib/media-url";

/**
 * Light copies of media for showing it small (lib/media-url): a picture as a WebP at a card's
 * width, a clip's opening frame, or the clip itself as a short, muted H.264 preview. A 4K PNG or a
 * 1080p clip costs the browser as much to decode in a 300-pixel card as on a full screen, and a
 * long video download ties up one of the few connections a browser opens to a site; these cost a
 * fraction of both. Each copy is made once, kept in data/cache/previews (a folder per original, gone
 * with it), and made again only when its original changes.
 */

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "previews");
/** A card loops this much of a long film at most. */
const CLIP_SECONDS = 60;
/** After a copy fails (a damaged file), the original is served for this long before trying again. */
const RETRY_AFTER = 10 * 60_000;

export type PreviewVariant = "poster" | null;
type What = "still" | "poster" | "clip";
type Made = { file: string; mime: string };

/** At most `max` jobs at once; the rest wait their turn. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

type State = {
  /** Pictures and opening frames (quick), and clips (slower), each with their own small lane. */
  stills: ReturnType<typeof limiter>;
  clips: ReturnType<typeof limiter>;
  inflight: Map<string, Promise<Made | null>>;
  failed: Map<string, number>;
  warm: { queue: [string, number, PreviewVariant][]; seen: Set<string>; running: boolean };
};
// On globalThis, so a hot reload in development doesn't start a second set of lanes.
const g = globalThis as unknown as { __crackioPreviews?: State };
const state: State = (g.__crackioPreviews ??= {
  stills: limiter(2),
  clips: limiter(1),
  inflight: new Map(),
  failed: new Map(),
  warm: { queue: [], seen: new Set(), running: false },
});

/**
 * A light copy of `source` about `width` pixels wide (`poster`: a clip's opening frame), made now
 * if it isn't on disk yet. Null when there's no lighter copy to give: serve the original.
 */
export async function preview(source: string, width: number, variant: PreviewVariant = null): Promise<Made | null> {
  const kind = kindOf(source);
  // Animated GIFs keep their motion; anything that isn't a picture or a clip has no copy.
  if (kind === "image" ? /\.gif$/i.test(source) : kind !== "video") return null;
  const w = previewWidth(width);
  const what: What = kind === "image" ? "still" : variant === "poster" ? "poster" : "clip";
  const made: Made = { file: path.join(/*turbopackIgnore: true*/ folderOf(source), `${what}-${w}.${what === "clip" ? "mp4" : "webp"}`), mime: what === "clip" ? "video/mp4" : "image/webp" };

  const failedAt = state.failed.get(made.file);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER) return null;
  const [src, have] = await Promise.all([fs.stat(source).catch(() => null), fs.stat(made.file).catch(() => null)]);
  if (!src?.isFile()) return null;
  if (have && have.size > 0 && have.mtimeMs >= src.mtimeMs) return made;

  let job = state.inflight.get(made.file);
  if (!job) {
    job = (what === "clip" ? state.clips : state.stills)(() => make(source, made.file, what, w))
      .then(() => made)
      .catch((err: Error) => {
        state.failed.set(made.file, Date.now());
        console.warn(`[previews] no ${what} of ${path.basename(source)}: ${err.message}`);
        return null;
      })
      .finally(() => state.inflight.delete(made.file));
    state.inflight.set(made.file, job);
  }
  return job;
}

/** Where one original's copies live. */
const folderOf = (source: string) => path.join(/*turbopackIgnore: true*/ DIR, createHash("sha1").update(path.resolve(/*turbopackIgnore: true*/ source)).digest("hex").slice(0, 20));

/** Drop an original's copies, once it's been deleted. */
export async function forgetPreviews(source: string) {
  await fs.rm(folderOf(source), { recursive: true, force: true }).catch(() => {});
}

async function make(source: string, out: string, what: What, w: number) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  // Written beside the copy and renamed into place, so a reader never gets half a file. (Built with
  // path.join, ignored: a bare template string here reads to the bundler as "any file", and makes
  // the production build trace the whole project.)
  const tmp = path.join(/*turbopackIgnore: true*/ path.dirname(out), `${path.basename(out)}.${process.pid}-${Date.now().toString(36)}.tmp${path.extname(out)}`);
  try {
    if (what === "still") {
      await sharp(source, { failOn: "none" }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
    } else if (what === "poster") {
      await sharp(await openingFrame(source, w)).webp({ quality: 82 }).toFile(tmp);
    } else {
      await previewClip(source, tmp, w);
    }
    await fs.rename(tmp, out);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** At most `w` wide, rounded to even pixels (H.264 needs them). */
const scaleTo = (w: number) => `scale='2*trunc(min(iw,${w})/2)':-2`;

/** The frame a card shows before it plays: a tenth of a second in, past any black first frame (as the players start). */
async function openingFrame(source: string, w: number) {
  for (const at of ["0.1", "0"]) {
    const r = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", at, "-i", source, "-frames:v", "1", "-vf", scaleTo(w), "-f", "image2pipe", "-c:v", "png", "-"], {
      timeoutMs: 60_000,
      background: true,
    });
    if (r.code === 0 && r.stdout.length) return r.stdout;
  }
  throw new Error("couldn't read a frame");
}

async function previewClip(source: string, tmp: string, w: number) {
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-t", String(CLIP_SECONDS), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", scaleTo(w)];
  // Clean at card size; the cap only bites on grainy footage, which would otherwise come out several MB.
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", tmp];
  const opts = { timeoutMs: 4 * 60_000, background: true };
  // More than 30 frames a second only costs decoding in a card. (Older ffmpeg builds lack -fpsmax.)
  let r = await runFfmpeg([...input, "-fpsmax", "30", ...encode], opts);
  if (r.code !== 0) r = await runFfmpeg([...input, ...encode], opts);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `ffmpeg exited with ${r.code}`);
}

/**
 * The copies cards and strips ask for most: two picture widths (by screen density; the Library's
 * bigger cards take the wider one), a clip and its opening frame.
 */
const USUAL: Record<"image" | "video", [number, PreviewVariant][]> = {
  image: [
    [640, null],
    [960, null],
  ],
  video: [
    [640, "poster"],
    [960, "poster"],
    [640, null],
  ],
};

/**
 * Make the usual copies of these files in the background, one at a time and newest first (pass
 * them in the order they're shown), so they're ready by the time their cards scroll into view.
 * `posters: false` skips clips' opening frames, for cards that have a still of their own.
 */
export function warmPreviews(files: string[], { posters = true }: { posters?: boolean } = {}) {
  const w = state.warm;
  for (const file of files) {
    const kind = kindOf(file);
    if ((kind !== "image" && kind !== "video") || w.seen.has(file)) continue;
    w.seen.add(file);
    for (const [width, variant] of USUAL[kind]) if (posters || variant !== "poster") w.queue.push([file, width, variant]);
  }
  if (w.running || !w.queue.length) return;
  w.running = true;
  void (async () => {
    try {
      for (let next = w.queue.shift(); next; next = w.queue.shift()) await preview(...next).catch(() => null);
    } finally {
      w.running = false;
    }
  })();
}
