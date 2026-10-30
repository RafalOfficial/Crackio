import { connection } from "next/server";
import { z } from "zod";
import { installComfy, SetupError, setupStatus, startComfy, stopComfy, uninstallComfy } from "@/lib/server/comfy-install";

/**
 * ComfyUI on this computer, set up by Crackio. GET: whether it's installed and running, where, with which PyTorch,
 * the install's stage, progress and log, and what Crackio would install for this hardware and why.
 * POST {action}: "install" (in the background; again resumes or repairs), "start", "stop", or "uninstall"
 * (deletes the install folder, models included, so it needs confirm: true).
 */
export async function GET() {
  await connection();
  return Response.json(await setupStatus(), { headers: { "Cache-Control": "no-store" } });
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("install"),
    /** Another folder than the one Crackio picks (an empty one). */
    path: z.string().min(3).max(400).optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    /** Start ComfyUI when it's installed (the default). */
    start: z.boolean().optional(),
  }),
  z.object({ action: z.literal("start"), keepAlive: z.boolean().optional(), share: z.boolean().optional() }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("uninstall"), confirm: z.boolean().optional() }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.action === "install") await installComfy({ path: body.path, port: body.port, start: body.start });
    else if (body.action === "start") await startComfy({ keepAlive: body.keepAlive, share: body.share });
    else if (body.action === "stop") await stopComfy({ byUser: true });
    else await uninstallComfy(body.confirm === true);
    return Response.json(await setupStatus(), { status: body.action === "stop" ? 200 : 202 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof SetupError ? err.status : 500 });
  }
}
