"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { nanoid } from "nanoid";
import { Film, ListPlus, Music2, Sparkles, VolumeX } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { clipFromFile, filmLength, lengthOf, placed, speedOf, timecode, type EditClip, type EditFile } from "@/lib/storyboard/edit";
import { addMusic, dropIndex, duplicate, insertMain, moveMain, patchClip, removeClip, splitAt, trimmed } from "@/lib/storyboard/edit-ops";
import { useGenerations } from "@/lib/hooks/use-generations";
import { previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { usePlayhead } from "./engine";
import { film, FILE_DRAG, useFileDrag } from "./film";
import { useProjectFiles } from "./project-files";
import { addAllToFilm, isFilm } from "./Files";
import { cn } from "@/lib/cn";

/**
 * The cut, CapCut-style: a ruler, the film's track (pictures and clips one after the other: magnetic, so nothing leaves a
 * gap), and a music lane under it. Drag files in from the right, drag pieces to reorder (the others slide aside), drag
 * their edges to trim; drag anywhere else (or the playhead's head) to scrub; the wheel slides along, Ctrl + wheel zooms.
 * Its zoom and the shot tools live in the controls above it (Controls, the screen's selection bar).
 *
 * Kept smooth on purpose: the playhead moves outside React, a drag or a trim changes the cut at most once a frame (a
 * trackpad sends 120 moves a second), the pieces that didn't move don't redraw, and every drag listens on the window,
 * so a piece that's redrawn under the pointer can't strand it (a reorder froze half-way that way, with the film playing
 * an order the track no longer showed).
 */

/** Room before the film's first second. */
const PAD = 14;
const RULER = 22;
const MAIN = 64;
const MUSIC = 30;
const MIN_PPS = 4;
const MAX_PPS = 320;
/** How near an edge (px) a drag starts sliding the cut along. */
const EDGE = 48;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const noop = () => {};

/** The newest of a burst of values, applied once per frame (and `flush`ed when the pointer lets go). */
function perFrame<T>(apply: (value: T) => void) {
  let raf = 0;
  let last: T;
  let waiting = false;
  const run = (value: T) => {
    last = value;
    waiting = true;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        waiting = false;
        apply(last);
      });
  };
  run.flush = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (waiting) {
      waiting = false;
      apply(last);
    }
  };
  run.cancel = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    waiting = false;
  };
  return run;
}

/**
 * A drag that follows the pointer anywhere until it lets go: listens on the window (not on the element pressed, which
 * may be redrawn or moved meanwhile), and ends on release, cancel or the window losing focus.
 */
