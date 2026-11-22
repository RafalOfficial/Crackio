import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { CloudGpu } from "@/lib/local/types";
import { addedId, forgetTargets, samePlace } from "./comfy-targets";
import { updateSettings } from "./settings";
import { markedJson, safeLogin, SshError, sshAnswers, sshRun, sshTunnel, viaJupyter, type SshLogin } from "./ssh";
import { boxFacts, ensurePython, installComfyOnBox, startComfyOnBox } from "./cloud-bootstrap";
import { COMFY_FLOOR, comfyOlder } from "@/lib/local/comfy-floor";

/**
 * Connecting a rented GPU (vast.ai, RunPod or any box with ComfyUI and SSH) in one step. From a pasted link or SSH
 * command, or a box picked from your cloud account, Crackio finds the box's ComfyUI address and token, copies the Crackio
 * bridge into it (downloads with your Hugging Face token, custom nodes, speeds), restarts ComfyUI so it loads, and adds the
 * box to your machines. Its models then install from the Local page and every tool's jobs can run there.
 */

export type Provider = CloudGpu["provider"];

/** What someone pasted: a ComfyUI link (perhaps with its token), an SSH command, or both. */
export type Pasted = { url?: string; token?: string; ssh?: SshLogin };

/** Links in a pasted text that aren't the box's ComfyUI. */
const NOT_COMFY = /(^|\.)(github\.com|huggingface\.co|vast\.ai\/docs|docs\.runpod\.io|comfy\.org)$/i;

