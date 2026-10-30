"""
Crackio nodes for small GPUs: SCAIL-2 character swaps (a Wan 2.1 14B model) on a 6 GB card.

Crackio Window Attention. A Wan video model attends every token of a clip to every other one. At SCAIL-2's sizes that
is 30,000 to 100,000 tokens (the reference picture, 21 latent frames of video, and the pose stream at half size), so
attention is most of the work: on a GTX 1060 one step at 512p spends 16 of its 23 minutes there. After the first step,
when the motion and the layout are settled, each frame only needs its neighbours: every frame (and its pose) attends to
the reference pictures, the frames within `window` latent frames of it (4 video frames each), and their poses. The
reference pictures still see everything. The first `dense_steps` steps run full attention. With window 2 that is about
a third of the attention work (7.7 s a layer against 28 s on a GTX 1060). It changes how the model attends, not its
weights, works with any attention ComfyUI picked (PyTorch, sage, Apple's), and leaves clips without SCAIL's layout alone.

Crackio FP16 On Old GPUs: half the activation memory on cards without bf16, at the same speed.

Crackio Resample Frames: SAM 3.1 tracks every 4th frame, and its masks come back at the clip's frame count.
"""
import logging
import time

import torch

log = logging.getLogger("crackio")


def _layout(x, c):
    """Where a SCAIL-2 step's tokens are: the reference frames, then the video frames, then the pose frames (patches of
    2x2). None for anything else."""
    pose = c.get("pose_latents")
    if pose is None or x.dim() != 5:
        return None
    ref = c.get("reference_latent")
    refs = ref.shape[2] if ref is not None else 0
    frames, h, w = x.shape[2], (x.shape[3] + 1) // 2, (x.shape[4] + 1) // 2
    pose_frames, ph, pw = pose.shape[2], (pose.shape[3] + 1) // 2, (pose.shape[4] + 1) // 2
    return {"refs": refs, "frames": frames, "tpf": h * w, "pose_frames": pose_frames, "ptpf": ph * pw}


def _windowed(func, q, k, v, layout, window, *args, **kwargs):
    """Attention where each video frame and its pose see the references and the frames (and poses) within `window`."""
    refs, frames, tpf, pose_frames, ptpf = layout["refs"], layout["frames"], layout["tpf"], layout["pose_frames"], layout["ptpf"]
    ref_end = refs * tpf
    video_end = ref_end + frames * tpf
    out = torch.empty_like(q)
    # The reference frames attend to everything.
    if refs:
        out[:, :ref_end] = func(q[:, :ref_end], k, v, *args, **kwargs)

    def video(a, b):
        return slice(ref_end + a * tpf, ref_end + b * tpf)

    def poses(a, b):
        a, b = min(a, pose_frames), min(b, pose_frames)
        return slice(video_end + a * ptpf, video_end + b * ptpf)

    for t in range(frames):
        lo, hi = max(0, t - window), min(frames, t + window + 1)
        rows = [video(t, t + 1), poses(t, t + 1)]
        cols = [slice(0, ref_end), video(lo, hi), poses(lo, hi)]
        rows = [r for r in rows if r.stop > r.start]
        cols = [c for c in cols if c.stop > c.start]
        qs = torch.cat([q[:, r] for r in rows], 1)
        ks = torch.cat([k[:, c] for c in cols], 1)
        vs = torch.cat([v[:, c] for c in cols], 1)
        o = func(qs, ks, vs, *args, **kwargs)
        at = 0
        for r in rows:
            n = r.stop - r.start
            out[:, r] = o[:, at : at + n]
            at += n
    return out


