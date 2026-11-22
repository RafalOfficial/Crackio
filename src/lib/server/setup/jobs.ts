import "server-only";
// comfy-local → refine → resolve → registry is a cycle: refine first (see voice/talk-setup).
import "@/lib/engines/refine";
import { randomUUID } from "node:crypto";
import { installModel, localStatus, stopDownload } from "../local-models";
import { allLocalModels } from "../local-templates";
import { setUpVoice } from "../voice/setup";
import { setUpTalk } from "../voice/talk-setup";
import { setUpLipsync } from "../lipsync/setup";
import { setupJobOf, talkSetupJobOf } from "../voice/jobs";
import { lipsyncJobOf } from "../lipsync/jobs";
import { forgetVoiceMachines } from "../voice/machines";
import { installComfy, setupStatus, updateLocalBridge } from "../comfy-install";
import { forgetTargets } from "../comfy-targets";
import { bumpEpoch } from "../epoch";
import { planInstall } from "../storage";
import { installState } from "@/lib/local/rows";
import { LFM3_LORAS, lfm3LorasBytes } from "@/lib/local/lfm3";
import { kitById } from "@/lib/setup/kits";
import { optionsOf } from "@/lib/setup/options";
import type { KitId, ReqStatus, SetupJob, SetupMachine, SetupPart, SetupSnapshot, SetupStep } from "@/lib/setup/types";
import type { VoiceModelId } from "@/lib/voice/models";

/**
 * Settings' set-ups: one job per machine at a time (later ones wait their turn), each a list of steps run one after
 * another by the installers the tools already use: installModel (Local, Get models), setUpVoice, setUpTalk,
 * setUpLipsync, installComfy and updateLocalBridge. A step that's already done there is skipped by its own installer.
 */

type Job = SetupJob & { parts: SetupPart[]; abort: AbortController; include: string[]; choices: Record<string, Choice>; only?: string[]; needsComfy: boolean };

const g = globalThis as unknown as { __crackioSetupJobs?: Map<string, Job> };
const jobs = (g.__crackioSetupJobs ??= new Map<string, Job>());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEEP_MS = 30 * 60_000;

/** What the jobs look like now, newest first (finished ones for half an hour). */
export function setupJobs(): SetupJob[] {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > KEEP_MS) jobs.delete(id);
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicJob);
}

function publicJob(j: Job): SetupJob {
  return structuredClone({
    id: j.id,
    machine: j.machine,
    machineLabel: j.machineLabel,
    kits: j.kits,
    state: j.state,
    steps: j.steps,
    error: j.error,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  });
}

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const GIB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GB`;

/** A model picked in Settings for one requirement ("video.model"), in place of Crackio's pick. */
export type Choice = { model: string; variant: string };

/**
 * The parts a set-up of these tools gets on a machine: every required one that isn't there, plus the optional ones asked
 * for. A model picked for a requirement (`choices`) is got instead of Crackio's pick, also beside one that's there
 * already (to try another); `hf` says whether your Hugging Face token is in. `only`: just these requirements of the
 * tools, optional or not, and nothing else they need (an add-on is got by itself, not with the tool it helps).
 */
export function planFor(machine: SetupMachine, kits: KitId[], include: string[] = [], choices: Record<string, Choice> = {}, hf = true, only?: string[]) {
  const parts: SetupPart[] = [];
  const blocked: ReqStatus[] = [];
  const keys = new Set<"comfy" | "hf">();
  /** Picks Crackio doesn't know on this machine (an old page, another machine's list). */
  const unknown: string[] = [];
  const add = (p: SetupPart) => {
    // One of each: a model two tools share, Voice once.
    const same = parts.find((q) => q.kind === p.kind && (p.kind !== "model" || (q.kind === "model" && q.model === p.model && q.variant === p.variant)));
    if (!same) parts.push(p);
    else if (p.kind === "voice" && same.kind === "voice" && p.clone && !same.clone) parts.splice(parts.indexOf(same), 1, p);
    else if (p.kind === "lfm3" && same.kind === "lfm3") {
      // LFM3-VL once, with every fine-tune asked for: what LFM3-VL lacks (the larger of the two counts) and each fine-tune.
      const loras = [...new Set([...(same.loras ?? []), ...(p.loras ?? [])])];
      const base = Math.max(same.bytes - lfm3LorasBytes(same.loras), p.bytes - lfm3LorasBytes(p.loras));
      parts.splice(parts.indexOf(same), 1, { kind: "lfm3", bytes: base + lfm3LorasBytes(loras), loras });
    }
  };
  for (const kit of kits) {
    const tool = machine.tools[kit];
    if (!tool) continue;
    for (const r of tool.reqs) {
      if (only && !only.includes(r.id)) continue;
      const chosen = choices[r.id];
      if (chosen) {
        const o = optionsOf(machine, r).find((x) => x.model === chosen.model);
        const v = o?.variants.find((x) => x.id === chosen.variant);
        if (!o || !v) {
          unknown.push(r.label);
          continue;
        }
        if (o.blocked) {
          blocked.push({ ...r, state: "blocked", why: `${o.name}'s licence leaves your region out` });
          continue;
        }
        if (v.installed) continue;
        if (o.gated && !hf) keys.add("hf");
        // A voice model: Voice's own installer gets it (and its engine); the version is the one it picks for the machine.
        if (r.plan?.kind === "voice" || o.model.startsWith("local:voice:")) add({ kind: "voice", bytes: v.bytes, clone: r.plan?.kind === "voice" ? r.plan.clone : false, model: o.model as VoiceModelId });
        else add({ kind: "model", model: o.model, name: o.name, variant: v.id, variantLabel: v.label, bytes: v.bytes, gated: o.gated });
        continue;
      }
      if (r.optional && !include.includes(r.id) && !only?.includes(r.id)) continue;
      if (r.state === "needs-key" && r.key) keys.add(r.key);
      if ((r.state === "unsupported" || r.state === "blocked" || r.state === "unpublished") && !r.optional) blocked.push(r);
      // A part downloading already joins too: its step follows that download (the installers skip files on their way).
      if (r.plan && (r.state === "missing" || r.state === "broken" || r.state === "outdated" || r.state === "needs-key" || r.state === "installing")) add(r.plan);
    }
  }
  const bridgeOld = kits.some((k) => machine.tools[k]?.reqs.some((r) => r.fix === "bridge" && (only ? only.includes(r.id) : !r.optional || include.includes(r.id))));
  return { parts, blocked, keys: [...keys], bridgeOld, unknown, bytes: parts.reduce((s, p) => s + p.bytes, 0) };
}

