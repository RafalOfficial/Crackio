/**
 * The Voice tool's models: open speech models that run on your own GPU through the Crackio bridge's "Crackio Voice"
 * node and audio.cpp (comfyui/crackio_bridge/voice.py), from GGUF files in ComfyUI's models/audiocpp folder. Client-safe.
 */

export type VoiceModelId = "local:voice:drama3" | "local:voice:voxcpm2" | "local:voice:supertonic";

export type VoiceFile = { name: string; url: string; bytes: number };

/** One version of a model's file: the best one a machine's memory holds is the one installed there. */
export type VoiceVariant = {
  id: string;
  label: string;
  file: VoiceFile;
  /** GPU memory (GB) it runs in whole; less still works with part of it in system RAM (`minGb` and `ramGb`). */
  needGb: number;
  minGb: number;
  /** System RAM it needs on top, when it doesn't fit the GPU whole. */
  ramGb: number;
};

export type VoiceModel = {
  id: VoiceModelId;
  /** "Drama 3". */
  name: string;
  maker: string;
  blurb: string;
  /** 1–5, the same five pips as the model library. */
  quality: number;
  languages: string;
  /** What it can do with your script and voices. */
  can: { clone: boolean; design: boolean; direct: boolean; tags: boolean; scene: boolean };
  variants: VoiceVariant[];
  licence: { name: string; url: string; commercial: "yes" | "limited" | "no"; note: string };
  /** Shown wherever its takes are made (Drama 3's licence asks for it). */
  credit?: string;
  /** Its card in the model library: a sky in these colours, and a take it made to play (with its waveform). */
  card: {
    hues: [string, string];
    sample: string;
    peaks: number[];
    score: number;
    rank?: string;
    says: string;
    released?: string;
    /**
     * A maker's logo. None ships: every voice model shows the same plain sound mark, its maker named in text (Fish Audio's
     * licence allows its name but no logo, and Crackio carries no other makers' brands either).
     */
    logo?: string;
  };
};

