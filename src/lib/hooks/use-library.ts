"use client";

import { create } from "zustand";
import type { Generation } from "@/lib/generations/types";
import type { LibraryProject, Placement, ProjectInput } from "@/lib/library/types";
import { useGenerationsStore } from "./use-generations";

/** One take: "generationId:outputIndex". */
export type TakeKey = string;
export const takeKey = (id: string, index: number): TakeKey => `${id}:${index}`;
const parseKey = (key: TakeKey) => {
  const at = key.lastIndexOf(":");
  return { id: key.slice(0, at), index: Number(key.slice(at + 1)) };
};

/** Where takes were before a move: a project's id, or null for General. */
export type Whereabouts = Record<TakeKey, string | null>;

type LibraryState = {
  projects: LibraryProject[];
  /** Takes filed into a project; anything missing here is in General. */
  placements: Record<TakeKey, string>;
  /** Every generation, oldest included (the shared generations store only holds the newest). */
  history: Generation[];
  loaded: boolean;
  load: () => Promise<void>;
  createProject: (input: ProjectInput) => Promise<LibraryProject>;
  updateProject: (id: string, patch: Partial<ProjectInput>) => Promise<void>;
  /** Removes the folder; its takes go back to General. */
  deleteProject: (id: string) => Promise<void>;
  /** Files takes into a project, or back into General with null. Resolves to where they were, for Undo. */
  move: (keys: TakeKey[], project: string | null) => Promise<Whereabouts>;
  restore: (before: Whereabouts) => Promise<void>;
  /** Deletes a generation everywhere, and forgets where its takes were filed. */
  removeGeneration: (id: string) => Promise<void>;
  /** The same for many at once (the page redraws once, the files go a few at a time). */
  removeGenerations: (ids: string[]) => Promise<void>;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again.");
  return data;
}

let loading: Promise<void> | null = null;
/** Bumped by every change made here, so a load that started before one can't undo it. */
let edits = 0;

export const useLibrary = create<LibraryState>((set, get) => ({
  projects: [],
  placements: {},
  history: [],
  loaded: false,

  load: () =>
    (loading ??= (async () => {
      const startedAt = edits;
      try {
        const data = await call<{ projects: LibraryProject[]; placements: Placement[]; items: Generation[] }>("/api/library");
        if (edits === startedAt) {
          const placements: Record<TakeKey, string> = {};
          for (const p of data.placements) placements[takeKey(p.id, p.index)] = p.project;
          set({ projects: data.projects, placements, history: data.items, loaded: true });
        } else set({ history: data.items, loaded: true });
      } catch {
        set({ loaded: true });
      } finally {
        loading = null;
      }
    })()),

  createProject: async (input) => {
    const { project } = await call<{ project: LibraryProject }>("/api/library/projects", { method: "POST", body: JSON.stringify(input) });
    edits++;
    set({ projects: [...get().projects, project] });
    return project;
  },

  updateProject: async (id, patch) => {
    const { project } = await call<{ project: LibraryProject }>(`/api/library/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    edits++;
    set({ projects: get().projects.map((p) => (p.id === id ? project : p)) });
  },

  deleteProject: async (id) => {
    const before = get();
    edits++;
    set({
      projects: before.projects.filter((p) => p.id !== id),
      placements: Object.fromEntries(Object.entries(before.placements).filter(([, p]) => p !== id)),
    });
    try {
      await call(`/api/library/projects/${id}`, { method: "DELETE" });
    } catch (err) {
      set({ projects: before.projects, placements: { ...get().placements, ...Object.fromEntries(Object.entries(before.placements).filter(([, p]) => p === id)) } });
      throw err;
    }
  },

  move: async (keys, project) => {
    const before: Whereabouts = {};
    const placements = { ...get().placements };
    for (const k of keys) {
      before[k] = placements[k] ?? null;
      if (project) placements[k] = project;
      else delete placements[k];
    }
    edits++;
    set({ placements });
    try {
      await call("/api/library/move", { method: "POST", body: JSON.stringify({ takes: keys.map(parseKey), project }) });
    } catch (err) {
      // Put back only what this move changed.
      const now = { ...get().placements };
      for (const k of keys) {
        if (before[k]) now[k] = before[k];
        else delete now[k];
      }
      set({ placements: now });
      throw err;
    }
    return before;
  },

  restore: async (before) => {
    const groups = new Map<string | null, TakeKey[]>();
    for (const [k, p] of Object.entries(before)) groups.set(p, [...(groups.get(p) ?? []), k]);
    await Promise.all(Array.from(groups, ([p, keys]) => get().move(keys, p)));
  },

  removeGeneration: async (id) => {
    edits++;
    set({
      history: get().history.filter((g) => g.id !== id),
      placements: Object.fromEntries(Object.entries(get().placements).filter(([k]) => parseKey(k).id !== id)),
    });
    await useGenerationsStore.getState().remove(id);
  },

  removeGenerations: async (ids) => {
    const gone = new Set(ids);
    edits++;
    set({
      history: get().history.filter((g) => !gone.has(g.id)),
      placements: Object.fromEntries(Object.entries(get().placements).filter(([k]) => !gone.has(parseKey(k).id))),
    });
    useGenerationsStore.setState((s) => ({ items: s.items.filter((g) => !gone.has(g.id)) }));
    const queue = [...gone];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) await fetch(`/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
      }),
    );
  },
}));
