/**
 * Settings → Storage: what Crackio keeps on each machine, where its downloads go, and the limit you set for it.
 * Client-safe: the page and the server (server/storage) share these shapes.
 *
 * Sizes are bytes. "GB" in words and in limits is 1024³ bytes, as the Local page counts model sizes.
 */

/** The Crackio bridge with GET /crackio/storage, a chosen download folder and a stable machine id (storage.py). */
export const STORAGE_BRIDGE = "1.10.0";
export const GB = 1024 ** 3;
/** Kept free on every drive when judging whether an install fits. */
export const RESERVE_BYTES = 2 * GB;
/** The share of a machine's limit at which Settings warns. */
export const CAP_WARN_AT = 0.9;
/** A download drive with less than this free gets a suggestion to download elsewhere. */
export const TIGHT_BYTES = 10 * GB;

/** What a drive holds for Crackio: where downloads go now, model folders, Crackio's data folder, ComfyUI itself. */
export type DriveHold = "downloads" | "models" | "data" | "comfyui";

export type StorageDrive = {
  /** Its root: "C:\\" on Windows, a mount point elsewhere ("/workspace"); a models folder when nothing better is known. */
  path: string;
  /** "C:", "/workspace". */
  label: string;
  freeBytes: number;
  totalBytes: number;
  holds: DriveHold[];
};

export type StorageModelKind = "catalog" | "lora" | "voice" | "lipsync" | "lfm3" | "unknown";

/** How to remove a row: the request the page sends (an existing route, or this page's own "remove-files"). */
export type StorageRemove = { method: "POST" | "DELETE"; url: string; body: Record<string, unknown> };

export type StorageModel = {
  /** Unique in the report: "catalog:flux3-klein", "lora:<file>", "voice:local:voice:drama3", "unknown:vae/x.safetensors". */
  id: string;
  name: string;
  /** The installed version's label ("INT8"); null when the model has no versions or isn't complete. */
  variant: string | null;
  /** The installed version's id (what removing a catalog model takes). */
  variantId?: string;
  bytes: number;
  /** What removing it frees: its files that no other installed model uses. */
  freesBytes: number;
  /** Kit ids (setup/kits KITS: "image", "video", "director", "voice"…) that use it; empty when no tool does. */
  tools: string[];
  kind: StorageModelKind;
  /** Its (main) file's model folder and name. */
  folder?: string;
  file?: string;
  /** Measured on the machine (bridge 1.10, or this computer); otherwise the catalog's size, or 0 when unknown. */
  sizeKnown: boolean;
  /** Some of its files are there, not all (a download that stopped). */
  partial?: boolean;
  remove?: StorageRemove;
  /** When a take on this machine last used it (its own or one of its steps); null when none since `usedSince`. */
  lastUsed?: number | null;
};

/** Crackio's data folder on this computer, by what it is. */
export type DataKind = "takes" | "motion" | "uploads" | "voices" | "templates" | "cache" | "logs" | "models" | "dev" | "db" | "other";

export type StorageData = { kind: DataKind; label: string; bytes: number; files: number; clearable: boolean; note?: string };

/** The cache folders Crackio makes again on demand (data/cache/<kind>); "all" is every one of them. */
export const REBUILDABLE_CACHE = [
  "previews",
  "vision",
  "director",
  "cast",
  "world",
  "world-depth",
  "detect",
  "product",
  "retouch",
  "lipsync",
  "voice",
  "comfy",
  "templates",
  "model-previews",
  "lora-previews",
  "local-thumbs",
  "storyboard-frames",
  "storyboard-export",
] as const;
export type CacheKind = (typeof REBUILDABLE_CACHE)[number] | "all";

/** One click on the page: what the Storage route's POST takes (see StorageAction). */
export type StorageSuggestion = { id: string; label: string; bytes: number; action: StorageAction };

