"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Sparkles, TriangleAlert } from "lucide-react";
import { HoverPreview } from "@/components/video/HoverPreview";
import { filmPreviews, tilePreview, type FilmPreview } from "@/lib/product/film-previews";
import type { FilmAxis, FilmOption } from "@/lib/product/film";
import { cn } from "@/lib/cn";

/**
 * A grid of Video picks, each one a real clip made with it. A tile shows the clip's first frame;
 * hover it and the clip plays, with what the director made of it.
 */
export function FilmOptionGrid<T extends string>({
  axis,
  options,
  value,
  onChange,
  like,
  warn,
  cols = 4,
}: {
  axis: FilmAxis;
  options: readonly FilmOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The product your picture shows, so tiles show a preview like it when there is one. */
  like: string | null;
  /** Why an option won't work on the model you picked (shown on the tile). */
  warn?: (o: FilmOption<T>) => string | null;
  cols?: 3 | 4;
}) {
  return (
    <div role="radiogroup" className={cn("grid gap-1.5", cols === 3 ? "grid-cols-3" : "grid-cols-4")}>
      {options.map((o, i) => {
        const active = value === o.id;
        const list = filmPreviews(axis, o.id);
        const shown = tilePreview(list, like, i);
        const problem = warn?.(o) ?? null;
        return (
          <HoverPreview
            key={o.id}
            title={o.label}
            caption={problem ? `${o.caption} ${problem}.` : o.caption}
            width={shown && shown.ratio >= 1 ? 320 : 230}
            ratio={shown?.ratio ?? 9 / 16}
            media={shown ? <ClipCycle list={list} first={shown} /> : <span className="absolute inset-0 bg-apple-2" />}
          >
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={o.label}
              onClick={() => onChange(o.id)}
              className={cn(
                "press group relative aspect-[4/5] w-full overflow-hidden rounded-[12px] bg-apple-2 text-left transition-shadow",
                active ? "" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
              )}
            >
              {shown ? <Poster src={shown.poster} /> : <span className="absolute inset-0 bg-gradient-to-br from-white/[0.07] to-transparent" />}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-6">
                <span className={cn("block truncate text-[11.5px] font-semibold leading-tight", active ? "text-white" : "text-white/85")}>{o.label}</span>
              </span>
              {o.id === "auto" ? (
                <span className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-black/55 text-white" title="Crackio decides">
                  <Sparkles size={11} />
                </span>
              ) : null}
              {problem ? (
                <span className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-tungsten text-[#1c1406]" title={problem}>
                  <TriangleAlert size={11} />
                </span>
              ) : null}
              {active ? (
                <motion.span
                  layoutId={`film-pick-${axis}`}
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

/** A tile's still; until its preview exists, a quiet empty tile instead of a broken image. */
function Poster({ src }: { src: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
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

/** One option's clips in turn (each plays through, then the next), with what the director made of each. */
export function ClipCycle({ list, first, muted = true, onEnded }: { list: FilmPreview[]; first: FilmPreview; muted?: boolean; onEnded?: () => void }) {
  const order = [first, ...list.filter((p) => p.clip !== first.clip)];
  const [at, setAt] = useState(0);
  const current = order[at % order.length];
  return (
    <>
      <video
        key={current.clip}
        src={current.clip}
        poster={current.poster}
        autoPlay
        muted={muted}
        playsInline
        loop={order.length < 2}
        onEnded={() => {
          setAt((x) => (x + 1) % order.length);
          onEnded?.();
        }}
        className="absolute inset-0 size-full object-cover"
      />
      {current.idea || order.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-2.5 pt-10">
          {current.idea ? <p className="text-[12px] font-semibold leading-snug text-white">{current.idea}</p> : null}
          {order.length > 1 ? (
            <div className="mt-2 flex gap-1">
              {order.map((p, k) => (
                <span key={p.clip} className={cn("h-[3px] flex-1 rounded-full transition-colors duration-300", k === at % order.length ? "bg-white" : "bg-white/25")} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
