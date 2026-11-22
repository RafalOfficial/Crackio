"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Box,
  Camera,
  Clapperboard,
  Download,
  Check,
  ChevronDown,
  Ellipsis,
  Eye,
  Focus,
  Grid3x3,
  Hand,
  House,
  ImagePlus,
  Images,
  Keyboard,
  LoaderCircle,
  Menu,
  Move3d,
  PersonStanding,
  Redo2,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Undo2,
  UserPlus,
  UserRound,
  Wand2,
  X,
} from "lucide-react";
import { MathUtils } from "three";
import { useDirector } from "@/lib/director/store";
import { installAgentHook } from "../agent-hook";
import { cameraHeight, pedestalTo } from "@/lib/director/camera";
import { FEEL, useFeel, type PlaceLook, type Scheme } from "@/lib/director/feel";
import { ASPECTS, aspectById } from "@/lib/shot";
import { ThirdsGrid } from "@/components/ui/Viewfinder";
import { cn } from "@/lib/cn";
import { useStageView } from "../stage/view";
import { nav } from "../stage/Nav";
import { walking } from "../walk";
import { DropZone, useHandoffIntoScene, useReadCast, useScriptHandle } from "../DirectorWorkspace";
import { MakingPlace, SetStatus } from "../Viewport";
import { friendlyModelError, useLocation } from "../status";
import { TakeCompare, TakesLibrary, useDirectorTakes, useTakesSummary } from "../Takes";
import { previewUrl } from "@/lib/media-url";
import type { Scene } from "@/lib/director/types";
import { closeLibrary, closeTake, openLibrary, openTake, useTakeView, useTakesFrom } from "../take-view";
import { toolTakesNow, useToolTakes } from "@/components/tools/use-tool-takes";
import { CutPlayer } from "../Clips";
import { ScenePanel } from "../ScenePanel";
import { PromptBar } from "../PromptBar";
import { addFilesToCast, setPlaceFile, setPlaceVideoFile } from "../intake";
import { VideoBar, VideoPanel, useVideoMode } from "./VideoMode";
import { useDirectorShot, useShotSize } from "../shot-model";
import { shotModelOf } from "../models";
import { useModelsStore } from "@/lib/hooks/use-models";
import { useGenerationsStore } from "@/lib/hooks/use-generations";
import { notice, useNotice } from "./notice";
import { Timeline } from "./Timeline";
import { downloadPreview, recordPreview } from "./preview";
import { hasKeys } from "@/lib/director/timeline";
import { FilmIt } from "./FilmIt";
import { FixSpot, useFixSpot } from "./FixSpot";
import { usePhoneLayout, type PhoneLayout } from "./compact";
import { useShell } from "@/components/shell/shell-store";

const Stage3D = dynamic(() => import("../stage/Stage3D"), {
  ssr: false,
  loading: () => <div className="size-full bg-[#0d0e11]" />,
});

/** Room kept around the Camera tab's frame for the rulers and the tools floating over the stage (px each side). */
const SIDE = 118;
const TOP = 66;
const BOTTOM = 70;

/**
 * Director v2: one screen. The stage fills the middle (Set: look around and place people; Camera: look through the one
 * Camera). Tools appear when there's something to use them on: an empty set shows only how to start; the rulers and the
 * move buttons come up while your pointer is over the stage. The shot and the cast are on the right, words and Shoot below.
 * `embedded`: inside Storyboard, under its own bar (as tall as the space left, not the window).
 */
