"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, Flame, MousePointerClick, Search, Upload } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { HoverClip } from "@/components/dashboard/HoverClip";
import { TEMPLATES } from "@/lib/templates/library";
import { heatBadge, heatOf, inSeason, swapLabel } from "@/lib/templates/meta";
import { previewUrl } from "@/lib/media-url";
import { useNow } from "@/lib/hooks/use-now";
import { CATEGORIES, type Template, type TemplateCategory } from "@/lib/templates/types";
import { cn } from "@/lib/cn";

type Filter = "all" | TemplateCategory;

/**
 * Every template: Crackio's own clips, made on open models with nobody's footage, likeness, music or brand in them,
 * and your own clip.
 */
export function TemplatesLibrary() {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const now = useNow();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter((t) => {
      if (!inSeason(t, now)) return false;
      if (filter !== "all" && !t.categories.includes(filter)) return false;
      if (!q) return true;
      return `${t.title} ${t.line} ${t.categories.join(" ")} ${swapLabel(t)}`.toLowerCase().includes(q);
    });
  }, [filter, query, now]);

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-start gap-3">
          <AppIcon glyph="/icons/templates.png" size={36} className="mt-1" />
          <div className="min-w-0">
            <h1 className="font-display text-[30px] sm:text-[34px]">Templates</h1>
            <p className="mt-1 max-w-[68ch] text-[15px] leading-relaxed text-haze">
              Clips to star in, made by Crackio on open models and yours to post, or bring your own. Add yourself, a friend or your product, and Crackio writes the exact edit for the model.
            </p>
          </div>
        </div>
        <label className="field-focus squircle flex h-10 w-full max-w-[300px] items-center gap-2 rounded-[14px] bg-apple px-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Search size={15} className="text-haze" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-haze"
          />
        </label>
      </header>

      <Link
        href="/tools/recast"
        className="press group mt-6 flex items-center gap-4 overflow-hidden rounded-[20px] bg-[linear-gradient(110deg,rgb(215_132_255/0.16),rgb(255_91_46/0.12)_55%,transparent)] p-4 shadow-[inset_0_0_0_1px_var(--color-line-strong)] sm:p-5"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-white/[0.08] text-paper">
          <MousePointerClick size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[19px] leading-tight text-paper">New: Swap anything in any clip</span>
          <span className="mt-0.5 block text-[13px] leading-snug text-fog">Click people, products or cars, pick what each becomes (your Cast, a picture, a colour), and keep every move. On your own GPU.</span>
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-[13px] font-semibold text-paper sm:inline-flex">
          Open Swap <ArrowUpRight size={15} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
      </Link>

      <div className="scrollbar-none mt-5 flex gap-1.5 overflow-x-auto pb-1">
        {(["all", ...CATEGORIES.map((c) => c.id).filter((c) => TEMPLATES.some((t) => t.categories.includes(c)))] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              "press squircle inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[12px] px-3.5 text-[13px] font-semibold",
              filter === f ? "bg-paper text-[#16171a]" : "bg-apple-2 text-fog hover:bg-gaffer hover:text-paper",
            )}
          >
            {f === "all" ? "All" : CATEGORIES.find((c) => c.id === f)?.label}
          </button>
        ))}
      </div>

      {shown.length ? (
        <ul className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {shown.map((t, i) => (
            <li key={t.id}>
              <TemplateCard t={t} heat={heatOf(t, now)} badge={heatBadge(t)} priority={i < 6} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-16 text-center">
          <p className="font-display text-[22px]">No templates match</p>
          <p className="mt-2 text-[14px] text-fog">Try another word, or bring your own clip.</p>
          <Link href="/templates/any-clip" className="mt-4 inline-flex text-[14px] font-semibold text-paper hover:underline">
            Put yourself in any clip
          </Link>
        </div>
      )}
    </div>
  );
}

function TemplateCard({ t, heat, badge, priority }: { t: Template; heat: number; badge?: string | null; priority?: boolean }) {
  const hot = heat >= 4;
  if (!t.poster) {
    // "Any clip": nothing to preview until you bring one.
    return (
      <Link href={`/templates/${t.id}`} className="group block">
        <div className="relative flex aspect-[9/16] flex-col items-center justify-center gap-3 overflow-hidden rounded-[16px] bg-white/[0.025] p-5 text-center shadow-[inset_0_0_0_1.5px_var(--color-line-strong)] transition-colors group-hover:bg-white/[0.05]">
          <span className="grid size-12 place-items-center rounded-full bg-spike/15 text-spike">
            <Upload size={20} />
          </span>
          <h3 className="font-display text-[18px] uppercase leading-[1.02] tracking-[-0.01em] text-paper">{t.title}</h3>
          <p className="text-[12px] leading-snug text-fog">{t.line}</p>
        </div>
      </Link>
    );
  }
  return (
    <Link href={`/templates/${t.id}`} className="group block" title={t.trend.note}>
      <div className="relative aspect-[9/16] overflow-hidden rounded-[16px] bg-apple">
        {/* eslint-disable-next-line @next/next/no-img-element -- a plain still under the hover clip */}
        <img
          src={t.poster}
          alt=""
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.035]"
        />
        <HoverClip src={previewUrl(t.clip, 640)} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
        <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1">
          <span className="rounded-[7px] bg-black/60 px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-white">{swapLabel(t)}</span>
        </div>
        {hot ? (
          <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-[7px] bg-spike px-1.5 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-spike-ink">
            <Flame size={11} /> Hot
          </span>
        ) : null}
        <div className="absolute inset-x-3 bottom-3">
          {badge ? <p className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.06em] text-spike">{badge}</p> : null}
          <h3 className="font-display text-[17px] uppercase leading-[1.02] tracking-[-0.01em] text-white sm:text-[18px]">{t.title}</h3>
          <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-white/75">{t.line}</p>
        </div>
      </div>
    </Link>
  );
}
