"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Carries a draft (words + reference images) from one tool to another, e.g. Home → Director. */
export type Handoff = {
  prompt: string;
  references: { url: string; name: string }[];
  aspect?: string;
  from?: string;
};

type HandoffState = {
  draft: Handoff | null;
  send: (draft: Handoff) => void;
  take: () => Handoff | null;
};

export const useHandoff = create<HandoffState>()(
  persist(
    (set, get) => ({
      draft: null,
      send: (draft) => set({ draft }),
      take: () => {
        const d = get().draft;
        set({ draft: null });
        return d;
      },
    }),
    { name: "crackio-handoff", storage: createJSONStorage(() => sessionStorage) },
  ),
);