function follow(onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent | null) => void) {
  const move = (e: PointerEvent) => onMove(e);
  const up = (e: PointerEvent) => end(e);
  const blur = () => end(null);
  function end(e: PointerEvent | null) {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", blur);
    onEnd(e);
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", blur);
}

/**
 * While a drag is near the cut's left or right edge, the cut slides that way (faster nearer the edge); `step` runs after
 * each slide so whatever is dragged keeps up with the pointer.
 */
function edgeSlide(el: HTMLElement, step: () => void) {
  let x = 0;
  let raf = 0;
  const tick = () => {
    raf = 0;
    const r = el.getBoundingClientRect();
    const v = x < r.left + EDGE ? -((r.left + EDGE - x) / EDGE) : x > r.right - EDGE ? (x - (r.right - EDGE)) / EDGE : 0;
    if (!v) return;
    const before = el.scrollLeft;
    el.scrollLeft = before + clamp(v, -1.5, 1.5) * 18;
    if (el.scrollLeft !== before) step();
    raf = requestAnimationFrame(tick);
  };
  return {
    at(clientX: number) {
      x = clientX;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/** Split, duplicate and delete what's selected (or what's under the playhead): the controls and the keys share them. */
export const cut = {
  split() {
    const { timeline, selected, change, select } = useEditor.getState();
    const t = usePlayhead.getState().t;
    // A selected sound under the playhead, else the picture or clip under it.
    const music = timeline.music.find((c) => c.id === selected && t > (c.at ?? 0) && t < (c.at ?? 0) + lengthOf(c))?.id;
    const id = music ?? placed(timeline.main).find((p) => t > p.start && t < p.end)?.clip.id;
    if (!id) return;
    const newId = nanoid(8);
    change((tl) => splitAt(tl, id, t, newId));
    select(newId);
  },
  duplicate() {
    const { selected, change, select } = useEditor.getState();
    if (!selected) return;
    const newId = nanoid(8);
    change((tl) => duplicate(tl, selected, newId));
    select(newId);
  },
  remove() {
    const { selected, change, select, pick, setPick } = useEditor.getState();
    if (!selected) return;
    change((tl) => removeClip(tl, selected));
    if (pick?.clip === selected) setPick(null);
    select(null);
  },
  /** The selected shot one place earlier (-1) or later (1) in the film. */
  nudge(dir: -1 | 1) {
    const { selected, timeline, change } = useEditor.getState();
    const from = timeline.main.findIndex((c) => c.id === selected);
    if (from < 0) return;
    const to = from + dir;
    if (to < 0 || to >= timeline.main.length) return;
    change((t) => moveMain(t, selected!, to));
  },
};

/** The timeline's zoom for the controls above it (filled while it's mounted). */
export const timelineZoom: { by: (factor: number) => void; fit: () => void } = { by: () => {}, fit: () => {} };

/** Seek, and keep going while the pointer is held: the film follows it, and the cut slides along at its edges. */
function scrubFrom(e: ReactPointerEvent, el: HTMLElement, timeAt: (clientX: number) => number) {
  if (e.button !== 0) return;
  e.preventDefault();
  const was = usePlayhead.getState().playing;
  if (was) film.pause();
  let x = e.clientX;
  const seek = perFrame((cx: number) => film.seek(Math.max(0, timeAt(cx))));
  film.seek(Math.max(0, timeAt(x)));
  const slide = edgeSlide(el, () => seek(x));
  document.body.style.cursor = "ew-resize";
  follow(
    (ev) => {
      x = ev.clientX;
      seek(x);
      slide.at(x);
    },
    () => {
      seek.flush();
      slide.stop();
      document.body.style.cursor = "";
    },
  );
}

export function Timeline() {
  const total = useEditor((s) => filmLength(s.timeline));
  const musicEnd = useEditor((s) => s.timeline.music.reduce((m, c) => Math.max(m, (c.at ?? 0) + lengthOf(c)), 0));
  const zoom = useEditor((s) => s.zoom);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(800);
  const fitPps = clamp((view - PAD * 2) / Math.max(total, 6), MIN_PPS, 120);
  const pps = zoom ?? fitPps;
  const width = Math.max(view, PAD * 2 + (Math.max(total, musicEnd) + 6) * pps);
  // The ruler is drawn in whole ten-second spans, so a trim doesn't redraw it.
  const rulerSeconds = Math.ceil((width - PAD) / pps / 10) * 10;

  // The room's width, once it settles: the sidebar sliding or a window being resized would otherwise refit (and ask
  // for new frames) on every step of it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer: number | undefined;
    setView(el.clientWidth);
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setView((v) => (Math.abs(v - el.clientWidth) >= 8 ? el.clientWidth : v)), 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // Ctrl + wheel (or a pinch) zooms around the pointer; the wheel slides the cut along, a mouse's notches eased into a
  // glide (a trackpad's own sideways swipe is left alone: it's smooth already).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let goal = el.scrollLeft;
    let raf = 0;
    const glide = () => {
      const d = goal - el.scrollLeft;
      if (Math.abs(d) < 0.6) {
        el.scrollLeft = goal;
        raf = 0;
        return;
      }
      el.scrollLeft += d * 0.22;
      raf = requestAnimationFrame(glide);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        const at = (x + el.scrollLeft - PAD) / pps;
        const next = clamp(pps * Math.exp(-e.deltaY * 0.0022), MIN_PPS, MAX_PPS);
        useEditor.getState().setZoom(next);
        requestAnimationFrame(() => (el.scrollLeft = Math.max(0, at * next + PAD - x)));
        return;
      }
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const d = e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? el.clientWidth : 1);
      // Small steps (a trackpad scrolling up and down) go straight on; a mouse's big notches glide.
      if (Math.abs(d) < 30 && !raf) {
        el.scrollLeft += d;
        return;
      }
      if (!raf) goal = el.scrollLeft;
      goal = clamp(goal + d * 1.2, 0, el.scrollWidth - el.clientWidth);
      if (!raf) raf = requestAnimationFrame(glide);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(raf);
    };
  }, [pps]);

  // While it plays, the cut scrolls along with it.
  const ppsNow = useRef(pps);
  useEffect(() => {
    ppsNow.current = pps;
  }, [pps]);
  useEffect(
    () =>
      usePlayhead.subscribe(({ t, playing }) => {
        const el = scroller.current;
        if (!el || !playing) return;
        const x = PAD + t * ppsNow.current;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.25);
      }),
    [],
  );

  /** Seconds of the film under a pointer. */
  const timeAt = useCallback(
    (clientX: number) => {
      const el = scroller.current!;
      return (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / pps;
    },
    [pps],
  );

  // The controls' zoom buttons: the playhead stays where it is on screen.
  useEffect(() => {
    timelineZoom.by = (factor: number) => {
      const el = scroller.current;
      const next = clamp(pps * factor, MIN_PPS, MAX_PPS);
      const t = usePlayhead.getState().t;
      const x = el ? PAD + t * pps - el.scrollLeft : 0;
      useEditor.getState().setZoom(next);
      if (el) requestAnimationFrame(() => (el.scrollLeft = Math.max(0, PAD + t * next - x)));
    };
    timelineZoom.fit = () => useEditor.getState().setZoom(null);
  }, [pps]);

  const scrub = useCallback((e: ReactPointerEvent) => scroller.current && scrubFrom(e, scroller.current, timeAt), [timeAt]);

  return (
    <div ref={scroller} aria-label="Timeline" className="scroll-thin relative h-[146px] shrink-0 overflow-x-auto overflow-y-hidden">
      <div className="relative h-full" style={{ width }}>
        <Ruler pps={pps} seconds={rulerSeconds} onScrub={scrub} />
        <MainTrack pps={pps} timeAt={timeAt} scroller={scroller} onScrub={scrub} />
        <MusicTrack pps={pps} timeAt={timeAt} onScrub={scrub} />
        <Playhead pps={pps} onScrub={scrub} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ ruler and playhead */

const Ruler = memo(function Ruler({ pps, seconds, onScrub }: { pps: number; seconds: number; onScrub: (e: ReactPointerEvent) => void }) {
  // A label every 1, 2, 5, 10… seconds, whichever keeps them at least 70 px apart; the small ticks are one painted strip.
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 70) ?? 300;
  const minor = step / (step >= 10 ? 5 : step >= 1 ? 4 : 5);
  const majors: number[] = [];
  for (let t = 0; t <= seconds; t = Math.round((t + step) * 1000) / 1000) majors.push(t);
  return (
    <div className="relative cursor-ew-resize select-none overflow-hidden" style={{ height: RULER }} onPointerDown={onScrub}>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 h-1"
        style={{ left: PAD, width: seconds * pps, backgroundImage: `repeating-linear-gradient(90deg, rgb(255 255 255 / 0.1) 0 1px, transparent 1px ${minor * pps}px)` }}
      />
      {majors.map((t) => (
        <span key={t} className="absolute bottom-0 h-2 w-px bg-white/25" style={{ left: PAD + t * pps }}>
          <span className="tabular absolute bottom-2.5 left-1 whitespace-nowrap font-mono text-[10px] text-haze/80">{timecode(t, false)}</span>
        </span>
      ))}
    </div>
  );
});

/** The playhead follows the film outside React: moved by its transform, never redrawn while it plays. Its head drags. */
function Playhead({ pps, onScrub }: { pps: number; onScrub: (e: ReactPointerEvent) => void }) {
  const line = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = (t: number) => {
      if (line.current) line.current.style.transform = `translate3d(${PAD + t * pps}px, 0, 0)`;
    };
    place(usePlayhead.getState().t);
    return usePlayhead.subscribe((s, prev) => {
      if (s.t !== prev.t) place(s.t);
    });
  }, [pps]);
  return (
    <div ref={line} className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-paper will-change-transform">
      <span
        onPointerDown={onScrub}
        title="Drag to move through the film"
        className="pointer-events-auto absolute -left-[9px] top-0 grid h-[18px] w-[19px] cursor-ew-resize touch-none place-items-start justify-center"
      >
        <span className="mt-0.5 h-3 w-[11px] rounded-b-[5px] rounded-t-[2px] bg-paper shadow-[0_1px_4px_rgb(0_0_0/0.5)]" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ the film's track */

type Drag = { id: string; grab: number; x: number } | null;

function MainTrack({ pps, timeAt, scroller, onScrub }: { pps: number; timeAt: (x: number) => number; scroller: React.RefObject<HTMLDivElement | null>; onScrub: (e: ReactPointerEvent) => void }) {
  const main = useEditor((s) => s.timeline.main);
  const selected = useEditor((s) => s.selected);
  const [drag, setDrag] = useState<Drag>(null);
  // Just after a drop: the pieces glide to their new places instead of jumping there.
  const [settling, setSettling] = useState(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const upload = useProjectFiles((s) => s.upload);
  const unused = useProjectFiles((s) => {
    const used = new Set(main.map((c) => c.url));
    return s.items.filter((f) => f.kind !== "audio" && !isFilm(f) && !used.has(f.url)).length;
  });

  // One handler for every piece, always the newest: the pieces stay memoized while the track redraws around them.
  const press = useRef<(e: ReactPointerEvent, clip: EditClip) => void>(noop);
  useLayoutEffect(() => {
    press.current = startMove;
  });
  const onBodyDown = useCallback((e: ReactPointerEvent, clip: EditClip) => press.current(e, clip), []);

  // While a piece is dragged it follows the pointer, and the others make room where it would land. Every piece keeps its
  // place in the page (drawn in the film's order), so the one in your hand is never redrawn from scratch under it.
  const dragged = drag ? (main.find((c) => c.id === drag.id) ?? null) : null;
  const positions = new Map<string, { left: number; width: number }>();
  if (dragged && drag) {
    const rest = main.filter((c) => c.id !== drag.id);
    const landing = dropIndex(main, (drag.x - drag.grab - PAD) / pps + lengthOf(dragged) / 2, drag.id);
    const room = lengthOf(dragged);
    for (const p of placed(rest)) positions.set(p.clip.id, { left: PAD + (p.start + (p.index >= landing ? room : 0)) * pps, width: (p.end - p.start) * pps });
    positions.set(dragged.id, { left: drag.x - drag.grab, width: room * pps });
  } else {
    for (const p of placed(main)) positions.set(p.clip.id, { left: PAD + p.start * pps, width: (p.end - p.start) * pps });
  }
  const marker = dropAt !== null ? (placed(main)[dropAt]?.start ?? filmLength({ main, music: [] })) : null;

  const visual = (f: EditFile | null) => Boolean(f && f.kind !== "audio");

  return (
    <div
      className="relative my-1.5"
      style={{ height: MAIN }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        useEditor.getState().select(null);
        onScrub(e);
      }}
      onDragOver={(e) => {
        const file = useFileDrag.getState().file;
        const os = Array.from(e.dataTransfer.types).includes("Files");
        if (!visual(file) && !os) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const at = dropIndex(main, timeAt(e.clientX));
        setDropAt((d) => (d === at ? d : at));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const index = dropIndex(main, timeAt(e.clientX));
        setDropAt(null);
        const file = useFileDrag.getState().file;
        const place = (files: EditFile[]) => {
          const clips = files.filter((f) => f.kind !== "audio").map((f) => clipFromFile(f, nanoid(8)));
          if (!clips.length) return;
          const { change, select } = useEditor.getState();
          change((t) => clips.reduce((acc, c, i) => insertMain(acc, c, index + i), t));
          select(clips[clips.length - 1].id);
        };
        if (visual(file) && e.dataTransfer.types.includes(FILE_DRAG)) return place([file!]);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void upload(files).then(place);
      }}
    >
      {!main.length ? (
        <div className="absolute inset-y-0 left-[14px] right-3 flex items-center justify-center gap-3 rounded-[12px] border border-dashed border-white/[0.1] text-[12.5px] text-haze">
          <span className="pointer-events-none flex items-center gap-2">
            <Film size={14} /> Drag your shots here
          </span>
          {unused ? (
            <button
              type="button"
              onClick={addAllToFilm}
              className="press squircle inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-white/[0.07] px-2.5 text-[12px] font-semibold text-paper hover:bg-white/[0.11]"
            >
              <ListPlus size={13} /> Add all {unused}
            </button>
          ) : null}
        </div>
      ) : null}
      {main.map((clip, i) => {
        const pos = positions.get(clip.id)!;
        const lifted = clip.id === drag?.id;
        return (
          <ClipBlock
            key={clip.id}
            number={i + 1}
            clip={clip}
            left={pos.left}
            width={pos.width}
            pps={pps}
            selected={selected === clip.id || lifted}
            lifted={lifted}
            glide={(Boolean(drag) && !lifted) || settling}
            onBodyDown={onBodyDown}
          />
        );
      })}
      {marker !== null ? <span className="pointer-events-none absolute inset-y-[-4px] z-10 w-[3px] -translate-x-1/2 rounded-full bg-spike" style={{ left: PAD + marker * pps }} /> : null}
    </div>
  );

  /** Press on a piece: it's selected; past a few pixels it lifts and moves. A press without a move seeks there. */
  function startMove(e: ReactPointerEvent, clip: EditClip) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = scroller.current;
    const { select, setPick, timeline } = useEditor.getState();
    select(clip.id);
    // A picture opens Make a clip for it (a clip leaves whatever you were making open).
    if (clip.kind === "image") setPick({ file: fileOfClip(clip), clip: clip.id });
    const left = PAD + (placed(timeline.main).find((p) => p.clip.id === clip.id)?.start ?? 0) * pps;
    const x0 = e.clientX;
    let x = x0;
    const toContent = (clientX: number) => PAD + timeAt(clientX) * pps;
    const grab = toContent(x0) - left;
    let moving = false;
    const lift = perFrame((cx: number) => setDrag({ id: clip.id, grab, x: toContent(cx) }));
    const slide = el ? edgeSlide(el, () => lift(x)) : null;
    follow(
      (ev) => {
        x = ev.clientX;
        if (!moving && Math.abs(x - x0) < 5) return;
        if (!moving) document.body.style.cursor = "grabbing";
        moving = true;
        lift(x);
        slide?.at(x);
      },
      (ev) => {
        lift.cancel();
        slide?.stop();
        document.body.style.cursor = "";
        if (moving) {
          const now = useEditor.getState().timeline.main;
          const to = dropIndex(now, (toContent(ev?.clientX ?? x) - grab - PAD) / pps + lengthOf(clip) / 2, clip.id);
          useEditor.getState().change((t) => moveMain(t, clip.id, to));
          setSettling(true);
          window.setTimeout(() => setSettling(false), 220);
        } else if (ev) film.seek(Math.max(0, timeAt(ev.clientX)));
        setDrag(null);
      },
    );
  }
}

