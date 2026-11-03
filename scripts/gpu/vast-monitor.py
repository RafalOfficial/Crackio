#!/usr/bin/env python3
"""
Watches vast.ai for an on-demand GPU that fits Crackio's ComfyUI box, rents it and keeps the first one
that comes up.

  - Fits: one RTX 5090, H100 (SXM, PCIe or NVL) or RTX PRO 6000 (WS, Server or Max-Q) with at least
    140 GB of disk (rented at 140 GB) that reads and writes at SSD speed, 48 GB of system RAM and
    400/400 Mb/s, verified or unverified, for at most $0.561/h with the 140 GB of storage included,
    and at most $5 per TB of download and of upload. "Deverified" hosts are left out (every one we
    rented failed to start), and so are hosts in China (Docker Hub and Hugging Face are often blocked
    there) and cards that vast measured far below normal (DLPerf under 60% of a healthy card's: a
    5090 scoring 55 had a third of the normal memory bandwidth).
  - Shows what it sees as it goes, in English and Italian (or one of them, --lang): each offer it
    passes up and why (SKIPPED), fits (FOUND), fits that are gone before it gets them (MISSED), and
    its own box from RENTED to READY. The same lines go to data/gpu/vast-monitor.log. On Windows,
    scripts/gpu/vast-watch.cmd opens it in a window of its own.
  - Rents vast's official ComfyUI template, looked up on every run so template updates carry over.
    Its image needs CUDA 13.2; hosts on CUDA 12.8 to 13.1 get the same ComfyUI release's cuda-12.9
    build (vast publishes both, and that one's PyTorch is built for CUDA 12.8), so they qualify too.
  - Every fit is within the price cap, so the 80+ GB cards (H100, RTX PRO 6000) go before 5090s.
    Among those the cheapest wins, unless a European host is within 3 cents an hour (we're on CET).
  - A box is ready once SSH logs in, the GPU shows up and ComfyUI's API answers. With --race N it
    keeps up to N boxes booting on different hosts, keeps the first one that's ready and destroys
    the rest. A box whose container fails to start is destroyed, its host is skipped from then on
    (data/gpu/vast-skip.json), and the next fit is rented in its place. So is a box still booting
    (rented under 30 minutes ago) that shows no sign of life 4 minutes after the rent, sits on one
    status for 10 minutes before it runs, or isn't running 30 minutes after the rent. (Boxes that
    never start cost next to nothing: three of them took $0.03 of credit.) A box that runs is never
    destroyed: if neither its own SSH port nor vast's SSH proxy lets us in, or ComfyUI doesn't
    answer, 30 minutes after the rent, the watcher says so and stops. (It used to destroy those, and
    destroyed a working 5090 that another session was already using.)
  - With --switch-below PRICE the first box that's ready is kept even above PRICE, the hunt goes
    on for boxes at most PRICE/h, and the first of those that's ready replaces it (the kept box is
    destroyed, with whatever was on it).
  - Instances labelled crackio-comfy count as ours: a re-run adopts them instead of renting more,
    except stopped ones (by hand, or by vast when the credit ran out), which it leaves alone. A rent
    that comes back over the price cap is destroyed at once. Only one watcher runs at a time; a dry
    run (--dry-run) watches without renting, beside it or alongside our boxes.
  - When a box is ready it writes data/gpu/vast-instance.json and a `crackio-gpu` host in
    ~/.ssh/config, checks that the alias logs in, and exits. Re-running it then just refreshes both.

Talks to vast's REST API directly (the vastai CLI hangs on some PCs and takes seconds to start), with
the key in VAST_API_KEY or ~/.config/vastai/vast_api_key (where `vastai set api-key KEY` puts it).
Usage: python scripts/gpu/vast-monitor.py [--race 2] [--switch-below 0.5] [--skip-machine ID ...] [--interval 5]
                                          [--lang en|it|both] [--dry-run] [--once]
"""
import argparse
import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

try:
    import requests  # certifi's CAs: urllib with Windows' store fails on Docker Hub's chain
except ImportError:
    sys.exit("needs requests (pip install requests)")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "data", "gpu")
STATE = os.path.join(OUT, "vast-instance.json")
SKIP = os.path.join(OUT, "vast-skip.json")
LOG = os.path.join(OUT, "vast-monitor.log")
PID_FILE = os.path.join(OUT, "vast-monitor.pid")
SSH_DIR = os.path.join(os.path.expanduser("~"), ".ssh")
KNOWN_HOSTS = os.path.join(SSH_DIR, "known_hosts_vast")
API = "https://console.vast.ai/api"
KEY_FILE = os.path.join(os.path.expanduser("~"), ".config", "vastai", "vast_api_key")

# vast's names for the cards that fit, each with the DLPerf a healthy one scores
GPUS = {"RTX 5090": 200, "H100 SXM": 340, "H100 NVL": 340, "H100 PCIE": 256,
        "RTX PRO 6000 WS": 280, "RTX PRO 6000 S": 280, "RTX PRO 6000 Max-Q": 280}
