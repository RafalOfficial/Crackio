"""
Crackio's lip-sync worker. The bridge (lipsync.py) runs it in a process of its own: ComfyUI's Python, with Crackio's
lip-sync packages first on the path. LatentSync wants diffusers 0.32 and friends; ComfyUI's own packages never see them,
and the GPU is all ComfyUI's again when the worker ends.

    python lipsync_worker.py <job.json>

The job file says what to do ("command"), where the engine and the models are, and where to write the result JSON
("out"). Frames travel as .npy files (uint8, frames × height × width × 3), speech as 16 kHz mono WAV.

Commands
  selftest  the packages import, the GPU answers, MediaPipe runs, LatentSync's model builds
  track     the faces in the frames (MediaPipe face landmarks), and which one is the speaker's, frame by frame
  sync      the mouth redrawn to the speech (LatentSync 1.6) in the span only, and only the mouth: lips and jaw from the
            nose down, never a hand in front of them; everything else stays the original pixels
  crop      square face crops of the span for a video model to redraw (with how they map back)
  paste     redrawn face crops put back, the same way sync puts its mouths back

Faces come from MediaPipe's face landmarker (Apache-2.0), not InsightFace (its weights are non-commercial): LatentSync's
alignment needs three points (the eyebrow centres and the middle of the nose), which MediaPipe's 478 landmarks give.
"""
import json
import math
import os
import sys
import time
import traceback
import types
import wave

import numpy as np

RES = 512
# stabilityai/sd-vae-ft-mse's config: the VAE comes as one weights file, the config stays here.
SD_VAE = {
    "act_fn": "silu",
    "block_out_channels": [128, 256, 512, 512],
    "down_block_types": ["DownEncoderBlock2D"] * 4,
    "in_channels": 3,
    "latent_channels": 4,
    "layers_per_block": 2,
    "norm_num_groups": 32,
    "out_channels": 3,
    "sample_size": 256,
    "up_block_types": ["UpDecoderBlock2D"] * 4,
}
# MediaPipe face mesh indices (the subject's right side is on the left of the picture).
BROW_A = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
BROW_B = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
# The nose tip: measured on real faces, it puts the nose bottom at 0.48–0.49 of LatentSync's crop, just above the line
# where its redrawn area starts (0.50), with the lips and chin well inside it (InsightFace's points did the same).
NOSE = [4, 1]
# The part of the face a mouth moves: from under the nose round the jaw to the chin and back.
MOUTH_AREA = [132, 205, 98, 164, 327, 425, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58]
LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
# The mouth's opening (the lips' inner edge).
LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
CHIN, SUBNASALE, UPPER_LIP, LOWER_LIP = 152, 2, 0, 17


def log(*a):
    print("[lipsync]", *a, flush=True)


# ------------------------------------------------------------------ the engine's packages


def setup(engine):
    """Crackio's lip-sync packages and LatentSync's code first on the path."""
    for p in (os.path.join(engine, "LatentSync"), os.path.join(engine, "site")):
        if p not in sys.path:
            sys.path.insert(0, p)
    # LatentSync's Whisper copy imports its text tokenizer from transformers when it loads; only its audio encoder is
    # used here, so a stand-in keeps the transformers next to ComfyUI (a newer one) out of this process.
    import importlib.machinery
    import importlib.util

    def stand_in(name, **attrs):
        mod = types.ModuleType(name)
        mod.__spec__ = importlib.machinery.ModuleSpec(name, None)
        for k, v in attrs.items():
            setattr(mod, k, v)
        sys.modules[name] = mod

    if "transformers" not in sys.modules:
        # diffusers decides once, as it loads, which optional packages are there: told there's no transformers, it never
        # reaches for one (the one next to ComfyUI wants a newer huggingface_hub than diffusers 0.32 runs with).
        sys.modules["transformers"] = None
        import diffusers.utils.import_utils  # noqa: F401

        stand_in("transformers", GPT2TokenizerFast=None)
    # MediaPipe's vision package imports matplotlib for its drawing helpers, and LatentSync's utilities import matplotlib,
    # imageio and decord for video files and plots: none of them is used here (frames and speech come as arrays).
    if importlib.util.find_spec("matplotlib") is None:
        stand_in("matplotlib")
        stand_in("matplotlib.pyplot")
    if importlib.util.find_spec("imageio") is None:
        stand_in("imageio")
    if importlib.util.find_spec("decord") is None:
        stand_in("decord", AudioReader=None, VideoReader=None)
    # Whisper's file loader (ffmpeg-python): speech arrives as samples.
    if importlib.util.find_spec("ffmpeg") is None:
        stand_in("ffmpeg")
    # diffusers 0.32 reads weights with safetensors.torch without importing it (transformers usually has by then).
    import safetensors.torch  # noqa: F401


def device_and_dtype():
    import torch

    if torch.cuda.is_available():
        major = torch.cuda.get_device_capability()[0]
        # LatentSync's own rule: half precision from Ampere on.
        return torch.device("cuda"), (torch.float16 if major > 7 else torch.float32)
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps"), torch.float16
    return torch.device("cpu"), torch.float32


# ------------------------------------------------------------------ files


def read_wav(path):
    """A WAV file as float32 mono samples and its rate."""
    with wave.open(path, "rb") as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, "<i4").astype(np.float32) / 2**31
    elif width == 1:
        x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width {width}")
    if ch > 1:
        x = x[: len(x) // ch * ch].reshape(-1, ch).mean(1)
    return x, rate


def resample(x, rate, to):
    if rate == to:
        return x
    n = int(round(len(x) * to / rate))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


# ------------------------------------------------------------------ faces


def face_landmarks(frames, fps, task, max_faces=4):
    """Every face in every frame: 478 points each, in pixels."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions, RunningMode

    opts = FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=task),
        running_mode=RunningMode.VIDEO,
        num_faces=max_faces,
        min_face_detection_confidence=0.4,
        min_face_presence_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    out = []
    with FaceLandmarker.create_from_options(opts) as lm:
        for i, f in enumerate(frames):
            h, w = f.shape[:2]
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f)), int(round(i * 1000 / fps)))
            out.append([np.array([[p.x * w, p.y * h] for p in face], np.float32) for face in res.face_landmarks])
    return out


def hand_points(frames, fps, task, max_hands=4):
    """Every hand in every frame: 21 points each, in pixels (to keep them in front of the mouth)."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import HandLandmarker, HandLandmarkerOptions, RunningMode

    opts = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=task),
        running_mode=RunningMode.VIDEO,
        num_hands=max_hands,
        min_hand_detection_confidence=0.35,
        min_hand_presence_confidence=0.35,
        min_tracking_confidence=0.35,
    )
    out = []
    with HandLandmarker.create_from_options(opts) as lm:
        for i, f in enumerate(frames):
            h, w = f.shape[:2]
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f)), int(round(i * 1000 / fps)))
            out.append([np.array([[p.x * w, p.y * h] for p in hand], np.float32) for hand in res.hand_landmarks])
    return out


def box_of(pts):
    x0, y0 = pts.min(0)
    x1, y1 = pts.max(0)
    return np.array([x0, y0, x1, y1], np.float32)


