import "server-only";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { comfyTargets, withTarget, type ComfyTarget } from "../comfy-targets";
import { whileBusy } from "../comfy-busy";
import { getSettings } from "../settings";
import { DATA_DIR } from "../paths";
import { writeFileAtomic } from "../atomic-write";
import { allJobs, getJob, jobPath, log, touch } from "./store";
import { trainingSet } from "./dataset";
import { resolveBase, type ResolvedBase } from "./bases";
import { pickDrawer } from "./drawer";
import { loraStem, prepareGraph, saveSteps, signatureOf, trainConfig, trainGraph, type Graph } from "./graph";
import { answers, cancel, fetchLora, fetchOutput, fetchState, getJson, hasNode, historyOf, inputThere, inQueue, listen, postJson, queue, sendLora, sendState, stateProbe, TrainFail, upload, type Heard } from "./comfy";
import { gpuKeyOf } from "@/lib/local/gpu-series";
import { BRIDGE_FEATURES, versionAtLeast } from "@/lib/setup/bridge";
import { ASPECTS } from "@/lib/shot";
import { profileById } from "@/lib/train/profiles";
import { captionFor, estimateTraining, formatDuration, machineSpeed, planFor, RESOLUTIONS, resolvedSettings, setFacts, subjectWords, testPrompts, type PaceRecord, type PlanMachine } from "@/lib/train/plan";
import { isActive, type TrainCheckpoint, type TrainJob, type TrainSettings } from "@/lib/train/types";
import type { LoraRecord } from "@/lib/local/loras";
import type { LocalModel } from "@/lib/local/types";

/**
 * A training run, start to finish, on the machine you picked: get the machine ready (start its ComfyUI, bring its helper
 * up to date, download the model's training weights), write captions, send the pictures, have the machine prepare them,
 * train in stretches (each one a ComfyUI job that carries on from the last: a version is saved and test pictures are
 * drawn between them), then bring the LoRA home and add it to the model's LoRAs.
 *
 * What goes wrong on the way is answered here first, in order, and said in the job's notes: a machine that isn't
 * running is started, an old helper is updated, a run out of GPU memory streams the model from RAM, then trains smaller;
 * a loss that stops being a number continues from the last good state at half the rate; a ComfyUI that restarted gets
 * the next stretch queued again. Only what none of that fixes stops the run, with what to do about it.
 *
 * A paused run can move to another machine (`moveTraining`): what it carries on from (the LoRA so far, the optimizer,
 * the step: one file, about a gigabyte) comes home from the old machine with the versions saved so far, the job points
 * at the new one, and the usual steps there (weights, pictures, preparing) are followed by sending that file before the
 * next stretch, which carries on at the same step. A rented machine's pause brings the file home by itself, so a box
 * that won't start again (RunPod gave a stopped pod's GPU to someone else) doesn't take the run with it.
 *
 * A run outlives Crackio: the training state is on the machine, the job's notes (`job.run`) on disk. After a restart the
 * next look at the jobs (`reattach`) picks every active one up where it stands.
 */

type Live = {
  abort: AbortController;
  stop: null | "pause" | "finish";
  lastSeq: number;
  done: Promise<void>;
  /** Saved versions on their way to this computer, how often each copy has failed, and whether the disk here ran short. */
  homing?: Promise<void>;
  homeTried?: Map<string, number>;
  homeFull?: boolean;
};
const g = globalThis as unknown as { __crackioTrainLive?: Map<string, Live>; __crackioTrainDrive?: (job: TrainJob, live: Live) => Promise<void>; __crackioTrainVersions?: Set<string> };
const live = (g.__crackioTrainLive ??= new Map());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GIB = 1024 ** 3;

export const isLive = (id: string) => live.has(id);

/* ------------------------------------------------------------------ machines */

/** One of your machines as planning sees it (Settings' snapshot), or null when it's gone. */
export async function planMachine(id: string, fresh = false): Promise<PlanMachine | null> {
  const { setupSnapshot } = await import("../setup/status");
  const m = (await setupSnapshot(fresh)).machines.find((x) => x.id === id);
  if (!m) return null;
  return { id: m.id, label: m.label, where: m.where, kind: m.kind, online: m.online, gpu: m.gpu, ramGb: m.ramGb, accel: m.accel, diskFreeGb: m.diskFreeGb, pricePerHour: m.pricePerHour, metered: m.metered };
}

export async function planMachines(): Promise<PlanMachine[]> {
  const { setupSnapshot } = await import("../setup/status");
  return (await setupSnapshot()).machines.map((m) => ({ id: m.id, label: m.label, where: m.where, kind: m.kind, online: m.online, gpu: m.gpu, ramGb: m.ramGb, accel: m.accel, diskFreeGb: m.diskFreeGb, pricePerHour: m.pricePerHour, metered: m.metered }));
}

/* ------------------------------------------------------------------ measured speeds */

const SPEEDS = path.join(/*turbopackIgnore: true*/ DATA_DIR, "train-speeds.json");

export async function paceRecords(): Promise<PaceRecord[]> {
  try {
    return JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ SPEEDS, "utf8")) as PaceRecord[];
  } catch {
    return [];
  }
}

async function recordPace(r: PaceRecord) {
  const all = (await paceRecords()).filter((x) => !(x.family === r.family && x.weights === r.weights && x.gpu === r.gpu && x.offload === r.offload));
  await writeFileAtomic(SPEEDS, JSON.stringify([r, ...all].slice(0, 200))).catch(() => undefined);
}

/* ------------------------------------------------------------------ starting, stopping */

export class TrainRefused extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Starts a job's training, or carries a paused or failed one on. Refuses what can't work, with why. */
export async function startTraining(id: string): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job) throw new TrainRefused("No such LoRA.", 404);
  if (live.has(id)) return job;
  if (job.state === "done") throw new TrainRefused("It's already trained.");
  const set = trainingSet(job);
  if (!job.base) throw new TrainRefused("Pick the model to train first.");
  if (!job.machine) throw new TrainRefused("Pick the machine to train on first.");
  // A model kept off the page isn't trained by another way in either (a request made by hand, a draft from before it
  // was held back, your own file of that kind), nor one that only learns edits for anything else.
  const asked = profileById(job.base.family);
  if (asked?.hold) throw new TrainRefused(`Crackio doesn't train ${asked.name} yet (${asked.hold.charAt(0).toLowerCase()}${asked.hold.slice(1)}). Pick another model.`);
  if (asked?.editOnly && job.goal !== "edit") throw new TrainRefused(`${asked.name} only learns a change from before and after pairs. Pick another model.`);
  if (job.goal === "edit") {
    // An edit LoRA: pairs, an instruction for each, and a model that takes a picture to change.
    if (set.length < 2) throw new TrainRefused("Add before and after pairs to train on first.");
    if (set.some((s) => !s.caption)) throw new TrainRefused("Say what the change is first (the instruction).");
    const profile = profileById(job.base.family);
    if (profile && !profile.edit) throw new TrainRefused(`${profile.name} can't learn an edit: pick a model that takes a picture to change.`);
  } else {
    if (set.length < 2) throw new TrainRefused("Add pictures to train on first.");
    if (!job.trigger.trim()) throw new TrainRefused("Give it a trigger word first.");
  }
  job.error = null;
  job.state = "starting";
  job.progress.stage = "Getting ready";
  job.progress.share = null;
  job.progress.finishedAt = null;
  job.progress.startedAt ??= Date.now();
  // Its place in the machine's queue: behind every run started before now.
  job.run = { ...job.run, askedAt: Date.now(), pausing: undefined };
  // The driver is in place before anything is waited for: a second Start arriving meanwhile finds it (above).
  launch(job);
  await touch(job, true);
  return job;
}

function launch(job: TrainJob) {
  // One driver a job, whatever asks: two looks at the jobs at once (two tabs open after a restart) each found the run
  // without one and started their own, and two trainers ran the same job side by side.
  if (live.has(job.id)) return;
  // The trainer's lines already in the job's log stay where they are: a run picked up again (Crackio restarted, Try
  // again) wrote the last forty of them a second time.
  // (A pause or a finish that was on its way when Crackio restarted is still wanted.)
  const l: Live = { abort: new AbortController(), stop: job.run?.pausing ?? null, lastSeq: job.run?.logSeq ?? 0, done: Promise.resolve() };
  live.set(job.id, l);
  // The newest code drives every run (a hot reload in dev leaves the old module's functions behind).
  l.done = (g.__crackioTrainDrive ?? drive)(job, l).finally(() => {
    if (live.get(job.id) === l) live.delete(job.id);
  });
}

/** Stops after the step in progress and keeps what's trained, to carry on later. */
export async function pauseTraining(id: string) {
  const l = live.get(id);
  const job = await getJob(id);
  if (!job) throw new TrainRefused("No such LoRA.", 404);
  if (!l) {
    if (isActive(job.state)) {
      job.state = "paused";
      await touch(job, true);
    }
    return job;
  }
  l.stop = "pause";
  job.run = { ...job.run, pausing: "pause" };
  job.progress.stage = "Pausing after this step";
  await touch(job, true);
  return job;
}

/**
 * A run that stopped before its first step goes back to the workbench: its model, machine, settings and pictures can
 * be changed again. (It could only be tried again or moved, with a hint that said "pick another model".)
 */
export async function editSetup(id: string): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job) throw new TrainRefused("No such LoRA.", 404);
  if (live.has(id) || isActive(job.state)) throw new TrainRefused("Pause it first.");
  if (job.state === "draft") return job;
  if (job.progress.step > 0 || job.result) throw new TrainRefused("It has trained already: its set-up is fixed. Start a new LoRA to change it.");
  job.state = "draft";
  job.error = null;
  job.run = undefined;
  job.planned = undefined;
  job.progress.stage = "";
  job.progress.share = null;
  job.progress.startedAt = null;
  job.progress.ranMs = 0;
  job.progress.runningSince = null;
  await log(job.id, "Back to the setup: nothing was trained yet");
  await touch(job, true);
  return job;
}

/** Stops here and makes the LoRA from what's trained so far. */
export async function finishTraining(id: string) {
  const job = await getJob(id);
  if (!job) throw new TrainRefused("No such LoRA.", 404);
  if (job.progress.step < 1) throw new TrainRefused("Nothing is trained yet.");
  const l = live.get(id);
  if (l) {
    l.stop = "finish";
    job.run = { ...job.run, pausing: "finish" };
    job.progress.stage = "Finishing with what's trained";
    await touch(job, true);
    return job;
  }
  // Paused or failed: the LoRA is made from the state kept on the machine.
  job.settings.steps = job.progress.step;
  job.auto = job.auto.filter((k) => k !== "steps");
  return startTraining(id);
}

/**
 * A paused (or failed) run carries on on another machine: what it keeps comes home from the old one, goes to the new
 * one, and the run goes on at the same step. Answers at once; the move shows in the job like any other part of a run.
 */
export async function moveTraining(id: string, machine: string): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job) throw new TrainRefused("No such LoRA.", 404);
  if (live.has(id) || isActive(job.state)) throw new TrainRefused("Pause it first: a run moves between two stretches.");
  if (job.state !== "paused" && job.state !== "error") throw new TrainRefused("Only a paused run can move.");
  if (!job.base || !job.machine) throw new TrainRefused("It hasn't started anywhere yet: pick the machine and start it.");
  if (machine === job.machine) return startTraining(id);
  const to = (await comfyTargets()).find((t) => t.id === machine);
  if (!to) throw new TrainRefused("That machine isn't one of yours.", 404);
  if (to.metered === "comfy-cloud") throw new TrainRefused("Comfy Cloud can't train.");
  if (to.serverless) throw new TrainRefused("A run can't move to a RunPod endpoint yet: pick a GPU of your own or a rented one.");
  // It must train on the same weights there: what it has learned so far is for those.
  const there = await planMachine(to.id);
  if (there && job.run?.weights && job.base.kind === "catalog" && job.progress.step > 0) {
    const facts = setFacts(job.images, job.settings.resolution, job.goal);
    const base = await withTarget(to, () => resolveBase(job.base!, there, { resolution: job.settings.resolution, rank: job.settings.rank, meanMp: facts.meanMp })).catch(() => null);
    if (base && (base.fit.state === "no" || base.weights.id !== job.run.weights)) {
      throw new TrainRefused(`${to.label} can't carry this run on: it trains on the ${base.weights.label.toLowerCase()} weights there, and this run started on others. Pick a machine with at least as much GPU memory.`);
    }
  }
  job.run = { ...job.run, moveTo: machine };
  await touch(job, true);
  return startTraining(id);
}

/** Picks every active job up again after Crackio restarted (called when the jobs are looked at). */
export async function reattach() {
  for (const job of await allJobs()) {
    if (isActive(job.state) && !live.has(job.id)) {
      // The driver first, then the line: nothing is waited for between looking and taking the run.
      launch(job);
      await log(job.id, "Crackio restarted: picking the run up where it stands");
    }
  }
}

/* ------------------------------------------------------------------ the run */

type Ctx = {
  job: TrainJob;
  live: Live;
  target: ComfyTarget;
  machine: PlanMachine;
  /** The machine's helper must hand over or take a run's state too (a move), not only train. */
  needsState?: boolean;
  say: (stage: string, share?: number | null) => void;
  note: (what: string) => Promise<void>;
  /** The finished LoRA as a file in the machine's output folder (a serverless endpoint hands it over that way). */
  exported?: { filename: string; subfolder?: string; type?: string };
};

