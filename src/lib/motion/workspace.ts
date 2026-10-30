import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR } from "@/lib/server/paths";
import { frameAt, probe } from "./ffmpeg";
import type { MotionFile } from "./store";

/**
 * A Motion project's folder: one flat directory of files under data/media/motion/<id>/, served
 * at /api/media/out/motion/<id>/<name>. The agent only ever sees plain file names.
 */
export class ToolError extends Error {}

export const workspaceDir = (projectId: string) => path.join(/*turbopackIgnore: true*/ MEDIA_DIR, "motion", projectId.replace(/[^\w-]/g, ""));
export const folderUrl = (projectId: string) => `/api/media/out/motion/${projectId}/`;

/** A readable, safe file name: lowercase letters, digits, dot, dash and underscore. */
export function cleanName(raw: string, ext?: string) {
  const base = path
    .basename(raw.replace(/\\/g, "/"))
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .toLowerCase();
  let name = base.slice(0, 80) || "file";
  if (ext) name = `${name.replace(/\.[a-z0-9]{1,5}$/i, "")}.${ext}`;
  return name;
}

/** `wanted`, or `wanted-2`, `wanted-3`… if the folder already has it. */
export async function uniqueName(dir: string, wanted: string) {
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? wanted : `${stem}-${i}${ext}`;
    try {
      await fs.access(path.join(dir, name));
    } catch {
      return name;
    }
  }
}

/** A project file by its plain name, or an error the agent can act on. */
export async function resolveFile(dir: string, name: unknown): Promise<string> {
  if (typeof name !== "string" || !name.trim()) throw new ToolError("Give a file name from the project folder.");
  const clean = name.trim();
  if (clean !== path.basename(clean) || clean.startsWith(".")) throw new ToolError(`"${clean}" must be a plain file name from the project folder, with no folders or paths.`);
  const p = path.join(dir, clean);
  try {
    await fs.access(p);
  } catch {
    throw new ToolError(`There's no "${clean}" in the project folder. Call list_files to see what's there.`);
  }
  return p;
}

/** Name → modification stamp, for spotting what a command wrote. */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const s = await fs.stat(path.join(dir, entry.name)).catch(() => null);
    if (s) out.set(entry.name, `${s.mtimeMs}:${s.size}`);
  }
  return out;
}

/** Measures a file in the folder and makes a poster for videos. */
export async function describeFile(projectId: string, name: string, source: MotionFile["source"], extra: Partial<MotionFile> = {}): Promise<MotionFile> {
  const dir = workspaceDir(projectId);
  const p = path.join(dir, name);
  const [info, stat] = await Promise.all([probe(p), fs.stat(p)]);
  // Files can be rewritten under the same name, and media is cached forever: version the URLs.
  const v = Math.round(stat.mtimeMs).toString(36);
  let poster: string | undefined;
  if (info.kind === "video") {
    try {
      const jpg = await frameAt(p, Math.min(1, (info.duration ?? 0) * 0.3), 480);
      await fs.mkdir(path.join(dir, ".posters"), { recursive: true });
      await fs.writeFile(path.join(dir, ".posters", `${name}.jpg`), jpg);
      poster = `${folderUrl(projectId)}.posters/${encodeURIComponent(name)}.jpg?v=${v}`;
    } catch {
      /* no poster; the player still works */
    }
  }
  return {
    name,
    kind: info.kind,
    url: `${folderUrl(projectId)}${encodeURIComponent(name)}?v=${v}`,
    poster,
    width: info.width,
    height: info.height,
    duration: info.duration,
    fps: info.fps,
    audio: info.audio,
    bytes: info.bytes,
    source,
    createdAt: Date.now(),
    ...extra,
  };
}

/** One line per file, the way the agent reads the folder. */
export function fileLine(f: Pick<MotionFile, "name" | "kind" | "width" | "height" | "duration" | "fps" | "audio" | "bytes" | "source" | "origin">) {
  const parts: string[] = [f.kind];
  if (f.width && f.height) parts.push(`${f.width}x${f.height}`);
  if (f.duration) parts.push(`${f.duration.toFixed(2)} s`);
  if (f.fps) parts.push(`${Math.round(f.fps * 100) / 100} fps`);
  if (f.kind === "video") parts.push(f.audio ? "with sound" : "no sound");
  parts.push(f.bytes > 1e6 ? `${(f.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.bytes / 1e3))} KB`);
  parts.push(f.source === "upload" ? "from the user" : f.source === "download" ? downloaded(f.origin) : `made by ${f.source}`);
  return `${f.name} — ${parts.join(", ")}`;
}

/** Where a download came from; a part says where it sits in the source, since its own clock starts at 0. */
function downloaded(o: MotionFile["origin"]) {
  if (!o) return "downloaded";
  const part = o.start !== undefined ? `, the part from ${o.start.toFixed(2)} to ${(o.end ?? 0).toFixed(2)} s of the source (subtract ${o.start.toFixed(2)} from transcript times)` : "";
  return `downloaded from ${o.title ? `"${o.title}" ` : ""}(${o.url})${part}`;
}
