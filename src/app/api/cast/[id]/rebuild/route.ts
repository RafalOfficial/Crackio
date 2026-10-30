import { z } from "zod";
import { rebuildCharacter, relayoutCharacter } from "@/lib/server/cast";

/** Optionally, the views to draw this time (the sides that look different); or only lay the sheet out again from its views. */
const Body = z.object({ views: z.array(z.enum(["front", "three-quarter", "side", "back"])).max(4).optional(), layoutOnly: z.boolean().optional() }).catch({});

export async function POST(request: Request, ctx: RouteContext<"/api/cast/[id]/rebuild">) {
  const { id } = await ctx.params;
  const { views, layoutOnly } = Body.parse(await request.json().catch(() => ({})));
  const item = layoutOnly ? await relayoutCharacter(id) : await rebuildCharacter(id, views);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}
