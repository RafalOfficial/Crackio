"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, CircleAlert, Dumbbell, LoaderCircle, Pause, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { createTrainJob, deleteTrainJob, useTrainJob, useTrainJobs } from "@/lib/hooks/use-train";
import { isActive, type TrainSummary } from "@/lib/train/types";
import { Draft, PlanPanel } from "./Draft";
import { RunView } from "./RunView";
import { Field, STATE_WORDS } from "./parts";

/**
 * Train: a workbench for LoRAs of your own. Your LoRAs down the left (the one open is in the address, `?job=`); the open
 * one in the middle, as a workbench while you put it together and as a monitor once it runs; what a run will do and take
 * on the right, until you start it.
 */
export function TrainStudio() {
  const router = useRouter();
  const pathname = usePathname();
  const open = useSearchParams().get("job");
  const { jobs, error: listError } = useTrainJobs();
  const view = useTrainJob(open);
  const { job } = view;
  const [creating, setCreating] = useState(false);
  const go = useCallback((id: string | null) => router.replace(id ? `${pathname}?job=${id}` : pathname, { scroll: false }), [router, pathname]);

  // Nothing open: the newest one that's running, else the newest.
  useEffect(() => {
    if (open || !jobs?.length) return;
    go((jobs.find((j) => isActive(j.state)) ?? jobs[0]).id);
  }, [open, jobs, go]);

  // The open one was deleted somewhere else: its address goes, and the newest takes its place (above).
  const { gone } = view;
  useEffect(() => {
    if (gone) go(null);
  }, [gone, go]);

  const create = async () => {
    setCreating(true);
    try {
      go((await createTrainJob()).id);
    } finally {
      setCreating(false);
    }
  };

  const draft = job?.state === "draft";
  return (
    <div className="@container mx-auto flex min-h-dvh w-full max-w-[1680px] flex-col gap-6 px-4 pb-16 pt-6 lg:px-8 xl:flex-row xl:gap-8">
      <nav aria-label="Your LoRAs" className="xl:sticky xl:top-6 xl:h-[calc(100dvh-48px)] xl:w-[236px] xl:shrink-0">
        <div className="flex items-center justify-between gap-3 xl:block">
          <div>
            <h1 className="flex items-center gap-2.5 font-display text-[26px] text-paper">
              <Dumbbell size={22} className="text-daylight" /> Train
            </h1>
            <p className="mt-1.5 hidden text-[12.5px] leading-relaxed text-haze xl:block">Teach a model a person, a thing or a look from your own pictures. It&rsquo;s yours to use in every tool.</p>
          </div>
          <button type="button" onClick={() => void create()} disabled={creating} className="press squircle inline-flex h-10 shrink-0 items-center gap-2 rounded-[13px] bg-paper px-4 text-[13px] font-bold text-[#16131b] hover:bg-white disabled:opacity-60 xl:mt-5 xl:w-full xl:justify-center">
            {creating ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} strokeWidth={3} />} New LoRA
          </button>
        </div>
        <ul className="scroll-thin mt-4 flex gap-1.5 overflow-x-auto pb-1 xl:mt-5 xl:max-h-[calc(100%-190px)] xl:flex-col xl:overflow-y-auto xl:overflow-x-visible xl:pb-0">
          {jobs === null ? (
            <li className="skeleton h-14 w-full min-w-[180px] rounded-[14px]" />
          ) : jobs.length ? (
            jobs.map((j) => <JobRow key={j.id} job={j} on={j.id === open} onOpen={() => go(j.id)} />)
          ) : (
            <li className="rounded-[14px] bg-white/[0.025] px-3.5 py-3 text-[12.5px] leading-relaxed text-haze">No LoRAs yet. Start one: all it takes is a set of pictures.</li>
          )}
        </ul>
        {listError && !jobs ? <p className="mt-2 text-[12.5px] text-tally">{listError}</p> : null}
      </nav>

      <div className="min-w-0 flex-1">
        {!open ? (
          jobs?.length === 0 ? <Welcome onCreate={() => void create()} creating={creating} /> : null
        ) : !job ? (
          view.error ? <p className="rounded-[14px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally">{view.error}</p> : <div className="skeleton h-[420px] rounded-[22px]" />
        ) : (
          <div className={cn("grid gap-8", draft && "2xl:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_320px]")}>
            <div className="@container min-w-0">
              <Header
                key={job.id}
                name={job.name}
                state={job.state}
                onRename={(name) => view.patch({ name })}
                onDelete={async (alsoLora) => {
                  await deleteTrainJob(job.id, alsoLora);
                  go(null);
                }}
                hasLora={Boolean(job.result)}
                busy={isActive(job.state)}
              />
              {view.error ? (
                <p className="mb-5 flex items-center justify-between gap-3 rounded-[14px] bg-tally/10 px-4 py-2.5 text-[13px] text-tally">
                  {view.error}
                  <button type="button" onClick={view.dismissError} aria-label="Dismiss" className="press grid size-7 shrink-0 place-items-center rounded-full hover:bg-white/[0.08]">
                    <X size={14} />
                  </button>
                </p>
              ) : null}
              {draft ? (
                <Draft job={job} options={view.options} upload={view.upload} patch={view.patch} addImages={view.addImages} removeImages={view.removeImages} removeBefore={view.removeBefore} clearUpload={view.clearUpload} />
              ) : (
                <RunView job={job} log={view.log} options={view.options} working={view.working} run={view.run} />
              )}
            </div>
            {draft ? (
              <div className="xl:sticky xl:top-6 xl:self-start">
                <PlanPanel job={job} options={view.options} onStart={() => view.run("start")} starting={view.working === "start"} uploading={Boolean(view.upload && view.upload.done < view.upload.total)} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, on, onOpen }: { job: TrainSummary; on: boolean; onOpen: () => void }) {
  const active = isActive(job.state);
  const share = job.steps ? Math.min(1, job.step / job.steps) : 0;
  return (
    <li className="min-w-[190px] xl:min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={on ? "true" : undefined}
        className={cn("press squircle flex w-full items-center gap-3 rounded-[14px] p-2 text-left", on ? "bg-white/[0.085] shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "hover:bg-white/[0.045]")}
      >
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-apple-2 text-haze">
          {job.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/train/${job.id}/file/images/${job.cover}?w=200`} alt="" className="size-full object-cover" />
          ) : (
            <Dumbbell size={15} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-paper">{job.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-haze">
            {active ? <LoaderCircle size={11} className="animate-spin text-daylight" /> : job.done ? <Check size={11} className="text-chroma" strokeWidth={3} /> : job.state === "error" ? <CircleAlert size={11} className="text-tally" /> : job.state === "paused" ? <Pause size={11} className="text-tungsten" /> : null}
            <span className="truncate">{active && job.step ? `${Math.round(share * 100)}% · ${STATE_WORDS[job.state].toLowerCase()}` : job.state === "draft" ? `${job.images} ${job.goal === "edit" ? (job.images === 1 ? "pair" : "pairs") : job.images === 1 ? "picture" : "pictures"}` : STATE_WORDS[job.state]}</span>
          </span>
          {active ? (
            <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
              <span className="block h-full origin-left rounded-full bg-daylight transition-transform duration-700" style={{ transform: `scaleX(${share})` }} />
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Header({ name, state, onRename, onDelete, hasLora, busy }: { name: string; state: TrainSummary["state"]; onRename: (name: string) => void; onDelete: (alsoLora: boolean) => Promise<void>; hasLora: boolean; busy: boolean }) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!asking) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setAsking(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [asking]);
  const remove = async (alsoLora: boolean) => {
    setWorking(true);
    setProblem(null);
    try {
      await onDelete(alsoLora);
    } catch (err) {
      setProblem((err as Error).message);
      setWorking(false);
    }
  };
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      {state === "draft" ? (
        <h2 className="font-display text-[30px] text-paper">{name === "New LoRA" ? "A new LoRA" : name}</h2>
      ) : (
        <Field label="Name" value={name} onCommit={(v) => v.trim() && onRename(v)} maxLength={60} className="w-[min(360px,100%)]" />
      )}
      <div ref={box} className="relative">
        <button type="button" onClick={() => setAsking(!asking)} disabled={busy} title={busy ? "Pause it before deleting it" : "Delete this LoRA"} aria-haspopup="menu" aria-expanded={asking} className="press inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-haze hover:bg-white/[0.06] hover:text-paper disabled:opacity-40">
          <Trash2 size={13} /> Delete
        </button>
        {asking ? (
          <div role="menu" className="absolute right-0 top-10 z-30 w-[280px] rounded-[16px] bg-[#1b1920] p-2 shadow-[0_12px_32px_rgb(0_0_0/0.5),inset_0_0_0_1px_rgb(255_255_255/0.06)]">
            <button type="button" role="menuitem" disabled={working} onClick={() => void remove(false)} className="press block w-full rounded-[11px] px-3 py-2.5 text-left hover:bg-white/[0.06]">
              <span className="block text-[13px] font-semibold text-paper">{hasLora ? "Delete the project, keep the LoRA" : "Delete it"}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-haze">{hasLora ? "The pictures, versions and log go. The LoRA stays in the model's LoRAs." : "Its pictures and everything it left on the machine go."}</span>
            </button>
            {hasLora ? (
              <button type="button" role="menuitem" disabled={working} onClick={() => void remove(true)} className="press mt-1 block w-full rounded-[11px] px-3 py-2.5 text-left hover:bg-tally/12">
                <span className="block text-[13px] font-semibold text-tally">Delete everything, the LoRA too</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-haze">The LoRA file is removed from the machine it trained on and from this computer.</span>
              </button>
            ) : null}
            {working ? <p className="px-3 py-1.5 text-[12px] text-haze">Deleting…</p> : null}
            {problem ? <p className="px-3 py-1.5 text-[12px] text-tally">{problem}</p> : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** The first visit: what this is, in three plain lines, and the one button. */
function Welcome({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div className="grid min-h-[70dvh] place-items-center">
      <div className="max-w-[560px] text-center">
        <Dumbbell size={34} className="mx-auto text-daylight" />
        <h2 className="mt-5 font-display text-[40px] leading-[1.02] text-paper">Teach a model something of your own</h2>
        <p className="mx-auto mt-4 max-w-[48ch] text-[15px] leading-relaxed text-fog">
          Drop in 10 to 200 pictures of a person, a product, a character or a look. Crackio sets everything up, trains a LoRA on your GPU, and switches it on for the model, so your next picture already has it.
        </p>
        <button type="button" onClick={onCreate} disabled={creating} className="press lip squircle mt-7 inline-flex h-12 items-center gap-2 rounded-[16px] bg-spike px-7 text-[14px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-60">
          {creating ? <LoaderCircle size={16} className="animate-spin" /> : <Plus size={16} strokeWidth={3} />} Start a LoRA
        </button>
      </div>
    </div>
  );
}
