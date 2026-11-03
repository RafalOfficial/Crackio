"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, Cpu, HardDrive, Layers, LoaderCircle, MemoryStick, Puzzle, Workflow } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SetupComfy } from "@/components/local/SetupComfy";
import { ConnectCloud } from "@/components/local/ConnectCloud";
import { AddMachine } from "@/components/local/LocalView";
import { useSetup, useSetupStore, announce } from "@/lib/hooks/use-setup";
import { setRunOn } from "@/lib/hooks/use-run-on";
import { reloadLocal } from "@/lib/hooks/use-local";
import type { SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { cn } from "@/lib/cn";
import { Heading, KitMark, Lamp, Loading, MachineStrip, ProblemCard, Tape, Verdict } from "./parts";
import { KITS } from "@/lib/setup/kits";
import { bytesText, countReady, gbText, machineTone, machineWords, pickMachine } from "./words";
import { useLive } from "@/lib/hooks/use-live";
import { LiveMeters } from "./LiveMeters";
import { CostPanel, CreditLine, StartBox } from "./CloudMoney";

/**
 * Settings → Machines: every computer Crackio runs on, one at a time: what it is, whether it answers, its helper, where
 * jobs go first; and the ways to add one (this computer, one on your network, a rented GPU, pay per job).
 */
export function MachinesView() {
  const params = useSearchParams();
  const adding = params.get("add") === "1";
  const { snap, error } = useSetup();
  if (!snap) return error ? <ProblemCard title="Crackio couldn't look at your machines" why={error} /> : <Loading rows={5} />;
  const m = adding ? null : pickMachine(snap, params.get("machine"));
  const pinned = snap.machines.find((x) => x.runOn);
  const on = snap.machines.filter((x) => x.online && !x.metered).length;
  return (
    <div>
      <Verdict title="Machines" facts={`${on} ${on === 1 ? "computer" : "computers"} on · jobs go ${pinned ? `to ${pinned.label} first` : "to the fastest free one that has the model (Auto)"}`} />
      <CreditLine credit={snap.credit} className="mt-3" />
      <div className="mt-6">
        <MachineStrip snap={snap} selected={m?.id ?? null} />
      </div>
      {adding || !m ? <AddComputer snap={snap} /> : <MachineDetail m={m} snap={snap} />}
    </div>
  );
}

function MachineDetail({ m, snap }: { m: SetupMachine; snap: SetupSnapshot }) {
  const [busy, setBusy] = useState<string | null>(null);
  // Its GPU right now, every few seconds while this page is in view.
  const live = useLive(m.online && !m.metered ? [m.id] : []);
  const [error, setError] = useState<string | null>(null);
  const ready = countReady(m);
  const toSet = Object.values(m.tools).filter((t) => t.state === "missing" || t.state === "no-comfy").length;

  async function act(name: string, fn: () => Promise<string | null>) {
    setBusy(name);
    setError(null);
    const err = await fn().catch((e: Error) => e.message);
    setError(err);
    await useSetupStore.getState().reload(true);
    setBusy(null);
  }

  const pinFirst = () =>
    act("first", async () => {
      await setRunOn(m.runOn ? "auto" : m.id);
      return null;
    });
  const updateHelper = () =>
    act("bridge", async () => {
      const res = await fetch("/api/setup/bridge", { method: "POST" }).catch(() => null);
      if (!res) return "Crackio didn't answer.";
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) announce();
      return res.ok ? null : (body.error ?? "That didn't work.");
    });
  const reconnect = () =>
    act("reconnect", async () => {
      if (!m.cloud?.instance || m.cloud.provider === "other") return "Crackio doesn't know this box's cloud: paste its SSH command under Add a computer.";
      const res = await fetch("/api/local/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "connect-box", provider: m.cloud.provider, id: m.cloud.instance }) }).catch(() => null);
      const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      return res?.ok ? null : (body?.error ?? "That didn't work.");
    });
  const forget = () =>
    act("forget", async () => {
      const res = await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove-machine", target: m.id }) }).catch(() => null);
      const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      if (res?.ok) {
        void reloadLocal();
        announce();
      }
      return res?.ok ? null : (body?.error ?? "That didn't work.");
    });

  const tiles: { icon: typeof Cpu; label: string; value: string; note?: string; meter?: number; warn?: boolean }[] = [];
  if (m.gpu || m.online)
    tiles.push({ icon: Cpu, label: "Graphics card", value: m.gpu ? m.gpu.name.replace(/^NVIDIA (GeForce )?/i, "") : "None found", note: m.gpu?.memoryGb ? `${gbText(m.gpu.memoryGb)} ${m.gpu.unified ? "shared with the computer" : "graphics memory"}` : m.online ? "Runs on the processor" : undefined });
  if (m.ramGb) tiles.push({ icon: MemoryStick, label: "Memory", value: `${gbText(m.ramGb)} RAM` });
  if (m.diskFreeGb != null)
    tiles.push({ icon: HardDrive, label: "Free for models", value: gbText(m.diskFreeGb), note: m.diskFreeGb < 10 ? "Running low: see Storage" : "Where downloads go", warn: m.diskFreeGb < 10 });
  if (m.online || m.modelBytes) tiles.push({ icon: Layers, label: "Models here", value: m.modelBytes ? bytesText(m.modelBytes) : "None yet", note: `${ready} tools ready` });
  tiles.push({ icon: Workflow, label: "ComfyUI", value: m.comfy.version ? `Version ${m.comfy.version}` : m.comfy.installed ? (m.online ? "Running" : "Not running") : "Not installed", note: m.os ?? undefined });
  if (!m.metered)
    tiles.push({
      icon: Puzzle,
      label: "Crackio's helper",
      value: m.bridge.version ?? (m.online ? "Not installed" : "Unknown"),
      note: m.bridge.version ? (m.bridge.outdated ? `${m.bridge.latest} is out` : "Up to date") : undefined,
      warn: m.bridge.outdated && Boolean(m.bridge.version),
    });


  return (
    <div className="mt-8 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] text-fog">
            <Lamp tone={machineTone(m)} />
            {m.metered ? "Pay per job" : machineWords(m)}
            <span className="text-haze">· {m.kind === "this-computer" ? "This computer" : m.where}</span>
          </p>
          <h2 className="mt-2 font-display text-[30px] uppercase leading-none text-paper">{m.label}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {m.online && !m.metered ? (
            <button
              type="button"
              onClick={() => void pinFirst()}
              disabled={busy === "first"}
              className={cn(
                "press squircle relative inline-flex h-10 items-center gap-2 rounded-btn px-4 text-[13px] font-semibold",
                m.runOn ? "bg-white/[0.08] text-paper" : "text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04] hover:text-paper",
              )}
              title="The one place jobs go first when it's free and has the model; Preferences shows the same choice"
            >
              {m.runOn ? "Jobs go here first" : "Send jobs here first"}
              {m.runOn ? <Tape className="inset-x-4 -bottom-[2px]" /> : null}
            </button>
          ) : null}
          {m.online && m.comfy.installed && !m.metered ? (
            <ButtonLink href={`/comfy?machine=${encodeURIComponent(m.id)}`} variant="outline">
              Open its ComfyUI <ArrowUpRight size={14} />
            </ButtonLink>
          ) : null}
        </div>
      </div>

      {error ? <ProblemCard title="That didn't work" why={error} /> : null}
      {!m.online && !m.metered ? (
        <ProblemCard
          tone="needs"
          title={`${m.label} isn't answering`}
          why={m.kind === "rented" ? "Stopped or given back at your cloud? Start it there and Crackio connects again by itself, or forget it here." : m.kind === "lan" ? "Start its ComfyUI (with --listen) and Crackio finds it again." : "Start ComfyUI and Crackio finds it again."}
          action={
            <>
              {m.kind === "rented" ? <StartBox m={m} /> : null}
              {m.kind === "rented" ? (
                <Button variant="outline" size="sm" onClick={() => void reconnect()} disabled={Boolean(busy)}>
                  {busy === "reconnect" ? <LoaderCircle size={14} className="animate-spin" /> : null}
                  Connect again
                </Button>
              ) : null}
              {m.kind !== "this-computer" ? (
                <Button variant="ghost" size="sm" onClick={() => void forget()} disabled={Boolean(busy)}>
                  Forget it
                </Button>
              ) : null}
            </>
          }
        />
      ) : null}
      {m.online && m.bridge.outdated && m.bridge.update !== "never" ? (
        <ProblemCard
          tone="needs"
          title={`Crackio's helper here is ${m.bridge.version ?? "missing"}; ${m.bridge.latest} is out`}
          why={
            m.bridge.update === "this-computer"
              ? "Updating restarts this computer's ComfyUI once its queue is empty."
              : m.bridge.update === "reconnect"
                ? "Connecting it again copies the new helper over and restarts its ComfyUI."
                : "Copy comfyui/crackio_bridge from Crackio into its ComfyUI's custom_nodes folder, then restart it."
          }
          action={
            m.bridge.update === "this-computer" ? (
              <Button variant="outline" size="sm" onClick={() => void updateHelper()} disabled={Boolean(busy)}>
                {busy === "bridge" ? <LoaderCircle size={14} className="animate-spin" /> : null}
                Update · about 20 s
              </Button>
            ) : m.bridge.update === "reconnect" ? (
              <Button variant="outline" size="sm" onClick={() => void reconnect()} disabled={Boolean(busy)}>
                Connect again
              </Button>
            ) : null
          }
        />
      ) : null}

      <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((t) => (
          <li key={t.label} className="squircle flex items-start gap-3.5 rounded-[18px] bg-white/[0.035] px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.06] text-fog">
              <t.icon size={18} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-haze">{t.label}</span>
              <span className="mt-0.5 block truncate text-[15px] font-semibold text-paper" title={t.value}>
                {t.value}
              </span>
              {t.note ? <span className={cn("mt-0.5 block truncate text-[12px]", t.warn ? "text-tungsten" : "text-haze")}>{t.note}</span> : null}
              {t.meter != null ? (
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <span className={cn("block h-full rounded-full", t.warn ? "bg-tungsten" : "bg-[#3987e5]")} style={{ width: `${Math.max(3, Math.min(100, t.meter * 100))}%` }} />
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {m.online && !m.metered ? <LiveMeters live={live[m.id]} /> : null}
      <CostPanel m={m} snap={snap} live={live[m.id]} />

      {m.online && m.comfy.installed && !m.metered ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {KITS.map((k) => (
            <KitMark key={k.id} kit={k} lit={m.tools[k.id]?.state === "ready"} size={28} title={`${k.name}: ${m.tools[k.id]?.state === "ready" ? "ready here" : "not set up here"}`} />
          ))}
          <span className="ml-2 text-[12.5px] text-haze">{ready} of {KITS.length} tools ready here</span>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3">
        <SummaryLink href={`/settings/tools?machine=${encodeURIComponent(m.id)}`} title={`${ready} tools ready`} note={toSet ? `${toSet} more can be set up` : "Every tool that fits is here"} />
        <SummaryLink href={`/settings/storage?machine=${encodeURIComponent(m.id)}`} title={m.modelBytes ? `${bytesText(m.modelBytes)} of models` : "No models yet"} note={m.diskFreeGb != null ? `${gbText(m.diskFreeGb)} free` : "Space unknown"} />
        <SummaryLink href="/settings/usage" title="Times here" note="What each model takes on this machine" />
      </div>

      {m.kind === "this-computer" ? (
        <section className="space-y-3">
          <Heading title="ComfyUI on this computer" note="Crackio installed it for this graphics card. Start, stop, share it on your network, or repair it." />
          <SetupComfy onChange={() => void useSetupStore.getState().reload(true)} />
        </section>
      ) : null}
      {m.kind !== "this-computer" && !m.metered ? (
        <p className="text-[12.5px] text-haze">
          Not using it any more?{" "}
          <button type="button" onClick={() => void forget()} className="font-semibold text-fog underline-offset-2 hover:text-paper hover:underline">
            Forget {m.label}
          </button>
          {m.kind === "rented" ? " (stopping it above only pauses it: give it back at your cloud to stop paying for its disk)." : "."}
        </p>
      ) : null}
    </div>
  );
}

function SummaryLink({ href, title, note }: { href: string; title: string; note: string }) {
  return (
    <Link href={href} className="squircle group flex items-center justify-between gap-3 rounded-[16px] bg-white/[0.03] px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.05]">
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-paper">{title}</span>
        <span className="block truncate text-[12.5px] text-haze">{note}</span>
      </span>
      <ArrowUpRight size={15} className="shrink-0 text-haze group-hover:text-paper" />
    </Link>
  );
}

/** The ways in: this computer, one on your network, a rented GPU, pay per job. */
function AddComputer({ snap }: { snap: SetupSnapshot }) {
  const here = snap.machines.find((m) => m.kind === "this-computer");
  const refresh = () => {
    void reloadLocal();
    announce();
  };
  return (
    <div className="mt-8 space-y-8">
      <section className="space-y-3">
        <Heading title="This computer" note={here?.comfy.installed ? `It runs ComfyUI already${here.gpu ? `, on its ${here.gpu.name}` : ""}.` : "Crackio installs ComfyUI for its graphics card: Python, PyTorch for the card, ComfyUI and Crackio's helper."} />
        <SetupComfy onChange={refresh} />
      </section>
      <section className="space-y-3">
        <Heading title="A rented GPU" note="Paste the SSH command or link your cloud gives you, or let your vast.ai or RunPod key bring every box you rent. About a minute and a half." />
        <ConnectCloud onConnected={refresh} />
      </section>
      <section className="space-y-3">
        <Heading title="A computer on your network" note="A Mac or PC on the same network running ComfyUI started with --listen. Crackio sets tools up on it too." />
        <AddMachine onAdded={refresh} />
      </section>
      <section className="space-y-3">
        <Heading title="Pay per job" note="RunPod Serverless endpoints start a GPU for each job and bill it; Comfy Cloud runs hosted models on your Comfy key." />
        <ButtonLink href="/settings/accounts#serverless" variant="outline" size="sm">
          Set them up in Accounts
        </ButtonLink>
      </section>
    </div>
  );
}
