/**
 * The visitor's address. The demo listens on 127.0.0.1 behind a Cloudflare tunnel, sometimes with a front door (a Pages
 * proxy) before it. The first X-Forwarded-For entry is the visitor either way (the front door sets it, Cloudflare appends
 * after it); Cloudflare's own header and the rest cover a direct or local visit.
 */
export function clientIp(request: Request): string {
  const h = request.headers;
  return (h.get("x-forwarded-for")?.split(",")[0] || h.get("cf-connecting-ip") || h.get("x-real-ip") || "local").trim().slice(0, 64);
}
