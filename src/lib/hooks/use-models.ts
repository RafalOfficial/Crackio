"use client";

import { useEffect, useLayoutEffect } from "react";
import { create } from "zustand";
import type { ModelAvailability, ModelKind } from "@/lib/models/catalog";
import { pickAuto } from "@/lib/models/auto";

type ModelsState = {
  loaded: boolean;
  error: string | null;
  models: ModelAvailability[];
  defaults: Partial<Record<ModelKind, string>>;
  refresh: () => Promise<void>;
  setDefault: (kind: ModelKind, id: string) => Promise<void>;
};

let fetchedAt = 0;

/**
 * The list as it was the last time, kept in this browser: shown at once on the next visit while /api/models answers
 * (about 2 s), so pickers and the Home bar's shape-and-size chip don't wait for it.
 */
const KEPT = "crackio:models";

function readKept(): { models: ModelAvailability[]; defaults: ModelsState["defaults"] } | null {
  try {
    const raw = localStorage.getItem(KEPT);
    return raw ? (JSON.parse(raw) as { models: ModelAvailability[]; defaults: ModelsState["defaults"] }) : null;
  } catch {
    return null;
  }
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  loaded: false,
  error: null,
  models: [],
  defaults: {},
  refresh: async () => {
    try {
      const res = await fetch("/api/models", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models: ModelAvailability[]; defaults: ModelsState["defaults"] };
      fetchedAt = Date.now();
      try {
        const json = JSON.stringify({ models: data.models, defaults: data.defaults ?? {} });
        if (localStorage.getItem(KEPT) !== json) localStorage.setItem(KEPT, json);
      } catch {
        /* private mode or full storage: the next visit waits for the list */
      }
      const was = get();
      // Most looks find the same list: kept as it is, so nothing that reads it draws again.
      if (was.loaded && !was.error && JSON.stringify(was.models) === JSON.stringify(data.models) && JSON.stringify(was.defaults) === JSON.stringify(data.defaults ?? {})) return;
      set({ models: data.models, defaults: data.defaults ?? {}, loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: (err as Error).message });
      // No list at all (a busy server took more than 15 s): asked again soon, not only when a picker opens, or every
      // picker says "Choose a model" over the models that are there.
      if (!get().models.length && retries < 6) setTimeout(() => void look(), 3_000 * ++retries);
    }
  },
  setDefault: async (kind, id) => {
    set({ defaults: { ...get().defaults, [kind]: id === "auto" ? undefined : id } });
    await fetch("/api/models", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, model: id }),
    });
  },
}));

let started = false;
let looking: Promise<void> | null = null;
let retries = 0;

const look = () =>
  (looking ??= useModelsStore
    .getState()
    .refresh()
    .finally(() => {
      looking = null;
    }));

/**
 * Looks again when the list is older than `fresh` ms (a picker opening, the tab coming back), so a model installed while
 * Crackio was open (from ComfyUI, another tab or another session) joins the pickers without a reload.
 */
export function revalidateModels(fresh = 5_000) {
  if (Date.now() - fetchedAt >= fresh) void look();
}

// Before the first paint after hydration, so the kept list shows without a frame of "Loading…".
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useModels() {
  const state = useModelsStore();
  useBeforePaint(() => {
    if (started) return;
    started = true;
    const kept = readKept();
    if (kept && !useModelsStore.getState().loaded) useModelsStore.setState({ models: kept.models, defaults: kept.defaults ?? {}, loaded: true });
    void look();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") revalidateModels(30_000);
    });
  }, []);
  return state;
}

/**
 * The id "Auto" will run: a saved Custom-tab default as is (the server checks it can run), else
 * the built-in model `resolveAuto` picks.
 */
export function resolveAutoId(kind: ModelKind, models: ModelAvailability[], defaults: Partial<Record<ModelKind, string>>, prefer: string[] = []): string | null {
  const saved = defaults[kind];
  if (saved && /^(fal|comfy):/.test(saved) && !models.some((m) => m.id === saved)) return saved;
  return resolveAuto(kind, models, defaults, prefer)?.id ?? null;
}

/** What "Auto" resolves to right now: the saved default, then Crackio's preference order. */
/** `prefer`: a tool's own favorites (Angles wants the models that follow a camera guide best), after your saved default. */
export function resolveAuto(
  kind: ModelKind,
  models: ModelAvailability[],
  defaults: Partial<Record<ModelKind, string>>,
  prefer: string[] = [],
  fits?: (m: ModelAvailability) => boolean,
) {
  return pickAuto(kind, models, defaults, prefer, fits);
}
