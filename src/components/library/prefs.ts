"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Density } from "./rows";

export type Sort = "new" | "old";

type Prefs = {
  /** How big the takes are in the grid. */
  density: Density;
  sort: Sort;
  /** The viewer's details panel. */
  info: boolean;
  /** Clips in the viewer play with sound unless you muted them. */
  muted: boolean;
  set: (patch: Partial<Omit<Prefs, "set">>) => void;
};

/** How you like the Library, kept on this computer. */
export const useLibraryPrefs = create<Prefs>()(
  persist(
    (set) => ({
      density: "m",
      sort: "new",
      info: true,
      muted: false,
      set: (patch) => set(patch),
    }),
    {
      name: "crackio-library",
      partialize: ({ density, sort, info, muted }) => ({ density, sort, info, muted }),
      // Rehydrate after mount so the first client render matches the server HTML.
      skipHydration: true,
    },
  ),
);