def follow(faces, start, hint=None):
    """The speaker's face through the frames: the one nearest the hint (or the biggest) where it first shows from
    `start`, then whichever face is nearest it frame to frame. None where it's out of sight."""
    n = len(faces)
    first = next((i for i in range(start, n) if faces[i]), next((i for i in range(start - 1, -1, -1) if faces[i]), None))
    if first is None:
        return [None] * n
    h_w = hint

    def score(face):
        b = box_of(face)
        if h_w is not None:
            c = (b[:2] + b[2:]) / 2
            return -float(np.hypot(*(c - np.array(h_w, np.float32))))
        return float((b[2] - b[0]) * (b[3] - b[1]))

    track = [None] * n
    track[first] = max(faces[first], key=score)

    def step(rng, prev_i):
        prev = track[prev_i]
        for i in rng:
            if prev is None:
                break
            pb = box_of(prev)
            pc, size = (pb[:2] + pb[2:]) / 2, max(pb[2] - pb[0], pb[3] - pb[1])
            best, dist = None, None
            for face in faces[i]:
                b = box_of(face)
                d = float(np.hypot(*(((b[:2] + b[2:]) / 2) - pc)))
                if dist is None or d < dist:
                    best, dist = face, d
            if best is not None and dist < 0.6 * size:
                track[i] = best
                prev = best
            # Out of sight for a moment: keep looking near where it was.

    step(range(first + 1, n), first)
    step(range(first - 1, -1, -1), first)
    return track


def fill_and_smooth(track, max_gap=8):
    """Short gaps filled in between the frames on either side; then each point averaged with its neighbours in time
    (weights 1 2 3 2 1), so crops and masks don't shake."""
    n = len(track)
    t = list(track)
    known = [i for i, x in enumerate(t) if x is not None]
    for a, b in zip(known, known[1:]):
        if 1 < b - a <= max_gap + 1:
            for i in range(a + 1, b):
                k = (i - a) / (b - a)
                t[i] = t[a] * (1 - k) + t[b] * k
    out = [None] * n
    weights = [1, 2, 3, 2, 1]
    for i in range(n):
        if t[i] is None:
            continue
        acc, wsum = 0, 0
        for k, wgt in zip(range(i - 2, i + 3), weights):
            if 0 <= k < n and t[k] is not None:
                acc = acc + t[k] * wgt
                wsum += wgt
        out[i] = acc / wsum
    return out


def points3(lm, nose=None):
    """LatentSync's three alignment points: the eyebrow on the left of the picture, the one on the right, the nose."""
    a, b = lm[BROW_A].mean(0), lm[BROW_B].mean(0)
    left, right = (a, b) if a[0] <= b[0] else (b, a)
    return np.array([left, right, lm[nose or NOSE].mean(0)], np.float32)


# ------------------------------------------------------------------ LatentSync


class Aligner:
    """LatentSync's face alignment (AlignRestore: a similarity transform onto its template), with our three points."""

    def __init__(self, device):
        from latentsync.utils.affine_transform import AlignRestore

        self.restorer = AlignRestore(resolution=RES, device=device)
        # The face before LatentSync squares it: 420 × 560 at 512.
        self.face_w, self.face_h = self.restorer.face_size

    def crop(self, frame, lm, nose=None):
        import cv2

        face, affine = self.restorer.align_warp_face(frame.copy(), landmarks3=points3(lm, nose), smooth=True)
        m = affine.squeeze(0).float().cpu().numpy()
        return cv2.resize(face, (RES, RES), interpolation=cv2.INTER_LANCZOS4), m


def fixed_mask(code):
    """LatentSync's mask: 1 where the face is kept (above the mouth), 0 where it's redrawn."""
    import cv2

    m = cv2.imread(os.path.join(code, "latentsync", "utils", "mask.png"))
    m = cv2.cvtColor(m, cv2.COLOR_BGR2RGB)
    return cv2.resize(m, (RES, RES), interpolation=cv2.INTER_LANCZOS4).astype(np.float32) / 255.0


def whisper_features(encoder, audio16k):
    """LatentSync's audio features (Whisper tiny's encoder, every layer, 50 a second) from samples, not a file."""
    import torch

    model = encoder.model
    from latentsync.whisper.whisper.audio import N_FRAMES, log_mel_spectrogram, pad_or_trim

    dtype = torch.float16 if model.device.type == "cuda" else torch.float32
    mel = log_mel_spectrogram(torch.from_numpy(audio16k))
    feats = []
    seek, step = 0, 3000
    with torch.no_grad():
        while seek < mel.shape[-1]:
            end = min(seek + step, mel.shape[-1])
            seg = pad_or_trim(mel[:, seek : seek + step], N_FRAMES).to(model.device).to(dtype).unsqueeze(0)
            _, emb = model.encoder(seg, include_embeddings=True)
            emb = emb.transpose(0, 2, 1, 3).squeeze(0)
            feats.append(emb[: int((end - seek) / 2)])
            seek += step
    return torch.from_numpy(np.concatenate(feats, axis=0))


