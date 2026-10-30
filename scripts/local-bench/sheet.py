# Contact sheet of the bench's picture outputs: one row per model, labelled. Usage: python sheet.py out.jpg [model ...]
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "..", "..", "data", "media")
results = json.load(open(os.path.join(HERE, "results.json"), encoding="utf8"))
out = sys.argv[1]
only = sys.argv[2:]
H = 300
font = ImageFont.load_default(size=16)
rows = []
for mid, r in results.items():
    if mid.startswith("__") or (only and mid not in only):
        continue
    tiles = []
    for run in r.get("runs", []):
        if not run.get("ok"):
            continue
        for url in run.get("outputs", [])[:1]:
            path = os.path.join(MEDIA, url.split("/")[-1])
            if not os.path.exists(path) or not path.lower().endswith((".png", ".jpg", ".webp")):
                continue
            im = Image.open(path).convert("RGB")
            im = im.resize((max(1, int(im.width * H / im.height)), H))
            tiles.append((im, f"{run['job']} {round(run.get('wall', 0))}s"))
    if tiles:
        rows.append((f"{r['name']} ({r['variant']})", tiles))
if not rows:
    sys.exit("nothing to show")
W = max(sum(t.width + 8 for t, _ in tiles) for _, tiles in rows) + 8
sheet = Image.new("RGB", (W, len(rows) * (H + 34) + 8), (18, 16, 20))
d = ImageDraw.Draw(sheet)
y = 8
for name, tiles in rows:
    d.text((8, y), name, fill=(240, 239, 237), font=font)
    x = 8
    for im, label in tiles:
        sheet.paste(im, (x, y + 22))
        d.text((x + 6, y + 26), label, fill=(255, 210, 120), font=font)
        x += im.width + 8
    y += H + 34
sheet.save(out, quality=82)
print(out, sheet.size)
