import os from "node:os";

/**
 * This computer's network addresses. `os.networkInterfaces()` blocks the whole server for 12–200 ms per call on Windows
 * (measured on the main PC, 2026-11-04), and the request proxy, Settings' look at the ComfyUI install and the LAN https
 * server all ask: one look serves them for `maxAgeMs` (30 s by default).
 */
const g = globalThis as unknown as { __crackioNetAddresses?: { at: number; list: os.NetworkInterfaceInfo[] } };

export function netAddresses(maxAgeMs = 30_000): os.NetworkInterfaceInfo[] {
  const hit = g.__crackioNetAddresses;
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.list;
  const list = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a));
  g.__crackioNetAddresses = { at: Date.now(), list };
  return list;
}

/** When the addresses were last read (0 before the first look). */
export const netAddressesAt = () => g.__crackioNetAddresses?.at ?? 0;
