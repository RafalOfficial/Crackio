"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { LOCAL_MODELS } from "@/lib/local/catalog";
import type { LocalModel, LocalStatus } from "@/lib/local/types";

/**
 * Your machines and the open models they can run (api/local and api/local/catalog), shared by the Local page and the model
 * library: an install started in one shows in the other. Kept fresh while anything on screen shows it: every 2 s while
 * files download anywhere, else every 15 s.
 */
type LocalState = {
  status: LocalStatus | null;
  catalog: LocalModel[] | null;
  error: string | null;
  reload: () => Promise<void>;
};

let catalogAsked = false;

export const useLocalStore = create<LocalState>((set) => ({
  status: null,
  catalog: null,
  error: null,
  reload: async () => {
    try {
      const res = await fetch("/api/local", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ status: (await res.json()) as LocalStatus, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));

/** Every model Local offers (Crackio's tuned ones and every open model in ComfyUI's templates); the tuned ones if that fails. */
function loadCatalog() {
  if (catalogAsked) return;
  catalogAsked = true;
  fetch("/api/local/catalog", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ models: LocalModel[] }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => useLocalStore.setState({ catalog: body.models }))
    .catch(() => {
      catalogAsked = false;
      useLocalStore.setState({ catalog: LOCAL_MODELS });
    });
}

const downloading = (s: LocalStatus | null) =>
  Boolean(s?.targets.some((t) => t.downloads.some((d) => d.state === "queued" || d.state === "downloading" || d.state === "checking")));

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!watchers) return;
  timer = setTimeout(
    () => {
      void useLocalStore.getState().reload().finally(schedule);
    },
    downloading(useLocalStore.getState().status) ? 2000 : 15000,
  );
}

/** Your machines and models, loaded and kept fresh while `watch` (a closed picker doesn't poll). */
export function useLocal(watch = true) {
  useLocalWatch(watch);
  return useLocalStore();
}

/**
 * Keeps your machines and models fresh while `watch`, without re-rendering the caller when they change. `firstAfter`
 * holds the first look back that long (the model library slides in first: new numbers mid-slide would redraw it).
 */
export function useLocalWatch(watch: boolean, firstAfter = 0) {
  useEffect(() => {
    if (!watch) return;
    watchers++;
    loadCatalog();
    const look = () => void useLocalStore.getState().reload().finally(schedule);
    const later = firstAfter && useLocalStore.getState().status ? setTimeout(look, firstAfter) : null;
    if (!later) look();
    return () => {
      if (later) clearTimeout(later);
      watchers--;
      if (!watchers && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [watch, firstAfter]);
}

let prefetched = false;

/** Load your machines and the catalog ahead of showing them (the pointer is on a model picker): once a page. */
export function prefetchLocal() {
  loadCatalog();
  if (prefetched || useLocalStore.getState().status) return;
  prefetched = true;
  void useLocalStore.getState().reload();
}

/** Look again now (after an install, a removal or a new machine), and keep the polling pace in step. */
export function reloadLocal() {
  return useLocalStore.getState().reload().finally(schedule);
}
