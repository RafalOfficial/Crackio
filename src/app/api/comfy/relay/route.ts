import { relayFor } from "@/lib/server/comfy-relay";
import { ourHost } from "@/lib/server/our-host";
import { targetById } from "@/lib/server/comfy-targets";

/**
 * The ComfyUI page's frame: the port on this computer that relays one machine's ComfyUI interface (`?machine=` its id from
 * the Local page). Opened from another device, the relay listens for the network too.
 */
export async function GET(request: Request) {
  // Only from Crackio's own page: another website (an <img> pointing here) or a name that isn't this computer's (DNS
  // rebinding) can't open a relay, least of all one for the whole network.
  if (request.headers.get("sec-fetch-site") === "cross-site" || !ourHost(request.headers.get("host"))) {
    return Response.json({ error: "Crackio only opens this from its own page." }, { status: 403 });
  }
  const machine = new URL(request.url).searchParams.get("machine");
  if (!machine || machine.length > 120) return Response.json({ error: "Which machine?" }, { status: 400 });
  // Only a machine Crackio knows, and never a billed one (RunPod, Comfy Cloud: they're not relayed to the ComfyUI page).
  const t = await targetById(machine);
  if (t.id !== machine || t.metered || t.serverless) return Response.json({ error: "No such machine." }, { status: 404 });
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const everywhere = !/^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  try {
    const { port } = await relayFor(machine, everywhere);
    return Response.json({ port }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
