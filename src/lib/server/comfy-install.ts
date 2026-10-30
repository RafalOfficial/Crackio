import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Gpu, Machine } from "@/lib/local/types";
import { writeFileAtomic } from "./atomic-write";
import { amdWindowsRocm, thisComputer } from "./hardware";
import { DATA_DIR } from "./paths";

/**
 * ComfyUI on this computer, set up by Crackio for people who have never touched it. Crackio reads the GPU,
 * picks the PyTorch build that GPU runs, and installs Python 3.12, ComfyUI, that PyTorch and the Crackio
 * bridge into one folder on the drive with the most room. Then it runs ComfyUI as a process it starts and
 * stops. Nothing outside that folder changes: uv, Python, the package cache and the logs all live in it, so
 * removing the folder removes everything.
 *
 *   <folder>/ComfyUI     the ComfyUI checkout (its models, custom_nodes and output folders too)
 *   <folder>/venv        its Python environment
 *   <folder>/python      the Python 3.12 uv downloaded
 *   <folder>/bin         uv itself, when this computer had none
 *   <folder>/cache       uv's package cache, kept off the system drive
 *   <folder>/logs        what ComfyUI prints
 *
 * Every step checks what is already there first, so running the install again resumes or repairs it.
 */

const WIN = process.platform === "win32";
const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A line without terminal colors (ComfyUI colors its log even into a file). */
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
/** Windows paths ignore case. */
const samePath = (a: string, b: string) => (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** 8188 is ComfyUI's usual port; on this setup an SSH tunnel to a rented GPU holds it. */
export const DEFAULT_PORT = 8189;
const PYTHON = "3.12";
/** github.com/comfyanonymous/ComfyUI moved here (the old address redirects). */
const COMFY_REPO = "https://github.com/Comfy-Org/ComfyUI";
const PYTORCH = "https://download.pytorch.org/whl";
const RECORD_FILE = path.join(DATA_DIR, "comfy-install.json");
const MARKER = ".crackio-install.json";

/* ------------------------------------------------------------------ which PyTorch */

export type TorchBuild = "cu126" | "cu128" | "cu130" | "rocm7.2" | "rocm10.0.0" | "xpu" | "cpu" | "mps";

type BuildInfo = {
  torch: string | null;
  torchvision: string | null;
  index: string | null;
  name: string;
  downloadGb: number;
  diskGb: number;
  /** pip extras on torch and torchvision (AMD's Windows wheels take the GPU's kernels as one). */
  extras?: string;
  /** The Python it needs, when not the usual one. */
  python?: string;
};

/**
 * The PyTorch builds Crackio installs, as download.pytorch.org listed them on 22 October 2026. PyTorch 2.14 is the
 * last release with CUDA 12 wheels (2.15 drops CUDA 12.6, and with it Maxwell, Pascal and Volta). Its CUDA 12.6
 * wheels are built for compute 5.0 to 9.0 (Windows: 5.0;6.0;6.1;7.0;7.5;8.0;8.6;9.0), its CUDA 13.0 wheels for 7.5
 * to 12.0. CUDA 12.8 wheels stopped at 2.11.
 *
 * Sizes are the download and the room it takes once installed. CUDA 12.6 on Windows is measured (a 2.4 GB wheel, 3.9 GB
 * installed); the rest are estimated from the wheels' sizes. On Linux the CUDA libraries come as separate packages.
 */
const BUILDS: Record<TorchBuild, BuildInfo> = {
  cu126: { torch: "2.14.1", torchvision: "0.29.1", index: `${PYTORCH}/cu126`, name: "CUDA 12.6", downloadGb: WIN ? 2.5 : 3.4, diskGb: WIN ? 4.5 : 6.5 },
  cu128: { torch: "2.11.0", torchvision: "0.26.0", index: `${PYTORCH}/cu128`, name: "CUDA 12.8", downloadGb: WIN ? 2.6 : 3.4, diskGb: WIN ? 4.6 : 6.5 },
  cu130: { torch: "2.14.1", torchvision: "0.29.1", index: `${PYTORCH}/cu130`, name: "CUDA 13.0", downloadGb: WIN ? 1.9 : 3, diskGb: WIN ? 3.6 : 6 },
  "rocm7.2": { torch: "2.14.1", torchvision: "0.29.1", index: `${PYTORCH}/rocm7.2`, name: "ROCm 7.2", downloadGb: 6, diskGb: 16 },
  // AMD's own multi-architecture Windows wheels, as ComfyUI's README gives them (Oct 2026): ROCm 10.0 with PyTorch 2.13 on
  // Python 3.13. The device extra brings the GPU's kernels and the ROCm runtime; no HIP SDK needed. Sizes estimated.
  "rocm10.0.0": { torch: "2.13.0", torchvision: "0.28.0", index: "https://stable.repo.amd.com/rocm/whl-next/", name: "ROCm 10 (AMD's build for Windows)", downloadGb: 5, diskGb: 14, extras: "device-all", python: "3.13" },
  xpu: { torch: "2.14.1", torchvision: "0.29.1", index: `${PYTORCH}/xpu`, name: "Intel GPUs (XPU)", downloadGb: 1.5, diskGb: 5 },
  cpu: { torch: "2.14.1", torchvision: "0.29.1", index: `${PYTORCH}/cpu`, name: "the CPU", downloadGb: 0.2, diskGb: 1 },
  // Macs take PyPI's own build (it runs on the GPU through Metal), the newest that this macOS runs.
  mps: { torch: null, torchvision: null, index: null, name: "Apple Silicon", downloadGb: 0.2, diskGb: 1 },
};

/** Python 3.12, ComfyUI and its other packages, on top of PyTorch (measured: 0.4 GB down, 1.4 GB installed). */
const BASE = { downloadGb: 0.5, diskGb: 1.5 };

export type SetupPlan = {
  /** False when nothing can be installed here (an Intel Mac: PyTorch no longer builds for it). */
  supported: boolean;
  build: TorchBuild;
  /** Pinned versions; null takes the newest that fits (Macs). */
  torch: string | null;
  torchvision: string | null;
  /** pip extras for torch and torchvision ("device-gfx1100"), when the build takes one. */
  extras: string | null;
  /** Where PyTorch comes from; null is PyPI. */
  index: string | null;
  python: string;
  /** "PyTorch 2.14.1 for CUDA 12.6". */
  label: string;
  /** Why this build here, in a sentence or two. */
  reason: string;
  warnings: string[];
  /** ComfyUI flags this machine needs (--cpu, --lowvram). */
  flags: string[];
  downloadGb: number;
  diskGb: number;
  gpu: { name: string; memoryGb: number | null; compute: number | null; driver: string | null } | null;
};

type Choice = { build: TorchBuild; reason: string; warnings?: string[]; flags?: string[]; supported?: boolean; extras?: string };

/** What Crackio would install on this machine, and why. */
export function planFor(machine: Machine): SetupPlan {
  const gpu = gpuFor(machine);
  const choice = chooseBuild(machine, gpu);
  const b = BUILDS[choice.build];
  return {
    supported: choice.supported !== false,
    build: choice.build,
    torch: b.torch,
    torchvision: b.torchvision,
    extras: choice.extras ?? b.extras ?? null,
    index: b.index,
    python: b.python ?? PYTHON,
    label: choice.build === "mps" ? "PyTorch for Apple Silicon (Metal)" : choice.build === "cpu" ? `PyTorch ${b.torch} (CPU only)` : `PyTorch ${b.torch} for ${b.name}`,
    reason: choice.reason,
    warnings: choice.warnings ?? [],
    flags: choice.flags ?? [],
    downloadGb: round1(BASE.downloadGb + b.downloadGb),
    diskGb: Math.ceil(BASE.diskGb + b.diskGb),
    gpu: gpu ? { name: gpu.name, memoryGb: gpu.memoryGb, compute: gpu.compute ?? null, driver: gpu.driver ?? null } : null,
  };
}

/** The GPU ComfyUI would compute on: the biggest one of the kind the machine accelerates with. */
function gpuFor(machine: Machine): Gpu | undefined {
  const vendor = { cuda: "nvidia", rocm: "amd", directml: "amd", xpu: "intel", mps: "apple", cpu: null }[machine.accel];
  return machine.gpus.filter((g) => g.vendor === vendor).sort((a, b) => (b.memoryGb ?? 0) - (a.memoryGb ?? 0))[0];
}

const shortName = (name: string) => name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "").replace(/^AMD\s+/i, "");

/** NVIDIA's architecture names by compute capability. */
function archOf(compute: number) {
  const names: [number, string][] = [[10, "Blackwell"], [9, "Hopper"], [8.9, "Ada Lovelace"], [8, "Ampere"], [7.5, "Turing"], [7, "Volta"], [6, "Pascal"], [5, "Maxwell"]];
  return names.find(([min]) => compute >= min)?.[1] ?? "pre-Maxwell";
}

const driverMajor = (driver?: string) => (driver && /^\d+/.test(driver) ? Number(driver.match(/^\d+/)![0]) : null);

/**
 * Non-NVIDIA GPUs run ComfyUI's older model loader, whose low-VRAM mode keeps text encoders on the CPU: worth it
 * under 8 GB. On NVIDIA, ComfyUI's dynamic VRAM (on by default with PyTorch 2.8+) streams weights itself and
 * ignores --lowvram.
 */
const lowVram = (gpu: Gpu) => ((gpu.memoryGb ?? 99) < 8 ? ["--lowvram"] : []);

