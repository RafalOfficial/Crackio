import { z } from "zod";
import { photoMesh } from "@/lib/server/photo-mesh";

const Body = z.object({ url: z.string().min(1).max(500), hfov: z.number().min(1).max(179) });

/** The place photo's 3D shape as the challenge winner's 3D World measures it, as a GLB (server/photo-mesh). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request." }, { status: 400 });
  try {
    return Response.json(await photoMesh(parsed.data.url, parsed.data.hfov, request.signal));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
