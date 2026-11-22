import "server-only";

/**
 * Your RunPod pods, through RunPod's REST API v2 (api.runpod.io/v2; v1 at rest.runpod.io retires on 2026-11-15): the pods
 * on the account, one pod's way in (its SSH and HTTP ports), starting, stopping and deleting one, the account's SSH keys,
 * its log, and running Crackio's scripts on a pod through its JupyterLab when it has no SSH straight in (no public IP).
 */

const API = "https://api.runpod.io/v2";

export class RunpodError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type SshEndpoint = { host?: string; port?: number; username?: string; command?: string };

/** A pod as v2 gives it. Its list leaves out `ssh.direct` and `runtime`: a pod by id has both. */
export type Pod = {
  id: string;
  name?: string;
  image?: string;
  /** PROVISIONING (being placed), STARTING (its container starting), RUNNING, EXITED (stopped), ERROR, TERMINATED. */
  status?: string;
  /** What it can do now: "start", "stop", "restart", "terminate" (a pod with a network volume can't stop). */
  actions?: string[];
  /** Dollars an hour while it runs (also given while it's stopped, when only its volume bills). */
  cost?: number;
  /** Absent on a CPU pod. */
  gpu?: { id?: string; count?: number; memory?: number; vcpuCount?: number } | null;
  /** "8188/http", "22/tcp". */
  ports?: string[] | null;
  env?: Record<string, string> | null;
  ssh?: { proxy?: SshEndpoint | null; direct?: SshEndpoint | null } | null;
  runtime?: {
    uptime?: number;
    gpus?: { util?: number; memoryUtil?: number }[];
    ports?: { private?: number; public?: number | null; type?: string; ip?: string | null }[];
  } | null;
  mounts?: { persistent?: { size?: number; path?: string } | null; network?: unknown } | null;
  template?: string | null;
  locked?: boolean;
  createdAt?: string;
};

/** The words for RunPod's refusals; v2's errors carry `detail` (RFC 9457). */
function refused(status: number, detail: string) {
  if (status === 401) return "RunPod refused the key: check it under Settings → Accounts.";
  if (status === 403) return "This RunPod key can't do that: make one with All permissions (RunPod → Settings → API Keys) and save it under Settings → Accounts.";
  if (status === 404) return "That pod isn't on your RunPod account any more.";
  if (status === 429) return "RunPod asks Crackio to slow down: it tries again in a minute.";
  return `RunPod said ${status}${detail ? `: ${detail}` : ""}`;
}

async function call<T>(key: string, route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const problem = JSON.parse(text) as { detail?: string; title?: string; errors?: string[] };
      detail = [problem.detail ?? problem.title, ...(problem.errors ?? [])].filter(Boolean).join("; ").slice(0, 240);
    } catch {
      /* not a problem object */
    }
    throw new RunpodError(refused(res.status, detail), res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Every pod on the account (v2 gives up to 1,000 a page). */
export async function listPods(key: string): Promise<Pod[]> {
  const out: Pod[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res: { pods?: Pod[]; pagination?: { nextCursor?: string | null; hasNextPage?: boolean } } = await call(key, `/pods${q}`);
    out.push(...(res.pods ?? []));
    cursor = res.pagination?.hasNextPage ? (res.pagination.nextCursor ?? null) : null;
    if (!cursor) break;
  }
  return out;
}

/** One pod, with its live SSH address and ports; null once it's gone from the account. */
export async function getPod(key: string, id: string): Promise<Pod | null> {
  try {
    return await call<Pod>(key, `/pods/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof RunpodError && err.status === 404) return null;
    throw err;
  }
}

/** Starts or stops a pod. RunPod answers 409 when the pod can't do that now. */
export async function podAction(key: string, id: string, action: "start" | "stop" | "restart") {
  try {
    await call(key, `/pods/${encodeURIComponent(id)}/action`, { method: "POST", body: { action } });
  } catch (err) {
    if (err instanceof RunpodError && err.status === 409) {
      const pod = await getPod(key, id).catch(() => null);
      if (action === "stop" && pod && !(pod.actions ?? []).includes("stop")) {
        throw new RunpodError(
          pod.locked
            ? "RunPod can't stop this pod: it's locked. Unlock it on RunPod, or delete it."
            : "RunPod can't stop this pod (a pod with a network volume can only be deleted): pick Delete it, or stop it on RunPod.",
          409,
        );
      }
      if (action === "start") throw new RunpodError("RunPod can't start it right now: its GPU may be rented by someone else. Try again later, or rent another pod.", 409);
    }
    throw err;
  }
}

/** Deletes a pod for good, with its volume disk (a network volume stays). Gone already counts as done. */
export async function terminatePod(key: string, id: string) {
  try {
    await call(key, `/pods/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof RunpodError && err.status === 404)) throw err;
  }
}

