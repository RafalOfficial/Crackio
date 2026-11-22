"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MathUtils } from "three";
import { Clapperboard, ImagePlus, UserRound } from "lucide-react";
import { useDirector, usePlayhead } from "@/lib/director/store";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { useGenerationsStore } from "@/lib/hooks/use-generations";
import { room } from "@/lib/director/room";
import { useStageView } from "./stage/view";
import { captureShot } from "./stage/capture";
import { ASPECTS, aspectById, type AspectId } from "@/lib/shot";
import { ScenePanel } from "./ScenePanel";
import { ShotPanel } from "./ShotPanel";
import { Viewport } from "./Viewport";
import { PromptBar } from "./PromptBar";
import { toolTakesNow } from "@/components/tools/use-tool-takes";
import { closeTake, openTake, useTakeView, useTakesFrom } from "./take-view";
import { useWalkKeys } from "./walk";
import { addFilesToCast, addToCast, castViews, dragsVideo, learnWhatItIs, setPlaceFile, setPlaceVideoFile } from "./intake";
import { liftFromPlace, useLift } from "./lift";
import { usePlaceModel } from "./place-model";
import { useShotModel } from "./shot-model";
import { buildAround, buildWorld, measureWorld, useAround, useWorld, WORLD_DEPTH_VERSION } from "./around";
import { cn } from "@/lib/cn";

/** `className`: Storyboard sets it under its own bar (the page is the Director's alone otherwise). */
export function DirectorWorkspace({ className }: { className?: string } = {}) {
  useHandoffIntoScene();
  useShortcuts();
  useWalkKeys();
  useReadCast();
  useScriptHandle();

  return (
    <div className={cn("grid grid-cols-1 gap-3 p-3 sm:p-4 lg:h-dvh lg:grid-cols-[300px_minmax(0,1fr)_330px] lg:py-4", className)}>
      <aside aria-label="Location and cast" className="surface order-3 rounded-panel lg:order-none lg:min-h-0">
        <ScenePanel />
      </aside>
      <CameraColumn />
      <aside aria-label="Shot settings" className="surface order-4 rounded-panel lg:order-none lg:min-h-0">
        <ShotPanel />
      </aside>
    </div>
  );
}

/** The camera's screen's title bar (Viewport), over its picture. */
const TITLE_BAR = 56;
/** The prompt box's height that's always allowed (about three lines), even where the screen fills the height. */
const MIN_WORDS = 96;

/**
 * The middle: the camera's screen (a title bar over exactly the frame you'll get) centered in the room above the prompt
 * bar, which sits at the bottom of the page like Home's. The screen is sized to its picture, so no blank band sits
 * around it.
 */
function CameraColumn() {
  const room = useRef<HTMLDivElement>(null);
  const aspect = useDirector((s) => s.scene.aspect);
  const a = aspectById(aspect);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [wordsMax, setWordsMax] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const fit = () => {
      // Only where the page is one screen tall (wide windows); stacked on phones the screen keeps its own height.
      if (window.innerWidth < 1024) {
        setSize(null);
        return setWordsMax(null);
      }
      const ratio = a.w / a.h;
      const width = Math.floor(Math.min(el.clientWidth, (el.clientHeight - TITLE_BAR) * ratio));
      const height = Math.floor(width / ratio) + TITLE_BAR;
      setSize({ width, height });
      // Typed lines grow the prompt box into the room the screen doesn't use: the screen rises with it, and the box
      // stops growing when the screen's top is level with the side panels', so the screen never shrinks.
      // Where the screen already fills the height, a few lines still fit.
      const words = document.getElementById("director-notes");
      if (words) setWordsMax(Math.max(MIN_WORDS, words.offsetHeight + el.clientHeight - height));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a.w, a.h]);
  return (
    <section
      aria-label="Camera"
      style={wordsMax ? ({ "--words-max": `${wordsMax}px` } as React.CSSProperties) : undefined}
      className="order-1 flex min-h-0 flex-col gap-3 lg:order-none"
    >
      <div ref={room} className="grid min-h-0 flex-1 place-items-center">
        <DropZone size={size}>
          <Viewport />
        </DropZone>
      </div>
      <PromptBar />
    </section>
  );
}

