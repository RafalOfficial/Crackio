"""
LFM3-VL's setup (bridge 1.9.2): what LFM3-VL (lfm3.py) needs on this machine and what's there, so Crackio can set it
up in one go: its two files in models/lfm3 (Crackio fetches them through /crackio/download, checksums included),
Crackio's fine-tunes beside them, and transformers 5.21 or newer (under 6) in ComfyUI's own Python. ComfyUI imports
transformers itself when it starts, so a newer one runs only after a restart (POST /crackio/restart).

  GET  /crackio/lfm3/setup     its files and fine-tunes here, transformers installed and in use, the packages job
  POST /crackio/lfm3/packages  transformers brought into range, in the background (GET says how it went)

Kept apart from lfm3.py, which needs that transformers to load at all: these routes answer on any.
"""

import os
import re
import shutil
import subprocess
import sys
import threading
import time

import folder_paths
from aiohttp import web
from server import PromptServer

FOLDER = "lfm3"
WEIGHTS = "lfm3-vl-2b.safetensors"
TOKENIZER = "lfm3-vl-2b-tokenizer.json"
LORA = re.compile(r"^lfm3-vl-2b-lora-([\w.-]+)\.safetensors$")
WANT = ">=5.21,<6"
# What updating it takes where the packages are: the new one beside the old until pip swaps them (~120 MB on the PC).
NEED_BYTES = 200_000_000
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# The folder, known even when lfm3.py didn't load (the same path it adds), so its files can download first.
if FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(FOLDER, os.path.join(folder_paths.models_dir, FOLDER))

_lock = threading.Lock()
_job = {"state": "idle", "error": None, "upgraded": None, "log": "", "started": None, "finished": None}


def _fits(version):
    nums = [int(x) for x in re.findall(r"\d+", version or "")[:2]]
    return len(nums) == 2 and (5, 21) <= tuple(nums) < (6, 0)


def _transformers():
    """transformers' version installed (what ComfyUI loads when it next starts) and the one it runs now (None: not loaded)."""
    from importlib import metadata

    try:
        disk = metadata.version("transformers")
    except metadata.PackageNotFoundError:
        disk = None
    mod = sys.modules.get("transformers")
    return disk, (getattr(mod, "__version__", None) if mod else None)


def _where():
    """Where /crackio/download puts LFM3-VL's files."""
    try:
        from . import _target_dir

        return _target_dir(FOLDER)
    except Exception:
        return folder_paths.get_folder_paths(FOLDER)[0]


def _free(path):
    p = os.path.abspath(path)
    while not os.path.exists(p) and os.path.dirname(p) != p:
        p = os.path.dirname(p)
    try:
        return shutil.disk_usage(p).free
    except OSError:
        return None


def status():
    names = set()
    for p in folder_paths.get_folder_paths(FOLDER):
        if os.path.isdir(p):
            try:
                names.update(os.listdir(p))
            except OSError:
                pass
    disk, used = _transformers()
    where = _where()
    with _lock:
        job = {k: _job[k] for k in ("state", "error", "upgraded")}
    return {
        "weights": WEIGHTS in names,
        "tokenizer": TOKENIZER in names,
        "loras": sorted(m.group(1) for m in map(LORA.match, names) if m),
        "transformers": disk,
        "transformers_used": used,
        "transformers_ok": _fits(disk),
        # Installed but not the one this ComfyUI runs: a restart brings it.
        "restart": bool(disk and used and disk != used),
        "want": WANT,
        "folder": where,
        "disk_free": _free(where),
        "packages": job,
    }


def _pip():
    """pip in ComfyUI's own Python; uv's pip where that Python has none (the vast.ai images)."""
    if subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True, timeout=60, creationflags=NO_WINDOW).returncode == 0:
        return [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", sys.executable]
    raise RuntimeError("ComfyUI's Python has no pip, and there's no uv to use instead.")


def _upgrade():
    try:
        before, _ = _transformers()
        # Room where ComfyUI's packages are: pip's own "No space left on device" doesn't say which disk.
        import sysconfig

        site = sysconfig.get_paths()["purelib"]
        free = _free(site)
        if free is not None and free < NEED_BYTES:
            raise RuntimeError(f"There's {free / 1e6:.0f} MB free where ComfyUI's Python keeps its packages ({site}); updating transformers needs about {NEED_BYTES // 1_000_000} MB.")
        # Only transformers and what it needs moved (pip's default only-if-needed): torch and the rest stay as they are.
        r = subprocess.run([*_pip(), f"transformers{WANT}"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=NO_WINDOW)
        after, _ = _transformers()
        log = (r.stdout[-1500:] + "\n" + r.stderr[-1500:]).strip()
        if r.returncode != 0 or not _fits(after):
            # Windows won't replace a package's compiled files while ComfyUI has them open.
            locked = re.search(r"WinError (5|32)|Access is denied|being used by another process", log)
            hint = f' Close ComfyUI, run "{sys.executable}" -m pip install "transformers{WANT}", then start it again.' if locked else ""
            tail = log.splitlines()[-1][:200] if log else ""
            raise RuntimeError(f"pip couldn't bring transformers to {WANT} (it has {after or 'none'}).{hint}" + (f" pip said: {tail}" if tail and not hint else ""))
        with _lock:
            _job.update(state="done", upgraded=f"{before or 'none'} → {after}" if before != after else None, log=log)
        print(f"[crackio_bridge] LFM3-VL: transformers {before} → {after} (ComfyUI runs it after a restart)")
    except Exception as e:
        with _lock:
            _job.update(state="error", error=str(e)[:600])
        print(f"[crackio_bridge] LFM3-VL: transformers not upgraded: {e}")
    finally:
        with _lock:
            _job["finished"] = time.time()


@PromptServer.instance.routes.get("/crackio/lfm3/setup")
async def setup_status(request):
    return web.json_response(status())


@PromptServer.instance.routes.post("/crackio/lfm3/packages")
async def packages(request):
    disk, _ = _transformers()
    with _lock:
        start = _job["state"] != "running" and not _fits(disk)
        if start:
            _job.update(state="running", error=None, upgraded=None, log="", started=time.time(), finished=None)
    if start:
        threading.Thread(target=_upgrade, daemon=True, name="lfm3-packages").start()
    return web.json_response(status())
