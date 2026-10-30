"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

const GAP = 18;
/** How far the pull reaches (px, a Gaussian's width), how far the nearest dots are pushed out, and how much they sink. */
const REACH = 128;
const PUSH = 30;
const SINK = 0.55;
const PAPER = "#f0efed";
const SPIKE = "#ff5b2e";

/**
 * A field of dots that bends around the pointer like a grid around a heavy mass: the dots near it are pushed outward and
 * sink (smaller, dimmer, a little lower), so the flat grid reads as a well in space. Without a pointer a slow phantom mass
 * drifts across it, so it never sits still. `progress` (0 to 1) lights the dots behind a soft front sweeping left to right,
 * with a warm band at the front.
 *
 * One canvas and one draw a frame (a couple of thousand small squares), paused while it's off screen or the tab is in the
 * background, and drawn once, still, for reduced motion. It listens for the pointer on its parent, so whatever lies on
 * top of it (with pointer-events off) still bends it.
 */
export function DotField({ progress = 0, className }: { progress?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wanted = useRef(progress);
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    wanted.current = Math.max(0, Math.min(1, progress));
    redraw.current?.();
  }, [progress]);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let left = 0;
    let top = 0;
    let offX = new Float32Array(0);
    let offY = new Float32Array(0);
    const pointer = { x: 0, y: 0, in: false };
    let pull = still ? 0 : 0.55;
    let front = wanted.current;
    let raf = 0;
    let onScreen = true;

    const measure = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      cols = Math.ceil(w / GAP) + 1;
      rows = Math.ceil(h / GAP) + 1;
      left = (w - (cols - 1) * GAP) / 2;
      top = (h - (rows - 1) * GAP) / 2;
      offX = new Float32Array(cols * rows);
      offY = new Float32Array(cols * rows);
    };

    const band: number[] = [];
    const draw = (t: number) => {
      // The mass: the pointer, else a phantom on a slow figure-eight.
      const mx = pointer.in ? pointer.x : w * (0.5 + 0.32 * Math.sin(t / 3100));
      const my = pointer.in ? pointer.y : h * (0.5 + 0.26 * Math.sin(t / 2300 + 1.3));
      if (!still) pull += ((pointer.in ? 1 : 0.55) - pull) * 0.06;
      front += (wanted.current - front) * (still ? 1 : 0.06);
      const fx = front * w;
      const r2 = REACH * REACH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = PAPER;
      band.length = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          const bx = left + i * GAP;
          const by = top + j * GAP;
          const dx = bx - mx;
          const dy = by - my;
          const d2 = dx * dx + dy * dy;
          let f = 0;
          let tx = 0;
          let ty = 0;
          if (pull > 0.01 && d2 < 9 * r2) {
            f = Math.exp(-d2 / (2 * r2)) * pull;
            const d = Math.sqrt(d2) || 1;
            tx = (dx / d) * PUSH * f;
            ty = (dy / d) * PUSH * f + 5 * f;
          }
          offX[k] += (tx - offX[k]) * (still ? 1 : 0.16);
          offY[k] += (ty - offY[k]) * (still ? 1 : 0.16);
          // Lit behind the front, fading out just ahead of it.
          const lit = bx <= fx ? 1 : Math.max(0, 1 - (bx - fx) / 70);
          const size = (1.6 + 0.6 * lit) * (1 - SINK * f);
          ctx.globalAlpha = (0.13 + 0.27 * lit) * (1 - 0.6 * f);
          const x = bx + offX[k];
          const y = by + offY[k];
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
          if (front > 0.005 && front < 0.995 && Math.abs(bx - fx) < 26) band.push(x, y, 1 - Math.abs(bx - fx) / 26, f);
        }
      }
      // The front: the dots on it warm and a little larger.
      ctx.fillStyle = SPIKE;
      for (let n = 0; n < band.length; n += 4) {
        const near = band[n + 2];
        const size = (2 + 1.2 * near) * (1 - SINK * band[n + 3]);
        ctx.globalAlpha = 0.65 * near;
        ctx.fillRect(band[n] - size / 2, band[n + 1] - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    };

    const loop = (t: number) => {
      raf = 0;
      draw(t);
      if (!still && onScreen && document.visibilityState === "visible") raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    redraw.current = () => (still ? draw(performance.now()) : start());

    const resize = new ResizeObserver(() => {
      measure();
      draw(performance.now());
    });
    resize.observe(canvas);
    const seen = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen) start();
    });
    seen.observe(canvas);
    const back = () => {
      if (document.visibilityState === "visible") start();
    };
    document.addEventListener("visibilitychange", back);
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.in = true;
      start();
    };
    const leave = () => {
      pointer.in = false;
    };
    if (!still) {
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerleave", leave);
    }
    measure();
    draw(performance.now());
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      redraw.current = null;
      resize.disconnect();
      seen.disconnect();
      document.removeEventListener("visibilitychange", back);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full", className)} />;
}
