import { z } from "zod";
import { enhance } from "@/lib/engines/enhance";
import { lfm3Machine } from "@/lib/engines/comfy-text";

const Body = z.object({ text: z.string().trim().min(1).max(2000), kind: z.enum(["image", "video"]).default("image") });

/** Settings → Tools → Add-ons → Try the prompt enhancer: your words as it writes them, where and how fast. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Type a few words first." }, { status: 400 });
  const machine = await lfm3Machine("enhance").catch(() => null);
  if (!machine) return Response.json({ error: "The prompt enhancer isn't on any of your machines yet." }, { status: 409 });
  const began = Date.now();
  try {
    const prompt = await enhance({ ...parsed.data, signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) });
    return Response.json({ prompt, ms: Date.now() - began, on: machine.label }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
