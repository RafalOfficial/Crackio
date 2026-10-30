"""
Crackio on Macs (Apple Silicon, PyTorch's MPS backend). One node, Crackio Mac Tuning, that Crackio puts after every
diffusion model it loads on a Mac, and an idle-memory watch. Nothing here changes anything off Macs.

Precision. ComfyUI computes in bf16 on every Mac with macOS 14 or newer, but M1 and M2 GPUs have no bf16 math and run it
at about half speed: an M2 multiplies 2048x3072 by 3072x6144 at 2.6 TFLOPS in fp16, 2.4 in fp32 and 1.4 in bf16. The node
times the three on the Mac it runs on (once, under a second) and computes the model in the fastest precision the model
is made for, from ComfyUI's own list for each model: FLUX.2, Krea 2, Chroma, Wan and SDXL take fp16; Z-Image, Qwen-Image,
FLUX 3 and LTX don't. FLUX.2 klein 4B GGUF Q8 at 1 MP on a MacBook Air M2 went from 28 to 17 s a step, with the same
picture quality (Oct 2026). ComfyUI's choice stands unless another precision is 15% faster, so M5 chips (bf16 as fast as
fp16) are left alone. fp32 is only used for pictures, and only on Macs with 32 GB or more: its activations are twice the
size, and Apple's fused attention kernel takes only fp16 and bf16, so fp32 attention over a clip's tokens would need
memory for every pair of them.

Cooling. A job keeps the Mac's GPU at full power for minutes, and a MacBook Air has no fan: its case is its heatsink,
and after 30 minutes of pictures it was too hot to touch. Heat also ages a lithium battery faster. Before each step the
node reads macOS's own thermal state (NSProcessInfo, no admin rights needed) and the battery's temperature (ioreg):
- hot (macOS says serious or critical, or the battery is at 40 °C on a MacBook Air, 45 °C on a Mac with fans): it waits
  until the Mac is back to fair and the battery 3 °C cooler, up to 3 min at a time;
- warm (fair) after 3 minutes of work without a break, in `cool` (the default on a MacBook Air): it rests a third as
  long as the last step took, which cuts the average heat by about a quarter. A picture or two runs at full speed (the
  case soaks up a burst); long clips and batches are paced;
- unplugged with 10% left: it stops the job and asks for the charger, rather than drain the battery flat.
Crackio's progress line says so while it waits. `balanced` (the default on Macs with fans) only waits when hot; `off`
never waits. The time a job takes includes the rests, so Crackio's estimates for this Mac learn them. The Local page
also shows macOS's energy mode: Low Power Mode slows jobs, and High Power Mode (MacBook Pros with a Max chip) keeps a
long one at full speed.

Awake. A job keeps the GPU busy but doesn't stop macOS from idle-sleeping, which stalls a 20-minute clip halfway
until someone wakes the Mac. While jobs run (and 30 s after), the bridge holds `caffeinate -i`, which keeps the
system awake while the display may still sleep. It is tied to ComfyUI's process, so it can't outlive it.

Idle memory. A Mac's GPU memory is its RAM, and ComfyUI keeps the last job's models in it (7.5 GB for FLUX.2 klein on a
16 GB Mac), which pushes the user's other apps into swap. On Macs with 24 GB or less the bridge has ComfyUI let them go
after CRACKIO_IDLE_UNLOAD seconds without a job (300 by default; 0 turns it off), between jobs only, as POST /free does.
The next job loads them again, about 12 s for klein from the SSD.
"""
import ctypes
import ctypes.util
import logging
import os
import re
import subprocess
import threading
import time

import torch

from . import pool

log = logging.getLogger("crackio")

GB = 1024**3
NAMES = {torch.float16: "fp16", torch.bfloat16: "bf16", torch.float32: "fp32"}
THERMAL = ("nominal", "fair", "serious", "critical")
# The battery's temperature that counts as hot: a MacBook Air's battery sits under its chip; a MacBook Pro's fans keep
# its battery cooler, and one charging under a long job can sit near 40 °C without harm.
HOT_BATTERY = {"cool": 40.0, "balanced": 45.0}
COOLED = 3.0
LOW_BATTERY = 10
REST_SHARE = 1 / 3
LONGEST_WAIT = 180
# Minutes of GPU work without a break before warm steps rest, and the gap that counts as a break.
SUSTAINED = 180
BREAK = 60


