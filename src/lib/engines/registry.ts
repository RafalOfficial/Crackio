import "server-only";
import type { ProviderId } from "@/lib/providers/types";
import { comfyEngine } from "./comfy";
import { comfyLocalEngine } from "./comfy-local";
import type { Engine } from "./types";

/** Engines Crackio can drive, keyed by the connection they use: Comfy Router on your Comfy key, and your own ComfyUIs. */
const ENGINES: Partial<Record<ProviderId, Engine>> = {
  "comfy-cloud": comfyEngine,
  "comfy-local": comfyLocalEngine,
};

export const implementedEngines = () => Object.keys(ENGINES) as ProviderId[];

export const engineFor = (provider: ProviderId) => ENGINES[provider] ?? null;
