import { z } from "zod";
import { askText } from "@/lib/engines/refine";
import { urlToPath } from "@/lib/server/media";

const Body = z.object({ image: z.string().min(1).max(500), note: z.string().max(600).optional() });

const INSTRUCTIONS = `You describe a reference image so a video editor can reproduce the thing in it exactly, without seeing it.
In two or three sentences, describe the main object (or the one the note is about): its type, shape and proportions, colors, materials and finish, patterns, graphics and any lettering (describe how it looks; quote short text exactly), and anything distinctive.
Describe only the thing itself, not the background or the photo. No preamble.`;

/**
 * Grok's video edit takes words only, so an image attached to a Recast note is turned into a
 * precise description of what's in it.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.image);
  if (!file) return Response.json({ error: "Upload the image first." }, { status: 400 });
  const description = await askText({
    instructions: INSTRUCTIONS,
    text: parsed.data.note ? `The note says: ${parsed.data.note}` : "Describe the main object.",
    references: [{ path: file, label: "the reference image" }],
    effort: "low",
  }).catch(() => null);
  if (!description) return Response.json({ error: "No text model answered. Describe it in the note instead." }, { status: 502 });
  return Response.json({ description: description.replace(/\s+/g, " ").trim() });
}
