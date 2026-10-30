import { nanoid } from "nanoid";
import { z } from "zod";
import { getGeneration, listGenerations, saveGeneration } from "@/lib/server/db";
import { mediaFiles } from "@/lib/server/media";
import { warmPreviews } from "@/lib/server/previews";
import { runner } from "@/lib/server/runner";
import { noteMentions, resolveMentions } from "@/lib/server/cast";
import type { Generation } from "@/lib/generations/types";
import { ASPECTS } from "@/lib/shot";
import { demoOwner, maysee } from "@/lib/demo/owner";
import { demoGpuMayRun, demoJob } from "@/lib/demo/gate";
import { priceGeneration } from "@/lib/demo/prices";

const aspectIds = ASPECTS.map((a) => a.id) as [string, ...string[]];

const GenerateBody = z.object({
  tool: z.string().min(1).max(40),
  prompt: z.string().max(8000).default(""),
  compiledPrompt: z.string().max(16000).optional(),
  aspect: z.enum(aspectIds).default("3:2"),
  count: z.number().int().min(1).max(4).default(1),
  model: z.string().max(300).default("auto"),
  refine: z.boolean().default(true),
  references: z
    .array(
      z.object({
        url: z.string().max(500),
        label: z.string().max(200).optional(),
        role: z.enum(["subject", "product", "place", "style", "edit-target"]).optional(),
      }),
    )
    .max(16)
    .default([]),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  // In the live demo, only the signed-in code's own (lib/demo).
  const viewer = await demoOwner(request);
  const ids = url.searchParams.get("ids");
  if (ids) {
    const items = ids
      .split(",")
      .slice(0, 50)
      .map((id) => getGeneration(id))
      .filter((g) => g && maysee(viewer, g.owner));
    return Response.json({ items });
  }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
  const before = url.searchParams.get("before");
  const items = listGenerations({ limit, before: before ? Number(before) : undefined, owner: viewer });
  // These are about to show as cards: get their light copies made, newest first.
  warmPreviews(mediaFiles(items.flatMap((g) => g.outputs.map((o) => o.url))));
  return Response.json({ items });
}

export async function POST(request: Request) {
  const parsed = GenerateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const transform = body.params?.kind === "upscale" || body.params?.kind === "reframe";
  if (!transform && !body.prompt.trim() && !body.compiledPrompt && body.references.length === 0) {
    return Response.json({ error: "Describe the shot or add a reference image first." }, { status: 400 });
  }
  // A clip to upscale comes as its address (params.videoUrl), not as a reference picture.
  if (transform && body.references.length === 0 && typeof body.params?.videoUrl !== "string") {
    return Response.json({ error: "Pick an image first." }, { status: 400 });
  }

  // "@mia" brings Mia along (see Cast). Plain pictures and clips list her and keep the words as typed: the runner sends
  // her sheet and face the way the model it picks takes pictures (server/cast-refs). Tools that read their references
  // themselves (Product Studio, Retouch, Director) get her pictures attached here.
  const p = body.params ?? {};
  const plain = (p.kind === undefined || p.kind === "image" || p.kind === "video") && !p.studio && !p.film && !p.retouch && !p.scene && !p.director;
  const mentioned = transform
    ? { prompt: body.prompt, compiledPrompt: body.compiledPrompt, references: body.references, cast: [] }
    : plain
      ? { prompt: body.prompt, compiledPrompt: body.compiledPrompt, references: body.references, cast: noteMentions(body) }
      : resolveMentions({ prompt: body.prompt, compiledPrompt: body.compiledPrompt, references: body.references, kind: p.kind });

  const id = nanoid(14);
  // The live demo: a signed-in code, one job at a time, paid in credits (lib/demo).
  const demo = await demoJob(request, id, async () => ((await demoGpuMayRun(body.model, body.params)) ? priceGeneration(body.tool, body.count, body.params) : { credits: 0 }));
  if (demo.response) return demo.response;

  const gen: Generation = {
    id,
    tool: body.tool,
    engine: "auto",
    model: body.model,
    status: "queued",
    prompt: mentioned.prompt.trim(),
    compiledPrompt: mentioned.compiledPrompt,
    aspect: body.aspect as Generation["aspect"],
    count: body.count,
    references: mentioned.references,
    outputs: [],
    params: { ...body.params, refine: body.refine, ...(mentioned.cast.length ? { cast: mentioned.cast } : {}) },
    progress: 0,
    stage: "Queued",
    createdAt: Date.now(),
    ...(demo.owner ? { owner: demo.owner } : {}),
  };
  saveGeneration(gen);
  runner().enqueue(gen.id);
  return Response.json({ item: gen }, { status: 201 });
}
