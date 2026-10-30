import { drawTurnaround } from "@/lib/server/director";
import type { SceneElement } from "@/lib/director/types";

/**
 * `{ element, model, machine? }`: the subject drawn from every side by that model (or Crackio's pick for "auto"), for
 * the camera view. Slow (one picture per side, in parallel where the model allows); cached per photo and angle.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { element?: SceneElement; model?: string; machine?: string } | null;
  if (!body?.element?.image?.url) return Response.json({ error: "Send the subject with its picture." }, { status: 400 });
  try {
    return Response.json({ views: await drawTurnaround(body.element, body.model || "auto", request.signal, body.machine) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
