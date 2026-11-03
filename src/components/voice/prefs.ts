"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { voiceModel, type VoiceModelId } from "@/lib/voice/models";

type VoicePrefs = {
  model: VoiceModelId;
  /** The voice for a single speaker. */
  voice: string;
  /** How it's said, in words. */
  direction: string;
  /** 0 steady, 1 natural, 2 lively. */
  lively: number;
  language: string;
  /** The language Talk hears you in (a code), or "auto" to work it out each time. */
  hears: string;
  set: (patch: Partial<Omit<VoicePrefs, "set">>) => void;
};

/** Voice's last choices, kept on this computer. */
export const useVoicePrefs = create<VoicePrefs>()(
  persist(
    (set) => ({
      model: "local:voice:drama3",
      voice: "mara",
      direction: "Warm and a little tired, smiling through it",
      lively: 1,
      language: "auto",
      hears: "en",
      set: (patch) => set(patch),
    }),
    {
      name: "crackio-voice",
      partialize: ({ model, voice, direction, lively, language, hears }) => ({ model, voice, direction, lively, language, hears }),
      // A model Crackio no longer offers falls back to the default.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<VoicePrefs>;
        return { ...current, ...s, model: s.model && voiceModel(s.model) ? s.model : current.model };
      },
      // Rehydrate after mount so the first client render matches the server HTML.
      skipHydration: true,
    },
  ),
);
