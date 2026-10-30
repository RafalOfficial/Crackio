import { getGeneration } from "@/lib/server/db";
import { deleteProject, getProject } from "@/lib/motion/store";
import { runner } from "@/lib/server/runner";

/** A project with the live state of every agent turn (status, progress, the rendered video). */
export async function GET(_req: Request, ctx: RouteContext<"/api/motion/projects/[id]">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  const jobs = Object.fromEntries(
    project.messages.flatMap((m) => {
      const g = m.generationId ? getGeneration(m.generationId) : null;
      return g ? [[g.id, { status: g.status, progress: g.progress, stage: g.stage, error: g.error, output: g.outputs[0]?.url, modelName: g.modelName }]] : [];
    }),
  );
  return Response.json({ project, jobs }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/motion/projects/[id]">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  for (const m of project?.messages ?? []) if (m.generationId) runner().cancel(m.generationId);
  await deleteProject(id);
  return Response.json({ ok: true });
}
