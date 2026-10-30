"""
Crackio bridge: lets Crackio see what this ComfyUI machine can run and install models
into it, wherever ComfyUI runs (your own computer, another PC on your network, a rented GPU).

Routes under /crackio:
  GET  /crackio/info                 this machine: CPU, RAM, GPUs (memory, compute capability), free disk
  GET  /crackio/live                 the GPU now: how busy other apps keep it, memory in use, its PCIe link
  POST /crackio/download             {url, folder, filename, sha256?, token?} fetch a model file into a model folder
  GET  /crackio/downloads            every download since ComfyUI started, with its progress
  POST /crackio/downloads/{id}/stop  stop one
  POST /crackio/delete               {folder, filename} remove a model file
  GET  /crackio/files                every model file in each model folder, any format (ComfyUI's own lists skip .gguf)
  GET  /crackio/nodes                which of the custom nodes Crackio knows are installed and loaded
  POST /crackio/nodes/install        {name} clone one of those into custom_nodes and install its packages (only the
                                     missing ones: nothing already installed changes version)
  POST /crackio/restart              restart ComfyUI in place, so new nodes load
  /crackio/pool...                   one model split across two computers' GPUs (pool.py, with its node
                                     "Crackio Pool Loader (GGUF)")

Nodes for small GPUs (small.py): "Crackio Window Attention" (after the first step each frame of a SCAIL-2 clip attends
to its neighbours, about a third of the attention work), "Crackio FP16 On Old GPUs" and "Crackio Resample Frames".

Downloads come in 16 parallel byte ranges (one connection to Hugging Face's CDN often tops out at a few MB/s), three
files at a time in the order asked, land as <name>.part, and only take their real name once every byte arrived and the
SHA-256 matches.
Only https links from model hosts are accepted, into ComfyUI's own model folders, as model files.
"""
import hashlib
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import folder_paths
from aiohttp import web
from server import PromptServer

VERSION = "1.6.0"
WORKERS = 16
CHUNK = 64 * 1024 * 1024
HOSTS = ("huggingface.co", "hf.co", "github.com", "objects.githubusercontent.com", "modelscope.cn", "civitai.com")
EXTENSIONS = (".safetensors", ".gguf", ".pt", ".pth", ".bin", ".ckpt", ".onnx", ".sft")
NAME = re.compile(r"^[\w.\-+ ()\[\]]{1,200}$")

from . import mac, pool, small

NODE_CLASS_MAPPINGS = {**pool.NODE_CLASS_MAPPINGS, **small.NODE_CLASS_MAPPINGS, **mac.NODE_CLASS_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**pool.NODE_DISPLAY_NAME_MAPPINGS, **small.NODE_DISPLAY_NAME_MAPPINGS, **mac.NODE_DISPLAY_NAME_MAPPINGS}
mac.start()

# Custom nodes Crackio's recipes use, by the name Crackio asks for: where they come from, and a node that proves
# they loaded. Only these can be installed through the bridge.
KNOWN_NODES = {
    "ComfyUI-GGUF": {"repo": "https://github.com/city96/ComfyUI-GGUF", "proof": "UnetLoaderGGUF"},
    # FlashVSR+ (Apache-2.0), at the commit Crackio tested. Its requirements.txt lists torch, pins nothing and names
    # training packages it never imports (held to the installed versions, pip walked back to a 2021 `datasets` whose
    # pyarrow wouldn't build); its imports need diffusers and loguru, which it doesn't list. So the packages are the
    # ones its nodes import, found on a fresh vast.ai ComfyUI box, each installed only when missing. Its Triton
    # attention kernel, the fast path on RTX cards, goes in where Triton runs.
    "ComfyUI_FlashVSR": {
        "repo": "https://github.com/smthemex/ComfyUI_FlashVSR",
        "commit": "153cf03343a116c85aee40d291125921cc33935a",
        "proof": "FlashVSR_SM_Model",
        "packages": ["diffusers", "loguru", "imageio", "imageio-ffmpeg", "ftfy", "opencv-python-headless", "einops", "safetensors"],
        "kernels": ["operators/flashvsr_attn"],
    },
}

