import { askText } from "@/lib/engines/refine";
import { GLOBE } from "@/lib/server/world";
import { urlToPath } from "@/lib/server/media";

/** Research tool: the world builder's look for a place drawn inside a ball (server/world), answered as is. `{ image }`. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { image?: string } | null;
  const image = body?.image ? urlToPath(body.image) : null;
  if (!image) return Response.json({ error: "Send the panorama." }, { status: 400 });
  const began = Date.now();
  const answer = await askText({ instructions: GLOBE.instructions, text: GLOBE.question, references: [{ path: image, label: "the panorama" }], imageEdge: 1280, detail: "low", effort: "low", timeoutMs: 45_000 }).catch(() => null);
  return Response.json({ answer, seconds: (Date.now() - began) / 1000 });
}
