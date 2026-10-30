"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import { Maximize2, Pause, Play } from "lucide-react";
import { screenTime, type Storyboard } from "@/lib/storyboard/types";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

/** One shot on the timeline: where it starts in the film, and which part of its clip plays. */
export type Segment = { id: string; n: number; title: string; start: number; length: number; clip?: string; in: number; out: number; still?: string };

export function segmentsOf(b: Storyboard): Segment[] {
  let start = 0;
  return b.shots.map((s, i) => {
    const length = screenTime(s);
    const seg: Segment = {
      id: s.id,
      n: i + 1,
      title: s.title,
      start,
      length,
      clip: s.clip,
      in: s.review?.in ?? 0,
      out: s.review?.out ?? (s.review?.in ?? 0) + length,
      still: s.frame,
    };
    start += length;
    return seg;
  });
}

export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export type PlayerHandle = { seek: (t: number, play?: boolean) => void; toggle: () => void };

type View = { front: number; index: number; playing: boolean; t: number };

/**
 * The playback engine, outside React: two video elements take turns, the next shot waiting paused
 * on its first frame, so a cut is a cut and not a flash. Shots without a clip hold their frame for
 * their length. It reports what to show; React only draws it.
 */
function createEngine() {
  let emit: (v: View) => void = () => {};
  const els: (HTMLVideoElement | null)[] = [null, null];
  let segments: Segment[] = [];
  let total = 0;
  let front = 0;
  let index = 0;
  let playing = false;
  let t = 0;
  let last = 0;
  let raf = 0;
  let sent = 0;

  const send = (force = false) => {
    const now = performance.now();
    // While playing, the clock moves 20 times a second; changes of shot go out at once.
    if (!force && now - sent < 50) return;
    sent = now;
    emit({ front, index, playing, t });
  };

  /** Put a shot into a video element at `offset` seconds into the shot, paused. */
  function prime(el: HTMLVideoElement | null, seg: Segment | undefined, offset = 0) {
    if (!el || !seg?.clip) return;
    if (!el.src.endsWith(seg.clip)) {
      el.src = seg.clip;
      el.load();
    }
    const to = seg.in + offset;
    const place = () => {
      try {
        el.currentTime = to;
      } catch {
        /* not seekable yet */
      }
    };
    if (el.readyState >= 1) place();
    else el.addEventListener("loadedmetadata", place, { once: true });
  }

  function show(k: number, offset: number, side: number) {
    index = k;
    front = side;
    prime(els[side], segments[k], offset);
    prime(els[1 - side], segments[k + 1], 0);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    for (const el of els) el?.pause();
    send(true);
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    const dt = (now - last) / 1000;
    last = now;
    const seg = segments[index];
    if (!seg) return stop();
    const el = els[front];
    // A clip that won't load plays as its still, for its length, rather than holding the film up.
    if (seg.clip && el && !el.error) {
      if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
      if (el.currentTime < seg.out - 0.035 && !el.ended) {
        t = Math.min(seg.start + Math.max(0, el.currentTime - seg.in), seg.start + seg.length);
        return send();
      }
    } else if (t + dt < seg.start + seg.length) {
      t += dt;
      return send();
    }
    // The cut.
    const next = index + 1;
    if (next >= segments.length) {
      t = total;
      return stop();
    }
    el?.pause();
    index = next;
    front = 1 - front;
    const incoming = els[front];
    if (segments[next].clip && incoming) {
      prime(incoming, segments[next], 0);
      void incoming.play().catch(() => {});
    }
    prime(els[1 - front], segments[next + 1], 0);
    t = segments[next].start;
    send(true);
  }

  function start() {
    if (!segments.length) return;
    if (t >= total - 0.06) {
      show(0, 0, front);
      t = 0;
    }
    playing = true;
    last = performance.now();
    const seg = segments[index];
    if (seg?.clip) void els[front]?.play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    send(true);
  }

  function seek(time: number, play?: boolean) {
    if (!segments.length) return;
    const clamped = Math.max(0, Math.min(time, Math.max(0, total - 0.05)));
    const k = Math.max(0, segments.findIndex((s) => clamped < s.start + s.length));
    for (const el of els) el?.pause();
    show(k, clamped - segments[k].start, front);
    t = clamped;
    if (play ?? playing) start();
    else send(true);
  }

  return {
    attach(i: number, el: HTMLVideoElement | null) {
      els[i] = el;
    },
    /** New clips and cuts arrive while you watch: keep the place. */
    setSegments(next: Segment[]) {
      segments = next;
      total = next.reduce((s, x) => s + x.length, 0);
      seek(Math.min(t, Math.max(0, total - 0.05)), playing);
    },
    seek,
    toggle: () => (playing ? stop() : start()),
    destroy: () => stop(),
    /** Who hears about time and shot changes. */
    listen(fn: (v: View) => void) {
      emit = fn;
      return () => {
        emit = () => {};
      };
    },
  };
}

