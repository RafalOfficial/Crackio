import { z } from "zod";
import { previewVoice, VoiceSetupError } from "@/lib/server/voice/setup";

const Body = z.object({
  /** A scratch clip from /api/voice/sample. */
  file: z.string().regex(/^[\w-]{6,40}\.wav$/),
  /** What the clip says. */
  text: z.string().min(1).max(2000),
  model: z.enum(["local:voice:drama3", "local:voice:voxcpm2"]),
  line: z.string().max(300).default(""),
});

/** A clone heard before it's kept: the chosen model says a line in the clip's voice. */
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Add a clip and what it says first." }, { status: 400 });
  const b = body.data;
  try {
    return Response.json(await previewVoice(b.file, b.text, b.model, b.line, request.signal));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: err instanceof VoiceSetupError ? err.status : 500 });
  }
}
