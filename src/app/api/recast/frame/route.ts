import { z } from "zod";
import { frameAt } from "@/lib/motion/ffmpeg";
import { saveUpload, urlToPath } from "@/lib/server/media";

const Body = z.object({ source: z.string().min(1).max(500), t: z.number().min(0).max(36_000).default(0) });

/** One frame of a clip, saved as a picture: Recast shows it right away, then finds the things in it. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.source);
  if (!file) return Response.json({ error: "Upload the clip first." }, { status: 400 });
  try {
    return Response.json({ frame: await saveUpload(await frameAt(file, parsed.data.t, 1600)) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
