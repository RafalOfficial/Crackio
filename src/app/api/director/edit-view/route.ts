import { editView } from "@/lib/server/director";

/** `{ url, words, model, machine? }`: one view of the place changed as the words say, its camera and edges kept. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; words?: string; model?: string; machine?: string } | null;
  if (!body?.url || !body.words?.trim()) return Response.json({ error: "Say what to change." }, { status: 400 });
  try {
    return Response.json(await editView(body.url, body.words.slice(0, 500), body.model || "auto", request.signal, body.machine));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
