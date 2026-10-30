import { z } from "zod";
import { postMessage } from "@/lib/server/storyboard";

const Body = z.object({ text: z.string().trim().min(1, "Say what to change.").max(4000) });

/** A message to the director; the reply and the changes follow in the background. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/messages">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid message" }, { status: 400 });
  const item = await postMessage(id, parsed.data.text);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item }, { status: 201 });
}
