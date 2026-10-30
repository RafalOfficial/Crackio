#!/usr/bin/env python3
"""
Watches vast.ai for an on-demand RTX 5090 that fits Crackio's ComfyUI box, rents it and keeps the
first one that comes up.

  - Fits: one RTX 5090 with at least 124 GB of disk (rented at 124 GB), 60 GB of system RAM and
    250/250 Mb/s, verified or not, for at most $0.711/h with the 124 GB of storage included, and
    at most $4.01 per TB of download and of upload. It skips hosts in China (Docker Hub and Hugging
    Face are often blocked there) and 5090s that vast measured far below normal (DLPerf under 120;
    a healthy one scores 160-200).
  - Rents vast's official ComfyUI template, looked up on every run so template updates carry over.
    Its image needs CUDA 13.2; hosts on CUDA 12.8 to 13.1 get the same ComfyUI release's cuda-12.9
    build (vast publishes both, and that one's PyTorch is built for CUDA 12.8), so they qualify too.
  - The cheapest fit wins, unless a European host is within 3 cents an hour (we're on CET).
  - A box is ready once SSH logs in, the GPU shows up and ComfyUI's API answers. With --race N it
    keeps up to N boxes booting on different hosts, keeps the first one that's ready and destroys
    the rest. A box whose container fails to start is destroyed, its host is skipped from then on
    (data/gpu/vast-skip.json), and the next fit is rented in its place. So is a box still booting
    (rented under 30 minutes ago) that shows no sign of life 4 minutes after the rent, sits on one
    status for 10 minutes before it runs, or isn't ready 30 minutes after the rent. (Boxes that
    never start cost next to nothing: three of them took $0.03 of credit.)
  - With --switch-below PRICE the first box that's ready is kept even above PRICE, the hunt goes
    on for boxes at most PRICE/h, and the first of those that's ready replaces it (the kept box is
    destroyed, with whatever was on it).
  - Instances labelled crackio-comfy count as ours: a re-run adopts them instead of renting more.
    A rent that comes back over the price cap is destroyed at once.
  - When a box is ready it writes data/gpu/vast-instance.json and a `crackio-gpu` host in
    ~/.ssh/config, checks that the alias logs in, and exits. Re-running it then just refreshes both.

Needs the vastai CLI with an API key (pip install vastai, then vastai set api-key KEY).
Usage: python scripts/gpu/vast-monitor.py [--race 2] [--switch-below 0.579] [--skip-machine ID ...] [--dry-run] [--once]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "data", "gpu")
STATE = os.path.join(OUT, "vast-instance.json")
SKIP = os.path.join(OUT, "vast-skip.json")
LOG = os.path.join(OUT, "vast-monitor.log")
SSH_DIR = os.path.join(os.path.expanduser("~"), ".ssh")
KNOWN_HOSTS = os.path.join(SSH_DIR, "known_hosts_vast")

GPU = "RTX 5090"
DISK_GB = 124
MIN_RAM_GB = 60
MIN_MBPS = 250
MAX_DPH = 0.711
MAX_TB_COST = 4.01  # $ per TB of download, and of upload
MIN_DLPERF = 120  # one 5090 scoring 55 had a third of the normal memory bandwidth
NO_COUNTRIES = {"CN"}  # the one CN box never got past "creating"
MIN_DAYS = 1  # skip hosts whose listing ends within a day
FALLBACK_CUDA = 12.9  # the other CUDA vast builds its ComfyUI image on
MIN_CUDA = 12.8  # that build's PyTorch is cu128, so 12.8 drivers run it
EUROPE_MARGIN = 0.03
EUROPE = set("AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LI LT LU LV MT NL NO PL PT RO RS SE SI SK".split())
LABEL = "crackio-comfy"
SSH_ALIAS = "crackio-gpu"
SSH_KEY = "~/.ssh/id_ed25519"
COMFY_PORT = 18188  # ComfyUI inside the box; the template's 8188 is Caddy with auth in front of it
STALL_MIN = 4  # a working host shows signs of life within a minute or two of the rent
OFFLINE_MIN = 3  # a host vast reports offline this long isn't coming back soon
QUIET_MIN = 10  # one unchanged status this long before the box runs means it's stuck
BOOT_MIN = 30  # rent to ready
# vast's official ComfyUI template on 2026-10-22, used only if the lookup fails
PINNED_TEMPLATE = {"hash_id": "72d536162ab79d0a192364fbbde69715", "image": "vastai/comfy",
                   "tag": "v0.41.0-cuda-13.2-py312", "cuda": 13.2}


class VastError(Exception):
    pass


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run_vast(args):
    exe = shutil.which("vastai")
    if not exe:
        sys.exit("vastai CLI not found (pip install vastai)")
    try:
        return subprocess.run([exe, *args], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env={**os.environ, "NO_COLOR": "1"}, timeout=120)
    except subprocess.TimeoutExpired:
        raise VastError(f"vastai {' '.join(args[:2])} timed out")


def vast(*args):
    p = run_vast([*args, "--raw"])
    try:
        return json.loads(p.stdout)
    except ValueError:
        raise VastError(" ".join(f"{p.stdout} {p.stderr}".split())[-400:] or f"exit code {p.returncode}")


def num(row, key):
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def load_skip():
    try:
        with open(SKIP, encoding="utf-8") as f:
            return {int(k): v for k, v in json.load(f).items()}
    except (OSError, ValueError):
        return {}


def save_skip(skip):
    """Merges into the file, so hosts added to it by hand while this runs aren't lost."""
    merged = {**load_skip(), **skip}
    with open(SKIP, "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in sorted(merged.items())}, f, indent=2)


def official_template():
    try:
        rows = vast("search", "templates", "recommended==True")
        rows = rows if isinstance(rows, list) else rows.get("templates") or []
        t = next(t for t in rows if t.get("name") == "ComfyUI" and t.get("image") == "vastai/comfy")
        filters = t.get("extra_filters") or {}
        filters = json.loads(filters) if isinstance(filters, str) else filters
        cuda = float((filters.get("cuda_max_good") or {}).get("gte") or 0)
        return {"hash_id": t["hash_id"], "image": t["image"], "tag": t["tag"], "cuda": cuda}
    except (VastError, StopIteration, KeyError, TypeError, ValueError) as e:
        log(f"template lookup failed ({e}), using the pinned one")
        return dict(PINNED_TEMPLATE)


def fallback_image(tpl):
    """The template's ComfyUI release built on CUDA 12.9, for drivers that stop short of the template's CUDA."""
    if tpl["cuda"] <= FALLBACK_CUDA:
        return None
    tag = re.sub(r"cuda-[0-9.]+", f"cuda-{FALLBACK_CUDA}", tpl["tag"])
    url = f"https://hub.docker.com/v2/repositories/{tpl['image']}/tags/{tag}"
    try:
        try:
            import requests  # certifi's CAs: urllib with Windows' store fails on Docker Hub's chain
            requests.get(url, timeout=20).raise_for_status()
        except ImportError:
            urllib.request.urlopen(url, timeout=20).close()
        return f"{tpl['image']}:{tag}"
    except Exception as e:  # any failure means the tag can't be counted on
        log(f"{tpl['image']}:{tag} isn't available ({e}); only CUDA {tpl['cuda']} hosts qualify")
        return None


def image_for(o, tpl, fb):
    """None keeps the template's image; hosts below its CUDA get the CUDA 12.9 build."""
    return None if num(o, "cuda_max_good") >= tpl["cuda"] else fb


def fits(o, min_cuda, cap):
    return (o.get("gpu_name") == GPU and o.get("num_gpus") == 1
            and num(o, "disk_space") >= DISK_GB and num(o, "cpu_ram") >= MIN_RAM_GB * 1000
            and num(o, "inet_down") >= MIN_MBPS and num(o, "inet_up") >= MIN_MBPS
            and 0 < num(o, "dph_total") <= cap and num(o, "cuda_max_good") >= min_cuda
            and num(o, "inet_down_cost") * 1000 <= MAX_TB_COST and num(o, "inet_up_cost") * 1000 <= MAX_TB_COST
            and not 0 < num(o, "dlperf") < MIN_DLPERF and country(o) not in NO_COUNTRIES
            and num(o, "duration") >= MIN_DAYS * 86400
            and o.get("rentable", True) and not o.get("rented", False))


def search(min_cuda, cap):
    query = (f"gpu_name={GPU.replace(' ', '_')} num_gpus=1 disk_space>={DISK_GB} cpu_ram>={MIN_RAM_GB} "
             f"inet_down>={MIN_MBPS} inet_up>={MIN_MBPS} dph<={cap} cuda_vers>={min_cuda} "
             f"duration>={MIN_DAYS} compute_cap>=800 verified=any rentable=true rented=false")
    rows = vast("search", "offers", query, "--type", "on-demand", "--storage", str(DISK_GB), "-o", "dph",
                "--limit", "300")
    if not isinstance(rows, list):
        raise VastError(f"unexpected search reply: {str(rows)[:200]}")
    # vast's dph filter can leave out the storage share of the price, so every bound is checked again
    return sorted((o for o in rows if fits(o, min_cuda, cap)), key=lambda o: o["dph_total"])


def country(o):
    return (o.get("geolocation") or "").rsplit(",", 1)[-1].strip().upper()


def ranked(fit):
    """Cheapest first, but the cheapest European host within EUROPE_MARGIN of it goes ahead."""
    if not fit:
        return fit
    first = next((o for o in fit if country(o) in EUROPE
                  and o["dph_total"] <= fit[0]["dph_total"] + EUROPE_MARGIN), fit[0])
    return [first] + [o for o in fit if o is not first]


def describe(o):
    reliability = num(o, "reliability2") or num(o, "reliability")
    verification = o.get("verification") or ("verified" if o.get("verified") else "unverified")
    return (f"offer {o['id']} ${o['dph_total']:.3f}/h {o.get('geolocation') or '?'}, "
            f"{num(o, 'cpu_ram') / 1000:.0f} GB RAM, {num(o, 'disk_space'):.0f} GB disk, "
            f"{num(o, 'inet_down'):.0f}/{num(o, 'inet_up'):.0f} Mb/s, CUDA {num(o, 'cuda_max_good')}, "
            f"{verification}, reliability {reliability:.3f}")


def our_instances():
    rows = vast("show", "instances")
    rows = rows if isinstance(rows, list) else rows.get("instances") or []
    return [i for i in rows if i.get("label") == LABEL]


def show(iid):
    r = vast("show", "instance", str(iid))
    return r if isinstance(r, dict) and r.get("id") else None


def rent(o, tpl, image):
    args = ["create", "instance", str(o["id"]), "--template_hash", tpl["hash_id"],
            "--disk", str(DISK_GB), "--label", LABEL, "--cancel-unavail"]
    if image:
        args += ["--image", image]
    r = vast(*args)
    if not (isinstance(r, dict) and r.get("success") and r.get("new_contract")):
        raise VastError(str(r)[:400])
    return int(r["new_contract"])


def destroy(iid):
    """Destroys a box and confirms it's gone (with --raw the CLI prints nothing for this)."""
    run_vast(["destroy", "instance", str(iid), "-y"])
    for _ in range(6):
        try:
            if show(iid) is None:
                return True
        except VastError:
            pass
        time.sleep(5)
    log(f"instance {iid} still shows up after destroying it: destroy it on vast by hand")
    return False


def price_ok(iid, cap):
    """Keeps the rent if it bills within the cap; otherwise destroys it."""
    dph = 0.0
    for _ in range(6):
        try:
            dph = num(show(iid) or {}, "dph_total")
        except VastError:
            pass
        if dph:
            break
        time.sleep(5)
    if not dph:
        log(f"couldn't read instance {iid}'s price; keeping it, check it on vast")
        return True
    if dph <= cap + 0.001:  # rounding only: the cap is a hard max
        log(f"instance {iid} bills ${dph:.3f}/h")
        return True
    log(f"instance {iid} bills ${dph:.3f}/h, over the ${cap}/h cap: destroying it")
    if not destroy(iid):
        sys.exit(3)
    return False


def failure(inst, box):
    """Why a box can't come up, once that has shown on three checks in a row; None while it still might."""
    msg = " ".join((inst.get("status_msg") or "").split())
    status, intended = inst.get("actual_status"), inst.get("intended_status")
    # a box someone stopped on purpose exits without an error, so it never counts
    error = "error" in msg.lower()
    broken = status != "running" and ((error and (intended == "stopped" or status in ("created", "exited")))
                                      or (status == "exited" and intended == "running"))
    box["bad"] = box.get("bad", 0) + 1 if broken else 0
    return (msg[:200] or f"container {status}") if box["bad"] >= 3 else None


def ssh_endpoint(inst):
    """The host's own address when it maps port 22 (faster), else vast's SSH proxy (as `vastai ssh-url` does)."""
    direct = (inst.get("ports") or {}).get("22/tcp")
    if direct and inst.get("public_ipaddr"):
        return inst["public_ipaddr"].strip(), int(direct[0]["HostPort"])
    if not (inst.get("ssh_host") and inst.get("ssh_port")):
        return None
    port = int(inst["ssh_port"]) + (1 if "jupyter" in (inst.get("image_runtype") or "") else 0)
    return inst["ssh_host"], port


def forget_host(host, port):
    """Drops the key of an earlier box at this address, which would fail StrictHostKeyChecking=accept-new."""
    if os.path.exists(KNOWN_HOSTS):
        subprocess.run(["ssh-keygen", "-R", f"[{host}]:{port}" if port != 22 else host, "-f", KNOWN_HOSTS],
                       capture_output=True)


def probe(host, port):
    """(GPU line, whether ComfyUI's API answers), checked over SSH; the GPU line is None until SSH logs in."""
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
           "-o", f"UserKnownHostsFile={KNOWN_HOSTS}", "-o", "IdentitiesOnly=yes",
           "-i", os.path.expanduser(SSH_KEY), "-p", str(port), f"root@{host}",
           "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader;"
           f" curl -sf -m 5 http://127.0.0.1:{COMFY_PORT}/system_stats"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired:
        return None, False
    lines = p.stdout.strip().splitlines()
    gpu = lines[0].strip() if lines and "MiB" in lines[0] else None
    return gpu, p.returncode == 0 and '"devices"' in p.stdout


def write_ssh_config(host, port):
    path = os.path.join(SSH_DIR, "config")
    raw = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8", newline="") as f:
            raw = f.read()
        if not os.path.exists(path + ".bak-crackio"):
            shutil.copyfile(path, path + ".bak-crackio")
    nl = "\r\n" if "\r\n" in raw else "\n"
    block = nl.join([
        f"# >>> {SSH_ALIAS} (written by Crackio's scripts/gpu/vast-monitor.py)",
        f"Host {SSH_ALIAS}",
        f"  HostName {host}",
        f"  Port {port}",
        "  User root",
        f"  IdentityFile {SSH_KEY}",
        "  IdentitiesOnly yes",
        "  ServerAliveInterval 30",
        "  ServerAliveCountMax 3",
        "  StrictHostKeyChecking accept-new",
        "  UserKnownHostsFile ~/.ssh/known_hosts_vast",
        f"# <<< {SSH_ALIAS}",
    ])
    rest = re.sub(rf"(\r?\n)*# >>> {SSH_ALIAS} .*?# <<< {SSH_ALIAS}(\r?\n)?", nl, raw, flags=re.S).rstrip("\r\n")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write((rest + nl + nl if rest else "") + block + nl)


def check_ssh():
    err = ""
    for _ in range(12):
        try:
            p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", SSH_ALIAS,
                                "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader"],
                               capture_output=True, text=True, timeout=60)
            if p.returncode == 0 and p.stdout.strip():
                return p.stdout.strip()
            err = " ".join(p.stderr.split())[-200:]
        except subprocess.TimeoutExpired:
            err = "timed out"
        time.sleep(15)
    log(f"ssh {SSH_ALIAS} still fails: {err}")
    return None


