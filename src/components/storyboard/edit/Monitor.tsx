"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Clapperboard, Download, Film, ImageIcon, Maximize, Pause, Play, Redo2, Scissors, SkipBack, SkipForward, Sparkles, Undo2, Upload } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { FILM_ASPECTS, filmLength, placed, placedAt, timecode } from "@/lib/storyboard/edit";
import { aspectById } from "@/lib/shot";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { TitleBar, ToolButton, ToolGroup, ToolPill } from "@/components/director/TitleBar";
import { FilmEngine, usePlayhead } from "./engine";
import { film, setFilmEngine } from "./film";
import { cn } from "@/lib/cn";

/**
 * The film as it plays: a title bar with undo, the transport and the film's shape, and under it exactly the frame the
 * film has, as big as the room allows (the Director's camera screen, for the cut).
 */
export function Monitor({ onDirect, onUpload }: { onDirect: () => void; onUpload: () => void }) {
  const timeline = useEditor((s) => s.timeline);
  const aspect = useEditor((s) => s.project?.aspect ?? "16:9");
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const { undo, redo } = useEditor.getState();
  const room = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const v0 = useRef<HTMLVideoElement>(null);
  const v1 = useRef<HTMLVideoElement>(null);
  const p0 = useRef<HTMLImageElement>(null);
  const p1 = useRef<HTMLImageElement>(null);
  const engineRef = useRef<FilmEngine | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const a = aspectById(aspect);
  const empty = !timeline.main.length;

  useEffect(() => {
    const e = new FilmEngine([v0.current!, v1.current!], [p0.current!, p1.current!]);
    engineRef.current = e;
    setFilmEngine(e);
    e.setFilm(useEditor.getState().timeline);
    return () => {
      e.destroy();
      setFilmEngine(null);
      engineRef.current = null;
    };
  }, []);
  useEffect(() => engineRef.current?.setFilm(timeline), [timeline]);

  // The biggest frame of the film's shape that fits.
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const fit = () => {
      const ratio = a.w / a.h;
      const w = Math.min(el.clientWidth - 32, (el.clientHeight - 32) * ratio);
      setBox({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(w / ratio)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.w, a.h]);

  return (
    <section aria-label="Monitor" className="surface relative flex min-h-[260px] flex-col overflow-hidden rounded-panel lg:min-h-0 lg:flex-1">
      <TitleBar>
        <ToolGroup>
          <ToolButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
            <Undo2 size={15} />
          </ToolButton>
          <ToolButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
            <Redo2 size={15} />
          </ToolButton>
        </ToolGroup>
        <span className="flex-1" />
        <Transport disabled={empty} />
        <span className="flex-1" />
        <ToolGroup className="hidden sm:flex">
          <ShapeMenu />
          <ToolButton label="Full screen" onClick={() => void screen.current?.requestFullscreen?.().catch(() => {})} disabled={empty}>
            <Maximize size={15} />
          </ToolButton>
        </ToolGroup>
      </TitleBar>
      <div ref={room} className="relative grid min-h-0 flex-1 place-items-center bg-[#0d0e11]">
        <div
          ref={screen}
          onClick={() => !empty && film.toggle()}
          className={cn("group/screen relative overflow-hidden rounded-[6px] bg-black", empty ? "invisible" : "cursor-pointer", "[&:fullscreen]:!h-full [&:fullscreen]:!w-full [&:fullscreen]:rounded-none")}
          style={{ width: box.w, height: box.h }}
        >
          <video ref={v0} className="absolute inset-0 size-full opacity-0" />
          <video ref={v1} className="absolute inset-0 size-full opacity-0" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={p0} alt="" className="absolute inset-0 size-full opacity-0" draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={p1} alt="" className="absolute inset-0 size-full opacity-0" draggable={false} />
          {empty ? null : <ShotLabel />}
        </div>
        {empty ? <FirstSteps onDirect={onDirect} onUpload={onUpload} /> : null}
      </div>
    </section>
  );
}

/** Which shot this is, over the picture while it's paused (a viewfinder's readout), gone while it plays. */
function ShotLabel() {
  const t = usePlayhead((s) => s.t);
  const playing = usePlayhead((s) => s.playing);
  const main = useEditor((s) => s.timeline.main);
  const at = placedAt(placed(main), t);
  if (!at) return null;
  const Icon = at.clip.kind === "image" ? ImageIcon : Film;
  return (
    <span
      className={cn(
        "tabular pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-[8px] bg-black/55 px-2 py-1 font-mono text-[11px] font-semibold text-paper/90 backdrop-blur-sm transition-opacity duration-300",
        playing ? "opacity-0" : "opacity-100",
      )}
    >
      <span className="font-display text-[13px] leading-none">{at.index + 1}</span>
      <span className="text-paper/50">/ {main.length}</span>
      <Icon size={11} className="text-paper/70" />
      {at.clip.kind === "image" ? <span className="font-sans text-paper/70">still</span> : null}
    </span>
  );
}

/** The film's shape: every picture and clip fills it (or fits inside it, shot by shot). */
function ShapeMenu() {
  const aspect = useEditor((s) => s.project?.aspect ?? "16:9");
  const setAspect = useEditor((s) => s.setAspect);
  return (
    <Popover
      placement="bottom-end"
      panelClassName="w-[220px] p-1"
      trigger={({ open, toggle }) => (
        <ToolPill title="The film's shape" onClick={toggle} active={open}>
          <Glyph id={aspect} />
          <span className="tabular">{aspect}</span>
          <ChevronDown size={12} className="text-haze" />
        </ToolPill>
      )}
    >
      {(close) => (
        <div>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">The film&apos;s shape</p>
          {FILM_ASPECTS.map((id) => (
            <MenuItem
              key={id}
              selected={id === aspect}
              hint={aspectById(id).label}
              onSelect={() => {
                setAspect(id);
                close();
              }}
            >
              <Glyph id={id} /> {id}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function Glyph({ id }: { id: string }) {
  const a = aspectById(id);
  return (
    <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
      <span className="rounded-[2px] border-[1.5px] border-current opacity-80" style={a.w >= a.h ? { width: 14, height: Math.max(5, Math.round((14 * a.h) / a.w)) } : { width: Math.max(5, Math.round((14 * a.w) / a.h)), height: 14 }} />
    </span>
  );
}

/** Back a cut, play or pause, on a cut; the time and the film's length. */
function Transport({ disabled }: { disabled: boolean }) {
  const playing = usePlayhead((s) => s.playing);
  const timeline = useEditor((s) => s.timeline);
  const total = filmLength(timeline);
  const jump = (dir: -1 | 1) => {
    const t = usePlayhead.getState().t;
    const cuts = [0, ...placed(timeline.main).map((p) => p.end)];
    const to = dir < 0 ? ([...cuts].reverse().find((c) => c < t - 0.05) ?? 0) : (cuts.find((c) => c > t + 0.05) ?? total);
    film.seek(to);
  };
  return (
    <div className="flex items-center gap-2">
      <ToolGroup>
        <ToolButton label="Back to the last cut" onClick={() => jump(-1)} disabled={disabled}>
          <SkipBack size={15} />
        </ToolButton>
        <button
          type="button"
          onClick={() => film.toggle()}
          disabled={disabled}
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          className="press squircle grid size-8 place-items-center rounded-[10px] bg-paper text-[#16131b] hover:bg-white disabled:opacity-30"
        >
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
        </button>
        <ToolButton label="On to the next cut" onClick={() => jump(1)} disabled={disabled}>
          <SkipForward size={15} />
        </ToolButton>
      </ToolGroup>
      <Clock total={total} />
    </div>
  );
}

function Clock({ total }: { total: number }) {
  const t = usePlayhead((s) => s.t);
  return (
    <p className="tabular hidden min-w-[112px] font-mono text-[12.5px] text-fog sm:block">
      <span className="text-paper">{timecode(Math.min(t, total))}</span>
      <span className="text-haze"> / {timecode(total)}</span>
    </p>
  );
}

const STEPS: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Clapperboard size={18} />, title: "Shoot", body: "Build the place and the cast once in the Director, then shoot from any angle. Same people, same place, every shot." },
  { icon: <Scissors size={18} />, title: "Cut", body: "Your shots land in Files. Put them on the timeline in story order, trim them, swap them around." },
  { icon: <Sparkles size={18} />, title: "Move", body: "Click a still and make it move: pick a camera move and a pace, and the clip takes its place." },
  { icon: <Download size={18} />, title: "Export", body: "One MP4 with its sound and your music, in the film's shape." },
];

/** A new project: what Storyboard does, in four steps, and the two ways to start. */
function FirstSteps({ onDirect, onUpload }: { onDirect: () => void; onUpload: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
      <div className="w-full max-w-[760px] text-center">
        <p className="font-display text-[28px] leading-tight sm:text-[34px]">Make a film, shot by shot</p>
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[13.5px] leading-relaxed text-haze">Not one clip at a time: a whole story, with the same people in the same place, from the first shot to the last.</p>
        <ol className="mt-6 grid grid-cols-2 gap-2 text-left md:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="squircle relative rounded-[16px] bg-white/[0.03] p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <span className="flex items-center gap-2">
                <span className={cn("grid size-8 place-items-center rounded-[10px]", i === 0 ? "bg-spike/15 text-spike" : "bg-white/[0.06] text-fog")}>{s.icon}</span>
                <span className="tabular font-mono text-[11px] text-haze">0{i + 1}</span>
              </span>
              <p className="mt-2.5 text-[14px] font-semibold">{s.title}</p>
              <p className="mt-1 text-[12px] leading-snug text-haze">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onDirect}
            className="lip press squircle inline-flex h-11 items-center gap-2 rounded-[14px] bg-spike px-5 text-[13.5px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi"
          >
            <Clapperboard size={15} /> Shoot the first shot
          </button>
          <button
            type="button"
            onClick={onUpload}
            className="press squircle inline-flex h-11 items-center gap-2 rounded-[14px] bg-white/[0.07] px-4 text-[13.5px] font-semibold text-fog hover:bg-white/[0.11] hover:text-paper"
          >
            <Upload size={15} /> Start from your own files
          </button>
        </div>
      </div>
    </div>
  );
}