async function drive(job: TrainJob, l: Live) {
  const say = (stage: string, share: number | null = null) => {
    job.progress.stage = stage;
    job.progress.share = share;
    void touch(job);
  };
  const note = async (what: string) => {
    job.heals.push({ at: Date.now(), what });
    if (job.heals.length > 40) job.heals.splice(0, job.heals.length - 40);
    await log(job.id, `Crackio: ${what}`);
    void touch(job);
  };
  let on: ComfyTarget | undefined;
  let ctx: Ctx | undefined;
  try {
    // Asked to move: the state comes home from the old machine and the job points at the new one, then the usual run.
    if (job.run?.moveTo) await move(job, l, say, note);
    const target = (await comfyTargets()).find((t) => t.id === job.machine);
    if (!target) throw new TrainFail("The machine this was set to train on isn't one of yours any more.", "Pick another machine, then start again.");
    on = target;
    // One training per machine: a second one waits its turn, in the order Start was pressed. (It went by when the
    // LoRAs were made: one made earlier and started later didn't wait for the one already training, and both ran.)
    const turn = (o: TrainJob) => o.run?.askedAt ?? o.createdAt;
    let fetched = false;
    for (;;) {
      const ahead = (await allJobs()).find((o) => o.id !== job.id && o.machine === job.machine && live.has(o.id) && (turn(o) < turn(job) || (turn(o) === turn(job) && o.id < job.id)));
      if (!ahead) break;
      job.state = "queued";
      say(`Waiting for ${ahead.name} to finish on ${target.label}`);
      // While it waits, its model's files come down: a download needs no GPU, and a rented one is paid by the minute
      // (a 29 GB download once sat between two runs with the GPU idle).
      if (!fetched) {
        fetched = true;
        await fetchAhead(job, l, target, say, note);
        if (l.stop) throw new Paused();
        continue;
      }
      await sleep(5000);
      if (l.stop) throw new Paused();
    }
    job.state = "starting";
    // Its running time starts when its turn comes (a stretch Crackio's restart cut short counts up to now: the machine
    // went on meanwhile).
    job.progress.ranMs = (job.progress.ranMs ?? 0) + (job.progress.runningSince ? Math.max(0, Date.now() - job.progress.runningSince) : 0);
    job.progress.runningSince = Date.now();
    const machine = (await planMachine(target.id)) ?? { id: target.id, label: target.label, where: "", kind: "lan" as const, online: true, gpu: null, ramGb: null, accel: null, diskFreeGb: null, pricePerHour: null, metered: Boolean(target.metered) };
    ctx = { job, live: l, target, machine, say, note, needsState: Boolean(job.run?.carry) };
    const run = ctx;
    await withTarget(target, () => whileBusy(target.id, () => steps(run)));
    // What the run kept to carry on from (close to a gigabyte for a big model) has done its job; the saved versions stay,
    // to pick from.
    if (!target.serverless) await withTarget(target, () => postJson("/crackio/train/clean", { job: job.id, loras: [] }, 30_000)).catch(() => undefined);
    job.state = "done";
    job.progress.finishedAt = Date.now();
    job.progress.stage = "";
    job.progress.share = null;
    job.run = { prepared: job.run?.prepared, weights: job.run?.weights };
    // The copy of its state kept here has done its job too.
    await fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "state"), { recursive: true, force: true }).catch(() => undefined);
    await log(job.id, `Finished: ${job.result?.file}`);
  } catch (err) {
    if (err instanceof Paused || l.stop === "pause") {
      // A rented machine can be gone tomorrow (a stopped pod's GPU goes to someone else): what the run carries on from
      // comes home now, so it can carry on anywhere. Not worth a failed pause: a machine that can't hand it over is left.
      if (on?.cloud && ctx && job.progress.step > 0 && job.run?.home?.step !== job.progress.step && !job.run?.moveTo) {
        const c = ctx;
        job.state = "saving";
        await withTarget(on, async () => {
          if ((await stateProbe(job.id))?.state) await keepHome(c);
        }).catch((e: Error) => log(job.id, `The checkpoint stays on ${on!.label} only (${e.message.slice(0, 160)})`));
      }
      job.state = "paused";
      job.progress.stage = "";
      job.progress.share = null;
      await log(job.id, `Paused at step ${job.progress.step}`);
    } else {
      const e = err as Error & { hint?: string; code?: string };
      job.state = "error";
      job.progress.stage = "";
      job.progress.share = null;
      job.error = { message: plainError(e.message), ...(e.hint ? { hint: e.hint } : {}), ...(e.code ? { code: e.code } : {}) };
      await log(job.id, `Stopped: ${e.message}`);
      console.warn(`[train] ${job.name} (${job.id}) stopped: ${e.message}`);
    }
  } finally {
    job.progress.notice = null;
    if (job.progress.runningSince) {
      job.progress.ranMs = (job.progress.ranMs ?? 0) + Math.max(0, Date.now() - job.progress.runningSince);
      job.progress.runningSince = null;
    }
    if (job.run?.pausing) job.run = { ...job.run, pausing: undefined };
    await touch(job, true);
  }
}
g.__crackioTrainDrive = drive;

class Paused extends Error {}

const isFile = (p: string) =>
  fs
    .stat(/*turbopackIgnore: true*/ p)
    .then((s) => (s.isFile() ? s.size : 0))
    .catch(() => 0);
const statePath = (job: TrainJob) => jobPath(job.id, "state", "state.pt");

/**
 * What the run carries on from, copied from the machine (the current target) to this computer, with the versions saved
 * so far that aren't here yet.
 */
async function keepHome(c: Ctx) {
  const { job, say } = c;
  const probe = await stateProbe(job.id);
  if (!probe) throw new TrainFail(`Crackio's helper on ${c.machine.label} is too old to hand the run over.`, "Connect the machine again under Settings → Machines, then move the run.", "NODE");
  if (!probe.state) throw new TrainFail(`${c.machine.label} keeps nothing of this run to carry on from.`, "Start it over on the machine you want.");
  // (Room for it first: on a disk too full it broke off half-way, and Crackio's own notes then couldn't be written.)
  const free = await fs
    .statfs(/*turbopackIgnore: true*/ jobPath(job.id))
    .then((s) => Number(s.bavail) * Number(s.bsize))
    .catch(() => null);
  if (free !== null && free < probe.bytes + HOME_ROOM) throw new TrainFail("This computer's disk is too full to keep a copy of the run's checkpoint.", "Free some room on this computer, then pause or move the run again.");
  say(`Bringing the checkpoint home from ${c.machine.label}`, 0);
  const bytes = await fetchState(job.id, statePath(job), (n) => say(`Bringing the checkpoint home from ${c.machine.label}`, n));
  await c.live.homing?.catch(() => undefined);
  for (const k of job.checkpoints) {
    if (k.home === false || !(await isFile(jobPath(job.id, "lora", k.file)))) say(`Bringing home the version saved at step ${k.step}`);
    await versionHome(job, k).catch(() => undefined);
  }
  job.run = { ...job.run, home: { step: job.progress.step, bytes } };
  await log(job.id, `Kept a copy of the checkpoint (step ${job.progress.step}, ${(bytes / 1024 ** 2).toFixed(0)} MB) on this computer`);
  await touch(job, true);
}

/** The first part of a move: the state home from the machine the run is on, then the job on the new one. */
async function move(job: TrainJob, l: Live, say: Ctx["say"], note: Ctx["note"]) {
  const to = job.run!.moveTo!;
  const targets = await comfyTargets();
  const dest = targets.find((t) => t.id === to);
  const from = targets.find((t) => t.id === job.machine);
  try {
    if (!dest) throw new TrainFail("The machine to move to isn't one of yours any more.", "Pick another one.");
    const have = job.run?.home?.step === job.progress.step && (await isFile(statePath(job))) > 0;
    if (job.progress.step > 0 && !have) {
      if (!from) throw new TrainFail("The machine that holds this run's checkpoint isn't one of yours any more, and Crackio has no copy of it.", "Start it over on the machine you want (a new LoRA with the same pictures).");
      job.state = "saving";
      const machine = (await planMachine(from.id)) ?? { id: from.id, label: from.label, where: "", kind: "lan" as const, online: true, gpu: null, ramGb: null, accel: null, diskFreeGb: null, pricePerHour: null, metered: false };
      const c: Ctx = { job, live: l, target: from, machine, say, note, needsState: true };
      await withTarget(from, async () => {
        if (!(await answers())) throw new TrainFail(`${from.label} holds this run's checkpoint and isn't answering.`, "Start it once so Crackio can bring the checkpoint home, then move the run.");
        await helper(c);
        await keepHome(c);
      });
      if (l.stop) throw new Paused();
    }
  } catch (err) {
    // Not moved: the run stays where it was, to try again or carry on there.
    job.run = { ...job.run, moveTo: undefined };
    throw err;
  }
  job.machine = to;
  // The trainer there counts its log lines from one.
  l.lastSeq = 0;
  // On the new machine nothing is prepared yet, and the state goes there before the next stretch.
  // (Its turn too: without it a moved run went by when the LoRA was made, and didn't wait for the run already
  // training there.)
  job.run = { weights: job.run?.weights, lrScale: job.run?.lrScale, home: job.run?.home, carry: job.progress.step > 0 || undefined, askedAt: job.run?.askedAt };
  job.progress.pace = null;
  job.planned = undefined;
  await note(`Moved from ${from?.label ?? "its old machine"} to ${dest.label}: it carries on from step ${job.progress.step}`);
  await touch(job, true);
}

/** The second part: the copy at home sent to the machine the run is on now, with the versions saved so far. */
async function carry(c: Ctx) {
  const { job, say } = c;
  if (!job.run?.carry) return;
  const kept = statePath(job);
  if (!(await isFile(kept))) throw new TrainFail("The checkpoint to carry on from isn't on this computer any more.", "Start it over, or move it back to the machine it was on.");
  job.state = "uploading";
  say(`Sending the checkpoint to ${c.machine.label}`, 0);
  await sendState(kept, job.id, (n) => say(`Sending the checkpoint to ${c.machine.label}`, n), c.live.abort.signal);
  // The versions saved before the move, so one of them can still become the LoRA.
  for (const k of job.checkpoints) {
    const file = jobPath(job.id, "lora", k.file);
    if (!(await isFile(file))) continue;
    say(`Sending the version saved at step ${k.step} to ${c.machine.label}`);
    await sendLora(file, k.file, undefined, c.live.abort.signal).catch(() => undefined);
  }
  job.run = { ...job.run, carry: undefined };
  await log(job.id, `Sent the checkpoint (step ${job.progress.step}) to ${c.machine.label}`);
  await touch(job, true);
}

