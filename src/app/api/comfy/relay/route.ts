import { relayFor } from "@/lib/server/comfy-relay";

/**
 * The ComfyUI page's frame: the port on this computer that relays one machine's ComfyUI interface (`?machine=` its id from
 * the Local page). Opened from another device, the relay listens for the network too.
 */
export async function GET(request: Request) {
  const machine = new URL(request.url).searchParams.get("machine");
  if (!machine || machine.length > 120) return Response.json({ error: "Which machine?" }, { status: 400 });
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const everywhere = !/^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  try {
    const { port } = await relayFor(machine, everywhere);
    return Response.json({ port }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
