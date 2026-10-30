"""
Crackio pool: one diffusion model split across the GPUs of two computers on your network, so a model that fits neither
GPU runs on both.

The computer that runs the job (the head) keeps the first blocks of the model's transformer in its GPU. Another computer
running ComfyUI with this bridge (the helper) keeps the last blocks in its own GPU memory and computes them. For every
step the head sends the helper the activations between the two halves and gets the result back: tens to hundreds of MB
a step, while the weights cross the network once, when the model first loads. The helper needs no copy of the model
file and no disk space for it.

Head: the node "Crackio Pool Loader (GGUF)" loads a GGUF diffusion model the way Unet Loader (GGUF) does, sends the
helper its share of the weights, and returns a MODEL whose last blocks are run by the helper. Everything else in the
workflow (text encoder, sampler, VAE) runs on the head as usual.

Helper routes:
  GET  /crackio/pool              this GPU's free memory, its compute precision, the model it holds
  POST /crackio/pool/tensors      a batch of a model's weights (raw GGUF blocks and plain tensors, never pickled)
  POST /crackio/pool/build        build that model's blocks on this GPU from the weights sent
  POST /crackio/pool/run          run the blocks on one step's activations
  POST /crackio/pool/free         drop the model

Wire format, both ways: b"CRKP", the header's length (8 bytes, little-endian), a JSON header, then the raw bytes of every
tensor. The header holds a value built from JSON, tensors ({"$t": index}), tensors the helper already holds ({"$h": hash}),
tuples, dicts, torch.Size, dtypes and LTX's compressed timesteps.
"""
import asyncio
import contextlib
import gc
import hashlib
import http.client
import inspect
import json
import logging
import os
import struct
import sys
import threading
import time
import warnings
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import torch

import comfy.model_management as mm
import comfy.samplers
import comfy.sd
import comfy.utils

try:
    from comfy.model_prefetch import pause_malloc_graph
except ImportError:  # older ComfyUI: no allocation graphs to pause
    pause_malloc_graph = None
import folder_paths
import nodes
from aiohttp import web
from server import PromptServer

MAGIC = b"CRKP"
# Weights go up in requests of about this size, so one failed request costs little.
BATCH = 48 * 1024 * 1024
# What the helper keeps free for a step's activations (and the OS: a Mac shares this memory with everything) when it
# picks how many blocks it holds. macOS kills a process that pushes it into heavy swapping, with no log line.
MARGIN = int(3.5 * 1024**3)
# What unpacking weights leaves free on the helper. Unpacked weights take 2-5x the memory of packed ones, and a Mac that
# starts swapping runs slower than it would packed (a Q6 run with 13 of 16 blocks unpacked took 2.2 s a block, packed
# Q8 1.3 s): unpack only with room to spare.
UNPACK_MARGIN = int(3.5 * 1024**3)
# How long the head waits for a helper whose ComfyUI stopped (Crackio starts it again) before the job fails.
COMEBACK_SECONDS = 240
# What the head keeps free on its own GPU for a step's activations when it picks how many blocks stay there.
HEAD_MARGIN = int(2 * 1024**3)
# Inputs that repeat every step (positions, the prompt, masks) stay on the helper; this much at most.
CACHE_BYTES = 2 * 1024**3
# Tensors are 64-byte aligned in a message.
ALIGN = 64
# Inputs a block expects in float32 whatever it computes in (Wan's rotary positions: its attention casts them itself).
KEEP_FLOAT32 = {"freqs"}

DTYPES = {
    "float32": torch.float32,
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
    "float64": torch.float64,
    "int64": torch.int64,
    "int32": torch.int32,
    "int16": torch.int16,
    "int8": torch.int8,
    "uint8": torch.uint8,
    "bool": torch.bool,
}
NAMES = {v: k for k, v in DTYPES.items()}

log = logging.getLogger("crackio.pool")


def _gguf():
    """ComfyUI-GGUF's nodes and ops modules: the pool loads GGUF files exactly the way it does."""
    cls = nodes.NODE_CLASS_MAPPINGS.get("UnetLoaderGGUF")
    if cls is None:
        raise RuntimeError("Pooling needs ComfyUI-GGUF installed in this ComfyUI.")
    mod = sys.modules[cls.__module__]
    return mod, sys.modules[mod.GGMLOps.__module__]


def _plain(t):
    """The tensor as a plain torch.Tensor (GGMLTensor reports its unpacked shape, not its storage's)."""
    return t.as_subclass(torch.Tensor) if type(t) is not torch.Tensor else t


def _raw(t):
    """A tensor's bytes, without copying when it's already contiguous on the CPU (a GGUF file's memory map)."""
    t = _plain(t).detach()
    if t.device.type != "cpu":
        t = t.to("cpu")
    t = t.contiguous()
    if t.numel() == 0:
        return memoryview(b"")
    return t.reshape(-1).view(torch.uint8).numpy()


def _nbytes(t):
    p = _plain(t)
    return p.numel() * p.element_size()


