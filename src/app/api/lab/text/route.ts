import { refinePrompt } from "@/lib/engines/refine";
import { localLlm, localText, routerText } from "@/lib/engines/comfy-text";
import fs from "node:fs/promises";
import { urlToPath } from "@/lib/server/media";

/**
 * Research tool: one answer from a chosen text model (falling back as every tool does), and which model gave it.
 * `{ model, text, instructions?, image?, images?, label? }` (`images`: several, each labelled `label`); `{ local: true, text }` asks
 * the open model on your ComfyUI directly, errors and all; `{ router: "google/gemini-3.5-flash", text }` asks one hosted model on
 * your Comfy key directly (Comfy Router's chat endpoint), errors and all.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { model?: string; text?: string; instructions?: string; image?: string; images?: string[]; label?: string; local?: boolean; router?: string } | null;
  if (!body?.text || (!body.model && !body.local && !body.router)) return Response.json({ error: "Send a model and some text." }, { status: 400 });
  const image = body.image ? urlToPath(body.image) : null;
  const many = (body.images ?? []).map((u) => urlToPath(u)).filter((p): p is string => Boolean(p));
  const began = Date.now();
  if (body.router) {
    try {
      const answer = await routerText({ model: body.router, system: body.instructions ?? "Answer briefly.", prompt: body.text, signal: AbortSignal.timeout(120_000) });
      return Response.json({ answer, ms: Date.now() - began });
    } catch (err) {
      return Response.json({ error: (err as Error).message, hint: (err as { hint?: string }).hint, ms: Date.now() - began }, { status: 500 });
    }
  }
  if (body.local) {
    const found = await localLlm().catch((err: Error) => err.message);
    try {
      const images = await Promise.all(many.map((p) => fs.readFile(p)));
      const answer = await localText({ system: body.instructions ?? "Answer briefly.", prompt: body.text, images, signal: AbortSignal.timeout(120_000) });
      return Response.json({ answer, on: typeof found === "string" ? found : found && { machine: found.target.label, model: found.llm.name }, ms: Date.now() - began });
    } catch (err) {
      return Response.json({ error: (err as Error).message, on: typeof found === "string" ? found : found && { machine: found.target.label, url: found.target.url }, ms: Date.now() - began }, { status: 500 });
    }
  }
  const { prompt, by } = await refinePrompt({
    text: body.text,
    prefer: [body.model!],
    effort: "low",
    ...(body.instructions ? { instructions: body.instructions } : {}),
    ...(image ? { references: [{ path: image, label: "the picture" }] } : many.length ? { references: many.map((path) => ({ path, label: body.label ?? "the picture" })), imageEdge: 1024 } : {}),
  });
  return Response.json({ answer: prompt, by, ms: Date.now() - began });
}
