"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

/**
 * A small window that floats above its trigger on hover (or focus) and plays a short clip:
 * what a camera move, a pace or a frame shape will look like before you pick it.
 * Rendered in a portal so panels with overflow never clip it.
 */
export function HoverPreview({
  children,
  title,
  caption,
  src,
  ratio = 1,
  /** Show the clip cropped to this aspect ratio instead of its own. */
  crop,
  width = 220,
  media,
  className,
}: {
  children: ReactNode;
  title: string;
  caption?: string;
  src?: string;
  ratio?: number;
  crop?: number;
  width?: number;
  /** Custom content instead of a single clip. */
  media?: ReactNode;
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Something inside was pressed (a picker opening): no preview until the pointer leaves. */
  const pressed = useRef(false);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    if (pressed.current) return;
    timer.current = setTimeout(() => {
      // A `display: contents` wrapper has no box of its own; measure what it wraps.
      const el = anchor.current;
      const box = el && getComputedStyle(el).display === "contents" ? (el.firstElementChild ?? el) : el;
      const r = box?.getBoundingClientRect();
      if (!r) return;
      const frame = crop ?? ratio;
      const height = width / frame + (caption ? 64 : 44);
      const below = r.top < height + 16;
      const left = Math.min(window.innerWidth - width / 2 - 12, Math.max(width / 2 + 12, r.left + r.width / 2));
      setPos({ left, top: below ? r.bottom + 10 : r.top - 10, below });
      setOpen(true);
    }, 120);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // Leaving the page closes it: Next keeps the page mounted (hidden), and the portal would stay on top.
  useLayoutEffect(() => () => setOpen(false), []);

  const frame = crop ?? ratio;
  return (
    <span
      ref={anchor}
      onMouseEnter={show}
      onMouseLeave={() => {
        pressed.current = false;
        hide();
      }}
      onPointerDown={() => {
        pressed.current = true;
        hide();
      }}
      onFocus={show}
      onBlur={hide}
      className={className ?? "contents"}
    >
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open && pos ? (
                <div
                  key="preview"
                  className="pointer-events-none fixed z-[90]"
                  style={{ left: pos.left, top: pos.top, width, transform: `translate(-50%, ${pos.below ? "0%" : "-100%"})` }}
                >
                  <motion.div
                    initial={{ opacity: 0, y: pos.below ? -6 : 6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: pos.below ? -4 : 4, scale: 0.97 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden rounded-[16px] border border-white/12 bg-[#1b1820]/95 p-1.5 shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)] backdrop-blur-xl"
                  >
                    <div className="relative overflow-hidden rounded-[11px] bg-black" style={{ aspectRatio: frame }}>
                      {media ?? (src ? <video src={src} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" /> : null)}
                    </div>
                    <div className="px-1.5 pb-1 pt-2">
                      <p className="text-[12.5px] font-semibold text-paper">{title}</p>
                      {caption ? <p className="mt-0.5 text-[11.5px] leading-snug text-haze">{caption}</p> : null}
                    </div>
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </span>
  );
}