# FlashVSR+'s model folder, known before its node is, so its files can download first (the node adds the same path).
if "FlashVSR" not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path("FlashVSR", os.path.join(folder_paths.models_dir, "FlashVSR"))


class CrackioFlashVSRTriton:
    """Registered only where FlashVSR+'s Triton attention kernel imports: Crackio's recipe then asks for it rather than
    PyTorch's own attention (the same result, built from dense masks, slower and bigger)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "Crackio"

    def run(self):
        return ()


try:
    import importlib.util

    if importlib.util.find_spec("flashvsr_attn") is not None and importlib.util.find_spec("triton") is not None:
        NODE_CLASS_MAPPINGS["CrackioFlashVSRTriton"] = CrackioFlashVSRTriton
        NODE_DISPLAY_NAME_MAPPINGS["CrackioFlashVSRTriton"] = "Crackio FlashVSR Triton (marker)"
except (ImportError, ValueError):
    pass

_downloads = {}
_lock = threading.Lock()


_cpu = []


def _cpu_model():
    if not _cpu:
        _cpu.append(_read_cpu_model())
    return _cpu[0]


def _read_cpu_model():
    try:
        if platform.system() == "Darwin":
            return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5).stdout.strip()
        if platform.system() == "Windows":
            import winreg

            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or platform.machine()


def _gpus():
    out = []
    try:
        import torch

        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                out.append({"name": p.name, "memory": p.total_memory, "compute": float(f"{p.major}.{p.minor}"), "backend": "rocm" if torch.version.hip else "cuda"})
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            # A Mac's GPU core count sets its speed as much as its chip does (an M4 Max has 32 or 40).
            out.append({"name": _cpu_model(), "memory": None, "compute": None, "backend": "mps", "cores": mac.gpu_cores(wait=False)})
        elif hasattr(torch, "xpu") and torch.xpu.is_available():
            for i in range(torch.xpu.device_count()):
                p = torch.xpu.get_device_properties(i)
                out.append({"name": p.name, "memory": p.total_memory, "compute": None, "backend": "xpu"})
    except Exception:
        pass
    return out


@PromptServer.instance.routes.get("/crackio/info")
async def info(request):
    import psutil

    try:
        disk = shutil.disk_usage(folder_paths.models_dir)
        free, total = disk.free, disk.total
    except Exception:
        free = total = None
    return web.json_response(
        {
            "version": VERSION,
            "os": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
            "cpu": {"model": _cpu_model(), "threads": os.cpu_count()},
            "ram_total": psutil.virtual_memory().total,
            "disk_free": free,
            "disk_total": total,
            "gpus": _gpus(),
        }
    )


_live = {"at": 0.0, "idle_util": None, "data": None}


def _nvidia_live():
    """The GPU now, from nvidia-smi: how busy it is, memory in use, the PCIe link its slot gives it (None without NVIDIA's
    tools). The link's maximum, not its current speed: an idle card drops its link to save power."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,pcie.link.gen.max,pcie.link.width.max", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip().splitlines()
        util, used, total, gen, width = [x.strip() for x in out[0].split(",")]
        num = lambda x: float(x) if re.match(r"^\d+(\.\d+)?$", x) else None
        return {"util": num(util), "memory_used": num(used), "memory_total": num(total), "pcie_gen": num(gen), "pcie_width": num(width)}
    except Exception:
        return None


