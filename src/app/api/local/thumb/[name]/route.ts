import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * A model's preview for the Local page: the opening frame of its ComfyUI template's preview (Comfy-Org/workflow_templates,
 * MIT), as a light WebP. The originals are animated and over a megabyte each for video models; fetched once, kept in
 * data/cache/local-thumbs.
 */

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "local-thumbs");
const SOURCE = "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates";
const making = new Map<string, Promise<Buffer | null>>();

async function make(name: string): Promise<Buffer | null> {
  const file = path.join(DIR, `${name}.webp`);
  const kept = await fs.readFile(file).catch(() => null);
  if (kept) return kept;
  const res = await fetch(`${SOURCE}/${encodeURIComponent(name)}-1.webp`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return null;
  const still = await sharp(Buffer.from(await res.arrayBuffer()), { pages: 1 })
    .resize({ width: 640, height: 400, fit: "cover", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer()
    .catch(() => null);
  if (!still) return null;
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(file, still);
  return still;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/local/thumb/[name]">) {
  const { name } = await ctx.params;
  if (!/^[\w.\-]+$/.test(name)) return new Response("Not found", { status: 404 });
  let job = making.get(name);
  if (!job) {
    job = make(name).finally(() => making.delete(name));
    making.set(name, job);
  }
  const still = await job;
  if (!still) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  return new Response(new Uint8Array(still), { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=604800" } });
}
