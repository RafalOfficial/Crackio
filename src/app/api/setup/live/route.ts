import { liveGpus } from "@/lib/server/setup/live";
import { watchIdle } from "@/lib/server/setup/cloud-money";

/** Machines' GPUs right now (?machine=a,b for some): load, memory, heat, and what ComfyUI is doing there. */
export async function GET(request: Request) {
  watchIdle();
  const ids = new URL(request.url).searchParams.get("machine")?.split(",").filter(Boolean);
  return Response.json({ live: await liveGpus(ids) }, { headers: { "Cache-Control": "no-store" } });
}
