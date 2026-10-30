"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Download,
  Info,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  Trash,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { AppIcon } from "@/components/ui/ToolTile";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { posterUrl, previewUrl } from "@/lib/media-url";
import { copyText } from "@/lib/clipboard";
import { toolBySlug } from "@/lib/tools";
import { cn } from "@/lib/cn";
import type { ProjectInput } from "@/lib/library/types";
import { HowItWasMade } from "./HowItWasMade";
import { MoveMenu } from "./MoveMenu";
import { ProjectIcon } from "./ProjectIcon";
import type { FolderInfo } from "./folders";
import { useLibraryPrefs } from "./prefs";
import { clock, download, downloadName, fileSize, span, toolIcon, toolName, type Take } from "./takes";

/** What the keyboard and the top bar can ask of the picture or clip on show. */
type MediaHandle = {
  toggleZoom?: () => void;
  zoomBy?: (factor: number) => void;
  togglePlay?: () => void;
  step?: (frames: number) => void;
  toggleMute?: () => void;
};

type Box = { w: number; h: number };

/** Where tools that take a still can pick it up from here. */
const NEXT_STEPS = [
  { label: "Animate", href: "/video", glyph: "/icons/video.png", hue: undefined },
  ...(["angles", "relight", "retouch", "upscale"] as const).map((slug) => {
    const t = toolBySlug(slug)!;
    return { label: t.name, href: t.href, glyph: t.glyph, hue: t.hue };
  }),
];

export type ViewerProps = {
  /** What ← and → step through: the takes the grid shows, in its order. */
  takes: Take[];
  index: number;
  onGo: (index: number) => void;
  onClose: () => void;
  folders: FolderInfo[];
  newColor: string;
  onMove: (take: Take, folder: string) => void;
  onCreateAndMove: (take: Take, input: ProjectInput) => Promise<void>;
  onDelete: (take: Take) => void;
  /** Open a still in another tool (Animate, Relight…). */
  onContinue: (take: Take, href: string) => void;
  /** Start a new image from this take's words. */
  onUsePrompt: (take: Take) => void;
};

/**
 * A take, as big as the screen allows, with everything about it on the right: the whole prompt,
 * the model, size, length, file, when it was made and how long it took, its folder, and what to do
 * next. ← → step through the grid (the grid follows), pictures zoom to their real pixels and pan,
 * clips get proper controls with frame stepping, and F takes either to full screen.
 */
