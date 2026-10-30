import { getGeneration } from "@/lib/server/db";
import { runner } from "@/lib/server/runner";
import { demoOwner, maysee } from "@/lib/demo/owner";

export async function POST(req: Request, ctx: RouteContext<"/api/generations/[id]/cancel">) {
  const { id } = await ctx.params;
  // In the live demo, only your own (lib/demo).
  if (!maysee(await demoOwner(req), getGeneration(id)?.owner)) return Response.json({ error: "Not found" }, { status: 404 });
  runner().cancel(id);
  return Response.json({ ok: true });
}
