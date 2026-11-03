"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { READY_VOICES } from "@/lib/voice/ready";
import type { VoiceCard, VoiceMachine } from "@/lib/voice/types";

/** Voices (Crackio's ready ones and yours) and the machines Voice runs on, shared by the Voice page and its drawers. */
type VoiceState = {
  ready: VoiceCard[];
  yours: VoiceCard[];
  machines: VoiceMachine[];
  loaded: boolean;
  machinesLoaded: boolean;
  loadVoices: () => Promise<void>;
  loadMachines: (fresh?: boolean) => Promise<void>;
  removeVoice: (id: string) => Promise<void>;
  added: (v: VoiceCard) => void;
};

export const useVoiceStore = create<VoiceState>((set, get) => ({
  // Crackio's own voices are part of the app: there from the first frame, so the page never names the wrong one.
  ready: READY_VOICES,
  yours: [],
  machines: [],
  loaded: false,
  machinesLoaded: false,
  loadVoices: async () => {
    try {
      const res = await fetch("/api/voice/voices", { cache: "no-store" });
      const data = (await res.json()) as { ready: VoiceCard[]; yours: VoiceCard[] };
      set({ ready: data.ready ?? [], yours: data.yours ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  loadMachines: async (fresh = false) => {
    try {
      const res = await fetch(`/api/voice/machines${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const data = (await res.json()) as { machines: VoiceMachine[] };
      set({ machines: data.machines ?? [], machinesLoaded: true });
    } catch {
      set({ machinesLoaded: true });
    }
  },
  removeVoice: async (id) => {
    set({ yours: get().yours.filter((v) => v.id !== id) });
    await fetch(`/api/voice/voices/${id}`, { method: "DELETE" });
  },
  added: (v) => set({ yours: [v, ...get().yours.filter((x) => x.id !== v.id)] }),
}));

export const voiceOf = (id: string | null | undefined) => {
  const s = useVoiceStore.getState();
  return [...s.yours, ...s.ready].find((v) => v.id === id) ?? null;
};

/** Loads voices and machines once, and watches the machines while something installs there. */
export function useVoiceSetup() {
  const loaded = useVoiceStore((s) => s.loaded);
  const busy = useVoiceStore((s) => s.machines.some((m) => m.downloads.length > 0 || m.installing || m.setup?.state === "running" || m.check?.state === "running" || m.check?.state === "switching" || m.brainSetup?.state === "running"));
  useEffect(() => {
    if (!loaded) void useVoiceStore.getState().loadVoices();
    void useVoiceStore.getState().loadMachines(true);
  }, [loaded]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void useVoiceStore.getState().loadMachines(true), 2500);
    return () => clearInterval(t);
  }, [busy]);
  // And now and then while the page is shown: a ComfyUI that starts or stops, a setup begun from another tab.
  useEffect(() => {
    if (busy) return;
    const t = setInterval(() => !document.hidden && void useVoiceStore.getState().loadMachines(), 20_000);
    return () => clearInterval(t);
  }, [busy]);
}