export function readPasted(text: string): Pasted {
  const out: Pasted = {};
  const ssh = /(?:^|[\s"'`])ssh\s+([^\n"'`]+)/i.exec(text)?.[1];
  if (ssh) {
    const words = ssh.trim().split(/\s+/);
    let port = 22;
    let user: string | undefined;
    let host: string | undefined;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "-p" && words[i + 1]) port = Number(words[++i]) || 22;
      else if (/^-p\d+$/.test(w)) port = Number(w.slice(2));
      else if (w === "-l" && words[i + 1]) user = words[++i];
      else if (/^-[iLRDoFJWbcEeIOQSw]$/.test(w)) i++;
      else if (w.startsWith("-")) continue;
      else if (!host) {
        const m = /^(?:ssh:\/\/)?(?:([^@\s]+)@)?([\w.-]+|\[[0-9a-f:]+\])(?::(\d+))?$/i.exec(w);
        if (m) {
          user = m[1] ?? user;
          host = m[2].replace(/^\[|\]$/g, "");
          if (m[3]) port = Number(m[3]);
        }
      }
    }
    // Only a login ssh can't read as one of its options ("-l -oProxyCommand=…" would run a program on this computer).
    const login = host ? { host, port, user: user ?? "root" } : null;
    if (login && safeLogin(login)) out.ssh = login;
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
    try {
      const u = new URL(m[0].replace(/[).,;]+$/, ""));
      if (NOT_COMFY.test(u.hostname)) continue;
      out.url ??= `${u.protocol}//${u.host}`;
      out.token ??= u.searchParams.get("token") ?? undefined;
    } catch {
      /* not a link */
    }
  }
  // A bare address: 1.2.3.4:8188
  if (!out.url && !out.ssh) {
    const bare = /\b((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(\d{2,5})\b/i.exec(text);
    if (bare) out.url = `http://${bare[1]}:${bare[2]}`;
  }
  return out;
}

/** Which cloud a box is on, from its addresses (the box's own variables say it for sure, see `probeBox`). */
export function providerOf(p: Pasted): Provider {
  const hosts = [p.ssh?.host, p.url && new URL(p.url).hostname].filter(Boolean).join(" ");
  if (/vast\.ai|trycloudflare\.com/i.test(hosts)) return "vast";
  if (/runpod\.(io|net)/i.test(hosts)) return "runpod";
  return "other";
}

/* ------------------------------------------------------------------ the box, over SSH */

type Probe = {
  env: Record<string, string>;
  comfy: { pid: number; ppid: number; args: string[]; root: string; port: number; listen: string | null }[];
  pid1: string;
  supervisor: string | null;
  systemd: string | null;
  manager: "legacy" | "package" | null;
  bridge: string | null;
  gpus: string[];
  python: string;
  /** The CUDA driver's answer to cuInit: 0 when CUDA starts on the card, null without an NVIDIA driver to ask. */
  cuda?: number | null;
};

/** Reads the box: its cloud's variables, its ComfyUI (where it lives, its port), how ComfyUI is kept running, its GPUs. */
const PROBE = String.raw`
set +e
PY=$(command -v python3 || command -v python)
"$PY" - <<'PYEOF'
import json, os, re, shutil, subprocess

def environ(pid):
    try:
        raw = open("/proc/%s/environ" % pid, "rb").read().split(b"\0")
        return dict(x.decode("utf8", "replace").split("=", 1) for x in raw if b"=" in x)
    except Exception:
        return {}

def run(*cmd):
    try:
        return subprocess.run(list(cmd), capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return ""

env = {**environ(1), **os.environ}
keep = re.compile(r"^(OPEN_BUTTON_TOKEN|OPEN_BUTTON_PORT|PORTAL_CONFIG|PUBLIC_IPADDR|VAST_\w+|CONTAINER_ID|RUNPOD_\w+|JUPYTER_TOKEN|JUPYTER_PASSWORD|WEB_USER|WEB_PASSWORD|WEB_TOKEN|COMFYUI_ARGS|COMFYUI_PORT\w*)$")
env = {k: v for k, v in env.items() if keep.match(k) and "API_KEY" not in k}

comfy = []
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        args = [a.decode("utf8", "replace") for a in open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0") if a]
    except Exception:
        continue
    main = next((a for a in args if a.endswith("main.py")), None)
    if not main or not any("python" in os.path.basename(a) for a in args[:2]):
        continue
    try:
        cwd = os.readlink("/proc/%s/cwd" % pid)
    except Exception:
        cwd = ""
    root = os.path.dirname(main if os.path.isabs(main) else os.path.join(cwd, main))
    if not os.path.isdir(os.path.join(root, "custom_nodes")):
        continue
    port, listen = 8188, None
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
        elif a.startswith("--port="):
            port = int(a.split("=", 1)[1])
        elif a == "--listen":
            listen = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("-") else "0.0.0.0"
    try:
        ppid = int(open("/proc/%s/stat" % pid).read().rsplit(")", 1)[1].split()[1])
    except Exception:
        ppid = 0
    comfy.append({"pid": int(pid), "ppid": ppid, "args": args, "root": root, "port": port, "listen": listen})

supervisor = None
if shutil.which("supervisorctl"):
    for line in run("supervisorctl", "status").splitlines():
        name = (line.split() or [""])[0]
        if "comfy" in name.lower():
            supervisor = name
            break
systemd = None
if shutil.which("systemctl") and os.path.isdir("/run/systemd/system"):
    for line in run("systemctl", "list-units", "--type=service", "--no-legend", "--plain").splitlines():
        name = (line.split() or [""])[0]
        if "comfy" in name.lower():
            systemd = name
            break

manager = bridge = None
if comfy:
    nodes = os.path.join(comfy[0]["root"], "custom_nodes")
    names = [n.lower() for n in os.listdir(nodes)]
    if "comfyui-manager" in names:
        manager = "legacy"
    elif "--enable-manager" in comfy[0]["args"]:
        manager = "package"
    try:
        bridge = re.search(r'^VERSION = "([^"]+)"', open(os.path.join(nodes, "crackio_bridge", "__init__.py")).read(), re.M).group(1)
    except Exception:
        bridge = None

gpus = [l.strip() for l in run("nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader").splitlines() if l.strip()]
# Whether CUDA works on the card at all: a broken host shows the card, then answers 999 (unknown error) to cuInit, or
# fails to open a context on it (719, the card stuck in an error state; 46, busy or unavailable). With no ComfyUI
# running, a context and 1 MB on the card too (one running has its own, which a busy-only card might refuse a second).
cuda = None
if gpus:
    try:
        import ctypes
        lib = ctypes.CDLL("libcuda.so.1")
        cuda = int(lib.cuInit(0))
        if cuda == 0 and not comfy:
            dev, ctx, ptr = ctypes.c_int(), ctypes.c_void_p(), ctypes.c_uint64()
            cuda = int(lib.cuDeviceGet(ctypes.byref(dev), 0))
            if cuda == 0:
                cuda = int(lib.cuDevicePrimaryCtxRetain(ctypes.byref(ctx), dev))
                if cuda == 0:
                    cuda = int(lib.cuCtxSetCurrent(ctx))
                    if cuda == 0:
                        cuda = int(lib.cuMemAlloc_v2(ctypes.byref(ptr), ctypes.c_size_t(1 << 20)))
                        if cuda == 0:
                            lib.cuMemFree_v2(ptr)
                    try:
                        lib.cuDevicePrimaryCtxRelease_v2(dev)
                    except Exception:
                        pass
    except Exception:
        cuda = None
pid1 = " ".join(a.decode("utf8", "replace") for a in open("/proc/1/cmdline", "rb").read().split(b"\0") if a)[:200]
python = comfy[0]["args"][0] if comfy else ""
print("CRACKIO_JSON " + json.dumps({"env": env, "comfy": comfy, "pid1": pid1, "supervisor": supervisor, "systemd": systemd, "manager": manager, "bridge": bridge, "gpus": gpus, "python": python, "cuda": cuda}))
PYEOF
`;

async function probeBox(login: SshLogin, signal?: AbortSignal): Promise<Probe> {
  const res = await sshRun(login, PROBE, { timeoutMs: 60_000, signal });
  const probe = markedJson<Probe>(res.stdout);
  if (!probe) throw new CloudError(`The box answered over SSH but couldn't be read (${(res.stderr || res.stdout).trim().slice(-200) || "no Python on it?"}).`);
  return probe;
}

/**
 * The web address of the box's ComfyUI, from its cloud's variables:
 *  - vast.ai: the Instance Portal (Caddy, with the box's OPEN_BUTTON_TOKEN) at the public port mapped to the portal's
 *    ComfyUI port. PORTAL_CONFIG lists the portal's apps as host:outside:inside:path:name; ComfyUI itself listens inside.
 *  - RunPod: its HTTP proxy, https://{pod}-{port}.proxy.runpod.net.
 * Null when the box shows none (then Crackio goes through an SSH tunnel).
 */
function webAddress(probe: Probe): { url: string; token?: string } | null {
  const env = probe.env;
  const comfyPort = probe.comfy[0]?.port ?? 8188;
  if (env.PUBLIC_IPADDR || env.VAST_CONTAINERLABEL) {
    let outside = comfyPort;
    for (const app of (env.PORTAL_CONFIG ?? "").split("|")) {
      const [, out, inside] = app.split(":");
      if (Number(inside) === comfyPort && Number(out)) outside = Number(out);
    }
    const mapped = env[`VAST_TCP_PORT_${outside}`];
    if (env.PUBLIC_IPADDR && mapped) return { url: `http://${env.PUBLIC_IPADDR}:${mapped}`, token: env.OPEN_BUTTON_TOKEN || undefined };
  }
  if (env.RUNPOD_POD_ID) return { url: `https://${env.RUNPOD_POD_ID}-${comfyPort}.proxy.runpod.net` };
  return null;
}

/**
 * vast.ai's ComfyUI template downloads its example workflow's model (SDXL Turbo, 7 GB) before it lets ComfyUI start: 15
 * minutes on a slow host, for a model Crackio never uses. Once its provisioner is only downloading (its last phase,
 * after packages and repos are in), Crackio stops it and lets ComfyUI start; Crackio installs the models it needs.
 * True when it did.
 */
async function skipStarterDownloads(login: SshLogin) {
  const script = String.raw`
L=/var/log/portal/provisioning.log
if [ -f /.provisioning ] && [ -f "$L" ] && grep -- "--- Phase" "$L" | tail -1 | grep -q "Downloads"; then
  for p in $(pgrep -f "[p]ython -m provisioner|[h]f download"); do kill "$p"; done
  rm -f /.provisioning && touch /.provisioning_complete && echo "CRACKIO_JSON {\"skipped\": true}"
fi
`;
  const res = await sshRun(login, script, { timeoutMs: 30_000 }).catch(() => null);
  return Boolean(res && markedJson<{ skipped: boolean }>(res.stdout)?.skipped);
}

/** Waits (up to 5 min) until the box's ComfyUI answers on the box itself; false when it never does. */
async function waitInside(login: SshLogin, port: number) {
  const script = String.raw`
PY=$(command -v python3 || command -v python)
"$PY" - <<'PYEOF'
import json, time, urllib.request
ok = False
for _ in range(100):
    try:
        urllib.request.urlopen("http://127.0.0.1:${port}/system_stats", timeout=3).read()
        ok = True
        break
    except Exception:
        time.sleep(3)
print("CRACKIO_JSON " + json.dumps({"ok": ok}))
PYEOF
`;
  const res = await sshRun(login, script, { timeoutMs: 6 * 60_000 }).catch(() => null);
  return Boolean(res && markedJson<{ ok: boolean }>(res.stdout)?.ok);
}

/* ------------------------------------------------------------------ HTTP to its ComfyUI */

async function comfyGet<T>(url: string, token: string | undefined, route: string, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await fetch(`${url}${route}`, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !/json/.test(res.headers.get("content-type") ?? "")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type Stats = { system?: { comfyui_version?: string; os?: string }; devices?: { name?: string; vram_total?: number }[] };

/** vast's portal answers 502 with this header while the box's ComfyUI is still being set up; 401 means a wrong token. */
async function booting(url: string, token: string | undefined) {
  try {
    const res = await fetch(`${url}/system_stats`, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => undefined);
    return res.headers.get("x-portal-placeholder") === "true";
  } catch {
    return false;
  }
}

/**
 * The ComfyUI behind a vast Instance Portal link (its "Open" button opens the portal, not ComfyUI): the portal lists its
 * apps and their own addresses.
 */
async function comfyBehindPortal(url: string, token: string): Promise<string | null> {
  const list = await comfyGet<unknown>(url, token, "/capabilities/services");
  const entries: unknown[] = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v])) : [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const { name, direct_url } = e as { name?: string; direct_url?: string };
    if (!/comfy/i.test(name ?? "") || !direct_url) continue;
    try {
      const u = new URL(direct_url);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* not an address */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ the bridge */

const BRIDGE_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "comfyui", "crackio_bridge");

async function bridgeFiles() {
  const names = (await fs.readdir(/*turbopackIgnore: true*/ BRIDGE_DIR)).filter((f) => /\.(py|md)$/.test(f));
  // LFM3-VL's config, processor settings, chat template and model code, which lfm3.py loads from its own folder.
  names.push(...(await fs.readdir(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ BRIDGE_DIR, "lfm3_vl")).catch(() => [] as string[])).map((f) => `lfm3_vl/${f}`));
  const files: Record<string, string> = {};
  for (const n of names) files[n] = (await fs.readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ BRIDGE_DIR, n))).toString("base64");
  const version = /^VERSION = "([^"]+)"/m.exec(Buffer.from(files["__init__.py"] ?? "", "base64").toString("utf8"))?.[1] ?? "0";
  return { files, version };
}