/** The file a still on the timeline is, for making a clip from it. */
export function fileOfClip(c: EditClip): EditFile {
  return { key: c.gen ? `gen:${c.gen}:0` : `clip:${c.id}`, url: c.url, kind: c.kind, name: c.name ?? "Picture", width: c.width, height: c.height, gen: c.gen, createdAt: 0 };
}

const ClipBlock = memo(function ClipBlock({
  clip,
  number,
  left,
  width,
  pps,
  selected,
  lifted,
  glide,
  onBodyDown,
}: {
  clip: EditClip;
  number: number;
  left: number;
  width: number;
  pps: number;
  selected: boolean;
  lifted?: boolean;
  glide?: boolean;
  onBodyDown: (e: ReactPointerEvent, clip: EditClip) => void;
}) {
  const making = useGenerations((s) => (clip.making ? s.items.find((g) => g.id === clip.making) : undefined));
  const speed = speedOf(clip);
  return (
    <div
      data-clip={clip.id}
      onPointerDown={(e) => onBodyDown(e, clip)}
      className={cn(
        "group absolute inset-y-0 cursor-grab touch-none select-none overflow-hidden rounded-[10px] bg-apple-2",
        selected ? "z-10 shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        lifted && "z-30 scale-[1.03] cursor-grabbing opacity-90 shadow-[0_0_0_2px_var(--color-spike),0_16px_36px_-10px_rgb(0_0_0/0.9)]",
      )}
      style={{ left: left + 1, width: Math.max(6, width - 2), transition: glide ? "left 200ms cubic-bezier(0.2, 0.8, 0.2, 1)" : undefined }}
    >
      <Strip clip={clip} width={width} pps={pps} />
      {/* The shot's number, as on a storyboard; its length and speed when you point at it. */}
      {width > 22 ? <span className="tabular pointer-events-none absolute left-1.5 top-1.5 rounded-[6px] bg-black/60 px-1.5 py-px text-[10.5px] font-semibold leading-4 text-paper">{number}</span> : null}
      {width > 64 ? (
        <span
          className={cn(
            "tabular pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-[6px] bg-black/60 px-1.5 py-px text-[10px] font-semibold leading-4 text-paper/90 transition-opacity",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {lengthOf(clip).toFixed(1)}s{speed !== 1 ? ` · ${speed}×` : ""}
          {clip.muted ? <VolumeX size={10} /> : null}
        </span>
      ) : null}
      {/* A picture still waits to move: the one thing to do with it, right on it. */}
      {clip.kind === "image" && !clip.making && !lifted && width > 118 ? (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            useEditor.getState().select(clip.id);
            useEditor.getState().setPick({ file: fileOfClip(clip), clip: clip.id });
          }}
          className={cn(
            "press absolute bottom-1.5 right-1.5 z-[3] inline-flex h-6 items-center gap-1 rounded-full bg-spike px-2 text-[10.5px] font-bold text-spike-ink transition-opacity",
            selected ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          )}
          title="Make this picture move"
        >
          <Sparkles size={11} /> Make it move
        </button>
      ) : null}
      {clip.making && (!making || making.status === "queued" || making.status === "running") ? (
        <>
          <GeneratingField bare progress={making?.progress} backdrop={clip.kind === "image" ? previewUrl(clip.url, 320) : null} className="z-[1] opacity-95" />
          {width > 90 ? (
            <span className="tabular pointer-events-none absolute bottom-1.5 right-2 z-[2] text-[10.5px] font-semibold text-paper/90">Moving · {Math.round((making?.progress ?? 0) * 100)}%</span>
          ) : null}
        </>
      ) : null}
      {!lifted ? (
        <>
          <TrimHandle clip={clip} edge="in" pps={pps} />
          <TrimHandle clip={clip} edge="out" pps={pps} />
        </>
      ) : null}
    </div>
  );
});

