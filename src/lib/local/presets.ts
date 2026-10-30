import type { Machine } from "./types";

/**
 * Machines people often have or think of buying, so the Local page can show what each would run ("What would
 * run on a 16 GB MacBook Air?"). Memory budgets follow the same rules as detected machines (see hardware.ts).
 */

const mac = (label: string, chip: string, ramGb: number, cores: number, gpuCores?: number): Machine => ({
  where: "example",
  label,
  os: { family: "macos", name: "macOS", arch: "arm64" },
  cpu: { model: chip, threads: cores },
  ramGb,
  gpus: [{ name: chip, vendor: "apple", memoryGb: ramGb, unified: true, ...(gpuCores ? { cores: gpuCores } : {}) }],
  diskFreeGb: null,
  accel: "mps",
  modelMemoryGb: Math.round((ramGb * (ramGb > 36 ? 0.75 : 0.67) - 0.5) * 10) / 10,
});

const pc = (label: string, gpu: string, vramGb: number, compute: number, ramGb = 32): Machine => ({
  where: "example",
  label,
  os: { family: "windows", name: "Windows 11", arch: "x64" },
  cpu: null,
  ramGb,
  gpus: [{ name: `NVIDIA GeForce ${gpu}`, vendor: "nvidia", memoryGb: vramGb, unified: false, compute }],
  diskFreeGb: null,
  accel: "cuda",
  modelMemoryGb: vramGb,
});

/** A Windows 11 PC with a Radeon (AMD's ROCm build of PyTorch, see comfy-install). */
const radeon = (label: string, gpu: string, vramGb: number, ramGb = 32): Machine => ({
  where: "example",
  label,
  os: { family: "windows", name: "Windows 11", arch: "x64" },
  cpu: null,
  ramGb,
  gpus: [{ name: `AMD Radeon ${gpu}`, vendor: "amd", memoryGb: vramGb, unified: false }],
  diskFreeGb: null,
  accel: "rocm",
  modelMemoryGb: vramGb,
});

export const PRESETS: Machine[] = [
  mac("MacBook Air", "Apple M4", 16, 10, 10),
  mac("MacBook Air", "Apple M5", 24, 10, 10),
  mac("MacBook Pro", "Apple M4 Pro", 24, 14, 20),
  mac("MacBook Pro", "Apple M5 Pro", 48, 15, 20),
  mac("MacBook Pro", "Apple M5 Max", 64, 18, 40),
  mac("Mac Studio", "Apple M4 Max", 64, 16, 40),
  pc("Gaming PC", "RTX 2060", 6, 7.5, 32),
  pc("Gaming PC", "RTX 3060", 12, 8.6),
  pc("Gaming PC", "RTX 3070 Ti", 8, 8.6, 24),
  pc("Gaming PC", "RTX 4070", 12, 8.9),
  pc("Gaming PC", "RTX 4090", 24, 8.9, 64),
  radeon("Gaming PC", "RX 7900 XTX", 24, 32),
  pc("Workstation", "RTX 5090", 32, 12.0, 64),
];