const older = (a: string | null | undefined, b: string) => !a || a.localeCompare(b, undefined, { numeric: true }) < 0;

/** Copies the bridge into the box's ComfyUI custom_nodes, each file swapped in whole. */
async function copyBridge(login: SshLogin, root: string, signal?: AbortSignal) {
  const { files } = await bridgeFiles();
  const payload = Buffer.from(JSON.stringify(files)).toString("base64");
  const script = String.raw`
set -e
PY=$(command -v python3 || command -v python)
"$PY" - <<'PYEOF'
import base64, json, os
dest = os.path.join(${JSON.stringify(root)}, "custom_nodes", "crackio_bridge")
os.makedirs(dest, exist_ok=True)
files = json.loads(base64.b64decode("${payload}"))
for name, data in files.items():
    target = os.path.join(dest, *name.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".crackio-new"
    with open(tmp, "wb") as f:
        f.write(base64.b64decode(data))
    os.replace(tmp, target)
print("CRACKIO_JSON " + json.dumps({"copied": len(files), "to": dest}))
PYEOF
`;
  const res = await sshRun(login, script, { timeoutMs: 120_000, signal });
  const done = markedJson<{ copied: number; to: string }>(res.stdout);
  if (!done) throw new CloudError(`Couldn't copy the bridge onto the box: ${(res.stderr || res.stdout).trim().slice(-300)}`);
  return done.to;
}

/* ------------------------------------------------------------------ connecting */

export class CloudError extends Error {}

export type ConnectStep = { label: string; state: "doing" | "done" | "failed" | "skipped"; detail?: string };
export type ConnectJob = {
  id: string;
  state: "running" | "done" | "error";
  steps: ConnectStep[];
  error?: string;
  /** What's left for you to do, when Crackio can't do it (restart ComfyUI from the cloud's page). */
  todo?: string;
  /** Worth knowing once it's in: a disk too small for every tool. */
  note?: string;
  /** The machine's id on the Local page, once added. */
  machine?: string;
  label?: string;
  at: number;
};

const g = globalThis as unknown as { __crackioCloudJobs?: Map<string, ConnectJob> };
const jobs = (g.__crackioCloudJobs ??= new Map());

export const connectJob = (id: string) => jobs.get(id) ?? null;

export type ConnectRequest = Pasted & {
  provider?: Provider;
  instance?: string;
  label?: string;
  /** Crackio's key was just put on the box (vast.ai's API): its SSH may refuse it for a moment. */
  waitForKey?: boolean;
  /**
   * Every way into the box by SSH, in order (vast.ai: straight in, then its proxy): when the one in use stops answering
   * part way (a vast.ai host's direct port began resetting every connection during a long install), the next that
   * answers takes over.
   */
  sshRoutes?: SshLogin[];
  /**
   * A box on your cloud account that may still be starting: resolves once its cloud says it runs and its SSH answers, with
   * the way in that does (cloud-accounts). `say` shows what it's doing meanwhile, in the cloud's words.
   */
  untilUp?: (say: (detail: string) => void) => Promise<ConnectRequest>;
  /**
   * Why the box's ComfyUI isn't up, when its cloud can say (RunPod: the pod's log shows ComfyUI stopped at start, a GPU
   * that CUDA can't start on, say): asked while Crackio waits for it, so a box that will never answer says so at once.
   */
  whyDown?: () => Promise<string | null>;
};

