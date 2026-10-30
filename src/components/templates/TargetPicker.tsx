"use client";

import { useRef, useState } from "react";
import { LoaderCircle, MousePointerClick } from "lucide-react";
import { smallestAt, useThings, where, type Box, type Thing } from "@/components/annotate/things";
import { cn } from "@/lib/cn";

type Frame = { url: string; width: number; height: number };

/** Who or what in your own clip a slot replaces, in words a video model can find: "the woman in the red dress in the left side of the frame (…)". */
export const targetOf = (t: Thing) => `the ${t.detail.replace(/\.$/, "").replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())} in ${where(t.box, "frame")}`;

/** How much two boxes (0–1000) share: their overlap over their union. */
function overlap(a: Box, b: Box) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (r: Box) => (r[2] - r[0]) * (r[3] - r[1]);
  return (w * h) / Math.max(1, area(a) + area(b) - w * h);
}

type Outlined = { overlay: string; box: Box; name?: string };

async function outlineOf(frame: string, at: [number, number], name: boolean, tint?: string): Promise<Outlined> {
  const res = await fetch("/api/swap/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frame, points: [{ x: at[0] / 1000, y: at[1] / 1000 }], name, ...(tint ? { style: "tint", color: tint } : {}) }),
  });
  const data = (await res.json()) as Partial<Outlined> & { error?: string };
  if (!res.ok || !data.overlay || !data.box) throw new Error(data.error ?? "Couldn't outline it.");
  return { overlay: data.overlay, box: data.box, name: data.name };
}

/**
 * A frame of your clip with everything in it found: hover outlines a thing, a click picks it as
 * who (or what) gets swapped, along with the point clicked (0–1000 across and down). Only whole
 * things are looked for here, never their parts.
 *
 * `outline`: a click is outlined by SAM 3.1 on your GPU, exactly what's under it (the swap replaces only that), and
 * named by the found thing that fits the outline, else by a vision model.
 *
 * Several characters (`tint`): this one's outline in its own colour, over the others' (`layers`), each under its name.
 */
export function TargetPicker({
  frame,
  picked,
  onPick,
  color = "var(--color-spike)",
  hint,
  outline = false,
  tint,
  overlay,
  label,
  layers = [],
}: {
  frame: Frame;
  picked: Thing | null;
  onPick: (t: Thing, at: [number, number], overlay?: string) => void;
  color?: string;
  /** What a click does, when it's more than naming who to swap. */
  hint?: string;
  outline?: boolean;
  /** This character's colour (#rrggbb): its outline is tinted in it, so several stack. */
  tint?: string;
  /** Its outline already made (picked before). */
  overlay?: string;
  /** Its name over its outline. */
  label?: string;
  /** The other characters' outlines. */
  layers?: { overlay: string; label: string; color: string; box: Box }[];
}) {
  const found = useThings(frame.url, 0);
  const [hover, setHover] = useState<Thing | null>(null);
  const [mask, setMask] = useState<string | null>(overlay ?? null);
  const [outlining, setOutlining] = useState(false);
  const [oops, setOops] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const at = (e: React.PointerEvent | React.MouseEvent): [number, number] | null => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    return [((e.clientX - r.left) / r.width) * 1000, ((e.clientY - r.top) / r.height) * 1000];
  };
  // Outlining: SAM's outline shows what was picked; the found boxes stay out of the way.
  const shown = outline ? null : (hover ?? picked);

  async function outlineAt(p: [number, number]) {
    setOutlining(true);
    setOops(null);
    try {
      const got = await outlineOf(frame.url, p, false, tint);
      setMask(got.overlay);
      // What it is: the found thing that fits the outline, else a vision model says (the same graph again: ComfyUI keeps its outline).
      const fit = found.things.map((t) => ({ t, o: overlap(t.box, got.box) })).sort((a, b) => b.o - a.o)[0];
      let thing: Thing | null = fit && fit.o >= 0.45 ? { ...fit.t, box: got.box } : null;
      if (!thing) {
        const named = await outlineOf(frame.url, p, true).catch(() => null);
        const words = named?.name?.replace(/^the\s+/i, "") || "one you clicked";
        thing = { id: `outline-${Date.now()}`, label: words.split(/\s+(in|with|on|at|wearing)\s+/i)[0], detail: words, box: got.box };
      }
      onPick(thing, p, got.overlay);
    } catch (err) {
      setOops((err as Error).message);
    } finally {
      setOutlining(false);
    }
  }

  return (
    <div>
      <div
        ref={box}
        className="relative mx-auto w-full cursor-crosshair overflow-hidden rounded-[14px] bg-black"
        style={{ aspectRatio: frame.width / frame.height }}
        onPointerMove={(e) => {
          if (outline) return;
          const p = at(e);
          setHover(p ? smallestAt(found.things, p) : null);
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const p = at(e);
          if (!p || outlining) return;
          if (outline) {
            void outlineAt(p);
            return;
          }
          const t = smallestAt(found.things, p);
          if (t) onPick(t, p);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={frame.url} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
        {layers.map((l) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={l.overlay} src={l.overlay} alt="" className="pointer-events-none absolute inset-0 size-full object-cover" draggable={false} />
        ))}
        {outline && mask ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mask} alt="" className="pointer-events-none absolute inset-0 size-full object-cover" draggable={false} />
        ) : null}
        {[...layers, ...(tint && picked && label ? [{ overlay: "", label, color: tint, box: picked.box }] : [])].map((l) => (
          <span
            key={`${l.label}-${l.color}`}
            className="pointer-events-none absolute ml-1 mt-1 max-w-[40%] truncate rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#16171a]"
            style={{ left: `${l.box[0] / 10}%`, top: `${l.box[1] / 10}%`, background: l.color }}
          >
            {l.label}
          </span>
        ))}
        {shown ? (
          <span
            className="pointer-events-none absolute rounded-[6px] transition-[left,top,width,height] duration-150"
            style={{
              left: `${shown.box[0] / 10}%`,
              top: `${shown.box[1] / 10}%`,
              width: `${(shown.box[2] - shown.box[0]) / 10}%`,
              height: `${(shown.box[3] - shown.box[1]) / 10}%`,
              boxShadow: `0 0 0 2px ${shown === picked ? color : "rgb(255 255 255 / 0.9)"}, 0 0 0 9999px rgb(10 8 14 / ${shown === picked ? 0.45 : 0.25})`,
            }}
          >
            <span className="absolute left-1 top-1 max-w-[calc(100%-8px)] truncate rounded-[5px] bg-black/70 px-1.5 py-0.5 text-[10.5px] font-semibold capitalize text-white">{shown.label}</span>
          </span>
        ) : null}
        {outlining ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-[11.5px] font-semibold text-white">
            <LoaderCircle size={12} className="animate-spin" /> Outlining…
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-haze">
        {oops ? (
          <span className="text-tungsten">{oops}</span>
        ) : found.status === "loading" && !outline ? (
          <>
            <LoaderCircle size={12} className="animate-spin" /> Finding who&rsquo;s in the frame…
          </>
        ) : found.status === "error" && !outline ? (
          <span className="text-tungsten">{found.error ?? "Nothing found"} · describe who to replace below</span>
        ) : (
          <>
            <MousePointerClick size={12} /> {picked && !tint ? <span className={cn("text-fog")}>Swapping {picked.label}</span> : (hint ?? "Click who (or what) to swap")}
          </>
        )}
      </p>
    </div>
  );
}
