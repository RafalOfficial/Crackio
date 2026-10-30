import { z } from "zod";
import { pickTake } from "@/lib/server/storyboard";

const Body = z.object({ shot: z.string().min(1).max(20), take: z.number().int().min(0).max(20) });

/** Use an earlier take of a shot; the shots after it are redone from its cut. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/take">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which take?" }, { status: 400 });
  const item = await pickTake(id, parsed.data.shot, parsed.data.take);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}
