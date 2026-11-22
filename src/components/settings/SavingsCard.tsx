"use client";

import { useEffect, useState } from "react";
import type { Savings } from "@/lib/server/setup/savings";
import { cn } from "@/lib/cn";
import { usd } from "./EstimatePanel";

/**
 * Usage's headline: what your takes would have cost on the models' official APIs against what their GPU time cost here,
 * tool by tool. Both prices come from the same tables as the estimates; a tool that cost more here says so.
 */

const n = (x: number) => x.toLocaleString("en-US");

export function SavingsCard({ days }: { days: number | null }) {
  const [data, setData] = useState<Savings | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/settings/savings?days=${days == null ? "all" : days}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Savings>) : null))
      .then((d) => live && d && setData(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [days]);
  // Its place is held while the numbers come, so the page under it doesn't jump when they land.
  if (!data) return <div className="skeleton h-[280px] rounded-[22px]" aria-hidden="true" />;
  if (!data.takes) return null;
  const saved = data.api - data.here;
  const rows = data.byTool.filter((r) => r.api >= 0.01 || r.here >= 0.01).slice(0, 8);
  const max = Math.max(...rows.map((r) => Math.max(r.api, r.here)), 0.01);
  const range = data.days == null ? "so far" : `in the last ${data.days} days`;
  return (
    <section aria-label="What Crackio saved" className="squircle overflow-hidden rounded-[22px] bg-white/[0.035] shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-6 pb-5 pt-6">
        <div className="min-w-0">
          <p className="font-display text-[44px] leading-none tabular text-paper">
            {saved >= 0 ? usd(saved) : usd(-saved)} <span className="text-[24px] text-fog">{saved >= 0 ? "saved" : "more here"}</span>
          </p>
          <p className="mt-3 max-w-[64ch] text-[13.5px] leading-relaxed text-fog">
            {range[0].toUpperCase() + range.slice(1)}, your {n(data.takes)} takes would have cost <span className="font-semibold tabular text-paper">{usd(data.api)}</span> on the models&rsquo; official APIs. Their GPU time cost about{" "}
            <span className="font-semibold tabular text-paper">{usd(data.here)}</span> here{data.here < 0.01 ? ": they ran on your own computers" : ""}.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[12px] text-haze" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-fog/60" /> Official API
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-spike" /> Here
          </span>
        </div>
      </div>
      <ul className="space-y-2.5 border-t border-line px-6 py-5">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[120px_minmax(0,1fr)_132px] items-center gap-4 text-[12.5px] max-sm:grid-cols-[90px_minmax(0,1fr)]">
            <span className="min-w-0">
              <span className="block truncate font-medium text-paper">{r.label}</span>
              <span className="block text-[11.5px] text-haze">
                {n(r.takes)} {r.takes === 1 ? "take" : "takes"}
              </span>
            </span>
            <span className="flex flex-col gap-1" title={`${usd(r.api)} on the API, ${usd(r.here)} here`}>
              <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                <span className="block h-full rounded-full bg-fog/60" style={{ width: `${Math.max(1, (r.api / max) * 100)}%` }} />
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                <span className="block h-full rounded-full bg-spike" style={{ width: `${Math.max(1, (r.here / max) * 100)}%` }} />
              </span>
            </span>
            <span className="text-right tabular max-sm:col-span-2 max-sm:text-left">
              <span className="text-fog">{usd(r.api)}</span>
              <span className="text-haze"> · </span>
              <span className={cn(r.here > r.api ? "text-tungsten" : "text-paper")}>{usd(r.here)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-6 py-3.5 text-[11.5px] leading-snug text-haze">
        {data.note}
        {data.skipped ? ` ${n(data.skipped)} takes without a price to compare (voice, lip sync) aren't counted.` : ""}
      </p>
    </section>
  );
}
