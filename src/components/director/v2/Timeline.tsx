"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightToLine,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  Diamond,
  Film,
  Focus,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Trash2,
  Video,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { pause, togglePlay, useDirector, usePlayhead } from "@/lib/director/store";
import {
  CAMERA_MOVES,
  EASES,
  MAX_SECONDS,
  MIN_SECONDS,
  allKeyTimes,
  hasKeys,
  nextKeyTime,
  prevKeyTime,
  selectionEase,
  timecode,
  type CameraKey,
  type CameraMoveKind,
  type Ease,
  type ElementKey,
  type KeySelection,
  type Timeline as Shot,
} from "@/lib/director/timeline";
import { useTakeView } from "../take-view";
import { useVideoStrip } from "./video-strip";
import { useFilmedSeconds } from "./VideoMode";
import { cn } from "@/lib/cn";

/** Width of the names column (px). */
const NAMES = 148;
/** Room at both ends of a track, so keys on the first and last frames are whole and easy to grab (px). */
const INSET = 10;
const ROW = 24;
const NO_KEYS: never[] = [];
/** Mounted timeline bars, newest last: the newest alone hears the keyboard. */
const keyOwners: symbol[] = [];

/** Where frame-share `f` (0…1) sits across a track: a CSS length. */
const across = (f: number) => `calc(${INSET}px + (100% - ${2 * INSET}px) * ${f})`;

const MOVE_ICONS: Record<CameraMoveKind, LucideIcon> = {
  "push-in": ZoomIn,
  "pull-out": ZoomOut,
  "orbit-left": RotateCcw,
  "orbit-right": RotateCw,
  "crane-up": MoveUp,
  "crane-down": MoveDown,
  "truck-left": MoveLeft,
  "truck-right": MoveRight,
  "tilt-up": ChevronsUp,
  "tilt-down": ChevronsDown,
  "dolly-zoom": Focus,
};

/* A picked key: "c|<frame>" on the camera's lane, "e|<element id>|<frame>" on an element's. */
const camRef = (t: number) => `c|${t}`;
const elRef = (id: string, t: number) => `e|${id}|${t}`;
function parseRef(ref: string): { lane: string | null; t: number } {
  const parts = ref.split("|");
  return parts[0] === "c" ? { lane: null, t: Number(parts[1]) } : { lane: parts[1], t: Number(parts[2]) };
}
const shiftRef = (ref: string, dt: number) => {
  const { lane, t } = parseRef(ref);
  return lane === null ? camRef(t + dt) : elRef(lane, t + dt);
};
function toSelection(refs: Iterable<string>): KeySelection {
  const camera: number[] = [];
  const elements: Record<string, number[]> = {};
  for (const r of refs) {
    const { lane, t } = parseRef(r);
    if (lane === null) camera.push(t);
    else (elements[lane] ??= []).push(t);
  }
  return { camera, elements };
}

/**
 * The shot's timeline, under the stage. A still (no keys) is one slim row: key the camera, or pick a camera move. With
 * keys it opens into transport, a ruler to scrub (the only thing that moves the playhead), the camera's row and a row
 * for every keyed element (and the picked one, to key it), its keys picked, dragged and deleted there, and how the
 * picked keys move on (Ease · Smooth · Linear · Cut · In · Out).
 */
export function Timeline({ className }: { className?: string }) {
  const keyed = useDirector((s) => hasKeys(s.scene.timeline));
  // Video mode: the bar is open from the start (the video plays and scrubs before there's a key).
  const video = useDirector((s) => Boolean(s.scene.place.video && s.scene.timeline));
  // Leaving the Director stops playback.
  useEffect(() => () => pause(), []);
  return keyed || video ? <TimelineBar className={className} /> : <StillBar className={className} />;
}

const BAR = "surface squircle rounded-[16px] select-none";