function chooseBuild(machine: Machine, gpu: Gpu | undefined): Choice {
  if (machine.os.family === "macos") {
    return gpu?.vendor === "apple"
      ? { build: "mps", reason: "Apple Silicon: PyTorch's standard Mac build runs ComfyUI on the GPU through Metal." }
      : { build: "cpu", supported: false, reason: "PyTorch stopped making Intel Mac builds after 2.2, which current ComfyUI can't run on." };
  }
  if (gpu?.vendor === "nvidia") return nvidiaChoice(gpu);
  if (gpu?.vendor === "amd") {
    if (machine.os.family === "linux") return { build: "rocm7.2", flags: lowVram(gpu), reason: `Your ${shortName(gpu.name)} is an AMD card on Linux: PyTorch's ROCm 7.2 build.` };
    if (machine.os.family === "windows" && amdWindowsRocm(gpu.name, machine.os.name)) {
      return {
        build: "rocm10.0.0",
        extras: amdDevice(gpu.name),
        flags: lowVram(gpu),
        reason: `Your ${shortName(gpu.name)} is an AMD card on Windows 11: AMD's ROCm 10 build of PyTorch, which ComfyUI recommends for Radeon cards on Windows.`,
        warnings: ["ROCm needs a current AMD graphics driver: update it from amd.com if the install can't see the card."],
      };
    }
    return {
      build: "cpu",
      flags: ["--cpu"],
      reason:
        machine.os.family === "windows" && machine.os.name !== "Windows 11"
          ? `AMD's PyTorch for Windows needs Windows 11, so on ${machine.os.name} ComfyUI runs on the CPU.`
          : `Your ${shortName(gpu.name)} is older than the Radeons AMD's PyTorch runs on Windows (RX 6000 and newer), so ComfyUI runs on the CPU.`,
      warnings: ["On the CPU, a picture takes minutes."],
    };
  }
  if (gpu?.vendor === "intel") return { build: "xpu", flags: lowVram(gpu), reason: `Your ${gpu.name} is an Intel GPU: PyTorch's XPU build.` };
  // A Radeon that AMD's Windows PyTorch doesn't cover (the machine then computes on the CPU): say why.
  const radeon = machine.os.family === "windows" ? machine.gpus.find((g) => g.vendor === "amd") : undefined;
  if (radeon) {
    return {
      build: "cpu",
      flags: ["--cpu"],
      reason:
        machine.os.name !== "Windows 11"
          ? `AMD's PyTorch for Windows needs Windows 11, so on ${machine.os.name} ComfyUI runs on the CPU.`
          : `Your ${shortName(radeon.name)} is older than the Radeons AMD's PyTorch runs on Windows (RX 6000 and newer), so ComfyUI runs on the CPU.`,
      warnings: ["On the CPU, a picture takes minutes."],
    };
  }
  const small = machine.gpus.find((g) => g.vendor === "nvidia");
  return {
    build: "cpu",
    flags: ["--cpu"],
    reason: small
      ? `Your ${shortName(small.name)} has under 3 GB of memory, too little for these models, so ComfyUI runs on the CPU.`
      : "No GPU PyTorch can use was found, so ComfyUI runs on the CPU: fine for small jobs, slow for pictures and video.",
    warnings: ["On the CPU, a picture takes minutes."],
  };
}

/** AMD's per-GPU extra for its Windows wheels (ComfyUI's README table); every supported GPU's kernels otherwise. */
function amdDevice(name: string) {
  const targets: [RegExp, string][] = [
    [/rx\s*9070|r9700/i, "device-gfx1201"],
    [/rx\s*9060/i, "device-gfx1200"],
    [/rx\s*7900/i, "device-gfx1100"],
    [/rx\s*7[78]00/i, "device-gfx1101"],
    [/rx\s*7600/i, "device-gfx1102"],
    [/8060s|8050s/i, "device-gfx1151"],
  ];
  return targets.find(([re]) => re.test(name))?.[1] ?? "device-all";
}

function nvidiaChoice(gpu: Gpu): Choice {
  const name = shortName(gpu.name);
  const cc = gpu.compute;
  const driver = driverMajor(gpu.driver);
  const warnings: string[] = [];
  // CUDA 12 runs on drivers from 525 (Linux) and 528 (Windows) on.
  if (driver !== null && driver < (WIN ? 528 : 525)) warnings.push(`Your NVIDIA driver (${gpu.driver}) is too old for CUDA 12: update it from nvidia.com first.`);
  if (cc !== undefined && cc < 5) {
    return { build: "cpu", flags: ["--cpu"], warnings, reason: `Your ${name} (compute ${cc}) is older than anything PyTorch still supports, so ComfyUI runs on the CPU.` };
  }
  if (cc === undefined) {
    return { build: "cu126", warnings, reason: `The driver didn't say which generation your ${name} is, so Crackio takes the CUDA 12.6 build: it runs on the most NVIDIA cards (Maxwell to Hopper).` };
  }
  const arch = archOf(cc);
  const a = /^[AEIOU]/.test(arch) ? "an" : "a";
  if (cc < 7.5) {
    return {
      build: "cu126",
      warnings,
      reason: `Your ${name} is ${a} ${arch} card (compute ${cc}). PyTorch's CUDA 12.8 and 13 builds no longer include ${arch} cards; 2.14 is the last release with CUDA 12.6 builds, and those still do.`,
    };
  }
  // CUDA 13 needs driver 580 or newer.
  if (driver !== null && driver < 580) {
    const update = "Update your NVIDIA driver to 580 or newer, then install again, for the CUDA 13 build ComfyUI recommends.";
    if (cc >= 10) {
      return { build: "cu128", warnings: [...warnings, update], reason: `Your ${name} is a Blackwell card, and CUDA 13 needs NVIDIA driver 580 or newer (you have ${gpu.driver}): this is the newest build your driver runs.` };
    }
    return { build: "cu126", warnings: [...warnings, update], reason: `Your ${name} is ${a} ${arch} card. CUDA 13 needs NVIDIA driver 580 or newer and you have ${gpu.driver}, so it gets the CUDA 12.6 build (models run, without ComfyUI's fastest kernels).` };
  }
  return { build: "cu130", warnings, reason: `Your ${name} is ${a} ${arch} card (compute ${cc}): PyTorch's CUDA 13.0 build, which ComfyUI recommends for RTX 20 series and newer.` };
}

/* ------------------------------------------------------------------ where it goes */

type Folder = { path: string; why: string };

/** Windows bus types (MSFT_PhysicalDisk.BusType) a drive shouldn't hold ComfyUI on: 1394, USB, SD, MMC. */
const REMOVABLE_BUS = new Set([4, 7, 12, 13]);

type Drive = { letter: string; fs: string; free: number; bus: number; media: number };

/** This PC's fixed drives, with free space, file system, bus (USB?) and media (4 is SSD). Takes a few seconds. */
async function windowsDrives(): Promise<Drive[]> {
  const script =
    "$ns='root/Microsoft/Windows/Storage'; $pd=@{}; Get-CimInstance -Namespace $ns -ClassName MSFT_PhysicalDisk | ForEach-Object { $pd[[string]$_.DeviceId]=$_ };" +
    " $part=@{}; Get-CimInstance -Namespace $ns -ClassName MSFT_Partition | Where-Object { [int]$_.DriveLetter -gt 0 } | ForEach-Object { $part[[string]$_.DriveLetter]=$pd[[string]$_.DiskNumber] };" +
    " Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $l=$_.DeviceID.Substring(0,1); $d=$part[$l];" +
    " [pscustomobject]@{ letter=$l; fs=[string]$_.FileSystem; free=[double]$_.FreeSpace; bus=[int]$d.BusType; media=[int]$d.MediaType } } | ConvertTo-Json -Compress";
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 });
  try {
    return ([] as Drive[]).concat(JSON.parse(r.out.trim() || "[]")).filter((d) => d?.letter);
  } catch {
    return [];
  }
}

/**
 * Where a new install goes: CRACKIO_COMFY_DIR when set; on Windows, the internal drive (SSDs first) with the most free
 * space, skipping USB drives and FAT32 (no files over 4 GB); elsewhere ~/Crackio/ComfyUI.
 */
async function chooseFolder(needGb: number): Promise<Folder> {
  const override = process.env.CRACKIO_COMFY_DIR?.trim();
  if (override) return { path: path.resolve(override), why: "Set by CRACKIO_COMFY_DIR." };
  const home = besideApp(path.join(/*turbopackIgnore: true*/ os.homedir(), "Crackio", "ComfyUI"));
  if (!WIN) return { path: home, why: "In your home folder." };
  const drives = (await windowsDrives()).filter((d) => /^(NTFS|ReFS)$/i.test(d.fs) && !REMOVABLE_BUS.has(d.bus));
  const roomy = drives.filter((d) => d.free / GB >= needGb + 2);
  const pick = (roomy.length ? roomy : drives).sort((a, b) => Number(b.media === 4) - Number(a.media === 4) || b.free - a.free)[0];
  if (!pick) return { path: home, why: "In your user folder." };
  const system = path.parse(os.homedir()).root.slice(0, 1).toUpperCase();
  const kind = pick.media === 4 && drives.some((d) => d.media !== 4) ? "internal SSDs" : "internal drives";
  return {
    path: pick.letter.toUpperCase() === system ? home : besideApp(`${pick.letter.toUpperCase()}:\\Crackio\\ComfyUI`),
    why: `${pick.letter.toUpperCase()}: has the most free space of this PC's ${kind} (${Math.round(pick.free / GB)} GB).`,
  };
}

