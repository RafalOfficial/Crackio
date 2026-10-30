import { createProject, listProjects } from "@/lib/motion/store";

export async function GET() {
  return Response.json({ projects: await listProjects() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  return Response.json({ project: await createProject() }, { status: 201 });
}