/** The trainer's own error text ("CRACKIO_TRAIN_OOM: out of GPU memory…") as a sentence. */
function plainError(message: string) {
  const m = /CRACKIO_TRAIN_[A-Z]+:\s*([^\n]+)/.exec(message);
  const text = (m ? m[1] : message).trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const CLOUD_NAME = { runpod: "RunPod", vast: "vast.ai" } as const;

/** The credit on the cloud account that bills a machine (a rented box, a RunPod endpoint); null for your own machines. */
async function creditOf(target: ComfyTarget, fresh = false) {
  const provider = target.serverless || target.metered === "runpod" ? "runpod" : target.cloud?.provider;
  if (provider !== "runpod" && provider !== "vast") return null;
  const { creditNow, creditFresh } = await import("../setup/cloud-money");
  const all = fresh ? await creditFresh().catch(() => creditNow()) : creditNow();
  return all.find((x) => x.provider === provider) ?? null;
}

/**
 * While a run trains on a rented GPU, once a minute: when the account's credit won't last the run it's said on the page,
 * and with six minutes of it left the run is paused. A cloud stops the GPU at zero, mid-step (a run died at step 30
 * that way): paused first, what's trained is saved there and brought to this computer, to carry on after a top-up or
 * on another machine.
 */
async function creditWatch(c: Ctx, kind: "prepare" | "train" | "final") {
  const { job, live: l, note } = c;
  const p = job.progress;
  const credit = await creditOf(c.target).catch(() => null);
  if (!credit || credit.until === null) {
    p.notice = null;
    return;
  }
  const name = CLOUD_NAME[credit.provider];
  const minutes = Math.max(0, (credit.until - Date.now()) / 60_000);
  const total = p.steps || job.settings.steps;
  const versionsLeft = job.settings.previews ? saveSteps(job.settings).filter((s) => s > p.step).length + 1 : 0;
  const need = p.pace ? (Math.max(0, total - p.step) * p.pace) / 60 + versionsLeft : null;
  p.notice =
    need !== null && minutes < need * 1.15
      ? `Your ${name} credit lasts about ${formatDuration(minutes * 60)} at this rate, and this run needs about ${formatDuration(need * 60)} more. Top up, or Crackio pauses it just before the credit runs out and keeps what's trained.`
      : null;
  if (kind === "train" && minutes < 6 && !l.stop && p.step > 0) {
    l.stop = "pause";
    job.run = { ...job.run, pausing: "pause" };
    p.stage = "Pausing after this step";
    await note(`Your ${name} credit is nearly used up ($${Math.max(0, credit.balance).toFixed(2)} left): paused here, with what's trained kept on this computer. Top up, then press Carry on (or move the run)`);
  }
}

async function steps(c: Ctx) {
  const { job, say } = c;
  // A rented GPU with no credit left doesn't run: said here, not as a machine that "isn't answering".
  const credit = await creditOf(c.target, true).catch(() => null);
  if (credit && credit.balance <= 0) {
    const name = CLOUD_NAME[credit.provider];
    throw new TrainFail(`Your ${name} credit is used up, so ${c.machine.label} can't run.`, `Top up at ${name}, start the machine (Settings → Machines), then press Try again.`, "CREDIT");
  }
  await awake(c);
  await helper(c);
  // The machine as it is now that it answers. Looked at before it did (a box just started, a ComfyUI brought back),
  // its GPU wasn't known, and the run was planned as if anything fitted it.
  for (let i = 0; i < 6 && !c.target.serverless && !c.machine.gpu?.memoryGb; i++) {
    if (i) await sleep(5000);
    stopCheck(c);
    c.machine = (await planMachine(c.target.id, true).catch(() => null)) ?? c.machine;
  }

  // The plan: Crackio's picks (for the settings still on auto) with what this machine allows, fixed for the run.
  if (!job.run?.prepared && job.progress.step === 0) {
    const profileBase = await resolveBase(job.base!, c.machine, { resolution: job.settings.resolution, rank: job.settings.rank });
    const plan = planFor({ goal: job.goal, images: job.images, profile: profileBase?.profile ?? null, fit: profileBase?.fit, memoryGb: c.machine.gpu?.memoryGb });
    job.settings = resolvedSettings(job, plan);
  }
  let base = await baseFor(c);
  if (base.fit.state === "no" && c.machine.gpu?.memoryGb) throw new TrainFail(`${base.profile.name} doesn't train on ${c.machine.label}: ${base.fit.why.toLowerCase()}.`, "Pick a machine with more GPU memory, or a smaller model.");
  if (base.fit.offload && !job.settings.offload) job.settings.offload = true;
  if (base.fit.resolution < job.settings.resolution && job.auto.includes("resolution")) job.settings.resolution = base.fit.resolution;
  job.run = { ...job.run, weights: base.weights.id };
  job.progress.steps = job.settings.steps;
  const facts = setFacts(job.images, job.settings.resolution, job.goal);
  const estimate = estimateTraining({ profile: base.profile, weights: base.weights, machine: c.machine, gpuKey: c.machine.gpu ? gpuKeyOf(c.machine.gpu.name) : undefined, settings: job.settings, facts, offload: job.settings.offload, records: await paceRecords() });
  job.planned ??= { seconds: estimate?.seconds ?? 0, machine: c.machine.label, gpu: c.machine.gpu?.name ?? null, pricePerHour: c.machine.pricePerHour };
  // What a step should take here, to tell a GPU that runs far slower than it should (train()).
  // Only where the estimate stands on a real run (this card's, or another's scaled): a table's guess can be off by as much.
  if (estimate?.parts.steps && estimate.basis !== "table" && job.settings.steps > job.progress.step) job.run = { ...job.run, expectPace: estimate.parts.steps / Math.max(1, job.settings.steps - job.progress.step), expectFrom: estimate.basis };
  else if (job.run?.expectPace) job.run = { ...job.run, expectPace: undefined, expectFrom: undefined };
  await log(job.id, `${job.name}: ${facts.count} ${job.goal === "edit" ? "before and after pairs" : "pictures"}, ${base.profile.name} (${base.weights.label}) on ${c.machine.label}, ${job.settings.steps} steps at ${job.settings.resolution} px, size ${job.settings.rank}`);
  await touch(job, true);

  // The picture model for the test pictures comes down alongside the training weights, before anything trains.
  const drawer = drawerReady(c, base);
  await files(c, base);
  await drawer;
  await captions(c);
  stopCheck(c);

  for (let round = 0; ; round++) {
    try {
      await sendPictures(c);
      await prepare(c, base);
      await carry(c);
      await train(c, base);
      break;
    } catch (err) {
      if (err instanceof Paused) throw err;
      const again = await remedy(c, err as TrainFail, base);
      if (!again || round > 12) throw err;
      // (On the weights it began on: a way out of too little memory doesn't send the run to other files.)
      if (again === "rebase") base = await baseFor(c, true);
    }
  }
  say("Bringing the LoRA home");
  job.state = "saving";
  await home(c, base);
}

function stopCheck(c: Ctx) {
  if (c.live.stop === "pause") throw new Paused();
}

/** `keep`: on the weights the run began on (a run with steps behind it always is). */
async function baseFor(c: Ctx, keep = c.job.progress.step > 0): Promise<ResolvedBase> {
  const { job } = c;
  const facts = setFacts(job.images, job.settings.resolution, job.goal);
  let custom: number | undefined;
  if (job.base!.kind === "custom") {
    const list = await getJson<{ models?: { folder: string; name: string; bytes: number }[] }>("/crackio/train/models", 20_000);
    const mine = list?.models?.find((m) => m.folder === (job.base as { folder: string }).folder && m.name === (job.base as { file: string }).file);
    if (list?.models && !mine) throw new TrainFail(`${(job.base as { file: string }).file} isn't in ${c.machine.label}'s models folder any more.`, "Put the file back, or pick another model.");
    custom = mine?.bytes;
  }
  const base = await resolveBase(job.base!, c.machine, { resolution: job.settings.resolution, rank: job.settings.rank, meanMp: facts.meanMp, customBytes: custom, ...(keep && job.run?.weights ? { weights: job.run.weights } : {}) });
  if (!base) throw new TrainFail("Crackio doesn't know how to train that model.", "Pick another model.");
  return base;
}

/**
 * A run that waits its turn gets its model's training files onto the machine meanwhile. Whatever goes wrong here (no
 * room on the disk, a gated repo, the machine not answering) is left for the run's own turn to say and to answer.
 */
async function fetchAhead(job: TrainJob, l: Live, target: ComfyTarget, say: Ctx["say"], note: Ctx["note"]) {
  try {
    const machine = await planMachine(target.id);
    if (!machine?.online || !job.base) return;
    const c: Ctx = { job, live: l, target, machine, say, note, needsState: false };
    await withTarget(target, async () => {
      const base = await baseFor(c);
      if (base.missing.length && !base.unknown.length) await files(c, base);
    });
  } catch (err) {
    if (err instanceof Paused) throw err;
  }
}

/* -------------------------------------------------- 1. the machine answers */

/**
 * A machine that answers now is looked at afresh: Crackio's last look at one that was off says "not answering" for a
 * while longer, and with it every model file there counted as missing (a run on a ComfyUI started a second ago went to
 * download a model it had, and was told the machine wasn't answering).
 */
async function seenAgain(target: ComfyTarget) {
  const [{ machineLook }, { forgetInstalled }] = await Promise.all([import("../machine-probe"), import("../local-models")]);
  await machineLook(target, { fresh: true }).catch(() => null);
  forgetInstalled();
}

/** Whether a rented box's ComfyUI process is gone (asked over SSH; false when that can't tell). */
async function downOnBox(target: ComfyTarget): Promise<boolean> {
  const login = target.cloud?.ssh;
  if (!login) return false;
  const { sshRun } = await import("../ssh");
  const res = await sshRun(login, 'pgrep -f "[m]ain.py" >/dev/null && echo CRACKIO_UP || echo CRACKIO_DOWN', { timeoutMs: 30_000 }).catch(() => null);
  return Boolean(res?.stdout.includes("CRACKIO_DOWN"));
}

/**
 * A rented box whose ComfyUI went down: started again the way it was started (the helper keeps that as a script on the
 * box, 1.12.2 and later), else by restarting the pod at RunPod. True once ComfyUI answers again. Their images start
 * ComfyUI once and never again: without this a run waited half an hour on a box that was up and idle.
 */
async function bringBack(c: Ctx): Promise<boolean> {
  const { target, say, note } = c;
  if (!target.cloud || !(await downOnBox(target))) return false;
  // Back means the whole of it: it answers and its helper's nodes are loaded, twice in a row (a ComfyUI still coming
  // up answers its first questions before the rest is there).
  const waitUp = async (seconds: number) => {
    let ready = 0;
    for (let i = 0; i < seconds / 4; i++) {
      await sleep(4000);
      stopCheck(c);
      ready = (await answers()) && (await hasNode("CrackioTrainLora").catch(() => false)) ? ready + 1 : 0;
      if (ready >= 2) return true;
    }
    return false;
  };
  say(`Starting ComfyUI on ${c.machine.label} again`);
  const { sshRun } = await import("../ssh");
  const res = await sshRun(target.cloud.ssh!, 'f=$(ls -t ~/.crackio/relaunch-*.sh 2>/dev/null | head -1); if [ -n "$f" ]; then bash "$f"; else echo CRACKIO_NO_SCRIPT; fi', { timeoutMs: 60_000 }).catch(() => null);
  if (res?.stdout.includes("CRACKIO_RELAUNCHED") && (await waitUp(240))) {
    await note(`ComfyUI on ${c.machine.label} had gone down: started it again`);
    return true;
  }
  if (target.cloud.provider === "runpod" && target.cloud.instance) {
    const key = (await getSettings()).keys.runpod;
    if (key) {
      say(`Restarting ${c.machine.label} at RunPod`);
      const { podAction } = await import("../runpod-pods");
      const asked = await podAction(key, target.cloud.instance, "restart").then(
        () => true,
        () => false,
      );
      if (asked && (await waitUp(600))) {
        // A restarted pod is on other SSH ports: its login follows, in this run and in your machines (the next look
        // over SSH, or a helper update, went to the old port).
        const { getPod, directSsh } = await import("../runpod-pods");
        const login = await getPod(key, target.cloud.instance).then(
          (p) => (p ? directSsh(p) : null),
          () => null,
        );
        const had = target.cloud.ssh;
        if (login && had && (login.host !== had.host || login.port !== had.port)) {
          target.cloud.ssh = login;
          const instance = target.cloud.instance;
          const { updateSettings } = await import("../settings");
          await updateSettings((st) => ({ ...st, comfyMachines: (st.comfyMachines ?? []).map((m) => (m.cloud?.provider === "runpod" && m.cloud.instance === instance ? { ...m, cloud: { ...m.cloud, ssh: login } } : m)) })).catch(() => undefined);
        }
        await note(`ComfyUI on ${c.machine.label} had gone down: restarted the pod at RunPod`);
        return true;
      }
    }
  }
  return false;
}

async function awake(c: Ctx) {
  const { target, say, note } = c;
  say(`Checking ${c.machine.label}`);
  if (await answers()) return seenAgain(target);
  const here = target.id === "this-computer" || target.source === "installed";
  if (here) {
    say("Starting ComfyUI on this computer");
    const { startComfy } = await import("../comfy-install");
    await startComfy().catch((err: Error) => {
      throw new TrainFail(`ComfyUI on this computer wouldn't start: ${err.message}`, "Start it under Settings → Machines, then press Resume.", "OFFLINE");
    });
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      if (await answers()) {
        await seenAgain(target);
        await note("ComfyUI on this computer was stopped: started it");
        return;
      }
    }
  } else {
    // A rented box or a computer on your network that blinked: a few more looks before it counts as off.
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      if (await answers()) return seenAgain(target);
    }
    // Up, with its ComfyUI gone: brought back.
    if (await bringBack(c)) return seenAgain(target);
  }
  throw new TrainFail(`${c.machine.label} isn't answering.`, here ? "Start ComfyUI under Settings → Machines, then press Resume." : "Start the machine (Settings → Machines), then press Resume.", "OFFLINE");
}

/* -------------------------------------------------- 2. its helper has the trainer */

async function helper(c: Ctx) {
  const { target, say, note } = c;
  // Up to date: it has the trainer, (for a run that moves) it hands over and takes a run's state, and it's as new as
  // this model's training needs (Qwen-Image 2.1 trains through code that came with helper 1.13).
  const needs = [BRIDGE_FEATURES.trainSafe, profileById(c.job.base?.family)?.helper, c.job.goal === "edit" ? BRIDGE_FEATURES.trainEdit : undefined].filter((v): v is string => Boolean(v));
  const need = needs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const ready = async () =>
    (await hasNode("CrackioTrainLora")) &&
    (!c.needsState || (await stateProbe(c.job.id).catch(() => null)) !== null) &&
    (!need || versionAtLeast((await getJson<{ version?: string }>("/crackio/info", 8000))?.version, need));
  if (await ready()) return;
  if (target.serverless) {
    throw new TrainFail("This RunPod endpoint's worker doesn't have Crackio's trainer yet.", "Update the endpoint to Crackio's latest worker (docs/SERVERLESS.md), or train on another machine.", "NODE");
  }
  const waitFor = async (seconds: number) => {
    for (let i = 0; i < seconds / 4; i++) {
      await sleep(4000);
      if (await ready()) return true;
    }
    return false;
  };
  if (target.id === "this-computer" || target.source === "installed") {
    say("Updating Crackio's helper on this computer");
    const { updateLocalBridge } = await import("../comfy-install");
    await updateLocalBridge().catch((err: Error) => {
      throw new TrainFail(`Crackio's helper on this computer couldn't be updated: ${err.message}`, "Try again once ComfyUI is idle.");
    });
    if (await waitFor(180)) return void (await note("Crackio's helper on this computer was out of date: updated it and restarted ComfyUI"));
  } else if (target.cloud?.ssh) {
    say(`Updating Crackio's helper on ${c.machine.label}`);
    const { startConnect, connectJob } = await import("../cloud-gpu");
    const cj = startConnect({ ssh: target.cloud.ssh, provider: target.cloud.provider, instance: target.cloud.instance, label: target.label });
    for (let i = 0; i < 150; i++) {
      await sleep(4000);
      const now = connectJob(cj.id);
      if (!now || now.state !== "running") {
        if (now?.state === "error") throw new TrainFail(`Crackio's helper on ${c.machine.label} couldn't be updated: ${now.error ?? "the box didn't take it"}`, "Connect the machine again under Settings → Machines, then press Resume.");
        break;
      }
    }
    if (await waitFor(120)) return void (await note(`Crackio's helper on ${c.machine.label} was out of date: updated it`));
  }
  throw new TrainFail(`Crackio's helper on ${c.machine.label} is too old to train.`, target.cloud?.ssh ? "Connect the machine again under Settings → Machines, then press Resume." : "Copy comfyui/crackio_bridge into its ComfyUI's custom_nodes folder and restart it, then press Resume.", "NODE");
}

/* -------------------------------------------------- 3. the model's files are there */