class Packer:
    """Builds one message. `known`: hashes of inputs the other side holds, which go by hash only."""

    def __init__(self, known=None):
        self.entries = []
        self.parts = []
        self.size = 0
        self.known = known
        self.sent = []

    def tensor(self, t, cache=False):
        plain = _plain(t)
        data = _raw(plain)
        entry = {"dtype": NAMES[plain.dtype], "shape": list(plain.shape), "offset": self.size, "nbytes": len(data) if isinstance(data, memoryview) else data.nbytes}
        if cache and self.known is not None:
            h = hashlib.blake2b(data, digest_size=16).hexdigest() + "-" + entry["dtype"] + "-" + "x".join(map(str, entry["shape"]))
            if h in self.known:
                return {"$h": h}
            entry["hash"] = h
            self.sent.append(h)
        tensor_type = getattr(t, "tensor_type", None)
        if tensor_type is not None:
            entry["ggml"] = int(tensor_type)
            entry["lshape"] = list(getattr(t, "tensor_shape", plain.shape))
        pad = -self.size % ALIGN
        if pad:
            self.parts.append(bytes(pad))
            self.size += pad
        entry["offset"] = self.size
        self.entries.append(entry)
        self.parts.append(data)
        self.size += entry["nbytes"]
        return {"$t": len(self.entries) - 1}

    def value(self, v, cache=False):
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, torch.Size):
            return {"$size": list(v)}
        if isinstance(v, torch.Tensor):
            return self.tensor(v, cache)
        if isinstance(v, torch.dtype):
            return {"$dtype": NAMES[v]}
        if isinstance(v, tuple):
            return {"$tuple": [self.value(x, cache) for x in v]}
        if isinstance(v, list):
            return [self.value(x, cache) for x in v]
        if isinstance(v, dict):
            return {"$dict": {str(k): self.value(x, cache) for k, x in v.items()}}
        if type(v).__name__ == "CompressedTimestep":
            return {"$ct": {"data": self.tensor(v.data, cache), "batch_size": v.batch_size, "num_frames": v.num_frames, "patches_per_frame": v.patches_per_frame, "feature_dim": v.feature_dim}}
        # An attention function a model built for this step (Qwen-Image 2.1's block-causal masks): the helper builds the same one.
        if callable(v) and hasattr(v, "crackio_attention"):
            return {"$attn": self.value(v.crackio_attention, cache)}
        raise TypeError(f"The pool can't send a {type(v).__name__}")

    def message(self, meta, value):
        header = json.dumps({"meta": meta, "tensors": self.entries, "value": value}).encode()
        header += b" " * (-(12 + len(header)) % ALIGN)
        return [MAGIC, struct.pack("<Q", len(header)), header, *self.parts]


def unpack(buf):
    """(meta, value tree with tensors on the CPU, tensor entries) from one message."""
    view = memoryview(buf)
    if bytes(view[:4]) != MAGIC:
        raise ValueError("not a pool message")
    (n,) = struct.unpack("<Q", view[4:12])
    header = json.loads(bytes(view[12 : 12 + n]))
    base = 12 + n
    tensors = []
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="The given buffer is not writable")
        for e in header["tensors"]:
            if e["nbytes"]:
                t = torch.frombuffer(view[base + e["offset"] : base + e["offset"] + e["nbytes"]], dtype=torch.uint8)
            else:
                t = torch.empty(0, dtype=torch.uint8)
            t = t.view(DTYPES[e["dtype"]]).reshape(e["shape"])
            tensors.append(t)
    return header["meta"], header["value"], header["tensors"], tensors


def build(v, tensors, lookup=None):
    """The value a message describes. `lookup(hash)` gives tensors the receiver already holds."""
    if isinstance(v, list):
        return [build(x, tensors, lookup) for x in v]
    if not isinstance(v, dict):
        return v
    if "$t" in v:
        return tensors[v["$t"]]
    if "$h" in v:
        return lookup(v["$h"])
    if "$tuple" in v:
        return tuple(build(x, tensors, lookup) for x in v["$tuple"])
    if "$dict" in v:
        return {k: build(x, tensors, lookup) for k, x in v["$dict"].items()}
    if "$size" in v:
        return torch.Size(v["$size"])
    if "$dtype" in v:
        return DTYPES[v["$dtype"]]
    if "$attn" in v:
        return AttentionSpec(build(v["$attn"], tensors, lookup))
    if "$ct" in v:
        from comfy.ldm.lightricks.av_model import CompressedTimestep

        c = v["$ct"]
        out = object.__new__(CompressedTimestep)
        out.data = build(c["data"], tensors, lookup)
        out.batch_size, out.num_frames, out.patches_per_frame, out.feature_dim = c["batch_size"], c["num_frames"], c["patches_per_frame"], c["feature_dim"]
        return out
    raise ValueError(f"unknown value {list(v)[:1]}")


class AttentionSpec:
    """What a model's per-step attention function was built from; `_walk` turns it into the function itself."""

    def __init__(self, spec):
        self.spec = spec


def _attention(spec):
    import comfy.ldm.qwen_image21.model as qwen21

    return qwen21.block_causal_attention(spec["segments"], {}, None, 0, spec["prefix_len"])


def _walk(v, fn):
    """The same tree with every tensor (and compressed timestep's data) passed through fn."""
    if isinstance(v, torch.Tensor):
        return fn(v)
    if isinstance(v, AttentionSpec):
        return _attention(_walk(v.spec, fn))
    if isinstance(v, tuple):
        return tuple(_walk(x, fn) for x in v)
    if isinstance(v, list):
        return [_walk(x, fn) for x in v]
    if isinstance(v, dict):
        return {k: _walk(x, fn) for k, x in v.items()}
    if type(v).__name__ == "CompressedTimestep":
        v.data = fn(v.data)
        return v
    return v


