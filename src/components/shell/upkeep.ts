"use client";

import { useEffect } from "react";
import { useLibrary } from "@/lib/hooks/use-library";

/** Whether an element is rendered at all (a page Next keeps hidden is display: none all the way down). */
const rendered = (el: Element) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0);

/**
 * Next keeps the last few pages you visited mounted but hidden, so going back is instant and keeps
 * your place. Hidden isn't stopped, though: a clip still playing there keeps decoding, and its sound
 * keeps going, on a page you can't see. After every navigation, whatever plays out of sight pauses
 * (where you were in it stays); thumbnails start again by themselves when their page is back.
 */
export function usePauseHiddenMedia(pathname: string) {
  useEffect(() => {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((m) => {
      // An <audio> without controls has no box of its own: its parent tells whether its page is up.
      const box = m instanceof HTMLAudioElement && !m.controls ? (m.parentElement ?? m) : m;
      if (!m.paused && !rendered(box)) m.pause();
    });
  }, [pathname]);
}

/** The Library's folders and every take, fetched once ahead of opening it (the server readies their light copies). */
export function warmLibrary() {
  if (!useLibrary.getState().loaded) void useLibrary.getState().load();
}

/**
 * Quietly fetch what the Library shows, so opening it is instant: right away when you point at it in the rail
 * (warmLibrary), else once the first page has long settled, so it never competes with that page's own pictures and
 * data. The pages themselves are prefetched by the rail's links in production.
 */
export function useWarmup() {
  useEffect(() => {
    let idle: number | undefined;
    const t = setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(warmLibrary, { timeout: 8000 });
      else warmLibrary();
    }, 9000);
    return () => {
      clearTimeout(t);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, []);
}