/**
 * Frame times sit on a fixed ladder of steps (a frame every quarter second, half second, second…), so zooming or
 * resizing asks for frames the strip already has instead of a new set from ffmpeg.
 */
const LADDER = [64, 32, 16, 8, 4, 2, 1, 0.5, 0.25];
/** Sharp on a Retina screen, light elsewhere (the frame route makes both sizes). */
const frameWidth = () => (typeof window !== "undefined" && window.devicePixelRatio > 1.5 ? 240 : 120);

/** The pictures along a piece: a clip's frames at their times, a picture repeated. */
const Strip = memo(function Strip({ clip, width, pps }: { clip: EditClip; width: number; pps: number }) {
  const h = MAIN;
  const ratio = clip.width && clip.height ? clip.width / clip.height : 16 / 9;
  const tile = Math.max(40, Math.round(h * Math.min(2.4, Math.max(0.5, ratio))));
  if (clip.kind === "image") {
    return (
      <span aria-hidden className="absolute inset-0 bg-repeat-x opacity-90" style={{ backgroundImage: `url("${previewUrl(clip.url, 320)}")`, backgroundSize: `${tile}px ${h}px` }} />
    );
  }
  const n = Math.max(1, Math.min(48, Math.ceil(width / tile)));
  // Seconds of the clip under one tile, and the ladder step its frames snap to.
  const span = (tile * speedOf(clip)) / pps;
  const step = LADDER.find((s) => s <= span) ?? 0.25;
  const last = Math.max(0, Math.floor((clip.out - 0.05) * 4) / 4);
  const w = frameWidth();
  return (
    <span aria-hidden className="absolute inset-0 flex">
      {Array.from({ length: n }, (_, i) => {
        const at = clip.in + (i + 0.5) * span;
        const t = Math.max(0, Math.min(last, Math.round(at / step) * step));
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={`/api/storyboard/frame?url=${encodeURIComponent(clip.url)}&t=${t}&w=${w}`}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full shrink-0 object-cover opacity-90"
            style={{ width: tile }}
          />
        );
      })}
    </span>
  );
});

