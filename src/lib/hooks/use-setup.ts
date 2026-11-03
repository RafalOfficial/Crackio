"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { KitId, SetupJob, SetupSnapshot } from "@/lib/setup/types";
import { reloadLocal } from "./use-local";
import { revalidateModels } from "./use-models";
import { useVoiceStore } from "./use-voice";
import { useLipsyncStore } from "./use-lipsync";
import { refreshConnections } from "./use-connections";

/**
 * Settings' look at every machine and tool (GET /api/setup), shared by every part of the app that shows set-up state.
 * Polled only while something on screen shows it and the tab is visible: every 2 s while a set-up or download runs,
 * else every 12 s. When a set-up finishes, every other store that shows models or machines looks again (here and in
 * other tabs), so a model installed from Settings is in the pickers at once.
 */
type SetupState = {
  snap: SetupSnapshot | null;
  error: string | null;
  reload: (fresh?: boolean) => Promise<void>;
};

const SESSION_KEY = "crackio:setup-snapshot";

function kept(): SetupSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SetupSnapshot) : null;
  } catch {
    return null;
  }
}

export const useSetupStore = create<SetupState>((set, get) => ({
  // Filled from this tab's last look after hydration (useSetup), so the server and first client render agree.
  snap: null,
  error: null,
  reload: async (fresh = false) => {
    try {
      const res = await fetch(`/api/setup${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (SetupSnapshot & { error?: string }) | null;
      if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const before = get().snap;
      set({ snap: body, error: null });
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(body));
      } catch {
        // Private windows: keep going without it.
      }
      if (finishedSince(before, body)) announce();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));

/** A set-up that was running is finished now. */
function finishedSince(before: SetupSnapshot | null, now: SetupSnapshot) {
  if (!before) return false;
  const was = new Set(before.jobs.filter((j) => j.state === "running" || j.state === "queued").map((j) => j.id));
  return now.jobs.some((j) => was.has(j.id) && j.finishedAt);
}

let channel: BroadcastChannel | null = null;
function bus() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel("crackio-setup");
    channel.onmessage = () => refreshEverything(false);
  }
  return channel;
}

/** Every store that shows machines, models or set-up state looks again. */
function refreshEverything(own = true) {
  void reloadLocal();
  revalidateModels(0);
  void useVoiceStore.getState().loadMachines(true);
  void useLipsyncStore.getState().load(true);
  void refreshConnections();
  if (own) void useSetupStore.getState().reload(true);
}

/** Something changed what's installed: this tab and the others look again. */
export function announce() {
  refreshEverything();
  bus()?.postMessage("changed");
}

const busy = (s: SetupSnapshot | null) =>
  Boolean(s?.jobs.some((j) => j.state === "running" || j.state === "queued") || s?.machines.some((m) => m.downloads.count > 0));

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!watchers) return;
  timer = setTimeout(
    () => {
      if (document.visibilityState === "hidden") return schedule();
      void useSetupStore.getState().reload().finally(schedule);
    },
    busy(useSetupStore.getState().snap) ? 2000 : 12000,
  );
}

/** The snapshot, loaded and kept fresh while `watch`. */
export function useSetup(watch = true) {
  useEffect(() => {
    if (!watch) return;
    watchers++;
    bus();
    if (!useSetupStore.getState().snap) {
      const last = kept();
      if (last) useSetupStore.setState({ snap: last });
    }
    void useSetupStore.getState().reload().finally(schedule);
    const back = () => {
      if (document.visibilityState === "visible") void useSetupStore.getState().reload().finally(schedule);
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      watchers--;
      if (!watchers && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [watch]);
  return useSetupStore();
}

/** Starts setting tools up on a machine. The error to show, or null. */
export async function setUp(
  machine: string,
  kits: KitId[],
  include?: string[],
  /** Models picked by requirement ("video.model"), instead of Crackio's picks. */
  choices?: Record<string, { model: string; variant: string }>,
): Promise<{ job: SetupJob | null; error: string | null }> {
  const res = await fetch("/api/setup/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine, kits, include, choices }),
  }).catch(() => null);
  if (!res) return { job: null, error: "Crackio didn't answer." };
  const body = (await res.json().catch(() => ({}))) as { job?: SetupJob; error?: string };
  void useSetupStore.getState().reload(true).finally(schedule);
  return res.ok && body.job ? { job: body.job, error: null } : { job: null, error: body.error ?? "That didn't start." };
}

/** Stops a set-up. */
export async function stopSetUp(id: string) {
  await fetch(`/api/setup/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  void useSetupStore.getState().reload(true).finally(schedule);
}