const HF = "https://huggingface.co";
const ACPP = `${HF}/audio-cpp/audio.cpp-gguf/resolve/main`;

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: "local:voice:drama3",
    name: "Drama 3",
    maker: "Fish Audio",
    blurb: "Acts it out: directions, laughs, sighs and whispers, several voices in one scene. About 80 languages.",
    quality: 5,
    languages: "About 80, Polish and Italian included",
    can: { clone: true, design: false, direct: true, tags: true, scene: true },
    variants: [
      { id: "q4", label: "Q4", file: { name: "drama-3-backbone-8bit-experts-Q4_K_S.gguf", url: `${HF}/Jmica/Drama-3-GGUF/resolve/main/drama-3-backbone-8bit-experts-Q4_K_S.gguf`, bytes: 24_596_497_888 }, needGb: 27, minGb: 15, ramGb: 16 },
      { id: "q3", label: "Q3", file: { name: "drama-3-backbone-8bit-experts-Q3_K_S.gguf", url: `${HF}/Jmica/Drama-3-GGUF/resolve/main/drama-3-backbone-8bit-experts-Q3_K_S.gguf`, bytes: 20_325_196_992 }, needGb: 23, minGb: 12, ramGb: 14 },
      { id: "q2", label: "Q2", file: { name: "drama-3-backbone-8bit-experts-Q2_K.gguf", url: `${HF}/Jmica/Drama-3-GGUF/resolve/main/drama-3-backbone-8bit-experts-Q2_K.gguf`, bytes: 17_053_639_872 }, needGb: 20, minGb: 6, ramGb: 16 },
    ],
    licence: {
      name: "Fish Audio Community License",
      url: `${HF}/fishaudio/drama-3/blob/main/LICENSE`,
      commercial: "limited",
      note: "Free for personal use, and for businesses under $500k a year. Clone a voice only with that person's consent.",
    },
    credit: "Built with Fish Audio",
    card: {
      hues: ["#ffc27a", "#b4401f"],
      sample: "/assets/voice/models/drama3.mp3",
      peaks: [0.74, 0.49, 0.58, 0.73, 0.74, 0.62, 0.21, 0.26, 0.22, 0.14, 0.68, 0.75, 0.5, 0.88, 0.85, 0.61, 0.72, 0.73, 0.73, 0.72, 0.71, 0.7, 0.67, 0.48, 0.6, 0.65, 0.69, 0.85, 0.77, 0.71, 0.55, 0.02, 0.02, 0.6, 0.67, 0.6, 0.67, 0.56, 0.09, 0.01, 0.01, 0.01, 0.05, 0.31, 0.38, 0.47, 0.51, 0.43, 0.41, 0.32, 0.35, 0.52, 0.22, 0.01, 0.98, 0.84, 1, 0.92, 0.96, 0.99, 0.98, 0.96, 0.87, 0.79],
      score: 93,
      rank: "#1 open model on the Artificial Analysis speech arena",
      says: "Sounds like a person acting the line: sighs, laughs and whispers land where you put them.",
      released: "2026-10-13",
    },
  },
  {
    id: "local:voice:voxcpm2",
    name: "VoxCPM2",
    maker: "OpenBMB",
    blurb: "Makes new voices from a description, and clones. 30 languages, 48 kHz.",
    quality: 4,
    languages: "30, Polish and Italian included",
    can: { clone: true, design: true, direct: true, tags: false, scene: false },
    variants: [{ id: "q8", label: "Q8", file: { name: "voxcpm2-q8_0.gguf", url: `${ACPP}/VoxCPM2-GGUF/voxcpm2-q8_0.gguf`, bytes: 2_955_007_488 }, needGb: 8, minGb: 8, ramGb: 8 }],
    licence: { name: "Apache-2.0", url: `${HF}/openbmb/VoxCPM2`, commercial: "yes", note: "Free for any use." },
    card: {
      hues: ["#8ff0dc", "#13706a"],
      sample: "/assets/voices/mara.mp3",
      peaks: [0.77, 0.73, 0.72, 0.71, 0.68, 0.76, 0.82, 0.81, 0.77, 0.75, 0.76, 0.67, 0.11, 0.02, 0.01, 0.91, 1, 0.69, 0.77, 0.79, 0.62, 0.72, 0.44, 0.68, 0.68, 0.59, 0.79, 0.72, 0.35, 0.85, 0.77, 0.78, 0.86, 0.81, 0.64, 0.3, 0.62, 0.48, 0.22, 0.2, 0.14, 0.1, 0.73, 0.95, 0.99, 0.86, 0.69, 0.74, 0.69, 0.69, 0.83, 0.67, 0.36, 0.65, 0.65, 0.75, 0.69, 0.77, 0.89, 0.88, 0.68, 0.66, 0.49, 0.13],
      score: 80,
      says: "Clean and natural, and the one that designs voices: Crackio's twelve voices were made with it.",
    },
  },
  {
    id: "local:voice:supertonic",
    name: "Supertonic 3",
    maker: "Supertone",
    blurb: "Quick and light: runs on any computer. Ten voices of its own, 31 languages. It can't clone.",
    quality: 2,
    languages: "31, Polish and Italian included",
    can: { clone: false, design: false, direct: false, tags: false, scene: false },
    variants: [{ id: "f16", label: "F16", file: { name: "supertonic-3-f16.gguf", url: `${ACPP}/Supertonic-3-GGUF/supertonic-3-f16.gguf`, bytes: 312_785_732 }, needGb: 1, minGb: 0, ramGb: 2 }],
    licence: { name: "OpenRAIL-M", url: `${HF}/Supertone/supertonic-3`, commercial: "yes", note: "Free to use, within its responsible-use rules." },
    card: {
      hues: ["#a9c8ff", "#2b47a6"],
      sample: "/assets/voice/models/supertonic.mp3",
      peaks: [0, 0, 0, 0.78, 0.72, 0.74, 0.09, 0.09, 0.09, 0.92, 0.99, 0.3, 0.89, 0.81, 0.8, 0.73, 0.75, 0.71, 0.71, 0.66, 0.8, 0.85, 0.12, 0.09, 0.2, 0.63, 0.79, 0.91, 1, 0.71, 0.88, 0.47, 0.69, 0.64, 0.86, 0.87, 0.59, 0.05, 0.03, 0.63, 0.8, 0.85, 0.77, 0.66, 0.66, 0.4, 0.05, 0.03, 0.88, 0.88, 0.63, 0.77, 0.77, 0.87, 0.9, 0.88, 0.8, 0.68, 0.6, 0.36, 0.14, 0.08, 0.05, 0],
      score: 55,
      says: "Fast and tiny, even on a laptop with no GPU; reads plainly, in its own ten voices.",
    },
  },
];

