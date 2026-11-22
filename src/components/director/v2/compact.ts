"use client";

import { useSyncExternalStore } from "react";

/**
 * Phones and small tablets (under Tailwind's `lg`, 1024 px): the Director goes full screen like a camera app, the stage
 * edge to edge with its controls floating over it. "portrait" or "landscape"; null on a bigger screen (and on the server).
 */
export type PhoneLayout = "portrait" | "landscape" | null;

const NARROW = "(max-width: 1023.98px)";
const SIDEWAYS = "(orientation: landscape)";

function subscribe(change: () => void) {
  const queries = [window.matchMedia(NARROW), window.matchMedia(SIDEWAYS)];
  for (const q of queries) q.addEventListener("change", change);
  return () => {
    for (const q of queries) q.removeEventListener("change", change);
  };
}

function snapshot(): PhoneLayout {
  if (!window.matchMedia(NARROW).matches) return null;
  return window.matchMedia(SIDEWAYS).matches ? "landscape" : "portrait";
}

export function usePhoneLayout(): PhoneLayout {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
