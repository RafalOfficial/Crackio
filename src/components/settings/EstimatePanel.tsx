"use client";

import Link from "next/link";
import { useState } from "react";
import { formatSeconds } from "@/lib/local/fit";
import { useEstimate } from "@/lib/hooks/use-estimate";
import { jobWords, SAFETY, type JobSpec, type Knobs } from "@/lib/setup/knobs";
import type { ModelOption, OptionVariant, SetupMachine } from "@/lib/setup/types";
import { cn } from "@/lib/cn";

/**
 * The estimate under a model's versions: set the job (a clip's length and size, a picture's size and how many, an
 * upscale's picture and factor) and see how long it takes on this machine, what that time costs on a rented GPU, and what
 * the same job costs on the model's official API. Times are Crackio's own (the tools show the same before a run), shown
 * a little slower than the math says.
 */

/** Dollars: "$0.0044", "$0.12", "$12.40". */
export function usd(n: number) {
  if (n === 0) return "$0";
  if (n < 0.001) return "<$0.001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
  return `$${n.toFixed(2)}`;
}

/** A few choices side by side, one picked. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-[12px] bg-white/[0.04] p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press rounded-[9px] px-3 py-1.5 text-[12.5px] font-semibold tabular transition-colors",
            o.value === value ? "bg-white/[0.13] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-haze hover:text-paper",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Knob({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
      <span className="text-[12.5px] text-haze">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Controls({ k, job, onJob }: { k: Knobs; job: JobSpec; onJob: (j: JobSpec) => void }) {
  const set = (p: Partial<JobSpec>) => onJob({ ...job, ...p });
  return (
    <div className="flex flex-col gap-3">
      {k.seconds ? (
        <Knob label={k.kind === "voice" ? "Speech" : "Clip length"}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={k.seconds.min}
              max={k.seconds.max}
              step={1}
              value={job.seconds ?? k.seconds.default}
              onChange={(e) => set({ seconds: Number(e.target.value) })}
              aria-label={k.kind === "voice" ? "Seconds of speech" : "Clip length in seconds"}
              className="h-1.5 w-full cursor-pointer accent-[var(--color-spike)]"
            />
            <span className="w-12 shrink-0 text-right text-[13px] font-semibold tabular text-paper">{job.seconds ?? k.seconds.default} s</span>
          </div>
        </Knob>
      ) : null}
      {k.resolutions && k.resolutions.length > 1 ? (
        <Knob label="Size">
          <Segmented label="Size" value={job.resolution ?? k.resolution ?? k.resolutions[0].value} options={k.resolutions} onChange={(resolution) => set({ resolution })} />
        </Knob>
      ) : null}
      {k.count ? (
        <Knob label="Pictures">
          <Segmented
            label="Pictures"
            value={job.count ?? 1}
            options={Array.from({ length: k.count.max - k.count.min + 1 }, (_, i) => ({ value: k.count!.min + i, label: String(k.count!.min + i) }))}
            onChange={(count) => set({ count })}
          />
        </Knob>
      ) : null}
      {k.sources ? (
        <Knob label="Picture">
          <Segmented
            label="Picture going in"
            value={k.sources.find((s) => s.width === job.source?.width && s.height === job.source?.height)?.value ?? k.sources[0].value}
            options={k.sources.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => {
              const s = k.sources!.find((x) => x.value === v)!;
              set({ source: { width: s.width, height: s.height } });
            }}
          />
        </Knob>
      ) : null}
      {k.scales ? (
        <Knob label="Bigger by">
          <Segmented label="Bigger by" value={job.scale ?? 2} options={k.scales.map((s) => ({ value: s, label: `${s}×` }))} onChange={(scale) => set({ scale })} />
        </Knob>
      ) : null}
    </div>
  );
}

/** How many of the job at once, for a project's totals. */
const COUNTS = [1, 10, 50, 100, 500] as const;

/** "1.2 h", "52 min", "40 s": a long total said the short way. */
const total = (seconds: number) => (seconds >= 5400 ? `${(seconds / 3600).toFixed(seconds >= 36_000 ? 0 : 1)} h` : formatSeconds(seconds));

