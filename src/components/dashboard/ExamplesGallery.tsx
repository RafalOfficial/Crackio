"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Check, ChevronLeft, ChevronRight, Copy, CornerUpLeft, X } from "lucide-react";
import { EXAMPLE_CATEGORIES, EXAMPLES, type Example, type ExampleCategory } from "@/lib/examples";
import { useComposerBridge } from "@/lib/hooks/use-composer-bridge";
import { copyText } from "@/lib/clipboard";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { cn } from "@/lib/cn";

type Filter = "All" | ExampleCategory;
const FILTERS: Filter[] = ["All", ...EXAMPLE_CATEGORIES];
const SIZES = "(min-width: 1536px) 18vw, (min-width: 1024px) 22vw, (min-width: 640px) 33vw, 50vw";

/** Columns for the gallery's width; the server renders four and the client corrects it. */
function useColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setCols(w < 520 ? 2 : w < 860 ? 3 : w < 1240 ? 4 : 5);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, cols };
}

/** Each next image goes into the shortest column, so the grid stays even and reads left to right. */
function masonry(items: Example[], cols: number) {
  const columns = Array.from({ length: cols }, () => ({ height: 0, items: [] as Example[] }));
  for (const ex of items) {
    const shortest = columns.reduce((a, b) => (b.height < a.height ? b : a));
    shortest.items.push(ex);
    shortest.height += ex.height / ex.width;
  }
  return columns.map((c) => c.items);
}

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (ex: Example) => {
    if (!(await copyText(ex.prompt))) return;
    setCopied(ex.id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1400);
  };
  return { copied, copy };
}

export function ExamplesGallery() {
  const push = useComposerBridge((s) => s.push);
  const [filter, setFilter] = useState<Filter>("All");
  const [open, setOpen] = useState<string | null>(null);
  const { ref, cols } = useColumns();
  const { copied, copy } = useCopied();

  const shown = useMemo(() => (filter === "All" ? EXAMPLES : EXAMPLES.filter((e) => e.category === filter)), [filter]);
  const columns = useMemo(() => masonry(shown, cols), [shown, cols]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, f === "All" ? EXAMPLES.length : EXAMPLES.filter((e) => e.category === f).length])), []);

  const use = (ex: Example) => {
    push({ prompt: ex.prompt, aspect: ex.aspect });
    setOpen(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <section aria-labelledby="examples-heading" className="scroll-mt-24">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h2 id="examples-heading" className="font-display text-[28px] sm:text-[34px]">
            Prompts that worked
          </h2>
          <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-fog">
            {EXAMPLES.length} shots, each with the exact prompt that made it. Open one to read it, copy it, or start from it.
          </p>
        </div>
        <div role="radiogroup" aria-label="Filter prompts" className="scrollbar-none -mx-4 flex max-w-[calc(100%+2rem)] gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold",
                filter === f ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper",
              )}
            >
              {f}
              <span className={cn("tabular text-[11.5px]", filter === f ? "text-[#16131b]/55" : "text-haze")}>{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <div ref={ref} className="mt-6 flex items-start gap-3">
        {columns.map((col, c) => (
          <div key={c} className="flex min-w-0 flex-1 flex-col gap-3">
            {col.map((ex) => (
              <Card key={ex.id} ex={ex} copied={copied === ex.id} onOpen={() => setOpen(ex.id)} onUse={() => use(ex)} onCopy={() => void copy(ex)} />
            ))}
          </div>
        ))}
      </div>

      <Lightbox items={shown} openId={open} onClose={() => setOpen(null)} onMove={setOpen} onUse={use} copied={copied} onCopy={(ex) => void copy(ex)} />
    </section>
  );
}

