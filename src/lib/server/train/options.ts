import "server-only";
import { comfyTargets, withTarget } from "../comfy-targets";
import { getSettings } from "../settings";
import { customModels, resolveBase, weightSizes, type CustomModel } from "./bases";
import { hasNode } from "./comfy";
import { drawerNeed, type DrawerNeed } from "./drawer";
import { creditFresh, creditNow } from "../setup/cloud-money";
import { paceRecords, planMachines } from "./run";
import { gpuKeyOf } from "@/lib/local/gpu-series";
import { estimateTraining, fitTraining, planFor, resolvedSettings, setFacts, type Plan, type PlanMachine, type TrainEstimate } from "@/lib/train/plan";
import { profileById, TRAIN_PROFILES } from "@/lib/train/profiles";
import type { TrainJob, TrainSettings } from "@/lib/train/types";

/**
 * Everything the Train page needs to let you choose with open eyes: the models that can be trained, your machines with
 * what each would do with this job (which weights fit, how long it would take, what it would cost, what it would
 * download first), Crackio's pick for every setting with its reason, and your own model files on the chosen machine.
 */

export type BaseOption = {
  id: string;
  name: string;
  maker: string;
  blurb: string;
  licence: { name: string; commercial: "yes" | "limited" | "no"; note?: string };
  note?: string;
  tested?: string;
  gated: boolean;
  /** Its training weights, best first, with their download size. */
  weights: { id: string; label: string; bytes: number }[];
  /** What a run on the chosen machine downloads first, in bytes (0: all there; null: no machine chosen or it's off). */
  download: number | null;
};

export type MachineOption = PlanMachine & {
  gpuName: string | null;
  /** Whether this job's model trains there, how, and why. */
  fit: { state: "great" | "ok" | "slow" | "no"; why: string; weights: string | null; offload: boolean; resolution: number } | null;
  estimate: TrainEstimate | null;
  /** Bytes it downloads before the first step. */
  download: number | null;
  /** The picture model the run's test pictures are drawn with there: on the machine already, or what the run downloads for them first (null: test pictures are off, the family draws none, or the machine is off). */
  pictures: DrawerNeed | null;
  /** Something to know (its helper updates first, it's off…), in a line. */
  notice: string | null;
  /** The credit left on the cloud account that bills this machine (a rented box, a RunPod endpoint), in dollars. */
  credit: { provider: "vast" | "runpod"; balance: number } | null;
  /** Whether a run can start there now. */
  usable: boolean;
  recommended: boolean;
};

export type TrainOptions = {
  bases: BaseOption[];
  machines: MachineOption[];
  /** Crackio's picks for the job as it stands (on the chosen machine, when one is). */
  plan: Plan;
  /** The settings a run would use now: yours where you set one, Crackio's elsewhere. */
  settings: TrainSettings;
  custom: { machine: string | null; models: CustomModel[]; folder: string | null };
  hfToken: boolean;
  /** The models the job's LoRA runs on (their Crackio ids), for switching it on and going to make a picture. */
  uses: { crackio: string; name: string; strength: number }[];
};

