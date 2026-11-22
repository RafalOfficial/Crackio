import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { SetupError } from "@/lib/server/comfy-install";
import { setUpTalk, TalkSetupError } from "@/lib/server/voice/talk-setup";

const Body = z.object({
  machine: z.string().max(200).optional(),
  /** Talk's voice model: LFM3-VL goes beside it unless a machine is named. */
  model: z.enum(["local:voice:drama3", "local:voice:voxcpm2", "local:voice:supertonic"]).optional(),
  /** Crackio's fine-tunes to get with it (published ones only). */
  loras: z.array(z.enum(["judge", "retouch", "chat", "enhance"])).max(4).optional(),
});

/**
 * Sets up LFM3-VL 2B, which writes Talk's answers, on a machine in one go: its files, transformers, a restart when that
 * needs one, then a hello it must answer (server/voice/talk-setup), and the fine-tunes asked for. Progress shows in
 * /api/voice/machines (brainSetup).
 */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "The live demo can't install anything." }, { status: 403 });
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "Which computer?" }, { status: 400 });
  try {
    return Response.json({ job: await setUpTalk(body.data) });
  } catch (err) {
    const status = err instanceof TalkSetupError || err instanceof SetupError ? err.status : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
