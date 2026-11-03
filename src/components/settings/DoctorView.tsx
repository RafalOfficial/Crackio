"use client";

import { useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSetup, useSetupStore } from "@/lib/hooks/use-setup";
import type { SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { Lamp, Loading, ProblemCard, Verdict } from "./parts";
import { findProblems, type Problem } from "./problems";
import { FixButton } from "./OverviewView";
import { countReady, gbText } from "./words";

/**
 * Settings → Doctor: everything Crackio checks, machine by machine. What's wrong comes first, each with its one fix
 * (the same list as Overview's "Needs you"); what passed is listed under it, so "all good" is something you can see.
 */
export function DoctorView() {
  const { snap, error } = useSetup();
  const [checking, setChecking] = useState(false);
  if (!snap) return error ? <ProblemCard title="Crackio couldn't look at your machines" why={error} /> : <Loading rows={6} />;
  const problems = findProblems(snap);
  const general = problems.filter((p) => !p.machine || !snap.machines.some((m) => m.id === p.machine));

  async function again() {
    setChecking(true);
    await useSetupStore.getState().reload(true);
    setChecking(false);
  }

  return (
    <div className="space-y-10">
      <Verdict
        title={problems.length ? `${problems.length} ${problems.length === 1 ? "thing" : "things"} to fix` : "All good."}
        facts={`Checked ${new Date(snap.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${snap.machines.length} machines · ${problems.length ? "fixes go gentlest first" : "nothing needs you"}`}
        aside={
          <Button variant="outline" onClick={() => void again()} disabled={checking}>
            {checking ? <LoaderCircle size={15} className="animate-spin" /> : null}
            Check again
          </Button>
        }
      />
      {general.length ? (
        <section className="space-y-2">
          {general.map((p) => (
            <ProblemRow key={p.id} p={p} />
          ))}
        </section>
      ) : null}
      {snap.machines.map((m) => (
        <MachineChecks key={m.id} m={m} problems={problems.filter((p) => p.machine === m.id)} snap={snap} />
      ))}
    </div>
  );
}

function ProblemRow({ p }: { p: Problem }) {
  return <ProblemCard tone={p.tone} title={p.title} why={p.why} action={p.fix ? <FixButton fix={p.fix} /> : null} />;
}

function MachineChecks({ m, problems, snap }: { m: SetupMachine; problems: Problem[]; snap: SetupSnapshot }) {
  const passed = checksFor(m, snap);
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <Lamp tone={!m.online ? "off" : problems.some((p) => p.tone === "problem") ? "problem" : problems.length ? "needs" : "ready"} />
        <h2 className="font-display text-[18px] uppercase leading-none text-paper">{m.label}</h2>
        <span className="text-[12.5px] text-haze">{m.kind === "this-computer" ? "This computer" : m.where}</span>
      </div>
      {problems.map((p) => (
        <ProblemRow key={p.id} p={p} />
      ))}
      {!m.online ? (
        <p className="text-[13px] text-haze">Not answering: its checks run when it&rsquo;s back.</p>
      ) : (
        <ul className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {passed.map((c) => (
            <li key={c} className="flex items-start gap-2 text-[13px] text-fog">
              <Check size={14} className="mt-[3px] shrink-0 text-chroma" />
              {c}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What passed on a machine, in plain words. */
function checksFor(m: SetupMachine, snap: SetupSnapshot): string[] {
  const out: string[] = [];
  if (m.metered) {
    out.push("Answers jobs");
    out.push(`${countReady(m)} tools have their models there`);
    return out;
  }
  if (m.comfy.installed && m.online) out.push(`ComfyUI is running${m.comfy.version ? ` (${m.comfy.version})` : ""}`);
  if (m.accel && m.accel !== "cpu") out.push(`The graphics card is in use${m.gpu ? `: ${m.gpu.name}` : ""}`);
  if (m.bridge.version && !m.bridge.outdated) out.push(`Crackio's helper is up to date (${m.bridge.version})`);
  if (m.diskFreeGb != null && m.diskFreeGb >= 2) out.push(`${gbText(m.diskFreeGb)} free for models`);
  const ready = countReady(m);
  if (ready) out.push(`${ready} tools ready to run here`);
  const notHere = Object.values(m.tools).filter((t) => t.state === "unsupported").length;
  if (notHere) out.push(`${notHere} tools don't fit this machine: they run elsewhere or on your Comfy key`);
  if (!snap.jobs.some((j) => j.machine === m.id && j.state === "error")) out.push("No set-up failed here lately");
  return out;
}
