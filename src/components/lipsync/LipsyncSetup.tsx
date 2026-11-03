"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, AudioLines, Check, Cpu, Download, LoaderCircle, Plug, RefreshCw, TriangleAlert } from "lucide-react";
import { PILL_ACT, PillAct, SetupPill, readLater, writeLater } from "@/components/ui/SetupPill";
import { lipsyncHome, useLipsyncStore } from "@/lib/hooks/use-lipsync";
import { useVoiceStore } from "@/lib/hooks/use-voice";
import { LIPSYNC_FILES, LIPSYNC_VRAM_GB, type LipsyncMachine, type LipsyncSetupJob } from "@/lib/lipsync/machines";
import { VOICE_MODELS } from "@/lib/voice/models";

/** The bridge with Lip Sync in it (server/lipsync/machines LIPSYNC_BRIDGE). */
const LIPSYNC_BRIDGE = "1.9.0";
const HUE = "var(--color-tool-lipsync)";
const LATER = "crackio.lipsync.later";
const ENGINE_BYTES = 1.2e9;
const atLeast = (a: string | null, b: string) => Boolean(a) && a!.localeCompare(b, undefined, { numeric: true }) >= 0;
const sizeOf = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const where = (m: Pick<LipsyncMachine, "id" | "gpu" | "label">) => (m.id === "this-computer" ? `this computer${m.gpu ? ` (${m.gpu})` : ""}` : (m.gpu ?? m.label));
/** The speech models that can say new words in someone's own voice. */
const SPEAKERS = VOICE_MODELS.filter((m) => m.can.clone).map((m) => m.id);
/** Lip Sync is offered on NVIDIA cards with room for LatentSync; Macs aren't tried yet (heat, and a full disk). */
const fits = (m: LipsyncMachine) => !m.unified && (m.gpuGb ?? 0) >= LIPSYNC_VRAM_GB;

type Issue =
  | { kind: "running"; machine: LipsyncMachine; job: LipsyncSetupJob }
  | { kind: "finished"; machine: LipsyncMachine; job: LipsyncSetupJob }
  | { kind: "installing"; machine: LipsyncMachine }
  | { kind: "new"; machine: LipsyncMachine; bytes: number }
  | { kind: "bridge"; machine: LipsyncMachine }
  | { kind: "small" }
  | { kind: "nothing" }
  | { kind: "speech" }
  | { kind: "hearing" };

const keyOf = (i: Issue) => ("machine" in i ? `${i.kind}:${i.machine.id}${"job" in i ? `:${i.job.startedAt}` : ""}` : i.kind);

/** What Lip Sync needs most right now: a setup going on or just ended, then a GPU set up for it, then Voice's parts. */
function issueOf(machines: LipsyncMachine[], voice: { machines: { online: boolean; engine: unknown; models: string[]; hearing: boolean }[]; loaded: boolean }, later: Set<string>): Issue | null {
  const all: Issue[] = [];
  for (const m of machines) if (m.setup) all.push(m.setup.state === "running" ? { kind: "running", machine: m, job: m.setup } : { kind: "finished", machine: m, job: m.setup });
  const online = machines.filter((m) => m.online);
  const home = lipsyncHome(machines);
  if (!home && !machines.some((m) => m.setup?.state === "running")) {
    const installing = online.find((m) => m.installing);
    const ready = online.filter((m) => m.ready && fits(m)).sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
    const old = online.filter((m) => !atLeast(m.bridge, LIPSYNC_BRIDGE) && fits(m)).sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
    if (installing) all.push({ kind: "installing", machine: installing });
    else if (ready) {
      const files = LIPSYNC_FILES.filter((f) => !ready.models[f.key]).reduce((s, f) => s + f.bytes, 0);
      all.push({ kind: "new", machine: ready, bytes: files + (ready.engine ? 0 : ENGINE_BYTES) });
    } else if (old) all.push({ kind: "bridge", machine: old });
    else if (online.length) all.push({ kind: "small" });
    else all.push({ kind: "nothing" });
  }
  if (voice.loaded) {
    const on = voice.machines.filter((m) => m.online && m.engine);
    if (!on.some((m) => m.models.some((id) => (SPEAKERS as string[]).includes(id)))) all.push({ kind: "speech" });
    else if (!voice.machines.some((m) => m.online && m.hearing)) all.push({ kind: "hearing" });
  }
  return all.find((i) => !later.has(keyOf(i))) ?? null;
}

