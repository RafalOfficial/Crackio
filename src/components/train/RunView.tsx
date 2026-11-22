"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, ArrowUpRight, Check, CircleAlert, Download, LoaderCircle, Pause, PenLine, Play, ScanEye, Sparkles, Square, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { isOn, loadLoraLibrary, useLoraLibrary } from "@/lib/hooks/use-lora-library";
import { setLora, useModelLoras } from "@/lib/hooks/use-model-loras";
import { captionFor, formatDuration, SETTING_HELP, testPrompts, trainable } from "@/lib/train/plan";
import { isActive, type LogLine, type TrainJob } from "@/lib/train/types";
import type { TrainOptions } from "@/lib/server/train/options";
import { GB, LossChart, STATE_WORDS, Tag, money, useNow } from "./parts";

/**
 * A LoRA that's training, paused, stopped or done: how far it is and how long it has left, its loss, the versions saved
 * so far as a strip of test pictures (the same two prompts and seeds at every version, beside the model without the
 * LoRA), what Crackio fixed on the way, and the log. Done, it offers the LoRA for use.
 */

type Props = {
  job: TrainJob;
  log: LogLine[];
  options: TrainOptions | null;
  working: string | null;
  run: (action: "start" | "pause" | "finish" | "use-version" | "move" | "keep-versions" | "edit-setup", step?: number, machine?: string) => void;
};

/**
 * How the pictures were captioned, in words: a LoRA's quality rests on it, and a run that trained with none (a text
 * model that never answered, in an older Crackio) must say so on its own page.
 */
function captionWords(job: TrainJob): { text: string; missing: boolean } {
  if (job.goal === "edit") return { text: "Your instruction", missing: false };
  const set = job.images.filter((i) => !i.skip);
  const have = set.filter((i) => i.caption?.trim());
  const yours = have.filter((i) => i.captionBy === "you").length;
  if (!have.length) return { text: job.settings.captions === "trigger" ? "None: the trigger word alone, as you chose" : "None: the trigger word alone", missing: job.settings.captions !== "trigger" };
  if (have.length < set.length) return { text: `${have.length} of ${set.length} pictures; the rest train with the trigger word alone`, missing: job.settings.captions !== "trigger" };
  return { text: `All ${set.length} pictures, ${yours === have.length ? "written by you" : yours ? `${yours} of them by you` : "written by Crackio"}`, missing: false };
}

