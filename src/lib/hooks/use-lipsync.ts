"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { LipsyncMachine } from "@/lib/lipsync/machines";

/** The machines Lip Sync runs on, as /api/lipsync/machines describes them (engine, LatentSync's files, a setup going on). */
type LipsyncState = {
  machines: LipsyncMachine[];
  loaded: boolean;
  load: (fresh?: boolean) => Promise<void>;
};

export const useLipsyncStore = create<LipsyncState>((set) => ({
  machines: [],
  loaded: false,
  load: async (fresh = false) => {
    try {
      const res = await fetch(`/api/lipsync/machines${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const data = (await res.json()) as { machines?: LipsyncMachine[] };
      set({ machines: Array.isArray(data.machines) ? data.machines : [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** Where a lip sync runs: set up there (engine and LatentSync's files), the one picked under Run on, else the biggest GPU. */
export function lipsyncHome(machines: LipsyncMachine[]) {
  const ready = machines.filter((m) => m.online && m.ready && m.engine && m.hasModels);
  return ready.find((m) => m.runOn) ?? [...ready].sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0] ?? null;
}

/** Loads the machines once, then looks again every few seconds while something is set up there (else now and then). */
export function useLipsyncMachines() {
  const busy = useLipsyncStore((s) => s.machines.some((m) => m.setup?.state === "running" || Boolean(m.installing)));
  useEffect(() => {
    void useLipsyncStore.getState().load(true);
  }, []);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && void useLipsyncStore.getState().load(busy), busy ? 2500 : 20_000);
    return () => clearInterval(t);
  }, [busy]);
}
