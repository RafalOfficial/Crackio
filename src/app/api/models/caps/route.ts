import { listModels } from "@/lib/models/resolve";
import { customRow, isCustomId } from "@/lib/models/custom";

/** What one model accepts (lengths, resolutions, shapes, frames), built-in or from a provider's catalog. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id || id.length > 300) return Response.json({ error: "Missing model id" }, { status: 400 });
  if (isCustomId(id)) {
    const row = await customRow(id).catch(() => null);
    if (!row) return Response.json({ error: "Unknown model" }, { status: 404 });
    return Response.json({ row }, { headers: { "Cache-Control": "no-store" } });
  }
  const m = (await listModels()).find((x) => x.id === id);
  if (!m) return Response.json({ error: "Unknown model" }, { status: 404 });
  return Response.json({ caps: m.caps ?? null }, { headers: { "Cache-Control": "no-store" } });
}
