import { redescribeCharacter } from "@/lib/server/cast";

export async function POST(_req: Request, ctx: RouteContext<"/api/cast/[id]/traits">) {
  const { id } = await ctx.params;
  try {
    const item = await redescribeCharacter(id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ item });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
