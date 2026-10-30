import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { MEDIA_DIR, TEMPLATES_DIR, UPLOADS_DIR } from "./paths";
import { mediaInfo } from "./media-info";
import { warmPreviews } from "./previews";
import { probe } from "@/lib/motion/ffmpeg";
import type { MediaRef } from "@/lib/generations/types";
import type { EngineOutput } from "@/lib/engines/types";

const PUBLIC_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "public");

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  json: "application/json",
  // Text the agent writes is shown as text, never run as a page.
  txt: "text/plain; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  css: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  lrc: "text/plain; charset=utf-8",
};

/** Resolve a URL Crackio handed out back to a file on disk. Returns null for anything else. */
export function urlToPath(url: string): string | null {
  const clean = decodeURIComponent(url.split("?")[0]);
  const within = (root: string, rel: string) => {
    const p = path.resolve(/*turbopackIgnore: true*/ root, rel);
    return p.startsWith(root + path.sep) ? p : null;
  };
  if (clean.startsWith("/api/media/uploads/")) return within(UPLOADS_DIR, clean.slice("/api/media/uploads/".length));
  if (clean.startsWith("/api/media/out/")) return within(MEDIA_DIR, clean.slice("/api/media/out/".length));
  if (clean.startsWith("/api/media/templates/")) return within(TEMPLATES_DIR, clean.slice("/api/media/templates/".length));
  if (clean.startsWith("/assets/")) return within(PUBLIC_DIR, clean.slice(1));
  return null;
}

/** Files behind Crackio media URLs, in order, for the ones that are on this computer. */
export const mediaFiles = (urls: string[]) => urls.map(urlToPath).filter((p): p is string => Boolean(p));

export async function saveOutputs(generationId: string, outputs: EngineOutput[]): Promise<MediaRef[]> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const saved = await Promise.all(
    outputs.map(async (out, i) => {
      const ext = EXT[out.mime] ?? "bin";
      const file = `${generationId}-${i}.${ext}`;
      await fs.writeFile(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, file), out.data);
      const kind = out.mime.startsWith("video/") ? "video" : "image";
      let { width, height } = out;
      if (kind === "image" && (!width || !height)) {
        const meta = await sharp(out.data).metadata();
        width = meta.width;
        height = meta.height;
      }
      // Clips from other models come in their own shapes; knowing it lets pages frame them exactly.
      if (kind === "video" && (!width || !height)) {
        const info = await probe(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, file)).catch(() => null);
        width = info?.width;
        height = info?.height;
      }
      // Its size, and a clip's length and frame rate, for the Library's cards and viewer.
      const stats = await mediaInfo(path.join(/*turbopackIgnore: true*/ MEDIA_DIR, file), { fresh: true });
      return { url: `/api/media/out/${file}`, kind, width, height, duration: stats?.duration, fps: stats?.fps, bytes: stats?.bytes } satisfies MediaRef;
    }),
  );
  // Its cards ask for light copies the moment it shows up; have them ready.
  warmPreviews(mediaFiles(saved.map((m) => m.url)));
  return saved;
}

/** Store an uploaded video, sound or text file as-is (Motion cuts, mixes and reads them). */
export async function saveFileUpload<K extends "video" | "audio" | "file">(data: Buffer, ext: string, kind: K) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const file = `${nanoid(12)}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin"}`;
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, file), data);
  return { url: `/api/media/uploads/${file}`, kind };
}

/** Store an uploaded image, normalized (EXIF-rotated, capped at 2560px). */
export async function saveUpload(data: Buffer) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const img = sharp(data, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const hasAlpha = Boolean(meta.hasAlpha);
  const resized = img.resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true });
  const out = hasAlpha ? await resized.png().toBuffer({ resolveWithObject: true }) : await resized.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  const file = `${nanoid(12)}.${hasAlpha ? "png" : "jpg"}`;
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, file), out.data);
  return { url: `/api/media/uploads/${file}`, width: out.info.width, height: out.info.height, hasAlpha };
}
