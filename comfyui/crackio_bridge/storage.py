"""
Storage (bridge 1.10): where this machine keeps its models, how much they take, on which drives, and where Crackio's
downloads go. Crackio's Settings → Storage reads and sets it.

  GET  /crackio/storage         every model folder with its paths, their size and files, where a download into it goes
                                now; the drives those are on (free, total); unfinished downloads (.part) nobody is
                                fetching; the size of ComfyUI's input, output and temp folders (Crackio's own crackio/
                                subfolders apart) and of the voice and lip-sync engines. Sizes are walked at most every
                                5 minutes (?fresh=1: now; ?walk=0: never, the last walk's or none); free space is read on
                                each ask.
  POST /crackio/storage/root    {path} downloads go to <path>/<model folder> from now on, and ComfyUI looks there first
                                for every model folder; {path: null}: back to ComfyUI's own model folders. A folder chosen
                                before stays one ComfyUI looks in (after its own), so what was downloaded there stays
                                usable. Refused while downloads or installs run. Kept in <ComfyUI user folder>/crackio/
                                storage.json.
  POST /crackio/storage/clean   {what: "parts"} unfinished downloads nobody is fetching (untouched for 10 minutes);
                                {what: "comfy", older_than_hours?: 24} Crackio's own copies in ComfyUI's input/crackio and
                                output/crackio (Crackio keeps every result in its Library; anything else there is yours
                                and stays), never while ComfyUI is working.

GET /crackio/info also says this machine's id (made once, kept in <ComfyUI user folder>/crackio/machine.json: a rented box
that reconnects at another address is still the same machine) and the download folder, and measures free disk there.

Until a download folder is chosen nothing here changes where files go.
"""
import asyncio
import json
import os
import re
import shutil
import sys
import threading
import time
import uuid

import folder_paths
from aiohttp import web
from server import PromptServer

# The bridge's own model folders (lfm3.py, voice.py, lipsync.py, FlashVSR+'s), besides those in ComfyUI's models folder.
OWN_FOLDERS = ("lfm3", "audiocpp", "latentsync", "mediapipe", "FlashVSR")
# In ComfyUI's table of folders, but not where models go.
NOT_MODELS = ("custom_nodes", "configs", "datasets")
# Model weights, listed one by one in the report whatever their size (anything else from 1 MB up).
WEIGHTS = (".safetensors", ".gguf", ".pt", ".pth", ".bin", ".ckpt", ".onnx", ".sft", ".task")
LISTED_FROM = 1024 * 1024
ACTIVE = ("queued", "downloading", "checking")
WALK_SECONDS = 300
# A .part nobody is fetching and untouched this long is a leftover (a ComfyUI stopped mid-download).
PART_QUIET = 600
REPARSE_POINT = 0x400  # Windows: junctions and links, never followed

_state = {"root": None, "also": []}
_id = {"value": None, "tried": 0.0}
_lock = threading.Lock()
_walk = {"at": 0.0, "data": None, "task": None}


def _pkg():
    """The bridge package (its downloads, its installs, its voice and lip-sync modules)."""
    return sys.modules.get(__package__ or "")


def _norm(path):
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _inside(path, folder):
    a, b = _norm(path), _norm(folder)
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep)


def _existing(path):
    """The path, else its nearest parent that exists (a folder not made yet is still on a drive)."""
    p = os.path.abspath(path)
    while not os.path.exists(p):
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent
    return p


def _mount(path):
    """The drive a path is on: C:\\ on Windows, its mount point elsewhere."""
    p = _existing(path)
    if p is None:
        return None
    if os.name == "nt":
        drive = os.path.splitdrive(p)[0]
        return drive + os.sep if drive else p
    try:
        dev = os.stat(p).st_dev
        while True:
            parent = os.path.dirname(p)
            if parent == p or os.stat(parent).st_dev != dev:
                return p
            p = parent
    except OSError:
        return p


def usage(path):
    p = _existing(path) if path else None
    if p is None:
        return None, None
    try:
        du = shutil.disk_usage(p)
        return du.free, du.total
    except OSError:
        return None, None


# ------------------------------------------------------------------ what the bridge keeps here


def _dir():
    """<ComfyUI's user folder>/crackio: the bridge's own settings on this machine."""
    try:
        user = folder_paths.get_user_directory()
    except Exception:  # a ComfyUI from before it had one
        user = os.path.join(os.path.dirname(os.path.abspath(folder_paths.__file__)), "user")
    return os.path.join(user, "crackio")


