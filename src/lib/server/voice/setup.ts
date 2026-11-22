import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { withTarget, type ComfyTarget } from "../comfy-targets";
import { DATA_DIR } from "../paths";
// The text models first: they reach the engine registry, which loads comfy-local whole (loaded first, comfy-local would
// reach the registry halfway through itself and the route fails before it starts).
import "@/lib/engines/refine";
import { downloadOutput, runWorkflow, uploadFile } from "@/lib/engines/comfy-local";
import { EngineError } from "@/lib/engines/types";
import { ask, bridgeAtLeast, forgetVoiceMachines, installTarget, machineFor, SETUP_BRIDGE, voiceMachines, type VoiceStatus } from "./machines";
import { setupJobs } from "./jobs";
import { lookAt, peaksOf, toWav } from "./audio";
import { scratchDir, scratchPath, scratchUrl } from "./store";
import { forModel } from "@/lib/voice/script";
import { AUDIOCPP_BYTES, buildName, gbOf, HEARING, modelOfFile, VOICE_MODELS, variantFor, type VoiceFile, type VoiceModelId } from "@/lib/voice/models";
import type { VoiceMachine, VoiceSetupJob } from "@/lib/voice/types";

/** Getting a voice model onto a machine, and the small jobs around voices: hearing a sample, designing a voice. */

