import "server-only";
import { BUILDS, nvidiaChoice } from "./comfy-install";
import { sshRun, type SshLogin } from "./ssh";
import type { Gpu } from "@/lib/local/types";

/**
 * Sets a rented box up from nothing: any Linux image (a bare Ubuntu, NVIDIA's CUDA image, a PyTorch template) gets
 * Python, ComfyUI and the PyTorch build its GPU and driver run, started and kept running, the way Crackio installs
 * ComfyUI on this computer (comfy-install). Everything runs on the box in the background and writes its progress to a
 * file there, so a dropped SSH connection doesn't stop it and the connect job shows each stage as it goes.
 */

export type BoxFacts = {
  /** Where Crackio keeps things there: /workspace when it's writable (vast.ai keeps it), else the home folder. */
  ws: string;
  python: string | null;
  curl: boolean;
  git: boolean;
  apt: boolean;
  root: boolean;
  /** Free space at `ws`, in GB. */
  diskGb: number | null;
  gpus: { name: string; compute: number | null; driver: string | null; memoryGb: number | null }[];
  /** The newest CUDA its driver runs ("13.2"). */
  cuda: string | null;
  /** A ComfyUI Crackio installed there before (its folder, port, Python). */
  installed: { dir: string; port: number; python: string } | null;
  /** Its template starts a ComfyUI by itself (vast.ai's ComfyUI template): wait for that one instead. */
  comfyComing: boolean;
};

/** What the box has, read with bash alone (a bare image may have no Python). */
const FACTS = String.raw`
set +e
WS=/workspace; { [ -d "$WS" ] && [ -w "$WS" ]; } || WS="$HOME"
f() { echo "CRACKIO_FACT $1=$2"; }
f ws "$WS"
f python "$(command -v python3 || command -v python || true)"
f curl "$(command -v curl >/dev/null && echo 1 || echo 0)"
f git "$(command -v git >/dev/null && echo 1 || echo 0)"
f apt "$(command -v apt-get >/dev/null && echo 1 || echo 0)"
f root "$([ "$(id -u)" = 0 ] && echo 1 || echo 0)"
f disk "$(df -Pk "$WS" 2>/dev/null | awk 'NR==2{print $4}')"
f gpus "$(nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null | tr '\n' ';')"
f cuda "$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: [0-9.]*' | awk '{print $3}')"
[ -f "$WS/.crackio-comfy.json" ] && f installed "$(tr -d '\n' < "$WS/.crackio-comfy.json")"
coming=0
tr '\0' '\n' < /proc/1/environ 2>/dev/null | grep -qi '^PORTAL_CONFIG=.*comfy' && coming=1
[ -f /opt/supervisor-scripts/comfyui.sh ] && coming=1
f comfyComing "$coming"
`;

export async function boxFacts(login: SshLogin): Promise<BoxFacts> {
  const res = await sshRun(login, FACTS, { timeoutMs: 60_000 });
  const kv = new Map<string, string>();
  for (const line of res.stdout.split("\n")) {
    const m = /^CRACKIO_FACT (\w+)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1], m[2]);
  }
  const gpus = (kv.get("gpus") ?? "")
    .split(";")
    .map((g) => g.split(",").map((x) => x.trim()))
    .filter((g) => g[0])
    .map(([name, cc, driver, mem]) => ({ name, compute: Number(cc) || null, driver: driver || null, memoryGb: Number(mem) ? Math.round((Number(mem) / 1024) * 10) / 10 : null }));
  let installed: BoxFacts["installed"] = null;
  try {
    installed = kv.get("installed") ? (JSON.parse(kv.get("installed")!) as BoxFacts["installed"]) : null;
  } catch {
    installed = null;
  }
  const disk = Number(kv.get("disk"));
  return {
    ws: kv.get("ws") || "/root",
    python: kv.get("python") || null,
    curl: kv.get("curl") === "1",
    git: kv.get("git") === "1",
    apt: kv.get("apt") === "1",
    root: kv.get("root") === "1",
    diskGb: Number.isFinite(disk) && disk > 0 ? Math.round((disk / 1024 / 1024) * 10) / 10 : null,
    gpus,
    cuda: kv.get("cuda") || null,
    installed,
    comfyComing: kv.get("comfyComing") === "1",
  };
}

