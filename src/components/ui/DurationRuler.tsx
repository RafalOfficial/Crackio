"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Clip length as a slim ruler: one tick per second up to the model's longest clip. Click or drag
 * anywhere on it (or use the arrow keys) and the length snaps to the nearest one the model can
 * make; ticks it can't make stay small. The pill shows the length; with Auto, tapping it lets the
 * model pick.
 */
export function DurationRuler({
  value,
  allowed,
  max,
  auto,
  onChange,
  className,
}: {
  value: number | "auto";
  /** Whole seconds the model can make, ascending. */
  allowed: number[];
  /** The last tick (the model's longest clip). */
  max: number;
  /** Offer "Auto" (the model picks the length). */
  auto?: boolean;
  onChange: (v: number | "auto") => void;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const ok = new Set(allowed);
  const lines = Array.from({ length: Math.max(1, max) }, (_, i) => i + 1);
  const isAuto = value === "auto";
  const current = isAuto ? null : value;
  const nearest = (s: number) => allowed.reduce((b, v) => (Math.abs(v - s) < Math.abs(b - s) ? v : b), allowed[0]);

  const fromPointer = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !allowed.length) return;
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const s = nearest(1 + t * (lines.length - 1));
    if (s !== value) onChange(s);
  };
  const step = (dir: 1 | -1) => {
    if (!allowed.length) return;
    if (current === null) return onChange(dir > 0 ? allowed[0] : allowed.at(-1)!);
    const i = allowed.indexOf(nearest(current));
    onChange(allowed[Math.min(allowed.length - 1, Math.max(0, i + dir))]);
  };
  const at = (s: number) => (lines.length === 1 ? 50 : ((s - 1) / (lines.length - 1)) * 100);

  return (
    <div className={cn("flex h-10 min-w-0 items-center gap-1 rounded-full bg-white/[0.05] p-1", className)}>
      <button
        type="button"
        onClick={() => auto && onChange(isAuto ? nearest(allowed.includes(5) ? 5 : allowed[Math.floor(allowed.length / 2)]) : "auto")}
        disabled={!auto}
        aria-pressed={auto ? isAuto : undefined}
        title={auto ? (isAuto ? "The model picks the length · tap to choose one" : "Tap to let the model pick the length") : undefined}
        className={cn(
          "tabular h-8 min-w-[48px] shrink-0 rounded-full px-2.5 text-[12.5px] font-bold transition-colors disabled:cursor-default",
          isAuto ? "bg-white/[0.12] text-paper" : "bg-paper text-[#16131b]",
          auto && "press hover:brightness-95",
        )}
      >
        {isAuto ? "Auto" : `${current}s`}
      </button>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Clip length"
        aria-valuemin={allowed[0] ?? 1}
        aria-valuemax={allowed.at(-1) ?? max}
        aria-valuenow={current ?? undefined}
        aria-valuetext={isAuto ? "Auto: the model picks the length" : `${current} seconds`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging && fromPointer(e.clientX)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          const keys: Record<string, () => void> = {
            ArrowRight: () => step(1),
            ArrowUp: () => step(1),
            ArrowLeft: () => step(-1),
            ArrowDown: () => step(-1),
            Home: () => allowed.length && onChange(allowed[0]),
            End: () => allowed.length && onChange(allowed.at(-1)!),
          };
          if (!keys[e.key]) return;
          e.preventDefault();
          keys[e.key]();
        }}
        className={cn(
          "relative h-8 min-w-0 flex-1 cursor-ew-resize touch-none rounded-full outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-spike)]",
          isAuto && "opacity-50",
        )}
      >
        <div ref={track} className="pointer-events-none absolute inset-x-2.5 inset-y-0">
          {lines.map((s) => {
            const allowedHere = ok.has(s);
            const filled = current !== null && s < current;
            return (
              <span
                key={s}
                className={cn(
                  "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                  dragging ? "transition-none" : "transition-[height,background-color] duration-150",
                  s === current
                    ? "h-5 w-[3px] bg-spike"
                    : allowedHere
                      ? filled
                        ? "h-3 w-[2px] bg-spike/80"
                        : "h-3 w-[2px] bg-white/[0.3]"
                      : filled
                        ? "h-1.5 w-[2px] bg-spike/35"
                        : "h-1.5 w-[2px] bg-white/[0.12]",
                )}
                style={{ left: `${at(s)}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
