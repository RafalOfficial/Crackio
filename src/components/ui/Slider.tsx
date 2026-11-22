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
  origin,
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
  /** Where the fill starts, for sliders that go both ways (−180…180 from 0): it fills from here to the value. */
  origin?: number;
  className?: string;
}) {
  const at = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  const pct = at(value);
  const from = origin === undefined ? 0 : at(origin);
  const lo = Math.min(from, pct);
  const hi = Math.max(from, pct);
  const fill =
    origin === undefined
      ? `linear-gradient(90deg, var(--color-spike) var(--pct), var(--color-gaffer) var(--pct))`
      : `linear-gradient(90deg, var(--color-gaffer) ${lo}%, var(--color-spike) ${lo}%, var(--color-spike) ${hi}%, var(--color-gaffer) ${hi}%)`;
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
            "--track": track ?? fill,
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
