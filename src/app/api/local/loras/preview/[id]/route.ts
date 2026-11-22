import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * A LoRA's example for the LoRA library (server/loras `loraPreview`), by the LoRA's id ("hf:owner~name" for one found
 * on Hugging Face: lib/local/loras `previewId`): its small still, or with `?v=clip` the short muted loop of an example
 * that moves, served by byte range as players ask for it. Only examples the library shows are answered.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  if (!/^[\w.\-:~]{1,200}$/.test(raw)) return new Response("Not found", { status: 404 });
  const id = raw.replace(/~/g, "/");
  const want = new URL(req.url).searchParams.get("v");
  const clip = want === "clip";
  const { loraPreview } = await import("@/lib/server/loras");
  // `?v=blur`: a smear of its colours, for a card that keeps its example back until asked.
  const file = await loraPreview(id, clip ? "clip" : want === "blur" ? "blur" : "still").catch(() => null);
  const stat = file ? await fs.stat(/*turbopackIgnore: true*/ file).catch(() => null) : null;
  if (!file || !stat?.isFile()) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
  const size = stat.size;
  const headers: Record<string, string> = {
    "Content-Type": clip ? "video/mp4" : "image/webp",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    "X-Content-Type-Options": "nosniff",
  };
  const stream = (start: number, end: number) => Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file, { start, end })) as ReadableStream<Uint8Array>;
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]));
    const end = Math.min(size - 1, range[1] && range[2] ? Number(range[2]) : size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    return new Response(stream(start, end), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(stream(0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
}
