/**
 * What the live demo says about its machines: their GPUs and models, never where they answer or how to reach them, nor
 * the server's own CPU, memory and disk. Drops every field with one of these names, at any depth (whatever shape a
 * machine kind adds later).
 */
const HIDDEN = new Set(["url", "urls", "token", "key", "apiKey", "secret", "password", "ssh", "host", "hostname", "endpoint", "endpointId", "path", "dir", "folder", "ip", "cpu", "ramGb", "diskFreeGb"]);

export function scrubForDemo<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubForDemo) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !HIDDEN.has(k)).map(([k, v]) => [k, scrubForDemo(v)])) as T;
  }
  return value;
}
