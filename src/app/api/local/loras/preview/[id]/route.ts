/** A LoRA pick's example picture, small (server/loras `loraPreview`), by the pick's id. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[\w.\-:]{1,120}$/.test(id)) return new Response("Not found", { status: 404 });
  const { loraPreview } = await import("@/lib/server/loras");
  const data = await loraPreview(id).catch(() => null);
  if (!data) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" } });
}
