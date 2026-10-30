import { z } from "zod";
import { addMachine, installModel, LocalError, localStatus, removeMachine, removeModel, stopDownload } from "@/lib/server/local-models";
import { updateSettings } from "@/lib/server/settings";
import { watchRentedBoxes } from "@/lib/server/cloud-accounts";
import { demoOn } from "@/lib/demo/config";
import { scrubForDemo } from "@/lib/demo/scrub";

/**
 * The Local page: every ComfyUI Crackio runs models on, the catalog files each has, and installs in progress. GPUs rented
 * on your cloud accounts join (or leave) in the background meanwhile.
 */
export async function GET() {
  // The live demo neither looks for rented boxes nor says where its machines answer (lib/demo).
  if (demoOn()) return Response.json(scrubForDemo(await localStatus()), { headers: { "Cache-Control": "no-store" } });
  watchRentedBoxes();
  return Response.json(await localStatus(), { headers: { "Cache-Control": "no-store" } });
}

const target = z.string().max(80).optional();
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("install"), model: z.string().max(60), variant: z.string().max(40), target }),
  z.object({ action: z.literal("remove"), model: z.string().max(60), variant: z.string().max(40), target }),
  z.object({ action: z.literal("stop"), id: z.string().max(40), target }),
  z.object({ action: z.literal("add-machine"), url: z.string().min(3).max(200), token: z.string().max(200).optional(), label: z.string().max(60).optional() }),
  z.object({ action: z.literal("remove-machine"), target: z.string().max(80) }),
  z.object({ action: z.literal("pooling"), mode: z.enum(["auto", "always", "off"]) }),
  z.object({ action: z.literal("run-on"), target: z.string().min(1).max(80) }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.action === "install") return Response.json(await installModel(body.model, body.variant, body.target));
    if (body.action === "remove") return Response.json(await removeModel(body.model, body.variant, body.target));
    if (body.action === "add-machine") return Response.json(await addMachine(body.url, body.token, body.label));
    if (body.action === "remove-machine") return Response.json(await removeMachine(body.target));
    if (body.action === "run-on") {
      const runOn = body.target;
      await updateSettings((s) => ({ ...s, runOn: runOn === "auto" ? undefined : runOn }));
      return Response.json({ runOn });
    }
    if (body.action === "pooling") {
      const mode = body.mode;
      await updateSettings((s) => ({ ...s, pooling: mode }));
      return Response.json({ pooling: mode });
    }
    await stopDownload(body.id, body.target);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LocalError ? err.status : 500 });
  }
}
