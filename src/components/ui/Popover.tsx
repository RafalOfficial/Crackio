"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";

type Placement = "top-start" | "bottom-start" | "bottom-end" | "top-end";
type Spot = { side: "top" | "bottom"; style: CSSProperties };

const GAP = 8;
const EDGE = 12;
const noop = () => () => {};

/**
 * The popovers open now, innermost last. One opened from inside another's panel (a picker's Cast list) keeps the outer
 * open while you use it; a click outside both closes both, and Escape closes the innermost.
 */
const openPanels: { panel: () => HTMLElement | null }[] = [];

/**
 * Where a floating panel opened from `el` goes: the modal <dialog> around it when there is one (a modal sits in the
 * browser's top layer and makes everything outside it inert, so a panel in <body> would open behind it, unclickable),
 * else <body>. The panel is fixed to the viewport either way.
 */
export function floatingHost(el: Element | null | undefined): HTMLElement {
  return el?.closest("dialog") ?? document.body;
}

/**
 * Anchored popover: click to toggle, closes on outside click or Escape.
 * The panel is portaled to <body> (or the dialog it opens from) and placed against the viewport,
 * so a parent with overflow:hidden (the composer, cards, panels) can never cut it off. `placement`
 * is the preferred side; it flips when there isn't room, and the panel exposes the space it has as
 * `--popover-max-h` so long lists can scroll inside it.
 */
export function Popover({
  trigger,
  children,
  placement = "top-start",
  className,
  panelClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: Placement;
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  // Where the panel opens: found once the trigger is on the page (inside a dialog or not).
  const anchorRef = useCallback((el: HTMLDivElement | null) => {
    anchor.current = el;
    const inDialog = el ? floatingHost(el) : null;
    if (inDialog && inDialog !== document.body) setHost(inDialog);
  }, []);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const client = useSyncExternalStore(noop, () => true, () => false);

  useEffect(() => {
    if (!open) return;
    const me = { panel: () => panel.current };
    openPanels.push(me);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // The model library, or an @ menu, opened from inside a panel floats over it: using it keeps the panel open.
      if ((t as Element).closest?.(".model-library-root, [data-floating]")) return;
      if (anchor.current?.contains(t)) return;
      if (openPanels.slice(openPanels.indexOf(me)).some((p) => p.panel()?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the innermost panel only (not the dialog it opened from), once nothing inside it used the key.
      if (e.key !== "Escape" || e.defaultPrevented || openPanels[openPanels.length - 1] !== me) return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      openPanels.splice(openPanels.indexOf(me), 1);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Measure before paint, then follow the trigger while the page scrolls or resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const above = a.top - GAP - EDGE;
      const below = vh - a.bottom - GAP - EDGE;
      const need = Math.min(p.scrollHeight, 320);
      const side: Spot["side"] = placement.startsWith("top")
        ? above >= need || above >= below
          ? "top"
          : "bottom"
        : below >= need || below >= above
          ? "bottom"
          : "top";
      const width = Math.min(p.offsetWidth, vw - EDGE * 2);
      const left = placement.endsWith("end") ? a.right - width : a.left;
      const style: CSSProperties = {
        left: Math.max(EDGE, Math.min(left, vw - EDGE - width)),
        ...(side === "top" ? { bottom: vh - a.top + GAP } : { top: a.bottom + GAP }),
        maxHeight: Math.max(140, side === "top" ? above : below),
        ["--popover-max-h" as string]: `${Math.max(140, side === "top" ? above : below)}px`,
      };
      setSpot({ side, style });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // Content that changes size (a menu that opens a form) is placed again, so it stays on screen.
    const ro = new ResizeObserver(place);
    if (panel.current) ro.observe(panel.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      ro.disconnect();
    };
  }, [open, placement]);

  const end = placement.endsWith("end");
  const side = spot?.side ?? (placement.startsWith("top") ? "top" : "bottom");

  return (
    <div ref={anchorRef} className={cn("relative", className)}>
      {trigger({
        open,
        toggle: () => {
          setSpot(null);
          setOpen((o) => !o);
        },
        id,
      })}
      {client
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  ref={panel}
                  id={id}
                  initial={{ opacity: 0, scale: 0.96, y: side === "top" ? 4 : -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                  style={spot?.style ?? { top: 0, left: 0, visibility: "hidden" }}
                  className={cn(
                    "squircle scroll-thin fixed z-[70] min-w-[200px] overflow-y-auto rounded-[20px] bg-apple-2 p-1.5 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_40px_-8px_rgb(0_0_0/0.6)]",
                    side === "top" ? (end ? "origin-bottom-right" : "origin-bottom-left") : end ? "origin-top-right" : "origin-top-left",
                    panelClassName,
                  )}
                >
                  {children(() => setOpen(false))}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            host ?? document.body,
          )
        : null}
    </div>
  );
}

export function MenuItem({
  selected,
  onSelect,
  children,
  hint,
  disabled,
}: {
  selected?: boolean;
  onSelect: () => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "squircle flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left text-[13px] transition-colors duration-150 disabled:opacity-40",
        selected ? "bg-gaffer text-paper" : "text-fog hover:bg-gaffer/60 hover:text-paper active:bg-gaffer",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      {hint ? <span className="shrink-0 text-[12px] text-haze">{hint}</span> : null}
    </button>
  );
}