export class VoiceSetupError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Puts a model (and speech to text, the first time) on a machine, with audio.cpp checked and a test line at the end. */
export async function installVoiceModel(model: VoiceModelId, machineId?: string) {
  const job = await setUpVoice(model, machineId);
  return { machine: job.machine, job };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Download = { id: string; folder: string; filename: string; state: string; received: number; total: number; error: string | null };

function oldBridge(machine: VoiceMachine) {
  const has = machine.bridge ? `Crackio bridge ${machine.bridge}` : "no Crackio bridge";
  return machine.id === "this-computer"
    ? `This computer's ComfyUI has ${has}; setting up Voice needs ${SETUP_BRIDGE}. Update it (ComfyUI restarts for a few seconds).`
    : `${machine.label} has ${has}; setting up Voice needs ${SETUP_BRIDGE}. Connect it again in Settings → Machines and Crackio brings the new one.`;
}

/**
 * Sets Voice up on a machine, all of it, in the background: audio.cpp (the build that runs there, checked before it's
 * kept, the next one tried when it doesn't), the model's file and speech to text, then a test line spoken by the model
 * and heard back by speech to text. Without a model, it finishes what the models already there need. The job shows in
 * GET /api/voice/machines as it goes.
 */
export async function setUpVoice(model: VoiceModelId | null, machineId?: string): Promise<VoiceSetupJob> {
  const m = model ? (VOICE_MODELS.find((x) => x.id === model) ?? null) : null;
  if (model && !m) throw new VoiceSetupError("Unknown voice model.", 404);
  let place: { target: ComfyTarget; machine: VoiceMachine } | null = null;
  if (m) place = await installTarget(m.id, machineId);
  else {
    const machine = (await voiceMachines(true)).find((x) => x.id === machineId) ?? null;
    const target = machine ? await targetOf(machine.id) : null;
    place = machine && target ? { target, machine } : null;
  }
  if (!place) throw new VoiceSetupError(m ? `None of your GPUs can run ${m.name}.` : "That computer isn't connected.", m ? 409 : 404);
  const { target, machine } = place;
  if (!machine.online) throw new VoiceSetupError(`${machine.label} isn't answering: start its ComfyUI first.`, 409);
  if (!bridgeAtLeast(machine.bridge, SETUP_BRIDGE)) throw new VoiceSetupError(oldBridge(machine), 409);
  const running = setupJobs.get(machine.id);
  if (running?.state === "running") return running;
  if (!machine.engine && !machine.builds.length) throw new VoiceSetupError(`audio.cpp has no build for ${machine.label}'s system.`, 409);

  const pick = m ? variantFor(m, machine.gpuGb, machine.ramGb, machine.unified) : null;
  if (m && !pick) throw new VoiceSetupError(`${m.name} doesn't fit ${machine.gpu ?? machine.label}.`, 409);
  const engineBytes = machine.engine ? 0 : (AUDIOCPP_BYTES[machine.builds[0] ?? ""] ?? 1e9) * 2.4;
  const sizeGb = (fs: VoiceFile[]) => (fs.reduce((s, f) => s + f.bytes, 0) + engineBytes) / 1e9;
  const modelFiles = (pick ? [pick.variant.file] : []).filter((f) => !machine.files.includes(f.name));
  const hearingFiles = machine.hearing ? [] : HEARING.filter((f) => !machine.files.includes(f.name));
  const fits = (fs: VoiceFile[], spare: number) => machine.diskGb == null || machine.diskGb >= sizeGb(fs) + spare;
  if (!fits(modelFiles, 1)) throw new VoiceSetupError(`${machine.label} needs ${Math.ceil(sizeGb(modelFiles) + 1)} GB free for this; it has ${machine.diskGb!.toFixed(1)} GB.`, 409);
  // Speech to text comes along when it leaves room to spare (a Mac's models share its system disk); without it Voice
  // still speaks, and clones are typed out on another machine that has it.
  const files = fits([...modelFiles, ...hearingFiles], 2.5) ? [...modelFiles, ...hearingFiles] : modelFiles;
  const skipped = hearingFiles.length && files.length === modelFiles.length ? `Speech to text left out: it needs ${gbOf(hearingFiles.reduce((s, f) => s + f.bytes, 0))} more free space` : null;
  // The test line: the new model, else the smallest one there (the bridge picks).
  const testWith = pick?.variant.file.name ?? null;
  const job: VoiceSetupJob = {
    machine: machine.id,
    label: machine.gpu ?? machine.label,
    model: m?.id ?? null,
    state: "running",
    step: "engine",
    detail: "Starting",
    fetches: [...(modelFiles.length && m ? [m.name] : []), ...(files.length > modelFiles.length ? ["speech to text"] : [])],
    progress: null,
    error: null,
    tried: [],
    result: null,
    note: skipped,
    startedAt: Date.now(),
    finishedAt: null,
  };
  setupJobs.set(machine.id, job);
  void runSetup(job, target, machine, files, testWith, m?.name ?? null);
  forgetVoiceMachines();
  return job;
}

/** Polls the bridge's /crackio/voice until `done` says so; a machine silent for 90 s, or the time running out, fails. */
async function until(target: ComfyTarget, done: (v: VoiceStatus) => boolean, withinMs: number) {
  const end = Date.now() + withinMs;
  let heard = Date.now();
  while (Date.now() < end) {
    await sleep(1500);
    const v = await ask<VoiceStatus>(target, "/crackio/voice", { timeoutMs: 8000 });
    if (!v) {
      if (Date.now() - heard > 90_000) throw new Error("The computer stopped answering.");
      continue;
    }
    heard = Date.now();
    if (done(v)) return v;
  }
  throw new Error("It took too long.");
}

async function runSetup(job: VoiceSetupJob, target: ComfyTarget, machine: VoiceMachine, files: VoiceFile[], testWith: string | null, modelName: string | null) {
  try {
    // 1. audio.cpp: the bridge tries this machine's builds best first, each checked before it's kept.
    if (!machine.engine) {
      Object.assign(job, { step: "engine", detail: `Getting audio.cpp for ${buildName(machine.builds[0])}` });
      const res = await ask<{ state?: string; error?: string }>(target, "/crackio/voice/engine", { method: "POST", body: "{}", timeoutMs: 20000 });
      if (!res || res.error) throw new Error(res?.error ?? "audio.cpp didn't start installing.");
      await until(
        target,
        (v) => {
          const i = v.install;
          job.tried = (i.tried ?? []).map((t) => ({ build: t.build, error: t.error }));
          job.progress = i.total ? { received: i.received, total: i.total } : null;
          const name = buildName(i.build);
          const before = job.tried.length ? ` · ${buildName(job.tried.at(-1)!.build)} didn't run here` : "";
          job.detail = i.state === "checking" ? `Checking audio.cpp ${name} runs here${before}` : i.state === "unpacking" ? `Unpacking audio.cpp ${name}${before}` : `Downloading audio.cpp ${name}${before}`;
          if (i.state === "error") throw new Error(`audio.cpp won't run on ${machine.gpu ?? machine.label}: ${i.error ?? "every build failed its check"}`);
          return i.state === "done" && Boolean(v.engine);
        },
        60 * 60_000,
      );
    }

    // 2. The model and speech to text.
    if (files.length) {
      const total = files.reduce((s, f) => s + f.bytes, 0);
      const names = files.map((f) => (HEARING.some((h) => h.name === f.name) ? null : modelName)).filter(Boolean);
      const what = [...new Set(names)].join(", ");
      const hearing = files.some((f) => HEARING.some((h) => h.name === f.name));
      Object.assign(job, { step: "files", progress: { received: 0, total }, detail: `Downloading ${[what, hearing ? "speech to text" : ""].filter(Boolean).join(" and ")} · ${gbOf(total)}` });
      for (const f of files) {
        const res = await ask<{ error?: string }>(target, "/crackio/download", { method: "POST", body: JSON.stringify({ url: f.url, folder: "audiocpp", filename: f.name, size: f.bytes }), timeoutMs: 20000 });
        if (!res || res.error) throw new Error(res?.error ?? `The computer refused ${f.name}.`);
      }
      const end = Date.now() + 6 * 60 * 60_000;
      while (Date.now() < end) {
        await sleep(2000);
        const [list, v] = await Promise.all([ask<Download[]>(target, "/crackio/downloads"), ask<VoiceStatus>(target, "/crackio/voice")]);
        const mine = (list ?? []).filter((d) => d.folder === "audiocpp" && files.some((f) => f.name === d.filename));
        const failed = mine.find((d) => d.state === "error" || d.state === "stopped");
        if (failed) throw new Error(failed.state === "stopped" ? `${failed.filename} was stopped.` : `${failed.filename} didn't download: ${failed.error ?? "unknown error"}`);
        const here = new Set((v?.models ?? []).map((x) => x.file));
        const got = files.reduce((s, f) => s + (here.has(f.name) ? f.bytes : Math.min(f.bytes, mine.find((d) => d.filename === f.name)?.received ?? 0)), 0);
        job.progress = { received: got, total };
        if (files.every((f) => here.has(f.name))) break;
      }
      if (job.progress && job.progress.received < total) throw new Error("The downloads took too long.");
    }

    // 3. The proof: a model speaks a test line, speech to text hears it back. A GPU build that can't speak moves on to
    // the next build there.
    Object.assign(job, { step: "check", progress: null, detail: `${modelName ?? "The model"} is speaking a test line` });
    const started = await ask<{ error?: string }>(target, "/crackio/voice/check", { method: "POST", body: JSON.stringify(testWith ? { model: testWith } : {}), timeoutMs: 20000 });
    if (!started || started.error) throw new Error(started?.error ?? "The test line didn't start.");
    let result: VoiceSetupJob["result"] = null;
    await until(
      target,
      (v) => {
        const c = v.check;
        if (!c) return false;
        // The bridge picks the smallest model there when none was asked for.
        const name = modelName ?? modelOfFile(c.model ?? "")?.name ?? "The model";
        if (c.tried?.length) job.tried = [...job.tried.filter((t) => !c.tried.some((x) => x.build === t.build)), ...c.tried];
        if (c.state === "switching") job.detail = `${buildName(c.build)} couldn't speak here: trying the next build`;
        else if (c.state === "running") job.detail = `${name} is speaking a test line${v.engine ? ` · ${buildName(v.engine.build)}` : ""}`;
        if (c.state === "error") throw new Error(`The test line failed: ${c.error ?? "unknown error"}`);
        if (c.state !== "done") return false;
        result = { build: c.build, gpu: v.engine?.gpu ?? null, model: name, seconds: c.seconds, heard: c.heard };
        return true;
      },
      30 * 60_000,
    );
    Object.assign(job, { state: "done", result, detail: "Voice works here", progress: null });
  } catch (err) {
    Object.assign(job, { state: "error", error: (err as Error).message, progress: null });
  } finally {
    job.finishedAt = Date.now();
    forgetVoiceMachines();
  }
}

/** Removes a model's file from a machine. */
export async function removeVoiceModel(model: VoiceModelId, machineId: string) {
  const m = VOICE_MODELS.find((x) => x.id === model);
  const machine = (await voiceMachines(true)).find((x) => x.id === machineId);
  const target = await targetOf(machineId);
  if (!m || !machine || !target) throw new VoiceSetupError("Unknown model or machine.", 404);
  await ask(target, "/crackio/voice/stop", { method: "POST", body: "{}" });
  for (const v of m.variants) if (machine.files.includes(v.file.name)) await ask(target, "/crackio/delete", { method: "POST", body: JSON.stringify({ folder: "audiocpp", filename: v.file.name }) });
  forgetVoiceMachines();
}

async function targetOf(id: string): Promise<ComfyTarget | null> {
  const { comfyTargets } = await import("../comfy-targets");
  return (await comfyTargets()).find((t) => t.id === id) ?? null;
}

/** A machine that has speech to text, else one that has the given model. */
export async function machineWith(need: (m: Awaited<ReturnType<typeof voiceMachines>>[number]) => boolean) {
  const machines = (await voiceMachines()).filter((m) => m.online && m.voiceReady && m.engine && need(m));
  const pick = machines.find((m) => m.runOn) ?? machines.sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  return pick ? { machine: pick, target: await targetOf(pick.id) } : null;
}

const quiet = { progress: () => {} };

export async function texts(target: ComfyTarget, graph: Record<string, unknown>, label: string, signal: AbortSignal) {
  const { files } = await withTarget(target, () => runWorkflow(graph, { ...quiet, signal }, 20_000, label));
  return files;
}

/**
 * A voice sample (an upload or a recording): a clean mono WAV of up to 30 seconds without the silence around it, how good
 * it is to clone from, and the words it says when a machine can hear them.
 */
export async function readSample(file: string, signal: AbortSignal, opts: { /** false: its words are known already, so no machine is asked to type them out. */ hear?: boolean } = {}) {
  const name = `${nanoid(10)}.wav`;
  const out = await scratchPath(name);
  await toWav(file, out, { rate: 24000, maxSeconds: 30, trim: true, signal });
  const [look, peaks] = await Promise.all([lookAt(out), peaksOf(out, 120)]);
  if (look.seconds < 2) throw new VoiceSetupError("That clip has almost no speech in it. Use 10 to 30 seconds of someone talking.");
  let text = "";
  // Typing it out needs only Qwen3-ASR (its aligner times words, which a sample doesn't need).
  const place = opts.hear === false ? null : await machineWith((m) => m.files.some((f) => /qwen3-asr/i.test(f)));
  if (place?.target) {
    const t = place.target;
    try {
      const up = await withTarget(t, () => uploadFile(out, signal, "sample"));
      const files = await texts(
        t,
        {
          clip: { class_type: "LoadAudio", inputs: { audio: up.name } },
          hear: { class_type: "CrackioTranscribe", inputs: { audio: ["clip", 0], text: "", language: "" } },
          save: { class_type: "CrackioSaveText", inputs: { text: ["hear", 0], filename_prefix: "crackio/voice-sample" } },
        },
        "Voice · hearing a sample",
        signal,
      );
      const f = files.find((x) => /voice-sample/.test(x.filename));
      if (f) text = (await withTarget(t, () => downloadOutput(f, signal))).data.toString("utf8").trim();
    } catch (err) {
      if (signal.aborted) throw err;
    }
  }
  return {
    url: scratchUrl(name),
    file: name,
    seconds: look.seconds,
    peaks,
    checks: { long: look.seconds >= 8, clean: look.snr >= 25, loud: !look.clipped },
    text,
    heard: Boolean(place),
  };
}

/**
 * A clone heard before it's kept: the chosen model says a line in the voice of a sample (a scratch clip from
 * readSample), on the GPU that has the model.
 */
export async function previewVoice(file: string, sampleText: string, model: VoiceModelId, line: string, signal: AbortSignal) {
  const m = VOICE_MODELS.find((x) => x.id === model);
  if (!m) throw new VoiceSetupError("Unknown voice model.", 404);
  if (!m.can.clone) throw new VoiceSetupError(`${m.name} can't clone voices: it speaks in voices of its own.`);
  const place = await machineFor(model);
  if (!place) throw new VoiceSetupError(`${m.name} isn't on any of your GPUs yet. Get it under Voice models, then try again.`, 409);
  const src = path.join(/*turbopackIgnore: true*/ scratchDir, file);
  if (!(await fs.stat(/*turbopackIgnore: true*/ src).catch(() => null))) throw new VoiceSetupError("That clip is gone. Add it again.", 404);
  const variant = m.variants.find((v) => place.machine.files.includes(v.file.name)) ?? m.variants[0];
  const said = line.trim().slice(0, 300) || "Hi! This is how I sound now. Pretty close, right?";
  const up = await withTarget(place.target, () => uploadFile(src, signal, "voice"));
  const files = await texts(
    place.target,
    {
      ref: { class_type: "LoadAudio", inputs: { audio: up.name } },
      say: {
        class_type: "CrackioVoice",
        inputs: { model: variant.file.name, text: forModel(model, said, ""), seed: 7, temperature: 0, speed: 1, preset: "", voice_1: ["ref", 0], voice_1_text: sampleText.slice(0, 2000) },
      },
      save: { class_type: "SaveAudio", inputs: { audio: ["say", 0], filename_prefix: "crackio/voice-preview" } },
    },
    `Voice · hearing a clone in ${m.name}`,
    signal,
  );
  const f = files.find((x) => x.filename.includes("voice-preview"));
  if (!f) throw new EngineError(`${m.name} made no sound.`);
  const raw = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "voice", `${nanoid(8)}${path.extname(f.filename)}`);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(/*turbopackIgnore: true*/ raw), { recursive: true });
  await fs.writeFile(/*turbopackIgnore: true*/ raw, (await withTarget(place.target, () => downloadOutput(f, signal))).data);
  const name = `${nanoid(10)}.wav`;
  const out = await scratchPath(name);
  await toWav(raw, out, { rate: 24000, signal });
  await fs.rm(/*turbopackIgnore: true*/ raw, { force: true });
  return { url: scratchUrl(name), file: name, peaks: await peaksOf(out, 90), seconds: (await lookAt(out)).seconds, model: m.name, gpu: place.machine.gpu ?? place.machine.label };
}