/**
 * A default folder, unless it falls inside Crackio's own (a clone in ~/crackio is ~/Crackio on macOS and Windows, whose
 * names ignore case, and its comfyui/ folder is then "ComfyUI"): then ComfyUI goes beside it, in Crackio-ComfyUI.
 */
function besideApp(dir: string) {
  const app = path.resolve(/*turbopackIgnore: true*/ process.cwd()).toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  if (d !== app && !d.startsWith(app + path.sep)) return dir;
  return path.join(path.dirname(path.dirname(path.resolve(dir))), "Crackio-ComfyUI");
}

/** Free space where `dir` is (or would be), in GB. */
async function freeAt(dir: string): Promise<number | null> {
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    try {
      const s = await fs.statfs(p);
      return round1((s.bavail * s.bsize) / GB);
    } catch {
      if (path.dirname(p) === p) return null;
    }
  }
}

/** Every path inside an install folder. */
function layout(root: string) {
  const at = (...parts: string[]) => path.join(/*turbopackIgnore: true*/ root, ...parts);
  return {
    root,
    comfy: at("ComfyUI"),
    main: at("ComfyUI", "main.py"),
    venv: at("venv"),
    python: WIN ? at("venv", "Scripts", "python.exe") : at("venv", "bin", "python"),
    pythons: at("python"),
    bin: at("bin"),
    uv: at("bin", WIN ? "uv.exe" : "uv"),
    cache: at("cache"),
    downloads: at("downloads"),
    logs: at("logs"),
    log: at("logs", "comfyui.log"),
    tmp: at("tmp"),
    marker: at(MARKER),
    constraints: at("constraints.txt"),
  };
}
type Layout = ReturnType<typeof layout>;

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/* ------------------------------------------------------------------ the install record */

/** data/comfy-install.json: the install Crackio made, and the ComfyUI it is running. */
export type InstallRecord = {
  path: string;
  comfyui: string;
  python: string;
  port: number;
  flags: string[];
  complete: boolean;
  pythonVersion?: string;
  torch?: string;
  /** The CUDA (or ROCm) version PyTorch was built for. */
  cuda?: string | null;
  build?: TorchBuild;
  comfyuiVersion?: string;
  device?: string | null;
  installedAt?: string;
  installSeconds?: number;
  run?: { pid: number; startedAt: number; keepAlive: boolean } | null;
  /** Listen on the network, not only this computer, so Crackio on another computer can run models on it. */
  share?: boolean;
  /** You stopped it (to free memory, say): it stays stopped when Crackio starts, until you start it again. */
  stoppedByUser?: boolean;
};

async function readRecord(): Promise<InstallRecord | null> {
  try {
    return JSON.parse(await fs.readFile(RECORD_FILE, "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}

/** Where the ComfyUI Crackio installed on this computer answers when it runs (null when there's none). */
export async function installedComfyUrl(): Promise<string | null> {
  const rec = await readRecord();
  return rec?.complete ? `http://127.0.0.1:${rec.port}` : null;
}

async function saveRecord(rec: InstallRecord) {
  await writeFileAtomic(RECORD_FILE, JSON.stringify(rec, null, 2));
}

async function updateRecord(patch: Partial<InstallRecord>) {
  const rec = await readRecord();
  if (rec) await saveRecord({ ...rec, ...patch });
}

/* ------------------------------------------------------------------ state (kept across hot reloads) */

type StageId = "prepare" | "uv" | "python" | "venv" | "comfyui" | "torch" | "packages" | "bridge" | "check" | "start" | "stop" | "remove";
type Stage = { id: StageId; label: string; weight: number };

const INSTALL_STAGES: Stage[] = [
  { id: "prepare", label: "Getting ready", weight: 1 },
  { id: "uv", label: "Getting uv, the Python installer", weight: 2 },
  { id: "python", label: "Installing Python 3.12", weight: 3 },
  { id: "venv", label: "Making ComfyUI's Python environment", weight: 2 },
  { id: "comfyui", label: "Downloading ComfyUI", weight: 4 },
  { id: "torch", label: "Installing PyTorch for your GPU", weight: 60 },
  { id: "packages", label: "Installing ComfyUI's packages", weight: 18 },
  { id: "bridge", label: "Adding the Crackio bridge", weight: 1 },
  { id: "check", label: "Checking PyTorch runs on your GPU", weight: 4 },
  { id: "start", label: "Starting ComfyUI", weight: 5 },
];
const UNINSTALL_STAGES: Stage[] = [
  { id: "stop", label: "Stopping ComfyUI", weight: 1 },
  { id: "remove", label: "Removing its folder", weight: 9 },
];

type Job = {
  action: "install" | "uninstall";
  stages: Stage[];
  stage: StageId;
  /** How far the current stage is, 0–1, when it can be measured. */
  fraction: number | null;
  /** "1.2 of 2.4 GB". */
  detail: string | null;
  log: string[];
  /** The last log line is a progress line that the next one replaces. */
  live: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
};

type ProcState = "stopped" | "starting" | "running" | "stopping" | "crashed";

type Proc = {
  state: ProcState;
  child: ChildProcess | null;
  pid: number | null;
  port: number;
  startedAt: number | null;
  readyAt: number | null;
  /** Start it again if it crashes: only when asked. */
  keepAlive: boolean;
  restarts: number[];
  lastExit: { code: number | null; at: number } | null;
  error: string | null;
};

type State = {
  job: Job | null;
  proc: Proc;
  plan: { at: number; value: Promise<PlanInfo> } | null;
  adopted: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

type PlanInfo = { plan: SetupPlan; folder: Folder };

const g = globalThis as unknown as { __crackioComfySetup?: State };
const state: State = (g.__crackioComfySetup ??= {
  job: null,
  proc: { state: "stopped", child: null, pid: null, port: DEFAULT_PORT, startedAt: null, readyAt: null, keepAlive: false, restarts: [], lastExit: null, error: null },
  plan: null,
  adopted: false,
  timer: null,
});

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** This computer's plan and folder, read once every ten minutes (the hardware and drive reads take seconds). */
function planInfo(): Promise<PlanInfo> {
  const hit = state.plan;
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = (async () => {
    const plan = planFor(await thisComputer());
    return { plan, folder: await chooseFolder(plan.diskGb) };
  })();
  state.plan = { at: Date.now(), value };
  value.catch(() => (state.plan = null));
  return value;
}

const busy = () => Boolean(state.job && !state.job.finishedAt);

/* ------------------------------------------------------------------ running commands */

type Run = { code: number; out: string; err: string };
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (line: string) => void };

/** Calls `onLine` with each line of a stream (git ends its progress lines with \r). */
function lineSplitter(onLine: (line: string) => void) {
  let partial = "";
  return (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split(/\r\n|\n|\r/);
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

/** Runs a program without a shell and collects what it prints; the timeout stops it and everything it started. */
function run(cmd: string, args: string[], { cwd, env, timeoutMs = 10 * 60_000, onLine }: RunOptions = {}): Promise<Run> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let child: ChildProcess;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => child?.pid && killPid(child.pid), timeoutMs);
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      err = String(e);
      done(-1);
      return;
    }
    const outLines = onLine ? lineSplitter(onLine) : null;
    const errLines = onLine ? lineSplitter(onLine) : null;
    child.stdout?.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-64_000);
      outLines?.(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-64_000);
      errLines?.(d);
    });
    child.on("error", (e) => {
      err += String(e);
      done(-1);
    });
    child.on("close", (code) => done(code ?? -1));
  });
}

