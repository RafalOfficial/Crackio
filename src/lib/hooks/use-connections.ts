"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { ConnectionStatus } from "@/lib/providers/types";
import { byAutoOrder } from "@/lib/providers/order";

type ConnectionsState = {
  loaded: boolean;
  /** Why the last check failed, if it did. */
  error: string | null;
  providers: ConnectionStatus[];
  refresh: () => Promise<void>;
};

const useConnectionsStore = create<ConnectionsState>((set) => ({
  loaded: false,
  error: null,
  providers: [],
  refresh: async () => {
    try {
      const res = await fetch("/api/connections", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const data = (await res.json()) as { providers: ConnectionStatus[] };
      set({ providers: data.providers, loaded: true, error: null });
    } catch (err) {
      const e = err as Error;
      set({ loaded: true, error: e.name === "TimeoutError" ? "The server took too long to answer." : e.message });
    }
  },
}));

export const refreshConnections = () => useConnectionsStore.getState().refresh();

let started = false;

export function useConnections() {
  const state = useConnectionsStore();
  useEffect(() => {
    if (started) return;
    started = true;
    void useConnectionsStore.getState().refresh();
  }, []);
  const connected = state.providers.filter((p) => p.state === "connected").length;
  /** Connected and drivable by Crackio right now, in the order Auto would pick them. */
  const usable = byAutoOrder(state.providers.filter((p) => p.state === "connected" && p.ready));
  const primary = usable[0] ?? state.providers.find((p) => p.state === "connected") ?? null;
  return { ...state, connected, usable, primary };
}