function StillBar({ className }: { className?: string }) {
  return (
    <div role="toolbar" aria-label="Shot timeline" className={cn(BAR, "flex h-11 items-center gap-2 px-2", className)}>
      <span className="label shrink-0 pl-1.5 pr-1" title="A still: one frame. Key the camera or pick a camera move to make it a moving shot.">
        Still
      </span>
      <button
        type="button"
        onClick={() => useDirector.getState().keyCamera()}
        title="Start a camera move: keys the camera here"
        className="press squircle inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper"
      >
        <Diamond size={13} />
        Key the camera
      </button>
      <MovesMenu />
    </div>
  );
}

function TimelineBar({ className }: { className?: string }) {
  const tl = useDirector((s) => s.scene.timeline);
  const lanes = tl?.elements;
  const selectedId = useDirector((s) => s.selectedId);
  // Names only: a frame of playback moves elements, which mustn't redraw the rows.
  const names = useDirector(useShallow((s) => s.scene.elements.map((e) => `${e.id}\u0001${e.name}`)));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(() => {
    const list = names.map((s) => {
      const i = s.indexOf("\u0001");
      return { id: s.slice(0, i), name: s.slice(i + 1).trim() || "Untitled" };
    });
    const keyed = list.filter((e) => lanes?.[e.id]?.length);
    // The picked element gets a row to key it, last, so the keyed rows never move.
    const extra = selectedId && !lanes?.[selectedId]?.length ? list.find((e) => e.id === selectedId) : undefined;
    return extra ? [...keyed, extra] : keyed;
  }, [names, lanes, selectedId]);

  // Picks of keys that are gone (deleted, undone) drop out.
  const live = useMemo(() => {
    const out = new Set<string>();
    if (!tl) return out;
    for (const r of picked) {
      const { lane, t } = parseRef(r);
      const keys: readonly { t: number }[] | undefined = lane === null ? tl.camera : tl.elements[lane];
      if (keys?.some((k) => k.t === t)) out.add(r);
    }
    return out;
  }, [picked, tl]);
  const selection = useMemo(() => toSelection(live), [live]);
  const ease = useMemo(() => (tl && live.size ? selectionEase(tl, selection) : null), [tl, live, selection]);
  // Picked frames per row ("" = the camera's), as plain text so a row redraws only when its own picks change.
  const pickedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of live) {
      const { lane, t } = parseRef(r);
      const k = lane ?? "";
      m.set(k, m.has(k) ? `${m.get(k)},${t}` : String(t));
    }
    return m;
  }, [live]);

  const liveRef = useRef(live);
  useLayoutEffect(() => {
    liveRef.current = live;
  });

  // Dragging picked keys: from the timeline the drag started on, so a key passed over comes back. One undo step. A
  // press on a key already picked keeps the others for the drag; let go without moving, it alone stays picked.
  const drag = useRef<{ refs: string[]; base: Shot; x: number; perFrame: number; moved: boolean; last: number; pointer: number; alone: string | null } | null>(null);

  const onKeyDown = useCallback((ref: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const base = useDirector.getState().scene.timeline;
    if (!base) return;
    const now = liveRef.current;
    let next: Set<string>;
    if (e.shiftKey) {
      next = new Set(now);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
    } else next = now.has(ref) ? new Set(now) : new Set([ref]);
    setPicked(next);
    if (!next.has(ref)) return;
    const track = e.currentTarget.closest<HTMLElement>("[data-track]");
    const width = (track?.getBoundingClientRect().width ?? 600) - 2 * INSET;
    drag.current = {
      refs: [...next],
      base,
      x: e.clientX,
      perFrame: Math.max(0.25, width / Math.max(1, base.length)),
      moved: false,
      last: 0,
      pointer: e.pointerId,
      alone: !e.shiftKey && next.size > 1 ? ref : null,
    };
  }, []);

  const onBackground = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button === 0 && !e.shiftKey) setPicked((p) => (p.size ? new Set() : p));
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointer) return;
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x) < 3) return;
        d.moved = true;
        useDirector.getState().checkpoint();
      }
      const df = Math.round((e.clientX - d.x) / d.perFrame);
      if (df === d.last) return;
      d.last = df;
      const went = useDirector.getState().moveKeys(toSelection(d.refs), df, true, d.base);
      setPicked(new Set(d.refs.map((r) => shiftRef(r, went))));
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (d?.pointer !== e.pointerId) return;
      drag.current = null;
      if (!d.moved && d.alone && e.type === "pointerup") setPicked(new Set([d.alone]));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // Space plays and pauses wherever the focus is (but in a text field, or with a dialog or a take open); Delete takes
  // away the picked keys (before anything else hears it, so the picked element stays); Escape lets go of them. Only
  // the newest bar on the page listens: two (a hidden copy for a narrow layout) would toggle twice and cancel out.
  useEffect(() => {
    const me = Symbol("timeline");
    keyOwners.push(me);
    const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
    const elsewhere = () => keyOwners[keyOwners.length - 1] !== me || !!useTakeView.getState().viewing || !!document.querySelector("[aria-modal='true']");
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || elsewhere()) return;
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) togglePlay();
        return;
      }
      const sel = liveRef.current;
      if (!sel.size) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        drag.current = null;
        useDirector.getState().deleteKeys(toSelection(sel));
        setPicked(new Set());
      } else if (e.key === "Escape") {
        e.stopPropagation();
        setPicked(new Set());
      }
    };
    // A focused button would also be pressed by the Space that let go of it.
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !elsewhere()) e.preventDefault();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      keyOwners.splice(keyOwners.indexOf(me), 1);
    };
  }, []);

  if (!tl) return null;
  const hasPicks = live.size > 0;

  return (
    <div role="region" aria-label="Shot timeline" className={cn(BAR, "flex h-[150px] flex-col gap-1.5 p-2", className)}>
      <div className="scrollbar-none flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto">
        <Transport tl={tl} />
        <Clock fps={tl.fps} />
        <LengthField length={tl.length} fps={tl.fps} />
        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-white/[0.08]" />
        <EaseStrip value={ease} disabled={!hasPicks} onPick={(e) => useDirector.getState().setKeysEase(selection, e)} />
        <span className="min-w-2 flex-1" />
        <MovesMenu />
        <button
          type="button"
          onClick={() => useDirector.getState().clearTimeline()}
          title="Take every key away: the set is a still again, as it looks now (Undo brings them back)"
          className="press squircle inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper"
        >
          <Trash2 size={13} />
          Clear
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex h-[18px] shrink-0">
          <div className="shrink-0" style={{ width: NAMES }} />
          <Ruler length={tl.length} fps={tl.fps} />
        </div>
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <VideoLane length={tl.length} fps={tl.fps} />
          <KeyRow id={null} name="Camera" keys={tl.camera} length={tl.length} fps={tl.fps} picked={pickedBy.get("") ?? ""} selected={false} onKeyDown={onKeyDown} onBackground={onBackground} />
          {rows.map((r) => (
            <KeyRow
              key={r.id}
              id={r.id}
              name={r.name}
              keys={tl.elements[r.id] ?? NO_KEYS}
              length={tl.length}
              fps={tl.fps}
              picked={pickedBy.get(r.id) ?? ""}
              selected={r.id === selectedId}
              onKeyDown={onKeyDown}
              onBackground={onBackground}
            />
          ))}
        </div>
        <PlayheadLine length={tl.length} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- transport ----------------------------------------- */

function IconButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // Disabled the soft way, so its tooltip still says why.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "press squircle grid size-7 shrink-0 place-items-center rounded-[9px]",
        disabled ? "cursor-default opacity-30" : active ? "bg-white/[0.12] text-paper" : "text-fog hover:bg-white/[0.06] hover:text-paper",
      )}
    >
      {children}
    </button>
  );
}

