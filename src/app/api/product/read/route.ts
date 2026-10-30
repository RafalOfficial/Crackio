import { urlToPath } from "@/lib/server/media";
import { readProduct } from "@/lib/server/product";

/**
 * `{ urls }`: photos of one product (front first, up to three). Answers what Crackio understood it
 * to be and how it's used; Product Studio shows it, so a wrong reading can be corrected before a shoot.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { urls?: unknown } | null;
  const urls = Array.isArray(body?.urls) ? body.urls.filter((u): u is string => typeof u === "string").slice(0, 3) : [];
  const files = urls.map(urlToPath).filter((p): p is string => Boolean(p));
  if (!files.length) return Response.json({ error: "Send the URL of a product photo Crackio stores." }, { status: 400 });
  // Not tied to this request: the reading is cached, so it's ready for the shoot even if the page moves on.
  const read = await readProduct(files).catch(() => null);
  if (!read) return Response.json({ error: "Couldn't read the product. Connect ChatGPT or Grok in Connections, or say what it is." }, { status: 503 });
  return Response.json({ read }, { headers: { "Cache-Control": "no-store" } });
}
