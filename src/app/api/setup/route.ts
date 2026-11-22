import { createHash } from "node:crypto";
import { setupSnapshot } from "@/lib/server/setup/status";
import { watchRentedBoxes } from "@/lib/server/cloud-accounts";
import type { SetupSnapshot } from "@/lib/setup/types";

/** The look without each requirement's model choices and each machine's models (most of it): what the pills and status lines read. */
const lite = (s: SetupSnapshot): SetupSnapshot => ({
  ...s,
  machines: s.machines.map((m) => ({
    ...m,
    models: undefined,
    tools: Object.fromEntries(Object.entries(m.tools).map(([k, t]) => [k, { ...t, reqs: t.reqs.map((r) => ({ ...r, options: undefined })) }])) as typeof m.tools,
  })),
});

/**
 * Settings' one look at every machine and every tool on it: what's ready, what a set-up would get, what's in the way
 * (lib/setup/types). Read by Settings and the tools' setup pills alike, so they can't disagree. `?fresh=1` skips the 2 s cache.
 * `?lite=1` leaves out each requirement's model choices (`options`) and each machine's models, most of the look, for
 * everything but the Tools sheet. An unchanged look answers 304 to `If-None-Match` with its ETag.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const fresh = query.get("fresh") === "1";
  // Settings in view keeps looking at your cloud accounts, so a GPU you rent joins by itself (at most every 30 s).
  watchRentedBoxes();
  try {
    const snap = await setupSnapshot(fresh);
    const body = JSON.stringify(query.get("lite") === "1" ? lite(snap) : snap);
    const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    const headers = { "Cache-Control": "no-store", ETag: etag };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
