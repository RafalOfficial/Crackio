import { z } from "zod";

/**
 * The LoRA library: GET is Crackio's picks for every open model, each model's Hugging Face search bases, and what every
 * downloaded LoRA file is. POST downloads a LoRA to machines (one of the picks by `id`, or a file found on Hugging Face by
 * `repo` and `path`) or deletes a file from one.
 */
export async function GET() {
  try {
    const { loraLibrary } = await import("@/lib/server/loras");
    return Response.json(await loraLibrary(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

const target = z.string().min(1).max(80);
const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("install"),
    model: z.string().min(1).max(80),
    id: z.string().max(120).optional(),
    repo: z.string().max(200).optional(),
    path: z.string().max(400).optional(),
    targets: z.array(target).min(1).max(8),
  }),
  z.object({ action: z.literal("remove"), file: z.string().min(1).max(220), target }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  const { installLora, removeLora } = await import("@/lib/server/loras");
  const { LocalError } = await import("@/lib/server/local-models");
  try {
    if (body.action === "install") {
      if (!body.id && !(body.repo && body.path)) return Response.json({ error: "Say which LoRA." }, { status: 400 });
      return Response.json(await installLora(body));
    }
    return Response.json(await removeLora(body.file, body.target));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LocalError ? err.status : 500 });
  }
}
