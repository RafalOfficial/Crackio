import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { MIME, urlToPath } from "@/lib/server/media";
import { preview } from "@/lib/server/previews";
import { demoMediaDenied } from "@/lib/demo/media";

/**
 * Serves generated and uploaded media, streamed from disk by byte range: players ask for a clip in
 * pieces (Safari needs ranges to play at all), and only the asked-for bytes are read. `?w=` asks for
 * a light copy to show small (lib/media-url): a WebP still, or a muted preview of a clip, with
 * `&poster=1` for its opening frame.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/media/[...path]">) {
  const { path: parts } = await ctx.params;
  const original = urlToPath(`/api/media/${parts.map(encodeURIComponent).join("/")}`);
  // The live demo serves each code only its own files (lib/demo).
  if (!original || (await demoMediaDenied(req, parts))) return new Response("Not found", { status: 404 });

  const query = new URL(req.url).searchParams;
  const width = Number(query.get("w"));
  const poster = query.get("poster") === "1";
  let file = original;
  let mime: string | undefined;
  // When no copy can be made the original stands in, kept only briefly so the copy is tried again.
  let standIn = false;
  if (width > 0) {
    // A copy not made yet goes on being made, but this request waits for it only a moment: each request held here
    // holds one of the browser's six connections to Crackio, and a few new clips in Recent (a few seconds of ffmpeg
    // each, one at a time) kept everything else on the page waiting, the showcase's pictures and clips with it.
    const making = preview(original, width, poster ? "poster" : null).catch(() => null);
    const clip = /\.(mp4|webm|mov|m4v)$/i.test(original) && !poster;
    const copy = await Promise.race([making, new Promise<undefined>((done) => setTimeout(done, poster ? 800 : clip ? 60 : 400))]);
    if (copy) ({ file, mime } = copy);
    else if (poster) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    else standIn = true;
  }

  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return new Response("Not found", { status: 404 });
  const size = stat.size;
  const etag = `"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    "Content-Type": mime ?? MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    // File names are unique per write (Motion's project files carry a version in the URL).
    "Cache-Control": standIn ? "public, max-age=60" : "public, max-age=31536000, immutable",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
    // Files opened directly can never run scripts on Crackio's origin (SVG, text the agent wrote).
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    // Motion's compositions run without an origin (sandboxed preview, headless render) and three.js
    // loads their images as WebGL textures, which needs CORS. Only a Motion project's own files.
    ...(parts[0] === "out" && parts[1] === "motion" ? { "Access-Control-Allow-Origin": "*" } : {}),
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  if (!size) return new Response(null, { headers: { ...headers, "Content-Length": "0" } });

  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(stream(file, start, end), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(stream(file, 0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}

/** Bytes `start`…`end` (inclusive) as a stream; a player that stops listening stops the read. */
const stream = (file: string, start: number, end: number) => Readable.toWeb(createReadStream(file, { start, end, highWaterMark: 256 * 1024 })) as ReadableStream<Uint8Array>;
