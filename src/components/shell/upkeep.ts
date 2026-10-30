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

/**
 * Once the first page has settled, quietly fetch what the other tabs show, so opening them is
 * instant: the Library's folders and every take (the server gets their light copies ready
 * meanwhile). The pages themselves are prefetched by the sidebar's links in production.
 */
export function useWarmup() {
  useEffect(() => {
    let idle: number | undefined;
    const go = () => {
      if (!useLibrary.getState().loaded) void useLibrary.getState().load();
    };
    const t = setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(go, { timeout: 5000 });
      else go();
    }, 2500);
    return () => {
      clearTimeout(t);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, []);
}
