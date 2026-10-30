import { z } from "zod";
import { createStoryboard, listStoryboards } from "@/lib/server/storyboard";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { LOOKS, type LookId } from "@/lib/storyboard/types";

const aspectIds = ASPECTS.map((a) => a.id) as [AspectId, ...AspectId[]];
const lookIds = LOOKS.map((l) => l.id) as [LookId, ...LookId[]];

const CreateBody = z.object({
  scene: z.string().trim().min(8, "Describe the film first.").max(4000),
  aspect: z.enum(aspectIds).default("16:9"),
  look: z.enum(lookIds).default("cinematic"),
  /** How long the film should run, in seconds. */
  target: z.number().int().min(5).max(180).default(30),
  /** The frame and clip models (leave out for Auto), and the frames' resolution. */
  models: z.object({ image: z.string().max(300).optional(), video: z.string().max(300).optional(), resolution: z.string().max(16).optional() }).optional(),
  /** Skip the questions: the director works out the story and shoots it straight away. */
  auto: z.boolean().optional(),
});

export async function GET() {
  return Response.json({ items: await listStoryboards() });
}

export async function POST(request: Request) {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  return Response.json({ item: await createStoryboard(parsed.data) }, { status: 201 });
}
