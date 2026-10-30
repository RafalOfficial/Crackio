"use client";

import { create } from "zustand";
import type { EditProject, EditProjectSummary } from "@/lib/storyboard/edit";
import type { AspectId } from "@/lib/shot";

/** Storyboard projects (lib/storyboard/edit): the list, and which one is open (remembered in this browser). */

const CURRENT = "crackio:storyboard:project";

function remembered() {
  try {
    return localStorage.getItem(CURRENT);
  } catch {
    return null;
  }
}

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(CURRENT, id);
    else localStorage.removeItem(CURRENT);
  } catch {
    /* private window: it opens the newest next time */
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
}

type ProjectsState = {
  items: EditProjectSummary[];
  loaded: boolean;
  /** The open project's id. */
  current: string | null;
  load: () => Promise<void>;
  open: (id: string) => void;
  create: (input?: { name?: string; aspect?: AspectId }) => Promise<EditProject>;
  remove: (id: string) => Promise<void>;
  /** A project's name, shape or length changed: its row in the list follows. */
  touch: (id: string, patch: Partial<EditProjectSummary>) => void;
};

export const useEditProjects = create<ProjectsState>((set, get) => ({
  items: [],
  loaded: false,
  current: null,
  load: async () => {
    const { items } = await json<{ items: EditProjectSummary[] }>(await fetch("/api/storyboard/projects", { cache: "no-store" }));
    const keep = get().current ?? remembered();
    set({ items, loaded: true, current: items.some((p) => p.id === keep) ? keep : (items[0]?.id ?? null) });
  },
  open: (id) => {
    remember(id);
    set({ current: id });
  },
  create: async (input = {}) => {
    const { project } = await json<{ project: EditProject }>(
      await fetch("/api/storyboard/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    );
    const row: EditProjectSummary = { id: project.id, name: project.name, icon: project.icon, color: project.color, aspect: project.aspect, createdAt: project.createdAt, updatedAt: project.updatedAt, clips: 0, seconds: 0 };
    remember(project.id);
    set({ items: [row, ...get().items], current: project.id });
    return project;
  },
  remove: async (id) => {
    await json(await fetch(`/api/storyboard/projects/${id}`, { method: "DELETE" }));
    const items = get().items.filter((p) => p.id !== id);
    const current = get().current === id ? (items[0]?.id ?? null) : get().current;
    remember(current);
    set({ items, current });
  },
  touch: (id, patch) => set({ items: get().items.map((p) => (p.id === id ? { ...p, ...patch } : p)) }),
}));
