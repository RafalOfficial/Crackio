"""
Download every model the named official ComfyUI templates list into ComfyUI's model folders.

Files come straight from Hugging Face's CDN in parallel byte ranges (16 at a time): one connection
from this box tops out around 3 MB/s, and anonymous Xet transfers stall after a GB or two. Files
already in place are skipped; a file is only moved into place once every byte arrived and its
SHA-256 matches the one Hugging Face lists.
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

D = "/venv/main/lib/python3.12/site-packages/comfyui_workflow_templates_json/templates"
MODELS = "/workspace/ComfyUI/models"
LOG = "/workspace/crackio/downloads.log"
WORKERS = 16
CHUNK = 64 * 1024 * 1024
TOKEN = os.environ.get("HF_TOKEN", "").strip()


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def collect(node, acc):
    if isinstance(node, dict):
        for m in (node.get("properties", {}) or {}).get("models", []) or []:
            if m.get("url") and m.get("directory") and m.get("name"):
                acc.setdefault((m["directory"], m["name"]), m["url"])
        for v in node.values():
            collect(v, acc)
    elif isinstance(node, list):
        for v in node:
            collect(v, acc)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def resolve(url):
    """The signed CDN link, total size and SHA-256 (LFS files' ETag) behind a /resolve/ URL."""
    req = urllib.request.Request(url, method="HEAD", headers={"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        res = opener.open(req, timeout=30)
        headers = res.headers
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 307, 308):
            raise
        headers = e.headers
    size = int(headers.get("X-Linked-Size") or headers.get("Content-Length") or 0)
    sha = (headers.get("X-Linked-ETag") or "").strip('"')
    return headers.get("Location") or url, size, sha if re.fullmatch(r"[0-9a-f]{64}", sha) else None


def fetch_range(state, start, end, fd, done):
    last = None
    for attempt in range(1, 9):
        got = 0
        try:
            req = urllib.request.Request(state["cdn"], headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=60) as res:
                if res.status != 206:
                    raise IOError(f"status {res.status}")
                pos = start
                while True:
                    block = res.read(1024 * 1024)
                    if not block:
                        break
                    os.pwrite(fd, block, pos)
                    pos += len(block)
                    got += len(block)
                    with state["lock"]:
                        state["got"] += len(block)
                if pos != end + 1:
                    raise IOError(f"short read {pos - start} of {end - start + 1}")
                done.append((start, end))
                return
        except Exception as e:  # expired link, dropped connection: re-resolve and retry this range
            last = e
            with state["lock"]:
                state["got"] -= got
            if attempt >= 2:
                try:
                    state["cdn"] = resolve(state["url"])[0]
                except Exception:
                    pass
            time.sleep(min(30, 3 * attempt))
    raise IOError(f"range {start}-{end} failed: {last}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(16 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def download(url, target):
    cdn, size, sha = resolve(url)
    if not size:
        raise IOError("Hugging Face didn't say how big the file is (gated or missing?)")
    part = target + ".part"
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd = os.open(part, os.O_RDWR | os.O_CREAT, 0o644)
    os.ftruncate(fd, size)
    state = {"url": url, "cdn": cdn, "got": 0, "lock": threading.Lock()}
    ranges = [(s, min(size - 1, s + CHUNK - 1)) for s in range(0, size, CHUNK)]
    done = []
    t0 = time.time()
    stop = threading.Event()

    def report():
        while not stop.wait(30):
            gb = state["got"] / 1e9
            log(f"     {gb:.1f} of {size / 1e9:.1f} GB, {state['got'] / 1e6 / max(1, time.time() - t0):.0f} MB/s")

    threading.Thread(target=report, daemon=True).start()
    try:
        with ThreadPoolExecutor(WORKERS) as pool:
            for f in [pool.submit(fetch_range, state, s, e, fd, done) for s, e in ranges]:
                f.result()
    finally:
        stop.set()
        os.close(fd)
    if len(done) != len(ranges):
        raise IOError("some ranges are missing")
    if sha and sha256(part) != sha:
        os.remove(part)
        raise IOError("SHA-256 mismatch")
    os.replace(part, target)
    return size, time.time() - t0


def main(names):
    wanted = {}
    for name in names:
        with open(os.path.join(D, name + ".json"), encoding="utf-8") as f:
            collect(json.load(f), wanted)
    for (directory, fname), url in wanted.items():
        target = os.path.join(MODELS, directory, fname)
        if os.path.exists(target):
            log(f"have {directory}/{fname}")
            continue
        if not url.startswith("https://huggingface.co/"):
            log(f"SKIP (not on HF): {url}")
            continue
        log(f"get  {directory}/{fname}")
        for attempt in range(1, 4):
            try:
                size, secs = download(url, target)
                log(f"done {directory}/{fname}: {size / 1e9:.2f} GB in {secs:.0f} s ({size / 1e6 / max(1, secs):.0f} MB/s)")
                break
            except Exception as e:
                log(f"     attempt {attempt} failed: {str(e)[:200]}")
                time.sleep(15)
        else:
            log(f"FAIL {directory}/{fname}")
    log("all done: " + " ".join(names))


if __name__ == "__main__":
    main(sys.argv[1:])