/** Another machine the same job could run on: its own version of the model (the one a set-up there would get). */
export type Elsewhere = { m: SetupMachine; option: ModelOption; variant: OptionVariant };

/** One other machine's line: the job's time and cost there, and whether the model is there. */
function ElsewhereRow({ e: x, job, n, href }: { e: Elsewhere; job: JobSpec; n: number; href: string }) {
  const { answer, loading } = useEstimate(x.m.online ? { machine: x.m.id, model: x.option.model, variant: x.variant.id, ...job } : null);
  const est = answer?.estimate;
  const there = x.variant.installed;
  return (
    <Link href={href} scroll={false} className="grid grid-cols-[minmax(0,1fr)_76px_76px] items-center gap-3 rounded-[10px] px-2.5 py-2 text-[12.5px] transition-colors hover:bg-white/[0.04]">
      <span className="min-w-0">
        <span className="block truncate font-medium text-paper">{x.m.label}</span>
        <span className="block truncate text-[11.5px] text-haze">
          {x.variant.label} · {there ? <span className="text-chroma">on it</span> : x.variant.fit === "no" ? "may not run" : `set up ${Math.max(0.1, x.variant.bytes / 1024 ** 3).toFixed(x.variant.bytes > 10 * 1024 ** 3 ? 0 : 1)} GB`}
        </span>
      </span>
      <span className="text-right tabular text-fog">{est ? total(est.shown * n) : loading ? "…" : "—"}</span>
      <span className="text-right tabular text-fog">{est ? (est.price ? usd(est.price.job * n) : "$0") : loading ? "…" : "—"}</span>
    </Link>
  );
}

/** "a clip", "a picture", "pictures": what 100 of the job are called. */
const plural = (j: JobSpec) =>
  j.kind === "video" ? "clips" : j.kind === "swap" ? "swaps" : j.kind === "voice" ? "takes" : j.kind === "upscale" ? (j.clip ? "clips" : "upscales") : j.references ? "edits" : (j.count ?? 1) > 1 ? "sets" : "pictures";

/** How many of a job an hour of the GPU makes, rounded the way people say it: "about 80", "about 1,200". */
function perHour(seconds: number) {
  const n = 3600 / Math.max(0.1, seconds);
  const r = n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return r.toLocaleString("en-US");
}

