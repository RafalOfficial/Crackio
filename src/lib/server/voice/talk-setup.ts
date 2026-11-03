import "server-only";
// The registry loads comfy-local whole first (see server/voice/setup).
import "@/lib/engines/refine";
import { forgetLfm3 } from "@/lib/engines/comfy-text";
import { LFM3_FILES, LFM3_FOLDER, LFM3_LORAS, LFM3_NAME, lfm3LoraUrl, type Lfm3LoraKey } from "@/lib/local/lfm3";
import type { VoiceModelId } from "@/lib/voice/models";
import type { TalkSetupJob, VoiceMachine } from "@/lib/voice/types";
import { comfyTargets, type ComfyTarget } from "../comfy-targets";
import { updateLocalBridge } from "../comfy-install";
import { forgetInstalled } from "../local-models";
import { getSettings } from "../settings";
import { talkSetupJobs } from "./jobs";
import { ask, BRAIN_BRIDGE, bridgeAtLeast, forgetVoiceMachines, machineFor, voiceMachines, type Lfm3Status } from "./machines";

/**
 * Talk's answers come from LFM3-VL 2B on one of your GPUs (lfm3Chat). Setting it up there in one go, in the background:
 * its two files (3.9 GB, each checked against its checksum), transformers 5.21+ in ComfyUI's own Python, a restart once
 * ComfyUI's queue is empty when the new transformers isn't the one running, then a hello it must answer. This computer's
 * bridge is brought up to date first when it's too old to say what's there. The job shows in /api/voice/machines.
 *
 * Crackio's fine-tunes a tool asks for (`loras`: Swap's judge, Retouch's eyes, Talk's chat voice) come with the files,
 * each from its own Hugging Face repo with your Hugging Face token while that's private, and each answers a question
 * after the hello (merged into the weights for it), so a broken file shows here and not halfway through a swap. Settings'
 * one-click set-ups (server/setup/jobs) run this for LFM3-VL and its fine-tunes.
 */

export class TalkSetupError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
type Download = { id: string | null; folder: string; filename: string; state: string; received: number; total: number; error: string | null };

/** A file it gets, and how the bridge's /crackio/lfm3/setup says it's there. */
type Want = { name: string; url: string; bytes: number; sha256: string; token: boolean; lora?: Lfm3LoraKey; has: (s: Lfm3Status) => boolean };

const BASE: Want[] = LFM3_FILES.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes, sha256: f.sha256, token: false, has: (s) => (f.role === "model" ? s.weights : s.tokenizer) }));

function loraWant(key: Lfm3LoraKey): Want {
  const l = LFM3_LORAS[key];
  return { name: l.name, url: lfm3LoraUrl(key) ?? "", bytes: l.bytes, sha256: l.sha256, token: l.private, lora: key, has: (s) => s.loras.includes(key) };
}

const hfToken = async () => (await getSettings()).keys.hf?.trim() || process.env.HF_TOKEN?.trim() || "";

export async function setUpTalk(input: { machine?: string; model?: VoiceModelId; loras?: Lfm3LoraKey[] }): Promise<TalkSetupJob> {
  const asked = [...new Set(input.loras ?? [])];
  const unpublished = asked.find((k) => !lfm3LoraUrl(k));
  if (unpublished) throw new TalkSetupError(`${LFM3_LORAS[unpublished].label} isn't published yet.`);
  const machines = (await voiceMachines(true)).filter((m) => m.online);
  const speech = input.model ? await machineFor(input.model) : null;
  // Where: the machine asked for; else the one that speaks the voice (voice.py leaves room on its card for LFM3-VL);
  // else the biggest GPU.
  const machine: VoiceMachine | undefined = input.machine
    ? machines.find((m) => m.id === input.machine)
    : (machines.find((m) => m.id === speech?.machine.id) ?? [...machines].sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0]);
  if (!machine) throw new TalkSetupError(input.machine ? "That computer isn't answering." : "None of your ComfyUIs is answering: start one first.");
  const token = await hfToken();
  const locked = asked.find((k) => LFM3_LORAS[k].private && !token && !machine.brain?.loras.includes(k));
  if (locked) throw new TalkSetupError(`${LFM3_LORAS[locked].label} needs your Hugging Face token while it's private: add it under Settings → Accounts.`);
  const running = talkSetupJobs.get(machine.id);
  if (running?.state === "running") {
    // The fine-tunes asked for join the set-up already running there: it gets them before it ends.
    for (const k of asked) if (!running.loras.includes(k)) running.loras.push(k);
    return running;
  }
  const old = !bridgeAtLeast(machine.bridge, BRAIN_BRIDGE);
  if (old && machine.id !== "this-computer") {
    throw new TalkSetupError(`${machine.gpu ?? machine.label} has Crackio bridge ${machine.bridge ?? "none"}; setting ${LFM3_NAME} up there needs ${BRAIN_BRIDGE}. Connect it again in Settings → Machines to bring it.`);
  }
  const target = (await comfyTargets()).find((t) => t.id === machine.id);
  if (!target) throw new TalkSetupError("That computer isn't connected.", 404);
  const job: TalkSetupJob = {
    machine: machine.id,
    label: machine.id === "this-computer" ? "this computer" : (machine.gpu ?? machine.label),
    loras: asked,
    state: "running",
    step: old ? "bridge" : "files",
    detail: "Starting",
    progress: null,
    error: null,
    answer: null,
    seconds: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  talkSetupJobs.set(machine.id, job);
  void runSetup(job, target, old, token);
  return job;
}

