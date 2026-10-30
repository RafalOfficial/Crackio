"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Image as ImageIcon, LoaderCircle, Sparkles, Upload } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CastStrip } from "@/components/cast/CastStrip";
import { useMentions } from "@/components/cast/Mentions";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";
import { imageSlots } from "@/lib/models/caps";
import { sayPictures } from "@/lib/prompt-pictures";
import { previewSrcSet, previewUrl } from "@/lib/media-url";
import { ASPECTS } from "@/lib/shot";
import { cn } from "@/lib/cn";

/**
 * Adding a picture to a prompt: your latest generations first (no download and re-upload), then your computer, and for a
 * clip's start and end frames, one made on the spot (FrameMaker). One picker serves every slot of a bar: its tabs are
 * the jobs a picture can do there (start frame, end frame, references).
 */

export type PickedPicture = { url: string; name: string; width?: number; height?: number };

/** One job a picture can do in a bar, as the picker offers it. */
export type PickerRole<R extends string = string> = {
  id: R;
  label: string;
  /** Under the label: what it's for ("Opens the clip"). Roles that take several show how many are in instead. */
  caption?: string;
  icon?: ReactNode;
  /** Takes several (references): each pick adds one and the picker stays open. `have` are in already; `max` fit. */
  several?: { have: number; max?: number };
  /** "Generate": the form that makes this picture on the spot (start and end frames). */
  maker?: { label: string; form: (done: () => void, back: () => void) => ReactNode };
};

/** A picture in the bar that can go along when a frame is made: its tag, its @word and what the model calls it. */
export type MakerPicture = { token: string; tag: string; label: string; said: string; url: string; preview: string };

