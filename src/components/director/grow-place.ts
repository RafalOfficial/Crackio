"use client";

import { create } from "zustand";
import { useDirector } from "@/lib/director/store";
import { loadDepth } from "@/lib/director/vision";
import { grownView } from "@/lib/director/grow";
import { friendlyModelError } from "./status";

/** The model Small extend draws with (server/grow-photo: FLUX 3 Klein and ausboss's outpaint LoRA). */
export const GROW_MODEL = "local:flux3-klein";

/** Small extend in progress (since when), or why it couldn't be done. */
export const useGrow = create<{ busy: boolean; error: string | null; since: number | null }>(() => ({ busy: false, error: null, since: null }));

let growRun: AbortController | null = null;

// Why one photo couldn't be extended isn't the next photo's business.
useDirector.subscribe((s, before) => {
  if (s.scene.place.image?.url !== before.scene.place.image?.url && useGrow.getState().error) useGrow.setState({ error: null });
});

/**
 * Small extend (server/grow-photo): the place's photo grown 1.5 times each way around itself by FLUX 3 Klein and the
 * outpaint LoRA, on the Director's GPU. The stage keeps its set and the Camera: the photo in the middle stays where it
 * was and the ring around it joins it (lib/director/grow). Undo takes it back. Another photo put in meanwhile stops it.
 */
export async function growPlace() {
  const scene = useDirector.getState().scene;
  const image = scene.place.image;
  if (!image?.view || useGrow.getState().busy) return;
  const run = new AbortController();
  growRun = run;
  const moved = useDirector.subscribe((s) => {
    if (s.scene.place.image?.url !== image.url) run.abort();
  });
  useGrow.setState({ busy: true, error: null, since: Date.now() });
  try {
    // The photo as the stage shows it: one Fix this spot changed is grown with the fix in it.
    const source = scene.place.world?.photo?.url ?? image.url;
    const res = await fetch("/api/director/grow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: source, ...(scene.place.text.trim() ? { words: scene.place.text.trim() } : {}) }),
      signal: run.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; grow?: { x: number; y: number }; error?: string };
    if (!res.ok || !data.url || !data.width || !data.height || !data.grow) throw new Error(data.error ?? "The photo couldn't be extended.");
    // The set's depth for the bigger photo, lined up with the old set where they overlap.
    const [before, after] = await Promise.all([loadDepth(image.url), loadDepth(data.url)]);
    const now = useDirector.getState().scene.place.image;
    if (run.signal.aborted || now?.url !== image.url || !now.view) return;
    useDirector.getState().growPlacePhoto({ url: data.url, width: data.width, height: data.height }, grownView(now.view, before, after, data.grow));
  } catch (err) {
    // Stopped (by you, or by another photo): nothing went wrong.
    if (!run.signal.aborted) useGrow.setState({ error: friendlyModelError((err as Error).message) });
  } finally {
    moved();
    if (growRun === run) growRun = null;
    useGrow.setState({ busy: false, since: null });
  }
}

/** Stops Small extend; its job on the GPU is cancelled with it. */
export function stopGrow() {
  growRun?.abort();
}