export function RunView({ job, log, options, working, run }: Props) {
  const [tab, setTab] = useState<"progress" | "log" | "settings">("progress");
  const [moving, setMoving] = useState(false);
  // The choices when captions couldn't be written: what each one is doing, and what it said.
  const [fixing, setFixing] = useState<"reader" | "trigger" | null>(null);
  const [fixSaid, setFixSaid] = useState<string | null>(null);
  const captioned = captionWords(job);
  const active = isActive(job.state);
  const now = useNow(active);
  const p = job.progress;
  const total = p.steps || job.settings.steps;
  const share = total ? Math.min(1, p.step / total) : 0;
  // Time left: the steps still to go at the measured pace, plus the test pictures still to draw.
  const left = p.pace && job.state !== "done" ? (total - p.step) * p.pace + (job.settings.previews ? Math.max(0, job.settings.checkpoints - job.checkpoints.filter((k) => k.previews).length) * 45 : 0) : null;
  // The time it ran for, without the hours it sat paused (a run paused overnight read "Took 14 h, about $3.50"). A run
  // from before that was counted goes by its start and its end.
  const elapsed = p.ranMs !== undefined ? (p.ranMs + (p.runningSince ? Math.max(0, now - p.runningSince) : 0)) / 1000 : p.startedAt ? ((p.finishedAt ?? now) - p.startedAt) / 1000 : 0;
  const machine = options?.machines.find((m) => m.id === job.machine);
  const spent = machine?.pricePerHour ? (elapsed / 3600) * machine.pricePerHour : null;
  return (
    <div className="space-y-5">
      <section className="squircle rounded-[22px] bg-white/[0.035] p-5 shadow-[inset_0_0_0_1px_var(--color-line)] @min-[720px]:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-fog">
              {active ? <LoaderCircle size={14} className="animate-spin text-daylight" /> : job.state === "done" ? <Check size={14} className="text-chroma" strokeWidth={3} /> : job.state === "error" ? <CircleAlert size={14} className="text-tally" /> : <Pause size={14} className="text-tungsten" />}
              {STATE_WORDS[job.state]}
              {machine ? <span className="font-normal text-haze">on {machine.label}</span> : null}
            </p>
            <p className="tabular mt-2 font-display text-[40px] leading-none text-paper">
              {p.step.toLocaleString("en-US")}
              <span className="text-[22px] text-haze"> / {total.toLocaleString("en-US")} steps</span>
            </p>
            <p className="mt-2 min-h-[20px] text-[13px] text-fog">
              {active ? p.stage || STATE_WORDS[job.state] : job.state === "done" ? `Took ${formatDuration(elapsed)}${spent ? `, about ${money(spent)}` : ""}${job.planned?.seconds ? ` (planned ${formatDuration(job.planned.seconds)})` : ""}` : job.state === "paused" ? (job.run?.home?.step === p.step && p.step > 0 ? "What's trained so far is kept on the machine, and a copy on this computer." : "What's trained so far is kept on the machine.") : ""}
            </p>
          </div>
          {active && p.notice ? (
            <p className="order-last flex basis-full items-start gap-1.5 rounded-[12px] bg-tungsten/10 px-3 py-2 text-[12.5px] leading-snug text-tungsten">
              <CircleAlert size={14} className="mt-px shrink-0" />
              <span>{p.notice}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {active ? (
              <>
                <RunButton onClick={() => run("pause")} busy={working === "pause"} icon={<Pause size={14} />}>
                  Pause
                </RunButton>
                {p.step > 0 && job.state !== "queued" ? (
                  <RunButton onClick={() => run("finish")} busy={working === "finish"} icon={<Square size={12} />} title="Stop here and make the LoRA from what's trained so far">
                    Finish now
                  </RunButton>
                ) : null}
              </>
            ) : job.state === "paused" || job.state === "error" ? (
              <>
                <RunButton primary onClick={() => run("start")} busy={working === "start"} icon={<Play size={14} />}>
                  {job.state === "error" ? "Try again" : "Carry on"}
                </RunButton>
                {p.step > 0 ? (
                  <RunButton onClick={() => run("finish")} busy={working === "finish"} icon={<Square size={12} />} title="Make the LoRA from what's trained so far">
                    Finish with what&rsquo;s trained
                  </RunButton>
                ) : null}
                <RunButton onClick={() => setMoving(!moving)} busy={working === "move"} icon={<ArrowRightLeft size={14} />} title="Carry this run on on another of your machines, from the same step">
                  Move to another machine
                </RunButton>
                {p.step === 0 ? (
                  <RunButton onClick={() => run("edit-setup")} busy={working === "edit-setup"} icon={<Wrench size={14} />} title="Nothing is trained yet: change the model, the machine, the settings or the pictures">
                    Change the setup
                  </RunButton>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        {moving && (job.state === "paused" || job.state === "error") ? (
          <MoveTo
            job={job}
            options={options}
            onPick={(id) => {
              setMoving(false);
              run("move", undefined, id);
            }}
          />
        ) : null}

        <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.07]" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={p.step} aria-label="Training progress">
          <div className={cn("h-full origin-left rounded-full transition-transform duration-700 ease-out", job.state === "error" ? "bg-tally/70" : job.state === "done" ? "bg-chroma" : "bg-daylight")} style={{ transform: `scaleX(${share})` }} />
        </div>
        {active && p.share !== null && job.state !== "training" ? (
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full origin-left rounded-full bg-white/35 transition-transform duration-500" style={{ transform: `scaleX(${p.share})` }} />
          </div>
        ) : null}

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 @min-[720px]:grid-cols-4">
          <Fact label="Time left" value={left !== null && active ? formatDuration(left) : job.state === "done" ? "Done" : "—"} />
          <Fact label="Running for" value={elapsed ? formatDuration(elapsed) : "—"} sub={spent && active ? (spent < 0.01 ? "under 1¢ so far" : `about ${money(spent)} so far`) : undefined} />
          <Fact label="A step takes" value={p.pace ? `${p.pace.toFixed(2)} s` : "—"} sub={p.peakGb ? `${p.peakGb.toFixed(1)} GB of GPU memory` : undefined} />
          <Fact label="Loss" value={p.loss !== null ? p.loss.toFixed(4) : "—"} sub="how far off its guesses are" />
        </dl>

        {job.error ? (
          <div className="mt-4 rounded-[14px] bg-tally/10 px-4 py-3">
            <p className="text-[13.5px] font-semibold text-tally">{job.error.message}</p>
            {job.error.hint ? <p className="mt-1 text-[13px] text-fog">{job.error.hint}</p> : null}
            {job.error.code === "CAPTIONS" && job.state === "error" ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {machine ? (
                  <RunButton
                    busy={fixing === "reader"}
                    icon={<ScanEye size={14} />}
                    title="Downloads LFM3-VL 2B, a small model that reads pictures (about 4 GB), to that machine"
                    onClick={() => {
                      setFixing("reader");
                      setFixSaid(null);
                      fetch("/api/setup/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machine: job.machine, kits: ["retouch"], only: ["retouch.eyes"] }) })
                        .then((r) => r.json() as Promise<{ error?: string }>)
                        .then((r) => setFixSaid(r.error ?? `A picture reader is downloading to ${machine.label} (about 4 GB). Press Try again when Settings → Tools shows it's there.`))
                        .catch(() => setFixSaid("Crackio didn't answer."))
                        .finally(() => setFixing(null));
                    }}
                  >
                    Set up a picture reader on {machine.label}
                  </RunButton>
                ) : null}
                <RunButton busy={working === "edit-setup"} icon={<PenLine size={14} />} title="Back to the pictures: type a caption under each one" onClick={() => run("edit-setup")}>
                  Write them myself
                </RunButton>
                <RunButton
                  busy={fixing === "trigger"}
                  icon={<Play size={14} />}
                  title="Every picture trains with the trigger word and nothing else. The LoRA learns less this way."
                  onClick={() => {
                    setFixing("trigger");
                    setFixSaid(null);
                    fetch(`/api/train/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { captions: "trigger" } }) })
                      .then((r) => (r.ok ? run("start") : setFixSaid("Crackio couldn't change the setting.")))
                      .catch(() => setFixSaid("Crackio didn't answer."))
                      .finally(() => setFixing(null));
                  }}
                >
                  Train without captions
                </RunButton>
              </div>
            ) : null}
            {fixSaid ? <p className="mt-2 text-[12.5px] text-fog">{fixSaid}</p> : null}
            <p className="mt-2 text-[12.5px] text-haze">{job.progress.step > 0 ? "Nothing trained so far is lost. " : ""}The log has the details.</p>
          </div>
        ) : null}
        {/* A run that trained (or is training) with captions missing says so here, not only in its log. */}
        {captioned.missing && !job.error && (job.progress.step > 0 || job.state === "done") ? (
          <p className="mt-4 flex items-start gap-1.5 rounded-[12px] bg-tungsten/10 px-3 py-2 text-[12.5px] leading-snug text-tungsten">
            <CircleAlert size={14} className="mt-px shrink-0" />
            <span>
              {captioned.text.startsWith("None") ? "This LoRA trained with no captions: no model could read the pictures when it started." : `Captions: ${captioned.text}.`} A LoRA learns less that way. Train it again with captions for a stronger
              one.
            </span>
          </p>
        ) : null}
      </section>

      {job.result ? <Result job={job} options={options} /> : null}

      {job.heals.length ? (
        <section aria-label="What Crackio fixed" className="rounded-[18px] bg-daylight/[0.06] px-4 py-3.5 shadow-[inset_0_0_0_1px_rgb(142_197_255/0.18)]">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-daylight">
            <Wrench size={13} /> Crackio sorted {job.heals.length === 1 ? "this" : "these"} out by itself
          </h3>
          <ul className="mt-2 space-y-1.5">
            {job.heals.map((h, i) => (
              <li key={i} className="flex gap-3 text-[12.5px] leading-relaxed text-fog">
                <span className="tabular shrink-0 text-haze">{new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span>{h.what}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div role="tablist" aria-label="Run details" className="flex gap-1 border-b border-line">
        {(["progress", "log", "settings"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("press -mb-px h-10 border-b-2 px-3.5 text-[13.5px] font-semibold", tab === t ? "border-daylight text-paper" : "border-transparent text-haze hover:text-paper")}
          >
            {t === "progress" ? "Versions and loss" : t === "log" ? "Log" : "Settings"}
          </button>
        ))}
      </div>

      {tab === "progress" ? <Progress job={job} options={options} run={run} working={working} /> : tab === "log" ? <Log lines={log} live={active} /> : <SettingsSummary job={job} options={options} />}
    </div>
  );
}

/**
 * The machines a paused run can carry on on. Crackio brings what's trained so far home from the machine it's on, sends
 * it to the one picked, and the run goes on there at the same step.
 */
function MoveTo({ job, options, onPick }: { job: TrainJob; options: TrainOptions | null; onPick: (machine: string) => void }) {
  const here = options?.machines.find((m) => m.id === job.machine);
  const others = (options?.machines ?? []).filter((m) => m.id !== job.machine && m.kind !== "serverless");
  const kept = job.run?.home?.step === job.progress.step && job.progress.step > 0;
  return (
    <div className="mt-4 rounded-[16px] bg-white/[0.03] p-3.5">
      <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-fog">
        {job.progress.step > 0
          ? kept
            ? `Step ${job.progress.step.toLocaleString("en-US")} is kept on this computer. Crackio sends it to the machine you pick, and training carries on there from the same step.`
            : `Crackio brings what's trained so far (step ${job.progress.step.toLocaleString("en-US")}) home from ${here?.label ?? "the machine it's on"}, sends it to the machine you pick, and training carries on there from the same step. ${here?.label ?? "That machine"} has to be on for this.`
          : "Nothing is trained yet: it starts on the machine you pick."}
      </p>
      {others.length ? (
        <div className="mt-2.5 divide-y divide-line rounded-[12px] bg-white/[0.03]">
          {others.map((m) => {
            const able = m.usable && m.fit?.state !== "no";
            return (
              <button
                key={m.id}
                type="button"
                disabled={!able}
                onClick={() => onPick(m.id)}
                className="press flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-left hover:bg-white/[0.04] disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold text-paper">{m.label}</span>
                  <span className="block truncate text-[12px] text-haze">{m.fit?.state === "no" ? m.fit.why : (m.notice ?? m.fit?.why ?? (m.online ? "Ready" : "Not answering"))}</span>
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-haze">{m.pricePerHour ? `${money(m.pricePerHour)} an hour` : m.kind === "this-computer" ? "this computer" : ""}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-haze">No other machine is connected yet. Rent or start one (Settings → Machines) and it shows up here.</p>
      )}
    </div>
  );
}

function RunButton({ onClick, busy, icon, children, primary, title }: { onClick: () => void; busy: boolean; icon: React.ReactNode; children: React.ReactNode; primary?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      className={cn(
        "press squircle inline-flex h-10 items-center gap-2 rounded-[13px] px-4 text-[13px] font-semibold disabled:opacity-50",
        primary ? "lip bg-spike font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi" : "bg-white/[0.07] text-paper hover:bg-white/[0.11]",
      )}
    >
      {busy ? <LoaderCircle size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[12px] text-haze">{label}</dt>
      <dd className="tabular mt-0.5 text-[17px] font-semibold text-paper">{value}</dd>
      {sub ? <dd className="text-[11.5px] text-haze">{sub}</dd> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ versions (the test strip) and loss */

function Progress({ job, options, run, working }: { job: TrainJob; options: TrainOptions | null; run: Props["run"]; working: string | null }) {
  // An edit LoRA's test pictures are before pictures redone with its instruction.
  const prompts = job.goal === "edit" ? [captionFor(job, {}), captionFor(job, {})] : testPrompts(job);
  const versions = job.checkpoints;
  const marks = versions.map((v) => v.step);
  const [big, setBig] = useState<string | null>(null);
  const canPick = job.state === "done" && Boolean(job.result);
  // A run that stopped for good (its rented GPU is gone, or you'd rather not carry on) can still be made into a LoRA
  // from a version Crackio kept on this computer.
  const canFinishFrom = !job.result && (job.state === "paused" || job.state === "error");
  // Versions that are only on the machine it trained on (another computer, a rented GPU): they go when it does.
  const machine = options?.machines.find((m) => m.id === job.machine);
  // (A RunPod endpoint's versions can't be copied or picked yet: neither is offered there.)
  const endpoint = machine?.kind === "serverless";
  const awayOnly = canPick && options && machine?.kind !== "this-computer" && !endpoint ? versions.filter((v) => !v.home && v.file !== job.result?.file).length : 0;
  return (
    <div className="space-y-5">
      <LossChart points={job.progress.losses} steps={job.progress.steps || job.settings.steps} marks={marks} />
      <p className="-mt-3 text-[12px] leading-relaxed text-haze">The loss wobbles: that&rsquo;s normal. What matters is the test pictures below. Dotted lines mark saved versions.</p>

      {versions.length || job.baseline?.length ? (
        <section aria-label="Saved versions">
          <h3 className="text-[14px] font-semibold text-paper">Versions</h3>
          <p className="mt-0.5 max-w-[76ch] text-[12.5px] leading-relaxed text-haze">
            The same two test pictures at every saved version, next to the model without your LoRA. Too early and it hardly shows; too late and every picture starts to look like your set. {canPick ? (endpoint ? "On a RunPod endpoint the last version is the LoRA: an earlier one can't be picked yet." : "Pick the one that looks best.") : canFinishFrom && versions.some((v) => v.home) ? "When it's done you can pick the one that looks best. Or end the run here: a version kept on this computer can be the LoRA as it is." : "When it's done you can pick the one that looks best."}
          </p>
          {awayOnly ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] leading-relaxed text-tungsten">
              <span>
                {awayOnly === 1 ? "One version is" : `${awayOnly} versions are`} only on {machine?.label ?? "the machine it trained on"}
                {machine ? (machine.kind === "rented" ? ": delete that machine and they're gone." : ": they go when it does.") : ", which isn't one of your machines any more."}
              </span>
              {machine ? (
                <button type="button" disabled={working === "keep-versions"} onClick={() => run("keep-versions")} className="press h-7 rounded-full bg-white/[0.08] px-3 text-[12px] font-semibold text-paper hover:bg-white/[0.13] disabled:opacity-50">
                  {working === "keep-versions" ? "Copying…" : "Copy them to this computer"}
                </button>
              ) : null}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2.5 overflow-x-auto pb-2 scroll-thin">
            {job.baseline?.length ? <Version label="Without it" sub="the model alone" pictures={job.baseline} prompts={prompts} onOpen={setBig} /> : null}
            {versions.map((v) => {
              const current = job.result?.step === v.step;
              return (
                <Version
                  key={v.step}
                  label={`Step ${v.step.toLocaleString("en-US")}`}
                  sub={current ? "your LoRA" : v.previews ? undefined : "no test pictures"}
                  pictures={v.previews ?? []}
                  prompts={prompts}
                  current={current}
                  onOpen={setBig}
                  action={
                    canPick && !current && (!endpoint || v.home) ? (
                      <button type="button" disabled={working === "use-version"} onClick={() => run("use-version", v.step)} className="press mt-2 h-8 w-full rounded-full bg-white/[0.08] text-[12px] font-semibold text-paper hover:bg-white/[0.13] disabled:opacity-50">
                        Use this version
                      </button>
                    ) : canFinishFrom && v.home ? (
                      <button type="button" disabled={working === "use-version"} title="Make the LoRA from this version and end the run here" onClick={() => run("use-version", v.step)} className="press mt-2 h-8 w-full rounded-full bg-white/[0.08] text-[12px] font-semibold text-paper hover:bg-white/[0.13] disabled:opacity-50">
                        Finish with this one
                      </button>
                    ) : null
                  }
                />
              );
            })}
          </div>
        </section>
      ) : (
        <p className="rounded-[14px] bg-white/[0.025] px-4 py-3.5 text-[13px] text-haze">{job.run?.noPreviews ?? (job.settings.previews ? "Test pictures appear here each time a version is saved." : "Test pictures are off for this run.")}</p>
      )}

      {big ? (
        <button type="button" onClick={() => setBig(null)} aria-label="Close the picture" className="fixed inset-0 z-[90] grid cursor-zoom-out place-items-center bg-black/80 p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={big} alt="" className="max-h-full max-w-full rounded-[14px]" />
        </button>
      ) : null}
    </div>
  );
}

function Version({ label, sub, pictures, prompts, current, action, onOpen }: { label: string; sub?: string; pictures: string[]; prompts: string[]; current?: boolean; action?: React.ReactNode; onOpen: (url: string) => void }) {
  return (
    <div className={cn("w-[168px] shrink-0 rounded-[16px] p-2", current ? "bg-chroma/[0.08] shadow-[inset_0_0_0_1.5px_rgb(90_215_143/0.5)]" : "bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)]")}>
      <div className="space-y-1.5">
        {pictures.length ? (
          pictures.map((url, i) => (
            <button key={url} type="button" onClick={() => onOpen(url)} title={prompts[i]} className="press block aspect-square w-full cursor-zoom-in overflow-hidden rounded-[10px] bg-apple">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={prompts[i] ?? ""} loading="lazy" decoding="async" className="size-full object-cover" />
            </button>
          ))
        ) : (
          <div className="grid aspect-square w-full place-items-center rounded-[10px] bg-white/[0.03] text-[11.5px] text-haze">Saved</div>
        )}
      </div>
      <p className="tabular mt-2 px-0.5 text-[12.5px] font-semibold text-paper">{label}</p>
      {sub ? <p className={cn("px-0.5 text-[11.5px]", current ? "text-chroma" : "text-haze")}>{sub}</p> : null}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ the log */

function Log({ lines, live }: { lines: LogLine[]; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="scroll-thin h-[420px] overflow-y-auto rounded-[16px] bg-[#100e14] p-4 font-mono text-[12px] leading-[1.7] text-fog shadow-[inset_0_0_0_1px_var(--color-line)]"
      role="log"
      aria-live={live ? "polite" : "off"}
      tabIndex={0}
    >
      {lines.length ? (
        lines.map(([seq, text]) => (
          <p key={seq} className={cn("whitespace-pre-wrap break-words", /^(\S+ )?Crackio:/.test(text) ? "text-daylight" : /Stopped:|Problem:|Traceback|Error/.test(text) ? "text-tally" : /Saved|Done|Finished/.test(text) ? "text-chroma" : undefined)}>
            {text}
          </p>
        ))
      ) : (
        <p className="text-haze">Nothing logged yet.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ what it ran with */

function SettingsSummary({ job, options }: { job: TrainJob; options: TrainOptions | null }) {
  const s = job.settings;
  const base = job.base ? (job.base.kind === "custom" ? job.base.file : (options?.bases.find((b) => b.id === job.base!.family)?.name ?? job.base.family)) : "—";
  const rows: [string, string][] = [
    ["Model", `${base}${job.run?.weights && job.run.weights !== "custom" ? ` (${job.run.weights.toUpperCase()} weights)` : ""}`],
    [job.goal === "edit" ? "Before and after pairs" : "Pictures", `${trainable(job.images, job.goal).length}, trained at up to ${s.resolution} px`],
    job.goal === "edit" ? ["Instruction", job.instruction ?? ""] : ["Trigger word", job.goal === "style" ? job.trigger : [job.trigger, job.noun].filter(Boolean).join(" ")],
    [SETTING_HELP.steps.label, s.steps.toLocaleString("en-US")],
    [SETTING_HELP.rank.label, String(s.rank)],
    [SETTING_HELP.lr.label, s.lr.toExponential(1)],
    [SETTING_HELP.checkpoints.label, String(s.checkpoints)],
    [SETTING_HELP.captions.label, captionWords(job).text],
    [SETTING_HELP.captionDropout.label, `${s.captionDropout}%`],
    [SETTING_HELP.offload.label, s.offload ? "On" : "Off"],
    [SETTING_HELP.seed.label, String(s.seed)],
  ];
  return (
    <dl className="squircle divide-y divide-line rounded-[16px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-6 px-4 py-2.5">
          <dt className="text-[13px] text-haze">{k}</dt>
          <dd className="tabular truncate text-right text-[13.5px] font-medium text-paper">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ done */

/** The finished LoRA: where it is, switched on for its model, and the way to a first picture with it. */
function Result({ job, options }: { job: TrainJob; options: TrainOptions | null }) {
  const result = job.result!;
  const uses = options?.uses ?? [];
  const main = uses[0];
  const loras = useModelLoras((s) => (main ? s.byModel[main.crackio] : undefined));
  const on = Boolean(loras?.some((l) => l.file === result.file));
  // Switched on once for its model, the first time the finished LoRA is looked at: ready for the next picture.
  useEffect(() => {
    if (!main || job.state !== "done") return;
    const key = `crackio:train-adopted:${job.id}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    if (!isOn(main.crackio, result.file)) setLora(main.crackio, result.file, main.strength);
  }, [main, job.id, job.state, result.file]);
  const subject = job.goal === "style" ? `in ${job.trigger} style` : [job.trigger, job.noun].filter(Boolean).join(" ");
  return (
    <section className="squircle rounded-[22px] bg-chroma/[0.07] p-5 shadow-[inset_0_0_0_1px_rgb(90_215_143/0.28)] @min-[720px]:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h3 className="font-display text-[22px] text-paper">{job.name} is ready</h3>
          <p className="mt-1.5 max-w-[66ch] text-[13.5px] leading-relaxed text-fog">
            {main && job.goal === "edit" ? (
              <>
                It&rsquo;s in {main.name}&rsquo;s LoRAs{on ? ", switched on" : ""}. To use it, give {main.name} a picture to change and type the instruction: <span className="font-mono text-[12.5px] text-paper">{job.instruction}</span>
              </>
            ) : main ? (
              <>
                It&rsquo;s in {main.name}&rsquo;s LoRAs{on ? ", switched on" : ""}: every picture {main.name} makes {on ? "now carries" : "can carry"} it, in every tool. Crackio adds <span className="font-mono text-[12.5px] text-paper">{subject}</span> to your prompt for you.
              </>
            ) : (
              <>Its file is {result.file}.</>
            )}
          </p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            <Tag>{GB(result.bytes)}</Tag>
            <Tag>From step {result.step.toLocaleString("en-US")}</Tag>
            {result.kept ? <Tag tone="info">{job.checkpoints.length > 1 && job.checkpoints.every((k) => k.home || k.file === result.file) ? "Kept on this computer, with every version" : "A copy is kept on this computer"}</Tag> : null}
            {result.works === true ? <Tag tone="good">Changes the test pictures</Tag> : result.works === false ? <Tag tone="warn">Test pictures look unchanged</Tag> : null}
            {/* A run whose captions never got written (a text model didn't answer) looked like any other: said on the LoRA. */}
            {job.goal !== "edit" && trainable(job.images, job.goal).length > 0 && trainable(job.images, job.goal).every((i) => !i.caption?.trim()) ? <Tag tone="warn">Trained without captions</Tag> : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {main ? (
            <>
              <Link
                href={`/create?model=${encodeURIComponent(main.crackio)}`}
                onClick={() => !on && setLora(main.crackio, result.file, main.strength)}
                className="press lip squircle inline-flex h-11 items-center gap-2 rounded-[14px] bg-spike px-5 text-[13px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi"
              >
                <Sparkles size={15} /> Make a picture with it
              </Link>
              <button type="button" onClick={() => setLora(main.crackio, result.file, on ? null : main.strength)} className="press squircle inline-flex h-11 items-center gap-2 rounded-[14px] bg-white/[0.08] px-4 text-[13px] font-semibold text-paper hover:bg-white/[0.12]">
                {on ? "Switch it off" : "Switch it on"}
              </button>
            </>
          ) : null}
          {result.kept ? (
            <a href={`/api/train/${job.id}/file/lora/${encodeURIComponent(result.file)}`} className="press squircle inline-flex h-11 items-center gap-2 rounded-[14px] bg-white/[0.08] px-4 text-[13px] font-semibold text-paper hover:bg-white/[0.12]">
              <Download size={14} /> File
            </a>
          ) : null}
        </div>
      </div>
      {main ? (
        <p className="mt-3 text-[12.5px] text-haze">
          Strength and on/off live with the model&rsquo;s other LoRAs: open the model picker on any page and press LoRAs.{" "}
          <Link href="/create" className="inline-flex items-center gap-0.5 font-semibold text-fog hover:text-paper">
            Image page <ArrowUpRight size={12} />
          </Link>
        </p>
      ) : null}
      <LoraNotes file={result.file} />
    </section>
  );
}

/**
 * How to prompt the LoRA, kept with it: the words that work, the strength, its quirks. Yours to write; agents read it
 * before they use the LoRA (the MCP's loras tool) and add what they learn, so a new conversation doesn't start from zero.
 */
function LoraNotes({ file }: { file: string }) {
  const record = useLoraLibrary((s) => s.library?.records[file]);
  // null: the saved text shows; a string: your edit of it.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => loadLoraLibrary(), []);
  if (!record) return null;
  const saved = record.notes?.text ?? "";
  const text = draft ?? saved;
  const changed = draft !== null && draft.trim() !== saved.trim();
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/local/loras/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "notes", file, text }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      loadLoraLibrary(true);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-4 border-t border-white/[0.08] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="text-[13px] font-semibold text-paper">How to prompt it</h4>
        {record.notes ? (
          <p className="text-[12px] text-haze">
            Written by {record.notes.by}, {new Date(record.notes.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
          </p>
        ) : null}
      </div>
      <textarea
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        // Tall enough for the whole note where it can be (long lines wrap: about 130 letters a row at the narrowest).
        rows={Math.min(18, Math.max(3, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 130)), 0) + 1))}
        maxLength={4000}
        placeholder="The words that work, the strength, its quirks. Agents read this before they use the LoRA, and add what they learn."
        className="field-focus squircle mt-2 w-full resize-y rounded-[12px] bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-paper outline-none placeholder:text-haze/70"
      />
      {changed || error ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {changed ? (
            <>
              <button type="button" onClick={save} disabled={saving} className="press squircle inline-flex h-9 items-center gap-2 rounded-[12px] bg-white/[0.1] px-4 text-[12.5px] font-semibold text-paper hover:bg-white/[0.14] disabled:opacity-60">
                {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} Save
              </button>
              <button type="button" onClick={() => setDraft(null)} disabled={saving} className="text-[12.5px] font-semibold text-haze hover:text-paper">
                Undo
              </button>
            </>
          ) : null}
          {error ? <p className="text-[12.5px] text-tungsten">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
