"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Whether the take `id` finished while it was on screen here (it was running, now it isn't): only those develop. A take
 * that was already done when the page opened, or another take picked into the same place, just shows.
 */
export function useJustFinished(id: string | undefined, live: boolean): boolean {
  const [seen, setSeen] = useState({ id, live, fresh: false });
  if (seen.id !== id) setSeen({ id, live, fresh: false });
  else if (seen.live !== live) setSeen({ id, live, fresh: seen.live && !live });
  return seen.id === id && seen.fresh;
}

/**
 * A finished take develops instead of popping in, like a print coming out of a camera: the dark of the field it ran under
 * holds until the picture is decoded (so there's never an empty frame), then the picture rises from a soft, bright blur
 * while the dark lifts. Once, in about 0.6 s; Calm (or the system's reduce-motion) shows it at once.
 */
export function TakeReveal({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"wait" | "go" | "done">("wait");
  useEffect(() => {
    let off = false;
    const go = () => {
      if (!off) setPhase((p) => (p === "wait" ? "go" : p));
    };
    const el = box.current?.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    // A clip shows its opening frame (its poster) at once; a picture waits until it's decoded, never more than 3 s.
    if (!el || el instanceof HTMLVideoElement) go();
    else if (el.complete && el.naturalWidth) go();
    else {
      // decode() alone can settle before a lazy picture has even loaded: wait for the load, then the decode.
      el.addEventListener("load", () => void el.decode().then(go, go), { once: true });
      el.addEventListener("error", go, { once: true });
    }
    const t = setTimeout(go, 3000);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, []);
  // The veil goes once its fade ends; this is the backstop if an animation never runs (it can't stay over the picture).
  useEffect(() => {
    if (phase !== "go") return;
    const t = setTimeout(() => setPhase("done"), 1200);
    return () => clearTimeout(t);
  }, [phase]);
  return (
    <div
      ref={box}
      data-reveal={phase}
      className={cn("take-reveal", className)}
      onAnimationEnd={(e) => {
        if ((e.target as HTMLElement).classList.contains("take-reveal-veil")) setPhase("done");
      }}
    >
      {children}
      {phase !== "done" ? <span aria-hidden="true" className="take-reveal-veil" /> : null}
    </div>
  );
}
