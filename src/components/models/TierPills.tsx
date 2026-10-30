"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

/**
 * How grand a resolution is, for the Home bar's picker: plain, then blue, green, an epic purple and a legendary gold.
 * Pictures: Draft, 720p, 1K, 2K, 4K. Clips: 540p, 720p, 1080p, 1440p. Sizes a model names in pixels follow suit.
 */
export type Tier = "plain" | "blue" | "green" | "epic" | "legendary";

export function resolutionTier(value: string | number | null | undefined): Tier {
  const v = String(value ?? "").toLowerCase();
  if (/^(4k|2160p|3840|1440p)$/.test(v)) return "legendary";
  if (/^(2k|2048|1080p)$/.test(v)) return "epic";
  if (/^(1k|1024|1\.5k|1536)$/.test(v)) return "green";
  if (v === "720p") return "blue";
  return "plain";
}

/** The tier's color for text beside the picker (the Home bar's chip); none for plain. */
export const TIER_INK: Record<Tier, string | null> = { plain: null, blue: "#7dd3fc", green: "#6ee7b7", epic: "#f0abfc", legendary: "#fcd34d" };

/**
 * Each tier as frosted glass in the chosen option's own rounded button (the shape its hover shows): a faint tint under a
 * soft white frost, and the tier's color as fog along the inside of the edges, strongest at the edge and fading inward. Inset shadows with blur and no spread:
 * no line anywhere, and they follow the rounded corners on their own (a blurred layer clipped to a rounded box showed as
 * a square in Safari). The left and right fogs have their own colors, so the epic one runs purple to pink; every tier has
 * the same shadows, which lets the colors fade into each other as the highlight slides.
 */
const GLASS: Record<Tier, { tint: string; left: string; right: string; fog: string; far: string; ink: string }> = {
  plain: { tint: "rgb(255 255 255 / 0.05)", left: "rgb(255 255 255 / 0.22)", right: "rgb(255 255 255 / 0.22)", fog: "rgb(255 255 255 / 0.2)", far: "rgb(255 255 255 / 0.07)", ink: "#ffffff" },
  blue: { tint: "rgb(56 189 248 / 0.09)", left: "rgb(56 189 248 / 0.5)", right: "rgb(56 189 248 / 0.5)", fog: "rgb(56 189 248 / 0.45)", far: "rgb(56 189 248 / 0.16)", ink: "#e0f2fe" },
  green: { tint: "rgb(52 211 153 / 0.09)", left: "rgb(52 211 153 / 0.48)", right: "rgb(52 211 153 / 0.48)", fog: "rgb(52 211 153 / 0.42)", far: "rgb(52 211 153 / 0.15)", ink: "#d1fae5" },
  epic: { tint: "rgb(217 70 239 / 0.09)", left: "rgb(168 85 247 / 0.65)", right: "rgb(236 72 153 / 0.6)", fog: "rgb(217 70 239 / 0.38)", far: "rgb(217 70 239 / 0.14)", ink: "#fae8ff" },
  legendary: { tint: "rgb(251 191 36 / 0.1)", left: "rgb(251 191 36 / 0.55)", right: "rgb(251 191 36 / 0.55)", fog: "rgb(251 191 36 / 0.5)", far: "rgb(251 191 36 / 0.18)", ink: "#fef3c7" },
};

const FADE = "background-color 320ms ease-out, box-shadow 320ms ease-out, color 320ms ease-out";

/**
 * A segmented control whose highlight slides from one option to the next, for the Home bar, where it's meant to feel
 * good to play with: a frosted-glass button in the shape of the option's own hover highlight. With `tiered`, it takes the
 * color of the resolution it lands on, fading between colors as it moves; the legendary one has a faint shine passing
 * over it. On a touch screen each pick gives a light tap.
 */
export function TierPills({
  label,
  value,
  options,
  onPick,
  tiered,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string; sub?: string | null; title?: string }[];
  onPick: (value: string) => void;
  tiered: boolean;
}) {
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; width: number } | null>(null);
  const index = options.findIndex((o) => o.value === value);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const b = el.querySelectorAll<HTMLElement>("[role=radio]")[index];
      setAt(b ? { x: b.offsetLeft, width: b.offsetWidth } : null);
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    return () => watch.disconnect();
  }, [index, options.length]);
  const tier = tiered ? resolutionTier(value) : "plain";
  const glass = GLASS[tier];
  const tall = options.some((o) => o.sub);
  const pick = (v: string) => {
    onPick(v);
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) navigator.vibrate?.(6);
  };

  return (
    <div ref={box} role="radiogroup" aria-label={label} className="relative flex min-w-0 flex-1 gap-1 rounded-[14px] bg-white/[0.05] p-1">
      {at ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 left-0 overflow-hidden rounded-[10px] [mask-image:linear-gradient(#000,#000)]"
          style={{ backgroundColor: glass.tint, transition: FADE }}
          initial={false}
          animate={{ x: at.x, width: at.width }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38, mass: 0.9 }}
        >
          {/* A soft frost, lighter at the top. */}
          <span className="absolute inset-0 rounded-[inherit] bg-[linear-gradient(180deg,rgb(255_255_255/0.08),rgb(255_255_255/0.015)_65%)]" />
          {/* The fog along the edges: the tier's color strongest at the edge, gone by the middle. */}
          <span
            className="absolute inset-0 rounded-[inherit]"
            style={{
              boxShadow: `inset 12px 0 12px -8px ${glass.left}, inset -12px 0 12px -8px ${glass.right}, inset 0 0 10px ${glass.fog}, inset 0 0 20px ${glass.far}`,
              transition: FADE,
            }}
          />
          {tier === "legendary" && !reduced ? (
            <motion.span
              className="absolute inset-y-0 w-1/4 -skew-x-12"
              style={{ background: "linear-gradient(90deg, transparent, rgb(254 243 199 / 0.16), transparent)" }}
              initial={{ x: "-200%" }}
              animate={{ x: "500%" }}
              transition={{ duration: 1.9, ease: "easeInOut", repeat: Infinity, repeatDelay: 2.2 }}
            />
          ) : null}
        </motion.span>
      ) : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => pick(o.value)}
            className={cn(
              "press relative z-[1] flex min-w-[46px] flex-1 flex-col items-center justify-center rounded-[10px] px-2 text-[12.5px] font-semibold transition-colors duration-300",
              tall ? "h-10" : "h-8",
              !on && "text-fog hover:bg-white/[0.06] hover:text-paper",
            )}
            style={on ? { color: glass.ink } : undefined}
          >
            <span className="leading-none">{o.label}</span>
            {o.sub ? <span className={cn("tabular mt-0.5 text-[10.5px] font-medium leading-none", on ? "opacity-70" : "text-haze")}>{o.sub}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
