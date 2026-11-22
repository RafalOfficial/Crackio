import { demoOn } from "@/lib/demo/config";
import { comfyTargets } from "@/lib/server/comfy-targets";
import { getSettings } from "@/lib/server/settings";
import { serverlessEndpoints } from "@/lib/server/serverless/endpoints";
import { keepWarm } from "@/lib/server/serverless/shim";
import { studioWarmGraph, WARM_UP } from "@/lib/engines/comfy-local-recipes";

/**
 * POST `{ load?: "director" }`: while you work in the Director, the machine chosen under Run on stays ready when it's
 * RunPod Serverless (server/serverless/shim `keepWarm`): its worker isn't let stop between shots, and with `load` a
 * new place gets the moved-camera shot's models loaded while you frame it. Nothing on your own GPU (nothing stops
 * there) or on a live demo (its GPU isn't the visitor's to keep). `{ state }`: busy, kept, loading, cold or none.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { load?: string };
  if (demoOn()) return Response.json({ state: "none" });
  const runOn = (await getSettings()).runOn;
  const target = runOn ? (await comfyTargets()).find((t) => t.id === runOn) : undefined;
  const ep = target?.serverless ? (await serverlessEndpoints()).find((e) => e.endpointId === target.serverless!.endpointId) : undefined;
  if (!ep) return Response.json({ state: "none" });
  try {
    const state = await keepWarm(ep, body.load === "director" ? { graph: studioWarmGraph(), model: WARM_UP } : undefined);
    return Response.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ state: "none", error: (err as Error).message }, { status: 502 });
  }
}
