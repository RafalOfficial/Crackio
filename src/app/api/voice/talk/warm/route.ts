import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { talkWarm } from "@/lib/server/voice/talk";

const Body = z.object({
  voice: z.string().min(1).max(200),
  model: z.enum(["local:voice:drama3", "local:voice:voxcpm2", "local:voice:supertonic"]),
});

/** Talk was pressed: the models wake while the person starts talking ({ms, ok: [hearing, answering, speaking]}). */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "Talk isn't part of the live demo." }, { status: 403 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick a voice first." }, { status: 400 });
  try {
    return Response.json(await talkWarm(parsed.data, request.signal));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