function Card({ ex, copied, onOpen, onUse, onCopy }: { ex: Example; copied: boolean; onOpen: () => void; onUse: () => void; onCopy: () => void }) {
  return (
    <div className="group relative overflow-hidden rounded-[14px] bg-apple" style={{ aspectRatio: `${ex.width} / ${ex.height}` }}>
      <button type="button" onClick={onOpen} className="absolute inset-0 block size-full text-left" aria-label={`Open “${ex.title}” and its prompt`}>
        <Image
          src={ex.src}
          alt={ex.prompt}
          fill
          sizes={SIZES}
          className="object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.03]"
        />
      </button>
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/40 to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
        <p className="text-[12.5px] font-semibold text-paper">{ex.title}</p>
        <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-paper/75">{ex.prompt}</p>
        <div className="pointer-events-auto mt-2.5 flex gap-1.5">
          <button type="button" onClick={onUse} className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-spike px-2.5 text-[11.5px] font-bold text-spike-ink hover:bg-spike-hi">
            <CornerUpLeft size={12} strokeWidth={2.4} /> Use
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.14] px-2.5 text-[11.5px] font-semibold text-paper hover:bg-white/[0.22]"
          >
            {copied ? <Check size={12} strokeWidth={2.6} className="text-chroma" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The example big, with its whole prompt. Arrow keys step through the current filter. */
function Lightbox({
  items,
  openId,
  onClose,
  onMove,
  onUse,
  copied,
  onCopy,
}: {
  items: Example[];
  openId: string | null;
  onClose: () => void;
  onMove: (id: string) => void;
  onUse: (ex: Example) => void;
  copied: string | null;
  onCopy: (ex: Example) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const index = items.findIndex((e) => e.id === openId);
  const ex = index >= 0 ? items[index] : null;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (ex && !d.open) d.showModal();
    if (!ex && d.open) d.close();
  }, [ex]);

  const step = (by: number) => items.length && onMove(items[(index + by + items.length) % items.length].id);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") step(1);
        if (e.key === "ArrowLeft") step(-1);
      }}
      aria-label={ex ? ex.title : "Example"}
      className="lightbox m-auto max-h-[calc(100dvh-2rem)] w-[min(1180px,calc(100vw-2rem))] overflow-hidden rounded-panel bg-flat p-0 text-paper shadow-[0_0_0_1px_var(--color-line-strong),0_40px_120px_-20px_rgb(0_0_0/0.9)] backdrop:bg-black/80"
    >
      {ex ? (
        // Focus lands here rather than on the first button, so opening shows no stray focus ring.
        <div autoFocus tabIndex={-1} className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none lg:h-[min(calc(100dvh-4rem),860px)] lg:flex-row">
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/40 p-3 sm:p-5">
            <Image
              key={ex.id}
              src={ex.src}
              alt={ex.prompt}
              width={ex.width}
              height={ex.height}
              sizes="(min-width: 1024px) 760px, 100vw"
              className="h-auto max-h-[52dvh] w-auto max-w-full rounded-[12px] object-contain lg:max-h-full"
            />
            <NavButton side="left" onClick={() => step(-1)} />
            <NavButton side="right" onClick={() => step(1)} />
          </div>
          <div className="flex w-full shrink-0 flex-col overflow-y-auto p-5 sm:p-6 lg:w-[360px]">
            <div className="flex items-center justify-between gap-3">
              <span className="label">
                {ex.category} · {index + 1} / {items.length}
              </span>
              <button type="button" onClick={onClose} className="press grid size-8 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper" aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <h3 className="mt-3 font-display text-[24px]">{ex.title}</h3>
            <p className="mt-3 select-text text-[14px] leading-relaxed text-fog">
              <Vocabulary text={ex.prompt} />
            </p>
            <p className="mt-4 flex items-center gap-1.5 text-[12.5px] text-haze">
              <AspectGlyph id={ex.aspect} /> {ex.aspect}
            </p>
            <p className="mt-1.5 text-[12.5px] text-haze">
              <span className="underline decoration-spike/60 decoration-[1.5px] underline-offset-[3px]">Underlined</span> words set the camera, the light and the style.
            </p>
            <div className="mt-6 flex flex-wrap gap-2 lg:mt-auto lg:pt-6">
              <button
                type="button"
                onClick={() => onUse(ex)}
                className="lip press inline-flex h-10 items-center gap-2 rounded-btn bg-spike px-4 text-[13.5px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi"
              >
                <CornerUpLeft size={15} strokeWidth={2.4} /> Use this prompt
              </button>
              <button type="button" onClick={() => onCopy(ex)} className="press inline-flex h-10 items-center gap-2 rounded-btn bg-white/[0.07] px-4 text-[13.5px] font-semibold hover:bg-white/[0.12]">
                {copied === ex.id ? <Check size={15} className="text-chroma" /> : <Copy size={15} />}
                {copied === ex.id ? "Copied" : "Copy prompt"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** The words doing the camera, light and style work, longest first so phrases win over their parts. */
const TERMS = [
  "golden hour", "blue hour", "backlight", "backlit", "rim light", "side light", "window light", "hard noon sun", "hard sunlight", "soft light",
  "overcast", "spotlight", "catchlights", "sun rays", "neon", "moonlit", "lamp light", "stadium lights", "close-up", "wide shot", "low side angle",
  "low angle", "three-quarter overhead angle", "three-quarter", "overhead", "flat lay", "straight down", "symmetrical", "isometric", "telephoto",
  "wide-angle", "fisheye", "macro", "anamorphic", "long-exposure", "long exposure", "long lens", "shallow depth of field", "bokeh", "rangefinder",
  "high-speed", "film grain", "visible grain", "Kodak Portra 400", "color grade", "high contrast", "black-and-white", "teal and amber",
  "film still", "editorial", "documentary", "matte painting", "watercolor", "pixel art", "claymation", "stop-motion", "3D render", "concept art",
  "anime-style", "screen-print",
].sort((a, b) => b.length - a.length);
const VOCABULARY = new RegExp(String.raw`(\b\d{2,3}mm\b|f/\d(?:\.\d)?|1/\d+s|\b(?:${TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\b)`, "gi");

/** A prompt with its craft words underlined, so the vocabulary is easy to learn and reuse. */
function Vocabulary({ text }: { text: string }) {
  return text.split(VOCABULARY).map((part, i) =>
    i % 2 ? (
      <span key={i} className="text-paper underline decoration-spike/60 decoration-[1.5px] underline-offset-[3px]">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous example" : "Next example"}
      className={cn(
        "press absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-paper ring-1 ring-white/10 hover:bg-black/75",
        side === "left" ? "left-3 sm:left-4" : "right-3 sm:right-4",
      )}
    >
      <Icon size={18} />
    </button>
  );
}