/** Starts connecting a box; the Local page follows the job's steps. */
export function startConnect(req: ConnectRequest): ConnectJob {
  const job: ConnectJob = { id: nanoid(10), state: "running", steps: [], at: Date.now() };
  jobs.set(job.id, job);
  for (const [id, old] of jobs) if (Date.now() - old.at > 3_600_000) jobs.delete(id);
  void connect(job, req).catch((err: Error) => {
    const doing = job.steps.findLast((s) => s.state === "doing");
    if (doing) doing.state = "failed";
    job.state = "error";
    job.error = err.message;
  });
  return job;
}

function step(job: ConnectJob, label: string) {
  const prev = job.steps.findLast((s) => s.state === "doing");
  if (prev) prev.state = "done";
  const s: ConnectStep = { label, state: "doing" };
  job.steps.push(s);
  return s;
}

const PROVIDER_NAME: Record<Provider, string> = { vast: "vast.ai", runpod: "RunPod", other: "Cloud GPU" };
/** CUDA's driver errors a broken card answers with, in words. */
const CUDA_WORDS: Record<number, string> = {
  2: "out of memory",
  3: "not initialized",
  46: "busy or unavailable",
  100: "no CUDA card",
  101: "invalid device",
  304: "the system call failed",
  719: "the card is stuck in an error state",
  999: "unknown error",
};
/** "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync" (ComfyUI) or "NVIDIA GeForce RTX 5090, 32607 MiB" (nvidia-smi) → "RTX 5090". */
const shortGpu = (name: string) =>
  name
    .replace(/^cuda:\d+\s*/i, "")
    .replace(/\s*:\s*[\w-]+$/, "")
    .replace(/^NVIDIA\s+(GeForce\s+)?/i, "")
    .replace(/,.*$/, "")
    .trim();

