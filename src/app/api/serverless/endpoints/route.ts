import { z } from "zod";
import { demoFull } from "@/lib/demo/config";
import { updateSettings } from "@/lib/server/settings";
import { forgetTargets } from "@/lib/server/comfy-targets";

/**
 * Your own RunPod Serverless endpoints (Connections → RunPod Serverless), run with your RunPod key: add one by its id, or
 * remove it. From this computer only: a hosted Crackio never takes a visitor's endpoint or key.
 */
const Add = z.object({ endpointId: z.string().trim().regex(/^[\w-]{4,64}$/, "That isn't an endpoint id."), label: z.string().trim().max(60).optional() });

const fromHere = (request: Request) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.get("host") ?? "");

export async function POST(request: Request) {
  if (!fromHere(request) && !demoFull()) return Response.json({ error: "Only from this computer." }, { status: 403 });
  const parsed = Add.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid endpoint." }, { status: 400 });
  const { endpointId, label } = parsed.data;
  await updateSettings((s) => ({ ...s, serverless: [...(s.serverless ?? []).filter((e) => e.endpointId !== endpointId), { endpointId, ...(label ? { label } : {}) }] }));
  forgetTargets();
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!fromHere(request) && !demoFull()) return Response.json({ error: "Only from this computer." }, { status: 403 });
  const endpointId = new URL(request.url).searchParams.get("endpointId");
  await updateSettings((s) => ({ ...s, serverless: (s.serverless ?? []).filter((e) => e.endpointId !== endpointId) }));
  forgetTargets();
  return Response.json({ ok: true });
}