export async function trainOptions(job: TrainJob): Promise<TrainOptions> {
  const [machines, records, targets, settings] = await Promise.all([planMachines(), paceRecords(), comfyTargets(), getSettings()]);
  const profile = profileById(job.base?.family);
  const facts0 = setFacts(job.images, job.settings.resolution, job.goal);
  // The last reading, or a first one when Crackio has none yet (just started).
  const credits = creditNow().length ? creditNow() : await creditFresh().catch(() => []);

  const options: MachineOption[] = [];
  for (const m of machines) {
    const target = targets.find((t) => t.id === m.id);
    const provider = target?.serverless || target?.metered === "runpod" ? "runpod" : target?.cloud?.provider;
    const billed = provider === "runpod" || provider === "vast" ? credits.find((x) => x.provider === provider) : undefined;
    const option: MachineOption = { ...m, gpuName: m.gpu?.name ?? null, fit: null, estimate: null, download: null, pictures: null, notice: null, credit: billed ? { provider: billed.provider, balance: billed.balance } : null, usable: false, recommended: false };
    if (m.kind === "comfy-cloud") continue;
    if (!m.online) option.notice = m.kind === "this-computer" ? "ComfyUI is stopped: Crackio starts it when you train here" : "Not answering: start it to train here";
    if (profile && job.base && m.gpu?.memoryGb) {
      const first = fitTraining(profile, m, { resolution: job.auto.includes("resolution") ? profile.resolution : job.settings.resolution, rank: job.auto.includes("rank") ? profile.rank : job.settings.rank, meanMp: facts0.meanMp, sizes: weightSizes(profile) });
      const plan = planFor({ goal: job.goal, images: job.images, profile, fit: first, memoryGb: m.gpu.memoryGb });
      const s = resolvedSettings(job, plan);
      const facts = setFacts(job.images, s.resolution, job.goal);
      const resolved = target && m.online ? await withTarget(target, () => resolveBase(job.base!, m, { resolution: s.resolution, rank: s.rank, meanMp: facts.meanMp })).catch(() => null) : null;
      const fit = resolved?.fit ?? fitTraining(profile, m, { resolution: s.resolution, rank: s.rank, meanMp: facts.meanMp, sizes: weightSizes(profile) });
      option.fit = { state: fit.state, why: fit.why, weights: fit.weights?.label ?? null, offload: fit.offload, resolution: fit.resolution };
      if (fit.weights) {
        option.estimate = estimateTraining({ profile, weights: fit.weights, machine: m, gpuKey: gpuKeyOf(m.gpu.name), settings: { ...s, resolution: fit.resolution, offload: fit.offload || s.offload }, facts: setFacts(job.images, fit.resolution, job.goal), offload: fit.offload || s.offload, records });
      }
      option.download = resolved ? resolved.missing.reduce((n, f) => n + f.bytes, 0) : null;
      if (s.previews && target && m.online && !target.serverless) option.pictures = await withTarget(target, () => drawerNeed(profile.uses, m.gpu, new Set(resolved?.missing.map((f) => `${f.folder}/${f.name}`)))).catch(() => null);
    } else if (m.online && !m.gpu?.memoryGb) {
      option.fit = { state: "no", why: "Crackio can't see its GPU", weights: null, offload: false, resolution: job.settings.resolution };
    }
    // A RunPod endpoint trains only once its worker carries the trainer (the helper 1.11): said here, not after Start.
    const noTrainer = m.kind === "serverless" && m.online && target ? !(await withTarget(target, () => hasNode("CrackioTrainLora")).catch(() => true)) : false;
    if (noTrainer) {
      option.notice = "Its worker doesn't have Crackio's trainer yet: update the endpoint to Crackio's latest worker (docs/SERVERLESS.md), or train on another machine";
      option.estimate = null;
      if (option.fit) option.fit = { ...option.fit, state: "no", why: "Its worker needs an update first" };
    }
    option.usable = !noTrainer && (m.online || m.kind === "this-computer") && (!option.fit || option.fit.state !== "no");
    options.push(option);
  }
  // Crackio's pick: your own machines before ones billed by time, then the one that finishes first.
  const able = options.filter((o) => o.usable && o.online && o.fit && o.fit.state !== "no");
  const best = [...able].sort((a, b) => Number(a.metered) - Number(b.metered) || Number(Boolean(a.pricePerHour)) - Number(Boolean(b.pricePerHour)) || (a.estimate?.seconds ?? 1e12) - (b.estimate?.seconds ?? 1e12))[0];
  if (best) best.recommended = true;

  const chosen = options.find((o) => o.id === job.machine) ?? null;
  const chosenTarget = chosen ? targets.find((t) => t.id === chosen.id) : undefined;
  const fit = chosen && profile && chosen.fit ? fitTraining(profile, chosen, { resolution: job.auto.includes("resolution") ? profile.resolution : job.settings.resolution, rank: job.auto.includes("rank") ? profile.rank : job.settings.rank, meanMp: facts0.meanMp, sizes: weightSizes(profile) }) : null;
  const plan = planFor({ goal: job.goal, images: job.images, profile, fit, memoryGb: chosen?.gpu?.memoryGb });

  const custom = chosen?.online && chosenTarget && !chosenTarget.serverless ? await withTarget(chosenTarget, () => customModels(chosenTarget.id)).catch(() => ({ models: [], folderHint: null })) : { models: [], folderHint: null };

  const bases: BaseOption[] = [];
  for (const p of TRAIN_PROFILES) {
    // One no model of Crackio's draws with (kept for your own model files of that kind): its LoRA would have no use here.
    if (!p.uses.length || p.hold) continue;
    // An edit is learned by a model that takes a picture to change beside the prompt.
    if (job.goal === "edit" ? !p.edit : p.editOnly) continue;
    const sizes = weightSizes(p);
    let download: number | null = null;
    if (chosen?.online && chosenTarget) {
      const r = await withTarget(chosenTarget, () => resolveBase({ kind: "catalog", family: p.id }, chosen, { resolution: p.resolution, rank: p.rank })).catch(() => null);
      download = r ? r.missing.reduce((n, f) => n + f.bytes, 0) : null;
    }
    bases.push({
      id: p.id,
      name: p.name,
      maker: p.maker,
      blurb: p.blurb,
      licence: p.licence,
      note: p.note,
      tested: p.tested,
      gated: Boolean(p.gated),
      weights: p.weights.map((w) => ({ id: w.id, label: w.label, bytes: sizes[w.name] ?? w.file?.bytes ?? 0 })),
      download,
    });
  }
  const { allLocalModels } = await import("../local-templates");
  const uses = profile ? allLocalModels().filter((m) => profile.uses.includes(m.id) && m.crackio).map((m) => ({ crackio: m.crackio!, name: m.name, strength: profile.strength })) : [];
  return { bases, machines: options, plan, settings: resolvedSettings(job, plan), custom: { machine: chosen?.id ?? null, models: custom.models, folder: custom.folderHint }, hfToken: Boolean(settings.keys.hf?.trim() || process.env.HF_TOKEN), uses };
}
