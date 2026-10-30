import { z } from "zod";
import { deleteStoryboard, getStoryboard, updateStoryboard } from "@/lib/server/storyboard";

const PatchBody = z.object({
  title: z.string().max(80).optional(),
  /** The frame and clip models ("auto" or null for Auto), and the frames' resolution (null for the model's default). */
  models: z.object({ image: z.string().max(300).nullable().optional(), video: z.string().max(300).nullable().optional(), resolution: z.string().max(16).nullable().optional() }).optional(),
  /** One shot's plan: it's redone, and every shot after it. */
  shot: z
    .object({
      id: z.string().max(20),
      title: z.string().max(60).optional(),
      framing: z.string().max(40).optional(),
      camera: z.string().max(300).optional(),
      layout: z.string().max(700).optional(),
      action: z.string().max(800).optional(),
      acting: z.string().max(600).optional(),
      background: z.string().max(400).optional(),
      end: z.string().max(500).optional(),
      state: z.string().max(500).optional(),
      transition: z.enum(["cut", "continuous"]).optional(),
      duration: z.number().min(1).max(15).optional(),
    })
    .optional(),
  /** The words that close every frame and clip prompt. */
  style: z.string().max(1200).optional(),
  motion: z.string().max(1200).optional(),
  /** Stop or go on making shots. */
  paused: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: RouteContext<"/api/storyboards/[id]">) {
  const { id } = await ctx.params;
  const item = await getStoryboard(id);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/storyboards/[id]">) {
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const item = await updateStoryboard(id, parsed.data);
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ item });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/storyboards/[id]">) {
  const { id } = await ctx.params;
  deleteStoryboard(id);
  return Response.json({ ok: true });
}