async function connect(job: ConnectJob, asked: ConnectRequest) {
  let req = asked;
  // A box just rented spends minutes being placed and pulling its image: nothing to log in to until its cloud says it
  // runs and its SSH answers.
  if (req.untilUp) {
    const w = step(job, "Waiting for the GPU to start");
    const since = Date.now();
    let waited = false;
    req = {
      ...req,
      ...(await req.untilUp((detail) => {
        waited = true;
        w.detail = detail;
      })),
    };
    const took = Date.now() - since;
    w.detail = !waited ? "it's up" : `up after ${took < 90_000 ? `${Math.round(took / 1000)} s` : `${Math.round(took / 60_000)} min`}`;
  }
  let { url, token, instance } = req;
  let login = req.ssh;
  // Another of the box's SSH routes, once the one in use stops answering (it then stays the one used and saved).
  const reroute = async (): Promise<SshLogin | null> => {
    for (const r of req.sshRoutes ?? []) {
      if (login && r.host === login.host && r.port === login.port) continue;
      if (await sshAnswers(r)) return (login = r);
    }
    return null;
  };
  let provider: Provider = req.provider ?? providerOf(req);
  if (!url && !login) throw new CloudError("Paste the box's ComfyUI link or its SSH command (or both).");

  let probe: Probe | null = null;
  if (login) {
    const s = step(job, viaJupyter(login) ? "Logging in through its JupyterLab (the pod has no public IP, so no SSH straight in)" : `Logging in to ${login.host}`);
    // A box that just started can say "running" before its SSH answers: keep trying for two minutes (a vast.ai RTX 4090
    // timed out at first). So can a key just put on it.
    const retry = req.waitForKey ? /timed out|refused|closed by|reset by|didn't take Crackio's SSH key/i : /timed out|refused|closed by|reset by/i;
    for (let tries = 1; ; tries++) {
      try {
        // A bare image (Ubuntu, NVIDIA's CUDA image) has no Python for Crackio's look at it: uv's own Python first.
        if ((await ensurePython(login)) === "installed") s.detail = "put a Python on it (uv's 3.12) to read it";
        probe = await probeBox(login);
        break;
      } catch (err) {
        if (!(err instanceof SshError) || !retry.test(err.message) || tries >= 9) throw err;
        s.detail = "its SSH isn't answering yet; trying again";
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    s.detail = probe.gpus.map(shortGpu).join(", ") || undefined;
    // A card CUDA can't start on runs nothing (ComfyUI stops at start): no set-up fixes the cloud's machine.
    if (typeof probe.cuda === "number" && probe.cuda !== 0) {
      const what = CUDA_WORDS[probe.cuda];
      throw new CloudError(
        `This GPU doesn't work: CUDA can't start on it (error ${probe.cuda}${what ? `, ${what}` : ""}), though the card shows. That's the cloud's machine, not something Crackio can fix: delete it (it stops billing) and rent another.`,
      );
    }
    if (probe.env.VAST_CONTAINERLABEL || probe.env.PUBLIC_IPADDR) provider = "vast";
    else if (probe.env.RUNPOD_POD_ID) provider = "runpod";
    // Its id at the cloud, from its own variables (vast.ai: VAST_CONTAINERLABEL "C.12345678"): a pasted box is then
    // known on your cloud account too, and not connected again from there.
    instance ??= /^C\.(\d+)$/.exec(probe.env.VAST_CONTAINERLABEL ?? "")?.[1] ?? (probe.env.RUNPOD_POD_ID || undefined);
    // No ComfyUI running, and no template about to start one (a CUDA, PyTorch or bare image): Crackio installs it, the
    // PyTorch build its GPU and driver run, with the bridge in from the start, and keeps it running. One Crackio installed
    // before (the box restarted) is started again.
    if (!probe.comfy.length) {
      const facts = await boxFacts(login);
      if (facts.installed || !facts.comfyComing) {
        let at = facts.installed;
        if (!at) {
          const w = step(job, "Installing ComfyUI on the box");
          try {
            at = await installComfyOnBox(login, facts, (detail) => (w.detail = detail), undefined, reroute);
          } catch (err) {
            throw new CloudError((err as Error).message);
          }
          step(job, "Adding the Crackio bridge").detail = `into ${at.dir}`;
          await copyBridge(login, at.dir);
        }
        const st = step(job, "Starting ComfyUI");
        st.detail = await startComfyOnBox(login, facts, at).catch((err: Error) => {
          throw new CloudError(err.message);
        });
        if (!(await waitInside(login, at.port))) {
          const log = await sshRun(login, `tail -n 12 "${facts.ws}/crackio-comfyui.log" 2>/dev/null`, { timeoutMs: 30_000 }).catch(() => null);
          throw new CloudError(`ComfyUI didn't start on the box. Its log ends: ${(log?.stdout ?? "").trim().slice(-500) || "(empty)"}`);
        }
        probe = await probeBox(login);
      }
    }
    if (!probe.comfy.length) {
      // A box just rented: its template downloads and starts ComfyUI on the first boot.
      const w = step(job, "Waiting for its ComfyUI to start");
      w.detail = "the cloud's template sets it up on the first boot";
      // RunPod's ComfyUI template copies ComfyUI into /workspace on the first boot, which RunPod says can take 30 minutes.
      const until = Date.now() + 30 * 60_000;
      let skipped = false;
      let asked = 0;
      while (!probe.comfy.length && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10_000));
        // Stopped for good (it never comes back by itself): say why now, rather than after half an hour.
        if (req.whyDown && Date.now() - asked > 30_000) {
          asked = Date.now();
          const why = await req.whyDown().catch(() => null);
          if (why) throw new CloudError(why);
        }
        if (!skipped && (await skipStarterDownloads(login))) {
          skipped = true;
          w.detail = "skipped the template's starter model download (Crackio installs its own)";
        }
        probe = await probeBox(login).catch(() => probe!);
      }
      if (!probe.comfy.length) throw new CloudError("No ComfyUI started on that box in 30 minutes. Check its log on the cloud's page, or rent it with the ComfyUI template.");
    }
  }

  // Its web address: as pasted, else from the box's variables, else a tunnel through SSH.
  let s = step(job, "Finding its ComfyUI");
  let tunnel: number | undefined;
  let stats: Stats | null = null;
  const look = async () => {
    stats = url ? await comfyGet<Stats>(url, token, "/system_stats") : null;
    if (!stats && probe) {
      const web = webAddress(probe);
      if (web) {
        const found = await comfyGet<Stats>(web.url, web.token, "/system_stats");
        if (found) ({ url, token, stats } = { ...web, stats: found });
      }
    }
    if (!stats && url && !token && probe?.env.OPEN_BUTTON_TOKEN) {
      // The pasted link was the portal's without its token.
      stats = await comfyGet<Stats>(url, probe.env.OPEN_BUTTON_TOKEN, "/system_stats");
      if (stats) token = probe.env.OPEN_BUTTON_TOKEN;
    }
    if (!stats && url && token) {
      const comfy = await comfyBehindPortal(url, token);
      if (comfy) {
        const found = await comfyGet<Stats>(comfy, token, "/system_stats");
        if (found) ({ url, stats } = { url: comfy, stats: found });
      }
    }
  };
  await look();
  // Without SSH: a box whose template is still downloading and starting ComfyUI says so (a RunPod pod's says nothing,
  // but its log says when ComfyUI stopped for good); wait for it.
  if (!stats && !login && url && (req.whyDown || (await booting(url, token)))) {
    const w = step(job, "Waiting for its ComfyUI to start");
    w.detail = "the cloud's template sets it up on the first boot";
    const until = Date.now() + 20 * 60_000;
    let asked = 0;
    while (!stats && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10_000));
      await look();
      if (!stats && req.whyDown && Date.now() - asked > 30_000) {
        asked = Date.now();
        const why = await req.whyDown().catch(() => null);
        if (why) throw new CloudError(why);
      }
    }
    s = step(job, "Finding its ComfyUI");
  }
  // A ComfyUI that's still loading its nodes answers nobody yet, not even on the box: wait for it there, then look again.
  if (!stats && probe && login && (await waitInside(login, probe.comfy[0].port))) await look();
  // RunPod's proxy takes a new pod into its routing 10–30 s after it starts, and its replicas can disagree for a while.
  for (let i = 0; !stats && i < 8 && /\.proxy\.runpod\.net$/i.test(asked.url ? new URL(asked.url).hostname : ""); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    await look();
  }
  if (!stats && probe && login) {
    tunnel = probe.comfy[0].port;
    const port = await sshTunnel(login, tunnel);
    url = `http://127.0.0.1:${port}`;
    token = undefined;
    stats = await comfyGet<Stats>(url, undefined, "/system_stats", 30_000);
    s.detail = "through an SSH tunnel (the box shows no web address)";
  }
  if (!stats || !url) {
    const why = req.whyDown ? await req.whyDown().catch(() => null) : null;
    if (why) throw new CloudError(why);
    throw new CloudError(
      login
        ? "The box's ComfyUI didn't answer, even from inside the box."
        : `No ComfyUI answered at ${url}${token ? "" : " (if it asks for a token, paste the whole link with ?token=…, or the SSH command)"}.`,
    );
  }
  s.detail ??= url;
  const gpu = shortGpu(stats.devices?.[0]?.name ?? probe?.gpus[0] ?? "GPU");
  const label = req.label || `${gpu} · ${PROVIDER_NAME[provider]}`;
  job.label = label;

  // A template's ComfyUI older than Crackio's models need (RunPod's ComfyUI 0.35.0 template has no FLUX 3 text encoder):
  // ComfyUI's latest release, which the restart below loads together with the bridge.
  const updated = login && probe ? await updateComfy(job, login, probe, (stats as Stats | null)?.system?.comfyui_version) : false;

  // A PyTorch that can't run on this GPU gets one that can, before anything else runs there; a CUDA 13 build gets its
  // libraries found by cuDNN.
  const swapped = login && probe ? await fitTorch(job, login, probe) : false;
  const linked = login && probe ? await linkCudaLibs(job, login, probe) : false;

  // The bridge: added, or brought up to Crackio's version.
  const mine = (await bridgeFiles()).version;
  const info = await comfyGet<{ version?: string }>(url, token, "/crackio/info");
  if (!older(info?.version, mine) && !swapped && !linked && !updated) {
    step(job, `Crackio bridge ${info?.version} is there`);
  } else if (!login || !probe) {
    const b = step(job, "Adding the Crackio bridge");
    b.state = "skipped";
    b.detail = "needs the box's SSH command: models can't install from here until then";
  } else {
    if (older(info?.version, mine)) {
      step(job, info?.version ? `Updating the Crackio bridge to ${mine}` : "Adding the Crackio bridge");
      await copyBridge(login, probe.comfy[0].root);
    }
    const r = step(job, "Restarting ComfyUI");
    const how = await restart(login, probe, url, token, Boolean(info?.version));
    r.detail = how ?? undefined;
    if (!how) {
      job.todo = "Restart ComfyUI once from your cloud's page (or restart the box); Crackio finishes by itself when it's back.";
      r.detail = "waiting for you to restart it";
    }
    if (!(await backWithBridge(url, token, mine, how ? 5 * 60_000 : 20 * 60_000))) {
      throw new CloudError("ComfyUI didn't come back with the bridge. Check its log on the box, then connect again.");
    }
    job.todo = undefined;
  }

  // Added to your machines (the same box connected again replaces its old entry, also at a new address after a restart).
  step(job, "Adding it to your machines");
  const cloud: CloudGpu = { provider, ...(instance ? { instance } : {}), ...(login ? { ssh: login } : {}), ...(tunnel ? { tunnel } : {}) };
  const entry = { url: tunnel ? "" : url, ...(token && !tunnel ? { token } : {}), label, cloud };
  const sameBox = (m: { cloud?: CloudGpu }) => Boolean(instance) && m.cloud?.provider === provider && m.cloud.instance === instance;
  await updateSettings((st) => ({
    ...st,
    comfyMachines: [...(st.comfyMachines ?? []).filter((m) => addedId(m) !== addedId(entry) && !(m.url && entry.url && samePlace(m.url, entry.url)) && !sameBox(m)), entry],
  }));
  forgetTargets();
  job.machine = addedId(entry);
  // A small disk, said now rather than when set-ups start refusing (a box rented with 16 GB keeps ~9 once ComfyUI is in).
  if (login) {
    const free = (await boxFacts(login).catch(() => null))?.diskGb ?? null;
    if (free !== null && free < 30) {
      job.note =
        free < 12
          ? `Only ${free} GB of disk is left on it: room for small tools like the upscalers. Rent it with 70 GB or more for every tool.`
          : `Only ${free} GB of disk is left on it: room for a picture model, not video models (20 to 40 GB each). Rent it with 70 GB or more for every tool.`;
    }
  }
  job.steps.findLast((x) => x.state === "doing")!.state = "done";
  job.state = "done";
}

