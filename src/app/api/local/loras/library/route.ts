import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The LoRA library: GET is Crackio's picks for every open model, each model's Hugging Face search bases, and what every
 * downloaded LoRA file is. POST downloads a LoRA to machines (one of the picks by `id`, or one found on Hugging Face by
 * `repo`, with its `path` or the file Crackio picks) or deletes a file from one; for a LoRA Crackio keeps a copy of (one you uploaded, one trained here)
 * it sends that copy to machines, and for an uploaded one changes its words or deletes it everywhere.
 */
export async function GET(request: Request) {
  try {
    const { loraLibrary } = await import("@/lib/server/loras");
    // 140 KB, asked again after every install: an unchanged library answers 304 to its ETag (sent as If-None-Match).
    const body = JSON.stringify(await loraLibrary());
    const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    const headers = { "Cache-Control": "no-store", ETag: etag };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
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
  // `forget`: a test download, so what Crackio noted of the file goes with it.
  z.object({ action: z.literal("remove"), file: z.string().min(1).max(220), target, forget: z.boolean().optional() }),
  z.object({ action: z.literal("send"), file: z.string().min(1).max(220), targets: z.array(target).min(1).max(8) }),
  z.object({ action: z.literal("stop-send"), file: z.string().min(1).max(220), target }),
  z.object({
    action: z.literal("edit"),
    file: z.string().min(1).max(220),
    name: z.string().max(80).optional(),
    trigger: z.string().max(200).optional(),
    triggerAt: z.enum(["start", "end"]).optional(),
    strength: z.number().min(-3).max(3).optional(),
  }),
  z.object({ action: z.literal("forget"), file: z.string().min(1).max(220) }),
  // How to prompt it, in your words (the Train page): agents read it before they use the LoRA.
  z.object({ action: z.literal("notes"), file: z.string().min(1).max(220), text: z.string().max(4000) }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  const { installLora, removeLora } = await import("@/lib/server/loras");
  const { LocalError } = await import("@/lib/server/local-models");
  const home = await import("@/lib/server/lora-home");
  try {
    if (body.action === "send") return Response.json(await home.sendToMachines(body.file, body.targets));
    if (body.action === "stop-send") return Response.json({ stopped: home.stopSend(body.file, body.target) });
    if (body.action === "edit") return Response.json({ record: await home.editUpload(body.file, body) });
    if (body.action === "forget") return Response.json(await home.forgetUpload(body.file));
    if (body.action === "notes") {
      const record = await (await import("@/lib/server/lora-notes")).setLoraNotes(body.file, body.text, "you");
      return record ? Response.json({ record }) : Response.json({ error: "Crackio has no record of that LoRA file." }, { status: 404 });
    }
    if (body.action === "install") {
      // A pick by its id, or a find by its repo: with no `path`, Crackio picks the file (or the Wan pair) from the repo.
      if (!body.id && !body.repo) return Response.json({ error: "Say which LoRA." }, { status: 400 });
      return Response.json(await installLora(body));
    }
    return Response.json(await removeLora(body.file, body.target, body.forget));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof LocalError || err instanceof home.LoraRefused ? err.status : 500 });
  }
}
