import { z } from "zod";
import { answerAsk } from "@/lib/server/storyboard";

/** "director" as the option: just make it (the director picks whatever is still open). */
const Body = z.object({ ask: z.string().min(1).max(20), option: z.string().min(1).max(20) });

/** Your answer to one of the director's questions. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/answer">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which answer?" }, { status: 400 });
  const item = await answerAsk(id, parsed.data.ask, parsed.data.option);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}
