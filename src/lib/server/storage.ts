import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { comfyTargets, isHere, withTarget, type ComfyTarget } from "./comfy-targets";
import { forgetInstalled, LocalError, removeFile } from "./local-models";
import { allLocalModels } from "./local-templates";
import { curated, loraLibrary } from "./loras";
import { getSettings, updateSettings } from "./settings";
import { busyCount } from "./comfy-busy";
import { installedVariant } from "@/lib/local/rows";
import { LFM3_FILES, LFM3_FOLDER, LFM3_LORAS, LFM3_NAME, type Lfm3LoraKey } from "@/lib/local/lfm3";
import { LIPSYNC_FILES } from "@/lib/lipsync/machines";
import { KITS } from "@/lib/setup/kits";
import { HEARING, VOICE_MODELS } from "@/lib/voice/models";
import type { LocalFile, LocalModel, TargetStatus } from "@/lib/local/types";
import {
  CAP_WARN_AT,
  GB,
  REBUILDABLE_CACHE,
  RESERVE_BYTES,
  STORAGE_BRIDGE,
  TIGHT_BYTES,
  formatBytes,
  type CacheKind,
  type DataKind,
  type DriveHold,
  type InstallPlan,
  type StorageData,
  type StorageDrive,
  type StorageModel,
  type StorageRemove,
  type StorageReport,
  type StorageSuggestion,
} from "@/lib/storage/types";

/**
 * Settings → Storage on the server: what Crackio keeps on each machine (its models there, and on this computer its data
 * folder), where each machine's downloads go, the limit you set per machine, and whether an install fits before it starts.
 *
 * A machine with the Crackio bridge 1.10 (comfyui/crackio_bridge/storage.py) measures its own model folders, says where a
 * download goes, takes a download folder and cleans up after itself. An older bridge (or none) gets what ComfyUI and the
 * catalog say: its files by name, their sizes from the catalog (measured with fs on this computer), its free disk.
 */

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The machine id used for this computer when it has no ComfyUI (only its data folder to show). */
const THIS_COMPUTER = "this-computer";
/** Folders in ComfyUI's table that aren't model folders. */
const NOT_MODELS = new Set(["custom_nodes", "configs", "datasets"]);
/** ComfyUI-GGUF's lists and the legacy names, as the folders they are. */
const ALIASES: Record<string, string> = { unet_gguf: "diffusion_models", clip_gguf: "text_encoders", unet: "diffusion_models", clip: "text_encoders" };
/** What the bridge's /crackio/delete takes (one file in a model folder, a model file's extension). */
const REMOVABLE = /^[\w.\-+ ()[\]]{1,200}\.(safetensors|gguf|pt|pth|bin|ckpt|onnx|sft)$/i;
/** A .part untouched this long, and not being fetched, is a leftover (as the bridge cleans). */
const PART_QUIET_MS = 10 * 60_000;

const atLeast = (version: string | null | undefined, min: string) => Boolean(version) && version!.localeCompare(min, undefined, { numeric: true }) >= 0;
const canonical = (folder: string) => ALIASES[folder] ?? folder;
const fileKey = (folder: string, name: string) => `${canonical(folder)}/${name.replace(/\\/g, "/")}`;

/* ------------------------------------------------------------------ talking to a machine */

async function get<T>(t: ComfyTarget, pathname: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const res = await fetch(`${t.url}${pathname}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: t.token ? { Authorization: `Bearer ${t.token}` } : {} });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function post<T>(t: ComfyTarget, pathname: string, body: unknown, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; body: Partial<T> & { error?: string } }> {
  try {
    const res = await fetch(`${t.url}${pathname}`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Partial<T> & { error?: string } };
  } catch {
    return { ok: false, status: 502, body: { error: `${t.label} didn't answer.` } as Partial<T> & { error?: string } };
  }
}

/** What GET /crackio/info says (bridge 1.10 adds machine_id and download_root). */
type Info = { version?: string; machine_id?: string | null; download_root?: string | null; disk_free?: number | null; disk_total?: number | null };

/** What GET /crackio/storage says (bridge 1.10). */
type BridgeStorage = {
  machine_id: string | null;
  models_dir: string;
  root: string | null;
  also?: string[];
  drives: { path: string; free: number | null; total: number | null }[];
  folders: Record<string, { target: string | null; paths: { path: string; exists: boolean; bytes: number; files: number }[] }>;
  sizes: Record<string, Record<string, number>>;
  parts: { folder: string; name: string; path: string; bytes: number; mtime: number }[];
  comfy: { input: number; output: number; temp: number; crackio_input: number; crackio_output: number; crackio_old?: number; dirs?: Record<string, string | null> };
  engines: Record<"audiocpp" | "lipsync", { path: string; bytes: number; files: number } | null>;
  walked_at: number | null;
};

type VoiceStatus = { engine?: { dir?: string } | null; models?: { file: string; bytes: number }[] };
type LipsyncStatus = { folder?: string; models?: Record<string, boolean> };
type Download = { folder: string; filename: string; state: string; received: number; total: number };

function updateHint(t: ComfyTarget) {
  if (isHere(t)) return "Restarting this computer's ComfyUI (Local page) brings it.";
  if (t.cloud) return "Reconnecting the box on the Local page brings it.";
  return "Copy comfyui/crackio_bridge into that ComfyUI's custom_nodes folder and restart it.";
}

/* ------------------------------------------------------------------ disks */

