"""
LFM3-VL-2B (Liquid AI, LFM Open License v1.0, lfm3_vl/LICENSE) as a ComfyUI node: a 1.9B vision-language model
that reads pictures at their own size, several at once, and video. Crackio asks it for prompt rewrites, swap checks
and boxes around things; it answers in well under a second on an RTX 5090.

Files, in models/lfm3 (fetched by Crackio through /crackio/download):
  lfm3-vl-2b.safetensors            the weights (LiquidAI/LFM3-VL-2B model.safetensors)
  lfm3-vl-2b-tokenizer.json         its tokenizer.json
  lfm3-vl-2b-lora-<name>.safetensors  optional fine-tunes (LoRA), e.g. Crackio's swap judge
Its config, processor settings, chat template and model code sit next to this file in lfm3_vl/.

Crackio asks through POST /crackio/lfm3, outside ComfyUI's prompt queue: a check must not wait behind a running render
(inside a swap, checks queued behind FLUX redraws took 8-23 s). The model stays on the GPU between questions and leaves
it after IDLE seconds, or as soon as another job is queued (an LTX-2.5 swap fills a 32 GB card): ComfyUI's memory
manager can't hold a Hugging Face model (its `device` is read-only), so this file does it.
"""
import asyncio
import base64
import io
import json
import os
import shutil
import threading
import time

import numpy as np
import torch

import comfy.model_management as mm
import folder_paths

FOLDER = "lfm3"
WEIGHTS = "lfm3-vl-2b.safetensors"
TOKENIZER = "lfm3-vl-2b-tokenizer.json"
CODE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lfm3_vl")
if FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(FOLDER, os.path.join(folder_paths.models_dir, FOLDER))

_lock = threading.Lock()
_loaded = {}  # weights path -> {"model", "processor", "loras"}


def _dir():
    return folder_paths.get_folder_paths(FOLDER)[0]


def _file(name):
    for p in folder_paths.get_folder_paths(FOLDER):
        f = os.path.join(p, name)
        if os.path.isfile(f):
            return f
    return None


def _loras():
    names = set()
    for p in folder_paths.get_folder_paths(FOLDER):
        if os.path.isdir(p):
            names.update(f[len("lfm3-vl-2b-lora-"):-len(".safetensors")] for f in os.listdir(p) if f.startswith("lfm3-vl-2b-lora-") and f.endswith(".safetensors"))
    return sorted(names)


def _runtime(weights):
    """A folder transformers can load from: the bundled config and code, the tokenizer, and the weights linked in
    (a hard link: no copy of 3.8 GB, and no admin rights needed on Windows)."""
    tok = _file(TOKENIZER)
    if not tok:
        raise RuntimeError(f"LFM3-VL's tokenizer is missing: put {TOKENIZER} in models/{FOLDER}.")
    run = os.path.join(os.path.dirname(weights), ".lfm3-vl-2b")
    os.makedirs(run, exist_ok=True)
    for f in os.listdir(CODE):
        if f != "LICENSE" and not os.path.exists(os.path.join(run, f)):
            shutil.copy(os.path.join(CODE, f), os.path.join(run, f))
    if not os.path.exists(os.path.join(run, "tokenizer.json")):
        shutil.copy(tok, os.path.join(run, "tokenizer.json"))
    link = os.path.join(run, "model.safetensors")
    if not os.path.exists(link):
        try:
            os.link(weights, link)
        except OSError:  # another drive, or a file system without hard links
            shutil.copy(weights, link)
    return run


def _dtype(device):
    if device.type == "cuda":
        return torch.bfloat16 if mm.should_use_bf16(device) else torch.float16
    if device.type == "mps":
        return torch.float16
    return torch.float32


