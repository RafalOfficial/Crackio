"""Crackio on a Google Colab GPU. The one cell in colab/Crackio.ipynb runs this file.

What it does, in order:
  1. checks the runtime has a GPU and room on its disk
  2. puts Crackio and ComfyUI on the runtime (Node.js and Python packages; nothing leaves the runtime)
  3. starts ComfyUI, Crackio and a small door in front of Crackio (colab/gate.py), all three only on the runtime itself
  4. opens one web link to that door and shows it as a button; the link carries a key made new for this session
  5. stays running: it keeps the runtime awake and starts again whatever stops

Run it again at any time (press play again): what is already there is kept, so it is back in seconds with the same link.
Everything lives in /content and is gone when the runtime ends, your pictures included: download what you want to keep.
"""
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
BASE = Path("/content") if Path("/content").is_dir() else APP.parent
STATE = BASE / "crackio-colab"
LOGS = STATE / "logs"
COMFY = BASE / "ComfyUI"
DATA = BASE / "crackio-data"
COMFY_PORT, APP_PORT, GATE_PORT, TUNNEL_PORT = 8188, 3000, 8190, 8191
COMFY_REPO = "https://github.com/Comfy-Org/ComfyUI"
ARCH = {"x86_64": ("x64", "amd64"), "aarch64": ("arm64", "arm64")}.get(platform.machine(), ("x64", "amd64"))
LINK = re.compile(r"https://(?!api\.)([a-z0-9-]+\.trycloudflare\.com)")
STOP_NOTE = "The GPU uses Colab compute units while the runtime is on.\n  When you are done: Runtime → Disconnect and delete runtime."


class Stop(Exception):
    """Something the person reading the notebook can act on: shown as plain words, without a traceback."""


def say(text=""):
    print(text, flush=True)


def took(since):
    s = int(time.time() - since)
    return f"{s} s" if s < 90 else f"{s // 60} min {s % 60:02d} s"


def tail(path, lines=25):
    try:
        return "\n".join("    " + l for l in Path(path).read_text(errors="replace").splitlines()[-lines:])
    except OSError:
        return "    (no log)"


