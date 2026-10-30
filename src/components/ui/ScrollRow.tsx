"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

const scrollMotion = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/**
 * Controls on one line at any width. When they don't all fit, the row scrolls sideways (swipe,
 * trackpad, Shift+wheel, or Tab to a control): the controls dissolve into a dark fade at each edge
 * with more past it, and an arrow there jumps to that end. When everything fits it's a plain row, so
 * adding a control never needs a breakpoint. The look is `.scroll-row` in globals.css.
 */
export function ScrollRow({ children, className, trackClassName }: { children: ReactNode; className?: string; trackClassName?: string }) {
  const view = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  /** Whether there's more past each edge. */
  const [more, setMore] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const el = view.current;
    const row = track.current;
    if (!el || !row) return;
    const measure = () => {
      const x = el.scrollLeft;
      const start = x > 1;
      const end = el.scrollWidth - el.clientWidth - x > 1;
      setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The view narrows with the window, and the controls change width (a model's name, another mode's settings).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(row);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);

  const jump = (to: "start" | "end") => {
    const el = view.current;
    el?.scrollTo({ left: to === "start" ? 0 : el.scrollWidth - el.clientWidth, behavior: scrollMotion() });
  };

  /** A control clicked while partly under a fade slides clear of it, once it has redrawn. */
  const reveal = (target: Node) => {
    const item = Array.from(track.current?.children ?? []).find((c) => c.contains(target));
    if (!item) return;
    requestAnimationFrame(() => {
      const el = view.current;
      if (!el || el.scrollWidth - el.clientWidth <= 1) return;
      // The view's scroll padding is the width of its fades.
      const fade = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
      const v = el.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      const dx = r.left < v.left + fade ? r.left - v.left - fade : r.right > v.right - fade ? r.right - v.right + fade : 0;
      if (dx) el.scrollBy({ left: dx, behavior: scrollMotion() });
    });
  };

  return (
    <div className={cn("scroll-row relative", className)}>
      <div
        ref={view}
        data-more-start={more.start || undefined}
        data-more-end={more.end || undefined}
        onClick={(e) => reveal(e.target as Node)}
        // Vertical room for the controls' focus rings, which the scrolling clips.
        className="scroll-row-view scrollbar-none overflow-x-auto overflow-y-hidden overscroll-x-contain py-1"
      >
        <div ref={track} className={cn("flex w-max items-center", trackClassName)}>
          {children}
        </div>
      </div>
      <EdgeArrow side="start" shown={more.start} onClick={() => jump("start")} />
      <EdgeArrow side="end" shown={more.end} onClick={() => jump("end")} />
    </div>
  );
}

/** The chevron in a fade: jumps to that end of the row. */
function EdgeArrow({ side, shown, onClick }: { side: "start" | "end"; shown: boolean; onClick: () => void }) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-side={side}
      // A pointer shortcut: Tab already brings each control into view.
      tabIndex={-1}
      aria-hidden="true"
      // Leave focus where it is (the prompt, mid-sentence).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "scroll-row-arrow press absolute inset-y-0 z-10 grid w-8 place-items-center text-paper",
        side === "start" ? "left-0" : "right-0",
        !shown && "pointer-events-none opacity-0",
      )}
    >
      <Icon size={18} strokeWidth={2.4} />
    </button>
  );
}
