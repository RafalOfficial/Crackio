import { z } from "zod";
import { LibraryError } from "@/lib/server/library";
import { createEditProject, listEditProjects } from "@/lib/server/edit-projects";
import { ASPECTS, type AspectId } from "@/lib/shot";

export async function GET() {
  return Response.json({ items: listEditProjects() });
}

const NewProject = z.object({
  name: z.string().max(400).optional(),
  aspect: z.enum(ASPECTS.map((a) => a.id) as [AspectId, ...AspectId[]]).optional(),
});

export async function POST(request: Request) {
  const parsed = NewProject.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return Response.json({ error: "Invalid project" }, { status: 400 });
  try {
    return Response.json({ project: createEditProject(parsed.data) }, { status: 201 });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
