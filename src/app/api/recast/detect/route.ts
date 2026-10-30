import { z } from "zod";
import { frameAt } from "@/lib/motion/ffmpeg";
import { saveUpload, urlToPath } from "@/lib/server/media";
import { detectThings } from "@/lib/server/detect";

const Body = z.object({ source: z.string().min(1).max(500), t: z.number().min(0).max(36_000).default(0) });

/**
 * A frame of the clip and the things in it, in one call (Recast itself now asks for the frame
 * first, at /api/recast/frame, and the things after, at /api/detect, so the frame shows at once).
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.source);
  if (!file) return Response.json({ error: "Upload the clip first." }, { status: 400 });

  let frame: { url: string; width: number; height: number };
  try {
    frame = await saveUpload(await frameAt(file, parsed.data.t, 1600));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
  const found = await detectThings(urlToPath(frame.url)!, request.signal).catch(() => null);
  if (!found) return Response.json({ frame, objects: [], error: "No text model answered, so nothing was found. Click anywhere to add a note." });
  return Response.json({ frame, objects: found.things });
}
