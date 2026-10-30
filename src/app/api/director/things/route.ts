import { liftThings } from "@/lib/server/director";

/**
 * `{ url, place, model, machine? }`: the cars, people, animals and objects a place photo shows, each cut out to stand on
 * set as its own subject, and the photo with them removed (filled in by `model`). Cached per photo and model.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; place?: string; model?: string; machine?: string } | null;
  if (!body?.url) return Response.json({ error: "Send the place photo." }, { status: 400 });
  try {
    return Response.json(await liftThings(body.url, body.place ?? "", body.model || "auto", request.signal, body.machine));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