def plain_options(options):
    """The parts of transformer_options a block reads that can cross the network: flags and numbers, not callbacks."""
    out = {}
    for k, v in (options or {}).items():
        if v is None or isinstance(v, (bool, int, float, str)):
            out[k] = v
        elif isinstance(v, (list, tuple)) and all(x is None or isinstance(x, (bool, int, float, str)) for x in v):
            out[k] = list(v)
    return out


# ---------------------------------------------------------------- helper: holds and runs the last blocks


class Session:
    def __init__(self, sid):
        self.id = sid
        self.staged = {}
        self.blocks = None
        self.first = 0
        self.attr = None
        self.device = None
        self.dtype = None
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.bytes = 0
        self.runs = 0
        self.seconds = 0.0
        self.created = time.time()


_sessions = {}
_lock = threading.Lock()
_run_lock = threading.Lock()


def _head_budget(device):
    """GPU memory this computer can give the model: all but what other programs use (a desktop's screens). ComfyUI's own
    models (a text encoder, say) leave first: they would make room for the sampler anyway, and its dynamic VRAM holds
    them outside what PyTorch reports."""
    mm.unload_all_models()
    mm.soft_empty_cache()
    if device.type == "cuda":
        return torch.cuda.mem_get_info(device)[0]
    return mm.get_free_memory(device)


def _free_memory(device):
    if device.type == "mps":
        import psutil

        # What the GPU may still take, and what the system has without swapping (macOS counts reclaimable memory as
        # available, so a gigabyte of it stays out).
        room = torch.mps.recommended_max_memory() - torch.mps.driver_allocated_memory()
        return max(0, min(room, psutil.virtual_memory().available - 1024**3))
    return mm.get_free_memory(device)


def _drop(sid=None):
    with _lock:
        for k in [k for k in _sessions if sid is None or k == sid]:
            del _sessions[k]
    mm.soft_empty_cache()


def _session(sid):
    s = _sessions.get(sid)
    if s is None:
        raise KeyError(sid)
    return s


async def _body(request):
    n = request.content_length or 0
    return await request.content.readexactly(n) if n else b""


@PromptServer.instance.routes.get("/crackio/pool")
async def pool_info(request):
    device = mm.get_torch_device()
    sessions = {s.id: {"blocks": len(s.blocks) if s.blocks is not None else 0, "first": s.first, "ready": s.blocks is not None, "bytes": s.bytes, "runs": s.runs, "seconds": round(s.seconds, 1)} for s in list(_sessions.values())}
    # What a new pooled model can have: free memory, plus what the one held now takes (a new one replaces it).
    held = sum(s["bytes"] for s in sessions.values())
    # A Mac unpacks the blocks it holds (as far as its memory goes), so the head can size its share by unpacked bytes.
    # Its matrix speed lets the head balance a split before either side has measured a step.
    tflops = await asyncio.get_running_loop().run_in_executor(None, _matmul_tflops, device, torch.float32)
    return web.json_response({"device": str(device), "free": _free_memory(device), "held": held, "total": mm.get_total_memory(device), "unpacks": device.type == "mps", "tflops": round(tflops, 2), "sessions": sessions})


@PromptServer.instance.routes.post("/crackio/pool/tensors")
async def pool_tensors(request):
    sid = request.query.get("session", "")
    buf = await _body(request)
    meta, value, entries, tensors = unpack(buf)
    with _lock:
        s = _sessions.get(sid)
        if s is None:
            # One pooled model per helper: a new one replaces what was there (freed before it arrives), and ComfyUI's own
            # models make room.
            _sessions.clear()
            gc.collect()
            mm.unload_all_models()
            mm.soft_empty_cache()
            s = _sessions[sid] = Session(sid)
    _, ops = _gguf()
    import gguf

    for key, i in value.items():
        t, e = tensors[i], entries[i]
        # The bytes came in one request buffer: copy each tensor out so the buffer can go.
        t = t.clone()
        if e.get("ggml") is not None:
            t = ops.GGMLTensor(t, tensor_type=gguf.GGMLQuantizationType(e["ggml"]), tensor_shape=torch.Size(e["lshape"]))
        s.staged[key] = t
    return web.json_response({"ok": True, "staged": len(s.staged)})


_SPEEDS = {}

# The precision unpacked weights are kept in, by the one a step computes in: fp32 compute keeps them in fp16 (half the
# memory; each layer casts its weight as it runs, which is far cheaper than unpacking a K-quant).
DENSE = {torch.float32: torch.float16}
# GGML's K-quant types (Q2_K, Q3_K, Q4_K, Q5_K, Q6_K), the ones that cost real work to unpack.
K_QUANTS = {10, 11, 12, 13, 14}


def _densify(blocks, device, store):
    """Unpacks each block's quantized weights once, in `store` precision on this GPU, while its memory allows: a step then
    skips unpacking them (a GGUF layer unpacks its weight at every step, most of a Mac's time). Blocks it has no room
    for stay packed. Only on a Mac, whose GPU unpacks slowly; returns how many blocks it unpacked."""
    if device.type != "mps":
        return 0
    _, ops = _gguf()
    done = 0
    gc.collect()
    mm.soft_empty_cache()
    for b in blocks:
        # Q8_0 unpacks in one multiply, about as fast as reading fp16: unpacking it once gains almost nothing and doubles
        # its memory, so only K-quants (Q2_K to Q6_K) are worth it.
        packed = [p for p in b.parameters() if ops.is_quantized(p) and int(p.tensor_type) in K_QUANTS]
        extra = sum(p.tensor_shape.numel() * store.itemsize - _nbytes(p) for p in packed)
        # The head sized this share with MARGIN to spare: keep room for a step's activations only.
        if extra > _free_memory(device) - UNPACK_MARGIN:
            break
        for m in b.modules():
            for name in ("weight", "bias"):
                p = m._parameters.get(name)
                if p is not None and ops.is_quantized(p) and int(p.tensor_type) in K_QUANTS:
                    w = ops.dequantize_tensor(p, store).as_subclass(torch.Tensor).contiguous()
                    m._parameters[name] = torch.nn.Parameter(w, requires_grad=False)
        done += 1
        mm.soft_empty_cache()
    return done


