"use client";

import { create } from "zustand";

/**
 * Which take is open in the before/after viewer (null = the live camera view), and whether the takes library is open on
 * the camera's screen (`library`): "Use this setup" closes both, so you land on the camera with the set it brought back.
 */
export const useTakeView = create<{ viewing: string | null; output: number; seen: string[]; library: boolean }>(() => ({ viewing: null, output: 0, seen: [], library: false }));

/** Whose takes the Director shows: a Storyboard project's only while it's open in Storyboard, else every take. */
export const useTakesFrom = create<{ project: string | null }>(() => ({ project: null }));

export function openTake(id: string) {
  useTakeView.setState((s) => ({ viewing: id, output: 0, seen: s.seen.includes(id) ? s.seen : [...s.seen, id] }));
}

export function closeTake() {
  useTakeView.setState({ viewing: null, output: 0 });
}

export function openLibrary() {
  useTakeView.setState({ library: true });
}

export function closeLibrary() {
  useTakeView.setState({ library: false });
}
