#!/usr/bin/env python3
"""
Finishes the dashboard's "See it work" demos: reads the originals that scripts/assets/showcase.mjs
writes to assets-src/showcase and writes everything the demos load to public/assets/showcase.

  - Variants are aligned to their original (OpenCV ECC on the subject), so the face, the bottle or
    the woman never shifts when one look turns into the next.
  - Retouch ships whole frames, but only the bag (and in the last frame the sweater) differs from
    the original: the colorways are pasted in through a selection made from where they differ.
  - Cast's places are each aligned on her eyes, so every cut keeps the face where it was.
  - Image's 52 worlds are aligned on her silhouette (subject masks from Crackio's vision model,
    in assets-src/showcase/masks/image), so she never jumps as the montage speeds up.
  - Upscale nests each sharper level inside the one before (Poisson-blended, and the sharp level
    gets the same low-frequency correction), so zooming in and out never shows a seam.
  - Product's and Director's stills are their clips' first frames, so a still turns into its
    clip without a jump.
  - Clips are cut and re-encoded small with the bundled ffmpeg (the Angles tour with a keyframe
    every few frames, so dragging scrubs instantly).

Needs Python 3 with opencv-python and numpy, and Node's ffmpeg-static (pnpm install).
Usage: python scripts/assets/showcase-finish.py [demo ...]
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, "assets-src", "showcase")
OUT = os.environ.get("SHOWCASE_OUT") or os.path.join(ROOT, "public", "assets", "showcase")
DEMOS = os.environ.get("SHOWCASE_DATA") or os.path.join(ROOT, "src", "components", "dashboard", "showcase", "demos")
W, H = 720, 900


def ffmpeg_path():
    return subprocess.run(["node", "-p", "require('ffmpeg-static')"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


FF = None


def ff(*args):
    global FF
    FF = FF or ffmpeg_path()
    subprocess.run([FF, "-v", "error", "-y", *args], check=True)


def src(name):
    for ext in (".png", ".mp4"):
        if os.path.exists(os.path.join(SRC, name + ext)):
            return os.path.join(SRC, name + ext)
    raise SystemExit(f"{name} isn't in assets-src/showcase; run scripts/assets/showcase.mjs first")


def load(name, size=(W, H)):
    return cv2.resize(cv2.imread(src(name), cv2.IMREAD_COLOR), size, interpolation=cv2.INTER_AREA)


def save(img, rel, size=None, q=82):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    if rel.endswith(".webp"):
        cv2.imwrite(path, img, [cv2.IMWRITE_WEBP_QUALITY, q])
    else:
        cv2.imwrite(path, img)


def edges(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.GaussianBlur(np.sqrt(gx * gx + gy * gy), (0, 0), 1.5)


def lock(base, img, region, motion=cv2.MOTION_AFFINE):
    """Warp img so `region` (fractions x0, y0, x1, y1) lines up with base."""
    h, w = base.shape[:2]
    x0, y0, x1, y1 = region
    mask = np.zeros((h, w), np.uint8)
    mask[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(edges(base), edges(img), warp, motion, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-7), mask, 5)
    except cv2.error:
        pass
    return cv2.warpAffine(img, warp, (w, h), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)


def variants(demo, base_name, items, region, motion=cv2.MOTION_AFFINE, small=True):
    base = load(base_name)
    save(base, f"{demo}/base.webp")
    if small:
        save(base, f"{demo}/base-sm.webp", (240, 300), 76)
    for key, name in items.items():
        out = lock(base, load(name), region, motion)
        save(out, f"{demo}/{key}.webp")
        if small:
            save(out, f"{demo}/{key}-sm.webp", (240, 300), 76)
    return base


def depth(demo, name):
    d = cv2.imread(os.path.join(SRC, "depth", name + ".png"), cv2.IMREAD_GRAYSCALE)
    cv2.imwrite(os.path.join(OUT, demo, "depth.png"), cv2.resize(d, (256, 320), interpolation=cv2.INTER_AREA))


def silhouette(base, base_mask, img, mask):
    """Warp img so her head and body (from the subject masks) sit exactly where they do in base."""
    h, w = base.shape[:2]
    R = np.zeros((h, w), np.uint8)
    R[int(0.05 * h):int(0.62 * h), int(0.22 * w):int(0.66 * w)] = 255

    def moments(a):
        m = cv2.moments(a * (R > 0))
        return m["m10"] / m["m00"], m["m01"] / m["m00"], np.sqrt(m["m00"])

    (bx, by, bs), (cx, cy, cs) = moments(base_mask), moments(mask)
    k = bs / cs
    warp = np.array([[1 / k, 0, cx - bx / k], [0, 1 / k, cy - by / k]], np.float32)
    try:
        _, warp = cv2.findTransformECC(cv2.GaussianBlur(base_mask, (0, 0), 2), cv2.GaussianBlur(mask, (0, 0), 2), warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 400, 1e-7), R, 5)
    except cv2.error:
        pass
    return cv2.warpAffine(img, warp, (w, h), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)


def image():
    # The first nine are ChatGPT edits (they keep her within a pixel); the rest are Grok's, locked on her silhouette.
    first = {"lavender": "world-lavender", "sahara": "world-sahara", "glacier": "world-glacier", "snow": "world-snow", "paris": "world-paris", "moon": "world-moon", "kyoto": "world-kyoto", "lagoon": "world-lagoon"}
    base = load("image-takes-4")
    out = {"salt": base}
    for key, name in first.items():
        out[key] = lock(base, load(name), (0.28, 0.16, 0.62, 0.82))
    mask = lambda name: cv2.resize(cv2.imread(os.path.join(SRC, "masks", "image", name + ".png"), cv2.IMREAD_GRAYSCALE), (W, H)).astype(np.float32) / 255
    base_mask = mask("base")
    for f in sorted(os.listdir(SRC)):
        if f.startswith("w-") and f.endswith(".png") and f[2:-4] != "redsquare":
            key = f[2:-4]
            out[key] = silhouette(base, base_mask, load(f[:-4]), mask(key))
    for key, img in out.items():
        save(img, f"image/{key}.webp", (448, 560), 74)
        save(img, f"image/{key}-t.webp", (128, 160), 72)


def relight():
    looks = {"left": "rl-left-g", "right": "rl-right-g", "golden": "rl-golden-g", "neon": "rl-neon-g", "noir": "rl-noir", "candle": "rl-candle", "sunset": "rl-sunset", "studio": "rl-studio"}
    variants("relight", "relight-portrait-2", looks, (0.2, 0.05, 0.85, 0.65), cv2.MOTION_EUCLIDEAN, small=False)
    depth("relight", "relight")


def product_stills():
    """
    Step one: every scene locked on the bottle (pd-<scene>-al.png in assets-src/showcase), the
    start frames of Product's clips (showcase.mjs pv-<scene>). Step two is product().
    """
    scenes = {"base": "product-pack-2", "marble": "pd-marble-g", "neon": "pd-neon-g", "splash": "pd-splash-g", "dune": "pd-dune-g", "snow": "pd-snow", "peony": "pd-peony", "beach": "pd-beach", "moss": "pd-moss"}
    base = load("product-pack-2")
    for key, name in scenes.items():
        img = base if key == "base" else lock(base, load(name), (0.28, 0.08, 0.74, 0.92))
        cv2.imwrite(os.path.join(SRC, f"pd-{key}-al.png"), img)


# How a Grok clip's frames sit over the 720 × 900 still it started from: scaled to cover, 5 px off
# the top, and 1.2% larger (measured with ECC). Stills that stand in for a clip get the same.
CLIP_WARP = np.array([[1.0118, 0.0, -4.2464], [0.0, 1.0121, -4.9781]], np.float32)
CLIP_VF = "scale=720:910:flags=lanczos,crop=720:900:0:5"


def clip_still(name, out, size, q=84, at="0"):
    """A clip's frame at `at`, framed like the clip is in the demo."""
    png = os.path.join(OUT, out[:-5] + ".png")
    ff("-ss", at, "-i", src(name), "-frames:v", "1", "-vf", f"{CLIP_VF},scale={size[0]}:{size[1]}:flags=lanczos", png)
    save(cv2.imread(png), out, q=q)
    os.remove(png)