@PromptServer.instance.routes.get("/crackio/live")
async def live(request):
    """What Crackio's time estimates allow for: how busy other apps keep the GPU (read while ComfyUI itself is idle; the
    last idle reading while it works), its memory in use, its PCIe link. Read at most every 5 seconds."""
    import asyncio

    now = time.time()
    if not _live["data"] or now - _live["at"] > 5:
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(None, _nvidia_live)
        # A Mac: how hot macOS says it is, and its battery (mac.py's cooling reads the same).
        heat = await loop.run_in_executor(None, mac.health) if mac.on_mac() else None
        try:
            working = PromptServer.instance.prompt_queue.get_tasks_remaining() > 0
        except Exception:
            working = False
        if data and not working and data.get("util") is not None:
            _live["idle_util"] = data["util"]
        _live.update(at=now, data={**(data or {}), "comfy_working": working, "others_util": _live["idle_util"], **({"mac": heat} if heat else {})})
    return web.json_response({"version": VERSION, **_live["data"]})


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _resolve(url, token):
    """The final download link, the size and (for Hugging Face LFS files) the SHA-256 behind a model URL."""
    headers = {"User-Agent": "crackio-bridge"}
    if token and urlparse(url).hostname in ("huggingface.co", "hf.co"):
        headers["Authorization"] = f"Bearer {token}"
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(6):
        req = urllib.request.Request(url, method="HEAD", headers=headers)
        try:
            res = opener.open(req, timeout=30)
            h, location = res.headers, None
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                raise IOError(f"{e.code} from {urlparse(url).hostname}" + (" (gated: accept the licence and add a token)" if e.code in (401, 403) else ""))
            h, location = e.headers, e.headers.get("Location")
        size = int(h.get("X-Linked-Size") or 0)
        sha = (h.get("X-Linked-ETag") or "").strip('"')
        if location:
            location = urljoin(url, location)
            if size:  # Hugging Face's own answer carries the size and hash; the CDN link is what we fetch.
                return location, size, sha if re.fullmatch(r"[0-9a-f]{64}", sha) else None
            url = location
            headers.pop("Authorization", None)
            continue
        size = size or int(h.get("Content-Length") or 0)
        return url, size, sha if re.fullmatch(r"[0-9a-f]{64}", sha) else None
    raise IOError("too many redirects")