/** Speech to text, installed with the first voice model: types a clone's words for you, times every word of a take and
 * checks that nothing was skipped. */
export const HEARING: VoiceFile[] = [
  { name: "qwen3-asr-0.6b-q8_0.gguf", url: `${ACPP}/Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf`, bytes: 1_151_279_968 },
  { name: "qwen3-forced-aligner-0.6b-q8_0.gguf", url: `${ACPP}/Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-q8_0.gguf`, bytes: 1_129_969_856 },
];

export const voiceModel = (id: string | null | undefined) => VOICE_MODELS.find((m) => m.id === id) ?? null;

/** The model a machine has, by its file. */
export const modelOfFile = (file: string) => VOICE_MODELS.find((m) => m.variants.some((v) => v.file.name === file)) ?? null;

/** Supertonic 3's own voices. */
export const SUPERTONIC_PRESETS = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;

/**
 * The version of a model a machine runs best: the biggest that fits its GPU whole, else the biggest that runs with part
 * of it in RAM. Null when none runs there. `unified`: the GPU shares the computer's memory (a Mac), so there's no other
 * RAM to put a part in: whole, or not at all.
 */
export function variantFor(model: VoiceModel, gpuGb: number | null, ramGb: number | null, unified = false) {
  const vram = gpuGb ?? 0;
  const ram = ramGb ?? 0;
  const whole = model.variants.find((v) => vram >= v.needGb);
  if (whole) return { variant: whole, offload: false };
  if (unified) return null;
  const parted = model.variants.find((v) => vram >= v.minGb && ram >= v.ramGb);
  if (parted) return { variant: parted, offload: true };
  return null;
}

export const gbOf = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`;

/** audio.cpp's builds (github.com/0xShug0/audio.cpp, release v0.9.3): what each downloads, its CUDA runtime included. */
export const AUDIOCPP_BYTES: Record<string, number> = {
  "windows-x64-cuda13.3": 852e6,
  "windows-x64-cuda12.4": 1073e6,
  "windows-x64-vulkan": 82e6,
  "windows-x64-cpu-portable": 30e6,
  "ubuntu-x64-cuda12.8-colab": 1015e6,
  "ubuntu-x64-vulkan": 99e6,
  "ubuntu-x64-cpu-portable": 63e6,
  "macos-arm64-metal": 35e6,
  "macos-x64-metal": 37e6,
};

/** A build in words: "Windows · CUDA 12.4", "macOS · Metal", "Linux · CPU". */
export function buildName(build: string | null | undefined) {
  if (!build) return "";
  const os = build.startsWith("windows") ? "Windows" : build.startsWith("macos") ? "macOS" : "Linux";
  const cuda = /cuda(\d+\.\d+)/.exec(build)?.[1];
  return `${os} · ${cuda ? `CUDA ${cuda}` : build.includes("vulkan") ? "Vulkan" : build.includes("metal") ? "Metal" : "CPU"}`;
}

type Placeable = { online: boolean; voiceReady: boolean; gpuGb: number | null; ramGb: number | null; unified: boolean; runOn: boolean; diskGb?: number | null };

/**
 * Where Voice should start for someone who has none of it yet: the best model one of their machines runs, on the
 * machine that runs it best. Drama 3 where it fits the GPU whole, else VoxCPM2 where it fits, else Supertonic 3, which
 * runs anywhere.
 */
export function firstVoiceModel<M extends Placeable>(machines: M[]) {
  const usable = machines.filter((m) => m.online && m.voiceReady).sort((a, b) => Number(b.runOn) - Number(a.runOn) || (b.gpuGb ?? 0) - (a.gpuGb ?? 0));
  for (const model of VOICE_MODELS) {
    for (const machine of usable) {
      const fit = variantFor(model, machine.gpuGb, machine.ramGb, machine.unified);
      // Drama 3 only whole: split over RAM it's slow for a first try. And only where the file fits on the disk.
      const room = machine.diskGb == null || !fit || machine.diskGb >= fit.variant.file.bytes / 1e9 + 1;
      if (fit && room && (model.id !== "local:voice:drama3" || !fit.offload)) return { machine, model, fit };
    }
  }
  return null;
}
