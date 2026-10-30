import { placeWorld } from "@/lib/server/director";
import { sharperWorld, typicalTimes } from "@/lib/server/world";
import type { PlaceView } from "@/lib/director/types";

/**
 * `?sharp=<world url>`: the 8K version of a world once it's sharpened (`{ url, width, height }`, `{ pending: true }` while
 * it's made, `{}` for none). Else how long a place usually takes here, seconds: `{ photo, world }`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("sharp");
  if (!url) return Response.json(await typicalTimes(), { headers: { "Cache-Control": "no-store" } });
  const sharp = await sharperWorld(url);
  return Response.json(sharp === "pending" ? { pending: true } : (sharp ?? {}), { headers: { "Cache-Control": "no-store" } });
}

/** `{ url, view, place, model, machine?, fresh? }`: the place all around its photo's spot as one 360 picture (server/world). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; view?: PlaceView; place?: string; model?: string; machine?: string; fresh?: boolean; around?: string[] } | null;
  if (!body?.url || !body.view) return Response.json({ error: "Send the place photo and how it was taken." }, { status: 400 });
  try {
    const around = Array.isArray(body.around) && body.around.length === 6 && body.around.every((u) => typeof u === "string") ? body.around : undefined;
    return Response.json(await placeWorld(body.url, body.view, body.place ?? "", body.model || "auto", request.signal, body.machine, body.fresh === true, around));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
