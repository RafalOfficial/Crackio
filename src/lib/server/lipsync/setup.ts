import "server-only";
import { comfyTargets, type ComfyTarget } from "../comfy-targets";
import { getSettings } from "../settings";
import { ask } from "../voice/machines";
import { lipsyncJobs } from "./jobs";
import { LIPSYNC_BRIDGE, lipsyncMachines } from "./machines";
import { LipsyncError } from "./analyze";
import { LIPSYNC_FILES, LIPSYNC_VRAM_GB, type LipsyncMachine, type LipsyncSetupJob } from "@/lib/lipsync/machines";

/**
 * Setting Lip Sync up on a machine in one go, in the background: its engine (pinned packages, LatentSync's code,
 * MediaPipe's landmarkers, a first check), LatentSync's files (with your Hugging Face token: ByteDance's are gated),
 * then the check again with the model loaded. The job shows in /api/lipsync/machines as it goes.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Download = { id: string; folder: string; filename: string; state: string; received: number; total: number; error: string | null };
type Status = { engine: unknown; install: { state: string; step: string | null; error: string | null }; check?: { state: string; error: string | null }; models: Record<string, boolean> };

const STEP_WORDS: Record<string, string> = { packages: "Installing its packages", code: "Getting LatentSync's code", landmarks: "Getting the face landmarker", checking: "Checking it runs" };

export async function setUpLipsync(machineId?: string): Promise<LipsyncSetupJob> {
  const machines = await lipsyncMachines(true);
  const usable = machines.filter((m) => m.online);
  // Picked for you: an NVIDIA card with room for LatentSync (Macs only when asked for by name: not tried there yet).
  const machine =
    usable.find((m) => m.id === machineId) ??
    (machineId ? null : usable.filter((m) => m.ready && !m.unified && (m.gpuGb ?? 0) >= LIPSYNC_VRAM_GB).sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0]);
  if (!machine) throw new LipsyncError(machineId ? "That computer isn't answering." : `Lip Sync needs a GPU with ${LIPSYNC_VRAM_GB} GB or more.`, 409);
  if (!machine.ready) {
    throw new LipsyncError(`${machine.label} has Crackio bridge ${machine.bridge ?? "none"}; Lip Sync needs ${LIPSYNC_BRIDGE}. Restart its ComfyUI from Crackio (or connect the GPU again) to bring it.`, 409);
  }
  const running = lipsyncJobs.get(machine.id);
  if (running?.state === "running") return running;
  const target = (await comfyTargets()).find((t) => t.id === machine.id);
  if (!target) throw new LipsyncError("That computer isn't connected.", 404);
  const files = LIPSYNC_FILES.filter((f) => !machine.models[f.key]);
  const needGb = files.reduce((s, f) => s + f.bytes, 0) / 1e9 + (machine.engine ? 0 : 1.5);
  if (machine.diskGb != null && machine.diskGb < needGb + 1) {
    throw new LipsyncError(`${machine.label} needs ${Math.ceil(needGb + 1)} GB free for Lip Sync; it has ${machine.diskGb.toFixed(1)} GB.`, 409);
  }
  const token = (await getSettings()).keys.hf?.trim() || process.env.HF_TOKEN?.trim() || "";
  if (files.some((f) => f.gated) && !token) {
    throw new LipsyncError("LatentSync's files need your Hugging Face token: add it under Settings → Accounts, after accepting ByteDance/LatentSync-1.6's terms on Hugging Face.", 409);
  }
  const job: LipsyncSetupJob = { machine: machine.id, label: machine.gpu ?? machine.label, state: "running", step: "engine", detail: "Starting", progress: null, error: null, startedAt: Date.now(), finishedAt: null };
  lipsyncJobs.set(machine.id, job);
  void runSetup(job, target, machine, files, token);
  return job;
}

async function status(target: ComfyTarget) {
  return ask<Status>(target, "/crackio/lipsync", { timeoutMs: 8000 });
}

async function until(target: ComfyTarget, done: (s: Status) => boolean, withinMs: number) {
  const end = Date.now() + withinMs;
  let heard = Date.now();
  while (Date.now() < end) {
    await sleep(2000);
    const s = await status(target);
    if (!s) {
      if (Date.now() - heard > 90_000) throw new Error("The computer stopped answering.");
      continue;
    }
    heard = Date.now();
    if (done(s)) return s;
  }
  throw new Error("It took too long.");
}

async function runSetup(job: LipsyncSetupJob, target: ComfyTarget, machine: LipsyncMachine, files: (typeof LIPSYNC_FILES)[number][], token: string) {
  try {
    // 1. The engine (its first check runs without the model when the files aren't there yet).
    if (!machine.engine) {
      Object.assign(job, { step: "engine", detail: "Installing the lip-sync engine" });
      const res = await ask<{ error?: string }>(target, "/crackio/lipsync/engine", { method: "POST", body: "{}", timeoutMs: 20000 });
      if (!res || res.error) throw new Error(res?.error ?? "The engine didn't start installing.");
      await until(
        target,
        (s) => {
          if (s.install.state === "error") throw new Error(s.install.error ?? "The engine didn't install.");
          if (s.install.step) job.detail = STEP_WORDS[s.install.step] ?? job.detail;
          return s.install.state === "done" && Boolean(s.engine);
        },
        30 * 60_000,
      );
    }
    // 2. LatentSync's files.
    if (files.length) {
      const total = files.reduce((s, f) => s + f.bytes, 0);
      Object.assign(job, { step: "files", progress: { received: 0, total }, detail: `Downloading LatentSync 1.6 · ${(total / 1e9).toFixed(1)} GB` });
      for (const f of files) {
        const res = await ask<{ error?: string }>(target, "/crackio/download", {
          method: "POST",
          body: JSON.stringify({ url: f.url, folder: "latentsync", filename: f.name, size: f.bytes, ...(f.gated ? { token } : {}) }),
          timeoutMs: 20000,
        });
        if (!res || res.error) throw new Error(res?.error ?? `The computer refused ${f.name}.`);
      }
      const end = Date.now() + 6 * 60 * 60_000;
      while (Date.now() < end) {
        await sleep(2500);
        const [list, s] = await Promise.all([ask<Download[]>(target, "/crackio/downloads"), status(target)]);
        const mine = (list ?? []).filter((d) => d.folder === "latentsync" && files.some((f) => f.name === d.filename));
        const failed = mine.find((d) => d.state === "error" || d.state === "stopped");
        if (failed) {
          const gated = /401|403|gated|access/i.test(failed.error ?? "");
          throw new Error(gated ? "Hugging Face refused LatentSync's files: accept ByteDance/LatentSync-1.6's terms with the account of your token, then try again." : `${failed.filename} didn't download: ${failed.error ?? "unknown error"}`);
        }
        const here = files.filter((f) => s?.models[f.key]);
        const got = files.reduce((sum, f) => sum + (here.includes(f) ? f.bytes : Math.min(f.bytes, mine.find((d) => d.filename === f.name)?.received ?? 0)), 0);
        job.progress = { received: got, total };
        if (here.length === files.length) break;
      }
      if (!job.progress || job.progress.received < total) throw new Error("The downloads took too long.");
    }
    // 3. The check, with LatentSync loaded this time.
    Object.assign(job, { step: "check", progress: null, detail: "Loading LatentSync to check it runs" });
    const started = await ask<{ error?: string }>(target, "/crackio/lipsync/check", { method: "POST", body: "{}", timeoutMs: 20000 });
    if (!started || started.error) throw new Error(started?.error ?? "The check didn't start.");
    await until(
      target,
      (s) => {
        if (s.check?.state === "error") throw new Error(s.check.error ?? "The check failed.");
        return s.check?.state === "done";
      },
      20 * 60_000,
    );
    Object.assign(job, { state: "done", detail: "Lip Sync works here", progress: null });
  } catch (err) {
    Object.assign(job, { state: "error", error: (err as Error).message, progress: null });
  } finally {
    job.finishedAt = Date.now();
  }
}
