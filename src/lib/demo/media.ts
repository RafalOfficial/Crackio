import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { db, getGeneration } from "@/lib/server/db";
import { UPLOADS_DIR } from "@/lib/server/paths";
import { demoOn } from "./config";
import { sessionOf } from "./session";

/**
 * Files in the live demo. A take's files are named after its generation, so they're served only to the code that made
 * it. Uploads are remembered with their code and served only to it; files the server cuts for you (a clip's frame, an
 * outline) carry long random names and are served to signed-in visitors only. Everything else under /api/media (Motion's
 * projects, downloaded template clips) isn't part of the demo.
 */

const g = globalThis as unknown as { __crackioDemoUploads2?: boolean };
function uploads() {
  const d = db();
  if (!g.__crackioDemoUploads2) {
    d.exec("CREATE TABLE IF NOT EXISTS demo_uploads (name TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
    // Made before uploads kept their size.
    const columns = d.prepare("PRAGMA table_info(demo_uploads)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "bytes")) d.exec("ALTER TABLE demo_uploads ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
    g.__crackioDemoUploads2 = true;
  }
  return d;
}

/** Remembers whose uploads these are (their /api/media/uploads/ URLs) and how big they were. */
export function noteUploads(owner: string, files: { url: string; bytes: number }[]) {
  const add = uploads().prepare("INSERT OR IGNORE INTO demo_uploads (name, owner, bytes, created_at) VALUES (?, ?, ?, ?)");
  for (const { url, bytes } of files) {
    const name = url.match(/^\/api\/media\/uploads\/([A-Za-z0-9_-]+\.[a-z0-9]+)$/)?.[1];
    if (name) add.run(name, owner, bytes, Date.now());
  }
}

/**
 * A file the server made in uploads for a code, as that code's own: a copy under a random name, remembered as its. A
 * cut-out is named after the photo it was cut from, so the same photo's cut-out would be everyone's.
 */
export async function demoOwnCopy(owner: string, url: string): Promise<string> {
  const name = url.match(/^\/api\/media\/uploads\/([A-Za-z0-9_-]+\.[a-z0-9]+)$/)?.[1];
  if (!name || RANDOM.test(name)) return url;
  const copy = `${nanoid(12)}${path.extname(name)}`;
  await fs.copyFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name), path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, copy));
  const { size } = await fs.stat(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, copy));
  noteUploads(owner, [{ url: `/api/media/uploads/${copy}`, bytes: size }]);
  return `/api/media/uploads/${copy}`;
}

/** Each code can store this much: the box's disk is shared by everyone. */
const ALLOWANCE_MB = Number(process.env.CRACKIO_DEMO_STORAGE_MB) || 600;
const PER_REQUEST = 4;

/** Why a code can't upload these files now (too many at once, or its allowance is used up), or null. */
export function demoUploadAllowance(owner: string, files: File[]): string | null {
  if (files.length > PER_REQUEST) return `The live demo takes up to ${PER_REQUEST} files at a time.`;
  const used = (uploads().prepare("SELECT COALESCE(SUM(bytes), 0) AS used FROM demo_uploads WHERE owner = ?").get(owner) as { used: number }).used;
  const incoming = files.reduce((sum, f) => sum + f.size, 0);
  return used + incoming > ALLOWANCE_MB * 1024 * 1024 ? `Your code has used its ${ALLOWANCE_MB} MB of uploads on the live demo.` : null;
}

const TAKE = /^([A-Za-z0-9_-]{14})-[A-Za-z0-9_.-]+$/;
const RANDOM = /^[A-Za-z0-9_-]{12}\.[a-z0-9]{2,5}$/;

/** Whether the demo keeps this /api/media/<parts> file from the request. Always false outside the demo. */
export async function demoMediaDenied(request: Request, parts: string[]): Promise<boolean> {
  if (!demoOn()) return false;
  const viewer = await sessionOf(request);
  if (!viewer || parts.length !== 2) return true;
  const [root, name] = parts;
  if (root === "out") {
    const id = name.match(TAKE)?.[1];
    return !id || getGeneration(id)?.owner !== viewer;
  }
  if (root === "uploads") {
    if (!RANDOM.test(name)) return true;
    const row = uploads().prepare("SELECT owner FROM demo_uploads WHERE name = ?").get(name) as { owner: string } | undefined;
    return row ? row.owner !== viewer : false;
  }
  return true;
}

const VIDEO_MB = Number(process.env.CRACKIO_DEMO_UPLOAD_MB) || 100;

/** Why the demo won't take this upload (only pictures and short clips, checked by their first bytes), or null. */
export async function demoUploadProblem(file: File): Promise<string | null> {
  if (!demoOn()) return null;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
    const picture =
      (head[0] === 0xff && head[1] === 0xd8) || // JPEG
      ascii(1, 4) === "PNG" ||
      (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
      ascii(4, 12).startsWith("ftyp") || // HEIC / AVIF
      ascii(0, 3) === "GIF";
    return picture ? null : `${file.name} isn't a picture the demo can use.`;
  }
  if (/^video\/(mp4|quicktime|webm|x-m4v)$/.test(file.type)) {
    const clip = ascii(4, 8) === "ftyp" || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);
    if (!clip) return `${file.name} isn't a clip the demo can use.`;
    return file.size > VIDEO_MB * 1024 * 1024 ? `The live demo takes clips up to ${VIDEO_MB} MB.` : null;
  }
  return "The live demo takes pictures and short clips only.";
}
