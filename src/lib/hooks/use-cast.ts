"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { CastKind, Character, SheetView } from "@/lib/cast/types";

type CastState = {
  items: Character[];
  loaded: boolean;
  /** Why the list didn't load (the page then offers to try again instead of showing an empty cast). */
  error: string | null;
  /** When the list last loaded, to refresh one that's gone stale (the Director makes members too). */
  loadedAt: number;
  load: () => Promise<void>;
  create: (input: { name: string; kind: CastKind; photos: string[]; description?: string; notes?: string; model?: string; height?: number; heightSet?: boolean; long?: boolean; views?: SheetView[]; viewsWhy?: string; viewLooks?: Partial<Record<SheetView, string>> }) => Promise<Character>;
  update: (
    id: string,
    patch: { name?: string; handle?: string; notes?: string; traits?: string; noun?: string; kind?: CastKind; height?: number | null; model?: string | null },
  ) => Promise<Character>;
  rebuild: (id: string, views?: SheetView[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
}

/** Your characters, kept fresh while any of them is still being built. */
export const useCastStore = create<CastState>((set, get) => {
  const schedule = () => {
    if (pollTimer || !get().items.some((c) => c.status === "building")) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      await get().load();
    }, 2000);
  };
  const put = (item: Character) => set({ items: get().items.some((c) => c.id === item.id) ? get().items.map((c) => (c.id === item.id ? item : c)) : [item, ...get().items] });

  return {
    items: [],
    loaded: false,
    error: null,
    loadedAt: 0,
    load: () =>
      // One load at a time: every page part that shows the cast asks for it as it mounts.
      (inflight ??= (async () => {
        try {
          const { items } = await call<{ items: Character[] }>("/api/cast");
          // An error answer (a dev server mid-restart) has no list: it's a failure, not an empty cast.
          if (!Array.isArray(items)) throw new Error("Your cast didn't load.");
          set({ items, loaded: true, error: null, loadedAt: Date.now() });
        } catch (err) {
          set({ loaded: true, error: (err as Error).message || "Your cast didn't load." });
        } finally {
          inflight = null;
        }
        schedule();
      })()),
    create: async (input) => {
      const { item } = await call<{ item: Character }>("/api/cast", { method: "POST", body: JSON.stringify(input) });
      put(item);
      schedule();
      return item;
    },
    update: async (id, patch) => {
      const { item } = await call<{ item: Character }>(`/api/cast/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      put(item);
      return item;
    },
    rebuild: async (id, views) => {
      const { item } = await call<{ item: Character }>(`/api/cast/${id}/rebuild`, { method: "POST", body: JSON.stringify(views ? { views } : {}) });
      put(item);
      schedule();
    },
    remove: async (id) => {
      set({ items: get().items.filter((c) => c.id !== id) });
      await call(`/api/cast/${id}`, { method: "DELETE" });
    },
  };
});

let loadedOnce = false;
/** A list older than this is fetched again when a page that shows it opens (members made elsewhere show up). */
const STALE = 60_000;

export function useCast() {
  const state = useCastStore();
  useEffect(() => {
    const { loadedAt, error, load } = useCastStore.getState();
    if (!loadedOnce || error || (loadedAt && Date.now() - loadedAt > STALE)) {
      loadedOnce = true;
      void load();
    }
  }, []);
  return state;
}
