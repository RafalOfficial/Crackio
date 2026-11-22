"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { KitId, SetupJob, SetupSnapshot } from "@/lib/setup/types";
import { reloadLocal, useLocalStore } from "./use-local";
import { revalidateModels } from "./use-models";
import { useVoiceStore } from "./use-voice";
import { useLipsyncStore } from "./use-lipsync";
import { refreshConnections } from "./use-connections";

/**
 * Settings' look at every machine and tool (GET /api/setup), shared by every part of the app that shows set-up state.
 * Polled only while something on screen shows it and the tab is visible: every 2 s while a set-up or download runs,
 * else every 12 s. One look at a time for the whole page (Settings' rail, its page and the sidebar's lamp share it), and
 * a look that finds nothing new leaves the snapshot as it is, so nothing that reads it draws again; the server says
 * "nothing new" with an empty answer (ETag, 304). Only Settings → Tools reads each part's model options, so every other
 * page asks for the light snapshot without them (?lite=1). When a set-up finishes, every other store that shows models or
 * machines looks again (here and in other tabs), so a model installed from Settings is in the pickers at once.
 */
type SetupState = {
  snap: SetupSnapshot | null;
  error: string | null;
  /** When Crackio last looked. The snapshot itself only changes when something in it does. */
  checkedAt: number;
  reload: (fresh?: boolean) => Promise<void>;
};

/** The last look, kept in this browser: a new tab or a reload shows it at once (with its time) while the next answers. */
const KEPT_KEY = "crackio:setup-snapshot";
/** A kept look older than this isn't shown: machines come and go. */
const KEPT_FOR = 15 * 60_000;

function kept(): SetupSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEPT_KEY) ?? sessionStorage.getItem(KEPT_KEY);
    const snap = raw ? (JSON.parse(raw) as SetupSnapshot) : null;
    return snap && Array.isArray(snap.machines) && Date.now() - snap.at < KEPT_FOR ? snap : null;
  } catch {
    return null;
  }
}

let keepTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes the snapshot to storage at most every 10 s: rewriting ~150 KB on every 2 s poll while things install isn't free. */
function keep() {
  if (keepTimer) return;
  keepTimer = setTimeout(() => {
    keepTimer = null;
    const { snap, checkedAt } = useSetupStore.getState();
    if (!snap) return;
    try {
      localStorage.setItem(KEPT_KEY, JSON.stringify({ ...snap, at: checkedAt || snap.at }));
    } catch {
      // Private windows or full storage: the next tab waits for its first look.
    }
  }, 10_000);
}

/** A snapshot's contents without the time of the look, to tell whether anything in it changed. */
const shape = (s: SetupSnapshot) => JSON.stringify({ ...s, at: 0 });

let lastShape = "";
/** Watchers that need each part's model options (Settings → Tools): while there are none, the light snapshot is enough. */
let fullWatchers = 0;
/** Whether the snapshot held has the options, and each form's last ETag (the server answers 304 to it when nothing changed). */
let heldFull = false;
/** The form the last look asked for: a light one that answers after the Tools page opened is followed by a full one at once. */
let lastForm: "lite" | "full" = "lite";
const tags: Record<"lite" | "full", string | null> = { lite: null, full: null };
/** The look in flight, shared by every ask while it's out (a fresh ask waits for a fresh look). */
let inflight: { fresh: boolean; done: Promise<void> } | null = null;
/** When the last look answered; mounts and tab returns within a few seconds of it don't ask again. */
let lookedAt = 0;
let asked = 0;
let applied = 0;

export const useSetupStore = create<SetupState>((set, get) => {
  const look = async (fresh: boolean) => {
    const mine = ++asked;
    const form = fullWatchers ? "full" : "lite";
    lastForm = form;
    try {
      const query = new URLSearchParams({ ...(form === "lite" ? { lite: "1" } : {}), ...(fresh ? { fresh: "1" } : {}) }).toString();
      // The ETag only stands for what this tab holds: a snapshot of the same form, as it last came.
      const tag = get().snap && heldFull === (form === "full") && !get().error ? tags[form] : null;
      const res = await fetch(`/api/setup${query ? `?${query}` : ""}`, { cache: "no-store", headers: tag ? { "If-None-Match": tag } : undefined });
      if (res.status === 304) {
        if (mine < applied) return;
        applied = mine;
        lookedAt = Date.now();
        set({ checkedAt: lookedAt });
        return;
      }
      const body = (await res.json().catch(() => null)) as (SetupSnapshot & { error?: string }) | null;
      if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
      // An older look answering after a newer one (a fresh ask overtook it) doesn't put old news back.
      if (mine < applied) return;
      applied = mine;
      lookedAt = Date.now();
      tags[form] = res.headers.get("etag");
      const before = get().snap;
      const now = shape(body);
      if (before && now === lastShape && !get().error) {
        if (form === "full") heldFull = true;
        set({ checkedAt: body.at });
      } else {
        lastShape = now;
        heldFull = form === "full";
        set({ snap: body, error: null, checkedAt: body.at });
        keep();
      }
      if (finishedSince(before, body)) announce();
    } catch (err) {
      const message = (err as Error).message;
      if (get().error !== message) set({ error: message });
    }
  };
  return {
    // Filled from this browser's last look after hydration (useSetup), so the server and first client render agree.
    snap: null,
    error: null,
    checkedAt: 0,
    reload: (fresh = false) => {
      if (inflight && (inflight.fresh || !fresh)) return inflight.done;
      const done: Promise<void> = look(fresh).finally(() => {
        if (inflight?.done === done) inflight = null;
        // A light look was on its way when the Tools page opened, and the page joined it: its model choices are asked for
        // now, not at the next poll 12 s later (its sheet showed a model part without its models until then).
        if (fullWatchers && lastForm === "lite" && !heldFull) void get().reload();
      });
      inflight = { fresh, done };
      return done;
    },
  };
});

