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

/** One look at a time: a second ask while one is out gets the same answer. */
let out: Promise<void> | null = null;

const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  loaded: false,
  error: null,
  providers: [],
  refresh: () =>
    (out ??= (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const data = (await res.json()) as { providers: ConnectionStatus[] };
        // The same answer keeps its objects, so nothing that shows it draws again.
        if (get().loaded && !get().error && JSON.stringify(data.providers) === JSON.stringify(get().providers)) return;
        set({ providers: data.providers, loaded: true, error: null });
      } catch (err) {
        const e = err as Error;
        set({ loaded: true, error: e.name === "TimeoutError" ? "The server took too long to answer." : e.message });
      } finally {
        out = null;
      }
    })()),
}));

/** Looks again, when anything on this page has shown the connections (otherwise the next one to show them asks). */
export const refreshConnections = () => (started ? useConnectionsStore.getState().refresh() : Promise.resolve());

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
