"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Box, Crosshair, Image as ImageIcon, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { toolBySlug } from "@/lib/tools";
import { Slider } from "@/components/ui/Slider";
import { Osd } from "@/components/ui/Viewfinder";
import { loadDepth, loadMask, useDepth, useMask, useVision, visionMessage } from "@/lib/director/vision";
import {
  angleBase,
  angleFacts,
  orbitFor,
  MAX_ELEVATION,
  MIN_ELEVATION,
  placeFor,
  provisionalPlace,
  resolveShot,
  wrapDegrees,
  type AngleShot,
  type AngleView,
} from "@/lib/angles/rig";
import { anglePrompt, angleSummary, describeMove, isOriginal } from "@/lib/angles/prompt";
import { ControlSection, EditToolShell, type Compiled, type ToolModel } from "./EditToolShell";
import { imageSlots } from "@/lib/models/caps";
import type { SourceImage } from "./SourcePicker";
import type { PickPoint } from "./angles/AngleStage";
import { cn } from "@/lib/cn";

const AngleStage = dynamic(() => import("./angles/AngleStage"), {
  ssr: false,
  loading: () => <div className="skeleton size-full" />,
});

const HINT_KEY = "crackio-angles-hint-seen";

/**
 * Auto's picks for Angles: in tests the GPT Image models followed the 3D guide's camera most
 * faithfully while keeping people the same; Nano Banana is next. Then Crackio's usual order.
 */
const PREFER = ["comfy:openai/gpt-image-2.5-flare", "comfy:vertexai/gemini-nano-banana-2.1", "local:flux3-klein", "local:flux2-klein-4b"];

type Pivot = { url: string; u: number; v: number };
type SetView = Dispatch<SetStateAction<AngleView>>;

/** Spots around the subject as seen from above, with the original camera at the bottom. */
const AROUND: ({ label: string; azimuth: number } | null)[] = [
  { label: "135° L", azimuth: -135 },
  { label: "Behind", azimuth: 180 },
  { label: "135° R", azimuth: 135 },
  { label: "90° L", azimuth: -90 },
  null,
  { label: "90° R", azimuth: 90 },
  { label: "45° L", azimuth: -45 },
  { label: "Front", azimuth: 0 },
  { label: "45° R", azimuth: 45 },
];

