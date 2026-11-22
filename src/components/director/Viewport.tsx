"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Aperture, Grid3x3, ImagePlus, Images, Keyboard, LoaderCircle, Move3d, PersonStanding, Redo2, ScanEye, Trash2, TriangleAlert, Undo2, UserRound } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { aspectById } from "@/lib/shot";
import { ThirdsGrid } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { Popover } from "@/components/ui/Popover";
import { addFilesToCast, setPlaceFile } from "./intake";
import { aboutTime, loadTypical, useExtend, useLift, useLocation, useTypical, useWorld, useWorldClock } from "./status";
import { buildWorld, stopWorld } from "./around";
import { CutPlayer } from "./Clips";
import { TakeCompare, TakesLibrary, useTakesSummary } from "./Takes";
import { TitleBar, ToolButton, ToolGroup, ToolPill } from "./TitleBar";
import { closeLibrary, openLibrary, useTakeView } from "./take-view";
import { useStageView } from "./stage/view";

const Stage3D = dynamic(() => import("./stage/Stage3D"), {
  ssr: false,
  loading: () => <div className="skeleton size-full" />,
});

/**
 * The camera's screen: a title bar with its tools, and under it exactly the frame you'll get, as big as the middle
 * allows; the takes are one button away on the same screen instead of a strip under it (the middle was crowded,
 * with blank space all round a small picture).
 */
export function Viewport() {
  // Only what the screen itself shows: the stage follows the set on its own, so typing the shot's words or a take's
  // progress doesn't redraw the 3D view (every change of the set re-rendered the whole stage).
  const aspect = useDirector((s) => s.scene.aspect);
  const empty = useDirector((s) => !s.scene.elements.length && !s.scene.place.image);
  const hasPlace = useDirector((s) => Boolean(s.scene.place.image));
  const canUndo = useDirector((s) => s.past.length > 0);
  const canRedo = useDirector((s) => s.future.length > 0);
  const { undo, redo, reset, toPhotoView } = useDirector.getState();
  const viewing = useTakeView((s) => s.viewing);
  const library = useTakeView((s) => s.library);
  const model = useStageView((s) => s.model);
  const scout = useStageView((s) => s.scout);
  const making = useLocation((s) => s.busy);
  const [thirds, setThirds] = useState(false);
  const takes = useTakesSummary();
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const a = aspectById(aspect);
  const stage = useMemo(() => <Stage3D />, []);

  // Fit the largest frame with the shot's aspect ratio into the available space, before the first paint (measured
  // after it, the frame was drawn at one size and then jumped to its own).
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const ratio = a.w / a.h;
      const w = Math.min(W, H * ratio);
      setBox((b) => {
        const next = { w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(w / ratio)) };
        return b.w === next.w && b.h === next.h ? b : next;
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.w, a.h]);

  return (
    <div className="surface relative flex h-full min-h-0 flex-col overflow-hidden rounded-panel">
      <TitleBar scroll>
        <ToolGroup>
          <ToolButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
            <Undo2 size={15} />
          </ToolButton>
          <ToolButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
            <Redo2 size={15} />
          </ToolButton>
        </ToolGroup>
        {!empty ? (
          <ToolGroup label="View">
            <ToolPill active={!scout} onClick={() => useStageView.setState({ scout: false })} title="Through the lens: exactly the frame you'll get">
              <Aperture size={14} /> Shot
            </ToolPill>
            <ToolPill active={scout} onClick={() => useStageView.setState({ scout: true, model: false })} title="Walk around the set: place people and move the camera itself">
              <Move3d size={14} /> Scout
            </ToolPill>
          </ToolGroup>
        ) : null}
        {/* How to move: the whole line where the bar has room for it, else one button that shows it all (cut short on
            the MacBook it read "W A S D walk · Q E up and down · …"). */}
        {empty ? (
          <span className="flex-1" />
        ) : (
          <>
            <p className="mx-auto hidden min-w-0 truncate px-2 text-[11.5px] text-haze min-[1700px]:block">{scout ? SCOUT_LINE : SHOT_LINE}</p>
            <span className="flex-1 min-[1700px]:hidden" />
            <ControlsButton scout={scout} />
          </>
        )}
        <ToolGroup>
          <TakesButton count={takes.count} live={takes.live} progress={takes.progress} fresh={takes.fresh} onClick={openLibrary} />
        </ToolGroup>
        <ToolGroup>
          {hasPlace && !scout ? (
            <ToolButton label="Back to the photo's viewpoint" onClick={toPhotoView}>
              <ScanEye size={15} />
            </ToolButton>
          ) : null}
          <ToolButton
            label={model ? "Back to the camera view" : "What the image model sees: stand-ins instead of photos, unknown parts in gray"}
            onClick={() => useStageView.setState({ model: !model, scout: false })}
            active={model}
          >
            <PersonStanding size={15} />
          </ToolButton>
          <ToolButton label="Rule-of-thirds grid" onClick={() => setThirds((v) => !v)} active={thirds}>
            <Grid3x3 size={15} />
          </ToolButton>
          <ToolButton label="Clear the set" onClick={reset} disabled={empty}>
            <Trash2 size={15} />
          </ToolButton>
        </ToolGroup>
      </TitleBar>

      <div ref={wrap} className="relative grid min-h-0 flex-1 place-items-center bg-[#0d0e11]">
        <div className="relative overflow-hidden" style={{ width: box.w, height: box.h }}>
          {box.w > 0 ? stage : null}
          {thirds && !scout ? <ThirdsGrid opacity={0.16} /> : null}
          {model && !empty ? (
            <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[11.5px] font-medium text-paper/90">
              Model&apos;s view · each color is one of your cast
            </span>
          ) : null}
          <SetStatus />
          <CutPlayer />
          {/* Drawing the place is a generation: the generating field fills the screen while it's made (the empty set's
              "press Create" stayed up the whole time). */}
          <AnimatePresence>{making ? <MakingPlace key="making" /> : empty ? <EmptySet key="empty" /> : null}</AnimatePresence>
        </div>
      </div>
      <AnimatePresence>{library ? <TakesLibrary key="library" onClose={closeLibrary} /> : null}</AnimatePresence>
      <AnimatePresence>{viewing ? <TakeCompare key="compare" /> : null}</AnimatePresence>
    </div>
  );
}