/** Three takes on a described voice, from VoxCPM2, each saying the same line. */
export async function designVoice(description: string, line: string, signal: AbortSignal) {
  const model = VOICE_MODELS.find((m) => m.id === "local:voice:voxcpm2")!;
  const file = model.variants[0].file.name;
  const place = await machineWith((m) => m.files.includes(file));
  if (!place?.target) throw new VoiceSetupError("Designing a voice needs VoxCPM2 (3 GB) on one of your GPUs. Get it under Voice models.", 409);
  const how = description.trim().replace(/[()]/g, "").slice(0, 300);
  // A clone holds a voice better from 8–10 seconds than from one short line: a short line gets a second sentence.
  const said = line.trim().slice(0, 300) || "Hi, I'm your new voice. Shall we start?";
  const words = said.length < 90 ? `${said} I can read you a story, an ad or a message, and I'll always sound like this.` : said;
  const seeds = [1, 2, 3].map(() => Math.floor(Math.random() * 2 ** 31));
  const graph: Record<string, unknown> = {};
  seeds.forEach((seed, i) => {
    graph[`say${i}`] = { class_type: "CrackioVoice", inputs: { model: file, text: `(${how})${words}`, seed, temperature: 0, speed: 1, preset: "" } };
    graph[`save${i}`] = { class_type: "SaveAudio", inputs: { audio: [`say${i}`, 0], filename_prefix: `crackio/voice-design-${i}` } };
  });
  const files = await texts(place.target, graph, "Voice · designing", signal);
  const tmp = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "voice");
  await fs.mkdir(/*turbopackIgnore: true*/ tmp, { recursive: true });
  return Promise.all(
    [0, 1, 2].map(async (i) => {
      const f = files.find((x) => x.filename.includes(`voice-design-${i}`));
      if (!f) throw new EngineError("VoxCPM2 made no sound.");
      const raw = path.join(/*turbopackIgnore: true*/ tmp, `${nanoid(8)}${path.extname(f.filename)}`);
      await fs.writeFile(/*turbopackIgnore: true*/ raw, (await withTarget(place.target!, () => downloadOutput(f, signal))).data);
      const name = `${nanoid(10)}.wav`;
      const out = await scratchPath(name);
      await toWav(raw, out, { rate: 24000, signal });
      await fs.rm(/*turbopackIgnore: true*/ raw, { force: true });
      return { url: scratchUrl(name), file: name, peaks: await peaksOf(out, 90), text: words, seconds: (await lookAt(out)).seconds };
    }),
  );
}
