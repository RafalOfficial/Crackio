import { z } from "zod";
import { removeVoice, updateVoice } from "@/lib/server/voice/store";

const Patch = z.object({ name: z.string().max(40).optional(), desc: z.string().max(90).optional(), text: z.string().max(2000).optional() });

export async function PATCH(request: Request, ctx: RouteContext<"/api/voice/voices/[id]">) {
  const { id } = await ctx.params;
  const body = Patch.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Nothing to change." }, { status: 400 });
  const voice = await updateVoice(id, body.data);
  return voice ? Response.json({ voice }) : Response.json({ error: "No such voice." }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/voice/voices/[id]">) {
  const { id } = await ctx.params;
  return (await removeVoice(id)) ? Response.json({ removed: true }) : Response.json({ error: "No such voice." }, { status: 404 });
}
