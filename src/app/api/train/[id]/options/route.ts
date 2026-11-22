/**
 * What a LoRA could be trained on and where: the trainable models, your machines with what each would make of this job
 * (fit, time, cost, downloads), Crackio's pick for each setting with its reason, and your own model files on the chosen
 * machine (server/train/options).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/train/[id]/options">) {
  const { id } = await ctx.params;
  const { getJob } = await import("@/lib/server/train/store");
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  try {
    const { trainOptions } = await import("@/lib/server/train/options");
    return Response.json(await trainOptions(job), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