async function files(c: Ctx, base: ResolvedBase) {
  const { job, target, say, note } = c;
  if (base.unknown.length) throw new TrainFail(`${c.machine.label} is missing ${base.unknown.join(", ")}, and Crackio doesn't know where to get it.`, `Set up ${base.profile.name} on that machine first (Settings → Tools).`);
  if (!base.missing.length) return;
  job.state = "starting";
  const total = base.missing.reduce((n, f) => n + f.bytes, 0);
  if (base.profile.gated && !(await getSettings()).keys.hf?.trim() && !process.env.HF_TOKEN) {
    throw new TrainFail(`${base.profile.name}'s weights need your Hugging Face token.`, `Accept its licence at huggingface.co/${base.profile.gated}, then add your token under Settings → Accounts.`);
  }
  const { planInstall } = await import("../storage");
  const room = await planInstall(target.id, base.missing.map((f) => ({ folder: f.folder, bytes: f.bytes }))).catch(() => null);
  if (room && !room.ok) throw new TrainFail(room.reason ?? `${c.machine.label} doesn't have room for the model.`, "Free some space under Settings → Storage, then press Resume.");
  const { installFile, forgetInstalled, installedFiles, localStatus } = await import("../local-models");
  say(`Downloading ${base.profile.name}'s training weights (${(total / GIB).toFixed(1)} GB)`, 0);
  await log(job.id, `Downloading to ${c.machine.label}: ${base.missing.map((f) => `${f.name} (${(f.bytes / GIB).toFixed(1)} GB)`).join(", ")}`);
  for (const f of base.missing) {
    await installFile(f, target.id).catch((err: Error) => {
      throw new TrainFail(`Couldn't download ${f.name}: ${err.message}`);
    });
  }
  const names = base.missing.map((f) => `${f.folder}/${f.name}`);
  let stalled = 0;
  let last = -1;
  for (;;) {
    await sleep(4000);
    stopCheck(c);
    forgetInstalled();
    const have = await installedFiles().catch(() => new Set<string>());
    if (names.every((n) => have.has(n))) break;
    const status = await localStatus().catch(() => null);
    const downloads = status?.targets.find((t) => t.id === target.id)?.downloads ?? [];
    const mine = downloads.filter((d) => names.includes(`${d.folder}/${d.filename}`));
    const failed = mine.find((d) => d.state === "error");
    if (failed) {
      const gated = /401|403|gated|accept/i.test(failed.error ?? "");
      throw new TrainFail(`Couldn't download ${failed.filename}: ${failed.error ?? "the download failed"}`, gated && base.profile.gated ? `Accept its licence at huggingface.co/${base.profile.gated} with the account your token is from, then press Resume.` : "Press Resume to try again.");
    }
    const got = mine.reduce((n, d) => n + d.received, 0) + base.missing.filter((f) => have.has(`${f.folder}/${f.name}`)).reduce((n, f) => n + f.bytes, 0);
    say(`Downloading ${base.profile.name}'s training weights (${(total / GIB).toFixed(1)} GB)`, Math.min(0.99, got / total));
    stalled = got === last ? stalled + 1 : 0;
    last = got;
    // A rented box stopped or deleted at its cloud mid-download won't finish it: said at once, not after ten minutes.
    if (stalled > 0 && stalled % 12 === 0 && target.cloud?.instance && !(await answers())) {
      const list = await import("../cloud-accounts").then((m) => m.rentedBoxes()).catch(() => null);
      const box = list?.boxes.find((b) => b.id === target.cloud!.instance);
      if (list && !list.errors[target.cloud.provider as "vast" | "runpod"] && (!box || (!box.ready && !box.starting))) {
        throw new TrainFail(box ? `${c.machine.label} was stopped at its cloud.` : `${c.machine.label} is gone from your account.`, box ? "Start it again (Settings → Machines), then press Try again." : "Pick another machine, then start again.", "STOPPED");
      }
    }
    // Ten minutes without a byte (a serverless endpoint fetches in one job and reports nothing meanwhile: an hour there).
    if (stalled > (target.serverless ? 900 : 150)) throw new TrainFail(`The download to ${c.machine.label} stopped.`, "Check the machine's connection, then press Resume.");
  }
  await note(`Downloaded ${base.profile.name}'s training weights to ${c.machine.label} (${(total / GIB).toFixed(1)} GB)`);
}

/* -------------------------------------------------- 4. captions */

const CAPTION_RULES: Record<TrainJob["goal"], (noun: string) => string> = {
  person: (noun) =>
    `You caption a photo for training an image model on one specific person${noun ? ` (${noun})` : ""}. Describe everything EXCEPT who the person is: never their face, hair, skin, age, body or any feature that belongs to them. Describe what they wear, their pose and expression, the framing (close-up, full body…), the place, the background, the light, and whether it's a photo, a selfie, a drawing… One plain sentence, 15 to 40 words, no preamble. Refer to the person as "the person".`,
  character: (noun) =>
    `You caption a picture for training an image model on one specific character or animal${noun ? ` (${noun})` : ""}. Describe everything EXCEPT the character's own design (its shape, colours, markings, face): its pose and what it's doing, the framing, the place, the background, the light and the medium (photo, 3D render, drawing…). One plain sentence, 15 to 40 words, no preamble. Refer to it as "the character".`,
  object: (noun) =>
    `You caption a photo for training an image model on one specific object${noun ? ` (${noun})` : ""}. Describe everything EXCEPT the object's own design (its shape, colours, materials, labels): where it sits, the angle it's seen from, hands or people with it, the background, the light, and the kind of shot. One plain sentence, 15 to 40 words, no preamble. Refer to it as "the object".`,
  edit: () => "",
  style: () =>
    `You caption a picture for training an image model on an art style. Describe only WHAT the picture shows: the subjects, what they do, the setting, the composition. Never mention the style, the medium, the colours, the line work, the mood or the lighting technique: those are what the model must learn by itself. One plain sentence, 12 to 35 words, no preamble.`,
};

/**
 * Captions for the pictures that have none, when the run asks Crackio to write them. A LoRA trained without captions
 * learns far less (a style LoRA trained that way once turned its subjects into photos and needed 1.3 strength to show),
 * so nothing here falls back in silence: if a picture can't be read, the run stops before anything trains and says why,
 * and the user decides (set a reader up, write them, or train with the trigger word alone on purpose).
 *
 * The first picture goes alone: with no model that can read it, the run stops seconds in. The reader on the training
 * machine is asked first; a caption written is kept, so a run started again only writes the ones still missing.
 */
async function captions(c: Ctx) {
  const { job, say } = c;
  // (An edit LoRA's words are its instruction: there's nothing to describe.)
  if (job.goal === "edit") return;
  const set = job.images.filter((i) => !i.skip);
  const worded = set.filter((i) => i.caption?.trim());
  const yours = worded.filter((i) => i.captionBy === "you").length;
  if (job.settings.captions !== "auto") {
    await log(job.id, worded.length ? `Captions: ${worded.length} of ${set.length} pictures go in with one; the rest train with the trigger word alone, as you chose` : `Captions: none. Every picture trains with the trigger word alone, as you chose`);
    return;
  }
  const todo = job.images.filter((i) => !i.skip && !i.caption?.trim());
  if (!todo.length) {
    await log(job.id, `Captions: all ${set.length} pictures go in with one (${yours === worded.length ? "written by you" : yours ? `${yours} of them written by you` : "written by Crackio"})`);
    return;
  }
  job.state = "uploading";
  const [{ askText, freshTextModels }, { forgetLocalLlms }] = await Promise.all([import("@/lib/engines/refine"), import("@/lib/engines/comfy-text")]);
  // Which models can read a picture is looked up anew: the list other questions use can be from before this machine
  // came up, or from before the model's own text encoder (its picture reader) was downloaded a moment ago.
  const lookAgain = async () => {
    forgetLocalLlms();
    await freshTextModels();
  };
  await lookAgain();
  const rules = CAPTION_RULES[job.goal](job.noun.trim());
  const stand = job.goal === "person" ? "the person" : job.goal === "character" ? "the character" : job.goal === "object" ? "the object" : null;
  let why: string[] = [];
  const write = async (image: (typeof todo)[number]) => {
    const failed: string[] = [];
    // Who wrote it is kept with the picture: a LoRA can say afterwards which model described what it trained on.
    let writer: string | undefined;
    const ask = () =>
      askText({ instructions: rules, text: "Caption the picture.", references: [{ path: jobPath(job.id, "images", image.file), label: "the picture" }], imageEdge: 768, effort: "low", timeoutMs: 90_000, signal: c.live.abort.signal, machine: c.machine.id, failed, answeredBy: (name: string) => void (writer = name) } as Parameters<typeof askText>[0])
        .catch(() => null)
        .then((answer) => (answer ?? "").replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim());
    let text = await ask();
    // A text model on a GPU that's only just loading can answer nothing once (seen on a fresh RTX 5090): asked again.
    if (text.length < 12 && !c.live.abort.signal.aborted) text = await ask();
    if (text.length < 12 || text.length >= 600) {
      if (failed.length) why = [...new Set(failed)].slice(0, 4);
      return false;
    }
    // "the person" becomes the trigger and its noun where the caption is put together (plan `captionFor`).
    image.caption = stand ? text.replace(new RegExp(`\\b${stand}\\b`, "gi"), subjectWords(job)).trim() : text;
    image.captionBy = "crackio";
    if (writer) image.captionModel = writer.slice(0, 60);
    return true;
  };
  const stop = async (written: number) => {
    await touch(job, true);
    const reason = why.length ? ` ${why.join("; ")}.` : "";
    await log(job.id, `Captions: ${written} of ${todo.length} written.${reason} Stopped before training.`);
    throw new TrainFail(
      written ? `Captions were written for only ${written} of ${todo.length} pictures, so training didn't start.` : "No model could read your pictures to write their captions, so training didn't start.",
      `${why.length ? `${why.join("; ")}. ` : ""}A LoRA trained without captions learns much less. Set a picture reader up on ${c.machine.label}, write the captions yourself, or train with the trigger word alone.`,
      "CAPTIONS",
    );
  };

  await log(job.id, `Writing captions for ${todo.length} pictures`);
  say(`Writing captions · 1 of ${todo.length}`, 0);
  if (!(await write(todo[0]))) {
    stopCheck(c);
    // Once more after a short wait and a new look, before the run is stopped over it.
    say("Looking for a model that can read the pictures", 0);
    await new Promise((r) => setTimeout(r, 15_000));
    stopCheck(c);
    await lookAgain();
    if (!(await write(todo[0]))) {
      stopCheck(c);
      await stop(0);
    }
  }
  let done = 1;
  let next = 1;
  // Three in a row that fail: whatever was reading the pictures has gone (a box stopped, credits ran out).
  let inRow = 0;
  const missing: typeof todo = [];
  const worker = async () => {
    for (;;) {
      const image = todo[next++];
      if (!image) return;
      if (c.live.stop === "pause" || c.live.abort.signal.aborted) return;
      if (inRow >= 3) {
        missing.push(image);
        continue;
      }
      if (await write(image)) inRow = 0;
      else {
        inRow++;
        missing.push(image);
      }
      done++;
      say(`Writing captions · ${done} of ${todo.length}`, done / todo.length);
    }
  };
  await Promise.all([worker(), worker()]);
  stopCheck(c);
  // One more go at the ones that failed (a model that was loading, a busy GPU), unless the reader is plainly gone.
  if (missing.length && inRow < 3) {
    for (const image of missing) {
      stopCheck(c);
      say(`Writing captions · trying ${missing.length === 1 ? "one" : "a few"} again`, null);
      await write(image);
    }
  }
  const written = todo.filter((i) => i.caption?.trim()).length;
  if (written < todo.length) await stop(written);
  await log(job.id, `Captions written for all ${todo.length} pictures`);
  await touch(job, true);
}

/* -------------------------------------------------- 5. the pictures go up */

const inputName = (job: TrainJob, file: string) => `crackio/train/${job.id}/${file}`;

async function sendPictures(c: Ctx) {
  const { job, say } = c;
  const set = trainingSet(job);
  job.state = "uploading";
  let sent = 0;
  for (const [n, s] of set.entries()) {
    stopCheck(c);
    say(`Sending pictures to ${c.machine.label} · ${n + 1} of ${set.length}`, n / set.length);
    // A pair goes as its two pictures.
    for (const [file, from] of [[s.image.file, s.path], ...(s.source && s.image.source ? [[s.image.source.file, s.source]] : [])]) {
      if (await inputThere(inputName(job, file))) continue;
      await upload(await fs.readFile(/*turbopackIgnore: true*/ from), file, `crackio/train/${job.id}`, c.live.abort.signal);
      sent++;
    }
  }
  if (sent) await log(job.id, `Sent ${sent} pictures to ${c.machine.label}`);
}

/* -------------------------------------------------- 6. the machine prepares them */

async function prepare(c: Ctx, base: ResolvedBase) {
  const { job, say } = c;
  const set = trainingSet(job);
  const items = set.map((s) => ({ file: inputName(job, s.image.file), caption: s.caption, ...(s.source && s.image.source ? { source: inputName(job, s.image.source.file) } : {}) }));
  const key = createHash("sha1").update(JSON.stringify([signatureOf(base), job.settings.resolution, items])).digest("hex").slice(0, 16);
  if (job.run?.prepared === key) return;
  job.state = "preparing";
  say("Preparing the pictures", 0);
  await runGraph(c, prepareGraph(job, base, items, job.settings.resolution), "prepare");
  job.run = { ...job.run, prepared: key };
  await touch(job, true);
}

/* -------------------------------------------------- 7. training, a stretch at a time */

type TrainOut = { step: number; steps: number; done: boolean; loss?: number | null; pace?: number | null; peak_gb?: number; saved?: { step: number; file: string; bytes: number; loss: number }[]; seconds?: number; file?: string; bytes?: number; losses?: [number, number][]; log?: [number, string][] };

function mergeSaved(job: TrainJob, saved: TrainOut["saved"]) {
  for (const s of saved ?? []) {
    const had = job.checkpoints.find((k) => k.step === s.step);
    // (Saved again at the same step with other weights, after a stretch was trained again: the copy at home is behind.)
    if (had) Object.assign(had, { file: s.file, bytes: s.bytes, loss: s.loss }, had.home && (had.file !== s.file || had.bytes !== s.bytes || had.loss !== s.loss) ? { home: false } : {});
    else job.checkpoints.push({ step: s.step, file: s.file, bytes: s.bytes, loss: s.loss });
  }
  job.checkpoints.sort((a, b) => a.step - b.step);
}