# Grok's 1080p clips from a 4:5 start come back 3:4 with the picture stretched taller; scaling them
# to 4:5 gives the picture back as it was (cropping would keep the stretch).
TRUE_45 = "scale={w}:{h}:flags=lanczos,setsar=1"


def product():
    """Step two: each scene's clip and its first frame, the packshot matched to the clips, the creators' video and posts."""
    for key in ("marble", "splash", "peony", "neon", "snow", "dune", "moss", "beach"):
        name = "pv-neon-r1" if key == "neon" else f"pv-{key}"
        ff("-i", src(name), "-t", "2.4", "-vf", f"{CLIP_VF},scale=512:640:flags=lanczos,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slower", "-crf", "26", "-g", "24", "-movflags", "+faststart", os.path.join(OUT, "product", f"{key}.mp4"))
        clip_still(name, f"product/{key}.webp", (576, 720))
        save(cv2.imread(os.path.join(OUT, "product", f"{key}.webp")), f"product/{key}-t.webp", (64, 80), 80)
    base = cv2.imread(os.path.join(SRC, "pd-base-al.png"))
    base = cv2.warpAffine(base, cv2.invertAffineTransform(CLIP_WARP), (W, H), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    save(base, "product/base.webp", (576, 720), 86)
    # The same bottle in creators' hands: a phone video (9:16) and two posts.
    ff("-ss", "0.2", "-t", "4.2", "-i", src("ugc-hold-clip-1"), "-vf", "scale=360:640:flags=lanczos,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slower", "-crf", "25", "-g", "24", "-movflags", "+faststart", os.path.join(OUT, "product", "ugc.mp4"))
    png = os.path.join(OUT, "product", "ugc.png")
    ff("-ss", "0.2", "-i", src("ugc-hold-clip-1"), "-frames:v", "1", "-vf", "scale=360:640:flags=lanczos", png)
    save(cv2.imread(png), "product/ugc.webp", q=82)
    os.remove(png)
    for key in ("mirror", "cafe"):
        save(load(f"ugc-{key}"), f"product/ugc-{key}.webp", (288, 360), 80)


def director():
    """The two cut-outs (her, and the car's 17 angles in one atlas), the location and its depth, the render and its clip."""
    from PIL import Image

    out = os.path.join(OUT, "director")
    meta = {}

    def trim(im):
        return im.crop(im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())

    im = trim(Image.open(os.path.join(SRC, "dir-woman-1-cut.png")).convert("RGBA"))
    w = round(im.width * 640 / im.height)
    im.resize((w, 640), Image.LANCZOS).save(os.path.join(out, "woman.webp"), quality=88, method=6)
    meta["woman"] = {"w": w, "h": 640}
    # The car, front three-quarter to straight behind (frames of car-orbit-a and -b), each at the same height.
    frames = [trim(Image.open(os.path.join(SRC, "car-frames", f)).convert("RGBA")) for f in sorted(os.listdir(os.path.join(SRC, "car-frames")))]
    cw, ch, th, cols = 490, 150, 140, 5
    rows = (len(frames) + cols - 1) // cols
    atlas = Image.new("RGBA", (cw * cols, ch * rows), (0, 0, 0, 0))
    sizes = []
    for i, fr in enumerate(frames):
        fr = fr.resize((round(fr.width * th / fr.height), th), Image.LANCZOS)
        atlas.alpha_composite(fr, ((i % cols) * cw + (cw - fr.width) // 2, (i // cols) * ch + (ch - fr.height)))
        sizes.append([fr.width, fr.height])
    atlas.save(os.path.join(out, "car.webp"), quality=88, method=6)
    meta["car"] = {"cell": [cw, ch], "cols": cols, "rows": rows, "n": len(frames), "sizes": sizes}
    with open(os.path.join(DEMOS, "director-meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    # The location the set is built from, and its depth (Crackio's depth model).
    save(load("loc-desert-1", (1024, 1280)), "director/loc.webp", q=86)
    d = cv2.imread(os.path.join(SRC, "depth", "loc-desert-1.png"), cv2.IMREAD_GRAYSCALE)
    cv2.imwrite(os.path.join(out, "loc-depth.png"), d)
    # The render (render-hero: the hero frame of the set, guide-hero, made a photograph), alive.
    ff("-t", "3.6", "-i", src("render-hero-life"), "-vf", TRUE_45.format(w=576, h=720) + ",format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slower", "-crf", "23", "-g", "24", "-movflags", "+faststart", os.path.join(out, "render.mp4"))
    png = os.path.join(out, "render.png")
    ff("-i", src("render-hero-life"), "-frames:v", "1", "-vf", TRUE_45.format(w=720, h=900), png)
    save(cv2.imread(png), "director/render.webp", q=86)
    os.remove(png)


def upscale():
    """Three levels, each nested in the one before: the landscape, the deer, its eye."""

    def clone(base, patch, box):
        # Poisson-blend the patch in, and give the sharp patch the same low-frequency correction, so
        # it matches the blended picture exactly wherever it's drawn on top of it.
        x0, y0, w, h = box
        small = cv2.resize(patch, (w, h), interpolation=cv2.INTER_AREA)
        mask = np.zeros((h, w), np.uint8)
        b = max(3, w // 14)
        mask[b:h - b, b:w - b] = 255
        out = cv2.seamlessClone(small, base, mask, (x0 + w // 2, y0 + h // 2), cv2.NORMAL_CLONE)
        diff = cv2.GaussianBlur(out[y0:y0 + h, x0:x0 + w].astype(np.float32) - small.astype(np.float32), (0, 0), max(2, w / 30))
        fixed = np.clip(patch.astype(np.float32) + cv2.resize(diff, (patch.shape[1], patch.shape[0]), interpolation=cv2.INTER_CUBIC), 0, 255).astype(np.uint8)
        return out, fixed

    L0, L1, L2 = cv2.imread(src("up-wide-4")), cv2.imread(src("up-l1-g1")), cv2.imread(src("up-l2-c"))
    H0, W0 = L0.shape[:2]
    # Where the deer is in the landscape, and its eye in the deer (px of each original).
    C1 = (820, 1125, 144, 180)
    C2 = (901, 922, 160, 200)
    L1, L2 = clone(L1, L2, C2)
    L0, L1c = clone(L0, L1, C1)
    x0, y0, w, h = C2
    corr = cv2.resize((L1c.astype(np.float32) - L1.astype(np.float32))[y0:y0 + h, x0:x0 + w], (L2.shape[1], L2.shape[0]), interpolation=cv2.INTER_CUBIC)
    L2 = np.clip(L2.astype(np.float32) + corr, 0, 255).astype(np.uint8)
    L1 = L1c
    save(L0, "upscale/l0.webp", (888, 1110), 84)
    save(L0, "upscale/l0-lo.webp", (296, 370), 92)
    save(L1, "upscale/l1.webp", (720, 900), 84)
    save(L1, "upscale/l1-lo.webp", (273, 341), 92)
    save(L2, "upscale/l2.webp", (720, 900), 86)
    H1, W1 = L1.shape[:2]
    with open(os.path.join(DEMOS, "upscale-meta.json"), "w") as f:
        json.dump({"c1": [C1[0] / W0, C1[1] / H0, C1[2] / W0, C1[3] / H0], "c2": [C2[0] / W1, C2[1] / H1, C2[2] / W1, C2[3] / H1]}, f, indent=1)


def selection(base, others, region, hole=2500):
    """Where `others` differ from `base` inside `region`: blobs, gaps closed, small holes filled."""
    h, w = base.shape[:2]
    lab_b = cv2.GaussianBlur(cv2.cvtColor(base, cv2.COLOR_BGR2LAB).astype(np.float32), (0, 0), 1.2)
    acc = np.zeros((h, w), np.float32)
    for o in others:
        lab_o = cv2.GaussianBlur(cv2.cvtColor(o, cv2.COLOR_BGR2LAB).astype(np.float32), (0, 0), 1.2)
        acc = np.maximum(acc, np.sqrt(((lab_b - lab_o) ** 2).sum(axis=2)))
    x0, y0, x1, y1 = region
    roi = np.zeros((h, w), np.uint8)
    roi[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = 1
    m = ((acc > 18) & (roi > 0)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] > 300:
            keep[lab == i] = 1
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, _ = cv2.connectedComponentsWithStats((1 - keep).astype(np.uint8), 4)
    for i in range(1, n):
        x, y, ww, hh, area = st[i]
        if area < hole and x > 0 and y > 0 and x + ww < w and y + hh < h:
            keep[lab == i] = 1
    return keep


def curve(pts, w, h):
    """A closed Catmull-Rom spline through the points, as cubic Béziers in the 100 × 125 viewBox."""
    p = [(x / w * 100, y / h * 125) for x, y in pts]
    n = len(p)
    out = [f"M{p[0][0]:.2f} {p[0][1]:.2f}"]
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append(f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}")
    return " ".join(out) + " Z"


def outline(mask, eps, smooth=5):
    """
    The selection's outline as SVG path data in the card's 100 × 125 viewBox: the shape rounded off
    first (stray hair and noise along the edge would make it look traced by a machine), then drawn
    as one smooth curve.
    """
    h, w = mask.shape
    m = (mask * 255).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (smooth, smooth))
    m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k)
    m = ((cv2.GaussianBlur(m.astype(np.float32), (0, 0), smooth / 2) > 127) * 255).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    parts = []
    for c in sorted(cnts, key=cv2.contourArea, reverse=True):
        if cv2.contourArea(c) < 200:
            continue
        pts = c[:, 0, :].astype(np.float32)
        r = max(2, smooth)
        ker = np.ones(2 * r + 1) / (2 * r + 1)
        pts = np.stack([np.convolve(np.concatenate([pts[-r:, i], pts[:, i], pts[:r, i]]), ker, "valid") for i in (0, 1)], 1).astype(np.float32)
        a = cv2.approxPolyDP(pts.reshape(-1, 1, 2), eps, True)[:, 0, :]
        parts.append(curve(a, w, h))
    return " ".join(parts)


def retouch():
    base = load("retouch-base-1")
    names = {"red": "rt-red-g", "emerald": "rt-emerald-g", "cobalt": "rt-cobalt-g", "blush": "rt-blush-g", "black": "rt-black", "butter": "rt-butter", "lilac": "rt-lilac"}
    bags = {k: lock(base, load(v), (0.5, 0.38, 0.98, 0.84)) for k, v in names.items()}
    bag = selection(base, list(bags.values()), (0.48, 0.36, 0.99, 0.84))
    sw = lock(base, load("rt-sweater"), (0.0, 0.3, 0.6, 0.85))
    sweater = selection(base, [sw], (0.0, 0.25, 0.75, 1.0), hole=6000) & (1 - cv2.dilate(bag, np.ones((5, 5), np.uint8)))
    feather = lambda m: cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.4)[..., None]
    fb, fs = feather(bag), feather(sweater)
    save(base, "retouch/f-camel.webp")
    for k, v in bags.items():
        save((base * (1 - fb) + v * fb).astype(np.uint8), f"retouch/f-{k}.webp")
    red = base * (1 - fb) + bags["red"] * fb
    save((red * (1 - fs) + sw * fs).astype(np.uint8), "retouch/f-red-sweater.webp")
    depth("retouch", "retouch")
    # The outlines and the points the pointer taps, for the script (retouch-meta.json).
    d = cv2.imread(os.path.join(SRC, "depth", "retouch.png"), cv2.IMREAD_GRAYSCALE)
    meta = {}
    for name, m, eps, smooth in (("bag", bag, 0.8, 3), ("sweater", sweater, 1.6, 11)):
        ys, xs = np.nonzero(m)
        cx, cy = xs.mean() / W, ys.mean() / H
        meta[name] = {"path": outline(m, eps, smooth), "cx": cx * 100, "cy": cy * 100, "x0": xs.min() / W * 100, "y0": ys.min() / H * 100, "x1": xs.max() / W * 100, "y1": ys.max() / H * 100,
                      "depth": float(d[int(cy * d.shape[0]), int(cx * d.shape[1])] / 255)}
    with open(os.path.join(DEMOS, "retouch-meta.json"), "w") as f:
        json.dump(meta, f)


def eyes(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml").detectMultiScale(g, 1.1, 6, minSize=(120, 120))
    if not len(faces):
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    roi = g[y:y + h // 2 + h // 8, x:x + w]
    es = sorted(cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml").detectMultiScale(roi, 1.05, 8, minSize=(w // 10, w // 10)), key=lambda e: e[2] * e[3], reverse=True)[:2]
    if len(es) < 2:
        return (x + w / 2, y + h * 0.42, w)
    (ax, ay, aw, ah), (bx, by, bw, bh) = sorted(es, key=lambda e: e[0])
    l = np.array([x + ax + aw / 2, y + ay + ah / 2])
    r = np.array([x + bx + bw / 2, y + by + bh / 2])
    return ((l[0] + r[0]) / 2, (l[1] + r[1]) / 2, np.linalg.norm(r - l) * 2.6)


def cast():
    shots = {"selfie": "cast-a-2", "tokyo": "cs-tokyo-g", "paris": "cs-paris-g", "seventies": "cs-70s-g-1", "snow": "cs-snow-g-1", "mars": "cs-mars", "ibiza": "cs-ibiza", "kyoto": "cs-kyoto", "gala": "cs-gala2"}
    for key, name in shots.items():
        full = cv2.imread(src(name))
        k0 = full.shape[1] / W
        e = eyes(cv2.resize(full, (W, round(full.shape[0] / k0)), interpolation=cv2.INTER_AREA))
        if e is None:
            raise SystemExit(f"no face found in {name}")
        ex, ey, ew = e[0] * k0, e[1] * k0, e[2] * k0
        # A medium framing: eyes at 35% height, the face about 55% of the width (never past the photo's edges).
        s = max(W * 0.55 / ew, W / full.shape[1], H / full.shape[0])
        M = np.float32([[s, 0, W * 0.5 - ex * s], [0, s, H * 0.35 - ey * s]])
        out = cv2.warpAffine(full, M, (W, H), flags=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        save(out, f"cast/{key}.webp")
        save(out, f"cast/{key}-sm.webp", (240, 300), 76)
    sheet = cv2.imread(src("cs-sheet-g-1"))
    save(sheet, "cast/sheet.webp", (720, round(sheet.shape[0] * 720 / sheet.shape[1])))
    selfie = load("cast-a-2")
    save(selfie[:W, :], "cast/avatar.webp", (96, 96), 80)


def clip(src_name, out, size, crf=26, keyint=48, extra=()):
    ff("-i", src(src_name), *extra, "-vf", f"scale={size[0]}:{size[1]}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slower", "-crf", str(crf), "-g", str(keyint), "-an", "-movflags", "+faststart", os.path.join(OUT, out))


def video():
    for key, name in (("orbit", "vid-orbit"), ("push", "vid-push"), ("crane", "vid-crane"), ("pull", "vid-pull")):
        clip(name, f"video/{key}.mp4", (512, 640))
    ff("-i", src("vid-orbit"), "-vf", "select=eq(n\\,0),scale=720:900:flags=lanczos", "-frames:v", "1", os.path.join(OUT, "video", "first.png"))
    first = cv2.imread(os.path.join(OUT, "video", "first.png"))
    os.remove(os.path.join(OUT, "video", "first.png"))
    save(first, "video/first.webp", q=84)


def angles():
    # One continuous move: front → side (0–6 s), side → rear (6–11.2 s), up to overhead (11.2–17.2 s).
    ff("-i", src("car-orbit-a"), "-i", src("car-orbit-b"), "-i", src("car-top-b"), "-filter_complex",
       "[0:v]trim=0:6.0,setpts=PTS-STARTPTS,scale=432:540:flags=lanczos,setsar=1,fps=24[a];"
       "[1:v]trim=0:5.2,setpts=PTS-STARTPTS,scale=432:540:flags=lanczos,setsar=1,fps=24[b];"
       "[2:v]trim=0:6.0,setpts=PTS-STARTPTS,scale=432:540:flags=lanczos,setsar=1,fps=24[c];"
       "[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]",
       "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-g", "6", "-bf", "0", "-an", "-movflags", "+faststart", os.path.join(OUT, "angles", "tour.mp4"))
    save(load("car-2"), "angles/first.webp", q=84)


def motion():
    """The product photo, the six shots of the ad (Grok clips, the sunglasses always whole), the ad itself, the backdrop."""
    from PIL import Image

    im = Image.open(src("sunglasses-cut")).convert("RGBA")
    im = im.crop(im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())
    im.thumbnail((520, 520))
    im.save(os.path.join(OUT, "motion", "sunglasses.webp"), quality=88)
    # Sky · Splash · Deck · Sand · Walk · Towel, cut on the beat (each from a 1080p clip, back to true 4:5).
    shots = (("mv2-sky", 0.2, 1.2, 0.7), ("mv2-splash", 0.1, 1.1, 0.6), ("mv2-boat", 0.5, 1.15, 1.0), ("mv2-sand", 0.4, 1.1, 0.9), ("mv2-walk", 0.6, 1.25, 1.1), ("mv2-towel", 0.4, 1.3, 0.9))
    parts = []
    for i, (name, ss, t, still) in enumerate(shots):
        part = os.path.join(OUT, "motion", f"part-{i}.mp4")
        ff("-ss", str(ss), "-t", str(t), "-i", src(name), "-vf", TRUE_45.format(w=512, h=640) + ",fps=24,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-g", "24", "-threads", "2", part)
        parts.append(part)
        png = os.path.join(OUT, "motion", f"shot-{i}.png")
        ff("-ss", str(still), "-i", src(name), "-frames:v", "1", "-vf", TRUE_45.format(w=384, h=480), png)
        save(cv2.imread(png), f"motion/shot-{i}.webp", q=82)
        os.remove(png)
    # One part at a time, then joined: decoding six 1080p clips at once runs this machine out of memory.
    lst = os.path.join(OUT, "motion", "parts.txt")
    with open(lst, "w") as f:
        f.write("\n".join(f"file '{p.replace(os.sep, '/')}'" for p in parts))
    ff("-f", "concat", "-safe", "0", "-i", lst, "-c:v", "libx264", "-preset", "slower", "-crf", "25", "-g", "24", "-threads", "2", "-an", "-movflags", "+faststart", os.path.join(OUT, "motion", "ad.mp4"))
    for p in parts + [lst]:
        os.remove(p)
    png = os.path.join(OUT, "motion", "backdrop.png")
    ff("-ss", "0.5", "-i", src("mv-pool"), "-frames:v", "1", "-vf", "scale=360:-2,crop=360:450,gblur=sigma=14", png)
    save(cv2.imread(png), "motion/backdrop.webp", q=70)
    os.remove(png)


def recast():
    ff("-i", src("recast-clip"), "-i", src("rc-red"), "-i", src("rc-gold"), "-i", src("rc-night"), "-filter_complex",
       "[0:v]scale=352:446,setsar=1[a];[1:v]scale=352:446,setsar=1[b];[2:v]scale=352:446,setsar=1[c];[3:v]scale=352:446,setsar=1[d];[a][b][c][d]hstack=inputs=4,format=yuv420p[v]",
       "-map", "[v]", "-c:v", "libx264", "-preset", "slower", "-crf", "27", "-g", "48", "-an", "-movflags", "+faststart", os.path.join(OUT, "recast", "quad.mp4"))
    png = os.path.join(OUT, "recast", "first.png")
    ff("-i", src("recast-clip"), "-vf", "select=eq(n\\,0),scale=720:910,crop=720:900", "-frames:v", "1", png)
    save(cv2.imread(png), "recast/first.webp", q=84)
    os.remove(png)


def storyboard():
    """One line, six shots of the same woman (the bloom story): pencil panels, frames, and the film cut from their 1080p clips."""
    for i in range(1, 7):
        save(load(f"bloom-{i}", (288, 360)), f"storyboard/frame-{i}.webp")
        sketch = cv2.cvtColor(cv2.cvtColor(load(f"bloom-{i}-sketch", (288, 360)), cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
        save(sketch, f"storyboard/sketch-{i}.webp", q=80)
    cuts = ((0.3, 1.0), (0.5, 1.0), (0.8, 1.0), (1.0, 1.25), (1.0, 1.25), (0.6, 1.4))
    parts = []
    for i, (ss, t) in enumerate(cuts, 1):
        part = os.path.join(OUT, "storyboard", f"part-{i}.mp4")
        ff("-ss", str(ss), "-t", str(t), "-i", src(f"bloom-{i}-clip"), "-vf", TRUE_45.format(w=576, h=720) + ",fps=24,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-g", "24", "-threads", "2", part)
        parts.append(part)
    lst = os.path.join(OUT, "storyboard", "parts.txt")
    with open(lst, "w") as f:
        f.write("\n".join(f"file '{p.replace(os.sep, '/')}'" for p in parts))
    ff("-f", "concat", "-safe", "0", "-i", lst, "-c:v", "libx264", "-preset", "slower", "-crf", "23", "-g", "24", "-threads", "2", "-an", "-movflags", "+faststart", os.path.join(OUT, "storyboard", "film.mp4"))
    for p in parts + [lst]:
        os.remove(p)
    png = os.path.join(OUT, "storyboard", "film-first.png")
    ff("-i", os.path.join(OUT, "storyboard", "film.mp4"), "-frames:v", "1", png)
    save(cv2.imread(png), "storyboard/film-first.webp", q=84)
    os.remove(png)


def tries():
    """The pictures a demo hands its tool when you open it (ShowcaseRail)."""
    for key, name, width in (("retouch", "retouch-base-1", 1120), ("relight", "relight-portrait-2", 1120), ("product", "product-pack-2", 1120), ("angles", "car-2", 1120),
                             ("video", "video-still-4", 1120), ("director", "dir-woman-1", 792)):
        img = cv2.imread(src(name))
        save(img, f"try/{key}.webp", (width, round(img.shape[0] * width / img.shape[1])), 88)
    # Upscale's: the deer exactly as small as the landscape has it, to upscale yourself.
    save(cv2.imread(src("up-wide-4"))[1125:1305, 820:964], "try/upscale.webp", q=92)


TASKS = {f.__name__: f for f in (image, relight, product_stills, product, retouch, cast, director, upscale, video, angles, motion, recast, storyboard, tries)}

if __name__ == "__main__":
    for name in sys.argv[1:] or list(TASKS):
        os.makedirs(os.path.join(OUT, {"tries": "try", "product_stills": "product"}.get(name, name)), exist_ok=True)
        TASKS[name]()
        print("finished", name)
