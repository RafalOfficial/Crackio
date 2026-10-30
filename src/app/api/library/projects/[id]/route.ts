import { deleteProject, LibraryError, ProjectBody, updateProject } from "@/lib/server/library";

export async function PATCH(request: Request, ctx: RouteContext<"/api/library/projects/[id]">) {
  const { id } = await ctx.params;
  const parsed = ProjectBody.partial().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid project" }, { status: 400 });
  try {
    return Response.json({ project: updateProject(id, parsed.data) });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** The folder goes; its takes go back to General. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/library/projects/[id]">) {
  const { id } = await ctx.params;
  deleteProject(id);
  return Response.json({ ok: true });
}