/**
 * A stretch of training starts on a clean GPU: ComfyUI lets go of every model and of what it keeps from the jobs before
 * (its own "free memory", what its Unload button does). The trainer unloads models itself, but not what ComfyUI holds
 * for the last graph it ran: after pictures drawn with a reference on Qwen-Image 2.1 that was about 10 GB, and a
 * training on FLUX 3 Klein ran out of memory at its first step on a 24 GB card.
 */
async function clearGpu(c: Ctx) {
  if (c.target.serverless) return;
  await postJson("/free", { unload_models: true, free_memory: true }, 10_000).catch(() => null);
  await sleep(3000);
}

/**
 * The model that draws the test pictures, started downloading as the training begins when the machine doesn't have it
 * (a GPU rented a minute ago): by the first saved version it's there. Till now it was fetched at that first version,
 * with the training standing still for it (13 GB of Krea 2 Turbo took minutes of a paid GPU doing nothing).
 */
/**
 * The picture model a run's test pictures are drawn with, when it's on the machine. The machine is asked afresh, a few
 * times: the list other pages keep can be a quarter of an hour old for a box that was slow to answer (a rented 3090
 * across an ocean, busy taking a file), and by that list a model that finished downloading at 16:09 still "wasn't
 * there" at 16:29. The run then waited 16 minutes on an idle, billing GPU and drew no test pictures at all.
 */
async function drawerHere(c: Ctx, base: ResolvedBase) {
  const [{ allLocalModels }, { hasModelHere, forgetInstalled }, { machineLook }] = await Promise.all([import("../local-templates"), import("../local-models"), import("../machine-probe")]);
  const models = allLocalModels();
  // Whether the machine answered at all: one that didn't (a busy box across an ocean answers in 1 to 7 s, and the look
  // gives up at 6) has an unknown list of files, not an empty one.
  let answered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const look = await machineLook(c.target, { fresh: true }).catch(() => null);
    if (look?.stats) answered = true;
    forgetInstalled();
    for (const id of base.profile.uses) {
      const m = models.find((x) => x.id === id && x.crackio);
      if (m && (await hasModelHere(m).catch(() => false))) return { model: m, answered: true };
    }
    if (attempt < 2) await sleep(5000);
  }
  return { model: null, answered };
}

/** Why a run has no test pictures (yet), said on its page and in its log. Never a reason to stop training. */
async function noPictures(c: Ctx, why: string) {
  c.job.run = { ...c.job.run, noPreviews: why };
  await c.note(`${why}. Training goes on; the test pictures are drawn as soon as the model is there`);
}

/**
 * Before training: the picture model for the test pictures is on the machine, or is downloaded there now, next to the
 * training weights (a few GB more, while the GPU waits for those anyway). What can't be set up is said now, with the
 * reason, not at the first saved version. Never throws: test pictures are a look, not the LoRA.
 */
async function drawerReady(c: Ctx, base: ResolvedBase) {
  const { job, target, say, note } = c;
  if (!job.settings.previews || target.serverless || !base.profile.uses.length) return;
  const quit = () => Boolean(c.live.stop) || c.live.abort.signal.aborted;
  try {
    // A run started again looks again: what was missing last time may be there now.
    if (job.run?.noPreviews) job.run = { ...job.run, noPreviews: undefined };
    if ((await drawerHere(c, base)).model) return;
    const [{ allLocalModels }, { installModel, forgetInstalled, installedFiles, localStatus }] = await Promise.all([import("../local-templates"), import("../local-models")]);
    const models = allLocalModels();
    const name = models.find((x) => x.id === base.profile.uses[0])?.name ?? base.profile.name;
    const pick = drawerToSetUp(c, base, models);
    if (!pick) return await noPictures(c, `Test pictures need ${name} on ${c.machine.label}, and none of its versions runs there as it is (set one up under Settings → Tools)`);
    forgetInstalled();
    const before = await installedFiles().catch(() => new Set<string>());
    const missing = pick.variant.files.filter((f) => !before.has(`${f.folder}/${f.name}`));
    // What the training weights' download brings anyway isn't a second download: SDXL's one checkpoint was logged twice,
    // 6.5 GB each, and read as 13 GB.
    const coming = new Set(base.missing.map((f) => `${f.folder}/${f.name}`));
    const extra = missing.filter((f) => !coming.has(`${f.folder}/${f.name}`));
    const total = extra.reduce((n, f) => n + f.bytes, 0);
    const names = pick.variant.files.map((f) => `${f.folder}/${f.name}`);
    const version = `${pick.model.name} (${pick.variant.label})`;
    await log(
      job.id,
      extra.length
        ? `Downloading to ${c.machine.label} for the test pictures: ${version}, ${extra.map((f) => `${f.name} (${(f.bytes / GIB).toFixed(1)} GB)`).join(", ")}${extra.length < missing.length ? "; the rest comes with the training weights" : ""}`
        : missing.length
          ? `The test pictures use ${version}: ${missing.length === 1 ? "its file comes" : "its files come"} with the training weights, nothing more to download`
          : `The test pictures use ${version}: its files are on ${c.machine.label}`,
    );
    try {
      await installModel(pick.model.id, pick.variant.id, target.id);
    } catch (err) {
      return await noPictures(c, `Test pictures need ${pick.model.name} on ${c.machine.label}, and it couldn't be set up there (${(err as Error).message.slice(0, 200)})`);
    }
    let stalled = 0;
    let last = -1;
    for (;;) {
      await sleep(4000);
      if (quit()) return;
      forgetInstalled();
      const have = await installedFiles().catch(() => new Set<string>());
      if (names.every((n) => have.has(n))) break;
      const status = await localStatus().catch(() => null);
      const mine = (status?.targets.find((t) => t.id === target.id)?.downloads ?? []).filter((d) => names.includes(`${d.folder}/${d.filename}`));
      const failed = mine.find((d) => d.state === "error");
      if (failed) return await noPictures(c, `Test pictures need ${pick.model.name} on ${c.machine.label}, and ${failed.filename} couldn't be downloaded (${(failed.error ?? "the download failed").slice(0, 200)})`);
      const got = mine.reduce((n, d) => n + d.received, 0);
      // (The training weights' own line shows while they come down; this one once they're there.)
      if (job.state !== "starting" && total) say(`Downloading ${pick.model.name} for the test pictures (${(total / GIB).toFixed(1)} GB)`, Math.min(0.99, got / total));
      stalled = got === last ? stalled + 1 : 0;
      last = got;
      // Ten minutes without a byte: training doesn't wait on it any longer.
      if (stalled > 150) return await noPictures(c, `Test pictures need ${pick.model.name} on ${c.machine.label}, and its download stopped`);
    }
    // (Nothing of its own downloaded: nothing was done that needs saying.)
    if (extra.length) await note(`Set ${pick.model.name} up on ${c.machine.label} for the test pictures (${(total / GIB).toFixed(1)} GB)`);
  } catch (err) {
    if (!quit()) await log(job.id, `Setting the test pictures' model up didn't work (${(err as Error).message.slice(0, 160)})`).catch(() => undefined);
  }
}

/** The version of the family's picture model to set up on a machine that has none: the smallest that runs there as it is. */
function drawerToSetUp(c: Ctx, base: ResolvedBase, models: LocalModel[]) {
  return pickDrawer(base.profile.uses, c.machine.gpu, models);
}

async function train(c: Ctx, base: ResolvedBase) {
  const { job, say, target } = c;
  const settings = job.settings;
  const saves = saveSteps(settings);
  for (;;) {
    stopCheck(c);
    if (c.live.stop === "finish") break;
    const step = job.progress.step;
    if (step >= settings.steps && !job.run?.fresh) break;
    const next = saves.find((s) => s > (job.run?.fresh ? 0 : step)) ?? settings.steps;
    job.state = "training";
    say(step ? "Training" : "Loading the model");
    const config = trainConfig(job, base, settings, { stopAt: settings.previews ? next : settings.steps, budget: target.serverless ? 20 * 60 : 60 * 60, fresh: job.run?.fresh, lrScale: job.run?.lrScale }, { export: false });
    if (job.run?.fresh) {
      job.checkpoints = [];
      job.progress.step = 0;
      job.progress.losses = [];
      // The versions of the attempt before, kept here, go with it.
      await c.live.homing?.catch(() => undefined);
      await fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "lora"), { recursive: true, force: true }).catch(() => undefined);
    }
    let out: TrainOut;
    try {
      await clearGpu(c);
      out = (await runGraph(c, trainGraph(job, base, config), "train")) as TrainOut;
    } catch (err) {
      // Asked to finish on a machine that can only cancel (a serverless endpoint): the LoRA is made from what it kept.
      if (err instanceof Paused && (c.live.stop as Live["stop"]) === "finish") break;
      throw err;
    }
    job.run = { ...job.run, fresh: undefined };
    absorb(job, out);
    void versionsHome(c);
    // Far slower than this card should be (a rented RTX 5090 held back by its host ran at a third of its speed, slower
    // than an A40): said once, with the way out.
    // Only on good evidence, since people follow it: a hundred steps in (30 steps of a 3-picture SDXL run counted the
    // start-up and read as "6 times slower, move your run"), and against a run on this very card. An expectation carried
    // over from another card's run has to be missed by more, and says so.
    const expected = job.run.expectPace;
    const own = job.run.expectFrom !== "scaled";
    if (out.pace && expected && out.pace > expected * (own ? 2.2 : 3.5) && !job.run.slowSaid && job.progress.step >= 100) {
      job.run.slowSaid = true;
      const times = (out.pace / expected).toFixed(1).replace(/\.0$/, "");
      await c.note(
        own
          ? `${c.machine.label} takes ${out.pace.toFixed(1)} s a step, about ${times} times longer than Crackio expected for this card: ${
              target.cloud ? "its host may be holding the GPU back. You can pause and move the run to another machine" : "other programs may be using the GPU"
            }`
          : `${c.machine.label} takes ${out.pace.toFixed(1)} s a step, about ${times} times longer than Crackio guessed from runs on other cards. The guess may be off for this model here${target.cloud ? ", or its host is holding the GPU back: if a card of this kind was faster for you before, you can pause and move the run" : ""}`,
      );
    }
    if (out.pace && c.machine.gpu) {
      const facts = setFacts(job.images, settings.resolution, job.goal);
      await recordPace({ family: base.profile.id, weights: base.weights.id, gpu: gpuKeyOf(c.machine.gpu.name), speed: machineSpeed(c.machine), mp: facts.meanMp, pace: out.pace, offload: settings.offload, peakGb: out.peak_gb ?? null, at: Date.now() });
    }
    await touch(job, true);
    if (out.done) break;
    // A version was just saved: test pictures with it, unless you asked to pause or finish.
    const fresh = job.checkpoints.find((k) => k.step === out.step && !k.previews);
    if (settings.previews && fresh && !c.live.stop) await previews(c, base, fresh);
  }
  // (Read afresh: the stop is set from outside while the loop above waits.)
  if ((c.live.stop as Live["stop"]) === "finish") {
    // Stopped early on purpose: the LoRA is what's trained so far.
    if (job.progress.step < settings.steps) {
      settings.steps = Math.max(1, job.progress.step);
      job.progress.steps = settings.steps;
      job.auto = job.auto.filter((k) => k !== "steps");
    }
    c.live.stop = null;
  }
  // The LoRA under its own name (a run that reached its end has it already; one finished early gets it made now).
  const config = trainConfig(job, base, settings, { stopAt: settings.steps, budget: 0 }, { finalize: true, export: Boolean(target.serverless) });
  say("Saving the LoRA");
  const out = (await runGraph(c, trainGraph(job, base, config), "final")) as TrainOut & { files?: { filename: string; subfolder?: string; type?: string }[] };
  if (!out.file) throw new TrainFail("The machine didn't save the LoRA.");
  job.result = { file: out.file, bytes: out.bytes ?? 0, step: out.step, kept: false, on: [target.id] };
  job.progress.step = out.step;
  if (out.step < settings.steps) job.progress.steps = settings.steps = out.step;
  c.exported = out.files?.[0];
  if (settings.previews) await previews(c, base, { step: out.step, file: out.file, bytes: out.bytes ?? 0, loss: job.progress.loss }, true);
}

function absorb(job: TrainJob, out: TrainOut) {
  job.progress.step = out.step;
  if (out.loss != null) job.progress.loss = out.loss;
  if (out.pace) job.progress.pace = out.pace;
  if (out.peak_gb) job.progress.peakGb = Math.max(job.progress.peakGb ?? 0, out.peak_gb);
  if (out.losses?.length) job.progress.losses = out.losses;
  if (out.seconds) job.progress.trainedSeconds += out.seconds;
  mergeSaved(job, out.saved);
}

/* -------------------------------------------------- running one ComfyUI job and following it */

const STAGE: Record<string, string> = { preparing: "Preparing the pictures", prepared: "Pictures prepared", loading: "Loading the model", training: "Training", paused: "Saved a version", done: "Saving the LoRA" };

