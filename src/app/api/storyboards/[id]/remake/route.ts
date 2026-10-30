import { remakeStoryboard } from "@/lib/server/storyboard";

/** Make a board from the old storyboard again with the director: same scene, look and shape. */
export async function POST(_req: Request, ctx: RouteContext<"/api/storyboards/[id]/remake">) {
  const { id } = await ctx.params;
  const item = await remakeStoryboard(id);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item }, { status: 201 });
}
