import { z } from "zod";
import { listModels } from "@/lib/models/resolve";
import { comfyQuote } from "@/lib/engines/comfy-quote";
import { ASPECTS } from "@/lib/shot";

const aspectIds = ASPECTS.map((a) => a.id) as [string, ...string[]];

const Body = z.object({
  id: z.string().max(300),
  settings: z.object({
    output: z.enum(["image", "video"]),
    seconds: z.union([z.number().min(0).max(600), z.literal("auto")]).optional(),
    resolution: z.string().max(20).nullable().optional(),
    aspectValue: z.string().max(40).nullable().optional(),
    aspect: z.enum(aspectIds).default("16:9"),
    count: z.number().int().min(1).max(4).default(1),
    sound: z.boolean().optional(),
    start: z.boolean().optional(),
    end: z.boolean().optional(),
    images: z.number().int().min(0).max(16).optional(),
  }),
});

/** Comfy's price for the request these settings make (nothing runs, nothing is charged). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { id, settings } = parsed.data;
  if (!id.startsWith("comfy:")) return Response.json({ cost: null });
  const builtin = (await listModels()).find((m) => m.id === id);
  const cost = await comfyQuote(id.slice("comfy:".length), builtin?.family ?? "comfy-custom", { ...settings, aspect: settings.aspect as (typeof ASPECTS)[number]["id"] });
  return Response.json({ cost }, { headers: { "Cache-Control": "no-store" } });
}
