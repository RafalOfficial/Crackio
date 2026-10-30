"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, ChevronDown, ImagePlus, Timer, Volume2, VolumeX } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { DurationRuler } from "@/components/ui/DurationRuler";
import { QualityPicker, type OutputQuality } from "@/components/models/QualityPicker";
import { TIER_INK, resolutionTier } from "@/components/models/TierPills";
import { durationTicks, resolutionLabel, type Caps } from "@/lib/models/caps";
import type { CostInput, Pricing } from "@/lib/models/pricing";
import type { LocalRef } from "@/lib/hooks/use-uploads";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

/*
 * The Home composer's settings, one chip each: the shape and quality a take is made at, a clip's
 * length and sound, and what its pictures are for (start frame, end frame, references). Every
 * choice comes from the model that will run, so the chips change with it and never offer a value
 * it can't make.
 */

/** Controls on the glass bar: set into the glass, with a pane only under the pointer or while open. */
export const GLASS_CHIP = "bg-transparent hover:bg-white/[0.08] hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] aria-expanded:bg-white/[0.08]";

/*
 * The chips sit in one sideways-scrolling row (see Composer), so they keep their full labels at any
 * width rather than shedding them as the bar narrows.
 */
const CHEVRON = "shrink-0 text-haze";
/** A chip ending in a chevron: the chevron's own whitespace stands in for some of the padding (like the model chip). */
const CHEVRON_END = "pr-2.5";

export function ChipButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn("press inline-flex h-9 items-center gap-1.5 rounded-chip px-3 text-[13px] font-semibold text-paper", GLASS_CHIP, className)}
      {...props}
    />
  );
}

/** The shot's frame closest to a ratio (width / height). */
export const shotFor = (ratio: number): AspectId =>
  ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

/** How the chip names the size a take is made at: "2K", "720p", "High", "2 MP"; null when the model has no say. */
function qualitySummary(q: OutputQuality): string | null {
  if (q.resolution) {
    const c = q.resChoices.find((x) => String(x.value) === q.resolution);
    return c?.label && c.label !== String(c.value) ? c.label : resolutionLabel(q.resolution);
  }
  if (q.quality && q.qualityChoices.length > 1) return q.qualityChoices.find((x) => String(x.value) === q.quality)?.label ?? q.quality;
  if (q.megapixels) return `${q.megapixels} MP`;
  return null;
}

