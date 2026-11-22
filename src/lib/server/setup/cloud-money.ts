import "server-only";
import { getSettings, updateSettings } from "../settings";
import { forgetRentedBoxes, rentedBoxes } from "../cloud-accounts";
import { comfyTargets } from "../comfy-targets";
import { removeMachine } from "../local-models";
import { sshRun } from "../ssh";
import { podAction, terminatePod } from "../runpod-pods";
import { liveGpus } from "./live";
import { setupJobs } from "./jobs";
import { setupSnapshot } from "./status";
import type { AutoStop, CloudCredit } from "@/lib/setup/types";

/**
 * Money on rented GPUs, for Settings: each cloud account's credit and when it runs out at what its running boxes cost,
 * and boxes that stop themselves once idle. A box is idle when nothing uses it: no ComfyUI work queued or running, no
 * set-up or helper download there, the card quiet (GPU load under the box's own threshold, 10% unless you pick another,
 * so a training run outside ComfyUI counts as work; VRAM doesn't count, as ComfyUI keeps the last model loaded), and
 * over its SSH the box itself quiet too: under 20 MB moved in the last minute (an agent's wget or Hugging Face download
 * is work) and its own processes under half a CPU core (unpacking, building; not the load average, which on a shared
 * machine is everyone's). When Crackio can't look over SSH, no idle time counts.
 * Stopping keeps the disk (vast.ai bills only its storage then); Start brings the same box back, and Crackio connects to
 * it again by itself. A box you rented for one go can instead be deleted once idle (box and disk, for good: nothing
 * bills any more), and Crackio forgets it.
 */

const VAST = "https://console.vast.ai/api/v0";
/** RunPod's credit is only in its GraphQL API (REST v2 has none); pods go through REST v2 (runpod-pods). */
const RUNPOD_GQL = "https://api.runpod.io/graphql";

type Money = {
  credit: { at: number; value: CloudCredit[]; reading: boolean };
  idle: Map<string, { since: number }>;
  /** Each box's bytes moved over its network at the last look, to see what moved since. */
  net: Map<string, { at: number; bytes: number; cpuUsec?: number | null }>;
  /** Why each box wasn't idle at the last look. */
  why: Map<string, string>;
  stopped: Map<string, number>;
  /** Boxes the idle watch stopped or deleted, for notifications. */
  ended: Map<string, IdleEnd>;
  watching: ReturnType<typeof setInterval> | null;
  started: number;
};
export type IdleEnd = { box: string; at: number; label: string; minutes: number; deleted: boolean };
const g = globalThis as unknown as { __crackioMoney?: Money };
const money = (g.__crackioMoney ??= { credit: { at: 0, value: [], reading: false }, idle: new Map(), net: new Map(), why: new Map(), stopped: new Map(), ended: new Map(), watching: null, started: Date.now() });
// The dev server keeps the watch across reloads: one from before `net`, `why` and `ended`.
money.net ??= new Map();
money.why ??= new Map();
money.ended ??= new Map();

/** GPU load (%) a box counts as idle under, unless you pick another. */
const IDLE_LOAD = 10;
type Then = "stop" | "delete";
type Saved = number | { minutes: number; load?: number; then?: Then };
type Rule = { minutes: number; load: number; then: Then };
/** A saved rule: a bare number is the minutes, from before you could pick the load (and stopping was all it did). */
const ruleOf = (v: Saved): Rule => (typeof v === "number" ? { minutes: v, load: IDLE_LOAD, then: "stop" } : { minutes: v.minutes, load: v.load ?? IDLE_LOAD, then: v.then === "delete" ? "delete" : "stop" });

/** Moved more than this in a minute: something downloads or uploads there. */
const NET_BUSY_BYTES = 20 * 1024 ** 2;
/** Its own processes used more than this many CPU cores over the last minute: unpacking, building, a CPU job. */
const CPU_BUSY_CORES = 0.5;

/**
 * The CPU time the box's own processes used so far, in µs: its cgroup's counter (v2 cpu.stat, else v1 cpuacct). Not the
 * load average: a rented box is a container on a shared machine, and /proc/loadavg there is the whole machine's (an idle
 * vast.ai RTX A4000 read 4.1 from other renters' 1,280 processes, while it used 0.02 cores itself).
 */
