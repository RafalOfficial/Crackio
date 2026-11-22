import fs from "node:fs/promises";
import { programPath } from "@/lib/agent/connect";

/** Crackio's MCP program, for an agent on another computer to save and start (one file, plain Node, no packages). */
export async function GET() {
  const text = await fs.readFile(/*turbopackIgnore: true*/ programPath(), "utf8").catch(() => null);
  if (text === null) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(text, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Disposition": 'attachment; filename="crackio-mcp.mjs"', "Cache-Control": "no-store" } });
}