def _sync(device):
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize(device)


def _matmul_tflops(device, dtype):
    """How fast this GPU multiplies a block-sized matrix in `dtype`; an M2 does fp16 at 2.6 TFLOPS, fp32 at 2.4, bf16 at 1.4."""
    key = (str(device), dtype)
    if key not in _SPEEDS:
        a = torch.randn(2048, 3072, device=device, dtype=dtype)
        w = torch.randn(6144, 3072, device=device, dtype=dtype)
        for _ in range(2):
            torch.nn.functional.linear(a, w)
        _sync(device)
        start = time.time()
        for _ in range(6):
            torch.nn.functional.linear(a, w)
        _sync(device)
        _SPEEDS[key] = 6 * 2 * 2048 * 3072 * 6144 / max(1e-6, time.time() - start) / 1e12
        del a, w
    return _SPEEDS[key]


def _fastest(device, supported):
    """On a Mac, the precision among those the model runs in that this GPU computes fastest: ComfyUI picks bf16 there,
    which an M2 runs at about half its fp32 speed. Elsewhere ComfyUI's own choice stands (None)."""
    options = [d for d in supported if d in (torch.float16, torch.bfloat16, torch.float32)]
    if device.type != "mps" or not options:
        return None
    best = max(options, key=lambda d: _matmul_tflops(device, d))
    log.info("[crackio pool] " + ", ".join(f"{NAMES[d]} {_matmul_tflops(device, d):.2f}" for d in options) + f" TFLOPS here: computing in {NAMES[best]}")
    return best


def _with_layers(metadata, count):
    """The file's own config, with the helper's block count: ComfyUI builds a model with as many blocks as it says (LTX
    files say 48), and every block without weights would get full-size zero placeholders."""
    cfg = metadata.get("config")
    if isinstance(cfg, str):
        try:
            c = json.loads(cfg)
        except ValueError:
            return metadata
        if isinstance(c.get("transformer"), dict) and "num_layers" in c["transformer"]:
            c["transformer"]["num_layers"] = count
            return {**metadata, "config": json.dumps(c)}
    return metadata


def _build(s, attr, first, metadata, count):
    mod, _ = _gguf()
    metadata = _with_layers(metadata, count)

    ops = mod.GGMLOps()
    kwargs = {"metadata": metadata} if "metadata" in inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters else {}
    staged, s.staged = s.staged, {}
    patcher = comfy.sd.load_diffusion_model_state_dict(staged, model_options={"custom_operations": ops}, **kwargs)
    del staged
    if patcher is None:
        raise RuntimeError("ComfyUI didn't recognize the model the head sent.")
    model = patcher.model
    blocks = getattr(model.diffusion_model, attr)
    if len(blocks) != count:
        raise RuntimeError(f"Built {len(blocks)} blocks where the head sent {count}.")
    device = mm.get_torch_device()
    supported = list(getattr(getattr(model, "model_config", None), "supported_inference_dtypes", None) or [])
    dtype = _fastest(device, supported) or getattr(model, "manual_cast_dtype", None) or model.get_dtype()
    if dtype not in (torch.float16, torch.bfloat16, torch.float32):
        dtype = torch.bfloat16 if mm.should_use_bf16(device) else torch.float16
    # Only the blocks stay: the rest of the model (embeddings, heads) runs on the head.
    del patcher, model
    gc.collect()
    # One block at a time, so each block's CPU copy goes before the next moves (on a Mac both share the same memory).
    total = 0
    for i, b in enumerate(blocks):
        b.to(device)
        total += sum(_nbytes(p) for p in b.parameters())
        if i % 8 == 7:
            gc.collect()
    mm.soft_empty_cache()
    dense = _densify(blocks, device, DENSE.get(dtype, dtype))
    total = sum(_nbytes(p) for b in blocks for p in b.parameters())
    s.blocks, s.first, s.attr, s.device, s.dtype, s.bytes = blocks, first, attr, device, dtype, total
    log.info(f"[crackio pool] holding {len(blocks)} blocks ({total / 1024**3:.1f} GB, {dense} unpacked) on {device} in {dtype}")


@PromptServer.instance.routes.post("/crackio/pool/build")
async def pool_build(request):
    body = await request.json()
    sid = body.get("session", "")
    try:
        s = _session(sid)
    except KeyError:
        return web.json_response({"error": "unknown session"}, status=404)
    try:
        await asyncio.get_running_loop().run_in_executor(None, _build, s, body["attr"], int(body["first"]), body.get("metadata") or {}, int(body["count"]))
    except Exception as e:
        log.exception("[crackio pool] build failed")
        _drop(sid)
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"blocks": len(s.blocks), "device": str(s.device), "dtype": NAMES[s.dtype], "bytes": s.bytes})


