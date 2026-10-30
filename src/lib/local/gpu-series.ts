/**
 * Which family a GPU belongs to, from its name (and its compute capability when the name says nothing): an RTX 4070 Ti is
 * the RTX 40 series, Ada; a GTX 1080 Ti the GTX 10 series, Pascal. The series is how Crackio's benchmarks reach a card
 * nobody measured: an RTX 4060 is estimated from the RTX 40 cards that ran, before the 30 or 50 series. Client-safe.
 */

export type Arch =
  | "blackwell"
  | "hopper"
  | "ada"
  | "ampere"
  | "turing"
  | "volta"
  | "pascal"
  | "maxwell"
  | "rdna4"
  | "rdna3"
  | "rdna2"
  | "apple"
  | "arc"
  | "unknown";

export type GpuClass = {
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
  /** "RTX 40", "GTX 10", "GTX 16", "RX 7000", "Apple M2", "Arc B", "Data center", "Workstation". */
  series: string;
  arch: Arch;
  /** Tensor cores (NVIDIA RTX 20 and newer, Volta): what fast fp16/bf16/int8 diffusion runs on. */
  tensorCores: boolean;
};

/** NVIDIA GeForce: the first two digits of the four (RTX 4070 → 40; GTX 1080 → 10; GTX 980 → 9). */
const GEFORCE: Record<string, { arch: Arch; tensor: boolean }> = {
  "50": { arch: "blackwell", tensor: true },
  "40": { arch: "ada", tensor: true },
  "30": { arch: "ampere", tensor: true },
  "20": { arch: "turing", tensor: true },
  // GTX 16: Turing without tensor cores.
  "16": { arch: "turing", tensor: false },
  "10": { arch: "pascal", tensor: false },
  "9": { arch: "maxwell", tensor: false },
};

/** Workstation and data-center cards, by name. */
const NAMED: [RegExp, string, Arch, boolean][] = [
  [/b200|b100|gb200|rtx pro \d{4}/i, "Workstation", "blackwell", true],
  [/h100|h200|h800|gh200/i, "Data center", "hopper", true],
  [/rtx \d{4} ada|l40s?\b|l4\b|l20\b/i, "Workstation", "ada", true],
  [/rtx a\d{4}|\ba100\b|\ba40\b|\ba30\b|\ba10g?\b|\ba16\b|\ba2\b/i, "Workstation", "ampere", true],
  [/quadro rtx|titan rtx|\bt4\b|\bt400\b|\bt600\b|\bt1000\b/i, "Workstation", "turing", true],
  [/v100|titan v\b/i, "Data center", "volta", true],
  [/p100|p40\b|p4\b|quadro p\d+|titan x[p]?\b/i, "Workstation", "pascal", false],
];

/** From the compute capability alone (a bridge reports it): 12.x Blackwell, 8.9 Ada, 8.6 Ampere… */
function archOfCompute(c: number): { arch: Arch; tensor: boolean } {
  if (c >= 10) return { arch: "blackwell", tensor: true };
  if (c >= 9) return { arch: "hopper", tensor: true };
  if (c >= 8.9) return { arch: "ada", tensor: true };
  if (c >= 8) return { arch: "ampere", tensor: true };
  if (c >= 7.5) return { arch: "turing", tensor: true };
  if (c >= 7) return { arch: "volta", tensor: true };
  if (c >= 6) return { arch: "pascal", tensor: false };
  if (c >= 5) return { arch: "maxwell", tensor: false };
  return { arch: "unknown", tensor: false };
}

export function gpuClass(name: string, compute?: number | null): GpuClass {
  const n = name.replace(/^(NVIDIA|AMD|Intel)\s+/i, "").replace(/^(GeForce|Radeon)\s+/i, "");
  if (/apple|\bm[1-9]\b/i.test(name)) {
    const m = /\bM(\d)/i.exec(name);
    return { vendor: "apple", series: m ? `Apple M${m[1]}` : "Apple Silicon", arch: "apple", tensorCores: false };
  }
  if (/\barc\b/i.test(name)) {
    const b = /\barc(?:\(tm\))?\s*(?:pro\s*)?([ab])\d/i.exec(name);
    return { vendor: "intel", series: b ? `Arc ${b[1].toUpperCase()}` : "Arc", arch: "arc", tensorCores: true };
  }
  const rx = /\brx\s*(\d)(\d)\d\d/i.exec(n);
  if (rx || /radeon|amd/i.test(name)) {
    const gen = rx ? Number(rx[1]) : 0;
    const arch: Arch = gen === 9 ? "rdna4" : gen === 7 ? "rdna3" : gen === 6 ? "rdna2" : "unknown";
    return { vendor: "amd", series: rx ? `RX ${gen}000` : "Radeon", arch, tensorCores: gen >= 7 };
  }
  for (const [re, series, arch, tensor] of NAMED) if (re.test(n)) return { vendor: "nvidia", series, arch, tensorCores: tensor };
  // GeForce: RTX/GTX and the model number.
  const gf = /\b(RTX|GTX)\s*(\d{3,4})\b/i.exec(n);
  if (gf) {
    const digits = gf[2];
    const key = digits.length === 4 ? digits.slice(0, 2) : digits.slice(0, 1);
    const known = GEFORCE[key];
    const fromCompute = compute ? archOfCompute(compute) : null;
    return {
      vendor: "nvidia",
      series: `${gf[1].toUpperCase()} ${key}`,
      arch: known?.arch ?? fromCompute?.arch ?? "unknown",
      tensorCores: known?.tensor ?? fromCompute?.tensor ?? false,
    };
  }
  if (compute) {
    const a = archOfCompute(compute);
    return { vendor: "nvidia", series: /nvidia|geforce|quadro|tesla/i.test(name) ? "NVIDIA" : "GPU", arch: a.arch, tensorCores: a.tensor };
  }
  return { vendor: /nvidia|geforce|quadro|tesla/i.test(name) ? "nvidia" : "other", series: "GPU", arch: "unknown", tensorCores: false };
}

/** The key two GPUs share when they're the same card: "rtx 4070 ti", "gtx 1080 ti", "apple m2 pro". */
export const gpuKeyOf = (name: string) =>
  name
    .replace(/^(NVIDIA|AMD|Intel)\s+/i, "")
    .replace(/^(GeForce|Radeon)\s+/i, "")
    .replace(/\s+\d+\s*GB$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