def finish(inst, box, tpl):
    host, port = ssh_endpoint(inst)
    write_ssh_config(host, port)
    gpu = check_ssh()
    state = {
        "instance_id": inst["id"],
        "label": LABEL,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "gpu": inst.get("gpu_name"),
        "price_per_hour": round(num(inst, "dph_total"), 4),
        "location": inst.get("geolocation"),
        "machine_id": inst.get("machine_id"),
        "offer_id": (box.get("offer") or {}).get("id"),
        "template": tpl["hash_id"],
        "image": inst.get("image_uuid") or box.get("image"),
        "ssh": {"alias": SSH_ALIAS, "host": host, "port": port, "user": "root"},
        "comfyui": f"ssh -N -L 8188:127.0.0.1:{COMFY_PORT} {SSH_ALIAS}, then http://127.0.0.1:8188",
        "ports": inst.get("ports"),
        "nvidia_smi": gpu or box.get("gpu"),
    }
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    log(f"ready: ssh {SSH_ALIAS} ({host}:{port}), GPU: {state['nvidia_smi'] or '?'}"
        f"{'' if gpu else ' (but the alias check failed)'}; details in {os.path.relpath(STATE, ROOT)}")
    return 0 if gpu else 4


def stalled(inst, box, status, msg, now):
    """Why a box that isn't ready yet should be given up on, or None while it's still getting somewhere."""
    age = (now - (num(inst, "start_date") or box.setdefault("born", now))) / 60
    quiet = (now - box["changed"]) / 60
    if status == "creating" and not msg and age > STALL_MIN:
        return f"no sign of life {age:.0f} min after the rent"
    if status == "offline" and quiet > OFFLINE_MIN:
        return f"host offline for {quiet:.0f} min"
    if status != "running" and quiet > QUIET_MIN:
        return f"stuck at {status} for {quiet:.0f} min"
    if age > BOOT_MIN:
        return f"not ready {age:.0f} min after the rent"
    return None


