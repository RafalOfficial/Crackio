"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Download, LoaderCircle, Plug, RefreshCw, TriangleAlert, Wrench } from "lucide-react";
import { PILL_ACT as ACT, PillAct as Act, SetupPill as Pill, readLater as readLaterOf, writeLater } from "@/components/ui/SetupPill";
import { useVoiceStore } from "@/lib/hooks/use-voice";
import { AUDIOCPP_BYTES, buildName, firstVoiceModel, HEARING, voiceModel, type VoiceModel } from "@/lib/voice/models";
import type { VoiceMachine, VoiceSetupJob } from "@/lib/voice/types";
import { VoiceModelMark } from "./VoiceModelLibrary";

/** The bridge that checks audio.cpp builds and proves Voice with a test line (server/voice/machines SETUP_BRIDGE). */
const SETUP_BRIDGE = "1.8.5";
const atLeast = (a: string | null, b: string) => Boolean(a) && a!.localeCompare(b, undefined, { numeric: true }) >= 0;
const sizeOf = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const where = (m: VoiceMachine) => (m.id === "this-computer" ? `this computer${m.gpu ? ` (${m.gpu})` : ""}` : (m.gpu ?? m.label));
const HEARING_BYTES = HEARING.reduce((s, f) => s + f.bytes, 0);

type Issue =
  | { kind: "running"; machine: VoiceMachine; job: VoiceSetupJob }
  | { kind: "finished"; machine: VoiceMachine; job: VoiceSetupJob }
  /** Models there, audio.cpp not: the missing libraries. */
  | { kind: "engine"; machine: VoiceMachine }
  /** Setting up there needs a newer Crackio bridge first. */
  | { kind: "bridge"; machine: VoiceMachine }
  | { kind: "hearing"; machine: VoiceMachine }
  /** No voice model anywhere yet: the first one, picked for their GPU. */
  | { kind: "new"; machine: VoiceMachine; model: VoiceModel; bytes: number; hearing: boolean }
  /** No ComfyUI answering at all. */
  | { kind: "nothing" };

const keyOf = (i: Issue) => (i.kind === "nothing" ? "nothing" : i.kind === "running" || i.kind === "finished" ? `${i.kind}:${i.machine.id}:${i.job.startedAt}` : `${i.kind}:${i.machine.id}`);

/** What Voice needs most right now, across the machines: a setup going on or just ended, then what's missing. */
function issueOf(machines: VoiceMachine[], later: Set<string>): Issue | null {
  const online = machines.filter((m) => m.online);
  const all: Issue[] = [];
  for (const m of machines) if (m.setup) all.push(m.setup.state === "running" ? { kind: "running", machine: m, job: m.setup } : { kind: "finished", machine: m, job: m.setup });
  for (const m of online) {
    if (m.setup?.state === "running" || m.installing) continue;
    const needsEngine = m.models.length > 0 && !m.engine;
    if (needsEngine) all.push({ kind: atLeast(m.bridge, SETUP_BRIDGE) ? "engine" : "bridge", machine: m });
    // Speech to text only where it leaves room to spare.
    else if (m.models.length > 0 && m.engine && !m.hearing && atLeast(m.bridge, SETUP_BRIDGE) && (m.diskGb == null || m.diskGb >= HEARING_BYTES / 1e9 + 2.5)) all.push({ kind: "hearing", machine: m });
  }
  // A GPU that's only switched off still has its models: nothing to set up.
  if (!online.some((m) => m.models.length > 0) && !machines.some((m) => m.setup) && !machines.some((m) => !m.online && m.away?.models.length)) {
    const first = firstVoiceModel(online);
    if (first && atLeast(first.machine.bridge, SETUP_BRIDGE)) {
      const engine = first.machine.engine ? 0 : (AUDIOCPP_BYTES[first.machine.builds[0] ?? ""] ?? 0);
      const file = first.fit.variant.file.bytes;
      // Speech to text comes along where it leaves room to spare (as the setup itself decides).
      const disk = first.machine.diskGb;
      const hearing = disk == null || disk >= (file + HEARING_BYTES + engine * 2.4) / 1e9 + 2.5;
      all.push({ kind: "new", machine: first.machine, model: first.model, bytes: file + engine + (hearing ? HEARING_BYTES : 0), hearing });
    } else if (first) all.push({ kind: "bridge", machine: first.machine });
    else if (!online.length) all.push({ kind: "nothing" });
  }
  return all.find((i) => !later.has(keyOf(i))) ?? null;
}

const readLater = () => readLaterOf("crackio.voice.later");