def _load(weights):
    with _lock:
        if weights in _loaded:
            return _loaded[weights]
        try:
            from transformers import AutoModelForImageTextToText, AutoProcessor
            from transformers import __version__ as tv
        except ImportError as e:
            raise RuntimeError("LFM3-VL needs the transformers package.") from e
        if tuple(int(x) for x in tv.split(".")[:2]) < (5, 21):
            raise RuntimeError(f"LFM3-VL needs transformers 5.21 or newer; this ComfyUI has {tv}.")
        run = _runtime(weights)
        device = mm.get_torch_device()
        model = AutoModelForImageTextToText.from_pretrained(run, dtype=_dtype(device), trust_remote_code=True)
        model.eval()
        processor = AutoProcessor.from_pretrained(run, trust_remote_code=True)
        processor.tokenizer.padding_side = "left"
        entry = {"model": model, "processor": processor, "loras": {}}
        _loaded[weights] = entry
        return entry


# Two minutes on the GPU after an answer, so clicks in Retouch a little apart don't each wait for it to come back; any
# other job queued in ComfyUI still sends it off at once (_on_prompt).
IDLE = float(os.environ.get("CRACKIO_LFM3_IDLE", "120"))
_gen_lock = threading.Lock()  # one answer at a time
_last = {"at": 0.0, "park": False}


def _queue_busy():
    try:
        from server import PromptServer

        return PromptServer.instance.prompt_queue.get_tasks_remaining() > 0
    except Exception:
        return False


def _comfy_frees(need, device):
    """ComfyUI's own worker unloads its models (the queue flag POST /free sets) and this waits up to 10 s for the
    memory. ComfyUI's model management isn't thread-safe: mm.free_memory from a bridge request, while the worker
    started the next prompt, left a half-unloaded model in its list and the worker died in is_dead() (2026-11-02)."""
    try:
        from server import PromptServer

        PromptServer.instance.prompt_queue.set_flag("unload_models", True)
    except Exception:
        return
    for _ in range(50):
        if device.type != "cuda" or torch.cuda.mem_get_info(device)[0] >= need:
            return
        time.sleep(0.2)


def _on_gpu(entry, inside_comfy):
    """Onto the GPU. Next to a running render it only takes memory that's free; ComfyUI makes room only from inside a
    job of its own (the node, on the worker's thread) or, while it's idle, by its worker (_comfy_frees), never from
    this thread and never under a running job."""
    device = mm.get_torch_device()
    model = entry["model"]
    if next(model.parameters()).device.type == device.type:
        return device
    need = mm.module_size(model) * 1.3 + 1.2e9
    for _ in range(600):  # up to 2 minutes
        free = torch.cuda.mem_get_info(device)[0] if device.type == "cuda" else need
        if free >= need:
            break
        if inside_comfy:
            mm.free_memory(need, device)
            break
        if not _queue_busy():
            _comfy_frees(need, device)
            break
        time.sleep(0.2)
    model.to(device)
    return device


def _park(entry):
    """Off the GPU (back in RAM): an LTX-2.5 swap needs all 32 GB of a 5090."""
    model = entry["model"]
    if next(model.parameters()).device.type != "cpu":
        model.to(mm.unet_offload_device())
        mm.soft_empty_cache()


def _park_all():
    if _gen_lock.acquire(blocking=False):
        try:
            for entry in _loaded.values():
                _park(entry)
        finally:
            _gen_lock.release()
    else:  # an answer is being written: it leaves right after (see generate)
        _last["park"] = True


def _idle_watch():
    while True:
        time.sleep(2)
        if _last["at"] and time.time() - _last["at"] > IDLE:
            _last["at"] = 0.0
            _park_all()


threading.Thread(target=_idle_watch, daemon=True, name="lfm3-idle").start()


def _read_ahead():
    """On a machine with RAM to spare, the model and its fine-tunes' own weights are read while ComfyUI starts, so the
    first question after a restart waits only for them to go onto the GPU: Retouch's first box took 10-15 s after a
    restart, reading 3.8 GB first."""
    try:
        import psutil

        weights = _file(WEIGHTS)
        if psutil.virtual_memory().total < 24 * 1024**3 or not weights or not _file(TOKENIZER):
            return
        entry = _load(weights)
        lora = next((n for n in _loras()), None)
        if lora:
            from safetensors import safe_open

            with safe_open(_file(f"lfm3-vl-2b-lora-{lora}.safetensors"), "pt") as f:
                names = sorted(k[: -len(".lora_A")] for k in f.keys() if k.endswith(".lora_A"))
            with _gen_lock:
                _base_weights(entry, weights, names)
    except Exception as e:
        print(f"[crackio_bridge] LFM3-VL: not read ahead ({e})")