/** One option in a grid of them; the light pill slides to the picked one. */
function Tile({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      title={title}
      className={cn(
        "press relative flex h-[52px] flex-col items-center justify-center gap-1 rounded-[11px] text-[11px] font-semibold",
        on ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
      )}
    >
      {on ? <motion.span layoutId="composer-shape" className="absolute inset-0 rounded-[11px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
      <span className="relative flex flex-col items-center gap-1">{children}</span>
    </button>
  );
}

/** The shape of whatever the start frame is. */
function FrameGlyph() {
  return (
    <span className="grid size-4 place-items-center" aria-hidden="true">
      <span className="size-3 rounded-[3px] border-[1.5px] border-dashed border-current opacity-80" />
    </span>
  );
}

/** Where the chip's last size is kept; app/layout's SIZE_HINT_SCRIPT reads the same key. */
const SIZE_HINT = "crackio:size-hint";

/**
 * The chip's size ("· 2K"), shown from the first paint: the page's HTML arrives seconds before its scripts run (about 2 s
 * in development), and the size needs the model list on top. Until the real size renders, the empty span's ::after shows
 * the last one seen, in its tier's color: a script in the root layout's <head> (SIZE_HINT_SCRIPT) puts it on <html> as
 * CSS variables per key (`--size-hint-image`, `--size-hint-image-color`) before anything paints, and this span picks its
 * key's. No script here: React never runs one a client component renders, and warns about it.
 */
function SizeHint({ hintKey, children }: { hintKey: string; children: ReactNode }) {
  const vars = { "--size-hint": `var(--size-hint-${hintKey})`, "--size-hint-color": `var(--size-hint-${hintKey}-color)` } as CSSProperties;
  return (
    <span suppressHydrationWarning style={vars} className="font-medium text-fog empty:after:content-[var(--size-hint,'')] empty:after:[color:var(--size-hint-color,inherit)]">
      {children}
    </span>
  );
}

/**
 * Shape and quality in one chip ("3:2 · 2K"). The panel has the shapes, then whatever the model
 * lets you pick: a resolution, a quality, or a size in megapixels, each priced when it changes the
 * price.
 */
export function FormatChip({
  aspect,
  onAspect,
  frame,
  q,
  pricing,
  input,
  note,
  hintKey = "image",
}: {
  aspect: AspectId;
  onAspect: (a: AspectId) => void;
  /** A clip with a start frame keeps the frame's own shape until another one is picked. */
  frame?: { following: boolean; ratio: number | null; follow: () => void } | null;
  q: OutputQuality;
  pricing?: Pricing | null;
  /** The rest of the settings, to price each option with. */
  input?: CostInput;
  note?: string | null;
  /** Which remembered size the chip shows before the page is running ("image" or "video"): see `SizeHint`. */
  hintKey?: string;
}) {
  const summary = qualitySummary(q);
  const following = Boolean(frame?.following);
  const ink = q.resolution ? TIER_INK[resolutionTier(q.resolution)] : null;
  // Remembered for the next visit's first paint.
  useEffect(() => {
    if (!summary) return;
    try {
      const kept = JSON.parse(localStorage.getItem(SIZE_HINT) ?? "{}") as Record<string, { s: string; c?: string | null }>;
      if (kept[hintKey]?.s === summary && kept[hintKey]?.c === ink) return;
      localStorage.setItem(SIZE_HINT, JSON.stringify({ ...kept, [hintKey]: { s: summary, c: ink } }));
    } catch {
      /* private mode: the chip waits for the model list */
    }
  }, [summary, ink, hintKey]);
  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[296px] p-3"
      trigger={({ open, toggle }) => (
        <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label="Shape and quality" className={CHEVRON_END}>
          <AspectGlyph id={following && frame?.ratio ? shotFor(frame.ratio) : aspect} />
          {following ? "Frame" : aspect}
          <SizeHint hintKey={hintKey}>
            {summary ? (
              <>
                · <span className="transition-colors duration-300" style={ink ? { color: ink } : undefined}>{summary}</span>
              </>
            ) : null}
          </SizeHint>
          <ChevronDown size={13} className={CHEVRON} />
        </ChipButton>
      )}
    >
      {() => (
        <div className="space-y-3.5">
          <section>
            <h3 className="label mb-2">Aspect ratio</h3>
            <div role="radiogroup" aria-label="Aspect ratio" className="grid grid-cols-4 gap-1">
              {frame ? (
                <Tile on={following} onClick={frame.follow} title="Keep the start frame's own shape">
                  <FrameGlyph />
                  Frame
                </Tile>
              ) : null}
              {ASPECTS.map((a) => (
                <Tile key={a.id} on={!following && a.id === aspect} onClick={() => onAspect(a.id)} title={a.label}>
                  <AspectGlyph id={a.id} />
                  {a.id}
                </Tile>
              ))}
            </div>
            {note ? <p className="mt-2 text-[11.5px] text-haze">{note}</p> : null}
          </section>
          <QualityPicker q={q} pricing={pricing} input={input} layout="stack" look="tiers" />
        </div>
      )}
    </Popover>
  );
}

/** Lengths for a model whose limits aren't known yet (the server snaps to what it really makes). */
const ANY_LENGTH = { seconds: Array.from({ length: 15 }, (_, i) => i + 1), auto: false, min: 1, max: 15, preferred: 6 };