/**
 * Voice's setup as a small pill floating at the top of the page, over it (nothing moves): missing libraries where models
 * are ("Install audio.cpp?"), the first model for someone new, picked for their GPU, a bridge too old to set up, the
 * setup itself as it goes (audio.cpp → model and speech to text → a test line spoken and heard back) and how it went.
 * One or two lines; a success fades away by itself; each prompt can wait until later in this tab.
 */
export function VoiceSetupBar({ onModels }: { onModels: () => void }) {
  const machines = useVoiceStore((s) => s.machines);
  const loaded = useVoiceStore((s) => s.machinesLoaded);
  const [later, setLater] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readLater()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const issue = loaded ? issueOf(machines, later) : null;
  const key = issue ? keyOf(issue) : null;

  // A bridge update restarts ComfyUI: look again every few seconds until it's back with the new bridge.
  useEffect(() => {
    if (!updating) return;
    const end = Date.now() + 150_000;
    const t = window.setInterval(() => {
      const m = useVoiceStore.getState().machines.find((x) => x.id === updating);
      if ((m?.online && atLeast(m.bridge, SETUP_BRIDGE)) || Date.now() > end) {
        window.clearInterval(t);
        setUpdating(null);
        return;
      }
      void useVoiceStore.getState().loadMachines(true);
    }, 3000);
    return () => window.clearInterval(t);
  }, [updating]);

  // Out of the way: it fades, then it's gone for this tab.
  const hide = useCallback((k: string) => {
    setLeaving(k);
    window.setTimeout(() => {
      setLater((prev) => {
        const next = new Set(prev).add(k);
        writeLater("crackio.voice.later", next);
        return next;
      });
      setLeaving(null);
      setError(null);
    }, 220);
  }, []);

  // A setup that worked says so for a moment, then goes.
  const okKey = issue?.kind === "finished" && issue.job.state === "done" && !issue.job.note ? key : null;
  useEffect(() => {
    if (!okKey) return;
    const t = window.setTimeout(() => hide(okKey), 9000);
    return () => window.clearTimeout(t);
  }, [okKey, hide]);

  if (!issue || !key) return null;
  const act = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; updating?: boolean };
      if (!res.ok) throw new Error(data.error ?? "That didn't start.");
      if (data.updating && "machine" in body) setUpdating(String(body.machine));
      await useVoiceStore.getState().loadMachines(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => hide(key);
  const out = leaving === key;

  if (issue.kind === "running") {
    const job = issue.job;
    const share = job.progress?.total ? job.progress.received / job.progress.total : null;
    const steps = ["engine", ...(job.fetches.length ? ["files"] : []), "check"];
    const at = Math.max(0, steps.indexOf(job.step), job.step === "files" && !job.fetches.length ? 1 : 0);
    return (
      <Pill k={key} out={out} tone="hello" icon={<LoaderCircle size={14} className="animate-spin" />} onClose={close} closeLabel="Hide" progress={share} title={`${job.detail}${job.progress?.total ? ` · ${sizeOf(job.progress.received)} of ${sizeOf(job.progress.total)}` : ""}`}>
        <span className="font-semibold text-paper">Setting up Voice on {where(issue.machine)}</span>
        <span className="tabular text-haze">
          {" "}
          · {share !== null ? `${Math.round(share * 100)}%` : `${at + 1}/${steps.length}`}
        </span>
        <span className="text-fog"> · {job.detail.replace(/ · [\d.]+ [GM]B$/, "")}</span>
      </Pill>
    );
  }

  if (issue.kind === "finished") {
    const job = issue.job;
    if (job.state === "error")
      return (
        <Pill
          k={key}
          out={out}
          tone="error"
          icon={<TriangleAlert size={13} />}
          onClose={close}
          title={[job.error, ...job.tried.map((t) => `${buildName(t.build)}: ${t.error}`)].filter(Boolean).join("\n")}
          second={error ?? job.error}
          action={
            <Act busy={busy} onClick={() => void act({ machine: issue.machine.id, model: issue.job.model ?? undefined })}>
              <RefreshCw size={12} /> Try again
            </Act>
          }
        >
          <span className="font-semibold text-paper">Couldn&rsquo;t set up Voice on {where(issue.machine)}</span>
        </Pill>
      );
    const r = job.result;
    const onCpu = r?.build && /cpu/.test(r.build) && issue.machine.gpu;
    const heard = r?.heard ? `Heard back: “${r.heard}”` : "";
    return (
      <Pill
        k={key}
        out={out}
        tone="done"
        icon={<Check size={13} strokeWidth={3} />}
        onClose={close}
        title={[`audio.cpp ${buildName(r?.build)}`, heard, ...job.tried.map((t) => `${buildName(t.build)} didn't run: ${t.error}`)].filter(Boolean).join("\n")}
        second={job.note ? `${job.note}.` : onCpu ? "It runs on the CPU, slower: the GPU builds didn't work there." : null}
      >
        <span className="font-semibold text-paper">Voice works on {where(issue.machine)}</span>
        {r?.seconds != null ? (
          <span className="text-fog">
            {" "}
            · {r.model ?? "the model"} spoke a test line in {r.seconds} s
          </span>
        ) : null}
      </Pill>
    );
  }

  if (issue.kind === "nothing")
    return (
      <Pill
        k={key}
        out={out}
        tone="quiet"
        icon={<Plug size={13} />}
        onClose={close}
        action={
          <Link href="/settings/machines?add=1" className={ACT}>
            Connect a GPU <ArrowUpRight size={12} />
          </Link>
        }
      >
        <span className="font-semibold text-paper">Voice needs ComfyUI</span>
        <span className="text-fog"> · none is answering</span>
      </Pill>
    );

  const m = issue.machine;
  if (issue.kind === "bridge") {
    const here = m.id === "this-computer";
    return (
      <Pill
        k={key}
        out={out}
        tone="warn"
        icon={<RefreshCw size={13} />}
        onClose={close}
        second={error}
        title={`Setting up Voice there needs Crackio bridge ${SETUP_BRIDGE}; it has ${m.bridge ?? "none"}. ${here ? "Updating restarts its ComfyUI for a few seconds." : "Connecting it again in Settings → Machines brings it."}`}
        action={
          here ? (
            <Act busy={busy || Boolean(updating)} onClick={() => void act({ machine: m.id, update: true })}>
              {updating ? "Restarting…" : "Update"}
            </Act>
          ) : (
            <Link href="/settings/machines" className={ACT}>
              Open Machines <ArrowUpRight size={12} />
            </Link>
          )
        }
      >
        <span className="font-semibold text-paper">Update Crackio&rsquo;s bridge</span>
        <span className="text-fog"> on {where(m)} to set up Voice</span>
      </Pill>
    );
  }

  if (issue.kind === "engine") {
    const build = m.builds[0];
    const size = build && AUDIOCPP_BYTES[build] ? ` (${sizeOf(AUDIOCPP_BYTES[build])})` : "";
    const names = m.models.map((id) => voiceModel(id)?.name).filter(Boolean);
    return (
      <Pill
        k={key}
        out={out}
        tone="warn"
        icon={<Wrench size={13} />}
        onClose={close}
        second={error}
        title={`${names.join(" and ")} ${names.length > 1 ? "are" : "is"} there, but audio.cpp, the engine ${names.length > 1 ? "they run" : "it runs"} on, isn't. Crackio gets the build for ${buildName(build) || "this system"}, checks it runs, then has a model speak a test line.`}
        action={
          <Act busy={busy} onClick={() => void act({ machine: m.id })}>
            {busy ? null : <Download size={12} strokeWidth={2.6} />} Install
          </Act>
        }
      >
        <span className="font-semibold text-paper">Missing libraries on {where(m)}</span>
        <span className="text-fog">
          {" "}
          · install audio.cpp{size}?
        </span>
      </Pill>
    );
  }

  if (issue.kind === "hearing")
    return (
      <Pill
        k={key}
        out={out}
        tone="quiet"
        icon={<Download size={13} />}
        onClose={close}
        second={error}
        title="Speech to text types out what a clone says and times every word of a take."
        action={
          <Act busy={busy} onClick={() => void act({ machine: m.id })}>
            Install
          </Act>
        }
      >
        <span className="font-semibold text-paper">Speech to text is missing</span>
        <span className="text-fog">
          {" "}
          on {where(m)} · {sizeOf(HEARING_BYTES)}
        </span>
      </Pill>
    );

  // Someone new: no voice model on any of their machines yet.
  const { model } = issue;
  return (
    <Pill
      k={key}
      out={out}
      tone="hello"
      icon={<VoiceModelMark model={model} size={26} />}
      onClose={close}
      second={error}
      title={`${model.blurb} Crackio gets audio.cpp for ${buildName(m.builds[0]) || "it"}, the model${issue.hearing ? " and speech to text" : ""}, then checks it speaks.`}
      action={
        <>
          <Act busy={busy} onClick={() => void act({ machine: m.id, model: model.id })}>
            Set up · {sizeOf(issue.bytes)}
          </Act>
          <button type="button" onClick={onModels} className="press hidden h-7 shrink-0 rounded-full px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.07] hover:text-paper sm:inline-flex sm:items-center">
            Other models
          </button>
        </>
      }
    >
      <span className="font-semibold text-paper">Set up Voice</span>
      <span className="text-fog">
        {" "}
        · {model.name} for {where(m)}
      </span>
    </Pill>
  );
}