class CrackioWindowAttention:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "window": ("INT", {"default": 2, "min": 1, "max": 20, "tooltip": "Latent frames each side a frame attends to (4 video frames each)."}),
                "dense_steps": ("INT", {"default": 1, "min": 0, "max": 100, "tooltip": "First steps with full attention, while the motion and layout settle."}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Crackio"
    TITLE = "Crackio Window Attention"

    def patch(self, model, window, dense_steps):
        model = model.clone()
        before = model.model_options.get("model_function_wrapper")

        def wrapper(apply_model, args):
            c = dict(args["c"])
            layout = _layout(args["input"], c)
            options = dict(c.get("transformer_options", {}))
            sigmas = options.get("sample_sigmas")
            step = 0
            if sigmas is not None:
                now = float(args["timestep"].flatten()[0])
                step = int((sigmas[:-1] > now + 1e-5).sum())
            windowed = [0]
            if layout is not None and step >= dense_steps:
                # The whole sequence: SCAIL appends the pose tokens after the reference and video frames.
                total = (layout["refs"] + layout["frames"]) * layout["tpf"] + layout["pose_frames"] * layout["ptpf"]
                inner = options.get("optimized_attention_override")

                def attend(func, q, k, v, *a, **kw):
                    if q.shape[1] == total and k.shape[1] == total:
                        windowed[0] += 1
                        return _windowed(func, q, k, v, layout, window, *a, **kw)
                    return inner(func, q, k, v, *a, **kw) if inner else func(q, k, v, *a, **kw)

                options["optimized_attention_override"] = attend
                c["transformer_options"] = options
            run = {**args, "c": c}
            began = time.time()
            out = before(apply_model, run) if before else apply_model(run["input"], run["timestep"], **run["c"])
            if layout is not None:
                log.info(f"[crackio] step {step + 1}: {'windowed' if windowed[0] else 'full'} attention ({windowed[0]} layers), {time.time() - began:.0f} s")
            return out

        model.set_model_unet_function_wrapper(wrapper)
        return (model,)


class CrackioHalfOnOldGPUs:
    """GTX 10 series and older NVIDIA cards have no bf16, so ComfyUI computes there in fp32. Their fp16 matrix work runs
    as fast (3.7 against 3.35 TFLOPS on a GTX 1060) with half the memory for every activation, which is what decides
    whether a long clip fits a 6 GB card. Elsewhere (bf16 cards, Macs, CPUs) the model is left as it is. For Wan models,
    which are made for fp16 and bf16; some image models overflow in fp16."""

    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Crackio"
    TITLE = "Crackio FP16 On Old GPUs"

    def patch(self, model):
        import comfy.model_management as mm

        device = mm.get_torch_device()
        if device.type == "cuda" and model.model.manual_cast_dtype == torch.float32:
            model = model.clone()
            model.set_model_compute_dtype(torch.float16)
            log.info("[crackio] computing in fp16 on this GPU (it has no bf16)")
        return (model,)


class CrackioResampleFrames:
    """A batch of frames at another count, each the nearest in time: every 4th frame of a clip for a tracker that costs
    seconds a frame on a small GPU (SAM 3.1 looks at every frame at 1008 px: 3.3 s each on a GTX 1060), and its masks
    back at the clip's count afterwards."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {"frames": ("INT", {"default": 21, "min": 1, "max": 100000, "tooltip": "How many frames come out, spread over the same time."})},
            "optional": {"images": ("IMAGE",), "masks": ("MASK",), "like": ("IMAGE", {"tooltip": "Come out with as many frames as this batch instead."})},
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "resample"
    CATEGORY = "Crackio"
    TITLE = "Crackio Resample Frames"

    def resample(self, frames, images=None, masks=None, like=None):
        if like is not None:
            frames = like.shape[0]

        def pick(t):
            if t is None:
                return None
            n = t.shape[0]
            at = [0] if frames == 1 else [min(n - 1, round(i * (n - 1) / (frames - 1))) for i in range(frames)]
            return t[at]

        return (pick(images), pick(masks))


NODE_CLASS_MAPPINGS = {"CrackioWindowAttention": CrackioWindowAttention, "CrackioHalfOnOldGPUs": CrackioHalfOnOldGPUs, "CrackioResampleFrames": CrackioResampleFrames}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CrackioWindowAttention": "Crackio Window Attention",
    "CrackioHalfOnOldGPUs": "Crackio FP16 On Old GPUs",
    "CrackioResampleFrames": "Crackio Resample Frames",
}