# Another job queued (a render, a swap pass): the GPU goes back to ComfyUI first.
QUIET = {"CrackioLFM3", "LoadImage", "PreviewAny", "PrimitiveString", "PrimitiveStringMultiline"}
try:
    from server import PromptServer

    def _on_prompt(json_data):
        graph = (json_data or {}).get("prompt") or {}
        if any(isinstance(n, dict) and n.get("class_type") not in QUIET for n in graph.values()):
            threading.Thread(target=_park_all, daemon=True).start()
        return json_data

    PromptServer.instance.add_on_prompt_handler(_on_prompt)
except Exception as e:
    print(f"[crackio_bridge] LFM3-VL: can't watch the prompt queue ({e}); it leaves the GPU after {IDLE:.0f} s idle only")


class _Lora:
    """A fine-tune's low-rank weights, read once per version of its file (a retrained judge is read again)."""

    def __init__(self, path):
        from safetensors import safe_open

        self.stamp = (path, os.path.getmtime(path))
        with safe_open(path, "pt") as f:
            meta = f.metadata() or {}
            tensors = {k: f.get_tensor(k) for k in f.keys()}
        self.scale = float(meta.get("alpha", 1)) / float(meta.get("r", 1))
        self.layers = {k[: -len(".lora_A")]: (a, tensors[k[: -len(".lora_A")] + ".lora_B"]) for k, a in tensors.items() if k.endswith(".lora_A")}


def _base_weights(entry, weights, names):
    """The model's own weights for these layers, as the file has them. Kept in RAM once read (pinned, about 3 GB for a
    LoRA's 153 layers) where there's room for them: a swap switches between the base model and the judge after every
    FLUX render, and reading them back from the file after the swap's big models had pushed it out of the disk cache
    took about 20 s a switch. With little RAM they're read from the file each time."""
    cache = entry.setdefault("base", {})
    keep = entry.get("keep_base")
    if keep is None:
        try:
            import psutil

            keep = psutil.virtual_memory().total >= 24 * 1024**3
        except Exception:
            keep = False
        entry["keep_base"] = keep
    missing = [n for n in names if n not in cache]
    if missing:
        from safetensors import safe_open

        with safe_open(weights, "pt") as f:
            read = {n: f.get_tensor(n + ".weight") for n in missing}
        if not keep:
            return {n: cache.get(n, read.get(n)) for n in names}
        for n, t in read.items():
            try:
                cache[n] = t.pin_memory()
            except Exception:  # no CUDA, or pinning refused
                cache[n] = t
    return {n: cache[n] for n in names}


def _merge(entry, lora, weights):
    """The model's weights as asked: the base model's (lora None), or with one fine-tune merged in. Each switch starts
    from the base weights (_base_weights) and sums in float32, so going back and forth never drifts. Merged, an answer
    costs what the base model's does: on an RTX 5090 a Retouch picture took 2.8 s instead of 4.2 s with the LoRA as hooks
    on its 153 layers (126 tokens/s against 87)."""
    want = lora.stamp if lora else None
    if entry.get("merged") == want:
        return
    modules = dict(entry["model"].named_modules())
    keep = set(lora.layers) if lora else set()
    back = entry.get("changed", set()) - keep
    base = _base_weights(entry, weights, sorted(back | keep))
    with torch.no_grad():
        for name in back:
            w = modules[name].weight
            w.copy_(base[name].to(w.device, w.dtype, non_blocking=True))
        for name, (a, b) in (lora.layers.items() if lora else ()):
            mod = modules.get(name)
            if mod is None:
                raise RuntimeError(f"LoRA layer {name} isn't in this model.")
            w = mod.weight
            delta = (b.to(w.device, torch.float32) @ a.to(w.device, torch.float32)) * lora.scale
            w.copy_((base[name].to(w.device, torch.float32) + delta).to(w.dtype))
    entry["changed"] = keep
    entry["merged"] = want


