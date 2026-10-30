import "server-only";
import fs from "node:fs/promises";

/**
 * What the Library shows about a file beyond its picture: how big it is, and a clip's length and
 * frame rate. Clips are read straight from their MP4 header (a few small reads, no ffmpeg), and
 * each answer is kept until the file changes.
 */
export type MediaInfo = { bytes: number; duration?: number; fps?: number };

type Entry = { mtimeMs: number; info: MediaInfo };
// On globalThis, so a hot reload in development keeps what's been read.
const g = globalThis as unknown as { __crackioMediaInfo?: Map<string, Entry> };
const cache = (g.__crackioMediaInfo ??= new Map());

/** A header bigger than this isn't read (a normal clip's is well under a megabyte). */
const MOOV_MAX = 32 * 1024 * 1024;

/**
 * `fresh`: check the file hasn't changed since it was read. Outputs are written once under a new
 * name, so listings skip that and answer from memory.
 */
export async function mediaInfo(file: string, { fresh = false }: { fresh?: boolean } = {}): Promise<MediaInfo | null> {
  const hit = cache.get(file);
  if (hit && !fresh) return hit.info;
  const stat = await fs.stat(/*turbopackIgnore: true*/ file).catch(() => null);
  if (!stat?.isFile()) return null;
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.info;
  const info: MediaInfo = { bytes: stat.size };
  if (/\.(mp4|m4v|mov)$/i.test(file)) Object.assign(info, await mp4Timing(file, stat.size).catch(() => null));
  cache.set(file, { mtimeMs: stat.mtimeMs, info });
  return info;
}

/** Finds the top-level `moov` box and reads the timing out of it. */
async function mp4Timing(file: string, size: number) {
  const fh = await fs.open(/*turbopackIgnore: true*/ file, "r");
  try {
    const head = Buffer.alloc(16);
    for (let at = 0; at + 8 <= size; ) {
      const { bytesRead } = await fh.read(head, 0, 16, at);
      if (bytesRead < 8) return null;
      let len = head.readUInt32BE(0);
      let header = 8;
      if (len === 1) {
        if (bytesRead < 16) return null;
        len = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (len === 0) len = size - at;
      if (len < header) return null;
      if (head.toString("latin1", 4, 8) === "moov") {
        if (len > MOOV_MAX) return null;
        const moov = Buffer.alloc(len - header);
        await fh.read(moov, 0, moov.length, at + header);
        return readMoov(moov);
      }
      at += len;
    }
    return null;
  } finally {
    await fh.close();
  }
}

type Box = { type: string; start: number; end: number };

/** The boxes directly inside `start`–`end` of `buf`. */
function* boxes(buf: Buffer, start = 0, end = buf.length): Generator<Box> {
  for (let at = start; at + 8 <= end; ) {
    let len = buf.readUInt32BE(at);
    let header = 8;
    if (len === 1) {
      if (at + 16 > end) return;
      len = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (len === 0) len = end - at;
    if (len < header || at + len > end) return;
    yield { type: buf.toString("latin1", at + 4, at + 8), start: at + header, end: at + len };
    at += len;
  }
}

function child(buf: Buffer, box: Box | null, type: string) {
  if (!box) return null;
  for (const b of boxes(buf, box.start, box.end)) if (b.type === type) return b;
  return null;
}

/** `mvhd` and `mdhd` share a layout: version 1 has 64-bit times, so the timescale sits further in. */
function timescaleAndLength(buf: Buffer, box: Box) {
  const v1 = buf[box.start] === 1;
  const timescale = buf.readUInt32BE(box.start + (v1 ? 20 : 12));
  const length = v1 ? Number(buf.readBigUInt64BE(box.start + 24)) : buf.readUInt32BE(box.start + 16);
  return { timescale, length };
}

function readMoov(moov: Buffer): { duration?: number; fps?: number } {
  let duration: number | undefined;
  let fps: number | undefined;
  for (const box of boxes(moov)) {
    if (box.type === "mvhd") {
      const { timescale, length } = timescaleAndLength(moov, box);
      if (timescale > 0 && length > 0) duration = Math.round((length / timescale) * 100) / 100;
    } else if (box.type === "trak" && fps === undefined) fps = videoFps(moov, box);
  }
  return { duration, fps };
}

/** Frames per second of a video track: its samples over its length, from the sample-timing table. */
function videoFps(buf: Buffer, trak: Box) {
  const mdia = child(buf, trak, "mdia");
  const hdlr = child(buf, mdia, "hdlr");
  // hdlr: version and flags (4), pre_defined (4), then the handler type.
  if (!mdia || !hdlr || buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") return undefined;
  const mdhd = child(buf, mdia, "mdhd");
  const stts = child(buf, child(buf, child(buf, mdia, "minf"), "stbl"), "stts");
  if (!mdhd || !stts) return undefined;
  const { timescale } = timescaleAndLength(buf, mdhd);
  const entries = buf.readUInt32BE(stts.start + 4);
  let samples = 0;
  let ticks = 0;
  for (let i = 0; i < entries; i++) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) break;
    const count = buf.readUInt32BE(at);
    samples += count;
    ticks += count * buf.readUInt32BE(at + 4);
  }
  if (!timescale || !samples || !ticks) return undefined;
  return Math.round(((samples * timescale) / ticks) * 100) / 100;
}
