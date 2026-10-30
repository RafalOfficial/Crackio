"use client";

import { useEffect, useState } from "react";
import { Check, Cloud, Laptop, Monitor, Sparkles } from "lucide-react";
import { formatSeconds } from "@/lib/local/fit";
import { askEta, etaBody, setRunOn, useRunOnVersion, type EtaAsk } from "@/lib/hooks/use-run-on";
import { MenuItem } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { DEMO } from "@/lib/demo/config";

/** One machine a local job could run on, as the time line's API lists them (api/local/eta). */
export type RunOnMachine = {
  id: string;
  label: string;
  gpu: string | null;
  online: boolean;
  hasModel: boolean;
  queue: number;
  cloud: boolean;
  here: boolean;
  seconds: number | null;
  measured: boolean;
  /** Why a billed machine can't take jobs now ("Needs a paid Comfy Cloud plan"). */
  note?: string;
};

/**
 * The machines worth listing: all but the main ComfyUI's usual address when nothing runs there (not a machine anyone set
 * up), unless it's the one chosen. A choice between two or more of them is offered.
 */
export const listedMachines = (machines: RunOnMachine[], runOn: string) => machines.filter((m) => m.online || m.id !== "main" || m.id === runOn);

/** A machine as the list names it: "MacBook Air · Apple M2", "This computer · GTX 1060", "RTX 5090 · vast.ai (rented)". */
const nameOf = (m: RunOnMachine) => {
  const name = m.gpu && !m.label.includes(m.gpu) ? `${m.label} · ${m.gpu}` : m.label;
  return (m.cloud || m.id.startsWith("runpod-")) && m.id !== "comfy-cloud" && !DEMO ? `${name} (rented)` : name;
};

/** Its GPU ("GTX 1060"), or its name when another machine has the same card. */
const shortName = (m: RunOnMachine, all: RunOnMachine[]) => (m.gpu && !all.some((o) => o.id !== m.id && o.gpu === m.gpu) ? m.gpu : m.label);

/**
 * The machines a local job can run on, to pick one: Auto (the idle one with the fastest GPU, the default), then each machine
 * with the job's time there, or why it can't take it (offline, without the model, busy). Shared by the time line above
 * Generate and the Advanced section.
 */
export function RunOnMenu({ machines, runOn, onPicked, className }: { machines: RunOnMachine[]; runOn: string; onPicked?: () => void; className?: string }) {
  const shown = listedMachines(machines, runOn);
  const fastest = shown.filter((m) => m.hasModel && m.online && m.seconds !== null).sort((a, b) => a.seconds! - b.seconds!)[0];
  async function pick(id: string) {
    await setRunOn(id);
    onPicked?.();
  }
  return (
    <div role="menu" aria-label="Run on" className={cn("space-y-0.5", className)}>
      <MenuItem selected={runOn === "auto"} onSelect={() => void pick("auto")} hint={runOn === "auto" ? <Check size={14} className="text-spike" /> : undefined}>
        <Sparkles size={14} className="shrink-0 text-haze" />
        <span className="min-w-0">
          <span className="block font-semibold text-paper">Auto</span>
          <span className="block truncate text-[12px] text-haze">{fastest ? `Fastest free machine, now ${shortName(fastest, shown)}` : "Fastest free machine"}</span>
        </span>
      </MenuItem>
      {shown.map((m) => {
        const Icon = m.cloud ? Cloud : m.here ? Monitor : Laptop;
        const note = m.note ?? (!m.online ? "Offline" : !m.hasModel ? "Doesn't have this model: install it on Local" : m.queue ? `${m.queue} job${m.queue === 1 ? "" : "s"} ahead` : null);
        const time = m.online && m.seconds !== null ? `${m.measured ? "" : "~"}${formatSeconds(m.seconds)}` : null;
        return (
          <MenuItem
            key={m.id}
            selected={runOn === m.id}
            disabled={!m.online}
            onSelect={() => void pick(m.id)}
            hint={
              <span className="inline-flex items-center gap-1.5">
                {time ? <span className="tabular">{time}</span> : null}
                {runOn === m.id ? <Check size={14} className="text-spike" /> : null}
              </span>
            }
          >
            <Icon size={14} className="shrink-0 text-haze" />
            <span className="min-w-0">
              <span className="block truncate font-semibold text-paper">{nameOf(m)}</span>
              {note ? <span className="block truncate text-[12px] text-haze">{note}</span> : null}
            </span>
          </MenuItem>
        );
      })}
    </div>
  );
}

/**
 * The machines a local job can run on, for a picker outside the time line (the Advanced section): the time line's own
 * answer for the same job (one request for both), looked at again when the machine to run on changes. Null for models
 * that don't run locally.
 */
export function useRunOnChoices(job: EtaAsk) {
  const version = useRunOnVersion();
  const body = etaBody(job);
  const key = body ? `${version}|${body}` : null;
  const [got, setGot] = useState<{ key: string; machines: RunOnMachine[]; runOn: string } | null>(null);
  // Asked when the settings settle, as the time line does, so both get the one answer.
  useEffect(() => {
    if (!body || !key) return;
    let live = true;
    const t = setTimeout(() => {
      askEta<{ machines?: RunOnMachine[]; runOn?: string }>(body)
        .then((d) => live && setGot({ key, machines: d.machines ?? [], runOn: d.runOn ?? "auto" }))
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body, key]);
  return got && got.key === key ? got : null;
}
