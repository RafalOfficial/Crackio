"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

type ShellState = {
  collapsed: boolean;
  mobileOpen: boolean;
  dismissedTips: string[];
  toggleCollapsed: () => void;
  setMobileOpen: (open: boolean) => void;
  dismissTip: (id: string) => void;
};

export const useShell = create<ShellState>()(
  persist(
    (set) => ({
      collapsed: false,
      mobileOpen: false,
      dismissedTips: [],
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setMobileOpen: (mobileOpen) => set({ mobileOpen }),
      dismissTip: (id) => set((s) => ({ dismissedTips: [...s.dismissedTips, id] })),
    }),
    {
      name: "crackio-shell",
      partialize: (s) => ({ collapsed: s.collapsed, dismissedTips: s.dismissedTips }),
      // Rehydrate after mount so the first client render matches the server HTML.
      skipHydration: true,
    },
  ),
);
