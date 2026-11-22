"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import type { TrainState } from "@/lib/train/types";

/** A text as the server keeps it: runs of spaces as one, none at the ends. */
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** Small pieces the Train page is built from. */

export const GB = (bytes: number) => {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

export const money = (n: number) => (n < 0.01 ? "under 1¢" : n < 1 ? `${Math.round(n * 100)}¢` : `$${n.toFixed(2)}`);

export const STATE_WORDS: Record<TrainState, string> = {
  draft: "Not started",
  queued: "Waiting its turn",
  starting: "Getting ready",
  uploading: "Sending pictures",
  preparing: "Preparing pictures",
  training: "Training",
  previewing: "Drawing test pictures",
  saving: "Saving",
  paused: "Paused",
  done: "Trained",
  error: "Stopped",
};

/** A step of the workbench: its number on a rail down the left, its title, and what belongs to it. */
export function Step({ n, title, hint, done, children, aside }: { n: number; title: string; hint?: ReactNode; done?: boolean; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="relative pl-12 pb-10 last:pb-2">
      {/* The rail: a line from this step's number to the next. */}
      <span aria-hidden="true" className="absolute left-[15px] top-9 bottom-1 w-px bg-white/[0.07]" />
      <span
        aria-hidden="true"
        className={cn(
          "tabular absolute left-0 top-0 grid size-[31px] place-items-center rounded-full text-[13px] font-bold",
          done ? "bg-daylight/15 text-daylight shadow-[inset_0_0_0_1px_rgb(142_197_255/0.35)]" : "bg-white/[0.05] text-haze shadow-[inset_0_0_0_1px_var(--color-line)]",
        )}
      >
        {n}
      </span>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 pt-[3px]">
        <h2 className="font-display text-[19px] text-paper">{title}</h2>
        {aside}
      </div>
      {hint ? <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-haze">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A choice among a few: a card that's raised when it's the one. */
export function Choice({ on, onClick, disabled, children, className, title }: { on: boolean; onClick: () => void; disabled?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "press squircle rounded-[16px] p-3.5 text-left disabled:cursor-not-allowed disabled:opacity-45",
        on ? "bg-white/[0.085] shadow-[inset_0_0_0_1.5px_rgb(142_197_255/0.55)]" : "bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.055]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A quiet tag: a fact about something, coloured by what it means. */
export function Tag({ tone = "plain", children, title }: { tone?: "plain" | "good" | "warn" | "bad" | "info"; children: ReactNode; title?: string }) {
  const tones = {
    plain: "bg-white/[0.06] text-fog",
    good: "bg-chroma/12 text-chroma",
    warn: "bg-tungsten/12 text-tungsten",
    bad: "bg-tally/12 text-tally",
    info: "bg-daylight/12 text-daylight",
  } as const;
  return (
    <span title={title} className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold", tones[tone])}>
      {children}
    </span>
  );
}

/** "What does this do?": a small button that opens the longer explanation in place. */
export function More({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="press ml-1.5 inline-grid size-[18px] translate-y-[3px] place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper"
        aria-label={open ? "Hide the explanation" : "Explain this"}
      >
        <Info size={13} />
      </button>
      {open ? <span className="mt-1.5 block max-w-[68ch] text-[12.5px] leading-relaxed text-fog">{children}</span> : null}
    </>
  );
}

/** A text field that keeps what you type and sends it when you stop (or leave). */
export function Field({
  value,
  onCommit,
  placeholder,
  label,
  className,
  maxLength,
  mono,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
  maxLength?: number;
  mono?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [at, setAt] = useState(value);
  // Typed, not sent yet.
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server's value replaces what's shown only when it changed there, never under your typing: the server tidies
  // what it's sent (spaces at the ends go), and its answer to "Turn the photo " took the space back mid-sentence, with
  // whatever was typed meanwhile ("Turn the photointo").
  if (value !== at) {
    setAt(value);
    if (!pending && tidy(value) !== tidy(text)) setText(value);
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const send = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    setPending(false);
    if (v !== value) {
      setAt(v);
      onCommit(v);
    }
  };
  return (
    <label className={cn("block", className)}>
      <span className="text-[12px] font-medium text-haze">{label}</span>
      <input
        value={text}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setPending(true);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => send(v), 700);
        }}
        onBlur={() => send(text)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className={cn(
          "field-focus squircle mt-1.5 h-10 w-full rounded-[12px] bg-white/[0.05] px-3 text-[14px] text-paper outline-none placeholder:text-haze/70 disabled:opacity-50",
          mono && "font-mono text-[13px]",
        )}
      />
    </label>
  );
}

/** A loss curve: the run's error, smoothed, from its first step to now. Lower and flatter is the model settling. */
export function LossChart({ points, steps, marks, className }: { points: [number, number][]; steps: number; marks?: number[]; className?: string }) {
  const W = 640;
  const H = 150;
  if (points.length < 2) {
    return <div className={cn("grid place-items-center rounded-[14px] bg-white/[0.025] text-[12.5px] text-haze", className)} style={{ aspectRatio: `${W} / ${H}` }}>The curve starts with the first steps</div>;
  }
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const x = (s: number) => 6 + (s / Math.max(steps, points.at(-1)![0])) * (W - 12);
  const y = (v: number) => 10 + (1 - (v - lo) / span) * (H - 24);
  const line = points.map(([s, v], i) => `${i ? "L" : "M"}${x(s).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points.at(-1)!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("w-full rounded-[14px] bg-white/[0.025]", className)} role="img" aria-label={`Loss from ${hi.toFixed(3)} at its highest to ${last[1].toFixed(3)} now`}>
      {(marks ?? []).map((s) => (
        <line key={s} x1={x(s)} x2={x(s)} y1={8} y2={H - 8} stroke="rgb(255 255 255 / 0.08)" strokeDasharray="2 4" />
      ))}
      <path d={`${line} L${x(last[0]).toFixed(1)},${H} L${x(points[0][0]).toFixed(1)},${H} Z`} fill="rgb(142 197 255 / 0.07)" />
      <path d={line} fill="none" stroke="var(--color-daylight)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={3.5} fill="var(--color-daylight)" />
    </svg>
  );
}

/** Time since or until, ticking once a second while shown. */
export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
