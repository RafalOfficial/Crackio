"use client";

/* eslint-disable @next/next/no-img-element */
import type { ReactNode, Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * One step of "Your shot": a row that says what's picked (with a picture of it), which opens to pick
 * something else. Only one is open at a time; picking moves on to the next on its own.
 */
export function Step({
  stepRef,
  index,
  title,
  value,
  thumb,
  auto,
  open,
  done,
  onToggle,
  note,
  children,
}: {
  stepRef?: Ref<HTMLElement>;
  index: number;
  title: string;
  value: string;
  /** A small picture of what's picked. */
  thumb?: string | null;
  /** The pick is Best fit: Crackio decides. */
  auto?: boolean;
  open: boolean;
  /** You've been through this step. */
  done: boolean;
  onToggle: () => void;
  /** A line above the options (what the previews show). */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      ref={stepRef}
      className={cn(
        "scroll-mt-4 rounded-[16px] transition-[background-color,box-shadow] duration-300",
        open ? "bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.02]",
      )}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-[52px] w-full items-center gap-3 rounded-[16px] px-3 py-2 text-left">
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors",
            done ? "bg-spike text-spike-ink" : open ? "bg-paper text-[#16131b]" : "bg-white/[0.07] text-fog",
          )}
        >
          {done ? <Check size={12} strokeWidth={3} /> : index}
        </span>
        <span className="shrink-0 text-[13.5px] font-semibold text-paper">{title}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className={cn("truncate text-[13px]", auto && !done ? "text-haze" : "font-semibold text-fog")}>{value}</span>
          {thumb ? (
            <span className="relative size-9 shrink-0 overflow-hidden rounded-[9px] bg-apple-2 shadow-[0_0_0_1px_var(--color-line)]">
              <img src={thumb} alt="" className="size-full object-cover" />
              {auto ? (
                <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                  <Sparkles size={12} />
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-haze transition-transform duration-300", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="options"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3">
              {note ? <p className="mb-2.5 text-[12px] leading-snug text-haze">{note}</p> : null}
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
