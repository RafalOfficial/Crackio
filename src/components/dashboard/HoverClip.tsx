"use client";

import { useEffect, useRef } from "react";

/**
 * A card's clip, played over its still while the card is hovered or focused. It only loads on
 * the first hover, so the dashboard stays light.
 */
export function HoverClip({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    const card = v?.closest("a");
    if (!v || !card) return;
    const play = () => {
      v.preload = "auto";
      v.currentTime = 0;
      void v
        .play()
        .then(() => v.setAttribute("data-playing", ""))
        .catch(() => {});
    };
    const stop = () => {
      v.pause();
      v.removeAttribute("data-playing");
    };
    card.addEventListener("pointerenter", play);
    card.addEventListener("pointerleave", stop);
    card.addEventListener("focus", play);
    card.addEventListener("blur", stop);
    return () => {
      card.removeEventListener("pointerenter", play);
      card.removeEventListener("pointerleave", stop);
      card.removeEventListener("focus", play);
      card.removeEventListener("blur", stop);
      // Clicking the card leaves the page with the pointer still on it: don't keep playing out of sight.
      stop();
    };
  }, []);
  return (
    <video
      ref={video}
      src={src}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      className="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-500 data-[playing]:opacity-100"
    />
  );
}