class _Missing(Exception):
    def __init__(self, hashes):
        self.hashes = hashes


def _run(s, buf):
    meta, value, entries, tensors = unpack(buf)
    device, dtype = s.device, s.dtype
    # Inputs sent with a hash stay here for the next steps.
    for e, t in zip(entries, tensors):
        h = e.get("hash")
        if h and h not in s.cache:
            dev = t.to(device=device, dtype=torch.float32 if t.dtype == torch.float64 else t.dtype)
            s.cache[h] = dev
            s.cache_bytes += _nbytes(dev)
    while s.cache_bytes > CACHE_BYTES and len(s.cache) > 1:
        _, old = s.cache.popitem(last=False)
        s.cache_bytes -= _nbytes(old)
    missing = []

    def lookup(h):
        if h not in s.cache:
            missing.append(h)
            return None
        s.cache.move_to_end(h)
        return s.cache[h]

    x = build(value["x"], tensors, lookup)
    kwargs = build(value["kwargs"], tensors, lookup)
    if missing:
        raise _Missing(missing)
    x = _walk(x, lambda t: _to(t, device, dtype))
    kwargs = {k: _walk(v, lambda t, k=k: _cast(t, device, torch.float32 if k in KEEP_FLOAT32 else dtype)) for k, v in kwargs.items()}
    options = value.get("options") or {}
    start = time.time()
    with torch.inference_mode():
        for i, block in enumerate(s.blocks):
            kwargs["transformer_options"] = {**options, "block_index": s.first + i}
            x = block(x, **kwargs)
        out = _walk(x, lambda t: t.to("cpu"))
    del x, kwargs
    # PyTorch keeps freed GPU memory for reuse; on a Mac that memory is the whole system's, and a step's dequantized
    # weights pile up there until macOS swaps or kills the process. Hand it back after every step.
    mm.soft_empty_cache()
    s.runs += 1
    s.seconds += time.time() - start
    p = Packer()
    return b"".join(memoryview(part) for part in p.message({"seconds": time.time() - start}, p.value(out)))


def _to(t, device, dtype):
    """On this GPU; floating point in the precision this GPU computes in (MPS has no float64)."""
    if t.is_floating_point():
        return t.to(device=device, dtype=dtype)
    return t.to(device=device)


def _cast(t, device, dtype):
    return t if t.device == device and (not t.is_floating_point() or t.dtype == dtype) else _to(t, device, dtype)


@PromptServer.instance.routes.post("/crackio/pool/run")
async def pool_run(request):
    sid = request.query.get("session", "")
    try:
        s = _session(sid)
    except KeyError:
        return web.json_response({"error": "unknown session"}, status=404)
    if s.blocks is None:
        return web.json_response({"error": "not built"}, status=404)
    buf = await _body(request)

    def go():
        with _run_lock:
            return _run(s, buf)

    try:
        out = await asyncio.get_running_loop().run_in_executor(None, go)
    except _Missing as e:
        return web.json_response({"error": "missing", "missing": e.hashes}, status=409)
    except Exception as e:
        log.exception("[crackio pool] run failed")
        return web.json_response({"error": str(e)}, status=500)
    return web.Response(body=out, content_type="application/octet-stream")


@PromptServer.instance.routes.post("/crackio/pool/free")
async def pool_free(request):
    body = await request.json() if request.can_read_body else {}
    _drop(body.get("session"))
    return web.json_response({"ok": True})


# ---------------------------------------------------------------- head: the loader node and the stand-in blocks


class Helper:
    """A ComfyUI with this bridge on another computer."""

    def __init__(self, url, token=""):
        u = urlparse(url if "://" in url else f"http://{url}")
        self.host, self.port, self.https = u.hostname, u.port or (443 if u.scheme == "https" else 80), u.scheme == "https"
        self.label = u.netloc
        self.token = token.strip()

    def _conn(self, timeout):
        return (http.client.HTTPSConnection if self.https else http.client.HTTPConnection)(self.host, self.port, timeout=timeout)

    def request(self, method, path, parts=None, json_body=None, timeout=60):
        conn = self._conn(timeout)
        try:
            if json_body is not None:
                parts = [json.dumps(json_body).encode()]
            size = sum(len(p) if isinstance(p, (bytes, bytearray, memoryview)) else p.nbytes for p in parts or [])
            conn.putrequest(method, path)
            conn.putheader("Content-Type", "application/json" if json_body is not None else "application/octet-stream")
            conn.putheader("Content-Length", str(size))
            if self.token:
                conn.putheader("Authorization", f"Bearer {self.token}")
            conn.endheaders()
            for p in parts or []:
                conn.send(p)
            r = conn.getresponse()
            return r.status, r.read()
        finally:
            conn.close()

    def comes_back(self, seconds):
        """Whether this helper's ComfyUI answers again within `seconds` (Crackio there starts it again when it stops)."""
        until = time.time() + seconds
        while time.time() < until:
            try:
                status, _ = self.request("GET", "/crackio/pool", timeout=5)
                if status == 200:
                    return True
            except OSError:
                pass
            time.sleep(5)
        return False

    def json(self, method, path, body=None, timeout=60):
        status, data = self.request(method, path, json_body=body if method == "POST" else None, timeout=timeout)
        try:
            out = json.loads(data or b"{}")
        except ValueError:
            out = {"error": data[:200].decode(errors="replace")}
        if status >= 400:
            raise RuntimeError(f"{self.label}: {out.get('error', status)}")
        return out


