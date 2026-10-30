"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Crop, ImagePlus, LoaderCircle, Plus, Sparkles, TriangleAlert, X } from "lucide-react";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { ScrollRow } from "@/components/ui/ScrollRow";
import type { LocalRef } from "@/lib/hooks/use-uploads";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

/**
 * The pictures above the prompt, laid out like the shot: a clip's START → END frames, then its references, each with a tag
 * (what it's for, and the @word that mentions it in the prompt). It shows only once something is attached: a start frame
 * shows the frames, references show the references, both show both. Pictures drag between slots to change jobs; pointing
 * at one shows it bigger.
 */

export type ShotRole = "start" | "end" | "ref";

/** A picture in the strip: its job, its tag and the word that mentions it ("ref1"). */
export type ShotTile = { r: LocalRef; role: ShotRole; tag: string; token: string; unused?: boolean };

/** A frame being made on the spot (FrameMaker). */
export type Making = { progress?: number; stage?: string };

const MOVE = "application/x-crackio-picture";

const ROLE_NAME: Record<ShotRole, string> = { start: "Start frame", end: "End frame", ref: "Reference" };

/** A group's tray: frames in one, references in the other. */
const TRAY = "squircle rounded-[17px] bg-white/[0.035] p-1 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]";

export function ShotStrip({
  frames,
  refs,
  refsMax,
  endSlot,
  making,
  clipRatio,
  shape,
  roles,
  addSlot,
  onRemove,
  onMove,
}: {
  /** The clip's frames, or null when the model takes none (images, words-only clips). */
  frames: { start: ShotTile | null; end: ShotTile | null } | null;
  refs: ShotTile[];
  /** How many references the model takes; null while that isn't known. */
  refsMax: number | null;
  /** The model lands on an end frame: an empty end slot waits beside the start. */
  endSlot: boolean;
  making: Partial<Record<"start" | "end", Making>>;
  /** The clip's shape (width / height): an empty start frame, or one being made, is drawn in it. */
  clipRatio: number;
  /**
   * The start frame's shape against the clip's (`clip`, the shape picked): cropped to it, or the clip following the
   * frame's own (`picture`). One click flips it.
   */
  shape: { clip: string; clipRatio: number; picture: string; cropping: boolean; onToggle: () => void } | null;
  /** The jobs a picture can switch to from its tag. */
  roles: ShotRole[];
  /** The picker behind an empty slot (an end frame, one more reference). */
  addSlot: (role: ShotRole, trigger: (o: { open: boolean; toggle: () => void }) => ReactNode) => ReactNode;
  onRemove: (id: string) => void;
  /** A picture given another job (its tag, or dragged onto a slot), placed before the reference at `before`. */
  onMove: (id: string, role: ShotRole, before?: string) => void;
}) {
  const [hover, setHover] = useState<{ tile: ShotTile; rect: DOMRect } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A picture dropped into another group is drawn anew there, so its own dragend never comes: any drop ends the drag.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(null);
    window.addEventListener("drop", end, true);
    window.addEventListener("dragend", end, true);
    return () => {
      window.removeEventListener("drop", end, true);
      window.removeEventListener("dragend", end, true);
    };
  }, [dragging]);
  const showFrames = Boolean(frames && (frames.start || making.start || making.end));
  const showRefs = refs.length > 0;
  const frameRatio = (t: ShotTile | null) => (t?.r.width && t.r.height ? t.r.width / t.r.height : 1);
  const startRatio = frames?.start ? frameRatio(frames.start) : clipRatio;

  const tile = (t: ShotTile, kind: "frame" | "ref", before?: string) => (
    <Tile
      key={t.r.id}
      t={t}
      ratio={kind === "frame" ? frameRatio(t) : 1}
      roles={roles}
      dragging={dragging}
      cropTo={shape?.cropping && t.role !== "ref" ? shape.clipRatio : null}
      onDragState={setDragging}
      onHover={(rect) => setHover(rect ? { tile: t, rect } : null)}
      onRemove={() => onRemove(t.r.id)}
      onRole={(role) => onMove(t.r.id, role)}
      onDropHere={(id) => id !== t.r.id && onMove(id, t.role, t.role === "ref" ? (before ?? t.r.id) : undefined)}
    />
  );

  return (
    <ScrollRow trackClassName="items-end gap-2 px-1.5 pt-1">
      {showFrames && frames ? (
        <div role="group" className={cn("flex shrink-0 items-end gap-1.5", TRAY)} aria-label="Frames">
          {making.start ? (
            <MakingTile tag="START" ratio={clipRatio} making={making.start} />
          ) : frames.start ? (
            tile(frames.start, "frame")
          ) : (
            <Slot role="start" ratio={clipRatio} dragging={dragging} addSlot={addSlot} onDropHere={(id) => onMove(id, "start")} />
          )}
          {endSlot ? (
            <>
              <span aria-hidden="true" className="grid h-[68px] w-3 shrink-0 place-items-center text-haze">
                <ArrowRight size={13} />
              </span>
              {making.end ? (
                <MakingTile tag="END" ratio={startRatio} making={making.end} />
              ) : frames.end ? (
                tile(frames.end, "frame")
              ) : (
                <Slot
                  role="end"
                  ratio={startRatio}
                  ghost={frames.start ? thumb(frames.start.r.preview, 240) : undefined}
                  dragging={dragging}
                  addSlot={addSlot}
                  onDropHere={(id) => onMove(id, "end")}
                />
              )}
            </>
          ) : null}
          {shape ? (
            <button
              type="button"
              onClick={shape.onToggle}
              title={
                shape.cropping
                  ? `Your frames are ${shape.picture} and the clip ${shape.clip}, so they get cropped. Make the clip ${shape.picture} instead.`
                  : `The clip is made ${shape.picture}, like your start frame. Crop it to ${shape.clip} instead.`
              }
              className={cn(
                "press squircle flex h-[68px] shrink-0 flex-col items-start justify-center gap-0.5 whitespace-nowrap rounded-[13px] px-3 text-left",
                shape.cropping ? "bg-tungsten/[0.12] hover:bg-tungsten/[0.18]" : "bg-white/[0.05] hover:bg-white/[0.08]",
              )}
            >
              <span className={cn("flex items-center gap-1 text-[11px] font-semibold", shape.cropping ? "text-tungsten" : "text-haze")}>
                {shape.cropping ? <Crop size={11} /> : null}
                {shape.cropping ? `Cropped to ${shape.clip}` : `${shape.picture}, like the frame`}
              </span>
              <span className="text-[12.5px] font-semibold text-paper">{shape.cropping ? `Use ${shape.picture} →` : `Crop to ${shape.clip} →`}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {showRefs ? (
        <div role="group" className={cn("flex shrink-0 items-end gap-1.5", TRAY)} aria-label="References">
          {refs.map((t) => tile(t, "ref"))}
          {refs.length < (refsMax ?? 14) ? <Slot role="ref" ratio={1} dragging={dragging} addSlot={addSlot} onDropHere={(id) => onMove(id, "ref")} /> : null}
        </div>
      ) : null}

      {hover && !dragging ? <Preview tile={hover.tile} rect={hover.rect} /> : null}
    </ScrollRow>
  );
}

/** A light copy of a picture for the strip (uploads still on their way show their own preview). */
const thumb = (src: string, width: number) => (src.startsWith("blob:") ? src : previewUrl(src, width));

const frameWidth = (ratio: number) => Math.round(Math.max(44, Math.min(124, 68 * ratio)));

function Tile({
  t,
  ratio,
  roles,
  dragging,
  cropTo,
  onDragState,
  onHover,
  onRemove,
  onRole,
  onDropHere,
}: {
  t: ShotTile;
  ratio: number;
  roles: ShotRole[];
  dragging: string | null;
  /** The clip's shape (width / height) when the frame is cropped to it. */
  cropTo: number | null;
  onDragState: (id: string | null) => void;
  onHover: (rect: DOMRect | null) => void;
  onRemove: () => void;
  onRole: (role: ShotRole) => void;
  onDropHere: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  /** Pressed (its tag, ×, a drag): no bigger look until the pointer leaves. */
  const busy = useRef(false);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const r = t.r;
  return (
    <div
      ref={box}
      draggable={r.status === "ready"}
      onDragStart={(e) => {
        e.dataTransfer.setData(MOVE, r.id);
        e.dataTransfer.effectAllowed = "move";
        onHover(null);
        onDragState(r.id);
      }}
      onDragEnd={() => onDragState(null)}
      {...dropTarget(dragging, setOver, onDropHere)}
      onPointerEnter={() => {
        if (timer.current) clearTimeout(timer.current);
        if (!busy.current) timer.current = setTimeout(() => box.current && onHover(box.current.getBoundingClientRect()), 260);
      }}
      onPointerDown={() => {
        busy.current = true;
        if (timer.current) clearTimeout(timer.current);
        onHover(null);
      }}
      onPointerLeave={() => {
        busy.current = false;
        if (timer.current) clearTimeout(timer.current);
        onHover(null);
      }}
      className={cn("group relative shrink-0", dragging === r.id && "opacity-40")}
      style={{ width: frameWidth(ratio), height: 68 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumb(r.preview, 240)}
        alt={t.tag}
        draggable={false}
        className={cn(
          "squircle size-full cursor-grab rounded-[13px] object-cover shadow-[0_0_0_1px_var(--color-line-strong)] transition-[opacity,filter,box-shadow] duration-200 active:cursor-grabbing",
          r.status === "uploading" && "opacity-50",
          (r.status === "error" || t.unused) && "opacity-35 grayscale",
          over && "shadow-[0_0_0_2px_var(--color-spike)]",
        )}
      />
      {cropTo ? (
        // What the clip keeps of the frame: the rest is dimmed.
        <span aria-hidden="true" className="squircle pointer-events-none absolute inset-0 grid place-items-center overflow-hidden rounded-[13px]">
          <span
            className="rounded-[4px] shadow-[0_0_0_999px_rgb(0_0_0/0.55)] outline-dashed outline-[1.5px] outline-tungsten"
            style={cropTo > frameWidth(ratio) / 68 ? { width: "100%", aspectRatio: cropTo } : { height: "100%", aspectRatio: cropTo }}
          />
        </span>
      ) : null}
      <TagButton t={t} roles={roles} onRole={onRole} />
      {r.status === "uploading" ? <LoaderCircle size={18} className="pointer-events-none absolute inset-0 m-auto animate-spin text-paper" /> : null}
      {r.status === "error" ? <TriangleAlert size={16} className="pointer-events-none absolute inset-0 m-auto text-tally" aria-label={r.error} /> : null}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-paper text-[#16131b] opacity-0 shadow transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Remove ${t.tag.toLowerCase()}`}
      >
        <X size={12} strokeWidth={3} />
      </button>
    </div>
  );
}

/** The tag on a picture: what it's for. Where a picture can do more than one job, the tag switches it. */
function TagButton({ t, roles, onRole }: { t: ShotTile; roles: ShotRole[]; onRole: (role: ShotRole) => void }) {
  const tag = t.unused ? "Not used" : t.tag;
  const cls = "rounded-full bg-black/70 px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.08em] text-white";
  if (roles.length < 2)
    return <span className={cn("pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap", cls)}>{tag}</span>;
  return (
    <Popover
      placement="top-start"
      className="absolute bottom-1 left-1/2 -translate-x-1/2"
      panelClassName="w-[170px]"
      trigger={({ open, toggle }) => (
        <button type="button" onClick={toggle} aria-expanded={open} title="Change what it's for" className={cn("whitespace-nowrap hover:bg-black/90", cls, open && "bg-spike text-spike-ink")}>
          {tag}
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Use it as">
          {roles.map((role) => (
            <MenuItem
              key={role}
              selected={t.role === role}
              onSelect={() => {
                if (role !== t.role) onRole(role);
                close();
              }}
            >
              {ROLE_NAME[role]}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** An empty slot: its picker (recent pictures, your computer, or a frame made on the spot), and a place to drop. */
function Slot({
  role,
  ratio,
  ghost,
  dragging,
  addSlot,
  onDropHere,
}: {
  role: ShotRole;
  ratio: number;
  /** A faint look at the start frame behind an empty end slot. */
  ghost?: string;
  dragging: string | null;
  addSlot: (role: ShotRole, trigger: (o: { open: boolean; toggle: () => void }) => ReactNode) => ReactNode;
  onDropHere: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const label = role === "ref" ? "Add a reference" : role === "end" ? "Add an end frame" : "Add a start frame";
  return (
    <div className="relative shrink-0" style={{ width: role === "ref" ? 46 : frameWidth(ratio), height: 68 }} {...dropTarget(dragging, setOver, onDropHere)}>
      {ghost ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ghost} alt="" aria-hidden="true" className="squircle pointer-events-none absolute inset-0 size-full rounded-[13px] object-cover opacity-[0.17] blur-[1.5px]" />
      ) : null}
      {addSlot(role, ({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={label}
          title={label}
          className={cn(
            "press squircle flex size-full flex-col items-center justify-center gap-0.5 rounded-[13px] text-haze shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.16)] [background:rgb(255_255_255/0.025)] hover:text-paper hover:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.32)]",
            (over || open) && "text-spike shadow-[inset_0_0_0_2px_var(--color-spike)]",
          )}
        >
          {role === "ref" ? <Plus size={16} /> : <ImagePlus size={15} />}
          {role !== "ref" ? (
            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.08em]">
              {role}
              <Sparkles size={9} className="text-spike/80" />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** A frame being made: where it will land, and how far along it is. */
function MakingTile({ tag, ratio, making }: { tag: string; ratio: number; making: Making }) {
  const pct = making.progress == null ? null : Math.round(making.progress <= 1 ? making.progress * 100 : making.progress);
  return (
    <div className="skeleton squircle relative shrink-0 overflow-hidden rounded-[13px] shadow-[0_0_0_1px_rgb(255_91_46/0.45)]" style={{ width: frameWidth(ratio), height: 68 }} title={making.stage}>
      {/* Above the skeleton's light. */}
      <span className="absolute inset-0 z-[1] grid place-items-center">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-paper">
          <LoaderCircle size={13} className="animate-spin text-spike" />
          {pct !== null && pct > 0 ? `${pct}%` : null}
        </span>
      </span>
      <span className="absolute bottom-1 left-1/2 z-[1] -translate-x-1/2 whitespace-nowrap rounded-full bg-spike px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.08em] text-spike-ink">{tag}</span>
    </div>
  );
}

/** The bigger look while pointing at a picture: what it is, its size, and the word that mentions it. */
function Preview({ tile, rect }: { tile: ShotTile; rect: DOMRect }) {
  const r = tile.r;
  const ratio = r.width && r.height ? r.width / r.height : 1;
  const width = ratio >= 1 ? 280 : Math.max(150, Math.round(240 * ratio));
  const height = Math.round(width / ratio);
  const above = rect.top > height + 70;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  return createPortal(
    <div
      aria-hidden="true"
      className="squircle pointer-events-none fixed z-[90] overflow-hidden rounded-[16px] bg-apple-2 shadow-[0_0_0_1px_var(--color-line-strong),0_24px_60px_-12px_rgb(0_0_0/0.75)]"
      style={{ left, width, ...(above ? { bottom: window.innerHeight - rect.top + 10 } : { top: rect.bottom + 10 }) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={thumb(r.preview, 640)} alt="" className="block w-full object-cover" style={{ height }} />
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-[11.5px]">
        <span className="font-bold uppercase tracking-[0.06em] text-paper">{tile.unused ? "Not used" : tile.tag}</span>
        <span className="truncate text-haze">
          {r.width && r.height ? `${r.width}×${r.height}` : ""}
          {tile.unused ? "" : ` · @${tile.token} in the prompt`}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/** Drop handling for a slot or a picture: only pictures dragged within the strip (files go to the drop zones). */
function dropTarget(dragging: string | null, setOver: (on: boolean) => void, onDropHere: (id: string) => void) {
  const mine = (e: DragEvent) => e.dataTransfer.types.includes(MOVE);
  return {
    onDragOver: (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const id = e.dataTransfer.getData(MOVE) || dragging;
      if (id) onDropHere(id);
    },
  };
}

/**
 * Files dragged over the bar: a labelled place for each job the model has for a picture (start frame, end frame,
 * reference). Dropping on one gives the pictures that job.
 */
export function DropZones({ zones, onDrop }: { zones: { role: ShotRole; label: string; hint: string }[]; onDrop: (role: ShotRole, files: File[]) => void }) {
  const [over, setOver] = useState<ShotRole | null>(null);
  if (!zones.length) return null;
  return (
    <div className="squircle absolute inset-0 z-20 grid gap-1.5 rounded-[inherit] bg-[#0f0d14]/[0.96] p-1.5" style={{ gridTemplateColumns: `repeat(${zones.length}, minmax(0, 1fr))` }}>
      {zones.map((z) => (
        <div
          key={z.role}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setOver(z.role);
          }}
          onDragLeave={() => setOver((o) => (o === z.role ? null : o))}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(null);
            onDrop(z.role, Array.from(e.dataTransfer.files));
          }}
          className={cn(
            "squircle flex flex-col items-center justify-center gap-1 rounded-[20px] border-2 border-dashed px-3 text-center transition-[background-color,border-color,transform] duration-150",
            over === z.role ? "border-spike bg-spike/[0.14]" : "border-white/[0.18] bg-white/[0.02]",
          )}
        >
          <span className={cn("font-display text-[17px] uppercase leading-none", over === z.role ? "text-spike" : "text-paper")}>{z.label}</span>
          <span className="text-[11.5px] text-fog">{z.hint}</span>
        </div>
      ))}
    </div>
  );
}

export { ROLE_NAME };
