"use client";

import { cn } from "@/lib/cn";

/**
 * The bar across the top of the camera's screen (and of the takes and the take viewer in it): its buttons in plain
 * tinted groups. Glass buttons floating over the picture were hard to see on a bright shot (the user).
 */
export function TitleBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-white/[0.015] px-2", className)}>{children}</div>;
}

/** A group of buttons in the title bar. */
export function ToolGroup({ label, children, className }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("squircle flex items-center gap-0.5 rounded-[14px] bg-white/[0.04] p-1", className)} role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

/** An icon button in the title bar. */
export function ToolButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "press squircle grid size-8 place-items-center rounded-[10px] disabled:opacity-30",
        active ? "bg-white/[0.12] text-paper" : "text-fog hover:bg-white/[0.06] hover:text-paper",
      )}
    >
      {children}
    </button>
  );
}

/** A labeled button in the title bar (the label hides on narrow screens when `short`). */
export function ToolPill({
  title,
  onClick,
  active,
  disabled,
  children,
  className,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "press squircle relative inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold disabled:opacity-30",
        active ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-fog hover:bg-white/[0.06] hover:text-paper",
        className,
      )}
    >
      {children}
    </button>
  );
}