export function Viewer({ takes, index, onGo, onClose, folders, newColor, onMove, onCreateAndMove, onDelete, onContinue, onUsePrompt }: ViewerProps) {
  const take = takes[index];
  const info = useLibraryPrefs((s) => s.info);
  const setPrefs = useLibraryPrefs((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const media = useRef<MediaHandle | null>(null);
  // Where a clip draws its controls: under the stage, so they never cover the picture.
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Box>({ w: 0, h: 0 });
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  // A double-click on a card opens this with its first click: the second mustn't zoom or pause.
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setSettling(false), 350);
    return () => clearTimeout(t);
  }, []);

  // While it's up, the page behind stays where it was and out of reach (focus, clicks, scrolling).
  useEffect(() => {
    const html = document.documentElement;
    const shell = document.getElementById("shell");
    const before = { overflow: html.style.overflow, gutter: html.style.scrollbarGutter };
    // Keep the scrollbar's room, so the grid behind doesn't reflow.
    if (window.innerWidth > html.clientWidth) html.style.scrollbarGutter = "stable";
    html.style.overflow = "hidden";
    shell?.setAttribute("inert", "");
    root.current?.focus({ preventScroll: true });
    return () => {
      html.style.overflow = before.overflow;
      html.style.scrollbarGutter = before.gutter;
      shell?.removeAttribute("inert");
    };
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onChange = () => setFull(Boolean(stage.current) && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // In full screen the bars step aside once the pointer rests.
  useEffect(() => {
    if (!full) return;
    let t = setTimeout(() => setIdle(true), 2400);
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 2400);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [full]);

  const toggleFull = () => {
    setIdle(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.current?.requestFullscreen?.().catch(() => {});
  };
  const go = (i: number) => {
    if (i >= 0 && i < takes.length && i !== index) onGo(i);
  };

  // Keys. Caught on the way down, so a menu that's open gets Escape first.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keys.current = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest("input:not([type=range]), textarea, select, [contenteditable]")) return;
      const onControl = Boolean(el?.closest("button, a, input, [role=menu]"));
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const m = media.current;
      const act = (run?: () => void) => {
        e.preventDefault();
        run?.();
      };
      switch (k) {
        case "Escape":
          if (document.querySelector("[data-popover-open]") || document.fullscreenElement) return;
          return act(onClose);
        case "ArrowLeft":
        case "ArrowRight":
          if (el?.matches("input[type=range]")) return;
          return act(() => go(index + (k === "ArrowLeft" ? -1 : 1)));
        case "Home":
          return act(() => go(0));
        case "End":
          return act(() => go(takes.length - 1));
        case "f":
          return act(toggleFull);
        case "i":
          return act(() => setPrefs({ info: !useLibraryPrefs.getState().info }));
        case " ":
          if (onControl || !m?.togglePlay) return;
          return act(m.togglePlay);
        case "k":
          return act(m?.togglePlay);
        case "m":
          return act(m?.toggleMute);
        case ",":
        case ".":
          return act(() => m?.step?.(k === "," ? -1 : 1));
        case "z":
        case "0":
          return act(m?.toggleZoom);
        case "+":
        case "=":
          return act(() => m?.zoomBy?.(1.25));
        case "-":
          return act(() => m?.zoomBy?.(0.8));
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // The next and previous pictures load in the background, so stepping to them is instant.
  useEffect(() => {
    const near = [takes[index + 1], takes[index - 1]].filter((t): t is Take => Boolean(t) && t.kind === "image");
    const loading = near.map((t) => {
      const img = new Image();
      img.decoding = "async";
      img.src = t.gen.outputs[t.index]?.url ?? "";
      return img;
    });
    return () => void loading.splice(0);
  }, [takes, index]);

  if (!take) return null;
  const output = take.gen.outputs[take.index];
  if (!output) return null;
  const pad = full ? 0 : size.w < 640 ? 8 : 20;
  const chrome = cn("transition-opacity duration-300", full && idle && "pointer-events-none opacity-0");

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${take.kind === "video" ? "Clip" : "Image"} ${index + 1} of ${takes.length}`}
      tabIndex={-1}
      className="viewer-in fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-[#0c0a10] text-paper outline-none lg:flex-row lg:overflow-hidden"
    >
      <div ref={stage} className={cn("relative flex h-[64dvh] min-w-0 shrink-0 flex-col bg-[#0c0a10] lg:h-auto lg:flex-1", full && idle && "cursor-none")}>
        {/* Top bar */}
        <div className={cn("z-10 flex h-14 shrink-0 items-center gap-2 px-2.5 sm:px-4", full && "absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent", chrome)}>
          <BarButton label="Close (Esc)" onClick={onClose}>
            <X size={19} />
          </BarButton>
          <span className="tabular ml-1 shrink-0 text-[13px] text-haze">
            <b className="font-semibold text-paper">{(index + 1).toLocaleString()}</b> / {takes.length.toLocaleString()}
          </span>
          {/* With the details put away (or in full screen), what this is and when, in a word. */}
          <span className={cn("ml-3 min-w-0 truncate text-[13px] text-fog", info && !full ? "hidden" : "hidden lg:inline")}>
            {toolName(take.tool)} · {new Date(take.gen.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {take.kind === "image" ? (
              <button
                type="button"
                onClick={() => media.current?.toggleZoom?.()}
                title={zoom ? "Back to fit (Z)" : "Zoom to real pixels (Z)"}
                className="press tabular h-9 min-w-[58px] rounded-[11px] px-2.5 font-mono text-[12px] font-semibold text-fog hover:bg-white/[0.07] hover:text-paper"
              >
                {zoom ? `${Math.round(zoom * 100)}%` : "Fit"}
              </button>
            ) : null}
            <BarButton label={full ? "Leave full screen (F)" : "Full screen (F)"} onClick={toggleFull}>
              {full ? <Minimize size={17} /> : <Maximize size={17} />}
            </BarButton>
            {!full ? (
              <BarButton label={info ? "Hide details (I)" : "Show details (I)"} active={info} onClick={() => setPrefs({ info: !info })} className="hidden lg:grid">
                <Info size={17} />
              </BarButton>
            ) : null}
          </div>
        </div>

        {/* The picture or clip */}
        <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
          {size.w > 0 ? (
            take.kind === "image" ? (
              <Still key={take.key} ref={media} take={take} box={size} pad={pad} onZoom={setZoom} onSwipe={(d) => go(index + d)} />
            ) : (
              <ClipPlayer key={take.key} ref={media} take={take} box={size} pad={pad} controls={controlsHost} onToggleFull={toggleFull} onSwipe={(d) => go(index + d)} />
            )
          ) : null}
          {settling ? <div aria-hidden="true" className="absolute inset-0 z-20" /> : null}
          <NavArrow side="left" hidden={index === 0} onClick={() => go(index - 1)} className={chrome} />
          <NavArrow side="right" hidden={index === takes.length - 1} onClick={() => go(index + 1)} className={chrome} />
        </div>

        {/* Clip controls and the strip of takes */}
        <div className={cn("z-10 shrink-0", full && "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent pt-10", chrome)}>
          <div ref={setControlsHost} />
          <Filmstrip takes={takes} index={index} onGo={go} />
        </div>
      </div>

      <InfoPanel
        take={take}
        folders={folders}
        newColor={newColor}
        onMove={onMove}
        onCreateAndMove={onCreateAndMove}
        onDelete={onDelete}
        onContinue={onContinue}
        onUsePrompt={onUsePrompt}
        className={cn(!info && "lg:hidden", full && "hidden")}
      />
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------------------------ */

/** Where a `w`×`h` picture sits, as big as fits in `box` with `pad` around it. */
function fit(box: Box, w: number, h: number, pad: number) {
  const scale = Math.max(0, Math.min((box.w - pad * 2) / w, (box.h - pad * 2) / h));
  return { scale, width: w * scale, height: h * scale };
}

/** The tile's own copy of a take, if it's on the page: it's decoded already, so it shows at once. */
function tileCopy(key: string, poster = false) {
  const el = document.querySelector<HTMLImageElement>(`[data-take="${CSS.escape(key)}"] img`);
  return el?.currentSrc && (!poster || el.currentSrc.includes("poster=1")) ? el.currentSrc : undefined;
}

/** A tap, a drag, or a swipe on a touch screen, told apart. */
function useGesture({ onTap, onSwipe, onDrag, onEnd }: { onTap: (e: PointerEvent) => void; onSwipe?: (dir: 1 | -1) => void; onDrag?: (dx: number, dy: number) => void; onEnd?: () => void }) {
  const start = useRef<{ x: number; y: number; lastX: number; lastY: number; id: number; moved: boolean } | null>(null);
  return {
    onPointerDown(e: ReactPointerEvent) {
      if (e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId, moved: false };
    },
    onPointerMove(e: ReactPointerEvent) {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 5) {
        s.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (s.moved) onDrag?.(e.clientX - s.lastX, e.clientY - s.lastY);
      s.lastX = e.clientX;
      s.lastY = e.clientY;
    },
    onPointerUp(e: ReactPointerEvent) {
      const s = start.current;
      start.current = null;
      onEnd?.();
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.moved) return onTap(e.nativeEvent);
      if (e.pointerType !== "mouse" && onSwipe && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) onSwipe(dx < 0 ? 1 : -1);
    },
    onPointerCancel() {
      start.current = null;
      onEnd?.();
    },
  };
}

/**
 * A picture, fit to the stage, that zooms to its real pixels and beyond: click (or Z) to zoom where
 * you point and back, the wheel to zoom smoothly, drag to look around. The light copy the grid
 * already had shows at once; the original replaces it as soon as it's loaded.
 */
function Still({
  ref,
  take,
  box,
  pad,
  onZoom,
  onSwipe,
}: {
  ref: Ref<MediaHandle | null>;
  take: Take;
  box: Box;
  pad: number;
  onZoom: (scale: number | null) => void;
  onSwipe: (dir: 1 | -1) => void;
}) {
  const output = take.gen.outputs[take.index]!;
  const surface = useRef<HTMLDivElement>(null);
  const [base] = useState(() => tileCopy(take.key) ?? previewUrl(output.url, 960));
  const [natural, setNatural] = useState(output.width && output.height ? { w: output.width, h: output.height } : null);
  const [sharp, setSharp] = useState(false);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);

  const nat = natural ?? { w: take.ratio * 1000, h: 1000 };
  const fs = fit(box, nat.w, nat.h, pad).scale;
  // Up to three times the real pixels, or four times the fit for a small picture.
  const maxZ = natural ? Math.max(4, 3 / fs) : 4;
  const scale = fs * view.z;
  const zoomed = view.z > 1;

  /** Keeps the picture covering the stage wherever it's bigger than it. */
  const clampView = (z: number, x: number, y: number) => {
    const mx = Math.max(0, (nat.w * fs * z - box.w) / 2);
    const my = Math.max(0, (nat.h * fs * z - box.h) / 2);
    return { z, x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  };
  /** Zooms by `factor`, keeping the point at (cx, cy) from the stage's center where it is. */
  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const z = Math.min(maxZ, Math.max(1, v.z * factor));
      if (Math.abs(z - v.z) < 1e-4) return v;
      if (z === 1) return { z: 1, x: 0, y: 0 };
      const k = z / v.z;
      return clampView(z, cx - (cx - v.x) * k, cy - (cy - v.y) * k);
    });
  /** To the real pixels where you point (twice the fit if it's shown smaller already), or back to fit. */
  const toggleAt = (cx: number, cy: number) =>
    setView((v) => {
      if (v.z > 1) return { z: 1, x: 0, y: 0 };
      const z = Math.min(maxZ, Math.max(2, 1 / fs));
      return clampView(z, cx - cx * z, cy - cy * z);
    });
  const fromCenter = (e: { clientX: number; clientY: number }) => {
    const r = surface.current?.getBoundingClientRect();
    return r ? ([e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const) : ([0, 0] as const);
  };

  useImperativeHandle(ref, () => ({ toggleZoom: () => toggleAt(0, 0), zoomBy: (f: number) => zoomAt(f, 0, 0) }));

  useEffect(() => {
    onZoom(zoomed && natural ? scale : null);
  }, [onZoom, zoomed, natural, scale]);
  useEffect(() => () => onZoom(null), [onZoom]);

  // The wheel zooms (it has to be a listener that can stop the page from scrolling instead).
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  useLayoutEffect(() => {
    wheel.current = (e) => {
      const [cx, cy] = fromCenter(e);
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.0025)), cx, cy);
    };
  });
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel.current(e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const gesture = useGesture({
    onTap: (e) => toggleAt(...fromCenter(e)),
    onSwipe: zoomed ? undefined : onSwipe,
    onDrag: (dx, dy) => {
      if (!zoomed) return;
      setGrabbing(true);
      setView((v) => clampView(v.z, v.x + dx, v.y + dy));
    },
    onEnd: () => setGrabbing(false),
  });

  const w = nat.w * scale;
  const h = nat.h * scale;
  const frame = { left: (box.w - w) / 2 + view.x, top: (box.h - h) / 2 + view.y, width: w, height: h };
  // Past three times the real pixels, show them as squares (for checking detail), not smoothed.
  const pixelated = Boolean(natural) && scale >= 3;
  return (
    <div
      ref={surface}
      {...gesture}
      className={cn("absolute inset-0 touch-none select-none", zoomed ? (grabbing ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in")}
    >
      <div className="absolute" style={frame}>
        <img src={base} alt="" draggable={false} className={cn("absolute inset-0 size-full", sharp && "invisible")} />
        <img
          src={output.url}
          alt={take.gen.prompt}
          draggable={false}
          decoding="async"
          onLoad={(e) => {
            const el = e.currentTarget;
            if (!natural && el.naturalWidth && el.naturalHeight) setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            setSharp(true);
          }}
          className={cn("absolute inset-0 size-full", sharp ? "opacity-100" : "opacity-0")}
          style={pixelated ? { imageRendering: "pixelated" } : undefined}
        />
      </div>
    </div>
  );
}

/**
 * A clip, fit to the stage and playing (with sound unless you muted it): click to pause,
 * double-click for full screen. Its controls are drawn under the stage (`controls`): play, the
 * time to a tenth, a scrubber, speed, loop and sound; Space, M, and , . to step a frame.
 */
function ClipPlayer({
  ref,
  take,
  box,
  pad,
  controls,
  onToggleFull,
  onSwipe,
}: {
  ref: Ref<MediaHandle | null>;
  take: Take;
  box: Box;
  pad: number;
  controls: HTMLElement | null;
  onToggleFull: () => void;
  onSwipe: (dir: 1 | -1) => void;
}) {
  const output = take.gen.outputs[take.index]!;
  const setPrefs = useLibraryPrefs((s) => s.set);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLInputElement>(null);
  const scrubbing = useRef(false);
  const [poster] = useState(() => tileCopy(take.key, true) ?? posterUrl(output.url, 960));
  const [natural, setNatural] = useState(output.width && output.height ? { w: output.width, h: output.height } : null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(output.duration ?? 0);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  const [rate, setRate] = useState(1);
  const fps = output.fps ?? 24;
  const nat = natural ?? { w: take.ratio * 1000, h: 1000 };
  const fitted = fit(box, nat.w, nat.h, pad);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let frame = 0;
    // The scrubber follows every frame while it plays; the numbers a few times a second.
    const paint = () => {
      const b = bar.current;
      if (b && v.duration) {
        if (!scrubbing.current) b.value = String(Math.round((v.currentTime / v.duration) * 1000));
        b.style.setProperty("--p", `${(v.currentTime / v.duration) * 100}%`);
      }
      frame = v.paused ? 0 : requestAnimationFrame(paint);
    };
    const sync = () => {
      setPlaying(!v.paused);
      setTime(v.currentTime);
      setMuted(v.muted);
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const events = ["play", "pause", "timeupdate", "seeked", "durationchange", "loadedmetadata", "volumechange"] as const;
    for (const ev of events) v.addEventListener(ev, sync);
    v.muted = useLibraryPrefs.getState().muted;
    // Sound needs a click on the page first; without one it plays muted.
    v.play().catch((err: Error) => {
      if (err.name !== "NotAllowedError") return;
      v.muted = true;
      void v.play().catch(() => {});
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const ev of events) v.removeEventListener(ev, sync);
      v.pause();
    };
  }, []);

  useEffect(() => {
    if (video.current) video.current.loop = loop;
  }, [loop]);
  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const toggleMute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    setPrefs({ muted: v.muted });
  };
  const step = (frames: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.min(Math.max(0, v.currentTime + frames / fps), Math.max(0, (v.duration || 0) - 0.001));
  };
  const seek = (value: number) => {
    const v = video.current;
    if (v?.duration) v.currentTime = (value / 1000) * v.duration;
  };

  useImperativeHandle(ref, () => ({ togglePlay, toggleMute, step }));

  const gesture = useGesture({ onTap: togglePlay, onSwipe });

  return (
    <>
      <video
        ref={video}
        src={output.url}
        poster={poster}
        playsInline
        loop
        preload="auto"
        {...gesture}
        onDoubleClick={onToggleFull}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (!natural && el.videoWidth && el.videoHeight) setNatural({ w: el.videoWidth, h: el.videoHeight });
        }}
        className="absolute touch-none bg-black"
        style={{ left: (box.w - fitted.width) / 2, top: (box.h - fitted.height) / 2, width: fitted.width, height: fitted.height }}
      />
      {controls
        ? createPortal(
            <div className="flex h-12 items-center gap-1.5 px-2.5 sm:gap-2 sm:px-4">
              <BarButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
                {playing ? <Pause size={17} fill="currentColor" strokeWidth={0} /> : <Play size={17} fill="currentColor" strokeWidth={0} />}
              </BarButton>
              <span className="tabular shrink-0 whitespace-nowrap font-mono text-[12px] text-fog">
                {precise(time)} <span className="text-haze">/ {precise(duration)}</span>
              </span>
              <input
                ref={bar}
                type="range"
                min={0}
                max={1000}
                step={1}
                defaultValue={0}
                aria-label="Seek"
                onPointerDown={() => {
                  scrubbing.current = true;
                }}
                onPointerUp={() => {
                  scrubbing.current = false;
                }}
                onInput={(e) => seek(e.currentTarget.valueAsNumber)}
                className="clip-scrub min-w-0 flex-1"
              />
              <BarButton label="Playback speed" onClick={() => setRate((r) => (r === 1 ? 0.5 : r === 0.5 ? 0.25 : r === 0.25 ? 2 : 1))}>
                <span className="font-mono text-[11.5px] font-semibold">{rate}×</span>
              </BarButton>
              <BarButton label={loop ? "Looping" : "Plays once"} active={loop} onClick={() => setLoop((l) => !l)}>
                <Repeat size={16} />
              </BarButton>
              <BarButton label={muted ? "Sound off (M)" : "Sound on (M)"} onClick={toggleMute}>
                {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </BarButton>
            </div>,
            controls,
          )
        : null}
    </>
  );
}

/** "0:03.4": seconds to a tenth, for finding a moment. */
function precise(t: number) {
  const tenths = Math.floor(Math.max(0, t) * 10) % 10;
  return `${clock(t)}.${tenths}`;
}

/** Thumbnails keep their shape within limits, at the strip's height. */
const thumbWidth = (ratio: number) => Math.round(Math.min(92, Math.max(30, 44 * ratio)));
const THUMB_GAP = 6;
/** The strip draws the takes around this one in blocks, so a long folder stays light. */
const CHUNK = 40;

/** The takes around this one, to jump by sight. The one on show sits in the middle; the strip glides. */
function Filmstrip({ takes, index, onGo }: { takes: Take[]; index: number; onGo: (i: number) => void }) {
  if (takes.length < 2) return <div className="h-3" />;
  const chunk = Math.floor(index / CHUNK) * CHUNK;
  const from = Math.max(0, chunk - CHUNK);
  const list = takes.slice(from, Math.min(takes.length, chunk + CHUNK * 2));
  const widths = list.map((t) => thumbWidth(t.ratio));
  let shift = widths[index - from] / 2;
  for (let k = 0; k < index - from; k++) shift += widths[k] + THUMB_GAP;
  return (
    <div className="filmstrip relative h-[66px] overflow-hidden">
      {/* A new block starts without gliding from where the last one sat. */}
      <div
        key={from}
        className="absolute left-1/2 top-[10px] flex transition-transform duration-300 ease-[var(--ease-out-quint)]"
        style={{ gap: THUMB_GAP, transform: `translateX(${-shift}px)` }}
      >
        {list.map((t, k) => {
          const i = from + k;
          const o = t.gen.outputs[t.index];
          const src = o ? (t.kind === "video" ? posterUrl(o.url, 640) : previewUrl(o.url, 640)) : undefined;
          const here = i === index;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onGo(i)}
              aria-label={`Go to ${i + 1}`}
              aria-current={here || undefined}
              className={cn(
                "press squircle relative h-[44px] shrink-0 overflow-hidden rounded-[8px] bg-apple",
                here ? "opacity-100 shadow-[0_0_0_2px_var(--color-spike)]" : "opacity-45 hover:opacity-90",
              )}
              style={{ width: widths[k] }}
            >
              {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" /> : null}
              {t.kind === "video" ? <Play size={8} fill="currentColor" strokeWidth={0} className="absolute bottom-1 left-1 text-paper drop-shadow" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavArrow({ side, hidden, onClick, className }: { side: "left" | "right"; hidden: boolean; onClick: () => void; className?: string }) {
  if (hidden) return null;
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous (←)" : "Next (→)"}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      className={cn(
        "press absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-paper shadow-[0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-black/75",
        side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4",
        className,
      )}
    >
      <Icon size={20} />
    </button>
  );
}

function BarButton({ label, onClick, active, className, children }: { label: string; onClick: () => void; active?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "press squircle grid size-9 shrink-0 place-items-center rounded-[11px]",
        active ? "bg-white/[0.1] text-paper" : "text-fog hover:bg-white/[0.07] hover:text-paper",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------------------------ */

/** Everything about the take on show, and what to do with it. */
function InfoPanel({
  take,
  folders,
  newColor,
  onMove,
  onCreateAndMove,
  onDelete,
  onContinue,
  onUsePrompt,
  className,
}: Pick<ViewerProps, "folders" | "newColor" | "onMove" | "onCreateAndMove" | "onDelete" | "onContinue" | "onUsePrompt"> & { take: Take; className?: string }) {
  const g = take.gen;
  const o = g.outputs[take.index];
  const icon = toolIcon(take.tool);
  const sent = g.compiledPrompt?.trim();
  const differs = Boolean(sent) && sent !== g.prompt.trim();
  const [showSent, setShowSent] = useState(false);
  const folder = folders.find((f) => f.id === take.folder) ?? folders[0];
  const made = new Date(g.createdAt);
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(o?.url ?? "")?.[1]?.toUpperCase();

  return (
    // On a phone it runs on below the stage (the whole viewer scrolls) with Download kept in reach.
    <aside aria-label="Details" className={cn("flex shrink-0 flex-col bg-flat lg:min-h-0 lg:w-[384px] lg:shadow-[inset_1px_0_0_var(--color-line)]", className)}>
      <header className="flex items-center gap-3 px-5 pb-4 pt-5">
        <AppIcon glyph={icon.glyph} hue={icon.hue} size={36} />
        <div className="min-w-0">
          <p className="truncate text-[15.5px] font-semibold leading-tight">{toolName(take.tool)}</p>
          <p className="mt-1 truncate text-[12.5px] text-haze">
            {take.kind === "video" ? "Clip" : "Image"} · {made.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
      </header>

      <div className="scroll-thin px-5 pb-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
        <Section label="Prompt" action={g.prompt || sent ? <CopyButton text={g.prompt || sent!} /> : null}>
          {g.prompt ? (
            <p className="select-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-paper/90">{g.prompt}</p>
          ) : (
            <p className="text-[14px] italic text-haze">No words: made from references{sent ? " (what the model was sent is below)" : ""}.</p>
          )}
          {differs ? (
            <>
              <button
                type="button"
                onClick={() => setShowSent((s) => !s)}
                aria-expanded={showSent}
                className="press mt-3 inline-flex h-7 items-center gap-1 rounded-[9px] pl-0.5 pr-2 text-[12.5px] font-semibold text-fog hover:text-paper"
              >
                <ChevronDown size={14} className={cn("transition-transform duration-200", showSent && "rotate-180")} />
                {showSent ? "Hide" : "Show"} what the model was sent
              </button>
              {showSent ? (
                <div className="squircle relative mt-2 rounded-[14px] bg-white/[0.035] p-3.5 pr-11 shadow-[inset_0_0_0_1px_var(--color-line)]">
                  <p className="select-text whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fog">{sent}</p>
                  <span className="absolute right-2 top-2">
                    <CopyButton text={sent!} small />
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </Section>

        <Section label="Details">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-[13px]">
            {g.modelName ? <Detail term="Model">{g.modelName}</Detail> : null}
            {o?.width && o?.height ? (
              <Detail term="Size">
                <span className="tabular">
                  {o.width.toLocaleString()} × {o.height.toLocaleString()}
                </span>
              </Detail>
            ) : null}
            <Detail term="Shape">
              <span className="inline-flex items-center gap-1.5">
                <AspectGlyph id={g.aspect} /> {g.aspect}
              </span>
            </Detail>
            {take.kind === "video" && o?.duration ? (
              <Detail term="Length">
                <span className="tabular">
                  {o.duration < 60 ? `${o.duration.toFixed(1)} s` : precise(o.duration)}
                  {o.fps ? ` · ${o.fps} fps` : ""}
                </span>
              </Detail>
            ) : null}
            {o?.bytes ? (
              <Detail term="File">
                <span className="tabular">
                  {ext ? `${ext} · ` : ""}
                  {fileSize(o.bytes)}
                </span>
              </Detail>
            ) : null}
            {g.finishedAt && g.finishedAt > g.createdAt ? <Detail term="Took">{span(g.finishedAt - g.createdAt)}</Detail> : null}
            {g.outputs.length > 1 ? (
              <Detail term="Take">
                <span className="tabular">
                  {take.index + 1} of {g.outputs.length}
                </span>
              </Detail>
            ) : null}
          </dl>
        </Section>

        <HowItWasMade gen={g} />

        <Section label="Folder">
          <Popover
            placement="bottom-start"
            className="w-full"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={id}
                data-popover-open={open || undefined}
                className="press squircle flex h-11 w-full items-center gap-2.5 rounded-[13px] bg-white/[0.035] pl-2 pr-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]"
              >
                <ProjectIcon icon={folder.icon} color={folder.color} size={28} tile />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{folder.name}</span>
                <span className="text-[12.5px] font-semibold text-haze">Move</span>
                <ChevronDown size={15} className="text-haze" />
              </button>
            )}
          >
            {(close) => (
              <MoveMenu
                folders={folders}
                current={take.folder}
                count={1}
                close={close}
                newColor={newColor}
                onMove={(id) => onMove(take, id)}
                onCreate={(input) => onCreateAndMove(take, input)}
              />
            )}
          </Popover>
        </Section>

        {take.kind === "image" ? (
          <Section label="Keep going">
            <div className="grid grid-cols-5 gap-1.5">
              {NEXT_STEPS.map((s) => (
                <button
                  key={s.href}
                  type="button"
                  onClick={() => onContinue(take, s.href)}
                  title={s.label === "Animate" ? "Make a clip that starts on this image" : `Open this image in ${s.label}`}
                  className="press squircle flex flex-col items-center gap-1.5 rounded-[13px] px-1 py-2.5 text-[11.5px] font-semibold text-fog hover:bg-white/[0.05] hover:text-paper"
                >
                  <AppIcon glyph={s.glyph} hue={s.hue} size={30} />
                  {s.label}
                </button>
              ))}
            </div>
            {g.prompt ? (
              <button
                type="button"
                onClick={() => onUsePrompt(take)}
                className="press squircle mt-2 inline-flex h-10 w-full items-center justify-center gap-2 rounded-[13px] bg-white/[0.05] text-[13px] font-semibold text-paper hover:bg-white/[0.09]"
              >
                <CornerUpLeft size={15} /> Start a new image from this prompt
              </button>
            ) : null}
          </Section>
        ) : null}

        <p className="mt-8 hidden flex-wrap gap-x-3.5 gap-y-2 text-[11.5px] text-haze lg:flex">
          <Hint keys={["←", "→"]}>browse</Hint>
          {take.kind === "image" ? <Hint keys={["Z"]}>zoom</Hint> : <Hint keys={["Space"]}>play</Hint>}
          {take.kind === "video" ? <Hint keys={[",", "."]}>frame</Hint> : null}
          <Hint keys={["F"]}>full screen</Hint>
          <Hint keys={["I"]}>details</Hint>
          <Hint keys={["Esc"]}>close</Hint>
        </p>
      </div>

      <footer className="sticky bottom-0 flex items-center gap-2 bg-flat px-5 pb-5 pt-3 shadow-[inset_0_1px_0_var(--color-line)] lg:static">
        {o ? (
          <button
            type="button"
            onClick={() => download(o.url, downloadName(take))}
            className="press squircle inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[14px] bg-paper text-[14px] font-semibold text-[#16131b] hover:bg-white"
          >
            <Download size={16} /> Download
          </button>
        ) : null}
        <DeleteButton count={g.outputs.length} onDelete={() => onDelete(take)} key={take.key} />
      </footer>
    </aside>
  );
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-1">
      <div className="mb-2.5 flex h-7 items-center justify-between gap-3">
        <h3 className="label">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-haze">{term}</dt>
      <dd className="min-w-0 break-words text-paper/90">{children}</dd>
    </>
  );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="inline-grid h-5 min-w-5 place-items-center rounded-[5px] bg-white/[0.07] px-1 font-mono text-[10.5px] text-fog shadow-[inset_0_-1px_0_rgb(255_255_255/0.06)]">
          {k}
        </kbd>
      ))}
      <span className="ml-0.5">{children}</span>
    </span>
  );
}

function CopyButton({ text, small }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy"}
      className={cn(
        "press squircle inline-flex items-center gap-1.5 rounded-[9px] font-semibold text-fog hover:bg-white/[0.07] hover:text-paper",
        small ? "size-7 justify-center" : "h-7 px-2 text-[12px]",
      )}
    >
      {copied ? <Check size={14} className="text-chroma" /> : <Copy size={14} />}
      {small ? null : copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Two clicks to delete: the first arms it for a moment, so a stray click never loses a take. */
function DeleteButton({ count, onDelete }: { count: number; onDelete: () => void }) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const label = arming ? (count > 1 ? `Delete all ${count} takes of this run?` : "Click again to delete") : "Delete";
  return (
    <button
      type="button"
      onClick={() => {
        if (arming) return onDelete();
        setArming(true);
        clearTimeout(disarm.current);
        disarm.current = setTimeout(() => setArming(false), 3000);
      }}
      title={label}
      aria-label={label}
      className={cn(
        "press squircle inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[14px] text-[13px] font-semibold",
        arming ? "bg-tally px-3.5 text-white" : "w-11 bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper",
      )}
    >
      <Trash size={16} />
      {arming ? (count > 1 ? `Delete ${count}?` : "Delete?") : null}
    </button>
  );
}
