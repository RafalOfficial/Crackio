import { z } from "zod";
import { designVoice, VoiceSetupError } from "@/lib/server/voice/setup";

const Body = z.object({ description: z.string().min(3).max(400), line: z.string().max(300).default("") });

/** Three takes on a voice described in words (VoxCPM2 on your GPU); keep one with POST /api/voice/voices. */
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Describe the voice first." }, { status: 400 });
  try {
    return Response.json({ options: await designVoice(body.data.description, body.data.line, request.signal) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: err instanceof VoiceSetupError ? err.status : 500 });
  }
}
