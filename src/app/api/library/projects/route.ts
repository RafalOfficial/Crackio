import { createProject, LibraryError, ProjectBody } from "@/lib/server/library";

export async function POST(request: Request) {
  const parsed = ProjectBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid project" }, { status: 400 });
  try {
    return Response.json({ project: createProject(parsed.data) }, { status: 201 });
  } catch (err) {
    if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