const CPU_USEC = `u=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat 2>/dev/null)
if [ -z "$u" ]; then for f in /sys/fs/cgroup/cpuacct/cpuacct.usage /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage; do if [ -r "$f" ]; then u=$(( $(cat "$f") / 1000 )); break; fi; done; fi
echo CRACKIO_CPU_USEC \${u:-none}`;

/** The box itself over SSH: bytes its network moved (every interface but loopback) and its CPU time. Null when it doesn't answer. */
async function boxActivity(login: { host: string; port: number; user: string }): Promise<{ bytes: number; cpuUsec: number | null } | null> {
  const r = await sshRun(login, `cat /proc/net/dev\n${CPU_USEC}`, { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  let bytes = 0;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) bytes += (f[0] || 0) + (f[8] || 0);
  }
  const cpu = Number(/CRACKIO_CPU_USEC\s+(\d+)/.exec(r.stdout)?.[1]);
  return { bytes, cpuUsec: Number.isFinite(cpu) ? cpu : null };
}

/** The last look at your accounts' credit (read every 2 minutes in the background; empty until the first answers). */
/** The credit read now, not the copy of the last two minutes: for a question that can't wait (may a run start?). */
export async function creditFresh(): Promise<CloudCredit[]> {
  const value = await readCredit().catch(() => null);
  if (value) money.credit = { at: Date.now(), value, reading: false };
  return money.credit.value;
}

export function creditNow(): CloudCredit[] {
  if (!money.credit.reading && Date.now() - money.credit.at > 120_000) {
    money.credit.reading = true;
    void readCredit()
      .then((value) => (money.credit = { at: Date.now(), value, reading: false }))
      .catch(() => (money.credit = { ...money.credit, at: Date.now(), reading: false }));
  }
  return money.credit.value;
}

