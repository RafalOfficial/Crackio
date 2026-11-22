"""
Crackio's LoRA trainer (bridge 1.11): a LoRA for a picture model trained inside this ComfyUI, on whatever model its
loaders load (full precision or quantized, Crackio's or a file you put in models/), with nothing else to install.

Why not ComfyUI's own "Train LoRA" node: it takes the whole run in one job (no checkpoints, nothing kept when it stops),
and in 0.42 its multi-size modes train on latents that skipped the model's latent scaling and average a batch's captions
over every picture in it. This keeps ComfyUI's model loading, memory management and conditioning, and runs its own loop:

  Crackio Training Data   pictures (ComfyUI's input folder) and captions -> latents and text conditioning kept on disk,
                          each picture at its own shape (sizes on a grid, never enlarged), encoded once.
  Crackio Train LoRA      trains from that cache in segments: every job continues where the last one stopped (weights,
                          optimizer and random state are kept), saves checkpoints as LoRA files ComfyUI loads, and stops
                          cleanly on a time budget, a pause or ComfyUI's interrupt. The LoRA runs beside each layer
                          (out + up(down(x))), so quantized weights are never rewritten; the loss is the model's own
                          target (velocity for flow models, noise for the older ones) on timesteps drawn the way
                          dedicated trainers draw them.
  Crackio Model Facts     what a model file is (architecture, size, precision), read from its header.

While it runs it tells every listener ("crackio.train" on ComfyUI's websocket, and GET /crackio/train/status): the step,
loss, speed, GPU memory at its peak and its last log lines.

Routes:
  GET  /crackio/train/status?job=   the job's last status and log lines (from=<seq> for the ones after it)
  POST /crackio/train/stop          {job, finish?, clear?} pause after the step in progress (finish: save the LoRA as it is; clear: forget a stop asked before)
  POST /crackio/train/clean         {job, loras?: [names]} the job's cache and state removed (and those LoRA files)
  GET  /crackio/train/models        model files in diffusion_models and checkpoints (name, folder, bytes)
  POST /crackio/train/inspect       {folder, name} -> what that file is
  GET  /crackio/train/lora?name=    a LoRA file from models/loras, to keep a copy elsewhere
  POST /crackio/train/lora?name=&offset=&total=   the same file, sent here in pieces
  GET  /crackio/train/state?job=    what a run carries on from (probe=1: only whether it's here, and its size)
  POST /crackio/train/state?job=&offset=&total=   a run's state from another machine, sent here in pieces
"""
import gc
import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import threading
import time
import traceback

import folder_paths
import torch
import torch.nn.functional as F
import torch.utils.checkpoint

import comfy.model_management as mm
import comfy.samplers
import comfy.sampler_helpers
import comfy.utils

from . import train_patches

try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # read outside ComfyUI (tests)
    web = None
    PromptServer = None

JOB = re.compile(r"^[A-Za-z0-9_-]{4,48}$")
LORA_NAME = re.compile(r"^[\w.\-+ ()\[\]]{1,180}\.safetensors$")
# What a LoRA file has in its tensor names, whatever its kind (plain, LoHa, LoKr, OFT, the older diffusers "lora.down").
LORA_MARKS = ("lora_", "lora.down", "lora.up", "lokr_", "hada_", "oft_", ".diff")
STATE_VERSION = 2


# ------------------------------------------------------------------ where things live


def _loras_dir():
    """Where trained LoRAs go: a folder ComfyUI loads LoRAs from that outlives this process. On a serverless worker
    that's the network volume's (the container's own models folder is gone with the worker); else where Crackio's
    downloads go (storage.py's download folder, else models/loras)."""
    paths = folder_paths.get_folder_paths("loras") or []
    env = os.environ.get("CRACKIO_LORAS_DIR", "").strip()
    if env:
        os.makedirs(env, exist_ok=True)
        return env
    volume = os.environ.get("MODELS_DIR", "/runpod-volume/models").rstrip("/")
    for p in paths:
        if os.path.normpath(p).replace("\\", "/").startswith(volume + "/") and os.path.isdir(os.path.dirname(os.path.normpath(p))):
            os.makedirs(p, exist_ok=True)
            return p
    try:
        from . import storage

        chosen = storage.target("loras")
        if chosen:
            os.makedirs(chosen, exist_ok=True)
            storage.ensure("loras", chosen)
            return chosen
    except Exception:
        pass
    for p in paths:
        if os.path.basename(os.path.normpath(p)) == "loras" and os.path.isdir(p):
            return p
    if not paths:
        raise RuntimeError("This ComfyUI has no LoRA folder.")
    os.makedirs(paths[0], exist_ok=True)
    return paths[0]


def _work_root():
    """The trainer's own folder, beside the LoRA folder (so on the same lasting drive)."""
    root = os.path.join(os.path.dirname(os.path.normpath(_loras_dir())), "crackio_train")
    os.makedirs(root, exist_ok=True)
    return root


def _others_on_gpu(device):
    """What other programs hold on the GPU right now (a game, a 3D app, a browser, another ComfyUI) and the card's size,
    in GB: nvidia-smi's count once ComfyUI has let go of its own models, less what this process still keeps. None where
    that can't be read (no NVIDIA tools, another kind of GPU)."""
    if device.type != "cuda":
        return None
    try:
        mm.unload_all_models()
        mm.soft_empty_cache()
        out = subprocess.run(
            ["nvidia-smi", f"--id={device.index or 0}", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=8,
        ).stdout.strip().splitlines()[0]
        used, total = [float(x) for x in out.split(",")]
        mine = torch.cuda.memory_reserved(device) / 1024**2
        return max(0.0, used - mine) / 1024, total / 1024
    except Exception:
        return None


def _load_state(work):
    """A run's kept state. One that came from another machine (state.moved beside it) is read as plain tensors and
    numbers only: a file from outside never gets to run code here."""
    path = os.path.join(work, "state.pt")
    return torch.load(path, map_location="cpu", weights_only=os.path.isfile(os.path.join(work, "state.moved")))


def _work(job, make=True):
    if not JOB.match(job or ""):
        raise ValueError("That isn't a training job id.")
    path = os.path.join(_work_root(), job)
    if make:
        os.makedirs(os.path.join(path, "cache"), exist_ok=True)
    return path


def _atomic(path, write):
    tmp = f"{path}.tmp{os.getpid()}"
    write(tmp)
    os.replace(tmp, path)


def _write_json(path, data):
    def write(tmp):
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)

    _atomic(path, write)


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ------------------------------------------------------------------ status and log, heard by Crackio

_jobs = {}  # job -> {"status": dict, "log": [(seq, line)], "seq": int, "stop": None | "pause" | "finish"}
_lock = threading.Lock()


def _job(job):
    with _lock:
        j = _jobs.get(job)
        if j is None:
            kept = _read_json(os.path.join(_work(job, make=False), "status.json")) or {}
            lines = kept.pop("log", []) if isinstance(kept, dict) else []
            j = {"status": kept or {}, "log": [tuple(x) for x in lines][-200:], "seq": (lines[-1][0] if lines else 0), "stop": None, "sent": 0.0}
            _jobs[job] = j
        return j