function Transport({ tl }: { tl: Shot }) {
  const playing = usePlayhead((s) => s.playing);
  const loop = usePlayhead((s) => s.loop);
  const times = useMemo(() => allKeyTimes(tl), [tl]);
  const prev = usePlayhead((s) => prevKeyTime(times, s.frame));
  const next = usePlayhead((s) => nextKeyTime(times, s.frame));
  const go = (f: number | null) => {
    if (f === null) return;
    pause();
    useDirector.getState().seek(f);
  };
  return (
    <div role="group" aria-label="Playback" className="squircle flex shrink-0 items-center gap-0.5 rounded-[11px] bg-white/[0.04] p-0.5">
      <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay} active={playing}>
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </IconButton>
      <IconButton label={prev === null ? "No key before the playhead" : "Back to the key before"} disabled={prev === null} onClick={() => go(prev)}>
        <SkipBack size={14} />
      </IconButton>
      <IconButton label={next === null ? "No key after the playhead" : "On to the next key"} disabled={next === null} onClick={() => go(next)}>
        <SkipForward size={14} />
      </IconButton>
      <IconButton
        label={loop ? "Loop on: plays round and round (click to stop at the end)" : "Loop off: stops at the end (click to loop)"}
        onClick={() => usePlayhead.setState((s) => ({ loop: !s.loop }))}
      >
        {loop ? <Repeat size={14} /> : <ArrowRightToLine size={14} />}
      </IconButton>
    </div>
  );
}

