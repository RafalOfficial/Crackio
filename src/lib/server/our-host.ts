import os from "node:os";

/**
 * Whether a Host header names this computer: loopback, its own network addresses and name (also any .local name), or
 * one CRACKIO_ALLOWED_ORIGINS adds. A website whose own name resolves to this computer (DNS rebinding) isn't one, so its
 * page can't read or drive Crackio, or a ComfyUI relay, from your browser.
 */
export function ourHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local")) return true;
  if (h === os.hostname().toLowerCase()) return true;
  for (const extra of (process.env.CRACKIO_ALLOWED_ORIGINS ?? "").split(",")) {
    if (extra.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "") === h) return true;
  }
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.address.toLowerCase() === h) return true;
  }
  return false;
}