/** A path, or its nearest parent that exists. */
async function existing(p: string): Promise<string | null> {
  let at = path.resolve(/*turbopackIgnore: true*/ p);
  for (;;) {
    if (await fs.stat(at).then(() => true, () => false)) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The drive a path on this computer is on: "C:\\" on Windows, its mount point elsewhere. */
async function mountOf(p: string): Promise<string | null> {
  const at = await existing(p);
  if (!at) return null;
  if (process.platform === "win32") return path.parse(at).root;
  try {
    const dev = (await fs.stat(at)).dev;
    let cur = at;
    for (;;) {
      const up = path.dirname(cur);
      if (up === cur || (await fs.stat(up)).dev !== dev) return cur;
      cur = up;
    }
  } catch {
    return at;
  }
}

async function diskAt(p: string): Promise<{ free: number; total: number } | null> {
  const at = await existing(p);
  if (!at) return null;
  try {
    const s = await fs.statfs(at);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Paths compared the way their machine does: separators alike, and case-blind where there's a drive letter. */
function normPath(p: string) {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
}
const inside = (child: string, parent: string) => {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
};
const driveLabel = (root: string) => (/^[a-z]:[\\/]?$/i.test(root) ? root.slice(0, 2).toUpperCase() : root.replace(/[\\/]+$/, "") || "/");
const parentOf = (p: string) => p.replace(/[\\/]+[^\\/]+[\\/]*$/, "") || p;
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
const joinOn = (base: string, name: string) => `${base.replace(/[\\/]+$/, "")}${base.includes("\\") ? "\\" : "/"}${name}`;

/* ------------------------------------------------------------------ walking folders on this computer */

type Seen = { rel: string; size: number; mtimeMs: number };

/** Every file under `root` (opendir, so a big folder streams), links and junctions skipped. */
async function walk(root: string, onFile: (f: Seen) => void) {
  const stack: [string, string][] = [[root, ""]];
  while (stack.length) {
    const [dir, rel] = stack.pop()!;
    const files: string[] = [];
    try {
      for await (const e of await fs.opendir(dir, { bufferSize: 256 })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push([path.join(/*turbopackIgnore: true*/ dir, e.name), rel ? `${rel}/${e.name}` : e.name]);
        else if (e.isFile()) files.push(e.name);
      }
    } catch {
      continue; // gone, or not ours to read
    }
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map(async (name) => {
          const st = await fs.lstat(path.join(/*turbopackIgnore: true*/ dir, name)).catch(() => null);
          if (st?.isFile()) onFile({ rel: rel ? `${rel}/${name}` : name, size: st.size, mtimeMs: st.mtimeMs });
        }),
      );
    }
  }
}

/* ------------------------------------------------------------------ Crackio's data folder */

const REBUILDABLE = new Set<string>(REBUILDABLE_CACHE);
/** Cache folders the app doesn't make: test harnesses and training material (and a removed provider's leftovers). */
const DEV_CACHE = new Set(["angles-lora", "angles-v2", "angles-handoff", "sbtest", "fal"]);
/** Kept when the cache is cleared: place-build timings (estimates) and where voices were last seen. */
const KEPT = new Set(["cache/world/timings.jsonl", "cache/voice-seen.json"]);

const DATA_ROWS: Record<DataKind, { label: string; clearable: boolean; note?: string }> = {
  takes: { label: "Library takes", clearable: false, note: "Delete takes in the Library: each goes with its previews and how it was made." },
  motion: { label: "Motion projects", clearable: false, note: "Renders and projects: delete them in Motion." },
  uploads: { label: "Uploads", clearable: false, note: "Pictures and clips you added, and Director's cut-outs and plates." },
  voices: { label: "Your voices", clearable: false },
  templates: { label: "Template clips", clearable: false, note: "The clips Templates starts from, kept on this computer." },
  cache: {
    label: "Rebuildable cache",
    clearable: true,
    note: "Previews, depth and cut-outs, Director's and Cast's work in progress: made again when needed (a Director place takes a minute or two to remake).",
  },
  logs: { label: "Logs and ratings", clearable: false, note: "Swap checks and your ratings; the swap log trims itself." },
  models: { label: "Small models Crackio runs itself", clearable: false, note: "Depth, cut-outs and 3D for Director and Angles: downloaded again when needed." },
  dev: { label: "Developer files", clearable: false, note: "Training runs, upload staging and test material: not product data, nothing in the app reads them." },
  db: { label: "Database and settings", clearable: false },
  other: { label: "Other", clearable: false },
};
const DATA_ORDER: DataKind[] = ["takes", "uploads", "motion", "voices", "templates", "cache", "logs", "models", "dev", "db", "other"];

/** What a file in the data folder is, by its path there ("media/motion/…"). */
function dataKind(rel: string): DataKind {
  if (KEPT.has(rel)) return "db";
  const [top, sub, ...rest] = rel.split("/");
  if (sub === undefined) {
    // A file at the top of the data folder.
    if (/^crackio\.db/.test(top) || /^(settings|loras|local-speeds|comfy-install)\.json$/.test(top)) return "db";
    if (top === "voices.json") return "voices";
    if (top === "motion-recent.json") return "motion";
    if (/backup/i.test(top)) return "dev";
    return /\.(json|jsonl)$/.test(top) ? "db" : "other";
  }
  switch (top) {
    case "media":
      return sub === "motion" ? "motion" : sub === "feedback" ? "logs" : sub === "voices" ? "voices" : "takes";
    case "recipes":
      return "takes";
    case "motion":
      return "motion";
    case "uploads":
      return "uploads";
    case "templates":
      return "templates";
    case "feedback":
      return "logs";
    case "models":
      return "models";
    case "lfm3":
    case "hf":
    case "backups":
    case "gpu":
      return "dev";
    case "certs":
    case "ssh":
    case "serverless":
    case "accounts":
      return "db";
    case "cache":
      if (rest.length === 0) return "db"; // a file at the top of cache/ (voice-seen.json)
      if (REBUILDABLE.has(sub)) return "cache";
      return DEV_CACHE.has(sub) ? "dev" : "other";
    default:
      return "other";
  }
}

export type DataUsage = { at: number; rows: StorageData[]; totalBytes: number; cacheBytes: number };

const g = globalThis as unknown as {
  __crackioDataUsage?: { at: number; value: Promise<DataUsage> };
  __crackioStorageReports?: Map<string, { at: number; value: Promise<StorageReport> }>;
  __crackioStorageLocal?: Map<string, { at: number; value: Promise<LocalComfy> }>;
  __crackioRunnerState?: { active?: Map<string, unknown> };
};

/**
 * This computer's Crackio data folder by what it is, walked at most every 10 minutes (about 30,000 files: a few seconds,
 * off the request's path once it's cached).
 */
export function dataUsage(fresh = false): Promise<DataUsage> {
  const hit = g.__crackioDataUsage;
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = (async () => {
    const sums = new Map<DataKind, { bytes: number; files: number }>();
    let cacheBytes = 0;
    await walk(DATA_DIR, (f) => {
      const kind = dataKind(f.rel);
      const s = sums.get(kind) ?? { bytes: 0, files: 0 };
      s.bytes += f.size;
      s.files += 1;
      sums.set(kind, s);
      if (kind === "cache") cacheBytes += f.size;
    });
    const rows = DATA_ORDER.filter((k) => sums.get(k)?.files).map((kind): StorageData => ({ kind, ...DATA_ROWS[kind], ...sums.get(kind)! }));
    return { at: Date.now(), rows, totalBytes: rows.reduce((n, r) => n + r.bytes, 0), cacheBytes };
  })();
  g.__crackioDataUsage = { at: Date.now(), value };
  value.catch(() => (g.__crackioDataUsage = undefined));
  return value;
}

function forgetDataUsage() {
  g.__crackioDataUsage = undefined;
}

/** Whether Crackio is making something now (a job in its queue, or work on any ComfyUI). */
async function working() {
  if ((g.__crackioRunnerState?.active?.size ?? 0) > 0) return true;
  return (await comfyTargets()).some((t) => busyCount(t.id) > 0);
}

/** Empties rebuildable cache folders (data/cache/<kind>, or all of them), keeping place timings and voice sightings. */
export async function clearCache(kind: CacheKind) {
  if (kind !== "all" && !REBUILDABLE.has(kind)) throw new StorageError("That isn't a cache Crackio can clear.");
  if (await working()) throw new StorageError("Crackio is working on something: clear the cache once it's done.", 409);
  let freed = 0;
  let files = 0;
  for (const k of kind === "all" ? REBUILDABLE_CACHE : [kind]) {
    const dir = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", k);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (KEPT.has(`cache/${k}/${e.name}`)) continue;
      const at = path.join(/*turbopackIgnore: true*/ dir, e.name);
      let bytes = 0;
      let count = 0;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        await walk(at, (f) => {
          bytes += f.size;
          count += 1;
        });
      } else if (e.isFile()) {
        bytes = (await fs.lstat(at).catch(() => null))?.size ?? 0;
        count = 1;
      }
      try {
        await fs.rm(at, { recursive: true, force: true });
        freed += bytes;
        files += count;
      } catch {
        // in use (Windows): it goes next time
      }
    }
  }
  forgetDataUsage();
  forgetReports();
  return { ok: true, freed, files };
}

/* ------------------------------------------------------------------ one machine, looked at */

/** ComfyUI's input/output/temp on this computer, for a ComfyUI whose bridge doesn't measure them (before 1.10). */
type LocalComfy = { inputBytes: number; outputBytes: number; tempBytes: number; crackioBytes: number; crackioOldBytes: number };