def on_mac():
    import comfy.model_management as mm

    return mm.get_torch_device().type == "mps"


def _ram_gb():
    import psutil

    return psutil.virtual_memory().total / GB


# ------------------------------------------------------------------ precision


def precisions():
    """TFLOPS of a block-sized multiply in each precision on this Mac; None elsewhere."""
    if not on_mac():
        return None
    import comfy.model_management as mm

    device = mm.get_torch_device()
    return {NAMES[d]: round(pool._matmul_tflops(device, d), 2) for d in NAMES}


def fastest(supported, current, ram_gb=None, picture=True):
    """The precision to compute a model in on this Mac, among those it's made for; None to keep ComfyUI's (`current`)."""
    speed = precisions()
    options = [d for d in supported if d in NAMES]
    if not speed or current not in NAMES or not options:
        return None
    pick = max(options, key=lambda d: speed[NAMES[d]])
    if pick == torch.float32 and not (picture and (ram_gb if ram_gb is not None else _ram_gb()) >= 32):
        rest = [d for d in options if d != torch.float32]
        pick = max(rest, key=lambda d: speed[NAMES[d]]) if rest else None
    if pick is None or pick == current or speed[NAMES[pick]] < 1.15 * speed[NAMES[current]]:
        return None
    return pick


# ------------------------------------------------------------------ heat and battery

_objc = {}


def thermal_state():
    """macOS's thermal state (NSProcessInfo.thermalState): 0 nominal, 1 fair, 2 serious, 3 critical; None if unreadable."""
    try:
        if not _objc:
            objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))
            ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Foundation.framework/Foundation")
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.objc_getClass.argtypes = [ctypes.c_char_p]
            objc.sel_registerName.restype = ctypes.c_void_p
            objc.sel_registerName.argtypes = [ctypes.c_char_p]
            send_id = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)(("objc_msgSend", objc))
            _objc["state"] = ctypes.CFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(("objc_msgSend", objc))
            _objc["info"] = send_id(objc.objc_getClass(b"NSProcessInfo"), objc.sel_registerName(b"processInfo"))
            _objc["sel"] = objc.sel_registerName(b"thermalState")
        return int(_objc["state"](_objc["info"], _objc["sel"]))
    except Exception:  # noqa: BLE001
        return None


_battery = {"at": 0.0, "data": None, "none": False}


def battery():
    """The battery's temperature (°C), charge (%) and whether the charger is in; None on a Mac without one. Read at most
    every 15 s (a Mac Studio or mini is asked once)."""
    if _battery["none"] or time.time() - _battery["at"] < 15:
        return _battery["data"]
    data = None
    try:
        out = subprocess.run(["ioreg", "-rn", "AppleSmartBattery"], capture_output=True, text=True, timeout=5).stdout
        temp = re.search(r'"Temperature" = (\d+)', out)
        charge = re.search(r'"CurrentCapacity" = (\d+)', out)
        if temp:
            data = {"temp": int(temp.group(1)) / 100, "percent": int(charge.group(1)) if charge else None, "plugged": '"ExternalConnected" = Yes' in out}
    except Exception:  # noqa: BLE001
        pass
    _battery.update(at=time.time(), data=data, none=data is None and _battery["at"] == 0.0)
    return data


_power = {"at": 0.0, "data": None}


def power():
    """macOS's energy mode: Low Power Mode on or off, and on MacBook Pros with a Max chip (and other Macs that have it) the
    mode itself, automatic / low / high (pmset). Read at most every minute."""
    if time.time() - _power["at"] < 60:
        return _power["data"]
    data = None
    try:
        out = subprocess.run(["pmset", "-g"], capture_output=True, text=True, timeout=5).stdout
        low = re.search(r"^\s*lowpowermode\s+(\d)", out, re.M)
        mode = re.search(r"^\s*powermode\s+(\d)", out, re.M)
        data = {"low": bool(low and low.group(1) == "1"), "mode": {"0": "automatic", "1": "low", "2": "high"}.get(mode.group(1)) if mode else None}
    except Exception:  # noqa: BLE001
        pass
    _power.update(at=time.time(), data=data)
    return data


_cores = []


def gpu_cores(wait=True):
    """The GPU's core count (system_profiler), or None. `wait=False` (in a route) answers only once it's known."""
    if not _cores and not wait:
        return None
    if not _cores:
        try:
            out = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True, timeout=20).stdout
            m = re.search(r"Total Number of Cores:\s*(\d+)", out)
            _cores.append(int(m.group(1)) if m else None)
        except Exception:  # noqa: BLE001
            _cores.append(None)
    return _cores[0]