/** "LFM3-VL 2B", "Crackio's swap judge", "LFM3-VL 2B and Crackio's swap judge". */
function lfm3Label(p: Extract<SetupPart, { kind: "lfm3" }>) {
  const names = (p.loras ?? []).map((k) => LFM3_LORAS[k].label);
  if (p.bytes > lfm3LorasBytes(p.loras) || !names.length) names.unshift("LFM3-VL 2B");
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

const labelOf = (p: SetupPart) =>
  p.kind === "model" ? `${p.name}` : p.kind === "voice" ? "Voice" : p.kind === "lfm3" ? lfm3Label(p) : p.kind === "lipsync" ? "Lip Sync" : p.kind === "comfyui" ? "ComfyUI" : "Small helper models";

const step = (id: string, label: string): SetupStep => ({ id, label, state: "waiting", detail: "", progress: null, error: null });

/**
 * Starts setting tools up on a machine (or queues it behind the one running there). Refuses up front what can't work:
 * an offline machine, a missing key, too little room.
 */
export async function startSetup(snapshot: SetupSnapshot, input: { machine: string; kits: KitId[]; include?: string[]; choices?: Record<string, Choice>; only?: string[] }): Promise<SetupJob> {
  const machine = snapshot.machines.find((m) => m.id === input.machine);
  if (!machine) throw new SetupError("That computer isn't one of your machines.", 404);
  // This computer without a ComfyUI yet: the set-up installs one first.
  const noComfy = machine.kind === "this-computer" && !machine.comfy.installed;
  if (!machine.online && !noComfy) throw new SetupError(`${machine.label} isn't answering: start it, then try again.`);
  if (machine.metered) throw new SetupError("Pay-per-job machines bring their own models: set tools up on one of your GPUs instead.");
  const kits = input.kits.filter((k) => kitById(k));
  if (!kits.length) throw new SetupError("Pick a tool to set up.", 400);
  const plan = planFor(machine, kits, input.include, input.choices, snapshot.keys.hf, input.only);
  if (plan.unknown.length) throw new SetupError(`That model isn't one ${plan.unknown[0].toLowerCase()} can use on ${machine.label}: pick it again.`, 400);
  if (plan.keys.includes("hf")) throw new SetupError("Some of these files need your Hugging Face token first: add it under Settings → Accounts.");
  if (plan.bridgeOld && machine.bridge.update !== "this-computer") {
    throw new SetupError(
      machine.bridge.update === "reconnect"
        ? `Crackio's helper on ${machine.label} is out of date: reconnect it under Machines, then set up again.`
        : `Crackio's helper on ${machine.label} is out of date: copy comfyui/crackio_bridge into its ComfyUI's custom_nodes and restart it.`,
    );
  }
  if (!plan.parts.length && !plan.bridgeOld) {
    if (plan.blocked.length) throw new SetupError(plan.blocked[0].why);
    throw new SetupError(input.choices && Object.keys(input.choices).length ? "That model is there already." : "Everything these tools need is already there.");
  }
  const total = plan.bytes + (noComfy ? 4.5e9 : 0);
  if (noComfy) {
    if (machine.diskFreeGb != null && total / GIB > machine.diskFreeGb - 2) {
      throw new SetupError(`This needs about ${gb(total)} on ${machine.label}, which has ${machine.diskFreeGb.toFixed(1)} GB free. Free some space under Storage first.`);
    }
  } else {
    // The same verdict Storage gives: the drive downloads go to, 2 GB kept spare, and your limit for this machine.
    const fit = await planInstall(machine.id, total).catch(() => null);
    if (fit && !fit.ok) throw new SetupError(`${fit.reason ?? "There isn't room for this."} Free some space under Storage first.`);
  }
  const steps: SetupStep[] = [];
  if (noComfy) steps.push(step("comfyui", "ComfyUI"));
  if (plan.bridgeOld) steps.push(step("bridge", "Crackio's helper"));
  for (const p of plan.parts) steps.push(step(p.kind === "model" ? `model:${p.model}` : p.kind, labelOf(p)));
  const job: Job = {
    id: randomUUID().slice(0, 8),
    machine: machine.id,
    machineLabel: machine.label,
    kits,
    state: "queued",
    steps,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    parts: plan.parts,
    abort: new AbortController(),
    include: input.include ?? [],
    choices: input.choices ?? {},
    only: input.only,
    needsComfy: noComfy,
  };
  jobs.set(job.id, job);
  void next(machine.id);
  return publicJob(job);
}

/** Stops a job: the step running finishes its current file or check, the rest are skipped. */
export async function stopSetup(id: string) {
  const job = jobs.get(id);
  if (!job) throw new SetupError("No such set-up.", 404);
  if (job.finishedAt) return publicJob(job);
  job.abort.abort();
  if (job.state === "queued") finish(job, "stopped");
  // Downloads the running step started stop too.
  const running = job.steps.find((s) => s.state === "running");
  const part = running ? job.parts.find((p) => p.kind === "model" && running.id === `model:${p.model}`) : undefined;
  if (part?.kind === "model") {
    const status = await localStatus().catch(() => null);
    const target = status?.targets.find((t) => t.id === job.machine) ?? null;
    const variant = allLocalModels().find((m) => m.id === part.model)?.variants.find((v) => v.id === part.variant) ?? null;
    for (const d of installState(variant, target).active) await stopDownload(d.id, job.machine).catch(() => undefined);
  }
  return publicJob(job);
}

function finish(job: Job, state: SetupJob["state"], error: string | null = null) {
  job.state = state;
  job.error = error;
  job.finishedAt = Date.now();
  for (const s of job.steps) if (s.state === "waiting" || s.state === "running") s.state = state === "done" ? "done" : "skipped";
  // What it set up is in the next model list and look at once.
  bumpEpoch();
  void import("./status").then((m) => m.forgetSetupSnapshot());
}

/** The next queued job on a machine starts once none runs there. */
async function next(machine: string) {
  const all = [...jobs.values()];
  if (all.some((j) => j.machine === machine && j.state === "running")) return;
  const job = all.filter((j) => j.machine === machine && j.state === "queued").sort((a, b) => a.startedAt - b.startedAt)[0];
  if (!job) return;
  job.state = "running";
  try {
    await run(job);
    if (job.abort.signal.aborted) finish(job, "stopped");
    else finish(job, "done");
  } catch (err) {
    const running = job.steps.find((s) => s.state === "running");
    if (running) {
      running.state = "error";
      running.error = (err as Error).message;
    }
    finish(job, job.abort.signal.aborted ? "stopped" : "error", (err as Error).message);
  } finally {
    forgetVoiceMachines();
    void next(machine);
  }
}

async function run(job: Job) {
  // By index: installing ComfyUI swaps the rest of the list for one planned against the new ComfyUI.
  for (let i = 0; i < job.steps.length; i++) {
    const s = job.steps[i];
    if (job.abort.signal.aborted) return;
    s.state = "running";
    if (s.id === "comfyui") await runComfy(job, s);
    else if (s.id === "bridge") {
      s.detail = "Updating and restarting ComfyUI";
      await updateLocalBridge();
      await sleep(8000);
    } else {
      const part = job.parts.find((p) => (p.kind === "model" ? s.id === `model:${p.model}` : s.id === p.kind));
      if (part) await runPart(job, s, part);
    }
    if (job.abort.signal.aborted) return;
    s.state = "done";
    s.progress = null;
    const { forgetSetupSnapshot } = await import("./status");
    forgetSetupSnapshot();
  }
}

/** ComfyUI on this computer, then the plan made again for it (its id and its files are new). */
async function runComfy(job: Job, s: SetupStep) {
  s.detail = "Installing ComfyUI";
  const started = Date.now();
  await installComfy({ start: true });
  for (;;) {
    if (job.abort.signal.aborted) return;
    await sleep(2000);
    const st = await setupStatus();
    s.detail = st.stage ?? st.detail ?? "Installing ComfyUI";
    s.progress = st.progress != null ? { received: st.progress, total: 100 } : null;
    // Only this install's own error (an older one's stays in the status until a new one starts).
    const mine = st.job && st.job.startedAt >= started - 5000;
    if (mine && st.job!.finishedAt && st.error) throw new Error(st.error);
    if (st.installed && st.running) break;
  }
  forgetTargets();
  // The new ComfyUI is a machine now: plan the rest again against it.
  const { setupSnapshot } = await import("./status");
  let machine: SetupMachine | undefined;
  for (let i = 0; i < 30 && !machine; i++) {
    const snap = await setupSnapshot(true);
    machine = snap.machines.find((m) => m.kind === "this-computer" && m.comfy.installed && m.online);
    if (!machine) await sleep(2000);
  }
  if (!machine) throw new Error("ComfyUI installed, but Crackio can't reach it yet: open Settings → Machines.");
  job.machine = machine.id;
  job.machineLabel = machine.label;
  const plan = planFor(machine, job.kits, job.include, job.choices, true, job.only);
  job.parts = plan.parts;
  const done = job.steps.filter((x) => x.id === "comfyui");
  job.steps = [...done, ...plan.parts.map((p) => step(p.kind === "model" ? `model:${p.model}` : p.kind, labelOf(p)))];
  // The loop in run() goes on over the new list.
  s.state = "done";
}

async function runPart(job: Job, s: SetupStep, p: SetupPart) {
  const machine = job.machine;
  if (p.kind === "model") {
    s.detail = `Getting ${p.name} (${p.variantLabel})`;
    await installModel(p.model, p.variant, machine);
    const model = allLocalModels().find((m) => m.id === p.model);
    const variant = model?.variants.find((v) => v.id === p.variant) ?? null;
    let idle = 0;
    let away = 0;
    for (;;) {
      if (job.abort.signal.aborted) return;
      await sleep(2000);
      const status = await localStatus();
      const target = status.targets.find((t) => t.id === machine) ?? null;
      // A box busy installing a custom node, or a tunnel that blinks, misses a look or two: the download goes on there.
      if (!target?.connected) {
        away += 2;
        s.detail = `${job.machineLabel} isn't answering; waiting for it`;
        if (away > 90) throw new Error(`${job.machineLabel} stopped answering for over a minute and a half.`);
        continue;
      }
      away = 0;
      const st = installState(variant, target);
      s.progress = { received: st.done, total: st.total };
      s.detail = st.checking ? `Checking ${p.name}` : `Downloading ${p.name}`;
      if (st.installed) return;
      if (st.failed && !st.active.length) throw new Error(`${p.name}: ${st.failed.error ?? "its download stopped"}`);
      // Nothing downloading and not there: the bridge dropped it (or never took it). Ask again once, then give up.
      if (!st.active.length) {
        idle++;
        if (idle === 5) await installModel(p.model, p.variant, machine);
        if (idle > 15) throw new Error(`${p.name} didn't start downloading on ${job.machineLabel}.`);
      } else idle = 0;
    }
  }
  if (p.kind === "voice") {
    s.detail = "Setting up Voice";
    await setUpVoice(p.model, machine);
    await follow(job, s, () => setupJobOf(machine));
    return;
  }
  if (p.kind === "lfm3") {
    s.detail = `Setting up ${lfm3Label(p)}`;
    await setUpTalk({ machine, loras: p.loras });
    await follow(job, s, () => talkSetupJobOf(machine));
    return;
  }
  if (p.kind === "lipsync") {
    s.detail = "Setting up Lip Sync";
    await setUpLipsync(machine);
    await follow(job, s, () => lipsyncJobOf(machine));
  }
}

type Followed = { state: "running" | "done" | "error"; detail: string; progress: { received: number; total: number } | null; error: string | null };

/** Waits for one of the tools' own set-up jobs, showing its words and progress as this step's. */
async function follow(job: Job, s: SetupStep, look: () => Followed | null) {
  for (;;) {
    if (job.abort.signal.aborted) return;
    await sleep(2000);
    const j = look();
    if (!j) continue;
    s.detail = j.detail || s.detail;
    s.progress = j.progress;
    if (j.state === "done") return;
    if (j.state === "error") throw new Error(j.error ?? "It stopped.");
  }
}