/**
 * Lip Sync's setup as Voice's is: one small pill floating at the top of the page, over it. The setup as it goes (the
 * engine → LatentSync's files → a check with the model loaded) and how it went; else what's missing, most needed first:
 * a GPU set up for it, a newer bridge, a GPU big enough, ComfyUI at all, then the speech model and speech to text it
 * borrows from Voice. Each prompt can wait until later in this tab; a success fades by itself.
 */
export function LipsyncSetupBar() {
  const machines = useLipsyncStore((s) => s.machines);
  const loaded = useLipsyncStore((s) => s.loaded);
  const voiceMachines = useVoiceStore((s) => s.machines);
  const voiceLoaded = useVoiceStore((s) => s.machinesLoaded);
  const [later, setLater] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readLater(LATER)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const issue = loaded ? issueOf(machines, { machines: voiceMachines, loaded: voiceLoaded }, later) : null;
  const key = issue ? keyOf(issue) : null;

  // A bridge update restarts ComfyUI: look again every few seconds until it's back with Lip Sync.
  useEffect(() => {
    if (!updating) return;
    const end = Date.now() + 150_000;
    const t = window.setInterval(() => {
      const m = useLipsyncStore.getState().machines.find((x) => x.id === updating);
      if ((m?.online && m.ready) || Date.now() > end) {
        window.clearInterval(t);
        setUpdating(null);
        return;
      }
      void useLipsyncStore.getState().load(true);
    }, 3000);
    return () => window.clearInterval(t);
  }, [updating]);

  const hide = useCallback((k: string) => {
    setLeaving(k);
    window.setTimeout(() => {
      setLater((prev) => {
        const next = new Set(prev).add(k);
        writeLater(LATER, next);
        return next;
      });
      setLeaving(null);
      setError(null);
    }, 220);
  }, []);

  const okKey = issue?.kind === "finished" && issue.job.state === "done" ? key : null;
  useEffect(() => {
    if (!okKey) return;
    const t = window.setTimeout(() => hide(okKey), 9000);
    return () => window.clearTimeout(t);
  }, [okKey, hide]);

  if (!issue || !key) return null;
  const close = () => hide(key);
  const out = leaving === key;
  const pill = { k: key, out, onClose: close, hue: HUE, ink: "#2b1208" };

  const setUp = async (machine: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lipsync/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machine }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That didn't start.");
      await useLipsyncStore.getState().load(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = async (machine: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machine, update: true }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "The update didn't start.");
      setUpdating(machine);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (issue.kind === "running") {
    const job = issue.job;
    const share = job.progress?.total ? job.progress.received / job.progress.total : null;
    const step = ["engine", "files", "check"].indexOf(job.step) + 1;
    return (
      <SetupPill {...pill} tone="hello" icon={<LoaderCircle size={14} className="animate-spin" />} closeLabel="Hide" progress={share} title={`${job.detail}${job.progress?.total ? ` · ${sizeOf(job.progress.received)} of ${sizeOf(job.progress.total)}` : ""}`}>
        <span className="font-semibold text-paper">Setting up Lip Sync on {where(issue.machine)}</span>
        <span className="tabular text-haze"> · {share !== null ? `${Math.round(share * 100)}%` : `${step}/3`}</span>
        <span className="text-fog"> · {job.detail.replace(/ · [\d.]+ [GM]B$/, "")}</span>
      </SetupPill>
    );
  }

  if (issue.kind === "finished") {
    const job = issue.job;
    if (job.state === "error") {
      const token = /token/i.test(job.error ?? "") && /Connections/.test(job.error ?? "");
      const terms = /terms/i.test(job.error ?? "") && !token;
      return (
        <SetupPill
          {...pill}
          tone="error"
          icon={<TriangleAlert size={13} />}
          title={job.error ?? undefined}
          second={error ?? job.error}
          action={
            token ? (
              <Link href="/settings/accounts#hf" className={PILL_ACT}>
                Add the token <ArrowUpRight size={12} />
              </Link>
            ) : terms ? (
              <>
                <a href="https://huggingface.co/ByteDance/LatentSync-1.6" target="_blank" rel="noreferrer" className="press hidden h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.07] hover:text-paper sm:inline-flex">
                  The terms <ArrowUpRight size={12} />
                </a>
                <PillAct busy={busy} onClick={() => void setUp(issue.machine.id)}>
                  <RefreshCw size={12} /> Try again
                </PillAct>
              </>
            ) : (
              <PillAct busy={busy} onClick={() => void setUp(issue.machine.id)}>
                <RefreshCw size={12} /> Try again
              </PillAct>
            )
          }
        >
          <span className="font-semibold text-paper">Couldn&rsquo;t set up Lip Sync on {where(issue.machine)}</span>
        </SetupPill>
      );
    }
    const e = issue.machine.engine;
    return (
      <SetupPill {...pill} tone="done" icon={<Check size={13} strokeWidth={3} />} title={e ? `LatentSync 1.6 on ${e.device ?? "the GPU"}${e.dtype ? ` (${e.dtype})` : ""}` : undefined}>
        <span className="font-semibold text-paper">Lip Sync works on {where(issue.machine)}</span>
        <span className="text-fog"> · LatentSync loaded and checked</span>
      </SetupPill>
    );
  }

  if (issue.kind === "installing")
    return (
      <SetupPill {...pill} tone="hello" icon={<LoaderCircle size={14} className="animate-spin" />} closeLabel="Hide" progress={null}>
        <span className="font-semibold text-paper">Installing the lip-sync engine</span>
        <span className="text-fog"> on {where(issue.machine)}</span>
      </SetupPill>
    );

  if (issue.kind === "new") {
    const m = issue.machine;
    return (
      <SetupPill
        {...pill}
        tone="hello"
        icon={<Download size={13} strokeWidth={2.4} />}
        second={error}
        title="LatentSync 1.6 (ByteDance, open weights) redraws only the mouth, to the new words. Crackio installs its engine, gets its files with your Hugging Face token (accept ByteDance/LatentSync-1.6's terms first), then checks it runs."
        action={
          <PillAct busy={busy} onClick={() => void setUp(m.id)}>
            Set up · {sizeOf(issue.bytes)}
          </PillAct>
        }
      >
        <span className="font-semibold text-paper">Set up Lip Sync</span>
        <span className="text-fog"> · LatentSync 1.6 for {where(m)}</span>
      </SetupPill>
    );
  }

  if (issue.kind === "bridge") {
    const m = issue.machine;
    const here = m.id === "this-computer";
    return (
      <SetupPill
        {...pill}
        tone="warn"
        icon={<RefreshCw size={13} />}
        second={error}
        title={`Lip Sync needs Crackio bridge ${LIPSYNC_BRIDGE}; it has ${m.bridge ?? "none"}. ${here ? "Updating restarts its ComfyUI for a few seconds." : "Connecting it again in Settings → Machines brings it."}`}
        action={
          here ? (
            <PillAct busy={busy || Boolean(updating)} onClick={() => void update(m.id)}>
              {updating ? "Restarting…" : "Update"}
            </PillAct>
          ) : (
            <Link href="/settings/machines" className={PILL_ACT}>
              Open Machines <ArrowUpRight size={12} />
            </Link>
          )
        }
      >
        <span className="font-semibold text-paper">Update Crackio&rsquo;s bridge</span>
        <span className="text-fog"> on {where(m)} for Lip Sync</span>
      </SetupPill>
    );
  }

  if (issue.kind === "small")
    return (
      <SetupPill
        {...pill}
        tone="quiet"
        icon={<Cpu size={13} />}
        title={`LatentSync needs about ${LIPSYNC_VRAM_GB} GB of GPU memory. A rented GPU connects from Settings → Machines in a minute.`}
        action={
          <Link href="/settings/machines?add=1" className={PILL_ACT}>
            Rent one <ArrowUpRight size={12} />
          </Link>
        }
      >
        <span className="font-semibold text-paper">Lip Sync needs a GPU with {LIPSYNC_VRAM_GB} GB</span>
        <span className="text-fog"> or more</span>
      </SetupPill>
    );

  if (issue.kind === "nothing")
    return (
      <SetupPill
        {...pill}
        tone="quiet"
        icon={<Plug size={13} />}
        action={
          <Link href="/settings/machines?add=1" className={PILL_ACT}>
            Connect a GPU <ArrowUpRight size={12} />
          </Link>
        }
      >
        <span className="font-semibold text-paper">Lip Sync needs ComfyUI</span>
        <span className="text-fog"> · none is answering</span>
      </SetupPill>
    );

  return (
    <SetupPill
      {...pill}
      tone="quiet"
      icon={<AudioLines size={13} />}
      title={issue.kind === "speech" ? "The new words are said by Voice's models: Drama 3 or VoxCPM2, in the clip's own voice or one of yours." : "Speech to text reads what the clip says, word by word, so you can change it."}
      action={
        <Link href="/tools/voice" className={PILL_ACT}>
          Open Voice <ArrowUpRight size={12} />
        </Link>
      }
    >
      <span className="font-semibold text-paper">{issue.kind === "speech" ? "Lip Sync speaks with Drama 3 or VoxCPM2" : "Lip Sync needs speech to text"}</span>
      <span className="text-fog"> · {issue.kind === "speech" ? "set one up in Voice" : "install it in Voice"}</span>
    </SetupPill>
  );
}
