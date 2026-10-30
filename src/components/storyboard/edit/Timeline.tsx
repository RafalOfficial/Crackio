"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { nanoid } from "nanoid";
import { Clapperboard, Download, Film, ImageIcon, Keyboard, ListPlus, LoaderCircle, Minus, Music2, Plus, Scissors, Sparkles, VolumeX } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { clipFromFile, filmLength, lengthOf, placed, speedOf, timecode, type EditClip, type EditFile } from "@/lib/storyboard/edit";
import { addMusic, dropIndex, duplicate, insertMain, moveMain, patchClip, removeClip, splitAt, trimmed } from "@/lib/storyboard/edit-ops";
import { useGenerations } from "@/lib/hooks/use-generations";
import { previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { Popover } from "@/components/ui/Popover";
import { TitleBar, ToolButton, ToolGroup, ToolPill } from "@/components/director/TitleBar";
import { usePlayhead } from "./engine";
import { film, FILE_DRAG, useFileDrag } from "./film";
import { useProjectFiles } from "./project-files";
import { ShotTools } from "./ShotTools";
import { isExporting, useExport } from "./exporting";
import { addAllToFilm, isFilm } from "./Files";
import { cn } from "@/lib/cn";

/**
 * The cut, CapCut-style: a ruler, the film's track (pictures and clips one after the other: magnetic, so nothing leaves a
 * gap), and a music track under it. Drag files in from the right, drag pieces to reorder, drag their edges to trim,
 * S splits at the playhead.
 */

/** Room before the film's first second. */
const PAD = 14;
const RULER = 26;
const MAIN = 80;
const MUSIC = 42;
const MIN_PPS = 4;
const MAX_PPS = 320;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Split, duplicate and delete what's selected (or what's under the playhead): the toolbar and the keys share them. */
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
};

