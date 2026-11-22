"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { LocalModel, LocalStatus } from "@/lib/local/types";

/**
 * Your machines and the open models they can run (api/local and api/local/catalog), shared by Settings and the model
 * library: an install started in one shows in the other. Kept fresh while anything on screen shows it and the tab is
 * visible: every 2 s while files download anywhere, else every 15 s. One look at a time, and a look that finds nothing
 * new leaves the status as it is, so the library's cards don't draw again.
 */
type LocalState = {
  status: LocalStatus | null;
  catalog: LocalModel[] | null;
  error: string | null;
  reload: () => Promise<void>;
};

let catalogAsked = false;
let lastJson = "";
let inflight: Promise<void> | null = null;
/** When the last look answered. */
let lookedAt = 0;

export const useLocalStore = create<LocalState>((set, get) => ({
  status: null,
  catalog: null,
  error: null,
  reload: () =>
    (inflight ??= (async () => {
      try {
        const res = await fetch("/api/local", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        lookedAt = Date.now();
        if (text === lastJson && get().status && !get().error) return;
        lastJson = text;
        set({ status: JSON.parse(text) as LocalStatus, error: null });
      } catch (err) {
        const message = (err as Error).message;
        if (get().error !== message) set({ error: message });
      } finally {
        inflight = null;
      }
    })()),
}));

/**
 * Every model Crackio offers (its tuned ones and every open model in ComfyUI's templates). If that fails, the tuned ones
 * built into the app: loaded only then, so the 50 KB list isn't in every page's code.
 */
function loadCatalog() {
  if (catalogAsked) return;
  catalogAsked = true;
  fetch("/api/local/catalog", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ models: LocalModel[] }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => useLocalStore.setState({ catalog: body.models }))
    .catch(async () => {
      catalogAsked = false;
      const { LOCAL_MODELS } = await import("@/lib/local/catalog");
      if (!useLocalStore.getState().catalog) useLocalStore.setState({ catalog: LOCAL_MODELS });
    });
}

const downloading = (s: LocalStatus | null) =>
  Boolean(s?.targets.some((t) => t.downloads.some((d) => d.state === "queued" || d.state === "downloading" || d.state === "checking")));

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const pace = () => (downloading(useLocalStore.getState().status) ? 2000 : 15000);

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!watchers) return;
  timer = setTimeout(() => {
    // A tab in the background doesn't ask (the machines are looked at again the moment it's back).
    if (document.visibilityState === "hidden") return schedule();
    void useLocalStore.getState().reload().finally(schedule);
  }, pace());
}

let listening = false;

/** Back in view after longer than a poll: look at once instead of waiting for the next tick. */
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && watchers && Date.now() - lookedAt > pace()) void useLocalStore.getState().reload().finally(schedule);
  });
}

/** Your machines and models, loaded and kept fresh while `watch` (a closed picker doesn't poll). */
export function useLocal(watch = true) {
  useLocalWatch(watch);
  return useLocalStore(useShallow((s) => ({ status: s.status, catalog: s.catalog, error: s.error, reload: s.reload })));
}

/**
 * Keeps your machines and models fresh while `watch`, without re-rendering the caller when they change. `firstAfter`
 * holds the first look back that long (the model library slides in first: new numbers mid-slide would redraw it).
 */
export function useLocalWatch(watch: boolean, firstAfter = 0) {
  useEffect(() => {
    if (!watch) return;
    watchers++;
    listen();
    loadCatalog();
    const look = () => void useLocalStore.getState().reload().finally(schedule);
    // A look that just answered (the page's other watcher, a hover's prefetch) is fresh enough: the poll goes on from it.
    const fresh = useLocalStore.getState().status && Date.now() - lookedAt < 3_000;
    const later = !fresh && firstAfter && useLocalStore.getState().status ? setTimeout(look, firstAfter) : null;
    if (fresh) {
      if (!timer) schedule();
    } else if (!later) look();
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

/**
 * Look again now (after an install, a removal or a new machine), and keep the polling pace in step. A look already out
 * started before the change, so a new one follows it.
 */
export function reloadLocal() {
  const look = () => useLocalStore.getState().reload();
  return (inflight ? inflight.then(look) : look()).finally(schedule);
}
