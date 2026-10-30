"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { GenerateRequest, Generation } from "@/lib/generations/types";
import { withModelLoras } from "./use-model-loras";
import { refreshDemoSession } from "@/lib/demo/use-demo-session";

type SubmitInput = Omit<GenerateRequest, "references"> & {
  references?: GenerateRequest["references"];
  compiledPrompt?: string;
};

type GenerationsState = {
  items: Generation[];
  loaded: boolean;
  load: () => Promise<void>;
  submit: (input: SubmitInput) => Promise<Generation>;
  remove: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

export const isLive = (g: Generation) => g.status === "queued" || g.status === "running";
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Settings a page adds to everything made while it's open: Storyboard files what you make in a project into its folder
 * (params.project). Empty everywhere else.
 */
export const useSubmitTags = create<{ params: Record<string, unknown> }>(() => ({ params: {} }));

export const useGenerationsStore = create<GenerationsState>((set, get) => {
  const poll = async () => {
    pollTimer = null;
    const live = get().items.filter(isLive);
    if (!live.length) return;
    try {
      const res = await fetch(`/api/generations?ids=${live.map((g) => g.id).join(",")}`, { cache: "no-store" });
      const { items } = (await res.json()) as { items: Generation[] };
      const byId = new Map(items.map((i) => [i.id, i]));
      // Only takes that moved on get new objects, so a card whose take didn't change doesn't redraw.
      let changed = false;
      const next = get().items.map((g) => {
        const fresh = byId.get(g.id);
        if (!fresh || JSON.stringify(fresh) === JSON.stringify(g)) return g;
        changed = true;
        return fresh;
      });
      if (changed) set({ items: next });
    } catch {
      /* transient; try again next tick */
    }
    schedule();
  };
  const schedule = () => {
    if (pollTimer || !get().items.some(isLive)) return;
    pollTimer = setTimeout(poll, 1200);
  };

  return {
    items: [],
    loaded: false,
    load: async () => {
      try {
        const res = await fetch("/api/generations?limit=60", { cache: "no-store" });
        const { items } = (await res.json()) as { items: Generation[] };
        set({ items, loaded: true });
        schedule();
      } catch {
        set({ loaded: true });
      }
    },
    submit: async (input) => {
      const tags = useSubmitTags.getState().params;
      // The LoRAs switched on for a local model (its library page) go with every job it runs.
      const params = withModelLoras(input.model, Object.keys(tags).length ? { ...tags, ...input.params } : input.params);
      const res = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: [], ...input, ...(params ? { params } : {}) }),
      });
      const data = (await res.json()) as { item?: Generation; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error ?? "Couldn't start the generation.");
      set({ items: [data.item, ...get().items] });
      schedule();
      // The live demo took its credits as it queued: the strip shows what's left at once (a no-op elsewhere).
      void refreshDemoSession();
      return data.item;
    },
    remove: async (id) => {
      set({ items: get().items.filter((g) => g.id !== id) });
      await fetch(`/api/generations/${id}`, { method: "DELETE" });
    },
    cancel: async (id) => {
      await fetch(`/api/generations/${id}/cancel`, { method: "POST" });
    },
  };
});

let loadedOnce = false;
const everything = (s: GenerationsState) => s;

/**
 * The shared generations, loaded once. Pass `select` to follow only what a component shows (an
 * action, a count, a flag): it then redraws only when that changes, not on every progress tick.
 * `select` must return something stable (a value, a function, an item), never a new array.
 */
export function useGenerations(): GenerationsState;
export function useGenerations<T>(select: (s: GenerationsState) => T): T;
export function useGenerations<T>(select?: (s: GenerationsState) => T) {
  const state = useGenerationsStore(select ?? (everything as (s: GenerationsState) => T));
  useEffect(() => {
    if (loadedOnce) return;
    loadedOnce = true;
    void useGenerationsStore.getState().load();
  }, []);
  return state;
}