/** The packages a bare image lacks for what follows (curl, git, certificates), from its own package manager. */
const BASICS = String.raw`
set +e
export DEBIAN_FRONTEND=noninteractive
need=""
command -v curl >/dev/null || need="$need curl"
command -v git >/dev/null || need="$need git"
[ -s /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
if [ -n "$need" ] && command -v apt-get >/dev/null && [ "$(id -u)" = 0 ]; then
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends $need) > /tmp/crackio-apt.log 2>&1
fi
command -v curl >/dev/null && echo CRACKIO_OK || { tail -5 /tmp/crackio-apt.log; echo CRACKIO_NO_CURL; }
`;

/**
 * A Python for Crackio's look at the box (it reads the box with a Python script): a bare image gets uv's own Python 3.12,
 * linked as python3 (nothing from the system's packages changes).
 */
export async function ensurePython(login: SshLogin): Promise<"there" | "installed"> {
  const facts = await boxFacts(login);
  if (facts.python) return "there";
  const basics = await sshRun(login, BASICS, { timeoutMs: 10 * 60_000 });
  if (!basics.stdout.includes("CRACKIO_OK")) throw new Error(`The box has no curl and couldn't get one: ${basics.stdout.slice(-300)}`);
  const res = await sshRun(
    login,
    String.raw`
set -e
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh > /tmp/crackio-uv.log 2>&1
uv python install 3.12 > /tmp/crackio-uvpy.log 2>&1
PY=$(uv python find 3.12)
if [ "$(id -u)" = 0 ]; then ln -sf "$PY" /usr/local/bin/python3; else mkdir -p "$HOME/.local/bin"; ln -sf "$PY" "$HOME/.local/bin/python3"; fi
echo CRACKIO_OK "$PY"
`,
    { timeoutMs: 10 * 60_000 },
  );
  if (!res.stdout.includes("CRACKIO_OK")) throw new Error(`Couldn't put a Python on the box: ${(res.stderr || res.stdout).slice(-300)}`);
  return "installed";
}

/** ComfyUI listens here inside the box; Crackio reaches it through an SSH tunnel (nothing new is opened to the internet). */
export const BOX_PORT = 18188;

export type BoxPlan = { build: string; torch: string | null; torchvision: string | null; index: string | null; reason: string };

/** The PyTorch build for the box's GPU and driver: the same rules as this computer's installer (comfy-install). */
export function planForBox(facts: BoxFacts): BoxPlan {
  const g = facts.gpus[0];
  if (!g) return { build: "cpu", ...pick("cpu"), reason: "No NVIDIA GPU answered on the box, so ComfyUI runs on its CPU." };
  const gpu: Gpu = { name: g.name, vendor: "nvidia", memoryGb: g.memoryGb, unified: false, driver: g.driver ?? undefined, compute: g.compute ?? undefined };
  const choice = nvidiaChoice(gpu);
  const build = choice.build === "cpu" || choice.build === "cu126" || choice.build === "cu128" || choice.build === "cu130" ? choice.build : "cu126";
  return { build, ...pick(build), reason: choice.reason };
}

function pick(build: keyof typeof BUILDS) {
  const b = BUILDS[build];
  return { torch: b.torch, torchvision: b.torchvision, index: b.index };
}

const STAGES: Record<string, string> = {
  basics: "Getting curl and git",
  uv: "Getting uv (Python's installer)",
  python: "Setting up Python 3.12",
  comfyui: "Getting ComfyUI",
  torch: "Installing PyTorch for this GPU",
  requirements: "Installing ComfyUI's packages",
  done: "Installed",
};

