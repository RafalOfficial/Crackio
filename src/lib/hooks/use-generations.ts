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
  /** True once the takes came in. A failed look leaves it false (and `error` set) and tries again by itself. */
  loaded: boolean;
  /** Why the last look at the takes failed, while it retries; null once they're in. */
  error: string | null;
  load: () => Promise<void>;
  submit: (input: SubmitInput) => Promise<Generation>;
  /**
   * A take another route started (Swap, Templates, Recast…): it shows at once and is followed until it's done, without
   * re-reading every take.
   */
  track: (item: Generation) => void;
  remove: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

export const isLive = (g: Generation) => g.status === "queued" || g.status === "running";

/** How many takes a look asks for, and how many live ones one poll can ask about (the route's own caps). */
const LIMIT = 60;
const POLL_IDS = 50;
const POLL_MS = 1200;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollFails = 0;
/** Ids a poll didn't get back: dropped once they're missing twice (deleted on another device or tab). */
const missing = new Map<string, number>();
/** Ids this tab added (submit, track) that no look has returned yet: a look that left before them mustn't drop them. */
const made = new Set<string>();
let loading: Promise<void> | null = null;
let loadAgain = false;
/** Asks about the live takes right now (set by the store below). */
let kick: () => void = () => {};
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** What a card shows of a take. Comparing this (not the whole take, compiled prompt included) keeps polls cheap. */
const look = (g: Generation) =>
  `${g.status}|${g.progress ?? ""}|${g.stage ?? ""}|${g.error ?? ""}|${g.startedAt ?? ""}|${g.finishedAt ?? ""}|${g.modelName ?? ""}|${g.outputs.map((o) => o.url).join(",")}|${JSON.stringify(g.params ?? null)}`;

/**
 * The server's newest takes plus what it couldn't know yet: takes made after its list was read (newer than its newest,
 * or added here since), and older ones a tool loaded beyond its window. A take inside the window that the server no
 * longer has was deleted elsewhere and goes. A take this tab already saw finish never turns back to running.
 */
