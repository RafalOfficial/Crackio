"use client";

import { create } from "zustand";

/** Which take is open in the before/after viewer (null = the live camera view). */
export const useTakeView = create<{ viewing: string | null; output: number; seen: string[] }>(() => ({ viewing: null, output: 0, seen: [] }));

export function openTake(id: string) {
  useTakeView.setState((s) => ({ viewing: id, output: 0, seen: s.seen.includes(id) ? s.seen : [...s.seen, id] }));
}

export function closeTake() {
  useTakeView.setState({ viewing: null, output: 0 });
}
