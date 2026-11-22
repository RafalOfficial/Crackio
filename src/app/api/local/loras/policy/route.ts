import { z } from "zod";

/**
 * Adult LoRAs on this computer (Settings → Preferences; server/lora-policy): GET says what was chosen, POST changes it.
 * Someone who said they are under 18 can't change it again from the app.
 */
export async function GET() {
  const { loraPolicy } = await import("@/lib/server/lora-policy");
  return Response.json(await loraPolicy(), { headers: { "Cache-Control": "no-store" } });
}

const Body = z.object({ age: z.enum(["adult", "minor"]).optional(), adult: z.boolean().optional(), blur: z.boolean().optional() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { setLoraPolicy, PolicyLocked } = await import("@/lib/server/lora-policy");
  try {
    return Response.json(await setLoraPolicy(parsed.data));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof PolicyLocked ? 403 : 500 });
  }
}
