"use client";

import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { estimateCost, formatMoney, type Cost, type CostInput, type Pricing, type QuoteSettings } from "@/lib/models/pricing";
import { DEMO_FULL } from "@/lib/demo/config";
import { cn } from "@/lib/cn";

const prices = new Map<string, Promise<Pricing>>();
const refining = (p: Pricing) => "refining" in p && Boolean(p.refining);

function pricingOf(id: string, fresh = false): Promise<Pricing> {
  let p = fresh ? undefined : prices.get(id);
  if (!p) {
    p = fetch(`/api/models/price?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ pricing?: Pricing }>)
      .then((d) => d.pricing ?? { kind: "none" as const })
      .catch(() => ({ kind: "none" as const }));
    const mine = p;
    prices.set(id, mine);
    // Prices change rarely; ask again after a while, or soon when none (or only a base rate) came back.
    void mine.then((v) => setTimeout(() => prices.get(id) === mine && prices.delete(id), v.kind === "none" || refining(v) ? 30_000 : 10 * 60_000));
  }
  return p;
}

/** How a result is counted in the line: "this clip", "these 2 images", "this edit". */
function what(input: CostInput, noun?: string) {
  if (noun) return noun;
  if (input.output === "video") return input.count > 1 ? `these ${input.count} clips` : "this clip";
  return input.count > 1 ? `these ${input.count} images` : "this image";
}

/**
 * What the next generation will cost with the model and settings on screen: "≈ $0.56 this clip ·
 * $0.14/s × 4 s". It follows resolution, sound, quality, length and takes. Plans say they include
 * it; quotes (Comfy) are asked for as settings change.
 */
/**
 * How a model is priced (plans, unit rates, quotes), fetched once and shared by every line and
 * picker that shows it. While its detailed rates are being read, it asks again every few seconds.
 */
export function usePricing(modelId: string | null): Pricing | null {
  const [pricing, setPricing] = useState<{ id: string; value: Pricing; tries: number } | null>(null);

  useEffect(() => {
    if (!modelId) return;
    let alive = true;
    void pricingOf(modelId).then((value) => alive && setPricing({ id: modelId, value, tries: 0 }));
    return () => {
      alive = false;
    };
  }, [modelId]);

  const again = pricing && pricing.id === modelId && refining(pricing.value) && pricing.tries < 6 ? pricing : null;
  useEffect(() => {
    if (!again) return;
    let alive = true;
    const t = setTimeout(() => void pricingOf(again.id, true).then((value) => alive && setPricing({ id: again.id, value, tries: again.tries + 1 })), 3500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [again]);

  return pricing && pricing.id === modelId ? pricing.value : null;
}

export function CostLine({
  modelId,
  input,
  quote,
  noun,
  className,
}: {
  modelId: string | null;
  input: CostInput;
  /** The same settings for a provider that quotes exact requests. */
  quote: QuoteSettings;
  /** Overrides "this clip" / "this image" ("this edit", "this upscale"). */
  noun?: string;
  className?: string;
}) {
  const [quoted, setQuoted] = useState<{ key: string; cost: Cost | null } | null>(null);
  const current = usePricing(modelId);
  // The model and the settings as one string, so a quote is asked for only when either changes.
  const quoteKey = modelId && current?.kind === "quote" ? JSON.stringify({ id: modelId, settings: quote }) : null;

  // Quotes follow the settings, a moment after they settle.
  useEffect(() => {
    if (!quoteKey) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch("/api/models/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteKey, signal: ctrl.signal })
        .then((r) => r.json() as Promise<{ cost?: Cost | null }>)
        .then((d) => setQuoted({ key: quoteKey, cost: d.cost ?? null }))
        .catch(() => {});
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [quoteKey]);

  if (!modelId || !current || current.kind === "none") return null;
  if (current.kind === "plan") {
    return (
      <p className={cn("flex items-center gap-1.5 px-1 text-[12px] text-haze", className)}>
        <CircleDollarSign size={13} className="shrink-0" /> Included in your {current.plan} plan
      </p>
    );
  }
  const cost = current.kind === "quote" ? (quoted?.key === quoteKey ? quoted.cost : null) : estimateCost(current, input);
  if (!cost) return null;
  return (
    <p className={cn("flex min-w-0 items-center justify-between gap-3 px-1 text-[12px] text-haze", className)} aria-live="polite">
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <CircleDollarSign size={13} className="shrink-0" />
        <span>
          {cost.approximate ? "≈ " : ""}
          <span className="tabular font-semibold text-paper">{formatMoney(cost.amount)}</span> {what(input, noun)}
          {DEMO_FULL ? <span title="It runs on your own Comfy key, so it takes no demo credits."> · free (your own key)</span> : null}
        </span>
      </span>
      <span className="min-w-0 truncate text-right" title={cost.detail}>
        {cost.detail}
      </span>
    </p>
  );
}
