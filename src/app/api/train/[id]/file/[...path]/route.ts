import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * A LoRA's own files: its pictures (`images/<id>`, `?w=` for a small copy; `before/<id>`: a pair's before picture), its
 * test pictures (`previews/<name>`) and the
 * copy of the finished LoRA Crackio keeps (`lora/<file>`, as a download).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/train/[id]/file/[...path]">) {
  const { id, path: parts } = await ctx.params;
  const { getJob, jobPath } = await import("@/lib/server/train/store");
  const job = await getJob(id);
  if (!job || parts.length !== 2) return new Response("Not found", { status: 404 });
  const [kind, name] = parts;
  let file: string;
  let mime: string;
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (kind === "images" || kind === "before") {
    const { imageFile } = await import("@/lib/server/train/dataset");
    const width = Number(new URL(request.url).searchParams.get("w")) || undefined;
    const found = await imageFile(job, name, width, kind === "before");
    if (!found) return new Response("Not found", { status: 404 });
    ({ file, mime } = found);
    headers["Cache-Control"] = "private, max-age=31536000, immutable";
  } else if (kind === "previews" && /^[\w-]{1,60}\.webp$/.test(name)) {
    file = jobPath(id, "previews", name);
    mime = "image/webp";
    headers["Cache-Control"] = "private, max-age=31536000, immutable";
  } else if (kind === "lora" && job.result?.file === name) {
    file = jobPath(id, "lora", name);
    mime = "application/octet-stream";
    headers["Content-Disposition"] = `attachment; filename="${name.replace(/[^\w.\-+ ()[\]]+/g, "_")}"`;
    headers["Cache-Control"] = "no-store";
  } else return new Response("Not found", { status: 404 });
  const stat = await fs.stat(/*turbopackIgnore: true*/ file).catch(() => null);
  if (!stat?.isFile()) return new Response("Not found", { status: 404 });
  return new Response(Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file)) as ReadableStream, { headers: { ...headers, "Content-Type": mime, "Content-Length": String(stat.size) } });
}
