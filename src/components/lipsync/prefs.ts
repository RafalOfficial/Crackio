"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { voiceModel, type VoiceModelId } from "@/lib/voice/models";

type LipsyncPrefs = {
  /** The speech model that says the new words (one that can clone). */
  model: VoiceModelId;
  /** Who says them: "clone" (the clip's own speaker) or one of the voices' ids. */
  voice: string;
  /** How the new mouths are drawn: LatentSync alone, or LatentSync then HuMo 17B (their own teeth and lips). */
  quality: "standard" | "best";
  set: (patch: Partial<Omit<LipsyncPrefs, "set">>) => void;
};

/** Lip Sync's last choices, kept on this computer. Permission to clone is never kept: it's given for each clip. */
export const useLipsyncPrefs = create<LipsyncPrefs>()(
  persist(
    (set) => ({
      model: "local:voice:drama3",
      voice: "clone",
      quality: "standard",
      set: (patch) => set(patch),
    }),
    {
      name: "crackio-lipsync",
      partialize: ({ model, voice, quality }) => ({ model, voice, quality }),
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<LipsyncPrefs>;
        const m = s.model ? voiceModel(s.model) : null;
        return { ...current, ...s, model: m?.can.clone ? m.id : current.model, quality: s.quality === "best" ? "best" : "standard" };
      },
      skipHydration: true,
    },
  ),
);
