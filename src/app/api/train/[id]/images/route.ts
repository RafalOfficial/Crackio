import { z } from "zod";

/**
 * A LoRA's pictures: POST adds some (multipart, field "file", any picture format sharp reads; each is kept upright as a
 * JPEG of at most 2048 px), DELETE takes some out. Both answer with the job. For an edit LoRA, `?as=before` adds the
 * pictures as before pictures (a name like "cat_before.jpg" says so by itself), and DELETE with `before` takes only the
 * before pictures off the pairs named.
 */
const MAX_BYTES = 40 * 1024 * 1024;

export async function POST(request: Request, ctx: RouteContext<"/api/train/[id]/images">) {
  const { id } = await ctx.params;
  const { getJob } = await import("@/lib/server/train/store");
  const { isActive } = await import("@/lib/train/types");
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  if (isActive(job.state)) return Response.json({ error: "Pause it first." }, { status: 409 });
  if (job.progress.step > 0) return Response.json({ error: "This one has started training: its set is fixed. Start a new LoRA to train on other pictures." }, { status: 409 });
  const form = await request.formData().catch(() => null);
  const files = form?.getAll("file").filter((f): f is File => f instanceof File) ?? [];
  if (!files.length) return Response.json({ error: "No pictures received." }, { status: 400 });
  const { addImages } = await import("@/lib/server/train/dataset");
  const refused: { name: string; why: string }[] = [];
  const good: { name: string; data: Buffer }[] = [];
  for (const f of files.slice(0, 60)) {
    if (f.size > MAX_BYTES) refused.push({ name: f.name, why: "Larger than 40 MB." });
    else good.push({ name: f.name, data: Buffer.from(await f.arrayBuffer()) });
  }
  const out = await addImages(job, good, new URL(request.url).searchParams.get("as") === "before" ? "before" : undefined);
  return Response.json({ job, added: out.added.length, refused: [...refused, ...out.refused] }, { status: 201 });
}

const Body = z.object({ ids: z.array(z.string().max(20)).min(1).max(400), before: z.boolean().optional() });

export async function DELETE(request: Request, ctx: RouteContext<"/api/train/[id]/images">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { getJob } = await import("@/lib/server/train/store");
  const { isActive } = await import("@/lib/train/types");
  const job = await getJob(id);
  if (!job) return Response.json({ error: "No such LoRA." }, { status: 404 });
  if (isActive(job.state) || job.progress.step > 0) return Response.json({ error: "This one has started training: its set is fixed." }, { status: 409 });
  const { removeImages, removeBefore } = await import("@/lib/server/train/dataset");
  if (parsed.data.before) await removeBefore(job, parsed.data.ids);
  else await removeImages(job, parsed.data.ids);
  return Response.json({ job });
}
