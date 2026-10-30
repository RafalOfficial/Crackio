"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Labeled range input. `onStart` fires once when a drag begins (used for undo checkpoints),
 * `onChange` fires continuously.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onStart,
  format,
  hint,
  track,
  className,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onStart?: () => void;
  format?: (v: number) => ReactNode;
  hint?: [ReactNode, ReactNode];
  /** Optional CSS background for the track (e.g. a color-temperature gradient). */
  track?: string;
  className?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={cn("block", className)}>
      <span className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-medium text-fog">{label}</span>
        <span className="tabular font-semibold text-paper">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onKeyDown={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "PageUp" || e.key === "PageDown") onStart?.();
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        className="crackio-range mt-2 w-full"
        style={
          {
            "--pct": `${pct}%`,
            "--track": track ?? `linear-gradient(90deg, var(--color-spike) var(--pct), var(--color-gaffer) var(--pct))`,
          } as CSSProperties
        }
      />
      {hint ? (
        <span className="mt-1 flex justify-between text-[11px] text-haze">
          <span>{hint[0]}</span>
          <span>{hint[1]}</span>
        </span>
      ) : null}
    </label>
  );
}