/** The install, as one script that runs on the box by itself and writes `stage|detail` lines to its status file. */
function installScript(facts: BoxFacts, plan: BoxPlan) {
  const ws = facts.ws;
  return String.raw`#!/bin/bash
# Crackio: ComfyUI for this box (written by Crackio's connect; safe to run again: done steps are skipped).
WS="${ws}"
DIR="$WS/ComfyUI"
VENV="$WS/crackio-venv"
STATUS="$WS/crackio-install.status"
export PATH="$HOME/.local/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
export UV_LINK_MODE=copy
say() { echo "$1|$2" > "$STATUS"; echo "== $1: $2"; }
fail() { echo "error|$1" > "$STATUS"; echo "!! $1"; exit 1; }

say basics "checking curl, git and a C compiler"
need=""
command -v curl >/dev/null || need="$need curl"
command -v git >/dev/null || need="$need git"
[ -s /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
# PyTorch's Triton compiles small GPU kernels with the system's C compiler at run time ("Failed to find C compiler" on a
# bare Ubuntu, Nov 2026): a bare image needs one.
command -v gcc >/dev/null || command -v cc >/dev/null || need="$need build-essential"
if [ -n "$need" ]; then
  if command -v apt-get >/dev/null && [ "$(id -u)" = 0 ]; then
    say basics "installing$need"
    apt-get update -qq && apt-get install -y -qq --no-install-recommends $need || fail "couldn't install$need with apt-get"
  fi
fi
command -v curl >/dev/null || fail "the box has no curl, and Crackio couldn't install it"

say uv "checking uv"
command -v uv >/dev/null || { say uv "downloading uv"; curl -LsSf https://astral.sh/uv/install.sh | sh || fail "couldn't get uv"; }
command -v uv >/dev/null || fail "uv didn't install"
# PyTorch's CUDA libraries are GBs of wheels: from a slow mirror a read can stall past uv's 30 s default ("operation timed out").
export UV_HTTP_TIMEOUT=600

say python "Python 3.12"
# --seed: pip in the venv too (the bridge installs custom nodes' packages with it).
[ -x "$VENV/bin/python" ] || { uv python install 3.12 && uv venv --seed --python 3.12 "$VENV"; } || fail "couldn't set up Python 3.12"
"$VENV/bin/python" -m pip --version >/dev/null 2>&1 || uv pip install --python "$VENV/bin/python" pip setuptools wheel || fail "couldn't put pip in Python 3.12"

say comfyui "the latest ComfyUI release"
if [ ! -f "$DIR/main.py" ]; then
  TAG=$(curl -fsSL https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  if command -v git >/dev/null; then
    git clone --depth 1 ${"$"}{TAG:+--branch "$TAG"} https://github.com/comfyanonymous/ComfyUI "$DIR" || fail "couldn't clone ComfyUI"
  else
    REF=${"$"}{TAG:-master}
    mkdir -p "$DIR.tmp" && curl -fsSL "https://codeload.github.com/comfyanonymous/ComfyUI/tar.gz/$REF" | tar -xz -C "$DIR.tmp" --strip-components=1 && mv "$DIR.tmp" "$DIR" || fail "couldn't download ComfyUI"
  fi
fi

say torch "${plan.torch ? `PyTorch ${plan.torch} (${plan.build})` : "PyTorch"}"
HAVE=$("$VENV/bin/python" -c "import torch; print(torch.__version__)" 2>/dev/null)
if [ -z "$HAVE" ] || ! echo "$HAVE" | grep -q "^${plan.torch ?? ""}"; then
  # Three tries: a download that drops starts again from uv's cache (the wheels already fetched stay).
  ok=""
  for try in 1 2 3; do
    uv pip install --python "$VENV/bin/python" ${plan.index ? `--index-url ${plan.index}` : ""} ${plan.torch ? `"torch==${plan.torch}" "torchvision==${plan.torchvision}"` : "torch torchvision"} && { ok=1; break; }
    [ "$try" = 3 ] || { say torch "the PyTorch download dropped, trying again ($try of 3)"; sleep 5; }
  done
  [ -n "$ok" ] || fail "couldn't install PyTorch (${plan.build})"
fi
"$VENV/bin/python" -c "import torch; print(torch.__version__)" > "$WS/crackio-torch.txt" 2>&1 || fail "PyTorch doesn't import: $(tail -c 300 "$WS/crackio-torch.txt")"

say requirements "ComfyUI's packages"
"$VENV/bin/python" -c "import torch, torchvision; print('torch==' + torch.__version__.split('+')[0]); print('torchvision==' + torchvision.__version__.split('+')[0])" > "$WS/crackio-constraints.txt"
uv pip install --python "$VENV/bin/python" -r "$DIR/requirements.txt" --constraint "$WS/crackio-constraints.txt" || fail "couldn't install ComfyUI's packages"
"$VENV/bin/python" - <<'PYEOF' > "$WS/crackio-gpu.txt" 2>&1
import torch
ok = torch.cuda.is_available()
print("gpu", ok, torch.cuda.get_device_name(0) if ok else "")
if ok:
    print("math", float((torch.ones(8, device="cuda") * 2).sum()))
PYEOF
grep -q "^gpu True" "$WS/crackio-gpu.txt" || grep -q "^gpu False" "$WS/crackio-gpu.txt"
echo "{\"dir\": \"$DIR\", \"port\": ${BOX_PORT}, \"python\": \"$VENV/bin/python\"}" > "$WS/.crackio-comfy.json"
say done "$(head -1 "$WS/crackio-gpu.txt")"
`;
}

