import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { installVoiceModel, removeVoiceModel, VoiceSetupError } from "@/lib/server/voice/setup";

const Body = z.object({ model: z.enum(["local:voice:drama3", "local:voice:voxcpm2", "local:voice:supertonic"]), machine: z.string().max(200).optional() });

const fail = (err: unknown) =>
  err instanceof VoiceSetupError ? Response.json({ error: err.message }, { status: err.status }) : Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });

/** Get a voice model onto a machine: audio.cpp first if it isn't there, then the model's file and speech to text. */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "The live demo can't install models." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Which model?" }, { status: 400 });
  try {
    return Response.json(await installVoiceModel(body.data.model, body.data.machine));
  } catch (err) {
    return fail(err);
  }
}

/** Take a voice model's file off a machine. */
export async function DELETE(request: Request) {
  if (DEMO) return Response.json({ error: "The live demo can't remove models." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success || !body.data.machine) return Response.json({ error: "Which model, and where?" }, { status: 400 });
  try {
    await removeVoiceModel(body.data.model, body.data.machine);
    return Response.json({ removed: true });
  } catch (err) {
    return fail(err);
  }
}