/** A clip's length on a ruler (snapping to the lengths the model makes) and its sound. */
export function LengthChip({
  caps,
  value,
  onChange,
  sound,
  onSound,
}: {
  caps: Caps | null;
  /** The length the model will make, already snapped to what it allows; null when it sets the length itself. */
  value: number | "auto" | null;
  onChange: (v: number | "auto") => void;
  /** Sound on or off; null when the model has no sound setting. */
  sound: boolean | null;
  onSound: (on: boolean) => void;
}) {
  const ticks = caps?.duration ? durationTicks(caps.duration) : caps ? null : ANY_LENGTH;
  const label = typeof value === "number" ? `${value}s` : "Auto";
  const range = !ticks
    ? "Set by the model"
    : ticks.min === ticks.max
      ? `${ticks.min} s`
      : ticks.seconds.length === ticks.max - ticks.min + 1
        ? `${ticks.min}–${ticks.max} s`
        : `${ticks.seconds.length} lengths up to ${ticks.max} s`;
  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[320px] p-3"
      trigger={({ open, toggle }) => (
        <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label={`Length: ${label}${sound === false ? ", silent" : ""}`} className={CHEVRON_END}>
          <Timer size={14} className="text-fog" />
          <span className="tabular">{label}</span>
          {sound === false ? <VolumeX size={13} className="text-haze" /> : null}
          <ChevronDown size={13} className={CHEVRON} />
        </ChipButton>
      )}
    >
      {() => (
        <div className="space-y-3">
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="label">Length</h3>
              <span className="text-[11.5px] text-haze">{range}</span>
            </div>
            {ticks && ticks.seconds.length > 1 ? (
              <DurationRuler value={value ?? ticks.seconds[0]} allowed={ticks.seconds} max={ticks.max} auto={ticks.auto} onChange={onChange} />
            ) : (
              <p className="flex h-10 items-center rounded-full bg-white/[0.05] px-4 text-[12.5px] text-haze">
                {ticks ? (
                  <>
                    <span className="mr-1.5 font-bold text-paper">{ticks.seconds[0]}s</span> the only length this model makes
                  </>
                ) : (
                  "This model sets the length itself"
                )}
              </p>
            )}
          </section>
          {sound !== null ? (
            <button
              type="button"
              role="switch"
              aria-checked={sound}
              onClick={() => onSound(!sound)}
              className="press flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
            >
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", sound ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-haze")}>
                {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold">{sound ? "Sound on" : "Silent"}</span>
                <span className="block text-[11.5px] text-haze">{sound ? "Ambience and effects made with the clip" : "Video only"}</span>
              </span>
              <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", sound ? "bg-spike" : "bg-gaffer")}>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", sound ? "left-[18px]" : "left-0.5")} />
              </span>
            </button>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

/** What a picture is for in a clip. */
export type FrameRole = "start" | "end" | "ref";

/** A frame in the chip: its picture, or a dashed outline while it's empty. */
function MiniFrame({ r }: { r: LocalRef | null }) {
  return (
    <span className="relative block h-[19px] w-[15px] shrink-0 overflow-hidden rounded-[4px]">
      {r ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.preview.startsWith("blob:") ? r.preview : previewUrl(r.preview, 48)} alt="" className={cn("size-full object-cover", r.status !== "ready" && "opacity-50")} />
      ) : (
        <span className="absolute inset-0 rounded-[4px] border-[1.5px] border-dashed border-current opacity-70" />
      )}
    </span>
  );
}

/**
 * The chip that adds a clip's pictures, drawn as what the model takes: a start and an end frame ([▢] → [▢]), a start
 * frame only, or references. It opens the picture picker (components/media/PicturePicker).
 */
export function FramesButton({
  layout,
  start,
  end,
  extras,
  open,
  toggle,
}: {
  layout: "start-end" | "start" | "refs";
  start: LocalRef | null;
  end: LocalRef | null;
  /** Pictures beside the frames. */
  extras: LocalRef[];
  open: boolean;
  toggle: () => void;
}) {
  const name = layout === "start-end" ? "Start and end frames" : layout === "start" ? "Start frame" : "References";
  return (
    <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label={name} title={name}>
      {layout === "refs" ? (
        <>
          <ImagePlus size={15} />
          References
        </>
      ) : (
        <>
          <MiniFrame r={start} />
          {layout === "start-end" ? (
            <>
              <ArrowRight size={11} className="text-haze" />
              <MiniFrame r={end} />
            </>
          ) : (
            "Start frame"
          )}
        </>
      )}
      {extras.length ? <span className="tabular text-haze">{layout === "refs" ? extras.length : `+${extras.length}`}</span> : null}
    </ChipButton>
  );
}
