"use client";

import Link from "next/link";
import { ArrowRight, Flame } from "lucide-react";
import { HoverClip } from "./HoverClip";
import { TEMPLATES } from "@/lib/templates/library";
import { heatOf, inSeason, swapLabel } from "@/lib/templates/meta";
import { previewUrl } from "@/lib/media-url";
import { useNow } from "@/lib/hooks/use-now";

/** Crackio's own templates, the liveliest first, a row of tall cards; each clip plays on hover only. */
export function TemplatesRow() {
  const now = useNow();
  const hottest = TEMPLATES.filter((t) => t.poster && inSeason(t, now))
    .map((t, i) => ({ t, i, h: heatOf(t, now) }))
    .sort((a, b) => b.h - a.h || a.i - b.i)
    .slice(0, 10)
    .map((x) => x.t);
  if (!hottest.length) return null;

  return (
    <section aria-labelledby="templates-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="templates-heading" className="font-display text-[28px] sm:text-[34px]">
          Templates
        </h2>
        <Link href="/templates" className="inline-flex items-center gap-1 text-[14px] font-semibold text-fog hover:text-paper">
          All {TEMPLATES.length} <ArrowRight size={14} />
        </Link>
      </div>
      <ul className="scrollbar-none -mx-1 mt-5 flex gap-3 overflow-x-auto px-1 pb-1">
        {hottest.map((t) => {
          return (
            <li key={t.id} className="w-[46vw] shrink-0 sm:w-[30vw] md:w-[22vw] lg:w-[15.5vw] xl:w-[13vw] 2xl:w-[200px]">
              <Link href={`/templates/${t.id}`} className="group block" title={t.trend.note}>
                <div className="relative aspect-[9/16] overflow-hidden rounded-[16px] bg-apple">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a plain still under the hover clip */}
                  <img src={t.poster} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.035]" />
                  <HoverClip src={previewUrl(t.clip, 640)} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
                  <span className="absolute left-2.5 top-2.5 rounded-[7px] bg-black/60 px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-white">{swapLabel(t)}</span>
                  {heatOf(t, now) >= 4 ? (
                    <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-[7px] bg-spike px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-spike-ink">
                      <Flame size={11} /> Hot
                    </span>
                  ) : null}
                  <div className="absolute inset-x-3 bottom-3">
                    {t.trend.views ? <p className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.06em] text-spike">{t.trend.views}</p> : null}
                    <h3 className="font-display text-[16px] uppercase leading-[1.02] tracking-[-0.01em] text-white">{t.title}</h3>
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
