"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { AspectId } from "@/lib/shot";
import { shotDone, type LookId, type Shot, type Storyboard } from "@/lib/storyboard/types";

type ShotEdit = Partial<Pick<Shot, "title" | "framing" | "camera" | "layout" | "action" | "end" | "transition" | "duration">> & { id: string };

type NewFilm = { scene: string; aspect: AspectId; look: LookId; target: number; models?: { image?: string; video?: string; resolution?: string }; auto?: boolean };

type BoardsState = {
  items: Storyboard[];
  loaded: boolean;
  /** The board open in the editor. */
  current: string | null;
  open: (id: string | null) => void;
  load: () => Promise<void>;
  refresh: (id: string) => Promise<void>;
  create: (input: NewFilm) => Promise<Storyboard>;
  send: (id: string, text: string) => Promise<void>;
  /** Answer one of the director's questions ("director" for "just make it"). */
  answer: (id: string, ask: string, option: string) => Promise<void>;
  update: (id: string, patch: { title?: string; models?: { image?: string | null; video?: string | null; resolution?: string | null }; shot?: ShotEdit; style?: string; motion?: string; paused?: boolean }) => Promise<void>;
  retake: (id: string, shot: string, note?: string) => Promise<void>;
  redraw: (id: string, shot: string, note?: string) => Promise<void>;
  pickTake: (id: string, shot: string, take: number) => Promise<void>;
  stitch: (id: string) => Promise<void>;
  remake: (id: string) => Promise<Storyboard>;
  remove: (id: string) => Promise<void>;
};

/** Something is still being made or decided on this board. */
export const isBusy = (b: Storyboard) => {
  if (b.status === "planning" || b.finalJob || b.jobs?.plate || b.messages?.some((m) => m.pending)) return true;
  // Waiting for your answers: only pictures of the places still rendering keep it busy.
  if (b.status === "developing") return Boolean(b.messages?.some((m) => m.asks?.some((a) => a.options.some((o) => o.job))));
  if (b.version !== 3) return b.shots.some((s) => s.jobs.frame || s.jobs.fix || s.jobs.clip || s.check?.status === "pending" || s.check?.status === "checking");
  if (b.paused || b.status !== "ready") return false;
  // The chain waits at its first unfinished shot; a problem there waits for you.
  const first = b.shots.find((s) => !shotDone(s));
  if (first) return !first.error;
  return b.shots.length > 0 && !b.final && (b.filmFailures ?? 0) < 2;
};

let boardTimer: ReturnType<typeof setTimeout> | null = null;
let listTimer: ReturnType<typeof setTimeout> | null = null;
/** Pages showing the boards right now; nothing polls when there are none. */
let watching = 0;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
}

export const useStoryboardsStore = create<BoardsState>((set, get) => {
  /** The open board refreshes quickly while it's working (that also moves it along on the server). */
  const follow = () => {
    if (boardTimer) clearTimeout(boardTimer);
    const id = get().current;
    const b = get().items.find((x) => x.id === id);
    if (!id || !b || !watching) return;
    boardTimer = setTimeout(() => void get().refresh(id), isBusy(b) ? 1500 : 12_000);
  };
  const put = (item: Storyboard) => {
    set({ items: get().items.some((b) => b.id === item.id) ? get().items.map((b) => (b.id === item.id ? item : b)) : [item, ...get().items] });
    if (item.id === get().current) follow();
  };
  const post = (url: string, body?: unknown) => call<{ item: Storyboard }>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined }).then(({ item }) => put(item));

  return {
    items: [],
    loaded: false,
    current: null,
    open: (id) => {
      set({ current: id });
      follow();
      if (id) void get().refresh(id);
    },
    load: async () => {
      try {
        const { items } = await call<{ items: Storyboard[] }>("/api/storyboards");
        // Keep the open board's fresher copy.
        const current = get().items.find((b) => b.id === get().current);
        set({ items: items.map((b) => (current && b.id === current.id && current.updatedAt > b.updatedAt ? current : b)), loaded: true });
      } catch {
        set({ loaded: true });
      }
      if (listTimer) clearTimeout(listTimer);
      if (watching) listTimer = setTimeout(() => void get().load(), 15_000);
      follow();
    },
    refresh: async (id) => {
      try {
        put((await call<{ item: Storyboard }>(`/api/storyboards/${id}`)).item);
      } catch {
        follow();
      }
    },
    create: async (input) => {
      const { item } = await call<{ item: Storyboard }>("/api/storyboards", { method: "POST", body: JSON.stringify(input) });
      set({ current: item.id });
      put(item);
      return item;
    },
    send: (id, text) => post(`/api/storyboards/${id}/messages`, { text }),
    answer: (id, ask, option) => post(`/api/storyboards/${id}/answer`, { ask, option }),
    update: async (id, patch) => put((await call<{ item: Storyboard }>(`/api/storyboards/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).item),
    retake: (id, shot, note) => post(`/api/storyboards/${id}/retake`, { shot, note }),
    redraw: (id, shot, note) => post(`/api/storyboards/${id}/redraw`, { shot, note }),
    pickTake: (id, shot, take) => post(`/api/storyboards/${id}/take`, { shot, take }),
    stitch: (id) => post(`/api/storyboards/${id}/stitch`),
    remake: async (id) => {
      const { item } = await call<{ item: Storyboard }>(`/api/storyboards/${id}/remake`, { method: "POST" });
      set({ current: item.id });
      put(item);
      return item;
    },
    remove: async (id) => {
      const rest = get().items.filter((b) => b.id !== id);
      set({ items: rest, current: get().current === id ? (rest[0]?.id ?? null) : get().current });
      follow();
      await call(`/api/storyboards/${id}`, { method: "DELETE" });
    },
  };
});

export function useStoryboards() {
  return useStoryboardsStore();
}

/** Keep the boards fresh while the page that shows them is open (call it once, from the page). */
export function useStoryboardsLive() {
  useEffect(() => {
    watching++;
    void useStoryboardsStore.getState().load();
    return () => {
      watching--;
      if (watching) return;
      if (boardTimer) clearTimeout(boardTimer);
      if (listTimer) clearTimeout(listTimer);
      boardTimer = listTimer = null;
    };
  }, []);
}
