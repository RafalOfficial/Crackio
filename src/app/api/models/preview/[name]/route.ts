import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { modelPreview, type PreviewKind } from "@/lib/server/model-previews";

/**
 * A model's preview for the model library (lib/server/model-previews), by its ComfyUI template's name:
 * `?v=still` (default), `?v=clip` for a video template's loop, `?v=before` for a compare template's starting picture.
 * Clips are served by byte range, as players ask for them.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/models/preview/[name]">) {
  const { name } = await ctx.params;
  if (!/^[\w.\-]{1,120}$/.test(name)) return new Response("Not found", { status: 404 });
  const v = new URL(req.url).searchParams.get("v");
  const kind: PreviewKind = v === "clip" || v === "before" ? v : "still";
  const file = await modelPreview(name, kind);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return new Response("Not found", { status: 404 });
  const size = stat.size;
  const headers: Record<string, string> = {
    "Content-Type": kind === "clip" ? "video/mp4" : "image/webp",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    "X-Content-Type-Options": "nosniff",
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]));
    const end = Math.min(size - 1, range[1] && range[2] ? Number(range[2]) : size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    return new Response(stream(file, start, end), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(stream(file, 0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}

const stream = (file: string, start: number, end: number) => Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
