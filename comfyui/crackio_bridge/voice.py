"""
Voice: speech from text, and text from speech, on this machine through audio.cpp (github.com/0xShug0/audio.cpp,
Apache-2.0), one C++ engine that runs open speech models from GGUF files on CUDA, Vulkan, Metal or the CPU: Fish Audio
Drama 3, VoxCPM2, Supertonic 3, Qwen3-ASR and its forced aligner. ComfyUI's own loaders don't run speech models, so the
node keeps one audio.cpp server next to ComfyUI, hands it each line and gives the audio back as ComfyUI AUDIO.

Nodes
  Crackio Voice (CrackioVoice)            words, and optionally voices to speak with (AUDIO + what they say) -> AUDIO
  Crackio Transcribe (CrackioTranscribe)  AUDIO, and the words when they're known -> text, words with times (JSON)

Files
  models/audiocpp/*.gguf             the models (folder "audiocpp"; extra_model_paths.yaml can put it on another drive)
  <its parent>/audiocpp-engine/      audio.cpp itself, fetched for this machine (POST /crackio/voice/engine)

Routes
  GET  /crackio/voice                the engine, the server and the models it serves
  POST /crackio/voice/engine         {build?} get audio.cpp running here: this machine's builds best first, each checked
  POST /crackio/voice/check          {model?} speak a test line and hear it back (the proof Voice works here)
  POST /crackio/voice/stop           stop the server: frees all of its GPU memory and RAM (the next line starts it again)

Models load on the first line that needs them and leave the GPU after two quiet minutes, so the card is free again
for pictures and clips. Fish Audio Drama 3 is under the Fish Audio Community License: built with Fish Audio.
"""
import asyncio
import base64
import hashlib
import json
import math
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import numpy as np
import torch

import folder_paths
from aiohttp import web
from server import PromptServer

TAG = "v0.9.3"
RELEASES = f"https://github.com/0xShug0/audio.cpp/releases/download/{TAG}"
FOLDER = "audiocpp"
IDLE_MS = 120_000

if FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(FOLDER, os.path.join(folder_paths.models_dir, FOLDER))

# What each file is, by its name: audio.cpp's family, the route the server opens for it, and what it does.
FAMILIES = (
    (re.compile(r"drama-?3", re.I), "fish_drama3", "tts", "speech"),
    (re.compile(r"voxcpm2", re.I), "voxcpm2", "tts", "speech"),
    (re.compile(r"supertonic", re.I), "supertonic", "tts", "speech"),
    (re.compile(r"kokoro", re.I), "kokoro_tts", "tts", "speech"),
    (re.compile(r"forced-?aligner", re.I), "qwen3_forced_aligner", "align", "align"),
    (re.compile(r"qwen3-?asr", re.I), "qwen3_asr", "asr", "asr"),
)

# Language names the Qwen3 models take, by code.
LANGUAGES = {
    "en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "pl": "Polish", "nl": "Dutch", "ar": "Arabic", "tr": "Turkish",
    "sv": "Swedish", "da": "Danish", "fi": "Finnish", "cs": "Czech", "el": "Greek", "hu": "Hungarian", "ro": "Romanian",
    "id": "Indonesian", "vi": "Vietnamese", "th": "Thai", "hi": "Hindi", "uk": "Ukrainian", "ms": "Malay",
}


def _models_dir():
    from . import storage

    chosen = storage.folder(FOLDER)  # the download folder chosen in Crackio's Settings → Storage (bridge 1.10)
    if chosen:
        return chosen
    paths = folder_paths.get_folder_paths(FOLDER) or [os.path.join(folder_paths.models_dir, FOLDER)]
    for p in paths:
        if os.path.isdir(p):
            return p
    os.makedirs(paths[0], exist_ok=True)
    return paths[0]


def _engine_dir():
    # CRACKIO_AUDIOCPP_ENGINE_DIR: elsewhere, e.g. when the models sit on a RAM disk that can't run programs.
    return os.environ.get("CRACKIO_AUDIOCPP_ENGINE_DIR") or os.path.join(os.path.dirname(os.path.normpath(_models_dir())), "audiocpp-engine")


def _family(name):
    for pattern, family, task, kind in FAMILIES:
        if pattern.search(name):
            return family, task, kind
    return None


def _model_id(name):
    return re.sub(r"[^a-z0-9._-]+", "-", os.path.splitext(name)[0].lower())


def _gguf_files():
    out = []
    for p in folder_paths.get_folder_paths(FOLDER) or []:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if f.lower().endswith(".gguf") and _family(f):
                    out.append(os.path.join(p, f))
    return out


def _speech_models():
    return [os.path.basename(p) for p in _gguf_files() if _family(os.path.basename(p))[2] == "speech"]


# ------------------------------------------------------------------ this machine