/** An edge to drag: the piece gets longer or shorter there, and the rest of the film follows. */
function TrimHandle({ clip, edge, pps }: { clip: EditClip; edge: "in" | "out"; pps: number }) {
  const [tip, setTip] = useState<string | null>(null);
  return (
    <span
      role="separator"
      aria-label={edge === "in" ? "Trim the start" : "Trim the end"}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const { checkpoint, select } = useEditor.getState();
        checkpoint();
        select(clip.id);
        const x0 = e.clientX;
        const start = clip;
        // Only a trim that changes the piece reaches the cut (and the film, the save and every track).
        let last = `${start.in}|${start.out}|${start.at ?? ""}`;
        const apply = perFrame((dx: number) => {
          const next = trimmed(start, edge, dx / pps);
          const key = `${next.in}|${next.out}|${next.at ?? ""}`;
          if (key === last) return;
          last = key;
          useEditor.getState().change((t) => patchClip(t, start.id, next), true);
          setTip(`${lengthOf(next).toFixed(1)}s`);
        });
        document.body.style.cursor = "ew-resize";
        follow(
          (ev) => apply(ev.clientX - x0),
          () => {
            apply.flush();
            setTip(null);
            document.body.style.cursor = "";
          },
        );
      }}
      className={cn(
        "absolute inset-y-0 z-[2] w-2.5 cursor-ew-resize touch-none",
        edge === "in" ? "left-0" : "right-0",
        "after:absolute after:inset-y-2 after:w-[3px] after:rounded-full after:bg-white/0 after:transition-colors group-hover:after:bg-white/70",
        edge === "in" ? "after:left-[3px]" : "after:right-[3px]",
      )}
    >
      {tip ? (
        <span className={cn("tabular absolute top-1/2 z-30 -translate-y-1/2 rounded-md bg-black/80 px-1.5 py-0.5 text-[10.5px] font-semibold text-paper", edge === "in" ? "left-3" : "right-3")}>{tip}</span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ the music lane */

function MusicTrack({ pps, timeAt, onScrub }: { pps: number; timeAt: (x: number) => number; onScrub: (e: ReactPointerEvent) => void }) {
  const music = useEditor((s) => s.timeline.music);
  const selected = useEditor((s) => s.selected);
  const [over, setOver] = useState<number | null>(null);
  const upload = useProjectFiles((s) => s.upload);
  const isSound = (f: EditFile | null) => f?.kind === "audio";

  /** Sounds snap to the cuts and the playhead when they come within a few pixels (read as the sound moves). */
  const snap = useCallback(
    (at: number, length: number) => {
      const points = [0, ...placed(useEditor.getState().timeline.main).map((p) => p.end), usePlayhead.getState().t];
      for (const p of points) {
        if (Math.abs(at - p) * pps < 8) return p;
        if (Math.abs(at + length - p) * pps < 8) return p - length;
      }
      return Math.max(0, at);
    },
    [pps],
  );

  return (
    <div
      className="relative"
      style={{ height: MUSIC }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        useEditor.getState().select(null);
        onScrub(e);
      }}
      onDragOver={(e) => {
        const os = Array.from(e.dataTransfer.types).includes("Files");
        if (!isSound(useFileDrag.getState().file) && !os) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const at = Math.max(0, timeAt(e.clientX));
        setOver((o) => (o !== null && Math.abs(o - at) * pps < 1 ? o : at));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const at = Math.max(0, timeAt(e.clientX));
        setOver(null);
        const lay = (files: EditFile[]) => {
          const sounds = files.filter((f) => f.kind === "audio");
          if (!sounds.length) return;
          const { change, select } = useEditor.getState();
          const clips = sounds.map((f) => clipFromFile(f, nanoid(8), at));
          change((t) => clips.reduce((acc, c) => addMusic(acc, c), t));
          select(clips[0].id);
        };
        const file = useFileDrag.getState().file;
        if (isSound(file) && e.dataTransfer.types.includes(FILE_DRAG)) return lay([file!]);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void upload(files).then(lay);
      }}
    >
      {!music.length ? (
        <span
          className={cn(
            "pointer-events-none absolute inset-y-1 left-[14px] right-3 flex items-center gap-1.5 rounded-[8px] px-2 text-[11.5px]",
            over !== null ? "text-paper shadow-[inset_0_0_0_1px_rgb(255_91_46/0.6)]" : "text-haze/60",
          )}
        >
          <Music2 size={11} /> Music
        </span>
      ) : null}
      {music.map((c) => (
        <SoundBlock key={c.id} clip={c} pps={pps} selected={selected === c.id} snap={snap} />
      ))}
      {over !== null && music.length ? <span className="pointer-events-none absolute inset-y-0 z-10 w-[3px] -translate-x-1/2 rounded-full bg-spike" style={{ left: PAD + over * pps }} /> : null}
    </div>
  );
}

const SoundBlock = memo(function SoundBlock({ clip, pps, selected, snap }: { clip: EditClip; pps: number; selected: boolean; snap: (at: number, length: number) => number }) {
  const left = PAD + (clip.at ?? 0) * pps;
  const width = lengthOf(clip) * pps;
  return (
    <div
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const { checkpoint, select } = useEditor.getState();
        select(clip.id);
        const x0 = e.clientX;
        let moving = false;
        let last = clip.at ?? 0;
        const slide = perFrame((dx: number) => {
          const at = snap((clip.at ?? 0) + dx / pps, lengthOf(clip));
          if (at === last) return;
          last = at;
          useEditor.getState().change((t) => patchClip(t, clip.id, { at }), true);
        });
        follow(
          (ev) => {
            if (!moving && Math.abs(ev.clientX - x0) < 4) return;
            if (!moving) checkpoint();
            moving = true;
            slide(ev.clientX - x0);
          },
          () => slide.flush(),
        );
      }}
      className={cn(
        "group absolute inset-y-1 cursor-grab touch-none select-none overflow-hidden rounded-[8px] bg-[color-mix(in_oklab,var(--color-chroma)_22%,#1b1820)] active:cursor-grabbing",
        selected ? "z-10 shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_rgb(90_215_143/0.25)]",
      )}
      style={{ left: left + 1, width: Math.max(6, width - 2) }}
    >
      {/* A quiet wave, so it reads as sound at a glance. */}
      <span
        aria-hidden
        className="absolute inset-x-0 inset-y-1.5 opacity-40"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, rgb(90 215 143 / 0.9) 0 2px, transparent 2px 5px)", maskImage: "linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent)" }}
      />
      {width > 40 ? (
        <span className="pointer-events-none absolute left-2 top-1/2 flex max-w-[calc(100%-16px)] -translate-y-1/2 items-center gap-1 text-[10.5px] font-semibold text-paper/90">
          <Music2 size={10} className="shrink-0" />
          <span className="truncate">{clip.name ?? "Sound"}</span>
          {clip.muted ? <VolumeX size={10} className="shrink-0" /> : null}
        </span>
      ) : null}
      <TrimHandle clip={clip} edge="in" pps={pps} />
      <TrimHandle clip={clip} edge="out" pps={pps} />
    </div>
  );
});
