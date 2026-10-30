import "server-only";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { DATA_DIR } from "./paths";
import type { Backend, Gpu, GpuVendor, Machine } from "@/lib/local/types";

export type { Gpu, Machine };

/**
 * What a machine can run models on: its GPU and memory, OS, CPU and free disk. "This computer" is read
 * with the OS's own tools (nvidia-smi, sysctl, the Windows registry); a ComfyUI elsewhere reports through
 * its /system_stats (and the Crackio bridge node, when installed, for its CPU and disk).
 */

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

const vendorOf = (name: string): GpuVendor =>
  /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name)
    ? "nvidia"
    : /amd|radeon|ati /i.test(name)
      ? "amd"
      : /intel|arc|iris|uhd/i.test(name)
        ? "intel"
        : /apple/i.test(name)
          ? "apple"
          : "other";

/** Every NVIDIA GPU, with its real memory and compute capability. */
async function nvidia(): Promise<Gpu[]> {
  const csv = await run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"]);
  if (!csv) return [];
  return csv
    .split(/\r?\n/)
    .map((line) => line.split(",").map((s) => s.trim()))
    .filter((p) => p[0])
    .map(([name, mem, driver, cap]) => ({
      name: name.replace(/^NVIDIA\s+/i, "NVIDIA "),
      vendor: "nvidia" as const,
      memoryGb: Number(mem) ? round1(Number(mem) / 1024) : null,
      unified: false,
      driver,
      compute: Number(cap) || undefined,
    }));
}

/**
 * Windows' display adapters with their real memory: WMI's AdapterRAM stops at 4 GB, so the size comes
 * from the driver's registry key (HardwareInformation.qwMemorySize).
 */
async function windowsGpus(): Promise<Gpu[]> {
  const script =
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';" +
    "Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue;" +
    " if ($p.DriverDesc) { [pscustomobject]@{ name = $p.DriverDesc; mem = $p.'HardwareInformation.qwMemorySize'; driver = $p.DriverVersion } } } | ConvertTo-Json -Compress";
  const json = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
  if (!json) return [];
  try {
    const rows = ([] as { name: string; mem?: number | string; driver?: string }[]).concat(JSON.parse(json));
    const seen = new Set<string>();
    return rows
      .filter((r) => r.name && !/basic display|remote|virtual|parsec|meta/i.test(r.name) && !seen.has(r.name) && seen.add(r.name))
      .map((r) => ({ name: r.name, vendor: vendorOf(r.name), memoryGb: Number(r.mem) ? round1(Number(r.mem) / GB) : null, unified: false, driver: r.driver }));
  } catch {
    return [];
  }
}

async function macGpu(ramGb: number): Promise<Gpu | null> {
  const chip = await run("sysctl", ["-n", "machdep.cpu.brand_string"]);
  if (!chip || !/apple/i.test(chip)) return null;
  const json = await run("system_profiler", ["SPDisplaysDataType", "-json"], 8000);
  let cores: number | undefined;
  try {
    const gpu = JSON.parse(json ?? "{}").SPDisplaysDataType?.[0];
    cores = Number(gpu?.sppci_cores) || undefined;
  } catch {}
  return { name: chip, vendor: "apple", memoryGb: ramGb, unified: true, cores };
}

async function linuxGpus(): Promise<Gpu[]> {
  const rocm = await run("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"]);
  if (rocm) {
    try {
      return Object.values(JSON.parse(rocm) as Record<string, Record<string, string>>).map((card) => ({
        name: card["Card series"] || card["Card SKU"] || "AMD GPU",
        vendor: "amd" as const,
        memoryGb: Number(card["VRAM Total Memory (B)"]) ? round1(Number(card["VRAM Total Memory (B)"]) / GB) : null,
        unified: false,
      }));
    } catch {}
  }
  const lspci = await run("lspci", []);
  return (lspci ?? "")
    .split("\n")
    .filter((l) => /vga|3d controller/i.test(l))
    .map((l) => l.replace(/^.*?:\s*/, "").replace(/^.*?controller:\s*/i, ""))
    .map((name) => ({ name, vendor: vendorOf(name), memoryGb: null, unified: false }));
}

/**
 * How much memory a model can sit in. A discrete GPU: its own memory. A Mac: macOS lets the GPU wire about
 * two thirds of unified memory up to 36 GB and three quarters above (16 GB: ~10.7 GB).
 */
export function modelMemory(gpu: Gpu | undefined, ramGb: number) {
  if (!gpu) return 0;
  if (gpu.unified) return round1(ramGb * (ramGb > 36 ? 0.75 : 0.67) - 0.5);
  return gpu.memoryGb ?? 0;
}

