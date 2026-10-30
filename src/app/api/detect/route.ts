import { z } from "zod";
import { urlToPath } from "@/lib/server/media";
import { detectParts, detectThings } from "@/lib/server/detect";

const BoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Body = z.object({
  image: z.string().min(1).max(500),
  /** Ask for the parts of this thing instead of the things in the picture. */
  parent: z.object({ id: z.string().max(40), label: z.string().max(60), detail: z.string().max(160), box: BoxSchema }).optional(),
});

/**
 * The things in a picture Crackio stores (an upload, a result, a frame), each with a box; or,
 * with `parent`, that thing's main parts. Looking closely takes a while; answers are cached.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.image);
  if (!file) return Response.json({ error: "Upload the picture first." }, { status: 400 });
  try {
    if (parsed.data.parent) {
      const out = await detectParts(file, parsed.data.parent, request.signal);
      if (!out) return Response.json({ error: "Couldn't find its parts (no text model answered)." }, { status: 502 });
      return Response.json(out);
    }
    const out = await detectThings(file, request.signal);
    if (!out) return Response.json({ things: [], error: "No text model answered, so nothing was found. Click anywhere to add a change." });
    return Response.json(out);
  } catch (err) {
    return Response.json({ error: (err as Error).message || "Couldn't look at the picture." }, { status: 500 });
  }
}
