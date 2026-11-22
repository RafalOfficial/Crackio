/**
 * The visitor's address. The demo listens on 127.0.0.1 behind a Cloudflare tunnel, sometimes with a front door (a Pages
 * proxy) before it. The first X-Forwarded-For entry is the visitor either way (the front door sets it, Cloudflare appends
 * after it); Cloudflare's own header and the rest cover a direct or local visit.
 */
export function clientIp(request: Request): string {
  const h = request.headers;
  // Only an address counts: any other text in the header (a made-up value per request) would be a new visitor each time.
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return (ADDRESS.test(first) ? first : h.get("cf-connecting-ip") || h.get("x-real-ip") || "local").trim().slice(0, 64);
}

/** An IPv4 or IPv6 address, as proxies write them. */
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=[0-9a-f:.]*:)[0-9a-f:.]{2,45}(?:%[\w.]+)?)$/i;
