"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether a sheet covers the page (the model library): Home's moving parts (the hero's frames, the showcase rail) hold
 * still under it, so the glass over them has nothing to redraw and nothing moves behind what you're choosing.
 */
const EVENT = "crackio:overlay";
let covering = 0;

export const overlayOpen = () => covering > 0;

/** Hear when a sheet opens or closes over the page. */
export function onOverlay(changed: () => void) {
  window.addEventListener(EVENT, changed);
  return () => window.removeEventListener(EVENT, changed);
}

/** Marks the page as covered while `on`. */
export function useCoverPage(on: boolean) {
  useEffect(() => {
    if (!on) return;
    covering += 1;
    window.dispatchEvent(new Event(EVENT));
    return () => {
      covering = Math.max(0, covering - 1);
      window.dispatchEvent(new Event(EVENT));
    };
  }, [on]);
}

export function useOverlayOpen() {
  return useSyncExternalStore(onOverlay, overlayOpen, () => false);
}