function osName(family: Machine["os"]["family"]) {
  if (family === "windows") {
    const build = Number(os.release().split(".")[2]);
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (family === "macos") {
    const darwin = Number(os.release().split(".")[0]);
    // Darwin 20 is macOS 11; Darwin 25 is macOS 26 (Apple jumped to year numbers).
    return darwin >= 25 ? `macOS ${darwin + 1}` : darwin >= 20 ? `macOS ${darwin - 9}` : "macOS";
  }
  return family === "linux" ? "Linux" : os.type();
}

async function freeDisk(dir: string) {
  try {
    const s = await fs.statfs(dir);
    return round1((s.bavail * s.bsize) / GB);
  } catch {
    return null;
  }
}

/**
 * Radeons AMD's Windows build of PyTorch runs (ROCm 10, the way ComfyUI recommends for AMD on Windows): RDNA 2 and newer
 * (RX 6000, 7000 and 9000, Radeon PRO W6000/W7000, Radeon AI PRO, Ryzen AI Max), on Windows 11.
 */
export const amdWindowsRocm = (gpuName: string, osName: string) => osName === "Windows 11" && /rx\s*[679]\d{3}|radeon pro w[679]\d{3}|radeon ai pro|8060s|8050s/i.test(gpuName);

const best = (gpus: Gpu[]) => [...gpus].sort((a, b) => (b.memoryGb ?? 0) - (a.memoryGb ?? 0) || Number(b.vendor === "nvidia") - Number(a.vendor === "nvidia"))[0];

/** This computer, the one Crackio runs on. `diskAt` is where models would go (a local ComfyUI's models folder). */
export async function thisComputer(diskAt?: string): Promise<Machine> {
  const family = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "other";
  const ramGb = round1(os.totalmem() / GB);
  let gpus: Gpu[] = [];
  if (family === "macos") {
    const mac = await macGpu(ramGb);
    gpus = mac ? [mac] : [];
  } else {
    gpus = await nvidia();
    const others = family === "windows" ? await windowsGpus() : family === "linux" ? await linuxGpus() : [];
    // nvidia-smi knows NVIDIA cards best; keep the other vendors' cards from the OS list.
    gpus = [...gpus, ...others.filter((g) => g.vendor !== "nvidia" || !gpus.length)];
  }
  const gpu = best(gpus);
  const name = osName(family);
  // What Crackio's ComfyUI would compute on here (see comfy-install): an AMD card on Windows needs AMD's ROCm build,
  // which covers RDNA 2 and newer on Windows 11; older ones get the CPU.
  const accel: Backend =
    gpu?.vendor === "apple"
      ? "mps"
      : gpu?.vendor === "nvidia"
        ? "cuda"
        : gpu?.vendor === "amd"
          ? family === "linux" || (family === "windows" && amdWindowsRocm(gpu.name, name))
            ? "rocm"
            : "cpu"
          : gpu?.vendor === "intel" && (gpu.memoryGb ?? 0) >= 6
            ? "xpu"
            : "cpu";
  const cpus = os.cpus();
  return {
    where: "this-computer",
    label: family === "macos" ? `Mac with ${gpu?.name ?? "Intel"}` : family === "windows" ? "Windows PC" : family === "linux" ? "Linux computer" : "This computer",
    os: { family, name, arch: process.arch },
    cpu: cpus.length ? { model: cpus[0].model.replace(/\s+/g, " ").trim(), threads: cpus.length } : null,
    ramGb,
    gpus,
    diskFreeGb: await freeDisk(diskAt ?? DATA_DIR),
    accel: accel === "cuda" && (gpu?.memoryGb ?? 0) < 3 ? "cpu" : accel,
    modelMemoryGb: accel === "cpu" ? 0 : modelMemory(gpu, ramGb),
  };
}

export type SystemStats = {
  system?: { os?: string; ram_total?: number; comfyui_version?: string; pytorch_version?: string };
  devices?: { name?: string; type?: string; vram_total?: number; vram_free?: number; torch_vram_total?: number }[];
};

export type BridgeInfo = {
  version?: string;
  cpu?: { model?: string; threads?: number };
  disk_free?: number;
  gpus?: { name?: string; memory?: number; compute?: number; cores?: number | null }[];
};

/** A ComfyUI's machine, from what it reports about itself. */
export function comfyMachine(url: string, stats: SystemStats, bridge?: BridgeInfo | null): Machine {
  const sys = stats.system ?? {};
  const dev = stats.devices?.[0];
  const type = (dev?.type ?? "cpu").toLowerCase();
  const ramGb = round1((sys.ram_total ?? 0) / GB);
  const fam = /darwin|mac/i.test(sys.os ?? "") ? "macos" : /nt|win/i.test(sys.os ?? "") ? "windows" : /linux|posix/i.test(sys.os ?? "") ? "linux" : "other";
  const raw = (dev?.name ?? "").replace(/^(cuda|xpu|mps|privateuseone):\d*\s*/i, "").replace(/\s*:\s*\w+$/, "").trim();
  const accel: Backend = type === "cuda" ? (/rocm|hip|amd|radeon/i.test(`${raw} ${sys.pytorch_version}`) ? "rocm" : "cuda") : type === "mps" ? "mps" : type === "xpu" ? "xpu" : type === "privateuseone" ? "directml" : "cpu";
  const unified = accel === "mps";
  const fromBridge = bridge?.gpus?.[0];
  const gpu: Gpu | undefined =
    accel === "cpu"
      ? undefined
      : {
          name: fromBridge?.name || (unified ? "Apple Silicon" : raw || "GPU"),
          vendor: unified ? "apple" : vendorOf(fromBridge?.name || raw),
          memoryGb: unified ? ramGb : dev?.vram_total ? round1(dev.vram_total / GB) : null,
          unified,
          compute: fromBridge?.compute,
          ...(unified && fromBridge?.cores ? { cores: fromBridge.cores } : {}),
        };
  return {
    where: "comfyui",
    label: fam === "macos" ? "Mac running ComfyUI" : fam === "windows" ? "Windows PC running ComfyUI" : "Linux machine running ComfyUI",
    os: { family: fam, name: fam === "macos" ? "macOS" : fam === "windows" ? "Windows" : fam === "linux" ? "Linux" : sys.os ?? "Unknown", arch: "" },
    cpu: bridge?.cpu?.model ? { model: bridge.cpu.model, threads: bridge.cpu.threads ?? 0 } : null,
    ramGb,
    gpus: gpu ? [gpu] : [],
    diskFreeGb: typeof bridge?.disk_free === "number" ? round1(bridge.disk_free / GB) : null,
    accel,
    modelMemoryGb: modelMemory(gpu, ramGb),
    comfy: { url, version: sys.comfyui_version, torch: sys.pytorch_version, bridge: bridge?.version },
  };
}
