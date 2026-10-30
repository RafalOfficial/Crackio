import { z } from "zod";
import { planViews } from "@/lib/server/cast";

/**
 * Which views a new Cast member's sheet needs, before it's made: only the sides that look different (an umbrella: the
 * front; a car: front and side; a person: front, side and back), with a short reason to show. The page asks once a photo
 * is in or the description is written; you can still change them.
 */
const Body = z.object({
  kind: z.enum(["person", "pet", "character", "object"]),
  name: z.string().max(40).optional(),
  description: z.string().max(1200).optional(),
  notes: z.string().max(400).optional(),
  photo: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  return Response.json(await planViews(parsed.data));
}