const SHOT_LINE = "W A S D walk · Q E up and down · arrows look · F frames the cast · drag to orbit · scroll to move in";
const SCOUT_LINE = "Drag to look around · right-drag to slide · scroll to zoom · drag people to place them · drag the orange camera";

/** Every way to move, by view: through the lens, scouting, and what works on whoever is picked. */
const CONTROLS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Through the lens",
    rows: [
      ["W A S D", "Walk"],
      ["Q  E", "Down and up"],
      ["Arrows", "Look around"],
      ["Drag", "Orbit the shot"],
      ["Shift or right-drag", "Raise or lower the camera"],
      ["Scroll", "Move in and out"],
      ["F", "Frame the cast"],
    ],
  },
  {
    title: "Scouting",
    rows: [
      ["Drag", "Look around"],
      ["Right-drag", "Slide"],
      ["Scroll", "Zoom"],
      ["Drag a person", "Place them"],
      ["Drag the orange camera", "Move the shot camera"],
    ],
  },
  {
    title: "Someone picked",
    rows: [
      ["Arrows", "Nudge them (Shift: farther)"],
      ["Delete", "Take them off the set"],
      ["Esc", "Let go"],
    ],
  },
  {
    title: "Anywhere",
    rows: [
      ["Ctrl Z", "Undo"],
      ["Ctrl Shift Z", "Redo"],
    ],
  },
];

