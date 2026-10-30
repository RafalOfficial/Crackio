import { extendView } from "@/lib/server/extend";
import type { AspectId } from "@/lib/shot";

/** `{ url, place, words, model, aspect, machine? }`: the view from the camera drawn again as the place carries on (server/extend). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; place?: string; words?: string; model?: string; aspect?: AspectId; machine?: string; resolution?: string } | null;
  if (!body?.url) return Response.json({ error: "Send the view to extend." }, { status: 400 });
  try {
    return Response.json(await extendView(body.url, body.place ?? "", body.words ?? "", body.model || "auto", body.aspect ?? "16:9", request.signal, body.machine, body.resolution));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
