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
  /**
   * Who checks a swap's drawings (server/swap-checker): "local", Crackio's judge on your GPU; "cloud", Gemini 3.5 Flash
   * on the Comfy key; "auto", the judge where it's installed, else Gemini. Missing means auto.
   */
  swapChecker?: "auto" | "local" | "cloud";
  /**
   * How sure Crackio's judge must be before a swap keeps a drawing (server/swap-checker): "lenient" keeps acceptable
   * swaps with small flaws (the user's own standard), "strict" redraws anything doubtful. Missing means lenient.
   */
  swapStrictness?: "strict" | "normal" | "lenient";
  /**
   * Who finds the things in a picture and their parts (Retouch, Recast, a template's pick; server/detect): "local",
   * Crackio's own eyes (LFM3-VL 2B with the Retouch LoRA) on your GPU; "cloud", Gemini 3.5 Flash on the Comfy key;
   * "auto", your GPU where the eyes are installed, else Gemini. Missing means auto.
   */
  retouchEyes?: "auto" | "local" | "cloud";
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
   * Rented boxes that stop themselves once idle, by "vast:58824818" (Settings → Machines): after `minutes` with their GPU
   * load under `load` % (10 when missing) and nothing else running there; `then` "delete" deletes the box instead (for a
   * one-time box). A bare number is the minutes (from before `load`).
   */
  autoStop?: Record<string, number | { minutes: number; load?: number; then?: "stop" | "delete" }>;
  /**
   * RunPod Serverless endpoints running Crackio's ComfyUI worker (serverless/worker), with the RunPod key above: they join
   * your machines as ComfyUIs that start a GPU per job (server/serverless). Picked under Run on, never by Auto.
   */
  serverless?: { endpointId: string; label?: string }[];
  /**
   * The most Crackio may keep on each machine (Settings → Storage), in GB: its models there, plus Crackio's own data on
   * this computer. Keyed by the machine's id (the bridge's stable machine id when it has one, else the ComfyUI target id).
   * Installs past it stop and ask; nothing already made is ever deleted for it.
   */
  storageCaps?: Record<string, number>;
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

/**
 * Writes take turns: each reads the file the previous one wrote. Several write at once (a saved key, Run on, the cloud
 * watcher adding a box), and a read-modify-write that overlapped another dropped its change.
 */
const queue = globalThis as unknown as { __crackioSettingsWrites?: Promise<unknown> };

export function updateSettings(patch: (s: Settings) => Settings): Promise<Settings> {
  const run = (queue.__crackioSettingsWrites ?? Promise.resolve()).then(async () => {
    const next = patch(await getSettings());
    await writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  });
  queue.__crackioSettingsWrites = run.catch(() => undefined);
  return run;
}