/**
 * Drop photos on the camera view: on the left half as the location, on the right half into the shot. `fill`: as big as
 * its stage at every width (Director v2, whose stage sets its own size): under `lg` it hugged a frame 260 px tall, and
 * on a phone the whole 3D stage was a strip along the top of the screen.
 */
export function DropZone({ size, fill = false, children }: { size: { width: number; height: number } | null; fill?: boolean; children: React.ReactNode }) {
  const [over, setOver] = useState<"place" | "cast" | "video" | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const aspect = useDirector((s) => s.scene.aspect);
  const a = aspectById(aspect);
  const isFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      ref={box}
      // On phones the panel hugs the frame (toolbar + picture) instead of leaving empty bands.
      style={{ "--frame-h": `calc((100vw - 40px) / ${a.w / a.h} + ${TITLE_BAR}px)`, ...(size ?? {}) } as React.CSSProperties}
      className={cn("relative w-full rounded-panel", fill ? "h-full" : ["h-[min(64vh,var(--frame-h))] min-h-[260px]", size ? "lg:min-h-0" : "lg:h-full"])}
      onDragEnter={(e) => {
        if (!isFiles(e)) return;
        depth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) {
          setDragging(false);
          setOver(null);
        }
      }}
      onDragOver={(e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        const r = box.current!.getBoundingClientRect();
        // A video is the whole place (Director video mode): one target, the whole stage.
        setOver(dragsVideo(e.dataTransfer) ? "video" : e.clientX < r.left + r.width / 2 ? "place" : "cast");
      }}
      onDrop={(e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        const video = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("video/"));
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (video) void setPlaceVideoFile(video).catch(() => undefined);
        else if (over === "place" && files[0]) void setPlaceFile(files[0]);
        else if (files.length) void addFilesToCast(files);
        depth.current = 0;
        setDragging(false);
        setOver(null);
      }}
    >
      {children}
      <AnimatePresence>
        {dragging ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className={cn("pointer-events-none absolute inset-2 z-30 grid gap-2 rounded-[18px] bg-stage/80 p-2 backdrop-blur-sm", over === "video" ? "grid-cols-1" : "grid-cols-2")}
          >
            {over === "video" ? (
              <DropTarget active icon={<Clapperboard size={22} />} title="Film this video again" sub="Move the camera through it, then film it from there" />
            ) : (
              <>
                <DropTarget active={over === "place"} icon={<ImagePlus size={22} />} title="Use as the location" sub="It becomes the 3D set" />
                <DropTarget active={over === "cast"} icon={<UserRound size={22} />} title="Add to the shot" sub="People, pets, products" />
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function DropTarget({ active, icon, title, sub }: { active: boolean; icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div
      className={cn(
        "squircle grid place-items-center rounded-card border-2 border-dashed text-center transition-colors",
        active ? "border-spike bg-spike/10 text-paper" : "border-line-strong text-fog",
      )}
    >
      <div>
        <span className={cn("mx-auto grid size-12 place-items-center rounded-[14px]", active ? "bg-spike text-spike-ink" : "bg-white/[0.06]")}>{icon}</span>
        <p className="mt-3 text-[15px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-haze">{sub}</p>
      </div>
    </div>
  );
}

/** In development, scripts (benchmarks, tests) stage scenes through the same store and intake the page uses. */
export function useScriptHandle() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __crackioDirector?: unknown }).__crackioDirector = {
      store: useDirector,
      addToCast,
      learnWhatItIs,
      buildAround,
      around: useAround,
      buildWorld,
      measureWorld,
      world: useWorld,
      generations: useGenerationsStore,
      room,
      playhead: usePlayhead,
      // Tests grab the shot's passes (the kept shot's camera view) without shooting.
      capture: captureShot,
    };
  }, []);
}

/**
 * Cast from before Crackio read pictures (or whose reading predates knowing which side the photo shows) gets read
 * once, so its stand-in faces the way its photo card shows it.
 */
