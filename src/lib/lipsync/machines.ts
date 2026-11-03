/** A machine as Lip Sync sees it (server/lipsync/machines). */
export type LipsyncMachine = {
  id: string;
  label: string;
  online: boolean;
  gpu: string | null;
  gpuGb: number | null;
  unified: boolean;
  platform: "windows" | "linux" | "macos" | null;
  bridge: string | null;
  /** Its bridge has Lip Sync (1.9+). */
  ready: boolean;
  /** The engine, installed and checked: where it runs, and whether its check loaded LatentSync itself. */
  engine: { device: string | null; dtype: string | null; full: boolean; checked: number | null } | null;
  /** What installing it is doing (packages, code, landmarks, checking). */
  installing: string | null;
  installError: string | null;
  models: Record<"unet" | "whisper" | "vae" | "syncnet" | "face" | "hand", boolean>;
  /** LatentSync's three needed files are there. */
  hasModels: boolean;
  /** Best quality can run there: its bridge has Crackio Mouth Refine and HuMo 17B's files are in (bridge 1.10.1+). */
  best: boolean;
  /** It has Crackio's MXFP8 build of HuMo, which draws 1.7x faster on an RTX 5090 (bridge 1.10.3+ says). */
  bestFast?: boolean;
  diskGb: number | null;
  /** Speech to text is there (to hear what a clip says). */
  hearing: boolean;
  runOn: boolean;
  setup: LipsyncSetupJob | null;
};

/** Setting Lip Sync up on a machine: its engine, LatentSync's files, the check. */
export type LipsyncSetupJob = {
  machine: string;
  label: string;
  state: "running" | "done" | "error";
  step: "engine" | "files" | "check";
  detail: string;
  progress: { received: number; total: number } | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/** LatentSync 1.6's files (ByteDance/LatentSync-1.6 needs its terms accepted on Hugging Face, with your token). */
export const LIPSYNC_FILES = [
  { key: "unet", name: "latentsync_unet.pt", url: "https://huggingface.co/ByteDance/LatentSync-1.6/resolve/main/latentsync_unet.pt", bytes: 5_072_222_488, gated: true },
  { key: "whisper", name: "whisper-tiny.pt", url: "https://huggingface.co/ByteDance/LatentSync-1.6/resolve/main/whisper/tiny.pt", bytes: 75_572_083, gated: true },
  { key: "vae", name: "sd-vae-ft-mse.safetensors", url: "https://huggingface.co/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.safetensors", bytes: 334_643_276, gated: false },
  // Only for scoring how well mouths go with the words; Lip Sync runs without it.
  { key: "syncnet", name: "stable_syncnet.pt", url: "https://huggingface.co/ByteDance/LatentSync-1.6/resolve/main/stable_syncnet.pt", bytes: 1_605_328_746, gated: true },
] as const;

/** LatentSync at 512 with its sync check peaked at 10.8 GB on an RTX 5090 (half precision). */
export const LIPSYNC_VRAM_GB = 11;

/** Best quality: HuMo 17B (FP8) over an 832x832 face window of 97 frames peaked at 27 GB on an RTX 5090. */
export const LIPSYNC_BEST_VRAM_GB = 28;
