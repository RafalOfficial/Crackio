"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle, X } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { setUp, stopSetUp } from "@/lib/hooks/use-setup";
import { formatSeconds } from "@/lib/local/fit";
import { kitById } from "@/lib/setup/kits";
import { defaultJob, type JobSpec } from "@/lib/setup/knobs";
import { useEstimate } from "@/lib/hooks/use-estimate";
import type { Kit, KitId, ModelOption, OptionVariant, ReqStatus, SetupJob, SetupMachine, SetupSnapshot, ToolStatus } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { EstimatePanel, usd, type Elsewhere } from "./EstimatePanel";
import { chosen, defaultChoice, lowerFirst, sameChoice, type Choice } from "./ModelChooser";
import { Lamp, Progress, useHrefWith } from "./parts";
import { bytesText, fits, gbText, plainWhy, REQ_TONE, toolWords } from "./words";

/**
 * A tool's set-up, opened from its card: a wide sheet from the right. The tool's parts along the top (when it has more
 * than one), and for a model part every model it can use on this machine on the left, the one picked on the right with
 * its versions and an estimate (time, cost here, cost on the official API). One bar at the bottom does the one thing to
 * do next: set up, set up with your picks, make room, open the tool.
 */

export type SheetCtx = { m: SetupMachine; snap: SetupSnapshot; live: SetupJob | null };