/** Keeps ComfyUI running there: under the box's supervisor when it has one (it outlives Crackio and restarts), else a loop. */
function startScript(facts: BoxFacts, dir: string, python: string, port: number) {
  const ws = facts.ws;
  return String.raw`
set +e
WS="${ws}"
cat > "$WS/crackio-comfyui.sh" <<'SHEOF'
#!/bin/bash
cd "${dir}"
exec "${python}" main.py --listen 127.0.0.1 --port ${port}
SHEOF
chmod +x "$WS/crackio-comfyui.sh"
# "status" fails whenever any program is stopped; "version" only asks whether supervisord answers.
if command -v supervisorctl >/dev/null && [ -d /etc/supervisor/conf.d ] && [ -w /etc/supervisor/conf.d ] && supervisorctl version >/dev/null 2>&1; then
  cat > /etc/supervisor/conf.d/crackio-comfyui.conf <<CONF
[program:crackio-comfyui]
command=$WS/crackio-comfyui.sh
autostart=true
autorestart=true
startsecs=5
stdout_logfile=$WS/crackio-comfyui.log
redirect_stderr=true
CONF
  supervisorctl reread >/dev/null 2>&1; supervisorctl update >/dev/null 2>&1; supervisorctl start crackio-comfyui >/dev/null 2>&1
  echo CRACKIO_STARTED supervisor
else
  pgrep -f "main.py --listen 127.0.0.1 --port ${port}" >/dev/null && { echo CRACKIO_STARTED already; exit 0; }
  nohup setsid bash -c 'while true; do "$0"; sleep 3; done' "$WS/crackio-comfyui.sh" >> "$WS/crackio-comfyui.log" 2>&1 < /dev/null &
  echo CRACKIO_STARTED loop
fi
`;
}

type Report = (detail: string) => void;

/**
 * Installs ComfyUI on the box (in the background there) and starts it. Returns where it lives. Throws in plain words,
 * with the end of the install's log, when a stage fails.
 */
