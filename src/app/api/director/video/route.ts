import { z } from "zod";
import { prepareVideoPlace } from "@/lib/server/director-video";

const Body = z.object({ url: z.string().min(1).max(500) });

/**
 * Director video mode: a video you dropped, read for the stage (server/director-video `prepareVideoPlace`): what it is
 * (size, length, frame rate, sound) and its first frame as a picture, which the 3D set is built from.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send the video." }, { status: 400 });
  try {
    return Response.json(await prepareVideoPlace(parsed.data.url, request.signal));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
