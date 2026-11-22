"use client";

import { create } from "zustand";

/**
 * What the Director is building for the set right now (the place, its world, an extend, things lifted out of the
 * photo), and how long that usually takes here. Plain state with no three.js in it: pages that only need to know whether
 * the Director is busy (Storyboard's editor) read it from here without pulling in the 3D code. The work itself lives in
 * around.ts, lift.ts, extend.ts and location.ts, which re-export these.
 */

/**
 * A model step's failure in words a person can act on: with no GPU ready (none connected yet, or the model isn't on
 * any of them) the server's own words ("Unknown model …") meant nothing to anyone (Director v2's first test).
 */
export function friendlyModelError(message: string) {
  if (/unknown model|isn.t ready|isn.t answering|not ready|no (picture|image|edit) model|not answering|offline|econnrefused|fetch failed|no machine|couldn.t reach|nothing to run/i.test(message))
    return "This needs a GPU, and none is ready yet. Connect one (Settings shows them), then try again.";
  return message;
}

/** The place all around built view by view (around.ts `buildAround`). */
export const useAround = create<{ busy: boolean; done: number; total: number; error: string | null }>(() => ({ busy: false, done: 0, total: 0, error: null }));

/** The place's 360 world being drawn or measured (around.ts `buildWorld`, `measureWorld`). */
export const useWorld = create<{ busy: boolean; error: string | null; measuring: boolean }>(() => ({ busy: false, error: null, measuring: false }));

/** Bumped when the measuring changes: worlds measured before are measured again. */
export const WORLD_DEPTH_VERSION = 8;

/** The cars, people and things of a place photo being lifted onto the set (lift.ts), or why that failed. */
export const useLift = create<{ busy: string | null; error: string | null }>(() => ({ busy: null, error: null }));

/** An extend in progress (what it's doing), or why it couldn't be done (extend.ts). */
export const useExtend = create<{ stage: string | null; error: string | null }>(() => ({ stage: null, error: null }));

/** A place being made from words (location.ts), when it started, or why it couldn't be. */
export const useLocation = create<{ busy: boolean; error: string | null; since: number | null; words: string }>(() => ({ busy: false, error: null, since: null, words: "" }));

/** "about 50 s", "about 1 min", "about 2½ min". */
export function aboutTime(seconds: number) {
  if (seconds < 75) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} s`;
  const halves = Math.round(seconds / 30);
  return `about ${Math.floor(halves / 2) || ""}${halves % 2 ? "½" : ""} min`;
}

/** How long a new place usually takes here (seconds: its photo, its world), from the runs the server kept. */
export const useTypical = create<{ photo: number | null; world: number | null; loaded: boolean }>(() => ({ photo: null, world: null, loaded: false }));

export function loadTypical() {
  if (useTypical.getState().loaded) return;
  useTypical.setState({ loaded: true });
  void fetch("/api/director/world")
    .then((r) => r.json())
    .then((t: { photo?: number | null; world?: number | null }) => useTypical.setState({ photo: t.photo ?? null, world: t.world ?? null }))
    .catch(() => undefined);
}

/** When the world being built started (for its elapsed time and progress), set by around.ts. */
export const useWorldClock = create<{ since: number | null }>(() => ({ since: null }));
