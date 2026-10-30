"use client";

import { create } from "zustand";

/** Lets other parts of a page drop text into the composer ("use this prompt"). */
export const useComposerBridge = create<{
  pending: { prompt: string; aspect?: string } | null;
  push: (p: { prompt: string; aspect?: string }) => void;
  consume: () => { prompt: string; aspect?: string } | null;
}>((set, get) => ({
  pending: null,
  push: (pending) => set({ pending }),
  consume: () => {
    const p = get().pending;
    if (p) set({ pending: null });
    return p;
  },
}));