class LatentSync:
    def __init__(self, engine, models, device, dtype):
        import torch
        from diffusers import AutoencoderKL, DDIMScheduler
        from omegaconf import OmegaConf
        from latentsync.models.unet import UNet3DConditionModel
        from latentsync.whisper.audio2feature import Audio2Feature

        code = os.path.join(engine, "LatentSync")
        self.config = OmegaConf.load(os.path.join(code, "configs", "unet", "stage2_512.yaml"))
        self.device, self.dtype = device, dtype
        self.scheduler = DDIMScheduler.from_pretrained(os.path.join(code, "configs"))
        self.audio = Audio2Feature(model_path=models["whisper"], device=str(device), num_frames=16, audio_feat_length=list(self.config.data.audio_feat_length))
        if os.path.isfile(models["vae"]):
            import safetensors.torch

            self.vae = AutoencoderKL(**SD_VAE)
            weights = safetensors.torch.load_file(models["vae"])
            # The file keeps the old attention names (query, key, value, proj_attn); from_pretrained renames them, and
            # so does this.
            self.vae._convert_deprecated_attention_blocks(weights)
            self.vae.load_state_dict(weights)
            self.vae = self.vae.to(device=device, dtype=dtype)
        else:
            self.vae = AutoencoderKL.from_pretrained(models["vae"], torch_dtype=dtype).to(device)
        self.vae.config.scaling_factor = 0.18215
        self.vae.config.shift_factor = 0
        unet, _ = UNet3DConditionModel.from_pretrained(OmegaConf.to_container(self.config.model), models["unet"], device="cpu")
        self.unet = unet.to(device=device, dtype=dtype).eval()
        self.mask = torch.from_numpy(fixed_mask(code)).permute(2, 0, 1)  # c h w, 1 = kept

    def __call__(self, crops, audio16k, fps, steps=20, guidance=1.5, seed=1247, progress=None, refs=None, overlap=0):
        """Mouths for the face crops (N × 512 × 512 × 3 uint8), driven by the speech (16 kHz, the crops' length).
        `refs`: the face each frame takes its looks from (teeth, lips), one per crop (default: the crop itself).
        `overlap`: frames the 16-frame windows share; there the mouths cross-fade (the window's middle counts most)
        instead of jumping at each window's edge."""
        import torch
        import torch.nn.functional as F
        from einops import rearrange

        n = len(crops)
        refs = crops if refs is None else refs
        overlap = max(0, min(12, int(overlap)))
        stride = 16 - overlap
        starts = list(range(0, n - 16 + 1, stride)) if n > 16 else [0]
        if n > 16 and starts[-1] + 16 < n:
            starts.append(n - 16)
        feats = whisper_features(self.audio, audio16k)
        chunks = self.audio.feature2chunks(feature_array=feats, fps=fps)
        if len(chunks) < n:
            chunks += [chunks[-1]] * (n - len(chunks))
        chunks = chunks[:n]
        dev, dt = self.device, self.dtype
        cfg = guidance > 1.0
        gen = torch.Generator(device="cpu").manual_seed(int(seed))
        self.scheduler.set_timesteps(steps, device=dev)
        scale = self.vae.config.scaling_factor
        # One noise for the whole clip, as LatentSync does: the frames stay of a piece.
        base = torch.randn((1, 4, 1, RES // 8, RES // 8), generator=gen, dtype=torch.float32).to(dev, dt)
        acc = np.zeros((n, RES, RES, 3), np.float32)
        weight = np.zeros(n, np.float32)
        mask = self.mask.to(dev, dt)
        with torch.no_grad():
            for a in starts:
                b = min(n, a + 16)
                faces = torch.from_numpy(crops[a:b]).to(dev).permute(0, 3, 1, 2).to(dt) / 255.0
                looks = torch.from_numpy(np.ascontiguousarray(refs[a:b])).to(dev).permute(0, 3, 1, 2).to(dt) / 255.0
                f = faces.shape[0]
                pixels = (faces - 0.5) / 0.5
                masked = pixels * mask
                masks = mask[0:1].unsqueeze(0).repeat(f, 1, 1, 1)
                audio = torch.stack(chunks[a:b]).to(dev, dt)
                if cfg:
                    audio = torch.cat([torch.zeros_like(audio), audio])
                mask_lat = F.interpolate(masks, size=(RES // 8, RES // 8))
                mask_lat = rearrange(mask_lat, "f c h w -> 1 c f h w")
                masked_lat = rearrange(self.vae.encode(masked).latent_dist.sample(generator=None) * scale, "f c h w -> 1 c f h w")
                ref_lat = rearrange(self.vae.encode((looks - 0.5) / 0.5).latent_dist.sample(generator=None) * scale, "f c h w -> 1 c f h w")
                if cfg:
                    mask_lat, masked_lat, ref_lat = (torch.cat([x] * 2) for x in (mask_lat, masked_lat, ref_lat))
                latents = base.repeat(1, 1, f, 1, 1) * self.scheduler.init_noise_sigma
                for t in self.scheduler.timesteps:
                    x = torch.cat([latents] * 2) if cfg else latents
                    x = self.scheduler.scale_model_input(x, t)
                    x = torch.cat([x, mask_lat, masked_lat, ref_lat], dim=1)
                    pred = self.unet(x, t, encoder_hidden_states=audio).sample
                    if cfg:
                        uncond, cond = pred.chunk(2)
                        pred = uncond + guidance * (cond - uncond)
                    latents = self.scheduler.step(pred, t, latents).prev_sample
                decoded = self.vae.decode(rearrange(latents / scale, "b c f h w -> (b f) c h w")).sample
                # LatentSync keeps the face above the mouth as it was.
                decoded = decoded * (1 - masks) + pixels * masks
                imgs = ((decoded / 2 + 0.5).clamp(0, 1) * 255).permute(0, 2, 3, 1).float().cpu().numpy()
                k = np.arange(f, dtype=np.float32)
                w = np.minimum(1.0, np.minimum((k + 1) / (overlap + 1), (f - k) / (overlap + 1))) if overlap else np.ones(f, np.float32)
                acc[a:b] += imgs * w[:, None, None, None]
                weight[a:b] += w
                if progress:
                    progress(b, n)
        return np.clip(np.round(acc / weight[:, None, None, None]), 0, 255).astype(np.uint8)


# ------------------------------------------------------------------ putting mouths back


def soft(mask, sigma):
    import cv2

    k = int(max(3, round(sigma * 3)) * 2 + 1)
    return cv2.GaussianBlur(mask, (k, k), sigma)


# How far the colour pull may move the redrawn mouth (OpenCV's 8-bit Lab: L 0-255, a and b offset by 128): it
# corrects a drift of a few units, it never repaints. And how different a ring pixel may be in the two pictures and
# still count: past that they show different things (her hair on one side, skin on the other as her head turns).
# Without both, the "Serum UGC" woman's mouth went dark grey with blue teeth while she tilted her head (2026-11-03):
# the ring had her hair in the original and skin in the drawing, and the pull followed the hair.
# The most the redrawn mouth's fine texture is boosted to match the original's.
SHARPEN_MAX = 2.5
COLOUR_CAP = np.array([20.0, 10.0, 10.0], np.float32)
COLOUR_SAME = np.array([24.0, 14.0, 14.0], np.float32)


def match_colour(cand, orig, ring):
    """The redrawn mouth's colour pulled to the original's, from a thin ring just outside it: mean and spread per
    channel in Lab, over the ring pixels that show the same thing in both pictures, the shift capped. Returns the
    shift and scale (to smooth over time), and whether the cap held it, or None when too little of the ring is left."""
    import cv2

    if ring.sum() < 50:
        return None
    a = cv2.cvtColor(cand, cv2.COLOR_RGB2LAB).astype(np.float32)[ring]
    b = cv2.cvtColor(orig, cv2.COLOR_RGB2LAB).astype(np.float32)[ring]
    same = (np.abs(a - b) < COLOUR_SAME).all(1)
    if same.sum() < 50:
        return None
    a, b = a[same], b[same]
    ma, sa, mb, sb = a.mean(0), a.std(0) + 1e-3, b.mean(0), b.std(0) + 1e-3
    scale = np.clip(sb / sa, 0.75, 1.33)
    shift = mb - ma
    capped = bool((np.abs(shift) > COLOUR_CAP).any())
    return ma, ma + np.clip(shift, -COLOUR_CAP, COLOUR_CAP), scale, capped


def apply_colour(cand, params):
    import cv2

    ma, mb, scale = params
    lab = cv2.cvtColor(cand, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab = (lab - ma) * scale + mb
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)


def span_alpha(n, span, fade):
    """How much of the new mouth each frame takes: 0 outside the span, rising and falling over `fade` frames at its ends
    (the span's first and last frames stay the original's)."""
    a = np.zeros(n, np.float32)
    s, e = max(0, int(span[0])), min(n, int(span[1]))
    for i in range(s, e):
        k = min(i - s, e - 1 - i)
        a[i] = 1.0 if fade <= 0 else min(1.0, k / fade)
    return a


def mouth_mask(shape, lm, hands, face_h, origin=(0, 0), area="mouth"):
    """Where the new mouth may go: from under the nose round the jaw, a little wider, minus any hand. In a window of the
    frame of `shape` whose top-left corner is `origin`. `area` "lips": only the lips and the mouth's opening (teeth,
    tongue), a little wider."""
    import cv2

    h, w = shape[:2]
    o = np.array(origin, np.float32)
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.round(lm[LIPS if area == "lips" else MOUTH_AREA] - o).astype(np.int32)], 255)
    # "lips": a narrow margin (2.2% of the chin-to-eyes height, ~10 px on a 954 px face); wider lets HuMo's skin through.
    grow = max(3, int(face_h * (0.022 if area == "lips" else 0.035)))
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1)))
    for hand in hands:
        hull = cv2.convexHull(np.round(hand - o).astype(np.int32))
        hm = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(hm, hull, 255)
        pad = max(4, int(face_h * 0.06))
        hm = cv2.dilate(hm, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (pad * 2 + 1, pad * 2 + 1)))
        m[hm > 0] = 0
    return m


def detail(x, sigma=1.2):
    """The fine texture of an image: it minus a blur of it."""
    import cv2

    f = x.astype(np.float32)
    return f - cv2.GaussianBlur(f, (0, 0), sigma)


