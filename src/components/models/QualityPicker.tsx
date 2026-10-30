"use client";

import { useState } from "react";
import { fitResolution, resolutionLabel, type Caps, type CapChoice } from "@/lib/models/caps";
import { estimateCost, formatMoney, type CostInput, type Pricing } from "@/lib/models/pricing";
import { TierPills } from "./TierPills";
import { cn } from "@/lib/cn";

/** Sizes offered for models that take any width and height (and price by the megapixel). */
const SIZES = [1, 2, 4];

/**
 * The resolution, quality and size a picture is made at, snapped to what the model offers. Your
 * last pick is kept across models (the nearest one each model has).
 */
export function useOutputQuality(caps: Caps | null) {
  const [res, setResolution] = useState<string | null>(null);
  const [wantedQuality, setQuality] = useState<string | null>(null);
  const [mp, setMegapixels] = useState<number | null>(null);
  const resChoices: CapChoice[] = caps?.resolution?.choices ?? [];
  const qualityChoices: CapChoice[] = caps?.quality?.choices ?? [];
  const sizes = caps?.size?.custom && !resChoices.length ? SIZES : null;
  const resolution = resChoices.length ? String(fitResolution(resChoices, res ?? undefined, caps?.resolution?.default ?? null) ?? resChoices[0].value) : null;
  const pickedQuality = qualityChoices.find((c) => String(c.value) === wantedQuality) ?? qualityChoices.find((c) => c.value === caps?.quality?.default) ?? qualityChoices[0];
  const quality = pickedQuality ? String(pickedQuality.value) : null;
  const megapixels = sizes ? (mp ?? 1) : null;
  return {
    resolution,
    quality,
    megapixels,
    resChoices,
    qualityChoices,
    sizes,
    setResolution,
    setQuality,
    setMegapixels,
    /** For the job's options (a 1 MP size is the model's own default, so it isn't sent). */
    options: { ...(resolution ? { resolution } : {}), ...(quality ? { quality } : {}), ...(megapixels && megapixels !== 1 ? { megapixels } : {}) },
    /** For the cost line (a size only once you pick one: until then an edit keeps its picture's size). */
    cost: { resolution, quality, ...(sizes && mp ? { megapixels: mp } : {}) },
  };
}

export type OutputQuality = ReturnType<typeof useOutputQuality>;

/** Whether the model has anything to pick here. */
export const hasQualityChoices = (q: OutputQuality) => q.resChoices.length > 1 || q.qualityChoices.length > 1 || Boolean(q.sizes);

/**
 * Pills for the resolution, quality and size a picture is made at. Each shows what one image costs
 * that way when the price depends on it, so you can pick by price too.
 */
export function QualityPicker({
  q,
  pricing,
  input,
  layout = "rows",
  look,
  className,
}: {
  q: OutputQuality;
  pricing?: Pricing | null;
  /** The rest of the settings, to price each option with. */
  input?: CostInput;
  /** "rows": a label beside each set (settings lists); "stack": label above (tool panels). */
  layout?: "rows" | "stack";
  /** "tiers": the Home bar's look, a sliding highlight colored by how grand the resolution is (TierPills). */
  look?: "tiers";
  className?: string;
}) {
  const price = (patch: Partial<CostInput>) => {
    if (!pricing || !input || pricing.kind === "plan" || pricing.kind === "quote" || pricing.kind === "none") return null;
    return estimateCost(pricing, { ...input, count: 1, ...patch });
  };
  const sets = [
    q.resChoices.length > 1
      ? {
          label: "Resolution",
          value: q.resolution,
          set: q.setResolution,
          options: q.resChoices.map((c) => ({ value: String(c.value), label: c.label && c.label !== String(c.value) ? c.label : resolutionLabel(c.value), cost: price({ resolution: String(c.value) }) })),
        }
      : null,
    q.qualityChoices.length > 1
      ? {
          label: "Quality",
          value: q.quality,
          set: q.setQuality,
          options: q.qualityChoices.map((c) => ({ value: String(c.value), label: c.label || String(c.value), cost: price({ quality: String(c.value) }) })),
        }
      : null,
    q.sizes
      ? {
          label: "Size",
          value: String(q.megapixels ?? 1),
          set: (v: string) => q.setMegapixels(Number(v)),
          options: q.sizes.map((n) => ({ value: String(n), label: `${n} MP`, cost: price({ megapixels: n }) })),
        }
      : null,
  ].filter((s): s is NonNullable<typeof s> => s !== null);
  if (!sets.length) return null;

  return (
    <div className={cn(layout === "rows" ? "divide-y divide-line" : "space-y-3", className)}>
      {sets.map((s) => {
        // Prices only when they differ: the same number under every pill says nothing.
        const amounts = s.options.map((o) => (o.cost ? formatMoney(o.cost.amount) : null));
        const showPrices = amounts.every(Boolean) && new Set(amounts).size > 1;
        return (
          <div key={s.label} className={cn(layout === "rows" ? "flex min-h-12 items-center gap-3 px-3 py-2" : "space-y-1.5")}>
            <span className={cn(layout === "rows" ? "w-[76px] shrink-0 text-[13px] text-haze" : "label block")}>{s.label}</span>
            {look === "tiers" ? (
              <TierPills
                label={s.label}
                value={s.value}
                onPick={s.set}
                tiered={s.label === "Resolution"}
                options={s.options.map((o, i) => ({
                  value: o.value,
                  label: o.label,
                  sub: showPrices ? amounts[i] : null,
                  title: o.cost ? `${o.cost.approximate ? "About " : ""}${formatMoney(o.cost.amount)} an image` : undefined,
                }))}
              />
            ) : (
              <div role="radiogroup" aria-label={s.label} className={cn("flex min-w-0 flex-1 flex-wrap gap-1 rounded-[14px] bg-white/[0.05] p-1", layout === "rows" && "justify-end")}>
                {s.options.map((o, i) => {
                  const on = o.value === s.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => s.set(o.value)}
                      title={o.cost ? `${o.cost.approximate ? "About " : ""}${formatMoney(o.cost.amount)} an image` : undefined}
                      className={cn(
                        "press flex min-w-[46px] flex-1 flex-col items-center justify-center rounded-[10px] px-2 text-[12.5px] font-semibold transition-colors",
                        showPrices ? "h-10" : "h-8",
                        on ? "bg-paper text-[#16131b]" : "text-fog hover:bg-white/[0.06] hover:text-paper",
                      )}
                    >
                      <span className="leading-none">{o.label}</span>
                      {showPrices ? <span className={cn("tabular mt-0.5 text-[10.5px] font-medium leading-none", on ? "text-[#16131b]/70" : "text-haze")}>{amounts[i]}</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