/** Stops a process and everything it started. */
async function killPid(pid: number) {
  if (WIN) {
    await new Promise((r) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, r));
    return;
  }
  try {
    process.kill(-pid, "SIGTERM"); // its process group (it was started detached)
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(8000);
  if (!alive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The environment for installers and ComfyUI: no Python settings of the user's that would leak into this install. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const drop = new Set(["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "CONDA_PREFIX", "UV_PYTHON", "UV_SYSTEM_PYTHON", "PIP_USER", "PIP_REQUIRE_VIRTUALENV", ...Object.keys(extra).map((k) => k.toUpperCase())]);
  const env: Record<string, string | undefined> = {};
  // Windows' variable names ignore case: drop "Temp" too when setting TEMP.
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

function installEnv(l: Layout) {
  return cleanEnv({
    // Packages and Python stay in the install folder: the system drive may be nearly full.
    UV_CACHE_DIR: l.cache,
    UV_PYTHON_INSTALL_DIR: l.pythons,
    UV_NO_MODIFY_PATH: "1",
    UV_HTTP_TIMEOUT: "300",
    PIP_CACHE_DIR: path.join(l.cache, "pip"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    TMP: l.tmp,
    TEMP: l.tmp,
    TMPDIR: l.tmp,
    PYTHONUTF8: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
}

function comfyEnv(l: Layout) {
  const bin = path.dirname(l.python);
  return cleanEnv({
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    // Custom nodes that run `python` or `pip` get this environment.
    VIRTUAL_ENV: l.venv,
    PATH: [bin, process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter),
    // On a Mac, an operation PyTorch's Metal backend lacks runs on the CPU instead of failing the job (custom nodes reach
    // for some).
    ...(process.platform === "darwin" ? { PYTORCH_ENABLE_MPS_FALLBACK: "1" } : {}),
    // On Windows, aiohttp's sendfile can stall on a partial download (a video player seeking sends one), and from then on
    // every /view download hangs with 0 bytes until ComfyUI restarts. Plain reads and writes avoid it.
    ...(process.platform === "win32" ? { AIOHTTP_NOSENDFILE: "1" } : {}),
  });
}

/* ------------------------------------------------------------------ the install job */

function newJob(action: Job["action"], stages: Stage[]): Job {
  return { action, stages, stage: stages[0].id, fraction: null, detail: null, log: [], live: false, startedAt: Date.now(), finishedAt: null, error: null };
}

/** Adds a line to the job's log; progress lines (git's percentages) replace each other. */
function say(job: Job, line: string, live = false) {
  const text = plain(line).trimEnd().slice(0, 400);
  if (!text.trim()) return;
  if (live && job.live) job.log[job.log.length - 1] = text;
  else job.log.push(text);
  job.live = live;
  if (job.log.length > 400) job.log.splice(0, job.log.length - 300);
}

function enter(job: Job, stage: StageId) {
  Object.assign(job, { stage, fraction: null, detail: null, live: false });
  say(job, `— ${job.stages.find((s) => s.id === stage)?.label ?? stage}`);
}

/** The whole job's progress, 0–100, from the stages done and how far the current one is. */
function percentOf(job: Job) {
  if (job.finishedAt && !job.error) return 100;
  const total = job.stages.reduce((n, s) => n + s.weight, 0);
  const i = job.stages.findIndex((s) => s.id === job.stage);
  const before = job.stages.slice(0, i).reduce((n, s) => n + s.weight, 0);
  return Math.round(((before + job.stages[i].weight * (job.fraction ?? 0)) / total) * 100);
}

/** The line in a failed run's output that says what went wrong. */
function lastLine(r: Run) {
  const lines = `${r.out}\n${r.err}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return (lines.filter((l) => /error|failed|denied|not found|no such|unable|cannot|could not/i.test(l)).pop() ?? lines.pop() ?? `exit code ${r.code}`).slice(0, 300);
}

/** Runs one install command, logging what it prints; fails the step when it fails. */
async function must(job: Job, what: string, cmd: string, args: string[], opts: RunOptions & { live?: RegExp; progress?: (line: string) => number | null } = {}) {
  say(job, `$ ${path.basename(cmd)} ${args.map((a) => (a.length > 90 ? `…${a.slice(-60)}` : a)).join(" ")}`);
  const r = await run(cmd, args, {
    ...opts,
    onLine: (line) => {
      const live = opts.live?.test(line) ?? false;
      const f = opts.progress?.(line);
      if (f != null) job.fraction = f;
      say(job, line, live);
    },
  });
  if (r.code !== 0) throw new Error(`${what} failed: ${lastLine(r)}`);
  return r;
}

type Ctx = {
  job: Job;
  l: Layout;
  plan: SetupPlan;
  port: number;
  env: NodeJS.ProcessEnv;
  /** uv, when this computer has it (or Crackio installed it). */
  uv: string | null;
  /** This computer's own Python, when there's no uv. */
  system: { cmd: string; args: string[]; version: string } | null;
  pyVersion: string;
  comfyuiVersion: string;
  check: Check | null;
};

type Check = { python?: string; torch?: string; cuda?: string | null; hip?: string | null; device?: string; capability?: string; archs?: string[]; gpu_ok?: boolean; error?: string };

/** Installs (or finishes, or repairs) ComfyUI in the background. Returns at once; status() shows how it goes. */
export async function installComfy(opts: { path?: string; port?: number; start?: boolean } = {}) {
  if (busy()) throw new SetupError("Crackio is already setting up ComfyUI.", 409);
  const { plan, folder } = await planInfo();
  if (!plan.supported) throw new SetupError(plan.reason);
  const rec = await readRecord();
  const root = path.resolve(opts.path ?? rec?.path ?? folder.path);
  if (rec?.complete && !samePath(rec.path, root) && (await exists(rec.path))) {
    throw new SetupError(`ComfyUI is already installed in ${rec.path}. Uninstall it first to move it.`, 409);
  }
  await checkTarget(root);
  const port = opts.port ?? rec?.port ?? DEFAULT_PORT;
  // A port something else holds (8188 here is an SSH tunnel) is refused up front.
  const holder = await probe(port);
  if ((holder && !(rec && isOurs(holder, rec))) || (!holder && !(await portFree(port)))) {
    throw new SetupError(`Port ${port} is taken by another program: pick another one.`, 409);
  }
  const job = newJob("install", INSTALL_STAGES);
  state.job = job;
  void runInstall(job, root, port, plan, opts.start !== false);
}

/** A folder Crackio may install into: new, empty, or one it made before. */
async function checkTarget(root: string) {
  if (!path.isAbsolute(root) || path.parse(root).root === root || samePath(root, os.homedir())) {
    throw new SetupError("Pick a folder of its own for ComfyUI, not a drive or your home folder.");
  }
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  if (entries.length && !entries.includes(MARKER)) throw new SetupError(`${root} already has other files in it. Pick an empty folder.`, 409);
}

async function runInstall(job: Job, root: string, port: number, plan: SetupPlan, start: boolean) {
  const l = layout(root);
  const ctx: Ctx = { job, l, plan, port, env: installEnv(l), uv: null, system: null, pyVersion: "", comfyuiVersion: "", check: null };
  const steps: [StageId, (c: Ctx) => Promise<void>][] = [
    ["prepare", prepare],
    ["uv", getUv],
    ["python", getPython],
    ["venv", makeVenv],
    ["comfyui", getComfyUI],
    ["torch", installTorch],
    ["packages", installPackages],
    ["bridge", addBridge],
    ["check", checkTorch],
  ];
  try {
    for (const [stage, step] of steps) {
      enter(job, stage);
      await step(ctx);
    }
    await saveRecord({
      ...((await readRecord()) ?? {}),
      path: l.root,
      comfyui: l.comfy,
      python: l.python,
      port,
      flags: plan.flags,
      complete: true,
      pythonVersion: ctx.pyVersion,
      torch: ctx.check?.torch,
      cuda: ctx.check?.cuda ?? ctx.check?.hip ?? null,
      build: plan.build,
      comfyuiVersion: ctx.comfyuiVersion,
      device: ctx.check?.device ?? null,
      installedAt: new Date().toISOString(),
      installSeconds: Math.round((Date.now() - job.startedAt) / 1000),
    });
    say(job, `Installed in ${Math.round((Date.now() - job.startedAt) / 1000)} s.`);
    if (start) {
      enter(job, "start");
      await startAndWait(job);
    }
    job.finishedAt = Date.now();
  } catch (err) {
    job.error = (err as Error).message;
    job.finishedAt = Date.now();
    say(job, `✗ ${job.error}`);
  }
  // Kept for later: what went wrong, after Crackio restarts.
  await fs.writeFile(path.join(l.logs, "install.log"), `${job.log.join("\n")}\n`).catch(() => {});
}

async function prepare({ job, l, plan }: Ctx) {
  // A repair: stop the running ComfyUI first, or Windows keeps its files locked.
  if (state.proc.state === "running" || state.proc.state === "starting") {
    say(job, "Stopping ComfyUI while its files change.");
    await stopComfy();
  }
  await fs.mkdir(l.root, { recursive: true });
  await writeFileAtomic(l.marker, JSON.stringify({ madeBy: "Crackio", path: l.root, at: new Date().toISOString() }, null, 2));
  for (const dir of [l.tmp, l.logs, l.cache, l.downloads]) await fs.mkdir(dir, { recursive: true });
  const need = (await exists(l.python)) ? 2 : plan.diskGb + 1;
  const free = await freeAt(l.root);
  say(job, `Installing into ${l.root} (${free ?? "?"} GB free).`);
  if (free !== null && free < need) throw new Error(`It needs about ${need} GB free on ${path.parse(l.root).root} and there are ${free} GB.`);
}

/** "uv 0.12.5 (…)" → [0, 12, 5]. */
async function uvVersion(cmd: string) {
  const r = await run(cmd, ["--version"], { timeoutMs: 20_000 });
  const m = r.code === 0 ? r.out.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** uv 0.8 or newer: the install folder's own, or this computer's. */
async function findUv(l: Layout) {
  for (const cmd of [l.uv, "uv"]) {
    const v = await uvVersion(cmd);
    if (v && (v[0] > 0 || v[1] >= 8)) return { cmd, version: v.join(".") };
  }
  return null;
}

async function getUv(ctx: Ctx) {
  const { job, l } = ctx;
  let found = await findUv(l);
  if (!found) {
    say(job, "This computer has no uv: installing it into the ComfyUI folder.");
    const env = { ...ctx.env, UV_UNMANAGED_INSTALL: l.bin };
    const r = WIN
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"], { env, timeoutMs: 5 * 60_000, onLine: (s) => say(job, s) })
      : await run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh || wget -qO- https://astral.sh/uv/install.sh | sh"], { env, timeoutMs: 5 * 60_000, onLine: (s) => say(job, s) });
    if (r.code !== 0) say(job, `uv didn't install (${lastLine(r)}).`);
    found = await findUv(l);
  }
  if (found) {
    ctx.uv = found.cmd;
    say(job, `Using uv ${found.version}${found.cmd === "uv" ? "" : ` (${found.cmd})`}.`);
  } else {
    say(job, "No uv: using this computer's own Python instead.");
  }
}

/**
 * This computer's Python for when uv can't be had: the version the build wants (3.12; 3.13 for AMD's Windows wheels),
 * else for the usual build another 3.10–3.13.
 */
async function systemPython(want: string) {
  const exact = want !== PYTHON;
  const tries: [string, string[]][] = WIN
    ? [["py", [`-${want}`]], ...(exact ? [] : ([["py", ["-3.13"]], ["py", ["-3.11"]], ["py", ["-3.10"]]] as [string, string[]][])), ["python", []]]
    : [[`python${want}`, []], ["python3", []], ["python", []]];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, [...args, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { timeoutMs: 20_000 });
    const version = r.out.trim();
    if (r.code === 0 && (exact ? version.startsWith(`${want}.`) : /^3\.1[0-3]\.\d+$/.test(version))) return { cmd, args, version };
  }
  return null;
}

async function getPython(ctx: Ctx) {
  const { job, l } = ctx;
  if (ctx.uv) {
    // --no-bin and --no-registry: no python3.12 on PATH and nothing in the registry; this Python is the install's own.
    await must(job, "Installing Python", ctx.uv, ["python", "install", ctx.plan.python, "--install-dir", l.pythons, "--no-bin", ...(WIN ? ["--no-registry"] : [])], { env: ctx.env });
    return;
  }
  ctx.system = await systemPython(ctx.plan.python);
  if (!ctx.system) throw new Error(`There's no Python ${ctx.plan.python} here and uv couldn't be installed to get one. Install Python ${ctx.plan.python} from python.org, then try again.`);
  say(job, `Using this computer's Python ${ctx.system.version}.`);
}

async function pythonWorks(python: string) {
  return (await run(python, ["-I", "-c", "import sys, pip"], { timeoutMs: 60_000 })).code === 0;
}

async function makeVenv(ctx: Ctx) {
  const { job, l } = ctx;
  if (!(await pythonWorks(l.python))) {
    if (ctx.uv) {
      // --seed adds pip: the bridge and custom nodes install their requirements with it.
      await must(job, "Making the Python environment", ctx.uv, ["venv", l.venv, "--python", ctx.plan.python, "--managed-python", "--seed", "--clear"], { env: ctx.env });
    } else {
      await must(job, "Making the Python environment", ctx.system!.cmd, [...ctx.system!.args, "-m", "venv", "--clear", l.venv], { env: ctx.env });
    }
  } else {
    say(job, "Its Python environment is already there.");
  }
  ctx.pyVersion = (await run(l.python, ["-I", "-c", "import platform; print(platform.python_version())"])).out.trim();
  say(job, `Python ${ctx.pyVersion}.`);
}

/** ComfyUI's newest release ("v0.42.1"), or null to take master. */
async function latestRelease() {
  try {
    const res = await fetch("https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest", {
      headers: { "User-Agent": "crackio", Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const tag = res.ok ? ((await res.json()) as { tag_name?: string }).tag_name : undefined;
    return tag && /^v?\d+\.\d+/.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

async function comfyVersionAt(l: Layout) {
  const text = await fs.readFile(path.join(l.comfy, "comfyui_version.py"), "utf8").catch(() => "");
  return text.match(/__version__\s*=\s*["']([^"']+)/)?.[1] ?? "";
}

async function getComfyUI(ctx: Ctx) {
  const { job, l } = ctx;
  if (await exists(l.main)) {
    ctx.comfyuiVersion = await comfyVersionAt(l);
    say(job, `ComfyUI ${ctx.comfyuiVersion} is already there.`);
    return;
  }
  await fs.rm(l.comfy, { recursive: true, force: true });
  const tag = await latestRelease();
  say(job, `ComfyUI ${tag ?? "(latest)"} from ${COMFY_REPO}.`);
  if ((await run("git", ["--version"], { timeoutMs: 20_000 })).code === 0) {
    await must(job, "Downloading ComfyUI", "git", ["-c", "advice.detachedHead=false", "clone", "--progress", "--depth", "1", ...(tag ? ["--branch", tag] : []), `${COMFY_REPO}.git`, l.comfy], {
      env: ctx.env,
      timeoutMs: 20 * 60_000,
      live: /\d+%/,
      progress: (line) => {
        const m = line.match(/^Receiving objects:\s+(\d+)%/);
        return m ? Number(m[1]) / 100 : null;
      },
    });
  } else {
    await comfyFromZip(ctx, tag);
  }
  ctx.comfyuiVersion = await comfyVersionAt(l);
}

/** Without git: GitHub's zip of the release, unpacked with the environment's own Python. */
async function comfyFromZip(ctx: Ctx, tag: string | null) {
  const { job, l } = ctx;
  const zip = path.join(l.tmp, "comfyui.zip");
  const out = path.join(l.tmp, "comfyui-unzipped");
  const url = `${COMFY_REPO}/archive/refs/${tag ? `tags/${tag}` : "heads/master"}.zip`;
  say(job, "No git here: downloading ComfyUI as a zip.");
  await download(url, zip, null, (got) => (job.detail = `${round1(got / 1024 ** 2)} MB`));
  await fs.rm(out, { recursive: true, force: true });
  await must(job, "Unpacking ComfyUI", ctx.l.python, ["-I", "-m", "zipfile", "-e", zip, out]);
  const [inner] = await fs.readdir(out);
  if (!inner) throw new Error("ComfyUI's zip was empty.");
  await fs.rename(path.join(out, inner), l.comfy);
  await fs.rm(out, { recursive: true, force: true });
  await fs.rm(zip, { force: true });
}

/** The installed version of a package ("2.14.1+cu126"), or null. */
async function installedVersion(python: string, pkg: string) {
  const r = await run(python, ["-I", "-c", "import importlib.metadata as m, sys\ntry: print(m.version(sys.argv[1]))\nexcept Exception: pass", pkg], { timeoutMs: 60_000 });
  return r.out.trim() || null;
}

const pinned = (version: string | null, plan: SetupPlan) => (version && plan.index ? `${version}+${plan.build}` : version);

async function installTorch(ctx: Ctx) {
  const { job, l, plan } = ctx;
  const want = pinned(plan.torch, plan);
  const have = await installedVersion(l.python, "torch");
  if (have && (!want || have === want)) {
    say(job, `PyTorch ${have} is already installed.`);
    return;
  }
  if (have) say(job, `Replacing PyTorch ${have} with ${want}.`);
  const wheel = await torchWheel(ctx).catch((err) => {
    say(job, `Couldn't fetch the wheel directly (${(err as Error).message}); the installer will.`);
    return null;
  });
  const vision = pinned(plan.torchvision, plan);
  const extra = plan.extras ? `[${plan.extras}]` : "";
  const specs = [wheel ?? (want ? `torch${extra}==${want}` : "torch"), vision ? `torchvision${extra}==${vision}` : "torchvision"];
  const index = plan.index ? ["--index-url", plan.index] : [];
  job.fraction = wheel ? 0.88 : null;
  job.detail = null;
  if (ctx.uv) await must(job, "Installing PyTorch", ctx.uv, ["pip", "install", "--python", l.python, ...index, ...specs], { env: ctx.env, timeoutMs: 60 * 60_000 });
  else await must(job, "Installing PyTorch", l.python, ["-m", "pip", "install", "--no-cache-dir", "--progress-bar", "off", ...index, ...specs], { env: ctx.env, timeoutMs: 60 * 60_000 });
  if (wheel) await fs.rm(wheel, { force: true });
}

/** pip's platform tag for this computer, or null where PyTorch's own index isn't used. */
function wheelPlatform() {
  if (process.platform === "win32") return process.arch === "arm64" ? "win_arm64" : "win_amd64";
  if (process.platform === "linux") return process.arch === "arm64" ? "manylinux_2_28_aarch64" : "manylinux_2_28_x86_64";
  return null;
}

/**
 * PyTorch's wheel, fetched here rather than by uv: it is most of the install (2.4 GB for CUDA 12.6 on Windows), and
 * this way it shows real progress, resumes after a dropped connection or a restart, and is checked against the
 * SHA-256 the index lists. Null when the index doesn't list one for this computer (uv then fetches it).
 */
async function torchWheel(ctx: Ctx): Promise<string | null> {
  const { job, l, plan } = ctx;
  const platform = wheelPlatform();
  if (!plan.torch || !plan.index?.startsWith(PYTORCH) || !platform) return null;
  const py = `cp${ctx.pyVersion.split(".").slice(0, 2).join("")}`;
  const file = `torch-${plan.torch}+${plan.build}-${py}-${py}-${platform}.whl`;
  const dest = path.join(l.downloads, file);
  if (await exists(dest)) return dest;
  const html = await (await fetch(`${plan.index}/torch/`, { cache: "no-store", signal: AbortSignal.timeout(60_000) })).text();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`href="([^"]*?(?:${esc(file.replace("+", "%2B"))}|${esc(file)}))#sha256=([0-9a-f]{64})"`));
  if (!m) return null;
  const url = new URL(m[1].replace(/&amp;/g, "&"), `${plan.index}/torch/`).toString();
  say(job, `Downloading ${file}.`);
  let last = 0;
  await download(
    url,
    dest,
    m[2],
    (got, total) => {
      job.fraction = total ? 0.85 * (got / total) : null;
      job.detail = `${round1(got / GB)} of ${round1(total / GB)} GB`;
      if (got - last > 256 * 1024 ** 2 || got === total) {
        last = got;
        say(job, `Downloaded ${job.detail}`, true);
      }
    },
    () => (job.detail = "Checking the download"),
  );
  say(job, "Its SHA-256 matches the index.");
  return dest;
}

/** Fetches a file to `dest`, resuming the `.part` an earlier try left, and checks its SHA-256 when given. */
async function download(url: string, dest: string, sha256: string | null, onProgress: (got: number, total: number) => void, onCheck?: () => void) {
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, part, onProgress);
      break;
    } catch (err) {
      if (attempt >= 6) throw err;
      await sleep(Math.min(30_000, 2000 * attempt));
    }
  }
  if (sha256) {
    onCheck?.();
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== sha256) {
      await fs.rm(part, { force: true });
      throw new Error("The download didn't match its checksum. Try again.");
    }
  }
  await fs.rename(part, dest);
}

async function downloadOnce(url: string, part: string, onProgress: (got: number, total: number) => void) {
  const have = (await fs.stat(part).catch(() => null))?.size ?? 0;
  // A connection that goes quiet for a minute is dropped and resumed.
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), 60_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "crackio", ...(have ? { Range: `bytes=${have}-` } : {}) }, cache: "no-store", signal: idle.signal });
    if (res.status === 416) return; // the part is already whole
    if (!res.ok || !res.body) throw new Error(`${res.status} from ${new URL(url).hostname}`);
    const resumed = have > 0 && res.status === 206;
    let got = resumed ? have : 0;
    const total = got + Number(res.headers.get("content-length") ?? 0);
    const fh = await fs.open(part, resumed ? "a" : "w");
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), 60_000);
        await fh.write(chunk);
        got += chunk.length;
        onProgress(got, total);
      }
    } finally {
      await fh.close();
    }
    if (total > got) throw new Error("The download stopped early.");
  } finally {
    clearTimeout(timer);
  }
}