/** The biggest box of this shape that fits inside `el`. */
function useFit(el: RefObject<HTMLDivElement | null>, ratio: number) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(([e]) => {
      const width = Math.min(e.contentRect.width, e.contentRect.height * ratio);
      setSize(width > 0 ? { width, height: width / ratio } : null);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, ratio]);
  return size;
}

/** The film as it's cut right now, played straight from the shots' clips: each from its in point to its cut. */
export const SequencePlayer = forwardRef<PlayerHandle, { board: Storyboard; onTime: (t: number) => void; className?: string }>(function SequencePlayer(
  { board, onTime, className },
  ref,
) {
  const segments = useMemo(() => segmentsOf(board), [board]);
  const total = segments.reduce((t, s) => t + s.length, 0);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ front: 0, index: 0, playing: false, t: 0 });
  const [engine] = useState(createEngine);
  useEffect(
    () =>
      engine.listen((v) => {
        setView(v);
        onTime(v.t);
      }),
    [engine, onTime],
  );

  const shape = segments.map((s) => `${s.id}:${s.clip ?? ""}:${s.in}:${s.out}:${s.length}`).join("|");
  useEffect(() => {
    engine.setSegments(segments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, shape]);
  useEffect(() => () => engine.destroy(), [engine]);
  useImperativeHandle(ref, () => ({ seek: engine.seek, toggle: engine.toggle }), [engine]);

  // Space plays and pauses (unless you're typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.code !== "Space" || el?.closest("input, textarea, select, [contenteditable=true], button")) return;
      e.preventDefault();
      engine.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const seg = segments[view.index];
  const [w, h] = board.aspect.split(":").map(Number);
  const size = useFit(box, w / h);

  return (
    <div ref={box} className={cn("relative flex min-h-0 items-center justify-center", className)}>
      <div className="relative overflow-hidden rounded-[14px] bg-black shadow-[0_30px_80px_-30px_rgb(0_0_0/0.8),0_0_0_1px_var(--color-line)]" style={size ?? { width: "100%", aspectRatio: `${w} / ${h}` }}>
        {[0, 1].map((i) => (
          <video
            key={i}
            ref={(el) => engine.attach(i, el)}
            muted
            playsInline
            preload="auto"
            className={cn("absolute inset-0 size-full object-contain", view.front === i && seg?.clip ? "opacity-100" : "opacity-0")}
          />
        ))}
        {seg && !seg.clip ? (
          seg.still ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl(seg.still, 1280)} alt="" className="absolute inset-0 size-full object-contain" />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-center">
              <p className="text-[13px] text-haze">Shot {seg.n} isn&apos;t made yet</p>
            </div>
          )
        ) : null}
        {!segments.length ? <div className="skeleton absolute inset-0" /> : null}

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-2.5 pt-10">
          <button
            type="button"
            onClick={() => engine.toggle()}
            disabled={!segments.length}
            className="press grid size-9 place-items-center rounded-full bg-white/90 text-[#16131b] hover:bg-white disabled:opacity-40"
            aria-label={view.playing ? "Pause" : "Play"}
          >
            {view.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
          </button>
          <span className="tabular font-mono text-[12px] text-white/90">
            {clock(view.t)} / {clock(total)}
          </span>
          {seg ? (
            <span className="truncate rounded-full bg-black/50 px-2 py-0.5 text-[11.5px] font-semibold text-white/85 ring-1 ring-white/10">
              Shot {seg.n} · {seg.title}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void box.current?.requestFullscreen?.().catch(() => {})}
            className="press ml-auto grid size-8 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Full screen"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
});
