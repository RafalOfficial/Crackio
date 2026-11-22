"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clapperboard, Download, Film, ImageIcon, LoaderCircle, Pause, Play, Scissors, SkipBack, SkipForward, Snowflake, Sparkles, Upload } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { FILM_ASPECTS, FPS, filmLength, placed, placedAt, speedOf, timecode, type EditFile } from "@/lib/storyboard/edit";
import { useProjectFiles } from "./project-files";
import { aspectById } from "@/lib/shot";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { ToolButton, ToolPill } from "@/components/director/TitleBar";
import { FilmEngine, usePlayhead } from "./engine";
import { film, setFilmEngine } from "./film";
import { ShotTools } from "./ShotTools";
import { cn } from "@/lib/cn";

/** The screen's frame, for the controls' full screen button (Controls). */
export const monitorScreen: { el: HTMLDivElement | null } = { el: null };

/**
 * The film as it plays: exactly the frame the film has, as big as the room allows (the Director's camera screen, for the
 * cut), with nothing over it but the shot's number while it's paused and, while a shot is selected, that shot's tools.
 * Play, undo and the film's shape are in the row under it (Controls).
 */
export function Monitor({ onDirect, onUpload }: { onDirect: () => void; onUpload: () => void }) {
  // The engine follows the cut on its own (below): the monitor redraws only when it fills or empties.
  const empty = useEditor((s) => !s.timeline.main.length);
  const aspect = useEditor((s) => s.project?.aspect ?? "16:9");
  const room = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const v0 = useRef<HTMLVideoElement>(null);
  const v1 = useRef<HTMLVideoElement>(null);
  const p0 = useRef<HTMLImageElement>(null);
  const p1 = useRef<HTMLImageElement>(null);
  const engineRef = useRef<FilmEngine | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const a = aspectById(aspect);

  useEffect(() => {
    const e = new FilmEngine([v0.current!, v1.current!], [p0.current!, p1.current!]);
    engineRef.current = e;
    setFilmEngine(e);
    e.setFilm(useEditor.getState().timeline);
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.timeline !== prev.timeline) e.setFilm(s.timeline);
    });
    return () => {
      unsubscribe();
      e.destroy();
      setFilmEngine(null);
      engineRef.current = null;
    };
  }, []);

  // The biggest frame of the film's shape that fits.
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const fit = () => {
      const ratio = a.w / a.h;
      const w = Math.min(el.clientWidth - 24, (el.clientHeight - 24) * ratio);
      setBox({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(w / ratio)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.w, a.h]);

  useEffect(() => {
    monitorScreen.el = screen.current;
    return () => {
      monitorScreen.el = null;
    };
  }, []);

  return (
    <section aria-label="Monitor" className="relative flex min-h-[260px] flex-col overflow-hidden lg:min-h-0 lg:flex-1">
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
        <SelectionBar />
      </div>
    </section>
  );
}

/**
 * The selected shot's tools (length or trim, speed, sound, fill, fades, make it move, split, duplicate, delete), on a
 * solid bar over the screen's foot while one is selected: glass over a bright shot was hard to read.
 */
function SelectionBar() {
  const clip = useEditor((s) => (s.selected ? (s.timeline.main.find((c) => c.id === s.selected) ?? s.timeline.music.find((c) => c.id === s.selected) ?? null) : null));
  const number = useEditor((s) => {
    if (!s.selected) return null;
    const i = s.timeline.main.findIndex((c) => c.id === s.selected);
    return i >= 0 ? i + 1 : null;
  });
  if (!clip) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <div className="scroll-thin pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[16px] bg-[#17181c]/95 p-1 shadow-[0_18px_40px_-16px_rgb(0_0_0/0.9),inset_0_0_0_1px_rgb(255_255_255/0.08)] backdrop-blur-md">
        <ShotTools key={clip.id} clip={clip} music={!number} number={number} />
      </div>
    </div>
  );
}

/**
 * Which shot this is, over the picture while it's paused (a viewfinder's readout), gone while it plays. It follows the
 * shot under the playhead, not the playhead itself: a still frame of the cut redraws it, a playing one never does.
 */
