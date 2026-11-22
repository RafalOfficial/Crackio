"use client";

import { create } from "zustand";

/**
 * The one line at the top of the stage: what just happened, what's loading, what didn't work and why, or what to do
 * next. Nothing fails silently (the winner's rule); the line never blocks anything.
 */
export type NoticeKind = "done" | "info" | "warn" | "stop" | "busy";

type Notice = { text: string | null; kind: NoticeKind; id: number };

export const useNotice = create<Notice>(() => ({ text: null, kind: "info", id: 0 }));

let timer: ReturnType<typeof setTimeout> | null = null;

/** Show a line for `ms` (2 s after the last time it was asked for); the same line again just keeps it up. */
export function notice(text: string, kind: NoticeKind = "info", ms = 2000) {
  const cur = useNotice.getState();
  if (cur.text !== text || cur.kind !== kind) useNotice.setState({ text, kind, id: cur.id + 1 });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    useNotice.setState({ text: null });
  }, ms);
}