/** Camera heights, as the angle the subject sees the camera at. */
const HEIGHTS = [
  { label: "Top-down", elevation: MAX_ELEVATION },
  { label: "Bird's-eye", elevation: 60 },
  { label: "High", elevation: 30 },
  { label: "Eye level", elevation: 0 },
  { label: "Low", elevation: -25 },
  { label: "Worm's-eye", elevation: -50 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The photo's 3D set, what the camera orbits and where it stood, once depth (and the subject's matte) arrive. */
function useAngleScene(source: SourceImage, picked?: { u: number; v: number }) {
  const { depth, error, retry } = useDepth(source.url);
  const { mask } = useMask(source.url);
  const aspect = source.width / source.height;
  const place = useMemo(() => (depth ? placeFor(depth, aspect) : provisionalPlace(aspect)), [depth, aspect]);
  const u = picked?.u;
  const v = picked?.v;
  const orbit = useMemo(() => orbitFor(place, depth, aspect, mask, u === undefined || v === undefined ? undefined : { u, v }), [place, depth, aspect, mask, u, v]);
  const base = useMemo(() => angleBase(place, orbit.point), [place, orbit]);
  return { depth, mask, error, retry, place, orbit, base, aspect };
}

/**
 * Renders the 3D set from the chosen camera, uploads it as the guide and words the move around it.
 * A model that takes only one picture gets the move in words alone (it couldn't see the guide).
 */
async function compileAngles(source: SourceImage, view: AngleView, model: ToolModel): Promise<Compiled> {
  const aspect = source.width / source.height;
  // Usually ready already (the 3D view asked for them). Without depth the move goes by words alone;
  // without a subject matte the set is one surface.
  const [depth, mask] = await Promise.all([loadDepth(source.url).catch(() => null), loadMask(source.url).catch(() => null)]);
  const place = depth ? placeFor(depth, aspect) : provisionalPlace(aspect);
  const orbit = orbitFor(place, depth, aspect, mask, view.pivot);
  const base = angleBase(place, orbit.point);
  const shot = resolveShot(base, view);
  const facts = angleFacts(base, shot, orbit);
  if (isOriginal(facts)) throw new Error("Move the camera first: drag the 3D view or pick a spot.");
  const summary = `Angles · ${angleSummary(facts)}`;
  const oneImage = model.caps ? imageSlots(model.caps) < 2 : false;
  if (!depth || oneImage) return { summary, prompt: anglePrompt(facts, { guide: false }), params: { view, shot } };

  const { renderGuide } = await import("./angles/place");
  const guide = await renderGuide({ url: source.url, depth, mask, place, aspect, base, shot });
  const body = new FormData();
  body.append("file", new File([guide.blob], "angle-guide.png", { type: "image/png" }));
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json().catch(() => ({}))) as { items?: { url: string }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Couldn't save the 3D preview.");
  const guideUrl = data.items[0].url;
  // The original goes first (models keep image 1's identity best), the preview second.
  return {
    summary,
    prompt: anglePrompt(facts, { guide: true, order: "original-first" }),
    extraRefs: [{ url: guideUrl, label: "rough 3D preview from the new camera" }],
    params: { view, shot, preview: guideUrl },
  };
}

export function AnglesTool() {
  const tool = toolBySlug("angles")!;
  const [view, setView] = useState<AngleView>({ azimuth: -35, zoom: 0 });
  // The orbit point belongs to one image; another image starts from its middle.
  const [pivot, setPivot] = useState<Pivot | null>(null);
  const viewFor = (source: SourceImage | null): AngleView =>
    pivot && source && pivot.url === source.url ? { ...view, pivot: { u: pivot.u, v: pivot.v } } : view;
  const moved = view.azimuth !== 0 || view.elevation !== undefined || view.zoom !== 0;

  return (
    <EditToolShell
      tool={tool}
      hint="A photo, render or past generation. It turns into a 3D scene you can move the camera around."
      actionLabel="Re-shoot"
      ready={moved}
      prefer={PREFER}
      compile={(source, model) => compileAngles(source, viewFor(source), model)}
      controls={(source) =>
        source ? (
          <AnglesControls source={source} view={viewFor(source)} setView={setView} onPivot={(p) => setPivot(p && { url: source.url, ...p })} />
        ) : (
          <p className="text-[12.5px] leading-relaxed text-haze">Add an image and it becomes a soft 3D scene: drag it to choose where the camera goes.</p>
        )
      }
      stage={(source, output) => (
        <AnglesStage
          source={source}
          {...output}
          view={viewFor(source)}
          setView={setView}
          onPivot={(p) => setPivot({ url: source.url, ...p })}
        />
      )}
    />
  );
}

function AnglesControls({
  source,
  view,
  setView,
  onPivot,
}: {
  source: SourceImage;
  view: AngleView;
  setView: SetView;
  onPivot: (p: { u: number; v: number } | null) => void;
}) {
  const { base, orbit } = useAngleScene(source, view.pivot);
  const shot = resolveShot(base, view);
  const facts = angleFacts(base, shot, orbit);

  return (
    <>
      <ControlSection title="Camera" hint="Or drag the 3D view">
        <div className="flex gap-2">
          <div className="grid flex-1 grid-cols-3 gap-1.5" role="group" aria-label="Where the camera goes around the subject">
            {AROUND.map((spot, i) =>
              spot ? (
                <button
                  key={spot.label}
                  onClick={() => setView((v) => ({ ...v, azimuth: spot.azimuth }))}
                  aria-pressed={Math.abs(wrapDegrees(view.azimuth - spot.azimuth)) < 1}
                  className={cn(
                    "press squircle h-11 rounded-[10px] text-[12px] font-semibold",
                    Math.abs(wrapDegrees(view.azimuth - spot.azimuth)) < 1
                      ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1.5px_var(--color-spike)]"
                      : "bg-apple-2 text-fog hover:bg-gaffer hover:text-paper",
                  )}
                >
                  {spot.label}
                </button>
              ) : (
                <span key={i} className="relative grid h-11 place-items-center overflow-hidden rounded-[10px] bg-flat" title="The subject">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={source.url} alt="" className="absolute inset-0 size-full object-cover opacity-70" />
                  <Compass azimuth={view.azimuth} />
                </span>
              ),
            )}
          </div>
          <div className="flex w-[92px] shrink-0 flex-col gap-1" role="group" aria-label="Camera height">
            {HEIGHTS.map((h) => {
              const active = view.elevation !== undefined && Math.abs(view.elevation - h.elevation) < 1;
              return (
                <button
                  key={h.label}
                  onClick={() => setView((v) => ({ ...v, elevation: h.elevation }))}
                  aria-pressed={active}
                  className={cn(
                    "press squircle h-[23px] rounded-[8px] text-[11.5px] font-semibold",
                    active ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "bg-apple-2 text-fog hover:bg-gaffer hover:text-paper",
                  )}
                >
                  {h.label}
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-fog">{describeMove(facts)}</p>
      </ControlSection>

      <ControlSection title="Fine-tune">
        <div className="space-y-4">
          <Slider
            label="Around the subject"
            value={Math.round(view.azimuth)}
            min={-180}
            max={180}
            onChange={(azimuth) => setView((v) => ({ ...v, azimuth }))}
            format={(v) => (Math.abs(v) < 1 ? "As shot" : Math.abs(v) >= 179 ? "Behind" : `${Math.abs(v)}° ${v < 0 ? "left" : "right"}`)}
            hint={["Left", "Right"]}
          />
          <Slider
            label="Height"
            value={Math.round(shot.elevation)}
            min={MIN_ELEVATION}
            max={90}
            onChange={(elevation) => setView((v) => ({ ...v, elevation: Math.min(MAX_ELEVATION, elevation) }))}
            format={(v) => (Math.abs(v) < 1 ? "Level" : `${Math.abs(v)}° ${v > 0 ? "above" : "below"}`)}
            hint={["Looking up", "Looking down"]}
          />
          <Slider
            label="Distance"
            value={view.zoom}
            min={-1}
            max={1}
            step={0.05}
            onChange={(zoom) => setView((v) => ({ ...v, zoom }))}
            format={(v) => (v > 0.1 ? "Closer" : v < -0.1 ? "Wider" : "Same")}
            hint={["Wider", "Closer"]}
          />
        </div>
      </ControlSection>

      <ControlSection title="Orbit point" hint="Double-click the 3D view to change">
        <div className="squircle flex items-center gap-2.5 rounded-[12px] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Crosshair size={15} className={view.pivot ? "text-spike" : "text-haze"} />
          <span className="min-w-0 flex-1 text-[12.5px] text-fog">
            {orbit.kind === "picked" ? "A point you picked" : orbit.kind === "subject" ? "The main subject" : "The middle of the picture"}
          </span>
          {view.pivot ? (
            <button onClick={() => onPivot(null)} className="press text-[12px] font-semibold text-haze hover:text-paper">
              Reset
            </button>
          ) : null}
        </div>
      </ControlSection>

      <button
        onClick={() => {
          setView({ azimuth: 0, zoom: 0 });
          onPivot(null);
        }}
        className="press flex items-center gap-1.5 text-[12.5px] font-semibold text-haze hover:text-paper"
      >
        <RotateCcw size={13} /> Back to the original camera
      </button>
    </>
  );
}

/** A small arrow in the subject cell pointing at where the camera now stands (seen from above). */
function Compass({ azimuth }: { azimuth: number }) {
  return (
    <svg viewBox="-12 -12 24 24" className="relative size-7 drop-shadow-[0_1px_2px_rgb(0_0_0/0.8)]" aria-hidden>
      <circle r={10} fill="rgb(0 0 0 / 0.45)" stroke="rgb(255 255 255 / 0.35)" strokeWidth={1} />
      <g transform={`rotate(${180 - azimuth})`}>
        <path d="M0 -8.5 L3.2 -3 L-3.2 -3 Z" fill="var(--color-spike)" />
      </g>
      <circle r={1.6} fill="#f3f2ee" />
    </svg>
  );
}

function AnglesStage({
  source,
  compare,
  result,
  view,
  setView,
  onPivot,
}: {
  source: SourceImage;
  compare: ReactNode;
  result: string | null;
  view: AngleView;
  setView: SetView;
  onPivot: (p: { u: number; v: number }) => void;
}) {
  const [tab, setTab] = useState<"camera" | "result">("camera");
  // A new result shows itself; moving the camera brings the 3D view back. (By value: the view
  // object is rebuilt on every render of the page.)
  const key = JSON.stringify(view);
  const [seen, setSeen] = useState({ result, key });
  if (seen.result !== result || seen.key !== key) {
    setSeen({ result, key });
    if (seen.result !== result && result) setTab("result");
    else if (seen.key !== key) setTab("camera");
  }
  const showing = tab === "result" && result ? "result" : "camera";

  return (
    <div className="flex size-full flex-col gap-3">
      <div role="tablist" aria-label="Stage" className="mx-auto grid w-[260px] grid-cols-2 gap-1 rounded-[14px] bg-white/[0.04] p-1">
        <StageTab active={showing === "camera"} onClick={() => setTab("camera")} icon={<Box size={15} />}>
          3D camera
        </StageTab>
        <StageTab active={showing === "result"} onClick={() => setTab("result")} icon={<ImageIcon size={15} />} disabled={!result}>
          Result
        </StageTab>
      </div>
      <div className="min-h-0 flex-1">
        {showing === "camera" ? <AngleViewport source={source} view={view} setView={setView} onPivot={onPivot} /> : compare}
      </div>
    </div>
  );
}

function StageTab({ active, onClick, icon, disabled, children }: { active: boolean; onClick: () => void; icon: ReactNode; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "press squircle flex h-8 items-center justify-center gap-1.5 rounded-[10px] text-[12.5px] font-semibold disabled:opacity-35",
        active ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-haze hover:text-paper",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** The 3D set seen from the new camera, at the photo's shape. Drag orbits, scroll moves in and out. */
function AngleViewport({
  source,
  view,
  setView,
  onPivot,
}: {
  source: SourceImage;
  view: AngleView;
  setView: SetView;
  onPivot: (p: { u: number; v: number }) => void;
}) {
  const scene = useAngleScene(source, view.pivot);
  const shot: AngleShot = resolveShot(scene.base, view);
  const facts = angleFacts(scene.base, shot, scene.orbit);
  const models = useVision((s) => s.models);
  const frame = useRef<HTMLDivElement>(null);
  const pickRef = useRef<PickPoint | null>(null);
  const drag = useRef<{ x: number; y: number; azimuth: number; elevation: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY);
    } catch {
      return false;
    }
  });
  const dismissHint = () => {
    if (!hint) return;
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private window: the hint just comes back next time */
    }
  };

  // Scroll moves the camera in and out. A native listener: React's wheel events can't stop the page from scrolling.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      setView((v) => ({ ...v, zoom: clamp(v.zoom - dy * 0.0012, -1, 1) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView]);

  const ratio = scene.aspect;
  const loading = !scene.depth && !scene.error;

  return (
    <div className="grid size-full place-items-center" style={{ containerType: "size" }}>
      <div
        ref={frame}
        tabIndex={0}
        role="application"
        aria-label="3D camera. Drag to orbit, scroll to move in or out, arrow keys to nudge."
        className={cn(
          "relative touch-none select-none overflow-hidden rounded-[14px] bg-apple shadow-[0_0_0_1px_var(--color-line-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-spike)]",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, azimuth: view.azimuth, elevation: shot.elevation, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = frame.current;
          if (!d || !el) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 3) return;
          if (!d.moved) {
            d.moved = true;
            setDragging(true);
            dismissHint();
          }
          // Grab the world: drag right and it turns right (the camera goes left); drag down and the camera rises.
          setView((v) => ({
            ...v,
            azimuth: Math.round(wrapDegrees(d.azimuth - (dx / el.clientWidth) * 220)),
            elevation: Math.round(clamp(d.elevation + (dy / el.clientHeight) * 120, MIN_ELEVATION, MAX_ELEVATION)),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const hit = pickRef.current?.((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          if (hit) onPivot(hit);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15 : 5;
          const keys: Record<string, (v: AngleView) => AngleView> = {
            ArrowLeft: (v) => ({ ...v, azimuth: Math.round(wrapDegrees(v.azimuth - step)) }),
            ArrowRight: (v) => ({ ...v, azimuth: Math.round(wrapDegrees(v.azimuth + step)) }),
            ArrowUp: (v) => ({ ...v, elevation: clamp(Math.round(shot.elevation + step), MIN_ELEVATION, MAX_ELEVATION) }),
            ArrowDown: (v) => ({ ...v, elevation: clamp(Math.round(shot.elevation - step), MIN_ELEVATION, MAX_ELEVATION) }),
            "+": (v) => ({ ...v, zoom: clamp(v.zoom + 0.1, -1, 1) }),
            "=": (v) => ({ ...v, zoom: clamp(v.zoom + 0.1, -1, 1) }),
            "-": (v) => ({ ...v, zoom: clamp(v.zoom - 0.1, -1, 1) }),
          };
          const change = keys[e.key];
          if (!change) return;
          e.preventDefault();
          setView(change);
        }}
      >
        <AngleStage url={source.url} aspect={ratio} depth={scene.depth} mask={scene.mask} place={scene.place} shot={shot} pivot={scene.orbit.point} pickRef={pickRef} />

        <Osd className="pointer-events-none absolute left-3 top-3 rounded bg-black/55 px-1.5 py-1">{angleSummary(facts)}</Osd>

        {/* The orbit point stays put in the frame; shown while moving, or when you picked one. */}
        {dragging || scene.orbit.kind === "picked" ? (
          <span
            className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_1.5px_var(--color-spike),0_0_0_3px_rgb(0_0_0/0.35)]"
            style={{ left: `${scene.orbit.u * 100}%`, top: `${scene.orbit.v * 100}%` }}
          >
            <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-spike" />
          </span>
        ) : null}

        {loading ? (
          <span className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-black/65 px-3 py-1.5 text-[12px] font-semibold text-paper">
            <LoaderCircle size={13} className="animate-spin" />
            {visionMessage(models) ?? "Building 3D from your image"}
          </span>
        ) : scene.error ? (
          <span className="absolute inset-x-3 bottom-3 flex items-start gap-2 rounded-[12px] bg-black/70 px-3 py-2 text-[12px] leading-relaxed text-paper">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-tungsten" />
            <span className="min-w-0 flex-1">
              The 3D preview isn&rsquo;t available ({scene.error}). Re-shoot still works, guided by words alone.
            </span>
            <button onClick={scene.retry} className="press shrink-0 font-semibold text-spike hover:brightness-110">
              Retry
            </button>
          </span>
        ) : hint ? (
          <span className="pointer-events-none absolute inset-x-3 bottom-3 mx-auto w-fit max-w-full rounded-[12px] bg-black/60 px-3 py-1.5 text-center text-[11.5px] leading-snug text-fog">
            Drag to orbit · scroll to move in or out · double-click to orbit a point
          </span>
        ) : null}
      </div>
    </div>
  );
}