def place(img, face_size, warp, x0, y0, ww, wh):
    """A redrawn face picture (any size: it stands for the `face_size` crop that `warp` cuts out of the frame) put into
    the frame's window (x0, y0, ww × wh) in one resampling. Where it has more pixels than the frame gives the face
    (drawn bigger, or decoded at twice the size) it's first softened just enough not to alias, a Gaussian of
    0.4·sqrt(f²-1) of its pixels for f of them to a frame pixel, then placed with one bicubic warp (Lanczos near 1:1).
    Measured on the clip's own frames against an antialiased Lanczos shrink (C:/CrackioTemp/humo/place_test4.py): rmse
    0.9-1.5 from f 1 to 3 where the old bilinear warp gave 1.2-3.6 (it blurred every frame at the sub-pixel shifts a
    moving face has, and aliased pictures drawn bigger)."""
    import cv2

    gh, gw = img.shape[:2]
    fw, fh = face_size
    w = np.asarray(warp, np.float64)
    k = float(np.sqrt(abs(np.linalg.det(w[:, :2]))))  # crop pixels per frame pixel
    fx, fy = gw * k / fw, gh * k / fh  # picture pixels per frame pixel
    sx, sy = 0.4 * math.sqrt(max(fx * fx - 1, 0)), 0.4 * math.sqrt(max(fy * fy - 1, 0))
    if max(sx, sy) > 0.15:
        img = cv2.GaussianBlur(img, (0, 0), sigmaX=max(sx, 1e-3), sigmaY=max(sy, 1e-3))
    # picture pixel -> crop pixel (pixel centres, as cv2.resize) -> frame pixel -> window pixel
    to_crop = np.array([[fw / gw, 0, 0.5 * fw / gw - 0.5], [0, fh / gh, 0.5 * fh / gh - 0.5], [0, 0, 1]])
    to_frame = np.vstack([cv2.invertAffineTransform(w), [0, 0, 1]])
    to_window = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], np.float64)
    m = (to_window @ to_frame @ to_crop)[:2]
    flags = cv2.INTER_LANCZOS4 if max(fx, fy) < 1.2 else cv2.INTER_CUBIC
    return cv2.warpAffine(img, m, (ww, wh), flags=flags, borderMode=cv2.BORDER_REPLICATE)


def composite(frames, gens, lms, hands, alpha, warps, region, face_size, colour=True, sharpen=True, area="mouth", base=None):
    """Each redrawn face crop warped back into its frame, and only the mouth area of it blended in: feathered, its colour
    pulled to the skin around it and its fine texture to the original's (both smoothed over time so nothing flickers),
    faded at the span's ends. Works in a window round the mouth; every pixel outside the mouth area is the original's,
    byte for byte.
    `area` "lips" with `base` (Best quality: LatentSync's frames, whose jaw and skin already move with the new words):
    only the lips and the mouth's opening are taken from the crops, laid onto `base`, their colour pulled to its skin
    round them. HuMo gives a smooth face real-skin texture round the mouth, a stubble-like band above the lip on the
    "Capsules UGC" woman (2026-11-03) whatever its prompt, precision, size or steering; its lips and teeth stay."""
    import cv2

    fw, fh = face_size
    under = frames if base is None else base
    out = under.copy()
    n = len(frames)
    H, W = frames.shape[1:3]
    work = [None] * n
    colours, gains = [None] * n, [None] * n
    region_face = cv2.resize(region, (fw, fh))
    for i in range(n):
        if alpha[i] <= 0 or gens[i] is None or lms[i] is None:
            continue
        lm = lms[i]
        face_h = float(np.linalg.norm(lm[CHIN] - points3(lm)[:2].mean(0)))
        # The window: the mouth area, grown by its feather and the colour ring.
        pad = int(face_h * 0.15) + 16
        x0, y0 = np.floor(lm[MOUTH_AREA].min(0)).astype(int) - pad
        x1, y1 = np.ceil(lm[MOUTH_AREA].max(0)).astype(int) + pad
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        ww, wh = x1 - x0, y1 - y0
        inv = cv2.invertAffineTransform(warps[i])
        inv[:, 2] -= (x0, y0)
        cand = place(gens[i], (fw, fh), warps[i], x0, y0, ww, wh)
        # Only where LatentSync drew, a little inside its edge.
        drawn = cv2.warpAffine(region_face, inv, (ww, wh), flags=cv2.INTER_LINEAR, borderValue=0)
        drawn = cv2.erode((drawn > 0.5).astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
        orig = frames[i, y0:y1, x0:x1]
        m = cv2.bitwise_and(mouth_mask((wh, ww), lm, hands[i] if hands else [], face_h, (x0, y0), area), drawn)
        if not m.any():
            continue
        if colour:
            ring = cv2.dilate(m, np.ones((9, 9), np.uint8)) > 0
            ring &= m == 0
            ring &= drawn > 0
            colours[i] = match_colour(cand, under[i, y0:y1, x0:x1], ring)
        if sharpen:
            inside = cv2.erode(m, np.ones((5, 5), np.uint8)) > 0
            if inside.sum() > 50:
                eo = float(np.abs(detail(orig)[inside]).mean())
                ec = float(np.abs(detail(cand)[inside]).mean()) + 1e-3
                gains[i] = float(np.clip(eo / ec, 1.0, SHARPEN_MAX))
        work[i] = (x0, y0, x1, y1, cand, m, face_h)
    # Colour and texture corrections averaged over neighbouring frames, then the blend.
    capped = 0
    for i in range(n):
        if work[i] is None:
            continue
        x0, y0, x1, y1, cand, m, face_h = work[i]
        near = range(max(0, i - 3), min(n, i + 4))
        if colour:
            cs = [colours[k] for k in near if colours[k] is not None]
            if cs:
                cand = apply_colour(cand, tuple(np.mean([c[j] for c in cs], axis=0) for j in range(3)))
                capped += bool(colours[i] is not None and colours[i][3])
        if sharpen:
            gs = [gains[k] for k in near if gains[k] is not None]
            if gs:
                g = float(np.mean(gs))
                if g > 1.02:
                    cand = np.clip(cand.astype(np.float32) + (g - 1.0) * detail(cand), 0, 255).astype(np.uint8)
        a = soft(m.astype(np.float32) / 255.0, max(1.5, face_h * (0.012 if area == "lips" else 0.025))) * alpha[i]
        a = a[..., None]
        bed = under[i, y0:y1, x0:x1]
        blended = bed.astype(np.float32) * (1 - a) + cand.astype(np.float32) * a
        changed = a[..., 0] > 0
        win = out[i, y0:y1, x0:x1]
        win[changed] = np.clip(np.round(blended[changed]), 0, 255).astype(np.uint8)
    if capped:
        log(f"colour pull capped in {capped} frames")
    return out


def lip_mask(shape, lm, origin=(0, 0)):
    """The lips themselves: inside their outer edge, outside the mouth's opening. In a window whose top-left is `origin`."""
    import cv2

    o = np.array(origin, np.float32)
    m = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(m, [np.round(lm[LIPS] - o).astype(np.int32)], 255)
    cv2.fillPoly(m, [np.round(lm[LIPS_INNER] - o).astype(np.int32)], 0)
    return m


def lips_box(lm, shape, pad):
    H, W = shape[:2]
    x0, y0 = np.floor(lm[LIPS].min(0)).astype(int) - pad
    x1, y1 = np.ceil(lm[LIPS].max(0)).astype(int) + pad
    return max(0, x0), max(0, y0), min(W, x1), min(H, y1)


def lab_of(rgb):
    import cv2

    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2LAB)


def lip_ab(img, lm):
    """The lips' colour: the median a* and b* of their pixels, a little inside their edges. None when too few show."""
    import cv2

    x0, y0, x1, y1 = lips_box(lm, img.shape, 2)
    if x1 - x0 < 6 or y1 - y0 < 4:
        return None
    m = cv2.erode(lip_mask((y1 - y0, x1 - x0), lm, (x0, y0)), np.ones((3, 3), np.uint8)) > 0
    if m.sum() < 40:
        return None
    return np.median(lab_of(img[y0:y1, x0:x1])[m][:, 1:], 0)