/** The account's SSH public keys, which RunPod puts on every pod (one running already gets a key added within moments). */
export async function accountKeys(key: string): Promise<string[]> {
  const out = await call<{ keys?: string[] }>(key, "/account/ssh-keys");
  return (out?.keys ?? []).filter((k) => typeof k === "string" && k.trim());
}

/** A public key without its comment, for comparing. */
export const keyBody = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

/** Adds a key to the account's keys (a PUT replaces them all, so the others are sent back with it). True when it added it. */
export async function addAccountKey(key: string, publicKey: string): Promise<boolean> {
  const have = await accountKeys(key);
  if (have.some((k) => keyBody(k) === keyBody(publicKey))) return false;
  await call(key, "/account/ssh-keys", { method: "PUT", body: { keys: [...have, publicKey.trim()] } });
  return true;
}

/* ------------------------------------------------------------------ a pod's ways in */

export const podGpuName = (p: Pod) => {
  const count = p.gpu?.count ?? 1;
  return `${count > 1 ? `${count}× ` : ""}${(p.gpu?.id ?? "GPU").replace(/^NVIDIA\s+(GeForce\s+)?/i, "")}`;
};

/** The pod's HTTP ports, reached through RunPod's proxy at https://{pod}-{port}.proxy.runpod.net. */
export const httpPorts = (p: Pod) => (p.ports ?? []).map((x) => /^(\d+)\/http$/.exec(x)?.[1]).filter(Boolean).map(Number);

/** Its SSH straight in (the one that runs scripts and tunnels; RunPod's ssh.runpod.io proxy is an interactive shell only). */
export function directSsh(p: Pod): { host: string; port: number; user: string } | null {
  const d = p.ssh?.direct;
  const tcp = p.runtime?.ports?.find((x) => x.private === 22 && x.type === "tcp" && x.ip && x.public);
  const host = d?.host ?? tcp?.ip ?? undefined;
  const port = d?.port ?? tcp?.public ?? undefined;
  return host && port ? { host, port, user: d?.username || "root" } : null;
}

/** Where a pod is on its way up, in Crackio's words. */
export function podPhase(p: Pod): { state: string; up: boolean; starting: boolean; broken: boolean; detail?: string } {
  switch ((p.status ?? "").toUpperCase()) {
    case "RUNNING":
      return { state: "running", up: true, starting: false, broken: false };
    case "PROVISIONING":
      return { state: "starting", up: false, starting: true, broken: false, detail: "RunPod is placing it on a machine" };
    case "STARTING":
      return { state: "starting", up: false, starting: true, broken: false, detail: "its container is starting" };
    case "EXITED":
      return { state: "stopped", up: false, starting: false, broken: false };
    case "ERROR":
      return { state: "error", up: false, starting: false, broken: true, detail: "RunPod says its container is in an error state" };
    case "TERMINATED":
      return { state: "deleted", up: false, starting: false, broken: true };
    default:
      return { state: (p.status ?? "unknown").toLowerCase(), up: false, starting: false, broken: false };
  }
}

/* ------------------------------------------------------------------ scripts on a pod, through its JupyterLab */

export type Jupyter = { url: string; token: string };

/**
 * JupyterLab on the pod, when its template runs one (RunPod's ComfyUI and PyTorch templates do, on 8888): its address
 * through RunPod's proxy and its token (the pod's JUPYTER_PASSWORD; the ComfyUI template runs it without one when
 * that's unset). Null when the pod shows none, or its token is one of your RunPod secrets (Crackio can't read those).
 */