def _target_dir(folder):
    paths = folder_paths.get_folder_paths(folder)
    if not paths:
        raise ValueError(f"unknown model folder {folder}")
    # The folder named like its type (models/diffusion_models before the legacy models/unet).
    for p in paths:
        if os.path.basename(os.path.normpath(p)) == folder and os.path.commonpath([os.path.abspath(p), os.path.abspath(folder_paths.models_dir)]) == os.path.abspath(folder_paths.models_dir):
            return p
    return paths[0]


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(16 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# Files downloading at once; the rest wait their turn, in the order asked. Every model asked for at once (28 files of 16
# connections each) crawled at ~20 MB/s on a rented box, and no model was ready until nearly all of them were.
_slots = threading.BoundedSemaphore(3)


def _run(d):
    with _slots:
        if d["stop"]:
            d.update(state="stopped", finished=time.time())
            return
        _fetch(d)


def _fetch(d):
    part = d["target"] + ".part"
    try:
        cdn, size, sha = _resolve(d["url"], d.get("token"))
        if not size:
            raise IOError("the host didn't say how big the file is")
        d.update(total=size, state="downloading", sha256=d.get("sha256") or sha)
        os.makedirs(os.path.dirname(d["target"]), exist_ok=True)
        free = shutil.disk_usage(os.path.dirname(d["target"])).free
        if free < size + 512 * 1024 * 1024:
            raise IOError(f"not enough disk space: {size / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free")
        fd = os.open(part, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
        os.ftruncate(fd, size)
        state = {"cdn": cdn, "lock": threading.Lock()}
        ranges = [(s, min(size - 1, s + CHUNK - 1)) for s in range(0, size, CHUNK)]

        def fetch(start, end):
            last = None
            for attempt in range(1, 9):
                got = 0
                try:
                    if d["stop"]:
                        return
                    req = urllib.request.Request(state["cdn"], headers={"Range": f"bytes={start}-{end}", "User-Agent": "crackio-bridge"})
                    with urllib.request.urlopen(req, timeout=60) as res:
                        if res.status != 206:
                            raise IOError(f"status {res.status}")
                        pos = start
                        while not d["stop"]:
                            block = res.read(1024 * 1024)
                            if not block:
                                break
                            if hasattr(os, "pwrite"):
                                os.pwrite(fd, block, pos)
                            else:  # Windows
                                with state["lock"]:
                                    os.lseek(fd, pos, 0)
                                    os.write(fd, block)
                            pos += len(block)
                            got += len(block)
                            with _lock:
                                d["received"] += len(block)
                        if d["stop"]:
                            return
                        if pos != end + 1:
                            raise IOError("short read")
                        return
                except Exception as e:  # an expired link or a dropped connection: fetch the link again and retry
                    last = e
                    with _lock:
                        d["received"] -= got
                    if attempt >= 2:
                        try:
                            state["cdn"] = _resolve(d["url"], d.get("token"))[0]
                        except Exception:
                            pass
                    time.sleep(min(30, 3 * attempt))
            raise IOError(f"part of the file kept failing: {last}")

        try:
            with ThreadPoolExecutor(WORKERS) as pool:
                for f in [pool.submit(fetch, s, e) for s, e in ranges]:
                    f.result()
        finally:
            os.close(fd)
        if d["stop"]:
            raise InterruptedError("stopped")
        if d["sha256"]:
            d["state"] = "checking"
            if _sha256(part) != d["sha256"]:
                raise IOError("the file didn't match its checksum")
        os.replace(part, d["target"])
        d.update(state="done", received=size, finished=time.time())
    except InterruptedError:
        d.update(state="stopped", finished=time.time())
        _remove(part)
    except Exception as e:
        d.update(state="error", error=str(e)[:300], finished=time.time())
        _remove(part)


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _public(d):
    return {k: d.get(k) for k in ("id", "folder", "filename", "state", "received", "total", "error", "started", "finished")}


@PromptServer.instance.routes.post("/crackio/download")
async def download(request):
    body = await request.json()
    url, folder, filename = str(body.get("url", "")), str(body.get("folder", "")), str(body.get("filename", ""))
    host = urlparse(url).hostname or ""
    if urlparse(url).scheme != "https" or not any(host == h or host.endswith("." + h) for h in HOSTS):
        return web.json_response({"error": "Only https links from Hugging Face, GitHub, ModelScope or Civitai."}, status=400)
    if not NAME.match(filename) or not filename.lower().endswith(EXTENSIONS):
        return web.json_response({"error": "That isn't a model file name."}, status=400)
    try:
        target = os.path.join(_target_dir(folder), filename)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if os.path.exists(target):
        return web.json_response({"id": None, "state": "done", "exists": True})
    with _lock:
        for d in _downloads.values():
            if d["target"] == target and d["state"] in ("queued", "downloading", "checking"):
                return web.json_response(_public(d))
        token = str(body.get("token") or os.environ.get("HF_TOKEN") or "").strip()
        if not token:
            try:
                with open(os.path.expanduser("~/.cache/huggingface/token")) as f:
                    token = f.read().strip()
            except OSError:
                pass
        d = {"id": uuid.uuid4().hex[:12], "url": url, "folder": folder, "filename": filename, "target": target, "token": token,
             "sha256": str(body.get("sha256") or "") or None, "state": "queued", "received": 0, "total": int(body.get("size") or 0),
             "error": None, "stop": False, "started": time.time(), "finished": None}
        _downloads[d["id"]] = d
    threading.Thread(target=_run, args=(d,), daemon=True).start()
    return web.json_response(_public(d))


@PromptServer.instance.routes.get("/crackio/downloads")
async def downloads(request):
    with _lock:
        return web.json_response([_public(d) for d in _downloads.values()])


@PromptServer.instance.routes.post("/crackio/downloads/{id}/stop")
async def stop(request):
    d = _downloads.get(request.match_info["id"])
    if not d:
        return web.json_response({"error": "No such download."}, status=404)
    d["stop"] = True
    return web.json_response(_public(d))


@PromptServer.instance.routes.post("/crackio/delete")
async def delete(request):
    body = await request.json()
    folder, filename = str(body.get("folder", "")), str(body.get("filename", ""))
    if not NAME.match(filename) or not filename.lower().endswith(EXTENSIONS):
        return web.json_response({"error": "That isn't a model file name."}, status=400)
    removed = False
    for p in folder_paths.get_folder_paths(folder) or []:
        target = os.path.join(p, filename)
        if os.path.isfile(target):
            os.remove(target)
            removed = True
    return web.json_response({"removed": removed})


@PromptServer.instance.routes.get("/crackio/files")
async def files(request):
    out = {}
    for folder, entry in folder_paths.folder_names_and_paths.items():
        paths = entry[0] if isinstance(entry, (list, tuple)) else []
        names = set()
        for p in paths:
            if not os.path.isdir(p):
                continue
            for root, _, fs in os.walk(p, followlinks=True):
                for f in fs:
                    if f.lower().endswith(EXTENSIONS):
                        names.add(os.path.relpath(os.path.join(root, f), p).replace(os.sep, "/"))
        if names:
            out[folder] = sorted(names)
    return web.json_response(out)


def _custom_nodes_dir():
    return folder_paths.get_folder_paths("custom_nodes")[0]


# Written in a node's folder once Crackio's install of it finished: a folder without it may be an install cut short
# (a restart while pip ran), packages missing.
DONE_MARK = ".crackio-installed"


def _node_ready(name, loaded):
    folder = os.path.join(_custom_nodes_dir(), name)
    return os.path.isdir(folder) and (loaded or os.path.isfile(os.path.join(folder, DONE_MARK)))


@PromptServer.instance.routes.get("/crackio/nodes")
async def nodes_status(request):
    import nodes

    out = {}
    for name, info in KNOWN_NODES.items():
        loaded = info["proof"] in nodes.NODE_CLASS_MAPPINGS
        out[name] = {"installed": _node_ready(name, loaded), "loaded": loaded}
    return web.json_response(out)


def _from_zip(repo, target, log, ref="HEAD"):
    """The node at a commit (its default branch when none is pinned) as GitHub's zip, for computers without git (most
    Windows PCs)."""
    import io
    import zipfile

    with urllib.request.urlopen(urllib.request.Request(f"{repo}/archive/{ref}.zip", headers={"User-Agent": "crackio-bridge"}), timeout=300) as r:
        data = r.read()
    parent = os.path.dirname(target)
    tmp = os.path.join(parent, f".crackio-unzip-{uuid.uuid4().hex[:8]}")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extractall(tmp)
        inner = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d))]
        if len(inner) != 1:
            raise OSError("the zip didn't hold one folder")
        os.replace(os.path.join(tmp, inner[0]), target)
        log.append(f"unpacked {len(data) // 1024} KB from GitHub's zip")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _dist_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


