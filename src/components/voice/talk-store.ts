"use client";

import { create } from "zustand";

export type TalkPhase = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking";

/**
 * What a live talk shows outside its bar: its phase (the orb's ring breathes while it hears and thinks) and how loud it
 * is right now, your voice or its own (the orb and the backdrop move with it). Kept out of React's state so only what
 * listens re-renders, not the page.
 */
export const useTalkState = create<{ phase: TalkPhase; level: number }>(() => ({ phase: "off", level: 0 }));
