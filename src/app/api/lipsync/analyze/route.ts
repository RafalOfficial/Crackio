import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { analyzeClip, LipsyncError } from "@/lib/server/lipsync/analyze";

const Body = z.object({ url: z.string().min(1).max(500), fresh: z.boolean().optional() });

/** What a clip says, sentence by sentence with times (heard on a GPU that has speech to text; kept once heard). */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "Lip Sync isn't part of the live demo." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Which clip?" }, { status: 400 });
  try {
    return Response.json({ analysis: await analyzeClip(body.data.url, request.signal, body.data.fresh) });
  } catch (err) {
    const status = err instanceof LipsyncError ? err.status : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
