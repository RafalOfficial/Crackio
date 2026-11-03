import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { SetupError, updateLocalBridge } from "@/lib/server/comfy-install";
import { setUpVoice, VoiceSetupError } from "@/lib/server/voice/setup";
import { forgetVoiceMachines } from "@/lib/server/voice/machines";

const Body = z.object({
  machine: z.string().max(200).optional(),
  model: z.enum(["local:voice:drama3", "local:voice:voxcpm2", "local:voice:supertonic"]).optional(),
  /** Bring this computer's Crackio bridge up to date first (ComfyUI restarts). */
  update: z.literal(true).optional(),
});

/**
 * Sets Voice up on a machine in one go: audio.cpp (the build that runs there, checked), the model and speech to text,
 * then a test line spoken and heard back (server/voice/setup). Without a model it finishes what the models already
 * there need. {update: true} brings this computer's bridge up to date instead. Progress shows in /api/voice/machines.
 */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "The live demo can't install anything." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Which computer, or which model?" }, { status: 400 });
  try {
    if (body.data.update) {
      if (body.data.machine && body.data.machine !== "this-computer") return Response.json({ error: "Only this computer's bridge updates from here." }, { status: 400 });
      await updateLocalBridge();
      forgetVoiceMachines();
      return Response.json({ updating: true });
    }
    if (!body.data.model && !body.data.machine) return Response.json({ error: "Which computer, or which model?" }, { status: 400 });
    return Response.json({ job: await setUpVoice(body.data.model ?? null, body.data.machine) });
  } catch (err) {
    const status = err instanceof VoiceSetupError || err instanceof SetupError ? err.status : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
