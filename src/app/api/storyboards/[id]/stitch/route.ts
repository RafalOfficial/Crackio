import { stitchStoryboard } from "@/lib/server/storyboard";

export async function POST(_req: Request, ctx: RouteContext<"/api/storyboards/[id]/stitch">) {
  const { id } = await ctx.params;
  try {
    const item = await stitchStoryboard(id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ item });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
