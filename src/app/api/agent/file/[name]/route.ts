import fs from "node:fs/promises";
import { shownPath } from "@/lib/agent/pictures";

/** A preview an agent tool made (lib/agent/pictures): a small JPEG, by the name the tool's answer gave. */
export async function GET(_request: Request, ctx: RouteContext<"/api/agent/file/[name]">) {
  const { name } = await ctx.params;
  const file = shownPath(name);
  const data = file ? await fs.readFile(/*turbopackIgnore: true*/ file).catch(() => null) : null;
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/jpeg", "Content-Length": String(data.length), "Cache-Control": "private, max-age=3600" } });
}
