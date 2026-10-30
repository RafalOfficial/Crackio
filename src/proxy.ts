import { NextResponse, type NextRequest } from "next/server";
import { demoOn, demoPage, demoTools } from "@/lib/demo/config";
import { demoApi } from "@/lib/demo/routes";
import { sessionOf } from "@/lib/demo/session";

/**
 * Helpers that use the GPU or disk without costing credits (a clip's frame, outlines, reading a picture, uploads): 60
 * per code every 10 minutes. One server process, so a Map holds the counts.
 */
const HELPERS = /^\/api\/(recast\/(frame|detect|describe)|detect|swap\/outline|templates\/describe|uploads)$/;
const helperUse = new Map<string, number[]>();
function overHelperLimit(code: string) {
  const now = Date.now();
  const recent = (helperUse.get(code) ?? []).filter((t) => now - t < 600_000);
  recent.push(now);
  helperUse.set(code, recent);
  return recent.length > 60;
}

/** Built files and what public/ holds. */
const STATIC = /^\/(_next\/|assets\/|icons\/|favicon\.ico$|icon\.svg$|apple-icon\.png$|robots\.txt$)/;

/**
 * Runs before every request. Outside the live demo it lets everything through untouched. In the demo (lib/demo) it's
 * the front door: a page or API route that isn't on the demo's lists doesn't exist, and anything that spends the GPU or
 * stores a file needs a signed-in access code. The routes check the code again themselves.
 */
export async function proxy(request: NextRequest) {
  if (!demoOn()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  const tools = demoTools();

  if (pathname.startsWith("/api/")) {
    const access = demoApi(method, pathname, tools);
    if (!access) return Response.json({ error: "That isn't part of the live demo." }, { status: 404 });
    if (access !== "code") return NextResponse.next();
    const code = await sessionOf(request);
    if (!code) return Response.json({ error: "Enter your access code first (top of the page)." }, { status: 401 });
    if (HELPERS.test(pathname) && overHelperLimit(code)) {
      return Response.json({ error: "That's a lot at once. Give it a few minutes." }, { status: 429 });
    }
    return NextResponse.next();
  }
  if (STATIC.test(pathname)) return NextResponse.next();
  // Crackio has no server actions, so a page is only ever fetched.
  if (method !== "GET" && method !== "HEAD") return new Response("Not found", { status: 404 });
  // A tool the demo leaves out (Director, Settings, Local…) shows the demo page in its place, which says why. A rewrite,
  // not a redirect: behind a front door, this server's own host name isn't the public one.
  if (!demoPage(pathname, tools)) {
    const to = new URL("/demo", request.url);
    // Behind a tunnel the request says https (X-Forwarded-Proto) while this server speaks plain http, and Next proxies a
    // rewrite to another origin as an external one (over TLS, which fails): keep the origin this server answers on.
    if (request.headers.get("x-forwarded-proto") === "https") to.protocol = "http:";
    return NextResponse.rewrite(to);
  }
  return NextResponse.next();
}