async function installPackages(ctx: Ctx) {
  const { job, l } = ctx;
  // ComfyUI's requirements name torch unpinned: hold PyTorch where it is, or the installer could swap in PyPI's
  // build (CPU-only on Windows) for a package that asks for a newer one. Better a clear failure than a silent one.
  const torch = await installedVersion(l.python, "torch");
  const vision = await installedVersion(l.python, "torchvision");
  await fs.writeFile(l.constraints, [torch && `torch==${torch}`, vision && `torchvision==${vision}`].filter(Boolean).join("\n") + "\n");
  const req = path.join(l.comfy, "requirements.txt");
  if (ctx.uv) await must(job, "Installing ComfyUI's packages", ctx.uv, ["pip", "install", "--python", l.python, "-r", req, "-c", l.constraints], { env: ctx.env, timeoutMs: 40 * 60_000 });
  else await must(job, "Installing ComfyUI's packages", l.python, ["-m", "pip", "install", "--progress-bar", "off", "-r", req, "-c", l.constraints], { env: ctx.env, timeoutMs: 40 * 60_000 });
}

/** Copies comfyui/crackio_bridge into custom_nodes, so Crackio can read the machine and install models into it. */
async function addBridge({ job, l }: Ctx) {
  const from = path.join(/*turbopackIgnore: true*/ process.cwd(), "comfyui", "crackio_bridge");
  const to = path.join(l.comfy, "custom_nodes", "crackio_bridge");
  if (!(await exists(path.join(from, "__init__.py")))) {
    say(job, `The bridge isn't at ${from}; ComfyUI works without it on this computer.`);
    return;
  }
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  say(job, `Copied it to ${to}.`);
}

