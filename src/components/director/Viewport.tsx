"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Aperture, Grid3x3, ImagePlus, Images, LoaderCircle, Move3d, PersonStanding, Redo2, ScanEye, Trash2, TriangleAlert, Undo2, UserRound } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { aspectById } from "@/lib/shot";
import { ThirdsGrid } from "@/components/ui/Viewfinder";
import { addFilesToCast, setPlaceFile } from "./intake";
import { useLocation } from "./location";
import { useLift } from "./lift";
import { aboutTime, buildWorld, loadTypical, useTypical, useWorld } from "./around";
import { useExtend } from "./extend";
import { CutPlayer } from "./Clips";
import { TakeCompare, TakesLibrary, useTakesSummary } from "./Takes";
import { TitleBar, ToolButton, ToolGroup, ToolPill } from "./TitleBar";
import { useTakeView } from "./take-view";
import { useStageView } from "./stage/view";

const Stage3D = dynamic(() => import("./stage/Stage3D"), {
  ssr: false,
  loading: () => <div className="skeleton size-full" />,
});

/**
 * The camera's screen: a title bar with its tools, and under it exactly the frame you'll get, as big as the middle
 * allows; the takes are one button away on the same screen instead of a strip under it (the user found the middle
 * crowded, with blank space all round a small picture).
 */
export function Viewport() {
  const scene = useDirector((s) => s.scene);
  const canUndo = useDirector((s) => s.past.length > 0);
  const canRedo = useDirector((s) => s.future.length > 0);
  const { undo, redo, reset, toPhotoView } = useDirector.getState();
  const viewing = useTakeView((s) => s.viewing);
  const model = useStageView((s) => s.model);
  const scout = useStageView((s) => s.scout);
  const [thirds, setThirds] = useState(false);
  const [library, setLibrary] = useState(false);
  const takes = useTakesSummary();
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const a = aspectById(scene.aspect);
  const empty = !scene.elements.length && !scene.place.image;

  // Fit the largest frame with the shot's aspect ratio into the available space.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const pad = 0;
      const W = el.clientWidth - pad * 2;
      const H = el.clientHeight - pad * 2;
      const ratio = a.w / a.h;
      const w = Math.min(W, H * ratio);
      setBox({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(w / ratio)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.w, a.h]);

  return (
    <div className="surface relative flex h-full min-h-0 flex-col overflow-hidden rounded-panel">
      <TitleBar>
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
        {/* How to move: always there, quietly (it was a hint once, then gone). */}
        <p className="mx-auto hidden min-w-0 truncate px-2 text-[11.5px] text-haze xl:block">
          {empty
            ? ""
            : scout
              ? "Drag to look around · right-drag to slide · scroll to zoom · drag people to place them · drag the orange camera"
              : "W A S D walk · Q E up and down · arrows look · F frames the cast · drag to orbit · scroll to move in"}
        </p>
        <span className="flex-1 xl:hidden" />
        <ToolGroup>
          <TakesButton count={takes.count} live={takes.live} progress={takes.progress} fresh={takes.fresh} onClick={() => setLibrary(true)} />
        </ToolGroup>
        <ToolGroup>
          {scene.place.image && !scout ? (
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
          {box.w > 0 ? <Stage3D /> : null}
          {thirds && !scout ? <ThirdsGrid opacity={0.16} /> : null}
          {model && !empty ? (
            <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-2 py-1 text-[11.5px] font-medium text-paper/90">
              Model&apos;s view · each color is one of your cast
            </span>
          ) : null}
          <SetStatus />
          <CutPlayer />
          <AnimatePresence>{empty ? <EmptySet /> : null}</AnimatePresence>
        </div>
      </div>
      <AnimatePresence>{library ? <TakesLibrary key="library" onClose={() => setLibrary(false)} /> : null}</AnimatePresence>
      <AnimatePresence>{viewing ? <TakeCompare key="compare" /> : null}</AnimatePresence>
    </div>
  );
}

/** The takes: how many, how far the ones being made are, new ones. Opens them all on the screen. */
function TakesButton({ count, live, progress, fresh, onClick }: { count: number; live: number; progress: number; fresh: number; onClick: () => void }) {
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

/** Time since it started, and the usual time when there is one: "0:42 · usually about 1 min". */
function Elapsed({ expect }: { expect: number | null }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return (
    <span className="tabular shrink-0 text-paper/55">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      {expect ? ` · usually ${aboutTime(expect)}` : ""}
    </span>
  );
}

/** What's being built for the set (the place, its things lifted out, the world all around), or what went wrong. */
function SetStatus() {
  const lift = useLift((s) => s.busy);
  const { busy: world, error } = useWorld();
  const placed = useDirector((s) => Boolean(s.scene.place.image));
  const making = useLocation((s) => s.busy);
  const extending = useExtend((s) => s.stage);
  const measuring = useWorld((s) => s.measuring);
  const typical = useTypical();
  useEffect(loadTypical, []);
  const text = making
    ? "Drawing the place"
    : extending
      ? extending
      : lift
        ? lift
        : world
          ? "Building the place all around you"
          : measuring && placed
            ? "Measuring the place so you can walk in it"
            : null;
  return (
    <AnimatePresence>
      {text || error ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-lg bg-black/65 px-2.5 py-1.5 text-[12px] font-medium text-paper/90 backdrop-blur-sm"
        >
          {text ? <LoaderCircle size={13} className="shrink-0 animate-spin" /> : <TriangleAlert size={13} className="shrink-0 text-tally" />}
          <span className="truncate">{text ? `${text}…` : error}</span>
          {/* How long so far, and how long a place usually takes here (it said "about a minute" while it took six). */}
          {text && (making || world) ? (
            <Elapsed key={making ? "making" : "world"} expect={making ? (typical.photo ?? 0) + (typical.world ?? 0) : typical.world} />
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
function EmptySet() {
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