def _say(job, line):
    """One log line: kept (the last 200), written to the job's log.txt and sent with the next status."""
    j = _job(job)
    with _lock:
        j["seq"] += 1
        j["log"].append((j["seq"], f"{time.strftime('%H:%M:%S')} {line}"))
        del j["log"][:-200]
    print(f"[crackio_train {job}] {line}", flush=True)
    try:
        with open(os.path.join(_work(job), "log.txt"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except OSError:
        pass


def _tell(job, patch=None, force=False, prompt_id=None):
    """Update the job's status and send it to whoever listens, at most every 1.5 s unless `force`."""
    j = _job(job)
    with _lock:
        if patch:
            j["status"].update(patch)
        j["status"]["at"] = time.time()
        now = time.time()
        if not force and now - j["sent"] < 1.5:
            return
        j["sent"] = now
        payload = {"job": job, **j["status"], "log": j["log"][-40:]}
        kept = {**payload, "log": j["log"][-200:]}
    if prompt_id:
        payload["prompt_id"] = prompt_id
    try:
        _write_json(os.path.join(_work(job), "status.json"), kept)
    except OSError:
        pass
    if PromptServer is not None:
        try:
            PromptServer.instance.send_sync("crackio.train", payload)
        except Exception:
            pass


def _prompt_id():
    try:
        return PromptServer.instance.last_prompt_id
    except Exception:
        return None


class TrainError(RuntimeError):
    """A failure Crackio knows how to answer: `code` says which (OOM, NAN, DATA, STATE, MODEL)."""

    def __init__(self, code, message):
        super().__init__(f"CRACKIO_TRAIN_{code}: {message}")
        self.code = code


# ------------------------------------------------------------------ the dataset: latents and text conditioning, kept


def _input_path(name):
    root = os.path.abspath(folder_paths.get_input_directory())
    path = os.path.abspath(os.path.join(root, name.replace("\\", "/").lstrip("/")))
    if not path.startswith(root + os.sep):
        raise TrainError("DATA", f"{name} isn't inside ComfyUI's input folder.")
    return path


def _bucket(width, height, resolution, grid):
    """The size a picture trains at: its own shape, about `resolution`² pixels at most (never enlarged past its own
    size), each side on the model's grid and the shape kept between 1:2.5 and 2.5:1."""
    ratio = min(2.5, max(0.4, width / height))
    area = min(resolution * resolution, width * height)
    low = math.ceil(256 / grid) * grid
    w = max(low, round(math.sqrt(area * ratio) / grid) * grid)
    h = max(low, round(math.sqrt(area / ratio) / grid) * grid)
    # Rounding both sides up can overshoot: the longer side gives way until the picture is within a tenth of its area.
    while w * h > area * 1.1 and max(w, h) > low:
        if w >= h:
            w -= grid
        else:
            h -= grid
    return w, h


def _load_picture(path, width, height):
    """The picture, turned upright, covering width x height from its middle: (1, H, W, 3) in 0..1."""
    import numpy as np
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(Image.open(path))
    if img.mode in ("RGBA", "LA", "P"):
        # Transparent parts go to white: a subject cut out of its background is still a subject on a plain backdrop.
        rgba = img.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(white, rgba)
    img = img.convert("RGB")
    scale = max(width / img.width, height / img.height)
    size = (max(width, round(img.width * scale)), max(height, round(img.height * scale)))
    img = img.resize(size, Image.Resampling.LANCZOS)
    left, top = (img.width - width) // 2, (img.height - height) // 2
    img = img.crop((left, top, left + width, top + height))
    return torch.from_numpy(np.asarray(img).astype("float32") / 255.0)[None]


def _cpu(value):
    """Conditioning with its tensors on the CPU, as plain tensors (not ones made in inference mode)."""
    if isinstance(value, torch.Tensor):
        return value.detach().to("cpu").clone()
    if isinstance(value, dict):
        return {k: _cpu(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_cpu(v) for v in value)
    return value


def _file_sha(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# The system prompt ComfyUI's TextEncodeQwenImageEditPlus puts before the words (the Qwen-Image-Edit models were
# trained with it).
QWEN_EDIT_TEMPLATE = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"


def build_dataset(vae, clip, job, items, resolution, grid, signature, edit=""):
    """Encode what isn't in the job's cache yet and write its index (dataset.json). Returns the index.

    An item with a `source` is a pair for an edit LoRA: `source` is the picture before the change, `file` the picture
    after it, `caption` the instruction. The before picture is encoded at the after picture's size and kept beside it
    (the model's reference picture). `edit` says how the model takes it: "reference" (FLUX 3 Klein, FLUX.2 klein: the
    encoded picture alone), "vision" (Qwen-Image 2.1: its text encoder also looks at the picture with the words) or
    "qwen-edit" (Qwen-Image-Edit 2509/2511: the text encoder looks at a small copy of it under the edit models' own
    system prompt, as ComfyUI's TextEncodeQwenImageEditPlus does).
    """
    from PIL import Image, ImageOps

    work = _work(job)
    cache = os.path.join(work, "cache")
    pid = _prompt_id()
    if not items:
        raise TrainError("DATA", "No pictures to train on.")
    _tell(job, {"phase": "preparing", "prepared": 0, "pictures": len(items), "error": None, "code": None}, force=True, prompt_id=pid)
    _say(job, f"Preparing {len(items)} pictures at up to {resolution} px")
    index = {"signature": signature, "resolution": resolution, "items": [], "captions": {}, "edit": edit}
    bar = comfy.utils.ProgressBar(len(items))
    captions = {}
    vision = edit in ("vision", "qwen-edit")

    def tokens_beside(text, picture):
        if edit == "qwen-edit":
            samples = picture.movedim(-1, 1)
            scale = math.sqrt(384 * 384 / (samples.shape[3] * samples.shape[2]))
            small = comfy.utils.common_upscale(samples, round(samples.shape[3] * scale), round(samples.shape[2] * scale), "area", "disabled").movedim(1, -1)
            return clip.tokenize("Picture 1: <|vision_start|><|image_pad|><|vision_end|>" + text, images=[small], llama_template=QWEN_EDIT_TEMPLATE)
        return clip.tokenize(text, images=[picture])

    def cond_of(text, picture=None, tag=""):
        """The words as the model takes them. With `picture` (a function giving a pair's before picture), the words
        beside that picture, for a model whose text encoder looks at it."""
        key = hashlib.sha1(f"{signature}|{text}{tag}".encode("utf-8")).hexdigest()[:20]
        if key in captions:
            return key
        path = os.path.join(cache, f"c_{key}.pt")
        if not os.path.isfile(path):
            tokens = clip.tokenize(text) if picture is None else tokens_beside(text, picture()[:, :, :, :3])
            cond = clip.encode_from_tokens_scheduled(tokens)
            _atomic(path, lambda tmp: torch.save(_cpu(cond), tmp))
        captions[key] = text
        return key

    # The words first, while the text encoder is the only big model loaded; then the pictures. (Words that go in beside
    # a picture are encoded with it, below.)
    empty = cond_of("")
    keys = [None if vision and it.get("source") else cond_of(str(it.get("caption") or "").strip()) for it in items]
    skipped = []
    pairs = 0
    for n, it in enumerate(items):
        mm.throw_exception_if_processing_interrupted()
        w = h = 0
        try:
            src = _input_path(str(it["file"]))
            with Image.open(src) as probe:
                iw, ih = ImageOps.exif_transpose(probe).size
            w, h = _bucket(iw, ih, resolution, grid)
            lkey = hashlib.sha1(f"{signature}|{_file_sha(src)}|{w}x{h}".encode("utf-8")).hexdigest()[:20]
            path = os.path.join(cache, f"l_{lkey}.pt")
            if not os.path.isfile(path):
                pixels = _load_picture(src, w, h)
                latent = vae.encode(pixels[:, :, :, :3])
                _atomic(path, lambda tmp: torch.save(latent.detach().to("cpu", torch.float32).clone(), tmp))
            entry = {"latent": f"l_{lkey}.pt", "cond": keys[n], "width": w, "height": h, "file": str(it["file"])}
            if it.get("source"):
                before = _input_path(str(it["source"]))
                rkey = hashlib.sha1(f"{signature}|before|{_file_sha(before)}|{w}x{h}".encode("utf-8")).hexdigest()[:20]
                rpath = os.path.join(cache, f"r_{rkey}.pt")
                loaded = {}

                def picture():
                    if "p" not in loaded:
                        loaded["p"] = _load_picture(before, w, h)
                    return loaded["p"]

                if not os.path.isfile(rpath):
                    ref = vae.encode(picture()[:, :, :, :3])
                    _atomic(rpath, lambda tmp: torch.save(ref.detach().to("cpu", torch.float32).clone(), tmp))
                entry["ref"] = f"r_{rkey}.pt"
                if vision:
                    entry["cond"] = cond_of(str(it.get("caption") or "").strip(), picture, f"|beside|{rkey}")
                pairs += 1
            index["items"].append(entry)
        except TrainError:
            raise
        except mm.InterruptProcessingException:
            raise
        except Exception as e:  # one unreadable picture doesn't end the run
            if mm.is_oom(e):
                raise TrainError("OOM", f"out of GPU memory while encoding a {w}x{h} picture")
            skipped.append(str(it.get("file")))
            _say(job, f"Skipped {os.path.basename(str(it.get('file')))}: {str(e)[:160]}")
        bar.update_absolute(n + 1)
        _tell(job, {"prepared": n + 1}, prompt_id=pid)
    if not index["items"]:
        raise TrainError("DATA", "None of the pictures could be read.")
    index["captions"] = captions
    index["empty"] = empty
    index["skipped"] = skipped
    sizes = {}
    for it in index["items"]:
        sizes[f"{it['width']}x{it['height']}"] = sizes.get(f"{it['width']}x{it['height']}", 0) + 1
    index["sizes"] = sizes
    _write_json(os.path.join(work, "dataset.json"), index)
    _say(job, (f"Prepared {pairs} before/after pairs" if pairs else f"Prepared {len(index['items'])} pictures") + f" in {len(sizes)} sizes" + (f", {len(skipped)} skipped" if skipped else ""))
    _tell(job, {"phase": "prepared", "prepared": len(items), "sizes": sizes, "skipped": skipped}, force=True, prompt_id=pid)
    return index


class CrackioTrainData:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "vae": ("VAE",),
                "clip": ("CLIP",),
                "job": ("STRING", {"default": ""}),
                "items": ("STRING", {"default": "[]", "multiline": True, "tooltip": 'JSON: [{"file": "crackio/train/<job>/0001.jpg", "caption": "..."}]'}),
                "resolution": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 32}),
                "grid": ("INT", {"default": 32, "min": 8, "max": 128, "step": 8, "tooltip": "Sides are multiples of this many pixels."}),
                "signature": ("STRING", {"default": "", "tooltip": "What the cache is for (the model's family and files): a new one encodes again."}),
            },
            # The pictures' names once more, each a value of its own in the graph: a serverless endpoint sends along the
            # input files a graph names. Not read here. `edit`: how the model takes a pair's before picture.
            "optional": {"files": ("CRACKIO_FILES",), "edit": ("STRING", {"default": ""})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("data",)
    FUNCTION = "prepare"
    CATEGORY = "Crackio/training"
    OUTPUT_NODE = True

    def prepare(self, vae, clip, job, items, resolution, grid, signature, files=None, edit=""):
        try:
            with torch.inference_mode(False), torch.no_grad():
                index = build_dataset(vae, clip, job, json.loads(items), int(resolution), int(grid), signature, str(edit or ""))
        except TrainError as e:
            _fail(job, e)
            raise
        summary = {"job": job, "pictures": len(index["items"]), "sizes": index["sizes"], "skipped": index.get("skipped", [])}
        return {"ui": {"crackio_train": [summary]}, "result": (json.dumps(summary),)}


def _fail(job, e):
    _say(job, f"Stopped: {e}")
    _tell(job, {"phase": "error", "error": str(e), "code": getattr(e, "code", None)}, force=True, prompt_id=_prompt_id())


# ------------------------------------------------------------------ the LoRA: a low-rank path beside each layer


class Lora(torch.nn.Module):
    """out + up(down(x)) * alpha / rank, for a Linear or a Conv layer. `up` starts at zero: step 0 changes nothing."""

    def __init__(self, module, rank, alpha):
        super().__init__()
        shape = tuple(module.weight.shape)
        self.conv = len(shape) > 2
        rank = max(1, min(rank, shape[0], shape[1]))
        if self.conv:
            self.kw = {"stride": module.stride, "padding": module.padding, "dilation": module.dilation, "groups": module.groups}
            self.down = torch.nn.Parameter(torch.empty((rank, shape[1], *shape[2:])))
            self.up = torch.nn.Parameter(torch.zeros((shape[0], rank, *([1] * (len(shape) - 2)))))
        else:
            self.kw = {}
            self.down = torch.nn.Parameter(torch.empty((rank, shape[1])))
            self.up = torch.nn.Parameter(torch.zeros((shape[0], rank)))
        torch.nn.init.kaiming_uniform_(self.down, a=math.sqrt(5))
        self.rank = rank
        self.alpha = float(alpha)

    def forward(self, x):
        down, up = self.down.to(x.dtype), self.up.to(x.dtype)
        if self.conv:
            fn = (F.conv1d, F.conv2d, F.conv3d)[self.down.ndim - 3]
            return fn(fn(x, down, **self.kw), up) * (self.alpha / self.rank)
        return F.linear(F.linear(x, down), up) * (self.alpha / self.rank)


def _is_layer(m):
    name = type(m).__name__
    weight = getattr(m, "weight", None)
    if weight is None or not hasattr(weight, "shape"):
        return False
    if isinstance(m, torch.nn.Linear) or name == "Linear":
        return len(weight.shape) == 2
    if isinstance(m, (torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d)) or name in ("Conv1d", "Conv2d", "Conv3d"):
        return len(weight.shape) in (3, 4, 5) and getattr(m, "groups", 1) == 1
    return False


# Layers inside a numbered block (double_blocks.3.…, layers.12.…, input_blocks.4.1.…): the model's attention and MLPs.
# Its embedders and its last layer are left alone, as dedicated trainers leave them.
IN_BLOCK = re.compile(r"(^|\.)[A-Za-z_]+\.\d+\.")


def target_layers(diffusion_model, include=None, exclude=None, conv=False):
    out = []
    inc = re.compile(include) if include else None
    exc = re.compile(exclude) if exclude else None
    for name, m in diffusion_model.named_modules():
        if not _is_layer(m) or not IN_BLOCK.search(name):
            continue
        if len(m.weight.shape) > 2 and not conv:
            continue
        if inc and not inc.search(name):
            continue
        if exc and exc.search(name):
            continue
        out.append((name, m))
    return out


def _attach(module, lora):
    orig = module.forward

    def forward(x, *args, **kwargs):
        out = orig(x, *args, **kwargs)
        return out + lora(x).to(out.dtype)

    module._crackio_forward = (orig, "forward" in module.__dict__)
    module._crackio_force = (getattr(module, "comfy_force_forward", False), "comfy_force_forward" in module.__dict__)
    # ComfyUI's fused fast paths (a quantized linear with its activation folded in) step aside for a plain forward.
    module.comfy_force_forward = True
    module.forward = forward


def _restore(module, name, kept):
    """Puts an attribute back as it was: its old value when the object had one of its own, else gone (the class's shows)."""
    value, own = kept
    if own:
        setattr(module, name, value)
    else:
        try:
            delattr(module, name)
        except AttributeError:
            pass


def _detach(module):
    if hasattr(module, "_crackio_forward"):
        _restore(module, "forward", module._crackio_forward)
        _restore(module, "comfy_force_forward", module._crackio_force)
        del module._crackio_forward
        del module._crackio_force


def lora_state(loras, prefix="diffusion_model."):
    """The LoRA as ComfyUI loads it: <layer>.lora_up.weight, .lora_down.weight, .alpha."""
    sd = {}
    for name, lora in loras.items():
        sd[f"{prefix}{name}.lora_up.weight"] = lora.up.detach().to("cpu", torch.float16).contiguous()
        sd[f"{prefix}{name}.lora_down.weight"] = lora.down.detach().to("cpu", torch.float16).contiguous()
        sd[f"{prefix}{name}.alpha"] = torch.tensor(float(lora.alpha), dtype=torch.float16)
    return sd


def _portable(sd, meta):
    """FLUX 3's INT8 files have one fused "qkv" layer where its full-precision files have q_proj, k_proj and v_proj, and
    LoRAs address the separate ones: ComfyUI maps those onto a fused weight, never the other way (a LoRA saved on "qkv"
    loaded 129 of its 172 layers on the full-precision model). So a fused layer's LoRA is written as its three thirds:
    the same down, the up's rows split in the order ComfyUI fuses them (q, k, v). The same LoRA, loadable on both."""
    if str(meta.get("crackio.family", "")) != "flux3-klein":
        return sd
    out = {}
    for k, v in sd.items():
        m = re.match(r"^(.*)\.qkv\.(lora_up\.weight|lora_down\.weight|alpha)$", k)
        up = sd.get(f"{m.group(1)}.qkv.lora_up.weight") if m else None
        if up is None or up.shape[0] % 3:
            out[k] = v
            continue
        base, part = m.groups()
        third = up.shape[0] // 3
        for i, proj in enumerate(("q_proj", "k_proj", "v_proj")):
            out[f"{base}.{proj}.{part}"] = v[i * third : (i + 1) * third].contiguous() if part == "lora_up.weight" else v.clone()
    return out


def save_lora(loras, path, meta):
    import safetensors.torch

    sd = _portable(lora_state(loras), meta)
    bad = [k for k, v in sd.items() if not torch.isfinite(v.float()).all()]
    if bad:
        raise TrainError("NAN", f"the LoRA has values that aren't numbers ({len(bad)} tensors)")
    _atomic(path, lambda tmp: safetensors.torch.save_file(sd, tmp, metadata={k: str(v) for k, v in meta.items()}))
    return os.path.getsize(path)


# ------------------------------------------------------------------ gradient checkpointing (memory for time)


def _blocks(model, depth=1):
    """The model's blocks: the modules `depth` forwards down from the top (containers don't count)."""
    out = []

    def walk(m, d):
        container = isinstance(m, (torch.nn.ModuleList, torch.nn.Sequential, torch.nn.ModuleDict))
        if hasattr(m, "forward") and not container:
            d += 1
            if d == depth:
                out.append(m)
                return
        for child in m.children():
            walk(child, d)

    for child in model.children():
        walk(child, 0)
    return out


# Off for the moment the trainer compares gradients with and without it (Run.selftest).
CHECKPOINTING = {"on": True}


def _checkpointed(m):
    orig = m.forward

    def run(args, kwargs):
        return orig(*args, **kwargs)

    def forward(*args, **kwargs):
        if not CHECKPOINTING["on"]:
            return orig(*args, **kwargs)
        return torch.utils.checkpoint.checkpoint(run, args, kwargs, use_reentrant=False)

    m._crackio_ckpt = (orig, "forward" in m.__dict__)
    m.forward = forward


def _uncheckpointed(m):
    if hasattr(m, "_crackio_ckpt"):
        _restore(m, "forward", m._crackio_ckpt)
        del m._crackio_ckpt


def _sdpa(func, *args, **kwargs):
    """PyTorch's own attention, whatever kernel this ComfyUI draws with (sage and the INT8 kernels have no backward)."""
    import comfy.ldm.modules.attention as attention

    return attention.attention_pytorch(*args, **kwargs)


# ------------------------------------------------------------------ the loop


class _Guider(comfy.samplers.CFGGuider):
    """ComfyUI's guider with the conditioning only (no guidance while training), loading the model for training."""

    def __init__(self, model_patcher, offload):
        super().__init__(model_patcher)
        self.offload = offload

    def set_conds(self, positive):
        self.inner_set_conds({"positive": positive})

    def outer_sample(self, noise, latent_image, sampler, sigmas, denoise_mask=None, callback=None, disable_pbar=False, seed=None, **kwargs):
        try:
            self.inner_model, self.conds, self.loaded_models = comfy.sampler_helpers.prepare_sampling(
                self.model_patcher, noise.shape, self.conds, self.model_options, force_full_load=not self.offload, force_offload=self.offload
            )
        except TypeError:  # a ComfyUI from before training took those
            self.inner_model, self.conds, self.loaded_models = comfy.sampler_helpers.prepare_sampling(self.model_patcher, noise.shape, self.conds, self.model_options)
        device = self.model_patcher.load_device
        noise = noise.to(device)
        latent_image = latent_image.to(device)
        sigmas = sigmas.to(device)
        try:
            comfy.samplers.cast_to_load_options(self.model_options, device=device, dtype=self.model_patcher.model_dtype())
        except Exception:
            pass
        try:
            self.model_patcher.pre_run()
            return self.inner_sample(noise, latent_image, device, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, **kwargs)
        finally:
            self.model_patcher.cleanup()
            comfy.sampler_helpers.cleanup_models(self.conds, self.loaded_models)
            del self.inner_model
            del self.loaded_models


def _to(value, device):
    """A processed conditioning entry with its tensors on `device` (ComfyUI's CONDRegular and friends hold `.cond`)."""
    if isinstance(value, torch.Tensor):
        return value.to(device)
    if isinstance(value, dict):
        return {k: _to(v, device) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_to(v, device) for v in value)
    return value


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class _Loop(comfy.samplers.Sampler):
    """What the guider "samples" with: the training steps. Called once the model is loaded and the conditioning is the
    model's own."""

    def __init__(self, run):
        self.run = run

    def sample(self, model_wrap, sigmas, extra_args, callback, noise, latent_image=None, denoise_mask=None, disable_pbar=False):
        self.run.steps_loop(model_wrap, extra_args)
        return torch.zeros_like(latent_image)


class Run:
    """One segment of a job's training: from the step its state stands at, until the work is done, the segment's step or
    time is up, or someone stops it."""

    def __init__(self, model, job, cfg):
        self.job = job
        self.cfg = cfg
        self.work = _work(job)
        self.pid = _prompt_id()
        self.model = model
        self.total = int(cfg["steps"])
        self.rank = int(cfg.get("rank", 16))
        self.alpha = float(cfg.get("alpha", self.rank))
        self.lr = float(cfg.get("lr", 1e-4))
        self.accum = max(1, int(cfg.get("accum", 1)))
        self.warmup = max(0, int(cfg.get("warmup", min(100, self.total // 20))))
        self.schedule = cfg.get("schedule", "constant")
        self.timestep = cfg.get("timestep", "sigmoid")
        self.loss_kind = cfg.get("loss", "target")
        self.dropout = float(cfg.get("caption_dropout", 0.05))
        self.seed = int(cfg.get("seed", 0))
        self.save_at = sorted({int(s) for s in cfg.get("save_at", []) if 0 < int(s) < self.total})
        self.stop_at = min(self.total, int(cfg.get("stop_at", 0)) or self.total)
        self.budget = float(cfg.get("budget_s", 0))
        self.save_every = float(cfg.get("save_every_s", 300))
        self.name = cfg["name"]
        self.offload = bool(cfg.get("offload", False))
        self.checkpointing = bool(cfg.get("checkpointing", True))
        self.meta = cfg.get("meta", {})
        self.started = time.time()
        self.step = 0
        self.loras = {}
        self.losses = []  # [step, loss] thinned for a chart
        self.ema = None
        self.saved = []
        self.nan = 0
        self.peak = 0.0
        self.pace = None
        self.seconds = 0.0
        self.patched = None

    # -------------------------------------------------------------- state

    def signature(self):
        return {"v": STATE_VERSION, "rank": self.rank, "alpha": self.alpha, "layers": len(self.loras), "base": self.cfg.get("base", ""), "conv": bool(self.cfg.get("conv", False))}

    def state_path(self):
        return os.path.join(self.work, "state.pt")

    def save_state(self):
        # From now on the state is this machine's own again (see _load_state).
        moved = os.path.join(self.work, "state.moved")
        if os.path.isfile(moved):
            os.remove(moved)
        state = {
            "signature": self.signature(),
            "step": self.step,
            "lora": {n: {"down": l.down.detach().to("cpu"), "up": l.up.detach().to("cpu")} for n, l in self.loras.items()},
            "optimizer": self.optimizer.state_dict(),
            "scaler": self.scaler.state_dict() if self.scaler else None,
            "losses": self.losses[-4000:],
            "ema": self.ema,
            "saved": self.saved,
            "rng": self.rng.get_state(),
            "py_rng": self.py_rng.getstate(),
            "lr_scale": self.lr_scale,
        }
        _atomic(self.state_path(), lambda tmp: torch.save(state, tmp))

    def load_state(self):
        path = self.state_path()
        # A run Crackio has at step N, with nothing of it kept here (the models folder was moved, a container's disk
        # was reset): said, where it used to train from step 0 again with Crackio still showing step N, saving the
        # early versions over the ones already made.
        resume = int(self.cfg.get("resume_step") or 0)
        if resume > 0 and not self.cfg.get("fresh") and not os.path.isfile(path):
            raise TrainError("GONE", f"nothing is kept of this run on this machine any more (it was at step {resume})")
        if self.cfg.get("fresh") or not os.path.isfile(path):
            if os.path.isfile(path):
                os.remove(path)
            # (The versions of the attempt before are no longer this run's: said, or Crackio takes them back.)
            _tell(self.job, {"saved": []}, force=True)
            return False
        try:
            state = _load_state(self.work)
        except Exception as e:
            raise TrainError("STATE", f"the kept training state can't be read ({str(e)[:120]})")
        if state.get("signature") != self.signature():
            raise TrainError("STATE", "the kept training state is for other settings (rank, layers or model)")
        for n, l in self.loras.items():
            l.down.data.copy_(state["lora"][n]["down"])
            l.up.data.copy_(state["lora"][n]["up"])
        self._kept = state
        self.step = int(state["step"])
        self.losses = list(state.get("losses", []))
        self.ema = state.get("ema")
        self.saved = list(state.get("saved", []))
        return True

    # -------------------------------------------------------------- set-up

    def dataset(self):
        index = _read_json(os.path.join(self.work, "dataset.json"))
        if not index or not index.get("items"):
            raise TrainError("DATA", "the prepared pictures are missing: prepare them again")
        cache = os.path.join(self.work, "cache")
        keys = sorted(set(it["cond"] for it in index["items"]) | {index["empty"]})
        conds = []
        for k in keys:
            c = torch.load(os.path.join(cache, f"c_{k}.pt"), map_location="cpu", weights_only=False)
            guidance = self.cfg.get("guidance")
            if guidance is not None:
                c = [[t, {**d, "guidance": float(guidance)}] for t, d in c]
            # One caption is one entry; a prompt scheduled in parts (never from Crackio) would be several.
            conds.append(c[0])
        self.cond_index = {k: i for i, k in enumerate(keys)}
        self.empty = self.cond_index[index["empty"]]
        self.items = index["items"]
        self.latents = [torch.load(os.path.join(cache, it["latent"]), map_location="cpu", weights_only=False) for it in self.items]
        # An edit LoRA's pairs: each before picture goes in with its pair's words (ComfyUI's "reference latents", what
        # its edit nodes set), so a pair is an entry of its own.
        self.refs = [torch.load(os.path.join(cache, it["ref"]), map_location="cpu", weights_only=False) if it.get("ref") else None for it in self.items]
        self.item_cond = []
        # Qwen-Image-Edit reads its reference the way its ComfyUI template sets it (FluxKontextMultiReferenceLatentMethod).
        method = {"reference_latents_method": "index_timestep_zero"} if index.get("edit") == "qwen-edit" else {}
        for it, ref in zip(self.items, self.refs):
            i = self.cond_index[it["cond"]]
            if ref is not None:
                words, more = conds[i]
                conds.append([words, {**more, "reference_latents": [ref], **method}])
                i = len(conds) - 1
            self.item_cond.append(i)
        return conds

    def precision(self, device):
        asked = self.cfg.get("precision", "auto")
        if asked == "auto":
            if device.type != "cuda":
                asked = "fp32" if device.type == "cpu" else "bf16" if _supports(device, torch.bfloat16) else "fp32"
            elif mm.should_use_bf16(device, prioritize_performance=False):
                asked = "bf16"
            elif mm.should_use_fp16(device, prioritize_performance=False):
                asked = "fp16"
            else:
                asked = "fp32"
        return {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[asked], asked

    def train(self):
        cfg, job = self.cfg, self.job
        device = mm.get_torch_device()
        # Other programs on this GPU: said, and where they leave too little for this training, refused here in words.
        # Run into instead, PyTorch's GPU error takes the whole ComfyUI down (a 6 GB card with a 3D app open did).
        held = _others_on_gpu(device)
        if held:
            others, size = held
            need = float(cfg.get("need_gb") or 0)
            _tell(job, {"others_gb": round(others, 2), "gpu_gb": round(size, 2)}, force=True)
            if others >= 1.0:
                _say(job, f"Other programs hold {others:.1f} GB of this GPU's {size:.0f} GB")
            if need and size - others - 0.3 < need * 0.8:
                raise TrainError("CROWDED", f"other programs are using {others:.1f} GB of this GPU's {size:.0f} GB, which leaves too little for this training (about {need:.1f} GB)")
        if device.type == "cuda":
            # What ComfyUI itself still holds after letting its models go (what it kept from the last graph it ran):
            # said, so a run that then finds too little room says why.
            gc.collect()
            mm.soft_empty_cache(True)
            kept = torch.cuda.memory_allocated(device) / 1024**3
            if kept >= 1.0:
                _say(job, f"ComfyUI still holds {kept:.1f} GB of this GPU from the jobs before")
        conds = self.dataset()
        self.dtype, dtype_name = self.precision(device)

        # A model of our own to train on, as ComfyUI's trainer makes it: loaded again outside inference mode, so its
        # weights can sit in a graph that's differentiated.
        # A model ComfyUI pages into GPU memory as it draws ("dynamic VRAM") is loaded the plain way instead. The way
        # back through a step reads every weight again, and a weight paged out since is memory that's gone: a CUDA
        # "illegal memory access" that takes the whole ComfyUI down without a word (seen on an RTX 3090, Nov 2026:
        # Qwen-Image 2.1 always, which pages block by block; FLUX 3 Klein once pictures had been made on the GPU and
        # their models still held part of it).
        paged = bool(getattr(self.model, "is_dynamic", lambda: False)())
        try:
            try:
                mp = self.model.clone(disable_dynamic=True, force_deepcopy=True) if paged else self.model.clone(force_deepcopy=True)
            except RuntimeError:
                if not paged:
                    raise
                # A loader that can't give a plain copy (ComfyUI keeps how to load it again only for its own loaders).
                mp = self.model.clone(force_deepcopy=True)
        except TypeError:
            raise TrainError("MODEL", "this ComfyUI is too old to train LoRAs: update it")
        except RuntimeError as e:
            raise TrainError("MODEL", f"this model's loader can't be trained on ({str(e)[:140]})")
        dm = mp.model.diffusion_model
        if getattr(dm, "flow_map", False):
            raise TrainError("MODEL", "this file is the fast, step-distilled model, which can't be trained on: train on the Base file (the LoRA then runs on the fast one)")
        quantized = _quantized(dm)
        if not quantized and self.dtype != torch.float32:
            mp.set_model_compute_dtype(self.dtype)
        mp.model.requires_grad_(False)
        mp.model_options.setdefault("transformer_options", {})["optimized_attention_override"] = _sdpa

        layers = target_layers(mp.model.diffusion_model, cfg.get("include"), cfg.get("exclude"), bool(cfg.get("conv", False)))
        if not layers:
            raise TrainError("MODEL", "found no layers to train in this model")
        for name, m in layers:
            torch.manual_seed(int(hashlib.sha1(f"{self.seed}|{name}".encode()).hexdigest()[:8], 16))
            self.loras[name] = Lora(m, self.rank, self.alpha)
        self.rng = torch.Generator().manual_seed(self.seed)
        self.py_rng = random.Random(self.seed)
        self.lr_scale = 1.0
        resumed = self.load_state()
        params = [p for l in self.loras.values() for p in (l.down, l.up)]
        count = sum(p.numel() for p in params)

        opt = cfg.get("optimizer", "adamw").lower()
        decay = float(cfg.get("weight_decay", 0.01))
        blocks = _blocks(mp.model.diffusion_model, int(cfg.get("checkpoint_depth", 1))) if self.checkpointing else []
        mm.in_training = True
        if hasattr(mm, "training_fp8_bwd"):
            mm.training_fp8_bwd = bool(cfg.get("fp8_backward", False)) and quantized
        unpatch = lambda: None  # noqa: E731
        try:
            # Models ComfyUI wrote for drawing only get their training forms first (train_patches.py).
            try:
                self.patched, unpatch = train_patches.apply(dm)
            except RuntimeError as e:
                raise TrainError("MODEL", str(e))
            for name, m in layers:
                self.loras[name].to(device)
                _attach(m, self.loras[name])
            for b in blocks:
                _checkpointed(b)
            # Made once the LoRA is on the GPU, so its state is made (and loaded) there too.
            if opt == "adamw":
                self.optimizer = torch.optim.AdamW(params, lr=self.lr, weight_decay=decay, betas=(0.9, 0.999), eps=1e-8)
            elif opt == "adam":
                self.optimizer = torch.optim.Adam(params, lr=self.lr)
            else:
                raise TrainError("MODEL", f"unknown optimizer {opt}")
            self.scaler = torch.amp.GradScaler(device.type) if self.dtype == torch.float16 and device.type == "cuda" else None
            self.params = params
            if resumed:
                self.optimizer.load_state_dict(self._kept["optimizer"])
                if self.scaler and self._kept.get("scaler"):
                    self.scaler.load_state_dict(self._kept["scaler"])
                self.rng.set_state(self._kept["rng"])
                self.py_rng.setstate(self._kept["py_rng"])
                self.lr_scale = float(self._kept.get("lr_scale", 1.0))
                del self._kept
            # The scale asked for stands as it is. Multiplied into the kept one, which held it already, a run cut to
            # half after a loss that wasn't a number went to a quarter at the next saved version, then an eighth.
            if cfg.get("lr_scale") is not None:
                self.lr_scale = float(cfg["lr_scale"])
            _say(job, ("Continuing from step %d of %d" % (self.step, self.total)) if resumed else f"Training {len(layers)} layers ({count / 1e6:.1f}M values, rank {self.rank}) for {self.total} steps")
            _say(job, f"{dtype_name} maths, {'quantized weights, ' if quantized else ''}{'saving memory by redoing each block on the way back' if self.checkpointing else 'no gradient checkpointing'}{', weights streamed from RAM' if self.offload else ''}")
            _tell(job, {"phase": "loading", "step": self.step, "steps": self.total, "error": None, "code": None, "layers": len(layers), "values": count, "precision": dtype_name, "quantized": quantized}, force=True, prompt_id=self.pid)
            if self.step < self.stop_at:
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                mm.soft_empty_cache()
                try:
                    mm.load_models_gpu([mp], memory_required=1e20, force_full_load=not self.offload)
                except TypeError:
                    mm.load_models_gpu([mp])
                guider = _Guider(mp, self.offload)
                guider.set_conds(conds)
                self.mp = mp
                dummy = self.latents[0].to(torch.float32)
                guider.sample(torch.zeros_like(dummy), dummy, _Loop(self), torch.tensor([1.0, 0.0]), seed=self.seed)
        finally:
            mm.in_training = False
            if hasattr(mm, "training_fp8_bwd"):
                mm.training_fp8_bwd = False
            CHECKPOINTING["on"] = True
            train_patches.ORIGINAL["on"] = False
            for b in blocks:
                _uncheckpointed(b)
            for _, m in layers:
                _detach(m)
            unpatch()
        return self.finish()

    # -------------------------------------------------------------- steps

    def sigma(self, ms):
        """A noise level for one step, drawn the way dedicated trainers draw it. "shift": any level alike, passed
        through the model's own time shift (or `shift`, a number: BFL trains FLUX 3 at its fixed 6.93). "sigmoid": round
        the middle (the sigmoid of a normal draw), shifted only when `shift` is given. Older, noise-predicting models:
        any of their timesteps alike."""
        u = torch.rand((), generator=self.rng).item()
        if self.timestep == "sigmoid":
            n = torch.randn((), generator=self.rng).item()
            u = 1.0 / (1.0 + math.exp(-n * float(self.cfg.get("sigmoid_scale", 1.0))))
        u = _clamp(u, 1e-3, 1.0 - 1e-3)
        if not _flow(ms):
            return float(ms.percent_to_sigma(1.0 - u))
        shift = self.cfg.get("shift")
        if shift is None:
            return float(ms.percent_to_sigma(1.0 - u)) if self.timestep == "shift" else u
        shift = float(shift)
        return shift * u / (1.0 + (shift - 1.0) * u)

    def lr_now(self):
        lr = self.lr * self.lr_scale
        if self.warmup and self.step < self.warmup:
            lr *= (self.step + 1) / self.warmup
        if self.schedule == "cosine":
            p = _clamp((self.step - self.warmup) / max(1, self.total - self.warmup), 0.0, 1.0)
            lr *= 0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * p))
        return lr

    def predict(self, model_wrap, extra_args, cond, latent, noise, s, device, grad=True):
        """The model's answer (the clean picture it predicts) for `latent` noised to level `s`."""
        ms = model_wrap.inner_model.model_sampling
        sigma = torch.full((latent.shape[0],), s, device=device, dtype=torch.float32)
        xt = ms.noise_scaling(sigma, noise, latent, False)
        model_wrap.conds["positive"] = [_to(cond, device)]
        with torch.autocast(device.type, dtype=self.dtype, enabled=self.dtype != torch.float32):
            if grad:
                return model_wrap(xt.requires_grad_(True), sigma.requires_grad_(True), **extra_args)
            return model_wrap(xt, sigma, **extra_args)

    def loss(self, pred, latent, s):
        # ComfyUI's models answer with the clean picture they predict. Divided by the noise level squared, its error is
        # the error of what the model itself outputs (velocity or noise): the loss dedicated trainers use.
        err = F.mse_loss(pred.float(), latent.float())
        if self.loss_kind == "target":
            err = err / max(s, float(self.cfg.get("sigma_floor", 0.02))) ** 2
            cap = self.cfg.get("snr_gamma")
            if cap:
                err = err * min(1.0, float(cap) * s * s)
        return err

    def selftest(self, model_wrap, extra_args, all_conds, device):
        """Before the first step, on a small corner of the first picture: the model with its training forms answers
        like ComfyUI's own code, and its gradients come out the same with and without gradient checkpointing. A model
        whose code can't be differentiated (it changes tensors in place) is refused here, not trained wrongly."""
        base = model_wrap.inner_model
        ms = base.model_sampling
        small = self.latents[0][..., :16, :16].to(device, torch.float32)
        latent = base.process_latent_in(small)
        noise = torch.randn(latent.shape, generator=torch.Generator().manual_seed(1234), dtype=torch.float32).to(device)
        s = 0.6 if _flow(ms) else float(ms.percent_to_sigma(0.45))
        cond = all_conds[self.item_cond[0]]
        # A pair's before picture is cut to the same small corner: whole, the pass without checkpointing wouldn't fit.
        made = cond.get("model_conds") if isinstance(cond, dict) else None
        if made and "ref_latents" in made:
            kept = made["ref_latents"]
            cond = {**cond, "model_conds": {**made, "ref_latents": type(kept)([t[..., :16, :16] for t in kept.cond])}}
        ups = [l.up for l in self.loras.values()]
        fresh = all(float(u.detach().abs().max()) == 0.0 for u in ups[:8])
        try:
            if self.patched and fresh:
                with torch.no_grad():
                    CHECKPOINTING["on"] = False
                    mine = self.predict(model_wrap, extra_args, cond, latent, noise, s, device, grad=False).float()
                    train_patches.ORIGINAL["on"] = True
                    try:
                        theirs = self.predict(model_wrap, extra_args, cond, latent.clone(), noise, s, device, grad=False).float()
                    finally:
                        train_patches.ORIGINAL["on"] = False
                off = float((mine - theirs).norm() / theirs.norm().clamp_min(1e-8))
                _say(self.job, f"Training form of the model checked against ComfyUI's own: they differ by {off:.1e}")
                if not off < 0.03:
                    raise TrainError("MODEL", f"Crackio's training form of this model no longer matches this ComfyUI's code (they differ by {off:.2f}): the trainer needs an update for this ComfyUI version")

            def grads(checkpointed, of=ups, whole=True):
                CHECKPOINTING["on"] = checkpointed
                for p in self.params:
                    p.grad = None
                err = self.loss(self.predict(model_wrap, extra_args, cond, latent, noise, s, device, grad=whole), latent, s)
                # As a step does it: 16-bit floats lose small gradients unless the loss is scaled up first.
                (self.scaler.scale(err) if self.scaler else err).backward()
                return torch.cat([u.grad.detach().float().flatten() for u in of if u.grad is not None])

            def in_place(e):
                if "inplace" in str(e) or "in-place" in str(e) or "out=" in str(e):
                    return TrainError("MODEL", "ComfyUI's code for this model changes tensors in place, so it can't be trained on yet (Crackio has training forms for FLUX 3, Qwen-Image 2.1, FLUX.1 and FLUX.2 so far)")
                return None

            def let_go():
                for p in self.params:
                    p.grad = None
                gc.collect()
                mm.soft_empty_cache(True)

            where = ""
            too_big = False
            try:
                plain = grads(False)
            except RuntimeError as e:
                refused = in_place(e)
                if refused:
                    raise refused
                if not (self.checkpointing and mm.is_oom(e)):
                    raise
                too_big = True
            if too_big:
                # Without checkpointing the whole model's graph is held at once, with a copy of every weight it had
                # to convert on the way (a 20B model in FP8 passed 22 GB on a 24 GB card before its first step). The
                # training itself never needs that. So the two ways are compared on the model's last layers only:
                # nothing before them is kept for the way back. (Out here, not inside the `except`: a caught error
                # keeps everything its failed pass held until its handler is left.)
                let_go()
                tail = ups[-12:]
                frozen = [p for p in self.params if not any(p is u for u in tail)]
                for p in frozen:
                    p.requires_grad_(False)
                try:
                    try:
                        plain = grads(False, tail, whole=False)
                        where = " (on the model's last layers: the whole graph at once doesn't fit this card)"
                    except RuntimeError as e:
                        refused = in_place(e)
                        if refused:
                            raise refused
                        if not mm.is_oom(e):
                            raise
                        plain = None
                    if plain is None:
                        let_go()
                    saved = grads(True, tail, whole=False) if plain is not None else None
                finally:
                    for p in frozen:
                        p.requires_grad_(True)
                    let_go()
                if plain is None:
                    _say(self.job, "The check without memory saving doesn't fit this card, even on the model's last layers: the gradients are checked with it on only")
                    plain = saved = grads(True)
            else:
                saved = grads(True) if self.checkpointing else None
            if saved is not None and saved is not plain:
                cos = float(F.cosine_similarity(plain, saved, dim=0))
                ratio = float(saved.norm() / plain.norm().clamp_min(1e-12))
                _say(self.job, f"Gradient check: with and without checkpointing agree to {cos:.5f} (size {ratio:.3f}){where}")
                if not (cos > 0.995 and 0.97 < ratio < 1.03):
                    raise TrainError("MODEL", f"this model's gradients come out wrong with memory saving on (agreement {cos:.3f}): ComfyUI's code for it isn't safe to train on yet")
            if not torch.isfinite(plain).all() or float(plain.norm()) == 0.0:
                raise TrainError("MODEL", "the model gave no gradient to learn from")
        finally:
            CHECKPOINTING["on"] = True
            self.optimizer.zero_grad(set_to_none=True)
            mm.soft_empty_cache()

    def one(self, model_wrap, extra_args, all_conds, device):
        """One picture: its noised latent through the model and back. Returns the loss as a number, or None when it
        wasn't one (then nothing was added to the gradient)."""
        base = model_wrap.inner_model
        ms = base.model_sampling
        i = self.py_rng.randrange(len(self.items))
        # Now and then a picture goes in without its words (never a pair: its words are the instruction).
        ci = self.empty if self.dropout and self.refs[i] is None and self.py_rng.random() < self.dropout else self.item_cond[i]
        latent = base.process_latent_in(self.latents[i].to(device, torch.float32))
        noise = torch.randn(latent.shape, generator=self.rng, dtype=torch.float32).to(device)
        s = self.sigma(ms)
        pred = self.predict(model_wrap, extra_args, all_conds[ci], latent, noise, s, device)
        err = self.loss(pred, latent, s)
        if not torch.isfinite(err):
            return None
        scaled = err / self.accum
        if self.scaler:
            self.scaler.scale(scaled).backward()
        else:
            scaled.backward()
        return float(err.detach())

    def steps_loop(self, model_wrap, extra_args):
        job = self.job
        device = self.mp.load_device
        all_conds = list(model_wrap.conds["positive"])
        bar = comfy.utils.ProgressBar(self.total)
        bar.update_absolute(self.step)
        # (A stop asked for while the stretch waited or its model loaded is still wanted: it's honoured after the first
        # step. It used to be cleared here, and the stretch ran on to the next saved version, an hour at most.)
        j = _job(job)
        last_save = time.time()
        t0 = time.time()
        pace = None
        seg_start = self.step
        thin = max(1, self.total // 400)
        if self.step == 0 and self.cfg.get("selftest", True):
            _say(job, "Model loaded, checking it before the first step")
            self.selftest(model_wrap, extra_args, all_conds, device)
        _say(job, "Training")
        _tell(job, {"phase": "training"}, force=True, prompt_id=self.pid)
        self.optimizer.zero_grad(set_to_none=True)
        while self.step < self.stop_at:
            began = time.time()
            for g in self.optimizer.param_groups:
                g["lr"] = self.lr_now()
            total, got = 0.0, 0
            try:
                for _ in range(self.accum):
                    loss = self.one(model_wrap, extra_args, all_conds, device)
                    if loss is not None:
                        total += loss
                        got += 1
            except Exception as e:
                self.optimizer.zero_grad(set_to_none=True)
                if mm.is_oom(e):
                    del e
                    gc.collect()
                    mm.soft_empty_cache(True)
                    self.save_state()
                    raise TrainError("OOM", f"out of GPU memory at step {self.step + 1} (rank {self.rank}, pictures up to {max(i['width'] * i['height'] for i in self.items) / 1e6:.2f} MP)")
                raise
            if not got:
                # A step with no number to learn from is skipped; a run of them means the settings can't work.
                self.optimizer.zero_grad(set_to_none=True)
                self.nan += 1
                if self.nan >= 8:
                    raise TrainError("NAN", f"the loss stopped being a number at step {self.step + 1}")
                continue
            if self.scaler:
                self.scaler.unscale_(self.optimizer)
            norm = torch.nn.utils.clip_grad_norm_(self.params, float(self.cfg.get("clip", 1.0)))
            if not torch.isfinite(norm):
                self.optimizer.zero_grad(set_to_none=True)
                if self.scaler:
                    self.scaler.update()
                self.nan += 1
                if self.nan >= 8:
                    raise TrainError("NAN", f"the gradients stopped being numbers at step {self.step + 1}")
                continue
            if self.scaler:
                self.scaler.step(self.optimizer)
                self.scaler.update()
            else:
                self.optimizer.step()
            self.optimizer.zero_grad(set_to_none=True)
            self.nan = 0
            self.step += 1
            loss = total / got
            self.ema = loss if self.ema is None else self.ema * 0.98 + loss * 0.02
            took = time.time() - began
            # The first steps of a segment include warming up (cudnn, the allocator): the pace settles after them.
            if self.step - seg_start > 2:
                pace = took if pace is None else pace * 0.9 + took * 0.1
                self.pace = pace
            if self.step % thin == 0 or self.step == self.total:
                self.losses.append([self.step, round(self.ema, 5)])
            if device.type == "cuda":
                # What the card has in use, as the driver sees it (ComfyUI keeps weights outside PyTorch's own count).
                try:
                    free, whole = torch.cuda.mem_get_info(device)
                    self.peak = max(self.peak, (whole - free) / 1024**3)
                except Exception:
                    self.peak = max(self.peak, torch.cuda.max_memory_allocated() / 1024**3)
            bar.update_absolute(self.step)
            if self.step % 50 == 0 or self.step == self.total:
                _say(job, f"step {self.step}/{self.total}  loss {self.ema:.4f}  {('%.2f s/step' % pace) if pace else ''}  lr {self.lr_now():.2e}")
            _tell(
                job,
                {"step": self.step, "loss": round(self.ema, 5), "raw": round(loss, 5), "pace": round(pace, 3) if pace else None, "peak_gb": round(self.peak, 2), "lr": self.lr_now(), "losses": self.losses[-400:]},
                prompt_id=self.pid,
            )
            if self.step in self.save_at:
                self.checkpoint()
                last_save = time.time()
            elif time.time() - last_save > self.save_every:
                self.save_state()
                last_save = time.time()
            if self.step >= self.stop_at:
                break
            if j["stop"]:
                _say(job, "Pausing here" if j["stop"] == "pause" else "Finishing here, as asked")
                if j["stop"] == "finish":
                    self.total = self.step
                j["stop"] = None
                break
            if self.budget and time.time() - self.started > self.budget:
                break
            if mm.processing_interrupted():
                self.save_state()
                _say(job, f"Interrupted at step {self.step}: kept, so it can continue")
                _tell(job, {"phase": "paused", "step": self.step}, force=True, prompt_id=self.pid)
                mm.throw_exception_if_processing_interrupted()
        self.save_state()
        self.seconds = time.time() - t0

    def lora_path(self, step=None):
        stem = self.name if step is None else f"{self.name}-{step:06d}"
        return os.path.join(_loras_dir(), f"{stem}.safetensors")

    def checkpoint(self):
        self.save_state()
        path = self.lora_path(self.step)
        size = save_lora(self.loras, path, {**self.meta, "crackio.step": self.step, "crackio.steps": self.total, "crackio.rank": self.rank})
        self.saved = [s for s in self.saved if s["step"] != self.step] + [{"step": self.step, "file": os.path.basename(path), "bytes": size, "loss": round(self.ema or 0, 5)}]
        self.save_state()
        _say(self.job, f"Saved a checkpoint at step {self.step}: {os.path.basename(path)}")
        _tell(self.job, {"saved": self.saved}, force=True, prompt_id=self.pid)

    def finish(self):
        done = self.step >= self.total
        out = {"job": self.job, "step": self.step, "steps": self.total, "done": done, "loss": self.ema, "pace": self.pace, "peak_gb": round(self.peak, 2), "saved": self.saved, "seconds": round(self.seconds, 1), "losses": self.losses[-400:], "log": _job(self.job)["log"][-120:]}
        files = []
        if done:
            path = self.lora_path()
            size = save_lora(self.loras, path, {**self.meta, "crackio.step": self.step, "crackio.steps": self.total, "crackio.rank": self.rank})
            out["file"] = os.path.basename(path)
            out["bytes"] = size
            _say(self.job, f"Done: {os.path.basename(path)} ({size / 1e6:.0f} MB)")
            if self.cfg.get("export"):
                files.append(_export(path))
        _tell(self.job, {"phase": "done" if done else "paused", "step": self.step, "steps": self.total, "saved": self.saved, **({"file": out["file"], "bytes": out["bytes"]} if done else {})}, force=True, prompt_id=self.pid)
        return out, files


def _flow(ms):
    """Whether a model's sampling is flow matching (ComfyUI's CONST type): its noise level is its time, 0 to 1."""
    return any(c.__name__ == "CONST" for c in type(ms).__mro__)


def _supports(device, dtype):
    try:
        torch.zeros(1, device=device, dtype=dtype)
        return True
    except Exception:
        return False


def _quantized(model):
    """Whether the model's weights are kept quantized (ComfyUI's INT8, FP8 or NVFP4 layouts)."""
    fp8 = tuple(getattr(torch, n) for n in ("float8_e4m3fn", "float8_e5m2") if hasattr(torch, n))
    for m in model.modules():
        w = getattr(m, "weight", None)
        if w is not None and type(w).__name__ == "QuantizedTensor":
            return True
        if isinstance(w, torch.Tensor) and fp8 and w.dtype in fp8:
            return True
    return False


def _export(path):
    """A copy in ComfyUI's output folder, which /view serves (and a serverless worker sends back)."""
    sub = os.path.join("crackio", "train")
    out = os.path.join(folder_paths.get_output_directory(), sub)
    os.makedirs(out, exist_ok=True)
    dest = os.path.join(out, os.path.basename(path))
    shutil.copyfile(path, dest)
    return {"filename": os.path.basename(path), "subfolder": sub.replace(os.sep, "/"), "type": "output"}


class _Kept:
    def __init__(self, d, alpha):
        self.up, self.down, self.alpha = d["up"], d["down"], alpha


def finalize(job, cfg):
    """The LoRA as it stands in the kept state (or at one of its checkpoints), saved under its own name without
    training further."""
    work = _work(job)
    dest = os.path.join(_loras_dir(), f"{cfg['name']}.safetensors")
    pick = cfg.get("from_checkpoint")
    if pick:
        if not LORA_NAME.match(str(pick)):
            raise TrainError("STATE", "that isn't one of this job's checkpoints")
        src = os.path.join(_loras_dir(), str(pick))
        if not os.path.isfile(src):
            raise TrainError("STATE", f"the checkpoint {pick} is gone")
        shutil.copyfile(src, dest)
        size = os.path.getsize(dest)
        step = int(cfg.get("step", 0))
        saved = (_read_json(os.path.join(work, "status.json")) or {}).get("saved", [])
        ema = None
    else:
        path = os.path.join(work, "state.pt")
        if not os.path.isfile(path):
            raise TrainError("STATE", "nothing has been trained yet")
        state = _load_state(work)
        rank, alpha = state["signature"]["rank"], state["signature"]["alpha"]
        step = int(state["step"])
        if step <= 0:
            raise TrainError("STATE", "nothing has been trained yet")
        loras = {n: _Kept(d, alpha) for n, d in state["lora"].items()}
        size = save_lora(loras, dest, {**cfg.get("meta", {}), "crackio.step": step, "crackio.steps": step, "crackio.rank": rank})
        saved, ema = state.get("saved", []), state.get("ema")
    _say(job, f"Saved as it stands at step {step}: {os.path.basename(dest)}")
    files = [_export(dest)] if cfg.get("export") else []
    _tell(job, {"phase": "done", "step": step, "steps": step, "file": os.path.basename(dest), "bytes": size}, force=True, prompt_id=_prompt_id())
    return {"job": job, "step": step, "steps": step, "done": True, "file": os.path.basename(dest), "bytes": size, "saved": saved, "loss": ema}, files


class CrackioTrainLora:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "job": ("STRING", {"default": ""}),
                "config": ("STRING", {"default": "{}", "multiline": True, "tooltip": "JSON: name, steps, rank, lr and the rest (see train.py)."}),
            },
            "optional": {"data": ("STRING", {"forceInput": True, "tooltip": "From Crackio Training Data, so the pictures are prepared first."})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("result",)
    FUNCTION = "train"
    CATEGORY = "Crackio/training"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")  # every job is the next segment

    def train(self, model, job, config, data=None):
        cfg = json.loads(config)
        try:
            with torch.inference_mode(False), torch.enable_grad():
                if cfg.get("finalize"):
                    out, files = finalize(job, cfg)
                else:
                    out, files = Run(model, job, cfg).train()
        except TrainError as e:
            _fail(job, e)
            raise
        except mm.InterruptProcessingException:
            raise
        except Exception as e:
            if mm.is_oom(e):
                err = TrainError("OOM", "out of GPU memory while loading the model for training")
                _fail(job, err)
                raise err
            _say(job, traceback.format_exc()[-1500:])
            _fail(job, e)
            raise
        finally:
            gc.collect()
            mm.soft_empty_cache()
        return {"ui": {"crackio_train": [out], **({"crackio_files": files} if files else {})}, "result": (json.dumps(out),)}


# ------------------------------------------------------------------ what a model file is


class _Lazy:
    """A safetensors file as the state dict ComfyUI's model detection reads: names, shapes, and tensors only when asked."""

    def __init__(self, handle, prefix=""):
        self.f = handle
        self.prefix = prefix
        self.names = set(handle.keys())

    def keys(self):
        return [k[len(self.prefix):] for k in self.names if k.startswith(self.prefix)] if self.prefix else list(self.names)

    def __contains__(self, k):
        return (self.prefix + k) in self.names

    def __iter__(self):
        return iter(self.keys())

    def __len__(self):
        return len(self.keys())

    def __getitem__(self, k):
        if (self.prefix + k) not in self.names:
            raise KeyError(k)
        return self.f.get_tensor(self.prefix + k)

    def get(self, k, default=None):
        return self[k] if k in self else default

    def items(self):
        return ((k, self[k]) for k in self.keys())


def inspect_model(folder, name):
    import safetensors

    if folder not in ("diffusion_models", "checkpoints", "unet"):
        raise ValueError("Models to train on are in diffusion_models or checkpoints.")
    path = folder_paths.get_full_path(folder, name)
    if not path or not os.path.isfile(path):
        raise ValueError(f"{name} isn't in models/{folder}.")
    info = {"folder": folder, "name": name, "bytes": os.path.getsize(path), "format": os.path.splitext(name)[1].lstrip(".").lower()}
    if info["format"] not in ("safetensors", "sft"):
        info["problem"] = "Only .safetensors files can be trained on."
        return info
    with safetensors.safe_open(path, framework="pt") as f:
        meta = f.metadata() or {}
        names = list(f.keys())
        values, dtypes = 0, {}
        for k in names:
            s = f.get_slice(k)
            n = 1
            for d in s.get_shape():
                n *= d
            values += n
            dt = str(s.get_dtype())
            dtypes[dt] = dtypes.get(dt, 0) + n
        info["tensors"] = len(names)
        info["values"] = values
        info["dtypes"] = dtypes
        info["quantized"] = any("quant" in k.lower() for k in meta) or any(k.endswith((".comfy_quant", ".scale_weight", ".weight_scale")) for k in names[:4000])
        import comfy.model_detection as md

        checkpoint = any(k.startswith("model.diffusion_model.") for k in names)
        prefix = "model.diffusion_model." if checkpoint else ""
        if not checkpoint:
            try:
                prefix = md.unet_prefix_from_state_dict(_Lazy(f)) or ""
            except Exception:
                prefix = ""
            # ComfyUI's guess when nothing matches is "model.": a bare model file has no prefix at all.
            if prefix and not any(k.startswith(prefix) for k in names):
                prefix = ""
        info["checkpoint"] = checkpoint
        info["has_text"] = any(k.startswith(("cond_stage_model.", "conditioner.", "text_encoders.")) for k in names)
        info["has_vae"] = any(k.startswith(("first_stage_model.", "vae.")) for k in names)
        try:
            try:
                config = md.model_config_from_unet(_Lazy(f, prefix), "", metadata=meta)
            except TypeError:  # a ComfyUI whose detection takes no metadata
                config = md.model_config_from_unet(_Lazy(f, prefix), "")
        except Exception as e:
            config = None
            info["detect_error"] = str(e)[:200]
        if config is None:
            info["problem"] = info.get("problem") or "ComfyUI doesn't recognise this file as a picture model."
        else:
            info["architecture"] = type(config).__name__
            unet = dict(getattr(config, "unet_config", {}) or {})
            info["image_model"] = unet.get("image_model")
            # A step-distilled flow map (FLUX 3's fast file): it draws, but can't be trained on.
            info["distilled"] = bool(unet.get("flow_map"))
            info["latent"] = type(getattr(config, "latent_format", None)).__name__
            info["sampling"] = str((getattr(config, "sampling_settings", {}) or {}))[:200]
    return info


class CrackioTrainInspect:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"folder": (["diffusion_models", "checkpoints"],), "name": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("STRING",)
    FUNCTION = "look"
    CATEGORY = "Crackio/training"
    OUTPUT_NODE = True

    def look(self, folder, name):
        try:
            info = inspect_model(folder, name)
        except Exception as e:
            info = {"folder": folder, "name": name, "problem": str(e)[:300]}
        return {"ui": {"crackio_train": [info]}, "result": (json.dumps(info),)}


NODE_CLASS_MAPPINGS = {"CrackioTrainData": CrackioTrainData, "CrackioTrainLora": CrackioTrainLora, "CrackioTrainInspect": CrackioTrainInspect}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioTrainData": "Crackio Training Data", "CrackioTrainLora": "Crackio Train LoRA", "CrackioTrainInspect": "Crackio Model Facts"}


# ------------------------------------------------------------------ routes

if PromptServer is not None and web is not None and getattr(PromptServer, "instance", None) is not None:
    routes = PromptServer.instance.routes

    @routes.get("/crackio/train/status")
    async def train_status(request):
        job = request.query.get("job", "")
        if not JOB.match(job):
            return web.json_response({"error": "No such job."}, status=400)
        work = _work(job, make=False)
        if not os.path.isdir(work):
            return web.json_response({"job": job, "phase": None, "log": []})
        j = _job(job)
        since = int(request.query.get("from", "0") or 0)
        with _lock:
            return web.json_response({"job": job, **j["status"], "log": [l for l in j["log"] if l[0] > since], "state": os.path.isfile(os.path.join(work, "state.pt"))})

    @routes.post("/crackio/train/stop")
    async def train_stop(request):
        body = await request.json()
        job = str(body.get("job", ""))
        if not JOB.match(job):
            return web.json_response({"error": "No such job."}, status=400)
        # `clear`: a stop left over from before isn't wanted any more (the run is being carried on).
        _job(job)["stop"] = None if body.get("clear") else "finish" if body.get("finish") else "pause"
        return web.json_response({"ok": True})

    @routes.post("/crackio/train/clean")
    async def train_clean(request):
        body = await request.json()
        job = str(body.get("job", ""))
        if not JOB.match(job):
            return web.json_response({"error": "No such job."}, status=400)
        removed = []
        work = _work(job, make=False)
        if os.path.isdir(work):
            shutil.rmtree(work, ignore_errors=True)
            removed.append("work")
        with _lock:
            _jobs.pop(job, None)
        for name in body.get("loras") or []:
            if not LORA_NAME.match(str(name)):
                continue
            for p in folder_paths.get_folder_paths("loras") or []:
                target = os.path.join(p, str(name))
                if os.path.isfile(target):
                    os.remove(target)
                    removed.append(str(name))
        return web.json_response({"removed": removed})

    @routes.get("/crackio/train/models")
    async def train_models(request):
        out = []
        for folder in ("diffusion_models", "checkpoints"):
            for p in folder_paths.get_folder_paths(folder) or []:
                if not os.path.isdir(p):
                    continue
                for root, _dirs, files in os.walk(p, followlinks=True):
                    for f in files:
                        if f.lower().endswith((".safetensors", ".sft")):
                            full = os.path.join(root, f)
                            out.append({"folder": folder, "name": os.path.relpath(full, p).replace(os.sep, "/"), "bytes": os.path.getsize(full), "dir": p})
        return web.json_response({"models": out, "loras": _loras_dir()})

    @routes.post("/crackio/train/inspect")
    async def train_inspect(request):
        import asyncio

        body = await request.json()
        try:
            info = await asyncio.get_running_loop().run_in_executor(None, inspect_model, str(body.get("folder", "")), str(body.get("name", "")))
        except Exception as e:
            return web.json_response({"error": str(e)[:300]}, status=400)
        return web.json_response(info)

    def _lora_file(name):
        if not LORA_NAME.match(name or ""):
            return None
        for p in folder_paths.get_folder_paths("loras") or []:
            target = os.path.join(p, name)
            if os.path.isfile(target):
                return target
        return None

    @routes.get("/crackio/train/lora")
    async def train_lora_get(request):
        path = _lora_file(request.query.get("name", ""))
        if not path:
            return web.json_response({"error": "No such LoRA."}, status=404)
        return web.FileResponse(path)

    @routes.post("/crackio/train/lora")
    async def train_lora_put(request):
        """A LoRA file sent in pieces: each piece appended at its offset; the last one gives the file its name."""
        name = request.query.get("name", "")
        if not LORA_NAME.match(name):
            return web.json_response({"error": "That isn't a LoRA file name."}, status=400)
        offset, total = int(request.query.get("offset", "0")), int(request.query.get("total", "0"))
        if total <= 0 or total > 8 * 1024**3:
            return web.json_response({"error": "That isn't a LoRA's size."}, status=400)
        dest = os.path.join(_loras_dir(), name)
        part = dest + ".part"
        have = os.path.getsize(part) if os.path.isfile(part) and offset else 0
        if offset != have:
            return web.json_response({"error": "out of order", "have": have}, status=409)
        with open(part, "wb" if offset == 0 else "ab") as f:
            async for chunk in request.content.iter_chunked(1024 * 1024):
                f.write(chunk)
        have = os.path.getsize(part)
        if have < total:
            return web.json_response({"have": have})
        if have > total:
            os.remove(part)
            return web.json_response({"error": "More bytes than the file has."}, status=400)
        try:
            import safetensors

            with safetensors.safe_open(part, framework="pt") as f:
                if not any(any(m in k for m in LORA_MARKS) for k in list(f.keys())[:400]):
                    raise ValueError("no LoRA weights in it")
        except Exception as e:
            os.remove(part)
            return web.json_response({"error": f"That file isn't a LoRA ({str(e)[:120]})."}, status=400)
        os.replace(part, dest)
        return web.json_response({"have": have, "done": True, "file": name})

    @routes.get("/crackio/train/state")
    async def train_state_get(request):
        """What a run carries on from (the LoRA so far, the optimizer, the step): asked for to carry it on on another
        machine, or to keep a copy where this machine going away can't take it. `probe=1`: only whether it's here."""
        job = request.query.get("job", "")
        if not JOB.match(job):
            return web.json_response({"error": "No such job."}, status=400)
        path = os.path.join(_work(job, make=False), "state.pt")
        there = os.path.isfile(path)
        if request.query.get("probe"):
            return web.json_response({"state": there, "bytes": os.path.getsize(path) if there else 0})
        if not there:
            return web.json_response({"error": "Nothing is kept for that job here."}, status=404)
        return web.FileResponse(path)

    @routes.post("/crackio/train/state")
    async def train_state_put(request):
        """A run's state from another machine, sent in pieces: each appended at its offset, the last one puts it where
        this machine's own would be (marked as from outside: see _load_state)."""
        job = request.query.get("job", "")
        if not JOB.match(job):
            return web.json_response({"error": "No such job."}, status=400)
        offset, total = int(request.query.get("offset", "0")), int(request.query.get("total", "0"))
        if total <= 0 or total > 16 * 1024**3:
            return web.json_response({"error": "That isn't a training state's size."}, status=400)
        work = _work(job)
        dest = os.path.join(work, "state.pt")
        part = dest + ".part"
        have = os.path.getsize(part) if os.path.isfile(part) and offset else 0
        if offset != have:
            return web.json_response({"error": "out of order", "have": have}, status=409)
        with open(part, "wb" if offset == 0 else "ab") as f:
            async for chunk in request.content.iter_chunked(1024 * 1024):
                f.write(chunk)
        have = os.path.getsize(part)
        if have < total:
            return web.json_response({"have": have})
        if have > total:
            os.remove(part)
            return web.json_response({"error": "More bytes than the file has."}, status=400)
        with open(os.path.join(work, "state.moved"), "w") as f:
            f.write(str(time.time()))
        os.replace(part, dest)
        return web.json_response({"have": have, "done": True})
