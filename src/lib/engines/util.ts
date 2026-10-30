import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { EngineError, type EngineJob, type EngineOutput, type EngineReference } from "./types";

/** A reference file as a data URL, downscaled so requests stay small (models read ~1K references anyway). */
export async function toDataUrl(ref: EngineReference, maxEdge = 1536) {
  const data = await fs.readFile(ref.path);
  const ext = path.extname(ref.path).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const resized = await sharp(data).resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true }).toBuffer();
  return `data:${mime};base64,${resized.toString("base64")}`;
}

/** gpt-image sizes: both edges multiples of 16, long edge ≤ 3840, ratio ≤ 3:1, 655,360–8,294,400 pixels in all. */
export function gptImageSize(w: number, h: number, longEdge = 1536) {
  const ratio = Math.min(3, Math.max(1 / 3, w / h));
  let long = Math.min(3840, Math.max(1024, longEdge));
  const short = () => (ratio >= 1 ? long / ratio : long * ratio);
  // Keep the total inside the pixel budget (a wide 1024 frame is too small; a big square too large).
  const area = () => long * short();
  if (area() < 655_360) long = Math.min(3840, Math.sqrt(655_360 * Math.max(ratio, 1 / ratio)));
  if (area() > 8_294_400) long = Math.sqrt(8_294_400 * Math.max(ratio, 1 / ratio));
  const up = (n: number) => Math.max(256, Math.ceil(n / 16) * 16);
  const down = (n: number) => Math.max(256, Math.floor(n / 16) * 16);
  const snap = area() <= 700_000 ? up : down;
  return ratio >= 1 ? `${snap(long)}x${snap(long / ratio)}` : `${snap(long * ratio)}x${snap(long)}`;
}

/** The long edge a picked image resolution asks for: "2048" (Crackio's 2K), "4K", "1.5K"… */
export function longEdgeFor(resolution: string | number | undefined | null): number | undefined {
  if (resolution === undefined || resolution === null) return undefined;
  const v = String(resolution).trim().toLowerCase();
  if (/^\d{3,4}$/.test(v)) return Number(v);
  const k = /^(\d+(?:\.\d+)?)k$/.exec(v);
  return k ? Math.round(Number(k[1]) * 1024) : undefined;
}

/** Fetch a result URL (or decode base64) into bytes. */
export async function fetchOutput(
  item: { url?: string; b64?: string; mime?: string },
  signal: AbortSignal,
  label = "the engine",
): Promise<EngineOutput> {
  if (item.b64) return { data: Buffer.from(item.b64, "base64"), mime: item.mime ?? "image/png" };
  if (!item.url) throw new EngineError(`${label} returned no image.`);
  if (item.url.startsWith("data:")) {
    const [head, b64] = item.url.split(",", 2);
    return { data: Buffer.from(b64, "base64"), mime: head.slice(5).split(";")[0] || "image/png" };
  }
  const res = await fetch(item.url, { signal });
  if (!res.ok) throw new EngineError(`Couldn't download the result from ${label} (${res.status}).`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: item.mime ?? res.headers.get("content-type") ?? "image/png" };
}

/** Center-crop to the exact aspect ratio that was asked for (engines often round to their own presets). */
export async function fitAspect(out: EngineOutput, target: number): Promise<EngineOutput> {
  const img = sharp(out.data);
  const { width = 0, height = 0 } = await img.metadata();
  if (!width || !height || Math.abs(width / height - target) / target < 0.01) return { ...out, width, height };
  const w = width / height > target ? Math.round(height * target) : width;
  const h = width / height > target ? height : Math.round(width / target);
  const data = await img
    .extract({ left: Math.round((width - w) / 2), top: Math.round((height - h) / 2), width: w, height: h })
    .png()
    .toBuffer();
  return { data, mime: "image/png", width: w, height: h };
}

/** Pick the closest ratio an engine supports, compared on a log scale. */
export function closestRatio(target: number, options: { id: string; r: number }[]) {
  return options.reduce((b, x) => (Math.abs(Math.log(x.r / target)) < Math.abs(Math.log(b.r / target)) ? x : b)).id;
}

/** A progress ticker for engines that report nothing while they work. `stage` can name the time so far (ms). */
export function ticker(progress: (v: number, stage?: string) => void, expectedMs: number, from = 0.2, stage: string | ((elapsedMs: number) => string) = "Rendering") {
  const started = Date.now();
  const t = setInterval(() => {
    const elapsed = Date.now() - started;
    progress(Math.min(0.92, from + (elapsed / expectedMs) * (0.92 - from)), typeof stage === "string" ? stage : stage(elapsed));
  }, 500);
  return () => clearInterval(t);
}

/**
 * Images to send, in the order prompts number them. A Director layout guide goes first: it's the
 * frame the model turns into the finished shot, and the references after it (image 2, 3, …) only
 * say who and where.
 */
/** Told to the model whenever frameCanvas adds a canvas. */
export const CANVAS_NOTE = "The last image is only a blank canvas that sets the frame of the result: compose the picture to fill it edge to edge.";

/**
 * Edit endpoints that keep the shape of the pictures they're given (ChatGPT's ignores `size`)
 * return a reference's shape, which then gets cropped to the shot: heads go missing. When the
 * first picture isn't already the shot's shape, this is a blank canvas in that shape to send last.
 */
export async function frameCanvas(first: EngineReference | undefined, ratio: number): Promise<string | null> {
  if (!first) return null;
  const { width = 0, height = 0 } = await sharp(first.path).metadata();
  if (!width || !height || Math.abs(Math.log(width / height / ratio)) < 0.04) return null;
  const w = ratio >= 1 ? 1536 : Math.round(1536 * ratio);
  const h = ratio >= 1 ? Math.round(1536 / ratio) : 1536;
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: "#d8d8da" } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

export function orderedInputs(job: Pick<EngineJob, "references" | "guide">, max: number) {
  const refs = job.references.slice(0, job.guide ? max - 1 : max);
  return job.guide ? [job.guide, ...refs] : refs;
}