/**
 * Shell lines that set $PY to the Python running ComfyUI (that pid) as it was started: its venv's python, from the
 * process's VIRTUAL_ENV or its argv[0] on its own PATH. Not /proc/<pid>/exe, which resolves a venv's python to the
 * interpreter it points at: pip run that way installs outside the venv (RunPod's ComfyUI template runs
 * .venv-cu128/bin/python, which is /usr/bin/python3.12).
 */
const pythonOf = (pid: number) => String.raw`PY=""
VENV=$(tr '\0' '\n' < /proc/${pid}/environ 2>/dev/null | sed -n 's/^VIRTUAL_ENV=//p' | head -1)
[ -n "$VENV" ] && [ -x "$VENV/bin/python" ] && PY="$VENV/bin/python"
if [ -z "$PY" ]; then
  A0=$(tr '\0' '\n' < /proc/${pid}/cmdline 2>/dev/null | head -1)
  case "$A0" in
    /*) [ -x "$A0" ] && PY="$A0" ;;
    */*) [ -x "/proc/${pid}/cwd/$A0" ] && PY="$(readlink /proc/${pid}/cwd)/$A0" ;;
    ?*) P=$(tr '\0' '\n' < /proc/${pid}/environ 2>/dev/null | sed -n 's/^PATH=//p' | head -1); PY=$(PATH="$P" command -v "$A0" 2>/dev/null) ;;
  esac
fi
[ -n "$PY" ] || PY=$(readlink -f /proc/${pid}/exe)`;

/**
 * Brings a ComfyUI older than COMFY_FLOOR up to ComfyUI's latest release, in place: by git when its folder is a git
 * checkout, else from the release's archive copied over it (models, custom nodes and your files stay). The release's
 * packages go in first with ComfyUI's own Python, so when they can't, the ComfyUI there keeps running as it was. The
 * restart that loads it is the bridge step's. True when it updated.
 */
