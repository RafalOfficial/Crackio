import { makeLocation } from "@/lib/server/location";

/** `{ words, model, machine? }`: a place made from words, one wide picture to build the set from (server/location). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { words?: string; model?: string; machine?: string; resolution?: string } | null;
  if (!body?.words?.trim()) return Response.json({ error: "Say what the place is." }, { status: 400 });
  try {
    return Response.json(await makeLocation(body.words, body.model || "auto", request.signal, body.machine, body.resolution));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
