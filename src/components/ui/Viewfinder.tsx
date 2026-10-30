import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function ThirdsGrid({ className, opacity = 0.08 }: { className?: string; opacity?: number }) {
  const line = `rgb(255 255 255 / ${opacity})`;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        backgroundImage: `linear-gradient(to right, transparent calc(33.333% - 0.5px), ${line} calc(33.333% - 0.5px), ${line} calc(33.333% + 0.5px), transparent calc(33.333% + 0.5px), transparent calc(66.666% - 0.5px), ${line} calc(66.666% - 0.5px), ${line} calc(66.666% + 0.5px), transparent calc(66.666% + 0.5px)), linear-gradient(to bottom, transparent calc(33.333% - 0.5px), ${line} calc(33.333% - 0.5px), ${line} calc(33.333% + 0.5px), transparent calc(33.333% + 0.5px), transparent calc(66.666% - 0.5px), ${line} calc(66.666% - 0.5px), ${line} calc(66.666% + 0.5px), transparent calc(66.666% + 0.5px))`,
      }}
    />
  );
}

/** Small on-screen-display readout, styled like a camera monitor overlay. */
export function Osd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.06em] text-paper/80",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function RecDot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-2 rounded-full bg-tally animate-rec", className)} />;
}
