import "server-only";
import { createHash } from "node:crypto";

/**
 * Checks that an API key is actually accepted, using each provider's cheapest authenticated
 * read. Results are cached per key for ten minutes so Connections stays fast.
 */
export type KeyVerdict = "valid" | "invalid" | "unknown";

const CHECKS: Record<string, (key: string) => Promise<Response>> = {
  comfy: (key) => fetch("https://api.comfy.org/v2/models?limit=1", { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(6000) }),
};

const TTL = 10 * 60_000;
const g = globalThis as unknown as { __crackioKeyCache?: Map<string, { verdict: KeyVerdict; at: number }> };
const cache: Map<string, { verdict: KeyVerdict; at: number }> = (g.__crackioKeyCache ??= new Map());

export async function verifyKey(provider: keyof typeof CHECKS | string, key: string): Promise<KeyVerdict> {
  const check = CHECKS[provider];
  if (!check) return "unknown";
  const id = `${provider}:${createHash("sha256").update(key).digest("hex")}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.verdict;
  let verdict: KeyVerdict = "unknown";
  try {
    const res = await check(key);
    verdict = res.status === 401 || res.status === 403 ? "invalid" : res.ok ? "valid" : "unknown";
  } catch {
    verdict = "unknown"; // offline or slow: don't punish the key
  }
  cache.set(id, { verdict, at: Date.now() });
  return verdict;
}

export function forgetVerdicts() {
  cache.clear();
}
