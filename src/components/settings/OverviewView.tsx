"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { UsageSummary } from "@/lib/usage/types";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { setUp, useSetup } from "@/lib/hooks/use-setup";
import { setRunOn } from "@/lib/hooks/use-run-on";
import { KITS } from "@/lib/setup/kits";
import type { KitId, LiveGpu, SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Heading, KitMark, Lamp, Loading, ProblemCard, Tape, Verdict } from "./parts";
import { findProblems, type Fix, type Problem } from "./problems";
import { bytesText, gbText, machineTone, machineWords, settable } from "./words";
import { JobPanel } from "./ToolsView";
import { useLive } from "@/lib/hooks/use-live";
import { LiveLine } from "./LiveMeters";
import { CreditLine } from "./CloudMoney";

/**
 * Settings' first page: does it work, on which computer, what can I make, what needs me. A verdict in one line, your
 * machines, at most three things that need you, then every tool and where it runs.
 */
export function OverviewView() {
  const { snap, error } = useSetup();
  // The GPUs right now, for the machine cards' one line.
  const gpus = useLive((snap?.machines ?? []).filter((m) => m.online && !m.metered).map((m) => m.id));
  if (!snap) return error ? <ProblemCard title="Crackio couldn't look at your machines" why={error} /> : <Loading rows={6} />;
  const problems = findProblems(snap);
  const own = snap.machines.filter((m) => !m.metered);
  const working = own.filter((m) => m.online && m.comfy.installed);
  const readyKits = KITS.filter((k) => snap.runsOn[k.id]);
  const fresh = !working.length;
  const title = fresh ? "Let's get you making." : problems.length === 0 ? "All set." : problems.length === 1 ? "One thing needs you." : `${problems.length} things need you.`;
  const video = snap.runsOn.video ? snap.machines.find((m) => m.id === snap.runsOn.video) : null;
  const facts = fresh
    ? "Crackio runs every tool on your own graphics card, through ComfyUI. Set this computer up, or connect a GPU."
    : `${working.length} ${working.length === 1 ? "computer" : "computers"} on · ${readyKits.length} of ${KITS.length} tools ready${video ? ` · clips run on ${video.label}` : ""}`;
  const live = snap.jobs.filter((j) => j.state === "running" || j.state === "queued");

  return (
    <div className="space-y-10">
      <div>
        <Verdict title={title} facts={facts} />
        <CreditLine credit={snap.credit} className="mt-3" />
        <ToolLights snap={snap} />
      </div>
      {fresh ? <FirstRun snap={snap} /> : null}
      {live.map((j) => (
        <JobPanel key={j.id} job={j} />
      ))}
      <section className="space-y-3">
        <Heading title="Your machines" aside={<Link href="/settings/machines?add=1" className="text-[13px] font-medium text-haze hover:text-paper">Add a computer</Link>} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {snap.machines.map((m) => (
            <MachineCard key={m.id} m={m} live={gpus[m.id]} />
          ))}
        </div>
      </section>
      {problems.length ? (
        <section className="space-y-3">
          <Heading title="Needs you" aside={problems.length > 3 ? <Link href="/settings/doctor" className="text-[13px] font-medium text-haze hover:text-paper">All {problems.length} in Doctor</Link> : null} />
          <div className="space-y-2">
            {problems.slice(0, 3).map((p) => (
              <ProblemRow key={p.id} p={p} />
            ))}
          </div>
        </section>
      ) : null}
      <WeekLine />
      <section className="space-y-3">
        <Heading title="Ready to make" note="Each tool runs on the machine shown; set up the rest where they'd run best." />
        <ul className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {KITS.map((k) => (
            <KitLine key={k.id} kitId={k.id} snap={snap} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** What to do about a machine that isn't answering (its lamp already says "Not answering"). */
const offlineHint = (m: SetupMachine) =>
  m.kind === "rented"
    ? "Stopped or starting up. Start it in Machines."
    : m.kind === "lan"
      ? "Turn it on and start ComfyUI there: it joins again by itself."
      : m.kind === "this-computer"
        ? m.comfy.installed
          ? "Its ComfyUI isn't running."
          : "No ComfyUI yet."
        : "Not answering right now.";

function MachineCard({ m, live }: { m: SetupMachine; live?: LiveGpu }) {
  const tone = machineTone(m);
  const ready = Object.values(m.tools).filter((t) => t.state === "ready").length;
  return (
    <Link
      href={`/settings/machines?machine=${encodeURIComponent(m.id)}`}
      className="squircle group relative flex flex-col gap-3 rounded-[18px] bg-white/[0.035] p-4 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-white/[0.055]"
    >
      <span className="flex items-center gap-2 text-[12px] font-medium text-haze">
        <Lamp tone={tone} />
        {m.metered ? "Pay per job" : machineWords(m)}
      </span>
      <span>
        <span className="block truncate font-display text-[20px] uppercase leading-none text-paper">{m.label}</span>
        <span className="mt-1 block truncate text-[12.5px] text-haze">{m.kind === "this-computer" ? "This computer" : m.where}</span>
      </span>
      <span className="text-[12.5px] leading-relaxed text-fog">
        {!m.online
          ? offlineHint(m)
          : !m.comfy.installed
            ? "No ComfyUI yet"
            : `${ready} tools ready${m.gpu?.memoryGb ? ` · ${gbText(m.gpu.memoryGb)} ${m.gpu.unified ? "shared" : "graphics memory"}` : ""}`}
        {m.online && m.diskFreeGb != null ? <span className={cn("block", m.diskFreeGb < 2 ? "text-tally" : m.diskFreeGb < 10 ? "text-tungsten" : "text-haze")}>{gbText(m.diskFreeGb)} free for models</span> : null}
      </span>
      <LiveLine live={live} />
      {m.online && m.comfy.installed ? (
        <span className="mt-auto flex flex-wrap gap-1 pt-1" aria-label={`${ready} of ${KITS.length} tools ready here`}>
          {KITS.map((k) => (
            <KitMark key={k.id} kit={k} lit={m.tools[k.id]?.state === "ready"} size={18} title={`${k.name}: ${m.tools[k.id]?.state === "ready" ? "ready" : "not set up"}`} />
          ))}
        </span>
      ) : null}
      {m.runOn ? (
        <span className="absolute right-4 top-4 text-[11px] font-semibold text-spike" title="Jobs go here first">
          First
          <Tape className="inset-x-0 -bottom-1 h-[2px]" />
        </span>
      ) : null}
    </Link>
  );
}

function ProblemRow({ p }: { p: Problem }) {
  return <ProblemCard tone={p.tone} title={p.title} why={p.why} action={p.fix ? <FixButton fix={p.fix} /> : null} />;
}

/** The one button a problem offers, doing what it says. */
export function FixButton({ fix }: { fix: Fix }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (fix.kind === "link") {
    return (
      <ButtonLink href={fix.href} variant="outline" size="sm">
        {fix.label}
      </ButtonLink>
    );
  }
  async function run() {
    setBusy(true);
    setError(null);
    if (fix.kind === "run-on-auto") await setRunOn("auto");
    if (fix.kind === "setup") setError((await setUp(fix.machine, fix.kits as KitId[])).error);
    if (fix.kind === "start-comfy") {
      const res = await fetch("/api/local/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) }).catch(() => null);
      if (!res?.ok) setError("ComfyUI didn't start.");
    }
    const { useSetupStore } = await import("@/lib/hooks/use-setup");
    await useSetupStore.getState().reload(true);
    setBusy(false);
  }
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-[12px] text-tally">{error}</span> : null}
      <Button variant="outline" size="sm" onClick={() => void run()} disabled={busy}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
        {fix.label}
      </Button>
    </span>
  );
}

function KitLine({ kitId, snap }: { kitId: KitId; snap: SetupSnapshot }) {
  const kit = KITS.find((k) => k.id === kitId)!;
  const on = snap.runsOn[kitId] ? snap.machines.find((m) => m.id === snap.runsOn[kitId]) : null;
  const best = !on && snap.recommended[kitId] ? snap.machines.find((m) => m.id === snap.recommended[kitId]) : null;
  const where = on?.tools[kitId];
  const cloud = !on && kit.cloud && snap.keys.comfy;
  return (
    <li className="flex min-h-[64px] items-center gap-3.5 border-b border-line py-2.5">
      <span className="relative shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={kit.media} alt="" loading="lazy" decoding="async" className={cn("squircle h-11 w-16 rounded-[10px] object-cover", on ? "" : "opacity-45 grayscale-[0.9]")} />
        <span className="absolute -bottom-1.5 -right-1.5">
          <KitMark kit={kit} lit={Boolean(on)} size={22} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-paper">{kit.name}</span>
        <span className="block truncate text-[12.5px] text-haze">
          {on ? `${where?.why ?? "Ready"} · on ${on.label}` : cloud ? `On your Comfy key: ${kit.cloud}` : best ? `Not set up · would run on ${best.label}` : "Not set up anywhere yet"}
        </span>
      </span>
      {on ? (
        <Link href={kit.href} className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-fog hover:text-paper">
          Open <ArrowUpRight size={13} />
        </Link>
      ) : best ? (
        <Link href={`/settings/tools?machine=${encodeURIComponent(best.id)}&tool=${kitId}`} className="shrink-0 text-[12.5px] font-semibold text-spike hover:text-spike-hi">
          Set up{best.tools[kitId].bytes ? ` · ${bytesText(best.tools[kitId].bytes)}` : ""}
        </Link>
      ) : null}
    </li>
  );
}

/** A computer with nothing set up: one button sets it up for its card, or the other ways in, side by side. */
function FirstRun({ snap }: { snap: SetupSnapshot }) {
  const here = snap.machines.find((m) => m.kind === "this-computer") ?? null;
  const kits = here ? settable(here) : [];
  const bytes = here ? kits.reduce((s, k) => s + here.tools[k].bytes, 0) : 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const weak = !here?.gpu || (here.gpu.memoryGb ?? 0) < 6;
  async function go() {
    if (!here) return;
    setBusy(true);
    setError((await setUp(here.id, kits)).error);
    setBusy(false);
  }
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="squircle relative flex flex-col justify-between gap-5 rounded-[22px] bg-white/[0.045] p-6 shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
        {!weak ? <span className="absolute left-6 top-0 h-[3px] w-24 rounded-b-[2px] bg-spike" aria-hidden="true" /> : null}
        <div>
          <p className="font-display text-[24px] uppercase leading-none text-paper">Set up this computer</p>
          <p className="mt-2 text-[14px] leading-relaxed text-fog">
            {here?.gpu ? `${here.gpu.name}${here.gpu.memoryGb ? `, ${gbText(here.gpu.memoryGb)}` : ""}` : "No graphics card found"}
            {here?.os ? ` · ${here.os}` : ""}
            {here?.diskFreeGb != null ? ` · ${gbText(here.diskFreeGb)} free` : ""}
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-fog">
            {kits.length
              ? `ComfyUI for this card, then ${kits.map((k) => KITS.find((x) => x.id === k)?.name).join(", ")}: about ${bytesText(bytes)} in all.`
              : "This card is too small for Crackio's open models. Connect a bigger GPU, or use hosted models with a Comfy key."}
          </p>
        </div>
        {kits.length ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" onClick={() => void go()} disabled={busy}>
              {busy ? <LoaderCircle size={16} className="animate-spin" /> : null}
              Set up this computer · {bytesText(bytes)}
            </Button>
            <Link href="/settings/tools?machine=this-computer" className="text-[13px] font-medium text-haze hover:text-paper">
              Choose what goes in
            </Link>
          </div>
        ) : null}
        {error ? <p className="text-[13px] text-tally">{error}</p> : null}
      </div>
      <div className="grid gap-3">
        <Option title="Use a bigger GPU" body="Rent one on vast.ai or RunPod, or add another computer: Crackio connects it and sets it up." href="/settings/machines?add=1" action="Connect a GPU" />
        <Option title="Nothing to install" body="Hosted models run on Comfy's GPUs with a Comfy key, billed by Comfy." href="/settings/accounts#comfy" action="Add a Comfy key" />
      </div>
    </div>
  );
}

function Option({ title, body, href, action }: { title: string; body: string; href: string; action: string }) {
  return (
    <div className="squircle flex flex-col justify-between gap-3 rounded-[18px] bg-white/[0.03] p-5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div>
        <p className="font-display text-[16px] uppercase leading-none text-paper">{title}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fog">{body}</p>
      </div>
      <ButtonLink href={href} variant="outline" size="sm" className="self-start">
        {action}
      </ButtonLink>
    </div>
  );
}

/** The last 7 days in one line, from the same numbers as Settings → Usage. */
function WeekLine() {
  const [week, setWeek] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/settings/usage?days=7", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<UsageSummary>) : null))
      .then((d) => live && setWeek(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!week) return null;
  const t = week.totals;
  const parts = [t.pictures && `${t.pictures.toLocaleString("en-US")} pictures`, t.clips && `${t.clips.toLocaleString("en-US")} clips`, t.audio && `${t.audio} voice takes`].filter(Boolean);
  return (
    <Link href="/settings/usage" className="squircle group flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-white/[0.03] px-5 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]">
      <span className="text-[14px] text-fog">
        <span className="font-semibold text-paper">This week</span> · {parts.length ? parts.join(" · ") : "nothing made yet"}
        {t.firstTry != null ? ` · ${Math.round(t.firstTry * 100)}% worked first try` : ""}
        {t.gpuHours ? ` · ${t.gpuHours < 1 ? `${Math.round(t.gpuHours * 60)} min` : `${t.gpuHours.toFixed(1)} h`} of GPU work` : ""}
      </span>
      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-haze group-hover:text-paper">
        Usage <ArrowUpRight size={13} />
      </span>
    </Link>
  );
}

/** Every tool as its own mark, lit in its colour when it's ready somewhere: Crackio's whole kit at a glance. */
function ToolLights({ snap }: { snap: SetupSnapshot }) {
  return (
    <ul className="mt-6 flex flex-wrap items-center gap-2" aria-label="Tools ready">
      {KITS.map((k) => {
        const on = snap.runsOn[k.id] ? snap.machines.find((m) => m.id === snap.runsOn[k.id]) : null;
        return (
          <li key={k.id}>
            <Link href={on ? k.href : `/settings/tools?tool=${k.id}`} className="press block" title={on ? `${k.name}: ready on ${on.label}` : `${k.name}: not set up yet`}>
              <KitMark kit={k} lit={Boolean(on)} size={36} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