function localComfy(base: string): Promise<LocalComfy> {
  const cache = (g.__crackioStorageLocal ??= new Map());
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = (async () => {
    const out: LocalComfy = { inputBytes: 0, outputBytes: 0, tempBytes: 0, crackioBytes: 0, crackioOldBytes: 0 };
    const dayAgo = Date.now() - 86_400_000;
    for (const kind of ["input", "output", "temp"] as const) {
      await walk(path.join(/*turbopackIgnore: true*/ base, kind), (f) => {
        out[`${kind}Bytes`] += f.size;
        if (kind !== "temp" && f.rel.startsWith("crackio/")) {
          out.crackioBytes += f.size;
          if (f.mtimeMs < dayAgo) out.crackioOldBytes += f.size;
        }
      });
    }
    return out;
  })();
  cache.set(base, { at: Date.now(), value });
  return value;
}

type Drive = { key: string; path: string; free: number | null; total: number | null };

/** Everything the report and the install check need from one machine, read once. */
type Look = {
  t: ComfyTarget | null;
  id: string;
  label: string;
  here: boolean;
  online: boolean;
  bridge: string | null;
  info: Info | null;
  storage: BridgeStorage | null;
  /** Model folder → its paths (not custom_nodes and the like). */
  folders: Record<string, string[]>;
  modelsDir: string | null;
  /** Model folder → where a download into it goes now. */
  targets: Record<string, string>;
  root: string | null;
  also: string[];
  /** ComfyUI's own folder (input, output, custom_nodes are in it). */
  base: string | null;
  drives: Drive[];
  /** The drive a path is on (its key in `drives`), or null when the machine doesn't say. */
  driveOf: (p: string) => string | null;
  /** Model folder paths known to hold files (or, measured here, to exist). */
  present: Set<string>;
};

/** The folder named like its type inside the models folder, else the folder's first path: the bridge's rule before 1.10. */
function defaultTarget(name: string, paths: string[], modelsDir: string | null) {
  return paths.find((p) => baseName(p) === name && modelsDir !== null && inside(p, modelsDir)) ?? paths[0];
}

async function look(t: ComfyTarget | null, opts: { walk: boolean; fresh?: boolean }): Promise<Look> {
  const here = t ? isHere(t) : true;
  const empty: Look = { t, id: t?.id ?? THIS_COMPUTER, label: t?.label ?? "This computer", here, online: false, bridge: null, info: null, storage: null, folders: {}, modelsDir: null, targets: {}, root: null, also: [], base: null, drives: [], driveOf: () => null, present: new Set() };
  if (t?.metered === "comfy-cloud") return empty;
  const timeout = here ? 4000 : 8000;
  const info = t ? await get<Info>(t, "/crackio/info", timeout) : null;
  const online = Boolean(info) || (t ? (await get(t, "/system_stats", timeout)) !== null : false);
  const bridge = info?.version ?? null;
  const storage = t && online && atLeast(bridge, STORAGE_BRIDGE) ? await get<BridgeStorage>(t, `/crackio/storage?${opts.walk ? (opts.fresh ? "fresh=1" : "") : "walk=0"}`, opts.walk ? 120_000 : 10_000) : null;
  const folders: Record<string, string[]> = {};
  if (storage) {
    for (const [name, f] of Object.entries(storage.folders)) if (!NOT_MODELS.has(name)) folders[name] = f.paths.map((p) => p.path);
  } else if (t && online && !t.serverless) {
    const raw = await get<Record<string, (string | [string, ...unknown[]])[]>>(t, "/internal/folder_paths", timeout);
    for (const [name, list] of Object.entries(raw ?? {})) {
      const paths = (Array.isArray(list) ? list : []).map((p) => (Array.isArray(p) ? p[0] : p)).filter((p): p is string => typeof p === "string");
      if (name === "custom_nodes" && paths[0]) folders[name] = paths;
      else if (!NOT_MODELS.has(name) && !ALIASES[name]) folders[name] = paths;
    }
  }
  const nodes = folders.custom_nodes?.[0];
  delete folders.custom_nodes;
  // The models folder: the bridge says it; else the parent most standard folders' own paths share.
  let modelsDir = storage?.models_dir ?? null;
  if (!modelsDir) {
    const votes = new Map<string, number>();
    for (const [name, paths] of Object.entries(folders)) for (const p of paths) if (baseName(p) === name) votes.set(parentOf(p), (votes.get(parentOf(p)) ?? 0) + 1);
    modelsDir = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  const root = storage?.root ?? info?.download_root ?? null;
  const targets: Record<string, string> = {};
  for (const [name, paths] of Object.entries(folders)) {
    const target = storage?.folders[name]?.target ?? (root ? joinOn(root, name) : paths.length ? defaultTarget(name, paths, modelsDir) : null);
    if (target) targets[name] = target;
  }
  const outputDir = storage?.comfy.dirs?.output ?? null;
  const base = outputDir ? parentOf(outputDir) : nodes ? parentOf(nodes) : null;

  // Drives: the bridge's (1.10), measured here on this computer, else the models folder's from /crackio/info.
  const drives: Drive[] = [];
  let driveOf: (p: string) => string | null = () => null;
  if (here) {
    const paths = [DATA_DIR, ...Object.values(folders).flat(), ...Object.values(targets), ...(root ? [root] : []), ...(storage?.also ?? []), ...(base ? [base] : [])];
    const mounts = new Map<string, string>();
    await Promise.all(
      [...new Set(paths)].map(async (p) => {
        const m = await mountOf(p);
        if (m) mounts.set(p, m);
      }),
    );
    for (const m of new Set(mounts.values())) {
      const d = await diskAt(m);
      drives.push({ key: normPath(m), path: m, free: d?.free ?? null, total: d?.total ?? null });
    }
    driveOf = (p) => {
      const m = mounts.get(p);
      if (m) return normPath(m);
      return drives.filter((d) => inside(p, d.path)).sort((a, b) => b.key.length - a.key.length)[0]?.key ?? null;
    };
  } else if (storage) {
    for (const d of storage.drives) drives.push({ key: normPath(d.path), path: d.path, free: d.free, total: d.total });
    driveOf = (p) => drives.filter((d) => inside(p, d.path)).sort((a, b) => b.key.length - a.key.length)[0]?.key ?? null;
  } else if (modelsDir && typeof info?.disk_free === "number") {
    drives.push({ key: normPath(modelsDir), path: modelsDir, free: info.disk_free, total: info.disk_total ?? null });
    driveOf = (p) => (inside(p, modelsDir!) ? normPath(modelsDir!) : null);
  }
  const present = new Set<string>();
  if (storage) {
    for (const f of Object.values(storage.folders)) for (const p of f.paths) if (p.exists && p.files > 0) present.add(p.path);
  } else if (here) {
    await Promise.all(Object.values(folders).flat().map(async (p) => void ((await fs.stat(p).then((s) => s.isDirectory(), () => false)) && present.add(p))));
  } else if (modelsDir) {
    present.add(modelsDir);
  }
  return { t, id: t?.id ?? THIS_COMPUTER, label: t?.label ?? "This computer", here, online, bridge, info, storage, folders, modelsDir, targets, root, also: storage?.also ?? [], base, drives, driveOf, present };
}

/* ------------------------------------------------------------------ what's on a machine */

const KIT_IDS_BY_MODEL = new Map<string, Set<string>>();
for (const kit of KITS) {
  for (const r of kit.needs) {
    if (r.need.kind !== "model") continue;
    for (const id of r.need.anyOf) KIT_IDS_BY_MODEL.set(id, (KIT_IDS_BY_MODEL.get(id) ?? new Set()).add(kit.id));
  }
}
const kitsWhere = (test: (need: (typeof KITS)[number]["needs"][number]["need"]) => boolean) => KITS.filter((k) => k.needs.some((r) => test(r.need))).map((k) => k.id as string);

/** The tools (kit ids) a catalog model is in: those that list it, else the page its pickers offer it on. */
function toolsOf(m: LocalModel): string[] {
  const out = new Set<string>(m.crackio ? (KIT_IDS_BY_MODEL.get(m.crackio) ?? []) : []);
  if (m.tool) out.add(m.tool);
  if (!out.size && m.crackio) out.add(m.tasks.includes("upscale") ? "upscale" : m.tasks.includes("swap") ? "recast" : m.unit === "clip" ? "video" : "image");
  return [...out];
}

/** Every model file on a machine as `folder/name` (any format, every model folder), from its bridge or ComfyUI's lists. */
async function filesOn(lk: Look): Promise<Set<string>> {
  const out = new Set<string>();
  if (!lk.t || !lk.online) return out;
  const t = lk.t;
  const listed = lk.bridge ? await get<Record<string, string[]>>(t, "/crackio/files", 20_000) : null;
  if (listed) {
    for (const [folder, names] of Object.entries(listed)) if (!NOT_MODELS.has(folder)) for (const n of names) out.add(fileKey(folder, n));
  } else {
    const folders = [...new Set([...allLocalModels().flatMap((m) => m.variants.flatMap((v) => v.files.map((f) => f.folder as string))), ...Object.keys(lk.folders)]), "unet_gguf", "clip_gguf"];
    const lists = await Promise.all(folders.map(async (f) => [f, (await get<string[]>(t, `/models/${f}`, 8000)) ?? []] as const));
    for (const [folder, names] of lists) for (const n of names) out.add(fileKey(folder, n));
  }
  for (const [folder, names] of Object.entries(lk.storage?.sizes ?? {})) for (const n of Object.keys(names)) out.add(fileKey(folder, n));
  return out;
}

/** Each file's real size: the bridge's walk (1.10), or measured here on this computer. */
async function sizesOn(lk: Look, have: Set<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [folder, names] of Object.entries(lk.storage?.sizes ?? {})) for (const [n, b] of Object.entries(names)) out.set(fileKey(folder, n), b);
  if (lk.storage || !lk.here) return out;
  await Promise.all(
    [...have].map(async (key) => {
      const cut = key.indexOf("/");
      const folder = key.slice(0, cut);
      const name = key.slice(cut + 1);
      for (const p of lk.folders[folder] ?? []) {
        const st = await fs.lstat(path.join(/*turbopackIgnore: true*/ p, name)).catch(() => null);
        if (st?.isFile()) {
          out.set(key, st.size);
          return;
        }
      }
    }),
  );
  return out;
}

