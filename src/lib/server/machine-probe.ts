import "server-only";
import { isHere, type ComfyTarget } from "./comfy-targets";
import { bumpEpoch } from "./epoch";
import type { BridgeInfo, SystemStats } from "./hardware";

/**
 * One look at each ComfyUI, shared by everything that asks whether it answers and what it runs on: the Local page,
 * Settings, the model pickers, Connections, job routing, Voice and Lip Sync. Each used to send its own /system_stats and
 * wait out its own timeout, so a switched-off box cost every request seconds (the vast 5090 stopped at $0 made /api/setup
 * take 2–4 s and /api/models 5–7 s).
 *
 * - A machine that answers is looked at again once its look is older than `maxAgeMs` (2 s by default). Up to 30 s old,
 *   the last look is answered at once and the new one happens in the background.
 * - A machine that didn't answer is answered "offline" at once and looked at again in the background every 10 s, so
 *   nobody waits on its timeout; it's back within ~10 s of answering again.
 * - A machine that answered at its last look and misses one is asked once more before it counts as off: a rented box
 *   across an ocean, busy drawing, answered in 0.6 to 7 s, and one missed look made a queued job fail with "Connect
 *   ComfyUI" and its models vanish from the list. Its helper's report isn't dropped over one missed answer either.
 * - One request per machine at a time, whoever asks.
 * - Going online or offline bumps the epoch, so model lists made before it are thrown away.
 */

export type MachineLook = {
  /** Its /system_stats, or null when it didn't answer. */
  stats: SystemStats | null;
  /** Crackio's bridge report (/crackio/info), or null without a bridge (or when it didn't answer). */
  bridge: BridgeInfo | null;
  /** When this look was taken. */
  at: number;
};

type Entry = { look: MachineLook | null; pending: Promise<MachineLook> | null; bridgeAt: number };

const g = globalThis as unknown as { __crackioMachineLooks?: Map<string, Entry> };
const looks = (g.__crackioMachineLooks ??= new Map());

const keyOf = (t: ComfyTarget) => `${t.id}|${t.url}|${t.token ? "t" : ""}`;

/** Online looks older than this are taken again before answering; younger ones answer at once while a new one runs. */
const STALE_MS = 30_000;
/** How often a machine that didn't answer is looked at again (in the background). */
const OFFLINE_RETRY_MS = 10_000;
/** The bridge's report changes only with an update: asked again once a minute. */
const BRIDGE_MS = 60_000;

async function ask<T>(t: ComfyTarget, route: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`${t.url}${route}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: t.token ? { Authorization: `Bearer ${t.token}` } : undefined,
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function lookNow(t: ComfyTarget, e: Entry): Promise<MachineLook> {
  if (e.pending) return e.pending;
  const timeoutMs = isHere(t) ? 3000 : 6000;
  const wasOnline = e.look ? e.look.stats !== null : null;
  const bridgeDue = !e.look?.stats || Date.now() - e.bridgeAt > BRIDGE_MS;
  const pending = (async (): Promise<MachineLook> => {
    let [stats, freshBridge] = await Promise.all([ask<SystemStats>(t, "/system_stats", timeoutMs), bridgeDue ? ask<BridgeInfo>(t, "/crackio/info", timeoutMs) : Promise.resolve(undefined)]);
    // Busy more often than off: asked once more, with a little longer to answer.
    if (!stats && wasOnline) stats = await ask<SystemStats>(t, "/system_stats", timeoutMs + 4000);
    // A helper that reported before and didn't this once is still there: its last report stands, and it's asked again.
    if (stats && freshBridge === null && e.look?.bridge) freshBridge = undefined;
    if (freshBridge !== undefined && stats) e.bridgeAt = Date.now();
    const look: MachineLook = { stats, bridge: stats ? (freshBridge !== undefined ? freshBridge : (e.look?.bridge ?? null)) : null, at: Date.now() };
    e.look = look;
    if (wasOnline !== null && wasOnline !== (stats !== null)) bumpEpoch();
    return look;
  })().finally(() => {
    if (e.pending === pending) e.pending = null;
  });
  e.pending = pending;
  return pending;
}

/**
 * The machine's last look, or a new one. `fresh` waits for a new look (after a restart, before an install); `maxAgeMs`
 * is how old an online look may be; `wait` waits for the new look once it's older than that (picking a machine for a
 * job), instead of answering the last one meanwhile.
 */
export function machineLook(t: ComfyTarget, opts: { maxAgeMs?: number; fresh?: boolean; wait?: boolean } = {}): Promise<MachineLook> {
  const key = keyOf(t);
  let e = looks.get(key);
  if (!e) looks.set(key, (e = { look: null, pending: null, bridgeAt: 0 }));
  const last = e.look;
  if (opts.fresh || !last) return lookNow(t, e);
  const age = Date.now() - last.at;
  if (!last.stats) {
    if (age > OFFLINE_RETRY_MS) void lookNow(t, e);
    return Promise.resolve(last);
  }
  if (age < (opts.maxAgeMs ?? 2000)) return Promise.resolve(last);
  if (age < STALE_MS && !opts.wait) {
    void lookNow(t, e);
    return Promise.resolve(last);
  }
  return lookNow(t, e);
}

/** Whether the machine answered at its last look (looking first if it never was). */
export async function machineOnline(t: ComfyTarget): Promise<boolean> {
  return (await machineLook(t)).stats !== null;
}

/** What is known without asking: true/false from the last look, null before the first. */
export function lastKnownOnline(t: ComfyTarget): boolean | null {
  const look = looks.get(keyOf(t))?.look;
  return look ? look.stats !== null : null;
}

/** Forget every look (machines added or removed), or one machine's. */
export function forgetMachineLooks(t?: ComfyTarget) {
  if (t) looks.delete(keyOf(t));
  else looks.clear();
}
