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
} as const;

export type BridgeFeature = keyof typeof BRIDGE_FEATURES;

/** "1.10.0" is newer than "1.9.2". */
export function versionAtLeast(version: string | null | undefined, min: string) {
  if (!version) return false;
  return version.localeCompare(min, undefined, { numeric: true }) >= 0;
}

export const bridgeHas = (version: string | null | undefined, feature: BridgeFeature) => versionAtLeast(version, BRIDGE_FEATURES[feature]);
