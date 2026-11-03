import { updateLocalBridge } from "@/lib/server/comfy-install";
import { forgetSetupSnapshot } from "@/lib/server/setup/status";
import { forgetVoiceMachines } from "@/lib/server/voice/machines";

/**
 * Brings this computer's ComfyUI up to the Crackio helper (bridge) this Crackio carries, then restarts it once its queue
 * is empty. Rented GPUs get theirs when they connect again; machines on your network by hand.
 */
export async function POST() {
  try {
    await updateLocalBridge();
    forgetVoiceMachines();
    forgetSetupSnapshot();
    return Response.json({ ok: true });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
