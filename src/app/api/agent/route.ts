import { callTool, describeDoor } from "@/lib/agent/call";
import { failure } from "@/lib/agent/errors";

/**
 * The agent door: what Crackio's MCP program (scripts/mcp/crackio-mcp.mjs) talks to. GET lists the tools and the
 * instructions an agent reads when it connects; POST runs one tool. A failure is an answer too (`ok: false` with the
 * error every agent tool shares), so only a request that isn't JSON at all gets an HTTP error. The live demo has no
 * agent door: src/proxy.ts answers 404 for it there.
 */

/**
 * A caller on this computer: it asked for localhost itself, not through the network address, the LAN https address or a
 * tunnel (those keep their own name in Host or X-Forwarded-Host; Next fills the second in with the first when it's missing).
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const fromHere = (request: Request) => LOOPBACK.test(request.headers.get("host") ?? "") && LOOPBACK.test(request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "");

export async function GET(request: Request) {
  return Response.json(await describeDoor({ local: fromHere(request) }), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { tool?: unknown; args?: unknown; client?: unknown } | null;
  if (!body || typeof body.tool !== "string") {
    return Response.json({ ok: false, error: failure("invalid_input", { what: "Send JSON: { tool, args, client }." }) }, { status: 400 });
  }
  const answer = await callTool(body.tool, body.args, typeof body.client === "string" ? body.client : "agent", request.signal);
  return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
}
