import { z } from "zod";

/**
 * A LoRA's training: start it (or carry a paused or failed one on), pause it, finish it early with what's trained, or
 * make an earlier saved version the LoRA.
 */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("finish") }),
  z.object({ action: z.literal("use-version"), step: z.number().int().min(1) }),
  /** Its saved versions copied to this computer from the machine it trained on. */
  z.object({ action: z.literal("keep-versions") }),
  /** A run that stopped before its first step, back on the workbench. */
  z.object({ action: z.literal("edit-setup") }),
  /** The finished LoRA sent to another of your machines. */
  z.object({ action: z.literal("send"), machine: z.string().min(1).max(120) }),
  /** A paused run carried on on another machine. */
  z.object({ action: z.literal("move"), machine: z.string().min(1).max(120) }),
]);

export async function POST(request: Request, ctx: RouteContext<"/api/train/[id]/run">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const run = await import("@/lib/server/train/run");
  try {
    const body = parsed.data;
    const job =
      body.action === "start" ? await run.startTraining(id) : body.action === "pause" ? await run.pauseTraining(id) : body.action === "finish" ? await run.finishTraining(id) : body.action === "send" ? await run.sendTo(id, body.machine) : body.action === "move" ? await run.moveTraining(id, body.machine) : body.action === "keep-versions" ? await run.keepVersions(id) : body.action === "edit-setup" ? await run.editSetup(id) : await run.useVersion(id, body.step);
    return Response.json({ job });
  } catch (err) {
    const status = err instanceof run.TrainRefused ? err.status : 500;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