_fanless = []


def fanless(wait=True):
    """A MacBook Air: no fan, so its case is its heatsink. `wait=False` (in a route) answers only once it's known."""
    if not _fanless and not wait:
        return None
    if not _fanless:
        try:
            out = subprocess.run(["system_profiler", "SPHardwareDataType"], capture_output=True, text=True, timeout=20).stdout
            _fanless.append("MacBook Air" in out)
        except Exception:  # noqa: BLE001
            _fanless.append(False)
    return _fanless[0]


def health():
    """What the cooling reads, for Crackio's Local page (/crackio/info)."""
    state = thermal_state()
    return {"thermal": THERMAL[state] if state is not None and 0 <= state < 4 else None, "battery": battery(), "fanless": fanless(wait=False), "power": power()}


def _say(text):
    """A line for Crackio's progress bar on the job running now."""
    try:
        from server import PromptServer

        s = PromptServer.instance
        # Crackio queues without a client id, so its jobs' messages go to every socket (as their progress does).
        s.send_sync("crackio.status", {"prompt_id": getattr(s, "last_prompt_id", None), "text": text}, s.client_id)
    except Exception:  # noqa: BLE001
        pass


def _rest(seconds):
    """Sleeps, a moment at a time, so a cancelled job stops at once."""
    import comfy.model_management as mm

    until = time.time() + seconds
    while time.time() < until:
        mm.throw_exception_if_processing_interrupted()
        time.sleep(min(1.0, max(0.0, until - time.time())))


def _hot(battery_limit):
    state = thermal_state() or 0
    temp = (battery() or {}).get("temp") or 0
    return state >= 2 or temp >= battery_limit


def before_step(mode, last_step, sustained=0.0):
    """Waits while this Mac is hot, rests after a warm step in `cool` mode once it has worked `SUSTAINED` seconds without a
    break, stops on a nearly flat battery. Seconds waited."""
    if mode == "off":
        return 0.0
    b = battery()
    if b and not b["plugged"] and b["percent"] is not None and b["percent"] <= LOW_BATTERY:
        raise RuntimeError(f"Your Mac's battery is at {b['percent']}%: plug in the charger, then run this again.")
    start = time.time()
    limit = HOT_BATTERY.get(mode, HOT_BATTERY["balanced"])
    if _hot(limit):
        _say("Letting your Mac cool down")
        log.info(f"[crackio] the Mac is hot ({health()}): waiting before the next step")
        while time.time() - start < LONGEST_WAIT and _hot(limit - COOLED):
            _rest(2)
    elif mode == "cool" and last_step and sustained >= SUSTAINED and thermal_state() == 1:
        _say("Resting a moment: your Mac is warm")
        _rest(min(30.0, last_step * REST_SHARE))
    return time.time() - start


_busy = {"since": 0.0, "at": None, "step": 0.0}


def _job():
    try:
        from server import PromptServer

        return getattr(PromptServer.instance, "last_prompt_id", None)
    except Exception:  # noqa: BLE001
        return None


def _cooling(mode):
    """An apply-model wrapper that calls `before_step` before every step. It first waits for the GPU to finish the last
    step (PyTorch queues Metal work and runs ahead): only then is a rest an idle GPU, and a step's time is the time from
    one call to the next within a job, less the rest taken."""
    last = {"job": None, "at": None, "rested": 0.0}

    def wrapper(executor, *args, **kwargs):
        torch.mps.synchronize()
        now, job = time.time(), _job()
        step = now - last["at"] - last["rested"] if last["at"] is not None and last["job"] == job else None
        step = step if step and step < 600 else None
        # How long the GPU has worked without a break, across jobs: a queue of pictures is one long job to the case, and
        # the reading and decoding between pictures are work too. A break is idle time past a step and BREAK.
        if _busy["at"] is None or now - _busy["at"] > _busy["step"] + BREAK:
            _busy["since"] = now
        rested = before_step(mode, step, now - _busy["since"])
        _busy.update(at=time.time(), step=step or _busy["step"])
        last.update(job=job, at=now, rested=rested)
        return executor(*args, **kwargs)

    return wrapper


# ------------------------------------------------------------------ the node


