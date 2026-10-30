import "server-only";
import type { CloudGpu } from "@/lib/local/types";
import { CloudError, startConnect, type ConnectJob, type ConnectRequest } from "./cloud-gpu";
import { addedId, samePlace } from "./comfy-targets";
import { machineAnswers, removeMachine } from "./local-models";
import { getSettings } from "./settings";
import { publicKey, sshAnswers, type SshLogin } from "./ssh";

/**
 * Your GPU cloud accounts (keys saved under Connections → GPUs): the boxes running there, how to reach each one (its
 * ComfyUI's address and token, its SSH login), putting Crackio's SSH key on the account so every new box takes it, and
 * boxes joining your machines by themselves (`tendRentedBoxes`).
 */

export type RentedBox = {
  provider: "vast" | "runpod";
  id: string;
  label: string;
  gpu: string;
  state: string;
  /** Its cloud says it runs: its SSH may still be opening, its ComfyUI still starting. */
  ready: boolean;
  /** Rented and on its way up: being placed, or pulling its image. */
  starting?: boolean;
  /** Its cloud's own line about it ("b86400ee9ef6: Pull complete"). */
  detail?: string;
  /** Dollars an hour. */
  price?: number;
  /** Already one of your machines on the Local page. */
  connected?: boolean;
  /** The connect job under way for it (cloud-gpu `connectJob`). */
  connecting?: string;
  /** Why it didn't connect last time. */
  problem?: string;
};

const VAST = "https://console.vast.ai/api/v0";
/** Listing boxes moved to v1, a page at a time (v0's answers 410 "deprecated_endpoint" since Oct 2026). */
const VAST_V1 = "https://console.vast.ai/api/v1";
const RUNPOD = "https://api.runpod.io/v2";

