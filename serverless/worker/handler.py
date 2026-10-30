"""
Crackio's RunPod Serverless worker: ComfyUI in a container that scales to zero.

One job runs one ComfyUI graph (API format), the same graphs Crackio queues on your own ComfyUI. Crackio's side
(src/lib/server/serverless) speaks ComfyUI's HTTP API to the rest of Crackio and turns each queued graph into a job here,
so multi-step tools, recipes and the Library work unchanged.

Job input ("action", default "run"):
  run   {graph, prompt_id?, inputs: [{name, url | b64}], outputs: [presigned PUT url, ...]}
        Inputs land in ComfyUI's input folder under their names ("crackio/in-....png"). Each output file goes to the next
        presigned URL (Cloudflare R2), or comes back as base64 when there are no URLs left and it's small.
  list  what this worker holds: model files (folder/name/bytes), node classes and their modules, GPU, ComfyUI version.
  fetch {files: [{url, folder, name, bytes?}]}: model files downloaded once into the network volume (HF_TOKEN for gated
        Hugging Face repos), skipped when already there at the right size.

No keys come in a job: Hugging Face's token is the endpoint's HF_TOKEN; files move through presigned URLs.
"""

import base64
import concurrent.futures
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid

import requests
import runpod
import websocket

COMFY_DIR = os.environ.get("COMFY_DIR", "/comfyui")
PORT = 8188
HOST = f"http://127.0.0.1:{PORT}"
MODELS = os.environ.get("MODELS_DIR", "/runpod-volume/models")
IN_DIR = "/tmp/comfy-in"
OUT_DIR = "/tmp/comfy-out"
INLINE_MAX = 6 * 1024 * 1024
FOLDERS = [
    "checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "upscale_models", "latent_upscale_models",
    "controlnet", "clip_vision", "model_patches", "audio_encoders", "style_models", "embeddings", "sam3",
]

_proc = None
_lock = threading.Lock()


def start_comfy():
    """ComfyUI, started once per worker (FlashBoot keeps it loaded between jobs)."""
    global _proc
    with _lock:
        if _proc and _proc.poll() is None:
            return
        for d in [IN_DIR, OUT_DIR] + [os.path.join(MODELS, f) for f in FOLDERS]:
            os.makedirs(d, exist_ok=True)
        _proc = subprocess.Popen(
            [
                # As on the 5090 box: ComfyUI's own memory management (it moves weights between the GPU and RAM as a
                # model needs, which is how LTX-2.5 int8 with Gemma runs in 32 GB), no xformers.
                sys.executable, "-u", "main.py", "--listen", "127.0.0.1", "--port", str(PORT), "--disable-auto-launch", "--disable-xformers",
                "--extra-model-paths-config", "/extra_model_paths.yaml",
                "--input-directory", IN_DIR, "--output-directory", OUT_DIR,
            ],
            cwd=COMFY_DIR,
        )
        for _ in range(1200):
            if _proc.poll() is not None:
                raise RuntimeError(f"ComfyUI exited with {_proc.returncode}")
            try:
                if requests.get(f"{HOST}/system_stats", timeout=2).ok:
                    return
            except requests.RequestException:
                pass
            time.sleep(0.25)
        raise RuntimeError("ComfyUI didn't start in 5 minutes")


def inside(root, name):
    """A file name from a job, kept inside its folder."""
    path = os.path.normpath(os.path.join(root, name.replace("\\", "/").lstrip("/")))
    if not path.startswith(os.path.normpath(root) + os.sep):
        raise ValueError(f"bad file name: {name}")
    return path


def download(url, dest, headers=None, size=None):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    with requests.get(url, headers=headers or {}, stream=True, timeout=(20, 120)) as r:
        r.raise_for_status()
        with open(part, "wb") as f:
            for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                f.write(chunk)
    if size and os.path.getsize(part) != size:
        raise RuntimeError(f"{os.path.basename(dest)}: got {os.path.getsize(part)} of {size} bytes")
    os.replace(part, dest)


def gpu():
    try:
        import torch

        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            return {"name": p.name, "vram": p.total_memory}
    except Exception:
        pass
    return {"name": None, "vram": None}


def files():
    out = []
    for folder in FOLDERS:
        root = os.path.join(MODELS, folder)
        for dirpath, _, names in os.walk(root):
            for n in names:
                if n.endswith(".part"):
                    continue
                p = os.path.join(dirpath, n)
                out.append({"folder": folder, "name": os.path.relpath(p, root).replace(os.sep, "/"), "bytes": os.path.getsize(p)})
    return out


def comfy_version():
    try:
        return requests.get(f"{HOST}/system_stats", timeout=5).json().get("system", {}).get("comfyui_version")
    except Exception:
        return None


def run(job, inp):
    started = time.time()
    warm = _proc is not None and _proc.poll() is None
    start_comfy()
    ready = time.time()
    written = []
    try:
        for f in inp.get("inputs", []):
            dest = inside(IN_DIR, f["name"])
            written.append(dest)
            if f.get("url"):
                download(f["url"], dest)
            else:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as fh:
                    fh.write(base64.b64decode(f["b64"]))
        return queue_and_collect(job, inp, started, ready, warm)
    finally:
        # A job's inputs don't outlive it: the next job may be someone else's.
        for p in written:
            try:
                os.remove(p)
            except OSError:
                pass


