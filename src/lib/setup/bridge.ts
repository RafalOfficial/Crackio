/**
 * The Crackio bridge (comfyui/crackio_bridge) versions each feature needs, in one table. Client-safe.
 * The server reads the version this Crackio carries from the bridge's own __init__.py (server/setup/status).
 */
export const BRIDGE_FEATURES = {
  /** /crackio/files lists every model folder (GGUF included). */
  files: "1.1.0",
  /** Splitting a model across two computers (pool.py). */
  pooling: "1.3.0",
  /** FlashVSR+'s model folder. */
  flashvsr: "1.5.0",
  /** Other apps' GPU load and PCIe speed, for estimates. */
  live: "1.5.5",
  /** A Mac's heat and battery. */
  macHeat: "1.6.0",
  /** Voice's nodes. */
  voice: "1.8.0",
  /** Voice's one-click set-up (builds checked, test line). */
  voiceSetup: "1.8.5",
  /** Lip Sync. */
  lipsync: "1.9.0",
  /** LFM3-VL's set-up routes (files, transformers). */
  lfm3Setup: "1.9.2",
  /** Storage: model folders with sizes, a download folder you choose, clean-ups, a stable machine id (storage.py). */
  storage: "1.10.0",
  /** Lip Sync's best quality: Crackio Mouth Refine (HuMo 17B over LatentSync) and its files in /crackio/lipsync. */
  lipsyncBest: "1.10.1",
  /** Mouth Refine's finer drawing: a tighter window drawn bigger (scale, upscale), cfg on the first steps only. */
  lipsyncFine: "1.10.2",
  /**
   * Mouth Refine's lips-only paste (area "lips": HuMo's lips and mouth opening on LatentSync's frames), the colour pull
   * that ignores what differs (a head turning into her hair) and caps itself, and the MXFP8 HuMo in /crackio/lipsync.
   */
  lipsyncLips: "1.10.3",
  /** Sets up nomadoor's Panorama Stickers (the Director's moved-camera shots: its Panorama Studio render). */
  panorama: "1.10.4",
  /** The Director's video re-shoot: Crackio IC-LoRA Guide (the look still before the clip) and Crackio MoGe Clay (video.py). */
  videoReshoot: "1.10.5",
  /** LoRA training: Crackio Training Data, Crackio Train LoRA and the routes under /crackio/train (train.py). */
  train: "1.11.0",
  /** A training run moved to another machine: its state fetched and sent (/crackio/train/state). */
  trainMove: "1.12.0",
  /** Edit LoRAs: Crackio Training Data takes before/after pairs, and the trainer hands each before picture to the model. */
  trainEdit: "1.14.0",
  /**
   * The oldest helper a training starts on. Before 1.14.3 a model ComfyUI pages into GPU memory could take ComfyUI down
   * at the first step (once other models held part of the card). Before 1.14.4 a pause asked for while the model
   * loaded was forgotten, a learning rate cut after a loss that wasn't a number kept halving, and a run whose kept
   * state was gone from the machine started again at step 0 without saying so.
   */
  trainSafe: "1.14.4",
} as const;

export type BridgeFeature = keyof typeof BRIDGE_FEATURES;

/** "1.10.0" is newer than "1.9.2". */
export function versionAtLeast(version: string | null | undefined, min: string) {
  if (!version) return false;
  return version.localeCompare(min, undefined, { numeric: true }) >= 0;
}

export const bridgeHas = (version: string | null | undefined, feature: BridgeFeature) => versionAtLeast(version, BRIDGE_FEATURES[feature]);