def match_lips(frames, out, track, alpha, fps, task, reach=12, limit=6.0):
    """LatentSync draws lips a shade pinker than they are (2-3 units of b* less warm, measured): their colour pulled
    back to the original lips' own. The median a*/b* of the lips in the original frames and in the new ones, each pooled
    over a second around the frame (lips change shape, not colour), and the difference added to the new lips, feathered
    and faded with the span, only on pixels the redraw changed. Returns the frames and the median shift."""
    import cv2

    n = len(frames)
    on = [i for i in range(n) if alpha[i] > 0]
    if not on:
        return out, None
    s, e = on[0], on[-1] + 1
    # The new lips are found again in the new frames (their shape is new): the face where the original's track is.
    found = face_landmarks(out[s:e], fps, task)
    new = [None] * n
    for k, i in enumerate(range(s, e)):
        if track[i] is None or not found[k]:
            continue
        b = box_of(track[i])
        c, size = (b[:2] + b[2:]) / 2, float(b[2] - b[0])

        def off(f):
            fb = box_of(f)
            return float(np.hypot(*((fb[:2] + fb[2:]) / 2 - c)))

        best = min(found[k], key=off)
        if off(best) < 0.3 * size:
            new[i] = best
    was = [lip_ab(frames[i], track[i]) if s <= i < e and track[i] is not None else None for i in range(n)]
    now = [lip_ab(out[i], new[i]) if new[i] is not None else None for i in range(n)]
    shifts = []
    for i in range(s, e):
        # Where the new face wasn't found, the original's lips mark the place (close enough for a feathered colour
        # shift), so no frame goes without it and flickers.
        lm = new[i] if new[i] is not None else track[i]
        if lm is None or alpha[i] <= 0:
            continue
        near = range(max(s, i - reach), min(e, i + reach + 1))
        a = [was[k] for k in near if was[k] is not None]
        b = [now[k] for k in near if now[k] is not None]
        if len(a) < 3 or len(b) < 3:
            continue
        shift = np.clip(np.median(a, 0) - np.median(b, 0), -limit, limit)
        shifts.append(shift)
        if np.abs(shift).max() < 0.25:
            continue
        x0, y0, x1, y1 = lips_box(lm, out.shape[1:3], 6)
        if x1 - x0 < 6 or y1 - y0 < 4:
            continue
        win = out[i, y0:y1, x0:x1]
        m = lip_mask((y1 - y0, x1 - x0), lm, (x0, y0))
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        w = soft(m.astype(np.float32) / 255.0, 1.5) * alpha[i]
        w *= np.any(win != frames[i, y0:y1, x0:x1], axis=-1)
        if not (w > 0.02).any():
            continue
        lab = lab_of(win)
        lab[..., 1] += shift[0] * w
        lab[..., 2] += shift[1] * w
        fixed = np.clip(np.round(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB) * 255.0), 0, 255).astype(np.uint8)
        sel = w > 0.02
        win[sel] = fixed[sel]
    return out, ([round(float(v), 2) for v in np.median(shifts, 0)] if shifts else None)


# ------------------------------------------------------------------ commands


def models_has(job, key):
    path = job.get("models", {}).get(key)
    return bool(path) and os.path.exists(path)


def write_patches(folder, frames, out, span, fps, matrix=None):
    """What changed, as little pictures: for each frame of the span with a changed pixel, an RGBA PNG of one rectangle
    (the same for every frame: all the span's changes fit in it) that is opaque exactly where the pixel changed. Pasted
    onto the original frames they give `out` back, and every other pixel stays the original's."""
    import cv2

    os.makedirs(folder, exist_ok=True)
    s, e = int(span[0]), int(span[1])
    changed = np.any(out[s:e] != frames[s:e], axis=-1)  # f h w
    if not changed.any():
        info = {"box": None, "frames": [], "fps": fps, "matrix": matrix}
    else:
        ys, xs = np.where(changed.any(axis=0))
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        listed = []
        for k in range(e - s):
            if not changed[k].any():
                continue
            rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
            rgba[..., :3] = out[s + k, y0:y1, x0:x1]
            rgba[..., 3] = changed[k, y0:y1, x0:x1] * 255
            name = f"patch_{s + k:06d}.png"
            cv2.imwrite(os.path.join(folder, name), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 6])
            listed.append({"frame": s + k, "file": name})
        info = {"box": [x0, y0, x1 - x0, y1 - y0], "frames": listed, "fps": fps, "matrix": matrix}
    with open(os.path.join(folder, "patches.json"), "w") as f:
        json.dump(info, f)
    return {"box": info["box"], "count": len(info["frames"])}


def cmd_selftest(job):
    import torch

    t0 = time.time()
    import diffusers
    import mediapipe  # noqa: F401
    import cv2  # noqa: F401
    from omegaconf import OmegaConf  # noqa: F401

    dev, dt = device_and_dtype()
    faces = face_landmarks(np.zeros((2, 256, 256, 3), np.uint8), 25, job["models"]["face"])
    info = {"ok": True, "device": str(dev), "dtype": str(dt).replace("torch.", ""), "torch": torch.__version__, "diffusers": diffusers.__version__, "faces_on_blank": sum(len(f) for f in faces)}
    if torch.cuda.is_available():
        info["gpu"] = torch.cuda.get_device_name(0)
    if job.get("full"):
        LatentSync(job["engine"], job["models"], dev, dt)
        info["model"] = "loaded"
    info["seconds"] = round(time.time() - t0, 1)
    return info


def cmd_track(job):
    frames = np.load(job["frames"], mmap_mode="r")
    fps = float(job["fps"])
    faces = face_landmarks(frames, fps, job["models"]["face"])
    start = int(job.get("start", 0))
    track = fill_and_smooth(follow(faces, start, job.get("hint")))
    h, w = frames.shape[1:3]
    boxes = [None if t is None else [round(float(v), 1) for v in box_of(t)] for t in track]
    return {"frames": len(frames), "size": [w, h], "faces_per_frame": [len(f) for f in faces], "boxes": boxes, "found": sum(b is not None for b in boxes)}