const removeFilesBody = (machine: string, files: { folder: string; file: string }[]): StorageRemove | undefined => {
  const ok = files.filter((f) => REMOVABLE.test(f.file));
  return ok.length ? { method: "POST", url: "/api/settings/storage", body: { action: "remove-files", machine, files: ok } } : undefined;
};

type Inventory = { models: StorageModel[]; usedBytes: number; unknownBytes: number };

/** Every model a machine keeps, what each is for, and what Crackio's own take there in all. */
async function inventory(lk: Look): Promise<Inventory> {
  if (!lk.t || !lk.online || lk.t.metered === "comfy-cloud") return { models: [], usedBytes: 0, unknownBytes: 0 };
  const t = lk.t;
  const canRemove = !t.metered && !t.serverless;
  const have = await filesOn(lk);
  const measured = await sizesOn(lk, have);
  const [voice, lipsync] = await Promise.all([
    atLeast(lk.bridge, "1.8.0") ? get<VoiceStatus>(t, "/crackio/voice", 8000) : null,
    atLeast(lk.bridge, "1.9.0") ? get<LipsyncStatus>(t, "/crackio/lipsync", 8000) : null,
  ]);
  const models: StorageModel[] = [];
  /** File key → its bytes, for every file Crackio knows here (counted once, however many models share it). */
  const known = new Map<string, number>();
  const sizeOf = (key: string, fallback: number) => measured.get(key) ?? fallback;
  const claim = (key: string, bytes: number) => known.set(key, bytes);

  // Catalog models with every file of a version here.
  const catalog = allLocalModels();
  const listed: TargetStatus = { installed: [...have] } as TargetStatus;
  const complete = catalog.map((m) => ({ m, v: installedVariant(m, listed) })).filter((x) => x.v !== null);
  const usedBy = new Map<string, number>();
  for (const { v } of complete) for (const f of v!.files) usedBy.set(fileKey(f.folder, f.name), (usedBy.get(fileKey(f.folder, f.name)) ?? 0) + 1);
  for (const { m, v } of complete) {
    const files = v!.files.map((f) => ({ key: fileKey(f.folder, f.name), f, bytes: sizeOf(fileKey(f.folder, f.name), f.bytes) }));
    for (const x of files) claim(x.key, x.bytes);
    const main = v!.files.find((f) => f.role === "model") ?? v!.files[0];
    models.push({
      id: `catalog:${m.id}`,
      name: m.name,
      variant: m.variants.length > 1 ? v!.label : null,
      variantId: v!.id,
      bytes: files.reduce((n, x) => n + x.bytes, 0),
      freesBytes: files.filter((x) => (usedBy.get(x.key) ?? 0) <= 1).reduce((n, x) => n + x.bytes, 0),
      tools: toolsOf(m),
      kind: "catalog",
      folder: main?.folder,
      file: main?.name,
      sizeKnown: files.every((x) => measured.has(x.key)),
      ...(canRemove ? { remove: { method: "POST" as const, url: "/api/local", body: { action: "remove", model: m.id, variant: v!.id, target: t.id } } } : {}),
    });
  }
  // Catalog files here without a whole version (a download that stopped, a shared file left behind): with the first
  // model that uses each, so one file never shows twice.
  const firstOwner = new Map<string, { m: LocalModel; f: LocalFile }>();
  for (const m of catalog) for (const v of m.variants) for (const f of v.files) if (!firstOwner.has(fileKey(f.folder, f.name))) firstOwner.set(fileKey(f.folder, f.name), { m, f });
  const partial = new Map<string, { m: LocalModel; files: { key: string; f: LocalFile; bytes: number }[] }>();
  for (const key of have) {
    if (known.has(key)) continue;
    const owner = firstOwner.get(key);
    if (!owner) continue;
    const row = partial.get(owner.m.id) ?? { m: owner.m, files: [] };
    row.files.push({ key, f: owner.f, bytes: sizeOf(key, owner.f.bytes) });
    partial.set(owner.m.id, row);
  }
  for (const { m, files } of partial.values()) {
    for (const x of files) claim(x.key, x.bytes);
    const bytes = files.reduce((n, x) => n + x.bytes, 0);
    models.push({
      id: `partial:${m.id}`,
      name: m.name,
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: toolsOf(m),
      kind: "catalog",
      folder: files[0].f.folder,
      file: files[0].f.name,
      sizeKnown: files.every((x) => measured.has(x.key)),
      partial: true,
      ...(canRemove ? { remove: removeFilesBody(t.id, files.map((x) => ({ folder: x.f.folder, file: x.f.name }))) } : {}),
    });
  }

  // LoRAs Crackio downloaded (its picks, and found ones it kept a record of).
  const { records } = await loraLibrary();
  const picks = new Map<string, { name: string; bytes: number; models: string[] }>();
  for (const e of curated()) e.local?.forEach((name, i) => picks.set(name, { name: e.name, bytes: e.files[i]?.bytes ?? 0, models: e.models }));
  for (const r of Object.values(records)) if (!picks.has(r.file)) picks.set(r.file, { name: r.name, bytes: r.bytes, models: r.models });
  for (const key of have) {
    if (known.has(key) || !key.startsWith("loras/")) continue;
    const file = key.slice("loras/".length);
    const pick = picks.get(file);
    if (!pick) continue;
    const bytes = sizeOf(key, pick.bytes);
    claim(key, bytes);
    const tools = new Set(pick.models.flatMap((id) => {
      const m = catalog.find((x) => x.id === id);
      return m ? toolsOf(m) : [];
    }));
    models.push({
      id: `lora:${file}`,
      name: pick.name,
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: [...tools],
      kind: "lora",
      folder: "loras",
      file,
      sizeKnown: measured.has(key),
      ...(canRemove ? { remove: { method: "POST" as const, url: "/api/local/loras/library", body: { action: "remove", file, target: t.id } } } : {}),
    });
  }

  // Voice: its models, speech to text, and the engine (audio.cpp).
  const voiceKits = (clone: boolean) => kitsWhere((n) => n.kind === "voice" && (!n.clone || clone));
  for (const vm of VOICE_MODELS) {
    for (const variant of vm.variants) {
      const key = fileKey("audiocpp", variant.file.name);
      if (!have.has(key) || known.has(key)) continue;
      const bytes = sizeOf(key, voice?.models?.find((x) => x.file === variant.file.name)?.bytes ?? variant.file.bytes);
      claim(key, bytes);
      models.push({
        id: `voice:${vm.id}:${variant.id}`,
        name: vm.name,
        variant: vm.variants.length > 1 ? variant.label : null,
        bytes,
        freesBytes: bytes,
        tools: voiceKits(vm.can.clone),
        kind: "voice",
        folder: "audiocpp",
        file: variant.file.name,
        sizeKnown: measured.has(key) || Boolean(voice?.models?.length),
        ...(canRemove ? { remove: { method: "DELETE" as const, url: "/api/voice/install", body: { model: vm.id, machine: t.id } } } : {}),
      });
    }
  }
  const hearing = HEARING.filter((h) => have.has(fileKey("audiocpp", h.name)) && !known.has(fileKey("audiocpp", h.name)));
  if (hearing.length) {
    const files = hearing.map((h) => ({ key: fileKey("audiocpp", h.name), h, bytes: sizeOf(fileKey("audiocpp", h.name), voice?.models?.find((x) => x.file === h.name)?.bytes ?? h.bytes) }));
    for (const x of files) claim(x.key, x.bytes);
    const bytes = files.reduce((n, x) => n + x.bytes, 0);
    models.push({
      id: "voice:hearing",
      name: "Speech to text (Qwen3-ASR)",
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: kitsWhere((n) => n.kind === "voice"),
      kind: "voice",
      folder: "audiocpp",
      file: files[0].h.name,
      sizeKnown: files.every((x) => measured.has(x.key)),
      ...(canRemove ? { remove: removeFilesBody(t.id, files.map((x) => ({ folder: "audiocpp", file: x.h.name }))) } : {}),
    });
  }
  let engineBytes = 0;
  const engines: { key: "audiocpp" | "lipsync"; name: string; tools: string[]; dir: string | null }[] = [
    { key: "audiocpp", name: "Voice engine (audio.cpp)", tools: kitsWhere((n) => n.kind === "voice"), dir: voice?.engine?.dir ? parentOf(voice.engine.dir) : null },
    { key: "lipsync", name: "Lip Sync engine", tools: kitsWhere((n) => n.kind === "lipsync"), dir: lipsync?.folder ? joinOn(parentOf(lipsync.folder), "lipsync-engine") : null },
  ];
  for (const e of engines) {
    let size = lk.storage?.engines?.[e.key] ?? null;
    if (!size && !lk.storage && lk.here && e.dir) {
      // An older bridge on this computer: measured here.
      let bytes = 0;
      let files = 0;
      await walk(e.dir, (f) => {
        bytes += f.size;
        files += 1;
      });
      size = files ? { path: e.dir, bytes, files } : null;
    }
    if (!size?.bytes) continue;
    engineBytes += size.bytes;
    models.push({ id: `engine:${e.key}`, name: e.name, variant: null, bytes: size.bytes, freesBytes: size.bytes, tools: e.tools, kind: e.key === "audiocpp" ? "voice" : "lipsync", sizeKnown: true });
  }

  // LFM3-VL: the model and Crackio's fine-tunes. No remove here: its runtime folder holds a link to the weights, so
  // deleting the file alone frees nothing.
  const lfm3Files = LFM3_FILES.filter((f) => have.has(fileKey(LFM3_FOLDER, f.name)) && !known.has(fileKey(LFM3_FOLDER, f.name)));
  if (lfm3Files.length) {
    const files = lfm3Files.map((f) => ({ key: fileKey(LFM3_FOLDER, f.name), bytes: sizeOf(fileKey(LFM3_FOLDER, f.name), f.bytes) }));
    for (const x of files) claim(x.key, x.bytes);
    const bytes = files.reduce((n, x) => n + x.bytes, 0);
    models.push({
      id: "lfm3:model",
      name: LFM3_NAME,
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: kitsWhere((n) => n.kind === "lfm3" || n.kind === "lfm3-lora"),
      kind: "lfm3",
      folder: LFM3_FOLDER,
      file: LFM3_FILES[0].name,
      sizeKnown: files.every((x) => measured.has(x.key)),
      partial: lfm3Files.length < LFM3_FILES.length || undefined,
    });
  }
  const LORA_NAMES: Record<Lfm3LoraKey, string> = { judge: "Crackio's swap judge (LFM3-VL)", retouch: "Crackio's eyes for Retouch (LFM3-VL)", chat: "Talk's chat voice (LFM3-VL)" };
  for (const [k, lora] of Object.entries(LFM3_LORAS) as [Lfm3LoraKey, (typeof LFM3_LORAS)[Lfm3LoraKey]][]) {
    const key = fileKey(LFM3_FOLDER, lora.name);
    if (!have.has(key) || known.has(key)) continue;
    const bytes = sizeOf(key, lora.bytes);
    claim(key, bytes);
    models.push({
      id: `lfm3:${k}`,
      name: LORA_NAMES[k],
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: kitsWhere((n) => n.kind === "lfm3-lora" && n.lora === k),
      kind: "lfm3",
      folder: LFM3_FOLDER,
      file: lora.name,
      sizeKnown: measured.has(key),
      ...(canRemove ? { remove: removeFilesBody(t.id, [{ folder: LFM3_FOLDER, file: lora.name }]) } : {}),
    });
  }

  // Lip Sync: LatentSync's files and MediaPipe's landmarkers.
  const lipsyncFiles = LIPSYNC_FILES.filter((f) => have.has(fileKey("latentsync", f.name)) && !known.has(fileKey("latentsync", f.name)));
  const tasks = ["face_landmarker.task", "hand_landmarker.task"].filter((n) => have.has(fileKey("mediapipe", n)) && !known.has(fileKey("mediapipe", n)));
  if (lipsyncFiles.length || tasks.length) {
    const files = [
      ...lipsyncFiles.map((f) => ({ folder: "latentsync", file: f.name, bytes: sizeOf(fileKey("latentsync", f.name), f.bytes) })),
      ...tasks.map((n) => ({ folder: "mediapipe", file: n, bytes: sizeOf(fileKey("mediapipe", n), 0) })),
    ];
    for (const x of files) claim(fileKey(x.folder, x.file), x.bytes);
    const bytes = files.reduce((n, x) => n + x.bytes, 0);
    models.push({
      id: "lipsync:latentsync",
      name: "LatentSync 1.6 (Lip Sync)",
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: kitsWhere((n) => n.kind === "lipsync"),
      kind: "lipsync",
      folder: "latentsync",
      file: files[0].file,
      sizeKnown: files.every((x) => measured.has(fileKey(x.folder, x.file))),
      ...(canRemove ? { remove: removeFilesBody(t.id, files.map(({ folder, file }) => ({ folder, file }))) } : {}),
    });
  }

  // Everything else in the model folders: no Crackio tool uses it (it may well be yours).
  let unknownBytes = 0;
  for (const key of have) {
    if (known.has(key)) continue;
    const cut = key.indexOf("/");
    const folder = key.slice(0, cut);
    const file = key.slice(cut + 1);
    if (folder === LFM3_FOLDER && file.endsWith(".json")) continue; // LFM3-VL's tokenizer without its weights: tiny
    // Bridge 1.10 measures every model file but those reached through a link (they take no room here).
    if (lk.storage && !measured.has(key)) continue;
    const bytes = measured.get(key) ?? 0;
    unknownBytes += bytes;
    models.push({
      id: `unknown:${key}`,
      name: file,
      variant: null,
      bytes,
      freesBytes: bytes,
      tools: [],
      kind: "unknown",
      folder,
      file,
      sizeKnown: measured.has(key),
      ...(canRemove ? { remove: removeFilesBody(t.id, [{ folder, file }]) } : {}),
    });
  }
  models.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const usedBytes = [...known.values()].reduce((n, b) => n + b, 0) + engineBytes;
  return { models, usedBytes, unknownBytes };
}