def _blocks_of(sd):
    """The attribute that holds the model's transformer blocks, and how many there are."""
    for attr in ("transformer_blocks", "blocks"):
        idx = {int(k.split(".")[1]) for k in sd if k.startswith(attr + ".") and k.split(".")[1].isdigit()}
        if idx:
            return attr, max(idx) + 1
    raise RuntimeError("Pooling doesn't know this model's layout yet (no transformer_blocks or blocks).")


# Seconds a block takes on each side, by model file, from the steps run so far: what a split for lanes is balanced on.
_PACE = {}
# When this thread's current model step started (the head's own blocks run between that and the call to the helper), and
# how many steps run at once: lanes share this GPU, so a lane's own blocks only time this GPU when it runs alone.
_STEP = threading.local()
_RUNNING = [0]
_RUNNING_LOCK = threading.Lock()


def _pace(key, side, seconds_per_block):
    seen = _PACE.setdefault(key, {})
    seen[side] = seconds_per_block if side not in seen else 0.7 * seen[side] + 0.3 * seconds_per_block


def _timed(forward):
    """The diffusion model's forward, noting when each step starts, with its own copy of the transformer options: lanes run
    steps on several threads at once, and the model writes into them."""

    def run(*args, **kwargs):
        _STEP.start = time.time()
        if isinstance(kwargs.get("transformer_options"), dict):
            kwargs["transformer_options"] = dict(kwargs["transformer_options"])
        with _RUNNING_LOCK:
            _RUNNING[0] += 1
        try:
            return forward(*args, **kwargs)
        finally:
            with _RUNNING_LOCK:
                _RUNNING[0] -= 1

    return run


class RemoteBlocks(torch.nn.Module):
    """Stands in for the helper's blocks: sends the activations there and returns what comes back. `names`: the block's
    forward parameters, so arguments a model passes by position (Qwen-Image 2.1) go by name."""

    def __init__(self, helper, session, first, count, upload, names, key):
        super().__init__()
        self.helper, self.session, self.first, self.count, self.upload, self.names, self.key = helper, session, first, count, upload, names, key
        self.known = set()
        self.steps = 0
        self.lock = threading.Lock()

    def forward(self, *args, **kwargs):
        x = args[0]
        kwargs = {**dict(zip(self.names[1:], args[1:])), **kwargs}
        with pause_malloc_graph(sync=True) if pause_malloc_graph else contextlib.nullcontext():
            y = self._call(x, kwargs)
        return _like(y, x)

    def _call(self, x, kwargs):
        rest = {k: v for k, v in kwargs.items() if k != "transformer_options"}
        for attempt in range(3):
            start = time.time()
            p = Packer(self.known)
            value = {"x": p.value(x), "kwargs": p.value(rest, cache=True), "options": plain_options(kwargs.get("transformer_options"))}
            # Packing waited for this GPU to finish the step's first blocks.
            began = getattr(_STEP, "start", None)
            if began is not None and attempt == 0 and _RUNNING[0] == 1:
                _pace(self.key, "head", (time.time() - began) / max(1, self.first))
            try:
                status, data = self.helper.request("POST", f"/crackio/pool/run?session={self.session}", p.message({}, value), timeout=3600)
            except OSError as e:
                # Its ComfyUI stopped (macOS ends a process that runs it short of memory): wait for it to start again,
                # send it its blocks again, and redo the step.
                if attempt == 2 or not self.helper.comes_back(COMEBACK_SECONDS):
                    raise RuntimeError(f"The computer running the model's last blocks ({self.helper.label}) stopped answering: {e}. Start ComfyUI there again and retry.") from None
                log.warning(f"[crackio pool] {self.helper.label} came back after stopping: sending its blocks again")
                self._again()
                continue
            if status == 200:
                self.known.update(p.sent)
                meta, out, _, tensors = unpack(data)
                self.steps += 1
                total = time.time() - start
                if meta.get("seconds"):
                    _pace(self.key, "helper", meta["seconds"] / self.count)
                log.info(f"[crackio pool] {self.helper.label}: {self.count} blocks in {meta.get('seconds', 0):.1f} s, {total:.1f} s with {p.size / 1e6:.0f} MB there and {len(data) / 1e6:.0f} MB back")
                return build(out, tensors)
            # The helper restarted, or let cached inputs go: send everything again.
            if status in (404, 409):
                if status == 404:
                    self._again()
                else:
                    self.known.clear()
                continue
            raise RuntimeError(f"The helper at {self.helper.label} failed: {data[:300].decode(errors='replace')}")
        raise RuntimeError(f"The helper at {self.helper.label} kept refusing the step.")


    def _again(self):
        """Sends the helper its blocks again, once even when several lanes find it empty at the same time."""
        with self.lock:
            self.known.clear()
            try:
                status, body = self.helper.request("GET", "/crackio/pool", timeout=10)
                sessions = json.loads(body or b"{}").get("sessions", {}) if status == 200 else {}
            except (OSError, ValueError):
                sessions = {}
            if not sessions.get(self.session, {}).get("ready"):
                self.upload()


class Passthrough(torch.nn.Module):
    """A block the helper already ran: its input goes through unchanged."""

    def forward(self, *args, **kwargs):
        return args[0]


def _like(y, x):
    """The helper's output on the head's GPU, in the head's precision."""
    if isinstance(y, (tuple, list)):
        return type(y)(_like(a, b) for a, b in zip(y, x))
    return y.to(device=x.device, dtype=x.dtype)


