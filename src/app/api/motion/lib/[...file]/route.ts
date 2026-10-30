import fs from "node:fs/promises";
import path from "node:path";

/**
 * The libraries Motion's compositions may load: GSAP (with its plugins) and three.js (with its
 * addons), served from Crackio's own node_modules. Compositions play in a sandboxed frame with no
 * origin and load three.js as an ES module, so these answer with CORS open; only these two
 * folders are reachable, and only .js files in them.
 */
const ROOTS = {
  gsap: path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "gsap", "dist"),
  three: path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "three", "build"),
  addons: path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "three", "examples", "jsm"),
};

const HEADERS = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=86400",
  "X-Content-Type-Options": "nosniff",
};

function locate(parts: string[]): string | null {
  if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) return null;
  const [first, ...rest] = parts;
  let root: string;
  let rel: string[];
  if (first === "addons") {
    root = ROOTS.addons;
    rel = rest;
  } else if (parts.length === 1 && /^three(\.core|\.module)?\.js$/.test(first)) {
    root = ROOTS.three;
    rel = [first];
  } else if (parts.length === 1) {
    root = ROOTS.gsap;
    rel = [first];
  } else return null;
  if (!rel.length || !rel[rel.length - 1].endsWith(".js")) return null;
  const file = path.join(root, ...rel);
  return file.startsWith(root + path.sep) ? file : null;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/motion/lib/[...file]">) {
  const { file: parts } = await ctx.params;
  const file = locate(parts);
  // Ignored by the bundler: a read of a path it can't pin down makes production builds trace every file in the project.
  const body = file ? await fs.readFile(/*turbopackIgnore: true*/ file).catch(() => null) : null;
  if (!body) return new Response("Not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
  return new Response(new Uint8Array(body), { headers: HEADERS });
}
