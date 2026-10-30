"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Sparkles } from "lucide-react";
import { HoverPreview } from "@/components/video/HoverPreview";
import { previewIdea, previewSamples, previewSrc, sampleById, tileSample, type PreviewAxis, type PreviewContext, type SampleId } from "@/lib/product/previews";
import type { StudioOption } from "@/lib/product/vocab";
import { cn } from "@/lib/cn";

/**
 * A grid of picks, each one a real shot made with it. Hover one to see it play out on several
 * very different products (and what Crackio made of each); the tiles show the one closest to yours.
 */
export function OptionGrid<T extends string>({
  axis,
  options,
  value,
  onChange,
  sample,
  ctx,
}: {
  axis: PreviewAxis;
  options: readonly StudioOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The sample that looks most like your product; otherwise the tiles show a range of products. */
  sample: SampleId | null;
  /** Which previews to show: the product on its own or someone using it, like the shot you picked. */
  ctx?: PreviewContext;
}) {
  return (
    <div role="radiogroup" className="grid grid-cols-4 gap-1.5">
      {options.map((o, i) => {
        const active = value === o.id;
        const available = previewSamples(axis, o.id, ctx);
        const shown = tileSample(available, sample, i);
        return (
          <HoverPreview
            key={o.id}
            title={o.label}
            caption={o.caption}
            width={272}
            ratio={4 / 5}
            media={shown ? <PreviewCycle axis={axis} id={o.id} samples={available} first={shown} ctx={ctx} /> : <span className="absolute inset-0 bg-apple-2" />}
          >
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={o.label}
              onClick={() => onChange(o.id)}
              className={cn(
                "press group relative aspect-square w-full overflow-hidden rounded-[12px] bg-apple-2 text-left transition-shadow",
                active ? "" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
              )}
            >
              {shown ? <Thumb src={previewSrc(axis, o.id, shown, true, ctx)} /> : null}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-6">
                <span className={cn("block truncate text-[11.5px] font-semibold leading-tight", active ? "text-white" : "text-white/85")}>{o.label}</span>
              </span>
              {o.id === "auto" ? (
                <span className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-black/55 text-white" title="Crackio decides">
                  <Sparkles size={11} />
                </span>
              ) : null}
              {active ? (
                <motion.span
                  layoutId={`pick-${axis}`}
                  className="pointer-events-none absolute inset-0 rounded-[12px] shadow-[inset_0_0_0_2px_var(--color-spike)]"
                  transition={{ type: "spring", bounce: 0.18, duration: 0.38 }}
                >
                  <span className="absolute right-1.5 top-1.5 grid size-[18px] place-items-center rounded-full bg-spike text-spike-ink">
                    <Check size={11} strokeWidth={3} />
                  </span>
                </motion.span>
              ) : null}
            </button>
          </HoverPreview>
        );
      })}
    </div>
  );
}

/** A tile's picture; until its preview exists, a quiet empty tile instead of a broken image. */
function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  // A picture that failed before the page came alive never fires onError for React: check once mounted.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth === 0) setFailed(src);
  }, [src]);
  if (failed === src) return <span className="absolute inset-0 bg-gradient-to-br from-white/[0.06] to-transparent" />;
  return (
    <img
      ref={img}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
      className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.06]"
    />
  );
}

/** One option on each of its sample products in turn, starting with `first`, with what the director made of each. */
export function PreviewCycle({
  axis,
  id,
  samples,
  first,
  ctx,
  interval = 1600,
}: {
  axis: PreviewAxis;
  id: string;
  samples: SampleId[];
  first: SampleId;
  ctx?: PreviewContext;
  interval?: number;
}) {
  const order = [first, ...samples.filter((s) => s !== first)];
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (order.length < 2) return;
    const t = setInterval(() => setAt((x) => (x + 1) % order.length), interval);
    return () => clearInterval(t);
  }, [order.length, interval]);
  const current = order[at % order.length];
  const idea = previewIdea(axis, id, current, ctx);
  return (
    <>
      {order.map((s, k) => (
        <img
          key={s}
          src={previewSrc(axis, id, s, false, ctx)}
          alt=""
          // Only the next picture loads ahead; the rest as the cycle gets to them.
          loading={Math.abs(k - (at % order.length)) <= 1 ? "eager" : "lazy"}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-500", k === at % order.length ? "opacity-100" : "opacity-0")}
        />
      ))}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-10">
        <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/65">{sampleById(current).label}</p>
        {idea ? <p className="mt-0.5 text-[12.5px] font-semibold leading-snug text-white">{idea}</p> : null}
        {order.length > 1 ? (
          <div className="mt-2 flex gap-1">
            {order.map((s, k) => (
              <span key={s} className={cn("h-[3px] flex-1 rounded-full transition-colors duration-300", k === at % order.length ? "bg-white" : "bg-white/25")} />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
