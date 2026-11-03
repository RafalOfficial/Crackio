"""
Lip sync: a video's mouth redrawn to new speech, only in the frames where the words change and only round the mouth
(LatentSync 1.6 by ByteDance: Apache-2.0 code, OpenRAIL++ weights). lipsync_worker.py does the work in a process of its
own (ComfyUI's Python with this engine's pinned packages first), so LatentSync's older libraries never meet ComfyUI's
and the GPU is ComfyUI's again the moment it ends.

Nodes
  Crackio Lip Sync (CrackioLipSync)   frames, the speech for them, the span to change -> the same frames with the mouth
                                      redrawn in the span, and a report (how many frames, the sync scores, timings)

Files
  models/latentsync/                  latentsync_unet.pt, whisper-tiny.pt, sd-vae-ft-mse.safetensors, stable_syncnet.pt
                                      (downloaded like any model; the first two are needed, SyncNet only for scores)
  models/mediapipe/                   face_landmarker.task, hand_landmarker.task (fetched with the engine)
  <models' parent>/lipsync-engine/    site/ (diffusers 0.32 and the rest, pinned) and LatentSync/ (its code, fixed commit)

Routes
  GET  /crackio/lipsync               the engine, the models, the install
  POST /crackio/lipsync/engine        install the engine (packages, LatentSync's code, MediaPipe's models) and check it
  POST /crackio/lipsync/check         check it again (after its models arrived)
"""
import hashlib
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import uuid

import numpy as np
import torch

import folder_paths
from aiohttp import web
from server import PromptServer

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lipsync_worker.py")
LATENTSYNC_COMMIT = "a229c3948406"
LATENTSYNC_CODE = f"https://codeload.github.com/bytedance/LatentSync/tar.gz/{LATENTSYNC_COMMIT}"
# Pinned: what LatentSync was made with (diffusers 0.32) and what MediaPipe's landmarkers need. Installed with
# --no-deps into the engine's own folder; torch, numpy, scipy, tqdm, einops, safetensors and Pillow come from ComfyUI.
PACKAGES = [
    "diffusers==0.32.2",
    "huggingface-hub==0.36.0",
    "omegaconf==2.3.0",
    "antlr4-python3-runtime==4.9.3",
    "mediapipe==1.2.0",
    "absl-py==2.3.1",
    "flatbuffers==25.9.23",
    "opencv-contrib-python-headless==4.12.0.88",
    "kornia==0.8.0",
    "kornia_rs==0.1.9",
    "more-itertools==10.7.0",
    "importlib-metadata==8.7.0",
    "zipp==3.23.0",
]
# MediaPipe's landmarkers (Apache-2.0), version 1, checked by their SHA-256.
TASKS = {
    "face_landmarker.task": ("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"),
    "hand_landmarker.task": ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"),
}
MODEL_FILES = {"unet": "latentsync_unet.pt", "whisper": "whisper-tiny.pt", "vae": "sd-vae-ft-mse.safetensors", "syncnet": "stable_syncnet.pt"}

for _name in ("latentsync", "mediapipe"):
    if _name not in folder_paths.folder_names_and_paths:
        folder_paths.add_model_folder_path(_name, os.path.join(folder_paths.models_dir, _name))


def _folder(name):
    from . import storage

    chosen = storage.folder(name)  # the download folder chosen in Crackio's Settings → Storage (bridge 1.10)
    if chosen:
        return chosen
    paths = folder_paths.get_folder_paths(name) or [os.path.join(folder_paths.models_dir, name)]
    for p in paths:
        if os.path.isdir(p):
            return p
    os.makedirs(paths[0], exist_ok=True)
    return paths[0]


def _engine_dir():
    # Next to the models (where the voice engine lives too), so it sits on the drive that has room.
    return os.environ.get("CRACKIO_LIPSYNC_ENGINE_DIR") or os.path.join(os.path.dirname(os.path.normpath(_folder("latentsync"))), "lipsync-engine")


def _models():
    from . import storage

    ls, mp = _folder("latentsync"), _folder("mediapipe")
    # storage.found: with a download folder chosen, files from before it stay usable where they are.
    out = {k: storage.found("latentsync", v, ls) for k, v in MODEL_FILES.items()}
    out["face"] = storage.found("mediapipe", "face_landmarker.task", mp)
    out["hand"] = storage.found("mediapipe", "hand_landmarker.task", mp)
    return out


def _engine():
    """The installed engine ({checked, device, gpu, ...} from its last self-test), or None."""
    try:
        with open(os.path.join(_engine_dir(), "engine.json")) as f:
            e = json.load(f)
        ok = os.path.isdir(os.path.join(_engine_dir(), "site", "diffusers")) and os.path.isdir(os.path.join(_engine_dir(), "LatentSync", "latentsync"))
        return e if ok else None
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------ running the worker

_run_lock = threading.Lock()


def run_worker(command, fields, on_line=None, timeout=3600):
    """One worker job; its result (raises with the worker's own words when it fails)."""
    engine = _engine_dir()
    tmp = os.path.join(engine, "tmp")
    os.makedirs(tmp, exist_ok=True)
    job_id = uuid.uuid4().hex[:10]
    job = {"command": command, "engine": engine, "models": _models(), "out": os.path.join(tmp, f"{job_id}.out.json"), **fields}
    path = os.path.join(tmp, f"{job_id}.json")
    with open(path, "w") as f:
        json.dump(job, f)
    env = dict(os.environ)
    env.update(TMP=tmp, TEMP=tmp, TMPDIR=tmp, PYTHONUNBUFFERED="1")
    log = os.path.join(engine, "worker.log")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    t0 = time.time()
    with _run_lock, open(log, "a", encoding="utf-8", errors="replace") as logf:
        logf.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} {command}\n")
        proc = subprocess.Popen([sys.executable, WORKER, path], cwd=engine, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=flags)
        try:
            for line in proc.stdout:
                logf.write(line)
                if on_line:
                    on_line(line.rstrip())
                if time.time() - t0 > timeout:
                    proc.kill()
                    raise RuntimeError(f"the lip-sync worker took longer than {timeout // 60} minutes")
            proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
    try:
        with open(job["out"]) as f:
            result = json.load(f)
    except (OSError, ValueError):
        raise RuntimeError(f"the lip-sync worker stopped without an answer (exit code {proc.returncode}); see {log}") from None
    finally:
        for p in (path, job["out"]):
            try:
                os.remove(p)
            except OSError:
                pass
    if not result.get("ok"):
        raise RuntimeError(f"lip sync: {result.get('error', 'failed')}")
    return result


