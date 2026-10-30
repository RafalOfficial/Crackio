import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { runFfmpeg } from "@/lib/motion/ffmpeg";
import { PREVIEW_TRIM, trimKey } from "@/lib/models/gallery";

/**
 * A model's preview in the model library, from its official ComfyUI template (Comfy-Org/workflow_templates, MIT): what
 * ComfyUI's own template browser shows for it.
 * - `still`: the opening frame of its preview, as a light WebP.
 * - `clip`: a video template's animated preview as a short, muted H.264 loop. Half the animated WebP's size, and the
 *   browser decodes it on the GPU instead of the CPU.
 * - `before`: a compare template's other picture (the photo an edit or upscale started from).
 * Fetched once, kept in data/cache/model-previews.
 */

export type PreviewKind = "still" | "clip" | "before";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "model-previews");
const SOURCE = "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates";
/** Templates Comfy has retired keep their previews in the repo's archive. */
const ARCHIVE = "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/archived";
const ARCHIVED = new Set(["api_veo3"]);
/** A preview the templates don't have is asked for again only after this long. */
const MISSING_FOR = 30 * 60_000;

type State = { making: Map<string, Promise<string | null>>; missing: Map<string, number>; clips: number; waiting: (() => void)[] };
// On globalThis, so a hot reload in development keeps what it learned.
const g = globalThis as unknown as { __crackioModelPreviews?: State };
const state: State = (g.__crackioModelPreviews ??= { making: new Map(), missing: new Map(), clips: 0, waiting: [] });

/** Two clips at a time: each one decodes every frame of its preview. */
async function clipLane<T>(job: () => Promise<T>): Promise<T> {
  while (state.clips >= 2) await new Promise<void>((r) => state.waiting.push(r));
  state.clips++;
  try {
    return await job();
  } finally {
    state.clips--;
    state.waiting.shift()?.();
  }
}

async function fetchWebp(name: string, n: 1 | 2): Promise<Buffer | null> {
  const res = await fetch(`${ARCHIVED.has(name) ? ARCHIVE : SOURCE}/${encodeURIComponent(name)}-${n}.webp`, { signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!res?.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** The animated preview's frames, as PNGs in a scratch folder, and the rate they play at. */
async function framesOf(source: Buffer, dir: string): Promise<number | null> {
  const meta = await sharp(source, { animated: true }).metadata();
  const pages = meta.pages ?? 1;
  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? meta.height ?? 0;
  if (pages < 2 || !width || !height) return null;
  const { data } = await sharp(source, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frame = width * height * 4;
  for (let i = 0; i < pages; i++) {
    await sharp(data.subarray(i * frame, (i + 1) * frame), { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 1 })
      .toFile(path.join(dir, `${String(i).padStart(4, "0")}.png`));
  }
  const delay = meta.delay?.find((d) => d > 0) ?? 67;
  return Math.max(6, Math.min(30, Math.round(1000 / delay)));
}

async function make(name: string, kind: PreviewKind): Promise<string | null> {
  // A trimmed one (gallery PREVIEW_TRIM) is kept under its trim, so a new trim makes it again.
  const trim = PREVIEW_TRIM[name];
  const base = trim ? `${name}.t${trimKey(trim)}` : name;
  const file = path.join(DIR, `${base}.${kind === "clip" ? "mp4" : kind === "before" ? "before.webp" : "webp"}`);
  if (await fs.stat(file).then((s) => s.size > 0).catch(() => false)) return file;
  const source = await fetchWebp(name, kind === "before" ? 2 : 1);
  if (!source) return null;
  await fs.mkdir(DIR, { recursive: true });
  const { top = 0, right = 0, bottom = 0, left = 0 } = trim ?? {};
  if (kind !== "clip") {
    const size = trim ? await sharp(source, { pages: 1 }).metadata() : null;
    const height = size?.pageHeight ?? size?.height;
    const first = sharp(source, { pages: 1 });
    if (size?.width && height) first.extract({ left, top, width: size.width - left - right, height: height - top - bottom });
    const still = await first
      .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
      .catch(() => null);
    if (!still) return null;
    await fs.writeFile(file, still);
    return file;
  }
  return clipLane(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-preview-"));
    try {
      const fps = await framesOf(source, dir).catch(() => null);
      if (!fps) return null;
      const tmp = `${file}.part.mp4`;
      const run = await runFfmpeg(
        ["-y", "-framerate", String(fps), "-i", path.join(dir, "%04d.png"), "-vf", `${trim ? `crop=iw-${left + right}:ih-${top + bottom}:${left}:${top},` : ""}scale=trunc(iw/2)*2:trunc(ih/2)*2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "veryfast", "-movflags", "+faststart", "-an", tmp],
        { timeoutMs: 120_000, background: true },
      );
      if (run.code !== 0) return null;
      await fs.rename(tmp, file);
      return file;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/** The cached preview file, made on first ask; null when the template has none of that kind. */
export async function modelPreview(name: string, kind: PreviewKind): Promise<string | null> {
  const key = `${name}:${kind}`;
  const missed = state.missing.get(key);
  if (missed && Date.now() - missed < MISSING_FOR) return null;
  let job = state.making.get(key);
  if (!job) {
    job = make(name, kind)
      .catch(() => null)
      .finally(() => state.making.delete(key));
    state.making.set(key, job);
  }
  const file = await job;
  if (!file) state.missing.set(key, Date.now());
  return file;
}