export function Director({ embedded = false }: { embedded?: boolean } = {}) {
  // Director v2 before anything reads it (the place's builders check it on their first run).
  useState(() => useStageView.setState({ v2: true, scout: false }));
  useHandoffIntoScene();
  useReadCast();
  // Crackio's own hidden page (an agent's Director): the scene and the camera view made reachable (agent-hook).
  useEffect(installAgentHook, []);
  useScriptHandle();
  useKeys();
  // Nothing is built for the place by itself here (no world, no lifting, not even "again once a GPU joins": that one
  // put a world built hours before back on screen when a phone came back to the Director).
  useShowFinishedTakes();
  useKeepGpuWarm();
  useEffect(() => {
    useStageView.setState({ v2: true, scout: false });
    return () => useStageView.setState({ v2: false, scout: false });
  }, []);
  const phone = usePhoneLayout();
  const video = useVideoMode();

  // A phone: the stage full screen, like a camera app, with everything else floating over it or in one sheet (the
  // first phone layout was unusable: the panels stacked under a stage a third of the screen).
  if (phone) {
    return (
      <div className={cn("relative overflow-hidden bg-[#0d0e11]", embedded ? "h-[80dvh] min-h-[420px] rounded-panel" : "h-dvh")}>
        <StageArea phone={phone} />
      </div>
    );
  }

  return (
    <div className={cn("grid min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[minmax(0,1fr)_auto_auto]", embedded ? "lg:h-full sm:p-4 lg:py-4" : "h-dvh")}>
      <section aria-label="Stage" className="surface relative min-h-[60vh] overflow-hidden rounded-panel lg:min-h-0">
        <StageArea />
      </section>
      <aside aria-label="Shot, cast and place" className="surface min-h-0 overflow-hidden rounded-panel lg:row-span-3">
        <SidePanel />
      </aside>
      <ShotTimeline />
      {video ? (
        // Video mode: the words and Film it (the video filmed again along your path); no stills, no cast.
        <VideoBar />
      ) : (
        <div className="flex min-w-0 items-stretch gap-3">
          <div className="min-w-0 flex-1">
            <PromptBar lean />
          </div>
          <FilmIt />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ stage ------------------------------------------ */

/** A phone's top row of floating controls (menu, tabs, frame, takes, the sheet), px. */
const PHONE_TOP = 56;

function StageArea({ phone = null }: { phone?: PhoneLayout }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // A phone: how tall the controls floating along the bottom are (the frame stays clear of them), and the sheet.
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
  const [inset, setInset] = useState(0);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    if (!bottom) return;
    const fit = () => setInset(bottom.offsetHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, [bottom]);
  const scout = useStageView((s) => s.scout);
  const preview = useStageView((s) => s.preview);
  const aspect = useDirector((s) => s.scene.aspect);
  const empty = useDirector((s) => !s.scene.elements.length && !s.scene.place.image);
  const making = useLocation((s) => s.busy);
  const library = useTakeView((s) => s.library);
  const viewing = useTakeView((s) => s.viewing);
  const [thirds, setThirds] = useState(false);
  const awake = useAwake(wrap);
  const a = aspectById(aspect);
  const ratio = a.w / a.h;
  const stage = useMemo(() => <Stage3D />, []);
  const video = useVideoMode();

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The shot's frame: as big as the stage allows round the tools, centered on the stage (the lens's middle). On a phone
  // the tools float over the stage, so only their own height is kept clear (the rulers' room on a computer made the
  // frame a stamp on a phone).
  const frame = useMemo(() => {
    if (!box.w || !box.h) return null;
    const side = phone ? 10 : SIDE;
    const vertical = phone ? Math.max(PHONE_TOP, inset + 8) : Math.max(TOP, BOTTOM);
    const h = Math.max(80, Math.min(box.h - 2 * vertical, (box.w - 2 * side) / ratio));
    const w = h * ratio;
    return { w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 };
  }, [box, ratio, phone, inset]);
  // The small live picture of the shot (Set tab), top right under the output line.
  const pip = useMemo(() => {
    if (!box.w) return null;
    const w = phone ? (phone === "landscape" ? 150 : 124) : Math.round(Math.min(300, Math.max(170, box.w * 0.2)));
    return phone ? { x: box.w - w - 10, y: PHONE_TOP + 4, w, h: Math.round(w / ratio) } : { x: box.w - w - 14, y: 60, w, h: Math.round(w / ratio) };
  }, [box, ratio, phone]);
  useEffect(() => {
    if (!frame) return;
    useStageView.setState({ fit: { scale: box.h / frame.h, aspect: ratio } });
  }, [frame, box.h, ratio]);
  useEffect(() => {
    useStageView.setState({ pip: pip && scout && preview && !empty ? pip : { x: 0, y: 0, w: 0, h: 0 } });
  }, [pip, scout, preview, empty]);

  return (
    <div ref={wrap} className="absolute inset-0 bg-[#0d0e11]">
      <DropZone size={null} fill>
        <div className="absolute inset-0">{box.w > 0 ? stage : null}</div>
      </DropZone>

      {!scout && frame && !empty ? <FrameMask frame={frame} thirds={thirds} /> : null}
      {phone ? null : <Fade show={!scout && Boolean(frame) && !empty && awake}>{frame ? <Rulers frame={frame} /> : null}</Fade>}
      {scout && preview && pip && !empty ? <PreviewWindow pip={pip} small={Boolean(phone)} /> : null}

      {/* A phone's controls, over the stage (not over your takes, which then fill the screen with their own). */}
      {phone && !library && !viewing ? (
        <>
          <PhoneTop empty={empty} onSheet={() => setSheet(true)} />
          {empty ? null : (
            // Clear of the window onto the shot (Set tab, top right).
            <div
              className="pointer-events-none absolute z-20 flex justify-center"
              style={{ top: PHONE_TOP + 2, left: 10, right: scout && preview && pip ? pip.w + 20 : 10 }}
            >
              <StatusLine phone />
            </div>
          )}
          {phone === "portrait" && !empty ? <TurnHint /> : null}
          {scout && !empty && pip ? <CameraHere top={preview ? pip.y + pip.h + 8 : PHONE_TOP + 4} /> : null}
          <div ref={setBottom} className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col gap-2 p-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            {empty ? null : <SelectionBar phone />}
            <PhoneBottom phone={phone} empty={empty} />
          </div>
          <PhoneSheet open={sheet} onClose={() => setSheet(false)} landscape={phone === "landscape"} thirds={thirds} setThirds={setThirds} />
        </>
      ) : null}

      <AnimatePresence>
        {!empty && !phone ? (
          <motion.div key="chrome" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-3">
              <div className="pointer-events-auto">
                <Tabs />
              </div>
              <div className="flex min-w-0 flex-1 justify-center pt-1">
                <StatusLine />
              </div>
              <div className="pointer-events-auto">
                <OutputChip compact={box.w < 1100} />
              </div>
            </div>
            <ToolRail thirds={thirds} setThirds={setThirds} />
            <ViewButtons awake={awake} />
            <SelectionBar />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!scout && !video ? <FixSpot /> : null}
      {phone ? (
        // Above the controls floating along the bottom.
        <div className="pointer-events-none absolute inset-x-0 h-0 [&>*]:pointer-events-auto" style={{ bottom: inset + 4 }}>
          <SetStatus />
        </div>
      ) : (
        <SetStatus />
      )}
      <CutPlayer />
      <AnimatePresence>{making ? <MakingPlace key="making" /> : empty ? <EmptyStage key="empty" phone={phone} below={inset} /> : null}</AnimatePresence>
      <AnimatePresence>{library ? <TakesLibrary key="library" onClose={closeLibrary} /> : null}</AnimatePresence>
      <AnimatePresence>{viewing ? <TakeCompare key="compare" /> : null}</AnimatePresence>
    </div>
  );
}

/** True while the pointer is over the stage, and for two seconds after: the rulers and move buttons come up then. */
function useAwake(ref: React.RefObject<HTMLDivElement | null>) {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      setAwake(true);
      if (t) clearTimeout(t);
      t = setTimeout(() => setAwake(false), 2200);
    };
    el.addEventListener("pointermove", wake);
    el.addEventListener("pointerdown", wake);
    el.addEventListener("wheel", wake, { passive: true });
    return () => {
      if (t) clearTimeout(t);
      el.removeEventListener("pointermove", wake);
      el.removeEventListener("pointerdown", wake);
      el.removeEventListener("wheel", wake);
    };
  }, [ref]);
  return awake;
}

function Fade({ show, children }: { show: boolean; children: ReactNode }) {
  return <div className={cn("transition-opacity duration-300", show ? "opacity-100" : "pointer-events-none opacity-0")}>{children}</div>;
}

/** Nothing on set yet: one line and two ways to start; the words go in the bar below. */
function EmptyStage({ phone = null, below = 0 }: { phone?: PhoneLayout; below?: number }) {
  const placeInput = useRef<HTMLInputElement>(null);
  const castInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const sideways = phone === "landscape";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={cn("absolute inset-0 z-10 grid place-items-center overflow-y-auto", phone ? "px-4" : "p-6")}
      style={phone ? { paddingTop: PHONE_TOP, paddingBottom: below + 8 } : undefined}
    >
      <div className={cn("w-full text-center", sideways ? "max-w-[420px]" : "max-w-[460px]")}>
        <p className={cn("font-display leading-tight", sideways ? "text-[21px]" : "text-[28px]")}>Where does it happen?</p>
        <p className={cn("text-fog", sideways ? "mt-1 text-[13px]" : "mt-2 text-[14px]")}>Describe a place in the bar below, or start from a photo.</p>
        <div className={cn("grid gap-2", sideways ? "mt-3 grid-cols-3" : phone ? "mt-5 grid-cols-2" : "mt-5 grid-cols-3")}>
          <StartButton icon={<ImagePlus size={18} />} title="A place" sub="From a photo" compact={sideways} onClick={() => placeInput.current?.click()} />
          <StartButton icon={<UserRound size={18} />} title="Someone" sub="People, pets, products" compact={sideways} onClick={() => castInput.current?.click()} />
          <StartButton icon={<Clapperboard size={18} />} title="A video" sub="Film it again from anywhere" compact={sideways} onClick={() => videoInput.current?.click()} />
        </div>
        {phone ? null : <p className="mt-3 text-[12px] text-haze">or drop photos or a video here</p>}
        <RecentSets compact={sideways} />
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
        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void setPlaceVideoFile(f).catch((err: Error) => notice(err.message, "stop", 6000));
          }}
        />
      </div>
    </motion.div>
  );
}