def cmd_sync(job):
    """The mouth redrawn in the span (frames [start, end)) to the speech, and put back."""
    import torch

    t0 = time.time()
    frames = np.load(job["frames"])
    fps = float(job["fps"])
    n = len(frames)
    span = job.get("span") or [0, n]
    fade = int(job.get("fade", 4))
    audio, rate = read_wav(job["audio"])
    audio = resample(audio, rate, 16000)
    want = int(round(n / fps * 16000))
    audio = np.pad(audio, (0, max(0, want - len(audio))))[:want]

    faces = face_landmarks(frames, fps, job["models"]["face"])
    track = fill_and_smooth(follow(faces, int(span[0]), job.get("hint")))
    alpha = span_alpha(n, span, fade)
    missing = [i for i in range(n) if alpha[i] > 0 and track[i] is None]
    if len(missing) > 0.5 * max(1, int((alpha > 0).sum())):
        raise RuntimeError(f"the face isn't visible in {len(missing)} of the span's frames")
    hands = hand_points(frames, fps, job["models"]["hand"]) if job["models"].get("hand") else None
    t_faces = time.time() - t0

    dev, dt = device_and_dtype()
    aligner = Aligner(dev)
    # The frames LatentSync sees: the span plus a little on each side, so its mouths settle in before they're used.
    s = max(0, int(span[0]) - 8)
    e = min(n, int(span[1]) + 8)
    idx = [i for i in range(s, e)]
    crops, warps = [], {}
    last = None
    for i in idx:
        lm = track[i] if track[i] is not None else last
        if lm is None:
            lm = next((track[k] for k in range(i, e) if track[k] is not None), None)
        if lm is None:
            raise RuntimeError("no face to sync in the span")
        crop, m = aligner.crop(frames[i], lm)
        crops.append(crop)
        warps[i] = m
        last = lm
    crops = np.stack(crops)
    clip_audio = audio[int(round(s / fps * 16000)) : int(round(e / fps * 16000))]
    refs, looks = reference_faces(str(job.get("reference") or "same"), crops, [track[i] for i in idx], clip_audio, fps)
    model = LatentSync(job["engine"], job["models"], dev, dt)
    t_load = time.time() - t0 - t_faces
    gens = model(
        crops,
        clip_audio,
        fps,
        steps=int(job.get("steps", 20)),
        guidance=float(job.get("guidance", 1.5)),
        seed=int(job.get("seed", 1247)),
        progress=lambda k, total: print(f"[lipsync] progress {k}/{total}", flush=True),
        refs=refs,
        overlap=int(job.get("overlap", 0)),
    )
    t_sync = time.time() - t0 - t_faces - t_load
    peak_gb = round(torch.cuda.max_memory_allocated() / 2**30, 2) if torch.cuda.is_available() else None
    del model
    torch.cuda.empty_cache() if torch.cuda.is_available() else None

    region = 1.0 - fixed_mask(os.path.join(job["engine"], "LatentSync"))[..., 0]
    full_gens = [None] * n
    full_warps = [None] * n
    for k, i in enumerate(idx):
        full_gens[i] = gens[k]
        full_warps[i] = warps[i]
    t_paste = time.time()
    out = composite(frames, full_gens, track, hands, alpha, full_warps, region, (aligner.face_w, aligner.face_h), colour=job.get("colour", True), sharpen=job.get("sharpen", True))
    lips_shift = None
    if job.get("colour", True):
        out, lips_shift = match_lips(frames, out, track, alpha, fps, job["models"]["face"])
    t_paste = time.time() - t_paste
    if job.get("out_frames"):
        np.save(job["out_frames"], out)
    patches = write_patches(job["patch_dir"], frames, out, span, fps, job.get("matrix")) if job.get("patch_dir") else None
    if job.get("debug_crops"):
        np.save(job["debug_crops"], np.stack([crops, gens]))
    span_frames = slice(max(0, int(span[0])), min(n, int(span[1])))
    changed = int(np.count_nonzero(np.any(out[span_frames] != frames[span_frames], axis=-1)))
    scores = None
    if job.get("score") and models_has(job, "syncnet"):
        t_s = time.time()
        scores = {"new": sync_score(job["engine"], job["models"], out, track, audio, fps, span, dev)}
        if job.get("original_audio"):
            orig, r0 = read_wav(job["original_audio"])
            orig = resample(orig, r0, 16000)
            orig = np.pad(orig, (0, max(0, want - len(orig))))[:want]
            # How the original mouths went with the original words: the bar the new ones should reach.
            scores["original"] = sync_score(job["engine"], job["models"], frames, track, orig, fps, span, dev)
        scores["seconds"] = round(time.time() - t_s, 1)
    return {
        "frames": n,
        "span": [int(span[0]), int(span[1])],
        "synced": len(idx),
        "missing": len(missing),
        "peak_gb": peak_gb,
        "changed_pixels": changed,
        "changed_share": round(changed / float(max(1, span_frames.stop - span_frames.start) * frames.shape[1] * frames.shape[2]), 5),
        "scores": scores,
        "lips_shift_ab": lips_shift,
        "reference": looks,
        "overlap": int(job.get("overlap", 0)),
        "steps": int(job.get("steps", 20)),
        "patches": patches,
        "seconds": {"faces": round(t_faces, 1), "load": round(t_load, 1), "sync": round(t_sync, 1), "paste": round(t_paste, 1), "total": round(time.time() - t0, 1)},
    }


def opening(lm):
    """How open the mouth is: the gap between the inner lips (13, 14) over the face's height (10 to 152)."""
    if lm is None:
        return None
    face = float(np.linalg.norm(lm[10] - lm[152])) or 1.0
    return float(np.linalg.norm(lm[13] - lm[14])) / face


def reference_faces(mode, crops, lms, audio16k, fps):
    """The faces LatentSync takes each frame's looks from. "same": each frame itself (LatentSync's way: a frame caught
    with its mouth shut shows no teeth to copy). "open": the frame of the window where the mouth is most open, so its
    teeth and inner lips are there for every frame. "pair": that open frame where the new speech is loud, the most
    closed frame where it's quiet, so the looks match the mouth each frame needs."""
    if mode not in ("open", "pair"):
        return None, {"mode": "same"}
    amount = [opening(lm) for lm in lms]
    known = [k for k, v in enumerate(amount) if v is not None]
    if not known:
        return None, {"mode": "same", "why": "no landmarks"}
    k_open = max(known, key=lambda k: amount[k])
    k_shut = min(known, key=lambda k: amount[k])
    looks = {"mode": mode, "open": [k_open, round(amount[k_open], 4)], "closed": [k_shut, round(amount[k_shut], 4)]}
    if mode == "open" or k_open == k_shut:
        return np.stack([crops[k_open]] * len(crops)), looks
    per = 16000 / float(fps)
    rms = np.array([np.sqrt(np.mean(np.square(audio16k[int(k * per) : max(int(k * per) + 1, int((k + 1) * per))])) + 1e-12) for k in range(len(crops))])
    loud = rms > 0.3 * float(np.percentile(rms, 90))
    looks["loud"] = int(loud.sum())
    return np.stack([crops[k_open] if loud[k] else crops[k_shut] for k in range(len(crops))]), looks


def face_window(track, span, n, size, scale=1.9, smooth=6):
    """A square window round the face for each frame of [s, e): its centre follows the face, smoothed over +-`smooth`
    frames so the crop doesn't wobble; its side is the face's biggest size in the span times `scale`. Returns the 2x3
    frame-to-crop transforms (crop side `size`)."""
    s, e = int(span[0]), int(span[1])
    centres, sides = {}, []
    for i in range(s, e):
        lm = track[i]
        if lm is None:
            continue
        b = box_of(lm)
        centres[i] = (b[:2] + b[2:]) / 2
        sides.append(max(b[2] - b[0], b[3] - b[1]))
    if not centres:
        raise RuntimeError("no face in the span")
    side = float(max(sides)) * scale
    known = sorted(centres)
    warps = {}
    for i in range(s, e):
        near = [centres[k] for k in known if abs(k - i) <= smooth] or [centres[min(known, key=lambda k: abs(k - i))]]
        cx, cy = np.mean(near, axis=0)
        k = size / side
        warps[i] = np.array([[k, 0, -(cx - side / 2) * k], [0, k, -(cy - side / 2) * k]], np.float32)
    return warps, side


def cmd_crop(job):
    """Square face crops of the window [s, e) (span plus margins) for a video model to redraw, and what maps them back."""
    import cv2

    frames = np.load(job["frames"])
    fps = float(job["fps"])
    n = len(frames)
    span = job.get("span") or [0, n]
    size = int(job.get("size", 768))
    if job.get("window"):
        s, e = max(0, int(job["window"][0])), min(n, int(job["window"][1]))
    else:
        margin = int(job.get("margin", 8))
        s, e = max(0, int(span[0]) - margin), min(n, int(span[1]) + margin)
    faces = face_landmarks(frames, fps, job["models"]["face"])
    track = fill_and_smooth(follow(faces, int(span[0]), job.get("hint")))
    hands = hand_points(frames, fps, job["models"]["hand"]) if job["models"].get("hand") else [[] for _ in range(n)]
    warps, side = face_window(track, [s, e], n, size)
    crops = np.stack([cv2.warpAffine(frames[i], warps[i], (size, size), flags=cv2.INTER_AREA if side > size else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) for i in range(s, e)])
    np.save(job["out_crops"], crops)
    meta = {"window": [s, e], "span": [int(span[0]), int(span[1])], "size": size, "side": side, "warps": {str(i): warps[i].tolist() for i in warps}, "track": {str(i): (None if track[i] is None else track[i].tolist()) for i in range(n)}, "hands": {str(i): [h.tolist() for h in hands[i]] for i in range(n)}}
    with open(job["out_meta"], "w") as f:
        json.dump(meta, f)
    return {"window": [s, e], "crops": len(crops), "size": size, "side": round(side, 1)}