DLPERF_SHARE = 0.6  # one 5090 scoring 55 had a third of the normal memory bandwidth
DISK_GB = 140
MIN_DISK_MBPS = 400  # SSD speed: vast doesn't say what the disk is, only how fast it measured
MIN_RAM_GB = 48
MIN_MBPS = 400
MAX_DPH = 0.561
MAX_TB_COST = 5.0  # $ per TB of download, and of upload
VERIFICATION = {"verified", "unverified"}  # every "deverified" host we rented failed to start
BIG_GPU_MB = 80000  # H100 and RTX PRO 6000
NO_COUNTRIES = {"CN"}  # the one CN box never got past "creating"
MIN_DAYS = 1  # skip hosts whose listing ends within a day
NEAR_DPH = 0.15  # offers up to this much over the price cap show in the feed as passed up, with why
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
# vast's official ComfyUI template on 2026-10-31, used only if the lookup fails
PINNED_TEMPLATE = {"hash_id": "433eb09ebc5e2eec355d62f8187c940f", "image": "vastai/comfy",
                   "tag": "v0.43.0-cuda-13.2-py312", "cuda": 13.2}

# the feed: what each line is about, as symbol, English, Italian and colour
KINDS = {"hunt": ("●", "HUNTING", "A CACCIA", "blue"), "skip": ("×", "SKIPPED", "SCARTATA", "yellow"),
         "found": ("◆", "FOUND", "TROVATA", "cyan"), "missed": ("◇", "MISSED", "SFUGGITA", "magenta"),
         "rented": ("★", "RENTED", "NOLEGGIATA", "green"), "boot": ("▲", "BOOT", "AVVIO", "cyan"),
         "ready": ("✓", "READY", "PRONTA", "green"), "failed": ("■", "FAILED", "FALLITA", "red"),
         "error": ("!", "ERROR", "ERRORE", "red"), "info": ("·", "INFO", "INFO", "dim")}
STYLES = {"bold": "1", "dim": "2", "red": "91", "green": "92", "yellow": "93", "blue": "94", "magenta": "95",
          "cyan": "96"}
STATUS_IT = {"creating": "in creazione", "created": "creata", "loading": "in caricamento", "running": "in funzione",
             "exited": "uscita", "stopped": "fermata", "offline": "offline", "scheduling": "in attesa"}
LOGO = ("▄▀▀ █▀▄ ▄▀▄ ▄▀▀ █▄▀ █ ▄▀▄", "▀▄▄ █▀▄ █▀█ ▀▄▄ █ █ █ ▀▄▀")
ui = {"lang": "both", "color": False}


class VastError(Exception):
    pass


def setup_console(lang):
    ui["lang"] = lang
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # host names can be anything
    ui["color"] = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
    if ui["color"] and os.name == "nt":  # Windows consoles draw ANSI colours once asked to
        import ctypes
        k32, mode = ctypes.windll.kernel32, ctypes.c_uint32()
        out = k32.GetStdHandle(-11)
        ui["color"] = bool(k32.GetConsoleMode(out, ctypes.byref(mode)) and k32.SetConsoleMode(out, mode.value | 4))


def paint(text, *styles):
    return f"\033[{';'.join(STYLES[s] for s in styles)}m{text}\033[0m" if ui["color"] and styles else text


def words(en, it):
    """The text in the language(s) asked for: one line, or English then Italian."""
    if ui["lang"] == "it":
        return [it]
    return [en] if ui["lang"] == "en" or it == en else [en, it]


