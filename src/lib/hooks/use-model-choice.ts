"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useModelsStore } from "./use-models";
import { capsFit, type ModelTask } from "@/lib/models/caps";
import type { ModelKind } from "@/lib/models/catalog";

/**
 * The model a tool runs, as you chose it: Crackio doesn't pick one for you. A tool starts on the model you last chose for
 * the same job in this browser (or for any job of its kind, when that model can do this one), else your default from
 * Settings, as long as it can still run. With none of those (a first visit, a new studio), it starts on the first model of
 * its kind that's ready and can do the job (FIRST: a plain pre-fill you see and can change, no Auto and no guessing, as the
 * Director's place model does since 2c80284). With nothing ready either, nothing is chosen ("auto") until you pick one, and
 * Generate opens the model library instead of running (askForModel).
 */
const CHANGED = "crackio:model-choice";
/** A first visit's model, per kind: the first of these that's ready and can do the job. */
const FIRST: Partial<Record<ModelKind, readonly string[]>> = {
  image: ["local:flux3-klein", "local:z-image-turbo", "local:tpl:qwen-image-2.1", "local:flux2-klein-4b"],
  video: ["local:ltx-2.5", "local:wan2.2-5b"],
  upscale: ["local:realesrgan-x4", "local:nomos2-hq"],
  reframe: ["comfy:bria/image-edit-expand"],
};
const keyOf = (kind: ModelKind, task?: ModelTask) => `crackio:model-choice:${kind}${task ? `:${task}` : ""}`;

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, id: string) {
  try {
    localStorage.setItem(key, id);
  } catch {
    /* private mode: the choice lasts this visit only */
  }
}

function subscribe(changed: () => void) {
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", changed);
  };
}

/**
 * `[model, choose]`, like useState: "auto" while nothing is chosen. Switching `kind` or `task` brings back that job's choice.
 * `first` replaces the kind's pre-fill order (the Director's own models), or turns it off.
 */
export function useModelChoice(kind: ModelKind, task?: ModelTask, opts: { first?: readonly string[] | false } = {}) {
  const own = keyOf(kind, task);
  const any = keyOf(kind);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const last = useSyncExternalStore(subscribe, () => read(own), () => null);
  const lastOfKind = useSyncExternalStore(subscribe, () => read(any), () => null);
  const models = useModelsStore((s) => s.models);
  const defaults = useModelsStore((s) => s.defaults);

  // Still there and able to do this job. A model from a provider's catalog (Templates' picks) is taken as it is.
  const usable = (id: string | null | undefined): id is string => {
    if (!id || id === "auto") return false;
    const m = models.find((x) => x.id === id);
    if (!m) return /^(fal|comfy):/.test(id) && models.length > 0;
    return m.kind === kind && m.available && (!task || !m.caps || capsFit(m.caps, task));
  };
  const saved = defaults[kind];
  // With no list yet (still on its way, or a busy server didn't answer in time), this job's last choice is still the
  // choice: pressed then, the Director's Shoot opened an empty picker ("No image model is ready yet") over a model that
  // was there all along. The server checks the model anyway.
  const waiting = !models.length && Boolean(last) && last !== "auto";
  const first = opts.first === false ? undefined : (opts.first ?? FIRST[kind] ?? []).find((id) => usable(id));
  const model = picked[own] ?? (waiting ? last! : usable(last) ? last : usable(lastOfKind) ? lastOfKind : usable(saved) ? saved : (first ?? "auto"));

  const choose = useCallback(
    (id: string) => {
      setPicked((p) => ({ ...p, [own]: id }));
      if (id === "auto") return;
      remember(own, id);
      remember(any, id);
      window.dispatchEvent(new Event(CHANGED));
    },
    [own, any],
  );
  return [model, choose] as const;
}

/**
 * Nothing chosen and Generate pressed: the picker for this kind of model on the page opens its library (the first one
 * that hears it). Returns whether one did.
 */
export function askForModel(kind: ModelKind): boolean {
  const ask = { kind, taken: false };
  window.dispatchEvent(new CustomEvent(ASK, { detail: ask }));
  return ask.taken;
}

export const ASK = "crackio:choose-model";
export type ModelAsk = { kind: ModelKind; taken: boolean };