def teeth_frame(frames, track, keys):
    """The frame whose mouth shows the most of itself (teeth, inner lips): of the quarter of `keys` where the mouth is
    most open, the one whose opening is brightest inside (teeth are; a dark open mouth or an "o" shows none)."""
    import cv2

    amount = {i: opening(track[i]) for i in keys if track[i] is not None}
    if not amount:
        return None, None
    ranked = sorted(amount, key=amount.get, reverse=True)
    best, light = ranked[0], -1.0
    for i in ranked[: max(1, len(ranked) // 4)]:
        m = np.zeros(frames[i].shape[:2], np.uint8)
        cv2.fillPoly(m, [np.round(track[i][LIPS_INNER]).astype(np.int32)], 255)
        ys, xs = np.nonzero(m)
        if len(ys) < 12:
            continue
        lum = float(cv2.cvtColor(np.ascontiguousarray(frames[i][ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]), cv2.COLOR_RGB2LAB)[..., 0][m[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] > 0].mean())
        if lum * amount[i] > light:
            best, light = i, lum * amount[i]
    return best, round(amount[best], 4)


def cmd_window(job):
    """What a video model redraws over LatentSync's mouths (Lip Sync's best quality): the speaker's face found in the
    clip's own frames, a square window that follows it over the span plus margins (the face's biggest size x `scale`,
    drawn at its own pixel size up to `size` and never under 512, or with `upscale` always at `size`: a face drawn
    bigger than it is gets finer teeth and lips, shrunk back when it's pasted), cut out of LatentSync's frames (`cuts`);
    and the reference face, the clip's own frame of the window whose mouth shows the most (teeth, inner lips), in its own
    window."""
    import cv2

    t0 = time.time()
    frames = np.load(job["frames"])
    cuts = np.load(job["cuts"], mmap_mode="r")
    if cuts.shape != frames.shape:
        raise RuntimeError(f"LatentSync's frames {tuple(cuts.shape)} aren't the clip's {tuple(frames.shape)}")
    fps = float(job["fps"])
    n = len(frames)
    span = [int(job["span"][0]), int(job["span"][1])]
    margin = int(job.get("margin", 8))
    s, e = max(0, span[0] - margin), min(n, span[1] + margin)
    faces = face_landmarks(frames, fps, job["models"]["face"])
    track = fill_and_smooth(follow(faces, span[0], job.get("hint")))
    hands = hand_points(frames, fps, job["models"]["hand"]) if models_has(job, "hand") else [[] for _ in range(n)]
    scale = float(job.get("scale", 1.9))
    _, side = face_window(track, [s, e], n, 16, scale)
    cap = int(job.get("size", 832))
    size = cap if job.get("upscale") else int(min(cap, max(512, int(round(side / 16)) * 16)))
    warps, side = face_window(track, [s, e], n, size, scale)
    flags = cv2.INTER_AREA if side > size else cv2.INTER_CUBIC

    def cut(img, i):
        return cv2.warpAffine(np.ascontiguousarray(img), warps[i], (size, size), flags=flags, borderMode=cv2.BORDER_REPLICATE)

    crops = np.stack([cut(cuts[i], i) for i in range(s, e)])
    k_ref, amount = teeth_frame(frames, track, range(s, e))
    if k_ref is None:
        raise RuntimeError("no face in the span")
    np.save(job["out_crops"], crops)
    np.save(job["out_ref"], cut(frames[k_ref], k_ref))
    meta = {"window": [s, e], "span": span, "size": size, "side": side, "warps": {str(i): warps[i].tolist() for i in warps}, "track": {str(i): (None if track[i] is None else track[i].tolist()) for i in range(n)}, "hands": {str(i): [h.tolist() for h in hands[i]] for i in range(n)}}
    with open(job["out_meta"], "w") as f:
        json.dump(meta, f)
    return {"window": [s, e], "size": size, "side": round(side, 1), "scale": scale, "reference": [k_ref, amount], "seconds": round(time.time() - t0, 1)}


def cmd_paste(job):
    """Redrawn face crops (from crop or window) put back: only the mouth area, as sync does (or with `area` "lips" and
    `base`, LatentSync's frames, only the lips and the mouth's opening, onto those). With `lips` their colour is pulled
    back to the original lips', with `patch_dir` the changes are saved as patches, with `score` (and `audio`) the new
    mouths are scored against the speech (and the original ones against `original_audio`)."""
    t0 = time.time()
    frames = np.load(job["frames"])
    n = len(frames)
    fps = float(job.get("fps", 25.0))
    gens_win = np.load(job["crops"])
    with open(job["meta"]) as f:
        meta = json.load(f)
    s, e = meta["window"]
    size = meta["size"]
    if len(gens_win) < e - s:
        raise RuntimeError(f"{len(gens_win)} redrawn crops for {e - s} frames")
    track = [None if meta["track"][str(i)] is None else np.array(meta["track"][str(i)], np.float32) for i in range(n)]
    hands = [[np.array(h, np.float32) for h in meta["hands"][str(i)]] for i in range(n)]
    gens, warps = [None] * n, [None] * n
    for k, i in enumerate(range(s, e)):
        gens[i] = gens_win[k]
        warps[i] = np.array(meta["warps"][str(i)], np.float32)
    span = meta["span"]
    alpha = span_alpha(n, span, int(job.get("fade", 4)))
    region = np.ones((size, size), np.float32)
    area = job.get("area", "mouth")
    base = np.load(job["base"]) if area == "lips" and job.get("base") else None
    if base is not None and base.shape != frames.shape:
        raise RuntimeError(f"the base frames ({tuple(base.shape)}) aren't the clip's ({tuple(frames.shape)})")
    out = composite(frames, gens, track, hands, alpha, warps, region, (size, size), colour=job.get("colour", True), sharpen=job.get("sharpen", True), area=area if base is not None else "mouth", base=base)
    lips_shift = None
    if job.get("lips"):
        out, lips_shift = match_lips(frames, out, track, alpha, fps, job["models"]["face"])
    if job.get("out_frames"):
        np.save(job["out_frames"], out)
    patches = write_patches(job["patch_dir"], frames, out, span, fps, job.get("matrix")) if job.get("patch_dir") else None
    scores = None
    if job.get("score") and job.get("audio") and models_has(job, "syncnet"):
        dev, _ = device_and_dtype()
        want = int(round(n / fps * 16000))

        def heard(p):
            a, r = read_wav(p)
            a = resample(a, r, 16000)
            return np.pad(a, (0, max(0, want - len(a))))[:want]

        scores = {"new": sync_score(job["engine"], job["models"], out, track, heard(job["audio"]), fps, span, dev)}
        if job.get("original_audio"):
            scores["original"] = sync_score(job["engine"], job["models"], frames, track, heard(job["original_audio"]), fps, span, dev)
    inside = slice(max(0, int(span[0])), min(n, int(span[1])))
    changed = int(np.count_nonzero(np.any(out[inside] != frames[inside], axis=-1)))
    return {"frames": n, "window": [s, e], "span": [int(span[0]), int(span[1])], "changed_pixels": changed, "lips_shift_ab": lips_shift, "patches": patches, "scores": scores, "seconds": round(time.time() - t0, 1)}


# ------------------------------------------------------------------ how well a mouth matches its speech


def syncnet_mel(wav16k):
    """LatentSync's SyncNet audio features (configs/audio.yaml: Wav2Lip's mel) without librosa: pre-emphasis 0.97, a
    centred 800-point STFT every 200 samples (Hann, zero padding, as librosa 0.10), 80 Slaney mel bands 55-7600 Hz,
    dB above 1e-5 minus 20, scaled to -4..4. 80 frames a second."""
    from scipy.signal import get_window, lfilter

    sr, n_fft, hop, n_mels, fmin, fmax = 16000, 800, 200, 80, 55.0, 7600.0
    y = lfilter([1, -0.97], [1], wav16k.astype(np.float64))
    y = np.pad(y, n_fft // 2)
    count = 1 + (len(y) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(count)[:, None]
    spec = np.abs(np.fft.rfft(y[idx] * get_window("hann", n_fft, fftbins=True), axis=1)).T  # (bins, frames)

    def hz_to_mel(f):
        f = np.asarray(f, np.float64)
        lin = f / (200.0 / 3)
        return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), lin)

    def mel_to_hz(m):
        m = np.asarray(m, np.float64)
        return np.where(m >= 15.0, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), (200.0 / 3) * m)

    freqs = np.linspace(0, sr / 2, 1 + n_fft // 2)
    edges = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(edges)
    ramps = edges[:, None] - freqs[None, :]
    basis = np.maximum(0, np.minimum(-ramps[:-2] / fdiff[:-1, None], ramps[2:] / fdiff[1:, None]))
    basis *= (2.0 / (edges[2 : n_mels + 2] - edges[:n_mels]))[:, None]
    db = 20 * np.log10(np.maximum(1e-5, basis @ spec)) - 20
    return np.clip(8 * ((db + 100) / 100) - 4, -4, 4).astype(np.float32)


class SyncNet:
    """LatentSync's StableSyncNet: how much a run of 16 mouths (the lower half of 256-pixel aligned faces, 25 a second)
    goes with the 0.65 s of speech under them. Cosine similarity: in sync above 0.5."""

    def __init__(self, engine, path, device):
        import torch
        from omegaconf import OmegaConf
        from latentsync.models.stable_syncnet import StableSyncNet

        cfg = OmegaConf.load(os.path.join(engine, "LatentSync", "configs", "syncnet", "syncnet_16_pixel_attn.yaml"))
        net = StableSyncNet(OmegaConf.to_container(cfg.model))
        net.load_state_dict(torch.load(path, map_location="cpu", weights_only=True)["state_dict"])
        self.half = device.type == "cuda"
        self.net = net.to(device, dtype=torch.float16 if self.half else torch.float32).eval()
        self.device = device

    def __call__(self, faces256, mels):
        """faces256: windows × 16 × 256 × 256 × 3 uint8; mels: windows × 80 × 52. Similarity per window."""
        import torch
        from einops import rearrange

        dt = torch.float16 if self.half else torch.float32
        out = []
        with torch.no_grad():
            for k in range(0, len(faces256), 8):
                f = torch.from_numpy(np.ascontiguousarray(faces256[k : k + 8])).to(self.device).to(dt) / 255.0
                f = (f - 0.5) / 0.5
                f = rearrange(f, "b f h w c -> b (f c) h w")[:, :, 128:, :]
                m = torch.from_numpy(np.ascontiguousarray(mels[k : k + 8])).to(self.device).to(dt).unsqueeze(1)
                v, a = self.net(f, m)
                out.append(torch.nn.functional.cosine_similarity(v, a).float().cpu().numpy())
        return np.concatenate(out)


def sync_score(engine, models, frames, track, audio16k, fps, span, device, step=2, shifts=range(-12, 13, 2)):
    """How well the mouths in the span go with the speech: SyncNet's similarity over 16-frame windows (25 a second) at
    the true timing, and the timing shift (in 12.5 ms steps of the speech) where they'd go best."""
    import cv2

    aligner = Aligner(device)
    s, e = int(span[0]), int(span[1])
    t_start, t_end = s / fps, e / fps
    starts = np.arange(t_start, t_end - 16 / 25 + 1e-6, step / 25)
    if not len(starts):
        return None
    need = sorted({min(e - 1, max(s, int(round((t + k / 25) * fps)))) for t in starts for k in range(16)})
    faces = {}
    last = None
    for i in need:
        lm = track[i] if track[i] is not None else last
        if lm is None:
            continue
        crop, _ = aligner.crop(frames[i], lm)
        faces[i] = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_AREA)
        last = lm
    mel = syncnet_mel(audio16k)
    net = SyncNet(engine, models["syncnet"], device)
    by_shift = {}
    for d in shifts:
        wins, mels = [], []
        for t in starts:
            idx = [min(e - 1, max(s, int(round((t + k / 25) * fps)))) for k in range(16)]
            if any(i not in faces for i in idx):
                continue
            a = int(80.0 * t) + d
            if a < 0 or a + 52 > mel.shape[1]:
                continue
            wins.append(np.stack([faces[i] for i in idx]))
            mels.append(mel[:, a : a + 52])
        if wins:
            by_shift[d] = float(np.mean(net(np.stack(wins), np.stack(mels))))
    if 0 not in by_shift:
        return None
    best = max(by_shift, key=by_shift.get)
    return {"sync": round(by_shift[0], 4), "best": round(by_shift[best], 4), "best_shift_ms": best * 12.5, "windows": len(starts), "by_shift": {str(k): round(v, 4) for k, v in sorted(by_shift.items())}}


def cmd_score(job):
    """How well the mouths in the span go with the speech (SyncNet), for picking among takes and checking a result."""
    t0 = time.time()
    frames = np.load(job["frames"], mmap_mode="r")
    fps = float(job["fps"])
    n = len(frames)
    span = job.get("span") or [0, n]
    audio, rate = read_wav(job["audio"])
    audio = resample(audio, rate, 16000)
    lo, hi = max(0, int(span[0]) - 2), min(n, int(span[1]) + 2)
    sub = np.asarray(frames[lo:hi])
    faces = face_landmarks(sub, fps, job["models"]["face"])
    track_sub = fill_and_smooth(follow(faces, 0, job.get("hint")))
    track = [None] * n
    for k, i in enumerate(range(lo, hi)):
        track[i] = track_sub[k]
    dev, _ = device_and_dtype()

    class Lazy:
        def __getitem__(self, i):
            return np.asarray(frames[i])

    res = sync_score(job["engine"], job["models"], Lazy(), track, audio, fps, span, dev)
    if res is None:
        raise RuntimeError("the span is too short to score (16 frames at least)")
    res["seconds"] = round(time.time() - t0, 1)
    return res


def calibrate(job):
    """Where the nose, lips and chin land in LatentSync's aligned crop with MediaPipe's points (development aid)."""
    frames = np.load(job["frames"], mmap_mode="r")
    fps = float(job["fps"])
    faces = face_landmarks(frames, fps, job["models"]["face"])
    track = fill_and_smooth(follow(faces, 0, None))
    dev, _ = device_and_dtype()
    aligner = Aligner(dev)
    rows = []
    for i in range(0, len(frames), max(1, len(frames) // 12)):
        if track[i] is None:
            continue
        aligner.restorer.p_bias = None
        _, m = aligner.crop(frames[i], track[i], job.get("nose"))
        pts = np.concatenate([track[i], np.ones((len(track[i]), 1), np.float32)], 1) @ m.T
        fh = aligner.face_h
        rows.append({k: round(float(pts[idx, 1] / fh), 3) for k, idx in (("subnasale", SUBNASALE), ("upper_lip", UPPER_LIP), ("lower_lip", LOWER_LIP), ("chin", CHIN))})
    return {"rows": rows, "mean": {k: round(float(np.mean([r[k] for r in rows])), 3) for k in rows[0]} if rows else {}}


COMMANDS = {"selftest": cmd_selftest, "track": cmd_track, "sync": cmd_sync, "crop": cmd_crop, "window": cmd_window, "paste": cmd_paste, "score": cmd_score, "calibrate": calibrate}


def main():
    with open(sys.argv[1]) as f:
        job = json.load(f)
    setup(job["engine"])
    try:
        result = COMMANDS[job["command"]](job)
        result.setdefault("ok", True)
    except Exception as e:
        traceback.print_exc()
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"[:600]}
    with open(job["out"], "w") as f:
        json.dump(result, f)
    log("done", json.dumps(result)[:400])


if __name__ == "__main__":
    main()
