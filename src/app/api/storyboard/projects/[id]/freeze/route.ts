import { z } from "zod";
import { frameAt } from "@/lib/motion/ffmpeg";
import { saveUpload, urlToPath } from "@/lib/server/media";
import { addUploads } from "@/lib/server/edit-projects";
import { LibraryError } from "@/lib/server/library";

const Body = z.object({ url: z.string().min(1).max(600), t: z.number().min(0).max(36_000), name: z.string().max(120).optional() });

/**
 * Freeze: one frame of a clip on the Storyboard timeline (`t` seconds into its file, frame-exact), at the clip's own
 * size, kept as a picture in the project's Files (where it can go on the timeline, become a clip, or a Director set).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboard/projects/[id]/freeze">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Which clip, and when?" }, { status: 400 });
  const file = urlToPath(parsed.data.url);
  if (!file || !/\.(mp4|m4v|mov|webm|mkv)$/i.test(file)) return Response.json({ error: "Only a clip can be frozen." }, { status: 400 });
  try {
    const frame = await frameAt(file, parsed.data.t, 0, 2);
    const saved = await saveUpload(frame);
    const [item] = await addUploads(id, [{ url: saved.url, name: parsed.data.name ?? "Frame" }]);
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    return Response.json({ error: `Couldn't freeze that frame: ${(err as Error).message}` }, { status: 500 });
  }
}
