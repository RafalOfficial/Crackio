"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CrackioEvent } from "@/lib/setup/types";

/**
 * Notifications from Crackio while you're elsewhere: a long take done (or failed), a set-up ended, a rented box that
 * stopped itself, credit about to run out. Your browser shows them (Settings → Preferences turns them on); this looks for
 * news every 10 seconds and, for takes and set-ups, only speaks up while Crackio's window isn't the one you're in.
 * Each event's id is its notification tag, so two open tabs never show the same one twice. Stored per browser.
 */

export type NotifyPrefs = { on: boolean; takes: boolean; setups: boolean; money: boolean };
const KEY = "crackio:notify";
const DEFAULTS: NotifyPrefs = { on: false, takes: true, setups: true, money: true };
export const NOTIFY_EVENT = "crackio:notify";

export function readNotify(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function writeNotify(p: NotifyPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private windows: on for this page only.
  }
  window.dispatchEvent(new Event(NOTIFY_EVENT));
}

/** The prefs as they're saved in this browser, following changes from this tab and others. */
export function useNotifyPrefs(): NotifyPrefs {
  const raw = useSyncExternalStore(
    (changed) => {
      window.addEventListener(NOTIFY_EVENT, changed);
      window.addEventListener("storage", changed);
      return () => {
        window.removeEventListener(NOTIFY_EVENT, changed);
        window.removeEventListener("storage", changed);
      };
    },
    () => {
      try {
        return localStorage.getItem(KEY) ?? "";
      } catch {
        return "";
      }
    },
    () => "",
  );
  return useMemo(() => {
    try {
      return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<NotifyPrefs>) : {}) };
    } catch {
      return DEFAULTS;
    }
  }, [raw]);
}

/** Notifications can show here: the browser has them, the page is https (or this computer), and you allowed them. */
export const canNotify = () => typeof window !== "undefined" && "Notification" in window && window.isSecureContext && Notification.permission === "granted";

export function showNotification(title: string, opts: { body?: string; tag?: string; icon?: string; href?: string } = {}) {
  if (!canNotify()) return;
  const n = new Notification(title, { body: opts.body, tag: opts.tag, icon: opts.icon ?? "/apple-icon.png" });
  n.onclick = () => {
    window.focus();
    if (opts.href) window.location.assign(opts.href);
    n.close();
  };
}

const wants = (p: NotifyPrefs, e: CrackioEvent) => (e.kind === "take" ? p.takes : e.kind === "setup" ? p.setups : p.money);

export function Notifier() {
  useEffect(() => {
    let since = Date.now();
    let gone = false;
    let timer: number | undefined;
    const look = async () => {
      const p = readNotify();
      if (p.on && canNotify()) {
        const res = await fetch(`/api/settings/events?since=${since}`, { cache: "no-store" }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { events?: CrackioEvent[]; now?: number } | null;
        if (!gone && body?.events) {
          // You're in Crackio's window: takes and set-ups show there already.
          const away = !document.hasFocus();
          for (const e of [...body.events].reverse()) {
            if (!wants(p, e) || (!away && (e.kind === "take" || e.kind === "setup"))) continue;
            showNotification(e.title, { body: e.body, tag: e.id, icon: e.icon, href: e.href });
          }
          since = Math.max(since, body.now ?? since, ...body.events.filter((e) => e.kind !== "credit").map((e) => e.at));
        }
      } else {
        // Off: nothing from before turning it on comes in a flood later.
        since = Date.now();
      }
      if (!gone) timer = window.setTimeout(() => void look(), 10_000);
    };
    timer = window.setTimeout(() => void look(), 10_000);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
