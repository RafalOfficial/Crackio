import { z } from "zod";
import { deleteCharacter, getCharacter, updateCharacter } from "@/lib/server/cast";

const PatchBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  handle: z.string().max(40).optional(),
  notes: z.string().max(400).optional(),
  traits: z.string().max(600).optional(),
  noun: z.string().max(90).optional(),
  kind: z.enum(["person", "pet", "character", "object"]).optional(),
  /** Real height in meters; null forgets a typed one, so the next reading sets it. */
  height: z.number().positive().max(200).nullable().optional(),
  /** The image model for rebuilds ("auto" or null: the best one connected). */
  model: z.string().max(300).nullable().optional(),
});

export async function GET(_req: Request, ctx: RouteContext<"/api/cast/[id]">) {
  const { id } = await ctx.params;
  const item = await getCharacter(id);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/cast/[id]">) {
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const item = await updateCharacter(id, parsed.data);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/cast/[id]">) {
  const { id } = await ctx.params;
  deleteCharacter(id);
  return Response.json({ ok: true });
}
