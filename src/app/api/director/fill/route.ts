import { fillView } from "@/lib/server/director";

/**
 * `{ url, place, model, machine? }`: a view of the location (rendered from the photo's spot, turned) with what the
 * photo never showed filled in by a model, carrying on only what borders it. For building the place all around.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; place?: string; photo?: string; model?: string; machine?: string; bridge?: boolean } | null;
  if (!body?.url) return Response.json({ error: "Send the view to fill." }, { status: 400 });
  try {
    return Response.json(await fillView(body.url, body.place ?? "", body.model || "auto", request.signal, body.machine, body.photo, body.bridge === true));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
