"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { setUp, stopSetUp, useSetup } from "@/lib/hooks/use-setup";
import { KITS, kitById } from "@/lib/setup/kits";
import { ADDONS } from "@/lib/addons";
import type { KitId, SetupJob, SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Heading, KitMark, Lamp, Loading, MachineStrip, ProblemCard, Progress, Verdict, useHrefWith } from "./parts";
import { ToolBoard } from "./ToolBoard";
import { AddonBoard, addonStatus } from "./AddonBoard";
import { bytesText, fits, gbText, settable, toolWords, toolsInOrder, pickMachine, countReady } from "./words";

/**
 * Settings → Tools: every tool on one machine, what it needs there and one button that gets it. The machine is the page's
 * context (?machine=); "All" shows every tool on every machine at once. The switch under the title turns the board to
 * the add-ons (?view=addons; lib/addons): the small extras a tool can do without, each got by itself.
 */
export function ToolsView() {
  const params = useSearchParams();
  const asked = params.get("machine");
  const focus = params.get("tool");
  // ?model= (Settings → Models' "Set up on …"): the tool's sheet opens with that model picked.
  const model = params.get("model");
  // The sheet and the model chooser read every part's model options: the full snapshot here.
  const { snap, error } = useSetup(true, { full: true });
  if (!snap) return error ? <ProblemCard title="Crackio couldn't look at your machines" why={error} /> : <Loading rows={8} />;
  const addons = params.get("view") === "addons";
  // Add-ons are looked at one machine at a time.
  const all = asked === "all" && !addons;
  const m = all ? null : pickMachine(snap, asked === "all" ? null : asked);
  return (
    <div>
      <Verdict
        title="Tools"
        facts={addons ? "Small add-ons that make a tool better. One click gets one." : m ? machineFacts(m) : "Every tool on every machine. Pick one to set things up there."}
      />
      <div className="mt-5">
        <ViewSwitch addons={addons} />
      </div>
      <div className="mt-5">
        <MachineStrip snap={snap} selected={m?.id ?? null} all={!addons} allOn={all} />
      </div>
      {all ? <AllMachines snap={snap} /> : !m ? <NoMachines /> : addons ? <MachineAddons snap={snap} m={m} /> : <MachineTools snap={snap} m={m} focus={focus} model={model} />}
    </div>
  );
}

/** The page's two sides: the tools, and the add-ons that make them better. */
function ViewSwitch({ addons }: { addons: boolean }) {
  const hrefWith = useHrefWith();
  const side = (label: string, count: number, on: boolean, href: string) => (
    <Link
      href={href}
      replace
      scroll={false}
      role="tab"
      aria-selected={on}
      className={cn(
        "press squircle inline-flex h-9 items-center gap-2 rounded-[10px] px-4 text-[13.5px] font-semibold transition-colors",
        on ? "bg-white/[0.11] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-fog hover:text-paper",
      )}
    >
      {label}
      <span className={cn("text-[12px] font-medium tabular", on ? "text-fog" : "text-haze")}>{count}</span>
    </Link>
  );
  return (
    <div role="tablist" aria-label="What to set up" className="squircle inline-flex gap-1 rounded-[13px] bg-white/[0.04] p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
      {side("Tools", KITS.length, !addons, hrefWith("view", null))}
      {side("Add-ons", ADDONS.length, addons, hrefWith("view", "addons"))}
    </div>
  );
}

function MachineAddons({ snap, m }: { snap: SetupSnapshot; m: SetupMachine }) {
  const jobs = snap.jobs.filter((j) => j.machine === m.id || (m.kind === "this-computer" && j.machine === "this-computer"));
  const live = jobs.find((j) => j.state === "running" || j.state === "queued") ?? null;
  const recent = !live ? (jobs.find((j) => j.finishedAt && snap.at - j.finishedAt < 10 * 60_000 && j.state !== "done") ?? null) : null;
  const ready = m.online ? ADDONS.filter((a) => addonStatus(m, a)?.state === "ready").length : 0;
  return (
    <div className="mt-6 space-y-5">
      <p className="text-[13px] text-haze">
        {ready} of {ADDONS.length} ready on {m.label}
      </p>
      {!m.online ? (
        <ProblemCard title={`${m.label} isn't answering`} why={m.kind === "rented" ? "Stopped, or given back? Start it at your cloud and Crackio connects again by itself." : "Start its ComfyUI and Crackio finds it again."} />
      ) : null}
      {m.metered ? <ProblemCard tone="needs" title="Pay per job" why="This endpoint brings its own models and bills each job. Add-ons are set up on your own GPUs." /> : null}
      {live ? <JobPanel job={live} /> : recent ? <JobPanel job={recent} /> : null}
      <AddonBoard m={m} live={live} />
    </div>
  );
}

