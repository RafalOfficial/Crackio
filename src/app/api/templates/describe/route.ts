import { z } from "zod";
import { urlToPath } from "@/lib/server/media";
import { describePhoto } from "@/lib/server/template-describe";

const Body = z.object({ image: z.string().min(1).max(500), kind: z.enum(["person", "face", "pet", "object", "place"]) });

/** What a vision model sees in a photo you put into a template (shown, and editable, before you make it). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.image);
  if (!file) return Response.json({ error: "Upload the photo first." }, { status: 400 });
  const description = await describePhoto(file, parsed.data.kind).catch(() => null);
  if (!description) return Response.json({ error: "No text model could read the photo. Describe them yourself below." }, { status: 502 });
  return Response.json({ description });
}