export function Timeline({ onDirect }: { onDirect: () => void }) {
  const timeline = useEditor((s) => s.timeline);
  const selected = useEditor((s) => s.selected);
  const clip = timeline.main.find((c) => c.id === selected) ?? timeline.music.find((c) => c.id === selected) ?? null;
  const number = clip ? timeline.main.findIndex((c) => c.id === clip.id) + 1 || null : null;
  const zoom = useEditor((s) => s.zoom);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(800);
  const total = filmLength(timeline);
  const musicEnd = timeline.music.reduce((m, c) => Math.max(m, (c.at ?? 0) + lengthOf(c)), 0);
  const fitPps = clamp((view - PAD * 2) / Math.max(total, 6), MIN_PPS, 120);
  const pps = zoom ?? fitPps;
  const width = Math.max(view, PAD * 2 + (Math.max(total, musicEnd) + 6) * pps);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView(el.clientWidth));
    ro.observe(el);
    setView(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Ctrl + wheel zooms around the pointer; the wheel alone scrolls the cut sideways.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        const at = (x + el.scrollLeft - PAD) / pps;
        const next = clamp(pps * Math.exp(-e.deltaY * 0.0022), MIN_PPS, MAX_PPS);
        useEditor.getState().setZoom(next);
        requestAnimationFrame(() => (el.scrollLeft = Math.max(0, at * next + PAD - x)));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
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
  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / pps;
  };

  const setZoom = (next: number) => {
    const el = scroller.current;
    const t = usePlayhead.getState().t;
    useEditor.getState().setZoom(clamp(next, MIN_PPS, MAX_PPS));
    // Keeps the playhead where it is on screen.
    if (el) {
      const x = PAD + t * pps - el.scrollLeft;
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, PAD + t * clamp(next, MIN_PPS, MAX_PPS) - x)));
    }
  };

  return (
    <section aria-label="Timeline" className="surface flex h-[232px] shrink-0 flex-col overflow-hidden rounded-panel">
      {/* The selected shot's tools, or with nothing selected the next thing to do. */}
      <TitleBar className="scrollbar-none overflow-x-auto">
        {clip ? (
          <ShotTools key={clip.id} clip={clip} music={!number} number={number} />
        ) : (
          <>
            <ToolGroup label="Edit">
              <ToolPill title="Split at the playhead (S)" onClick={cut.split} disabled={!timeline.main.length && !timeline.music.length}>
                <Scissors size={14} /> <span className="hidden md:inline">Split</span>
              </ToolPill>
            </ToolGroup>
            <NextStep onDirect={onDirect} />
          </>
        )}
        <span className="min-w-2 flex-1" />
        <ToolGroup label="Zoom">
          <ToolButton label="Zoom out" onClick={() => setZoom(pps / 1.4)} disabled={pps <= MIN_PPS}>
            <Minus size={15} />
          </ToolButton>
          <input
            type="range"
            min={Math.log(MIN_PPS)}
            max={Math.log(MAX_PPS)}
            step={0.01}
            value={Math.log(pps)}
            onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
            aria-label="Zoom"
            className="hidden w-20 accent-[var(--color-paper)] 2xl:block"
          />
          <ToolButton label="Zoom in" onClick={() => setZoom(pps * 1.4)} disabled={pps >= MAX_PPS}>
            <Plus size={15} />
          </ToolButton>
          <ToolPill title="Fit the whole film" onClick={() => useEditor.getState().setZoom(null)} active={zoom === null}>
            Fit
          </ToolPill>
        </ToolGroup>
        <Keys />
      </TitleBar>
      <div ref={scroller} className="scroll-thin relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="relative h-full" style={{ width }}>
          <Ruler pps={pps} width={width} timeAt={timeAt} />
          <MainTrack pps={pps} timeAt={timeAt} />
          <MusicTrack pps={pps} timeAt={timeAt} />
          <Playhead pps={pps} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ ruler and playhead */

function Ruler({ pps, width, timeAt }: { pps: number; width: number; timeAt: (x: number) => number }) {
  // A label every 1, 2, 5, 10… seconds, whichever keeps them at least 70 px apart.
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 70) ?? 300;
  const minor = step / (step >= 10 ? 5 : step >= 1 ? 4 : 5);
  const marks: { t: number; major: boolean }[] = [];
  const seconds = (width - PAD) / pps;
  for (let t = 0; t <= seconds; t = Math.round((t + minor) * 1000) / 1000) marks.push({ t, major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    film.seek(Math.max(0, timeAt(e.clientX)));
  };
  return (
    <div
      className="relative cursor-ew-resize select-none border-b border-white/[0.05]"
      style={{ height: RULER }}
      onPointerDown={scrub}
      onPointerMove={(e) => e.buttons === 1 && film.seek(Math.max(0, timeAt(e.clientX)))}
    >
      {marks.map((m) => (
        <span key={m.t} className={cn("absolute bottom-0 w-px", m.major ? "h-2.5 bg-white/30" : "h-1.5 bg-white/12")} style={{ left: PAD + m.t * pps }}>
          {m.major ? <span className="tabular absolute bottom-3 left-1 whitespace-nowrap font-mono text-[10px] text-haze">{timecode(m.t, false)}</span> : null}
        </span>
      ))}
    </div>
  );
}

function Playhead({ pps }: { pps: number }) {
  const t = usePlayhead((s) => s.t);
  const x = PAD + t * pps;
  return (
    <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-paper" style={{ left: x }}>
      <span className="absolute -left-[5px] top-0 h-3 w-[11px] rounded-b-[4px] bg-paper" />
    </div>
  );
}

/* ------------------------------------------------------------------ the film's track */

type Drag = { id: string; grab: number; x: number } | null;

function MainTrack({ pps, timeAt }: { pps: number; timeAt: (x: number) => number }) {
  const main = useEditor((s) => s.timeline.main);
  const selected = useEditor((s) => s.selected);
  const [drag, setDrag] = useState<Drag>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const upload = useProjectFiles((s) => s.upload);

  // While a piece is dragged, the others make room where it would land.
  const dragged = drag ? main.find((c) => c.id === drag.id) : null;
  const rest = dragged ? main.filter((c) => c.id !== drag!.id) : main;
  const landing = dragged ? dropIndex(main, (drag!.x - drag!.grab) / pps + lengthOf(dragged) / 2, drag!.id) : null;
  const room = dragged ? lengthOf(dragged) : 0;
  const shown = placed(rest).map((p) => ({ ...p, shift: landing !== null && p.index >= landing ? room : 0 }));
  const marker = dropAt !== null ? (placed(main)[dropAt]?.start ?? filmLength({ main, music: [] })) : null;

  const visual = (f: EditFile | null) => Boolean(f && f.kind !== "audio");

  return (
    <div
      className="relative mx-0 my-1.5"
      style={{ height: MAIN }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        useEditor.getState().select(null);
        film.seek(Math.max(0, timeAt(e.clientX)));
      }}
      onDragOver={(e) => {
        const file = useFileDrag.getState().file;
        const os = Array.from(e.dataTransfer.types).includes("Files");
        if (!visual(file) && !os) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropAt(dropIndex(main, timeAt(e.clientX)));
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
        <div className="pointer-events-none absolute inset-y-0 left-[14px] right-3 grid place-items-center rounded-[14px] border border-dashed border-white/[0.12] text-[12.5px] text-haze">
          <span className="flex items-center gap-2">
            <Film size={14} /> Your shots go here, in the order the story goes: drag them in from Files
          </span>
        </div>
      ) : null}
      {shown.map((p) => (
        <ClipBlock
          key={p.clip.id}
          number={main.indexOf(p.clip) + 1}
          clip={p.clip}
          left={PAD + (p.start + p.shift) * pps}
          width={(p.end - p.start) * pps}
          pps={pps}
          selected={selected === p.clip.id}
          onBodyDown={(e) => startMove(e, p.clip, PAD + p.start * pps)}
        />
      ))}
      {dragged && drag ? (
        <ClipBlock clip={dragged} number={main.indexOf(dragged) + 1} left={drag.x - drag.grab} width={lengthOf(dragged) * pps} pps={pps} selected lifted onBodyDown={() => {}} />
      ) : null}
      {marker !== null ? <span className="pointer-events-none absolute inset-y-[-4px] z-10 w-[3px] -translate-x-1/2 rounded-full bg-spike" style={{ left: PAD + marker * pps }} /> : null}
    </div>
  );

  /** Press on a piece: it's selected; past a few pixels it lifts and moves. */
  function startMove(e: ReactPointerEvent, clip: EditClip, left: number) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const { select, setPick } = useEditor.getState();
    select(clip.id);
    // A picture opens Make a clip for it (a clip leaves whatever you were making open).
    if (clip.kind === "image") setPick({ file: fileOfClip(clip), clip: clip.id });
    const x0 = e.clientX;
    const toContent = (clientX: number) => PAD + timeAt(clientX) * pps;
    const grab = toContent(x0) - left;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - x0) < 5) return;
      moving = true;
      setDrag({ id: clip.id, grab, x: toContent(ev.clientX) });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moving) {
        const now = useEditor.getState().timeline.main;
        const len = lengthOf(clip);
        const to = dropIndex(now, (toContent(ev.clientX) - grab - PAD) / pps + len / 2, clip.id);
        useEditor.getState().change((t) => moveMain(t, clip.id, to));
      } else film.seek(Math.max(0, timeAt(ev.clientX)));
      setDrag(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
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
  onBodyDown,
}: {
  clip: EditClip;
  number: number;
  left: number;
  width: number;
  pps: number;
  selected: boolean;
  lifted?: boolean;
  onBodyDown: (e: ReactPointerEvent) => void;
}) {
  const making = useGenerations((s) => (clip.making ? s.items.find((g) => g.id === clip.making) : undefined));
  const speed = speedOf(clip);
  return (
    <div
      data-clip={clip.id}
      onPointerDown={onBodyDown}
      className={cn(
        "group absolute inset-y-0 cursor-grab touch-none select-none overflow-hidden rounded-[12px] bg-apple-2 active:cursor-grabbing",
        selected ? "z-10 shadow-[0_0_0_2px_var(--color-spike),0_8px_20px_-8px_rgb(0_0_0/0.8)]" : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]",
        lifted && "z-30 opacity-85 shadow-[0_0_0_2px_var(--color-spike),0_16px_40px_-10px_rgb(0_0_0/0.9)]",
      )}
      style={{ left: left + 1, width: Math.max(6, width - 2) }}
    >
      <Strip clip={clip} width={width} pps={pps} />
      <span className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-gradient-to-b from-black/70 to-transparent" />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/70 to-transparent" />
      {width > 46 ? (
        <span className="pointer-events-none absolute left-1.5 top-1 flex max-w-[calc(100%-12px)] items-center gap-1 text-[10.5px] font-semibold text-white/90">
          {clip.kind === "image" ? <ImageIcon size={10} className="shrink-0 opacity-80" /> : <Film size={10} className="shrink-0 opacity-80" />}
          <span className="tabular shrink-0">{lengthOf(clip).toFixed(1)}s</span>
          {speed !== 1 ? <span className="tabular shrink-0 rounded bg-white/20 px-1">{speed}×</span> : null}
          {clip.muted ? <VolumeX size={10} className="shrink-0 opacity-80" /> : null}
          {width > 150 ? <span className="truncate font-medium text-white/60">{clip.name}</span> : null}
        </span>
      ) : null}
      {/* The shot's number, as on a storyboard. */}
      {width > 26 ? <span className="tabular pointer-events-none absolute bottom-1 left-2 font-display text-[17px] leading-none text-white/95 [text-shadow:0_1px_6px_rgb(0_0_0/0.7)]">{number}</span> : null}
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
            "press absolute bottom-1.5 right-1.5 z-[3] inline-flex h-6 items-center gap-1 rounded-full bg-spike px-2 text-[10.5px] font-bold text-spike-ink shadow-[0_4px_14px_-4px_rgb(255_91_46/0.7)] transition-opacity",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
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

/** The pictures along a piece: a clip's frames at their times, a picture repeated. */
function Strip({ clip, width, pps }: { clip: EditClip; width: number; pps: number }) {
  const h = MAIN;
  const ratio = clip.width && clip.height ? clip.width / clip.height : 16 / 9;
  const tile = Math.max(40, Math.round(h * Math.min(2.4, Math.max(0.5, ratio))));
  if (clip.kind === "image") {
    return (
      <span
        aria-hidden
        className="absolute inset-0 bg-repeat-x opacity-90"
        style={{ backgroundImage: `url("${previewUrl(clip.url, 320)}")`, backgroundSize: `${tile}px ${h}px` }}
      />
    );
  }
  const n = Math.max(1, Math.min(48, Math.ceil(width / tile)));
  const speed = speedOf(clip);
  return (
    <span aria-hidden className="absolute inset-0 flex">
      {Array.from({ length: n }, (_, i) => {
        const at = Math.min(clip.out - 0.05, clip.in + ((i + 0.5) * tile * speed) / pps);
        const t = Math.max(0, Math.round(at * 4) / 4);
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={`/api/storyboard/frame?url=${encodeURIComponent(clip.url)}&t=${t}&w=120`}
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
}

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
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const { checkpoint, select } = useEditor.getState();
        checkpoint();
        select(clip.id);
        const x0 = e.clientX;
        const start = clip;
        const move = (ev: PointerEvent) => {
          const next = trimmed(start, edge, (ev.clientX - x0) / pps);
          useEditor.getState().change((t) => patchClip(t, start.id, next), true);
          setTip(`${lengthOf(next).toFixed(1)}s`);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          setTip(null);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
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

/* ------------------------------------------------------------------ the music track */

function MusicTrack({ pps, timeAt }: { pps: number; timeAt: (x: number) => number }) {
  const music = useEditor((s) => s.timeline.music);
  const main = useEditor((s) => s.timeline.main);
  const selected = useEditor((s) => s.selected);
  const [over, setOver] = useState<number | null>(null);
  const upload = useProjectFiles((s) => s.upload);
  const isSound = (f: EditFile | null) => f?.kind === "audio";

  /** Sounds snap to the cuts and the playhead when they come within a few pixels. */
  const snap = (at: number, length: number) => {
    const points = [0, ...placed(main).map((p) => p.end), usePlayhead.getState().t];
    for (const p of points) {
      if (Math.abs(at - p) * pps < 8) return p;
      if (Math.abs(at + length - p) * pps < 8) return p - length;
    }
    return Math.max(0, at);
  };

  return (
    <div
      className="relative"
      style={{ height: MUSIC }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        useEditor.getState().select(null);
        film.seek(Math.max(0, timeAt(e.clientX)));
      }}
      onDragOver={(e) => {
        const os = Array.from(e.dataTransfer.types).includes("Files");
        if (!isSound(useFileDrag.getState().file) && !os) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(Math.max(0, timeAt(e.clientX)));
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
        <div
          className={cn(
            "pointer-events-none absolute inset-y-1 left-[14px] right-3 flex items-center gap-1.5 rounded-[10px] border border-dashed px-3 text-[12px]",
            over !== null ? "border-spike/60 text-paper" : "border-white/[0.08] text-haze",
          )}
        >
          <Music2 size={12} /> Music: drop a sound here
        </div>
      ) : null}
      {music.map((c) => (
        <SoundBlock key={c.id} clip={c} pps={pps} selected={selected === c.id} snap={snap} />
      ))}
      {over !== null && music.length ? <span className="pointer-events-none absolute inset-y-0 z-10 w-[3px] -translate-x-1/2 rounded-full bg-spike" style={{ left: PAD + over * pps }} /> : null}
    </div>
  );
}

function SoundBlock({ clip, pps, selected, snap }: { clip: EditClip; pps: number; selected: boolean; snap: (at: number, length: number) => number }) {
  const left = PAD + (clip.at ?? 0) * pps;
  const width = lengthOf(clip) * pps;
  return (
    <div
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const { checkpoint, select } = useEditor.getState();
        select(clip.id);
        const x0 = e.clientX;
        let moving = false;
        const move = (ev: PointerEvent) => {
          if (!moving && Math.abs(ev.clientX - x0) < 4) return;
          if (!moving) checkpoint();
          moving = true;
          const at = snap((clip.at ?? 0) + (ev.clientX - x0) / pps, lengthOf(clip));
          useEditor.getState().change((t) => patchClip(t, clip.id, { at }), true);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      className={cn(
        "group absolute inset-y-1 cursor-grab touch-none select-none overflow-hidden rounded-[9px] bg-[color-mix(in_oklab,var(--color-chroma)_22%,#1b1820)] active:cursor-grabbing",
        selected ? "z-10 shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_rgb(90_215_143/0.28)]",
      )}
      style={{ left: left + 1, width: Math.max(6, width - 2) }}
    >
      {/* A quiet wave, so it reads as sound at a glance. */}
      <span
        aria-hidden
        className="absolute inset-x-0 inset-y-2 opacity-40"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, rgb(90 215 143 / 0.9) 0 2px, transparent 2px 5px)", maskImage: "linear-gradient(180deg, transparent, #000 30%, #000 70%, transparent)" }}
      />
      {width > 40 ? (
        <span className="pointer-events-none absolute left-2 top-1/2 flex max-w-[calc(100%-16px)] -translate-y-1/2 items-center gap-1 text-[11px] font-semibold text-paper/90">
          <Music2 size={11} className="shrink-0" />
          <span className="truncate">{clip.name ?? "Sound"}</span>
          {clip.muted ? <VolumeX size={11} className="shrink-0" /> : null}
        </span>
      ) : null}
      <TrimHandle clip={clip} edge="in" pps={pps} />
      <TrimHandle clip={clip} edge="out" pps={pps} />
    </div>
  );
}

/* ------------------------------------------------------------------ guidance */

/**
 * With nothing selected, the bar says what to do next, and does it in one click: shoot the first shot, put every shot on
 * the timeline, make the next still move, export the film, download it. Someone new never has to guess.
 */
function NextStep({ onDirect }: { onDirect: () => void }) {
  const timeline = useEditor((s) => s.timeline);
  const project = useEditor((s) => s.project);
  const changedAt = useEditor((s) => s.changedAt);
  const files = useProjectFiles((s) => s.items);
  const loaded = useProjectFiles((s) => s.loaded);
  const job = useExport((s) => s.job);
  if (!project || !loaded) return null;
  const shots = files.filter((f) => f.kind !== "audio" && !isFilm(f));
  const stills = placed(timeline.main).filter((p) => p.clip.kind === "image");
  const waiting = stills.find((p) => !p.clip.making);
  const latest = files.find(isFilm);
  const step: { label: string; icon: ReactNode; act?: () => void; href?: string } = !timeline.main.length
    ? shots.length
      ? { label: `Put your ${shots.length === 1 ? "shot" : `${shots.length} shots`} on the timeline`, icon: <ListPlus size={14} />, act: addAllToFilm }
      : { label: "Shoot your first shot in the Director", icon: <Clapperboard size={14} />, act: onDirect }
    : waiting
      ? {
          label: `Make shot ${waiting.index + 1} move`,
          icon: <Sparkles size={14} />,
          act: () => {
            useEditor.getState().select(waiting.clip.id);
            useEditor.getState().setPick({ file: fileOfClip(waiting.clip), clip: waiting.clip.id });
            film.seek(waiting.start);
          },
        }
      : stills.length
        ? { label: "Your clips are on their way: each takes its picture's place", icon: <LoaderCircle size={14} className="animate-spin" /> }
        : isExporting(job)
          ? { label: `Putting the film together · ${Math.round((job?.progress ?? 0) * 100)}%`, icon: <LoaderCircle size={14} className="animate-spin" /> }
          : latest && latest.createdAt >= changedAt
            ? { label: "Your film is ready: download it", icon: <Download size={14} />, href: latest.url }
            : { label: "Everything moves: export the film", icon: <Download size={14} />, act: () => void useExport.getState().start(project.id, "1080p") };
  const body = (
    <>
      <span className="grid size-6 place-items-center rounded-[8px] bg-spike/15 text-spike">{step.icon}</span>
      <span className="label text-[10px] text-haze">Next</span>
      <span className="truncate">{step.label}</span>
    </>
  );
  const style =
    "press squircle flex h-10 min-w-0 max-w-[460px] shrink items-center gap-2 rounded-[12px] bg-white/[0.04] pl-2 pr-3 text-[12.5px] font-semibold text-paper shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.07] disabled:hover:bg-white/[0.04]";
  return step.href ? (
    <a href={step.href} download={`${project.name}.mp4`} className={style}>
      {body}
    </a>
  ) : (
    <button type="button" onClick={step.act} disabled={!step.act} className={style}>
      {body}
    </button>
  );
}


/** The keys, one click away. */
function Keys() {
  return (
    <Popover
      placement="top-end"
      panelClassName="w-[280px] p-3"
      trigger={({ open, toggle }) => (
        <ToolGroup>
          <ToolButton label="Keyboard shortcuts" onClick={toggle} active={open}>
            <Keyboard size={15} />
          </ToolButton>
        </ToolGroup>
      )}
    >
      {() => (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          {[
            ["Space", "Play or pause"],
            ["S", "Split at the playhead"],
            ["Del", "Delete what's selected"],
            ["Ctrl D", "Duplicate it"],
            ["← →", "A frame back or on (Shift: a second)"],
            ["Ctrl Z", "Undo (Shift for redo)"],
            ["Ctrl scroll", "Zoom the timeline"],
            ["Esc", "Let go of the selection"],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[11px] font-semibold text-fog">{k}</dt>
              <dd className="text-haze">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Popover>
  );
}