export function machineFacts(m: SetupMachine) {
  const parts = [
    m.gpu?.memoryGb ? `${gbText(m.gpu.memoryGb)} ${m.gpu.unified ? "shared memory" : "graphics memory"}` : m.accel === "cpu" ? "No GPU in use" : null,
    m.os,
    m.diskFreeGb != null ? `${gbText(m.diskFreeGb)} free for models` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function NoMachines() {
  return (
    <div className="mt-10">
      <ProblemCard
        tone="needs"
        title="No machine to set tools up on yet"
        why="Set ComfyUI up on this computer, add one on your network, or connect a rented GPU."
        action={
          <ButtonLink href="/settings/machines?add=1" variant="primary" size="sm">
            Add a computer
          </ButtonLink>
        }
      />
    </div>
  );
}

function MachineTools({ snap, m, focus, model }: { snap: SetupSnapshot; m: SetupMachine; focus: string | null; model: string | null }) {
  const rows = toolsInOrder(m);
  const jobs = snap.jobs.filter((j) => j.machine === m.id || (m.kind === "this-computer" && j.machine === "this-computer"));
  const live = jobs.find((j) => j.state === "running" || j.state === "queued") ?? null;
  const recent = !live ? (jobs.find((j) => j.finishedAt && snap.at - j.finishedAt < 10 * 60_000 && j.state !== "done") ?? null) : null;
  const can = settable(m);
  const canBytes = can.reduce((s, k) => s + m.tools[k].bytes, 0);
  const counts = {
    ready: countReady(m),
    set: rows.filter((r) => ["missing", "no-comfy"].includes(r.status.state)).length,
    not: rows.filter((r) => r.status.state === "unsupported").length,
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function all() {
    setBusy(true);
    setError(null);
    const r = await setUp(m.id, can);
    setError(r.error);
    setBusy(false);
  }

  return (
    <div className="mt-6 space-y-5">
      <p className="text-[13px] text-haze">
        {counts.ready} ready{counts.set ? ` · ${counts.set} to set up` : ""}
        {counts.not ? ` · ${counts.not} not for this machine` : ""}
      </p>
      {!m.online ? (
        <ProblemCard title={`${m.label} isn't answering`} why={m.kind === "rented" ? "Stopped, or given back? Start it at your cloud and Crackio connects again by itself." : "Start its ComfyUI and Crackio finds it again."} />
      ) : null}
      {m.metered ? <ProblemCard tone="needs" title="Pay per job" why="This endpoint brings its own models and bills each job. Tools are set up on your own GPUs; jobs go here only when you pick it." /> : null}
      {live ? <JobPanel job={live} /> : recent ? <JobPanel job={recent} /> : null}
      {m.online && !m.metered && can.length > 1 && !live ? (
        <div className="squircle flex flex-wrap items-center justify-between gap-3 rounded-[18px] bg-white/[0.035] px-5 py-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <p className="text-[14px] text-fog">
            <span className="font-semibold text-paper">{can.length} tools</span> run well here and aren&rsquo;t set up yet: {bytesText(canBytes)} to download.
            {!fits(m, canBytes) ? <span className="block text-tungsten">There&rsquo;s {gbText(m.diskFreeGb)} free here: make room first.</span> : null}
          </p>
          {fits(m, canBytes) ? (
            <Button variant="primary" size="md" onClick={() => void all()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : null}
              Set up all {can.length} · {bytesText(canBytes)}
            </Button>
          ) : (
            <ButtonLink href={`/settings/storage?machine=${encodeURIComponent(m.id)}`} variant="outline" size="md">
              Open Storage
            </ButtonLink>
          )}
        </div>
      ) : null}
      {error ? <ProblemCard title="That didn't start" why={error} /> : null}
      <ToolBoard rows={rows} ctx={{ m, snap, live }} focus={focus} model={model} />
    </div>
  );
}

/** A set-up in progress (or one that just stopped): its steps, each with its words and progress. */
export function JobPanel({ job }: { job: SetupJob }) {
  const running = job.state === "running" || job.state === "queued";
  return (
    <div className="squircle rounded-[18px] bg-daylight/[0.05] px-5 py-4 shadow-[inset_0_0_0_1px_rgb(142_197_255/0.16)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[14px] font-semibold text-paper">
          <Lamp tone={running ? "busy" : job.state === "error" ? "problem" : "off"} />
          {running ? `Setting up ${kitNames(job.kits)} on ${job.machineLabel}` : job.state === "error" ? `Setting up ${kitNames(job.kits)} stopped` : `Stopped setting up ${kitNames(job.kits)}`}
        </p>
        {running ? (
          <Button variant="ghost" size="sm" onClick={() => void stopSetUp(job.id)}>
            Stop
          </Button>
        ) : null}
      </div>
      <ol className="mt-3 space-y-2">
        {job.steps.map((s) => (
          <li key={s.id} className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2.5 text-[13px]">
            <span className="mt-[5px]">
              <Lamp tone={s.state === "done" ? "ready" : s.state === "running" ? "busy" : s.state === "error" ? "problem" : "off"} />
            </span>
            <span className="min-w-0">
              <span className={cn("font-medium", s.state === "waiting" || s.state === "skipped" ? "text-haze" : "text-paper")}>{s.label}</span>
              {s.detail && s.state === "running" ? <span className="text-fog"> · {s.detail}</span> : null}
              {s.error ? <span className="block text-tally">{s.error}</span> : null}
              {s.state === "running" && s.progress ? (
                <span className="mt-1.5 flex max-w-[420px] items-center gap-2">
                  <Progress received={s.progress.received} total={s.progress.total} className="flex-1" />
                  <span className="shrink-0 text-[11.5px] tabular text-haze">
                    {s.progress.total === 100 ? `${Math.round(s.progress.received)}%` : `${bytesText(s.progress.received)} of ${bytesText(s.progress.total)}`}
                  </span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {running ? <p className="mt-3 text-[12px] text-haze">Keep using Crackio meanwhile: the set-up carries on by itself.</p> : null}
    </div>
  );
}

const kitNames = (ids: KitId[]) => {
  const names = ids.map((id) => kitById(id)?.name ?? id);
  return names.length <= 2 ? names.join(" and ") : `${names.length} tools`;
};

/** Every tool × every machine: one lamp per cell, each a link to that machine's tools. */
function AllMachines({ snap }: { snap: SetupSnapshot }) {
  const hrefWith = useHrefWith();
  const machines = snap.machines;
  return (
    <div className="scroll-thin mt-6 overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className="sticky left-0 bg-stage py-2 pr-4 text-left font-medium text-haze">Tool</th>
            {machines.map((m) => (
              <th key={m.id} className="px-3 py-2 text-left font-medium">
                <Link href={hrefWith("machine", m.id)} className="font-display text-[12.5px] uppercase text-fog hover:text-paper">
                  {m.label}
                </Link>
                <span className="block text-[11px] font-normal text-haze">{m.kind === "this-computer" ? "This computer" : m.where}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KITS.map((kit) => (
            <tr key={kit.id} className="group">
              <td className="sticky left-0 border-t border-line bg-stage py-2.5 pr-4">
                <span className="flex items-center gap-2.5">
                  <KitMark kit={kit} lit={machines.some((m) => m.tools[kit.id].state === "ready")} size={24} />
                  <span className="font-medium text-paper">{kit.name}</span>
                </span>
              </td>
              {machines.map((m) => {
                const w = toolWords(m.tools[kit.id]);
                return (
                  <td key={m.id} className="border-t border-line px-3 py-2.5">
                    <Link href={`${hrefWith("machine", m.id)}&tool=${kit.id}`.replace("?&", "?")} className="inline-flex items-center gap-1.5 text-fog hover:text-paper">
                      <Lamp tone={w.tone} />
                      {w.label}
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { Heading };