/** The controls, all of them, one click away (the line under the title bar didn't fit on a laptop screen). */
function ControlsButton({ scout }: { scout: boolean }) {
  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[330px]"
      className="min-[1700px]:hidden"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="How to move the camera and the cast"
          className="press squircle inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper aria-expanded:bg-white/[0.08] aria-expanded:text-paper"
        >
          <Keyboard size={14} /> Controls
        </button>
      )}
    >
      {() => (
        <div className="space-y-3 p-3">
          {CONTROLS.filter((g) => (scout ? g.title !== "Through the lens" : g.title !== "Scouting")).map((g) => (
            <section key={g.title}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">{g.title}</p>
              <dl className="grid grid-cols-[132px_1fr] items-center gap-x-3 gap-y-1.5">
                {g.rows.map(([keys, what]) => (
                  <div key={keys + what} className="contents">
                    <dt>
                      <kbd className="inline-flex min-h-6 max-w-full items-center rounded-[7px] bg-white/[0.07] px-2 py-0.5 font-mono text-[11px] font-medium leading-tight text-paper shadow-[inset_0_-1px_0_rgb(255_255_255/0.06),inset_0_0_0_1px_rgb(255_255_255/0.06)]">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="text-[12.5px] text-fog">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** The takes: how many, how far the ones being made are, new ones. Opens them all on the screen. */
export function TakesButton({ count, live, progress, fresh, onClick }: { count: number; live: number; progress: number; fresh: number; onClick: () => void }) {
  return (
    <ToolPill title="Your takes: compare each with what you planned" onClick={onClick}>
      {live ? <LoaderCircle size={14} className="animate-spin text-spike" /> : <Images size={14} />}
      Takes
      {count ? <span className="tabular text-haze">{count}</span> : null}
      {live ? <span className="tabular text-[11.5px] text-spike">{Math.round(progress * 100)}%</span> : null}
      {fresh && !live ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-spike" /> : null}
    </ToolPill>
  );
}

/** The time now, once a second while something is running (for its elapsed time and estimated progress). */
function useTicking(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** How far along a step that usually takes `expect` seconds is after `since`: never quite done until it is. */
const estimate = (now: number, since: number | null, expect: number | null | undefined) =>
  since && expect ? Math.min(0.95, Math.max(0.02, (now - since) / 1000 / expect)) : null;

/** The place being drawn from your words: the generating field over the screen, with how long it usually takes. */
export function MakingPlace() {
  const since = useLocation((s) => s.since);
  const words = useLocation((s) => s.words);
  const typical = useTypical();
  useEffect(loadTypical, []);
  const now = useTicking(true);
  const usually = (typical.photo ?? 0) + (typical.world ?? 0);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="absolute inset-0 z-20">
      <GeneratingField
        stage={usually ? `Drawing the place · usually ${aboutTime(usually)} with its world` : "Drawing the place"}
        progress={estimate(now, since, typical.photo)}
        prompt={words}
        since={since ?? undefined}
      />
    </motion.div>
  );
}

/** Time since it started, and the usual time when there is one: "0:42 · usually about 1 min". */
function Elapsed({ since, expect }: { since: number; expect: number | null }) {
  const now = useTicking(true);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="tabular shrink-0 text-paper/55">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      {expect ? ` · usually ${aboutTime(expect)}` : ""}
    </span>
  );
}

/**
 * What's being built for the set (its things lifted out, the world all around, an extend), or what went wrong. The
 * world and an extend are drawn by a model: their pill carries a small generating field, the way every generation shows
 * (the place is built around the picture you keep working on, so it doesn't cover the screen); finding things and
 * measuring are analysis, with a spinner.
 */
export function SetStatus() {
  const lift = useLift((s) => s.busy);
  const world = useWorld((s) => s.busy);
  const error = useWorld((s) => s.error);
  const measuring = useWorld((s) => s.measuring);
  const placed = useDirector((s) => Boolean(s.scene.place.image));
  const extending = useExtend((s) => s.stage);
  const worldSince = useWorldClock((s) => s.since);
  const typical = useTypical();
  useEffect(loadTypical, []);
  const text = extending ? extending : lift ? lift : world ? "Building the place all around you" : measuring && placed ? "Measuring the place so you can walk in it" : null;
  const generating = Boolean(extending) || (!lift && world);
  const now = useTicking(Boolean(world && !extending && !lift));
  const progress = world && !extending && !lift ? estimate(now, worldSince, typical.world) : null;
  return (
    <AnimatePresence>
      {text || error ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-16px)] items-center gap-2 rounded-lg bg-black/75 py-1.5 pl-1.5 pr-2.5 text-[12px] font-medium text-paper/90 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]"
        >
          {text ? (
            generating ? (
              <span className="relative h-5 w-8 shrink-0 overflow-hidden rounded-[6px]">
                <GeneratingField bare progress={progress} className="rounded-[6px]" />
              </span>
            ) : (
              <LoaderCircle size={13} className="ml-1 shrink-0 animate-spin" />
            )
          ) : (
            <TriangleAlert size={13} className="ml-1 shrink-0 text-tally" />
          )}
          <span className="truncate">{text ? `${text}…` : error}</span>
          {/* How long so far, and how long a place usually takes here (it said "about a minute" while it took six). */}
          {text && world && !extending && !lift && worldSince ? <Elapsed since={worldSince} expect={typical.world} /> : null}
          {text && world && !extending && !lift ? (
            <button type="button" onClick={stopWorld} title="Stop building the world (its job on the GPU stops too)" className="press shrink-0 font-semibold text-fog underline-offset-2 hover:text-paper hover:underline">
              Stop
            </button>
          ) : null}
          {!text && error ? (
            <button type="button" onClick={() => void buildWorld()} className="press shrink-0 font-semibold underline-offset-2 hover:underline">
              Try again
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Nothing on set yet: the two ways to start. */
export function EmptySet() {
  const placeInput = useRef<HTMLInputElement>(null);
  const castInput = useRef<HTMLInputElement>(null);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 grid place-items-center bg-black/30 p-6 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-[460px] text-center">
        <p className="font-display text-[26px]">Set the scene</p>
        <p className="mx-auto mt-1.5 max-w-[360px] text-[14px] leading-relaxed text-fog">
          Say where it happens and the place is built all around you. Add who&apos;s in it, then move the camera until it looks right.
        </p>
        <p className="mx-auto mt-4 max-w-[360px] text-[13px] leading-relaxed text-haze">Describe the place in the bar below and press Create, or start from a photo:</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <StartButton icon={<ImagePlus size={18} />} title="A place" sub="From a photo" onClick={() => placeInput.current?.click()} />
          <StartButton icon={<UserRound size={18} />} title="Who or what" sub="People, pets, products" onClick={() => castInput.current?.click()} />
        </div>
        <p className="mt-3 text-[12px] text-haze">or drop photos anywhere here</p>
        <input
          ref={placeInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setPlaceFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={castInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addFilesToCast(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
    </motion.div>
  );
}

function StartButton({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press squircle flex flex-col items-center gap-2 rounded-card bg-white/[0.06] px-3 py-4 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.1]"
    >
      <span className="grid size-10 place-items-center rounded-[12px] bg-spike/15 text-spike">{icon}</span>
      <span>
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="block text-[12px] text-haze">{sub}</span>
      </span>
    </button>
  );
}