def _upload(helper, session, sd, attr, first, n, metadata, progress=None):
    """Sends the helper the weights it needs (every non-block tensor, and blocks first..n-1 numbered from 0), then builds."""
    keys = []
    for k in sd:
        parts = k.split(".")
        if k.startswith(attr + ".") and parts[1].isdigit():
            i = int(parts[1])
            if i >= first:
                keys.append((k, ".".join([attr, str(i - first), *parts[2:]])))
        else:
            keys.append((k, k))
    total = sum(_nbytes(sd[k]) for k, _ in keys)
    sent = 0
    start = time.time()
    batch, size = [], 0

    def flush():
        nonlocal batch, size, sent
        if not batch:
            return
        p = Packer()
        value = {name: p.tensor(sd[k])["$t"] for k, name in batch}
        for attempt in range(4):
            status, data = helper.request("POST", f"/crackio/pool/tensors?session={session}", p.message({}, value), timeout=600)
            if status == 200:
                break
            if attempt == 3:
                raise RuntimeError(f"The helper at {helper.label} refused the weights: {data[:300].decode(errors='replace')}")
            time.sleep(2)
        sent += size
        if progress:
            progress(sent, total)
        batch, size = [], 0

    for k, name in keys:
        n_bytes = _nbytes(sd[k])
        if size and size + n_bytes > BATCH:
            flush()
        batch.append((k, name))
        size += n_bytes
    flush()
    log.info(f"[crackio pool] sent {total / 1024**3:.1f} GB to {helper.label} in {time.time() - start:.0f} s")
    return helper.json("POST", "/crackio/pool/build", {"session": session, "attr": attr, "first": first, "count": n - first, "metadata": metadata}, timeout=1800)


class CrackioPoolLoaderGGUF:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "unet_name": (folder_paths.get_filename_list("unet_gguf"),),
                "helper": ("STRING", {"default": "http://192.168.1.20:8188", "tooltip": "Another computer's ComfyUI with the Crackio bridge, listening on the network."}),
                "helper_blocks": ("INT", {"default": 0, "min": 0, "max": 512, "tooltip": "How many of the model's last blocks the helper runs. 0: as many as fit its free GPU memory."}),
            },
            "optional": {"token": ("STRING", {"default": ""})},
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "Crackio"
    TITLE = "Crackio Pool Loader (GGUF)"

    def load(self, unet_name, helper, helper_blocks=0, token=""):
        mod, _ = _gguf()
        path = folder_paths.get_full_path("unet", unet_name)
        sd, extra = mod.gguf_sd_loader(path)
        metadata = {k: v for k, v in (extra.get("metadata") or {}).items() if isinstance(v, (str, int, float, bool))}
        attr, n = _blocks_of(sd)
        h = Helper(helper, token)
        try:
            info = h.json("GET", "/crackio/pool", timeout=15)
        except RuntimeError as e:
            raise RuntimeError(f"{e}. The computer at {h.label} needs ComfyUI listening on the network with Crackio's bridge 1.3 or newer.") from None

        per_block = [0] * n
        for k, v in sd.items():
            parts = k.split(".")
            if k.startswith(attr + ".") and parts[1].isdigit():
                per_block[int(parts[1])] += _nbytes(v)
        m = helper_blocks
        if m <= 0:
            # The first blocks that fit this GPU (after the model's other weights and room for a step), and the helper's room.
            rest = sum(_nbytes(v) for k, v in sd.items() if not (k.startswith(attr + ".") and k.split(".")[1].isdigit()))
            here = _head_budget(mm.get_torch_device()) - HEAD_MARGIN - rest
            keep = 0
            while keep < n and sum(per_block[: keep + 1]) <= here:
                keep += 1
            room = info["free"] + info.get("held", 0) - MARGIN
            # Split by speed, so this side's blocks take as long as the helper's: one picture then finishes soonest, and two
            # side by side (Crackio Lanes Sampler) keep both computers busy. Measured seconds a block once steps have run,
            # else each side's matrix speed. That needs RAM here to stream what this GPU can't hold of its share; without it
            # the helper holds everything that doesn't fit here.
            pace = _PACE.get(unet_name, {})
            if "head" in pace and "helper" in pace:
                slower = pace["helper"] / pace["head"]
            else:
                # A Mac runs a whole block at about 75% of its matrix speed (attention, norms and unpacking cost it more),
                # where a GTX 1060 reaches about 90%: measured 1.3 s against 0.73 s a Qwen-Image 2.1 block.
                helper_tflops = max(0.1, float(info.get("tflops") or 1)) * (0.75 if info.get("unpacks") else 0.9)
                slower = _matmul_tflops(mm.get_torch_device(), torch.float32) * 0.9 / helper_tflops
            balanced = n - round(n * slower / (1 + slower))
            import psutil

            m = balanced if sum(per_block[keep : n - balanced]) < psutil.virtual_memory().available * 0.5 else n - keep
            while m > 0 and sum(per_block[n - m :]) > room:
                m -= 1
        m = max(1, min(n - 1, m))
        first = n - m
        stat = os.stat(path)
        session = hashlib.blake2b(f"{os.path.basename(path)}:{stat.st_size}:{int(stat.st_mtime)}:{first}:{n}".encode(), digest_size=8).hexdigest()
        held = sum(per_block[first:]) / 1024**3
        log.info(f"[crackio pool] {unet_name}: {first} of {n} blocks here, {m} ({held:.1f} GB) on {h.label}")

        pbar = comfy.utils.ProgressBar(100)

        def upload():
            _upload(h, session, sd, attr, first, n, metadata, lambda got, total: pbar.update_absolute(int(got * 100 / max(1, total)), 100))

        ready = info.get("sessions", {}).get(session, {}).get("ready")
        if not ready:
            upload()

        kwargs = {"metadata": extra.get("metadata", {})} if "metadata" in inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters else {}
        model = comfy.sd.load_diffusion_model_state_dict(sd, model_options={"custom_operations": mod.GGMLOps()}, **kwargs)
        if model is None:
            raise RuntimeError(f"ComfyUI didn't recognize {unet_name}.")
        model = mod.GGUFModelPatcher.clone(model)
        dm = model.model.diffusion_model
        blocks = getattr(dm, attr)
        if type(dm).__name__ == "QwenImage21Transformer2DModel":
            _send_qwen21_attention()
            # Its prefix cache runs blocks on cached rows only: not something to split. ComfyUI turns it on for every
            # sampling run; this option turns it off.
            model.model_options.setdefault("transformer_options", {})["qwen_image21_cache"] = {"device": "off"}
        names = list(inspect.signature(type(blocks[first]).forward).parameters)[1:]
        blocks[first] = RemoteBlocks(h, session, first, m, upload, names, unet_name)
        dm.forward = _timed(dm.forward)
        for i in range(first + 1, n):
            blocks[i] = Passthrough()
        if hasattr(model, "size"):
            model.size = 0
        return (model,)


