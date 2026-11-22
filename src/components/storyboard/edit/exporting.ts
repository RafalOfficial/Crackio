"use client";

import { create } from "zustand";
import type { Generation } from "@/lib/generations/types";
import { isLive, useGenerationsStore } from "@/lib/hooks/use-generations";
import { flushSaves } from "@/lib/storyboard/edit-store";
import { useProjectFiles } from "./project-files";

/** The film being exported (one at a time): the top bar's button and the timeline's next step both start and follow it. */
type ExportState = {
  job: Generation | null;
  error: string | null;
  start: (project: string, quality: "720p" | "1080p") => Promise<void>;
  /** A project opening picks up its export still running (the page was reloaded or left meanwhile). */
  restore: (project: string) => void;
};

let timer: ReturnType<typeof setTimeout> | null = null;

export const isExporting = (g: Generation | null) => Boolean(g && (g.status === "queued" || g.status === "running"));

/** A film export of a Storyboard project (server/edit-projects startExport). */
export const isExportJob = (g: Generation, project?: string) => g.tool === "storyboard" && Boolean(g.params?.export) && (!project || g.params?.project === project);

/** Gives up following after this many looks that found nothing (the job was deleted, or the server is gone). */
const MISSES = 5;

export const useExport = create<ExportState>((set, get) => {
  const follow = (id: string) => {
    if (timer) clearTimeout(timer);
    let misses = 0;
    const look = async () => {
      timer = null;
      if (get().job?.id !== id) return;
      // The takes list may already follow it (after a reload it's one of the recent takes): no second request then.
      const known = useGenerationsStore.getState().items.find((g) => g.id === id);
      let g: Generation | undefined = known && isLive(known) ? known : undefined;
      if (!g) {
        const r = await fetch(`/api/generations?ids=${id}`, { cache: "no-store" }).catch(() => null);
        g = ((await r?.json().catch(() => null)) as { items?: Generation[] } | null)?.items?.[0];
      }
      if (get().job?.id !== id) return;
      if (!g) {
        if (++misses >= MISSES) return set({ job: null });
      } else {
        misses = 0;
        const was = get().job;
        // Only a real change redraws the button and the next step.
        if (!was || was.status !== g.status || was.progress !== g.progress || was.stage !== g.stage) set({ job: g });
        if (!isExporting(g)) {
          if (g.status === "done") void useProjectFiles.getState().refresh();
          else set({ error: g.error ?? "The film didn't come together." });
          return;
        }
      }
      // A hidden tab looks less often; it catches up as soon as it's seen.
      timer = setTimeout(() => void look(), document.visibilityState === "visible" ? 1200 : 5000);
    };
    timer = setTimeout(() => void look(), 1200);
  };

  return {
    job: null,
    error: null,
    start: async (project, quality) => {
      if (isExporting(get().job)) return;
      set({ error: null });
      await flushSaves();
      const res = await fetch(`/api/storyboard/projects/${project}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quality }) });
      const data = (await res.json().catch(() => ({}))) as { item?: Generation; error?: string };
      if (!res.ok || !data.item) return set({ error: data.error ?? "Couldn't start the export." });
      set({ job: data.item });
      follow(data.item.id);
    },
    restore: (project) => {
      const job = get().job;
      if (isExporting(job) && job?.params?.project === project) return;
      const find = () => useGenerationsStore.getState().items.find((g) => isExportJob(g, project) && isLive(g));
      const adopt = (g: Generation) => {
        set({ job: g, error: null });
        follow(g.id);
      };
      const running = find();
      if (running) return adopt(running);
      // The takes may not have loaded yet: the first list that arrives is looked through once.
      if (useGenerationsStore.getState().loaded) return;
      const off = useGenerationsStore.subscribe((s) => {
        if (!s.loaded) return;
        off();
        const late = find();
        if (late && !isExporting(get().job)) adopt(late);
      });
    },
  };
});
