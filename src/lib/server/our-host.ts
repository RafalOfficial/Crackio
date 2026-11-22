import os from "node:os";
import { netAddresses, netAddressesAt } from "./net-addresses";

/** This computer's own names: loopback, its name, its network addresses and any CRACKIO_ALLOWED_ORIGINS entry. */
function ownNames(maxAgeMs?: number): Set<string> {
  const set = new Set(["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()]);
  for (const extra of (process.env.CRACKIO_ALLOWED_ORIGINS ?? "").split(",")) {
    const h = extra.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
    if (h) set.add(h);
  }
  for (const a of netAddresses(maxAgeMs)) set.add(a.address.toLowerCase());
  return set;
}

/**
 * Whether a Host header names this computer: loopback, its own network addresses and name (also any .local name), or
 * one CRACKIO_ALLOWED_ORIGINS adds. A website whose own name resolves to this computer (DNS rebinding) isn't one, so its
 * page can't read or drive Crackio, or a ComfyUI relay, from your browser.
 */
export function ourHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h.endsWith(".local") || ownNames().has(h)) return true;
  // An address this computer only just got (another Wi-Fi, a new DHCP lease): look again before turning it away, at
  // most every 5 s (each look blocks the server for a moment).
  return Date.now() - netAddressesAt() > 5000 && ownNames(0).has(h);
}