/** What the trainer said (its status over ComfyUI's websocket, or asked for) taken into the job. */
async function heard(c: Ctx, data: Record<string, unknown>) {
  const { job, live: l } = c;
  if (data.job !== job.id) return;
  const p = job.progress;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const phase = typeof data.phase === "string" ? data.phase : "";
  if (num(data.others_gb) !== null) p.othersGb = num(data.others_gb);
  if (phase === "preparing" && num(data.pictures)) {
    p.stage = `Preparing the pictures · ${num(data.prepared) ?? 0} of ${num(data.pictures)}`;
    p.share = (num(data.prepared) ?? 0) / (num(data.pictures) ?? 1);
  } else if (phase && STAGE[phase] && !l.stop) {
    p.stage = STAGE[phase];
    p.share = null;
  }
  if (phase === "training" || phase === "loading") {
    const step = num(data.step);
    if (step !== null && (step >= p.step || job.run?.fresh)) p.step = step;
    if (num(data.steps)) p.steps = num(data.steps)!;
    if (num(data.loss) !== null) p.loss = num(data.loss);
    if (num(data.pace)) p.pace = num(data.pace);
    if (num(data.peak_gb)) p.peakGb = Math.max(p.peakGb ?? 0, num(data.peak_gb)!);
    if (Array.isArray(data.losses) && data.losses.length) p.losses = data.losses as [number, number][];
    if (phase === "training" && step) p.trainingAt ??= Date.now();
  }
  // (Starting over, the trainer goes on naming the versions of the attempt before until it saves its first: only
  // the ones it has reached again are taken.)
  if (Array.isArray(data.saved)) {
    const upTo = job.run?.fresh ? (num(data.step) ?? 0) : Infinity;
    mergeSaved(
      job,
      (data.saved as NonNullable<TrainOut["saved"]>).filter((v) => v.step <= upTo),
    );
  }
  if (job.checkpoints.some((k) => !k.home)) void versionsHome(c);
  if (Array.isArray(data.log)) {
    // (An older message can arrive after a newer one: its lines are behind the place kept, and stay out. The place
    // starts over only where the trainer's count does: on another machine, in `move`.)
    const lines = (data.log as [number, string][]).filter(([seq]) => seq > l.lastSeq);
    if (lines.length) {
      l.lastSeq = lines[lines.length - 1][0];
      job.run = { ...job.run, logSeq: l.lastSeq };
      // The machine's clock is its own (a rented box keeps UTC): lines are stamped as they arrive here.
      await log(job.id, ...lines.map(([, text]) => text.replace(/^\d\d:\d\d:\d\d /, "")));
    }
  }
  void touch(job);
}

/**
 * Queues a graph on the machine and waits for it, taking in what the trainer says meanwhile. A job the notes say is
 * already there (Crackio restarted mid-run) is followed, not queued twice. Returns the trainer node's own answer.
 */
