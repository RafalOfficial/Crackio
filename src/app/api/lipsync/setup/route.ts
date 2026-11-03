import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { LipsyncError } from "@/lib/server/lipsync/analyze";
import { setUpLipsync } from "@/lib/server/lipsync/setup";

const Body = z.object({ machine: z.string().max(200).optional() });

/** Sets Lip Sync up on a machine (engine, LatentSync's files, the check), in the background; progress shows in /api/lipsync/machines. */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "The live demo can't install anything." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "Which computer?" }, { status: 400 });
  try {
    return Response.json({ job: await setUpLipsync(body.data.machine) });
  } catch (err) {
    const status = err instanceof LipsyncError ? err.status : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
