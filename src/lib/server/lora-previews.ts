import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./paths";

/**
 * A LoRA's example in the LoRA library, made small and kept on disk (data/cache/lora-previews): a page shows dozens at
 * once, and the originals on Hugging Face are several-megabyte PNGs and clips.
 * - the still: a 512 px WebP (a clip's frame a second in);
 * - the clip, for an example that moves: a short, muted H.264 loop a card plays while the pointer is on it.
 * Only what the library decided to show reaches here (server/loras `previewSource`): a checked pick's example, or one of
 * a LoRA whose example was looked at.
 */

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "lora-previews");
/** Hugging Face's own hosts, and a file that is a picture or a clip. */
const SOURCE = /^https:\/\/(huggingface\.co|cdn-uploads\.huggingface\.co)\/[^?#]+\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
/** One that failed is tried again only after this long. */
const MISSING_FOR = 30 * 60_000;

type State = { making: Map<string, Promise<string | null>>; missing: Map<string, number>; busy: Record<"still" | "clip", number>; waiting: Record<"still" | "clip", (() => void)[]> };
const g = globalThis as unknown as { __crackioLoraExamples?: State };
const state: State = (g.__crackioLoraExamples ??= { making: new Map(), missing: new Map(), busy: { still: 0, clip: 0 }, waiting: { still: [], clip: [] } });

/** A page of cards asks for two dozen at once: four stills and two clips are made at a time, the rest wait their turn. */
async function lane<T>(kind: "still" | "clip", job: () => Promise<T>): Promise<T> {
  const most = kind === "still" ? 4 : 2;
  while (state.busy[kind] >= most) await new Promise<void>((r) => state.waiting[kind].push(r));
  state.busy[kind]++;
  try {
    return await job();
  } finally {
    state.busy[kind]--;
    state.waiting[kind].shift()?.();
  }
}

/** Its file in the cache: the LoRA's id, and its source's address (a new example is made anew). */
const fileOf = (key: string, url: string, ext: string) =>
  path.join(/*turbopackIgnore: true*/ DIR, `${key.replace(/[^\w.-]+/g, "_").slice(0, 120)}.${createHash("sha1").update(`${url}|${ext === "mp4" ? CLIP_WIDTH : 512}`).digest("hex").slice(0, 8)}.${ext}`);

async function once(file: string, make: () => Promise<boolean>): Promise<string | null> {
  if (await fs.stat(/*turbopackIgnore: true*/ file).then((s) => s.size > 0, () => false)) return file;
  const missed = state.missing.get(file);
  if (missed && Date.now() - missed < MISSING_FOR) return null;
  let job = state.making.get(file);
  if (!job) {
    job = (async () => {
      await fs.mkdir(/*turbopackIgnore: true*/ DIR, { recursive: true });
      return (await make().catch(() => false)) ? file : null;
    })().finally(() => state.making.delete(file));
    state.making.set(file, job);
  }
  const made = await job;
  if (!made) state.missing.set(file, Date.now());
  return made;
}

/**
 * Your Hugging Face token, for a repo that asks you to accept its terms first (Lightricks' LTX LoRAs): sent to
 * huggingface.co alone, never to another host.
 */
const auth = (url: string, token?: string) => (token && url.startsWith("https://huggingface.co/") ? { Authorization: `Bearer ${token}` } : null);
/** The same, as ffmpeg takes it (before its `-i`). */
const ffAuth = (url: string, token?: string) => (auth(url, token) ? ["-headers", `Authorization: Bearer ${token}\r\n`] : []);

async function download(url: string, token?: string, most = 40 * 1024 * 1024): Promise<Buffer | null> {
  const res = await fetch(url, { headers: { "User-Agent": "crackio", ...auth(url, token) }, signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!res?.ok || Number(res.headers.get("content-length") ?? 0) > most) return null;
  const data = Buffer.from(await res.arrayBuffer());
  return data.length <= most ? data : null;
}

/** The example as a small still; null when it can't be read. */
export async function loraStill(key: string, url: string, token?: string): Promise<string | null> {
  if (!SOURCE.test(url)) return null;
  const file = fileOf(key, url, "webp");
  return once(file, () =>
    lane("still", async () => {
      let data: Buffer | null = null;
      if (VIDEO.test(url)) {
        // A clip: one frame a second in (its opening frame when it's shorter), read straight from Hugging Face: ffmpeg
        // asks for the bytes it needs, not the whole clip.
        const { runFfmpeg } = await import("@/lib/motion/ffmpeg");
        const frame = `${file}.frame.png`;
        for (const at of ["1", "0"]) {
          const run = await runFfmpeg(["-y", "-ss", at, ...ffAuth(url, token), "-i", url, "-frames:v", "1", "-vf", "scale=640:-2", frame], { timeoutMs: 90_000, background: true }).catch(() => null);
          data = run?.code === 0 ? await fs.readFile(/*turbopackIgnore: true*/ frame).catch(() => null) : null;
          if (data?.length) break;
        }
        await fs.rm(/*turbopackIgnore: true*/ frame, { force: true });
      } else data = await download(url, token);
      if (!data?.length) return false;
      const { default: sharp } = await import("sharp");
      const small = await sharp(data, { pages: 1 })
        .rotate()
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer()
        .catch(() => null);
      if (!small) return false;
      await fs.writeFile(/*turbopackIgnore: true*/ file, small);
      return true;
    }),
  );
}

/**
 * The example as a smear of its colours: 40 px wide and blurred, for a card that keeps its example back until asked
 * (an unchecked LoRA whose words say it may be suggestive). Nothing of the picture can be made out, and the browser
 * has only this until the button is pressed.
 */
export async function loraBlur(key: string, url: string, token?: string): Promise<string | null> {
  const still = await loraStill(key, url, token);
  if (!still) return null;
  const file = still.replace(/\.webp$/, ".blur.webp");
  return once(file, async () => {
    const { default: sharp } = await import("sharp");
    const small = await sharp(still).resize({ width: 40, height: 40, fit: "inside" }).blur(4).webp({ quality: 60 }).toBuffer().catch(() => null);
    if (!small) return false;
    await fs.writeFile(/*turbopackIgnore: true*/ file, small);
    return true;
  });
}

/** How much of an example a card plays, and how wide. */
const CLIP_SECONDS = 5;
const CLIP_WIDTH = 640;
const ENCODE = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "29", "-preset", "veryfast", "-movflags", "+faststart"];
const SCALE = `scale='trunc(min(${CLIP_WIDTH},iw)/2)*2':-2`;

/** The example as a short muted loop; null when it's a still picture, or can't be read. */
export async function loraClip(key: string, url: string, token?: string): Promise<string | null> {
  if (!SOURCE.test(url) || /\.(png|jpe?g)$/i.test(url)) return null;
  const file = fileOf(key, url, "mp4");
  return once(file, () =>
    lane("clip", async () => {
      const { runFfmpeg } = await import("@/lib/motion/ffmpeg");
      const part = `${file}.part.mp4`;
      let ok = false;
      if (!/\.webp$/i.test(url)) {
        const run = await runFfmpeg(["-y", "-t", String(CLIP_SECONDS), ...ffAuth(url, token), "-i", url, "-vf", `${SCALE},fps=20`, ...ENCODE, part], { timeoutMs: 150_000, background: true }).catch(() => null);
        ok = run?.code === 0;
      } else {
        // An animated WebP: ffmpeg doesn't read those, so its frames are written out first.
        const source = await download(url, token);
        if (!source) return false;
        const { default: sharp } = await import("sharp");
        const meta = await sharp(source, { animated: true }).metadata().catch(() => null);
        const pages = meta?.pages ?? 1;
        const width = meta?.width ?? 0;
        const height = meta?.pageHeight ?? meta?.height ?? 0;
        if (pages < 2 || !width || !height) return false;
        const delay = meta?.delay?.find((d) => d > 0) ?? 67;
        const fps = Math.max(6, Math.min(30, Math.round(1000 / delay)));
        const keep = Math.min(pages, CLIP_SECONDS * fps);
        const dir = await fs.mkdtemp(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ os.tmpdir(), "crackio-lora-"));
        try {
          const { data } = await sharp(source, { animated: true, pages: keep }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const frame = width * height * 4;
          for (let i = 0; i < keep; i++) {
            await sharp(data.subarray(i * frame, (i + 1) * frame), { raw: { width, height, channels: 4 } })
              .png({ compressionLevel: 1 })
              .toFile(path.join(/*turbopackIgnore: true*/ dir, `${String(i).padStart(4, "0")}.png`));
          }
          const run = await runFfmpeg(["-y", "-framerate", String(fps), "-i", path.join(/*turbopackIgnore: true*/ dir, "%04d.png"), "-vf", SCALE, ...ENCODE, part], { timeoutMs: 150_000, background: true }).catch(() => null);
          ok = run?.code === 0;
        } finally {
          await fs.rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (!ok) {
        await fs.rm(/*turbopackIgnore: true*/ part, { force: true });
        return false;
      }
      await fs.rename(/*turbopackIgnore: true*/ part, file);
      return true;
    }),
  );
}
