import { worldDepth } from "@/lib/server/world-depth";

/** `{ url, eye }`: how far everything in a place's 360 world is, and its light (server/world-depth). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; eye?: number } | null;
  if (!body?.url) return Response.json({ error: "Send the place's world." }, { status: 400 });
  try {
    return Response.json(await worldDepth(body.url, Number(body.eye) || 1.6));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