async function runGraph(c: Ctx, graph: Graph, kind: "prepare" | "train" | "final"): Promise<Record<string, unknown>> {
  const { job, live: l, target, say } = c;
  let promptId = job.run?.kind === kind ? job.run.promptId : undefined;
  if (promptId) {
    // One that's over and failed is not followed again: ComfyUI keeps a failed job in its history, so the stretch asked
    // for again after a way out (part of the model in RAM, half the learning rate, a fresh start) or by Try again was
    // answered with the old failure three seconds later, and nothing ran. Out of memory so skipped its first way out
    // and went straight to a smaller picture size.
    const known = await historyOf(promptId);
    const failed = known && known !== "unreachable" && known.status?.status_str === "error";
    const queued = known ? null : await inQueue(promptId);
    if (failed || (!known && (!queued || queued.state === "gone"))) promptId = undefined;
  }
  if (!promptId) {
    promptId = randomUUID();
    job.run = { ...job.run, promptId, kind };
    await touch(job, true);
    // (The trainer keeps a stop it was asked for until a step honours it, so one asked while its model loads isn't
    // lost. One that came too late for its stretch is taken back here, or this stretch would stop at its first step.)
    if (kind === "train" && !l.stop && !target.serverless) await postJson("/crackio/train/stop", { job: job.id, clear: true }, 10_000).catch(() => null);
    await queue(graph, promptId, `Training ${job.name}`);
  }
  const serverless = Boolean(target.serverless);
  const close = listen((m: Heard) => {
    if (m.type === "train") void heard(c, m.data);
    // A serverless worker passes on only ComfyUI's step counter: the trainer's counts steps of the whole run.
    else if (m.type === "progress" && serverless && m.promptId === promptId && kind === "train" && m.max === job.settings.steps) {
      if (m.value > job.progress.step) job.progress.step = m.value;
      job.progress.trainingAt ??= Date.now();
      void touch(job);
    }
  });
  let asked = false;
  let gone = 0;
  let silent = 0;
  let polls = 0;
  try {
    for (;;) {
      await sleep(3000);
      polls++;
      if (l.stop && !asked && kind !== "final") {
        asked = true;
        const res = serverless ? null : await postJson("/crackio/train/stop", { job: job.id, finish: l.stop === "finish" }, 15_000).catch(() => null);
        // A machine without the route (a serverless endpoint): its job is cancelled; what was kept there stays.
        if (!res?.ok) await cancel(promptId);
      }
      const h = await historyOf(promptId);
      if (h === "unreachable") {
        // Nothing can be asked of a machine that doesn't answer: a pause takes effect now (what it kept stays there).
        if (l.stop === "pause") throw new Paused();
        silent++;
        // This computer's ComfyUI silent for half a minute with its process gone: it went down (a GPU error inside
        // PyTorch takes the whole process with it). Answered now, not after half an hour of looking.
        if (silent >= 8 && silent % 8 === 0 && (target.id === "this-computer" || target.source === "installed")) {
          const running = await import("../comfy-install").then((m) => m.setupStatus()).then(
            (s) => s.running,
            () => true,
          );
          if (!running) throw new TrainFail(`ComfyUI on this computer went down while ${kind === "prepare" ? "preparing the pictures" : "training"}.`, undefined, "CRASHED");
        }
        // A rented box that's up with its ComfyUI gone (it went down: out of RAM, a GPU error): answered now.
        if (target.cloud?.ssh && silent >= 20 && silent % 20 === 0 && (await downOnBox(target))) {
          throw new TrainFail(`ComfyUI on ${c.machine.label} went down while ${kind === "prepare" ? "preparing the pictures" : "training"}.`, undefined, "CRASHED");
        }
        // A rented box that was stopped or deleted at its cloud won't answer again by waiting.
        if (target.cloud?.instance && silent >= 40 && silent % 60 === 40) {
          const list = await import("../cloud-accounts").then((m) => m.rentedBoxes()).catch(() => null);
          const box = list?.boxes.find((b) => b.id === target.cloud!.instance);
          if (list && !list.errors[target.cloud.provider as "vast" | "runpod"] && (!box || (!box.ready && !box.starting))) {
            const kept = job.run?.home?.step === job.progress.step && job.progress.step > 0;
            throw new TrainFail(
              box ? `${c.machine.label} was stopped at its cloud.` : `${c.machine.label} is gone from your account.`,
              kept ? `Step ${job.progress.step} is kept on this computer: press Move to another machine to carry on elsewhere.` : box ? "Start it again (Settings → Machines), then press Try again." : "Start it over on another machine.",
              "STOPPED",
            );
          }
        }
        // Otherwise the machine trains on by itself; Crackio keeps looking for half an hour before it gives the run up.
        if (silent > 600) throw new TrainFail(`Lost contact with ${c.machine.label}.`, "Check the machine, then press Resume: what it trained is kept there.", "OFFLINE");
        if (silent === 5) say(`Lost contact with ${c.machine.label}: still trying`);
        continue;
      }
      silent = 0;
      if (h) {
        if (h.status?.status_str === "error") {
          // It's over: the next stretch is a new job there.
          job.run = { ...job.run, promptId: undefined, kind: undefined };
          const messages = h.status.messages ?? [];
          const failed = messages.find(([k]) => k === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
          if (!failed && messages.some(([k]) => k === "execution_interrupted")) {
            if (l.stop) throw new Paused();
            throw new TrainFail("The run was interrupted on the machine.", undefined, "INTERRUPTED");
          }
          const text = (failed?.exception_message ?? "ComfyUI failed.").trim();
          if (/Cancelled\.?$/.test(text) && l.stop) throw new Paused();
          const code = /CRACKIO_TRAIN_([A-Z]+)/.exec(text)?.[1] ?? (/out of memory|OutOfMemory/i.test(text) ? "OOM" : /time limit|TIMED_OUT/i.test(text) ? "TIMEOUT" : /Value not in list|not in \(list/i.test(text) ? "FILES" : undefined);
          throw new TrainFail(text.split("\n")[0].slice(0, 500), undefined, code);
        }
        const outs = Object.values(h.outputs ?? {});
        const result = outs.flatMap((o) => (Array.isArray(o.crackio_train) ? (o.crackio_train as Record<string, unknown>[]) : [])).at(-1) ?? {};
        const exported = outs.flatMap((o) => (Array.isArray(o.crackio_files) ? (o.crackio_files as { filename: string }[]) : []));
        if (Array.isArray(result.log)) await heard(c, { job: job.id, log: result.log });
        job.run = { ...job.run, promptId: undefined, kind: undefined };
        return { ...result, ...(exported.length ? { files: exported } : {}) };
      }
      if (polls % 20 === 0) await creditWatch(c, kind);
      const q = await inQueue(promptId);
      if (q?.state === "waiting") say(serverless ? "Waiting for a GPU on RunPod" : `In ${c.machine.label}'s queue · ${q.ahead} ahead`);
      if (q?.state === "gone") {
        if (++gone >= 8) throw new TrainFail(`ComfyUI on ${c.machine.label} lost the job (it restarted?).`, undefined, "LOST");
      } else gone = 0;
      // What a missed message would have said (machines whose helper answers for it).
      if (!serverless && polls % 4 === 0) {
        const st = await getJson<Record<string, unknown>>(`/crackio/train/status?job=${job.id}&from=${l.lastSeq}`, 10_000);
        if (st && st.phase) await heard(c, { ...st, job: job.id });
      }
    }
  } finally {
    close();
  }
}

/* -------------------------------------------------- when something goes wrong */

/**
 * Answers a failure with the next thing worth trying, says so in the job's notes, and returns whether to go again
 * ("rebase": with the model's files looked at afresh). Null: nothing left to try.
 */
async function remedy(c: Ctx, err: TrainFail, base: ResolvedBase): Promise<"again" | "rebase" | null> {
  const { job, note, say } = c;
  const code = err.code ?? "";
  const tried = (job.run ??= {}).tried ?? (job.run.tried = {});
  const count = (k: string) => (tried[k] = (tried[k] ?? 0) + 1);
  const s = job.settings;
  await log(job.id, `Problem: ${err.message}`);

  // The same three steps for every way of having too little GPU memory: the trainer ran out (OOM), other programs
  // hold too much of the card (CROWDED), or ComfyUI went down with a GPU error as the training started (CRASHED).
  const others = job.progress.othersGb ?? 0;
  const wayOut =
    others >= 1
      ? `Other programs are using ${others.toFixed(1)} GB of this GPU: close them (a game, a 3D app, a browser with many tabs) and press Try again, or train on another machine.`
      : "Train on a machine with more GPU memory, or pick a smaller model.";
  // ("rebase": what the run needs of the GPU is worked out again for the new settings, on the same weights. Sent as
  // it stood, the trainer refused a crowded card the same way whatever was made smaller.)
  const tighter = async (lead: string, startOver = true): Promise<"rebase"> => {
    if (!s.offload) {
      s.offload = true;
      job.auto = job.auto.filter((k) => k !== "offload");
      await note(`${lead}: now keeping part of the model in RAM (slower, but it needs less)`);
      return "rebase";
    }
    const smaller = [...RESOLUTIONS].reverse().find((r) => r <= s.resolution * 0.8 && r >= 512);
    if (smaller) {
      await note(`${lead}: training at ${smaller} px instead of ${s.resolution} px`);
      s.resolution = smaller;
      job.auto = job.auto.filter((k) => k !== "resolution");
      job.run!.prepared = undefined;
      return "rebase";
    }
    // Other programs holding the card isn't a reason to throw away what's trained and start over smaller: said, with
    // the way out that's yours (close them).
    if (!startOver) throw new TrainFail(`Other programs leave too little of ${c.machine.label}'s GPU memory for this training.`, wayOut, "CROWDED");
    if (s.rank > 8) {
      await note(`${lead}: making the LoRA smaller (size ${s.rank} to ${s.rank / 2}) and starting the training over`);
      s.rank = Math.max(8, Math.round(s.rank / 2));
      job.auto = job.auto.filter((k) => k !== "rank");
      job.run!.fresh = true;
      return "rebase";
    }
    throw new TrainFail(`${base.profile.name} doesn't fit ${c.machine.label}'s GPU memory, even made as small as it goes with part of it in RAM.`, wayOut, "OOM");
  };
  if (code === "OOM") return tighter(`${c.machine.label} ran out of GPU memory`);
  if (code === "CROWDED") return tighter(`Other programs are using ${others.toFixed(1)} GB of ${c.machine.label}'s GPU, which leaves too little`, false);
  if (code === "CRASHED") {
    if (count("CRASHED") > 5) return null;
    // Its ComfyUI is started again (and its helper looked at) before anything else.
    await awake(c);
    await helper(c);
    if (job.progress.step > 0 && tried.CRASHED === 1) {
      await note(`ComfyUI on ${c.machine.label} went down mid-run: started it again, carrying on from what it kept`);
      return "again";
    }
    return tighter(`ComfyUI on ${c.machine.label} went down with a GPU error as the training started (nearly always too little free GPU memory)`);
  }
  if (code === "NAN") {
    if (count("NAN") > 2) return null;
    job.run.lrScale = (job.run.lrScale ?? 1) * 0.5;
    await note("The loss stopped being a number: carrying on from the last good state at half the learning rate");
    return "again";
  }
  if (code === "DATA") {
    if (count("DATA") > 1) return null;
    job.run.prepared = undefined;
    await note("The prepared pictures on the machine were gone: preparing them again");
    return "again";
  }
  if (code === "GONE") {
    if (count("GONE") > 1) return null;
    const home = job.run.home;
    if (home && (await isFile(statePath(job))) > 0) {
      job.run.carry = true;
      await note(`${c.machine.label} keeps nothing of this run any more: sending it the checkpoint kept on this computer (step ${home.step}), to carry on from there`);
      return "again";
    }
    // Stopped during its first stretch, before anything was saved (ComfyUI interrupted or restarted, out of memory
    // at step 31 of a run that first saves at step 80): there is nothing to carry on from and nothing to lose, so
    // it trains again from the first step. It used to end here with "start a new LoRA with the same pictures".
    if (!job.checkpoints.length) {
      job.run.fresh = true;
      await note(`${c.machine.label} had saved nothing of this run yet (it stopped at step ${job.progress.step}, before its first save): training again from the first step`);
      return "again";
    }
    throw new TrainFail(
      `${c.machine.label} keeps nothing of this run any more (it was at step ${job.progress.step}), and there's no copy of its checkpoint on this computer.`,
      job.checkpoints.some((k) => k.home) ? "Finish it with one of its saved versions (Versions, below), or start a new LoRA with the same pictures." : "Start a new LoRA with the same pictures.",
      "GONE",
    );
  }
  if (code === "STATE") {
    if (count("STATE") > 1) return null;
    job.run.fresh = true;
    await note("What was kept from the last run doesn't fit these settings: starting the training over");
    return "again";
  }
  if (code === "NODE") {
    if (count("NODE") > 1) return null;
    await helper(c);
    return "again";
  }
  if (code === "FILES") {
    if (count("FILES") > 1) return null;
    await note("A model file the run needs wasn't where ComfyUI looks: fetching it again");
    const { forgetInstalled } = await import("../local-models");
    forgetInstalled();
    const fresh = await baseFor(c, true);
    await files(c, fresh);
    return "rebase";
  }
  if (code === "LOST" || code === "OFFLINE" || code === "INTERRUPTED" || code === "TIMEOUT") {
    if (count("LOST") > 4) return null;
    // Gone at the very start for the third time: ComfyUI there goes down as the training begins (a rented box's
    // supervisor starts it again at once, so it never looks stopped). Said as that, not as a job that got lost.
    if (code === "LOST" && job.progress.step === 0 && tried.LOST >= 3) {
      throw new TrainFail(`ComfyUI on ${c.machine.label} goes down every time this training starts.`, "Update ComfyUI on that machine (Settings → Machines), or train on another one. Its own log there says what took it down.", "CRASHED");
    }
    say(`Waiting for ${c.machine.label} to answer again`);
    for (let i = 0; i < 120; i++) {
      if (await answers()) break;
      stopCheck(c);
      await sleep(5000);
    }
    if (!(await answers())) return null;
    await seenAgain(c.target);
    await helper(c);
    await note(code === "TIMEOUT" ? "The stretch ran past the machine's time limit: carrying on from what it kept" : `${c.machine.label}'s ComfyUI restarted mid-run: carrying on from what it kept`);
    return "again";
  }
  return null;
}

/* -------------------------------------------------- test pictures */

async function previews(c: Ctx, base: ResolvedBase, version: TrainCheckpoint, final = false) {
  const { job, target, say, note } = c;
  const stateBefore = job.state;
  try {
    const found = await drawerHere(c, base).catch(() => ({ model: null, answered: false }));
    const drawer = found.model;
    if (!drawer) {
      // Not waited for here: a rented GPU isn't left idle mid-run over a look (it once was, for 16 minutes). This
      // version's pictures are drawn when the model is there: at the next saved version, or at the end.
      if (!found.answered) {
        // The machine didn't say what it has: nothing is claimed about the model.
        await note(`${c.machine.label} didn't answer when the test pictures at step ${version.step} were due: they're drawn at the next saved version. Training goes on`);
        return;
      }
      if (!job.run?.noPreviews) {
        const { allLocalModels } = await import("../local-templates");
        const name = allLocalModels().find((x) => x.id === base.profile.uses[0])?.name ?? base.profile.name;
        await noPictures(c, `Test pictures need ${name} set up on ${c.machine.label} (Settings → Tools)`);
      }
      await log(job.id, `No test pictures at step ${version.step} yet: their model isn't on ${c.machine.label}`);
      return;
    }
    if (job.run?.noPreviews) job.run = { ...job.run, noPreviews: undefined };
    job.state = "previewing";
    const [{ resolveModel }, { engineFor }, { forgetLoraFiles }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry"), import("@/lib/engines/comfy-local")]);
    const def = await resolveModel("image", drawer.crackio!);
    const engine = def.via ? engineFor(def.via) : null;
    if (!engine) throw new Error(`${def.name} has no engine`);
    forgetLoraFiles();
    // An edit LoRA's test pictures: before pictures redone with the instruction (the ones in no pair first: the model
    // never saw their after picture; else the first two pairs').
    const tests: { prompt: string; before?: string; ratio?: number }[] =
      job.goal === "edit"
        ? [
            ...job.images.filter((i) => i.waiting).map((i) => ({ prompt: captionFor(job, {}), before: jobPath(job.id, "images", i.file), ratio: i.width / i.height })),
            ...trainingSet(job).filter((s) => s.source).map((s) => ({ prompt: s.caption, before: s.source!, ratio: s.image.source!.width / s.image.source!.height })),
          ].slice(0, 2)
        : testPrompts(job).map((prompt) => ({ prompt }));
    // An edit is drawn in its before picture's shape (the nearest of Crackio's), at about a megapixel: square, a tall
    // picture came back re-framed.
    const shapeOf = (ratio?: number) => {
      const a = ratio ? [...ASPECTS].sort((x, y) => Math.abs(Math.log(x.w / x.h / ratio)) - Math.abs(Math.log(y.w / y.h / ratio)))[0] : ASPECTS[0];
      const r = a.w / a.h;
      const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
      return { aspect: a.id, width: snap(Math.sqrt(1.05e6 * r)), height: snap(Math.sqrt(1.05e6 / r)) };
    };
    const draw = async (lora: string | null, tag: string, step = version.step) => {
      const urls: string[] = [];
      for (const [i, { prompt, before, ratio }] of tests.entries()) {
        const shape = shapeOf(before ? ratio : undefined);
        say(`Drawing test pictures${lora ? ` at step ${step}` : " without the LoRA"} · ${i + 1} of ${tests.length}`);
        const result = await engine.run(
          {
            kind: "image",
            model: def.model,
            via: def.via ?? undefined,
            family: def.family,
            caps: def.caps ?? undefined,
            options: { machine: target.id, seed: 4242 + i, megapixels: 1, ...(lora ? { loras: [{ file: lora, strength: base.profile.strength }] } : {}) },
            prompt,
            userPrompt: prompt,
            refine: false,
            aspect: shape.aspect,
            width: shape.width,
            height: shape.height,
            count: 1,
            references: before ? [{ path: before }] : [],
            mode: "image",
          },
          { signal: c.live.abort.signal, progress: () => undefined },
        );
        const name = `${tag}-${i}.webp`;
        await fs.mkdir(/*turbopackIgnore: true*/ jobPath(job.id, "previews"), { recursive: true });
        await sharp(result.outputs[0].data).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toFile(jobPath(job.id, "previews", name));
        urls.push(`/api/train/${job.id}/file/previews/${name}?v=${Date.now().toString(36)}`);
      }
      return urls;
    };
    if (!job.baseline?.length) job.baseline = await draw(null, "base");
    const urls = await draw(version.file, final ? "final" : `step-${version.step}`);
    const kept = job.checkpoints.find((k) => k.step === version.step);
    if (kept) kept.previews = urls;
    else if (final) job.checkpoints.push({ ...version, previews: urls });
    // Versions saved while the model wasn't there get their pictures now (their files are still on the machine).
    for (const k of job.checkpoints) {
      if (k.previews?.length || k.step === version.step || c.live.stop || c.live.abort.signal.aborted) continue;
      const late = await draw(k.file, `step-${k.step}`, k.step).catch(() => null);
      if (late) {
        k.previews = late;
        await log(job.id, `Drew the test pictures the version at step ${k.step} was still missing`);
      }
    }
    if (final && job.result) job.result.works = await differs(job, "base-0.webp", "final-0.webp");
    await log(job.id, `Drew ${urls.length} test pictures at step ${version.step}`);
  } catch (err) {
    if (c.live.abort.signal.aborted) throw err;
    // Test pictures are a look, never a reason to stop training.
    await note(`Test pictures at step ${version.step} didn't work (${(err as Error).message.slice(0, 160)}): training goes on`);
  } finally {
    job.state = stateBefore;
    await touch(job, true);
  }
}

/** Whether two test pictures (same prompt, same seed) differ visibly: a LoRA that loads but changes nothing gives twins. */
async function differs(job: TrainJob, a: string, b: string): Promise<boolean | null> {
  try {
    // (Read into memory first: sharp keeps a file it opened by name open, and on Windows a run deleted right after it
    // finished failed with "resource busy" on these two pictures.)
    const small = async (f: string) => sharp(await fs.readFile(/*turbopackIgnore: true*/ jobPath(job.id, "previews", f))).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer();
    const [x, y] = await Promise.all([small(a), small(b)]);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
    return sum / x.length / 255 > 0.015;
  } catch {
    return null;
  }
}

/* -------------------------------------------------- saved versions come home */

/** Room left on this computer's disk once a version is copied to it. */
const HOME_ROOM = 2 * 1024 ** 3;
class DiskFull extends Error {}

/** A machine that can be gone when you pick a version: another computer, or a rented GPU. (This one keeps them itself.) */
const away = (c: Ctx) => c.machine.kind === "lan" || c.machine.kind === "rented";

/** One saved version copied from the machine (the current target) into Crackio's own folder here, unless it's there. */
async function versionHome(job: TrainJob, k: TrainCheckpoint): Promise<boolean> {
  const file = jobPath(job.id, "lora", k.file);
  if (k.home !== false && (await isFile(file))) return (k.home = true);
  const free = await fs
    .statfs(/*turbopackIgnore: true*/ jobPath(job.id))
    .then((s) => Number(s.bavail) * Number(s.bsize))
    .catch(() => null);
  if (free !== null && free < k.bytes + HOME_ROOM) throw new DiskFull();
  await fetchLora(k.file, file, k.bytes);
  return (k.home = true);
}

/**
 * The versions saved so far, copied to this computer while the training goes on (a copy needs no GPU). The best version
 * is often not the last, and a rented machine can be gone before you've picked: a GPU stopped for the night went to
 * someone else with steps 800 and 1,000 of a LoRA on it, where step 800 had looked best and only the last was here. One
 * pass at a time. `last` (the run is over) waits for it, tries once more what didn't get through, and says what stays on
 * the machine only.
 */
function versionsHome(c: Ctx, last = false): Promise<void> {
  const { job, live: l } = c;
  if (!away(c)) return Promise.resolve();
  const tried = (l.homeTried ??= new Map<string, number>());
  const pass = async (all: boolean) => {
    const seen = new Set<string>();
    for (;;) {
      const k = job.checkpoints.find((v) => !v.home && v.file !== job.result?.file && !seen.has(v.file) && (all || (!l.homeFull && (tried.get(v.file) ?? 0) < 2)));
      if (!k) return;
      seen.add(k.file);
      try {
        await versionHome(job, k);
        await log(job.id, `The version saved at step ${k.step} is on this computer too`);
        void touch(job);
      } catch (err) {
        tried.set(k.file, (tried.get(k.file) ?? 0) + 1);
        if (err instanceof DiskFull) l.homeFull = true;
      }
    }
  };
  // (Asked of the run's machine by name: started from a message of the machine's, the copy isn't left to find out
  // which one "the" ComfyUI is.)
  if (!last) {
    if (!l.homing) {
      const going: Promise<void> = withTarget(c.target, () => pass(false)).finally(() => {
        if (l.homing === going) l.homing = undefined;
      });
      l.homing = going;
    }
    return l.homing;
  }
  return (async () => {
    await l.homing?.catch(() => undefined);
    if (job.checkpoints.some((k) => !k.home && k.file !== job.result?.file)) c.say("Copying the saved versions to this computer");
    await withTarget(c.target, () => pass(true));
    const left = job.checkpoints.filter((k) => !k.home && k.file !== job.result?.file).length;
    if (left) await c.note(`${left === 1 ? "One saved version stays" : `${left} saved versions stay`} on ${c.machine.label} only (${l.homeFull ? "this computer's disk is nearly full" : "the copy didn't get through"}): pick the version you want before that machine goes`);
  })();
}

/** One thing at a time with a job's version files: copying them and picking one, asked together, wrote the same files. */
async function oneAtATime<T>(id: string, work: () => Promise<T>): Promise<T> {
  const busy = (g.__crackioTrainVersions ??= new Set<string>());
  if (busy.has(id)) throw new TrainRefused("Its versions are being copied or changed right now: wait a moment.");
  busy.add(id);
  try {
    return await work();
  } finally {
    busy.delete(id);
  }
}

/** The machine lets go of what it holds in memory: a LoRA file changed under its name is read again, not remembered. */
const letGo = () => postJson("/free", { unload_models: true, free_memory: true }, 10_000).catch(() => null);

/**
 * A run's saved versions copied to this computer from the machine it trained on, asked for by hand: for a run from
 * before Crackio did that as it trains, or one whose copies didn't get through.
 */
export const keepVersions = (id: string) => oneAtATime(id, () => keepVersionsNow(id));

async function keepVersionsNow(id: string): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job || !job.machine || !job.checkpoints.length) throw new TrainRefused("That LoRA has no saved versions yet.", 404);
  if (live.has(id)) throw new TrainRefused("It's training: its versions are copied as they're saved.");
  const target = (await comfyTargets()).find((t) => t.id === job.machine);
  if (!target) throw new TrainRefused("The machine it trained on isn't one of yours any more.");
  if (target.serverless) throw new TrainRefused("Versions on a RunPod endpoint can't be copied yet.");
  let copied = 0;
  let failed: Error | null = null;
  await withTarget(target, async () => {
    if (!(await answers())) throw new TrainRefused(`${target.label} isn't answering: start it first.`);
    for (const k of job.checkpoints) {
      if (k.file === job.result?.file) {
        k.home = Boolean(job.result?.kept);
        continue;
      }
      const had = k.home === true;
      try {
        await versionHome(job, k);
        if (!had) copied++;
        await touch(job, true);
      } catch (err) {
        if (err instanceof DiskFull) throw new TrainRefused("This computer's disk is nearly full: free some room, then copy them again.", 507);
        failed = err as Error;
      }
    }
  });
  if (copied) await log(job.id, `${copied === 1 ? "One saved version is" : `${copied} saved versions are`} on this computer now`);
  await touch(job, true);
  if (failed) throw new TrainRefused(`${target.label} didn't hand every version over (${(failed as Error).message.slice(0, 140)}).`, 502);
  return job;
}

/* -------------------------------------------------- the LoRA comes home */

const licenceOf = (base: Pick<ResolvedBase, "profile">): LoraRecord["licence"] => ({ name: `${base.profile.licence.name} (the model's licence)`, commercial: base.profile.licence.commercial });

async function home(c: Ctx, base: ResolvedBase) {
  const { job, note } = c;
  const result = job.result!;
  const dest = jobPath(job.id, "lora", result.file);
  try {
    const bytes = c.exported ? await fetchOutput(c.exported, dest) : await fetchLora(result.file, dest);
    result.bytes = bytes;
    result.kept = true;
    const own = job.checkpoints.find((k) => k.file === result.file);
    if (own) own.home = true;
  } catch (err) {
    await note(`Couldn't copy the LoRA to this computer (${(err as Error).message.slice(0, 120)}): it's on ${c.machine.label}, where it trained`);
  }
  await versionsHome(c, true);
  await register(job, base);
  const { forgetInstalled } = await import("../local-models");
  forgetInstalled();
  if (result.works === false) await note("The test pictures with and without the LoRA look the same: it may need more steps or a higher strength");
}

/** The trained LoRA in the LoRA library: under every model of its family, with its trigger words and strength. */
export async function register(job: TrainJob, base: Pick<ResolvedBase, "profile">) {
  if (!job.result) return;
  const { recordTrained } = await import("../loras");
  const style = job.goal === "style";
  const subject = subjectWords(job);
  await recordTrained({
    file: job.result.file,
    entry: `trained:${job.id}`,
    name: job.name,
    repo: "",
    path: job.result.file,
    models: base.profile.uses,
    category: style ? "looks" : job.goal === "object" || job.goal === "edit" ? "edit" : "characters",
    // (An edit LoRA has no trigger word: what calls it is the instruction you type with the picture to change.)
    ...(subject && job.goal !== "edit" ? { trigger: style ? `in ${subject} style` : subject, ...(style ? { triggerAt: "end" as const } : {}) } : {}),
    strength: base.profile.strength,
    range: [0, 1.5],
    licence: licenceOf(base),
    bytes: job.result.bytes,
    found: true,
    trained: job.id,
    step: job.result.step,
  });
}

/* -------------------------------------------------- afterwards */

/**
 * Makes an earlier saved version the LoRA (the best one is often not the last). It's done on this computer, from
 * Crackio's own copies, so it works with the machine it trained on off or gone: the version's file comes home if it
 * isn't here, the version that was the LoRA till now gets a file of its own (it only ever had the LoRA's, and picking
 * another would have written over it), and the LoRA's file here becomes the version picked. The machines that have the
 * LoRA follow where they answer: the one it trained on copies its own file of that version, the others are sent it.
 */
export const useVersion = (id: string, step: number) => oneAtATime(id, () => pickVersion(id, step));

/**
 * A run that never reached its end, made into a LoRA from one of its saved versions: what's left of a run whose machine
 * is gone (a rented GPU taken back mid-run) or that you'd rather not carry on. Made on this computer from Crackio's own
 * copy of the version; the machine isn't needed.
 */
async function finishFrom(job: TrainJob, version: TrainCheckpoint): Promise<TrainJob> {
  if (job.state !== "paused" && job.state !== "error") throw new TrainRefused("That LoRA isn't finished yet.");
  const here = jobPath(job.id, "lora", version.file);
  if (version.home === false || !(await isFile(here))) {
    const target = (await comfyTargets()).find((t) => t.id === job.machine);
    const where = target?.label ?? "the machine it trained on";
    if (!target || target.serverless || !(await withTarget(target, () => answers()).catch(() => false))) throw new TrainRefused(`That version is only on ${where}, which isn't answering.`);
    await withTarget(target, () => versionHome(job, version)).catch((err: Error) => {
      throw new TrainRefused(err instanceof DiskFull ? "This computer's disk is nearly full: free some room first." : `${where} didn't hand that version over (${err.message.slice(0, 120)}).`, 502);
    });
  }
  version.home = true;
  const file = `${loraStem(job)}.safetensors`;
  const dest = jobPath(job.id, "lora", file);
  await fs.copyFile(/*turbopackIgnore: true*/ here, `${dest}.part`);
  await fs.rename(/*turbopackIgnore: true*/ `${dest}.part`, dest);
  job.result = { file, bytes: (await isFile(dest)) || version.bytes, step: version.step, kept: true, on: [] };
  job.state = "done";
  job.error = null;
  job.progress.stage = "";
  job.progress.share = null;
  job.progress.finishedAt = Date.now();
  job.progress.steps = job.settings.steps = Math.max(1, job.progress.step);
  job.auto = job.auto.filter((k) => k !== "steps");
  job.run = { prepared: job.run?.prepared, weights: job.run?.weights };
  await fs.rm(/*turbopackIgnore: true*/ jobPath(job.id, "state"), { recursive: true, force: true }).catch(() => undefined);
  const profile = profileById(job.base!.family);
  if (profile) await register(job, { profile });
  const { forgetInstalled } = await import("../local-models");
  forgetInstalled();
  await log(job.id, `Finished with the version saved at step ${version.step}: the run didn't reach its end`);
  await touch(job, true);
  return job;
}

async function pickVersion(id: string, step: number): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job || !job.base || !job.machine) throw new TrainRefused("That LoRA isn't finished yet.");
  if (live.has(id)) throw new TrainRefused("Wait for the run to finish first.");
  const version = job.checkpoints.find((k) => k.step === step);
  if (!version) throw new TrainRefused("No version was saved at that step.", 404);
  if (!job.result) return finishFrom(job, version);
  const result = job.result;
  if (version.step === result.step) return job;
  if (version.file === result.file) throw new TrainRefused("That version was written over when another one was picked: it can't be brought back.");
  const targets = await comfyTargets();
  const target = targets.find((t) => t.id === job.machine) ?? null;
  if (target?.serverless) throw new TrainRefused("Versions on a RunPod endpoint can't be swapped yet: train on a rented or local GPU to pick one.");
  const up = target ? await withTarget(target, () => answers()).catch(() => false) : false;
  const where = target?.label ?? "the machine it trained on";
  const dest = jobPath(job.id, "lora", result.file);
  const here = jobPath(job.id, "lora", version.file);

  // 1. The version's file on this computer.
  if (version.home === false || !(await isFile(here))) {
    if (!target) throw new TrainRefused("That version was only kept on the machine it trained on, which isn't one of yours any more.");
    if (!up) throw new TrainRefused(`That version is only on ${where}, which isn't answering: start it first.`);
    await withTarget(target, () => versionHome(job, version)).catch((err: Error) => {
      throw new TrainRefused(err instanceof DiskFull ? "This computer's disk is nearly full: free some room first." : `${where} didn't hand that version over (${err.message.slice(0, 120)}).`, 502);
    });
  }
  version.home = true;

  // 2. The version that is the LoRA now, kept under a name of its own.
  // (A run without test pictures lists no version for its last step: it gets one here, or it couldn't be picked again.)
  const current = job.checkpoints.find((k) => k.file === result.file && k.step === result.step);
  if (current || !job.checkpoints.some((k) => k.step === result.step)) {
    if (!(await isFile(dest))) {
      if (!target || !up) throw new TrainRefused(`The LoRA as it is now is only on ${where}, which isn't answering: start it first.`);
      await withTarget(target, () => fetchLora(result.file, dest)).catch((err: Error) => {
        throw new TrainRefused(`${where} didn't hand the LoRA over (${err.message.slice(0, 120)}).`, 502);
      });
    }
    const own = `${loraStem(job)}-${String(result.step).padStart(6, "0")}.safetensors`;
    await fs.copyFile(/*turbopackIgnore: true*/ dest, jobPath(job.id, "lora", own));
    if (current) Object.assign(current, { file: own, home: true });
    else {
      job.checkpoints.push({ step: result.step, file: own, bytes: result.bytes, loss: job.progress.loss, home: true });
      job.checkpoints.sort((x, y) => x.step - y.step);
    }
  }

  // 3. This computer's LoRA becomes the version picked.
  await fs.copyFile(/*turbopackIgnore: true*/ here, `${dest}.part`);
  await fs.rename(/*turbopackIgnore: true*/ `${dest}.part`, dest);
  result.bytes = (await isFile(dest)) || result.bytes;
  result.step = version.step;
  result.kept = true;
  await touch(job, true);

  // 4. The machines that have the LoRA follow.
  let profile = profileById(job.base.family);
  const behind: string[] = [];
  // Machines left with the version from before under the LoRA's name (off just now, or a RunPod endpoint): the file
  // goes there again before their next job with it (the LoRA's record says which).
  const stale: string[] = [];
  for (const id of [...result.on]) {
    const t = targets.find((x) => x.id === id);
    // (A machine that isn't yours any more has nothing to follow with.)
    if (!t) {
      result.on = result.on.filter((x) => x !== id);
      continue;
    }
    try {
      if (t.serverless || t.metered) throw new Error("not reachable this way");
      await withTarget(t, async () => {
        if (!(await answers())) throw new Error("not answering");
        // Where it trained, the version is a file already: the machine copies it over the LoRA's, nothing travels.
        // Not while it's busy with another run (the copy would wait its turn behind a stretch of up to an hour): the
        // file is sent then.
        const queue = id === job.machine ? await getJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue", 5000) : null;
        if (queue && !queue.queue_running?.length && !queue.queue_pending?.length) {
          const machine = await planMachine(t.id);
          const base = machine ? await resolveBase(job.base!, machine, { resolution: job.settings.resolution, rank: job.settings.rank }).catch(() => null) : null;
          if (base) profile = base.profile;
          const copied =
            machine && base
              ? await runGraph(
                  { job, live: { abort: new AbortController(), stop: null, lastSeq: 0, done: Promise.resolve() }, target: t, machine, say: () => undefined, note: async () => undefined },
                  // (Under the LoRA's own file name: its job's name may have changed since.)
                  trainGraph(job, base, { name: result.file.replace(/\.safetensors$/i, ""), finalize: true, from_checkpoint: version.file, step: version.step, export: false, meta: {} }),
                  "final",
                ).then(
                  () => true,
                  () => false,
                )
              : false;
          if (copied) return void (await letGo());
        }
        await sendLora(dest, result.file);
        // ComfyUI remembers a LoRA by its file's name: without this the next picture there was still drawn with the
        // version from before.
        await letGo();
      });
    } catch {
      behind.push(t.label);
      stale.push(id);
    }
  }
  if (profile) await register(job, { profile });
  const { changeRecord } = await import("../loras");
  await changeRecord(result.file, (r) => {
    r.step = result.step;
    if (stale.length) r.stale = stale;
    else delete r.stale;
  }).catch(() => null);
  await log(job.id, `The version saved at step ${step} is now the LoRA${behind.length ? ` on this computer. ${behind.join(" and ")} still ${behind.length === 1 ? "has" : "have"} the one from before: it's sent there before the next job that uses it` : ""}`);
  await touch(job, true);
  return job;
}

