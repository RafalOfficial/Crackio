import { z } from "zod";
import { searchCustom } from "@/lib/models/custom-search";

const Query = z.object({
  task: z.enum(["image", "edit", "retouch", "video", "video-edit", "video-swap", "animate", "upscale", "reframe"]),
  q: z.string().max(120).default(""),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(5).max(20).default(12),
  provider: z.enum(["comfy-cloud", "comfy-local"]).optional(),
});

/** The Custom tab: every model of a kind from every connected provider, searched and paged. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "Invalid search" }, { status: 400 });
  try {
    return Response.json(await searchCustom(parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