export function podJupyter(p: Pod): Jupyter | null {
  if (!httpPorts(p).includes(8888)) return null;
  const token = p.env?.JUPYTER_PASSWORD ?? p.env?.JUPYTER_TOKEN ?? "";
  if (/\{\{/.test(token)) return null;
  return { url: `https://${p.id}-8888.proxy.runpod.net`, token };
}

const authOf = (j: Jupyter): Record<string, string> => (j.token ? { Authorization: `token ${j.token}` } : {});

/** Whether the pod's JupyterLab answers through RunPod's proxy, with that token. */
export async function jupyterAnswers(j: Jupyter): Promise<boolean> {
  const res = await fetch(`${j.url}/api/status`, { headers: authOf(j), cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  await res?.arrayBuffer().catch(() => undefined);
  return Boolean(res?.ok);
}

/**
 * Where Crackio puts its scripts and their output, under JupyterLab's own folder (/workspace on RunPod's ComfyUI
 * template, / on its PyTorch one). Not a dot folder: JupyterLab refuses hidden paths.
 */
const RUN_DIR = "crackio-run";

/** Opens a JupyterLab terminal and types one line into it; the terminal stays (and runs) after the socket closes. */
async function typeInTerminal(j: Jupyter, line: string): Promise<string> {
  const made = await fetch(`${j.url}/api/terminals`, { method: "POST", headers: { ...authOf(j), "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) });
  if (!made.ok) throw new RunpodError(made.status === 403 || made.status === 401 ? "JupyterLab on the pod refused its token." : `JupyterLab on the pod said ${made.status}.`, made.status);
  const { name } = (await made.json()) as { name?: string };
  if (!name) throw new RunpodError("JupyterLab on the pod didn't open a terminal.");
  const ws = new WebSocket(`${j.url.replace(/^http/, "ws")}/terminals/websocket/${encodeURIComponent(name)}${j.token ? `?token=${encodeURIComponent(j.token)}` : ""}`);
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => done(new RunpodError("JupyterLab's terminal on the pod didn't open.")), 30_000);
    const done = (err?: Error) => {
      clearTimeout(timer);
      if (err) {
        try {
          ws.close();
        } catch {
          /* closed already */
        }
        reject(err);
      } else resolve();
    };
    const send = () => {
      if (sent) return;
      sent = true;
      ws.send(JSON.stringify(["stdin", `${line}\r`]));
      // The line is in once the terminal has it; closing the socket leaves the terminal running.
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* closed already */
        }
        done();
      }, 700);
    };
    ws.addEventListener("open", () => setTimeout(send, 400));
    ws.addEventListener("message", (e) => {
      try {
        if ((JSON.parse(String(e.data)) as [string])[0] === "setup") send();
      } catch {
        /* not one of the terminal's messages */
      }
    });
    ws.addEventListener("error", () => !sent && done(new RunpodError("Couldn't open JupyterLab's terminal on the pod.")));
  });
  return name;
}

/**
 * Runs a bash script on the pod through its JupyterLab, for a pod with no SSH straight in (no public IP): the script
 * goes up as a file, a terminal runs it, and its output and exit code come back as files, looked at every couple of
 * seconds (RunPod's proxy drops long-held connections, so nothing waits on one). Past the time, its terminal is closed,
 * which stops it. stdout and stderr come back together.
 */
export async function jupyterExec(j: Jupyter, script: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number; out: string }> {
  const id = Math.random().toString(36).slice(2, 12);
  const file = (ext: string) => `${RUN_DIR}/${id}.${ext}`;
  const contents = (path: string, init: { method?: string; body?: unknown; query?: string } = {}) =>
    fetch(`${j.url}/api/contents/${path}${init.query ?? ""}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: { ...authOf(j), "Content-Type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
  await contents(RUN_DIR, { method: "PUT", body: { type: "directory" } }).catch(() => null);
  const put = await contents(file("sh"), { method: "PUT", body: { type: "file", format: "text", content: script.replace(/\r\n/g, "\n") } });
  if (!put.ok) throw new RunpodError(`JupyterLab on the pod didn't take Crackio's script (${put.status}).`, put.status);
  // Its folder from the terminal's: JupyterLab's own, which the terminal doesn't always start in.
  const name = await typeInTerminal(
    j,
    `for d in /workspace / "$HOME"; do [ -f "$d/${file("sh")}" ] && cd "$d" && break; done; bash ${file("sh")} > ${file("out")} 2>&1; echo $? > ${file("tmp")}; mv ${file("tmp")} ${file("code")}`,
  );
  const until = Date.now() + (opts.timeoutMs ?? 120_000);
  let code: number | null = null;
  try {
    for (let wait = 800; Date.now() < until && !opts.signal?.aborted; wait = Math.min(wait * 1.5, 3000)) {
      await new Promise((r) => setTimeout(r, wait));
      const res = await contents(file("code"), { query: "?type=file&format=text" }).catch(() => null);
      if (!res?.ok) continue;
      const body = (await res.json().catch(() => null)) as { content?: string } | null;
      const n = Number((body?.content ?? "").trim());
      if (Number.isInteger(n)) {
        code = n;
        break;
      }
    }
    const res = await contents(file("out"), { query: "?type=file&format=text" }).catch(() => null);
    const out = res?.ok ? (((await res.json().catch(() => null)) as { content?: string } | null)?.content ?? "") : "";
    return { code: code ?? -1, out: code === null ? `${out}\n(stopped after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} s)` : out };
  } finally {
    // Closing its terminal ends the script if it still runs; its files go too.
    await fetch(`${j.url}/api/terminals/${encodeURIComponent(name)}`, { method: "DELETE", headers: authOf(j), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    await Promise.all(["sh", "out", "code", "tmp"].map((ext) => contents(file(ext), { method: "DELETE" }).catch(() => null)));
  }
}

/**
 * Puts Crackio's SSH key in the pod's root authorized_keys through its JupyterLab, and starts its SSH server if none
 * runs: for a pod rented before the key was on the account. True when the pod says it's in.
 */
export async function addKeyThroughJupyter(p: Pod, publicKey: string): Promise<boolean> {
  const jupyter = podJupyter(p);
  if (!jupyter) return false;
  const line = Buffer.from(`${publicKey.trim()}\n`).toString("base64");
  const body = keyBody(publicKey).split(" ")[1] ?? "";
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return false;
  const script = [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
    `grep -qF '${body}' ~/.ssh/authorized_keys || echo '${line}' | base64 -d >> ~/.ssh/authorized_keys`,
    // Its SSH server, when the template didn't start one.
    "(pgrep -x sshd >/dev/null || /usr/sbin/sshd || service ssh start) >/dev/null 2>&1",
    `grep -qF '${body}' ~/.ssh/authorized_keys && echo CRACKIO_KEYED`,
  ].join("\n");
  const { out } = await jupyterExec(jupyter, script, { timeoutMs: 60_000 });
  return out.includes("CRACKIO_KEYED");
}

/* ------------------------------------------------------------------ a pod's log */

/**
 * The last lines a pod's container printed (its template's start script, ComfyUI's own output), or RunPod's own
 * ("system": its image pulling, its container starting), from RunPod's log stream: what it has so far, read for a few
 * seconds (the stream stays open for new lines).
 */
export async function podLogTail(key: string, id: string, lines = 300, source: "container" | "system" = "container", readMs = 5000): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), readMs);
  const out: string[] = [];
  try {
    const res = await fetch(`${API}/pods/${encodeURIComponent(id)}/logs?source=${source}&tail=${lines}`, { headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" }, signal: ac.signal });
    if (!res.ok || !res.body) return [];
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parts = (rest + decoder.decode(value, { stream: true })).split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.startsWith("data:")) continue;
        try {
          out.push(String((JSON.parse(p.slice(5)) as { line?: string }).line ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
        } catch {
          /* not a log line */
        }
      }
    }
  } catch {
    /* read for long enough */
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Why a pod's ComfyUI isn't up, from its log: RunPod's ComfyUI template prints "ComfyUI exited unexpectedly" when it
 * stops and doesn't start it again. Null when the log doesn't say it stopped.
 */
export function crashIn(log: string[]): { gpu: boolean; error: string } | null {
  const end = log.findLastIndex((l) => /ComfyUI exited unexpectedly/i.test(l));
  // A stop from before the pod's last start doesn't count.
  if (end < 0 || end < log.findLastIndex((l) => /^Starting ComfyUI/i.test(l.trim()))) return null;
  const error =
    log
      .slice(Math.max(0, end - 60), end)
      .reverse()
      .map((l) => l.trim())
      .find((l) => /^[\w.]*(Error|Exception)\b|^RuntimeError|Error: /.test(l)) ?? "it stopped with an error";
  return { gpu: /CUDA (unknown )?error|no CUDA GPUs|CUDA driver|CUDA initialization|cudaGetDeviceCount|nvidia-smi.*failed/i.test(error), error: error.slice(0, 240) };
}