def _make_room():
    """The worker needs the GPU: ComfyUI's models step aside (they load again when next needed), and so does the voice
    engine if it's holding one. ComfyUI's model management isn't thread-safe: voice.comfy_step_aside unloads in the
    prompt worker's own thread, where the Lip Sync node runs, and asks the worker to from anywhere else."""
    try:
        from . import voice

        voice.comfy_step_aside()
    except Exception:
        pass
    try:
        from . import voice

        voice.stop_server()
    except Exception:
        pass


# ------------------------------------------------------------------ installing the engine

_install = {"state": "idle", "step": None, "error": None, "started": None, "finished": None}
_install_lock = threading.Lock()


def _set(**kw):
    with _install_lock:
        _install.update(kw)


def _pip_command():
    """How to install into the engine folder with ComfyUI's Python: its pip, else uv (venvs made by uv have no pip)."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    probe = subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True, text=True, creationflags=flags)
    if probe.returncode == 0:
        return [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    uv = shutil.which("uv") or shutil.which("uv.exe")
    for p in (os.path.dirname(sys.executable), os.path.dirname(os.path.dirname(sys.executable)), os.path.dirname(os.path.dirname(os.path.dirname(sys.executable)))):
        for name in ("uv", "uv.exe"):
            if not uv and os.path.isfile(os.path.join(p, name)):
                uv = os.path.join(p, name)
    if uv:
        return [uv, "pip", "install", "--python", sys.executable]
    subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], capture_output=True, creationflags=flags)
    return [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]


def _fetch(url, target, sha=None):
    req = urllib.request.Request(url, headers={"User-Agent": "crackio-bridge"})
    with urllib.request.urlopen(req, timeout=300) as res, open(target + ".part", "wb") as out:
        shutil.copyfileobj(res, out, 4 * 1024 * 1024)
    if sha:
        h = hashlib.sha256()
        with open(target + ".part", "rb") as f:
            for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != sha:
            os.remove(target + ".part")
            raise IOError(f"{os.path.basename(target)} didn't match its checksum")
    os.replace(target + ".part", target)


def _install_engine():
    try:
        engine = _engine_dir()
        os.makedirs(engine, exist_ok=True)
        free = shutil.disk_usage(engine).free
        if free < 1.5 * 1024**3:
            raise IOError(f"not enough disk space for the lip-sync engine: 1.5 GB needed, {free / 1e9:.1f} GB free")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        # 1. The packages, pinned, into the engine's own folder.
        _set(step="packages")
        site = os.path.join(engine, "site")
        staging = site + ".new"
        shutil.rmtree(staging, ignore_errors=True)
        cmd = _pip_command() + ["--target", staging, "--no-deps", "--upgrade", *PACKAGES]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, creationflags=flags)
        if r.returncode != 0:
            raise IOError(f"installing the packages failed: {(r.stderr or r.stdout)[-500:]}")
        shutil.rmtree(site, ignore_errors=True)
        os.replace(staging, site)
        # 2. LatentSync's code at its fixed commit (its model code, configs and mask).
        _set(step="code")
        code = os.path.join(engine, "LatentSync")
        archive = os.path.join(engine, "latentsync.tar.gz")
        _fetch(LATENTSYNC_CODE, archive)
        unpack = os.path.join(engine, "latentsync.new")
        shutil.rmtree(unpack, ignore_errors=True)
        os.makedirs(unpack)
        with tarfile.open(archive) as t:
            members = [m for m in t.getmembers() if re.match(r"^[^/]+/(latentsync|configs)/", m.name) or re.match(r"^[^/]+/LICENSE$", m.name)]
            for m in members:
                dest = os.path.realpath(os.path.join(unpack, m.name))
                if not dest.startswith(os.path.realpath(unpack) + os.sep):
                    raise IOError("unsafe path in LatentSync's archive")
            t.extractall(unpack, members=members)
        root = next(os.path.join(unpack, d) for d in os.listdir(unpack))
        shutil.rmtree(code, ignore_errors=True)
        os.replace(root, code)
        shutil.rmtree(unpack, ignore_errors=True)
        os.remove(archive)
        # 3. MediaPipe's face and hand landmarkers.
        _set(step="landmarks")
        mp = _folder("mediapipe")
        for name, (url, sha) in TASKS.items():
            target = os.path.join(mp, name)
            if not os.path.exists(target):
                _fetch(url, target, sha)
        # 4. The check: everything imports, the GPU answers, MediaPipe runs (and LatentSync loads, when it's here).
        _set(step="checking")
        full = all(os.path.exists(_models()[k]) for k in ("unet", "whisper", "vae"))
        res = run_worker("selftest", {"full": full}, timeout=900)
        res["checked"] = time.time()
        res["full"] = full
        with open(os.path.join(engine, "engine.json"), "w") as f:
            json.dump(res, f)
        _set(state="done", step=None, finished=time.time())
    except Exception as e:
        _set(state="error", error=str(e)[:500], finished=time.time())
        print(f"[crackio_bridge] lip sync: engine install failed: {e}")


# ------------------------------------------------------------------ the node


class CrackioLipSync:
    """The mouth redrawn to new speech (LatentSync 1.6) in the frames of the span only, and only the mouth: from under the
    nose round the jaw, never a hand in front of it, colour and texture matched to the face round it. Every other pixel
    of every frame stays the original's. The speech covers all the frames (it's what's heard under them); outside the
    span it's ignored."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "The soundtrack for these frames with the new words in it."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.001}),
                "span_start": ("INT", {"default": 0, "min": 0, "max": 1_000_000, "tooltip": "First frame whose mouth changes."}),
                "span_end": ("INT", {"default": -1, "min": -1, "max": 1_000_000, "tooltip": "Frame after the last one that changes; -1: to the end."}),
                "steps": ("INT", {"default": 20, "min": 4, "max": 60}),
                "guidance": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 3.0, "step": 0.05}),
                "seed": ("INT", {"default": 1247, "min": 0, "max": 0xFFFFFFFF}),
                "fade": ("INT", {"default": 4, "min": 0, "max": 24, "tooltip": "Frames the new mouth takes to come in and go out at the span's ends."}),
                "sharpen": ("BOOLEAN", {"default": True, "tooltip": "Brings the new mouth's fine texture up to the original's."}),
                "check": ("BOOLEAN", {"default": True, "tooltip": "Scores how well the new mouths go with the words (SyncNet), when it's installed."}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "The frames (or give the video instead)."}),
                "video": ("VIDEO", {"tooltip": "The clip itself instead of frames: read here with a known colour matrix (BT.709), so its patches go back onto the clip's own colours exactly."}),
                "original_audio": ("AUDIO", {"tooltip": "The original soundtrack, to score the original mouths too (the bar to reach)."}),
                "patch_prefix": ("STRING", {"default": "", "tooltip": "Also save what changed as RGBA patches (and patches.json) under output/<prefix>_<n>/, for pasting onto the original frames exactly."}),
                "face_x": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.001, "tooltip": "Which face speaks: across the frame (0–1), -1 for the biggest."}),
                "face_y": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.001}),
                "reference": (["same", "open", "pair"], {"default": "same", "tooltip": "Where the new mouth takes its looks (teeth, lips) from: each frame itself; the frame where the mouth is most open (teeth showing); or that one where the new words are loud and the most closed one where they're quiet."}),
                "overlap": ("INT", {"default": 0, "min": 0, "max": 12, "tooltip": "Frames LatentSync's 16-frame windows share: the mouths cross-fade there instead of jumping at each window's edge (8: about twice the time)."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "report")
    FUNCTION = "run"
    CATEGORY = "Crackio"
    OUTPUT_NODE = True

    def run(self, audio, fps, span_start, span_end, steps, guidance, seed, fade, sharpen, check, images=None, video=None, original_audio=None, patch_prefix="", face_x=-1.0, face_y=-1.0, reference="same", overlap=0):
        if not _engine():
            raise RuntimeError("Lip sync isn't set up on this machine yet: set it up from Crackio's Lip Sync tool.")
        models = _models()
        for k in ("unet", "whisper", "vae"):
            if not os.path.exists(models[k]):
                raise RuntimeError(f"Lip sync is missing {MODEL_FILES[k]}: get it from Crackio's Lip Sync tool.")
        matrix = None
        if video is not None:
            frames_u8, matrix = _read_video(video)
        elif images is not None:
            frames_u8 = (images.clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        else:
            raise ValueError("Give the frames or the video.")
        n, h, w = frames_u8.shape[0], frames_u8.shape[1], frames_u8.shape[2]
        end = n if span_end < 0 else min(n, span_end)
        if end - span_start < 2:
            raise ValueError("The span needs at least two frames.")
        tmp = os.path.join(_engine_dir(), "tmp")
        os.makedirs(tmp, exist_ok=True)
        key = uuid.uuid4().hex[:10]
        frames_in = os.path.join(tmp, f"{key}-in.npy")
        frames_out = os.path.join(tmp, f"{key}-out.npy")
        wav = os.path.join(tmp, f"{key}.wav")
        wav0 = os.path.join(tmp, f"{key}-orig.wav")
        np.save(frames_in, frames_u8)
        del frames_u8
        _write_wav(audio, wav)
        fields = {"matrix": matrix, "frames": frames_in, "fps": float(fps), "audio": wav, "span": [int(span_start), int(end)], "steps": int(steps), "guidance": float(guidance), "seed": int(seed), "fade": int(fade), "sharpen": bool(sharpen), "score": bool(check) and os.path.exists(models["syncnet"]), "out_frames": frames_out, "reference": str(reference), "overlap": int(overlap)}
        if original_audio is not None:
            _write_wav(original_audio, wav0)
            fields["original_audio"] = wav0
        if face_x >= 0 and face_y >= 0:
            fields["hint"] = [float(face_x) * w, float(face_y) * h]
        saved = None
        if patch_prefix.strip():
            out_dir = folder_paths.get_output_directory()
            folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(patch_prefix.strip(), out_dir)
            sub = os.path.join(subfolder, f"{name}_{counter:05}") if subfolder else f"{name}_{counter:05}"
            fields["patch_dir"] = os.path.join(out_dir, sub)
            saved = sub
        import comfy.utils

        bar = comfy.utils.ProgressBar(100)

        def on_line(line):
            m = re.search(r"progress (\d+)/(\d+)", line)
            if m:
                bar.update_absolute(int(100 * int(m.group(1)) / max(1, int(m.group(2)))), 100)

        _make_room()
        try:
            report = run_worker("sync", fields, on_line=on_line)
            out = torch.from_numpy(np.load(frames_out)).float() / 255.0
        finally:
            for p in (frames_in, frames_out, wav, wav0):
                try:
                    os.remove(p)
                except OSError:
                    pass
        if not saved:
            return (out, json.dumps(report))
        # The patches and their list as outputs of this node, so whoever queued the graph can fetch them.
        listed = [{"filename": "patches.json", "subfolder": saved.replace(os.sep, "/"), "type": "output"}]
        listed += [{"filename": p["file"], "subfolder": saved.replace(os.sep, "/"), "type": "output"} for p in json.load(open(os.path.join(fields["patch_dir"], "patches.json")))["frames"]]
        with open(os.path.join(fields["patch_dir"], "report.json"), "w") as f:
            json.dump(report, f)
        listed.append({"filename": "report.json", "subfolder": saved.replace(os.sep, "/"), "type": "output"})
        return {"ui": {"files": listed}, "result": (out, json.dumps(report))}


def _read_video(video):
    """A clip's frames as RGB, converted from its YUV with BT.709 (limited range) said outright, so whoever pastes the
    patches back knows the matrix (ComfyUI's own reading leaves it to the decoder's default)."""
    import av

    src = video.get_stream_source()
    frames, matrix = [], "bt709"
    with av.open(src) as c:
        stream = c.streams.video[0]
        for frame in c.decode(stream):
            try:
                frames.append(frame.to_ndarray(format="rgb24", src_colorspace="ITU709", src_color_range="MPEG"))
            except TypeError:
                # An older PyAV without these: its default (BT.601).
                matrix = "bt601"
                frames.append(frame.to_ndarray(format="rgb24"))
    if not frames:
        raise ValueError("The video has no frames.")
    return np.stack(frames), matrix


def _write_wav(audio, path):
    """ComfyUI AUDIO as a 16 kHz mono WAV (what the worker hears)."""
    import wave

    wave_t = audio["waveform"]
    rate = int(audio["sample_rate"])
    x = wave_t[0].float().mean(0).cpu().numpy()
    if rate != 16000:
        n = int(round(len(x) * 16000 / rate))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


# ------------------------------------------------------------------ editing the clip itself to new speech (HuMo)


def flow_sigmas(steps, shift):
    """A flow model's noise levels: `steps` evenly from 1 down (the last above 0), shifted toward the noisy end
    (sigma' = shift*sigma / (1 + (shift-1)*sigma)), then 0."""
    base = torch.linspace(1.0, 0.0, steps + 1)[:-1]
    shifted = shift * base / (1 + (shift - 1) * base)
    return torch.cat([shifted, torch.zeros(1)])


class _FlowAlignSampler:
    """The edit: the clip's own latent is noised to each level and the model is asked, at that level, how the clip moves
    with its old speech and how the edit moves with the new; the edit takes only the difference (the mouth), so
    everything the speech doesn't touch stays the clip's own. Guidance pushes the edit away from the old speech (cfg),
    not from nothing. After `end` the edit is only cleaned up by the new speech's prediction. A Sampler for ComfyUI's
    guider (positive = the new speech, negative = the old)."""

    def __init__(self, start, end, cfg, seed, progress=None):
        self.start, self.end, self.cfg, self.seed, self.progress = int(start), int(end), float(cfg), int(seed), progress

    def max_denoise(self, model_wrap, sigmas):
        return False

    def sample(self, model_wrap, sigmas, extra_args, callback, noise, latent_image=None, denoise_mask=None, disable_pbar=False):
        import math

        import comfy.samplers

        guider = model_wrap
        model = guider.inner_model
        options = extra_args.get("model_options", {})
        tar, src = guider.conds.get("positive"), guider.conds.get("negative")
        x0 = latent_image.float()
        gen = torch.Generator(device="cpu").manual_seed(self.seed)

        def randn():
            return torch.randn(x0.shape, generator=gen, dtype=torch.float32).to(x0.device)

        eps = randn()
        size = x0.numel()
        n = len(sigmas) - 1
        z_tar = None
        ones = torch.ones((x0.shape[0],), device=x0.device, dtype=torch.float32)
        for i in range(n):
            sig, nxt = float(sigmas[i]), float(sigmas[i + 1])
            if i < self.start:
                continue
            z_src = (1 - sig) * x0 + sig * eps
            if z_tar is None:
                z_tar = z_src.clone()
            t = ones * sig
            # The edit's velocity with the new speech, guided away from the old one.
            if self.cfg > 1:
                d_new, d_old = comfy.samplers.calc_cond_batch(model, [tar, src], z_tar, t, options)
                v_new, v_old = (z_tar - d_new) / sig, (z_tar - d_old) / sig
                vp = v_old + self.cfg * (v_new - v_old)
            else:
                d_new = comfy.samplers.calc_cond_batch(model, [tar], z_tar, t, options)[0]
                vp = (z_tar - d_new) / sig
            if i <= self.end:
                # How the clip itself moves with its own speech here: only the difference goes into the edit.
                d_q = comfy.samplers.calc_cond_batch(model, [src], z_src, t, options)[0]
                vq = (z_src - d_q) / sig
                v = vp - vq
                guess = z_src + (1 - sig) * vq  # the noise the model sees in the clip at this level
                fresh = (1 - sig) * guess + sig * randn()
                fresh = fresh / torch.norm(fresh.reshape(1, -1), dim=1).clamp_min(1e-6) * math.sqrt(size)
                z_tar = z_tar + (nxt - sig) * v + (sig - nxt) * x0 + nxt * fresh - sig * eps
                eps = fresh
            else:
                z_tar = z_tar + (nxt - sig) * vp
            if callback is not None:
                callback(i, d_new, z_tar, n)
            if self.progress:
                self.progress(i + 1, n)
        return z_tar if z_tar is not None else x0


class CrackioAudioEdit:
    """A talking clip edited to new speech by an audio-driven video model (HuMo), without masking anything: the clip's
    own latent goes in, and the model changes only what the new speech changes (the mouth, the jaw), keeping the face,
    the smile and the teeth it already shows. Wire two HuMo conditionings (WanHuMoImageToVideo) made with the same
    reference picture and prompt: `target` with the new speech, `source` with the clip's own. Defaults: 20 steps,
    shift 5, the edit from step 6 to 16, guidance 4.5 (FlowAlign-style editing as in SyncEdit, arXiv 2603.09084)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "target": ("CONDITIONING", {"tooltip": "HuMo conditioning with the NEW speech."}),
                "source": ("CONDITIONING", {"tooltip": "HuMo conditioning with the clip's OWN speech (same reference and prompt)."}),
                "latent": ("LATENT", {"tooltip": "The clip itself, encoded (VAE Encode)."}),
                "seed": ("INT", {"default": 7, "min": 0, "max": 0xFFFFFFFF}),
                "steps": ("INT", {"default": 20, "min": 4, "max": 100}),
                "shift": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 20.0, "step": 0.1}),
                "start_step": ("INT", {"default": 6, "min": 0, "max": 99, "tooltip": "Earlier: more change (better sync), later: closer to the clip."}),
                "end_step": ("INT", {"default": 16, "min": 0, "max": 99, "tooltip": "The last step that follows the clip; after it the edit is only cleaned up."}),
                "cfg": ("FLOAT", {"default": 4.5, "min": 1.0, "max": 15.0, "step": 0.1, "tooltip": "How hard the edit is pushed from the old speech to the new."}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "run"
    CATEGORY = "Crackio"

    def run(self, model, target, source, latent, seed, steps, shift, start_step, end_step, cfg):
        import comfy.samplers
        import comfy.utils

        sigmas = flow_sigmas(int(steps), float(shift))
        bar = comfy.utils.ProgressBar(int(steps))
        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(target, source)
        guider.set_cfg(1.0)
        sampler = _FlowAlignSampler(start_step, end_step, cfg, seed, progress=lambda k, n: bar.update_absolute(k, n))
        x = latent["samples"]
        out = guider.sample(torch.zeros_like(x), x, sampler, sigmas, seed=int(seed))
        result = latent.copy()
        result["samples"] = out
        return (result,)


# What Crackio Mouth Refine is wired to (server/lipsync/run HUMO_FILES): Comfy-Org's HuMo repack and Wan 2.1's files.
HUMO_FILES = {
    "model": ("diffusion_models", "humo_17B_fp8_e4m3fn.safetensors"),
    "whisper": ("audio_encoders", "whisper_large_v3_fp16.safetensors"),
    "text": ("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
    "vae": ("vae", "wan_2.1_vae.safetensors"),
}
# Crackio's MXFP8 build of HuMo 17B (from Comfy-Org's fp16: Linear weights MXFP8, the rest fp16), which Crackio uses
# instead where it's there: the same pictures, 1.7x faster drawing on an RTX 5090 (its tensor cores do MXFP8 themselves).
HUMO_FAST = ("diffusion_models", "humo_17B_mxfp8_crackio.safetensors")


def _speech_features(audio_encoder, audio, frames, fps):
    """HuMo's speech features, one per frame of the clip at its own rate: Whisper large v3 hears the speech as it is
    (in pieces of 25 s; it takes 30 at most), its layers pooled the way HuMo was trained (ComfyUI's
    WanHuMoImageToVideo) and spread from Whisper's 50 a second to the clip's `fps`, so frame k hears what's said under
    frame k (HuMo is trained at 25 fps; other rates are close enough)."""
    from comfy_extras.nodes_wan import linear_interpolation

    wave_t = audio["waveform"][:1]
    rate = int(audio["sample_rate"])
    want = int(round(frames / fps * rate))
    if wave_t.shape[-1] < want:
        wave_t = torch.nn.functional.pad(wave_t, (0, want - wave_t.shape[-1]))
    wave_t = wave_t[..., :want]
    piece = 25 * rate
    layers = []
    for p0 in range(0, want, piece):
        enc = audio_encoder.encode_audio(wave_t[..., p0 : p0 + piece], rate)
        every = torch.stack(enc["encoded_audio_all_layers"], dim=2)
        layers.append(every[:, : (enc["audio_samples"] // 640) * 2])
    emb = torch.cat(layers, dim=1)
    out = frames + 8

    def spread(x):
        return linear_interpolation(x, 50, fps, output_len=max(1, int(round(emb.shape[1] / 50 * fps))))

    feats = [spread(emb[:, :, k : k + 8].mean(dim=2)) for k in (0, 8, 16, 24)] + [spread(emb[:, :, 32])]
    feats = torch.stack(feats, dim=2)[0]
    if feats.shape[0] < out:
        feats = torch.cat([feats, torch.zeros((out - feats.shape[0],) + tuple(feats.shape[1:]), dtype=feats.dtype, device=feats.device)])
    return feats


def _sample(model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise, guided=0):
    """KSampler's way (`steps` over the whole schedule, its last part at `denoise`), with classifier-free guidance on
    the first `guided` steps only (0: on all): the rest run at cfg 1, one pass of the model a step instead of two. The
    progress bar counts all the steps."""
    import comfy.sample
    import comfy.utils

    steps = int(steps)
    lat = comfy.sample.fix_empty_latent_channels(model, latent)
    noise = comfy.sample.prepare_noise(lat, int(seed), None)
    bar = comfy.utils.ProgressBar(steps)

    def counted(offset):
        return lambda step, x0, x, total: bar.update_absolute(offset + step + 1, steps)

    split = 0 < int(guided) < steps and float(cfg) != 1.0
    args = dict(denoise=float(denoise), disable_pbar=True, seed=int(seed))
    if not split:
        return comfy.sample.sample(model, noise, steps, float(cfg), sampler_name, scheduler, positive, negative, lat, callback=counted(0), **args)
    g = int(guided)
    half = comfy.sample.sample(model, noise, steps, float(cfg), sampler_name, scheduler, positive, negative, lat, last_step=g, force_full_denoise=False, callback=counted(0), **args)
    # The rest from where the first part stopped (its leftover noise is in it): no new noise, cfg 1.
    return comfy.sample.sample(model, torch.zeros_like(noise), steps, 1.0, sampler_name, scheduler, positive, negative, half, disable_noise=True, start_step=g, force_full_denoise=True, callback=counted(g), **args)


class CrackioMouthRefine:
    """Lip Sync's best quality: LatentSync's new mouths made real. An audio-driven video model (HuMo 17B) redraws the
    face lightly over them (denoise about 0.35), hearing the new speech and looking at the person's own frame where the
    mouth shows the most, so the teeth, lips and inside of the mouth come out as theirs instead of LatentSync's soft,
    generic ones while the mouth keeps LatentSync's shapes. Then only the mouth area goes back onto the clip's own frames
    (as Lip Sync does: colour matched, lips' colour pulled back, every other pixel the original's). Works in windows of
    HuMo's length (97 frames) that cross-fade. Wire HuMo (UNETLoader → speed LoRA if wanted → ModelSamplingSD3, shift
    5), the Wan 2.1 VAE, a text prompt (CLIPTextEncode, umt5) and Whisper large v3 (AudioEncoderLoader)."""

    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers

        return {
            "required": {
                "model": ("MODEL", {"tooltip": "HuMo 17B (or 1.7B), shift 5."}),
                "vae": ("VAE", {"tooltip": "Wan 2.1's VAE."}),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "audio_encoder": ("AUDIO_ENCODER", {"tooltip": "Whisper large v3."}),
                "images": ("IMAGE", {"tooltip": "The frames with LatentSync's new mouths (Crackio Lip Sync's images)."}),
                "video": ("VIDEO", {"tooltip": "The same frames as they were (the clip): the reference face and the pixels the mouth goes back onto."}),
                "audio": ("AUDIO", {"tooltip": "The soundtrack for these frames with the new words in it."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.001}),
                "span_start": ("INT", {"default": 0, "min": 0, "max": 1_000_000, "tooltip": "First frame whose mouth changes."}),
                "span_end": ("INT", {"default": -1, "min": -1, "max": 1_000_000, "tooltip": "Frame after the last one that changes; -1: to the end."}),
                "denoise": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 1.0, "step": 0.01, "tooltip": "How much HuMo redraws: lower keeps more of LatentSync (its sync), higher more of HuMo (real teeth and lips)."}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 100, "tooltip": "Steps over the whole schedule (KSampler's way): at denoise 0.35, 8 run 8. 8 look like 20 (lips SSIM 0.95) in under half the time."}),
                "cfg": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 15.0, "step": 0.1, "tooltip": "1 with a CFG-distilled speed LoRA (twice as fast)."}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "seed": ("INT", {"default": 11, "min": 0, "max": 0xFFFFFFFF}),
                "size": ("INT", {"default": 832, "min": 512, "max": 1280, "step": 16, "tooltip": "The face window's biggest side in HuMo's picture; a smaller face is drawn at its own size (never under 512)."}),
                "fade": ("INT", {"default": 4, "min": 0, "max": 24, "tooltip": "Frames the new mouth takes to come in and go out at the span's ends."}),
                "check": ("BOOLEAN", {"default": True, "tooltip": "Scores how well the new mouths go with the words (SyncNet), when it's installed."}),
            },
            "optional": {
                "original_audio": ("AUDIO", {"tooltip": "The original soundtrack, to score the original mouths too (the bar to reach)."}),
                "patch_prefix": ("STRING", {"default": "", "tooltip": "Also save what changed as RGBA patches (and patches.json) under output/<prefix>_<n>/, for pasting onto the original frames exactly."}),
                "face_x": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.001, "tooltip": "Which face speaks: across the frame (0–1), -1 for the biggest."}),
                "face_y": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.001}),
                "chunk": ("INT", {"default": 97, "min": 33, "max": 161, "step": 4, "tooltip": "Frames HuMo draws at once (4n+1; it's trained on 97)."}),
                "scale": ("FLOAT", {"default": 1.9, "min": 1.2, "max": 3.0, "step": 0.05, "tooltip": "How much round the face HuMo sees: the window's side is the face's biggest size times this."}),
                "upscale": ("BOOLEAN", {"default": False, "tooltip": "Always draw the window at `size`, a smaller face made bigger (finer teeth and lips, shrunk back when pasted), not at its own pixel size."}),
                "guided_steps": ("INT", {"default": 0, "min": 0, "max": 100, "tooltip": "Guidance (cfg) on the first this many steps only, the rest at cfg 1, one model pass a step instead of two; 0: on all."}),
                "area": (["mouth", "lips"], {"default": "mouth", "tooltip": "What HuMo's drawing replaces: the mouth area (under the nose round the jaw) on the clip, or only the lips and the mouth's opening, on LatentSync's frames (its skin round them; HuMo can give a smooth face rough skin there)."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "report")
    FUNCTION = "run"
    CATEGORY = "Crackio"
    OUTPUT_NODE = True

    def run(self, model, vae, positive, negative, audio_encoder, images, video, audio, fps, span_start, span_end, denoise, steps, cfg, sampler_name, scheduler, seed, size, fade, check, original_audio=None, patch_prefix="", face_x=-1.0, face_y=-1.0, chunk=97, scale=1.9, upscale=False, guided_steps=0, area="mouth"):
        import comfy.model_management
        import node_helpers
        import nodes
        from comfy_extras.nodes_wan import get_audio_emb_window

        if not _engine():
            raise RuntimeError("Lip sync isn't set up on this machine yet: set it up from Crackio's Lip Sync tool.")
        t0 = time.time()
        models = _models()
        frames_u8, matrix = _read_video(video)
        cuts = (images.clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        n, h, w = frames_u8.shape[0], frames_u8.shape[1], frames_u8.shape[2]
        if cuts.shape != frames_u8.shape:
            raise ValueError(f"The frames ({tuple(cuts.shape)}) aren't the clip's ({tuple(frames_u8.shape)}).")
        end = n if span_end < 0 else min(n, span_end)
        if end - span_start < 2:
            raise ValueError("The span needs at least two frames.")
        tmp = os.path.join(_engine_dir(), "tmp")
        os.makedirs(tmp, exist_ok=True)
        key = uuid.uuid4().hex[:10]
        p = {k: os.path.join(tmp, f"{key}-{k}") for k in ("orig.npy", "cuts.npy", "crops.npy", "ref.npy", "meta.json", "gens.npy", "out.npy", "new.wav", "old.wav")}
        try:
            np.save(p["orig.npy"], frames_u8)
            np.save(p["cuts.npy"], cuts)
            del cuts
            fields = {"frames": p["orig.npy"], "cuts": p["cuts.npy"], "fps": float(fps), "span": [int(span_start), int(end)], "size": int(size), "scale": float(scale), "upscale": bool(upscale), "margin": 8, "out_crops": p["crops.npy"], "out_ref": p["ref.npy"], "out_meta": p["meta.json"]}
            if face_x >= 0 and face_y >= 0:
                fields["hint"] = [float(face_x) * w, float(face_y) * h]
            win = run_worker("window", fields)
            crops = np.load(p["crops.npy"])
            ref = torch.from_numpy(np.load(p["ref.npy"])).float()[None] / 255.0
            a, b = win["window"]
            side = int(win["size"])
            t_window = time.time() - t0

            feats = _speech_features(audio_encoder, audio, n, float(fps))
            ref_lat = vae.encode(ref[:, :, :, :3])
            total = b - a
            chunk = max(5, 4 * ((int(chunk) - 1) // 4) + 1)
            over = 16
            if total <= chunk:
                starts, each = [0], total
            else:
                # As few windows as fit, the same length, sharing at least `over` frames where they meet.
                m = math.ceil((total - over) / (chunk - over))
                each = min(chunk, 4 * math.ceil(((total + (m - 1) * over) / m - 1) / 4) + 1)
                starts = [int(round(k * (total - each) / (m - 1))) for k in range(m)]
            acc = np.zeros((total, side, side, 3), np.float32)
            weight = np.zeros((total,), np.float32)
            for c0 in starts:
                c1 = min(total, c0 + each)
                length = 4 * ((c1 - c0 - 1 + 3) // 4) + 1
                x = crops[c0:c1]
                if len(x) < length:
                    x = np.concatenate([x, np.repeat(x[-1:], length - len(x), axis=0)])
                lat = vae.encode(torch.from_numpy(x).float()[:, :, :, :3] / 255.0)
                emb, _ = get_audio_emb_window(feats, length, frame0_idx=a + c0)
                emb = emb.unsqueeze(0)
                pos = node_helpers.conditioning_set_values(positive, {"reference_latents": [ref_lat]}, append=True)
                neg = node_helpers.conditioning_set_values(negative, {"reference_latents": [torch.zeros_like(ref_lat)]}, append=True)
                pos = node_helpers.conditioning_set_values(pos, {"audio_embed": emb})
                neg = node_helpers.conditioning_set_values(neg, {"audio_embed": torch.zeros_like(emb)})
                drawn = _sample(model, seed, steps, cfg, sampler_name, scheduler, pos, neg, lat, denoise, guided_steps)
                pix = vae.decode(drawn)
                pix = pix.reshape(-1, pix.shape[-3], pix.shape[-2], pix.shape[-1])[: c1 - c0]
                got = (pix.clamp(0, 1) * 255.0).float().cpu().numpy()
                k = np.arange(c1 - c0, dtype=np.float32)
                # Cross-fades where windows meet (a window's own ends stay whole at the edges of the stretch).
                ramp_in = np.ones_like(k) if c0 == 0 else np.minimum(1.0, (k + 1) / (over + 1))
                ramp_out = np.ones_like(k) if c1 == total else np.minimum(1.0, (c1 - c0 - k) / (over + 1))
                wk = np.minimum(ramp_in, ramp_out)
                acc[c0:c1] += got * wk[:, None, None, None]
                weight[c0:c1] += wk
                comfy.model_management.throw_exception_if_processing_interrupted()
            gens = np.clip(np.round(acc / np.maximum(weight, 1e-6)[:, None, None, None]), 0, 255).astype(np.uint8)
            del acc, crops
            np.save(p["gens.npy"], gens)
            t_draw = time.time() - t0 - t_window

            _write_wav(audio, p["new.wav"])
            paste = {"frames": p["orig.npy"], "crops": p["gens.npy"], "meta": p["meta.json"], "fps": float(fps), "fade": int(fade), "colour": True, "sharpen": True, "lips": True, "out_frames": p["out.npy"], "matrix": matrix, "score": bool(check) and os.path.exists(models["syncnet"]), "audio": p["new.wav"], "area": area, "base": p["cuts.npy"]}
            if original_audio is not None:
                _write_wav(original_audio, p["old.wav"])
                paste["original_audio"] = p["old.wav"]
            saved = None
            if patch_prefix.strip():
                out_dir = folder_paths.get_output_directory()
                folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(patch_prefix.strip(), out_dir)
                sub = os.path.join(subfolder, f"{name}_{counter:05}") if subfolder else f"{name}_{counter:05}"
                paste["patch_dir"] = os.path.join(out_dir, sub)
                saved = sub
            done = run_worker("paste", paste)
            out = torch.from_numpy(np.load(p["out.npy"])).float() / 255.0
        finally:
            for f in p.values():
                try:
                    os.remove(f)
                except OSError:
                    pass
        report = {
            "frames": n,
            "span": [int(span_start), int(end)],
            "refine": {"model": "HuMo", "window": [a, b], "size": side, "face_side": win.get("side"), "scale": float(scale), "upscale": bool(upscale), "chunks": len(starts), "denoise": float(denoise), "steps": int(steps), "guided_steps": int(guided_steps) or int(steps), "cfg": float(cfg), "sampler": sampler_name, "reference": win.get("reference"), "area": area},
            "scores": done.get("scores"),
            "lips_shift_ab": done.get("lips_shift_ab"),
            "changed_pixels": done.get("changed_pixels"),
            "patches": done.get("patches"),
            "seconds": {"window": round(t_window, 1), "draw": round(t_draw, 1), "paste": done.get("seconds"), "total": round(time.time() - t0, 1)},
        }
        if not saved:
            return (out, json.dumps(report))
        listed = [{"filename": "patches.json", "subfolder": saved.replace(os.sep, "/"), "type": "output"}]
        listed += [{"filename": q["file"], "subfolder": saved.replace(os.sep, "/"), "type": "output"} for q in json.load(open(os.path.join(paste["patch_dir"], "patches.json")))["frames"]]
        with open(os.path.join(paste["patch_dir"], "report.json"), "w") as f:
            json.dump(report, f)
        listed.append({"filename": "report.json", "subfolder": saved.replace(os.sep, "/"), "type": "output"})
        return {"ui": {"files": listed}, "result": (out, json.dumps(report))}


NODE_CLASS_MAPPINGS = {"CrackioLipSync": CrackioLipSync, "CrackioAudioEdit": CrackioAudioEdit, "CrackioMouthRefine": CrackioMouthRefine}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioLipSync": "Crackio Lip Sync (LatentSync)", "CrackioAudioEdit": "Crackio Audio Edit (HuMo)", "CrackioMouthRefine": "Crackio Mouth Refine (HuMo)"}


# ------------------------------------------------------------------ routes


@PromptServer.instance.routes.get("/crackio/lipsync")
async def lipsync_status(request):
    models = _models()
    with _install_lock:
        install = dict(_install)
    try:
        disk = shutil.disk_usage(_folder("latentsync")).free
    except OSError:
        disk = None
    return web.json_response({
        "engine": _engine(),
        "install": install,
        "check": dict(_check),
        "models": {k: os.path.exists(v) for k, v in models.items()},
        # Best quality's files (Crackio Mouth Refine: HuMo over LatentSync), where ComfyUI's own loaders look.
        "best": {k: bool(folder_paths.get_full_path(folder, name)) or (k == "model" and bool(folder_paths.get_full_path(*HUMO_FAST))) for k, (folder, name) in HUMO_FILES.items()},
        "best_fast": bool(folder_paths.get_full_path(*HUMO_FAST)),
        "files": MODEL_FILES,
        "folder": _folder("latentsync"),
        "disk_free": disk,
        "platform": {"system": platform.system(), "machine": platform.machine()},
    })


_check = {"state": "idle", "error": None, "started": None, "finished": None}


def _run_check():
    try:
        full = all(os.path.exists(_models()[k]) for k in ("unet", "whisper", "vae"))
        res = run_worker("selftest", {"full": full}, timeout=900)
        res.update(checked=time.time(), full=full)
        with open(os.path.join(_engine_dir(), "engine.json"), "w") as f:
            json.dump(res, f)
        with _install_lock:
            _check.update(state="done", finished=time.time())
    except Exception as e:
        with _install_lock:
            _check.update(state="error", error=str(e)[:500], finished=time.time())


@PromptServer.instance.routes.post("/crackio/lipsync/check")
async def lipsync_check(request):
    """The self-test again (after the models arrived): the packages import, MediaPipe runs, LatentSync loads."""
    if not os.path.isdir(os.path.join(_engine_dir(), "site", "diffusers")):
        return web.json_response({"error": "The lip-sync engine isn't installed here yet."}, status=409)
    with _install_lock:
        if _check["state"] == "running":
            return web.json_response(dict(_check))
        _check.update(state="running", error=None, started=time.time(), finished=None)
    threading.Thread(target=_run_check, daemon=True, name="crackio-lipsync-check").start()
    with _install_lock:
        return web.json_response(dict(_check))


@PromptServer.instance.routes.post("/crackio/lipsync/engine")
async def lipsync_engine(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if _engine() and not body.get("force"):
        return web.json_response({"state": "done", "engine": _engine()})
    with _install_lock:
        if _install["state"] == "running":
            return web.json_response(dict(_install))
        _install.update(state="running", step="packages", error=None, started=time.time(), finished=None)
    threading.Thread(target=_install_engine, daemon=True, name="crackio-lipsync-install").start()
    return web.json_response(dict(_install))


@PromptServer.instance.routes.post("/crackio/lipsync/forget")
async def lipsync_forget(request):
    """What a lip sync left here once Crackio has its result: the window clip and sounds it sent (input/crackio/,
    named lipsync-...) and the patches' folders (output/crackio/lipsync_NNNNN). Nothing else can be named."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    removed = 0
    inputs = folder_paths.get_input_directory()
    for name in body.get("inputs") or []:
        name = str(name).replace("\\", "/")
        if not re.fullmatch(r"(crackio/)?lipsync-[A-Za-z0-9_-]+\.(mp4|wav)", name):
            continue
        path = os.path.join(inputs, *name.split("/"))
        if os.path.isfile(path):
            os.remove(path)
            removed += 1
    outputs = folder_paths.get_output_directory()
    for sub in body.get("outputs") or []:
        sub = str(sub).replace("\\", "/")
        if not re.fullmatch(r"crackio/lipsync_\d{5}", sub):
            continue
        path = os.path.join(outputs, *sub.split("/"))
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
    return web.json_response({"removed": removed})
