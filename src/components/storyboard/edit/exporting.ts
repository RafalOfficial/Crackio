"use client";

import { create } from "zustand";
import type { Generation } from "@/lib/generations/types";
import { flushSaves } from "@/lib/storyboard/edit-store";
import { useProjectFiles } from "./project-files";

/** The film being exported (one at a time): the top bar's button and the timeline's next step both start and follow it. */
type ExportState = {
  job: Generation | null;
  error: string | null;
  start: (project: string, quality: "720p" | "1080p") => Promise<void>;
};

let timer: ReturnType<typeof setInterval> | null = null;

export const isExporting = (g: Generation | null) => Boolean(g && (g.status === "queued" || g.status === "running"));

export const useExport = create<ExportState>((set, get) => ({
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
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      const id = get().job?.id;
      const r = id ? await fetch(`/api/generations?ids=${id}`, { cache: "no-store" }).catch(() => null) : null;
      const g = ((await r?.json().catch(() => null)) as { items?: Generation[] } | null)?.items?.[0];
      if (!g) return;
      set({ job: g });
      if (isExporting(g)) return;
      if (timer) clearInterval(timer);
      timer = null;
      if (g.status === "done") void useProjectFiles.getState().refresh();
      else set({ error: g.error ?? "The film didn't come together." });
    }, 1200);
  },
}));
