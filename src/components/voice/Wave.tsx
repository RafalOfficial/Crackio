"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A waveform from a take's peaks (0–1), drawn as rounded bars: the part already heard in the voice's colour, the rest
 * quiet. Click anywhere on it to play from there.
 */
export function Wave({
  peaks,
  progress = 0,
  color = "#9be05c",
  className,
  onSeek,
  bar = 2,
  gap = 2,
}: {
  peaks: number[];
  progress?: number;
  color?: string;
  className?: string;
  onSeek?: (share: number) => void;
  bar?: number;
  gap?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  // What to draw, kept current for the one observer below: playback moves `progress` every frame, and recreating the
  // ResizeObserver with each move (60 times a second) was most of a playing take's cost.
  const input = useRef({ peaks, progress, color, bar, gap });
  const paint = useRef<() => void>(() => {});

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const { peaks, progress, color, bar, gap } = input.current;
      const { w, h } = size.current;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = Math.max(8, Math.floor((w + gap) / (bar + gap)));
      const list = peaks.length ? peaks : [0.1];
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i / n) * list.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / n) * list.length));
        let p = 0;
        for (let j = a; j < b && j < list.length; j++) p = Math.max(p, list[j]);
        const bh = Math.max(2, p * (h - 2));
        const x = i * (bar + gap);
        ctx.fillStyle = (i + 0.5) / n <= progress ? color : "rgba(240,239,237,0.22)";
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, (h - bh) / 2, bar, bh, bar / 2);
        else ctx.rect(x, (h - bh) / 2, bar, bh);
        ctx.fill();
      }
    };
    paint.current = draw;
    const ro = new ResizeObserver(([e]) => {
      size.current = { w: e.contentRect.width, h: e.contentRect.height };
      draw();
    });
    ro.observe(c);
    draw();
    return () => {
      ro.disconnect();
      paint.current = () => {};
    };
  }, []);

  useEffect(() => {
    input.current = { peaks, progress, color, bar, gap };
    paint.current();
  }, [peaks, progress, color, bar, gap]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("block h-full w-full", onSeek && "cursor-pointer", className)}
      onClick={
        onSeek
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onSeek(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)));
            }
          : undefined
      }
    />
  );
}