function mergeTakes(fresh: Generation[], local: Generation[]): Generation[] {
  const byId = new Map(fresh.map((g) => [g.id, g]));
  for (const id of byId.keys()) made.delete(id);
  let newest = -Infinity;
  let oldest = Infinity;
  for (const g of fresh) {
    if (g.createdAt > newest) newest = g.createdAt;
    if (g.createdAt < oldest) oldest = g.createdAt;
  }
  const windowFull = fresh.length >= LIMIT;
  const out: Generation[] = [];
  const seen = new Set<string>();
  for (const g of local) {
    const f = byId.get(g.id);
    if (f) {
      out.push(isLive(f) && !isLive(g) ? g : look(f) === look(g) ? g : f);
      seen.add(g.id);
    } else if (made.has(g.id) || g.createdAt > newest || (windowFull && g.createdAt < oldest)) {
      out.push(g);
      seen.add(g.id);
    }
  }
  for (const f of fresh) if (!seen.has(f.id)) out.push(f);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Other tabs on this computer hear about new and deleted takes, so their Home and Library don't wait for a reload. */
const channel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window ? new BroadcastChannel("crackio-takes") : null;
const tellOtherTabs = () => {
  try {
    channel?.postMessage("changed");
  } catch {
    /* a closed channel: nothing to tell */
  }
};

/**
 * Settings a page adds to everything made while it's open: Storyboard files what you make in a project into its folder
 * (params.project). Empty everywhere else.
 */
export const useSubmitTags = create<{ params: Record<string, unknown> }>(() => ({ params: {} }));

export const useGenerationsStore = create<GenerationsState>((set, get) => {
  const poll = async () => {
    pollTimer = null;
    // A hidden tab stops asking: the take goes on on the server, and coming back asks at once (see watch()).
    if (typeof document !== "undefined" && document.hidden) return;
    const ids = get().items.filter(isLive).slice(0, POLL_IDS).map((g) => g.id);
    if (!ids.length) return;
    try {
      const res = await fetch(`/api/generations?ids=${ids.join(",")}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { items?: Generation[] } | null;
      if (!res.ok || !Array.isArray(data?.items)) throw new Error(`HTTP ${res.status}`);
      const byId = new Map(data.items.map((i) => [i.id, i]));
      const asked = new Set(ids);
      // Only takes that moved on get new objects, so a card whose take didn't change doesn't redraw.
      let changed = false;
      const next: Generation[] = [];
      for (const g of get().items) {
        if (!asked.has(g.id)) {
          next.push(g);
          continue;
        }
        const fresh = byId.get(g.id);
        if (!fresh) {
          const times = (missing.get(g.id) ?? 0) + 1;
          missing.set(g.id, times);
          if (times >= 2) {
            missing.delete(g.id);
            changed = true;
            continue;
          }
          next.push(g);
          continue;
        }
        missing.delete(g.id);
        if (look(fresh) === look(g)) next.push(g);
        else {
          changed = true;
          next.push(fresh);
        }
      }
      if (changed) set({ items: next });
      pollFails = 0;
    } catch {
      // Transient (the server restarting or busy): ask again, a little later each time, up to 15 s apart.
      pollFails++;
    }
    schedule();
  };
  const schedule = (now = false) => {
    if (pollTimer || !get().items.some(isLive)) return;
    pollTimer = setTimeout(poll, now ? 0 : Math.min(15_000, POLL_MS * 2 ** Math.min(pollFails, 4)));
  };
  const pollNow = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    schedule(true);
  };
  kick = pollNow;

  const readTakes = async () => {
    try {
      const res = await fetch(`/api/generations?limit=${LIMIT}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { items?: Generation[] } | null;
      // An error answer (the dev server mid-restart) has no list: it isn't "no takes".
      if (!res.ok || !Array.isArray(data?.items)) throw new Error(`Takes didn't load (HTTP ${res.status})`);
      const fresh = data.items;
      set((s) => ({ items: mergeTakes(fresh, s.items), loaded: true, error: null }));
      retries = 0;
      schedule();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Takes didn't load" });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void get().load(), Math.min(30_000, 2_000 * 2 ** retries++));
    }
  };

  return {
    items: [],
    loaded: false,
    error: null,
    load: () => {
      // One look at a time; a call made while one is out gets one more look after it, so nothing added meanwhile is missed.
      if (loading) {
        loadAgain = true;
        return loading;
      }
      loading = readTakes().finally(() => {
        loading = null;
        if (loadAgain) {
          loadAgain = false;
          void get().load();
        }
      });
      return loading;
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
      // A crashed route answers with an HTML page: say what happened, not "Unexpected token '<'".
      const data = (await res.json().catch(() => ({}))) as { item?: Generation; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error ?? `Couldn't start the generation (HTTP ${res.status}).`);
      get().track(data.item);
      // The live demo took its credits as it queued: the strip shows what's left at once (a no-op elsewhere).
      void refreshDemoSession();
      return data.item;
    },
    track: (item) => {
      made.add(item.id);
      const items = get().items;
      set({ items: items.some((g) => g.id === item.id) ? items.map((g) => (g.id === item.id ? item : g)) : [item, ...items] });
      schedule();
      tellOtherTabs();
    },
    remove: async (id) => {
      const before = get().items;
      const at = before.findIndex((g) => g.id === id);
      set({ items: before.filter((g) => g.id !== id) });
      made.delete(id);
      const res = await fetch(`/api/generations/${id}`, { method: "DELETE" }).catch(() => null);
      if (res?.ok) {
        tellOtherTabs();
        return;
      }
      // It's still there: put it back where it was rather than pretend.
      const gone = before[at];
      if (gone && !get().items.some((g) => g.id === id)) {
        const items = [...get().items];
        items.splice(Math.min(at, items.length), 0, gone);
        set({ items });
      }
    },
    cancel: async (id) => {
      // Say so at once; the next poll shows where it stopped.
      set({ items: get().items.map((g) => (g.id === id && isLive(g) ? { ...g, stage: "Cancelling…" } : g)) });
      await fetch(`/api/generations/${id}/cancel`, { method: "POST" }).catch(() => null);
      pollNow();
    },
  };
});

let watching = false;
/**
 * Once per tab: a tab coming back asks about its live takes at once, and after a while away (or when another tab made
 * or deleted one) looks at the takes again, so a take started on the Mac shows on the PC without a reload.
 */
function watch() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    const store = useGenerationsStore.getState();
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > 20_000) void store.load();
    else if (store.items.some(isLive)) {
      pollFails = 0;
      kick();
    }
    hiddenAt = 0;
  });
  if (channel) {
    let soon: ReturnType<typeof setTimeout> | null = null;
    channel.onmessage = () => {
      if (soon) return;
      soon = setTimeout(() => {
        soon = null;
        void useGenerationsStore.getState().load();
      }, 400);
    };
  }
}

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
    watch();
    if (loadedOnce) return;
    loadedOnce = true;
    void useGenerationsStore.getState().load();
  }, []);
  return state;
}
