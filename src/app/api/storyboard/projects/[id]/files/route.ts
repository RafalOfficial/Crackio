import { LibraryError } from "@/lib/server/library";
import { AddFiles, addUploads, projectFiles, removeFile } from "@/lib/server/edit-projects";

const fail = (err: unknown) => {
  if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

export async function GET(_req: Request, ctx: RouteContext<"/api/storyboard/projects/[id]/files">) {
  const { id } = await ctx.params;
  try {
    return Response.json({ items: await projectFiles(id) });
  } catch (err) {
    return fail(err);
  }
}

/** Files you uploaded, added to the project. */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboard/projects/[id]/files">) {
  const { id } = await ctx.params;
  const parsed = AddFiles.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid files" }, { status: 400 });
  try {
    return Response.json({ items: await addUploads(id, parsed.data.items) }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** `?key=`: out of the project (a take goes back to General in the Library). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/storyboard/projects/[id]/files">) {
  const { id } = await ctx.params;
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "Which file?" }, { status: 400 });
  try {
    removeFile(id, key);
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