/** Your latest pictures, newest first: every picture of every finished generation. */
export function useRecentPictures(limit = 48): PickedPicture[] {
  const items = useGenerations((s) => s.items);
  const out: PickedPicture[] = [];
  for (const g of items) {
    if (g.status !== "done") continue;
    for (const o of g.outputs) {
      if (o.kind !== "image") continue;
      out.push({ url: o.url, name: g.prompt.slice(0, 48) || "Generation", width: o.width, height: o.height });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** The shot shape closest to a picture's ("16:9"). */
function shapeOf(p: PickedPicture) {
  if (!p.width || !p.height) return null;
  const r = p.width / p.height;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? a : best)).id;
}

export function PicturePicker<R extends string>({
  roles,
  initial,
  tags = {},
  note,
  trigger,
  onPick,
  onUpload,
  onUnpick,
  placement = "top-start",
  className,
}: {
  roles: PickerRole<R>[];
  /** The tab it opens on (the first empty slot). */
  initial?: R;
  /** Pictures already in the bar, by url: their tag ("Ref 1", "Start"). */
  tags?: Record<string, string>;
  /** What the model does with them, in a line. */
  note?: string;
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  onPick: (role: R, pictures: PickedPicture[]) => void;
  onUpload: (role: R, files: File[]) => void;
  /** A picture taken back out (picked again, in a role that takes several). */
  onUnpick?: (role: R, url: string) => void;
  placement?: "top-start" | "bottom-start" | "bottom-end" | "top-end";
  className?: string;
}) {
  return (
    <Popover placement={placement} className={className} panelClassName="w-[min(392px,calc(100vw-24px))] p-2.5" trigger={trigger}>
      {(close) => <PickerPanel roles={roles} initial={initial} tags={tags} note={note} onPick={onPick} onUpload={onUpload} onUnpick={onUnpick} close={close} />}
    </Popover>
  );
}

function PickerPanel<R extends string>({
  roles,
  initial,
  tags,
  note,
  onPick,
  onUpload,
  onUnpick,
  close,
}: {
  roles: PickerRole<R>[];
  initial?: R;
  tags: Record<string, string>;
  note?: string;
  onPick: (role: R, pictures: PickedPicture[]) => void;
  onUpload: (role: R, files: File[]) => void;
  onUnpick?: (role: R, url: string) => void;
  close: () => void;
}) {
  const [tab, setTab] = useState<R>(initial ?? roles[0].id);
  const [making, setMaking] = useState(false);
  const [over, setOver] = useState(false);
  const recent = useRecentPictures();
  const input = useRef<HTMLInputElement>(null);
  const role = roles.find((r) => r.id === tab) ?? roles[0];
  const several = role.several;
  const full = Boolean(several && several.max !== undefined && several.have >= several.max);

  const files = (list: File[]) => {
    const pictures = list.filter((f) => f.type.startsWith("image/"));
    if (!pictures.length) return;
    onUpload(role.id, several ? pictures : pictures.slice(0, 1));
    close();
  };
  const take = useEffectEvent(files);
  // A picture pasted while the picker is open goes where the picker is (the prompt box handles its own pastes).
  useEffect(() => {
    if (making) return;
    const paste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("textarea, input, [contenteditable]")) return;
      const list = Array.from(e.clipboardData?.files ?? []);
      if (!list.length) return;
      e.preventDefault();
      take(list);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [making]);

  if (making && role.maker) return <>{role.maker.form(close, () => setMaking(false))}</>;

  const pick = (p: PickedPicture) => {
    if (!several) {
      onPick(role.id, [p]);
      return close();
    }
    if (tags[p.url]) return onUnpick?.(role.id, p.url);
    if (!full) onPick(role.id, [p]);
  };
  const cell = "squircle size-full rounded-[13px]";

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        files(Array.from(e.dataTransfer.files));
      }}
    >
      <RoleTabs roles={roles} active={role.id} onChange={setTab} />

      {/* The rows are a quarter of the width each (a square per picture), set outright: rows sized by the pictures'
          aspect ratio collapse in some browsers once the list scrolls. */}
      <div className="scroll-thin @container -mx-1 mt-2.5 max-h-[min(296px,calc(var(--popover-max-h,60vh)-128px))] overflow-y-auto overscroll-contain px-1 pb-1 pt-0.5">
        <div className="grid grid-cols-4 gap-1.5 [grid-auto-rows:calc((100cqw_-_18px)/4)]">
          <button
            type="button"
            onClick={() => input.current?.click()}
            title="Pick pictures on your computer (or drop or paste them here)"
            className={cn(
              cell,
              "press flex flex-col items-center justify-center gap-1.5 text-fog shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.13)] [background:rgb(255_255_255/0.03)] hover:text-paper hover:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.28)]",
            )}
          >
            <Upload size={17} />
            <span className="text-[11.5px] font-semibold">Upload</span>
          </button>
          {role.maker ? (
            <button
              type="button"
              onClick={() => setMaking(true)}
              className={cn(
                cell,
                "press flex flex-col items-center justify-center gap-1.5 text-spike shadow-[inset_0_0_0_1.5px_rgb(255_91_46/0.38)] [background:radial-gradient(120%_90%_at_50%_0%,rgb(255_91_46/0.22),rgb(255_91_46/0.06))] hover:shadow-[inset_0_0_0_1.5px_rgb(255_91_46/0.6)]",
              )}
            >
              <Sparkles size={17} />
              <span className="px-1 text-center text-[11.5px] font-bold leading-tight">{role.maker.label}</span>
            </button>
          ) : null}
          {recent.map((p) => {
            const tag = tags[p.url];
            const shape = shapeOf(p);
            const blocked = Boolean(several && full && !tag);
            return (
              <button
                key={p.url}
                type="button"
                onClick={() => pick(p)}
                disabled={blocked}
                title={p.name}
                className={cn(
                  cell,
                  "press group/cell relative block overflow-hidden bg-apple shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-line-strong)] disabled:cursor-not-allowed disabled:opacity-35",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl(p.url, 200)}
                  srcSet={previewSrcSet(p.url, [200, 400])}
                  sizes="96px"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-[var(--ease-out-quint)] group-hover/cell:scale-[1.06]"
                />
                {/* What a click does, under the pointer. */}
                {!blocked ? (
                  <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/cell:opacity-100">
                    <span className="rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] font-semibold text-white">{tag ? (several ? "Remove" : "In use") : several ? "+ Add" : "Use"}</span>
                  </span>
                ) : null}
                {tag ? (
                  <>
                    <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_2px_var(--color-spike)]" />
                    <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-full bg-spike py-px pl-1 pr-1.5 text-[8.5px] font-bold uppercase tracking-[0.06em] text-spike-ink">
                      <Check size={9} strokeWidth={3.2} /> {tag}
                    </span>
                  </>
                ) : shape ? (
                  <span className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 py-px text-[9px] font-semibold text-white opacity-0 transition-opacity group-hover/cell:opacity-100">
                    {shape}
                  </span>
                ) : null}
              </button>
            );
          })}
          {!recent.length ? (
            <p className={cn("flex items-center px-2 text-[12px] leading-snug text-haze", role.maker ? "col-span-2" : "col-span-3")}>Your generations show up here, ready to reuse.</p>
          ) : null}
        </div>
      </div>

      {several ? (
        <div className="mt-2 flex items-center justify-between gap-3 pl-0.5">
          <span className="text-[11.5px] leading-snug text-haze">{full ? "That's as many as the model takes." : "Tap pictures to add them, or drop or paste your own."}</span>
          <button type="button" onClick={close} className="press shrink-0 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-paper hover:bg-white/[0.13]">
            Done
          </button>
        </div>
      ) : note ? (
        <p className="mt-2 px-0.5 text-[11.5px] leading-snug text-haze">{note}</p>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple={Boolean(several)}
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          files(list);
        }}
      />
      {over ? (
        <div className="pointer-events-none absolute -inset-1 z-10 grid place-items-center rounded-[16px] border-2 border-dashed border-spike bg-[#17110f]/[0.94]">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-spike">
            <Upload size={16} /> Drop to add {several ? "them" : "it"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** What a role's tab says under its name: what it's for, or for references how many are in. */
function captionOf<R extends string>(role: PickerRole<R>) {
  if (!role.several) return role.caption;
  if (role.several.max !== undefined) return `${role.several.have} of ${role.several.max}`;
  return role.several.have ? `${role.several.have} in` : role.caption;
}

/**
 * The jobs a picture can do here, side by side in equal parts. The one you're on glows softly from its outer corner
 * (the panel's top left for the first, top right for the last), fading over rather than sliding.
 */
function RoleTabs<R extends string>({ roles, active, onChange }: { roles: PickerRole<R>[]; active: R; onChange: (id: R) => void }) {
  const one = roles.length < 2;
  return (
    <div role={one ? undefined : "tablist"} aria-label={one ? undefined : "Add as"} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${roles.length}, minmax(0, 1fr))` }}>
      {roles.map((r, i) => {
        const on = r.id === active;
        const corner = one ? "50% 0%" : i === 0 ? "0% 0%" : i === roles.length - 1 ? "100% 0%" : "50% 0%";
        const caption = captionOf(r);
        const body = (
          <>
            {/* The glow: a soft orange edge and light pooling in the outer corner. */}
            <span
              aria-hidden="true"
              className={cn("pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-300 ease-out", on && !one ? "opacity-100" : "opacity-0")}
              style={{
                background: `radial-gradient(140% 170% at ${corner}, rgb(255 91 46 / 0.17), rgb(255 91 46 / 0.03) 58%, transparent 80%)`,
                boxShadow: "inset 0 0 0 1px rgb(255 91 46 / 0.32), inset 0 0 14px rgb(255 91 46 / 0.1), 0 0 18px -6px rgb(255 91 46 / 0.55)",
              }}
            />
            <span
              className={cn(
                "squircle relative grid size-7 shrink-0 place-items-center rounded-[9px] transition-colors duration-300",
                on ? (one ? "bg-white/[0.08] text-paper" : "bg-spike/[0.16] text-spike") : "bg-white/[0.045] text-haze group-hover/tab:text-fog",
              )}
            >
              {r.icon ?? <ImageIcon size={14} />}
            </span>
            <span className="relative min-w-0">
              <span className="block truncate text-[12.5px] font-semibold leading-[1.3]">{r.label}</span>
              {caption ? <span className="tabular block truncate text-[10.5px] leading-[1.3] text-haze">{caption}</span> : null}
            </span>
          </>
        );
        if (one) return <div key={r.id} className="relative flex min-w-0 items-center gap-2 px-0.5 text-paper">{body}</div>;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(r.id)}
            className={cn(
              "squircle group/tab relative flex min-w-0 items-center gap-2 rounded-[12px] p-1.5 pr-2 text-left outline-none transition-colors duration-300 focus-visible:bg-white/[0.05]",
              on ? "text-paper" : "text-fog hover:bg-white/[0.03] hover:text-paper",
            )}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A clip's start or end frame made on the spot: an image model, a few words, and what goes along: the bar's references
 * and anyone from your Cast ("@"). The end frame is the start frame edited into how the shot ends, so the clip has
 * somewhere true to land.
 */
export function FrameMaker({
  which,
  base,
  shape,
  pictures = [],
  onBack,
  onMake,
}: {
  which: "start" | "end";
  /** The start frame, which the end frame is made from. */
  base?: PickedPicture | null;
  /** The shape it's made in: the clip's ("16:9"). */
  shape: string;
  /** The bar's references, which can go along. */
  pictures?: MakerPicture[];
  onBack: () => void;
  /** Starts the picture with the words as the model reads them and the references going along; it lands in its slot when it's done. */
  onMake: (model: string, prompt: string, going: MakerPicture[]) => Promise<void>;
}) {
  const [model, setModel] = useModelChoice("image", which === "end" ? "edit" : "image");
  const [prompt, setPrompt] = useState("");
  const [off, setOff] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const info = useModelInfo(model === "auto" ? null : model);
  useEffect(() => box.current?.focus({ preventScroll: true }), []);

  // How many references the model reads beside the start frame (an end frame is made from it).
  const slots = info.caps ? imageSlots(info.caps) : null;
  const room = slots === null ? pictures.length : Math.max(0, slots - (which === "end" ? 1 : 0));
  // A picture named in the words goes even when switched off.
  const named = new Set(Array.from(prompt.matchAll(/@(ref\d{1,2})\b/gi), (m) => m[1].toLowerCase()));
  const wanted = pictures.filter((p) => !off.includes(p.token) || named.has(p.token));
  const going = wanted.slice(0, room);
  const mentions = useMentions({
    textarea: box,
    value: prompt,
    onChange: setPrompt,
    pictures: [
      ...(which === "end" && base ? [{ token: "start", label: "Start frame", src: previewUrl(base.url, 96) }] : []),
      ...pictures.map((p) => ({ token: p.token, label: p.label, src: p.preview })),
    ],
  });

  async function make() {
    if (busy) return;
    if (!prompt.trim()) return box.current?.focus();
    if (model === "auto") return void askForModel("image");
    setBusy(true);
    setError(null);
    try {
      const words = sayPictures(prompt.trim(), [...(which === "end" ? [{ token: "start", said: "the start frame" }] : []), ...going]);
      await onMake(model, words, going);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onBack} aria-label="Back" className="press grid size-8 shrink-0 place-items-center rounded-full text-fog hover:bg-white/[0.07] hover:text-paper">
          <ArrowLeft size={15} />
        </button>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{which === "start" ? "Generate the start frame" : "Generate the end frame"}</p>
        <ModelPicker kind="image" task={which === "end" ? "edit" : "image"} value={model} onChange={setModel} variant="chip" />
      </div>

      <div className="field-focus rounded-[14px] bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--color-line)]">
        <textarea
          ref={box}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void make();
            }
          }}
          rows={3}
          placeholder={
            which === "start" ? "The first frame: who, where, the light. Type @ for your pictures and Cast." : "What has changed by the end? She's laughing now, the door is open…"
          }
          className="block w-full resize-none bg-transparent px-3 pb-1.5 pt-2.5 text-[13.5px] leading-relaxed text-paper outline-none placeholder:text-haze"
        />
        {mentions.menu}
        {pictures.length || (which === "end" && base) ? (
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
            <span className="mr-0.5 text-[11px] font-semibold text-haze">With</span>
            {which === "end" && base ? (
              <span
                title="Your start frame, changed into how the shot ends: same place, people and light."
                className="inline-flex h-7 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-spike shadow-[inset_0_0_0_1px_rgb(255_91_46/0.45)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl(base.url, 96)} alt="" className="size-6 rounded-full object-cover" />
                Start <ArrowRight size={10} /> End
              </span>
            ) : null}
            {pictures.map((p) => {
              const on = going.includes(p);
              const fits = !wanted.includes(p) || wanted.indexOf(p) < room;
              return (
                <button
                  key={p.token}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setOff((o) => (o.includes(p.token) ? o.filter((t) => t !== p.token) : [...o, p.token]))}
                  title={on ? `${p.label} goes along (@${p.token}). Click to leave it out.` : fits ? `Click to send ${p.label} along.` : `${info.name ?? "This model"} takes no more pictures.`}
                  className={cn(
                    "press inline-flex h-7 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[10.5px] font-bold uppercase tracking-[0.05em] transition-[opacity,background-color]",
                    on ? "bg-white/[0.1] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]" : "text-haze opacity-60 hover:opacity-100",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.preview} alt="" className={cn("size-6 rounded-full object-cover", !on && "grayscale")} />
                  {p.tag}
                </button>
              );
            })}
            {slots === 0 ? <span className="text-[11px] text-tungsten">{info.name ?? "This model"} makes pictures from words only</span> : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <CastStrip prompt={prompt} onChange={setPrompt} className="min-w-0 flex-1" />
        <span
          title={which === "end" ? "The start frame's shape" : "Your clip's shape"}
          className="tabular ml-auto shrink-0 rounded-full bg-white/[0.05] px-2 py-1 text-[11px] font-semibold text-fog"
        >
          {shape}
        </span>
        <button
          type="button"
          onClick={() => void make()}
          disabled={busy}
          className="lip press squircle inline-flex h-10 shrink-0 items-center gap-2 rounded-[12px] bg-spike px-4 text-[13px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
        >
          {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}
          Generate
        </button>
      </div>
      {error ? <p className="text-[12px] text-tally">{error}</p> : null}
    </div>
  );
}
