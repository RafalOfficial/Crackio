import { z } from "zod";
import { growPhoto } from "@/lib/server/grow-photo";

const Body = z.object({
  url: z.string().min(1).max(500),
  // The place's own words: the LoRA reads them after its instruction.
  words: z.string().max(500).optional(),
  machine: z.string().max(120).optional(),
  // Megapixels of the gray canvas the model draws (for tests: it was trained on 0.94 to 1.96).
  mp: z.number().min(0.5).max(2.4).optional(),
});

/** Small extend: the place's photo grown 1.5 times each way around itself (server/grow-photo). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send the photo to extend." }, { status: 400 });
  const { url, ...opts } = parsed.data;
  try {
    return Response.json(await growPhoto(url, request.signal, opts));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