export function EstimatePanel({
  m,
  option,
  variant,
  job,
  onJob,
  elsewhere = [],
  hrefFor,
}: {
  m: SetupMachine;
  option: ModelOption;
  variant: OptionVariant;
  job: JobSpec;
  onJob: (j: JobSpec) => void;
  /** The same job on your other machines, to compare. */
  elsewhere?: Elsewhere[];
  /** A link to this sheet on another machine. */
  hrefFor?: (machine: string) => string;
}) {
  const k = option.knobs;
  // How many of the job: the numbers become a project's totals (one after another on this GPU).
  const [n, setN] = useState(1);
  const ask = m.online ? { machine: m.id, model: option.model, variant: variant.id, ...job } : null;
  const { answer, loading } = useEstimate(ask);
  const e = answer?.estimate ?? null;
  const api = e?.api ?? answer?.api ?? null;
  const here = e ? (e.price ? e.price.job : 0) : null;
  const save = api && here !== null && api.usd > 0 ? Math.max(0, 1 - here / api.usd) : null;
  const words = jobWords(job, k);
  return (
    <section aria-label="Estimate" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-paper">How long, and what it costs</h3>
        <span className="text-[12px] text-haze">on this {m.label}</span>
      </div>
      <Controls k={k} job={job} onJob={onJob} />
      <Knob label="How many">
        <Segmented label="How many" value={n} options={COUNTS.map((c) => ({ value: c, label: c === 1 ? "One" : String(c) }))} onChange={setN} />
      </Knob>

      <div className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-[16px] bg-line transition-opacity", loading && e ? "opacity-60" : "")}>
        <div className="bg-flat px-4 py-3.5">
          <p className="font-display text-[34px] leading-none tabular text-paper">{e ? total(e.shown * n) : loading ? "…" : "—"}</p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-fog">{n === 1 ? words : `${n} × ${words}, one after another`}</p>
          {e ? (
            <p className="mt-1 text-[11.5px] leading-snug text-haze">
              {n === 1 ? `likely ${formatSeconds(e.low)}–${formatSeconds(e.high)}` : `${formatSeconds(e.shown)} each`}
              {e.load > 4 ? ` · first run +${formatSeconds(e.load)} to load it` : ""}
              <span className="block">
                about {perHour(e.shown)} {plural(job)} an hour
              </span>
            </p>
          ) : null}
        </div>
        <div className="bg-flat px-4 py-3.5">
          <p className="font-display text-[34px] leading-none tabular text-paper">{e ? (e.price ? usd(e.price.job * n) : "$0") : loading ? "…" : "—"}</p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-fog">
            {m.pricePerHour ? `at ${usd(m.pricePerHour)} an hour on ${m.priceFrom ?? "your cloud"}` : m.kind === "rented" ? "its hourly price isn't known yet" : "your own GPU: no rent"}
          </p>
          {e?.price && n > 1 ? <p className="mt-1 text-[11.5px] leading-snug text-haze">{usd(e.price.job)} each</p> : e?.price && e.load > 4 ? <p className="mt-1 text-[11.5px] leading-snug text-haze">first run {usd(e.price.firstJob)} with loading</p> : null}
        </div>
      </div>

      {api && here !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5" aria-label="Cost next to the API">
            {[
              { name: "Here", value: here * n, mine: true },
              { name: api.provider, value: api.usd * n, mine: false },
            ].map((row) => {
              const max = Math.max(here, api.usd) * n || 1;
              return (
                <div key={row.name} className="grid grid-cols-[112px_minmax(0,1fr)_72px] items-center gap-3 text-[12.5px]">
                  <span className={cn("truncate", row.mine ? "font-semibold text-paper" : "text-fog")}>{row.name}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
                    <span className={cn("block h-full rounded-full", row.mine ? "bg-spike" : "bg-fog/70")} style={{ width: `${Math.max(1.5, (row.value / max) * 100)}%` }} />
                  </span>
                  <span className="text-right tabular text-paper">{usd(row.value)}</span>
                </div>
              );
            })}
          </div>
          {save !== null && save > 0.005 ? (
            <p className="text-[13px] leading-snug text-paper">
              <span className="font-semibold text-chroma">You save {save >= 0.995 ? "over 99" : Math.round(save * 100)}%.</span>{" "}
              <span className="text-fog">
                {n === 1 ? `100 ${plural(job)}: ${usd(here * 100)} here, ${usd(api.usd * 100)} on ${api.provider}.` : `That's ${usd((api.usd - here) * n)} kept for ${n} ${plural(job)}.`}
              </span>
            </p>
          ) : null}
          <p className="text-[11.5px] leading-snug text-haze">
            {api.official ? "The maker's own API" : "The closest paid API"}: {api.product}, {api.rate}
            {api.note ? ` (${api.note})` : ""}. Checked {api.checked}.{" "}
            <a href={api.source} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-fog hover:underline">
              Source
            </a>
          </p>
        </div>
      ) : null}

      {elsewhere.length && hrefFor ? (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[minmax(0,1fr)_76px_76px] gap-3 px-2.5 text-[11.5px] text-haze">
            <span>On your other machines</span>
            <span className="text-right">{n === 1 ? "Time" : "Total"}</span>
            <span className="text-right">Cost</span>
          </div>
          {elsewhere.map((x) => (
            <ElsewhereRow key={x.m.id} e={x} job={job} n={n} href={hrefFor(x.m.id)} />
          ))}
        </div>
      ) : null}

      {answer?.error || (!e && answer?.why) ? <p className="text-[12.5px] text-tungsten">{answer.error ?? answer.why}</p> : null}
      {e ? (
        <p className="text-[11.5px] leading-snug text-haze">
          {e.basis}. Shown {Math.round((SAFETY - 1) * 100)}% slower than that, so it&rsquo;s a promise kept.
        </p>
      ) : null}
    </section>
  );
}