/** Your recent finished sets (a place and its cast): one click and you're back where you left it. */
function RecentSets({ compact = false }: { compact?: boolean }) {
  const takes = useDirectorTakes();
  const sets = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; scene: Scene; picture: string }[] = [];
    for (const g of takes) {
      const scene = g.params?.scene as Scene | undefined;
      const picture = g.outputs.find((o) => o.kind === "image")?.url;
      // A place's 360 world is built only when asked now: a set without one is still a set.
      if (!scene?.place.image || !scene.elements.length || !picture || g.status !== "done") continue;
      const key = `${scene.place.image?.url}|${scene.elements.map((e) => e.name).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, scene, picture });
      if (out.length >= 4) break;
    }
    return out;
  }, [takes]);
  if (!sets.length) return null;
  return (
    <div className={compact ? "mx-auto mt-3 max-w-[300px]" : "mt-6"}>
      <p className={cn("text-[12px] font-semibold uppercase tracking-[0.08em] text-haze", compact ? "mb-1.5" : "mb-2")}>Or continue a set</p>
      <div className={cn("grid grid-cols-4", compact ? "gap-1.5" : "gap-2")}>
        {sets.map((s) => (
          <button
            key={s.key}
            type="button"
            title={`${s.scene.place.text || "Your place"} · ${s.scene.elements.map((e) => e.name).join(", ")}`}
            onClick={() => useDirector.getState().loadScene(s.scene)}
            className="press squircle overflow-hidden rounded-[12px] opacity-85 shadow-[inset_0_0_0_1px_var(--color-line)] hover:opacity-100"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl(s.picture, 320)} alt="" className="aspect-[4/3] w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

function StartButton({ icon, title, sub, compact = false, onClick }: { icon: ReactNode; title: string; sub: string; compact?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press squircle flex items-center rounded-card bg-white/[0.05] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.09]",
        compact ? "gap-2.5 px-3 py-2.5 text-left" : "flex-col gap-2 px-3 py-4",
      )}
    >
      <span className={cn("grid shrink-0 place-items-center rounded-[12px] bg-spike/15 text-spike", compact ? "size-9" : "size-10")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="block truncate text-[12px] text-haze">{sub}</span>
      </span>
    </button>
  );
}

/** The Camera tab: the world dimmed around exactly the frame you'll get, with a fine line round it. */
function FrameMask({ frame, thirds }: { frame: { x: number; y: number; w: number; h: number }; thirds: boolean }) {
  const shade = "absolute bg-black/[0.8]";
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className={shade} style={{ left: 0, top: 0, right: 0, height: frame.y }} />
      <div className={shade} style={{ left: 0, top: frame.y + frame.h, right: 0, bottom: 0 }} />
      <div className={shade} style={{ left: 0, top: frame.y, width: frame.x, height: frame.h }} />
      <div className={shade} style={{ left: frame.x + frame.w, top: frame.y, right: 0, height: frame.h }} />
      <div className="absolute shadow-[0_0_0_1px_rgb(255_255_255/0.5),0_0_0_2px_rgb(0_0_0/0.4)]" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
        {thirds ? <ThirdsGrid opacity={0.18} /> : null}
      </div>
    </div>
  );
}

/** The Set tab's window onto the shot: the stage draws the picture underneath (one WebGL canvas). */
function PreviewWindow({ pip, small = false }: { pip: { x: number; y: number; w: number; h: number }; small?: boolean }) {
  if (small) {
    // A phone: a tap looks through the Camera; no label or close button on a window this size.
    return (
      <button
        type="button"
        title="Look through the Camera"
        onClick={() => useStageView.setState({ scout: false })}
        className="absolute z-20 rounded-[9px] shadow-[0_0_0_1.5px_rgb(255_91_46/0.9),0_0_0_3px_rgb(0_0_0/0.45)]"
        style={{ left: pip.x, top: pip.y, width: pip.w, height: pip.h }}
      />
    );
  }
  return (
    <div className="absolute z-20" style={{ left: pip.x, top: pip.y, width: pip.w, height: pip.h }}>
      <button
        type="button"
        title="Look through the Camera"
        onClick={() => useStageView.setState({ scout: false })}
        className="absolute inset-0 rounded-[10px] shadow-[0_0_0_1.5px_rgb(255_91_46/0.9),0_0_0_3px_rgb(0_0_0/0.45)] hover:shadow-[0_0_0_2px_rgb(255_91_46),0_0_0_3.5px_rgb(0_0_0/0.45)]"
      />
      <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-paper/90">The shot</span>
      <button
        type="button"
        title="Hide the shot"
        onClick={() => useStageView.setState({ preview: false })}
        className="press absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-black/60 text-paper/80 hover:text-paper"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- top: tabs, line, output ------------------------------ */

function Tabs({ compact = false }: { compact?: boolean }) {
  const scout = useStageView((s) => s.scout);
  return (
    <div role="tablist" aria-label="View" className="squircle flex rounded-[13px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
      <TabButton compact={compact} active={scout} onClick={() => useStageView.setState({ scout: true, model: false })} title="Walk around the set and place people (Tab). Looking around here never changes the shot.">
        <Move3d size={15} /> Set
      </TabButton>
      <TabButton compact={compact} active={!scout} onClick={() => useStageView.setState({ scout: false })} title="Look through the Camera (Tab): moving here moves the Camera">
        <Camera size={15} /> Camera
      </TabButton>
    </div>
  );
}

function TabButton({ active, compact = false, onClick, title, children }: { active: boolean; compact?: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={cn(
        "press inline-flex h-8 items-center justify-center gap-1.5 rounded-[10px] text-[13px] font-semibold transition-colors",
        compact ? "px-2.5" : "w-[100px]",
        active ? "bg-white/[0.14] text-paper" : "text-fog hover:text-paper",
      )}
    >
      {children}
    </button>
  );
}

/** One line: what happened, what's loading, or the next step. */
function StatusLine({ phone = false }: { phone?: boolean }) {
  const { text, kind, id } = useNotice();
  const hint = useNextStep(phone);
  const shown = text ?? hint;
  const k = text ? kind : "info";
  return (
    <AnimatePresence mode="wait">
      {shown ? (
        <motion.div
          key={text ? `n${id}` : `h${hint}`}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          title={shown}
          className="pointer-events-none flex min-w-0 max-w-full items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-[12.5px] font-medium text-paper/90 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]"
        >
          {k === "busy" ? (
            <LoaderCircle size={12} className="shrink-0 animate-spin" />
          ) : (
            <span className={cn("size-1.5 shrink-0 rounded-full", k === "done" ? "bg-[#c6e27a]" : k === "warn" ? "bg-[#e8cf74]" : k === "stop" ? "bg-[#f37159]" : "bg-white/50")} />
          )}
          <span className="truncate">{shown}</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** The next step, while there's one to take (a phone has no keys to press or photos to drop). */
function useNextStep(phone = false) {
  const video = useVideoMode();
  const keyed = useDirector((s) => hasKeys(s.scene.timeline));
  const hasPlace = useDirector((s) => Boolean(s.scene.place.image));
  const cast = useDirector((s) => s.scene.elements.length);
  const scout = useStageView((s) => s.scout);
  const takes = useTakesSummary();
  if (!hasPlace && !cast) return null;
  // Video mode: a path for the camera, then Film it.
  if (video) return keyed ? null : phone ? "Pick a move, or key the Camera, then Film" : "Pick a move, or key the Camera on the timeline, then Film it";
  if (!cast && !phone) return "Add someone: drop their photo here";
  if (scout) return phone ? "Find an angle, then Camera here" : "Find your angle, then press C";
  if (!takes.count) return phone ? "Frame it with your fingers, then Shoot" : "Frame it, then Shoot";
  return null;
}

/** What you'll get, and your takes. `phone`: the frame's shape alone (its size is on the words bar there). */
function OutputChip({ compact, phone = false }: { compact: boolean; phone?: boolean }) {
  const aspect = useDirector((s) => s.scene.aspect);
  const size = useShotSize((s) => s.size);
  const chosen = useDirectorShot((s) => s.model);
  const models = useModelsStore((s) => s.models);
  const model = shotModelOf(chosen, models);
  const name = model === "auto" ? "no model yet" : (models.find((m) => m.id === model)?.name ?? "Qwen-Image 2.1").replace(/\s*\(.*\)\s*$/, "");
  const scout = useStageView((s) => s.scout);
  const preview = useStageView((s) => s.preview);
  // The frame's shape is picked here, where the frame is described (the winner's "Frame 16:9 ▾"): the Shot tab with
  // its rows of buttons is gone.
  const [framing, setFraming] = useState(false);
  const video = useVideoMode();
  if (video)
    return (
      <div className="flex items-center gap-2">
        <div
          title={`Film it films the video again: ${aspect}, along your Camera path`}
          className="flex h-10 items-center gap-2 rounded-[12px] bg-black/55 px-3 text-[12.5px] font-medium text-fog shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
        >
          {phone ? null : <Clapperboard size={14} className="text-spike" />}
          {phone ? null : <span className="text-paper">Video</span>}
          <span className="tabular">{aspect}</span>
        </div>
        {phone ? null : <TakesButton compact={compact} />}
      </div>
    );
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex h-10 items-center gap-2 rounded-[12px] bg-black/55 px-1 text-[12.5px] font-medium text-fog shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        <button
          type="button"
          onClick={() => setFraming((f) => !f)}
          aria-expanded={framing}
          title={`Shoot makes a still: ${aspect}, ${size.toUpperCase()}, with ${name}. Click to change the frame.`}
          className={cn("press flex h-8 items-center rounded-[9px] hover:bg-white/[0.06]", phone ? "gap-1 px-1.5" : "gap-2 px-2")}
        >
          {phone ? null : <Camera size={14} className="text-spike" />}
          {phone ? null : <span className="text-paper">Still</span>}
          <span className={cn("tabular", phone && "text-paper")}>{aspect}</span>
          {phone ? null : <span className="tabular">{size.toUpperCase()}</span>}
          {compact ? null : <span className="max-w-[130px] truncate text-haze">{name}</span>}
          <ChevronDown size={13} className={cn("text-haze transition-transform", framing && "rotate-180")} />
        </button>
        {scout && !preview && !phone ? (
          <button type="button" onClick={() => useStageView.setState({ preview: true })} className="press mr-1 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11.5px] font-semibold text-paper hover:bg-white/[0.14]">
            Show
          </button>
        ) : null}
        <AnimatePresence>
          {framing ? <FramePicker close={() => setFraming(false)} /> : null}
        </AnimatePresence>
      </div>
      {/* A phone has its takes at the bottom left, where a camera app keeps its photos. */}
      {phone ? null : <TakesButton compact={compact} />}
    </div>
  );
}

/** Your takes: how many, the one being made (and how far along), a dot for one you haven't seen. */
function TakesButton({ compact }: { compact: boolean }) {
  const takes = useTakesSummary();
  return (
    <button
      type="button"
      onClick={openLibrary}
      title="Your takes"
      aria-label="Your takes"
      className={cn(
        "press pointer-events-auto relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] bg-black/55 text-[12.5px] font-semibold text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-black/70",
        compact ? "px-2.5" : "px-3",
      )}
    >
      {takes.live ? <LoaderCircle size={14} className="animate-spin text-spike" /> : <Images size={14} />}
      {compact ? null : "Takes"}
      {takes.live ? <span className="tabular text-[11.5px] text-spike">{Math.round(takes.progress * 100)}%</span> : takes.count ? <span className="tabular text-haze">{takes.count}</span> : null}
      {takes.fresh && !takes.live ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-spike" /> : null}
    </button>
  );
}

/** The frame's shape: what the Camera shoots and the stage frames. Closes on a pick, a click outside or Esc. */
function FramePicker({ close }: { close: () => void }) {
  const aspect = useDirector((s) => s.scene.aspect);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.parentElement?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [close]);
  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      className="absolute right-0 top-12 z-40 w-[300px] rounded-[14px] bg-[#16171a]/95 p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]"
    >
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">Frame</p>
      <div className="grid grid-cols-4 gap-1.5">
        {ASPECTS.map((a) => {
          const selected = aspect === a.id;
          const max = 26;
          const w = a.w >= a.h ? max : (max * a.w) / a.h;
          const h = a.h >= a.w ? max : (max * a.h) / a.w;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                useDirector.getState().setScene({ aspect: a.id });
                close();
              }}
              aria-pressed={selected}
              title={a.label}
              className={cn(
                "press flex flex-col items-center gap-1.5 rounded-[10px] py-2.5 text-[11.5px] font-semibold",
                selected ? "bg-white/[0.07] text-spike shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "text-fog hover:bg-white/[0.04]",
              )}
            >
              <span className="grid h-7 place-items-center">
                <span className="rounded-[3px] border-2 border-current" style={{ width: w, height: h }} />
              </span>
              {a.id}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ phone ------------------------------------------ */

/** A phone's glass button over the stage. */
function GlassButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "press pointer-events-auto grid size-10 shrink-0 place-items-center rounded-[12px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-colors",
        active ? "bg-white/[0.18] text-paper" : "bg-black/55 text-paper/90 hover:bg-black/70",
      )}
    >
      {children}
    </button>
  );
}

/** A phone's top row: Crackio's menu, the two tabs, the frame's shape, and the sheet with everything else. */
function PhoneTop({ empty, onSheet }: { empty: boolean; onSheet: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 px-2" style={{ height: PHONE_TOP }}>
      <GlassButton label="Menu" onClick={() => useShell.getState().setMobileOpen(true)}>
        <Menu size={18} />
      </GlassButton>
      {empty ? null : (
        <div className="pointer-events-auto">
          <Tabs compact />
        </div>
      )}
      <div className="min-w-0 flex-1" />
      {empty ? null : (
        <div className="pointer-events-auto">
          <OutputChip compact phone />
        </div>
      )}
      {empty ? null : (
        <GlassButton label="Cast, place and tools" onClick={onSheet}>
          <Ellipsis size={18} />
        </GlassButton>
      )}
    </div>
  );
}

/**
 * A phone's bottom: the words and Shoot, with your takes and undo on the left and Film it, the lens and Home on the
 * right. Upright those sit in a row above the words; sideways all of it is one row. Moving is done on the stage itself:
 * one finger swings round, two fingers pinch closer or slide.
 */
function PhoneBottom({ phone, empty }: { phone: "portrait" | "landscape"; empty: boolean }) {
  const canUndo = useDirector((s) => s.past.length > 0);
  const canRedo = useDirector((s) => s.future.length > 0);
  const video = useVideoMode();
  const bar = <div className="pointer-events-auto min-w-0 flex-1">{video ? <VideoBar phone /> : <PromptBar lean phone={phone} />}</div>;
  const left = empty ? null : (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
      <TakesButton compact />
      <div className="flex items-center gap-0.5 rounded-[14px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        <RailButton label="Undo" onClick={() => useDirector.getState().undo()} disabled={!canUndo} why="Nothing to undo">
          <Undo2 size={17} />
        </RailButton>
        <RailButton label="Redo" onClick={() => useDirector.getState().redo()} disabled={!canRedo} why="Nothing to redo">
          <Redo2 size={17} />
        </RailButton>
      </div>
    </div>
  );
  const right = empty ? null : (
    <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-[14px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
      {video ? null : <FilmIt compact />}
      <LensChip />
      <RailButton label="Back to the start" onClick={() => nav.home()}>
        <House size={16} />
      </RailButton>
    </div>
  );
  if (phone === "landscape") {
    return (
      <div className="flex items-end gap-2">
        {left}
        {bar}
        {right}
      </div>
    );
  }
  return (
    <>
      {empty ? null : (
        <div className="flex items-end justify-between gap-2">
          {left}
          {right}
        </div>
      )}
      <div className="flex">{bar}</div>
    </>
  );
}

/** In the Set tab on a phone, under the window onto the shot: the Camera takes the view you found. */
function CameraHere({ top }: { top: number }) {
  return (
    <button
      type="button"
      onClick={() => nav.cameraToView()}
      className="press absolute right-2.5 z-20 inline-flex h-9 items-center gap-1.5 rounded-[11px] bg-black/60 px-2.5 text-[12.5px] font-semibold text-spike shadow-[inset_0_0_0_1px_rgb(255_91_46/0.45)]"
      style={{ top }}
    >
      <Focus size={15} /> Camera here
    </button>
  );
}

/**
 * Everything a phone doesn't keep on screen, in one sheet: who's on set and the place (Cast & place), and the few tools
 * (add someone, another place, the model's view, the grid, how a drag moves, clearing the set). From the bottom when
 * the phone is upright, from the right when it's sideways.
 */
function PhoneSheet({
  open,
  onClose,
  landscape,
  thirds,
  setThirds,
}: {
  open: boolean;
  onClose: () => void;
  landscape: boolean;
  thirds: boolean;
  setThirds: (f: (v: boolean) => boolean) => void;
}) {
  const scout = useStageView((s) => s.scout);
  const model = useStageView((s) => s.model);
  const hasWorld = useDirector((s) => Boolean(s.scene.place.world));
  const cast = useDirector((s) => s.scene.elements.length);
  const scheme = useFeel((s) => s.scheme);
  const video = useVideoMode();
  const castInput = useRef<HTMLInputElement>(null);
  const placeInput = useRef<HTMLInputElement>(null);
  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div key="shade" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-40 bg-black/45" onClick={onClose} />
          <motion.aside
            key="sheet"
            role="dialog"
            aria-label="Cast, place and tools"
            initial={landscape ? { x: "100%" } : { y: "100%" }}
            animate={landscape ? { x: 0 } : { y: 0 }}
            exit={landscape ? { x: "100%" } : { y: "100%" }}
            transition={{ type: "spring", damping: 34, stiffness: 340 }}
            className={cn(
              "absolute z-50 flex flex-col overflow-hidden bg-[#141518] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_-20px_60px_rgb(0_0_0/0.5)]",
              landscape ? "inset-y-0 right-0 w-[min(380px,62vw)] rounded-l-[20px]" : "inset-x-0 bottom-0 max-h-[82%] rounded-t-[22px] pb-[env(safe-area-inset-bottom)]",
            )}
          >
            {landscape ? null : <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-white/20" />}
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-2.5">
              <p className="text-[15px] font-semibold text-paper">{video ? "Video" : <>Cast & place{cast ? <span className="text-haze"> · {cast}</span> : null}</>}</p>
              <button type="button" onClick={onClose} aria-label="Close" className="press grid size-9 place-items-center rounded-full bg-white/[0.06] text-fog hover:text-paper">
                <X size={16} />
              </button>
            </div>
            <div className="grid shrink-0 grid-cols-4 gap-1.5 px-3 pb-3">
              {video ? null : (
                <SheetAction label="Someone" onClick={() => castInput.current?.click()}>
                  <UserPlus size={18} />
                </SheetAction>
              )}
              <SheetAction label="New place" onClick={() => placeInput.current?.click()}>
                <ImagePlus size={18} />
              </SheetAction>
              <SheetAction label="Model view" active={model} onClick={() => useStageView.setState({ model: !model })}>
                <PersonStanding size={18} />
              </SheetAction>
              {scout ? null : (
                <SheetAction label="Grid" active={thirds} onClick={() => setThirds((v) => !v)}>
                  <Grid3x3 size={18} />
                </SheetAction>
              )}
              {!scout && hasWorld ? (
                <SheetAction
                  label="Fix a spot"
                  onClick={() => {
                    useFixSpot.setState({ open: true });
                    onClose();
                  }}
                >
                  <Wand2 size={18} />
                </SheetAction>
              ) : null}
              <SheetAction label={scheme === "orbit" ? "Drag circles" : "Drag turns"} onClick={() => useFeel.setState({ scheme: scheme === "orbit" ? "look" : "orbit" })}>
                {scheme === "orbit" ? <RotateCw size={18} /> : <Eye size={18} />}
              </SheetAction>
              <SheetAction
                label="Clear set"
                onClick={() => {
                  if (!window.confirm("Clear the set? Undo brings it back.")) return;
                  useDirector.getState().reset();
                  onClose();
                }}
              >
                <Trash2 size={18} />
              </SheetAction>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06]">{video ? <VideoPanel /> : <ScenePanel />}</div>
            <input
              ref={castInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void addFilesToCast(Array.from(e.target.files ?? []));
                e.target.value = "";
                onClose();
              }}
            />
            <input
              ref={placeInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void setPlaceFile(f);
                e.target.value = "";
                onClose();
              }}
            />
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function SheetAction({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "press flex flex-col items-center gap-1 rounded-[12px] py-2.5 text-[11.5px] font-semibold transition-colors",
        active ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_91_46/0.55)]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
      )}
    >
      {children}
      <span className="max-w-full truncate px-1">{label}</span>
    </button>
  );
}

/** Once, upright with a set: holding the phone sideways gives the stage the whole screen's width. */
const TURN_HINT = "crackio.director.turn-hint";

function TurnHint() {
  const [show, setShow] = useState(() => {
    try {
      return !localStorage.getItem(TURN_HINT);
    } catch {
      return true; // Private browsing: shown each visit then.
    }
  });
  useEffect(() => {
    if (!show) return;
    try {
      localStorage.setItem(TURN_HINT, "1");
    } catch {
      // As above.
    }
    const t = setTimeout(() => setShow(false), 7000);
    return () => clearTimeout(t);
  }, [show]);
  return (
    <AnimatePresence>
      {show ? (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          onClick={() => setShow(false)}
          className="absolute left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-black/75 px-3.5 py-2 text-[12.5px] font-medium text-paper/90 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]"
          style={{ top: PHONE_TOP + 44 }}
        >
          <Smartphone size={14} className="rotate-90 text-spike" />
          Turn your phone sideways for a bigger stage
        </motion.button>
      ) : null}
    </AnimatePresence>
  );
}

/* --------------------------------------------------------------- left: actions ------------------------------------- */

function ToolRail({ thirds, setThirds }: { thirds: boolean; setThirds: (f: (v: boolean) => boolean) => void }) {
  const scout = useStageView((s) => s.scout);
  const model = useStageView((s) => s.model);
  const canUndo = useDirector((s) => s.past.length > 0);
  const canRedo = useDirector((s) => s.future.length > 0);
  const hasWorld = useDirector((s) => Boolean(s.scene.place.world));
  const fixOpen = useFixSpot((s) => s.open);
  const video = useVideoMode();
  const castInput = useRef<HTMLInputElement>(null);
  const placeInput = useRef<HTMLInputElement>(null);
  return (
    <div className="absolute left-3 z-20 flex flex-col gap-1.5" style={{ top: TOP }}>
      <RailGroup>
        <RailButton label="Undo (Ctrl+Z)" onClick={() => useDirector.getState().undo()} disabled={!canUndo} why="Nothing to undo">
          <Undo2 size={17} />
        </RailButton>
        <RailButton label="Redo (Ctrl+Shift+Z)" onClick={() => useDirector.getState().redo()} disabled={!canRedo} why="Nothing to redo">
          <Redo2 size={17} />
        </RailButton>
      </RailGroup>
      <RailGroup>
        {scout ? (
          <RailButton label="Camera to view (C): the Camera takes this view" onClick={() => nav.cameraToView()} accent>
            <Focus size={17} />
          </RailButton>
        ) : null}
        {!scout && hasWorld ? (
          <RailButton label="Fix this spot: change what the Camera sees of the place" onClick={() => useFixSpot.setState((f) => ({ open: !f.open }))} active={fixOpen}>
            <Wand2 size={17} />
          </RailButton>
        ) : null}
        {video ? null : (
          <RailButton label="Add people or things (from photos)" onClick={() => castInput.current?.click()}>
            <UserPlus size={17} />
          </RailButton>
        )}
        <RailButton label="Another place, from a photo" onClick={() => placeInput.current?.click()}>
          <ImagePlus size={17} />
        </RailButton>
      </RailGroup>
      <RailGroup>
        <RailButton label={model ? "Back to the picture" : "What the image model sees: stand-ins, unknown parts in gray"} onClick={() => useStageView.setState({ model: !model })} active={model}>
          <PersonStanding size={17} />
        </RailButton>
        {!scout ? (
          <RailButton label="Rule-of-thirds grid" onClick={() => setThirds((v) => !v)} active={thirds}>
            <Grid3x3 size={17} />
          </RailButton>
        ) : null}
        <RailButton
          label="Clear the set"
          onClick={() => {
            if (window.confirm("Clear the set? Undo brings it back.")) useDirector.getState().reset();
          }}
        >
          <Trash2 size={17} />
        </RailButton>
      </RailGroup>
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
    </div>
  );
}

function RailGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-0.5 rounded-[14px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]", className)}>{children}</div>;
}

function RailButton({ label, onClick, disabled, why, active, accent, children }: { label: string; onClick: () => void; disabled?: boolean; why?: string; active?: boolean; accent?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled && why ? `${label} · ${why}` : label}
      aria-label={label}
      className={cn(
        "press grid size-9 place-items-center rounded-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-35",
        active ? "bg-white/[0.16] text-paper" : accent ? "text-spike hover:bg-spike/15" : "text-paper/85 hover:bg-white/[0.08] hover:text-paper",
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- bottom right: how you move ------------------------ */

/**
 * Moving the view, all in one corner: the drag buttons (a trackpad or a one-button mouse can do everything with them),
 * the lens, frame, home, every key, and the feel (how drag works, how the place is drawn) with what each one does.
 */
function ViewButtons({ awake }: { awake: boolean }) {
  const scout = useStageView((s) => s.scout);
  const scheme = useFeel((s) => s.scheme);
  return (
    <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5">
      <div className={cn("flex items-center gap-0.5 rounded-[14px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-opacity duration-300", awake ? "opacity-100" : "opacity-0 hover:opacity-100")}>
        <Knob op="orbit" label={`Swing round what you look at · ${scheme === "orbit" ? "drag" : "Alt-drag"}`}>
          <RotateCw size={16} />
        </Knob>
        <Knob op="look" label={`Turn your head · ${scheme === "look" ? "drag" : "Alt-drag"}`}>
          <Eye size={16} />
        </Knob>
        <Knob op="pan" label="Slide · right-drag">
          <Hand size={16} />
        </Knob>
      </div>
      <div className="flex items-center gap-0.5 rounded-[14px] bg-black/55 p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        <LensChip />
        <RailButton label="Frame who's picked, or everyone (F)" onClick={() => nav.frame()}>
          <Box size={16} />
        </RailButton>
        <RailButton label={scout ? "Back to the start (Home)" : "Camera back to the start (Home)"} onClick={() => nav.home()}>
          <House size={16} />
        </RailButton>
        <FeelButton />
        <ShortcutsButton />
      </div>
    </div>
  );
}

/** The lens: drag it sideways (your view's degrees in the Set tab, never the shot; the Camera's mm in the Camera tab). */
function LensChip() {
  const scout = useStageView((s) => s.scout);
  const focal = useDirector((s) => s.scene.camera.focal);
  const [, force] = useState(0);
  // Your eyes' lens isn't React state: read it a few times a second while the Set tab shows.
  useEffect(() => {
    if (!scout) return;
    const t = setInterval(() => force((n) => n + 1), 300);
    return () => clearInterval(t);
  }, [scout]);
  const value = scout ? nav.lensValue() : focal;
  const drag = useRef<{ x: number } | null>(null);
  return (
    <button
      type="button"
      title={scout ? "Your view's lens: drag, or Alt+wheel / pinch. Never changes the shot." : "The Camera's lens: drag, or Alt+wheel / pinch"}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX };
        e.currentTarget.setPointerCapture(e.pointerId);
        if (!scout) {
          useDirector.getState().checkpoint();
          walking.active = true;
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const steps = (e.clientX - d.x) / 6;
        if (Math.abs(steps) >= 1) {
          nav.lens(Math.trunc(steps));
          d.x = e.clientX;
          force((n) => n + 1);
        }
      }}
      onPointerUp={() => {
        drag.current = null;
        walking.active = false;
      }}
      onPointerCancel={() => {
        drag.current = null;
        walking.active = false;
      }}
      className="tabular h-8 w-[64px] shrink-0 cursor-ew-resize touch-none rounded-[10px] text-[12.5px] font-semibold text-paper hover:bg-white/[0.08]"
    >
      {scout ? `${Math.round(value)}°` : `${Math.round(value)} mm`}
    </button>
  );
}

function Knob({ op, label, children }: { op: "orbit" | "look" | "pan"; label: string; children: ReactNode }) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const [on, setOn] = useState(false);
  const end = () => {
    last.current = null;
    setOn(false);
    nav.end();
  };
  return (
    <button
      type="button"
      title={`${label} (or drag this button)`}
      aria-label={label}
      onPointerDown={(e) => {
        last.current = { x: e.clientX, y: e.clientY };
        setOn(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const l = last.current;
        if (!l) return;
        nav.drag(op, e.clientX - l.x, e.clientY - l.y);
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className={cn("grid size-8 cursor-grab touch-none place-items-center rounded-[10px] transition-colors active:cursor-grabbing", on ? "bg-white/[0.18] text-paper" : "text-paper/85 hover:bg-white/[0.08]")}
    >
      {children}
    </button>
  );
}

/** How the camera moves and how the place is drawn: each choice says what it does. */
function FeelButton() {
  const [open, setOpen] = useState(false);
  const { scheme, place } = useFeel();
  return (
    <div className="relative">
      <RailButton label="How moving feels, and how the place is drawn" onClick={() => setOpen((o) => !o)} active={open}>
        <SlidersHorizontal size={16} />
      </RailButton>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-12 right-0 w-[330px] space-y-3 rounded-[14px] bg-[#16171a]/95 p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]"
          >
            <section>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">When you drag</p>
              <Choice<Scheme>
                value={scheme}
                onChange={(v) => useFeel.setState({ scheme: v })}
                items={[
                  { value: "orbit", title: "Circle round", text: "Drag moves around what you look at, like turning a model in your hand. Best for framing people." },
                  { value: "look", title: "Turn your head", text: "Drag turns your view on the spot, like Street View. Best for looking around a place." },
                ]}
              />
              <p className="mt-1.5 text-[11.5px] text-haze">Alt-drag always does the other one. Right-drag slides.</p>
            </section>
            <section>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">The place</p>
              <Choice<PlaceLook>
                value={place}
                onChange={(v) => useFeel.setState({ place: v })}
                items={[
                  { value: "3d", title: "3D", text: "Your photo in depth: what's in it stands apart from what's behind, so you can move round it. Gaps are filled when you shoot." },
                  { value: "floor", title: "Picture on a floor", text: "The place all around, flat, its ground laid on the floor. Steady from anywhere, no depth." },
                  { value: "picture", title: "Picture only", text: "Just the 360 picture, far away. Never moves, never bends." },
                ]}
              />
            </section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Choice<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; title: string; text: string }[] }) {
  return (
    <div className="space-y-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cn(
            "press flex w-full items-start gap-2 rounded-[10px] px-2.5 py-2 text-left transition-colors",
            value === it.value ? "bg-white/[0.1] shadow-[inset_0_0_0_1px_rgb(255_91_46/0.6)]" : "hover:bg-white/[0.05]",
          )}
        >
          <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", value === it.value ? "bg-spike text-spike-ink" : "shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.3)]")}>
            {value === it.value ? <Check size={11} strokeWidth={3} /> : null}
          </span>
          <span>
            <span className="block text-[13px] font-semibold text-paper">{it.title}</span>
            <span className="block text-[12px] leading-snug text-fog">{it.text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

const SHORTCUTS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Moving",
    rows: [
      ["Drag", "Circle round (or turn your head: see the sliders button)"],
      ["Alt-drag · middle-drag", "The other one"],
      ["Right-drag", "Slide"],
      ["Wheel · two fingers", "Move toward the pointer"],
      ["Alt+wheel · pinch", "Lens: zoom without moving"],
      ["W A S D · Q E", "Walk · down and up (Shift: faster)"],
      ["Arrows", "Turn (with nobody picked)"],
      ["Double-click", "Look at that spot"],
      ["F · Home", "Frame who's picked · back to the start"],
    ],
  },
  {
    title: "Shot",
    rows: [
      ["Tab", "Set ↔ Camera"],
      ["C", "Camera to view (Set tab)"],
      ["Enter", "Shoot (in the words box)"],
    ],
  },
  {
    title: "Someone picked",
    rows: [
      ["Drag them (Set tab)", "Place them"],
      ["Arrows", "Nudge (Shift: farther)"],
      ["Delete · Esc", "Off the set · let go"],
    ],
  },
  { title: "Anywhere", rows: [["Ctrl Z · Ctrl Shift Z", "Undo · Redo"]] },
];

function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <RailButton label="Every key and mouse move" onClick={() => setOpen((o) => !o)} active={open}>
        <Keyboard size={16} />
      </RailButton>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-12 right-0 w-[380px] space-y-3 rounded-[14px] bg-[#16171a]/95 p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]"
          >
            {SHORTCUTS.map((g) => (
              <section key={g.title}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">{g.title}</p>
                <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
                  {g.rows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt>
                        <kbd className="inline-flex rounded-[6px] bg-white/[0.08] px-1.5 py-0.5 font-mono text-[11px] text-paper">{k}</kbd>
                      </dt>
                      <dd className="text-[12px] text-fog">{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* --------------------------------------------------------------- bottom center: who's picked ---------------------- */

function SelectionBar({ phone = false }: { phone?: boolean }) {
  const el = useDirector((s) => s.scene.elements.find((e) => e.id === s.selectedId));
  const camYaw = useDirector((s) => s.scene.camera.azimuth);
  if (!el) return null;
  const turn = (yaw: number) => useDirector.getState().updateElement(el.id, { yaw: Math.round(((yaw % 360) + 540) % 360) - 180 });
  return (
    <div
      className={cn(
        "z-20 flex items-center gap-1 rounded-[14px] bg-black/65 p-1 pl-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        // A phone: in the column floating along the bottom, scrolling sideways when it's wider than the phone.
        phone ? "pointer-events-auto mx-auto max-w-full overflow-x-auto [scrollbar-width:none]" : "absolute bottom-3 left-1/2 -translate-x-1/2",
      )}
    >
      <span className={cn("shrink-0 truncate text-[13px] font-semibold text-paper", phone ? "max-w-[96px]" : "w-[110px]")} title={el.name}>
        {el.name}
      </span>
      <span className="mx-1 text-[11.5px] text-haze">Faces</span>
      {(
        [
          ["Camera", camYaw],
          ["Away", camYaw + 180],
          ["Left", camYaw - 90],
          ["Right", camYaw + 90],
        ] as const
      ).map(([label, yaw]) => (
        <button key={label} type="button" onClick={() => turn(yaw)} className="press h-8 rounded-[9px] px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.08] hover:text-paper">
          {label}
        </button>
      ))}
      <button type="button" title="Take them off the set (Delete)" onClick={() => useDirector.getState().removeElement(el.id)} className="press ml-1 grid size-8 place-items-center rounded-[9px] text-fog hover:bg-white/[0.08] hover:text-tally">
        <Trash2 size={15} />
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- Camera tab rulers --------------------------------- */

/** The Camera's lens (left), height (right) and tilt (below), on the frame's edges: drag the scale. */
function Rulers({ frame }: { frame: { x: number; y: number; w: number; h: number } }) {
  const focal = useDirector((s) => s.scene.camera.focal);
  const roll = useDirector((s) => s.scene.camera.roll);
  const height = useDirector((s) => cameraHeight(s.scene.camera));
  const h = Math.min(220, frame.h * 0.6);
  return (
    <>
      <Ruler
        vertical
        label="Lens"
        value={`${Math.round(focal)} mm`}
        style={{ left: frame.x - 56, top: frame.y + (frame.h - h) / 2, height: h }}
        offset={Math.log(focal) * 60}
        onDrag={(d, shift) => {
          const f = useDirector.getState().scene.camera.focal;
          useDirector.getState().setCamera({ focal: Math.round(MathUtils.clamp(f * Math.pow(1.006, -d * (shift ? 0.25 : 1)), FEEL.focalMin, FEEL.focalMax) * 10) / 10 }, true);
        }}
        onReset={() => useDirector.getState().setCamera({ focal: 35 })}
      />
      <Ruler
        vertical
        label="Height"
        value={`${height.toFixed(2)} m`}
        style={{ left: frame.x + frame.w + 10, top: frame.y + (frame.h - h) / 2, height: h }}
        offset={height * 40}
        onDrag={(d, shift) => {
          const cam = useDirector.getState().scene.camera;
          const k = 0.006 * Math.max(0.6, cam.distance * 0.35) * (shift ? 0.25 : 1);
          useDirector.getState().setCamera(pedestalTo(cam, cameraHeight(cam) - d * k), true);
        }}
        onReset={() => {
          const cam = useDirector.getState().scene.camera;
          useDirector.getState().setCamera(pedestalTo(cam, 1.6));
        }}
      />
      <Ruler
        label="Tilt"
        value={`${Math.round(roll)}°`}
        style={{ left: frame.x + (frame.w - Math.min(260, frame.w * 0.5)) / 2, top: frame.y + frame.h + 12, width: Math.min(260, frame.w * 0.5) }}
        offset={roll * 8}
        onDrag={(d, shift) => {
          const r = useDirector.getState().scene.camera.roll + d * 0.125;
          useDirector.getState().setCamera({ roll: shift ? Math.round(r / 15) * 15 : Math.round(MathUtils.clamp(r, -45, 45) * 10) / 10 }, true);
        }}
        onReset={() => useDirector.getState().setCamera({ roll: 0 })}
      />
    </>
  );
}

function Ruler({
  vertical,
  label,
  value,
  style,
  offset,
  onDrag,
  onReset,
}: {
  vertical?: boolean;
  label: string;
  value: string;
  style: React.CSSProperties;
  offset: number;
  onDrag: (delta: number, shift: boolean) => void;
  onReset: () => void;
}) {
  const last = useRef<number | null>(null);
  const ticks = vertical
    ? "repeating-linear-gradient(to bottom, rgb(255 255 255/0.5) 0 1px, transparent 1px 8px)"
    : "repeating-linear-gradient(to right, rgb(255 255 255/0.5) 0 1px, transparent 1px 8px)";
  return (
    <div className={cn("group absolute z-20 flex select-none items-center gap-1.5", vertical ? "w-[46px] flex-col" : "h-9 flex-row")} style={style} title={`${label}: drag the scale (Shift: finer) · double-click: back to normal`}>
      <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-haze">{label}</span>
      <div
        className={cn("relative min-h-0 min-w-0 flex-1 cursor-grab touch-none overflow-hidden rounded-[8px] bg-black/45 active:cursor-grabbing", vertical ? "w-7" : "h-7")}
        style={{ backgroundImage: ticks, backgroundPosition: vertical ? `0 ${offset}px` : `${offset}px 0` }}
        onPointerDown={(e) => {
          last.current = vertical ? e.clientY : e.clientX;
          e.currentTarget.setPointerCapture(e.pointerId);
          useDirector.getState().checkpoint();
          walking.active = true;
        }}
        onPointerMove={(e) => {
          if (last.current === null) return;
          const p = vertical ? e.clientY : e.clientX;
          onDrag(p - last.current, e.shiftKey);
          last.current = p;
        }}
        onPointerUp={() => {
          last.current = null;
          walking.active = false;
        }}
        onDoubleClick={onReset}
      >
        <span className={cn("absolute bg-spike", vertical ? "inset-x-0 top-1/2 h-[2px] -translate-y-1/2" : "inset-y-0 left-1/2 w-[2px] -translate-x-1/2")} />
      </div>
      <span className="tabular shrink-0 whitespace-nowrap rounded-md bg-black/55 px-1 text-[11px] font-semibold text-paper">{value}</span>
    </div>
  );
}

/* --------------------------------------------------------------- right panel --------------------------------------- */

/**
 * The place and who's in it, nothing else. The shot's rows of buttons (shot size, angle, lens, focus, key light, mood,
 * style) are gone: the camera is framed on the stage itself, and anything else is said in words (light, for one, is
 * typed in the prompt, not set with a button). The frame's shape is on the Still chip.
 */
function SidePanel() {
  const cast = useDirector((s) => s.scene.elements.length);
  const video = useVideoMode();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center border-b border-white/[0.06] px-4">
        <p className="text-[13px] font-semibold text-paper">{video ? "Video" : <>Cast & place{cast ? <span className="text-haze"> · {cast}</span> : null}</>}</p>
      </div>
      <div className="min-h-0 flex-1">{video ? <VideoPanel /> : <ScenePanel />}</div>
    </div>
  );
}

/* --------------------------------------------------------------- behaviour --------------------------------------- */

/**
 * The GPU kept ready while you work here, when Run on is RunPod Serverless (api/serverless/warm; nothing on your own GPU).
 * RunPod stops its GPU a minute after the last job, and the next shot waited for a new one and for its models to load:
 * 2–4 minutes where a ready one takes about 35 s (Nov 13). So while you act here (a click, a drag, a key or the wheel in
 * the last 30 s, the page in view) it isn't let stop, and a new place gets the shot's models loaded while you frame it
 * (its 3D shape is measured on the same GPU first). It costs the GPU's time while you work: the last ping goes 30 s after
 * your last move and RunPod's idle minute runs from there, so it stops about 1.5 minutes after (3–4 before Nov 14, longer
 * than you need).
 */
const KEEP_AFTER_MS = 30_000;
function useKeepGpuWarm() {
  // A video place films with LTX, not the shot's models: nothing is loaded ahead for it (the GPU is still kept ready).
  const placed = useDirector((s) => (s.scene.place.image?.view && !s.scene.place.video ? s.scene.place.image.url : ""));
  const lastAct = useRef(0);
  const loadFor = useRef<string | null>(null);
  useEffect(() => {
    const ask = (load: boolean) =>
      void fetch("/api/serverless/warm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(load ? { load: "director" } : {}) }).catch(() => undefined);
    let last: ReturnType<typeof setTimeout> | undefined;
    const act = () => {
      const quiet = Date.now() - lastAct.current > 25_000;
      lastAct.current = Date.now();
      // A place waiting for its models (opened, or just made) loads them on your first move; else a quiet spell ends.
      if (loadFor.current) {
        loadFor.current = null;
        ask(true);
      } else if (quiet && !document.hidden) ask(false);
      // The last ping, KEEP_AFTER_MS after your last move (the ticks fall anywhere in it), so the stop is always ~1.5 min.
      clearTimeout(last);
      last = setTimeout(() => {
        if (!document.hidden) ask(false);
      }, KEEP_AFTER_MS);
    };
    const events = ["pointerdown", "keydown", "wheel", "drop"] as const;
    for (const e of events) window.addEventListener(e, act, { passive: true, capture: true });
    const tick = setInterval(() => {
      if (!document.hidden && Date.now() - lastAct.current < KEEP_AFTER_MS) ask(false);
    }, 25_000);
    return () => {
      for (const e of events) window.removeEventListener(e, act, { capture: true });
      clearInterval(tick);
      clearTimeout(last);
    };
  }, []);
  useEffect(() => {
    if (!placed) return;
    // Dropped just now (a drop is a move of yours): load at once. Opened with a place: on your first move.
    if (Date.now() - lastAct.current < 15_000) {
      void fetch("/api/serverless/warm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ load: "director" }) }).catch(() => undefined);
      loadFor.current = null;
    } else loadFor.current = placed;
  }, [placed]);
}

/**
 * A take you started here opens by itself when it's done (still or clip), so Shoot ends with your shot on screen, not a
 * dot on a button. Only takes that were running while the page was open; never over another take you're looking at.
 */
function useShowFinishedTakes() {
  const takes = useToolTakes("director");
  const running = useRef(new Set<string>());
  // Only takes this tab started: one started on another device (or by a test) never pops up here.
  const mine = useRef(new Set<string>());
  useEffect(() => {
    const original = useGenerationsStore.getState().submit;
    const submit: typeof original = async (input) => {
      const g = await original(input);
      mine.current.add(g.id);
      return g;
    };
    useGenerationsStore.setState({ submit });
    return () => {
      if (useGenerationsStore.getState().submit === submit) useGenerationsStore.setState({ submit: original });
    };
  }, []);
  useEffect(() => {
    for (const g of takes) {
      if (!mine.current.has(g.id)) continue;
      if (g.status === "queued" || g.status === "running") running.current.add(g.id);
      else if (running.current.has(g.id) || mine.current.has(g.id)) {
        mine.current.delete(g.id);
        running.current.delete(g.id);
        if (g.status === "done" && !useTakeView.getState().viewing && !document.hidden) openTake(g.id);
        // A take that failed says why where you're looking, in words you can act on.
        if (g.status === "error") notice(friendlyModelError(g.error ?? "The shot didn't come out. Try again."), "stop", 9000);
      }
    }
  }, [takes]);
}

/** The shot's timeline under the stage, once there's a set (an empty set has nothing to move). */
function ShotTimeline() {
  const empty = useDirector((s) => !s.scene.elements.length && !s.scene.place.image);
  if (empty) return null;
  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <Timeline className="min-w-0 flex-1" />
      <SavePreview />
    </div>
  );
}

/** Save preview: the move played through the Camera and saved as a video, free (no AI, any computer). */
function SavePreview() {
  const keyed = useDirector((s) => hasKeys(s.scene.timeline));
  const [share, setShare] = useState<number | null>(null);
  if (!keyed) return null;
  return (
    <button
      type="button"
      disabled={share !== null}
      title="Play the move through the Camera and save it as a video: free, no AI, on any computer"
      onClick={async () => {
        setShare(0);
        try {
          const blob = await recordPreview((p) => setShare(p));
          downloadPreview(blob);
          notice("Preview saved to your downloads", "done", 3000);
        } catch (err) {
          notice((err as Error).message, "stop", 6000);
        } finally {
          setShare(null);
        }
      }}
      className="surface squircle press inline-flex shrink-0 items-center gap-2 rounded-[16px] px-3 text-[12.5px] font-semibold text-fog hover:text-paper disabled:opacity-70"
    >
      {share !== null ? <LoaderCircle size={14} className="animate-spin text-spike" /> : <Download size={14} />}
      {share !== null ? `Recording ${Math.round(share * 100)}%` : "Save preview"}
    </button>
  );
}

/** Every Director take as the takes library shows it, newest first. */
function takesNow() {
  const project = useTakesFrom.getState().project;
  const all = toolTakesNow("director");
  return project ? all.filter((g) => g.params?.project === project) : all;
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], select")) return;
      const viewing = useTakeView.getState().viewing;
      if (viewing) {
        const list = takesNow();
        const i = list.findIndex((g) => g.id === viewing);
        if (e.key === "Escape") return closeTake();
        if (e.key === "ArrowLeft" && list[i + 1]) {
          e.preventDefault();
          return openTake(list[i + 1].id);
        }
        if (e.key === "ArrowRight" && i > 0) {
          e.preventDefault();
          return openTake(list[i - 1].id);
        }
        return;
      }
      const s = useDirector.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return e.shiftKey ? s.redo() : s.undo();
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        return s.redo();
      }
      if (mod || e.altKey) return;
      const empty = !s.scene.elements.length && !s.scene.place.image;
      if (e.key === "Tab" && !empty) {
        e.preventDefault();
        return useStageView.setState((v) => ({ scout: !v.scout, model: false }));
      }
      if (e.code === "KeyC" && useStageView.getState().scout) return nav.cameraToView();
      const el = s.scene.elements.find((x) => x.id === s.selectedId);
      if (!el) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        return s.removeElement(el.id);
      }
      if (e.key === "Escape") return s.select(null);
      // Arrows nudge the picked one relative to the Camera: across the frame, deeper or closer.
      const step = e.shiftKey ? 0.5 : 0.1;
      const az = MathUtils.degToRad(s.scene.camera.azimuth);
      const right = { x: Math.cos(az), z: -Math.sin(az) };
      const away = { x: -Math.sin(az), z: -Math.cos(az) };
      const move = (dx: number, dz: number) => {
        e.preventDefault();
        s.updateElement(el.id, { x: Math.round((el.x + dx) * 100) / 100, z: Math.round((el.z + dz) * 100) / 100 });
      };
      if (e.key === "ArrowLeft") move(-right.x * step, -right.z * step);
      if (e.key === "ArrowRight") move(right.x * step, right.z * step);
      if (e.key === "ArrowUp") move(away.x * step, away.z * step);
      if (e.key === "ArrowDown") move(-away.x * step, -away.z * step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
