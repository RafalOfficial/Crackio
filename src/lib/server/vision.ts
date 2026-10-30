import "server-only";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { DATA_DIR, UPLOADS_DIR } from "./paths";

/**
 * Director's eyes: two small open models that run on this computer.
 *  - depth: Depth Anything V2 Small (Apache-2.0) turns a photo into a depth map, so a location
 *    photo becomes a 3D set the camera can move through.
 *  - cutout: BiRefNet lite at 512px (MIT) lifts a person or object off its background.
 * Weights are downloaded once into data/models (or CRACKIO_MODELS_DIR), pinned to a revision
 * and checked against their SHA-256. On Windows they run on the GPU through DirectML.
 */
const MODELS_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.CRACKIO_MODELS_DIR || path.join(DATA_DIR, "models"));
const CACHE_DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "vision");

export type VisionModelId = "depth" | "cutout";

const MODELS: Record<VisionModelId, { file: string; url: string; sha256: string; bytes: number }> = {
  depth: {
    file: "depth-anything-v2-small-int8.onnx",
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx",
    sha256: "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d",
    bytes: 27_258_801,
  },
  cutout: {
    file: "birefnet-lite-512.onnx",
    url: "https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model.onnx",
    sha256: "1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2",
    bytes: 191_877_254,
  },
};
/** Bump to invalidate cached results when pre/post-processing changes. */
const PIPELINE_VERSION = 4;

export type ModelStatus = { state: "missing" | "downloading" | "loading" | "ready" | "error"; received: number; total: number; error?: string };

type Loaded = { session: InferenceSession; device: "gpu" | "cpu"; queue: Promise<unknown> };
type VisionState = {
  status: Record<VisionModelId, ModelStatus>;
  sessions: Partial<Record<VisionModelId, Promise<Loaded>>>;
};
// Survives hot reloads in dev, so models load once per server.
const g = globalThis as unknown as { __crackioVision?: VisionState };
const state: VisionState = (g.__crackioVision ??= {
  status: {
    depth: { state: "missing", received: 0, total: MODELS.depth.bytes },
    cutout: { state: "missing", received: 0, total: MODELS.cutout.bytes },
  },
  sessions: {},
});

export function visionStatus() {
  return state.status;
}