def _read(name):
    try:
        with open(os.path.join(_dir(), name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(name, data):
    folder = _dir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def machine_id():
    """This machine's id, made once and kept in <user folder>/crackio/machine.json. None while it can't be kept (a full
    disk): an id that changed on every start would be worse than none."""
    with _lock:
        if _id["value"]:
            return _id["value"]
        saved = _read("machine.json")
        value = saved.get("id") if isinstance(saved, dict) else None
        if isinstance(value, str) and re.fullmatch(r"[\w-]{8,64}", value):
            _id["value"] = value
            return value
        if time.time() - _id["tried"] < 60:
            return None
        _id["tried"] = time.time()
        value = str(uuid.uuid4())
        try:
            _write("machine.json", {"id": value, "made": int(time.time())})
        except OSError as e:
            print(f"[crackio_bridge] couldn't keep this machine's id in {_dir()}: {e}")
            return None
        _id["value"] = value
        return value


def _load():
    saved = _read("storage.json")
    saved = saved if isinstance(saved, dict) else {}
    value, also = saved.get("root"), saved.get("also")
    _state["root"] = os.path.normpath(value) if isinstance(value, str) and os.path.isabs(value) else None
    _state["also"] = [os.path.normpath(p) for p in also if isinstance(p, str) and os.path.isabs(p)][:8] if isinstance(also, list) else []


def root():
    """The folder downloads go to (<root>/<model folder>), or None: ComfyUI's own model folders."""
    return _state["root"]


# ------------------------------------------------------------------ model folders


def _paths(name):
    entry = folder_paths.folder_names_and_paths.get(name)
    return list(entry[0]) if entry and isinstance(entry[0], (list, tuple)) else []


def _canonical(name):
    """A folder's own name: unet → diffusion_models, and ComfyUI-GGUF's unet_gguf → the folder whose list it shares."""
    name = getattr(folder_paths, "map_legacy", lambda n: n)(name)
    entry = folder_paths.folder_names_and_paths.get(name)
    if entry:
        for other, e in list(folder_paths.folder_names_and_paths.items()):
            if e[0] is entry[0]:
                return other
    return name


def _folders():
    """Every model folder ComfyUI knows, each once (a folder sharing another's list of paths is that folder)."""
    out, seen = [], set()
    for name, entry in list(folder_paths.folder_names_and_paths.items()):
        paths = entry[0] if isinstance(entry, (list, tuple)) and entry else None
        if name in NOT_MODELS or not isinstance(paths, (list, tuple)) or id(paths) in seen:
            continue
        seen.add(id(paths))
        out.append(name)
    return out


def _download_folders():
    """The folders a download can go to: those in ComfyUI's models folder (its own and custom nodes'), and the bridge's."""
    models = os.path.join(folder_paths.models_dir, "")
    return [n for n in _folders() if n in OWN_FOLDERS or any(_norm(p) == _norm(models + n) for p in _paths(n))]


def _add_first(name, path):
    """ComfyUI looks for `name`'s files in `path` first (is_default, as extra_model_paths.yaml does; by hand on a
    ComfyUI from before it had that)."""
    for p in _paths(name):
        if _norm(p) == _norm(path):
            path = p  # the spelling it already has
            break
    try:
        folder_paths.add_model_folder_path(name, path, is_default=True)
    except TypeError:
        entry = folder_paths.folder_names_and_paths.get(name)
        if entry is None or not isinstance(entry[0], list):
            folder_paths.add_model_folder_path(name, path)
            return
        if path in entry[0]:
            entry[0].remove(path)
        entry[0].insert(0, path)


def _not_first(name, path):
    """ComfyUI still finds `name`'s files in `path`, after its other folders: a download folder chosen before."""
    entry = folder_paths.folder_names_and_paths.get(name)
    paths = entry[0] if entry else None
    same = [p for p in (paths or []) if _norm(p) == _norm(path)]
    if not same:
        if os.path.isdir(path):
            folder_paths.add_model_folder_path(name, path)
    elif isinstance(paths, list) and len(paths) > 1 and paths[0] in same:
        paths.remove(paths[0])
        paths.append(same[0])


def register(names=None):
    """While a download folder is chosen, every model folder looks in <root>/<folder> first; folders chosen before stay
    in each list, after ComfyUI's own."""
    names = names or _download_folders()
    r = _state["root"]
    for old in _state["also"]:
        if r and _norm(old) == _norm(r):
            continue
        for name in names:
            try:
                _not_first(name, os.path.join(old, name))
            except Exception as e:
                print(f"[crackio_bridge] storage: couldn't keep {old} for {name}: {e}")
    if not r:
        return
    for name in names:
        try:
            _add_first(name, os.path.join(r, name))
        except Exception as e:
            print(f"[crackio_bridge] storage: couldn't add {r} for {name}: {e}")


def target(name):
    """Where a download into model folder `name` goes while a download folder is chosen: <root>/<folder>; else None."""
    r = _state["root"]
    if not r:
        return None
    name = _canonical(name)
    return None if name in NOT_MODELS else os.path.join(r, name)


def ensure(name, path):
    """ComfyUI looks in a download folder for its files (one a custom node added after the bridge loaded, say)."""
    name = _canonical(name)
    if name not in folder_paths.folder_names_and_paths:  # as the bridge's own modules add theirs
        folder_paths.add_model_folder_path(name, os.path.join(folder_paths.models_dir, name))
    if not any(_norm(p) == _norm(path) for p in _paths(name)):
        _add_first(name, path)


def folder(name):
    """<root>/<name>, made and known to ComfyUI, while a download folder is chosen; None otherwise, or when it can't be
    made (a drive that's gone): the caller's own rule then."""
    path = target(name)
    if not path:
        return None
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        return None
    ensure(name, path)
    return path


def found(name, file, here):
    """Where `file` of model folder `name` is: in `here` (where it goes), else, while a download folder is chosen, in
    whichever of the folder's paths has it (files from before the folder was chosen stay where they are)."""
    path = os.path.join(here, file)
    if not _state["root"] or os.path.exists(path):
        return path
    for p in _paths(_canonical(name)):
        if os.path.isfile(os.path.join(p, file)):
            return os.path.join(p, file)
    return path


def start():
    """At the bridge's import: the download folder, if one is chosen, comes first for every model folder; again once every
    custom node has loaded, for the folders those added."""
    if not _state["root"] and not _state["also"]:
        return
    register()
    if _state["root"]:
        print(f"[crackio_bridge] downloads go to {_state['root']}")

    async def again(app):
        register()

    try:
        PromptServer.instance.app.on_startup.append(again)
    except Exception as e:
        print(f"[crackio_bridge] storage: {e}")


_load()


# ------------------------------------------------------------------ what's on disk


def _du(top, on_file=None, inodes=None):
    """Bytes and files under `top`. Links and junctions aren't followed; with `inodes`, a file hard-linked twice counts once
    (LFM3-VL's runtime folder links its weights)."""
    total = count = 0
    stack = [top]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                entries = list(it)
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_symlink():
                    continue
                st = e.stat(follow_symlinks=False)
                if getattr(st, "st_file_attributes", 0) & REPARSE_POINT:
                    continue
                if e.is_dir(follow_symlinks=False):
                    stack.append(e.path)
                    continue
                if not e.is_file(follow_symlinks=False):
                    continue
                if inodes is not None:
                    if os.name == "nt":  # DirEntry's stat has no link count on Windows
                        st = os.stat(e.path, follow_symlinks=False)
                    if st.st_nlink > 1:
                        key = (st.st_dev, st.st_ino)
                        if key in inodes:
                            continue
                        inodes.add(key)
                total += st.st_size
                count += 1
                if on_file:
                    on_file(e.path, st.st_size, st.st_mtime)
            except OSError:
                continue
    return total, count


def _comfy_dirs():
    out = {}
    for kind in ("input", "output", "temp"):
        try:
            out[kind] = getattr(folder_paths, f"get_{kind}_directory")()
        except Exception:
            out[kind] = None
    return out


def _engine_dirs():
    """The voice engine (audio.cpp) and the lip-sync engine, each beside its models folder."""
    pkg = _pkg()
    out = {}
    for key, module in (("audiocpp", "voice"), ("lipsync", "lipsync")):
        mod = getattr(pkg, module, None)
        try:
            out[key] = mod._engine_dir() if mod is not None else None
        except Exception:
            out[key] = None
    return out


def _walk_all():
    t0 = time.time()
    inodes = set()
    paths, sizes, parts = {}, {}, []
    for name in _folders():
        for p in _paths(name):
            key = _norm(p)
            if key in paths:
                continue
            if not os.path.isdir(p):
                paths[key] = {"bytes": 0, "files": 0}
                continue
            mine = sizes.setdefault(name, {})

            def on_file(path, size, mtime, name=name, base=p, mine=mine):
                rel = os.path.relpath(path, base).replace(os.sep, "/")
                low = rel.lower()
                if low.endswith(".part"):
                    parts.append({"folder": name, "name": rel[:-5], "path": path, "bytes": size, "mtime": mtime})
                elif name == "lfm3" and any(s.startswith(".") for s in rel.split("/")[:-1]):
                    pass  # LFM3-VL's runtime folder: its weights linked, its config (counted, not listed)
                elif size >= LISTED_FROM or low.endswith(WEIGHTS) or (name == "lfm3" and low.endswith(".json")):
                    mine[rel] = size

            b, n = _du(p, on_file, inodes)
            paths[key] = {"bytes": b, "files": n}
    dirs = _comfy_dirs()
    comfy = _no_comfy()
    day_ago = time.time() - 86400
    for kind, d in dirs.items():
        if not d or not os.path.isdir(d):
            continue
        own = os.path.join(d, "crackio")
        mine = [0, 0]

        def on_file(path, size, mtime, own=own, mine=mine):
            if _inside(path, own):
                mine[0] += size
                if mtime < day_ago:
                    mine[1] += size

        comfy[kind] = _du(d, on_file if kind != "temp" else None)[0]
        if kind != "temp":
            comfy[f"crackio_{kind}"] = mine[0]
            comfy["crackio_old"] += mine[1]
    engines = {}
    for key, d in _engine_dirs().items():
        if d and os.path.isdir(d):
            b, n = _du(d)
            engines[key] = {"path": d, "bytes": b, "files": n}
        else:
            engines[key] = None
    sizes = {k: v for k, v in sizes.items() if v}
    return {"at": time.time(), "took": round(time.time() - t0, 2), "paths": paths, "sizes": sizes, "parts": parts, "comfy": comfy, "engines": engines}


def _no_comfy():
    return {"input": 0, "output": 0, "temp": 0, "crackio_input": 0, "crackio_output": 0, "crackio_old": 0}


def _unwalked():
    """No walk yet (?walk=0): folders, targets and drives without sizes."""
    return {"at": None, "took": 0, "paths": {}, "sizes": {}, "parts": [], "comfy": _no_comfy(), "engines": {"audiocpp": None, "lipsync": None}}


async def _walked(fresh=False):
    """The last walk while it's under 5 minutes old, else a new one (one at a time: others wait for it)."""
    if not fresh and _walk["data"] and time.time() - _walk["at"] < WALK_SECONDS:
        return _walk["data"]
    task = _walk["task"]
    if task is None or task.done():
        task = asyncio.get_running_loop().run_in_executor(None, _walk_all)

        def keep(f):
            if not f.cancelled() and f.exception() is None:
                _walk.update(at=f.result()["at"], data=f.result())

        task.add_done_callback(keep)
        _walk["task"] = task
    # Shielded: a page closed mid-walk doesn't cancel it for the others waiting.
    return await asyncio.shield(task)


def _forget_walk():
    _walk.update(at=0.0, data=None)


def _active_parts():
    """The .part files being written now: the bridge's downloads, and Lip Sync's install fetching its landmarkers."""
    pkg = _pkg()
    out = set()
    for d in list((getattr(pkg, "_downloads", None) or {}).values()):
        if d.get("state") in ACTIVE and d.get("target"):
            out.add(_norm(d["target"] + ".part"))
    lipsync = getattr(pkg, "lipsync", None)
    if lipsync is not None and getattr(lipsync, "_install", {}).get("state") == "running":
        try:
            mp = lipsync._folder("mediapipe")
            out.update(_norm(os.path.join(mp, f + ".part")) for f in getattr(lipsync, "TASKS", {}))
        except Exception:
            pass
    return out


def _target_of(name):
    try:
        from . import _target_path

        return _target_path(name)
    except Exception:
        return None


def _report(walked):
    r = _state["root"]
    mounts = {}

    def note(path):
        m = _mount(path) if path else None
        if m:
            mounts.setdefault(_norm(m), m)

    note(folder_paths.models_dir)
    note(r)
    for old in _state["also"]:
        note(old)
    folders = {}
    for name in _folders():
        entries = []
        for p in _paths(name):
            seen = walked["paths"].get(_norm(p))
            exists = os.path.isdir(p)
            entries.append({"path": p, "exists": exists, "bytes": seen["bytes"] if seen and exists else 0, "files": seen["files"] if seen and exists else 0})
            note(p)
        folders[name] = {"target": _target_of(name), "paths": entries}
    drives = []
    for m in mounts.values():
        free, total = usage(m)
        drives.append({"path": m, "free": free, "total": total})
    active = _active_parts()
    parts = [{k: x[k] for k in ("folder", "name", "path", "bytes", "mtime")} for x in walked["parts"] if _norm(x["path"]) not in active and os.path.isfile(x["path"])]
    return {
        "machine_id": machine_id(),
        "models_dir": folder_paths.models_dir,
        "root": r,
        "also": list(_state["also"]),
        "drives": drives,
        "folders": folders,
        "sizes": walked["sizes"],
        "parts": parts,
        "comfy": {**walked["comfy"], "dirs": _comfy_dirs()},
        "engines": walked["engines"],
        "walked_at": walked["at"],
        "took": walked["took"],
    }


@PromptServer.instance.routes.get("/crackio/storage")
async def storage_status(request):
    fresh = request.query.get("fresh", "") in ("1", "true", "yes")
    try:
        # walk=0: what's known without walking (where downloads go, free space), for a quick check before an install.
        walked = (_walk["data"] or _unwalked()) if request.query.get("walk") == "0" else await _walked(fresh)
        return web.json_response(await asyncio.get_running_loop().run_in_executor(None, _report, walked))
    except Exception as e:
        return web.json_response({"error": f"Couldn't measure the model folders: {e}"[:300]}, status=500)


# ------------------------------------------------------------------ choosing the download folder


def _busy():
    """What a change of folder would cut through: downloads, a node or an engine installing."""
    pkg = _pkg()
    if any(d.get("state") in ACTIVE for d in list((getattr(pkg, "_downloads", None) or {}).values())):
        return "Downloads are still running: choose the folder once they're done."
    if getattr(pkg, "_installing", 0):
        return "A custom node is still installing."
    voice = getattr(pkg, "voice", None)
    if voice is not None and getattr(voice, "_install", {}).get("state") in ("downloading", "unpacking", "checking"):
        return "Voice's engine is installing."
    lipsync = getattr(pkg, "lipsync", None)
    if lipsync is not None and getattr(lipsync, "_install", {}).get("state") == "running":
        return "Lip Sync's engine is installing."
    return None


def _system_folders():
    if os.name == "nt":
        out = [os.environ.get(v) for v in ("SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData")]
        out += [r"C:\Windows", r"C:\Program Files", r"C:\Program Files (x86)", r"C:\ProgramData"]
    else:
        out = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run", "/sbin", "/snap", "/sys", "/usr",
               "/System", "/Library", "/Applications", "/private/etc", "/private/var/db"]
    return [p for p in out if p]


def _refuse(path):
    """Why a folder can't hold downloads, in plain words; None when it can."""
    if os.path.dirname(path) == path:
        return "Pick a folder, not a whole drive."
    for s in _system_folders():
        if _inside(path, s):
            return f"{path} is a system folder: pick one of your own."
    try:
        nodes = _paths("custom_nodes")
    except Exception:
        nodes = []
    for p in nodes:
        if _inside(path, p):
            return "Not inside custom_nodes: ComfyUI would try to load each folder there as a node."
    return None


def _try(path):
    """Makes the folder and writes (then removes) a file in it; the error, if any."""
    probe = os.path.join(path, f".crackio-write-test-{uuid.uuid4().hex[:8]}")
    try:
        os.makedirs(path, exist_ok=True)
        with open(probe, "wb") as f:
            f.write(b"crackio")
        os.remove(probe)
        return None
    except OSError as e:
        try:
            os.remove(probe)
        except OSError:
            pass
        return e.strerror or str(e)


def _also(old, new):
    """Folders chosen before, newest first: ComfyUI keeps looking in them, so nothing downloaded there goes missing."""
    keep = [p for p in _state["also"] if not (new and _norm(p) == _norm(new)) and not (old and _norm(p) == _norm(old))]
    return ([old] if old and not (new and _norm(old) == _norm(new)) else []) + keep[:7]


def _set_root(path):
    """Saves the choice and applies it now: (status, answer)."""
    old = _state["root"]
    if path is None:
        also = _also(old, None)
        try:
            _write("storage.json", {"root": None, "also": also, "set": int(time.time())})
        except OSError as e:
            return 507, {"error": f"Couldn't save that in {_dir()}: {e.strerror or e}"}
        _state.update(root=None, also=also)
        register()
        _forget_walk()
        free, total = usage(folder_paths.models_dir)
        note = "New downloads go to ComfyUI's own model folders again."
        if old:
            note += f" What's already in {old} stays there, and ComfyUI still finds it (it looks there after its own folders)."
        return 200, {"ok": True, "root": None, "free": free, "total": total, "note": note}
    refused = _refuse(path)
    if refused:
        return 400, {"error": refused}
    failed = _try(path)
    if failed:
        return 400, {"error": f"Crackio can't write in {path}: {failed.rstrip('.')}."}
    also = _also(old, path)
    try:
        _write("storage.json", {"root": path, "also": also, "set": int(time.time())})
    except OSError as e:
        return 507, {"error": f"Couldn't save that in {_dir()}: {e.strerror or e}"}
    _state.update(root=path, also=also)
    register()
    _forget_walk()
    free, total = usage(path)
    return 200, {"ok": True, "root": path, "free": free, "total": total}


@PromptServer.instance.routes.post("/crackio/storage/root")
async def storage_root(request):
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict) or "path" not in body:
        return web.json_response({"error": "Send {path}: a folder, or null for ComfyUI's own model folders."}, status=400)
    raw = body.get("path")
    if raw is not None and not isinstance(raw, str):
        return web.json_response({"error": "The path is text, or null."}, status=400)
    path = raw.strip() if isinstance(raw, str) else ""
    if path and (not os.path.isabs(path) or (os.name == "nt" and not os.path.splitdrive(path)[0])):
        return web.json_response({"error": "Give the whole path (C:\\Models, /data/models)."}, status=400)
    busy = _busy()
    if busy:
        return web.json_response({"error": busy}, status=409)
    status, answer = await asyncio.get_running_loop().run_in_executor(None, _set_root, os.path.normpath(path) if path else None)
    return web.json_response(answer, status=status)