export function useReadCast() {
  const pending = useDirector((s) => s.scene.elements.filter((e) => e.image && e.read?.around === undefined).map((e) => e.id).join(","));
  useEffect(() => {
    for (const id of pending.split(",").filter(Boolean)) {
      const el = useDirector.getState().scene.elements.find((e) => e.id === id);
      if (el?.image) void learnWhatItIs(id, el.image.sourceUrl ?? el.image.url);
    }
  }, [pending]);
  // The place photo's own cars, people and things, lifted onto the set once its 3D set is built.
  const unlifted = useDirector((s) => (s.scene.place.image?.view && !s.scene.place.lifted ? s.scene.place.image.url : ""));
  // With a model you chose (the place's, else the shot's): never Auto, and not before your choice has loaded.
  const ownChosen = usePlaceModel((s) => Boolean(s.model && s.model !== "auto"));
  const shotChosen = useShotModel((s) => s.model !== "auto");
  const chosen = ownChosen || shotChosen;
  // Director v2 lifts only when you ask (Cast & place → "Lift them out"): done by itself, the model sometimes drew the
  // astronaut back instead of erasing him, and he stood on set twice (v2's A40 test).
  const v2 = useStageView((s) => s.v2);
  useEffect(() => {
    if (unlifted && chosen && !v2) void liftFromPlace();
  }, [unlifted, chosen, v2]);
  // Then the place all around (its 360 world), from the photo without its things (or as it is, when lifting failed).
  // Director v2 builds it only when you ask (Cast & place → "Build the world around it"): built by itself it held the
  // GPU for 2–6 minutes after every new photo, and a shot taken meanwhile waited behind it: minutes lost when all you
  // want is one quick picture. A shot from the photo's 3D set doesn't need it.
  const liftFailed = useLift((s) => Boolean(s.error));
  const unbuilt = useDirector((s) => (!v2 && s.scene.place.image?.view && (s.scene.place.lifted || liftFailed) && !s.scene.place.world ? s.scene.place.image.url : ""));
  useEffect(() => {
    if (unbuilt && chosen) void buildWorld();
  }, [unbuilt, chosen]);
  // Then measured, so it's a place to walk into (and its light goes on the set).
  const unmeasured = useDirector((s) => (s.scene.place.world && (s.scene.place.world.depth?.version ?? 0) < WORLD_DEPTH_VERSION ? s.scene.place.world.url : ""));
  useEffect(() => {
    if (unmeasured) void measureWorld();
  }, [unmeasured]);
  // Cast members show their sheet's views in the camera view.
  const unseen = useDirector((s) => s.scene.elements.filter((e) => e.cast?.id && !e.views?.length).map((e) => e.id).join(","));
  useEffect(() => {
    for (const id of unseen.split(",").filter(Boolean)) void castViews(id);
  }, [unseen]);
}

/** Words and photos sent from another page (e.g. Home's "Stage in Director") land on set. */
export function useHandoffIntoScene() {
  useEffect(() => {
    const draft = useHandoff.getState().take();
    if (!draft) return;
    const { setScene } = useDirector.getState();
    if (draft.prompt.trim()) setScene({ notes: draft.prompt.trim() });
    if (draft.aspect && ASPECTS.some((a) => a.id === draft.aspect)) setScene({ aspect: draft.aspect as AspectId });
    for (const ref of draft.references) void addToCast({ url: ref.url, name: ref.name || "Subject" });
  }, []);
}

/** Every Director take as the takes library shows it, newest first (read when a key is pressed). */
function takesNow() {
  const project = useTakesFrom.getState().project;
  const all = toolTakesNow("director");
  return project ? all.filter((g) => g.params?.project === project) : all;
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], select")) return;

      // In the before/after viewer, arrows step through takes.
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
      const el = s.scene.elements.find((x) => x.id === s.selectedId);
      if (!el) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        return s.removeElement(el.id);
      }
      if (e.key === "Escape") return s.select(null);
      if (e.key.toLowerCase() === "f") return s.focusOn(el.id);
      // Arrow keys nudge relative to the camera: left/right across the frame, up/down deeper/closer.
      const step = e.shiftKey ? 0.5 : 0.1;
      const az = MathUtils.degToRad(s.scene.camera.azimuth);
      const right = { x: Math.cos(az), z: -Math.sin(az) };
      const away = { x: -Math.sin(az), z: -Math.cos(az) };
      const move = (dx: number, dz: number) => {
        e.preventDefault();
        s.updateElement(el.id, { x: round(el.x + dx), z: round(el.z + dz) });
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

const round = (n: number) => Math.round(n * 100) / 100;
