"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DEMO } from "./config";

/** Who's signed in to the live demo and what they have left, shared by the strip and the sign-in page. */
export type DemoSession = { loaded: boolean; signedIn: boolean; credits: number; label: string | null; running: boolean };

let state: DemoSession = { loaded: false, signedIn: false, credits: 0, label: null, running: false };
const listeners = new Set<() => void>();
const set = (next: Partial<DemoSession>) => {
  state = { ...state, ...next, loaded: true };
  for (const l of listeners) l();
};

export async function refreshDemoSession() {
  if (!DEMO) return;
  const r = await fetch("/api/demo/session", { cache: "no-store" }).catch(() => null);
  const body = r?.ok ? ((await r.json().catch(() => null)) as Partial<DemoSession> | null) : null;
  if (!body) return;
  const was = state.running;
  set({ signedIn: Boolean(body.signedIn), credits: Number(body.credits) || 0, label: body.label ?? null, running: Boolean(body.running) });
  // A job just ended: what it really cost (or its refund) is settled a moment after, so look again.
  if (was && !state.running) setTimeout(() => void refreshDemoSession(), 1500);
}

/** Tries a code; null when it worked, else the reason. */
export async function signInDemo(code: string): Promise<string | null> {
  const r = await fetch("/api/demo/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
  const body = (await r?.json().catch(() => null)) as (Partial<DemoSession> & { error?: string }) | null;
  if (!r?.ok) return body?.error ?? "Couldn't reach the demo. Try again.";
  set({ signedIn: true, credits: Number(body?.credits) || 0, label: body?.label ?? null, running: false });
  return null;
}

export async function signOutDemo() {
  await fetch("/api/demo/session", { method: "DELETE" }).catch(() => null);
  set({ signedIn: false, credits: 0, label: null, running: false });
}

export function useDemoSession(): DemoSession {
  const snapshot = useSyncExternalStore(
    useCallback((l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }, []),
    () => state,
    () => state,
  );
  // Credits change as jobs run: check now, every 3 s while one of yours runs (so its charge or refund shows the moment
  // it ends), every 20 s otherwise, and on coming back to the tab.
  useEffect(() => {
    if (!DEMO) return;
    void refreshDemoSession();
    let last = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!state.running && Date.now() - last < 20_000) return;
      last = Date.now();
      void refreshDemoSession();
    }, 3000);
    const onFocus = () => void refreshDemoSession();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return snapshot;
}