async function api<T>(url: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new CloudError("The key was refused: check it under Connections → GPUs.");
  if (!res.ok) throw new CloudError(`${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ vast.ai */

type VastInstance = {
  id: number;
  /** What the box is doing: null while it's placed, "loading" while its image pulls, then "running" (or "exited"...). */
  actual_status?: string | null;
  /** What it was asked to do: "running" from the moment it's rented, so it says nothing about being up. */
  intended_status?: string | null;
  cur_state?: string | null;
  /** vast.ai's line about it: "b86400ee9ef6: Pull complete", "success, running vastai/comfy…", an error. */
  status_msg?: string | null;
  label?: string | null;
  gpu_name?: string;
  num_gpus?: number;
  dph_total?: number;
  public_ipaddr?: string;
  ports?: Record<string, { HostIp?: string; HostPort: string }[]> | null;
  ssh_host?: string;
  ssh_port?: number;
  image_runtype?: string;
  jupyter_token?: string;
};

/** Every box on the account, newest first: v1 gives a page at a time, the next one by its `next_token`. */
async function vastInstances(key: string): Promise<VastInstance[]> {
  const out: VastInstance[] = [];
  let after: string | null | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "25", order_by: JSON.stringify([{ col: "id", dir: "desc" }]), ...(after ? { after_token: after } : {}) });
    const res = await api<{ instances?: VastInstance[]; next_token?: string | null }>(`${VAST_V1}/instances/?${q}`, key);
    out.push(...(res.instances ?? []));
    after = res.next_token;
    if (!after) break;
  }
  return out;
}

/** One box by id (v0's by-id route still answers, and has a box the list can lag on). */
async function vastInstance(key: string, id: string): Promise<VastInstance | null> {
  const one = await api<{ instances?: VastInstance | null }>(`${VAST}/instances/${encodeURIComponent(id)}/?owner=me`, key).catch(() => null);
  return one?.instances ?? (await vastInstances(key)).find((i) => String(i.id) === id) ?? null;
}

/** vast.ai's line about a box, short: "b86400ee9ef6: Pull complete". */
const vastNote = (i: VastInstance) => (i.status_msg ?? "").split(/\s+/).join(" ").trim().slice(0, 120) || undefined;

/**
 * Where a box is on its way up. `up`: vast.ai says it runs (its SSH may still be opening). `starting`: rented and still
 * placed or pulling its image. `broken`: it can't come up (an error while created, or exited when asked to run), as
 * scripts/gpu/vast-monitor.py tells it.
 */
function vastPhase(i: VastInstance): { state: string; up: boolean; starting: boolean; broken: boolean } {
  const status = i.actual_status ?? null;
  const intended = i.intended_status ?? i.cur_state ?? null;
  const error = /error/i.test(i.status_msg ?? "");
  const broken = status !== "running" && ((error && (intended === "stopped" || status === "created" || status === "exited")) || (status === "exited" && intended === "running"));
  return { state: status ?? (intended === "running" ? "starting" : "unknown"), up: status === "running", starting: !broken && status !== "running" && intended === "running", broken };
}

const hostPort = (i: VastInstance, port: number) => i.ports?.[`${port}/tcp`]?.[0]?.HostPort;

/**
 * A vast box's SSH logins, as `vastai ssh-url` gives them: straight to the box when it maps port 22 (not every host lets
 * it through: a 3060 Ti in Texas timed out there), and vast's proxy, one port up on images that run Jupyter.
 */
function vastLogins(i: VastInstance): SshLogin[] {
  const ip = i.public_ipaddr?.trim();
  const direct = ip && hostPort(i, 22);
  return [
    ...(direct ? [{ host: ip, port: Number(direct), user: "root" }] : []),
    ...(i.ssh_host && i.ssh_port ? [{ host: i.ssh_host, port: Number(i.ssh_port) + (/jupyter/.test(i.image_runtype ?? "") ? 1 : 0), user: "root" }] : []),
  ];
}

/** How to reach a vast box: the Instance Portal's ComfyUI door, and SSH (straight to the box, else through vast's proxy). */
function vastConnection(i: VastInstance, ssh = vastLogins(i)[0]): ConnectRequest {
  const ip = i.public_ipaddr?.trim();
  const web = ip && hostPort(i, 8188);
  return { provider: "vast", instance: String(i.id), ...(web ? { url: `http://${ip}:${web}` } : {}), ...(i.jupyter_token ? { token: i.jupyter_token } : {}), ...(ssh ? { ssh } : {}) };
}

/** The first of these logins (in order) whose SSH answers now, all asked at once. */
async function answering(logins: SshLogin[]): Promise<SshLogin | null> {
  const ok = await Promise.all(logins.map((l) => sshAnswers(l)));
  return logins.find((_, n) => ok[n]) ?? null;
}

/** How long to wait for a rented box to come up: vast.ai's placement and image pull usually take 2–6 minutes. */
const UP_WITHIN_MS = 20 * 60_000;
const UP_EVERY_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Until vast.ai says the box runs and one of its SSH logins answers (asked every 10 s, up to 20 minutes): then how to
 * reach it, by the login that answered. Meanwhile `say` gets vast.ai's own words ("loading · b86400ee9ef6: Pull
 * complete").
 */
async function vastUntilUp(key: string, id: string, say: (detail: string) => void): Promise<ConnectRequest> {
  const until = Date.now() + UP_WITHIN_MS;
  let broken = 0;
  let attached: boolean | null = null;
  for (;;) {
    const i = await vastInstance(key, id).catch(() => undefined);
    if (i === null) throw new CloudError("That box isn't on your vast.ai account any more.");
    if (i) {
      const phase = vastPhase(i);
      // Three looks in a row, as the monitor does: a box can pass through an error on its way up.
      broken = phase.broken ? broken + 1 : 0;
      if (broken >= 3) throw new CloudError(`vast.ai can't start it: ${vastNote(i) ?? phase.state}. Rent another, or look at its log on vast.ai.`);
      if (phase.up) {
        // Crackio's key on the running box, so it logs in without the key on the account.
        attached ??= await attachVastKey(id).catch(() => false);
        const login = await answering(vastLogins(i));
        if (login) return { ...vastConnection(i, login), waitForKey: attached };
        say("running; waiting for its SSH to open");
      } else if (!phase.starting && !phase.broken) {
        throw new CloudError(`It's ${phase.state} on vast.ai: start it there, and it connects.`);
      } else {
        say([phase.state, vastNote(i)].filter(Boolean).join(" · "));
      }
    }
    if (Date.now() > until) throw new CloudError("It didn't start on vast.ai within 20 minutes. Look at its log on vast.ai, or rent another.");
    await sleep(UP_EVERY_MS);
  }
}

/* ------------------------------------------------------------------ RunPod */

/** A pod as RunPod's v2 API lists it (`GET /v2/pods`; by id it adds `ssh.direct`). */
type RunpodPod = {
  id: string;
  name?: string;
  image?: string;
  status?: string;
  desiredStatus?: string;
  costPerHr?: number;
  adjustedCostPerHr?: number;
  gpuCount?: number;
  gpu?: { displayName?: string; id?: string; count?: number } | null;
  machine?: { gpuDisplayName?: string } | null;
  /** "8188/http", "22/tcp". */
  ports?: string[] | null;
  ssh?: { direct?: { host?: string; ip?: string; port?: number; username?: string } | null } | null;
  runtime?: { ports?: { private?: number; public?: number; type?: string; ip?: string }[] | null } | null;
};

const runpodPods = async (key: string) => {
  const out = await api<{ pods?: RunpodPod[] } | RunpodPod[]>(`${RUNPOD}/pods`, key);
  return Array.isArray(out) ? out : (out.pods ?? []);
};
const runpodPod = (key: string, id: string) => api<RunpodPod>(`${RUNPOD}/pods/${encodeURIComponent(id)}`, key);

const podState = (p: RunpodPod) => (p.status ?? p.desiredStatus ?? "unknown").toLowerCase();
const podGpu = (p: RunpodPod) => gpuName(p.gpu?.displayName ?? p.machine?.gpuDisplayName ?? p.gpu?.id, p.gpu?.count ?? p.gpuCount);

/**
 * How to reach a pod: its HTTP proxy for ComfyUI's port (its official template serves ComfyUI on 8188, no token), and
 * direct SSH (RunPod's ssh.runpod.io proxy is an interactive shell only, which can't run Crackio's setup).
 */
function runpodConnection(p: RunpodPod): ConnectRequest {
  const http = (p.ports ?? []).map((x) => /^(\d+)\/http$/.exec(x)?.[1]).filter(Boolean).map(Number);
  const web = http.includes(8188) ? 8188 : http[0];
  const direct = p.ssh?.direct;
  const tcp22 = p.runtime?.ports?.find((x) => x.private === 22 && x.type === "tcp" && x.ip && x.public);
  const host = direct?.host ?? direct?.ip ?? tcp22?.ip;
  const port = direct?.port ?? tcp22?.public;
  return {
    provider: "runpod",
    instance: p.id,
    ...(web ? { url: `https://${p.id}-${web}.proxy.runpod.net` } : {}),
    ...(host && port ? { ssh: { host, port, user: direct?.username ?? "root" } } : {}),
  };
}

/** Until RunPod says the pod runs and its SSH answers (when it shows one): then how to reach it. */
async function runpodUntilUp(key: string, id: string, say: (detail: string) => void): Promise<ConnectRequest> {
  const until = Date.now() + UP_WITHIN_MS;
  for (;;) {
    const pod = await runpodPod(key, id).catch(() => undefined);
    if (pod && !pod.id) throw new CloudError("That pod isn't on your RunPod account any more.");
    if (pod) {
      const state = podState(pod);
      const reach = runpodConnection(pod);
      if (state === "running") {
        if (!reach.ssh || (await sshAnswers(reach.ssh))) return reach;
        say("running; waiting for its SSH to open");
      } else if (/exited|terminated|stopped/.test(state)) {
        throw new CloudError(`It's ${state} on RunPod: start it there, and it connects.`);
      } else {
        say(state);
      }
    }
    if (Date.now() > until) throw new CloudError("It didn't start on RunPod within 20 minutes. Look at its log there, or rent another.");
    await sleep(UP_EVERY_MS);
  }
}

/* ------------------------------------------------------------------ both */

const gpuName = (name: string | undefined, count = 1) => `${count > 1 ? `${count}× ` : ""}${(name ?? "GPU").replace(/^NVIDIA\s+(GeForce\s+)?/i, "")}`;

type Listing = {
  accounts: { vast: boolean; runpod: boolean };
  boxes: RentedBox[];
  errors: Partial<Record<"vast" | "runpod", string>>;
  keyAdded: Partial<Record<"vast" | "runpod", boolean>>;
};

/**
 * Whether a box is one of your machines already: by its id at the cloud; a machine connected from a pasted command
 * before Crackio kept the box's id, by its SSH login or ComfyUI address.
 */
function mineAlready(machines: { url: string; cloud?: CloudGpu }[], provider: "vast" | "runpod", id: string, logins: SshLogin[], urls: string[]) {
  return machines.some((m) =>
    m.cloud?.instance
      ? m.cloud.provider === provider && m.cloud.instance === id
      : logins.some((l) => m.cloud?.ssh?.host === l.host && m.cloud.ssh.port === l.port) || urls.some((u) => Boolean(m.url) && samePlace(m.url, u)),
  );
}

/** Every box on the accounts you've connected, newest first, with whether it's already one of your machines. */
export async function rentedBoxes(): Promise<Listing> {
  settleJobs();
  const s = await getSettings();
  const machines = s.comfyMachines ?? [];
  const boxes: RentedBox[] = [];
  const errors: Partial<Record<"vast" | "runpod", string>> = {};
  const keyAdded: Partial<Record<"vast" | "runpod", boolean>> = {};
  const ours = await publicKey().then((k) => keyBody(k.key)).catch(() => null);
  await Promise.all([
    s.keys.vast &&
      (async () => {
        try {
          const [list, keys] = await Promise.all([vastInstances(s.keys.vast!), vastKeys(s.keys.vast!).catch(() => [])]);
          keyAdded.vast = Boolean(ours && keys.some((k) => keyBody(k) === ours));
          for (const i of list) {
            const phase = vastPhase(i);
            const reach = vastConnection(i);
            boxes.push({
              provider: "vast",
              id: String(i.id),
              label: i.label || `#${i.id}`,
              gpu: gpuName(i.gpu_name, i.num_gpus),
              state: phase.state,
              ready: phase.up,
              starting: phase.starting,
              detail: phase.up ? undefined : vastNote(i),
              price: i.dph_total,
              connected: mineAlready(machines, "vast", String(i.id), vastLogins(i), reach.url ? [reach.url] : []),
            });
          }
        } catch (err) {
          errors.vast = (err as Error).message;
        }
      })(),
    s.keys.runpod &&
      (async () => {
        try {
          const [pods, keys] = await Promise.all([runpodPods(s.keys.runpod!), runpodKeys(s.keys.runpod!).catch((): string[] => [])]);
          keyAdded.runpod = Boolean(ours && keys.some((k) => keyBody(k) === ours));
          for (const p of pods) {
            const state = podState(p);
            const reach = runpodConnection(p);
            boxes.push({
              provider: "runpod",
              id: p.id,
              label: p.name || p.id,
              gpu: podGpu(p),
              state,
              ready: state === "running",
              starting: state !== "running" && (p.desiredStatus ?? "").toLowerCase() === "running",
              price: p.costPerHr ?? p.adjustedCostPerHr,
              connected: mineAlready(machines, "runpod", p.id, reach.ssh ? [reach.ssh] : [], reach.url ? [reach.url] : []),
            });
          }
        } catch (err) {
          errors.runpod = (err as Error).message;
        }
      })(),
  ]);
  return { accounts: { vast: Boolean(s.keys.vast), runpod: Boolean(s.keys.runpod) }, boxes: withJobs(boxes), errors, keyAdded };
}

/**
 * What connecting one of those boxes starts from: its name, and waiting until it's up (the connect job's first step),
 * which gives the way in that answers then.
 */
export async function boxConnection(provider: "vast" | "runpod", id: string): Promise<ConnectRequest> {
  const s = await getSettings();
  if (provider === "vast") {
    const key = s.keys.vast;
    if (!key) throw new CloudError("Add your vast.ai key under Connections → GPUs first.");
    const box = await vastInstance(key, id);
    if (!box) throw new CloudError("That box isn't on your vast.ai account any more.");
    return { provider: "vast", instance: id, label: `${gpuName(box.gpu_name, box.num_gpus)} · vast.ai`, untilUp: (say) => vastUntilUp(key, id, say) };
  }
  const key = s.keys.runpod;
  if (!key) throw new CloudError("Add your RunPod key under Connections → GPUs first.");
  const pod = await runpodPod(key, id).catch(() => null);
  if (!pod?.id) throw new CloudError("That pod isn't on your RunPod account any more.");
  return { provider: "runpod", instance: id, label: `${podGpu(pod)} · RunPod`, untilUp: (say) => runpodUntilUp(key, id, say) };
}

/* ------------------------------------------------------------------ Crackio's SSH key on the account */

/** A public key without its comment, for comparing. */
const keyBody = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

async function vastKeys(key: string): Promise<string[]> {
  const out = await api<unknown>(`${VAST}/ssh/`, key);
  const list = Array.isArray(out) ? out : ((out as { keys?: unknown[] }).keys ?? []);
  return list.map((k) => (typeof k === "string" ? k : ((k as { public_key?: string; ssh_key?: string }).public_key ?? (k as { ssh_key?: string }).ssh_key ?? ""))).filter(Boolean);
}

/** The account's SSH keys (v2 `/account/ssh-keys`, which a PUT replaces whole). */
async function runpodKeys(key: string): Promise<string[]> {
  const out = await api<{ keys?: unknown[] } | unknown[]>(`${RUNPOD}/account/ssh-keys`, key);
  const list = Array.isArray(out) ? out : (out.keys ?? []);
  return list.map((k) => (typeof k === "string" ? k : ((k as { key?: string; publicKey?: string }).key ?? (k as { publicKey?: string }).publicKey ?? ""))).filter(Boolean);
}

/**
 * Puts Crackio's SSH key on the account, so boxes rented from now on take it. On vast.ai it's also attached to the boxes
 * running now; a RunPod pod reads the account's keys when it starts, so one running already needs a restart.
 */
export async function addKeyToAccount(provider: "vast" | "runpod") {
  const s = await getSettings();
  const { key } = await publicKey();
  if (provider === "vast") {
    if (!s.keys.vast) throw new CloudError("Add your vast.ai key under Connections → GPUs first.");
    const have = await vastKeys(s.keys.vast).catch(() => []);
    if (!have.some((k) => keyBody(k) === keyBody(key))) await api(`${VAST}/ssh/`, s.keys.vast, { method: "POST", body: JSON.stringify({ ssh_key: key }) });
    const running = (await vastInstances(s.keys.vast)).filter((i) => (i.actual_status ?? "") === "running");
    await Promise.all(running.map((i) => api(`${VAST}/instances/${i.id}/ssh/`, s.keys.vast!, { method: "POST", body: JSON.stringify({ ssh_key: key }) }).catch(() => null)));
    return { added: true, attached: running.length };
  }
  if (!s.keys.runpod) throw new CloudError("Add your RunPod key under Connections → GPUs first.");
  const current = await runpodKeys(s.keys.runpod);
  if (current.some((k) => keyBody(k) === keyBody(key))) return { added: true, attached: 0 };
  await api(`${RUNPOD}/account/ssh-keys`, s.keys.runpod, { method: "PUT", body: JSON.stringify({ keys: [...current, key] }) });
  return { added: true, attached: 0, note: "Pods running now take it once they restart." };
}

/** Crackio's SSH key on one running vast.ai box: it logs in without the key on the account. */
async function attachVastKey(id: string) {
  const s = await getSettings();
  if (!s.keys.vast) return false;
  const { key } = await publicKey();
  await api(`${VAST}/instances/${encodeURIComponent(id)}/ssh/`, s.keys.vast, { method: "POST", body: JSON.stringify({ ssh_key: key }) });
  return true;
}

/* ------------------------------------------------------------------ boxes joining and leaving by themselves */

/** How often Crackio looks at your accounts while it's in use. */
const LOOK_MS = 30_000;
/**
 * A box that failed to connect by itself is tried once more after this long, then left to its Connect button (one
 * without ComfyUI would wait 20 minutes for it every time).
 */
const RETRY_MS = 10 * 60_000;
const TRIES = 2;

type Watch = {
  /** Connect jobs under way, by "vast:27395123". */
  connecting: Map<string, ConnectJob>;
  /** Boxes that failed to connect: when, how many times, why. */
  failed: Map<string, { at: number; count: number; error?: string }>;
  /** Looks in a row each machine from an account didn't answer: gone from the account, or running there. */
  gone: Map<string, number>;
  silent: Map<string, number>;
  /** Whether each box was up at the last look. */
  seen: Map<string, boolean>;
  last: number;
  busy: boolean;
};
const g = globalThis as unknown as { __crackioCloudWatch?: Watch };
const w = (g.__crackioCloudWatch ??= { connecting: new Map(), failed: new Map(), gone: new Map(), silent: new Map(), seen: new Map(), last: 0, busy: false });
// The dev server keeps the watch across reloads: one from before `seen`.
w.seen ??= new Map();

const fail = (key: string, error?: string) => w.failed.set(key, { at: Date.now(), count: (w.failed.get(key)?.count ?? 0) + 1, error });

/** Connect jobs that ended: a box that failed is noted, one that connected forgets its failures. */
function settleJobs() {
  for (const [key, job] of w.connecting) {
    if (job.state === "running") continue;
    w.connecting.delete(key);
    if (job.state === "error") fail(key, job.error);
    else w.failed.delete(key);
  }
}

/** The boxes with the connect job under way for each, or why the last one failed. */
function withJobs(boxes: RentedBox[]): RentedBox[] {
  return boxes.map((box) => {
    const b: RentedBox = { ...box, connecting: undefined, problem: undefined };
    const key = `${b.provider}:${b.id}`;
    const job = w.connecting.get(key);
    if (job?.state === "running") return { ...b, connecting: job.id };
    const failed = w.failed.get(key);
    return failed?.error && !b.connected ? { ...b, problem: failed.error } : b;
  });
}

/**
 * Connects a box on your account, picked on the Local page (`byHand`) or by itself: one connect job per box at a time,
 * which first waits for the box to be up. On vast.ai Crackio's SSH key then goes on the box, so it needn't be on the
 * account (a RunPod pod reads the account's keys when it starts).
 */
export async function connectBox(provider: "vast" | "runpod", id: string, byHand = false): Promise<ConnectJob> {
  const key = `${provider}:${id}`;
  const under = w.connecting.get(key);
  if (under?.state === "running") return under;
  if (byHand) w.failed.delete(key);
  const job = startConnect(await boxConnection(provider, id));
  w.connecting.set(key, job);
  return job;
}

function freeToTry(key: string) {
  const failed = w.failed.get(key);
  return !w.connecting.has(key) && (!failed || (failed.count < TRIES && Date.now() - failed.at > RETRY_MS));
}
const tryBox = (provider: "vast" | "runpod", id: string) => connectBox(provider, id).catch((err: Error) => void fail(`${provider}:${id}`, err.message));

/**
 * After a look at your accounts: every box running or on its way up that isn't one of your machines yet starts
 * connecting (its job waits until it's up).
 */
async function connectNew(list: Listing) {
  settleJobs();
  for (const b of list.boxes) {
    const key = `${b.provider}:${b.id}`;
    // One that just came up starts afresh: what failed while it was starting doesn't count against it.
    if (b.ready && !w.seen.get(key)) w.failed.delete(key);
    w.seen.set(key, b.ready);
    // A running pod can't be given Crackio's key: only with it on the account.
    if ((b.ready || b.starting) && !b.connected && freeToTry(key) && (b.provider === "vast" || list.keyAdded.runpod)) await tryBox(b.provider, b.id);
  }
}

/**
 * Your machines from those accounts: one gone from its account leaves your machines once it stops answering (two looks
 * in a row); one running there but not answering connects again (three looks in a row: a restart moves a box to new ports).
 */
async function tidyMachines(list: Listing) {
  const machines = (await getSettings()).comfyMachines ?? [];
  await Promise.all(
    machines.map(async (m) => {
      const c = m.cloud;
      if (!c?.instance || (c.provider !== "vast" && c.provider !== "runpod") || !list.accounts[c.provider] || list.errors[c.provider]) return;
      const key = `${c.provider}:${c.instance}`;
      const box = list.boxes.find((b) => b.provider === c.provider && b.id === c.instance);
      // Stopped or starting: its card says it isn't answering until it's back.
      if ((box && !box.ready) || w.connecting.has(key) || (await machineAnswers(addedId(m)))) {
        w.gone.delete(key);
        w.silent.delete(key);
        return;
      }
      const tally = box ? w.silent : w.gone;
      const n = (tally.get(key) ?? 0) + 1;
      tally.set(key, n);
      if (!box && n >= 2) {
        w.gone.delete(key);
        await removeMachine(addedId(m)).catch(() => null);
      } else if (box && n >= 3 && freeToTry(key)) {
        w.silent.delete(key);
        await tryBox(c.provider, c.instance);
      }
    }),
  );
}

/**
 * Boxes joining and leaving your machines by themselves (settings `cloudAutoConnect`, on unless turned off), after a look
 * at your accounts. One look at a time: false when one is under way.
 */
async function tend(list: Listing, background: boolean) {
  if (w.busy || (await getSettings()).cloudAutoConnect === false) return false;
  w.busy = true;
  w.last = Date.now();
  try {
    await connectNew(list);
  } catch {
    /* tried again at the next look */
  }
  // The machines' checks wait on each ComfyUI: the Local page's look doesn't wait for them.
  const tidy = tidyMachines(list)
    .catch(() => undefined)
    .finally(() => (w.busy = false));
  if (!background) await tidy;
  return true;
}

/** The Local page's look at your accounts: new boxes start connecting first, so the list shows them connecting. */
export async function lookAtRentedBoxes(): Promise<Listing & { autoConnect: boolean }> {
  const list = await rentedBoxes();
  await tend(list, true);
  return { ...list, boxes: withJobs(list.boxes), autoConnect: (await getSettings()).cloudAutoConnect !== false };
}

/**
 * Looks at your accounts in the background at most every 30 s while Crackio is in use (the Local page and the
 * generators' time lines ask for it), so a GPU you rent shows up on its own and one you give back leaves.
 */
export function watchRentedBoxes() {
  if (w.busy || Date.now() - w.last < LOOK_MS) return;
  w.last = Date.now();
  void (async () => {
    const s = await getSettings();
    if (s.cloudAutoConnect === false || (!s.keys.vast && !s.keys.runpod)) return;
    await tend(await rentedBoxes(), false);
  })().catch(() => undefined);
}