async function updateComfy(job: ConnectJob, login: SshLogin, probe: Probe, version: string | undefined): Promise<boolean> {
  const at = probe.comfy[0];
  if (!at?.pid || !comfyOlder(version)) return false;
  const s = step(job, `Updating ComfyUI ${version} to its latest release`);
  s.detail = `Crackio's models need ${COMFY_FLOOR} or newer (FLUX 3 Klein and MOSS-Image)`;
  const script = String.raw`
set +e
ROOT=${JSON.stringify(at.root)}
${pythonOf(at.pid)}
LOG=/tmp/crackio-comfy-update.log
: > "$LOG"
say() { printf 'CRACKIO_JSON {"error": "%s"}\n' "$1"; exit 0; }
cd "$ROOT" || say "its ComfyUI folder is gone"
command -v curl >/dev/null || say "the box has no curl"
TAG=$(curl -fsSL https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest 2>>"$LOG" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$TAG" ] || say "GitHub didn't say which ComfyUI release is the latest"
REQ=$(mktemp)
NEW=""
if [ -d .git ] && command -v git >/dev/null; then
  git fetch -q --depth 1 https://github.com/Comfy-Org/ComfyUI "refs/tags/$TAG:refs/tags/$TAG" >>"$LOG" 2>&1 || say "git couldn't fetch ComfyUI $TAG"
  git show "$TAG:requirements.txt" > "$REQ" 2>>"$LOG" || say "git couldn't read the requirements of $TAG"
else
  NEW=$(mktemp -d)
  curl -fsSL "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/$TAG.tar.gz" 2>>"$LOG" | tar -xz --strip-components=1 -C "$NEW" >>"$LOG" 2>&1 || say "couldn't download ComfyUI $TAG"
  cp "$NEW/requirements.txt" "$REQ"
fi
# Its packages first: when they can't install, the ComfyUI there keeps running as it was.
# A template's pin on its own PyTorch (RunPod's PIP_CONSTRAINT) would undo a torch Crackio put in: Crackio picks it.
PIP_CONSTRAINT= PIP_BREAK_SYSTEM_PACKAGES=1 "$PY" -m pip install -q --disable-pip-version-check -r "$REQ" >>"$LOG" 2>&1 || say "pip couldn't install the packages of $TAG: $(tail -n 2 "$LOG" | tr -d '"\\' | tr '\n' ' ' | cut -c1-200)"
if [ -n "$NEW" ]; then
  cp -a "$NEW/." "$ROOT/" >>"$LOG" 2>&1 || say "couldn't copy ComfyUI $TAG in"
  rm -rf "$NEW"
else
  git -c advice.detachedHead=false checkout -q "$TAG" >>"$LOG" 2>&1 || { git stash -q >>"$LOG" 2>&1; git -c advice.detachedHead=false checkout -q "$TAG" >>"$LOG" 2>&1; } || say "git couldn't switch to $TAG"
fi
rm -f "$REQ"
printf 'CRACKIO_JSON {"tag": "%s"}\n' "$TAG"
`;
  const res = await sshRun(login, script, { timeoutMs: 20 * 60_000 }).catch((err: Error) => ({ code: -1, stdout: "", stderr: err.message }));
  const out = markedJson<{ tag?: string; error?: string }>(res.stdout);
  if (out?.tag) {
    s.detail = `now ${out.tag}`;
    return true;
  }
  // Not updated: the box goes on with the ComfyUI it has, and models that need a newer one say so when they run.
  s.state = "skipped";
  s.detail = `couldn't (${(out?.error ?? (res.stderr || res.stdout).trim().slice(-200)) || "no answer"}): FLUX 3 Klein and MOSS-Image won't run there until it's ${COMFY_FLOOR} or newer`;
  return false;
}

/**
 * The PyTorch build this GPU needs, put in ComfyUI's own Python with its matching torchvision and torchaudio (ComfyUI
 * restarts in the bridge step that follows). True when it did.
 * - GTX 10 and older (compute 6.x and below): PyTorch's CUDA 12.8 and later builds, the ones cloud templates ship now,
 *   have no kernels for them: ComfyUI starts, then every model fails with "no kernel image". The same version's CUDA
 *   12.6 build is the newest that still covers them.
 * - RTX 20 and newer on a CUDA 12 build, where the driver runs CUDA 13: ComfyUI turns its own fast kernels (int8, fp8 and
 *   nvfp4 math) off below cu130, and INT8 models ran 2–4× slower (rented RTX 5070 Ti and 4060 Ti next to a 4070 and a
 *   3060 Ti on cu130, Oct 2026). vast.ai's ComfyUI template gives hosts below CUDA 13.2 its CUDA 12.9 image.
 */
async function fitTorch(job: ConnectJob, login: SshLogin, probe: Probe): Promise<boolean> {
  const pid = probe.comfy[0]?.pid;
  if (!pid) return false;
  const check = String.raw`
${pythonOf(pid)}
"$PY" - <<'PYEOF'
import json, re, subprocess
from importlib.metadata import version
out = {}
try:
    import torch
    out["version"] = torch.__version__
    out["cuda"] = torch.version.cuda
    for name in ("torchvision", "torchaudio"):
        try:
            out[name] = version(name)
        except Exception:
            pass
    if torch.cuda.is_available():
        major, minor = torch.cuda.get_device_capability(0)
        out["cap"] = [major, minor]
        # Kernels for this chip, or for an older one of its generation (sm_86's run on sm_89), or PTX for an older chip
        # (compiled at load).
        def runs(arch):
            m = re.match(r"(sm|compute)_(\d+)", arch)
            if not m:
                return False
            n = int(m.group(2))
            return (n // 10 == major and n % 10 <= minor) if m.group(1) == "sm" else (n // 10, n % 10) <= (major, minor)
        out["fits"] = any(runs(a) for a in torch.cuda.get_arch_list())
    m = re.search(r"CUDA Version: (\d+)\.(\d+)", subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=60).stdout)
    if m:
        out["driver"] = [int(m.group(1)), int(m.group(2))]
except Exception as e:
    out["error"] = str(e)[:200]
print("CRACKIO_JSON " + json.dumps(out))
PYEOF
`;
  const res = await sshRun(login, check, { timeoutMs: 120_000 }).catch(() => null);
  const t = res
    ? markedJson<{ version?: string; torchvision?: string; torchaudio?: string; cuda?: string | null; cap?: number[]; fits?: boolean; driver?: number[] }>(res.stdout)
    : null;
  if (!t?.version || !t.cap) return false;
  const old = t.fits === false;
  const cu13 = !old && t.cap[0] * 10 + t.cap[1] >= 75 && Number(t.cuda?.split(".")[0]) === 12 && (t.driver?.[0] ?? 0) >= 13;
  if (!old && !cu13) return false;
  const build = old ? "cu126" : "cu130";
  const s = step(job, "Installing a PyTorch build for this GPU");
  s.detail = old
    ? `PyTorch ${t.version} has no kernels for compute ${t.cap.join(".")}; its CUDA 12.6 build does`
    : `PyTorch ${t.version} is a CUDA 12 build: ComfyUI's fast int8 and fp8 math needs its CUDA 13 build, which this driver runs`;
  // The same versions with the build's tag: pip counts 2.10.0+cu128 as 2.10.0 and would keep it.
  const pins = (["torch", "torchvision", "torchaudio"] as const).flatMap((name) => {
    const v = name === "torch" ? t.version : t[name];
    return v ? [`"${name}==${v.split("+")[0]}+${build}"`] : [];
  });
  // Past a template's pin on its own PyTorch (RunPod's ComfyUI template: PIP_CONSTRAINT holds torch at its cu128 build).
  const pip = `set -o pipefail\n${pythonOf(pid)}\nPIP_CONSTRAINT= PIP_BREAK_SYSTEM_PACKAGES=1 "$PY" -m pip install -q --index-url https://download.pytorch.org/whl/${build} ${pins.join(" ")} 2>&1 | tail -5`;
  const r = await sshRun(login, pip, { timeoutMs: 25 * 60_000 });
  if (r.code === 0) return true;
  if (old) throw new CloudError(`Couldn't put in a PyTorch build for this GPU: ${r.stdout.slice(-300)}`);
  // The CUDA 12 build still runs everything, only slower: the box goes on with it.
  s.state = "skipped";
  s.detail = `couldn't put in PyTorch's CUDA 13 build, so int8 and fp8 models run slower here: ${r.stdout.slice(-200)}`;
  return false;
}

