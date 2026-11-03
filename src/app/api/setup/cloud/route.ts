import { z } from "zod";
import { autoStopNow, creditNow, setAutoStop, setBoxState } from "@/lib/server/setup/cloud-money";
import { forgetSetupSnapshot } from "@/lib/server/setup/status";

/** Your cloud credit and the boxes that stop (or delete) themselves when idle. */
export async function GET() {
  return Response.json({ credit: creditNow(), autoStop: await autoStopNow() }, { headers: { "Cache-Control": "no-store" } });
}

const Box = z.string().regex(/^(vast|runpod):[\w-]{1,64}$/);
const Body = z.discriminatedUnion("action", [
  /**
   * Stop it after this many idle minutes, or never (null); idle = GPU load under `load` %; `then` "delete" deletes it
   * instead (each kept as it was when missing).
   */
  z.object({
    action: z.literal("auto-stop"),
    box: Box,
    minutes: z.number().int().min(5).max(24 * 60).nullable(),
    load: z.number().int().min(1).max(90).optional(),
    then: z.enum(["stop", "delete"]).optional(),
  }),
  z.object({ action: z.literal("stop"), box: Box }),
  z.object({ action: z.literal("start"), box: Box }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.action === "auto-stop") await setAutoStop(b.box, b.minutes, b.load, b.then);
    else await setBoxState(b.box, b.action === "stop" ? "stopped" : "running");
    forgetSetupSnapshot();
    return Response.json({ ok: true, autoStop: await autoStopNow() });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
