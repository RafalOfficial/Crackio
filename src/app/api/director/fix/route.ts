import { z } from "zod";
import { fixSpot } from "@/lib/server/fix-spot";

const Vec = z.tuple([z.number(), z.number(), z.number()]);
const Body = z.object({
  world: z.string().min(1).max(500),
  words: z.string().min(1).max(500),
  model: z.string().min(1).max(120),
  machine: z.string().max(120).optional(),
  look: z.object({ forward: Vec, right: Vec, up: Vec, vfov: z.number(), aspect: z.number() }),
  // The photo the stage shows where it looks (the place's, or one a fix changed before), and how it was taken.
  photo: z.object({ url: z.string().min(1).max(500), view: z.object({ fov: z.number(), pitch: z.number(), roll: z.number() }) }).optional(),
});

/** Fix this spot: the part of the place the Camera looks at, changed as you say and put back where it was (server/fix-spot). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what to change here." }, { status: 400 });
  const { world, words, model, machine, look, photo } = parsed.data;
  try {
    return Response.json(await fixSpot(world, look, words.trim(), model, request.signal, machine, photo));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