async function readCredit(): Promise<CloudCredit[]> {
  const s = await getSettings();
  const out: CloudCredit[] = [];
  const list = await rentedBoxes().catch(() => null);
  const burn = (provider: "vast" | "runpod") => {
    const up = (list?.boxes ?? []).filter((b) => b.provider === provider && b.ready);
    return { perHour: up.reduce((n, b) => n + (b.price ?? 0), 0), running: up.length };
  };
  const at = Date.now();
  if (s.keys.vast) {
    const res = await fetch(`${VAST}/users/current/`, { headers: { Authorization: `Bearer ${s.keys.vast}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const me = (await res?.json().catch(() => null)) as { credit?: number } | null;
    if (typeof me?.credit === "number") {
      const { perHour, running } = burn("vast");
      const hoursLeft = perHour > 0 ? me.credit / perHour : null;
      out.push({ provider: "vast", balance: me.credit, perHour, running, hoursLeft, until: hoursLeft !== null ? at + hoursLeft * 3_600_000 : null, at });
    }
  }
  if (s.keys.runpod) {
    const res = await fetch(RUNPOD_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.keys.runpod}` },
      body: JSON.stringify({ query: "{ myself { clientBalance currentSpendPerHr } }" }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const me = ((await res?.json().catch(() => null)) as { data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number } } } | null)?.data?.myself;
    if (typeof me?.clientBalance === "number") {
      const perHour = me.currentSpendPerHr ?? burn("runpod").perHour;
      const hoursLeft = perHour > 0 ? me.clientBalance / perHour : null;
      out.push({ provider: "runpod", balance: me.clientBalance, perHour, running: burn("runpod").running, hoursLeft, until: hoursLeft !== null ? at + hoursLeft * 3_600_000 : null, at });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ stopping idle boxes */

/** Each box with an idle stop, how long it has been idle, and when Crackio stopped it. */
export async function autoStopNow(): Promise<Record<string, AutoStop>> {
  watchIdle();
  const rules = (await getSettings()).autoStop ?? {};
  const out: Record<string, AutoStop> = {};
  for (const [box, v] of Object.entries(rules)) {
    const { minutes, load, then } = ruleOf(v);
    const idle = money.idle.get(box);
    out[box] = {
      box,
      minutes,
      load,
      then,
      idleMinutes: idle ? (Date.now() - idle.since) / 60_000 : null,
      why: idle ? null : (money.why.get(box) ?? null),
      ...(money.stopped.has(box) ? { stoppedAt: money.stopped.get(box) } : {}),
    };
  }
  return out;
}

/** Boxes the idle watch stopped or deleted, and when (for notifications). */
export const idleEnded = (): IdleEnd[] => [...money.ended.values()];

/**
 * Turns a box's idle stop on (minutes; the GPU load it counts as idle under; then stop it or delete it: each kept as it
 * was when not given) or off (null).
 */
export async function setAutoStop(box: string, minutes: number | null, load?: number, then?: Then) {
  await updateSettings((s) => {
    const next = { ...(s.autoStop ?? {}) };
    const was = next[box] != null ? ruleOf(next[box]) : null;
    if (minutes === null) delete next[box];
    else next[box] = { minutes, load: load ?? was?.load ?? IDLE_LOAD, then: then ?? was?.then ?? "stop" };
    return { ...s, autoStop: next };
  });
  money.idle.delete(box);
  money.why.delete(box);
  // A fresh first look: one left from an earlier rule counted every download since as "the last minute".
  money.net.delete(box);
  watchIdle();
}

/** Deletes a rented box at its cloud, for good: the box and its disk. Crackio forgets it (and its idle rule) at once. */
export async function deleteBox(box: string) {
  const [provider, instance] = box.split(":");
  const s = await getSettings();
  if (provider === "vast") {
    if (!s.keys.vast) throw new Error("Add your vast.ai key under Settings → Accounts first.");
    const res = await fetch(`${VAST}/instances/${encodeURIComponent(instance)}/`, { method: "DELETE", headers: { Authorization: `Bearer ${s.keys.vast}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; msg?: string; error?: string };
    if (!res.ok || body.success === false) throw new Error(body.msg ?? body.error ?? `vast.ai said ${res.status}.`);
  } else if (provider === "runpod") {
    if (!s.keys.runpod) throw new Error("Add your RunPod key under Settings → Accounts first.");
    await terminatePod(s.keys.runpod, instance);
  } else {
    throw new Error("Crackio can only delete vast.ai and RunPod boxes.");
  }
  const t = (await comfyTargets().catch(() => [])).find((x) => x.cloud?.provider === provider && x.cloud.instance === instance);
  if (t) await removeMachine(t.id).catch(() => null);
  await setAutoStop(box, null);
  for (const m of [money.idle, money.net, money.why, money.stopped]) m.delete(box);
  money.credit.at = 0;
  forgetRentedBoxes();
}

/** Stops or starts a rented box at its cloud. */
export async function setBoxState(box: string, state: "stopped" | "running") {
  const [provider, instance] = box.split(":");
  const s = await getSettings();
  if (provider === "vast") {
    if (!s.keys.vast) throw new Error("Add your vast.ai key under Settings → Accounts first.");
    const res = await fetch(`${VAST}/instances/${encodeURIComponent(instance)}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.keys.vast}` },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; msg?: string; error?: string };
    if (!res.ok || body.success === false) throw new Error(body.msg ?? body.error ?? `vast.ai said ${res.status}.`);
  } else if (provider === "runpod") {
    if (!s.keys.runpod) throw new Error("Add your RunPod key under Settings → Accounts first.");
    await podAction(s.keys.runpod, instance, state === "stopped" ? "stop" : "start");
  } else {
    throw new Error("Crackio can only stop and start vast.ai and RunPod boxes.");
  }
  if (state === "running") money.stopped.delete(box);
  else money.stopped.set(box, Date.now());
  money.idle.delete(box);
  money.credit.at = 0;
  forgetRentedBoxes();
}

/** Looks every minute at the boxes with an idle stop, and stops the ones idle for longer than asked. */
export function watchIdle() {
  if (money.watching) return;
  money.watching = setInterval(() => void tend().catch(() => undefined), 60_000);
  money.watching.unref?.();
}

async function tend() {
  const rules = (await getSettings()).autoStop ?? {};
  const boxes = Object.keys(rules);
  if (!boxes.length) return;
  const targets = await comfyTargets();
  const jobs = setupJobs().filter((j) => j.state === "running" || j.state === "queued");
  // Downloads through the helper (Get models, a pack) run without a set-up job.
  const snap = await setupSnapshot().catch(() => null);
  for (const box of boxes) {
    // Stopped by Crackio and still stopped: nothing to watch. One that answers again was started somewhere else (on
    // the cloud's own site): it's running and billing, so its idle stop counts again. (It used to stay skipped, and a
    // box started that way never stopped by itself.)
    if (money.stopped.has(box)) {
      const [p, i] = box.split(":");
      const again = targets.find((x) => x.cloud?.provider === p && x.cloud.instance === i);
      const up = again ? Boolean((await liveGpus([again.id]))[0]?.online) : false;
      if (!up) continue;
      money.stopped.delete(box);
      money.idle.delete(box);
      console.log(`[crackio] ${box} is running again (started outside Crackio): its idle stop counts again`);
    }
    const rule = ruleOf(rules[box]);
    // Not idle, and why (Settings shows it): the idle clock starts again from the next quiet look.
    const notIdle = (why: string) => {
      money.idle.delete(box);
      money.why.set(box, why);
    };
    const [provider, instance] = box.split(":");
    const t = targets.find((x) => x.cloud?.provider === provider && x.cloud.instance === instance);
    if (!t) {
      notIdle("Crackio isn't connected to it");
      continue;
    }
    const [live] = await liveGpus([t.id]);
    // Not answering: stopped or restarting elsewhere; no idle time counts until it answers again.
    if (!live?.online) {
      notIdle("it isn't answering");
      continue;
    }
    const downloading = (snap?.machines.find((m) => m.id === t.id)?.downloads.count ?? 0) > 0;
    const busy = live.working
      ? "ComfyUI is working there"
      : (live.util ?? 0) >= rule.load
        ? `its GPU is at ${Math.round(live.util ?? 0)}%`
        : downloading
          ? "a download is running there"
          : jobs.some((j) => j.machine === t.id)
            ? "a set-up is running there"
            : null;
    if (busy) {
      notIdle(busy);
      continue;
    }
    // The box itself: no look over SSH, no idle time (Crackio won't stop what it can't see).
    const login = t.cloud?.ssh;
    const now = login ? await boxActivity(login) : null;
    if (!now) {
      notIdle("Crackio can't look at it over SSH");
      continue;
    }
    const before = money.net.get(box);
    money.net.set(box, { at: Date.now(), bytes: now.bytes, cpuUsec: now.cpuUsec });
    if (!before) {
      notIdle("Crackio is taking its first look");
      continue;
    }
    const span = Math.max(1, Date.now() - before.at);
    const moved = ((now.bytes - before.bytes) * 60_000) / span;
    if (moved > NET_BUSY_BYTES) {
      notIdle(`its network moved ${Math.round(moved / 1024 ** 2)} MB in the last minute`);
      continue;
    }
    // CPU cores its own processes kept busy since the last look (no counter there: GPU, ComfyUI and network decide).
    const cores = now.cpuUsec != null && before.cpuUsec != null ? (now.cpuUsec - before.cpuUsec) / 1000 / span : null;
    if (cores !== null && cores >= CPU_BUSY_CORES) {
      notIdle(`its processes are using ${cores.toFixed(1)} CPU cores`);
      continue;
    }
    // Idle from the first quiet look (never from before Crackio started watching: a restart doesn't stop a box at once).
    const idle = money.idle.get(box) ?? { since: Math.max(Date.now(), money.started) };
    money.idle.set(box, idle);
    money.why.delete(box);
    if (Date.now() - idle.since >= rule.minutes * 60_000) {
      const end = { box, at: Date.now(), label: t.label, minutes: rule.minutes };
      if (rule.then === "delete") {
        try {
          await deleteBox(box);
          money.ended.set(box, { ...end, deleted: true });
          console.log(`[crackio] deleted ${box} after ${rule.minutes} idle minutes (GPU under ${rule.load}%)`);
          continue;
        } catch (err) {
          // Not deleted: stopped at least, so it doesn't keep billing for its GPU.
          console.log(`[crackio] couldn't delete ${box}: ${(err as Error).message}; stopping it instead`);
        }
      }
      try {
        await setBoxState(box, "stopped");
        money.ended.set(box, { ...end, deleted: false });
        console.log(`[crackio] stopped ${box} after ${rule.minutes} idle minutes (GPU under ${rule.load}%)`);
      } catch (err) {
        console.log(`[crackio] couldn't stop ${box}: ${(err as Error).message}`);
      }
    }
  }
}

// The dev server reloads this file without stopping the watch an older copy started (it lives on globalThis): restart
// it, so the code that looks at your boxes is always this one (each route that loads this file runs this again).
if (money.watching) {
  clearInterval(money.watching);
  money.watching = null;
  watchIdle();
}
