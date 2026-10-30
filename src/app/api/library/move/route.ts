import { z } from "zod";
import { fileTakes, LibraryError } from "@/lib/server/library";

const Body = z.object({
  takes: z
    .array(z.object({ id: z.string().min(1).max(40), index: z.number().int().min(0).max(64) }))
    .min(1)
    .max(5000),
  /** A project's id, or null for General. */
  project: z.string().min(1).max(40).nullable(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid move" }, { status: 400 });
  try {
    fileTakes(parsed.data.takes, parsed.data.project);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
