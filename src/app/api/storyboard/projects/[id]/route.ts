import { LibraryError } from "@/lib/server/library";
import { deleteEditProject, EditPatch, getEditProject, patchEditProject } from "@/lib/server/edit-projects";

export async function GET(_req: Request, ctx: RouteContext<"/api/storyboard/projects/[id]">) {
  const { id } = await ctx.params;
  const project = getEditProject(id);
  if (!project) return Response.json({ error: "That project doesn't exist anymore." }, { status: 404 });
  return Response.json({ project });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/storyboard/projects/[id]">) {
  const { id } = await ctx.params;
  const parsed = EditPatch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid change", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  try {
    const project = patchEditProject(id, parsed.data);
    return Response.json({ updatedAt: project.updatedAt, name: project.name });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** The project and its folder go; what was in the folder goes back to General in the Library. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/storyboard/projects/[id]">) {
  const { id } = await ctx.params;
  deleteEditProject(id);
  return Response.json({ ok: true });
}