class CrackioMacTuning:
    """On a Mac: computes the model in the precision this chip runs fastest among those the model is made for (fp16 on M1
    and M2 for FLUX.2, Wan, Krea 2, SDXL...), and rests between steps while the Mac is hot. Elsewhere it changes nothing."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {"model": ("MODEL",)},
            "optional": {
                "cooling": (["auto", "cool", "balanced", "off"], {"default": "auto", "tooltip": "auto: cool on a MacBook Air (no fan), balanced on Macs with fans. cool also rests after warm steps; balanced only waits when macOS says the Mac is hot."}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Crackio"
    TITLE = "Crackio Mac Tuning"

    def patch(self, model, cooling="auto"):
        if not on_mac():
            return (model,)
        import comfy.patcher_extension as pe

        base = model.model
        supported = getattr(getattr(base, "model_config", None), "supported_inference_dtypes", None) or []
        current = model.object_patches.get("manual_cast_dtype") or base.get_dtype_inference()
        # Pictures have 2D latents; clips (Wan, LTX, Hunyuan) 3D.
        picture = getattr(getattr(base, "latent_format", None), "latent_dimensions", 2) == 2
        best = fastest(supported, current, picture=picture)
        mode = ("cool" if fanless() else "balanced") if cooling == "auto" else cooling
        model = model.clone()
        if best is not None:
            model.set_model_compute_dtype(best)
            log.info(f"[crackio] {type(base).__name__} computes in {NAMES[best]} on this Mac (was {NAMES.get(current, current)}; TFLOPS {precisions()})")
        if mode != "off":
            model.add_wrapper_with_key(pe.WrappersMP.APPLY_MODEL, "crackio_mac_cooling", _cooling(mode))
        return (model,)


# ------------------------------------------------------------------ between jobs: awake, idle memory

AWAKE_AFTER = 30
_awake = {"proc": None}


def _keep_awake(on):
    """`caffeinate -i` while jobs run, gone when they're done; `-w` ends it with ComfyUI's process."""
    p = _awake["proc"]
    running = p is not None and p.poll() is None
    if on and not running:
        try:
            _awake["proc"] = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:  # noqa: BLE001
            _awake["proc"] = None
    elif not on and running:
        p.terminate()
        _awake["proc"] = None


def _watch(unload_after):
    """Every few seconds: keeps the Mac awake while jobs run, and lets ComfyUI's models go after `unload_after` seconds
    without a job, once per quiet spell (0: never)."""
    import comfy.model_management as mm
    from server import PromptServer

    quiet_since, freed = time.time(), True
    while True:
        time.sleep(5)
        try:
            q = PromptServer.instance.prompt_queue
            if q.get_tasks_remaining() > 0:
                quiet_since, freed = time.time(), False
                _keep_awake(True)
                continue
            quiet = time.time() - quiet_since
            if quiet >= AWAKE_AFTER:
                _keep_awake(False)
            # Once per quiet spell. ComfyUI's list of loaded models can already be empty while its node cache still holds
            # their weights, so the cache is what gets cleared.
            if unload_after and not freed and quiet >= unload_after:
                # The prompt worker clears its cache between jobs, which drops the models (ComfyUI holds loaded models
                # only by weak reference). Unloading them first would copy each to the CPU side of the same RAM.
                q.set_flag("unload_models", False)
                q.set_flag("free_memory", True)
                log.info(f"[crackio] idle for {unload_after} s: freeing ComfyUI's models from unified memory")
                freed = True
        except Exception as e:  # noqa: BLE001
            log.debug(f"[crackio] between jobs: {e}")


def start():
    """What runs on Macs by itself: the watch between jobs, and reading the hardware once (system_profiler takes a moment)."""
    try:
        if not on_mac():
            return
        threading.Thread(target=lambda: (fanless(), gpu_cores(), power()), daemon=True, name="crackio-mac-model").start()
        seconds = int(os.environ.get("CRACKIO_IDLE_UNLOAD", "300"))
        unload_after = seconds if seconds > 0 and _ram_gb() <= 24.5 else 0
        threading.Thread(target=_watch, args=(unload_after,), daemon=True, name="crackio-mac-watch").start()
    except Exception as e:  # noqa: BLE001
        log.warning(f"[crackio] Mac settings didn't start: {e}")


NODE_CLASS_MAPPINGS = {"CrackioMacTuning": CrackioMacTuning}
NODE_DISPLAY_NAME_MAPPINGS = {"CrackioMacTuning": "Crackio Mac Tuning"}