async function exists(file: string) {
  return fs.stat(file).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

async function sha256(file: string) {
  const hash = createHash("sha256");
  const handle = await fs.open(file);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function download(id: VisionModelId) {
  const m = MODELS[id];
  const target = path.join(/*turbopackIgnore: true*/ MODELS_DIR, m.file);
  if (await exists(target)) return target;
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const status = state.status[id];
  Object.assign(status, { state: "downloading", received: 0, total: m.bytes, error: undefined });
  const res = await fetch(m.url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the ${id} model (HTTP ${res.status}).`);
  const partial = `${target}.part`;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => (status.received += chunk.length));
  try {
    await pipeline(body, createWriteStream(partial));
  } catch (err) {
    await fs.rm(partial, { force: true });
    const full = /ENOSPC/.test(String(err));
    throw new Error(full ? "The disk is full, so the 3D tools couldn't be downloaded. Free some space and try again." : `Downloading the ${id} model failed.`);
  }
  if ((await sha256(partial)) !== m.sha256) {
    await fs.rm(partial, { force: true });
    throw new Error(`The downloaded ${id} model didn't match its checksum.`);
  }
  await fs.rename(partial, target);
  return target;
}

async function load(id: VisionModelId): Promise<Loaded> {
  const status = state.status[id];
  try {
    const file = await download(id);
    status.state = "loading";
    const ort = await import("onnxruntime-node");
    let loaded: Loaded | null = null;
    if (process.platform === "win32") {
      try {
        // DirectML can't run two inferences at once or reuse memory patterns.
        const session = await ort.InferenceSession.create(file, {
          executionProviders: ["dml", "cpu"],
          executionMode: "sequential",
          enableMemPattern: false,
          graphOptimizationLevel: "all",
          logSeverityLevel: 3,
        });
        loaded = { session, device: "gpu", queue: Promise.resolve() };
      } catch {
        loaded = null;
      }
    }
    if (!loaded) {
      const session = await ort.InferenceSession.create(file, { executionProviders: ["cpu"], graphOptimizationLevel: "all", logSeverityLevel: 3 });
      loaded = { session, device: "cpu", queue: Promise.resolve() };
    }
    Object.assign(status, { state: "ready", received: status.total });
    return loaded;
  } catch (err) {
    Object.assign(status, { state: "error", error: (err as Error).message });
    delete state.sessions[id];
    throw err;
  }
}

function session(id: VisionModelId) {
  return (state.sessions[id] ??= load(id));
}

/** One inference at a time per model (DirectML requires it, and it keeps memory flat). */
async function infer(id: VisionModelId, feeds: (s: InferenceSession) => Record<string, Tensor>) {
  const loaded = await session(id);
  const run = loaded.queue.then(() => loaded.session.run(feeds(loaded.session)));
  loaded.queue = run.catch(() => undefined);
  const out = await run;
  return out[loaded.session.outputNames[0]] as Tensor;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function imageTensor(file: string, width: number, height: number) {
  const ort = await import("onnxruntime-node");
  const { data } = await sharp(file, { failOn: "none" })
    .flatten({ background: "#7f7f7f" })
    .resize(width, height, { fit: "fill", kernel: "cubic" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = width * height;
  const f = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) f[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return new ort.Tensor("float32", f, [1, 3, height, width]);
}

async function cacheKey(file: string, task: string) {
  const s = await fs.stat(file);
  return createHash("sha1").update(`${PIPELINE_VERSION}|${task}|${file}|${s.size}|${s.mtimeMs}`).digest("hex").slice(0, 20);
}

export type DepthResult = { width: number; height: number; /** Little-endian uint16, 0 = far, 65535 = near. */ data: string };

/**
 * Relative depth of a photo, as disparity normalized to 0…1 (1 = nearest). Kept at the model's
 * resolution (~518px on the long edge); the 3D set interpolates between samples.
 */
export async function estimateDepth(file: string): Promise<DepthResult> {
  const key = await cacheKey(file, "depth");
  const cached = path.join(/*turbopackIgnore: true*/ CACHE_DIR, `${key}.depth`);
  const hit = await fs.readFile(cached).catch(() => null);
  if (hit) return decodeDepth(hit);

  const meta = await sharp(file, { failOn: "none" }).metadata();
  const w0 = meta.width ?? 518;
  const h0 = meta.height ?? 518;
  const scale = 518 / Math.max(w0, h0);
  const width = Math.max(14, Math.round((w0 * scale) / 14) * 14);
  const height = Math.max(14, Math.round((h0 * scale) / 14) * 14);
  const input = await imageTensor(file, width, height);
  const result = await infer("depth", (s) => ({ [s.inputNames[0]]: input }));
  const raw = result.data as Float32Array;
  const [oh, ow] = result.dims.slice(-2);

  // Robust range: ignore the most extreme 0.5% on each side.
  const sorted = Float32Array.from(raw).sort();
  const lo = sorted[Math.floor(sorted.length * 0.005)];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
  const span = Math.max(1e-6, hi - lo);
  const buf = Buffer.alloc(8 + ow * oh * 2);
  buf.writeUInt32LE(ow, 0);
  buf.writeUInt32LE(oh, 4);
  for (let i = 0; i < ow * oh; i++) {
    const v = Math.min(1, Math.max(0, (raw[i] - lo) / span));
    buf.writeUInt16LE(Math.round(v * 65535), 8 + i * 2);
  }
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cached, buf).catch(() => undefined);
  return decodeDepth(buf);
}

function decodeDepth(buf: Buffer): DepthResult {
  return { width: buf.readUInt32LE(0), height: buf.readUInt32LE(4), data: buf.subarray(8).toString("base64") };
}

export type MaskResult = { width: number; height: number; /** One byte per pixel, 255 = subject; all zero when nothing stands out. */ data: string };

/**
 * Where the photo's subject is, as a matte over the whole frame at the cutout model's resolution.
 * (`cutout` trims to the subject; Angles needs it in place to give the subject a body.)
 */
export async function subjectMask(file: string): Promise<MaskResult> {
  const key = await cacheKey(file, "mask");
  const cached = path.join(/*turbopackIgnore: true*/ CACHE_DIR, `${key}.mask`);
  const hit = await fs.readFile(cached).catch(() => null);
  if (hit) return decodeMask(hit);

  const S = 512;
  const input = await imageTensor(file, S, S);
  const logits = (await infer("cutout", (s) => ({ [s.inputNames[0]]: input }))).data as Float32Array;
  const buf = Buffer.alloc(8 + S * S);
  buf.writeUInt32LE(S, 0);
  buf.writeUInt32LE(S, 4);
  let covered = 0;
  for (let i = 0; i < S * S; i++) {
    const p = 1 / (1 + Math.exp(-logits[i]));
    // The same firmer edge as cutouts.
    const a = Math.min(1, Math.max(0, (p - 0.18) / 0.64));
    buf[8 + i] = Math.round(a * 255);
    if (a > 0.5) covered++;
  }
  const share = covered / (S * S);
  if (share < 0.004 || share > 0.97) buf.fill(0, 8);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cached, buf).catch(() => undefined);
  return decodeMask(buf);
}

/**
 * The picture with its subject's matte as the alpha channel (a PNG), for models that are told exactly
 * where the subject is (SCAIL-2's reference mask); null when the cutout model finds no clear subject.
 */
export async function withSubjectMatte(file: string): Promise<Buffer | null> {
  const m = await subjectMask(file);
  const matte = Buffer.from(m.data, "base64");
  if (!matte.some((v) => v > 127)) return null;
  // The colours first, as raw RGB: sharp applies removeAlpha at the very end, so it can't share a pipeline with joinChannel.
  const rgb = await sharp(file, { failOn: "none" }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = rgb.info;
  // The model saw the picture stretched to a square, so the matte stretches back the same way.
  // extractChannel keeps it one byte per pixel (resizing a one-band raw image can come back as three bands).
  const alpha = await sharp(matte, { raw: { width: m.width, height: m.height, channels: 1 } }).resize(width, height, { fit: "fill", kernel: "cubic" }).extractChannel(0).raw().toBuffer();
  return sharp(rgb.data, { raw: { width, height, channels: 3 } }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function decodeMask(buf: Buffer): MaskResult {
  return { width: buf.readUInt32LE(0), height: buf.readUInt32LE(4), data: buf.subarray(8).toString("base64") };
}

export type CutoutResult = { url: string; width: number; height: number; cutout: boolean; note?: string };

/**
 * Lift the subject off its background. Images that already carry transparency are used as-is.
 * The result is trimmed to the subject, so its height in the image is its real height.
 */
export async function cutout(file: string, sourceUrl: string): Promise<CutoutResult> {
  const meta = await sharp(file, { failOn: "none" }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (meta.hasAlpha) {
    const { data, info } = await sharp(file).extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
    let clear = 0;
    for (let i = 0; i < data.length; i += 7) if (data[i] < 128) clear++;
    if (clear / (data.length / 7) > 0.02) return { url: sourceUrl, width: info.width, height: info.height, cutout: true };
  }

  const key = await cacheKey(file, "cutout");
  const name = `cut-${key}.png`;
  const target = path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name);
  if (await exists(target)) {
    const m = await sharp(target).metadata();
    return { url: `/api/media/uploads/${name}`, width: m.width ?? 0, height: m.height ?? 0, cutout: true };
  }

  const S = 512;
  const input = await imageTensor(file, S, S);
  const logits = (await infer("cutout", (s) => ({ [s.inputNames[0]]: input }))).data as Float32Array;
  const mask = Buffer.alloc(S * S);
  let covered = 0;
  for (let i = 0; i < S * S; i++) {
    const p = 1 / (1 + Math.exp(-logits[i]));
    // Firm up the edge a little: soft halos read as a glow around the subject in 3D.
    const a = Math.min(1, Math.max(0, (p - 0.18) / 0.64));
    mask[i] = Math.round(a * 255);
    if (a > 0.5) covered++;
  }
  const share = covered / (S * S);
  if (share < 0.004 || share > 0.97) {
    return { url: sourceUrl, width, height, cutout: false, note: share > 0.97 ? "The whole photo looks like the subject, so it's used as-is." : "No clear subject found, so the photo is used as-is." };
  }

  // Scale the mask back to the photo (capped so cutouts stay light), attach it, trim to the subject.
  const long = Math.min(1600, Math.max(width, height));
  const k = long / Math.max(width, height);
  const W = Math.max(1, Math.round(width * k));
  const H = Math.max(1, Math.round(height * k));
  // One band in, one band out: without extractChannel libvips can hand back three, which scrambles the matte.
  const alpha = await sharp(mask, { raw: { width: S, height: S, channels: 1 } })
    .resize(W, H, { fit: "fill", kernel: "cubic" })
    .extractChannel(0)
    .raw()
    .toBuffer();
  if (alpha.length !== W * H) throw new Error("The cutout came out the wrong size.");
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = Math.round(Math.max(W, H) * 0.012);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const cw = Math.min(W, maxX + pad + 1) - left;
  const ch = Math.min(H, maxY + pad + 1) - top;
  const rgb = await sharp(file, { failOn: "none" }).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  // Two passes: in one pipeline sharp crops before it joins the matte, which would misalign them.
  const rgba = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } })
    .raw()
    .toBuffer();
  const out = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left, top, width: Math.max(1, cw), height: Math.max(1, ch) })
    .png({ compressionLevel: 8 })
    .toFile(target);
  return { url: `/api/media/uploads/${name}`, width: out.width, height: out.height, cutout: true };
}