/** POST /api/settings/storage. */
export type StorageAction =
  /** Downloads on that machine go to <path>/<model folder>; null: back to ComfyUI's own model folders (bridge 1.10). */
  | { action: "set-root"; machine: string; path: string | null }
  /** Crackio's limit on that machine in GB, null for none. `machine` is a target id (the page's `machine.id`). */
  | { action: "set-cap"; machine: string; gb: number | null }
  /** Empties rebuildable cache folders on this computer. */
  | { action: "clear-cache"; kind: CacheKind }
  /** Unfinished downloads nobody is fetching (bridge 1.10). */
  | { action: "clean-parts"; machine: string }
  /** Crackio's own copies in that ComfyUI's input/crackio and output/crackio, older than `olderThanHours` (24) (bridge 1.10). */
  | { action: "clean-comfy"; machine: string; olderThanHours?: number }
  /** Model files off a machine, by folder and name (files no tool uses, Lip Sync's, speech to text). */
  | { action: "remove-files"; machine: string; files: { folder: string; file: string }[] };

export type StorageReport = {
  /** The earliest take Crackio kept a recipe for (what "not used since" can go back to), and the server's clock now. */
  usedSince?: number | null;
  now?: number;
  machine: {
    /** The ComfyUI target id ("this-computer" when this computer has no ComfyUI). */
    id: string;
    /** What its limit is kept under: the bridge's machine id when it has one (1.10), else `id`. */
    key: string;
    label: string;
    online: boolean;
    bridge: string | null;
    /** Its bridge can take a download folder (1.10). */
    canChooseFolder: boolean;
    onThisComputer: boolean;
    /** Billed per job (RunPod Serverless, Comfy Cloud): its storage isn't Crackio's to manage. */
    metered?: boolean;
  };
  drives: StorageDrive[];
  downloads: {
    /** The chosen download folder; null: ComfyUI's own model folders. */
    root: string | null;
    /** Download folders chosen before: still looked in, so what's there stays usable. */
    earlier: string[];
    /** Where a standard download (a diffusion model) lands now. */
    goesTo: string | null;
    freeBytes: number | null;
  };
  cap: { bytes: number | null; usedBytes: number; warnAt: number };
  models: StorageModel[];
  /** This computer's Crackio data folder; empty for other machines. */
  data: StorageData[];
  /** Unfinished downloads nobody is fetching (bridge 1.10); `cleanable` is the part untouched for 10 minutes. */
  parts: { bytes: number; files: number; cleanableBytes: number };
  /** That ComfyUI's input, output and temp folders, and Crackio's own copies in them (`crackioOldBytes`: over a day old). */
  comfy: { inputBytes: number; outputBytes: number; tempBytes: number; crackioBytes: number; crackioOldBytes: number } | null;
  suggestions: StorageSuggestion[];
  notes: string[];
  /** When its model folders were last measured (epoch ms); null when sizes come from the catalog. */
  measuredAt: number | null;
};

/** Whether `bytes` more fit on a machine (server/storage `planInstall`), in plain words when they don't. */
export type InstallPlan = {
  ok: boolean;
  needBytes: number;
  /** Free where it goes (the tightest drive when its files go to several); null when the machine doesn't say. */
  freeBytes: number | null;
  capBytes: number | null;
  /** What Crackio keeps on that machine now (its models there, and its data on this computer). */
  usedBytes: number;
  /** "Needs 12 GB on D:, which has 0.1 GB free." / "Over your 200 GB limit for this computer". */
  reason: string | null;
  /** The drive it goes to ("D:"); null when unknown. */
  drive: string | null;
  /** Free space was measured (false: the machine didn't say, so nothing was refused for it). */
  known: boolean;
};

/** "29 MB", "4.5 GB", "120 GB". */
export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return "?";
  const gb = bytes / GB;
  if (gb < 0.1) return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024 ** 2))} MB`;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : Math.round(gb)} GB`;
}
