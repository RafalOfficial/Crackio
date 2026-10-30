import { z } from "zod";
import { retakeShot } from "@/lib/server/storyboard";

const Body = z.object({ shot: z.string().min(1).max(20), note: z.string().max(600).optional() });

/** Animate a shot again from the same first frame; the shots after it are redone from its new cut. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/retake">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which shot?" }, { status: 400 });
  const item = await retakeShot(id, parsed.data.shot, parsed.data.note);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}