function ShotLabel() {
  const playing = usePlayhead((s) => s.playing);
  const label = useShotAt();
  if (playing || !label) return null;
  const [index, count, kind] = label.split(":");
  const Icon = kind === "image" ? ImageIcon : Film;
  return (
    <span className="tabular pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-[7px] bg-black/55 px-1.5 py-0.5 text-[10.5px] font-semibold text-paper/85">
      <Icon size={10} className="text-paper/60" />
      {Number(index) + 1}
      <span className="text-paper/45">/ {count}</span>
    </span>
  );
}

/** "index:count:kind" of the shot under the playhead, as one string so a playhead moving inside a shot changes nothing. */
function useShotAt() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const look = () => {
      const main = useEditor.getState().timeline.main;
      const at = placedAt(placed(main), usePlayhead.getState().t);
      const next = at ? `${at.index}:${main.length}:${at.clip.kind}` : null;
      setLabel((l) => (l === next ? l : next));
    };
    look();
    const offPlayhead = usePlayhead.subscribe((s, prev) => {
      // While it plays the label is hidden: looked up again when it stops.
      if (s.playing) return;
      if (s.t !== prev.t || s.playing !== prev.playing) look();
    });
    const offCut = useEditor.subscribe((s, prev) => {
      if (s.timeline !== prev.timeline) look();
    });
    return () => {
      offPlayhead();
      offCut();
    };
  }, []);
  return label;
}

type Freeze = "first" | "here" | "last";

/** A time to the hundredth of a second ("0:03.42"): where a freeze is taken, exactly. */
function exactTime(t: number) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

/**
 * The shot a freeze is taken from, and where: the first or last frame of the shot that's selected (else the one under
 * the playhead), or the frame under the playhead to the hundredth of a second, as a time in its clip's own file.
 */
function freezeTarget(which: Freeze) {
  const { timeline, selected } = useEditor.getState();
  const list = placed(timeline.main);
  const t = usePlayhead.getState().t;
  const under = placedAt(list, t);
  const chosen = which === "here" ? under : (list.find((p) => p.clip.id === selected) ?? under);
  if (!chosen) return null;
  const c = chosen.clip;
  const at = which === "first" ? c.in : which === "last" ? Math.max(c.in, c.out - 1 / FPS) : Math.min(c.out, Math.max(c.in, c.in + (t - chosen.start) * speedOf(c)));
  return { placed: chosen, at, t };
}

/**
 * Freeze: a frame of a shot kept as a picture in Files, full size (to put on the timeline as a still, make a clip from,
 * or start a Director set from): its first frame, its last, or the one under the playhead to the exact moment.
 */