/**
 * PyTorch's CUDA 13 builds bring CUDA's libraries as pip packages (nvidia/cu13/lib), and cuDNN loads NVRTC from there by
 * name at run time: with that folder missing from the system's library list, SAM 3.1's attention stopped ComfyUI
 * ("Could not open libnvrtc", a rented RTX 5090, Oct 2026). Adds it (root only). True when it did: ComfyUI must restart.
 */
async function linkCudaLibs(job: ConnectJob, login: SshLogin, probe: Probe): Promise<boolean> {
  const pid = probe.comfy[0]?.pid;
  if (!pid) return false;
  const script = String.raw`
${pythonOf(pid)}
LIB=$("$PY" - <<'PYEOF'
import glob, os
try:
    import torch
    if (torch.version.cuda or "").split(".")[0] == "13":
        # Every nvidia folder on its path: a venv over a template's Python can't see its own through nvidia.__path__ when
        # the template's nvidia is a regular package (RunPod's ComfyUI template).
        import sys
        hits = [p for d in sys.path if d and os.path.isdir(os.path.join(d, "nvidia")) for p in glob.glob(os.path.join(d, "nvidia", "*", "lib", "libnvrtc.so.13*"))]
        print(os.path.dirname(hits[0]) if hits else "")
except Exception:
    pass
PYEOF
)
[ -n "$LIB" ] || exit 0
ldconfig -p | grep -q "libnvrtc.so.13 .*=> $LIB/" && exit 0
[ "$(id -u)" = 0 ] || exit 0
echo "$LIB" > /etc/ld.so.conf.d/crackio-cuda13.conf && ldconfig && echo CRACKIO_LINKED
`;
  const res = await sshRun(login, script, { timeoutMs: 120_000 }).catch(() => null);
  if (!res?.stdout.includes("CRACKIO_LINKED")) return false;
  step(job, "Pointing cuDNN at PyTorch's CUDA 13 libraries").detail = "SAM 3.1 needs them";
  return true;
}

/**
 * Restarts the box's ComfyUI so the bridge loads, the gentlest way it has: the bridge's own restart (when an older one
 * runs), its supervisor, ComfyUI-Manager's restart, or its systemd service. All of them restart it in place or under its
 * keeper; none stops the box. Says how, or null when it has none of them (then the user restarts it).
 */
async function restart(login: SshLogin, probe: Probe, url: string, token: string | undefined, hadBridge: boolean): Promise<string | null> {
  // Manager turns away bodyless POSTs with a form content type: send JSON.
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const post = (route: string, method = "POST") =>
    fetch(`${url}${route}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(15_000) }).then((r) => r.ok, () => false);
  if (hadBridge && (await post("/crackio/restart"))) return "with the bridge's own restart";
  if (probe.supervisor) {
    const res = await sshRun(login, `supervisorctl restart ${probe.supervisor}`, { timeoutMs: 120_000 });
    if (res.code === 0) return `with its supervisor (${probe.supervisor})`;
  }
  if (probe.manager) {
    // Its restart answers, or doesn't (the process is replaced at once): what counts is that ComfyUI goes away. The
    // custom-node Manager and Manager v4 have their own routes; older ones took a GET.
    for (const [route, method] of [["/manager/reboot", "POST"], ["/v2/manager/reboot", "POST"], ["/manager/reboot", "GET"]] as const) {
      void post(route, method);
      if (await wentDown(url, token)) return "with ComfyUI-Manager's restart";
    }
  }
  if (probe.systemd) {
    const res = await sshRun(login, `systemctl restart ${probe.systemd}`, { timeoutMs: 120_000 });
    if (res.code === 0) return `with its service (${probe.systemd})`;
  }
  // A ComfyUI Crackio installed there (cloud-bootstrap) runs under Crackio's own loop: stopping it starts it again.
  const pid = probe.comfy[0]?.pid;
  if (pid) {
    const res = await sshRun(login, `pgrep -f crackio-comfyui.sh >/dev/null && kill ${pid} && echo CRACKIO_RESTARTED`, { timeoutMs: 30_000 }).catch(() => null);
    if (res?.stdout.includes("CRACKIO_RESTARTED")) return "with Crackio's own loop";
  }
  return null;
}

/** Whether ComfyUI stops answering (or answers with the new bridge) within a few seconds: a restart under way. */
async function wentDown(url: string, token: string | undefined, withinMs = 12_000) {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await comfyGet<Stats>(url, token, "/system_stats", 4000))) return true;
    if (await comfyGet<{ version?: string }>(url, token, "/crackio/info", 4000)) return true;
  }
  return false;
}

/** Waits until ComfyUI answers again with the bridge at that version. */
async function backWithBridge(url: string, token: string | undefined, version: string, withinMs: number) {
  const until = Date.now() + withinMs;
  await new Promise((r) => setTimeout(r, 3000));
  while (Date.now() < until) {
    const info = await comfyGet<{ version?: string }>(url, token, "/crackio/info", 8000);
    if (info?.version && !older(info.version, version)) return true;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}