/**
 * Before ComfyUI starts: the bridge in this install made the same as Crackio's own copy, so updating Crackio brings its
 * newer bridge (pooling came in 1.3) to a ComfyUI installed before. Leaves it as it is when Crackio's copy is missing.
 */
async function refreshBridge(rec: InstallRecord) {
  const from = path.join(/*turbopackIgnore: true*/ process.cwd(), "comfyui", "crackio_bridge");
  const to = path.join(/*turbopackIgnore: true*/ rec.comfyui, "custom_nodes", "crackio_bridge");
  try {
    const files = (await fs.readdir(from)).filter((f) => /\.(py|md)$/.test(f));
    if (!files.includes("__init__.py")) return;
    for (const f of files) {
      const [mine, theirs] = await Promise.all([fs.readFile(path.join(from, f), "utf8"), fs.readFile(path.join(to, f), "utf8").catch(() => null)]);
      if (mine === theirs) continue;
      await fs.cp(from, to, { recursive: true, force: true, filter: (src) => !src.includes("__pycache__") });
      return;
    }
  } catch {
    // A bridge it can't update still works as it was.
  }
}

/** Loads PyTorch, and on a GPU runs a matrix multiply and a convolution and compares them with the CPU's. */
const CHECK_PY = `
import json, platform
out = {'python': platform.python_version()}
try:
    import torch
    out.update(torch=torch.__version__, cuda=torch.version.cuda, hip=getattr(torch.version, 'hip', None))
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        out.update(device=p.name, capability='%d.%d' % (p.major, p.minor), archs=torch.cuda.get_arch_list())
        a = torch.randn(256, 256, device='cuda')
        b = torch.randn(256, 256, device='cuda')
        x = torch.randn(1, 4, 32, 32, device='cuda')
        w = torch.randn(8, 4, 3, 3, device='cuda')
        same = torch.allclose((a @ b).cpu(), a.cpu() @ b.cpu(), rtol=1e-3, atol=1e-3)
        conv = torch.allclose(torch.nn.functional.conv2d(x, w).cpu(), torch.nn.functional.conv2d(x.cpu(), w.cpu()), rtol=1e-3, atol=1e-3)
        torch.cuda.synchronize()
        out['gpu_ok'] = bool(same and conv)
    elif getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available():
        out.update(device='Apple GPU (Metal)', gpu_ok=float((torch.ones(8, device='mps') * 2).sum()) == 16.0)
    elif hasattr(torch, 'xpu') and torch.xpu.is_available():
        out.update(device=torch.xpu.get_device_name(0), gpu_ok=float((torch.ones(8, device='xpu') * 2).sum()) == 16.0)
except Exception as e:
    out['error'] = '%s: %s' % (type(e).__name__, e)
print('CRACKIO_CHECK ' + json.dumps(out))
`;

async function checkTorch(ctx: Ctx) {
  const { job, l, plan } = ctx;
  const r = await run(l.python, ["-I", "-c", CHECK_PY], { env: comfyEnv(l), timeoutMs: 5 * 60_000 });
  const line = r.out.split(/\r?\n/).find((s) => s.startsWith("CRACKIO_CHECK "));
  if (!line) throw new Error(`PyTorch didn't load: ${lastLine(r)}`);
  const check = JSON.parse(line.slice("CRACKIO_CHECK ".length)) as Check;
  ctx.check = check;
  if (check.error) throw new Error(`PyTorch didn't work: ${check.error}`);
  say(job, `PyTorch ${check.torch}${check.cuda ? ` (CUDA ${check.cuda})` : check.hip ? ` (ROCm ${check.hip})` : ""} on Python ${check.python}.`);
  if (plan.build === "cpu") return;
  if (!check.device) throw new Error(`PyTorch ${check.torch} can't see the GPU. Update its driver, restart the computer, then install again to repair it.`);
  if (!check.gpu_ok) throw new Error(`PyTorch sees ${check.device} but got wrong numbers from it.`);
  say(job, `It sees ${check.device}${check.capability ? ` (compute ${check.capability})` : ""}${check.archs ? `, built for ${check.archs.join(" ")}` : ""}; a test on it matched the CPU.`);
}

/* ------------------------------------------------------------------ uninstall */

/** Deletes the install folder (ComfyUI, its models, its Python) after stopping ComfyUI. Only with confirm. */
export async function uninstallComfy(confirm: boolean) {
  const rec = await readRecord();
  const root = rec?.path ?? (await planInfo()).folder.path;
  if (!confirm) throw new SetupError(`Uninstalling deletes ${root}, models included: send confirm: true to go ahead.`);
  if (busy()) throw new SetupError("Crackio is already setting up ComfyUI.", 409);
  const l = layout(root);
  if (!(await exists(root))) {
    await fs.rm(RECORD_FILE, { force: true });
    throw new SetupError("ComfyUI isn't installed on this computer.", 404);
  }
  if (!(await madeByCrackio(l))) throw new SetupError(`${root} wasn't made by Crackio, so it isn't deleted.`, 409);
  const job = newJob("uninstall", UNINSTALL_STAGES);
  state.job = job;
  void (async () => {
    try {
      enter(job, "stop");
      await stopComfy();
      enter(job, "remove");
      await removeFolder(job, l);
      await fs.rm(RECORD_FILE, { force: true });
      job.finishedAt = Date.now();
      say(job, `Removed ${root}.`);
    } catch (err) {
      job.error = (err as Error).message;
      job.finishedAt = Date.now();
      say(job, `✗ ${job.error}`);
    }
  })();
}

async function madeByCrackio(l: Layout) {
  try {
    const marker = JSON.parse(await fs.readFile(l.marker, "utf8")) as { madeBy?: string; path?: string };
    return marker.madeBy === "Crackio" && samePath(marker.path ?? "", l.root);
  } catch {
    return false;
  }
}