# One OpenCV build is enough: a second one would overwrite the first's cv2.
OPENCV = {"opencv-python", "opencv-python-headless", "opencv-contrib-python", "opencv-contrib-python-headless"}


def _pip(args, timeout):
    """pip in ComfyUI's own Python; uv's pip where that Python has none (the vast.ai images)."""
    import sys

    has_pip = subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True, timeout=60).returncode == 0
    if not has_pip and shutil.which("uv"):
        return subprocess.run(["uv", "pip", "install", "--python", sys.executable, *args], capture_output=True, text=True, timeout=timeout)
    return subprocess.run([sys.executable, "-m", "pip", "install", *args], capture_output=True, text=True, timeout=timeout)


def _install_missing(packages, log):
    """The packages this Python lacks, with every one it has held at its version: a node never upgrades ComfyUI's torch,
    numpy or anything else under it."""
    import tempfile
    from importlib import metadata

    have = {}
    for d in metadata.distributions():
        name, version = (d.metadata.get("Name") or "").strip(), d.version or ""
        if name and re.fullmatch(r"[0-9][0-9A-Za-z.+!_-]*", version):
            have[_dist_name(name)] = version
    missing = [p for p in packages if _dist_name(p) not in have and not (_dist_name(p) in OPENCV and OPENCV & have.keys())]
    if not missing:
        return True
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join(f"{n}=={v}" for n, v in sorted(have.items())) + "\n")
        pins = f.name
    try:
        r = _pip(["-c", pins, *missing], 1800)
    finally:
        _remove(pins)
    log.append(r.stdout[-800:] + r.stderr[-800:])
    return r.returncode == 0