/* ------------------------------------------------------------------ the report */

async function pickTarget(targetId?: string | null): Promise<ComfyTarget | null> {
  const all = await comfyTargets();
  if (targetId) {
    const t = all.find((x) => x.id === targetId);
    if (t) return t;
    if (targetId === THIS_COMPUTER) return null;
    throw new StorageError("No such machine.", 404);
  }
  return all.find((t) => isHere(t) && !t.implicit) ?? all.find((t) => isHere(t)) ?? null;
}

function forgetReports(id?: string) {
  if (id) g.__crackioStorageReports?.delete(id);
  else g.__crackioStorageReports?.clear();
}

async function capFor(key: string, id: string) {
  const caps = (await getSettings()).storageCaps ?? {};
  const gb = caps[key] ?? caps[id];
  return typeof gb === "number" && gb > 0 ? gb * GB : null;
}

/**
 * One machine's storage for Settings: its drives, where its downloads go, its models and what uses them, this computer's
 * data folder, your limit, and one-click ways to make room. Kept 15 s (`fresh`: measured again).
 */
export function storageReport(targetId?: string | null, opts: { fresh?: boolean } = {}): Promise<StorageReport> {
  const cache = (g.__crackioStorageReports ??= new Map());
  const id = targetId || "";
  const hit = cache.get(id);
  if (!opts.fresh && hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = buildReport(targetId, opts);
  const entry = { at: Date.now(), value };
  cache.set(id, entry);
  // Fresh from when it's ready: a first look can take half a minute (the data folder's first walk).
  value.then(() => (entry.at = Date.now())).catch(() => cache.get(id) === entry && cache.delete(id));
  return value;
}

async function buildReport(targetId: string | null | undefined, opts: { fresh?: boolean }): Promise<StorageReport> {
  const t = await pickTarget(targetId);
  const lk = await look(t, { walk: true, fresh: opts.fresh });
  const [inv, data, local] = await Promise.all([
    inventory(lk),
    lk.here ? dataUsage(opts.fresh) : null,
    lk.here && !lk.storage && lk.base ? localComfy(lk.base).catch(() => null) : null,
  ]);
  const notes: string[] = [];
  const suggestions: StorageSuggestion[] = [];
  const metered = Boolean(t?.metered || t?.serverless);
  const canChooseFolder = Boolean(t && lk.online && !metered && atLeast(lk.bridge, STORAGE_BRIDGE));
  const key = lk.storage?.machine_id ?? lk.info?.machine_id ?? lk.id;

  // Where downloads go now: a diffusion model's folder (the biggest downloads), and its drive.
  const goesTo = lk.targets.diffusion_models ?? (lk.root ? joinOn(lk.root, "diffusion_models") : null);
  const dlKey = goesTo ? lk.driveOf(goesTo) : null;
  const dlDrive = lk.drives.find((d) => d.key === dlKey) ?? null;

  // Drives, with what each holds.
  const holds = new Map<string, Set<DriveHold>>();
  const mark = (p: string | null | undefined, h: DriveHold) => {
    const k = p ? lk.driveOf(p) : null;
    if (k) holds.set(k, (holds.get(k) ?? new Set()).add(h));
  };
  if (goesTo) mark(goesTo, "downloads");
  for (const p of lk.present) mark(p, "models");
  if (lk.here) mark(DATA_DIR, "data");
  if (lk.base) mark(lk.base, "comfyui");
  const order: DriveHold[] = ["downloads", "models", "data", "comfyui"];
  const drives: StorageDrive[] = lk.drives
    .filter((d) => d.free !== null && d.total !== null && (holds.get(d.key)?.size ?? 0) > 0)
    .map((d) => ({ path: d.path, label: driveLabel(d.path), freeBytes: d.free!, totalBytes: d.total!, holds: order.filter((h) => holds.get(d.key)?.has(h)) }))
    .sort((a, b) => order.indexOf(a.holds[0]) - order.indexOf(b.holds[0]) || a.label.localeCompare(b.label));

  // Unfinished downloads and ComfyUI's own folders.
  const now = Date.now();
  const parts = (lk.storage?.parts ?? []).reduce(
    (n, p) => ({ bytes: n.bytes + p.bytes, files: n.files + 1, cleanableBytes: n.cleanableBytes + (now - p.mtime * 1000 > PART_QUIET_MS ? p.bytes : 0) }),
    { bytes: 0, files: 0, cleanableBytes: 0 },
  );
  const sc = lk.storage?.comfy;
  const comfy = sc
    ? { inputBytes: sc.input, outputBytes: sc.output, tempBytes: sc.temp, crackioBytes: sc.crackio_input + sc.crackio_output, crackioOldBytes: sc.crackio_old ?? 0 }
    : local;

  // Your limit.
  const capBytes = await capFor(key, lk.id);
  const usedBytes = inv.usedBytes + (data?.totalBytes ?? 0);

  // What the page should say.
  if (t?.metered === "comfy-cloud") notes.push("Comfy Cloud keeps its own model library: there's nothing of Crackio's to manage on it.");
  else if (metered) notes.push(`${lk.label} keeps its models on its own network volume: Crackio can list them, not measure or clean it.`);
  else if (t && !lk.online) notes.push(`${lk.label} isn't answering: start it to see what it keeps.`);
  else if (t && !lk.bridge) notes.push(`${lk.label} has no Crackio bridge: sizes come from the catalog, and Crackio can't choose where its downloads go.`);
  else if (t && !canChooseFolder) {
    notes.push(`${lk.label}'s Crackio bridge is ${lk.bridge}: ${STORAGE_BRIDGE} measures its folders, cleans up and lets you choose where downloads go. ${updateHint(t)}`);
  }
  if (!t) notes.push("This computer has no ComfyUI yet: only Crackio's data folder is here.");
  const dlFree = dlDrive?.free ?? null;
  if (goesTo && dlFree !== null && dlFree < TIGHT_BYTES) notes.push(`Downloads land on ${driveLabel(dlDrive!.path)}, which has ${formatBytes(dlFree)} free.`);
  if (inv.unknownBytes >= GB) notes.push(`${formatBytes(inv.unknownBytes)} in the model folders isn't used by any Crackio tool (it may be yours).`);
  if (local && local.crackioBytes >= 100 * 1024 ** 2) notes.push(`Crackio's copies in ComfyUI's input and output folders take ${formatBytes(local.crackioBytes)} (bridge ${STORAGE_BRIDGE} can clear them).`);
  if (capBytes !== null && usedBytes >= capBytes * CAP_WARN_AT) notes.push(`Crackio keeps ${formatBytes(usedBytes)} here, ${Math.round((usedBytes / capBytes) * 100)}% of your ${formatBytes(capBytes)} limit.`);

  // A better download folder, when the one downloads go to is nearly full (named in a note while the bridge can't take one).
  if (t && lk.online && lk.bridge && !metered && dlFree !== null && dlFree < TIGHT_BYTES) {
    const candidates = new Set<string>();
    for (const [name, paths] of Object.entries(lk.folders)) for (const p of paths) if (baseName(p) === name && !(lk.modelsDir && inside(p, lk.modelsDir)) && !(lk.base && inside(p, lk.base))) candidates.add(parentOf(p));
    for (const p of lk.also) candidates.add(p);
    if (lk.here) candidates.add(path.join(os.homedir(), "Crackio-models"));
    if (lk.root) candidates.delete(lk.root);
    const scored: { dir: string; free: number }[] = [];
    for (const dir of candidates) {
      const free = lk.here ? ((await diskAt(dir))?.free ?? null) : (lk.drives.find((d) => d.key === lk.driveOf(dir))?.free ?? null);
      const k = lk.here ? normPath((await mountOf(dir)) ?? dir) : lk.driveOf(dir);
      if (free !== null && k !== dlKey && free >= TIGHT_BYTES && free > dlFree + TIGHT_BYTES) scored.push({ dir, free });
    }
    const best = scored.sort((a, b) => b.free - a.free)[0];
    if (best && !canChooseFolder) {
      notes.push(`${best.dir} has ${formatBytes(best.free)} free: once the bridge is ${STORAGE_BRIDGE}, make it the download folder.`);
    } else if (best) {
      suggestions.push({
        id: "set-root",
        label: `Make ${best.dir} the download folder (${formatBytes(best.free)} free; ${driveLabel(dlDrive!.path)} has ${formatBytes(dlFree)})`,
        bytes: best.free,
        action: { action: "set-root", machine: t.id, path: best.dir },
      });
    }
  }
  if (data && data.cacheBytes >= 256 * 1024 ** 2) suggestions.push({ id: "clear-cache", label: `Clear the rebuildable cache (${formatBytes(data.cacheBytes)})`, bytes: data.cacheBytes, action: { action: "clear-cache", kind: "all" } });
  if (canChooseFolder && t && parts.cleanableBytes > 0) suggestions.push({ id: "clean-parts", label: `Delete unfinished downloads (${formatBytes(parts.cleanableBytes)})`, bytes: parts.cleanableBytes, action: { action: "clean-parts", machine: t.id } });
  if (canChooseFolder && t && comfy && comfy.crackioOldBytes >= 100 * 1024 ** 2) {
    suggestions.push({
      id: "clean-comfy",
      label: `Delete Crackio's copies in ComfyUI's input and output older than a day (${formatBytes(comfy.crackioOldBytes)}; every result is in your Library)`,
      bytes: comfy.crackioOldBytes,
      action: { action: "clean-comfy", machine: t.id, olderThanHours: 24 },
    });
  }
  // A new download folder first (it's only offered when the drive downloads go to is nearly full), then the most room.
  suggestions.sort((a, b) => Number(b.id === "set-root") - Number(a.id === "set-root") || b.bytes - a.bytes);

  const walkedAt = lk.storage?.walked_at ?? null;
  return {
    machine: { id: lk.id, key, label: lk.label, online: lk.online, bridge: lk.bridge, canChooseFolder, onThisComputer: lk.here, ...(metered ? { metered: true } : {}) },
    drives,
    downloads: { root: lk.root, earlier: lk.also, goesTo, freeBytes: dlFree },
    cap: { bytes: capBytes, usedBytes, warnAt: CAP_WARN_AT },
    models: inv.models,
    data: data?.rows ?? [],
    parts,
    comfy: comfy ?? null,
    suggestions,
    notes,
    measuredAt: walkedAt ? Math.round(walkedAt * 1000) : lk.here && lk.online && !lk.storage ? Date.now() : null,
  };
}

/* ------------------------------------------------------------------ before an install */

/**
 * Whether `need` more bytes fit on a machine: on the drive each file goes to (a 2 GB reserve kept, downloads already
 * queued there counted) and under your limit for it. `need`: bytes (where a diffusion model goes), or files by model folder
 * when they go to several. Unknown free space never refuses an install: `known` says whether it was measured.
 */
/** Free space kept on the drive Crackio runs from (this computer), in bytes. */
const APP_DRIVE_RESERVE = 10 * 1024 ** 3;

export async function planInstall(targetId: string, need: number | { folder: string; bytes: number }[]): Promise<InstallPlan> {
  const files = typeof need === "number" ? [{ folder: "diffusion_models", bytes: need }] : need;
  const needBytes = files.reduce((n, f) => n + Math.max(0, f.bytes || 0), 0);
  const t = await pickTarget(targetId).catch(() => null);
  const none: InstallPlan = { ok: true, needBytes, freeBytes: null, capBytes: null, usedBytes: 0, reason: null, drive: null, known: false };
  if (!t || t.metered || t.serverless) return none;
  const lk = await look(t, { walk: false });
  if (!lk.online) return none;

  // What goes to each drive: these files, and downloads queued there that haven't taken their room yet.
  const where = (folder: string) => lk.targets[canonical(folder)] ?? (lk.root ? joinOn(lk.root, canonical(folder)) : (lk.targets.diffusion_models ?? null));
  const perDrive = new Map<string, number>();
  let unknown = false;
  const add = (folder: string, bytes: number) => {
    const dest = where(folder);
    const k = dest ? lk.driveOf(dest) : null;
    if (!k) unknown = true;
    else perDrive.set(k, (perDrive.get(k) ?? 0) + bytes);
  };
  for (const f of files) add(f.folder, Math.max(0, f.bytes || 0));
  const queued = lk.bridge ? ((await get<Download[]>(t, "/crackio/downloads", 6000)) ?? []) : [];
  for (const d of queued) if (d.state === "queued" && d.total > 0 && perDrive.size) add(d.folder, d.total);

  let reason: string | null = null;
  let tightest: { drive: Drive; bytes: number } | null = null;
  // The drive Crackio itself runs from on this computer (its data, the app, its temp files) keeps 10 GB free: a model
  // download filling it would stop Crackio, not just the install. Other drives keep 2 GB.
  const appDrive = lk.here ? lk.driveOf(DATA_DIR) : null;
  const reserveOf = (d: Drive) => (appDrive && d.key === appDrive ? APP_DRIVE_RESERVE : RESERVE_BYTES);
  for (const [k, bytes] of perDrive) {
    const drive = lk.drives.find((d) => d.key === k);
    if (!drive || drive.free === null) {
      unknown = true;
      continue;
    }
    if (!tightest || drive.free - bytes - reserveOf(drive) < tightest.drive.free! - tightest.bytes - reserveOf(tightest.drive)) tightest = { drive, bytes };
  }
  if (tightest && needBytes > 0 && tightest.drive.free! < tightest.bytes + reserveOf(tightest.drive)) {
    const label = driveLabel(tightest.drive.path);
    const spare = reserveOf(tightest.drive);
    reason =
      tightest.drive.free! >= tightest.bytes
        ? `Needs ${formatBytes(tightest.bytes)} on ${label} and ${formatBytes(spare)} to spare${spare > RESERVE_BYTES ? " (Crackio runs from that drive)" : ""}; it has ${formatBytes(tightest.drive.free)} free.`
        : `Needs ${formatBytes(tightest.bytes)} on ${label}, which has ${formatBytes(tightest.drive.free)} free.`;
  }

  // Your limit for this machine.
  const key = lk.storage?.machine_id ?? lk.info?.machine_id ?? lk.id;
  const capBytes = await capFor(key, lk.id);
  let usedBytes = 0;
  if (capBytes !== null) {
    usedBytes = (await inventory(lk)).usedBytes + (lk.here ? (await dataUsage()).totalBytes : 0);
    if (!reason && usedBytes + needBytes > capBytes) {
      reason = `Over your ${formatBytes(capBytes)} limit for ${lk.here ? "this computer" : lk.label}: Crackio keeps ${formatBytes(usedBytes)} there, and this needs ${formatBytes(needBytes)} more.`;
    }
  }
  return {
    ok: reason === null,
    needBytes,
    freeBytes: tightest?.drive.free ?? null,
    capBytes,
    usedBytes,
    reason,
    drive: tightest ? driveLabel(tightest.drive.path) : null,
    known: Boolean(tightest) && !unknown,
  };
}

/* ------------------------------------------------------------------ actions */

async function bridgeTarget(targetId: string, what: string) {
  const t = await pickTarget(targetId);
  if (!t) throw new StorageError("This computer has no ComfyUI yet.", 404);
  if (t.metered || t.serverless) throw new StorageError(`${t.label} keeps its own storage: Crackio can't ${what} there.`, 400);
  const info = await get<Info>(t, "/crackio/info", 8000);
  if (!info) throw new StorageError(`${t.label} isn't answering.`, 409);
  if (!atLeast(info.version, STORAGE_BRIDGE)) {
    throw new StorageError(`${t.label} needs Crackio's bridge ${STORAGE_BRIDGE} to ${what} (it has ${info.version ?? "none"}). ${updateHint(t)}`, 409);
  }
  return t;
}

function forgetMachine(t: ComfyTarget) {
  forgetReports();
  withTarget(t, () => forgetInstalled());
}

/** Downloads on that machine go to <dir>/<model folder> from now on; null: back to ComfyUI's own model folders. */
export async function setDownloadRoot(targetId: string, dir: string | null) {
  const t = await bridgeTarget(targetId, "choose the download folder");
  const res = await post<{ ok: boolean; root: string | null; free: number | null; total: number | null; note?: string }>(t, "/crackio/storage/root", { path: dir?.trim() || null }, 60_000);
  if (!res.ok) throw new StorageError(res.body.error ?? `${t.label} didn't take that folder.`, res.status === 409 ? 409 : res.status === 507 ? 507 : 400);
  forgetMachine(t);
  return res.body;
}

/** What a machine's limit is kept under: its bridge's machine id (1.10), else its target id. */
export async function capKeyFor(targetId: string) {
  const t = await pickTarget(targetId).catch(() => null);
  const info = t ? await get<Info>(t, "/crackio/info", 6000) : null;
  return info?.machine_id || t?.id || targetId;
}

/**
 * Crackio's limit on a machine, in GB (null: none). `replaces`: keys the same machine was kept under before (its target id,
 * before its bridge had a machine id), dropped so one machine never has two limits.
 */
export async function setCap(machineKey: string, gb: number | null, opts: { replaces?: string[] } = {}) {
  if (!machineKey) throw new StorageError("Which machine?");
  if (gb !== null && !(Number.isFinite(gb) && gb >= 1 && gb <= 1_000_000)) throw new StorageError("A limit is a number of GB, 1 or more.");
  await updateSettings((s) => {
    const caps = { ...(s.storageCaps ?? {}) };
    for (const k of opts.replaces ?? []) if (k !== machineKey) delete caps[k];
    if (gb === null) delete caps[machineKey];
    else caps[machineKey] = Math.round(gb * 10) / 10;
    // No limits left: the key goes (JSON leaves out what's undefined).
    return { ...s, storageCaps: Object.keys(caps).length ? caps : undefined };
  });
  forgetReports();
  return { ok: true, key: machineKey, gb };
}

/** Deletes unfinished downloads nobody is fetching on that machine. */
export async function cleanParts(targetId: string) {
  const t = await bridgeTarget(targetId, "delete unfinished downloads");
  const res = await post<{ ok: boolean; freed: number; files: number; kept: number }>(t, "/crackio/storage/clean", { what: "parts" }, 120_000);
  if (!res.ok) throw new StorageError(res.body.error ?? `${t.label} didn't clean up.`, res.status === 409 ? 409 : 400);
  forgetMachine(t);
  return res.body;
}

/** Deletes Crackio's own copies in that ComfyUI's input/crackio and output/crackio older than `hours` (24). */
export async function cleanComfy(targetId: string, hours = 24) {
  const t = await bridgeTarget(targetId, "clear Crackio's copies in ComfyUI's folders");
  const res = await post<{ ok: boolean; freed: number; files: number }>(t, "/crackio/storage/clean", { what: "comfy", older_than_hours: hours }, 120_000);
  if (!res.ok) throw new StorageError(res.body.error ?? `${t.label} didn't clean up.`, res.status === 409 ? 409 : 400);
  forgetMachine(t);
  return res.body;
}

/** Model files off a machine (files no tool uses, Lip Sync's, speech to text), one by one, each a model file in its folder. */
export async function removeFiles(targetId: string, files: { folder: string; file: string }[]) {
  const t = await pickTarget(targetId);
  if (!t) throw new StorageError("This computer has no ComfyUI yet.", 404);
  if (t.metered || t.serverless) throw new StorageError(`${t.label} keeps its own storage: remove its files there.`, 400);
  for (const f of files) {
    if (NOT_MODELS.has(f.folder) || !/^[\w.-]{1,60}$/.test(f.folder)) throw new StorageError(`${f.folder} isn't a model folder.`);
    if (!REMOVABLE.test(f.file)) throw new StorageError(`${f.file} isn't a model file Crackio can remove.`);
  }
  let removed = 0;
  try {
    for (const f of files) if ((await removeFile(canonical(f.folder) as LocalFile["folder"], f.file, t.id)).removed) removed += 1;
  } catch (err) {
    if (err instanceof LocalError) throw new StorageError(err.message, err.status);
    throw err;
  } finally {
    forgetMachine(t);
  }
  return { ok: true, removed };
}