function Clock({ fps }: { fps: number }) {
  const frame = usePlayhead((s) => s.frame);
  return (
    <span className="tabular w-[64px] shrink-0 text-center font-mono text-[12.5px] text-paper" title="Where the playhead is: minutes:seconds.frame">
      {timecode(frame, fps)}
    </span>
  );
}

/** The shot's length in seconds: set on Enter or leaving the field (not on each key, which would cut keys at "1" of "12"). */
function LengthField({ length, fps }: { length: number; fps: number }) {
  const seconds = length / fps;
  const shown = String(Math.round(seconds * 100) / 100);
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  const set = (s: number) => {
    if (!Number.isFinite(s)) return;
    const clamped = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s));
    useDirector.getState().setTimeline({ length: Math.round(clamped * fps) });
  };
  return (
    <label
      title={`How long the shot is, ${MIN_SECONDS} to ${MAX_SECONDS} seconds (↑ ↓ change it by a second). Keys past a shorter end move onto it.`}
      className="field-focus squircle flex h-8 w-[66px] shrink-0 items-center gap-0.5 rounded-[10px] bg-white/[0.04] pl-2 pr-2"
    >
      <input
        value={draft ?? shown}
        inputMode="decimal"
        aria-label="Shot length in seconds"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (skip.current) skip.current = false;
          else if (draft !== null) set(parseFloat(draft.replace(",", ".")));
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            skip.current = true;
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const from = draft !== null ? parseFloat(draft.replace(",", ".")) : seconds;
            set(Math.round(Number.isFinite(from) ? from : seconds) + (e.key === "ArrowUp" ? 1 : -1));
            setDraft(null);
          }
        }}
        className="tabular w-full min-w-0 bg-transparent text-right font-mono text-[12.5px] text-paper outline-none"
      />
      <span className="text-[12px] text-haze">s</span>
    </label>
  );
}

