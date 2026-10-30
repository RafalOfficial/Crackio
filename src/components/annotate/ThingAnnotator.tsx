"use client";

import { useRef, useState } from "react";
import { nanoid } from "nanoid";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, ImagePlus, LoaderCircle, ScanSearch, Trash, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMentions } from "@/components/cast/Mentions";
import { cn } from "@/lib/cn";
import { inBox, pinTarget, smallestAt, type Attachment, type Box, type Found, type Pin, type Thing } from "./things";

/**
 * A picture you point at to change things. It shows at once; the things in it arrive a moment
 * later and light up as you hover them (a white box and a name). Click one to pin a change there;
 * while the note is open, its parts (a pigeon's head, beak, wings) light up too, and clicking
 * one narrows the change to it. A note can carry a picture of how it should look.
 */
export function ThingAnnotator({
  image,
  things,
  status,
  error,
  needParts,
  pins,
  setPins,
  editing,
  setEditing,
  newPin,
  fit = "contain",
  maxHeight = "68vh",
  dim,
  chip = true,
  className,
}: {
  image: { url: string; width: number; height: number };
  things: Found[];
  status: "loading" | "ready" | "error";
  error?: string;
  needParts: (id: string) => void;
  /** The changes pinned on this picture. */
  pins: Pin[];
  setPins: (fn: (pins: Pin[]) => Pin[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** Adds what the page keeps on a new pin (Recast: the moment it's at). */
  newPin?: (p: Pin) => Pin;
  /** "contain": the largest picture that fits the box it's in; "width": full width, up to `maxHeight` tall. */
  fit?: "contain" | "width";
  maxHeight?: string;
  /** Fades the picture (a new frame is loading). */
  dim?: boolean;
  /** The "finding things" chip in the corner. */
  chip?: boolean;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Thing | null>(null);
  const ratio = image.width / image.height;
  const open = pins.find((p) => p.id === editing) ?? null;
  const openRoot = open?.root ? (things.find((t) => t.id === open.root!.id) ?? null) : null;

  const point = (e: React.MouseEvent): [number, number] => {
    const r = frame.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 1000), Math.round(((e.clientY - r.top) / r.height) * 1000)];
  };

  /** What's under the cursor: with a note open on a thing, its parts (or the thing); otherwise the things. */
  const targetAt = (at: [number, number]): { root?: Found; part?: Thing } => {
    if (openRoot && inBox(openRoot.box, at)) {
      const part = smallestAt(openRoot.parts ?? [], at);
      return { root: openRoot, part: part ?? undefined };
    }
    const root = smallestAt(things, at);
    return root ? { root } : {};
  };

  function retarget(id: string, at: [number, number], root?: Thing, part?: Thing) {
    setPins((ps) => ps.map((p) => (p.id === id ? { ...p, at, root, part } : p)));
    if (root) needParts(root.id);
  }

  function click(e: React.MouseEvent) {
    const at = point(e);
    const { root, part } = targetAt(at);
    // With a note open, a click moves it: to a part of its thing, the whole thing, or something else.
    if (open) return retarget(open.id, at, root ? strip(root) : undefined, part);
    const base: Pin = { id: nanoid(8), at, root: root ? strip(root) : undefined, text: "" };
    const pin = newPin ? newPin(base) : base;
    setPins((ps) => [...ps, pin]);
    setEditing(pin.id);
    setHover(null);
    if (root) needParts(root.id);
  }

  // The hover box, unless it's what the open note is already on.
  const selected = open ? (open.part ?? open.root ?? null) : null;
  const shown = hover && hover.id !== selected?.id ? hover : null;
  const saved = pins.filter((p) => p.text.trim() && p.id !== editing);

  const picture = (
    <div
      ref={frame}
      className={cn("relative cursor-crosshair select-none rounded-[14px] bg-black shadow-[0_0_0_1px_var(--color-line-strong)]", fit === "width" && "mx-auto w-full")}
      style={fit === "contain" ? { aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` } : { aspectRatio: ratio, maxHeight, maxWidth: `calc(${maxHeight} * ${ratio})` }}
      onMouseMove={(e) => {
        const { root, part } = targetAt(point(e));
        setHover(part ?? root ?? null);
      }}
      onMouseLeave={() => setHover(null)}
      onClick={click}
    >
      {/* Only the picture is clipped to the rounded frame: the note can reach past its edges. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt="The picture to change" draggable={false} className={cn("absolute inset-0 size-full rounded-[14px] object-contain transition-opacity", dim && "opacity-60")} />

      {/* Changes already pinned stay outlined, numbered in order. */}
      {saved.map((p) => {
        const box = pinTarget(p).box;
        return box ? <Outline key={`o-${p.id}`} box={box} tone="pinned" /> : null;
      })}

      {/* The thing a note is open on, its part when one is picked, and what's under the cursor. */}
      {open?.root ? <Outline box={openRoot?.box ?? open.root.box} tone="focus" label={open.part ? undefined : capital(open.root.label)} /> : null}
      {open?.part ? <Outline box={open.part.box} tone="active" label={capital(open.part.label)} /> : null}
      {shown ? <Outline box={shown.box} tone="hover" label={capital(shown.detail)} /> : null}

      {pins
        .filter((p) => p.text.trim() || p.id === editing)
        .map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(p.id);
            }}
            className={cn(
              "tabular absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[11px] font-bold shadow-[0_0_0_3px_rgb(0_0_0/0.35)]",
              p.id === editing ? "bg-paper text-[#16131b]" : "bg-spike text-spike-ink",
            )}
            style={{ left: `${p.at[0] / 10}%`, top: `${p.at[1] / 10}%` }}
            aria-label={`Edit change ${pins.indexOf(p) + 1}`}
          >
            {pins.filter((x) => x.text.trim() || x.id === editing).indexOf(p) + 1}
          </button>
        ))}

      {chip ? (
        <span className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 inline-flex max-w-[calc(100%-20px)] items-center gap-1.5 truncate rounded-full bg-black/60 px-2.5 py-1 text-[11.5px] font-semibold text-paper backdrop-blur">
          {status === "loading" ? (
            <>
              <LoaderCircle size={12} className="animate-spin" /> Finding things…
            </>
          ) : status === "error" ? (
            <span className="truncate text-tungsten">{error ?? "Nothing found"} · click anywhere to add a change</span>
          ) : (
            <>
              <ScanSearch size={12} /> {things.length ? `${things.length} things · hover to see them, click to change one` : "Nothing found · click anywhere to add a change"}
            </>
          )}
        </span>
      ) : null}

      <AnimatePresence>
        {open ? (
          <NotePopover
            key={open.id}
            pin={open}
            root={openRoot}
            onPick={(part) => retarget(open.id, part ? center(part.box) : open.at, open.root, part)}
            onHover={(t) => setHover(t)}
            onSave={(next) => {
              setPins((ps) => ps.map((p) => (p.id === next.id ? next : p)));
              setEditing(null);
            }}
            onCancel={() => {
              setPins((ps) => ps.filter((p) => p.id !== open.id || p.text.trim()));
              setEditing(null);
            }}
            onRemove={() => {
              setPins((ps) => ps.filter((p) => p.id !== open.id));
              setEditing(null);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );

  if (fit === "width") return <div className={className}>{picture}</div>;
  // The outer box is a size container, so the picture can be the largest rectangle with its shape.
  return (
    <div className={cn("grid size-full place-items-center", className)} style={{ containerType: "size" }}>
      {picture}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A found thing without its parts list, as a pin keeps it. */
const strip = (t: Found | Thing): Thing => ({ id: t.id, label: t.label, detail: t.detail, box: t.box });
const center = (b: Box): [number, number] => [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];

function Outline({ box, label, tone }: { box: Box; label?: string; tone: "hover" | "active" | "focus" | "pinned" }) {
  const [x0, y0, x1, y1] = box;
  return (
    <span
      className={cn(
        "pointer-events-none absolute rounded-[8px]",
        tone === "hover" && "bg-white/[0.07] shadow-[inset_0_0_0_2px_rgb(255_255_255/0.95),0_0_0_1px_rgb(0_0_0/0.45)]",
        tone === "active" && "bg-white/[0.05] shadow-[inset_0_0_0_2px_rgb(255_255_255),0_0_0_1px_rgb(0_0_0/0.5)]",
        tone === "focus" && "outline-dashed outline-2 -outline-offset-2 outline-white/80",
        tone === "pinned" && "shadow-[inset_0_0_0_1.5px_rgb(255_91_46/0.6)]",
      )}
      style={{ left: `${x0 / 10}%`, top: `${y0 / 10}%`, width: `${(x1 - x0) / 10}%`, height: `${(y1 - y0) / 10}%` }}
    >
      {label ? (
        <span className={cn("absolute left-0 max-w-[240px] truncate rounded-[7px] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#16131b] shadow", y0 < 60 ? "top-1.5 ml-1.5" : "-top-7")}>{label}</span>
      ) : null}
    </span>
  );
}

/** The glass note at the pin: what it's on (and its parts to narrow it to), what should change, and a picture of how. */
function NotePopover({
  pin,
  root,
  onPick,
  onHover,
  onSave,
  onCancel,
  onRemove,
}: {
  pin: Pin;
  root: Found | null;
  onPick: (part?: Thing) => void;
  onHover: (t: Thing | null) => void;
  onSave: (p: Pin) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(pin.text);
  const [image, setImage] = useState<Attachment | undefined>(pin.image);
  const field = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const mentions = useMentions({ textarea: field, value: text, onChange: setText });
  const [x, y] = pin.at;
  const below = y < 560;
  const parts = root?.parts ?? [];

  async function attach(f?: File) {
    if (!f?.type.startsWith("image/")) return;
    const preview = URL.createObjectURL(f);
    setImage({ url: "", preview, describing: true });
    try {
      const body = new FormData();
      body.append("file", f);
      const up = (await (await fetch("/api/uploads", { method: "POST", body })).json()) as { items?: { url: string }[]; error?: string };
      const url = up.items?.[0]?.url;
      if (!url) throw new Error(up.error ?? "Upload failed.");
      setImage({ url, preview, describing: true });
      // A description goes along too, for models that take words only.
      const res = await fetch("/api/recast/describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: url, note: text }) });
      const data = (await res.json()) as { description?: string; error?: string };
      setImage({ url, preview, description: data.description, error: data.error });
    } catch (err) {
      setImage({ url: "", preview, error: (err as Error).message });
    }
  }

  const save = () => text.trim() && onSave({ ...pin, text: text.trim(), image: image?.url ? image : undefined });
  const name = root?.label ?? pin.root?.label;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: below ? -6 : 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      className="absolute z-20 w-[310px] cursor-default rounded-[16px] border border-white/15 bg-[rgb(22_19_27/0.88)] p-2.5 shadow-[0_24px_60px_-18px_rgb(0_0_0/0.9)] backdrop-blur-xl"
      style={{
        left: `clamp(8px, calc(${x / 10}% - 155px), calc(100% - 318px))`,
        ...(below ? { top: `calc(${y / 10}% + 18px)` } : { bottom: `calc(${100 - y / 10}% + 18px)` }),
      }}
    >
      {/* What the change is on: the thing, and the part when one is picked. */}
      <div className="flex min-w-0 items-center gap-1 px-1 text-[11.5px] font-semibold">
        {name ? (
          <>
            <button type="button" onClick={() => onPick(undefined)} className={cn("truncate", pin.part ? "text-haze hover:text-paper" : "text-paper")} title={`The whole ${name}`}>
              {capital(name)}
            </button>
            {pin.part ? (
              <>
                <ChevronRight size={12} className="shrink-0 text-haze" />
                <span className="truncate text-paper">{capital(pin.part.label)}</span>
              </>
            ) : null}
          </>
        ) : (
          <span className="text-paper/80">This spot</span>
        )}
      </div>

      {/* Its parts, to narrow the change to one (they light up on the picture too). */}
      {root ? (
        root.partsState === "loading" || root.partsState === "idle" ? (
          <p className="mt-1.5 flex items-center gap-1.5 px-1 text-[11px] text-haze">
            <LoaderCircle size={11} className="animate-spin" /> Finding its parts…
          </p>
        ) : parts.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1 px-0.5" onMouseLeave={() => onHover(null)}>
            {parts.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(pin.part?.id === p.id ? undefined : p)}
                onMouseEnter={() => onHover(p)}
                className={cn(
                  "press h-6 shrink-0 rounded-full px-2 text-[11px] font-semibold",
                  pin.part?.id === p.id ? "bg-paper text-[#16131b]" : "bg-white/[0.07] text-fog hover:text-paper",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null
      ) : null}

      <textarea
        ref={field}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (mentions.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={2}
        placeholder={pin.part ? `What should the ${pin.part.label} become?` : name ? `What should the ${name} become?` : "What should change here?"}
        className="mt-2 block w-full resize-none rounded-[10px] bg-white/[0.06] px-2.5 py-2 text-[13px] leading-relaxed text-paper outline-none placeholder:text-haze"
      />
      {mentions.menu}
      {image ? (
        <div className="mt-2 flex items-start gap-2 rounded-[10px] bg-white/[0.05] p-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.preview} alt="" className="size-11 shrink-0 rounded-[8px] object-cover" />
          <p className="line-clamp-3 min-w-0 flex-1 text-[11px] leading-snug text-fog">
            {image.describing ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle size={11} className="animate-spin" /> Reading the image…
              </span>
            ) : (
              (image.description ?? image.error ?? "Goes along as a reference")
            )}
          </p>
          <button type="button" onClick={() => setImage(undefined)} className="text-haze hover:text-paper" aria-label="Remove image">
            <X size={12} />
          </button>
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex gap-1">
          <button type="button" onClick={() => file.current?.click()} className="press inline-flex h-7 items-center gap-1.5 rounded-[9px] bg-white/[0.07] px-2 text-[11.5px] font-semibold text-fog hover:text-paper" title="Attach a picture of how it should look">
            <ImagePlus size={12} /> Image
          </button>
          {pin.text ? (
            <button type="button" onClick={onRemove} className="press grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.07] hover:text-paper" aria-label="Remove change">
              <Trash size={12} />
            </button>
          ) : null}
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="paper" disabled={!text.trim() || image?.describing} onClick={save}>
            Pin
          </Button>
        </span>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void attach(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </motion.div>
  );
}