# ------------------------------------------------------------------ cleaning up


def _clean_parts():
    active = _active_parts()
    freed = files = kept = 0
    walked = set()
    for name in _folders():
        for p in _paths(name):
            if _norm(p) in walked or not os.path.isdir(p):
                continue
            walked.add(_norm(p))
            leftovers = []
            _du(p, lambda path, size, mtime: path.lower().endswith(".part") and leftovers.append((path, size, mtime)))
            for path, size, mtime in leftovers:
                if _norm(path) in active or time.time() - mtime < PART_QUIET:
                    kept += 1
                    continue
                try:
                    os.remove(path)
                    freed += size
                    files += 1
                except OSError:
                    kept += 1
    return {"ok": True, "freed": freed, "files": files, "kept": kept}


def _clean_comfy(hours):
    """Crackio's own files in ComfyUI's input/crackio and output/crackio older than `hours`: every result is in Crackio's
    Library already, and an input it needs again is uploaded again."""
    cutoff = time.time() - hours * 3600
    freed = files = 0
    for kind in ("input", "output"):
        base = _comfy_dirs().get(kind)
        own = os.path.join(base, "crackio") if base else None
        if not own or not os.path.isdir(own):
            continue
        old = []
        _du(own, lambda path, size, mtime: mtime < cutoff and old.append((path, size)))
        for path, size in old:
            try:
                os.remove(path)
                freed += size
                files += 1
            except OSError:
                pass
        for d, subdirs, names in os.walk(own, topdown=False):
            if d != own and not subdirs and not names:
                try:
                    os.rmdir(d)
                except OSError:
                    pass
    return {"ok": True, "freed": freed, "files": files}


@PromptServer.instance.routes.post("/crackio/storage/clean")
async def storage_clean(request):
    try:
        body = await request.json()
    except Exception:
        body = None
    what = body.get("what") if isinstance(body, dict) else None
    loop = asyncio.get_running_loop()
    if what == "parts":
        answer = await loop.run_in_executor(None, _clean_parts)
    elif what == "comfy":
        try:
            working = PromptServer.instance.prompt_queue.get_tasks_remaining() > 0
        except Exception:
            working = False
        if working:
            return web.json_response({"error": "ComfyUI is working on a job: clean up once it's done."}, status=409)
        try:
            hours = float(body.get("older_than_hours", 24))
        except (TypeError, ValueError):
            hours = 24.0
        answer = await loop.run_in_executor(None, _clean_comfy, min(max(hours, 1.0), 24.0 * 3650))
    else:
        return web.json_response({"error": 'Say what to clean: "parts" or "comfy".'}, status=400)
    _forget_walk()
    return web.json_response(answer)
