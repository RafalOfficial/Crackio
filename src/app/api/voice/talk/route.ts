import { z } from "zod";
import { DEMO } from "@/lib/demo/config";
import { talkTurn, type TalkEvent } from "@/lib/server/voice/talk";

const Body = z.object({
  /** What was just said: a WAV, base64. */
  audio: z.string().min(64).max(8_000_000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(60),
  voice: z.string().min(1).max(200),
  model: z.enum(["local:voice:drama3", "local:voice:voxcpm2", "local:voice:supertonic"]),
  language: z.string().max(20).optional(),
});

/**
 * One turn of Voice's Talk, as newline-delimited JSON while it happens: {heard}, the answer as it's written {text},
 * each sentence's audio as soon as it's spoken {audio}, then {done}. Closing the request (someone talking over it)
 * stops the answer and the voice at once.
 */
export async function POST(request: Request) {
  if (DEMO) return Response.json({ error: "Talk isn't part of the live demo." }, { status: 403 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say something first." }, { status: 400 });
  const ctrl = new AbortController();
  request.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: TalkEvent) => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the listener went away */
        }
      };
      try {
        await talkTurn(parsed.data, emit, ctrl.signal);
      } catch (err) {
        if (!ctrl.signal.aborted) emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ctrl.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
