"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { radioArrows, radioTab } from "@/lib/roving";
import type { UsageDay, UsageModel, UsageSummary } from "@/lib/usage/types";
import { Heading, Loading, ProblemCard, Tape, Verdict } from "./parts";
import { SavingsCard } from "./SavingsCard";

/**
 * Settings → Usage: how much Crackio made, how often it worked first time, and what each model takes on each machine.
 * A few numbers, one bar a day, one table (server/usage reads the Library's takes, their recipes and measured speeds).
 */

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: null, label: "All time" },
] as const;

/** Validated for the dark stage (dataviz validate_palette: lightness band, CVD and contrast pass), in this fixed order. */
const SERIES = [
  { key: "pictures", label: "Pictures", color: "#3987e5" },
  { key: "clips", label: "Clips", color: "#d55181" },
  { key: "audio", label: "Voice", color: "#9085e9" },
  { key: "other", label: "Other", color: "#6b6670" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

const n = (v: number) => v.toLocaleString("en-US");
const secs = (s: number | null) => (s == null ? "–" : s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s` : s < 3600 ? `${(s / 60).toFixed(s < 600 ? 1 : 0)} min` : `${(s / 3600).toFixed(1)} h`);
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(h < 10 ? 1 : 0)} h`);

export function UsageView() {
  const [days, setDays] = useState<number | null>(30);
  const [machine, setMachine] = useState<string>("");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ days: days == null ? "all" : String(days), ...(machine ? { machine } : {}) });
    fetch(`/api/settings/usage?${q}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<UsageSummary>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, machine]);

  if (!data) return error ? <ProblemCard title="Crackio couldn't count your takes" why={error} /> : <Loading rows={5} />;
  const t = data.totals;
  const range = days == null ? "so far" : `in the last ${days} days`;
  return (
    <div className="space-y-10">
      <Verdict
        title="Usage"
        facts={`${n(t.generations)} takes ${range}${t.firstTry != null ? ` · ${Math.round(t.firstTry * 100)}% worked first try` : ""} · ${hours(t.gpuHours)} of GPU work${t.rentedHours ? `, ${hours(t.rentedHours)} of it on rented GPUs` : ""}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Pills value={String(days)} onChange={(v) => setDays(v === "null" ? null : Number(v))} options={RANGES.map((r) => ({ value: String(r.days), label: r.label }))} />
        <select
          value={machine}
          onChange={(e) => setMachine(e.target.value)}
          aria-label="Machine"
          className="field-focus h-9 rounded-[11px] bg-white/[0.05] px-3 text-[13px] font-medium text-paper outline-none"
        >
          <option value="">Every machine</option>
          {data.machines.map((m) => (
            <option key={m.machine} value={m.machine}>
              {m.machine}
            </option>
          ))}
        </select>
      </div>

      <SavingsCard days={days} />

      <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
        <Figure label="Pictures" value={n(t.pictures)} />
        <Figure label="Clips" value={n(t.clips)} />
        <Figure label="Voice takes" value={n(t.audio)} />
        <Figure label="Failed" value={n(t.failed)} note={t.cancelled ? `${n(t.cancelled)} stopped by you` : undefined} />
      </dl>

      <section className="space-y-3">
        <Heading title="Every day" note="Finished takes by what they made. Point at a day for its numbers." />
        <DayChart days={data.days} />
      </section>

      <section className="space-y-3">
        <Heading title="Models and machines" note="Usual time is ComfyUI's own working time per take on that machine; the estimate is what Crackio said beforehand." />
        <ModelTable models={data.models} />
      </section>

      <section className="space-y-3">
        <Heading title="Tools" />
        <ToolTable tools={data.tools} />
      </section>

      {data.notes.length ? (
        <ul className="max-w-[86ch] list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-haze">
          {data.notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[12.5px] text-haze">{label}</dt>
      <dd className="mt-1 font-display text-[28px] leading-none tabular text-paper">{value}</dd>
      {note ? <dd className="mt-1 text-[12px] text-haze">{note}</dd> : null}
    </div>
  );
}

function Pills({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div role="radiogroup" aria-label="Range" onKeyDown={radioArrows} className="squircle inline-flex rounded-[12px] bg-white/[0.05] p-0.5">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={radioTab(on, i, options.some((x) => x.value === value))}
            onClick={() => onChange(o.value)}
            className={cn("press squircle relative rounded-[10px] px-3.5 py-1.5 text-[12.5px] font-semibold", on ? "bg-white/[0.12] text-paper" : "text-fog hover:text-paper")}
          >
            {o.label}
            {on ? <Tape className="inset-x-3 -bottom-[1px] h-[2px]" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** One stacked bar a day: 2 px gaps between segments, rounded at the top only, a tooltip per day. */
function DayChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = SERIES.filter((s) => days.some((d) => d[s.key as SeriesKey] > 0));
  const totals = days.map((d) => shown.reduce((sum, x) => sum + d[x.key as SeriesKey], 0));
  const max = Math.max(1, ...totals);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const h = hover != null ? days[hover] : null;
  const gap = days.length > 60 ? "gap-px" : days.length > 20 ? "gap-[3px]" : "gap-1.5";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-fog">
        {shown.map((x) => (
          <span key={x.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: x.color }} />
            {x.label}
          </span>
        ))}
      </div>
      <div className="relative pl-9">
        <div className="relative h-[220px]">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-white/[0.07]" style={{ bottom: `${(v / top) * 100}%` }}>
              <span className="absolute -left-9 w-7 -translate-y-1/2 text-right text-[11px] leading-none tabular text-haze">{v}</span>
            </div>
          ))}
          {/* One stop for the keyboard: ← and → walk the days, the tooltip follows (and is read out). */}
          <div
            className={cn("field-focus absolute inset-0 flex items-end rounded-[6px] outline-none", gap)}
            onMouseLeave={() => setHover(null)}
            tabIndex={0}
            role="group"
            aria-label="Takes per day: use the arrow keys to read each day"
            onFocus={() => setHover((v) => v ?? days.length - 1)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
              e.preventDefault();
              setHover((v) => {
                const at = v ?? days.length - 1;
                if (e.key === "Home") return 0;
                if (e.key === "End") return days.length - 1;
                return Math.max(0, Math.min(days.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)));
              });
            }}
          >
            {days.map((d, i) => {
              const total = totals[i];
              const parts = shown.map((x) => ({ x, v: d[x.key as SeriesKey] })).filter((p) => p.v > 0);
              return (
                <div key={d.day} className="relative flex h-full min-w-0 flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}>
                  <div className="flex w-full flex-col-reverse gap-[2px]" style={{ height: `${(total / top) * 100}%` }}>
                    {parts.map((p, k) => (
                      <div
                        key={p.x.key}
                        className={cn("w-full transition-opacity", k === parts.length - 1 && "rounded-t-[4px]")}
                        style={{ flexGrow: p.v, flexBasis: 0, minHeight: 1, background: p.x.color, opacity: hover == null || hover === i ? 1 : 0.45 }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {h ? (
            <div
              aria-live="polite"
              className="squircle pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-[12px] bg-apple-2 px-3 py-2 text-[12.5px] shadow-[0_8px_24px_rgb(0_0_0/0.4),inset_0_0_0_1px_var(--color-line-strong)]"
              style={{ left: `clamp(0px, calc(${((hover! + 0.5) / days.length) * 100}% - 75px), calc(100% - 160px))` }}
            >
              <p className="font-semibold text-paper">{longDay(h.day)}</p>
              {shown.map((x) => (
                <p key={x.key} className="mt-0.5 flex items-center justify-between gap-4 text-fog">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px]" style={{ background: x.color }} />
                    {x.label}
                  </span>
                  <span className="tabular text-paper">{h[x.key as SeriesKey]}</span>
                </p>
              ))}
              {h.failed ? <p className="mt-1 text-haze">{h.failed} failed</p> : null}
            </div>
          ) : null}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] tabular text-haze">
          <span>{shortDay(days[0]?.day)}</span>
          <span>{shortDay(days.at(-1)?.day)}</span>
        </div>
      </div>
    </div>
  );
}

function niceStep(max: number) {
  const raw = max / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

const shortDay = (d?: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const longDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function vsWords(v: number | null, runs: number) {
  if (v == null || runs < 3) return <span className="text-haze">–</span>;
  if (Math.abs(v) < 0.1) return <span className="text-fog">On target</span>;
  return <span className={v > 0 ? "text-tungsten" : "text-fog"}>{`${Math.round(Math.abs(v) * 100)}% ${v > 0 ? "slower" : "quicker"}`}</span>;
}

function ModelTable({ models }: { models: UsageModel[] }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => [...models].sort((a, b) => b.runs - a.runs || b.failed - a.failed), [models]);
  const shown = all ? rows : rows.slice(0, 14);
  if (!rows.length) return <p className="text-[13px] text-haze">Nothing made in this range.</p>;
  return (
    <div>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-haze">
              {["Model", "Machine", "Takes", "Usual time", "Fastest", "Vs estimate", "Failed"].map((h, i) => (
                <th key={h} className={cn("border-b border-line pb-2 font-medium", i >= 2 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={`${m.model}|${m.machine}|${m.engineId}`} className="border-b border-line">
                <td className="py-2.5 pr-4">
                  <span className="font-medium text-paper">{m.name}</span>
                  <span className="ml-2 text-[12px] text-haze">{m.engine}</span>
                </td>
                <td className="py-2.5 pr-4 text-fog">{m.machine ?? <span className="text-haze">Not recorded</span>}</td>
                <td className="py-2.5 text-right tabular text-paper">{n(m.runs)}</td>
                <td className="py-2.5 text-right tabular text-fog">{secs(m.medianSeconds)}</td>
                <td className="py-2.5 text-right tabular text-fog">{secs(m.fastestSeconds)}</td>
                <td className="py-2.5 text-right">{vsWords(m.vsEstimate, m.estimateRuns)}</td>
                <td className={cn("py-2.5 text-right tabular", m.failed ? "text-fog" : "text-haze")}>{m.failed || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 14 ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-3 text-[13px] font-semibold text-haze hover:text-paper">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

function ToolTable({ tools }: { tools: UsageSummary["tools"] }) {
  const max = Math.max(1, ...tools.map((t) => t.done + t.failed));
  return (
    <ul className="grid gap-x-10 gap-y-2 sm:grid-cols-2">
      {tools.map((t) => (
        // A fixed count column: every bar's track ends at the same place, so the bars compare at a glance.
        <li key={t.tool} className="grid grid-cols-[120px_minmax(0,1fr)_104px] items-center gap-3 text-[13px]">
          <span className="truncate text-fog">{t.label}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <span className="block h-full rounded-full bg-[#3987e5]" style={{ width: `${(t.done / max) * 100}%` }} />
          </span>
          <span className="tabular text-paper">
            {n(t.done)}
            {t.failed ? <span className="ml-1.5 text-[12px] text-haze">{t.failed} failed</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
