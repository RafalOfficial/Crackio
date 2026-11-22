"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

type ShellState = {
  /** Always false: the rail has one width now. Kept so older readers (the Library's dock) still compile. */
  collapsed: boolean;
  mobileOpen: boolean;
  dismissedTips: string[];
  setMobileOpen: (open: boolean) => void;
  dismissTip: (id: string) => void;
};

export const useShell = create<ShellState>()(
  persist(
    (set) => ({
      collapsed: false,
      mobileOpen: false,
      dismissedTips: [],
      setMobileOpen: (mobileOpen) => set({ mobileOpen }),
      dismissTip: (id) => set((s) => ({ dismissedTips: [...s.dismissedTips, id] })),
    }),
    {
      name: "crackio-shell",
      partialize: (s) => ({ dismissedTips: s.dismissedTips }),
      // Only the tips come back: a "collapsed" kept from the old sidebar mustn't return.
      merge: (kept, current) => ({
        ...current,
        dismissedTips: Array.isArray((kept as { dismissedTips?: unknown } | undefined)?.dismissedTips)
          ? (kept as { dismissedTips: string[] }).dismissedTips
          : current.dismissedTips,
      }),
      // Rehydrate after mount so the first client render matches the server HTML.
      skipHydration: true,
    },
  ),
);
