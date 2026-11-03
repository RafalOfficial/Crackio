"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

/** Orbs this big and up drift; smaller ones (in chips and lines) keep their clouds still, where nobody could see them move. */
const MOVES_FROM = 28;

/** One watcher for every orb (and Voice's backdrop): it moves only while it's on screen (and its page is shown). */
let watcher: IntersectionObserver | null = null;
export function watch(el: HTMLElement) {
  watcher ??= new IntersectionObserver((seen) => {
    for (const e of seen) (e.target as HTMLElement).toggleAttribute("data-live", e.isIntersecting);
  }, { rootMargin: "48px" });
  watcher.observe(el);
  return () => watcher?.unobserve(el);
}

/** A steady number from a voice's colours, so each voice's sky has its own clouds going its own ways. */
function seedOf(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const WAYS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

function skyOf(hues: [string, string]) {
  const s = seedOf(hues.join(""));
  const clouds = WAYS[s % 8];
  // The wisps go another way: three to five eighths of a turn round from the clouds.
  const wisps = WAYS[((s % 8) + 3 + ((s >>> 3) % 3)) % 8];
  // Diagonals cross more ground per loop: they take longer, so every voice drifts about as fast.
  const len = (w: [number, number]) => Math.hypot(w[0], w[1]);
  return {
    "--cx": clouds[0],
    "--cy": clouds[1],
    "--wx": wisps[0],
    "--wy": wisps[1],
    "--ct": `${Math.round((26 + ((s >>> 6) % 12)) * len(clouds))}s`,
    "--wt": `${Math.round((16 + ((s >>> 10) % 8)) * len(wisps))}s`,
    "--ox": ((s >>> 14) % 100) / 100,
    "--oy": ((s >>> 18) % 100) / 100,
    "--px": ((s >>> 22) % 100) / 100,
    "--py": ((s >>> 25) % 100) / 100,
  };
}

/**
 * The same sky filling its box (a card's art, a mood's swatch): it takes its parent's corners. `still` keeps the clouds
 * where they are (many at once, or small).
 */
export function Sky({ hues, still = false, className }: { hues: [string, string]; still?: boolean; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || still) return;
    return watch(node);
  }, [still]);
  return (
    <span ref={el} aria-hidden="true" className={cn("voice-orb voice-sky", className)} style={{ "--h1": hues[0], "--h2": hues[1], ...skyOf(hues) } as CSSProperties}>
      <i className="voice-orb-clouds" />
      <i className="voice-orb-wisps" />
    </span>
  );
}

/**
 * A voice's mark: a little sky in its two colours with white clouds drifting across it (globals.css, .voice-orb). A
 * ring breathes out of it while a take is made (`working`), and it swells with the sound while one plays (`level`, 0–1).
 */
export function Orb({ hues, size = 40, level = 0, working = false, className }: { hues: [string, string]; size?: number; level?: number; working?: boolean; className?: string }) {
  const sky = useRef<HTMLSpanElement>(null);
  const moves = size >= MOVES_FROM;
  useEffect(() => {
    const el = sky.current;
    if (!el || !moves) return;
    return watch(el);
  }, [moves]);
  return (
    <span
      aria-hidden="true"
      className={cn("voice-orb-wrap relative inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, "--h1": hues[0], "--h2": hues[1], transform: level ? `scale(${1 + Math.min(1, level) * 0.12})` : undefined } as CSSProperties}
    >
      <span ref={sky} className="voice-orb" style={skyOf(hues) as CSSProperties}>
        <i className="voice-orb-clouds" />
        {size >= 20 ? <i className="voice-orb-wisps" /> : null}
      </span>
      {working ? <span className="voice-orb-ring" /> : null}
    </span>
  );
}