def queue_and_collect(job, inp, started, ready, warm):
    graph = inp["graph"]
    print(f"[run] {len(graph)} nodes, {len(inp.get('inputs') or [])} inputs, ComfyUI {'warm' if warm else 'cold'} (startup {ready - started:.1f} s)", flush=True)
    prompt_id = inp.get("prompt_id") or str(uuid.uuid4())
    client = f"runpod-{uuid.uuid4().hex[:8]}"
    ws = websocket.create_connection(f"ws://127.0.0.1:{PORT}/ws?clientId={client}", timeout=30)
    try:
        r = requests.post(f"{HOST}/prompt", json={"prompt": graph, "prompt_id": prompt_id, "client_id": client}, timeout=60)
        if not r.ok:
            return {"error": {"kind": "invalid", "status": r.status_code, "body": r.text[:4000]}}
        prompt_id = r.json().get("prompt_id", prompt_id)
        last = 0.0
        ws.settimeout(15)
        while True:
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                h = requests.get(f"{HOST}/history/{prompt_id}", timeout=10).json().get(prompt_id)
                if h and (h.get("status", {}).get("completed") or h.get("status", {}).get("status_str") in ("success", "error")):
                    break
                continue
            if not isinstance(raw, str):
                continue
            msg = json.loads(raw)
            data = msg.get("data") or {}
            if data.get("prompt_id") not in (None, prompt_id):
                continue
            kind = msg.get("type")
            if kind == "progress" and time.time() - last > 1:
                last = time.time()
                runpod.serverless.progress_update(job, json.dumps({"node": data.get("node"), "value": data.get("value"), "max": data.get("max")}))
            elif kind == "executing" and data.get("node") is None and data.get("prompt_id") == prompt_id:
                break
            elif kind in ("execution_error", "execution_interrupted"):
                break
    finally:
        ws.close()
    h = {}
    for _ in range(20):
        h = requests.get(f"{HOST}/history/{prompt_id}", timeout=10).json().get(prompt_id) or {}
        if h.get("status"):
            break
        time.sleep(0.5)
    status = h.get("status") or {}
    slots = list(inp.get("outputs") or [])
    outs = []
    for node, node_out in (h.get("outputs") or {}).items():
        for key, items in node_out.items():
            if not isinstance(items, list):
                continue
            for it in items:
                if not isinstance(it, dict) or "filename" not in it or it.get("type", "output") != "output":
                    continue
                path = inside(OUT_DIR, os.path.join(it.get("subfolder") or "", it["filename"]))
                if not os.path.exists(path):
                    continue
                entry = {"node": node, "key": key, "filename": it["filename"], "subfolder": it.get("subfolder") or "", "bytes": os.path.getsize(path)}
                mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
                if slots:
                    url = slots.pop(0)
                    with open(path, "rb") as fh:
                        up = requests.put(url, data=fh, headers={"Content-Type": mime}, timeout=(20, 600))
                    up.raise_for_status()
                    entry["slot"] = len(inp.get("outputs") or []) - len(slots) - 1
                elif entry["bytes"] <= INLINE_MAX:
                    with open(path, "rb") as fh:
                        entry["b64"] = base64.b64encode(fh.read()).decode()
                outs.append(entry)
                os.remove(path)
    print(f"[run] {status.get('status_str')} in {time.time() - started:.1f} s, {len(outs)} files out", flush=True)
    return {
        "prompt_id": prompt_id,
        "status": {"status_str": status.get("status_str"), "completed": status.get("completed"), "messages": status.get("messages", [])},
        "outputs": h.get("outputs") or {},
        "files_out": outs,
        "gpu": gpu(),
        "comfyui": comfy_version(),
        "warm": warm,
        "startup_s": round(ready - started, 2),
        "total_s": round(time.time() - started, 2),
        "files": files(),
    }


def list_all():
    start_comfy()
    info = requests.get(f"{HOST}/object_info", timeout=120).json()
    nodes = {k: v.get("python_module") for k, v in info.items()}
    return {"files": files(), "nodes": nodes, "gpu": gpu(), "comfyui": comfy_version()}


def fetch(inp):
    token = os.environ.get("HF_TOKEN", "").strip()
    wanted = inp.get("files") or []

    def one(f):
        dest = inside(os.path.join(MODELS, f["folder"]), f["name"])
        if os.path.exists(dest) and (not f.get("bytes") or os.path.getsize(dest) == f["bytes"]):
            print(f"[fetch] {f['name']}: already on the volume", flush=True)
            return {"name": f["name"], "state": "had"}
        host = urllib.parse.urlparse(f["url"]).hostname or ""
        headers = {"Authorization": f"Bearer {token}"} if token and host.endswith("huggingface.co") else {}
        t = time.time()
        print(f"[fetch] {f['name']}: downloading", flush=True)
        try:
            download(f["url"], dest, headers, f.get("bytes"))
            s = time.time() - t
            gb = os.path.getsize(dest) / 1e9
            print(f"[fetch] {f['name']}: {gb:.2f} GB in {s:.0f} s ({gb * 1000 / max(s, 0.1):.0f} MB/s)", flush=True)
            return {"name": f["name"], "state": "fetched", "s": round(s, 1), "gb": round(gb, 2)}
        except Exception as e:  # noqa: BLE001
            print(f"[fetch] {f['name']}: FAILED {str(e)[:200]}", flush=True)
            return {"name": f["name"], "state": "failed", "error": str(e)[:300]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, wanted))
    return {"results": results, "files": files()}


def handler(job):
    inp = job.get("input") or {}
    action = inp.get("action", "run")
    if action == "list":
        return list_all()
    if action == "fetch":
        return fetch(inp)
    return run(job, inp)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
