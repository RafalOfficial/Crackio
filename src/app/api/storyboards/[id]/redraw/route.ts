import { z } from "zod";
import { redrawShot } from "@/lib/server/storyboard";

const Body = z.object({ shot: z.string().min(1).max(20), note: z.string().max(600).optional() });

/** Draw a shot's first frame again; the shots after it are redone from it. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/redraw">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which shot?" }, { status: 400 });
  const item = await redrawShot(id, parsed.data.shot, parsed.data.note);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}
