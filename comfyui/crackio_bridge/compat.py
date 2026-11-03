"""
Gaps in the Python ComfyUI runs on, filled before any job does.

os.memfd_create: ComfyUI 0.43's memory manager (comfy-aimdo) keeps the writable copy of a model it patches in place in
an anonymous file from os.memfd_create (comfy/anonymous_file.py), and Qwen-Image 2.1 models always take that path. A
Python built against an old glibc leaves os.memfd_create out even where the system's glibc has it (conda's builds, as
on vast.ai's ComfyUI image: Python 3.12.15, glibc 2.39), and every Qwen-Image 2.1 job then stopped in the sampler with
"module 'os' has no attribute 'memfd_create'". It is taken from libc here, with the flags Python names it with.

comfy-kitchen's INT8 and Sol attention: ComfyUI turns comfy-kitchen's CUDA backend off under a PyTorch older than cu130
(comfy/quant_ops.py), but a model whose file asks for "comfy_kitchen_int8" attention (FLUX 3 Klein INT8 does) still
calls its CUDA kernels straight away, and they're built for CUDA 13: on a vast.ai RTX 4060 Ti with a CUDA 12.7 driver
(565.57, so PyTorch cu126) every picture stopped in the KSampler with "detect_k_anchor kernel launch failed: CUDA driver
version is insufficient for CUDA runtime version". Below cu130 they say they aren't available here, as ComfyUI means
them to be, and those models take ComfyUI's usual attention.
"""
import ctypes
import os
import sys


def _add_memfd_create():
    if not sys.platform.startswith("linux") or hasattr(os, "memfd_create"):
        return
    try:
        call = ctypes.CDLL(None, use_errno=True).memfd_create
    except (OSError, AttributeError):  # a libc without it (glibc before 2.27): nothing to offer
        return
    call.argtypes = [ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int

    def memfd_create(name, flags=1):
        fd = call(os.fsencode(name), flags)
        if fd < 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        return fd

    os.memfd_create = memfd_create
    for flag, value in (("MFD_CLOEXEC", 1), ("MFD_ALLOW_SEALING", 2)):
        if not hasattr(os, flag):
            setattr(os, flag, value)
    print("[crackio_bridge] os.memfd_create taken from libc (this Python was built without it)")


def _guard_kitchen_attention():
    try:
        import torch
        import comfy_kitchen
    except Exception:  # no comfy-kitchen (older ComfyUI) or no torch: nothing calls it
        return
    cuda = torch.version.cuda
    try:
        if cuda is None or tuple(int(x) for x in cuda.split(".")[:2]) >= (13, 0):
            return
    except ValueError:
        return
    off = []
    for name in ("int8_attention_is_available", "sol_attn_is_available"):
        if callable(getattr(comfy_kitchen, name, None)):
            setattr(comfy_kitchen, name, lambda *args, **kwargs: False)
            off.append(name.split("_attn")[0].split("_attention")[0])
    try:
        from comfy.ldm.modules import attention

        attention.COMFY_KITCHEN_INT8_ATTENTION_IS_AVAILABLE = False
    except Exception:
        pass
    if off:
        print(f"[crackio_bridge] comfy-kitchen {' and '.join(off)} attention off: PyTorch is cu{cuda}, its kernels need cu130")


_add_memfd_create()
_guard_kitchen_attention()