def _nvidia():
    """The first NVIDIA GPU: compute capability, its memory, and the CUDA version its driver runs. None without one."""
    try:
        q = subprocess.run(["nvidia-smi", "--query-gpu=compute_cap,memory.total,memory.free", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=15)
        cc, total, free = [x.strip() for x in q.stdout.strip().splitlines()[0].split(",")]
        top = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=15).stdout
        m = re.search(r"CUDA Version:\s*(\d+)", top)
        return {"cc": float(cc), "total_mb": int(float(total)), "free_mb": int(float(free)), "cuda": int(m.group(1)) if m else 12}
    except Exception:
        if torch.cuda.is_available() and torch.version.cuda:
            major, minor = torch.cuda.get_device_capability(0)
            free, total = torch.cuda.mem_get_info(0)
            return {"cc": major + minor / 10, "total_mb": total // 2**20, "free_mb": free // 2**20, "cuda": int(torch.version.cuda.split(".")[0])}
        return None


def _candidates():
    """The audio.cpp builds that could run here, best first (github.com/0xShug0/audio.cpp/releases). A GPU build that
    can't use this machine's GPU (no driver, too old a driver, no Vulkan) fails its check and the next one is tried;
    the CPU build runs anywhere. Empty: audio.cpp has no build for this system."""
    forced = os.environ.get("CRACKIO_AUDIOCPP_BUILD")
    if forced:
        return [forced]
    system, machine = platform.system(), platform.machine().lower()
    if system == "Darwin":
        # Metal on both kinds of Mac (there's no CPU-only build for macOS).
        return ["macos-arm64-metal"] if machine in ("arm64", "aarch64") else ["macos-x64-metal"]
    if machine not in ("x86_64", "amd64"):
        return []
    gpu = _nvidia()
    cuda = gpu["cuda"] if gpu else 0
    if system == "Windows":
        out = []
        # CUDA 13 builds leave out GPUs before Turing (GTX 10 and older) and need a CUDA 13 driver.
        if gpu and gpu["cc"] >= 7.5 and cuda >= 13:
            out.append("windows-x64-cuda13.3")
        if gpu and cuda >= 12:
            out.append("windows-x64-cuda12.4")
        return out + ["windows-x64-vulkan", "windows-x64-cpu-portable"]
    if system == "Linux":
        return (["ubuntu-x64-cuda12.8-colab"] if gpu and cuda >= 12 else []) + ["ubuntu-x64-vulkan", "ubuntu-x64-cpu-portable"]
    return []


def _build():
    """The build to try first here, or None."""
    c = _candidates()
    return c[0] if c else None


def _backend(build):
    return "cuda" if "cuda" in build else "vulkan" if "vulkan" in build else "metal" if "metal" in build else "cpu"


def _assets(build):
    ext = "zip" if build.startswith("windows") else "tar.gz"
    names = [f"audio-{TAG}-bin-{build}.{ext}"]
    m = re.match(r"(windows|ubuntu)-x64-cuda(\d+\.\d+)", build)
    if m:
        names.append(f"audio-{TAG}-cudart-{m.group(1)}-x64-cuda{m.group(2)}.{ext}")
    return names


def _engine():
    """The installed engine: {build, dir, server, tag, checked?, gpu?, spoke?}, or None."""
    try:
        with open(os.path.join(_engine_dir(), "current.json")) as f:
            e = json.load(f)
        return e if os.path.isfile(e.get("server", "")) else None
    except (OSError, ValueError):
        return None


def _note_engine(**fields):
    """Adds to what current.json says about the engine (the line it spoke, how long that took)."""
    e = _engine()
    if not e:
        return
    e.update(fields)
    with open(os.path.join(_engine_dir(), "current.json"), "w") as f:
        json.dump(e, f)


def _engine_env(d):
    """The environment audio.cpp runs in: its own folder first for its libraries, its temp files next to it (audio.cpp
    unpacks each model's config there, and a full system drive stopped every model from loading)."""
    env = dict(os.environ)
    tmp = os.path.join(_engine_dir(), "tmp")
    os.makedirs(tmp, exist_ok=True)
    env.update(TMP=tmp, TEMP=tmp, TMPDIR=tmp)
    libs = [d, os.path.join(d, "lib")]
    if platform.system() == "Windows":
        env["PATH"] = os.pathsep.join([d, env.get("PATH", "")])
    elif platform.system() == "Darwin":
        env["DYLD_FALLBACK_LIBRARY_PATH"] = os.pathsep.join(filter(None, [*libs, env.get("DYLD_FALLBACK_LIBRARY_PATH")]))
    else:
        env["LD_LIBRARY_PATH"] = os.pathsep.join(filter(None, [*libs, env.get("LD_LIBRARY_PATH")]))
    return env


# ------------------------------------------------------------------ installing the engine

_install = {"state": "idle", "received": 0, "total": 0, "error": None, "build": None, "tried": [], "gpu": None}
_install_lock = threading.Lock()
_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_EXE = "audiocpp_server.exe" if platform.system() == "Windows" else "audiocpp_server"


def _download(url, target):
    req = urllib.request.Request(url, headers={"User-Agent": "crackio-bridge"})
    with urllib.request.urlopen(req, timeout=120) as res:
        size = int(res.headers.get("Content-Length") or 0)
        # Room for the archive and what it unpacks to.
        free = shutil.disk_usage(os.path.dirname(target)).free
        if size and free < size * 2.4 + 300 * 1024**2:
            raise IOError(f"not enough disk space: {size * 2.4 / 1e9 + 0.3:.1f} GB needed, {free / 1e9:.1f} GB free")
        with _install_lock:
            _install["total"] += size
        with open(target + ".part", "wb") as out:
            while True:
                block = res.read(4 * 1024 * 1024)
                if not block:
                    break
                out.write(block)
                with _install_lock:
                    _install["received"] += len(block)
    os.replace(target + ".part", target)


def _unpack(archive, into):
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for m in z.infolist():
                dest = os.path.realpath(os.path.join(into, m.filename))
                if not dest.startswith(os.path.realpath(into) + os.sep) and dest != os.path.realpath(into):
                    raise IOError("unsafe path in the archive")
            z.extractall(into)
    else:
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                dest = os.path.realpath(os.path.join(into, m.name))
                if not dest.startswith(os.path.realpath(into) + os.sep) and dest != os.path.realpath(into):
                    raise IOError("unsafe path in the archive")
            t.extractall(into)


def _find_server(into):
    if not os.path.isdir(into):
        return None
    return next((os.path.join(d, _EXE) for d, _, fs in os.walk(into) if _EXE in fs), None)


def _fetch_build(build):
    """One build on disk (downloaded and unpacked, or already there): its server's path."""
    root = _engine_dir()
    into = os.path.join(root, f"{TAG}-{build}")
    server = _find_server(into)
    current = _engine()
    if server and (os.path.isfile(os.path.join(into, ".complete")) or (current and current.get("server") == server)):
        return server
    shutil.rmtree(into, ignore_errors=True)
    os.makedirs(into, exist_ok=True)
    for name in _assets(build):
        archive = os.path.join(root, name)
        if not os.path.exists(archive):
            with _install_lock:
                _install["state"] = "downloading"
            _download(f"{RELEASES}/{name}", archive)
        with _install_lock:
            _install["state"] = "unpacking"
        _unpack(archive, into)
        os.remove(archive)
    server = _find_server(into)
    if not server:
        raise IOError("the download has no audiocpp_server")
    if platform.system() != "Windows":
        for d, _, fs in os.walk(os.path.dirname(server)):
            for f in fs:
                if f.startswith("audiocpp_") or ".so" in f or f.endswith(".dylib"):
                    os.chmod(os.path.join(d, f), 0o755)
    with open(os.path.join(into, ".complete"), "w") as f:
        f.write(TAG)
    return server


# How audio.cpp names a backend's devices in --list-devices ("CUDA:0", "Vulkan:0", "Metal:0" or "MTL:0").
_DEVICE_NAMES = {"cuda": ("cuda",), "vulkan": ("vulkan",), "metal": ("metal", "mtl")}


def _exit_reason(code):
    """Why a program stopped as it started, from its exit code."""
    if platform.system() == "Windows" and code in (3221225781, -1073741515):
        return "a library it needs is missing (Windows couldn't find a DLL)"
    if platform.system() == "Windows" and code in (3221225501, -1073741795):
        return "this processor lacks an instruction it uses"
    if platform.system() == "Windows" and code in (3221226505, -1073740791):
        return "it aborted"
    if code == 127:
        return "a library it needs is missing"
    if platform.system() == "Darwin" and code == -9:
        return "macOS stopped it (its code signature)"
    return f"exit code {code}"


def _selftest(server, build):
    """Whether this build runs here: its GPU backend finds a GPU (where the build has its CLI to ask), and its server
    starts and answers (its libraries load on this system). Returns the GPU's name, or None for a CPU build or one
    without the CLI; raises with what failed."""
    d = os.path.dirname(server)
    env = _engine_env(d)
    backend = _backend(build)
    gpu = None
    cli = os.path.join(d, "audiocpp_cli.exe" if platform.system() == "Windows" else "audiocpp_cli")
    if backend != "cpu" and os.path.isfile(cli):
        try:
            out = subprocess.run([cli, "--list-devices"], cwd=d, env=env, capture_output=True, text=True, timeout=120, creationflags=_FLAGS)
        except subprocess.TimeoutExpired:
            raise IOError("its device check didn't finish in two minutes") from None
        devices = re.findall(r'^(\w+):\d+ "([^"]*)" \[(\w+)\]', out.stdout or "", re.M)
        gpus = [name for kind, name, typ in devices if typ in ("GPU", "IGPU") and kind.lower().startswith(_DEVICE_NAMES.get(backend, (backend,)))]
        if not gpus:
            seen = ", ".join(f"{k} {n}" for k, n, _ in devices)
            if seen:
                why = f"it sees only {seen}"
            elif out.returncode:
                why = _exit_reason(out.returncode)
            else:
                why = (out.stderr or out.stdout or "").strip()[-200:] or "it lists no devices"
            raise IOError(f"its {'CUDA' if backend == 'cuda' else backend.title()} backend can't use a GPU here: {why}")
        gpu = gpus[0]
    port = _free_port()
    cfg = os.path.join(d, "selftest.json")
    log = os.path.join(d, "selftest.log")
    with open(cfg, "w") as f:
        json.dump({"host": "127.0.0.1", "port": port, "backend": backend, "device": 0, "threads": 2, "ui_management": True, "models": []}, f)
    with open(log, "wb") as logf:
        proc = subprocess.Popen([server, "--config", cfg], cwd=d, env=env, stdout=logf, stderr=subprocess.STDOUT, creationflags=_FLAGS)
    try:
        for _ in range(120):
            if proc.poll() is not None:
                raise IOError(f"it stopped as it started ({_exit_reason(proc.returncode)}): {_tail(log, 300) or 'no output'}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if json.loads(r.read().decode() or "{}").get("status") == "ok":
                        return gpu
            except (urllib.error.URLError, OSError, ValueError):
                time.sleep(0.5)
        raise IOError("it didn't answer within a minute")
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        for f in (cfg, log):
            try:
                os.remove(f)
            except OSError:
                pass


def _install_engine(first=None, after=None):
    """Gets audio.cpp running here: this machine's builds best first (from `first`, or past `after` when that one
    passed its check but couldn't speak), each downloaded, unpacked and checked; one that fails is removed and the next
    is tried. Returns whether one works."""
    builds = _candidates()
    if first:
        builds = builds[builds.index(first):] if first in builds else [first]
    if after:
        builds = builds[builds.index(after) + 1:] if after in builds else []
    root = _engine_dir()
    tried = []
    for build in builds:
        with _install_lock:
            _install.update(state="downloading", build=build, received=0, total=0, error=None, tried=list(tried), gpu=None)
        into = os.path.join(root, f"{TAG}-{build}")
        try:
            os.makedirs(root, exist_ok=True)
            server = _fetch_build(build)
            with _install_lock:
                _install["state"] = "checking"
            gpu = _selftest(server, build)
            with open(os.path.join(root, "current.json"), "w") as f:
                json.dump({"build": build, "dir": os.path.dirname(server), "server": server, "tag": TAG, "checked": time.time(), "gpu": gpu}, f)
            # Other builds (an older release, one that failed) go.
            for x in os.listdir(root):
                if re.match(r"v\d+\.\d+\.\d+-", x) and x != f"{TAG}-{build}" and os.path.isdir(os.path.join(root, x)):
                    shutil.rmtree(os.path.join(root, x), ignore_errors=True)
            with _install_lock:
                _install.update(state="done", finished=time.time(), gpu=gpu, tried=tried)
            return True
        except Exception as e:
            tried.append({"build": build, "error": str(e)[:300]})
            shutil.rmtree(into, ignore_errors=True)
            print(f"[crackio_bridge] voice: audio.cpp {build} won't run here: {e}")
    with _install_lock:
        last = tried[-1]["error"] if tried else f"audio.cpp has no build for {platform.system()} on {platform.machine()}"
        _install.update(state="error", error=last, tried=tried)
    return False


# ------------------------------------------------------------------ checking it speaks

TEST_LINE = "Hello! This is Crackio, checking that your voice engine works."
_check = {"state": "idle", "model": None, "error": None, "seconds": None, "build": None, "heard": None, "tried": []}
_check_lock = threading.Lock()
# A failure that says the GPU backend can't run here (rather than the model's file or the GPU's memory): the next build
# for this machine is tried.
_BACKEND_FAULT = re.compile(r"cuda|cublas|vulkan|metal|ggml|kernel image|driver|device|audio\.cpp stopped|stopped as it started|backend|illegal instruction|segmentation", re.I)
_NOT_BACKEND = re.compile(r"out of memory|\boom\b|alloc|no space|not enough disk|isn't in |No voice models", re.I)


def _test_line(file):
    """Speaks the test line with this model; with speech to text here, hears it back. Returns (seconds, heard)."""
    family = _family(file)[0]
    t0 = time.time()
    audio = speak(file, TEST_LINE, (), "F2" if family == "supertonic" else "")
    took = time.time() - t0
    wave = audio["waveform"]
    length = wave.shape[-1] / max(1, audio["sample_rate"])
    if length < 0.8 or float(wave.abs().max()) < 1e-3:
        raise RuntimeError(f"the test line came back silent ({length:.1f} s)")
    heard = None
    if any(_family(os.path.basename(p))[0] == "qwen3_asr" for p in _gguf_files()):
        heard, _ = transcribe(audio, "", "en")
        said = set(re.findall(r"[a-z]+", heard.lower()))
        if len(said & {"hello", "this", "checking", "that", "your", "voice", "engine", "works", "crackio"}) < 3:
            raise RuntimeError(f'the test line came out garbled (speech to text heard: "{heard[:80]}")')
    return took, heard


def _run_check(file):
    """The proof: a line spoken by a model on this engine (and heard back). A failure in the GPU backend moves on to the
    next build for this machine and tries again, down to the CPU one."""
    tried = []
    while True:
        engine = _engine()
        build = engine["build"] if engine else None
        with _check_lock:
            _check.update(state="running", model=file, error=None, seconds=None, heard=None, build=build, tried=list(tried), started=time.time())
        try:
            if not engine:
                raise RuntimeError("audio.cpp isn't installed here")
            took, heard = _test_line(file)
            _note_engine(spoke=time.time(), spoke_with=file, spoke_seconds=round(took, 1))
            with _check_lock:
                _check.update(state="done", seconds=round(took, 1), heard=heard, build=build, tried=tried, finished=time.time())
            return
        except Exception as e:
            err = str(e)[:300]
            print(f"[crackio_bridge] voice check with {file} on {build}: {err}")
            tried.append({"build": build, "error": err})
            stop_server()
            chain = _candidates()
            more = build in chain and chain.index(build) + 1 < len(chain)
            if build and more and _BACKEND_FAULT.search(err) and not _NOT_BACKEND.search(err):
                with _check_lock:
                    _check.update(state="switching", build=build, tried=list(tried))
                if _install_engine(after=build):
                    continue
            with _check_lock:
                _check.update(state="error", error=err, tried=tried, finished=time.time())
            return


# ------------------------------------------------------------------ the server

_srv = {"proc": None, "port": None, "key": None, "log": None, "busy": 0, "last": 0.0, "watch": None}
_srv_lock = threading.RLock()
# The server unloads its models after IDLE_MS; this long without a job it stops altogether, so even its GPU context
# (about 600 MB) goes back to ComfyUI's other jobs. The next voice job starts it again in a second or two.
STOP_AFTER_S = int(os.environ.get("CRACKIO_VOICE_STOP_AFTER_S", "180"))


def _pid_file():
    return os.path.join(_engine_dir(), "server.pid")


def _ours(pid):
    """Whether a process is an audio.cpp server, so a process id reused by something else is never touched."""
    try:
        import psutil

        p = psutil.Process(pid)
        return "audiocpp_server" in " ".join(p.cmdline() or [p.name()])
    except Exception:
        return False


def _reap_orphan():
    """A server started by a ComfyUI that has since restarted is out of this bridge's reach, still holding GPU
    memory: the id it left behind finds it, and it stops."""
    try:
        with open(_pid_file()) as f:
            pid = int(f.read().strip() or 0)
    except (OSError, ValueError):
        return
    mine = _srv["proc"]
    if mine is not None and mine.pid == pid and mine.poll() is None:
        return
    if pid and _ours(pid):
        try:
            import psutil

            p = psutil.Process(pid)
            p.terminate()
            try:
                p.wait(10)
            except psutil.TimeoutExpired:
                p.kill()
            print(f"[crackio_bridge] stopped audio.cpp server {pid} left by an earlier ComfyUI")
        except Exception as e:
            print(f"[crackio_bridge] couldn't stop audio.cpp server {pid}: {e}")
    try:
        os.remove(_pid_file())
    except OSError:
        pass


def _idle_watch():
    """Stops the server once it has had no job for STOP_AFTER_S."""
    while True:
        time.sleep(15)
        with _srv_lock:
            if not _alive():
                _srv["watch"] = None
                return
            if _srv["busy"] == 0 and time.time() - _srv["last"] > STOP_AFTER_S:
                # Whatever crowded the card then has likely gone: the next start sizes Drama 3 afresh.
                _drama_extra["layers"] = 0
                stop_server()
                _srv["watch"] = None
                return


# How much of a voice sample Drama 3's codec reads at once (samples at 44.1 kHz, a multiple of 512: about 3 s).
ENCODE_CHUNK = 131072

# Each time Drama 3 still ran out of GPU memory (a failed allocation), this many more of its expert layers go to RAM, for
# as long as this ComfyUI runs.
_drama_extra = {"layers": 0}
MORE_CPU_LAYERS = 6


def _sharing_gb():
    """What shares the card with a voice model: speech to text and its aligner (loaded beside it, two models at a time),
    and LFM3 where it's installed (it writes Talk's answers in ComfyUI: about 4.2 GB on the 5090)."""
    asr = sum(os.path.getsize(p) for p in _gguf_files() if _family(os.path.basename(p))[0] in ("qwen3_asr", "qwen3_forced_aligner")) / 1e9
    lfm3 = 0.0
    try:
        if any(f.lower().endswith((".safetensors", ".gguf")) for f in folder_paths.get_filename_list("lfm3")):
            lfm3 = 4.5
    except Exception:
        pass
    return asr + lfm3


def _drama_cpu_layers(path):
    """How many of Drama 3's 40 expert layers stay in system RAM so the rest fits on the GPU beside what shares it."""
    forced = os.environ.get("CRACKIO_DRAMA3_CPU_EXPERT_LAYERS")
    if forced:
        return max(0, min(40, int(forced)))
    if platform.system() == "Darwin":
        # A Mac's GPU uses the same memory as its CPU: nothing to keep back.
        return 0
    gpu = _nvidia()
    if not gpu:
        return 40
    size = os.path.getsize(path) / 1e9
    # About 85% of the file is the routed experts, spread evenly over 40 layers; the rest stays on the GPU with the KV
    # cache and the codec's weights (~1.3 GB), and the codec's working memory must fit too: ~1 GB to write a sentence,
    # and as much to read a voice sample in chunks (ENCODE_CHUNK; whole, a 20 s sample took 2.4 GB). The 5090's "failed
    # to allocate Fish DAC codec decode graph" in Talk (2026-11-01) was Drama 3 all on the card with speech to text and
    # LFM3 beside it. A Windows desktop keeps ~1 GB of the card for itself.
    budget = gpu["total_mb"] / 1024 - 1.3 - 1.2 - 0.5 - _sharing_gb() - (1.0 if platform.system() == "Windows" else 0.0)
    per_layer = 0.85 * size / 40
    on_gpu = int((budget - 0.15 * size) / per_layer)
    return max(0, min(40, 40 - on_gpu + _drama_extra["layers"]))


def _entries():
    out = []
    for path in _gguf_files():
        name = os.path.basename(path)
        family, task, _ = _family(name)
        entry = {"id": _model_id(name), "family": family, "path": path.replace("\\", "/"), "task": task, "mode": "offline"}
        if family == "fish_drama3":
            entry["session_options"] = {
                "fish_drama3.cpu_expert_layers": _drama_cpu_layers(path),
                "fish_drama3.context_length": 4096,
                # The voice sample read a few seconds at a time: the same codes, without the whole-sample spike.
                "fish_drama3.codec_encoder_chunk_samples": ENCODE_CHUNK,
            }
            entry["default_request_options"] = {"max_tokens": 700}
        if family == "qwen3_asr":
            aligner = next((p for p in _gguf_files() if _family(os.path.basename(p))[0] == "qwen3_forced_aligner"), None)
            if aligner:
                entry["session_options"] = {"qwen3_asr.forced_aligner_path": aligner.replace("\\", "/")}
        out.append(entry)
    return out


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _alive():
    p = _srv["proc"]
    return p is not None and p.poll() is None


def stop_server():
    with _srv_lock:
        p = _srv["proc"]
        if p is not None and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                p.kill()
        _srv.update(proc=None, port=None, key=None)
        # And one an earlier ComfyUI left running, if any.
        _reap_orphan()


def _ensure_server():
    with _srv_lock:
        engine = _engine()
        if not engine:
            raise RuntimeError("audio.cpp isn't installed on this machine yet: install a voice model from Crackio's Voice tool.")
        entries = _entries()
        if not entries:
            raise RuntimeError(f"No voice models in {_models_dir()}.")
        if _backend(engine["build"]) == "cuda":
            # audio.cpp's CUDA preset for Drama 3: fused MoE, bucketed attention and sampling on the card (faster steps).
            for e in entries:
                if e["family"] == "fish_drama3":
                    e["session_options"]["fish_drama3.perf_mode"] = "cuda_perf"
        key = json.dumps([engine["server"], entries], sort_keys=True)
        if _alive() and _srv["key"] == key:
            return _srv["port"]
        stop_server()
        root = _engine_dir()
        port = _free_port()
        threads = max(2, min(16, (os.cpu_count() or 4) // 2 + 1))
        config = {
            "host": "127.0.0.1", "port": port, "backend": _backend(engine["build"]), "device": 0, "threads": threads,
            "lazy_load": True, "max_loaded_models": 2, "idle_unload_ms": IDLE_MS, "busy_timeout_ms": 900_000,
            "max_request_body_bytes": 268_435_456, "models": entries,
        }
        cfg = os.path.join(root, "server.json")
        with open(cfg, "w") as f:
            json.dump(config, f, indent=1)
        log = os.path.join(root, "server.log")
        logf = open(log, "ab")
        proc = subprocess.Popen([engine["server"], "--config", cfg, "--log"], cwd=engine["dir"], env=_engine_env(engine["dir"]), stdout=logf, stderr=subprocess.STDOUT, creationflags=_FLAGS)
        _srv.update(proc=proc, port=port, key=key, log=log, last=time.time())
        # Its id, for a restarted ComfyUI to find it (_reap_orphan).
        try:
            with open(_pid_file(), "w") as f:
                f.write(str(proc.pid))
        except OSError:
            pass
        if _srv["watch"] is None:
            _srv["watch"] = threading.Thread(target=_idle_watch, name="crackio-voice-idle", daemon=True)
            _srv["watch"].start()
        for _ in range(240):
            if proc.poll() is not None:
                raise RuntimeError(f"audio.cpp stopped as it started: {_tail(log)}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    if r.status == 200:
                        return port
            except (urllib.error.URLError, OSError):
                time.sleep(0.5)
        raise RuntimeError("audio.cpp didn't start within two minutes.")


def _tail(path, n=1200):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - n))
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""


def _post(route, body, timeout=1800):
    with _srv_lock:
        port = _ensure_server()
        _srv["busy"] += 1
    if isinstance(body, tuple):
        data, headers = body
    else:
        data, headers = json.dumps(body).encode(), {"Content-Type": "application/json"}
    req = urllib.request.Request(f"http://127.0.0.1:{port}{route}", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read(), res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        raise RuntimeError(f"audio.cpp: {detail or e.reason}") from None
    except OSError:
        # The server went down mid-request (it crashed loading or running a model): say what it said last.
        time.sleep(0.3)
        p = _srv["proc"]
        if p is not None and p.poll() is not None:
            raise RuntimeError(f"audio.cpp stopped ({_exit_reason(p.returncode)}): {_last_error(_srv['log'])}") from None
        raise
    finally:
        with _srv_lock:
            _srv["busy"] -= 1
            _srv["last"] = time.time()


def _last_error(log):
    """The lines of a server log that say what went wrong (CUDA's "no kernel image", a failed allocation…)."""
    tail = _tail(log, 6000) if log else ""
    lines = [x.strip() for x in tail.splitlines() if re.search(r"error|failed|abort|exception|not supported|out of memory", x, re.I)]
    return " · ".join(dict.fromkeys(lines[-3:]))[:400] or tail[-300:] or "no output"


def _multipart(fields, files):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (name, data) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


# ------------------------------------------------------------------ audio in and out


def wav_to_audio(data):
    """A WAV file (PCM 16/24/32 or float) as ComfyUI AUDIO."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise RuntimeError("audio.cpp didn't send audio: " + data[:300].decode("utf-8", "replace"))
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            tag, channels, rate, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            if tag == 0xFFFE and len(body) >= 26:
                tag = struct.unpack("<H", body[24:26])[0]
            fmt = (tag, channels, rate, bits)
        elif cid == b"data":
            pcm = body
        pos += 8 + size + (size & 1)
    if not fmt or pcm is None:
        raise RuntimeError("audio.cpp sent a WAV file without sound in it")
    tag, channels, rate, bits = fmt
    if bits == 16:
        x = np.frombuffer(pcm[: len(pcm) // 2 * 2], "<i2").astype(np.float32) / 32768.0
    elif bits == 24:
        raw = np.frombuffer(pcm[: len(pcm) // 3 * 3], np.uint8).reshape(-1, 3)
        x = (raw[:, 0].astype(np.int32) | (raw[:, 1].astype(np.int32) << 8) | (raw[:, 2].astype(np.int32) << 16))
        x = np.where(x >= 2**23, x - 2**24, x).astype(np.float32) / 2**23
    elif bits == 32 and tag == 3:
        x = np.frombuffer(pcm[: len(pcm) // 4 * 4], "<f4").astype(np.float32)
    elif bits == 32:
        x = np.frombuffer(pcm[: len(pcm) // 4 * 4], "<i4").astype(np.float32) / 2**31
    else:
        raise RuntimeError(f"unsupported WAV format ({bits}-bit)")
    x = x[: len(x) // channels * channels].reshape(-1, channels).T
    return {"waveform": torch.from_numpy(np.ascontiguousarray(x)).unsqueeze(0), "sample_rate": int(rate)}


def _resample(x, rate, to):
    """Mono samples at another rate."""
    if rate == to or len(x) == 0:
        return x
    g = math.gcd(rate, to)
    try:
        from scipy.signal import resample_poly

        return resample_poly(x, to // g, rate // g).astype(np.float32)
    except Exception:
        pass
    if to < rate:  # a low-pass first, so nothing above the new limit folds back in
        n = np.arange(-48, 49)
        h = np.sinc(2 * 0.45 * to / rate * n) * np.hamming(len(n))
        x = np.convolve(x, h / h.sum(), mode="same")
    t = np.arange(int(len(x) * to / rate)) * (rate / to)
    return np.interp(t, np.arange(len(x)), x).astype(np.float32)


def audio_to_wav(audio, rate=None):
    """ComfyUI AUDIO as a mono 16-bit WAV file's bytes, at its own rate or the one given."""
    w = audio["waveform"]
    x = w[0].detach().float().cpu().numpy()
    mono = x.mean(axis=0) if x.shape[0] > 1 else x[0]
    own = int(audio["sample_rate"])
    rate = int(rate or own)
    mono = _resample(mono, own, rate)
    pcm = (np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def _as_file(audio):
    """A voice reference as a WAV file the server can read, kept by its content so the same voice isn't written twice."""
    data = audio_to_wav(audio)
    folder = os.path.join(_engine_dir(), "refs")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, hashlib.sha1(data).hexdigest()[:20] + ".wav")
    if not os.path.exists(path):
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
    return path.replace("\\", "/")


def comfy_step_aside(need_mb=None, wait=8.0):
    """ComfyUI's loaded models step aside for an engine outside it (they load again when next needed).

    ComfyUI's model management isn't thread-safe: unloading from a route's thread while the prompt worker starts a job
    killed the worker once (cleanup_models_gc → is_dead on a model being swapped out). So inside the prompt worker (a
    node) it's done there and then. From any other thread (Talk's /crackio/voice/say, a setup check) the worker is
    asked to, through the queue's unload flag as ComfyUI's own POST /free does, and this waits a few seconds for the
    memory (`need_mb` free). A job running meanwhile keeps its models until it ends.
    """
    import comfy.model_management as mm

    if "prompt_worker" in threading.current_thread().name:
        mm.unload_all_models()
        mm.soft_empty_cache()
        return
    from server import PromptServer

    PromptServer.instance.prompt_queue.set_flag("unload_models", True)
    end = time.time() + wait
    while time.time() < end:
        time.sleep(0.4)
        if need_mb is None:
            return
        gpu = _nvidia()
        if not gpu or gpu["free_mb"] >= need_mb:
            return


def _make_room(path):
    """Big models need the GPU to themselves: ComfyUI's loaded models step aside (they load again when next needed)."""
    gpu = _nvidia()
    if not gpu:
        return
    need = os.path.getsize(path) / 2**20 * 0.95
    if gpu["free_mb"] >= need + 1500:
        return
    try:
        comfy_step_aside(need + 1500)
    except Exception:
        pass


def speak(model, text, voices=(), voice="", seed=0, temperature=0.0, speed=1.0, options=None, ref_path=None, ref_text=""):
    """`ref_path` (with `ref_text`, what it says): a voice reference already on disk, for a live conversation that
    speaks sentence by sentence in the same voice (no copy written per sentence)."""
    path = next((p for p in _gguf_files() if os.path.basename(p) == model), None)
    if not path:
        raise RuntimeError(f"{model} isn't in {_models_dir()}.")
    family = _family(model)[0]
    if family in ("fish_drama3", "voxcpm2"):
        _make_room(path)
    if ref_path:
        voices = ()
    body = {"model": _model_id(model), "input": text}
    if ref_path:
        body["voice_ref"] = {"type": "path", "path": str(ref_path).replace("\\", "/")}
        if ref_text:
            body["reference_text"] = ref_text
            if family == "voxcpm2":
                body.setdefault("options", {})["ultimate_clone"] = True
    opts = dict(options or {})
    if voice:
        body["voice"] = voice
    if seed:
        body["seed"] = str(int(seed))
    if temperature and temperature > 0:
        opts["temperature"] = float(temperature)
    if speed and abs(speed - 1.0) > 1e-3:
        body["speed"] = float(speed)
    refs = [v for v in voices if v and v.get("audio") is not None]
    if family == "fish_drama3" and len(refs) > 1:
        # A scene: one reference per speaker, in the order of <|speaker:N|> in the words.
        opts["references"] = json.dumps([{"text": f"<|speaker:{i}|> {r.get('text') or ''}".strip(), "audio_path": _as_file(r["audio"])} for i, r in enumerate(refs)])
    elif refs:
        body["voice_ref"] = {"type": "path", "path": _as_file(refs[0]["audio"])}
        if refs[0].get("text"):
            body["reference_text"] = refs[0]["text"]
            if family == "voxcpm2":
                opts["ultimate_clone"] = True
    if opts:
        body["options"] = opts
    try:
        data, _ = _post("/v1/audio/speech", body)
    except RuntimeError as e:
        if family != "fish_drama3" or "failed to allocate" not in str(e) or _drama_extra["layers"] >= 40:
            raise
        # The card still ran out (something else took memory since it loaded): a few more expert layers go to RAM (the
        # server restarts with them, its config having changed) and it's said once more.
        _drama_extra["layers"] += MORE_CPU_LAYERS
        print(f"[crackio voice] Drama 3 ran out of GPU memory: {_drama_cpu_layers(path)} expert layers in RAM from now on")
        data, _ = _post("/v1/audio/speech", body)
    return wav_to_audio(data)


def transcribe(audio, text="", language=""):
    """What's said and when: the words given aligned to the audio, else heard by Qwen3-ASR (with times when the aligner
    is installed). Returns (text, [{word, start, end}])."""
    files = _gguf_files()
    asr = next((p for p in files if _family(os.path.basename(p))[0] == "qwen3_asr"), None)
    aligner = next((p for p in files if _family(os.path.basename(p))[0] == "qwen3_forced_aligner"), None)
    lang = LANGUAGES.get((language or "").lower()[:2], language or "")
    # At 16 kHz: both models hear at that rate, and audio.cpp (0.9.3) turns their 16 kHz sample times into seconds at
    # the file's own rate, so a 44.1 kHz take came back with every word 2.76 times too early.
    wav = audio_to_wav(audio, 16000)
    if text.strip() and aligner:
        data, _ = _post("/v1/audio/alignments", _multipart(
            {"model": _model_id(os.path.basename(aligner)), "language": lang or "English", "text": text}, {"file": ("take.wav", wav)}))
        res = json.loads(data)
        return text, _words(res)
    if not asr:
        raise RuntimeError("Speech to text needs Qwen3-ASR: install it from Crackio's Voice tool.")
    fields = {"model": _model_id(os.path.basename(asr))}
    if lang:
        fields["language"] = lang
    if aligner:
        fields["options"] = json.dumps({"return_timestamps": True})
    data, _ = _post("/v1/audio/transcriptions/details", _multipart(fields, {"file": ("speech.wav", wav)}))
    res = json.loads(data)
    return str(res.get("text", "")).strip(), _words(res)


def _words(res):
    rate = float(res.get("sample_rate") or 0) or None
    out = []
    for w in res.get("words") or []:
        word = w.get("word") or w.get("text") or ""
        if "start" in w and "end" in w:
            s, e = float(w["start"]), float(w["end"])
        elif rate and "start_sample" in w:
            s, e = w["start_sample"] / rate, w["end_sample"] / rate
        else:
            continue
        out.append({"word": word, "start": round(s, 3), "end": round(e, 3)})
    return out


# ------------------------------------------------------------------ nodes


class CrackioVoice:
    """Speak the words with an open model on this machine (audio.cpp). Voices: up to four references, each a clip of
    someone talking and what they say. With one, the model speaks in that voice; with Drama 3 and more than one, the
    words mark who speaks with <|speaker:0|>, <|speaker:1|>…"""

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for k in range(1, 5):
            optional[f"voice_{k}"] = ("AUDIO", {"tooltip": "A clip of the voice to speak with (5–30 s of one person, clean)."})
            optional[f"voice_{k}_text"] = ("STRING", {"multiline": True, "default": "", "tooltip": "Exactly what the clip says."})
        return {
            "required": {
                "model": (_speech_models() or ["(install a voice model)"],),
                "text": ("STRING", {"multiline": True, "default": "[warm, a little tired] Okay. Last call before we close the doors tonight."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFF, "tooltip": "0: a new take every time."}),
                "temperature": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "0: the model's own setting."}),
                "speed": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.05, "tooltip": "For models that take a speed (Supertonic)."}),
                "preset": ("STRING", {"default": "", "tooltip": "A model's own built-in voice (Supertonic: F1–F5, M1–M5)."}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "Crackio"

    def run(self, model, text, seed, temperature, speed, preset, **voices):
        refs = [{"audio": voices.get(f"voice_{k}"), "text": voices.get(f"voice_{k}_text", "")} for k in range(1, 5)]
        return (speak(model, text, refs, preset, seed, temperature, speed),)


class CrackioTranscribe:
    """What's said in a clip and when each word starts: the words you give are aligned to it (Qwen3 Forced Aligner), or
    it's heard from scratch (Qwen3-ASR)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"audio": ("AUDIO",)},
            "optional": {
                "text": ("STRING", {"multiline": True, "default": "", "tooltip": "The words, when you know them: only their timing is found."}),
                "language": ("STRING", {"default": "", "tooltip": "en, pl, it… or empty to let it hear the language."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "words")
    FUNCTION = "run"
    CATEGORY = "Crackio"

    def run(self, audio, text="", language=""):
        said, words = transcribe(audio, text, language)
        return (said, json.dumps(words))


class CrackioSaveText:
    """Keep text (a transcript, word times) as a file in ComfyUI's output folder, next to the audio it belongs to."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"forceInput": True}), "filename_prefix": ("STRING", {"default": "crackio/words"})}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Crackio"

    def save(self, text, filename_prefix):
        out = folder_paths.get_output_directory()
        folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, out)
        filename = f"{name}_{counter:05}_.json"
        with open(os.path.join(folder, filename), "w", encoding="utf-8") as f:
            f.write(text)
        return {"ui": {"text": [{"filename": filename, "subfolder": subfolder, "type": "output"}]}}


NODE_CLASS_MAPPINGS = {"CrackioVoice": CrackioVoice, "CrackioTranscribe": CrackioTranscribe, "CrackioSaveText": CrackioSaveText}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioVoice": "Crackio Voice (audio.cpp)", "CrackioTranscribe": "Crackio Transcribe (audio.cpp)", "CrackioSaveText": "Crackio Save Text"}


# ------------------------------------------------------------------ routes


@PromptServer.instance.routes.get("/crackio/voice")
async def voice_status(request):
    engine = _engine()
    with _install_lock:
        install = dict(_install)
    try:
        disk = shutil.disk_usage(_models_dir()).free
    except OSError:
        disk = None
    try:
        import psutil

        ram = psutil.virtual_memory().available
    except Exception:
        ram = None
    return web.json_response({
        "folder": _models_dir(),
        "disk_free": disk,
        "ram_free": ram,
        "engine": engine,
        "build": _build(),
        "builds": _candidates(),
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "install": install,
        "check": dict(_check),
        "server": {"running": _alive(), "port": _srv["port"]},
        "models": [{"file": os.path.basename(p), "family": _family(os.path.basename(p))[0], "kind": _family(os.path.basename(p))[2], "bytes": os.path.getsize(p)} for p in _gguf_files()],
    })


@PromptServer.instance.routes.post("/crackio/voice/engine")
async def voice_engine(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    asked = body.get("build")
    build = str(asked or _build() or "")
    if not build:
        return web.json_response({"error": f"audio.cpp has no build for {platform.system()} on {platform.machine()}."}, status=409)
    if not re.fullmatch(r"(windows|ubuntu|macos)-[a-z0-9.\-]+", build):
        return web.json_response({"error": "Unknown build."}, status=400)
    engine = _engine()
    # One that's here and of this release stays, whichever build it is (it may be the one that worked after the first
    # choice didn't), unless another build is asked for by name or a reinstall forced.
    if engine and engine.get("tag") == TAG and not body.get("force") and (not asked or engine.get("build") == build):
        return web.json_response({"state": "done", "engine": engine})
    with _install_lock:
        if _install["state"] in ("downloading", "unpacking", "checking"):
            return web.json_response(dict(_install))
        _install.update(state="downloading", received=0, total=0, error=None, build=build, tried=[], started=time.time())
    stop_server()
    threading.Thread(target=_install_engine, args=(build,), daemon=True).start()
    return web.json_response(dict(_install))


@PromptServer.instance.routes.post("/crackio/voice/check")
async def voice_check(request):
    """{model?} speak a test line with that model (else the smallest speech model here) and hear it back: the proof
    that Voice works on this machine. A GPU backend that fails moves on to the next build. Poll GET /crackio/voice."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    folder = _models_dir()
    speech = sorted(_speech_models(), key=lambda f: os.path.getsize(os.path.join(folder, f)) if os.path.exists(os.path.join(folder, f)) else 0)
    file = str(body.get("model") or (speech[0] if speech else ""))
    if not file or file not in speech:
        return web.json_response({"error": "No voice model here to check with."}, status=409)
    with _check_lock:
        if _check["state"] in ("running", "switching"):
            return web.json_response(dict(_check))
        _check.update(state="running", model=file, error=None, seconds=None, heard=None, tried=[], started=time.time())
    threading.Thread(target=_run_check, args=(file,), daemon=True, name="crackio-voice-check").start()
    return web.json_response(dict(_check))


@PromptServer.instance.routes.post("/crackio/voice/stop")
async def voice_stop(request):
    stop_server()
    return web.json_response({"stopped": True})


# ------------------------------------------------------------------ a live conversation (Voice's Talk)
# Outside ComfyUI's prompt queue, like /crackio/lfm3: what someone said, heard; one sentence of the answer, spoken. A
# running render doesn't hold either up.


def _input_file(name):
    """A file uploaded to ComfyUI's input folder (a voice's reference), by the name the upload gave it; None otherwise."""
    name = str(name or "").replace("\\", "/")
    if not name or name.startswith("/") or ".." in name.split("/"):
        return None
    path = os.path.join(folder_paths.get_input_directory(), *name.split("/"))
    return path if os.path.isfile(path) else None


def hear(wav, language=""):
    """What's said in a WAV (any rate): Qwen3-ASR, plain text (no word times: a conversation only needs the words)."""
    asr = next((p for p in _gguf_files() if _family(os.path.basename(p))[0] == "qwen3_asr"), None)
    if not asr:
        raise RuntimeError("Speech to text needs Qwen3-ASR: install it from Crackio's Voice tool.")
    fields = {"model": _model_id(os.path.basename(asr))}
    lang = LANGUAGES.get((language or "").lower()[:2], language or "")
    if lang:
        fields["language"] = lang
    data, _ = _post("/v1/audio/transcriptions/details", _multipart(fields, {"file": ("speech.wav", audio_to_wav(wav_to_audio(wav), 16000))}), timeout=120)
    try:
        return str(json.loads(data).get("text", "")).strip()
    except ValueError:
        return data.decode("utf-8", "replace").strip()


@PromptServer.instance.routes.post("/crackio/voice/hear")
async def voice_hear(request):
    """{audio: base64 WAV, language?} -> {text, ms}: what someone just said."""
    try:
        body = await request.json()
        wav = base64.b64decode(body.get("audio") or "")
        if len(wav) < 64:
            return web.json_response({"error": "No audio."}, status=400)
        t0 = time.time()
        text = await asyncio.to_thread(hear, wav, str(body.get("language") or ""))
        return web.json_response({"text": text, "ms": round((time.time() - t0) * 1000)})
    except Exception as e:
        return web.json_response({"error": str(e)[:400]}, status=500)


@PromptServer.instance.routes.post("/crackio/voice/say")
async def voice_say(request):
    """{model, text, ref?: an input file (the voice), ref_text?, preset?, seed?, temperature?, speed?} -> audio/wav: one
    sentence of an answer, in that voice. X-Crackio-Ms says how long it took."""
    try:
        body = await request.json()
        text = str(body.get("text") or "").strip()
        model = str(body.get("model") or "")
        if not text or not model:
            return web.json_response({"error": "Say what, with which model?"}, status=400)
        ref = _input_file(body.get("ref")) if body.get("ref") else None
        if body.get("ref") and not ref:
            return web.json_response({"error": "That voice's reference isn't on this machine."}, status=404)
        t0 = time.time()
        audio = await asyncio.to_thread(
            speak, model, text, (), str(body.get("preset") or ""), int(body.get("seed") or 0), float(body.get("temperature") or 0.0), float(body.get("speed") or 1.0), None, ref, str(body.get("ref_text") or "")
        )
        wav = audio_to_wav(audio)
        return web.Response(body=wav, content_type="audio/wav", headers={"X-Crackio-Ms": str(round((time.time() - t0) * 1000))})
    except Exception as e:
        return web.json_response({"error": str(e)[:400]}, status=500)


# A server an earlier ComfyUI left running (it restarted while the server sat idle) stops as this one loads.
try:
    _reap_orphan()
except Exception as e:  # never in the way of the bridge loading
    print(f"[crackio_bridge] voice: {e}")