/**
 * Sends a finished LoRA from Crackio's own copy to another of your machines, so the model there can use it too: through
 * the machine's helper, or onto a RunPod endpoint's volume (by way of R2, as its other files go).
 */
export async function sendTo(id: string, machine: string): Promise<TrainJob> {
  const job = await getJob(id);
  if (!job?.result) throw new TrainRefused("That LoRA isn't finished yet.");
  const file = jobPath(job.id, "lora", job.result.file);
  if (!job.result.kept || !(await fs.stat(/*turbopackIgnore: true*/ file).catch(() => null))) throw new TrainRefused("Crackio has no copy of this LoRA on this computer to send.");
  const target = (await comfyTargets()).find((t) => t.id === machine);
  if (!target) throw new TrainRefused("That machine isn't one of yours.", 404);
  // (Its place in R2 is named after the step too: another version picked since is another file, sent again.)
  const { sendHome, LoraRefused } = await import("../lora-home");
  await sendHome(job.result.file, target, { from: { path: file, bytes: job.result.bytes, name: job.name, key: `loras/${job.id}/${job.result.step}/${job.result.file}` } }).catch((err: Error) => {
    throw new TrainRefused(err.message, err instanceof LoraRefused ? err.status : 502);
  });
  if (!job.result.on.includes(machine)) job.result.on.push(machine);
  if (!target.serverless && !target.metered) await withTarget(target, () => letGo());
  const { changeRecord } = await import("../loras");
  await changeRecord(job.result.file, (r) => {
    r.stale = r.stale?.filter((x) => x !== machine);
    if (!r.stale?.length) delete r.stale;
  }).catch(() => null);
  await log(job.id, `Sent the LoRA to ${target.label}`);
  await touch(job, true);
  return job;
}

/** Removes what a job left on its machine: the prepared pictures and training state, and its saved versions (not the LoRA itself). */
export async function cleanMachine(job: TrainJob, alsoLora = false) {
  const target = (await comfyTargets()).find((t) => t.id === job.machine);
  if (!target || target.serverless) return false;
  const loras = [...job.checkpoints.map((k) => k.file).filter((f) => f !== job.result?.file), ...(alsoLora && job.result ? [job.result.file] : [])];
  return withTarget(target, async () => {
    const res = await postJson("/crackio/train/clean", { job: job.id, loras }, 30_000).catch(() => null);
    return Boolean(res?.ok);
  });
}

export type { TrainSettings };