function EaseStrip({ value, disabled, onPick }: { value: Ease | "mixed" | null; disabled: boolean; onPick: (e: Ease) => void }) {
  return (
    <div role="group" aria-label="How the picked keys move on" className="squircle flex shrink-0 items-center gap-0.5 rounded-[11px] bg-white/[0.04] p-0.5">
      {EASES.map((e) => (
        <button
          key={e.id}
          type="button"
          aria-pressed={!disabled && value === e.id}
          aria-disabled={disabled || undefined}
          title={disabled ? "Pick keys first (click a ◆, Shift-click for more) to change how they move" : value === "mixed" ? `${e.plain}. The picked keys move in different ways now.` : e.plain}
          onClick={disabled ? undefined : () => onPick(e.id)}
          className={cn(
            "press squircle h-7 shrink-0 rounded-[9px] px-2 text-[12px] font-semibold",
            disabled ? "cursor-default text-haze/45" : value === e.id ? "bg-white/[0.12] text-spike" : "text-fog hover:bg-white/[0.06] hover:text-paper",
          )}
        >
          {e.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- camera moves -------------------------------------- */

function MovesMenu() {
  const [at, setAt] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = at !== null;

  const toggle = () => {
    if (open || !button.current) return setAt(null);
    const r = button.current.getBoundingClientRect();
    const width = 236;
    const height = CAMERA_MOVES.length * 34 + 12;
    const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
    // Above the bar when it fits (the stage is up there), else below.
    setAt(r.top - 8 >= height || r.top > window.innerHeight - r.bottom ? { left, bottom: window.innerHeight - r.top + 6, width, maxHeight: r.top - 12 } : { left, top: r.bottom + 6, width, maxHeight: window.innerHeight - r.bottom - 12 });
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setAt(null);
      button.current?.focus();
    };
    const close = () => setAt(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  const pick = (kind: CameraMoveKind) => {
    setAt(null);
    useDirector.getState().applyCameraMove(kind);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="A ready-made camera move over the whole shot, from the camera as it is now (it replaces the camera's keys)"
        className={cn(
          "press squircle inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-semibold",
          open ? "bg-white/[0.12] text-paper" : "text-fog hover:bg-white/[0.06] hover:text-paper",
        )}
      >
        Camera moves
        <ChevronDown size={14} className={cn("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              aria-label="Camera moves"
              style={at}
              className="squircle scroll-thin fixed z-[80] overflow-y-auto overscroll-contain rounded-[16px] bg-apple-2 p-1.5 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_40px_-8px_rgb(0_0_0/0.6)]"
            >
              {CAMERA_MOVES.map((m) => {
                const Icon = MOVE_ICONS[m.id];
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitem"
                    title={m.plain}
                    onClick={() => pick(m.id)}
                    className="squircle flex h-[34px] w-full items-center gap-2.5 rounded-[11px] px-2 text-left text-[12.5px] font-semibold text-fog hover:bg-gaffer hover:text-paper focus-visible:bg-gaffer"
                  >
                    <Icon size={15} className="shrink-0 text-haze" />
                    <span className="truncate">{m.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ---------------------------------------------------------------- ruler and rows ------------------------------------ */

/** Seconds along the shot. Pressing or dragging on it moves the playhead (and stops playback); it never makes an undo step. */
function Ruler({ length, fps }: { length: number; fps: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const scrub = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWidth(el.clientWidth);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, []);

  const frameAt = (x: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return 0;
    const f = (x - r.left - INSET) / Math.max(1, r.width - 2 * INSET);
    return Math.round(Math.min(1, Math.max(0, f)) * length);
  };
  // At most one seek per screen refresh, however fast the pointer reports.
  const seekSoon = (frame: number) => {
    pending.current = frame;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const f = pending.current;
      pending.current = null;
      if (f !== null) useDirector.getState().seek(f);
    });
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub.current !== e.pointerId) return;
    scrub.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    if (pending.current !== null) useDirector.getState().seek(pending.current);
    pending.current = null;
  };

  const seconds = length / fps;
  const perSecond = (width - 2 * INSET) / Math.max(seconds, 1e-6);
  const every = perSecond >= 34 ? 1 : perSecond >= 17 ? 2 : 5;
  const ticks: number[] = [];
  for (let s = 0; s <= seconds + 1e-9; s++) ticks.push(s);

  return (
    <div
      ref={box}
      title="Drag to look through the shot"
      className="relative min-w-0 flex-1 cursor-col-resize touch-none overflow-hidden rounded-[6px] bg-white/[0.03]"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        pause();
        scrub.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        useDirector.getState().seek(frameAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (scrub.current === e.pointerId) seekSoon(frameAt(e.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      {ticks.map((s) => (
        <span key={s} className="pointer-events-none absolute bottom-0 top-0" style={{ left: across(Math.min(1, (s * fps) / length)) }}>
          <span className={cn("absolute bottom-0 w-px", s % every === 0 ? "h-[7px] bg-white/30" : "h-[4px] bg-white/15")} />
          {s % every === 0 ? <span className="tabular absolute left-1 top-[1px] font-mono text-[9.5px] leading-none text-haze">{s}s</span> : null}
        </span>
      ))}
    </div>
  );
}

function PlayheadLine({ length }: { length: number }) {
  const frame = usePlayhead((s) => s.frame);
  const f = Math.min(1, Math.max(0, frame / Math.max(1, length)));
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-0" style={{ left: `calc(${NAMES + INSET}px + (100% - ${NAMES + 2 * INSET}px) * ${f})` }}>
      <div className="absolute -left-[5px] top-0 h-[7px] w-[10px] rounded-b-[3px] bg-spike" />
      <div className="absolute bottom-0 top-0 -left-px w-[2px] rounded-full bg-spike/90" />
    </div>
  );
}

type AnyKey = CameraKey | ElementKey;
const valueOf = (k: AnyKey): object => ("cam" in k ? k.cam : k.v);
const easeName = (e: Ease) => EASES.find((x) => x.id === e)?.label ?? "Ease";

/** Stable ids for key values: a moved or re-eased key keeps its mark, a recorded one gets a new mark (and flashes). */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: object) {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}

const KeyRow = memo(function KeyRow({
  id,
  name,
  keys,
  length,
  fps,
  picked,
  selected,
  onKeyDown,
  onBackground,
}: {
  id: string | null;
  name: string;
  keys: readonly AnyKey[];
  length: number;
  fps: number;
  picked: string;
  selected: boolean;
  onKeyDown: (ref: string, e: ReactPointerEvent<HTMLElement>) => void;
  onBackground: (e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const seen = useRef<WeakSet<object> | null>(null);
  const pickedSet = useMemo(() => new Set(picked ? picked.split(",").map(Number) : []), [picked]);

  // A key just added or written (by hand or by the recording rule) flashes, so keying is never silent.
  useLayoutEffect(() => {
    const before = seen.current;
    const now = new WeakSet<object>();
    for (const k of keys) now.add(valueOf(k));
    seen.current = now;
    if (!before || !track.current) return;
    const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const k of keys) {
      if (before.has(valueOf(k))) continue;
      const ring = track.current.querySelector<HTMLElement>(`[data-k="${idOf(valueOf(k))}"] [data-flash]`);
      ring?.animate?.(
        calm ? [{ opacity: 0.9 }, { opacity: 0 }] : [{ opacity: 0.95, transform: "scale(0.5)" }, { opacity: 0, transform: "scale(2.1)" }],
        { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }, [keys]);

  const used = new Set<number>();
  return (
    <div className={cn("flex", selected && "bg-white/[0.035]")} style={{ height: ROW }}>
      <RowHead id={id} name={name} keys={keys} />
      <div ref={track} data-track="" className="relative min-w-0 flex-1" onPointerDown={onBackground}>
        {keys.slice(0, -1).map((k, i) => {
          const a = k.t / length;
          const b = keys[i + 1].t / length;
          return (
            <span
              key={`s${k.t}`}
              aria-hidden
              className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2", k.ease === "hold" ? "h-0 border-t border-dashed border-white/25" : "h-px bg-white/[0.16]")}
              style={{ left: across(a), width: `calc((100% - ${2 * INSET}px) * ${b - a})` }}
            />
          );
        })}
        {keys.map((k) => {
          const vid = idOf(valueOf(k));
          // Two keys can't share a value object, but if they ever did their marks still get their own React keys.
          const rk = used.has(vid) ? `${vid}@${k.t}` : String(vid);
          used.add(vid);
          const ref = id === null ? camRef(k.t) : elRef(id, k.t);
          return <KeyMark key={rk} k={vid} refId={ref} t={k.t} ease={k.ease} length={length} fps={fps} picked={pickedSet.has(k.t)} onKeyDown={onKeyDown} />;
        })}
      </div>
    </div>
  );
});

/**
 * Director video mode: the video's own frames along the timeline (what happens when), over the camera's row. Clicking it
 * puts the playhead there.
 */
function VideoLane({ length, fps }: { length: number; fps: number }) {
  const url = useDirector((s) => s.scene.place.video?.url);
  const frames = useVideoStrip(url, length / Math.max(1, fps), 12);
  // Past what Film it films (5 s for a final, 10 s for a draft) the frames are dimmed.
  const filmed = useFilmedSeconds() * fps;
  if (!url) return null;
  return (
    <div className="flex" style={{ height: 30 }}>
      <div className="flex shrink-0 items-center gap-1.5 pl-1.5 text-[12px] font-semibold text-fog" style={{ width: NAMES }}>
        <Film size={13} className="shrink-0 text-haze" />
        Video
      </div>
      <div
        className="relative min-w-0 flex-1 cursor-pointer"
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientX - r.left - INSET) / Math.max(1, r.width - 2 * INSET);
          pause();
          useDirector.getState().seek(Math.round(Math.min(1, Math.max(0, f)) * length));
        }}
      >
        <div className="absolute inset-y-[3px] flex overflow-hidden rounded-[6px] bg-white/[0.04]" style={{ left: INSET, right: INSET }}>
          {frames?.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-80" />
          ))}
        </div>
        {filmed < length ? (
          <div
            title={`Not filmed: Film it films the first ${Math.round(filmed / Math.max(1, fps))} s`}
            className="absolute inset-y-[3px] rounded-r-[6px] bg-[#0d0e11]/70"
            style={{ left: across(filmed / Math.max(1, length)), right: INSET }}
          />
        ) : null}
      </div>
    </div>
  );
}

function RowHead({ id, name, keys }: { id: string | null; name: string; keys: readonly AnyKey[] }) {
  const times = useMemo(() => new Set(keys.map((k) => k.t)), [keys]);
  const on = usePlayhead((s) => times.has(s.frame));
  const toggle = () => (id === null ? useDirector.getState().keyCamera() : useDirector.getState().keyElement(id));
  return (
    <div className="flex shrink-0 items-center gap-1 pl-1.5 pr-1" style={{ width: NAMES }}>
      {id === null ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold text-paper">
          <Video size={13} className="shrink-0 text-haze" />
          Camera
        </span>
      ) : (
        <button
          type="button"
          onClick={() => useDirector.getState().select(id)}
          title={`Pick ${name} on the set`}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-fog hover:text-paper"
        >
          {name}
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        title={on ? `Take away ${id === null ? "the camera's" : `${name}'s`} key here` : `Key ${id === null ? "the camera" : name} here, as ${id === null ? "it" : "they"} are now`}
        className={cn("press grid size-6 shrink-0 place-items-center rounded-[7px]", on ? "text-spike hover:bg-white/[0.06]" : "text-haze hover:bg-white/[0.06] hover:text-paper")}
      >
        <Diamond size={12} fill={on ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

const KeyMark = memo(function KeyMark({
  k,
  refId,
  t,
  ease,
  length,
  fps,
  picked,
  onKeyDown,
}: {
  k: number;
  refId: string;
  t: number;
  ease: Ease;
  length: number;
  fps: number;
  picked: boolean;
  onKeyDown: (ref: string, e: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-k={k}
      aria-pressed={picked}
      aria-label={`Key at ${timecode(t, fps)}`}
      title={`${timecode(t, fps)} · ${easeName(ease)} on to the next key. Drag to move, Shift-click to pick more, Delete to take away.`}
      onPointerDown={(e) => onKeyDown(refId, e)}
      className="group absolute top-0 z-[1] grid h-full w-[18px] -translate-x-1/2 cursor-grab touch-none place-items-center active:cursor-grabbing"
      style={{ left: across(t / length) }}
    >
      <span data-flash="" className="pointer-events-none absolute size-[16px] rounded-full bg-spike opacity-0" />
      <span
        className={cn(
          "relative size-[9px] shadow-[0_0_0_1.5px_rgb(13_14_17)] transition-transform duration-150 group-hover:scale-125",
          ease === "smooth" ? "rounded-full" : ease === "hold" ? "rounded-[1px]" : "rotate-45 rounded-[1.5px]",
          picked ? "bg-spike shadow-[0_0_0_1.5px_rgb(13_14_17),0_0_0_3px_rgb(255_91_46/0.35)]" : "bg-fog group-hover:bg-paper",
        )}
      />
    </button>
  );
});
