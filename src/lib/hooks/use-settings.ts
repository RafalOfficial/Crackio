"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * Settings' preferences and saved keys (GET /api/settings: keys come back as "saved" and their last 4 characters only),
 * one store for every settings section, so a change made in one shows in the others at once.
 */
export type KeyName = "comfy" | "hf" | "vast" | "runpod";
export type PublicSettings = {
  keys: Record<KeyName, { saved: boolean; last4: string | null }>;
  localVision: "4b" | "8b";
  swapChecker: "auto" | "local" | "cloud";
  swapStrictness: "strict" | "normal" | "lenient";
  retouchEyes: "auto" | "local" | "cloud";
  promptEnhancer: "auto" | "off";
  pooling: "auto" | "always" | "off";
  runOn: string;
  cloudAutoConnect: boolean;
};

type State = {
  settings: PublicSettings | null;
  error: string | null;
  load: () => Promise<void>;
  /** PATCH /api/settings; the answer is the new state. The error to show, or null. */
  patch: (body: Record<string, unknown>) => Promise<string | null>;
};

export const useSettingsStore = create<State>((set) => ({
  settings: null,
  error: null,
  load: async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ settings: (await res.json()) as PublicSettings, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  patch: async (body) => {
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) return "Crackio didn't answer.";
    const data = (await res.json().catch(() => ({}))) as PublicSettings & { error?: string };
    if (!res.ok) return data.error ?? "That didn't save.";
    set({ settings: data, error: null });
    return null;
  },
}));

let asked = false;
/** The settings, loaded once per page (and again after `reloadSettings`). */
export function useSettings() {
  useEffect(() => {
    if (asked) return;
    asked = true;
    void useSettingsStore.getState().load();
  }, []);
  return useSettingsStore();
}

export const reloadSettings = () => useSettingsStore.getState().load();