def _pictures(images):
    """ComfyUI IMAGE tensors (batch, height, width, 3 in 0-1) to PIL pictures, one per batch item."""
    from PIL import Image

    out = []
    for t in images:
        if t is None:
            continue
        for frame in t:
            out.append(Image.fromarray(np.clip(frame.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)))
    return out


def generate(prompt, system="", images=(), video=None, thinking=False, max_tokens=512, lora="none", sampling="greedy", seed=0, inside_comfy=True, odds=(), stream=None, history=None):
    """-> (answer, reasoning, odds): `odds` names JSON keys with a true/false answer, and for each one the answer writes,
    how likely the model thought "true" was there (a judge's yes with how sure it is). `stream`: a _Stream that's handed
    the answer as it's written."""
    with _gen_lock:
        _last["park"] = False
        try:
            return _generate(prompt, system, images, video, thinking, max_tokens, lora, sampling, seed, inside_comfy, odds, stream, history)
        finally:
            _last["at"] = time.time()
            if _last["park"]:  # another job was queued meanwhile
                _last["park"] = False
                for entry in _loaded.values():
                    _park(entry)


def _odds(tok, ids, logits, keys):
    """The chance of "true" at each key's value, from the raw scores (before the repetition penalty)."""
    first = lambda s: tok.encode(s, add_special_tokens=False)[0]
    pair = {True: [first(" true"), first(" false")], False: [first("true"), first("false")]}  # after '":' / after '": '
    found, text = {}, ""
    for i, t in enumerate(ids):
        head = text.rstrip()
        for key in keys:
            if key not in found and head.endswith(f'"{key}":'):
                found[key] = round(torch.softmax(logits[i][0, pair[text == head]].float(), -1)[0].item(), 4)
        text += tok.decode([t])
    return found


class _Stream:
    """The answer as it's written (transformers' streamer protocol: put(token ids), end()): `on_text` gets the text so far
    after each token; `stop()` ends the answer at the next token (the asker went away)."""

    def __init__(self, on_text):
        self.on_text, self.ids, self.prompt_seen, self.stopped, self.tok = on_text, [], False, False, None

    def put(self, value):
        if not self.prompt_seen:  # the first call is the prompt itself
            self.prompt_seen = True
            return
        self.ids.extend(value.reshape(-1).tolist())
        self.on_text(self.tok.decode(self.ids, skip_special_tokens=True))

    def end(self):
        pass

    def stop(self):
        self.stopped = True