export function FreezeMenu() {
  const project = useEditor((s) => s.project?.id ?? null);
  const empty = useEditor((s) => !s.timeline.main.length);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const done = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(done.current), []);
  const freeze = async (which: Freeze) => {
    const target = freezeTarget(which);
    if (!project || !target || target.placed.clip.kind !== "video") return;
    const clip = target.placed.clip;
    const when = which === "here" ? exactTime(target.t) : which === "first" ? "first frame" : "last frame";
    setState("busy");
    try {
      const res = await fetch(`/api/storyboard/projects/${project}/freeze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: clip.url, t: target.at, name: `Shot ${target.placed.index + 1} · ${when}` }),
      });
      const data = (await res.json().catch(() => ({}))) as { item?: EditFile; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error ?? "Couldn't freeze that frame.");
      const item = data.item;
      const files = useProjectFiles.getState();
      if (files.project === project) useProjectFiles.setState({ items: [item, ...files.items.filter((x) => x.key !== item.key)], error: null });
      setState("done");
      clearTimeout(done.current);
      done.current = setTimeout(() => setState("idle"), 2200);
    } catch (err) {
      useProjectFiles.setState({ error: (err as Error).message });
      setState("idle");
    }
  };
  return (
    <Popover
      placement="top-end"
      panelClassName="w-[268px] p-1"
      trigger={({ open, toggle }) => (
        <ToolButton label={state === "done" ? "Frozen: it's in Files" : "Freeze a frame of the shot into Files"} onClick={toggle} active={open} disabled={empty || state === "busy"}>
          {state === "busy" ? <LoaderCircle size={15} className="animate-spin" /> : state === "done" ? <Check size={15} className="text-spike" /> : <Snowflake size={15} />}
        </ToolButton>
      )}
    >
      {(close) => (
        <FreezeItems
          onFreeze={(which) => {
            close();
            void freeze(which);
          }}
        />
      )}
    </Popover>
  );
}

/** The freeze menu's choices, read as it opens: the shot they'd come from and the moment under the playhead. */
function FreezeItems({ onFreeze }: { onFreeze: (which: Freeze) => void }) {
  const [shot] = useState(() => freezeTarget("first"));
  const [here] = useState(() => freezeTarget("here"));
  const still = shot?.placed.clip.kind !== "video";
  const shotName = shot ? `Shot ${shot.placed.index + 1}` : "";
  return (
    <div>
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">Freeze into Files</p>
      <MenuItem onSelect={() => onFreeze("first")} disabled={still} hint={shotName}>
        First frame
      </MenuItem>
      <MenuItem onSelect={() => onFreeze("here")} disabled={here?.placed.clip.kind !== "video"} hint={<span className="tabular font-mono">{here ? exactTime(here.t) : ""}</span>}>
        This frame
      </MenuItem>
      <MenuItem onSelect={() => onFreeze("last")} disabled={still} hint={shotName}>
        Last frame
      </MenuItem>
      {still ? <p className="px-2.5 pb-1.5 pt-0.5 text-[11.5px] leading-snug text-haze">This shot is a picture: it&apos;s in Files already.</p> : null}
    </div>
  );
}

/** The film's shape: every picture and clip fills it (or fits inside it, shot by shot). */
export function ShapeMenu() {
  const aspect = useEditor((s) => s.project?.aspect ?? "16:9");
  const setAspect = useEditor((s) => s.setAspect);
  return (
    <Popover
      placement="top-end"
      panelClassName="w-[220px] p-1"
      trigger={({ open, toggle }) => (
        <ToolPill title="The film's shape" onClick={toggle} active={open} className="px-2 text-[12px]">
          <Glyph id={aspect} />
          <span className="tabular">{aspect}</span>
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
export function Transport({ disabled }: { disabled: boolean }) {
  const playing = usePlayhead((s) => s.playing);
  const total = useEditor((s) => filmLength(s.timeline));
  const jump = (dir: -1 | 1) => {
    const t = usePlayhead.getState().t;
    const cuts = [0, ...placed(useEditor.getState().timeline.main).map((p) => p.end)];
    const to = dir < 0 ? ([...cuts].reverse().find((c) => c < t - 0.05) ?? 0) : (cuts.find((c) => c > t + 0.05) ?? total);
    film.seek(to);
  };
  return (
    <div className="flex items-center gap-1">
      <ToolButton label="Back to the last cut" onClick={() => jump(-1)} disabled={disabled}>
        <SkipBack size={15} />
      </ToolButton>
      <button
        type="button"
        onClick={() => film.toggle()}
        disabled={disabled}
        aria-label={playing ? "Pause (Space)" : "Play (Space)"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        className="press grid size-9 place-items-center rounded-full bg-paper text-[#16131b] hover:bg-white disabled:opacity-30"
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
      </button>
      <ToolButton label="On to the next cut" onClick={() => jump(1)} disabled={disabled}>
        <SkipForward size={15} />
      </ToolButton>
      <Clock total={total} />
    </div>
  );
}

/** The time readout, written straight into its text as the film plays (React draws it once). */
function Clock({ total }: { total: number }) {
  const now = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    let shown = "";
    const write = (t: number) => {
      const text = timecode(Math.min(t, total));
      if (text !== shown && now.current) now.current.textContent = shown = text;
    };
    write(usePlayhead.getState().t);
    return usePlayhead.subscribe((s, prev) => {
      if (s.t !== prev.t) write(s.t);
    });
  }, [total]);
  return (
    <p className="tabular ml-1.5 hidden min-w-[104px] font-mono text-[12px] text-fog sm:block">
      <span ref={now} className="text-paper" />
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
