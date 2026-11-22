import fs from "node:fs/promises";
import { callTool, describeDoor } from "@/lib/agent/call";
import { shownPath } from "@/lib/agent/pictures";

/**
 * Crackio's tools over MCP's Streamable HTTP transport, for clients that connect to an address instead of starting a
 * program. The same tools as the stdio program (scripts/mcp/crackio-mcp.mjs), with two limits that come from having no
 * program on the agent's side: file arguments must be files Crackio already has (its own addresses), and results are
 * links to this Crackio, not paths on the agent's disk. Each request is answered on its own: no session is kept.
 */
const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> & { _meta?: Record<string, unknown> } };

async function answer(msg: Rpc, origin: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // a notification
  const meta = params?._meta ?? {};
  const version = meta[`${META}protocolVersion`];
  const modern = version !== undefined;
  const door = await describeDoor({ local: false });
  const info = { name: "crackio", title: "Crackio", version: door.version };
  const ok = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { [`${META}serverInfo`]: info } } : result });
  const no = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  if (modern && version !== MODERN) return no(-32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: version });
  const tools = door.tools.map((t) => ({ ...t, files: undefined }));
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok({ protocolVersion: typeof asked === "string" && LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: false } }, serverInfo: info, instructions: door.instructions });
    }
    case "server/discover":
      return ok({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } }, instructions: door.instructions, ttlMs: 60_000, cacheScope: "private" });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools, ...(modern ? { ttlMs: 60_000, cacheScope: "private" } : {}) });
    case "tools/call": {
      if (typeof params?.name !== "string") return no(-32602, "tools/call needs a tool name");
      const who = (meta[`${META}clientInfo`] as { name?: unknown } | undefined)?.name;
      const out = await callTool(params.name, params.arguments, typeof who === "string" ? who : "http-agent", signal, false);
      if (!out.ok) return ok({ content: [{ type: "text", text: JSON.stringify({ error: out.error }) }], isError: true });
      // Crackio's own addresses become full links the agent's side can open.
      const linked = (text: string) => text.replaceAll("{{crackio}}", origin).replace(/(?<![\w/])\/api\/(?:media\/(?:out|uploads|templates)|agent\/file)\/[A-Za-z0-9._-]+/g, (m) => `${origin}${m}`);
      const body = typeof out.data === "string" ? out.data : JSON.stringify(out.images.length ? { ...(out.data as object), previews: out.images.map((i) => ({ shows: i.label ?? "A preview.", file: i.url })) } : out.data);
      const content: Record<string, unknown>[] = [{ type: "text", text: linked(body) }];
      for (const img of out.images) {
        const file = shownPath(img.url.split("/").pop() ?? "");
        const data = file ? await fs.readFile(/*turbopackIgnore: true*/ file).catch(() => null) : null;
        if (data) content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
      }
      return ok({ content });
    }
    case "resources/list":
      return ok({ resources: [] });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return no(-32601, `Method not found: ${method}`);
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Rpc | Rpc[] | null;
  if (!body) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  const url = new URL(request.url);
  // The address the agent used, so the links it gets back are ones it can reach.
  const origin = `${request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host}`;
  const list = Array.isArray(body) ? body : [body];
  const answers = (await Promise.all(list.map((m) => answer(m, origin, request.signal)))).filter(Boolean);
  // Only notifications: accepted, nothing to say.
  if (!answers.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? answers : answers[0], { headers: { "Cache-Control": "no-store" } });
}

/** No stream is offered for server messages: every answer comes on its own request. */
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
