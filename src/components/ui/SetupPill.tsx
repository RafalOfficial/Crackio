"use client";

import type { CSSProperties, ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A tool's setup notices (Voice, Lip Sync) as one small pill floating at the top of the page, over it: nothing moves.
 * One line, two with `second`; `progress` draws a hairline along its bottom (null: a sweep, for a step without a number);
 * `title` holds the rest for whoever points at it. `hue` is the tool's colour.
 */

export const PILL_ACT =
  "press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-paper px-3 text-[12px] font-bold text-stage hover:bg-white disabled:opacity-70 disabled:cursor-default";

export function PillAct({ busy, onClick, children }: { busy: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={busy} onClick={onClick} className={PILL_ACT}>
      {busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

const TONES = {
  hello: "text-[var(--pill-hue)] bg-[color-mix(in_oklab,var(--pill-hue)_16%,transparent)]",
  done: "text-[var(--pill-ink)] bg-[var(--pill-hue)]",
  warn: "text-tungsten bg-tungsten/[0.16]",
  error: "text-tally bg-tally/[0.16]",
  quiet: "text-fog bg-white/[0.09]",
} as const;

export type PillTone = keyof typeof TONES;

export function SetupPill({
  k,
  out,
  tone,
  icon,
  children,
  second,
  action,
  onClose,
  closeLabel = "Close",
  progress,
  title,
  hue = "var(--color-tool-voice)",
  ink = "#11200a",
}: {
  k: string;
  out: boolean;
  tone: PillTone;
  icon: ReactNode;
  children: ReactNode;
  second?: string | null;
  action?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  progress?: number | null;
  title?: string;
  hue?: string;
  /** Text on the tool's colour (a "done" mark). */
  ink?: string;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[50px] z-[4] flex justify-center px-3 sm:top-[62px] xl:top-[17px]" style={{ "--pill-hue": hue, "--pill-ink": ink } as CSSProperties}>
      <div
        key={k}
        role="status"
        aria-live="polite"
        title={title}
        className={cn(
          "voice-setup smoked-glass pointer-events-auto relative flex min-h-10 max-w-[min(560px,100%)] items-center gap-2.5 overflow-hidden py-1.5 pl-1.5 pr-1.5",
          second ? "rounded-[20px]" : "rounded-full",
          out && "voice-setup-out",
        )}
      >
        <span className={cn("grid size-7 shrink-0 place-items-center overflow-hidden rounded-full", TONES[tone])}>{icon}</span>
        <div className="min-w-0 flex-1 py-0.5 text-[13px] leading-snug">
          <p className="truncate">{children}</p>
          {second ? <p className="truncate text-[12px] text-haze">{second}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        <button type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose} className="press grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
          <X size={13} />
        </button>
        {progress != null ? (
          <span className="absolute inset-x-4 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-white/[0.08]">
            <span className="block h-full rounded-full bg-[var(--pill-hue)] transition-[width] duration-700" style={{ width: `${Math.max(2, progress * 100)}%` }} />
          </span>
        ) : progress === null ? (
          <span className="absolute inset-x-4 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
            <span className="voice-setup-sweep block h-full w-1/3 rounded-full bg-[var(--pill-hue)] opacity-70" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Notices put "later" stay hidden for this tab (sessionStorage under `key`). */
export function readLater(key: string) {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set<string>();
  }
}

export function writeLater(key: string, later: Set<string>) {
  try {
    sessionStorage.setItem(key, JSON.stringify([...later]));
  } catch {
    /* this tab only */
  }
}
