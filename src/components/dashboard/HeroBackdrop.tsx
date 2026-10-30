"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { useInView } from "motion/react";
import { CornerUpLeft } from "lucide-react";
import hero from "../../../scripts/assets/hero.json";
import { useOverlayOpen } from "@/lib/hooks/use-overlay";
import { cn } from "@/lib/cn";

type Backdrop = (typeof hero.backdrops)[number];

const BACKDROPS: Backdrop[] = hero.backdrops;
/** How long each frame holds before the next one fades in. */
const HOLD = 8000;
/** The hero spans the content column: full width on phones, minus the sidebar and the rail on desktop. */
const SIZES = "(min-width: 1280px) calc(100vw - 520px), (min-width: 1024px) calc(100vw - 260px), 100vw";

// One shuffled order per page load. The server renders no frame (the order is random), so
// hydration always matches and the first frame fades in once it has loaded.
let shuffled: number[] | null = null;
function playOrder() {
  if (!shuffled) {
    shuffled = BACKDROPS.map((_, i) => i);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
  }
  return shuffled;
}
const noop = () => () => {};

/** Which frame is up, which loads next, and when to move on (never while the hero is off screen). */
export function useHeroBackdrops() {
  const box = useRef<HTMLDivElement>(null);
  // Still while it's off screen, or under the model library's glass.
  const inView = useInView(box, { amount: 0.2 });
  const covered = useOverlayOpen();
  const live = inView && !covered;
  const order = useSyncExternalStore(noop, playOrder, () => null);
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const shownAt = useRef(0);

  const at = (k: number) => (order ? BACKDROPS[order[k % order.length]] : null);
  const current = at(step);
  const next = at(step + 1);
  const showing = !!current && loaded.has(current.id);

  useEffect(() => {
    if (showing) shownAt.current = performance.now();
  }, [showing, step]);

  // Move on once this frame has held long enough and the next one is ready to show.
  const nextReady = !!next && loaded.has(next.id);
  useEffect(() => {
    if (!live || !showing || !nextReady) return;
    const t = setTimeout(() => setStep((s) => s + 1), Math.max(0, HOLD - (performance.now() - shownAt.current)));
    return () => clearTimeout(t);
  }, [live, showing, nextReady, step]);

  const markLoaded = (id: string) => setLoaded((s) => (s.has(id) ? s : new Set(s).add(id)));
  return { box, live, step, current: showing ? current : null, slides: { prev: step > 0 ? at(step - 1) : null, current, next }, showing, markLoaded };
}

type State = ReturnType<typeof useHeroBackdrops>;

/**
 * The hero's living background: ten cinematic frames made in Crackio, crossfading in a random
 * order with a slow drift. Dimmed so the composer stays the focus, sharp in the middle and
 * blurred toward the edges.
 */
export function HeroBackdrop({ state }: { state: State }) {
  const { box, live, slides, showing, markLoaded } = state;
  const layers = [
    slides.prev && { b: slides.prev, phase: "out" },
    slides.current && { b: slides.current, phase: showing ? "in" : "wait" },
    slides.next && { b: slides.next, phase: "wait" },
  ].filter((l): l is { b: Backdrop; phase: string } => !!l);

  return (
    <div ref={box} aria-hidden="true" data-live={live || undefined} className="hero-backdrop motion-always pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {layers.map(({ b, phase }) => (
        <div key={b.id} data-phase={phase} className="hero-slide absolute inset-0">
          {/* A small, blurred copy fills the edges; the sharp frame fades into it. */}
          <Image src={`/assets/hero/${b.id}.webp`} alt="" fill loading="eager" sizes="320px" className="scale-110 object-cover blur-2xl" style={{ objectPosition: b.focus }} />
          <Image
            src={`/assets/hero/${b.id}.webp`}
            alt=""
            fill
            loading="eager"
            sizes={SIZES}
            onLoad={() => markLoaded(b.id)}
            className="hero-sharp object-cover"
            style={{ objectPosition: b.focus }}
          />
        </div>
      ))}
      <div className="hero-shade absolute inset-0" />
    </div>
  );
}

/** What's behind the composer right now, with its prompt one click away. */
export function HeroCaption({ state, onUse, className }: { state: State; onUse: (prompt: string) => void; className?: string }) {
  const { current, step, live } = state;
  if (!current) return null;
  return (
    <button
      type="button"
      onClick={() => onUse(current.prompt)}
      title={current.prompt}
      className={cn(
        "press motion-always group pointer-events-auto flex min-w-0 items-center gap-2.5 rounded-full bg-black/35 px-3 py-1.5 text-left text-[11.5px] text-paper/70 ring-1 ring-white/[0.08] hover:bg-black/55 hover:text-paper",
        className,
      )}
    >
      {/* How long until the next frame: a bar that fills by transform, so it never repaints the page. */}
      <span aria-hidden="true" className="relative h-[3px] w-5 shrink-0 overflow-hidden rounded-full bg-white/15">
        <span
          key={step}
          className="hero-timer absolute inset-0 origin-left rounded-full bg-paper/80"
          style={{ animationDuration: `${HOLD}ms`, animationPlayState: live ? "running" : "paused" }}
        />
      </span>
      <span key={current.id} className="hero-caption min-w-0 truncate">
        {current.title}
      </span>
      <span className="hidden shrink-0 items-center gap-1 font-semibold text-paper/85 transition-colors group-hover:text-spike sm:inline-flex">
        <CornerUpLeft size={12} />
        Use prompt
      </span>
    </button>
  );
}