def _generate(prompt, system, images, video, thinking, max_tokens, lora, sampling, seed, inside_comfy, odds, stream=None, history=None):
    weights = _file(WEIGHTS)
    if not weights:
        raise RuntimeError(f"LFM3-VL isn't installed: put {WEIGHTS} and {TOKENIZER} in models/{FOLDER} (Crackio's Local page does it).")
    entry = _load(weights)
    model, processor = entry["model"], entry["processor"]
    use = None
    if lora != "none":
        path = _file(f"lfm3-vl-2b-lora-{lora}.safetensors")
        if not path:
            raise RuntimeError(f"No LFM3-VL fine-tune called {lora} in models/{FOLDER}.")
        use = entry["loras"].get(lora)
        if use is None or use.stamp != (path, os.path.getmtime(path)):
            use = entry["loras"][lora] = _Lora(path)
    t0 = time.time()
    device = _on_gpu(entry, inside_comfy)
    t1 = time.time()
    _merge(entry, use, weights)
    t2 = time.time()
    content = [{"type": "image", "image": im} for im in images]
    if video is not None and len(video):
        content.append({"type": "video", "video": [np.clip(f.cpu().numpy() * 255.0, 0, 255).astype(np.uint8) for f in video]})
    content.append({"type": "text", "text": prompt})
    messages = ([{"role": "system", "content": [{"type": "text", "text": system}]}] if system else []) + [{"role": "user", "content": content}]
    if history:  # a conversation: its turns as they were, each with the pictures it showed
        messages = messages[:-1] + [
            {"role": t["role"], "content": [*({"type": "image", "image": im} for im in t.get("images", ())), {"type": "text", "text": t["text"]}]} for t in history
        ]
    inputs = processor.apply_chat_template([messages], add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt", enable_thinking=bool(thinking))
    inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
    gen = {"max_new_tokens": int(max_tokens), "repetition_penalty": 1.1}
    if sampling == "greedy":
        gen["do_sample"] = False
    else:  # Liquid's recommended sampling
        torch.manual_seed(int(seed))
        gen.update(do_sample=True, temperature=0.1, top_k=50, top_p=1.0)
    if odds:
        gen.update(return_dict_in_generate=True, output_logits=True)
    if stream is not None:
        from transformers import StoppingCriteria, StoppingCriteriaList

        class _Asked(StoppingCriteria):
            def __call__(self, input_ids, scores, **kw):
                return stream.stopped

        stream.tok = processor.tokenizer
        gen.update(streamer=stream, stopping_criteria=StoppingCriteriaList([_Asked()]))
    with torch.inference_mode():
        out = model.generate(**inputs, **gen)
    new = (out.sequences if odds else out)[:, inputs["input_ids"].shape[1]:]
    found = _odds(processor.tokenizer, new[0].tolist(), out.logits, odds) if odds else {}
    text = processor.batch_decode(new, skip_special_tokens=True)[0]
    if time.time() - t0 > 3:  # where a slow answer's time went, in ComfyUI's log
        print(f"[crackio_bridge] LFM3-VL ({lora}): {time.time() - t0:.1f} s = onto the GPU {t1 - t0:.1f} s, weights {t2 - t1:.1f} s, answer {time.time() - t2:.1f} s ({new.shape[1]} tokens)")
    reasoning, sep, answer = text.partition("</think>")
    return (answer.strip(), reasoning.replace("<think>", "").strip(), found) if sep else (text.strip(), "", found)


class CrackioLFM3:
    """Ask LFM3-VL about pictures (each at its own size), a clip, or just words."""

    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"image_{k}": ("IMAGE",) for k in range(1, 7)}
        optional.update(
            video=("IMAGE", {"tooltip": "A clip's frames; sampled at their order, the model reads up to 768 frames."}),
            system=("STRING", {"multiline": True, "default": ""}),
        )
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": "Describe this picture."}),
                "thinking": ("BOOLEAN", {"default": False, "tooltip": "Reason step by step before answering: slower, better on hard questions."}),
                "max_tokens": ("INT", {"default": 512, "min": 1, "max": 16384}),
                "lora": (["none"] + _loras(), {"tooltip": "A fine-tune from models/lfm3, e.g. Crackio's swap judge."}),
                "sampling": (["greedy", "liquid"], {"tooltip": "greedy: the same answer every time. liquid: Liquid's settings (temperature 0.1)."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "thinking")
    FUNCTION = "run"
    CATEGORY = "Crackio"

    def run(self, prompt, thinking, max_tokens, lora, sampling, seed, system="", video=None, **images):
        pics = _pictures([images.get(f"image_{k}") for k in range(1, 7)])
        return generate(prompt, system, pics, video, thinking, max_tokens, lora, sampling, seed)[:2]


NODE_CLASS_MAPPINGS = {"CrackioLFM3": CrackioLFM3}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioLFM3": "LFM3-VL (Liquid AI)"}

try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/crackio/lfm3")
    async def _ask(request):
        """{prompt, system?, images?: [base64 PNG/JPEG], thinking?, max_tokens?, lora?, odds?: [JSON keys]} -> {text,
        thinking, ms, odds: {key: chance of true}}: an answer outside the prompt queue, so it doesn't wait for a running
        render."""
        from PIL import Image

        body = await request.json()
        try:
            pics = [Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB") for b in (body.get("images") or [])[:6]]
            history = _turns(body.get("history"))
            lora = str(body.get("lora") or "none")
            if lora != "none" and lora not in _loras():
                return web.json_response({"error": f"No LFM3-VL fine-tune called {lora} on this machine."}, status=404)
            odds = [str(k) for k in (body.get("odds") or [])][:8]
            t0 = time.time()
            text, reasoning, found = await asyncio.to_thread(
                generate, str(body.get("prompt") or ""), str(body.get("system") or ""), pics, None, bool(body.get("thinking")), int(body.get("max_tokens") or 1024), lora, "greedy", 0, False, odds, None, history
            )
            return web.json_response({"text": text, "thinking": reasoning, "ms": round((time.time() - t0) * 1000), "odds": found})
        except Exception as e:
            return web.json_response({"error": str(e)[:400]}, status=500)

    def _turns(raw):
        """A conversation sent as {role, text, images?: [base64]} turns (the last one yours), or None."""
        from PIL import Image

        if not isinstance(raw, list) or not raw:
            return None
        turns = []
        for t in raw[-40:]:
            role = "assistant" if t.get("role") == "assistant" else "user"
            pics = [Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB") for b in (t.get("images") or [])[:4]]
            turns.append({"role": role, "text": str(t.get("text") or ""), "images": pics})
        return turns

    def _event(value):
        """One server-sent event."""
        return ("data: " + json.dumps(value) + "\n\n").encode()

    @PromptServer.instance.routes.post("/crackio/lfm3/stream")
    async def _ask_stream(request):
        """/crackio/lfm3's question, answered as it's written: server-sent events, {"text": what's new} as the model writes
        it, then {"done": true, "text": the whole answer, "ms"} (or {"error"}). Retouch draws each thing's box as soon as
        its line is complete. A closed connection ends the answer at the next token."""
        from PIL import Image

        body = await request.json()
        try:
            pics = [Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB") for b in (body.get("images") or [])[:6]]
            history = _turns(body.get("history"))
        except Exception as e:
            return web.json_response({"error": f"A picture couldn't be read: {e}"[:400]}, status=400)
        lora = str(body.get("lora") or "none")
        if lora != "none" and lora not in _loras():
            return web.json_response({"error": f"No LFM3-VL fine-tune called {lora} on this machine."}, status=404)
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
        await resp.prepare(request)
        loop = asyncio.get_running_loop()
        news = asyncio.Queue()
        stream = _Stream(lambda text: loop.call_soon_threadsafe(news.put_nowait, ("text", text)))

        async def answer():
            t0 = time.time()
            try:
                text, _, _ = await asyncio.to_thread(
                    generate, str(body.get("prompt") or ""), str(body.get("system") or ""), pics, None, False, int(body.get("max_tokens") or 1024), lora, "greedy", 0, False, (), stream, history
                )
                await news.put(("done", {"done": True, "text": text, "ms": round((time.time() - t0) * 1000)}))
            except Exception as e:
                await news.put(("done", {"done": True, "error": str(e)[:400]}))

        task = asyncio.create_task(answer())
        sent = ""
        try:
            while True:
                kind, value = await news.get()
                if kind == "done":
                    await resp.write(_event(value))
                    break
                # Only what's new since the last event (the whole text again if a token rewrote the end).
                new = value[len(sent):] if value.startswith(sent) else value
                event = {"text": new} if value.startswith(sent) else {"text": new, "restart": True}
                sent = value
                if new:
                    await resp.write(_event(event))
        except (ConnectionResetError, asyncio.CancelledError):
            stream.stop()
            raise
        finally:
            if not task.done():
                stream.stop()
        await resp.write_eof()
        return resp
except Exception as e:
    print(f"[crackio_bridge] LFM3-VL: no /crackio/lfm3 route ({e}); Crackio asks through the node then")

# Started last, once everything it uses is defined.
threading.Thread(target=_read_ahead, daemon=True, name="lfm3-read-ahead").start()
