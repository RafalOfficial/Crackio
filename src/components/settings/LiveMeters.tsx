"use client";

import { Activity, Flame, Gauge, MemoryStick, Zap } from "lucide-react";
import type { LiveGpu } from "@/lib/setup/types";
import { cn } from "@/lib/cn";

/**
 * A machine's GPU right now: its load, memory in use, temperature and power, and what ComfyUI is working on. The full
 * meters sit on a machine's page; the one line goes on its card. Heat turns amber past 80 °C and red past 88.
 */

const heatTone = (c: number | null | undefined) => (c == null ? "text-fog" : c >= 88 ? "text-tally" : c >= 80 ? "text-tungsten" : "text-fog");

/** What ComfyUI is doing there, in a few words. */
export function workWords(l: LiveGpu) {
  if (!l.online) return "Not answering";
  if (l.working) return l.running ? `Working: ${l.running}${l.queue > 1 ? ` (+${l.queue - 1} waiting)` : ""}` : `Working${l.queue > 1 ? ` (${l.queue} jobs)` : ""}`;
  if ((l.util ?? 0) >= 10) return "Busy outside ComfyUI";
  return "Idle";
}

function Bar({ value, tone = "bg-fog/80" }: { value: number | null; tone?: string }) {
  return (
    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      <span className={cn("block h-full rounded-full transition-[width] duration-700 ease-out", tone)} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
    </span>
  );
}

export function LiveMeters({ live }: { live: LiveGpu | undefined }) {
  if (!live) return null;
  const mem = live.memUsedGb != null && live.memTotalGb ? (100 * live.memUsedGb) / live.memTotalGb : null;
  const tiles = [
    { icon: Gauge, label: "GPU load", value: live.util != null ? `${Math.round(live.util)}%` : "—", bar: live.util, tone: "bg-fog/80" },
    {
      icon: MemoryStick,
      label: "Graphics memory",
      value: live.memUsedGb != null && live.memTotalGb ? `${live.memUsedGb.toFixed(1)} of ${Math.round(live.memTotalGb)} GB` : "—",
      bar: mem,
      tone: mem != null && mem > 92 ? "bg-tungsten" : "bg-fog/80",
    },
    {
      icon: Flame,
      label: "Heat",
      value: live.tempC != null ? `${Math.round(live.tempC)} °C` : live.thermal ? live.thermal : "—",
      bar: live.tempC != null ? Math.min(100, (live.tempC / 95) * 100) : null,
      tone: live.tempC != null && live.tempC >= 88 ? "bg-tally" : live.tempC != null && live.tempC >= 80 ? "bg-tungsten" : "bg-fog/80",
      valueTone: heatTone(live.tempC),
    },
    { icon: Zap, label: "Power", value: live.powerW != null ? `${Math.round(live.powerW)} W` : "—", bar: null, tone: "" },
  ];
  return (
    <section aria-label="Right now" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-paper">Right now</h3>
        <span className={cn("inline-flex items-center gap-1.5 text-[12.5px]", live.working ? "text-paper" : "text-haze")}>
          <Activity size={13} className={live.working ? "text-spike" : "text-haze"} />
          {workWords(live)}
        </span>
      </div>
      <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <li key={t.label} className="squircle rounded-[16px] bg-white/[0.035] px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="flex items-center gap-1.5 text-[12px] text-haze">
              <t.icon size={13} strokeWidth={1.8} />
              {t.label}
            </span>
            <span className={cn("mt-1 block text-[18px] font-semibold tabular", t.valueTone ?? "text-paper")}>{t.value}</span>
            {t.bar != null ? <Bar value={t.bar} tone={t.tone} /> : <span className="mt-2 block h-1.5" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The one line for a machine's card: "GPU 87% · 21 of 32 GB · 64 °C · Wan 2.2 5B". */
export function LiveLine({ live, className }: { live: LiveGpu | undefined; className?: string }) {
  if (!live || !live.online) return null;
  const parts = [
    live.util != null ? `GPU ${Math.round(live.util)}%` : null,
    live.memUsedGb != null && live.memTotalGb ? `${Math.round(live.memUsedGb)} of ${Math.round(live.memTotalGb)} GB` : null,
    live.tempC != null ? `${Math.round(live.tempC)} °C` : live.thermal ? live.thermal : null,
  ].filter(Boolean);
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-[12px] tabular text-haze", className)}>
      <Activity size={12} className={live.working ? "shrink-0 text-spike" : "shrink-0"} />
      <span className="truncate">
        {parts.join(" · ")}
        {live.working ? <span className="text-fog"> · {live.running ?? "working"}</span> : null}
      </span>
    </p>
  );
}