export async function installComfyOnBox(
  login: SshLogin,
  facts: BoxFacts,
  report: Report,
  signal?: AbortSignal,
  /** Another way into the box, when this login stops answering part way (the install carries on there regardless). */
  reroute?: () => Promise<SshLogin | null>,
): Promise<{ dir: string; port: number; python: string; plan: BoxPlan }> {
  if (facts.diskGb != null && facts.diskGb < 12) throw new Error(`The box has ${facts.diskGb} GB free at ${facts.ws}; ComfyUI and PyTorch need about 12 GB. Rent it with more disk.`);
  const plan = planForBox(facts);
  report(`${plan.build === "cpu" ? "CPU only" : `PyTorch ${plan.torch} (${plan.build})`}: ${plan.reason}`);
  const script = installScript(facts, plan);
  // Written and started detached: it carries on if this SSH session drops. One already running there (a connect that
  // Crackio's restart cut off) is followed instead of started twice.
  const start = await sshRun(
    login,
    `set -e
if pgrep -f "crackio-install.sh" >/dev/null 2>&1; then echo CRACKIO_OK running; exit 0; fi
mkdir -p "${facts.ws}"
cat > "${facts.ws}/crackio-install.sh" <<'CRACKIOEOF'
${script}
CRACKIOEOF
chmod +x "${facts.ws}/crackio-install.sh"
echo "start|starting" > "${facts.ws}/crackio-install.status"
nohup setsid bash "${facts.ws}/crackio-install.sh" > "${facts.ws}/crackio-install.log" 2>&1 < /dev/null &
echo CRACKIO_OK`,
    { timeoutMs: 60_000, signal },
  );
  if (!start.stdout.includes("CRACKIO_OK")) throw new Error(`Couldn't start the install on the box: ${(start.stderr || start.stdout).slice(-300)}`);
  const until = Date.now() + 40 * 60_000;
  let last = "";
  let missed = 0;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error("Stopped.");
    // A look every 8 s: a new SSH connection each time, and some hosts start refusing ones that come too often.
    await new Promise((r) => setTimeout(r, 8000));
    const look = await sshRun(login, `cat "${facts.ws}/crackio-install.status" 2>/dev/null; echo; echo '--log--'; tail -n 4 "${facts.ws}/crackio-install.log" 2>/dev/null`, { timeoutMs: 30_000, signal }).catch(() => null);
    if (!look) {
      // Three looks in a row unanswered: the box's other way in (vast.ai's proxy), when it has one that answers.
      if (++missed >= 3 && reroute) {
        const next = await reroute().catch(() => null);
        if (next) {
          report(`its SSH at ${login.host} stopped answering, so Crackio carries on through ${next.host}`);
          login = next;
        }
        missed = 0;
      }
      continue;
    }
    missed = 0;
    const [statusLine, logPart = ""] = look.stdout.split("--log--");
    const [stage, ...rest] = statusLine.trim().split("|");
    const detail = rest.join("|");
    const tail = logPart.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 140) ?? "";
    if (stage === "error") throw new Error(`Installing ComfyUI on the box stopped: ${detail}. Last lines: ${logPart.trim().slice(-400)}`);
    const words = `${STAGES[stage] ?? stage}${detail ? `: ${detail}` : ""}${tail && stage !== "done" ? ` · ${tail}` : ""}`;
    if (words !== last) report((last = words));
    if (stage === "done") {
      const dir = `${facts.ws}/ComfyUI`;
      return { dir, port: BOX_PORT, python: `${facts.ws}/crackio-venv/bin/python`, plan };
    }
  }
  throw new Error("Installing ComfyUI on the box took over 40 minutes. Its log is crackio-install.log in " + facts.ws + ".");
}

/** Starts a ComfyUI Crackio installed there (after the box restarted, or right after its install). */
export async function startComfyOnBox(login: SshLogin, facts: BoxFacts, at: { dir: string; port: number; python: string }) {
  const res = await sshRun(login, startScript(facts, at.dir, at.python, at.port), { timeoutMs: 60_000 });
  if (!res.stdout.includes("CRACKIO_STARTED")) throw new Error(`Couldn't start ComfyUI on the box: ${(res.stderr || res.stdout).slice(-300)}`);
  return res.stdout.includes("supervisor") ? "under its supervisor" : "kept running by Crackio's loop";
}
