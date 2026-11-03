"use client";

import { useEffect, useState } from "react";
import type { LiveGpu } from "@/lib/setup/types";

/**
 * Machines' GPUs right now (/api/setup/live), looked at every 3 seconds while the page is in view and paused while it's
 * hidden. One look serves every meter on the page.
 */
export function useLive(ids: string[]) {
  const key = ids.filter(Boolean).sort().join(",");
  const [live, setLive] = useState<Record<string, LiveGpu>>({});
  useEffect(() => {
    if (!key) return;
    let gone = false;
    let timer: number | undefined;
    const look = async () => {
      if (document.visibilityState === "visible") {
        const res = await fetch(`/api/setup/live?machine=${encodeURIComponent(key)}`, { cache: "no-store" }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { live?: LiveGpu[] } | null;
        if (!gone && body?.live) setLive(Object.fromEntries(body.live.map((l) => [l.machine, l])));
      }
      if (!gone) timer = window.setTimeout(() => void look(), 3000);
    };
    void look();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [key]);
  return live;
}
