import { setupSnapshot } from "@/lib/server/setup/status";

/**
 * Settings' one look at every machine and every tool on it: what's ready, what a set-up would get, what's in the way
 * (lib/setup/types). Read by Settings and the tools' setup pills alike, so they can't disagree. `?fresh=1` skips the 2 s cache.
 */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  try {
    return Response.json(await setupSnapshot(fresh), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