async function post(t: ComfyTarget, route: string, body: unknown, timeoutMs: number) {
  const res = await fetch(`${t.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  }).catch((err: Error) => {
    throw new Error(`The computer didn't answer (${route}): ${err.message}`);
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

const statusOf = (t: ComfyTarget) => ask<Lfm3Status>(t, "/crackio/lfm3/setup", { timeoutMs: 8000 });

/** Whether ComfyUI is busy (a job queued or running, a download going): null when it doesn't answer. */
async function busyOf(t: ComfyTarget) {
  const [queue, downloads] = await Promise.all([
    ask<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(t, "/queue", { timeoutMs: 8000 }),
    ask<Download[]>(t, "/crackio/downloads", { timeoutMs: 8000 }),
  ]);
  if (!queue || !downloads) return null;
  return (queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0) > 0 || downloads.some((d) => ["queued", "downloading", "checking"].includes(d.state));
}

/** Looks every few seconds until `done`; a machine silent for `silentMs` (a restart takes a while) ends it. */
async function waitFor<T>(look: () => Promise<T | null>, done: (v: T) => boolean, withinMs: number, what: string, silentMs = 120_000): Promise<T> {
  const end = Date.now() + withinMs;
  let heard = Date.now();
  for (;;) {
    await sleep(2500);
    const v = await look();
    if (v != null) {
      heard = Date.now();
      if (done(v)) return v;
    } else if (Date.now() - heard > silentMs) throw new Error(`${what}: the computer stopped answering.`);
    if (Date.now() > end) throw new Error(`${what} took too long.`);
  }
}

/**
 * Its two files and the fine-tunes the job asks for that aren't there, each taking its name only once its checksum
 * matches; what the machine says once they're all there.
 */
async function fetchFiles(job: TalkSetupJob, target: ComfyTarget, s: Lfm3Status, token: string): Promise<Lfm3Status> {
  const missing = [...BASE, ...job.loras.map(loraWant)].filter((f) => !f.has(s));
  if (!missing.length) return s;
  const total = missing.reduce((sum, f) => sum + f.bytes, 0);
  if (s.disk_free != null && s.disk_free < total + 1e9) {
    throw new Error(`It needs ${gb(total + 1e9)} free where its files go (${s.folder}), and there's ${gb(s.disk_free)}.`);
  }
  // Fine-tunes alone go by name (the model is there already); the model goes by its size.
  const what = missing.every((f) => f.lora) ? missing.map((f) => LFM3_LORAS[f.lora!].label).join(" and ") : gb(total);
  Object.assign(job, { step: "files", progress: { received: 0, total }, detail: `Downloading ${what}` });
  const ids = new Set<string>();
  for (const f of missing) {
    const body = { url: f.url, folder: LFM3_FOLDER, filename: f.name, size: f.bytes, sha256: f.sha256, ...(f.token && token ? { token } : {}) };
    const r = await post(target, "/crackio/download", body, 20_000);
    if (!r.ok) throw new Error(String(r.json.error ?? `The computer refused ${f.name} (${r.status}).`));
    // Its own downloads only: an earlier try's error stays in the list.
    if (typeof r.json.id === "string") ids.add(r.json.id);
  }
  const end = Date.now() + 6 * 60 * 60_000;
  let heard = Date.now();
  for (;;) {
    await sleep(2500);
    if (Date.now() > end) throw new Error("The download took too long.");
    const [list, now] = await Promise.all([ask<Download[]>(target, "/crackio/downloads"), statusOf(target)]);
    if (!list || !now) {
      if (Date.now() - heard > 120_000) throw new Error("The computer stopped answering.");
      continue;
    }
    heard = Date.now();
    s = now;
    const mine = list.filter((d) => d.id && ids.has(d.id));
    const failed = mine.find((d) => d.state === "error" || d.state === "stopped");
    if (failed) {
      const why = failed.error ?? failed.state;
      // A private repo answers 401/403/404 to a token without access (or none).
      const denied = /\b(401|403|404)\b/.test(why) && missing.some((f) => f.token && f.name === failed.filename);
      throw new Error(denied ? `${failed.filename} didn't download: Hugging Face refused your token (${why}). Its repo is private until the release: the token in Settings → Accounts needs access to it.` : `${failed.filename} didn't download: ${why}.`);
    }
    job.progress = { received: missing.reduce((sum, f) => sum + (f.has(s) ? f.bytes : Math.min(f.bytes, mine.find((d) => d.filename === f.name)?.received ?? 0)), 0), total };
    if (missing.every((f) => f.has(s))) return s;
  }
}

async function runSetup(job: TalkSetupJob, target: ComfyTarget, old: boolean, token: string) {
  try {
    // 0. This computer's bridge, when it's too old to say what's there (ComfyUI restarts to load it; refused while it
    //    has work queued).
    if (old) {
      job.detail = "Updating Crackio's bridge (ComfyUI restarts)";
      await updateLocalBridge();
      await sleep(4000);
    }
    let s = await waitFor(() => statusOf(target), () => true, old ? 5 * 60_000 : 60_000, "Reading what's there", old ? 5 * 60_000 : 60_000);

    // 1. Its two files and the fine-tunes asked for.
    s = await fetchFiles(job, target, s, token);

    // 2. A transformers it runs on, put in while ComfyUI keeps working.
    if (!s.transformers_ok) {
      Object.assign(job, { step: "packages", progress: null, detail: `Updating transformers ${s.transformers ?? ""}`.trim() });
      const r = await post(target, "/crackio/lfm3/packages", {}, 30_000);
      if (!r.ok) throw new Error(String(r.json.error ?? `transformers' update didn't start (${r.status}).`));
      s = await waitFor(
        () => statusOf(target),
        (v) => {
          if (v.packages.state === "error") throw new Error(v.packages.error ?? "transformers didn't update.");
          return v.transformers_ok && v.packages.state !== "running";
        },
        35 * 60_000,
        "Updating transformers",
      );
    }

    // 3. ComfyUI runs the transformers it loaded when it started: a restart brings the new one, once nothing is queued.
    if (s.restart) {
      Object.assign(job, { step: "restart", detail: "Waiting for ComfyUI's queue to empty" });
      await waitFor(() => busyOf(target), (busy) => !busy, 2 * 60 * 60_000, "Waiting for ComfyUI's queue");
      // Voice's own server goes first: the restarted ComfyUI starts its own when it's asked to speak.
      await post(target, "/crackio/voice/stop", {}, 15_000).catch(() => null);
      job.detail = "Restarting ComfyUI";
      const r = await post(target, "/crackio/restart", {}, 20_000);
      if (!r.ok) throw new Error(String(r.json.error ?? `ComfyUI didn't restart (${r.status}).`));
      await sleep(6000);
      s = await waitFor(() => statusOf(target), (v) => !v.restart, 8 * 60_000, "Restarting ComfyUI", 8 * 60_000);
    }

    // 4. The proof: it answers a hello (the first one reads 3.8 GB from disk onto the card, so a slow disk takes a while).
    Object.assign(job, { step: "check", progress: null, detail: "Checking it answers" });
    const t0 = Date.now();
    const r = await post(target, "/crackio/lfm3", { history: [{ role: "user", text: "Hi! Say hi back in a few words." }], max_tokens: 16 }, 10 * 60_000);
    const text = typeof r.json.text === "string" ? r.json.text.trim() : "";
    if (!r.ok || !text) throw new Error(String(r.json.error ?? `It didn't answer (${r.status}).`));
    Object.assign(job, { answer: text.slice(0, 160), seconds: Math.round((Date.now() - t0) / 100) / 10 });

    // 5. Each fine-tune answers too, merged into the weights for it (any answer will do: a file that doesn't load errors).
    //    One asked for while this ran is fetched first. Nothing awaits between the last look and "done", so a fine-tune
    //    that joins later finds the job either still running or finished, never between.
    const checked = new Set<Lfm3LoraKey>();
    for (;;) {
      const next = job.loras.find((k) => !checked.has(k));
      if (!next) break;
      if (!s.loras.includes(next)) s = await fetchFiles(job, target, (await statusOf(target)) ?? s, token);
      const label = LFM3_LORAS[next].label;
      Object.assign(job, { step: "check", progress: null, detail: `Checking ${label}` });
      const a = await post(target, "/crackio/lfm3", { prompt: "Say OK.", max_tokens: 8, lora: next }, 5 * 60_000);
      if (!a.ok || typeof a.json.text !== "string") throw new Error(`${label} didn't load: ${String(a.json.error ?? `it answered ${a.status}`)}`);
      checked.add(next);
    }
    Object.assign(job, { state: "done", detail: "It answers" });
  } catch (err) {
    Object.assign(job, { state: "error", error: err instanceof Error ? err.message : String(err), progress: null });
  } finally {
    job.finishedAt = Date.now();
    forgetLfm3();
    forgetInstalled();
    forgetVoiceMachines();
  }
}
