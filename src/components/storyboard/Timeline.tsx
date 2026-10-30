"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link2, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Storyboard } from "@/lib/storyboard/types";
import { previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { cn } from "@/lib/cn";
import { segmentsOf } from "./SequencePlayer";
import { shotState, TONE } from "./shot-state";

/**
 * The film as a strip of shots, each as wide as it plays, with the playhead on it. Click or drag
 * anywhere to scrub; click a shot to open it on the right.
 */
export function Timeline({
  board,
  t,
  selected,
  onSeek,
  onSelect,
}: {
  board: Storyboard;
  t: number;
  selected: string | null;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
}) {
  const segments = useMemo(() => segmentsOf(board), [board]);
  const total = Math.max(1, segments.reduce((s, x) => s + x.length, 0));
  const outer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The whole film fits when it can; long films scroll.
  const pad = 12;
  const pps = Math.max(30, Math.min(160, (width - pad * 2) / total));
  const inner = total * pps + pad * 2;
  const x = (time: number) => pad + time * pps;
  const timeAt = (clientX: number) => {
    const el = outer.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + el.scrollLeft - pad) / pps));
  };
  const scrubbing = useRef(false);

  // Keep the playhead in view while it plays.
  useEffect(() => {
    const el = outer.current;
    if (!el || scrubbing.current) return;
    const px = x(t);
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 40) el.scrollTo({ left: Math.max(0, px - el.clientWidth / 3) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const step = total > 40 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor(total) + 1 }, (_, i) => i);

  return (
    <div
      ref={outer}
      className="scroll-thin relative select-none overflow-x-auto overflow-y-hidden"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-shot]")) return;
        scrubbing.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => scrubbing.current && onSeek(timeAt(e.clientX))}
      onPointerUp={() => (scrubbing.current = false)}
      onPointerCancel={() => (scrubbing.current = false)}
    >
      <div className="relative h-[104px]" style={{ width: Math.max(inner, width) }}>
        {/* Ruler */}
        <div className="absolute inset-x-0 top-0 h-5">
          {ticks.map((s) => (
            <span key={s} className={cn("absolute top-0 w-px", s % step === 0 ? "h-2.5 bg-white/30" : "h-1.5 bg-white/12")} style={{ left: x(s) }}>
              {s % step === 0 ? <span className="tabular absolute left-1 top-0.5 font-mono text-[9.5px] text-haze">{s}s</span> : null}
            </span>
          ))}
        </div>

        {/* Shots */}
        {segments.map((seg, i) => {
          const s = board.shots[i];
          const state = shotState(board, s, i);
          const thumb = s.frame ?? s.outFrame;
          const w = Math.max(18, seg.length * pps - 4);
          // Finished shots keep quiet; a shot at work or with a problem says so (the length steps aside on small tiles).
          const showLabel = state.busy || state.tone !== "done";
          return (
            <button
              key={seg.id}
              type="button"
              data-shot
              onClick={() => {
                onSelect(seg.id);
                onSeek(seg.start + 0.01);
              }}
              title={`Shot ${seg.n} · ${seg.title} · ${state.label}`}
              className={cn(
                "press group absolute top-6 h-[66px] overflow-hidden rounded-[10px] bg-apple text-left transition-shadow",
                selected === seg.id ? "shadow-[0_0_0_2px_var(--color-tool-storyboard)]" : "shadow-[0_0_0_1px_var(--color-line-strong)] hover:shadow-[0_0_0_1px_rgb(255_255_255/0.32)]",
                !thumb && "bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
              )}
              style={{ left: x(seg.start) + 2, width: w }}
            >
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl(thumb, 320)} alt="" loading="lazy" decoding="async" className={cn("absolute inset-0 size-full object-cover", !s.clip && "opacity-60")} />
              ) : null}
              {state.busy ? <GeneratingField bare backdrop={thumb ? previewUrl(thumb, 320) : null} /> : null}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4">
                <span className="flex items-center gap-1 text-[10.5px] font-semibold text-white/95">
                  <span className="tabular shrink-0 font-mono text-white/70">{seg.n}</span>
                  {w > 70 ? <span className="truncate">{seg.title}</span> : null}
                </span>
              </span>
              {showLabel ? (
                <span
                  className={cn("absolute left-1 top-1 flex max-w-[calc(100%-8px)] items-center gap-1 whitespace-nowrap rounded-full bg-black/65 px-1.5 py-px text-[9.5px] font-semibold ring-1 ring-white/10", TONE[state.tone])}
                >
                  {state.busy ? <LoaderCircle size={9} className="shrink-0 animate-spin" /> : state.tone === "error" || state.tone === "warn" ? <TriangleAlert size={9} className="shrink-0" /> : null}
                  <span className="truncate">{state.label}</span>
                </span>
              ) : null}
              {w > 54 && (!showLabel || w > 132) ? <span className="tabular absolute right-1 top-1 rounded bg-black/60 px-1 font-mono text-[9.5px] text-white/85">{seg.length.toFixed(1)}s</span> : null}
            </button>
          );
        })}

        {/* Takes that keep rolling */}
        {segments.slice(1).map((seg, i) =>
          board.shots[i + 1].transition === "continuous" ? (
            <span
              key={seg.id}
              title="Continues the same take"
              className="pointer-events-none absolute top-[50px] z-10 grid size-4 -translate-x-1/2 place-items-center rounded-full bg-stage text-fog ring-1 ring-white/20"
              style={{ left: x(seg.start) }}
            >
              <Link2 size={9} />
            </span>
          ) : null,
        )}

        {/* Playhead */}
        <span className="pointer-events-none absolute bottom-1 top-0 z-20 w-px bg-spike" style={{ left: x(Math.min(t, total)) }}>
          <span className="absolute -left-[5px] top-0 size-[11px] rounded-full bg-spike shadow-[0_0_0_2px_var(--color-stage)]" />
        </span>
      </div>
    </div>
  );
}
