"use client";

import { useSyncExternalStore } from "react";
import { MOTION_KEY } from "./motion-script";

/**
 * How much Crackio moves (Settings → Preferences), kept in this browser:
 * - "system": follow the system's reduce-motion switch. With it on, nothing slides, zooms or loops, but state changes
 *   still fade, so the interface doesn't snap like it's broken.
 * - "full": everything moves, whatever the system says (Windows turns reduce-motion on when its animation effects are off).
 * - "calm": as little motion as possible, on any system.
 * app/layout.tsx sets html[data-motion] from it before the first paint; globals.css and ShellFrame's MotionConfig read it.
 */
export type MotionPref = "system" | "full" | "calm";

const listeners = new Set<() => void>();

const read = (): MotionPref => {
  if (typeof document === "undefined") return "system";
  const m = document.documentElement.dataset.motion;
  return m === "full" || m === "calm" ? m : "system";
};

const apply = (pref: MotionPref) => {
  if (pref === "system") delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = pref;
  for (const listener of listeners) listener();
};

export function motionPref(): MotionPref {
  return read();
}

export function setMotionPref(pref: MotionPref) {
  try {
    if (pref === "system") localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, pref);
  } catch {
    /* private mode: it lasts for this page */
  }
  apply(pref);
}

let syncing = false;
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it: this one follows.
  if (!syncing && typeof window !== "undefined") {
    syncing = true;
    window.addEventListener("storage", (e) => {
      if (e.key !== MOTION_KEY) return;
      const m = e.newValue;
      apply(m === "full" || m === "calm" ? m : "system");
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useMotionPref(): MotionPref {
  return useSyncExternalStore(subscribe, read, () => "system");
}

/** Whether to leave movement out right now (Calm, or System with the system's reduce on): for motion made in code. */
export function calmNow(): boolean {
  const pref = read();
  if (pref === "calm") return true;
  if (pref === "full") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
