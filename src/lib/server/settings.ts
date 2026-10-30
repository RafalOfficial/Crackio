import "server-only";
import fs from "node:fs/promises";
import type { CloudGpu } from "@/lib/local/types";
import { writeFileAtomic } from "./atomic-write";
import { SETTINGS_FILE } from "./paths";

export type Settings = {
  /** API keys entered in the app. These win over environment variables. */
  keys: {
    comfy?: string;
    /** Hugging Face, for gated open models (LTX-2.5): sent with each download, to whichever machine fetches it. */
    hf?: string;
    /** GPU clouds, to find the boxes you rented and their addresses (Local → Connect a cloud GPU). */
    vast?: string;
    runpod?: string;
  };
  /** Default model per kind (catalog ids). Missing means Auto. */
  models: Partial<Record<"image" | "video" | "upscale" | "reframe" | "text", string>>;
  /** How hard the prompt writer thinks. Higher is more careful and slower. */
  textEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * The Qwen3-VL that reads pictures on your own GPU (Swap's checks): "4b", FLUX 3 Klein's own text encoder, there
   * wherever Klein is; or "8b", sharper and about twice the memory. Missing means 4b.
   */
  localVision?: "4b" | "8b";
  /** Engine used when a tool doesn't pin one. "auto" picks the first connected engine. */
  defaultEngine: string;
  onboarding: { connected?: boolean; directed?: boolean; cast?: boolean };
  /**
   * More ComfyUIs to run Local models on (a Mac on the same network, a rented GPU), besides COMFYUI_URL's and the one
   * Crackio installed. A rented one without a web address has an empty `url` and its `cloud.tunnel`.
   */
  comfyMachines?: { url: string; token?: string; label?: string; cloud?: CloudGpu }[];
  /**
   * When a model too big for one GPU is split with another computer (local-models `poolFor`): "auto" only when the
   * computer with its files can't run it alone (a PC with plenty of RAM streams the rest of the model from RAM, often
   * quicker than a slower second GPU), "always" whenever its GPU can't hold it, "off" never. Missing means auto.
   */
  pooling?: "auto" | "always" | "off";
  /**
   * The ComfyUI local jobs run on (a comfy-targets id), whenever it's online and has the job's model; missing or "auto":
   * the idle one with the fastest GPU (local-models `pickTarget`). A job can still ask for its own (`options.machine`).
   */
  runOn?: string;
  /**
   * GPUs running on your cloud accounts (keys under Connections → GPUs) join your machines by themselves, and leave them
   * when given back (cloud-accounts `tendRentedBoxes`). Missing means on.
   */
  cloudAutoConnect?: boolean;
  /**
   * RunPod Serverless endpoints running Crackio's ComfyUI worker (serverless/worker), with the RunPod key above: they join
   * your machines as ComfyUIs that start a GPU per job (server/serverless). Picked under Run on, never by Auto.
   */
  serverless?: { endpointId: string; label?: string }[];
};

const DEFAULTS: Settings = { keys: {}, models: {}, defaultEngine: "auto", onboarding: {} };

export async function getSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Partial<Settings>;
    return { ...DEFAULTS, ...raw, keys: { ...raw.keys }, models: { ...raw.models }, onboarding: { ...raw.onboarding } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function updateSettings(patch: (s: Settings) => Settings): Promise<Settings> {
  const next = patch(await getSettings());
  await writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