/** One part of the folder at a time, so the page shows it going; the marker goes last. */
async function removeFolder(job: Job, l: Layout) {
  const entries = (await fs.readdir(l.root)).filter((e) => e !== MARKER);
  for (const [i, entry] of entries.entries()) {
    job.detail = entry;
    await fs.rm(path.join(l.root, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    job.fraction = (i + 1) / (entries.length + 1);
  }
  await fs.rm(l.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  // An empty "Crackio" folder above it goes too.
  const parent = path.dirname(l.root);
  if (path.basename(parent) === "Crackio" && !(await fs.readdir(parent).catch(() => ["?"])).length) await fs.rmdir(parent).catch(() => {});
}

/* ------------------------------------------------------------------ running ComfyUI */

type Stats = { system?: { argv?: string[]; comfyui_version?: string; pytorch_version?: string }; devices?: { name?: string; type?: string; vram_total?: number; vram_free?: number }[] };

/** What a ComfyUI on this port says about itself, or null when nothing answers. */
async function probe(port: number): Promise<Stats | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    return res.ok ? ((await res.json()) as Stats) : null;
  } catch {
    return null;
  }
}

/**
 * Whether that ComfyUI is this install's, not another one on the same port (a tunnel to a rented GPU, say). Crackio
 * starts it by main.py's full path, and the bridge's restart keeps it; a bare "main.py" is a ComfyUI started from its
 * own folder, which could be anywhere.
 */
function isOurs(stats: Stats, rec: InstallRecord) {
  const argv0 = stats.system?.argv?.[0];
  return Boolean(argv0 && path.isAbsolute(argv0) && samePath(argv0, path.join(rec.comfyui, "main.py")));
}

/**
 * The pid when that process is this install's Python (the venv's launcher, or the interpreter it starts), else null.
 * Crackio only ever stops or watches a process that passes this: never a tunnel or another program on the port.
 */
async function ourPid(pid: number | null, rec: InstallRecord): Promise<number | null> {
  if (!pid || !alive(pid)) return null;
  const r = WIN
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], { timeoutMs: 15_000 })
    : await run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 10_000 });
  const exe = r.out.trim();
  const root = path.resolve(rec.path) + path.sep;
  const inside = WIN ? exe.toLowerCase().startsWith(root.toLowerCase()) : exe.includes(root);
  return exe && inside ? pid : null;
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** The process listening on a port: how Crackio finds a ComfyUI that restarted itself (the bridge's restart). */
async function portOwner(port: number): Promise<number | null> {
  const r = WIN
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { timeoutMs: 15_000 })
    : await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 10_000 });
  const pid = Number(r.out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The record of a finished install whose files are all still there. */
async function installed(): Promise<InstallRecord | null> {
  const rec = await readRecord();
  if (!rec?.complete) return null;
  return (await exists(rec.python)) && (await exists(path.join(rec.comfyui, "main.py"))) ? rec : null;
}

/**
 * Starts ComfyUI (or keeps the one running). It runs detached, writing to <folder>/logs/comfyui.log, so neither a hot
 * reload nor a restart of Crackio stops it: Crackio finds it again by its process and port. `keepAlive` starts it
 * again when it crashes.
 */
export async function startComfy(opts: { keepAlive?: boolean; share?: boolean } = {}) {
  await adopt();
  if (state.job && !state.job.finishedAt && state.job.action === "uninstall") throw new SetupError("ComfyUI is being removed.", 409);
  const rec = await installed();
  if (!rec) throw new SetupError("ComfyUI isn't installed on this computer yet.", 404);
  const p = state.proc;
  if (p.state === "stopping") throw new SetupError("ComfyUI is stopping: start it again in a moment.", 409);
  if (opts.keepAlive !== undefined) p.keepAlive = opts.keepAlive;
  if (rec.stoppedByUser) {
    await updateRecord({ stoppedByUser: false });
    rec.stoppedByUser = false;
  }
  // Sharing on the network or not is how it listens: a running ComfyUI starts over to change it.
  if (opts.share !== undefined && opts.share !== Boolean(rec.share)) {
    await updateRecord({ share: opts.share });
    rec.share = opts.share;
    if (p.state === "running" || p.state === "starting") {
      await stopComfy();
      await launch(rec);
      return;
    }
  }
  if (p.state === "running" || p.state === "starting") {
    if (p.pid) await updateRecord({ run: { pid: p.pid, startedAt: p.startedAt ?? Date.now(), keepAlive: p.keepAlive } });
    watch();
    return;
  }
  await launch(rec);
}

async function launch(rec: InstallRecord) {
  const p = state.proc;
  const stats = await probe(rec.port);
  if (stats) {
    if (!isOurs(stats, rec)) throw new SetupError(`Another program answers on port ${rec.port}. Stop it, or install again with another port.`, 409);
    // Already running (started before Crackio restarted, or by hand): take it over.
    Object.assign(p, { state: "running", child: null, pid: await ourPid(await portOwner(rec.port), rec), port: rec.port, startedAt: Date.now(), readyAt: Date.now(), error: null });
    if (p.pid) await updateRecord({ run: { pid: p.pid, startedAt: Date.now(), keepAlive: p.keepAlive } });
    watch();
    return;
  }
  if (!(await portFree(rec.port))) throw new SetupError(`Port ${rec.port} is taken by another program.`, 409);
  await refreshBridge(rec);
  const l = layout(rec.path);
  await fs.mkdir(l.logs, { recursive: true });
  await fs.rename(l.log, path.join(l.logs, "comfyui.previous.log")).catch(() => {});
  const fd = openSync(l.log, "a");
  let child: ChildProcess;
  // Windows counts pinned memory against its commit limit, and ComfyUI pins up to 40% of RAM for the weights it
  // offloads: with a 14B video model, a browser open and a full disk (the pagefile can't grow), allocations started
  // failing mid-job on a 48 GB PC. Video models compute for minutes a step, so unpinned transfers cost nothing there.
  const memory = process.platform === "win32" && !rec.flags.includes("--disable-pinned-memory") ? ["--disable-pinned-memory"] : [];
  // Macs: ComfyUI picks its sub-quadratic attention there, which holds 4–5 GB of scratch memory for every attention of a
  // 1–2 MP picture and takes twice as long as PyTorch's own, a fused Metal kernel that needs none (an M2 Air, PyTorch
  // 2.14: 148 against 260 ms at 1 MP, 652 against 1295 ms over a clip's 32k tokens, Oct 2026). Sub-quad also turns LTX
  // clips black on Macs (ComfyUI #15804).
  const attention = rec.build === "mps" && !rec.flags.some((f) => /cross-attention|--use-(sage|flash)/.test(f)) ? ["--use-pytorch-cross-attention"] : [];
  // ComfyUI 0.42 drops earlier jobs' models from its cache whenever free RAM is under its "inactive" headroom, which is all
  // of RAM by default: so every job reloads its models (FLUX.2 klein on an M2: ~10 s of a 97 s picture). On a Mac with 32
  // GB or more it keeps them while a quarter of the RAM is free (active headroom as ComfyUI's default); 16–24 GB Macs
  // have to let them go anyway.
  const ramGb = os.totalmem() / 1024 ** 3;
  const cache = rec.build === "mps" && ramGb >= 31 && !rec.flags.some((f) => /^--cache-/.test(f)) ? ["--cache-ram", String(Math.min(10, Math.max(2, Math.round(ramGb * 0.1)))), String(Math.round(ramGb * 0.25))] : [];
  try {
    child = spawn(rec.python, [l.main, "--listen", rec.share ? "0.0.0.0" : "127.0.0.1", "--port", String(rec.port), ...rec.flags, ...memory, ...attention, ...cache], {
      cwd: l.comfy,
      env: comfyEnv(l),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  Object.assign(p, { state: "starting", child, pid: child.pid ?? null, port: rec.port, startedAt: Date.now(), readyAt: null, error: null });
  child.once("error", (err) => {
    if (p.child !== child) return;
    Object.assign(p, { state: "crashed", child: null, pid: null, error: `ComfyUI didn't start: ${err.message}` });
  });
  child.once("exit", (code) => void onExit(child, code));
  if (p.pid) await updateRecord({ run: { pid: p.pid, startedAt: Date.now(), keepAlive: p.keepAlive } });
  watch();
  void untilReady(child, rec);
}

/** Polls /system_stats until this ComfyUI answers (its first start takes a minute: PyTorch and every node load). */
async function untilReady(child: ChildProcess | null, rec: InstallRecord, ms = 6 * 60_000) {
  const p = state.proc;
  const until = Date.now() + ms;
  while (Date.now() < until && p.child === child && p.state === "starting") {
    const stats = await probe(rec.port);
    if (stats && isOurs(stats, rec) && p.child === child && p.state === "starting") {
      Object.assign(p, { state: "running", readyAt: Date.now() });
      return;
    }
    await sleep(1000);
  }
  if (p.child === child && p.state === "starting") p.error = "ComfyUI is taking long to start; its log says why.";
}

/** The install job's last stage: start ComfyUI and wait until it answers. */
async function startAndWait(job: Job) {
  await startComfy();
  const p = state.proc;
  const started = Date.now();
  say(job, "Its first start takes a minute: PyTorch and every node load.");
  while (p.state === "starting" && Date.now() - started < 6 * 60_000) await sleep(500);
  if (p.state !== "running") throw new Error(`ComfyUI installed, but didn't start: ${p.error ?? "see its log"}`);
  say(job, `ComfyUI answers at http://127.0.0.1:${p.port}.`);
}

async function onExit(child: ChildProcess, code: number | null) {
  const p = state.proc;
  if (p.child !== child) return;
  p.child = null;
  await gone(code);
}

/** The ComfyUI process ended: stopped by Crackio, restarted by the bridge, or crashed. */
async function gone(code: number | null) {
  const p = state.proc;
  if (p.state === "stopping" || p.state === "stopped" || p.state === "crashed") return;
  // "Starting" until it's clear which: the page shouldn't flash "crashed" during a restart.
  Object.assign(p, { state: "starting", pid: null, lastExit: { code, at: Date.now() } });
  const rec = await installed();
  // The bridge's restart (os.execv) is a new process on Windows, started before the old one ends cleanly. A crash
  // ends with an error code, or leaves no process behind.
  if (rec && (code === null || code === 0) && (await successor(rec)) && (await comesBack(rec))) return;
  // Stopped, or started again, meanwhile.
  if (p.state !== "starting" || p.child) return;
  p.state = "crashed";
  p.error = `ComfyUI stopped${code !== null ? ` (exit code ${code})` : ""}. ${await lastLogError(rec)}`.trim();
  await updateRecord({ run: null });
  // Start it again when asked to, at most three times in ten minutes.
  p.restarts = p.restarts.filter((t) => Date.now() - t < 10 * 60_000);
  if (p.keepAlive && rec && p.restarts.length < 3) {
    p.restarts.push(Date.now());
    setTimeout(() => {
      if (state.proc.state === "crashed") void launch(rec).catch((err) => (state.proc.error = (err as Error).message));
    }, 3000);
  }
}

/** A process running this install's main.py: what the bridge's restart leaves on Windows. */
async function successor(rec: InstallRecord): Promise<number | null> {
  const main = path.join(rec.comfyui, "main.py");
  const r = WIN
    ? await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${main.replace(/'/g, "''")}') } | Select-Object -First 1 -ExpandProperty ProcessId`,
        ],
        { timeoutMs: 15_000 },
      )
    : await run("pgrep", ["-f", main], { timeoutMs: 10_000 });
  const pid = Number(r.out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Waits for this install's ComfyUI to answer again (a restart reloads PyTorch and every node), and takes it over. */
async function comesBack(rec: InstallRecord, ms = 90_000) {
  const p = state.proc;
  const until = Date.now() + ms;
  while (Date.now() < until && p.state === "starting" && !p.child) {
    const stats = await probe(rec.port);
    if (stats && isOurs(stats, rec)) {
      Object.assign(p, { state: "running", pid: await ourPid(await portOwner(rec.port), rec), readyAt: Date.now() });
      if (p.pid) await updateRecord({ run: { pid: p.pid, startedAt: p.startedAt ?? Date.now(), keepAlive: p.keepAlive } });
      return true;
    }
    await sleep(1500);
  }
  return false;
}

/** Notices when a ComfyUI Crackio took over (not its own child, so no exit event) goes away. */
function watch() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    const p = state.proc;
    if (p.child || !p.pid || p.state !== "running" || alive(p.pid)) return;
    void gone(null);
  }, 4000);
  state.timer.unref?.();
}

/** After Crackio restarts: the ComfyUI it started before may still be running (detached, it outlives Crackio). */
async function adopt() {
  if (state.adopted) return;
  state.adopted = true;
  const rec = await installed();
  if (!rec || state.proc.state !== "stopped") return;
  const p = state.proc;
  const run = rec.run ?? null;
  p.keepAlive = run?.keepAlive ?? false;
  const stats = await probe(rec.port);
  const known = await ourPid(run?.pid ?? null, rec);
  if (stats && isOurs(stats, rec)) {
    const pid = known ?? (await ourPid(await portOwner(rec.port), rec));
    Object.assign(p, { state: "running", pid, port: rec.port, startedAt: run?.startedAt ?? Date.now(), readyAt: Date.now() });
    if (pid && pid !== run?.pid) await updateRecord({ run: { pid, startedAt: Date.now(), keepAlive: p.keepAlive } });
    watch();
  } else if (run && known && Date.now() - run.startedAt < 10 * 60_000) {
    // Still loading when Crackio restarted.
    Object.assign(p, { state: "starting", pid: run.pid, port: rec.port, startedAt: run.startedAt });
    watch();
    void untilReady(null, rec);
  } else if (run) {
    await updateRecord({ run: null });
  }
}

/**
 * When Crackio starts: its own ComfyUI starts with it (unless you stopped it), so your local models are in every picker
 * after a restart of the computer without a trip to the Local page. Doesn't wait for it to load.
 */
export async function startWithCrackio() {
  await adopt();
  const rec = await installed();
  if (!rec || rec.stoppedByUser || state.proc.state !== "stopped" || busy()) return;
  await launch(rec);
}

/** Stops ComfyUI and waits until its port is free. `byUser`: you asked (it then stays stopped when Crackio starts). */
export async function stopComfy(opts: { byUser?: boolean } = {}) {
  await adopt();
  const p = state.proc;
  const rec = await readRecord();
  const port = rec?.port ?? p.port;
  // Only ever this install's own processes.
  let pid = rec ? await ourPid(p.pid, rec) : null;
  if (rec && !pid) {
    const stats = await probe(port);
    if (stats && isOurs(stats, rec)) pid = await ourPid(await portOwner(port), rec);
  }
  p.state = "stopping";
  if (pid && rec) {
    await killPid(pid);
    // The real interpreter under a venv launcher can outlive the launcher: stop it too if it still holds the port.
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const stats = await probe(port);
      if (!alive(pid) && !(stats && isOurs(stats, rec))) break;
      const owner = stats && isOurs(stats, rec) ? await ourPid(await portOwner(port), rec) : null;
      if (owner) await killPid(owner);
      await sleep(700);
    }
  }
  Object.assign(p, { state: "stopped", child: null, pid: null, readyAt: null, error: null });
  await updateRecord({ run: null, ...(opts.byUser ? { stoppedByUser: true } : {}) });
}

/** The last lines of what ComfyUI printed. */
async function logTail(rec: InstallRecord | null, lines = 60) {
  if (!rec) return [];
  const file = layout(rec.path).log;
  try {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      const length = Math.min(size, 32_000);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, size - length);
      // Progress bars (tqdm) redraw with \r: each redraw is a line of its own here.
      return plain(buf.toString("utf8"))
        .split(/\r\n|\n|\r/)
        .filter((s) => s.trim())
        .slice(-lines);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

async function lastLogError(rec: InstallRecord | null) {
  const tail = await logTail(rec, 40);
  return (tail.filter((l) => /error|exception|traceback/i.test(l)).pop() ?? "").slice(0, 300);
}

/* ------------------------------------------------------------------ status */

export type SetupStatus = {
  installed: boolean;
  /** An install that started and didn't finish: installing again picks it up. */
  partial: boolean;
  running: boolean;
  state: "not-installed" | "installing" | "uninstalling" | ProcState;
  /** Where ComfyUI answers (once it runs). */
  url: string | null;
  port: number;
  /** The install folder, or where a new one would go. */
  path: string;
  /** Why that folder. */
  pathWhy: string;
  freeGb: number | null;
  torch: string | null;
  cuda: string | null;
  python: string | null;
  comfyui: string | null;
  device: string | null;
  installSeconds: number | null;
  keepAlive: boolean;
  /** Listening on the network, and the address other computers use then. */
  share: boolean;
  lanUrl: string | null;
  /** The install or uninstall in progress (or the last one): the stage in words, 0–100, the step. */
  stage: string | null;
  progress: number | null;
  step: { index: number; count: number } | null;
  detail: string | null;
  job: { action: "install" | "uninstall"; startedAt: number; finishedAt: number | null } | null;
  error: string | null;
  /** The last lines of the install's log while it runs (or failed), else of ComfyUI's. */
  log: string[];
  logOf: "install" | "comfyui" | null;
  /** What it would install on this computer, and why. */
  plan: SetupPlan;
};

/** This computer's address on its local network (a private IPv4), for other computers to reach a shared ComfyUI. */
function lanUrl(port: number) {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => Boolean(n && n.family === "IPv4" && !n.internal))
    .map((n) => n.address);
  const ip = ips.find((a) => /^192\.168\./.test(a)) ?? ips.find((a) => /^10\./.test(a)) ?? ips.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ?? ips[0];
  return ip ? `http://${ip}:${port}` : null;
}

export async function setupStatus(): Promise<SetupStatus> {
  await adopt();
  const [{ plan, folder }, rec] = await Promise.all([planInfo(), readRecord()]);
  const done = await installed();
  const root = rec?.path ?? folder.path;
  const partial = !done && (await exists(layout(root).marker));
  const p = state.proc;
  const job = state.job;
  const working = job && !job.finishedAt;
  const showJob = job && (working || job.error);
  const port = rec?.port ?? DEFAULT_PORT;
  const i = job ? job.stages.findIndex((s) => s.id === job.stage) : -1;
  return {
    installed: Boolean(done),
    partial,
    running: p.state === "running",
    state: working ? (job.action === "install" ? "installing" : "uninstalling") : done ? p.state : "not-installed",
    url: done ? `http://127.0.0.1:${port}` : null,
    port,
    path: root,
    pathWhy: rec ? "Where Crackio installed it." : folder.why,
    freeGb: await freeAt(root),
    torch: done?.torch ?? null,
    cuda: done?.cuda ?? null,
    python: done?.pythonVersion ?? null,
    comfyui: done?.comfyuiVersion ?? null,
    device: done?.device ?? null,
    installSeconds: done?.installSeconds ?? null,
    keepAlive: p.keepAlive,
    share: Boolean(done?.share),
    lanUrl: done?.share ? lanUrl(port) : null,
    stage: job ? (job.stages[i]?.label ?? null) : null,
    progress: job ? percentOf(job) : null,
    step: job ? { index: i + 1, count: job.stages.length } : null,
    detail: job?.detail ?? null,
    job: job ? { action: job.action, startedAt: job.startedAt, finishedAt: job.finishedAt } : null,
    error: (showJob ? job.error : null) ?? (p.state === "crashed" || p.state === "starting" ? p.error : null),
    log: showJob ? job.log.slice(-80) : await logTail(done),
    logOf: showJob ? "install" : done ? "comfyui" : null,
    plan,
  };
}