def emit(pretty, plain):
    print("\n".join(pretty), flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write("\n".join(plain) + "\n")


def tag(kind):
    sym, en, it, _ = KINDS[kind]
    return f"{sym} {' · '.join(words(en, it))}"


def say(kind, en, it=None, under=0):
    """One line of the feed (two with English and Italian): in colour on screen, plain in the log. When both
    start with the same `under` characters (an offer's card), the Italian line under the English one leaves
    them out."""
    now = datetime.now()
    lines = words(en, en if it is None else it)
    head = f"{tag(kind):<{max(len(tag(k)) for k in KINDS)}}"
    pad = " " * (len(head) + 10 + under)
    pretty = [f"{paint(f'{now:%H:%M:%S}', 'dim')}  {paint(head, KINDS[kind][3], 'bold')}  {lines[0]}"]
    plain = [f"{now:%Y-%m-%d %H:%M:%S}  {head}  {lines[0]}"]
    for line in (line[under:] for line in lines[1:]):
        pretty.append(paint(f"{pad}↳ {line}", "dim"))
        plain.append(f"{' ' * 11}{pad}↳ {line}")
    emit(pretty, plain)


def frame(kind, rows):
    """The moments worth seeing from across the room, in a double-line box; rows are text or (English, Italian)."""
    lines = [line for row in rows for line in (words(*row) if isinstance(row, tuple) else [row])]
    w = max(len(line) for line in lines)
    plain = ["╔" + "═" * (w + 4) + "╗"] + [f"║  {line:<{w}}  ║" for line in lines] + ["╚" + "═" * (w + 4) + "╝"]
    emit([paint(line, KINDS[kind][3], "bold") for line in plain], plain)


def card_list():
    """RTX 5090 · H100 SXM/NVL/PCIE · RTX PRO 6000 WS/S/Max-Q"""
    groups = {}
    for name in GPUS:
        head, _, tail = name.rpartition(" ")
        groups.setdefault(head, []).append(tail)
    return " · ".join(f"{head} {'/'.join(tails)}".strip() for head, tails in groups.items())


def show_start(tpl, fb, a, skip):
    other = f" (+ {fb.split(':')[-1]})" if fb else ""
    rows = [("cards", "schede", card_list(), None),
            ("price", "prezzo", f"≤ ${a.max_price}/h with the {DISK_GB} GB disk", f"≤ ${a.max_price}/h col disco da {DISK_GB} GB"),
            ("net", "rete", f"≥ {MIN_MBPS}/{MIN_MBPS} Mb/s, ≤ ${MAX_TB_COST:g}/TB each way",
             f"≥ {MIN_MBPS}/{MIN_MBPS} Mb/s, ≤ ${MAX_TB_COST:g}/TB per verso"),
            ("machine", "macchina", f"≥ {MIN_RAM_GB} GB RAM · ≥ {DISK_GB} GB SSD at ≥ {MIN_DISK_MBPS} MB/s",
             f"≥ {MIN_RAM_GB} GB RAM · ≥ {DISK_GB} GB SSD a ≥ {MIN_DISK_MBPS} MB/s"),
            ("hosts", "host", "verified or unverified, outside China", "verificati o no, fuori dalla Cina"),
            ("skipped", "saltati", f"{len(skip)} hosts on the skip list", f"{len(skip)} host nella lista nera"),
            ("image", "immagine", f"{tpl['image']}:{tpl['tag']}{other}", None),
            ("checks", "controlli", f"every {a.interval:g} s · Ctrl+C stops", f"ogni {a.interval:g} s · Ctrl+C ferma")]
    if a.machine:
        rows.append(("host", "host", f"{a.machine} only, picked by hand", f"solo {a.machine}, scelto a mano"))
    if a.race > 1:
        rows.append(("race", "gara", f"{a.race} boxes boot at once, the first ready one stays",
                     f"{a.race} macchine partono insieme, resta la prima pronta"))
    if a.switch_below:
        rows.append(("switch", "cambio", f"then hunts on for one at ≤ ${a.switch_below}/h",
                     f"poi cerca ancora una a ≤ ${a.switch_below}/h"))
    if a.dry_run:
        rows.append(("dry run", "prova", "rents nothing, leaves our boxes alone", "non noleggia niente, non tocca le nostre"))
    body = []  # (label, text, whether it's the Italian line under an English one)
    for en_label, it_label, en, it in rows:
        texts = words(en, en if it is None else it)
        body += [(" · ".join(words(en_label, it_label)), texts[0], False)] + [("", t, True) for t in texts[1:]]
    lw = max(len(label) for label, _, _ in body)
    w = max(lw + 3 + len(text) for _, text, _ in body)
    title = " · ".join(words("GPU WATCH", "SENTINELLA GPU"))
    plain = ["", f"  {LOGO[0]}   {title}", f"  {LOGO[1]}   vast.ai → Crackio", "  ┌" + "─" * (w + 2) + "┐"]
    pretty = ["", f"  {paint(LOGO[0], 'cyan', 'bold')}   {paint(title, 'bold')}",
              f"  {paint(LOGO[1], 'cyan', 'bold')}   {paint('vast.ai → Crackio', 'dim')}", plain[3]]
    for label, text, second in body:
        line = f"{label:<{lw}}   {text}".ljust(w)
        plain.append(f"  │ {line} │")
        pretty.append(f"  │ {paint(line, 'dim') if second else paint(f'{label:<{lw}}', 'cyan') + line[lw:]} │")
    plain.append("  └" + "─" * (w + 2) + "┘")
    pretty.append(plain[-1])
    emit(pretty, plain)


_session = None


def vast(method, path, params=None, body=None):
    """One call to vast's REST API (what the vastai CLI does underneath); waits out its rate limit."""
    global _session
    if _session is None:
        key = os.environ.get("VAST_API_KEY", "").strip()
        if not key and os.path.exists(KEY_FILE):
            with open(KEY_FILE, encoding="utf-8") as f:
                key = f.read().strip()
        if not key:
            sys.exit(f"no vast.ai API key: set VAST_API_KEY or put it in {KEY_FILE}")
        _session = requests.Session()
        _session.headers["Authorization"] = f"Bearer {key}"
    for attempt in range(4):
        try:
            r = _session.request(method, API + path, params=params, json=body, timeout=30)
        except requests.RequestException as e:
            raise VastError(f"{method} {path}: {e.__class__.__name__}")
        if r.status_code != 429 or attempt == 3:
            break
        time.sleep(min(float(r.headers.get("Retry-After") or 2 * (attempt + 1)), 30))
    try:
        data = r.json()
    except ValueError:
        raise VastError(f"{method} {path}: HTTP {r.status_code} {' '.join(r.text.split())[:300]}")
    if r.status_code >= 400:
        raise VastError(f"{method} {path}: HTTP {r.status_code} {json.dumps(data)[:300]}")
    return data


def num(row, key):
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def alive(pid):
    """Whether pid is a running Python, so another watcher (not a process that reused its number)."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes  # os.kill on Windows would end the process instead of checking it
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    try:
        code, size, name = wintypes.DWORD(), wintypes.DWORD(1024), ctypes.create_unicode_buffer(1024)
        running = k32.GetExitCodeProcess(h, ctypes.byref(code)) and code.value == 259  # STILL_ACTIVE
        return bool(running and k32.QueryFullProcessImageNameW(h, 0, name, ctypes.byref(size))
                    and "python" in name.value.lower())
    finally:
        k32.CloseHandle(h)


def claim():
    """One watcher at a time: two would rent two boxes."""
    try:
        with open(PID_FILE, encoding="utf-8") as f:
            other = int(f.read().strip() or 0)
    except (OSError, ValueError):
        other = 0
    if other and other != os.getpid() and alive(other):
        sys.exit(f"another vast-monitor is running (pid {other}) · un'altra sentinella è già attiva (pid {other})")
    with open(PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    atexit.register(release)


def release():
    try:
        with open(PID_FILE, encoding="utf-8") as f:
            mine = f.read().strip() == str(os.getpid())
        if mine:
            os.remove(PID_FILE)
    except OSError:
        pass


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
        rows = vast("GET", "/v0/template/", params={"select_cols": json.dumps(["*"]),
                                                    "select_filters": json.dumps({"recommended": {"eq": True}})})
        t = next(t for t in rows.get("templates") or [] if t.get("name") == "ComfyUI" and t.get("image") == "vastai/comfy")
        filters = t.get("extra_filters") or {}
        filters = json.loads(filters) if isinstance(filters, str) else filters
        cuda = float((filters.get("cuda_max_good") or {}).get("gte") or 0)
        return {"hash_id": t["hash_id"], "image": t["image"], "tag": t["tag"], "cuda": cuda}
    except (VastError, StopIteration, KeyError, TypeError, ValueError, AttributeError) as e:
        say("error", f"template lookup failed ({e}), using the pinned one",
            f"ricerca del template fallita ({e}), uso quello fissato")
        return dict(PINNED_TEMPLATE)


def fallback_image(tpl):
    """The template's ComfyUI release built on CUDA 12.9, for drivers that stop short of the template's CUDA."""
    if tpl["cuda"] <= FALLBACK_CUDA:
        return None
    tag_ = re.sub(r"cuda-[0-9.]+", f"cuda-{FALLBACK_CUDA}", tpl["tag"])
    try:
        requests.get(f"https://hub.docker.com/v2/repositories/{tpl['image']}/tags/{tag_}", timeout=20).raise_for_status()
        return f"{tpl['image']}:{tag_}"
    except Exception as e:  # any failure means the tag can't be counted on
        say("error", f"{tpl['image']}:{tag_} isn't available ({e}); only CUDA {tpl['cuda']} hosts qualify",
            f"{tpl['image']}:{tag_} non è disponibile ({e}); vanno bene solo host con CUDA {tpl['cuda']}")
        return None


def image_for(o, tpl, fb):
    """None keeps the template's image; hosts below its CUDA get the CUDA 12.9 build."""
    return None if num(o, "cuda_max_good") >= tpl["cuda"] else fb


def verification(o):
    return o.get("verification") or ("verified" if o.get("verified") else "unverified")


def same(text):
    return text, text


def misses(o, min_cuda, cap):
    """Why an offer isn't a fit, as (English, Italian) pairs, mostly numbers both read; none for a fit."""
    out = []
    healthy = GPUS.get(o.get("gpu_name"))
    if healthy is None:
        out.append(("card not on the list", "scheda non in lista"))
    if o.get("num_gpus") != 1:
        out.append((f"{o.get('num_gpus')} GPUs", f"{o.get('num_gpus')} GPU"))
    if not 0 < num(o, "dph_total") <= cap:
        out.append(same(f">${cap:g}/h"))
    if verification(o) not in VERIFICATION:
        out.append(same(verification(o)))
    if num(o, "cpu_ram") < MIN_RAM_GB * 1000:
        out.append(same(f"RAM {num(o, 'cpu_ram') / 1000:.0f}<{MIN_RAM_GB} GB"))
    slow = [f"{arrow}{num(o, key):.0f}" for arrow, key in (("↓", "inet_down"), ("↑", "inet_up")) if num(o, key) < MIN_MBPS]
    if slow:
        out.append(same(f"{' '.join(slow)}<{MIN_MBPS} Mb/s"))
    dear = max(num(o, "inet_down_cost"), num(o, "inet_up_cost")) * 1000
    if dear > MAX_TB_COST:
        out.append(same(f"${dear:.2f}/TB>${MAX_TB_COST:g}"))
    if num(o, "disk_space") < DISK_GB:
        out.append(same(f"SSD {num(o, 'disk_space'):.0f}<{DISK_GB} GB"))
    if num(o, "disk_bw") < MIN_DISK_MBPS:
        out.append(same(f"SSD {num(o, 'disk_bw'):.0f}<{MIN_DISK_MBPS} MB/s"))
    if num(o, "cuda_max_good") < min_cuda:
        out.append(same(f"CUDA {num(o, 'cuda_max_good'):g}<{min_cuda:g}"))
    if healthy and 0 < num(o, "dlperf") < DLPERF_SHARE * healthy:
        out.append(same(f"DLPerf {num(o, 'dlperf'):.0f}<{DLPERF_SHARE * healthy:.0f}"))
    if country(o) in NO_COUNTRIES:
        out.append(same(country(o)))
    if num(o, "duration") < MIN_DAYS * 86400:
        out.append(("listing ends within a day", "l'annuncio scade entro un giorno"))
    if not o.get("rentable", True) or o.get("rented", False):
        out.append(("taken", "già presa"))
    return out


def fits(o, min_cuda, cap):
    return not misses(o, min_cuda, cap)


def offers(query):
    rows = vast("POST", "/v0/bundles/", body=query).get("offers")
    if not isinstance(rows, list):
        raise VastError(f"unexpected search reply: {str(rows)[:200]}")
    return rows


def search(min_cuda, cap, turn=0, machine=None):
    """The fits on vast now, cheapest first. vast bundles offers that look alike (a 5090 at the same price
    elsewhere) and lists one of each bundle, picked by the query, so one query shows only some of them (14
    of the 36 fits under $0.75 that thirty did, in a test), and its pick can be a deverified host hiding a
    verified one. So each turn asks for a few seconds less of listing time, which picks differently, and
    every bound is checked again here."""
    query = {"gpu_name": {"in": list(GPUS)}, "num_gpus": {"eq": 1}, "disk_space": {"gte": DISK_GB},
             "disk_bw": {"gte": MIN_DISK_MBPS}, "cpu_ram": {"gte": MIN_RAM_GB * 1000},
             "inet_down": {"gte": MIN_MBPS}, "inet_up": {"gte": MIN_MBPS},
             "inet_down_cost": {"lte": MAX_TB_COST / 1000}, "inet_up_cost": {"lte": MAX_TB_COST / 1000},
             "geolocation": {"notin": sorted(NO_COUNTRIES)}, "dph_total": {"lte": cap}, "cuda_max_good": {"gte": min_cuda},
             "duration": {"gte": MIN_DAYS * 86400 - turn % 3600}, "compute_cap": {"gte": 800},
             "rentable": {"eq": True}, "rented": {"eq": False}, "external": {"eq": False},
             "type": "on-demand", "allocated_storage": DISK_GB, "order": [["dph_total", "asc"]], "limit": 300}
    if machine:
        query["machine_id"] = {"eq": machine}
    # vast's price filter can leave out the storage share of the price, so every bound is checked again
    return sorted((o for o in offers(query) if fits(o, min_cuda, cap)), key=lambda o: o["dph_total"])


def around(cap, turn=0, machine=None):
    """Every listed card up to NEAR_DPH over the cap, fit or not, cheapest first: what the feed shows as
    passed up, and one more look for fits (see search)."""
    query = {"gpu_name": {"in": list(GPUS)}, "num_gpus": {"eq": 1}, "dph_total": {"lte": cap + NEAR_DPH},
             "duration": {"gte": turn % 3600}, "rentable": {"eq": True}, "rented": {"eq": False},
             "external": {"eq": False}, "type": "on-demand", "allocated_storage": DISK_GB,
             "order": [["dph_total", "asc"]], "limit": 300}
    if machine:
        query["machine_id"] = {"eq": machine}
    # vast's price filter leaves the storage out, so the line is drawn again here
    return sorted((o for o in offers(query) if num(o, "dph_total") <= cap + NEAR_DPH), key=lambda o: num(o, "dph_total"))


def country(o):
    return (o.get("geolocation") or "").rsplit(",", 1)[-1].strip().upper()


def ranked(fit):
    """80+ GB cards first, then 5090s; in each, cheapest first, but the cheapest European host within
    EUROPE_MARGIN of it goes ahead."""
    out = []
    for group in ([o for o in fit if num(o, "gpu_ram") >= BIG_GPU_MB], [o for o in fit if num(o, "gpu_ram") < BIG_GPU_MB]):
        if group:
            first = next((o for o in group if country(o) in EUROPE
                          and o["dph_total"] <= group[0]["dph_total"] + EUROPE_MARGIN), group[0])
            out += [first] + [o for o in group if o is not first]
    return out


def card(o, columns=True):
    """An offer's card, price and place, in the feed's columns or inline."""
    gpu, where, dph = o.get("gpu_name") or "?", o.get("geolocation") or "?", num(o, "dph_total")
    return f"{gpu:<18} ${dph:.3f}/h  {where[:24]:<24}" if columns else f"{gpu} ${dph:.3f}/h {where}"


def details(o):
    reliability = num(o, "reliability2") or num(o, "reliability")
    return (f"{card(o)}  {num(o, 'cpu_ram') / 1000:.0f} GB · ↓{num(o, 'inet_down'):.0f} ↑{num(o, 'inet_up'):.0f} Mb/s · "
            f"${max(num(o, 'inet_down_cost'), num(o, 'inet_up_cost')) * 1000:.2f}/TB · {verification(o)} "
            f"{reliability:.3f} · offer {o['id']}")


def our_instances():
    rows, token = [], None
    for _ in range(20):
        page = vast("GET", "/v1/instances/", params={"limit": 100, **({"after_token": token} if token else {})})
        rows += page.get("instances") or []
        token = page.get("next_token")
        if not token:
            break
    return [i for i in rows if i.get("label") == LABEL]


def show(iid):
    r = vast("GET", f"/v0/instances/{iid}/", params={"owner": "me"}).get("instances")
    return r if isinstance(r, dict) and r.get("id") else None


def rent(o, tpl, image):
    body = {"client_id": "me", "template_hash_id": tpl["hash_id"], "disk": DISK_GB, "label": LABEL,
            "cancel_unavail": True}
    if image:
        body["image"] = image
    r = vast("PUT", f"/v0/asks/{o['id']}/", body=body)
    if not (r.get("success") and r.get("new_contract")):
        raise VastError(json.dumps(r)[:400])
    return int(r["new_contract"])


def destroy(iid):
    """Destroys a box and confirms it's gone."""
    try:
        vast("DELETE", f"/v0/instances/{iid}/")
    except VastError as e:
        say("error", f"destroying instance {iid}: {e}", f"distruggendo l'istanza {iid}: {e}")
    for _ in range(6):
        try:
            if show(iid) is None:
                return True
        except VastError:
            pass
        time.sleep(5)
    say("error", f"instance {iid} still shows up after destroying it: destroy it on vast by hand",
        f"l'istanza {iid} risulta ancora dopo averla distrutta: distruggila a mano su vast")
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
        say("error", f"couldn't read instance {iid}'s price; keeping it, check it on vast",
            f"non riesco a leggere il prezzo dell'istanza {iid}; la tengo, controllala su vast")
        return True
    if dph <= cap + 0.001:  # rounding only: the cap is a hard max
        say("info", f"instance {iid} bills ${dph:.3f}/h", f"l'istanza {iid} costa ${dph:.3f}/h")
        return True
    say("failed", f"instance {iid} bills ${dph:.3f}/h, over the ${cap}/h cap: destroying it",
        f"l'istanza {iid} costa ${dph:.3f}/h, sopra il tetto di ${cap}/h: la distruggo")
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


def ssh_endpoints(inst):
    """Where SSH may answer: the host's own address when it maps port 22 (faster), then vast's SSH proxy (as
    `vastai ssh-url` gives it). Some hosts' own port never answers from outside, so both are tried."""
    out = []
    direct = (inst.get("ports") or {}).get("22/tcp")
    if direct and inst.get("public_ipaddr"):
        out.append((inst["public_ipaddr"].strip(), int(direct[0]["HostPort"])))
    if inst.get("ssh_host") and inst.get("ssh_port"):
        out.append((inst["ssh_host"], int(inst["ssh_port"]) + (1 if "jupyter" in (inst.get("image_runtype") or "") else 0)))
    return out


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
    say("error", f"ssh {SSH_ALIAS} still fails: {err}", f"ssh {SSH_ALIAS} non funziona ancora: {err}")
    return None


def finish(inst, box, tpl):
    host, port = box.get("ep") or ssh_endpoints(inst)[0]
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
    tunnel = f"ssh -N -L 8188:127.0.0.1:{COMFY_PORT} {SSH_ALIAS}"
    frame("ready", [f"{tag('ready')}   {card(inst, False)}",
                    f"ssh {SSH_ALIAS}   ({host}:{port})",
                    state["nvidia_smi"] or "?",
                    (f"ComfyUI: {tunnel}, then http://127.0.0.1:8188", f"ComfyUI: {tunnel}, poi http://127.0.0.1:8188"),
                    (f"details in {os.path.relpath(STATE, ROOT)}", f"dettagli in {os.path.relpath(STATE, ROOT)}")]
          + ([] if gpu else [("but the ssh alias check failed", "ma il controllo dell'alias ssh è fallito")]))
    return 0 if gpu else 4


def stalled(inst, box, status, msg, now):
    """Why a box that isn't ready yet should be given up on, as (English, Italian), or None while it's still
    getting somewhere."""
    age = (now - (num(inst, "start_date") or box.setdefault("born", now))) / 60
    quiet = (now - box["changed"]) / 60
    if status == "creating" and not msg and age > STALL_MIN:
        return f"no sign of life {age:.0f} min after the rent", f"nessun segno di vita {age:.0f} min dopo il noleggio"
    if status == "offline" and quiet > OFFLINE_MIN:
        return f"host offline for {quiet:.0f} min", f"host offline da {quiet:.0f} min"
    if status != "running" and quiet > QUIET_MIN:
        return f"stuck at {status} for {quiet:.0f} min", f"ferma su {STATUS_IT.get(status, status)} da {quiet:.0f} min"
    if status != "running" and age > BOOT_MIN:
        return f"not running {age:.0f} min after the rent", f"non in funzione {age:.0f} min dopo il noleggio"
    return None


def check_box(iid, inst, box):
    """Shows what changed and returns 'ready', why the box failed as (English, Italian), 'unreachable' for a
    running box that SSH or ComfyUI won't answer for, or None while it's still coming up."""
    now = time.time()
    status = inst.get("actual_status") or "creating"
    msg = " ".join((inst.get("status_msg") or "").split())[:200]
    if (status, msg) != box.get("seen"):
        say("boot", f"instance {iid} ({box['where']}): {status}  {msg}".rstrip(),
            f"istanza {iid} ({box['where']}): {STATUS_IT.get(status, status)}  {msg}".rstrip())
        box["seen"], box["changed"] = (status, msg), now
    why = failure(inst, box)
    if why:
        return same(why)  # vast's own words
    eps = ssh_endpoints(inst) if status == "running" else []
    for ep in [box["ep"]] if box.get("ep") in eps else eps:  # the one that answered, else each in turn
        if ep not in box.setdefault("forgot", set()):
            forget_host(*ep)
            box["forgot"].add(ep)
        gpu, comfy = probe(*ep)
        if gpu:
            box["ep"] = ep
            if not box.get("gpu"):
                box["gpu"] = gpu
                say("boot", f"instance {iid}: SSH works ({ep[0]}:{ep[1]}) · {gpu}",
                    f"istanza {iid}: SSH funziona ({ep[0]}:{ep[1]}) · {gpu}")
            if comfy:
                return "ready"
            break
    # only boxes still booting when this run met them get timed out; an older one may be someone's working box
    if not box["booting"]:
        return None
    if status == "running":  # never destroyed: it may be in use already, and not reaching it can be our side's fault
        age = (now - (num(inst, "start_date") or box.setdefault("born", now))) / 60
        return "unreachable" if age > BOOT_MIN else None
    return stalled(inst, box, status, msg, now)


def main():
    ap = argparse.ArgumentParser(description="Rent Crackio's ComfyUI GPU on vast.ai and keep the first box that comes up.")
    ap.add_argument("--race", type=int, default=1, help="boxes to keep booting at once, on different hosts (default 1)")
    ap.add_argument("--switch-below", type=float, metavar="PRICE",
                    help="keep the first ready box, go on hunting boxes at most PRICE $/h and switch once one is ready")
    ap.add_argument("--skip-machine", type=int, action="append", default=[], metavar="ID", help="never rent on this host")
    ap.add_argument("--machine", type=int, metavar="ID", help="rent on this host only (one picked from the feed), then stop")
    ap.add_argument("--max-price", type=float, default=MAX_DPH, metavar="PRICE",
                    help=f"the most to pay per hour, the {DISK_GB} GB disk included (default {MAX_DPH})")
    ap.add_argument("--interval", type=float, default=5, help="seconds between checks (default 5)")
    ap.add_argument("--lang", choices=("en", "it", "both"), default="both", help="the feed's language (default both)")
    ap.add_argument("--once", action="store_true", help="check once instead of until a box is ready")
    ap.add_argument("--dry-run", action="store_true",
                    help="watch and show what would be rented; rent and destroy nothing, and leave our boxes alone")
    a = ap.parse_args()
    setup_console(a.lang)
    os.makedirs(OUT, exist_ok=True)
    if not a.dry_run:
        claim()

    skip = load_skip()
    for m in a.skip_machine:
        skip.setdefault(m, "skipped by hand")
    save_skip(skip)
    tpl = official_template()
    fb = fallback_image(tpl)
    min_cuda = min(tpl["cuda"], MIN_CUDA) if fb else tpl["cuda"]
    show_start(tpl, fb, a, skip)

    boxes, retry_at, ghosts, polls = {}, {}, {}, 0
    passed, found, started, pick = set(), set(), time.time(), None  # what the feed has shown, so each shows once
    current = None  # with --switch-below: the ready box kept while a cheaper one is hunted
    while True:
        polls += 1
        skip.update(load_skip())  # picks up hosts added to the file by hand
        if a.machine in skip and all(b.get("stopped") for b in boxes.values()):
            say("failed", f"host {a.machine} is on the skip list now ({skip[a.machine]}), and it was the only one to rent",
                f"l'host {a.machine} ora è nella lista nera ({skip[a.machine]}), ed era l'unico da noleggiare")
            return 5
        try:
            live = {} if a.dry_run else {i["id"]: i for i in our_instances()}  # a dry run leaves our boxes alone
            for iid in [i for i in boxes if i not in live]:
                inst = show(iid)  # the list can lag behind a fresh rent; the instance's own route has it at once
                if inst:
                    live[iid] = inst
                    continue
                say("info", f"instance {iid} is gone", f"l'istanza {iid} non c'è più")
                del boxes[iid]
                current = None if iid == current else current
        except VastError as e:
            say("error", f"vast: {e}")
            time.sleep(a.interval)
            continue
        for iid, inst in live.items():
            young = time.time() - num(inst, "start_date") < BOOT_MIN * 60
            box = boxes.setdefault(iid, {"machine": inst.get("machine_id"), "where": inst.get("geolocation") or "?",
                                         "booting": young})
            box["dph"] = num(inst, "dph_total")
            # stopped by hand, or by vast when the credit ran out: left as it is, and no reason not to rent
            box["stopped"] = inst.get("intended_status") == "stopped" and not box["booting"]
            if box["stopped"] and not box.get("told"):
                box["told"] = True
                say("info", f"instance {iid} ({box['where']}) is stopped: leaving it alone",
                    f"l'istanza {iid} ({box['where']}) è ferma: la lascio stare")
            if iid == current or box.get("parked") or box["stopped"]:
                continue
            verdict = check_box(iid, inst, box)
            if isinstance(verdict, tuple) and not a.dry_run:
                say("failed", f"instance {iid} ({box['where']}): {verdict[0]}. Destroying it, and skipping host "
                    f"{box['machine']} from now on", f"istanza {iid} ({box['where']}): {verdict[1]}. La distruggo, e "
                    f"d'ora in poi salto l'host {box['machine']}")
                if destroy(iid):
                    skip[box["machine"]] = f"{verdict[0]} ({box['where']}, {datetime.now():%Y-%m-%d})"
                    save_skip(skip)
                    del boxes[iid]
            elif verdict == "unreachable" and not a.dry_run:
                say("error", f"instance {iid} ({box['where']}) runs, but SSH or ComfyUI hasn't answered from here "
                    f"{BOOT_MIN} min after the rent: leaving it as it is, check it by hand",
                    f"l'istanza {iid} ({box['where']}) è in funzione, ma SSH o ComfyUI non rispondono da qui "
                    f"{BOOT_MIN} min dopo il noleggio: la lascio com'è, controllala a mano")
                return 4
            elif verdict == "ready":
                say("ready", f"instance {iid} ({box['where']}, ${box['dph']:.3f}/h): ComfyUI answers",
                    f"istanza {iid} ({box['where']}, ${box['dph']:.3f}/h): ComfyUI risponde")
                if a.dry_run:
                    return 0
                if a.switch_below and box["dph"] > a.switch_below:
                    if current is not None:
                        box["parked"] = True
                        continue
                    current = iid
                    for other in [i for i, b in boxes.items() if i != iid and b["dph"] > a.switch_below]:
                        say("info", f"destroying instance {other} ({boxes[other]['where']}): keeping {iid}, and "
                            f"{other} isn't under ${a.switch_below}/h either", f"distruggo l'istanza {other} "
                            f"({boxes[other]['where']}): tengo {iid}, e nemmeno {other} sta sotto ${a.switch_below}/h")
                        destroy(other)
                    finish(inst, box, tpl)
                    say("info", f"keeping instance {iid} until one at most ${a.switch_below}/h is ready",
                        f"tengo l'istanza {iid} finché non è pronta una a ${a.switch_below}/h al massimo")
                    continue
                for other in [i for i in boxes if i != iid]:
                    switching = other == current
                    say("info", f"destroying instance {other} ({boxes[other]['where']}): "
                        f"{'switching to' if switching else 'keeping'} {iid} at ${box['dph']:.3f}/h",
                        f"distruggo l'istanza {other} ({boxes[other]['where']}): "
                        f"{'passo a' if switching else 'tengo'} {iid} a ${box['dph']:.3f}/h")
                    destroy(other)
                return finish(inst, box, tpl)

        cap = a.switch_below if a.switch_below and current else a.max_price
        racing = [b for i, b in boxes.items() if i != current and not b.get("parked") and not b.get("stopped")
                  and (not a.switch_below or b["dph"] <= cap)]
        if len(racing) < a.race:
            have = {b["machine"] for b in boxes.values()}
            try:
                seen = {o["id"]: o for o in search(min_cuda, cap, polls, a.machine)}
                near = around(cap, polls, a.machine)
            except VastError as e:
                say("error", f"vast: {e}")
                seen, near = {}, []
            passing = []  # (why, offer) for each offer passed up this time
            for o in near:
                why = misses(o, min_cuda, cap) + ([same("blacklist")] if o.get("machine_id") in skip else [])
                if not why:
                    seen.setdefault(o["id"], o)
                    continue
                passing.append((why, o))
                shown = (o.get("machine_id"), round(num(o, "dph_total"), 3), tuple(why))
                if shown not in passed:  # each host once per price and reason, however vast's bundles pick
                    passed.add(shown)
                    say("skip", f"{card(o)}  {', '.join(en for en, _ in why)}",
                        f"{card(o)}  {', '.join(it for _, it in why)}", under=len(card(o)) + 2)
            fit = ranked(sorted((o for o in seen.values() if o.get("machine_id") not in skip
                                 and o.get("machine_id") not in have and time.time() >= retry_at.get(o["id"], 0)
                                 and ghosts.get(o["id"], 0) < 3), key=lambda o: o["dph_total"]))
            for o in fit:
                if o["id"] not in found:
                    found.add(o["id"])
                    say("found", details(o))
            if not fit and (polls == 1 or polls % 120 == 0):
                mins = (time.time() - started) / 60
                en = f"nothing to rent yet after {mins:.0f} min ({polls} checks)" if polls > 1 else "nothing to rent yet"
                it = f"ancora niente da noleggiare dopo {mins:.0f} min ({polls} controlli)" if polls > 1 else "ancora niente da noleggiare"
                if passing:  # the one with the fewest things wrong, then the cheapest
                    why, o = min(passing, key=lambda p: (len(p[0]), num(p[1], "dph_total")))
                    en += f"; closest: {card(o, False)} ({', '.join(e for e, _ in why)})"
                    it += f"; la più vicina: {card(o, False)} ({', '.join(i for _, i in why)})"
                else:
                    en += f", nor anything under ${cap + NEAR_DPH:.3f}/h"
                    it += f", e niente sotto ${cap + NEAR_DPH:.3f}/h"
                say("hunt", en, it)
            if a.dry_run:  # names its pick each time the pick changes, and rents nothing
                if fit and fit[0]["id"] != pick:
                    pick = fit[0]["id"]
                    image = image_for(fit[0], tpl, fb)
                    say("info", f"would rent {card(fit[0], False)} (offer {pick}) with {image or 'the template image'}",
                        f"noleggerei {card(fit[0], False)} (offerta {pick}) con " + (image or "l'immagine del template"))
                fit = []
            for o in fit:
                if len(racing) >= a.race:
                    break
                if o["machine_id"] in have:  # one host can list several offers
                    continue
                image = image_for(o, tpl, fb)
                image_en, image_it = image or "the template image", image or "l'immagine del template"
                say("info", f"renting offer {o['id']} with {image_en}", f"noleggio l'offerta {o['id']} con {image_it}")
                retry_at[o["id"]] = time.time() + 600
                try:
                    iid = rent(o, tpl, image)
                except VastError as e:
                    # listed but gone: taken, held for a moment (one rent went through a minute after this), or a
                    # listing that stays up for hours without being there; three tries, 30 s apart
                    if "no_such_ask" in str(e):
                        ghosts[o["id"]] = ghosts.get(o["id"], 0) + 1
                        retry_at[o["id"]] = time.time() + 30
                        again = ghosts[o["id"]] < 3
                        say("missed", f"{card(o)}  gone before we got it; " + ("trying again in 30 s" if again else "giving up on it"),
                            f"{card(o)}  sparita prima che la prendessimo; " + ("riprovo tra 30 s" if again else "la lascio perdere"),
                            under=len(card(o)) + 2)
                    else:
                        say("missed", f"{card(o)}  the rent failed: {e}", f"{card(o)}  noleggio fallito: {e}",
                            under=len(card(o)) + 2)
                    continue
                frame("rented", [f"{tag('rented')}   {card(o, False)}",
                                 (f"instance {iid} · offer {o['id']} · {image_en}",
                                  f"istanza {iid} · offerta {o['id']} · {image_it}"),
                                 ("booting: ComfyUI answers in a few minutes",
                                  "in avvio: ComfyUI risponde tra qualche minuto")])
                if price_ok(iid, cap):
                    boxes[iid] = {"machine": o["machine_id"], "where": o.get("geolocation") or "?",
                                  "booting": True, "offer": o, "image": image, "dph": o["dph_total"]}
                    racing.append(boxes[iid])
                    have.add(o["machine_id"])
        if a.once:
            return 0 if boxes else 1
        time.sleep(a.interval)


if __name__ == "__main__":
    try:
        code = main()
    except KeyboardInterrupt:
        say("info", "stopped by hand", "fermata a mano")
        code = 130
    except Exception as e:  # leave a trace in the log too, then stop as usual
        say("error", f"stopped on an error: {e!r}", f"fermata per un errore: {e!r}")
        raise
    sys.exit(code)
