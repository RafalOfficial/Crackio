"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LoraPick = { file: string; strength: number };

/**
 * The LoRAs you put on each model (by model id): files in a ComfyUI's models/loras and how strong. A LoRA is made for one
 * model, so each keeps its own list; jobs send it as `options.loras` and the local engine puts them on the graph
 * (comfy-local-templates `withLoras`), leaving out any the machine doesn't have.
 */
export const useModelLoras = create<{ byModel: Record<string, LoraPick[]> }>()(persist(() => ({ byModel: {} }), { name: "crackio-model-loras" }));

/** A model's LoRAs, for a job's options (none: undefined, so the options stay as they were). */
export function lorasFor(model: string) {
  const list = useModelLoras.getState().byModel[model] ?? [];
  return list.length ? list : undefined;
}

/** At most this many on one model: the engine takes the first six (comfy-local `lorasOf`). */
export const MAX_LORAS = 6;

/**
 * A job's params with its local model's LoRAs in `options.loras`, unless the tool set that key itself (the Director sends
 * its own list): every tool's job with that model carries them (hooks/use-generations). Other models' jobs pass unchanged.
 */
export function withModelLoras(model: string, params: Record<string, unknown> | undefined) {
  if (!model.startsWith("local:")) return params;
  const options = (params?.options ?? {}) as Record<string, unknown>;
  if (options.loras !== undefined) return params;
  const loras = lorasFor(model);
  return loras ? { ...params, options: { ...options, loras } } : params;
}

export function setLora(model: string, file: string, strength: number | null) {
  useModelLoras.setState((s) => {
    const list = (s.byModel[model] ?? []).filter((l) => l.file !== file);
    return { byModel: { ...s.byModel, [model]: strength === null ? list : [...list, { file, strength }] } };
  });
}