def check_box(iid, inst, box):
    """Logs what changed and returns 'failed: why', 'ready' or None while the box is still coming up."""
    now = time.time()
    status = inst.get("actual_status") or "creating"
    msg = " ".join((inst.get("status_msg") or "").split())[:200]
    if (status, msg) != box.get("seen"):
        log(f"instance {iid} ({box['where']}): {status}  {msg}".rstrip())
        box["seen"], box["changed"] = (status, msg), now
    why = failure(inst, box)
    if why:
        return f"failed: {why}"
    ep = ssh_endpoint(inst) if status == "running" else None
    if ep:
        if box.get("ep") != ep:
            forget_host(*ep)
            box["ep"] = ep
        gpu, comfy = probe(*ep)
        if gpu and not box.get("gpu"):
            box["gpu"] = gpu
            log(f"instance {iid}: SSH works, {gpu}")
        if comfy:
            return "ready"
    # only boxes still booting when this run met them get timed out; an older one may be someone's working box
    why = stalled(inst, box, status, msg, now) if box["booting"] else None
    return f"failed: {why}" if why else None


def main():
    ap = argparse.ArgumentParser(description="Rent Crackio's ComfyUI RTX 5090 on vast.ai and keep the first box that comes up.")
    ap.add_argument("--race", type=int, default=1, help="boxes to keep booting at once, on different hosts (default 1)")
    ap.add_argument("--switch-below", type=float, metavar="PRICE",
                    help="keep the first ready box, go on hunting boxes at most PRICE $/h and switch once one is ready")
    ap.add_argument("--skip-machine", type=int, action="append", default=[], metavar="ID", help="never rent on this host")
    ap.add_argument("--interval", type=float, default=12, help="seconds between checks (default 12)")
    ap.add_argument("--once", action="store_true", help="check once instead of until a box is ready")
    ap.add_argument("--dry-run", action="store_true", help="show what would be rented; rent and destroy nothing")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # host names can be anything
    os.makedirs(OUT, exist_ok=True)

    skip = load_skip()
    for m in a.skip_machine:
        skip.setdefault(m, "skipped by hand")
    save_skip(skip)
    tpl = official_template()
    fb = fallback_image(tpl)
    min_cuda = min(tpl["cuda"], MIN_CUDA) if fb else tpl["cuda"]
    log(f"template {tpl['hash_id']}: {tpl['image']}:{tpl['tag']}"
        + (f", or {fb} on hosts below CUDA {tpl['cuda']}" if fb else ""))
    log(f"looking for 1x {GPU}, {DISK_GB} GB disk, {MIN_RAM_GB}+ GB RAM, {MIN_MBPS}+/{MIN_MBPS}+ Mb/s, "
        f"on-demand at most ${MAX_DPH}/h and ${MAX_TB_COST}/TB each way, any verification"
        + (f"; once one is ready, hunting on for one at most ${a.switch_below}/h to switch to" if a.switch_below else "")
        + (f"; racing {a.race} boxes" if a.race > 1 else "")
        + (f"; skipping hosts {', '.join(map(str, sorted(skip)))}" if skip else "")
        + (" (dry run)" if a.dry_run else ""))

    boxes, tried, ghosts, polls = {}, {}, {}, 0
    current = None  # with --switch-below: the ready box kept while a cheaper one is hunted
    while True:
        polls += 1
        skip.update(load_skip())  # picks up hosts added to the file by hand
        try:
            live = {i["id"]: i for i in our_instances()}
        except VastError as e:
            log(f"vast error: {e}")
            time.sleep(a.interval)
            continue
        for iid in [i for i in boxes if i not in live]:
            log(f"instance {iid} is gone")
            del boxes[iid]
            current = None if iid == current else current
        for iid, inst in live.items():
            young = time.time() - num(inst, "start_date") < BOOT_MIN * 60
            box = boxes.setdefault(iid, {"machine": inst.get("machine_id"), "where": inst.get("geolocation") or "?",
                                         "booting": young})
            box["dph"] = num(inst, "dph_total")
            if iid == current or box.get("parked"):
                continue
            verdict = check_box(iid, inst, box)
            if verdict and verdict.startswith("failed") and not a.dry_run:
                log(f"instance {iid} {verdict}; destroying it and skipping host {box['machine']} from now on")
                if destroy(iid):
                    skip[box["machine"]] = f"{verdict[8:]} ({box['where']}, {datetime.now():%Y-%m-%d})"
                    save_skip(skip)
                    del boxes[iid]
            elif verdict == "ready":
                log(f"instance {iid} ({box['where']}, ${box['dph']:.3f}/h) is ready: ComfyUI answers")
                if a.dry_run:
                    return 0
                if a.switch_below and box["dph"] > a.switch_below:
                    if current is not None:
                        box["parked"] = True
                        continue
                    current = iid
                    for other in [i for i, b in boxes.items() if i != iid and b["dph"] > a.switch_below]:
                        log(f"destroying instance {other} ({boxes[other]['where']}): keeping {iid}, "
                            f"and {other} isn't under ${a.switch_below}/h either")
                        destroy(other)
                    finish(inst, box, tpl)
                    log(f"keeping instance {iid} until a box at most ${a.switch_below}/h is ready")
                    continue
                for other in [i for i in boxes if i != iid]:
                    log(f"destroying instance {other} ({boxes[other]['where']}): "
                        f"{'switching to' if other == current else 'keeping'} {iid} at ${box['dph']:.3f}/h")
                    destroy(other)
                return finish(inst, box, tpl)

        cap = a.switch_below if a.switch_below and current else MAX_DPH
        racing = [b for i, b in boxes.items() if i != current and not b.get("parked")
                  and (not a.switch_below or b["dph"] <= cap)]
        if len(racing) < a.race:
            have = {b["machine"] for b in boxes.values()}
            try:
                fit = ranked([o for o in search(min_cuda, cap) if o.get("machine_id") not in skip
                              and o.get("machine_id") not in have and time.time() - tried.get(o["id"], 0) > 600
                              and ghosts.get(o["id"], 0) < 2])
            except VastError as e:
                log(f"vast error: {e}")
                fit = []
            if fit:
                log(f"{len(fit)} fit: " + " | ".join(describe(o) for o in fit[:3]))
            elif polls == 1 or polls % 120 == 0:
                log(f"nothing new fits yet; checking every {a.interval:.0f}s")
            for o in fit:
                if len(racing) >= a.race:
                    break
                if o["machine_id"] in have:  # one host can list several offers
                    continue
                image = image_for(o, tpl, fb)
                if a.dry_run:
                    log(f"would rent offer {o['id']} with {image or 'the template image'}")
                    have.add(o["machine_id"])
                    continue
                log(f"renting offer {o['id']} with {image or 'the template image'}")
                tried[o["id"]] = time.time()
                try:
                    iid = rent(o, tpl, image)
                except VastError as e:
                    log(f"rent failed: {e}")
                    if "no_such_ask" in str(e):  # listed but gone; some stay listed for hours
                        ghosts[o["id"]] = ghosts.get(o["id"], 0) + 1
                    continue
                log(f"rented instance {iid}")
                if price_ok(iid, cap):
                    boxes[iid] = {"machine": o["machine_id"], "where": o.get("geolocation") or "?",
                                  "booting": True, "offer": o, "image": image, "dph": o["dph_total"]}
                    racing.append(boxes[iid])
                    have.add(o["machine_id"])
        if a.once:
            return 0 if boxes else 1
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
