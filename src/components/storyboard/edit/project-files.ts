"use client";

import { create } from "zustand";
import type { EditFile } from "@/lib/storyboard/edit";

/** The open project's files (server/edit-projects): its takes and what you added, and adding more from your computer. */

type FilesState = {
  project: string | null;
  items: EditFile[];
  loaded: boolean;
  uploading: number;
  error: string | null;
  load: (project: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Files from your computer into the project; resolves with them once they're in. */
  upload: (files: File[]) => Promise<EditFile[]>;
  remove: (key: string) => Promise<void>;
};

const MEDIA = /^(image|video|audio)\//;

export const useProjectFiles = create<FilesState>((set, get) => ({
  project: null,
  items: [],
  loaded: false,
  uploading: 0,
  error: null,
  load: async (project) => {
    if (get().project !== project) set({ project, items: [], loaded: false, error: null });
    await get().refresh();
  },
  refresh: async () => {
    const project = get().project;
    if (!project) return;
    try {
      const res = await fetch(`/api/storyboard/projects/${project}/files`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { items?: EditFile[]; error?: string };
      if (get().project !== project) return;
      if (!res.ok || !data.items) throw new Error(data.error ?? "Couldn't list the project's files.");
      set({ items: data.items, loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: (err as Error).message });
    }
  },
  upload: async (files) => {
    const project = get().project;
    const usable = files.filter((f) => MEDIA.test(f.type) && f.type !== "image/svg+xml").slice(0, 24);
    if (!project || !usable.length) {
      if (files.length) set({ error: "Pictures, clips and sounds only." });
      return [];
    }
    set({ uploading: get().uploading + usable.length, error: null });
    try {
      const body = new FormData();
      for (const f of usable) body.append("file", f);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const up = (await res.json().catch(() => ({}))) as { items?: { url: string; name?: string }[]; error?: string };
      if (!res.ok || !up.items?.length) throw new Error(up.error ?? "Upload failed.");
      const added = await fetch(`/api/storyboard/projects/${project}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: up.items.map((i) => ({ url: i.url, name: i.name })) }),
      });
      const data = (await added.json().catch(() => ({}))) as { items?: EditFile[]; error?: string };
      if (!added.ok || !data.items) throw new Error(data.error ?? "Couldn't add the files.");
      if (get().project === project) set({ items: [...data.items, ...get().items.filter((x) => !data.items!.some((n) => n.key === x.key))] });
      return data.items;
    } catch (err) {
      set({ error: (err as Error).message });
      return [];
    } finally {
      set({ uploading: Math.max(0, get().uploading - usable.length) });
    }
  },
  remove: async (key) => {
    const project = get().project;
    if (!project) return;
    set({ items: get().items.filter((f) => f.key !== key) });
    const res = await fetch(`/api/storyboard/projects/${project}/files?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!res.ok) await get().refresh();
  },
}));