export function ToolSheet({ kitId, ctx, onClose }: { kitId: KitId | null; ctx: SheetCtx; onClose: () => void }) {
  const [shown, setShown] = useState<KitId | null>(kitId);
  if (kitId && kitId !== shown) setShown(kitId);
  const open = Boolean(kitId);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  const kit = shown ? kitById(shown) : null;
  const status = shown ? ctx.m.tools[shown] : null;
  return (
    <div className={cn("fixed inset-0 z-[70]", open ? "" : "pointer-events-none")} aria-hidden={!open}>
      <div className={cn("absolute inset-0 bg-black/60 transition-opacity duration-300", open ? "opacity-100" : "opacity-0")} onClick={onClose} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={kit ? `${kit.name} on ${ctx.m.label}` : undefined}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col overflow-hidden bg-flat outline-none shadow-[-40px_0_100px_rgb(0_0_0/0.55)] transition-transform duration-[460ms] ease-[cubic-bezier(0.32,0.72,0,1)] md:w-[min(860px,calc(100vw-56px))] md:rounded-l-[28px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {kit && status ? <SheetBody key={`${ctx.m.id}:${kit.id}`} kit={kit} status={status} ctx={ctx} onClose={onClose} /> : null}
      </aside>
    </div>
  );
}

/** "NVFP4 needs a newer NVIDIA GPU" → "Needs a newer NVIDIA GPU": a reason without the version's name before it. */
const reason = (v: OptionVariant) => {
  const why = v.why.startsWith(`${v.label} `) ? v.why.slice(v.label.length + 1) : v.why;
  return why.charAt(0).toUpperCase() + why.slice(1);
};

/** A version's state in a few words, and its colour (whether it's there shows apart: a tick, "On it"). */
function versionWords(v: OptionVariant): { text: string; tone: string } {
  if (!v.installed && !v.fitsDisk) return { text: "No room here", tone: "text-tally" };
  if (v.fit === "no") return { text: reason(v), tone: "text-tungsten" };
  // A little of it waiting in RAM (under 2 GB on a card that size) costs a few percent: it just fits, it isn't slow.
  const spill = /^Spills ([\d.]+) GB/.exec(v.why);
  if (v.fit === "slow" && !(spill && Number(spill[1]) < 2)) return { text: "Slow here", tone: "text-tungsten" };
  return { text: v.fit === "great" ? "Runs well" : "Just fits", tone: "text-fog" };
}

const unitWord = (o: ModelOption) =>
  o.knobs.kind === "image"
    ? o.knobs.edit
      ? "an edit"
      : "a picture"
    : o.knobs.kind === "upscale"
      ? o.knobs.clip
        ? "a 5 s clip"
        : "an upscale"
      : o.knobs.kind === "swap"
        ? "a 5 s swap"
        : o.knobs.kind === "voice"
          ? "30 s of speech"
          : "a 5 s clip";

/** The usual job's time with one version here, from the same estimate as the panel's (so the numbers agree). */
function JobTime({ m, option, variant, className }: { m: SetupMachine; option: ModelOption; variant: OptionVariant; className?: string }) {
  const runs = variant.fit !== "no" && m.online;
  const { answer, loading } = useEstimate(runs ? { machine: m.id, model: option.model, variant: variant.id, ...defaultJob(option.knobs) } : null);
  const e = answer?.estimate;
  if (!runs) return null;
  return <span className={cn("tabular", className)}>{e ? formatSeconds(e.shown) : loading ? "…" : null}</span>;
}

function SheetBody({ kit, status, ctx, onClose }: { kit: Kit; status: ToolStatus; ctx: SheetCtx; onClose: () => void }) {
  const m = ctx.m;
  const words = toolWords(status);
  const hrefWith = useHrefWith();
  const parts = status.reqs;
  const [partId, setPartId] = useState<string | undefined>(() => (parts.find((r) => r.options?.length && !r.optional) ?? parts.find((r) => r.options?.length) ?? parts[0])?.id);
  const part = parts.find((r) => r.id === partId) ?? parts[0];
  // Your picks by part, and each model's estimate settings; a part not picked keeps Crackio's pick.
  const [picked, setPicked] = useState<Record<string, Choice>>({});
  const [jobs, setJobs] = useState<Record<string, JobSpec>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = parts
    .map((r) => ({ r, c: picked[r.id], to: chosen(r, picked[r.id]) }))
    .filter((x): x is { r: ReqStatus; c: Choice; to: NonNullable<ReturnType<typeof chosen>> } => Boolean(x.c && x.to && !sameChoice(x.c, defaultChoice(x.r)) && !x.to.variant.installed));
  const choices = Object.fromEntries(changed.map((x) => [x.r.id, x.c]));
  const otherBytes = status.state === "missing" ? parts.filter((r) => !r.optional && !choices[r.id] && r.plan && r.state !== "ready").reduce((n, r) => n + (r.plan?.bytes ?? 0), 0) : 0;
  const bytes = changed.length ? changed.reduce((n, x) => n + x.to.variant.bytes, 0) + otherBytes : status.bytes;
  const live = ctx.live?.kits.includes(kit.id) ? ctx.live : null;
  const others = ctx.snap.machines.filter((x) => x.id !== m.id && !x.metered && x.tools[kit.id]?.state === "ready");

  async function go(include?: string[], with_?: Record<string, Choice>) {
    setBusy(true);
    setError(null);
    const r = await setUp(m.id, [kit.id], include, with_);
    setError(r.error);
    setBusy(false);
  }

  const facts = [m.where, m.pricePerHour ? `${usd(m.pricePerHour)}/h` : null, m.gpu?.memoryGb ? `${Math.round(m.gpu.memoryGb)} GB GPU` : null, m.diskFreeGb != null ? `${gbText(m.diskFreeGb)} free` : null].filter(Boolean).join(" · ");

  return (
    <>
      <header className="relative h-[148px] shrink-0 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={kit.media} alt="" className={cn("absolute inset-0 h-full w-full object-cover", status.state === "ready" ? "opacity-80" : "opacity-55 grayscale-[0.5]")} />
        <span className="absolute inset-0 bg-gradient-to-t from-flat via-flat/70 to-flat/5" />
        <button type="button" onClick={onClose} aria-label="Close" className="press absolute right-5 top-5 grid size-9 place-items-center rounded-full bg-black/55 text-paper hover:bg-black/75">
          <X size={16} />
        </button>
        <div className="absolute inset-x-6 bottom-4 flex items-end gap-3.5">
          <AppIcon glyph={kit.glyph} hue={kit.hue || undefined} size={46} />
          <div className="min-w-0">
            <h2 className="font-display text-[32px] uppercase leading-none text-paper">{kit.name}</h2>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-fog">
              <Lamp tone={words.tone} />
              <span>
                {words.label} on {m.label}
              </span>
              <span className="hidden text-haze sm:inline">{facts}</span>
            </p>
          </div>
        </div>
      </header>

      {parts.length > 1 ? (
        <nav aria-label={`What ${kit.name} needs`} className="flex shrink-0 gap-1 overflow-x-auto px-6 pb-1 pt-1">
          {parts.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setPartId(r.id)}
              aria-current={r.id === part?.id ? "true" : undefined}
              className={cn(
                "press flex shrink-0 items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                r.id === part?.id ? "bg-white/[0.1] text-paper" : "text-haze hover:bg-white/[0.04] hover:text-paper",
              )}
            >
              <Lamp tone={REQ_TONE[r.state]} />
              {r.label}
              {r.optional ? <span className="text-[11px] text-haze">optional</span> : null}
              {picked[r.id] && changed.some((x) => x.r.id === r.id) ? <span className="size-1.5 rounded-full bg-spike" aria-label="your pick" /> : null}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {part ? (
          part.options?.length ? (
            <ModelPart
              part={part}
              m={m}
              snap={ctx.snap}
              kitId={kit.id}
              hrefFor={(id) => hrefWith("machine", id)}
              choice={picked[part.id] ?? defaultChoice(part)}
              onChoice={(c) => setPicked((p) => ({ ...p, [part.id]: c }))}
              jobs={jobs}
              onJob={(model, j) => setJobs((p) => ({ ...p, [model]: j }))}
            />
          ) : (
            <PlainPart part={part} m={m} busy={busy || Boolean(ctx.live)} onAdd={() => void go([part.id])} />
          )
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-line bg-flat py-4 pl-6 pr-20">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Primary
            kit={kit}
            status={status}
            m={m}
            live={live}
            anyLive={Boolean(ctx.live)}
            busy={busy}
            changed={changed}
            bytes={bytes}
            onGo={() => void go(changed.filter((x) => x.r.optional).map((x) => x.r.id), changed.length ? choices : undefined)}
          />
          {changed.length ? (
            <button type="button" onClick={() => setPicked({})} className="text-[13px] font-medium text-haze hover:text-paper">
              Back to Crackio&rsquo;s pick
            </button>
          ) : status.state !== "ready" && status.state !== "installing" ? (
            <Link href={kit.href} className="text-[13px] font-medium text-haze hover:text-paper">
              Open {kit.name} anyway
            </Link>
          ) : null}
          <span className="ml-auto text-[12px] text-haze">
            {others.length ? (
              <>
                Also ready on{" "}
                {others.map((o, i) => (
                  <span key={o.id}>
                    {i ? ", " : ""}
                    <Link href={hrefWith("machine", o.id)} onClick={onClose} className="font-semibold text-fog hover:text-paper">
                      {o.label}
                    </Link>
                  </span>
                ))}
              </>
            ) : m.diskFreeGb != null ? (
              `${gbText(m.diskFreeGb)} free on ${m.label}`
            ) : null}
          </span>
        </div>
        {/* A set-up that fits but leaves the disk nearly full: say so before it starts, with the way to make room. */}
        {m.diskFreeGb != null && bytes > 0 && status.state !== "ready" && status.state !== "installing" && fits(m, bytes) && m.diskFreeGb - bytes / 1024 ** 3 < 10 ? (
          <p className="mt-2 text-[12.5px] text-tungsten">
            This leaves {gbText(Math.max(0, m.diskFreeGb - bytes / 1024 ** 3))} free on {m.label}.{" "}
            <Link href={`/settings/storage?machine=${encodeURIComponent(m.id)}#unused`} onClick={onClose} className="font-semibold underline-offset-2 hover:underline">
              See what isn&rsquo;t used
            </Link>
          </p>
        ) : null}
        {error ? <p className="mt-2 text-[12.5px] text-tally">{error}</p> : null}
      </footer>
    </>
  );
}

/** The one button at the bottom: what to do next with this tool here. */
function Primary({
  kit,
  status,
  m,
  live,
  anyLive,
  busy,
  changed,
  bytes,
  onGo,
}: {
  kit: Kit;
  status: ToolStatus;
  m: SetupMachine;
  live: SetupJob | null;
  anyLive: boolean;
  busy: boolean;
  changed: { r: ReqStatus; to: { option: ModelOption; variant: OptionVariant } }[];
  bytes: number;
  onGo: () => void;
}) {
  const big = "press inline-flex h-11 items-center gap-2 rounded-[14px] px-5 text-[14px] font-bold transition-colors disabled:opacity-50";
  const spike = `${big} bg-spike text-spike-ink hover:bg-spike-hi`;
  const quiet = `${big} bg-white/[0.08] text-paper hover:bg-white/[0.12]`;
  const spin = busy ? <LoaderCircle size={15} className="animate-spin" /> : null;
  if (!m.online) return <p className="text-[13px] text-haze">{m.label} isn&rsquo;t answering: start it, then set up here.</p>;
  if (m.metered) return <p className="text-[13px] text-haze">Pay-per-job machines come with their models.</p>;
  if (live) {
    const step = live.steps.find((s) => s.state === "running");
    return (
      <div className="flex min-w-[260px] flex-1 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-paper">
            {step ? `${step.label}${step.detail ? ` · ${step.detail}` : ""}` : "Waiting its turn"}
          </p>
          {step?.progress ? <Progress received={step.progress.received} total={step.progress.total} className="mt-1.5" /> : null}
        </div>
        <button type="button" onClick={() => void stopSetUp(live.id)} className={quiet}>
          Stop
        </button>
      </div>
    );
  }
  const room = (
    <Link href={`/settings/storage?machine=${encodeURIComponent(m.id)}`} className={quiet} title={`Needs ${bytesText(bytes)}; ${gbText(m.diskFreeGb)} free`}>
      Make room for {bytesText(bytes)}
    </Link>
  );
  if (changed.length) {
    if (!fits(m, bytes)) return room;
    const names = changed.map((x) => `${x.to.option.name} ${x.to.variant.label}`).join(" and ");
    const doubt = changed.some((x) => x.to.variant.fit === "no");
    return (
      <button type="button" onClick={onGo} disabled={busy || anyLive} className={spike}>
        {spin}
        {status.state === "ready" ? "Add" : doubt ? "Try" : "Set up with"} {names} · {bytesText(bytes)}
      </button>
    );
  }
  switch (status.state) {
    case "ready":
      return (
        <Link href={kit.href} className={spike}>
          Open {kit.name} <ArrowUpRight size={15} />
        </Link>
      );
    case "missing":
    case "no-comfy": {
      if (!fits(m, bytes)) return room;
      const pick = status.reqs.find((r) => !r.optional && r.plan?.kind === "model" && r.state !== "ready")?.plan;
      return (
        <button type="button" onClick={onGo} disabled={busy || anyLive} className={spike}>
          {spin}
          {pick && pick.kind === "model" ? `Set up with ${pick.name} ${pick.variantLabel}` : `Set up ${kit.name}`} · {bytesText(bytes)}
        </button>
      );
    }
    case "broken":
      return (
        <button type="button" onClick={onGo} disabled={busy || anyLive} className={spike}>
          {spin}Try again
        </button>
      );
    case "needs-update":
      return m.bridge.update === "this-computer" || status.reqs.some((r) => r.state === "outdated" && r.plan) ? (
        <button type="button" onClick={onGo} disabled={busy || anyLive} className={spike}>
          {spin}Update
        </button>
      ) : (
        <Link href={`/settings/machines?machine=${encodeURIComponent(m.id)}`} className={quiet}>
          How to update
        </Link>
      );
    case "needs-key":
      return (
        <Link href="/settings/accounts#hf" className={spike}>
          Add your Hugging Face token
        </Link>
      );
    default:
      return <p className="max-w-[60ch] text-[13px] text-haze">{plainWhy(status.why)}</p>;
  }
}

/** A model part: the models it can use here on the left; the one picked, its versions and its estimate on the right. */
function ModelPart({
  part,
  m,
  snap,
  kitId,
  hrefFor,
  choice,
  onChoice,
  jobs,
  onJob,
}: {
  part: ReqStatus;
  m: SetupMachine;
  snap: SetupSnapshot;
  kitId: KitId;
  hrefFor: (machine: string) => string;
  choice: Choice | null;
  onChoice: (c: Choice) => void;
  jobs: Record<string, JobSpec>;
  onJob: (model: string, j: JobSpec) => void;
}) {
  const options = part.options ?? [];
  const option = options.find((o) => o.model === choice?.model) ?? options[0];
  const variant = option?.variants.find((v) => v.id === (choice?.model === option?.model ? choice?.variant : option?.variant)) ?? option?.variants[0];
  if (!option || !variant) return null;
  const job = jobs[option.model] ?? defaultJob(option.knobs);
  const say = versionWords(variant);
  // The same model on your other machines: the version picked here where it has it, else the one it would get there.
  const elsewhere: Elsewhere[] = snap.machines
    .filter((x) => x.id !== m.id && x.online)
    .flatMap((x) => {
      const o = x.tools[kitId]?.reqs.find((r) => r.id === part.id)?.options?.find((y) => y.model === option.model);
      // The version picked here if it runs there, else the one Crackio would get there (a GTX 1060 can't run INT8).
      const same = o?.variants.find((y) => y.id === variant.id && y.fit !== "no");
      const v = o ? (same ?? o.variants.find((y) => y.id === o.variant)) : undefined;
      return o && v ? [{ m: x, option: o, variant: v }] : [];
    });
  return (
    <div className="grid gap-6 px-6 pb-8 pt-4 lg:grid-cols-[minmax(220px,250px)_minmax(0,1fr)] lg:gap-7">
      <div className="min-w-0">
        <p className="mb-2 text-[12.5px] text-haze">
          {part.label}
          {part.optional ? " (optional)" : ""}: {options.length} {options.length === 1 ? "model" : "models"} for {m.label}
        </p>
        <ul role="radiogroup" aria-label={`${part.label}: pick a model`} className="flex flex-col gap-1">
          {options.map((o) => {
            const on = o.model === option.model;
            const v = o.variants.find((x) => x.id === (on ? variant.id : o.variant)) ?? o.variants[0];
            const w = v ? versionWords(v) : null;
            const there = o.variants.some((x) => x.installed);
            return (
              <li key={o.model}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={o.blocked}
                  onClick={() => onChoice({ model: o.model, variant: on ? variant.id : o.variant })}
                  className={cn(
                    "relative w-full rounded-[14px] px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                    on ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-semibold text-paper">{o.name}</span>
                    {there ? (
                      <span className="shrink-0 text-[11px] font-semibold text-chroma">On it</span>
                    ) : o.pick ? (
                      <span className="shrink-0 text-[11px] font-semibold text-fog">Crackio&rsquo;s pick</span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2 text-[12px]">
                    <span className={cn("truncate", o.blocked ? "text-haze" : (w?.tone ?? "text-haze"))}>{o.blocked ? "Not in your region" : w?.text}</span>
                    <span className="shrink-0 tabular text-haze">
                      {v && !v.installed ? `${bytesText(v.bytes)} · ` : null}
                      {v ? <JobTime m={m} option={o} variant={v} /> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 px-1 text-[11.5px] leading-snug text-haze">Times are for {unitWord(option)} here. Pick any model: Crackio tells you if it doubts one, and lets you try it.</p>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-display text-[28px] uppercase leading-none text-paper">{option.name}</h3>
            <span className="text-[13px] text-haze">{option.maker}</span>
          </div>
          <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-fog">{option.blurb}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-haze">
            {option.qualityKnown ? (
              <span>
                Quality <span className="font-semibold tabular text-fog">{option.quality}</span> of 100
              </span>
            ) : null}
            {option.audio ? <span>Makes sound</span> : null}
            <span>
              {option.licence.name}
              {option.licence.commercial === "yes" ? ", free for business" : option.licence.commercial === "limited" ? ", business use limited" : ", not for business"}
            </span>
          </p>
        </div>

        <div>
          <p className="mb-2 text-[12.5px] text-haze">Version</p>
          <div role="radiogroup" aria-label={`${option.name}: version`} className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
            {option.variants.map((v) => {
              const on = v.id === variant.id;
              const w = versionWords(v);
              return (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={v.why}
                  onClick={() => onChoice({ model: option.model, variant: v.id })}
                  className={cn(
                    "press rounded-[14px] px-3.5 py-3 text-left transition-[background-color,box-shadow]",
                    on ? "bg-white/[0.08] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "bg-white/[0.03] hover:bg-white/[0.06]",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13.5px] font-semibold text-paper">{v.label}</span>
                    {v.installed ? <Check size={14} className="shrink-0 text-chroma" /> : null}
                  </span>
                  <span className="mt-1 block text-[12px] tabular text-fog">
                    {v.installed ? "On it" : bytesText(v.bytes)} · {Math.round(v.fidelity * 100)}% quality
                  </span>
                  <span className={cn("mt-0.5 line-clamp-2 block text-[11.5px] leading-snug", w.tone)}>
                    {w.text}
                    {v.fit !== "no" && (v.fitsDisk || v.installed) ? (
                      <>
                        <span className="text-haze"> · </span>
                        <JobTime m={m} option={option} variant={v} className="text-haze" />
                      </>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          {!variant.installed && (!variant.fitsDisk || variant.fit === "no" || (variant.fit === "slow" && say.text === "Slow here")) ? (
            <p className={cn("mt-2.5 text-[12.5px] leading-snug", say.tone)}>
              {!variant.fitsDisk
                ? `${variant.label} needs ${bytesText(variant.bytes)} of disk and ${m.label} has ${gbText(m.diskFreeGb)} free: make room under Storage, or pick a smaller version.`
                : variant.fit === "no"
                  ? `Crackio doubts ${variant.label} runs here (${lowerFirst(variant.why)}). You can still try it: if it stops or crawls, pick another.`
                  : `${variant.label} runs slowly here (${lowerFirst(variant.why)}).`}
            </p>
          ) : null}
        </div>

        <EstimatePanel m={m} option={option} variant={variant} job={job} onJob={(j) => onJob(option.model, j)} elsewhere={elsewhere} hrefFor={hrefFor} />
      </div>
    </div>
  );
}

/** A part that isn't a model pick (a voice engine, a judge, a key): what it is, where it stands, and Add for optional ones. */
function PlainPart({ part, m, busy, onAdd }: { part: ReqStatus; m: SetupMachine; busy: boolean; onAdd: () => void }) {
  return (
    <div className="flex max-w-[640px] flex-col gap-3 px-6 pb-8 pt-5">
      <div className="flex items-center gap-2.5">
        <Lamp tone={REQ_TONE[part.state]} />
        <h3 className="text-[16px] font-semibold text-paper">{part.label}</h3>
        {part.optional ? <span className="text-[12px] text-haze">optional</span> : null}
      </div>
      <p className="text-[13.5px] leading-relaxed text-fog">{part.state === "missing" && part.plan ? `Gets ${plainWhy(part.why)}` : plainWhy(part.why)}</p>
      {part.state !== "ready" && part.instead ? <p className="text-[12.5px] text-haze">Without it: {part.instead}</p> : null}
      {part.progress ? <Progress received={part.progress.received} total={part.progress.total} /> : null}
      <div className="flex items-center gap-3">
        {part.plan?.bytes ? <span className="text-[12.5px] tabular text-fog">{bytesText(part.plan.bytes)} to download</span> : null}
        {part.optional && part.state === "missing" && m.online && !m.metered ? (
          <button type="button" onClick={onAdd} disabled={busy} className="press rounded-[12px] bg-white/[0.08] px-3.5 py-2 text-[13px] font-semibold text-paper hover:bg-white/[0.12] disabled:opacity-50">
            Add it
          </button>
        ) : null}
      </div>
    </div>
  );
}
