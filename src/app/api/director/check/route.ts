import { checkTake } from "@/lib/server/director-check";

/** `{ id }`: how close a finished Director take came to its plan (placement, size, depth), kept on the take. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return Response.json({ error: "Send the take's id." }, { status: 400 });
  try {
    return Response.json({ check: await checkTake(body.id) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
