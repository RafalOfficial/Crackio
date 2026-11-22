import "server-only";
import type { ProviderId } from "@/lib/providers/types";
import { comfyEngine } from "./comfy";
import { comfyLocalEngine } from "./comfy-local";
import type { Engine } from "./types";

/**
 * Engines Crackio can drive, keyed by the connection they use: Comfy Router on your Comfy key, and your own ComfyUIs.
 *
 * Read when first asked, never while this module loads: comfy → refine → resolve → registry → comfy is a cycle, so a
 * request that enters it at comfy (api/models/quote first after a hot reload) reaches this file before `comfyEngine`
 * exists. As a table made on load that threw "Cannot access 'comfyEngine' before initialization", the dev server kept
 * the failed module, and every route answered 500 until a restart (Nov 20).
 */
const engines = (): Partial<Record<ProviderId, Engine>> => ({
  "comfy-cloud": comfyEngine,
  "comfy-local": comfyLocalEngine,
});

export const implementedEngines = () => Object.keys(engines()) as ProviderId[];

export const engineFor = (provider: ProviderId) => engines()[provider] ?? null;
