"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { LiveGpu } from "@/lib/setup/types";

/**
 * Machines' GPUs right now (/api/setup/live), looked at every 3 seconds while the page is in view and paused while it's
 * hidden. One look serves every meter on the page, and each reading lives in a small store by machine: a meter that reads
 * its own machine (useLiveOf) redraws alone, not the page around it, and a reading that didn't change draws nothing.
 */
const useLiveStore = create<{ live: Record<string, LiveGpu> }>(() => ({ live: {} }));

/** Looks every 3 s at these machines' GPUs while mounted, without re-rendering the caller. */
export function useLiveWatch(ids: string[]) {
  const key = ids.filter(Boolean).sort().join(",");
  useEffect(() => {
    if (!key) return;
    let gone = false;
    let timer: number | undefined;
    const look = async () => {
      if (document.visibilityState === "visible") {
        const res = await fetch(`/api/setup/live?machine=${encodeURIComponent(key)}`, { cache: "no-store" }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { live?: LiveGpu[] } | null;
        if (!gone && body?.live) {
          const was = useLiveStore.getState().live;
          const changed = body.live.filter((l) => JSON.stringify(was[l.machine]) !== JSON.stringify(l));
          if (changed.length) useLiveStore.setState({ live: { ...was, ...Object.fromEntries(changed.map((l) => [l.machine, l])) } });
        }
      }
      if (!gone) timer = window.setTimeout(() => void look(), 3000);
    };
    void look();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [key]);
}

/** One machine's GPU right now (kept fresh by a useLiveWatch on the page). */
export function useLiveOf(id: string | null | undefined): LiveGpu | undefined {
  return useLiveStore((s) => (id ? s.live[id] : undefined));
}

/** These machines' GPUs right now, looked at every 3 s while mounted. */
export function useLive(ids: string[]): Record<string, LiveGpu> {
  useLiveWatch(ids);
  const key = ids.filter(Boolean).sort().join(",");
  return useLiveStore(useShallow((s) => Object.fromEntries(key ? key.split(",").flatMap((id) => (s.live[id] ? [[id, s.live[id]]] : [])) : [])));
}
