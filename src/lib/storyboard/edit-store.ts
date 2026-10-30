"use client";

import { create } from "zustand";
import { emptyTimeline, filmLength, type EditFile, type EditMode, type EditProject, type EditTimeline } from "./edit";
import { useEditProjects } from "@/lib/hooks/use-edit-projects";
import type { AspectId } from "@/lib/shot";

/**
 * The open Storyboard project in the browser: its timeline with undo, what's selected, the picture a clip is being
 * made from, and saving. Every change is saved on its own a moment later; switching projects (or leaving) saves first.
 */

type Patch = { timeline?: EditTimeline; aspect?: AspectId; mode?: EditMode; scene?: unknown };

/** A picture to make a clip from: a file, and the still on the timeline it is (whose place the clip takes). */
export type ClipPick = { file: EditFile; clip?: string };

type EditorState = {
  project: EditProject | null;
  timeline: EditTimeline;
  past: EditTimeline[];
  future: EditTimeline[];
  selected: string | null;
  pick: ClipPick | null;
  /** Pixels per second on the timeline; null fits the whole film. */
  zoom: number | null;
  saving: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  /** When the cut last changed: a film exported before it is out of date. */
  changedAt: number;

  open: (project: EditProject) => void;
  close: () => void;
  /** Change the timeline. `live` changes (a drag) don't add undo steps: call checkpoint() when the drag starts. */
  change: (fn: (t: EditTimeline) => EditTimeline, live?: boolean) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  setPick: (pick: ClipPick | null) => void;
  setAspect: (aspect: AspectId) => void;
  setMode: (mode: EditMode) => void;
  setZoom: (zoom: number | null) => void;
  /** Saved under another name (the folder's: the Library checks it). */
  rename: (name: string) => Promise<void>;
};

const HISTORY = 100;

/* ------------------------------------------------------------------ saving */

const pending = new Map<string, Patch>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> = Promise.resolve();

async function send(id: string, patch: Patch) {
  const res = await fetch(`/api/storyboard/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    // A save made as the page closes still goes out.
    keepalive: JSON.stringify(patch).length < 60_000,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; updatedAt?: number };
  if (!res.ok) throw Object.assign(new Error(data.error ?? "Couldn't save the project."), { status: res.status });
  return data.updatedAt;
}

/** Everything waiting to be saved, sent now. */
export function flushSaves(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = [...pending.entries()];
  pending.clear();
  if (!batch.length) return inFlight;
  useEditor.setState({ saving: "saving" });
  inFlight = inFlight.then(async () => {
    try {
      for (const [id, patch] of batch) {
        const updatedAt = await send(id, patch);
        const t = patch.timeline;
        useEditProjects.getState().touch(id, {
          ...(updatedAt ? { updatedAt } : {}),
          ...(patch.aspect ? { aspect: patch.aspect } : {}),
          ...(t ? { clips: t.main.length, seconds: filmLength(t), cover: t.main[0]?.url } : {}),
        });
      }
      if (!pending.size) useEditor.setState({ saving: "saved", saveError: null });
    } catch (err) {
      // Gone (its folder was deleted in the Library): nothing to save it to, so another project opens.
      if ((err as { status?: number }).status === 404) {
        useEditor.setState({ saving: "idle", saveError: null });
        void useEditProjects.getState().load();
        return;
      }
      // Kept for the next try: nothing you did is dropped.
      for (const [id, patch] of batch) pending.set(id, { ...patch, ...pending.get(id) });
      useEditor.setState({ saving: "error", saveError: (err as Error).message });
      timer = setTimeout(() => void flushSaves(), 4000);
    }
  });
  return inFlight;
}

/** Saved a moment from now, with whatever else changes meanwhile. */
export function queueSave(id: string, patch: Patch) {
  pending.set(id, { ...pending.get(id), ...patch });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSaves(), 700);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flushSaves());

/* ------------------------------------------------------------------ the store */

export const useEditor = create<EditorState>((set, get) => {
  const save = (patch: Patch) => {
    const id = get().project?.id;
    if (id) queueSave(id, patch);
  };
  const commit = (timeline: EditTimeline, live?: boolean) => {
    if (timeline === get().timeline) return;
    set((s) => (live ? { timeline, changedAt: Date.now() } : { timeline, changedAt: Date.now(), past: [...s.past, s.timeline].slice(-HISTORY), future: [] }));
    save({ timeline });
  };

  return {
    project: null,
    timeline: emptyTimeline(),
    past: [],
    future: [],
    selected: null,
    pick: null,
    zoom: null,
    saving: "idle",
    saveError: null,
    changedAt: 0,

    open: (project) =>
      set({ project, timeline: project.timeline ?? emptyTimeline(), past: [], future: [], selected: null, pick: null, zoom: null, saving: "idle", saveError: null, changedAt: 0 }),
    close: () => set({ project: null, timeline: emptyTimeline(), past: [], future: [], selected: null, pick: null }),

    change: (fn, live) => commit(fn(get().timeline), live),
    checkpoint: () => set((s) => ({ past: [...s.past, s.timeline].slice(-HISTORY), future: [] })),
    undo: () => {
      const prev = get().past.at(-1);
      if (!prev) return;
      set((s) => ({ timeline: prev, changedAt: Date.now(), past: s.past.slice(0, -1), future: [s.timeline, ...s.future].slice(0, HISTORY) }));
      save({ timeline: prev });
    },
    redo: () => {
      const next = get().future[0];
      if (!next) return;
      set((s) => ({ timeline: next, changedAt: Date.now(), future: s.future.slice(1), past: [...s.past, s.timeline].slice(-HISTORY) }));
      save({ timeline: next });
    },

    select: (selected) => set({ selected }),
    setPick: (pick) => set({ pick }),
    setAspect: (aspect) => {
      const project = get().project;
      if (!project || project.aspect === aspect) return;
      set({ project: { ...project, aspect }, changedAt: Date.now() });
      save({ aspect });
    },
    setMode: (mode) => {
      const project = get().project;
      if (!project || project.mode === mode) return;
      set({ project: { ...project, mode } });
      save({ mode });
    },
    setZoom: (zoom) => set({ zoom }),
    rename: async (name) => {
      const project = get().project;
      if (!project || !name.trim() || name.trim() === project.name) return;
      const res = await fetch(`/api/storyboard/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; name?: string };
      if (!res.ok || !data.name) throw new Error(data.error ?? "Couldn't rename the project.");
      set({ project: { ...project, name: data.name } });
      useEditProjects.getState().touch(project.id, { name: data.name });
    },
  };
});
