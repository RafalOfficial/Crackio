import "server-only";
import type { TalkSetupJob, VoiceSetupJob } from "@/lib/voice/types";

/** Voice setups (server/voice/setup), running or just finished, by machine. One server process: a Map on globalThis. */
const g = globalThis as unknown as { __crackioVoiceSetups?: Map<string, VoiceSetupJob> };
export const setupJobs = (g.__crackioVoiceSetups ??= new Map<string, VoiceSetupJob>());

/** A machine's setup while it runs, and for ten minutes after it ends, so the page can say how it went. */
export function setupJobOf(machine: string): VoiceSetupJob | null {
  const job = setupJobs.get(machine);
  if (!job) return null;
  if (job.finishedAt && Date.now() - job.finishedAt > 10 * 60_000) return null;
  return { ...job, tried: [...job.tried], progress: job.progress ? { ...job.progress } : null, result: job.result ? { ...job.result } : null };
}

/** Talk's LFM3-VL setups (server/voice/talk-setup), by machine, kept the same way. */
const gt = globalThis as unknown as { __crackioTalkSetups?: Map<string, TalkSetupJob> };
export const talkSetupJobs = (gt.__crackioTalkSetups ??= new Map<string, TalkSetupJob>());

export function talkSetupJobOf(machine: string): TalkSetupJob | null {
  const job = talkSetupJobs.get(machine);
  if (!job || (job.finishedAt && Date.now() - job.finishedAt > 10 * 60_000)) return null;
  return { ...job, progress: job.progress ? { ...job.progress } : null };
}