@PromptServer.instance.routes.post("/crackio/nodes/install")
async def nodes_install(request):
    import asyncio

    body = await request.json()
    name = str(body.get("name", ""))
    info = KNOWN_NODES.get(name)
    if not info:
        return web.json_response({"error": "Crackio doesn't know that node."}, status=400)
    # git and pip can take minutes: off the event loop, so ComfyUI keeps answering (and running jobs) meanwhile; and no
    # restart meanwhile, which would leave it half installed.
    global _installing
    with _lock:
        _installing += 1
    try:
        status, out = await asyncio.get_running_loop().run_in_executor(None, _install_node, name, info)
    finally:
        with _lock:
            _installing -= 1
    return web.json_response(out, status=status)


_installing = 0


def _install_node(name, info):
    import importlib.util

    target = os.path.join(_custom_nodes_dir(), name)
    commit = info.get("commit")
    log = []
    try:
        if not os.path.isdir(target):
            cloned = False
            if shutil.which("git"):
                r = subprocess.run(["git", "clone", "--depth", "1", info["repo"], target], capture_output=True, text=True, timeout=300)
                log.append(r.stdout[-500:] + r.stderr[-500:])
                cloned = r.returncode == 0
                if cloned and commit:
                    steps = [["git", "-C", target, "fetch", "--depth", "1", "origin", commit], ["git", "-C", target, "checkout", "--quiet", commit]]
                    for step in steps:
                        r = subprocess.run(step, capture_output=True, text=True, timeout=300)
                        log.append(r.stdout[-300:] + r.stderr[-300:])
                        cloned = cloned and r.returncode == 0
                if not cloned:
                    shutil.rmtree(target, ignore_errors=True)
            if not cloned:
                _from_zip(info["repo"], target, log, commit or "HEAD")
        if "packages" in info:
            if not _install_missing(info["packages"], log):
                return 500, {"error": "installing its Python packages failed", "log": log}
        else:
            req = os.path.join(target, "requirements.txt")
            if os.path.isfile(req):
                r = _pip(["-r", req], 900)
                log.append(r.stdout[-800:] + r.stderr[-800:])
                if r.returncode != 0:
                    return 500, {"error": "installing its Python packages failed", "log": log}
        # Optional compiled kernels (Triton): without one the node runs a slower path, so a failure here isn't fatal.
        if importlib.util.find_spec("triton") is not None:
            for rel in info.get("kernels", []):
                path = os.path.join(target, rel)
                if os.path.isdir(path):
                    r = _pip(["--no-build-isolation", "--no-deps", path], 900)
                    log.append(r.stdout[-400:] + r.stderr[-400:])
        with open(os.path.join(target, DONE_MARK), "w") as f:
            f.write(f"{commit or 'HEAD'} {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    except (OSError, subprocess.TimeoutExpired, urllib.error.URLError) as e:
        return 500, {"error": str(e)[:300], "log": log}
    return 200, {"installed": True, "restart": True, "log": log}


@PromptServer.instance.routes.post("/crackio/restart")
async def restart(request):
    import asyncio
    import sys

    def again():
        time.sleep(1.0)
        # The same process, started over: what ComfyUI-Manager's restart does.
        os.execv(sys.executable, [sys.executable] + sys.argv)

    if any(d["state"] in ("queued", "downloading", "checking") for d in _downloads.values()):
        return web.json_response({"error": "Downloads are still running."}, status=409)
    if _installing:
        return web.json_response({"error": "A custom node is still installing."}, status=409)
    threading.Thread(target=again, daemon=True).start()
    await asyncio.sleep(0)
    return web.json_response({"restarting": True})