/** A set-up that was running is finished now. */
function finishedSince(before: SetupSnapshot | null, now: SetupSnapshot) {
  if (!before) return false;
  const was = new Set(before.jobs.filter((j) => j.state === "running" || j.state === "queued").map((j) => j.id));
  return now.jobs.some((j) => was.has(j.id) && j.finishedAt);
}

/** Another tab finished something while this one was in the background: it looks again once it's back in view. */
let missed = false;

let channel: BroadcastChannel | null = null;
function bus() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel("crackio-setup");
    channel.onmessage = () => {
      if (document.visibilityState === "visible") refreshEverything(false);
      else missed = true;
    };
  }
  return channel;
}

/**
 * Every store that shows machines, models or set-up state looks again. The tab where it happened (`own`) asks the
 * machines afresh; other tabs reuse what the server just learned. A store nothing on this page has loaded is left alone.
 */
function refreshEverything(own = true) {
  if (useLocalStore.getState().status) void reloadLocal();
  revalidateModels(0);
  if (useVoiceStore.getState().machinesLoaded) void useVoiceStore.getState().loadMachines(own);
  if (useLipsyncStore.getState().loaded) void useLipsyncStore.getState().load(own);
  void refreshConnections();
  if (watchers || useSetupStore.getState().snap) void useSetupStore.getState().reload(own).finally(schedule);
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

let listening = false;

/** One listener for the whole page: back in view, look again unless a look just answered. */
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (missed) {
      missed = false;
      refreshEverything(false);
    } else if (watchers && Date.now() - lookedAt > 5_000) void useSetupStore.getState().reload().finally(schedule);
  });
}

/**
 * The snapshot, loaded and kept fresh while `watch`. `full`: this page reads each part's model options (Settings →
 * Tools' sheet and model chooser); everywhere else the light snapshot is asked for.
 */
export function useSetup(watch = true, { full = false }: { full?: boolean } = {}) {
  useEffect(() => {
    if (!watch) return;
    watchers++;
    if (full) fullWatchers++;
    bus();
    listen();
    if (!useSetupStore.getState().snap) {
      const last = kept();
      if (last) {
        lastShape = shape(last);
        heldFull = false;
        useSetupStore.setState({ snap: last, checkedAt: last.at });
      }
    }
    // A look that just answered (another part of this page, or the page before) is fresh enough: no second ask. A page
    // that needs the options and holds the light snapshot asks at once.
    if (Date.now() - lookedAt > 5_000 || (full && !heldFull)) void useSetupStore.getState().reload().finally(schedule);
    else if (!timer) schedule();
    return () => {
      watchers--;
      if (full) fullWatchers--;
      if (!watchers && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [watch, full]);
  return useSetupStore(useShallow((s) => ({ snap: s.snap, error: s.error, reload: s.reload })));
}

/** Starts setting tools up on a machine. The error to show, or null. */
export async function setUp(
  machine: string,
  kits: KitId[],
  include?: string[],
  /** Models picked by requirement ("video.model"), instead of Crackio's picks. */
  choices?: Record<string, { model: string; variant: string }>,
  /** Just these requirements, and nothing else the tools need (an add-on by itself). */
  only?: string[],
): Promise<{ job: SetupJob | null; error: string | null }> {
  // What you see is what gets installed. Every model part goes with the pick this screen shows: yours, or Crackio's
  // suggestion as it stood when you pressed. Left out, the server made its own pick again at that moment, from the GPU
  // memory free right then, and installed another model than the one named (LTX-2.5 shown, Wan 2.2 5B installed).
  const shown: Record<string, { model: string; variant: string }> = {};
  const here = useSetupStore.getState().snap?.machines.find((x) => x.id === machine);
  for (const kit of kits) {
    for (const r of here?.tools[kit]?.reqs ?? []) {
      if (only && !only.includes(r.id)) continue;
      if (r.optional && !include?.includes(r.id) && !only?.includes(r.id)) continue;
      const p = r.plan;
      if (p?.kind !== "model" || (r.state !== "missing" && r.state !== "needs-key")) continue;
      // (The plan alone names it: the light snapshot other screens hold, and this one for its first seconds, has no
      // list of choices. The server checks the pick against the machine and refuses one it can't use there.)
      shown[r.id] = { model: p.model, variant: p.variant };
    }
  }
  const sent = { ...shown, ...choices };
  const res = await fetch("/api/setup/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine, kits, include, choices: Object.keys(sent).length ? sent : undefined, only }),
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