def run(cmd, log, what, cwd=None, env=None, tries=1):
    """Runs one step with its output in a log file; a step that fails says so with the log's last lines."""
    for attempt in range(tries):
        with open(LOGS / log, "ab") as out:
            code = subprocess.call([str(c) for c in cmd], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
        if code == 0:
            return
        if attempt + 1 < tries:
            time.sleep(5)
    raise Stop(f"{what} didn't work. The last lines it wrote:\n{tail(LOGS / log)}")


def output(cmd, timeout=60, cwd=None):
    try:
        res = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL)
        return res.stdout.strip() if res.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def spawn(cmd, log, cwd=None, env=None):
    """Starts a program in its own session, so stopping the notebook's cell doesn't stop it."""
    out = open(LOGS / log, "ab")
    try:
        return subprocess.Popen([str(c) for c in cmd], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        out.close()


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def fetch(url, timeout=10, headers=None):
    """(status, text) of a GET; (0, "") when nothing answers."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "crackio-colab", **(headers or {})})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read(200_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def wait_for(check, seconds, every=2):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return True
        time.sleep(every)
    return bool(check())


def download(url, to, what):
    part = Path(str(to) + ".part")
    run(["curl", "-fsSL", "--retry", "4", "--retry-delay", "3", "--connect-timeout", "20", "-o", part, url], "download.log", f"Downloading {what}", tries=2)
    part.replace(to)


def alive(pid_file, word):
    """The pid in a file, when that process still runs and its command line has `word` in it."""
    try:
        pid = int(Path(pid_file).read_text().strip())
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
        return pid if word in cmd else None
    except (OSError, ValueError):
        return None


def stop(pid_file, word):
    pid = alive(pid_file, word)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        wait_for(lambda: not alive(pid_file, word), 15, 0.5)
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        Path(pid_file).unlink()
    except OSError:
        pass


# ------------------------------------------------------------------ the runtime


def look_at_runtime():
    gpus = [l.split(",") for l in output(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], 30).splitlines() if "," in l]
    if not gpus:
        raise Stop("This runtime has no GPU. In Colab's menu choose Runtime → Change runtime type, pick a GPU (L4 is a good one), save, then press play again.")
    name, mem = gpus[0][0].strip(), gpus[0][1].strip()
    ram = 0.0
    try:
        ram = int(re.search(r"MemTotal:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1)) / 1024 / 1024
    except (OSError, AttributeError, ValueError):
        pass
    free = shutil.disk_usage(BASE).free / 1024**3
    say(f"  GPU: {name} with {round(int(mem) / 1024) if mem.isdigit() else mem} GB · memory {ram:.0f} GB · disk {free:.0f} GB free")
    if free < 12 and not (APP / ".next" / "BUILD_ID").exists():
        raise Stop(f"Only {free:.0f} GB of disk is free here, and Crackio with ComfyUI needs about 12 GB before any model. Start a new runtime (Runtime → Disconnect and delete runtime), then press play again.")
    return ram


def ensure_node():
    """Node.js 22.13 or newer: the runtime's own when it is new enough, else nodejs.org's (checked against its checksum)."""
    own = STATE / "node" / "bin"
    if (own / "node").exists():
        os.environ["PATH"] = f"{own}{os.pathsep}{os.environ.get('PATH', '')}"

    def version():
        v = output(["node", "-p", "process.versions.node"], 20)
        try:
            a, b = (int(x) for x in v.split(".")[:2])
            return (a, b), v
        except ValueError:
            return (0, 0), ""

    if version()[0] >= (22, 13):
        return version()[1]
    base = "https://nodejs.org/dist/latest-v22.x/"
    sums = ""
    for _ in range(3):
        status, sums = fetch(base + "SHASUMS256.txt", 30)
        if status == 200:
            break
        time.sleep(4)
    found = re.search(rf"^([0-9a-f]{{64}})\s+(node-v[\d.]+-linux-{ARCH[0]}\.tar\.xz)$", sums, re.M)
    if not found:
        raise Stop("Node.js couldn't be downloaded (nodejs.org didn't answer). Press play again in a minute.")
    digest, name = found.groups()
    pack = STATE / name
    download(base + name, pack, "Node.js")
    if hashlib.sha256(pack.read_bytes()).hexdigest() != digest:
        pack.unlink()
        raise Stop("The Node.js download arrived damaged. Press play again.")
    shutil.rmtree(STATE / "node", ignore_errors=True)
    (STATE / "node").mkdir(parents=True)
    run(["tar", "-xJf", pack, "-C", STATE / "node", "--strip-components=1"], "download.log", "Unpacking Node.js")
    pack.unlink()
    os.environ["PATH"] = f"{own}{os.pathsep}{os.environ.get('PATH', '')}"
    if version()[0] < (22, 13):
        raise Stop("Node.js didn't install. Press play again.")
    return version()[1]


def ensure_pnpm():
    """pnpm, in the version Crackio names, in a folder of its own."""
    want = json.loads((APP / "package.json").read_text())["packageManager"].split("@")[1].split("+")[0]
    exe = STATE / "npm" / "bin" / "pnpm"
    if output([exe, "--version"], 30) != want:
        run(["npm", "install", "-g", "--prefix", STATE / "npm", "--no-fund", "--no-audit", f"pnpm@{want}"], "pnpm.log", "Installing pnpm", tries=3)
    return exe


def ensure_cloudflared():
    exe = STATE / "cloudflared"
    if not output([exe, "--version"], 20):
        download(f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{ARCH[1]}", exe, "the link program (cloudflared)")
        exe.chmod(0o755)
        if not output([exe, "--version"], 20):
            raise Stop("The link program (cloudflared) doesn't run here. Press play again.")
    return exe


# ------------------------------------------------------------------ Crackio


def commit():
    return output(["git", "-C", APP, "rev-parse", "HEAD"], 20) or "unknown"


def build_crackio(pnpm, ram):
    stamp = STATE / "built"
    if (APP / ".next" / "BUILD_ID").exists() and stamp.exists() and stamp.read_text().strip() == commit():
        return
    t = time.time()
    run([pnpm, "install", "--frozen-lockfile"], "install.log", "Installing Crackio's packages", cwd=APP, env={**os.environ, "CI": "1"}, tries=2)
    say(f"  Crackio's packages are in ({took(t)})")
    t = time.time()
    # The build may use most of the memory, never all of it (a small runtime has 12 GB for everything).
    heap = max(3072, min(8192, int(ram * 1024 * 0.6))) if ram else 6144
    env = {**os.environ, "NODE_OPTIONS": f"--max-old-space-size={heap}", "NEXT_TELEMETRY_DISABLED": "1"}
    run(["node", "node_modules/next/dist/bin/next", "build"], "build.log", "Building Crackio", cwd=APP, env=env)
    stamp.write_text(commit())
    say(f"  Crackio is built ({took(t)})")


def app_env(host):
    return {**os.environ, "CRACKIO_ALLOWED_ORIGINS": host, "CRACKIO_DATA_DIR": str(DATA), "UV_THREADPOOL_SIZE": "16", "NEXT_TELEMETRY_DISABLED": "1"}


def start_crackio(host):
    """Crackio answers only under names it knows: it is started with the link's name, and again when the link changes."""
    if port_open(APP_PORT) and (STATE / "host").exists() and (STATE / "host").read_text().strip() == host:
        return
    stop(STATE / "app.pid", "next")
    subprocess.call(["pkill", "-f", "next-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for(lambda: not port_open(APP_PORT), 20, 0.5)
    DATA.mkdir(parents=True, exist_ok=True)
    p = spawn(["node", "node_modules/next/dist/bin/next", "start", "-p", APP_PORT, "-H", "127.0.0.1"], "crackio.log", cwd=APP, env=app_env(host))
    (STATE / "app.pid").write_text(str(p.pid))
    (STATE / "host").write_text(host)


def crackio_ready():
    return fetch(f"http://127.0.0.1:{APP_PORT}/api/generations?limit=1", 10)[0] == 200


def start_gate():
    if port_open(GATE_PORT):
        return
    p = spawn([sys.executable, APP / "colab" / "gate.py", GATE_PORT, APP_PORT, STATE / "key", STATE / "host"], "gate.log")
    (STATE / "gate.pid").write_text(str(p.pid))


def make_key():
    f = STATE / "key"
    if not f.exists() or len(f.read_text().strip()) < 32:
        f.write_text(secrets.token_urlsafe(24))
        f.chmod(0o600)
    return f.read_text().strip()


# ------------------------------------------------------------------ ComfyUI


def install_comfy():
    t = time.time()
    new = False
    if not (COMFY / "main.py").exists():
        new = True
        shutil.rmtree(COMFY, ignore_errors=True)
        # The newest release, read with git itself (GitHub's API turns shared addresses like Colab's away).
        tags = output(["git", "ls-remote", "--tags", "--refs", "--sort=-v:refname", COMFY_REPO, "v*"], 60).splitlines()
        tag = tags[0].split("refs/tags/")[-1] if tags else ""
        try:
            run(["git", "clone", "-q", "--depth", "1", *(["--branch", tag] if tag else []), COMFY_REPO, COMFY], "comfy-install.log", "Getting ComfyUI", tries=2)
        except Stop:
            shutil.rmtree(COMFY, ignore_errors=True)
            run(["git", "clone", "-q", "--depth", "1", COMFY_REPO, COMFY], "comfy-install.log", "Getting ComfyUI", tries=2)
    req = COMFY / "requirements.txt"
    mark, digest = STATE / "comfy-packages", hashlib.sha256(req.read_bytes()).hexdigest()
    if not mark.exists() or mark.read_text().strip() != digest:
        new = True
        # Colab comes with a PyTorch that runs its GPU: ComfyUI's packages go in around it, and it stays as it is.
        pins = output([sys.executable, "-c", "import torch, torchvision\nprint('torch==' + torch.__version__.split('+')[0])\nprint('torchvision==' + torchvision.__version__.split('+')[0])\ntry:\n    import torchaudio\n    print('torchaudio==' + torchaudio.__version__.split('+')[0])\nexcept Exception:\n    pass"], 120)
        (STATE / "constraints.txt").write_text(pins + "\n" if pins else "")
        run([sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", req, "-c", STATE / "constraints.txt"], "comfy-install.log", "Installing ComfyUI's packages", tries=2)
        mark.write_text(digest)
    if not comfy_pid():
        # Crackio's helper: the custom node Crackio talks to (models, set-ups, training).
        helper = COMFY / "custom_nodes" / "crackio_bridge"
        shutil.rmtree(helper, ignore_errors=True)
        shutil.copytree(APP / "comfyui" / "crackio_bridge", helper, ignore=shutil.ignore_patterns("__pycache__"))
    if new:
        say(f"  ComfyUI is in ({took(t)})")


def comfy_pid():
    """A ComfyUI that is running or still loading (also one Crackio's helper started again after a set-up)."""
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            cmd = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if b"main.py" in cmd and str(COMFY_PORT).encode() in cmd and b"--port" in cmd:
            return int(entry.name)
    return None


def start_comfy():
    if port_open(COMFY_PORT) or comfy_pid():
        return
    spawn([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", COMFY_PORT], "comfyui.log", cwd=COMFY)


def comfy_ready():
    return fetch(f"http://127.0.0.1:{COMFY_PORT}/system_stats", 5)[0] == 200


# ------------------------------------------------------------------ the link


def tunnel_host():
    try:
        found = LINK.findall((LOGS / "tunnel.log").read_text(errors="replace"))
        return found[-1] if found else None
    except OSError:
        return None


def tunnel_ready():
    """cloudflared's own word on whether it holds a connection (asked on the runtime itself, no web look-up)."""
    status, text = fetch(f"http://127.0.0.1:{TUNNEL_PORT}/ready", 5)
    try:
        return status == 200 and json.loads(text).get("readyConnections", 0) > 0
    except ValueError:
        return False


def open_tunnel(cloudflared, fresh=False):
    """One web link to the door. Returns its host name, or None when Cloudflare gives no link."""
    if not fresh and alive(STATE / "tunnel.pid", "cloudflared") and tunnel_host():
        return tunnel_host()
    for attempt in range(1, 4):
        stop(STATE / "tunnel.pid", "cloudflared")
        (LOGS / "tunnel.log").write_text("")
        # http2: cloudflared's default connection type is slow from Colab (0.1 MB/s measured against 4 to 5).
        p = spawn([cloudflared, "tunnel", "--url", f"http://127.0.0.1:{GATE_PORT}", "--no-autoupdate", "--protocol", "http2", "--metrics", f"127.0.0.1:{TUNNEL_PORT}"], "tunnel.log")
        (STATE / "tunnel.pid").write_text(str(p.pid))
        if wait_for(lambda: tunnel_host() or p.poll() is not None, 45, 1) and tunnel_host():
            wait_for(tunnel_ready, 30, 1)
            return tunnel_host()
        say(f"  Cloudflare gave no link yet (try {attempt} of 3) ...")
        time.sleep(6 * attempt)
    stop(STATE / "tunnel.pid", "cloudflared")
    return None


def colab_address():
    """Colab's own address for a port on the runtime: opens only in this browser, signed in as you."""
    try:
        from google.colab.output import eval_js

        return str(eval_js(f"google.colab.kernel.proxyPort({GATE_PORT})")).rstrip("/")
    except Exception:
        return None


def show(address, key, note):
    link = f"{address}/__gate#{key}"
    try:
        from IPython import get_ipython
        from IPython.display import HTML, display

        if get_ipython() is None:
            raise ImportError
        display(HTML(
            '<div style="margin:14px 0 6px;font-family:system-ui,sans-serif">'
            f'<a href="{link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 30px;border-radius:12px;background:#ff5b2e;color:#1a0e08;font-weight:700;font-size:17px;text-decoration:none">Open Crackio</a>'
            f'<div style="margin-top:10px;font-size:13px;line-height:1.5;max-width:640px;opacity:.8">{note}</div>'
            # The button lets you in by itself. The key is shown for the one case a page asks for it (the address opened
            # without the button, in another browser say).
            '<div style="margin-top:8px;font-size:13px;line-height:1.5;opacity:.8">The button lets you in by itself. If a page ever asks for a key, it is: '
            f'<code style="user-select:all;padding:2px 7px;border-radius:6px;background:rgba(127,127,127,.2);font-size:13px">{key}</code></div></div>'
        ))
    except ImportError:
        say(f"\n  Open Crackio: {link}\n  {note}\n  If a page asks for a key, it is: {key}\n")


# ------------------------------------------------------------------ start, then keep running

PRIVATE = "This link is private and only for you: anyone who has it can use this Crackio, so don't share it. It works until the runtime ends. Leave this cell running."
OWN = "Cloudflare gave no link, so this is Colab's own address: slower, and it only opens in this browser, signed in to Google as you. For the faster link, press play again in a few minutes. Leave this cell running."


def start():
    began = time.time()
    say("Crackio on Colab\n")
    LOGS.mkdir(parents=True, exist_ok=True)
    ram = look_at_runtime()

    first = not (APP / ".next" / "BUILD_ID").exists()
    say("\n1/3  Setting up" + (" (about 2 minutes the first time)" if first else ""))
    node = ensure_node()
    pnpm = ensure_pnpm()
    cloudflared = ensure_cloudflared()
    say(f"  Node.js {node} and the link program are ready")
    # ComfyUI goes in (and starts loading) while Crackio builds.
    failed = []

    def comfy_side():
        try:
            install_comfy()
            start_comfy()
        except BaseException as e:  # shown by the main thread
            failed.append(e)

    side = threading.Thread(target=comfy_side, daemon=True)
    side.start()
    try:
        build_crackio(pnpm, ram)
    finally:
        side.join()
    if failed:
        raise failed[0]

    say("\n2/3  Starting")
    key = make_key()
    host = open_tunnel(cloudflared)
    address, note = (f"https://{host}", PRIVATE) if host else (None, OWN)
    if not host:
        address = colab_address()
        if not address:
            raise Stop("No web link could be opened: Cloudflare gave none (it limits how many it hands out) and Colab's own didn't answer. Press play again in a few minutes.")
        host = address.split("://", 1)[-1]
    start_crackio(host)
    start_gate()
    if not wait_for(crackio_ready, 150):
        raise Stop(f"Crackio didn't start. The last lines it wrote:\n{tail(LOGS / 'crackio.log')}")
    say("  Crackio is running")
    if not wait_for(comfy_ready, 420, 3):
        raise Stop(f"ComfyUI didn't start. The last lines it wrote:\n{tail(LOGS / 'comfyui.log', 40)}")
    say("  ComfyUI is running")
    if note is PRIVATE and not wait_for(lambda: fetch(f"{address}/__gate/ping", 10)[1].strip() == "crackio-gate", 60, 3):
        say("  The link is new: it may need a minute before it opens.")

    say(f"\n3/3  Ready in {took(began)}")
    show(address, key, note)
    say("  First time here? Open Settings in Crackio and set up a tool: its model downloads to this runtime.")
    say(f"  Everything is gone when the runtime ends, your pictures too: download what you want to keep.\n  {STOP_NOTE}")
    return cloudflared, host, key, note is PRIVATE


def keep_running(cloudflared, host, key, tunnelled):
    """Keeps the cell busy (an idle runtime is taken away) and starts again whatever stops."""
    comfy_down = link_down = 0
    retry_at = 0.0
    began = last_note = time.time()
    while True:
        time.sleep(15)
        if port_open(COMFY_PORT) or comfy_pid():
            comfy_down = 0
        else:
            comfy_down += 1
            if comfy_down >= 2:
                say("  ComfyUI stopped (a job that needs more memory than the runtime has does that). Starting it again ...")
                start_comfy()
                comfy_down = 0
        if not port_open(APP_PORT):
            say("  Crackio stopped. Starting it again ...")
            (STATE / "host").unlink(missing_ok=True)
            start_crackio(host)
        if not port_open(GATE_PORT):
            start_gate()
        if tunnelled:
            link_down = 0 if tunnel_ready() else link_down + 1
            if time.time() >= retry_at and (link_down >= 12 or (link_down and not alive(STATE / "tunnel.pid", "cloudflared"))):
                say("  The link stopped answering. Opening a new one ...")
                new = open_tunnel(cloudflared, fresh=True)
                link_down = 0
                if new:
                    host = new
                    start_crackio(host)
                    wait_for(crackio_ready, 120)
                    say("  The old link no longer works. This is the new one:")
                    show(f"https://{host}", key, PRIVATE)
                else:
                    # Cloudflare limits how many links it hands out: ask again later, not every few seconds.
                    retry_at = time.time() + 300
                    say("  Cloudflare gave no new link. Crackio keeps running here; trying again in 5 minutes.")
        if time.time() - last_note >= 3600:
            last_note = time.time()
            say(f"  Still running, {int((time.time() - began) // 3600)} h so far.\n  {STOP_NOTE}")


def main():
    try:
        keep_running(*start())
    except Stop as e:
        say(f"\n  Crackio didn't start: {e}\n\n  The full logs are in {LOGS}.")
    except KeyboardInterrupt:
        say(f"\n  This cell stopped. Crackio itself keeps running: press play again to see its link.\n  {STOP_NOTE}")


if __name__ == "__main__":
    main()