def _send_qwen21_attention():
    """Qwen-Image 2.1 hands each block an attention function built from the step's segments (text causal, image
    blocks): the function remembers them, so the helper can build the same one."""
    import comfy.ldm.qwen_image21.model as qwen21

    if getattr(qwen21.block_causal_attention, "crackio", False):
        return
    original = qwen21.block_causal_attention

    def block_causal_attention(segments, transformer_options={}, cache=None, block_index=0, prefix_len=0):
        fn = original(segments, transformer_options, cache, block_index, prefix_len)
        fn.crackio_attention = {"segments": segments, "prefix_len": prefix_len}
        return fn

    block_causal_attention.crackio = True
    qwen21.block_causal_attention = block_causal_attention


class LanesSampler(comfy.samplers.KSAMPLER):
    """Samples a batch's pictures in `lanes` loops side by side, a share of the batch each. The pictures are the same as from
    one loop (each keeps its own slice of the batch's noise), but while one lane waits on the helper's blocks, the next runs
    its first blocks here: both computers work all the time instead of taking turns at every step."""

    def __init__(self, base, lanes):
        super().__init__(base.sampler_function, base.extra_options, base.inpaint_options)
        self.lanes = lanes

    def sample(self, model_wrap, sigmas, extra_args, callback, noise, latent_image=None, denoise_mask=None, disable_pbar=False):
        batch = noise.shape[0]
        lanes = min(self.lanes, batch)
        if lanes < 2:
            return super().sample(model_wrap, sigmas, extra_args, callback, noise, latent_image, denoise_mask, disable_pbar)
        bounds = [round(i * batch / lanes) for i in range(lanes + 1)]

        def run(i):
            rows = slice(bounds[i], bounds[i + 1])

            def take(t):
                return t[rows] if isinstance(t, torch.Tensor) and t.dim() and t.shape[0] == batch else t

            # Inference mode is per thread; the first lane reports the steps.
            with torch.inference_mode():
                return comfy.samplers.KSAMPLER.sample(self, model_wrap, sigmas, dict(extra_args), callback if i == 0 else None, noise[rows], take(latent_image), take(denoise_mask), disable_pbar or i > 0)

        with ThreadPoolExecutor(lanes) as pool:
            return torch.cat(list(pool.map(run, range(lanes))), 0)


class CrackioLanesSampler:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "sampler_name": (comfy.samplers.SAMPLER_NAMES,),
                "lanes": ("INT", {"default": 2, "min": 1, "max": 8, "tooltip": "Loops side by side. With a model split across two computers, 2 keeps both busy."}),
            }
        }

    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "get"
    CATEGORY = "Crackio"
    TITLE = "Crackio Lanes Sampler"

    def get(self, sampler_name, lanes):
        base = comfy.samplers.sampler_object(sampler_name)
        return (LanesSampler(base, lanes) if isinstance(base, comfy.samplers.KSAMPLER) else base,)


class CrackioFreeMemory:
    """Unloads every model from the GPU before the next node: a small card then decodes a video with all of its memory
    instead of spilling into the system's (on Windows that can take ten times as long)."""

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"samples": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "free"
    CATEGORY = "Crackio"
    TITLE = "Crackio Free GPU Memory"

    def free(self, samples):
        mm.unload_all_models()
        mm.soft_empty_cache()
        return (samples,)


NODE_CLASS_MAPPINGS = {"CrackioPoolLoaderGGUF": CrackioPoolLoaderGGUF, "CrackioLanesSampler": CrackioLanesSampler, "CrackioFreeMemory": CrackioFreeMemory}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioPoolLoaderGGUF": "Crackio Pool Loader (GGUF)", "CrackioLanesSampler": "Crackio Lanes Sampler", "CrackioFreeMemory": "Crackio Free GPU Memory"}
