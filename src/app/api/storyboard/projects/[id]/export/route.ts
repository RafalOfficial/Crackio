import { z } from "zod";
import { LibraryError } from "@/lib/server/library";
import { startExport } from "@/lib/server/edit-projects";
import { demoOwner, signInFirst } from "@/lib/demo/owner";

const Body = z.object({ quality: z.enum(["720p", "1080p"]).default("1080p") });

/** The film made from the timeline: a take that shows up in the project's files (and its Library folder) when done. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboard/projects/[id]/export">) {
  const { id } = await ctx.params;
  // The live demo: a signed-in code, stamped on the film so its page can follow it.
  const owner = await demoOwner(request);
  if (owner === null) return signInFirst();
  const parsed = Body.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return Response.json({ error: "Invalid export" }, { status: 400 });
  try {
    return Response.json({ item: startExport(id, parsed.data.quality, owner) }, { status: 201 });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
