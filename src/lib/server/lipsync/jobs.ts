import "server-only";
import type { LipsyncSetupJob } from "@/lib/lipsync/machines";

/** Lip Sync setups (server/lipsync/setup), running or just finished, by machine. One server process: a Map on globalThis. */
const g = globalThis as unknown as { __crackioLipsyncSetups?: Map<string, LipsyncSetupJob> };
export const lipsyncJobs = (g.__crackioLipsyncSetups ??= new Map<string, LipsyncSetupJob>());

/** A machine's setup while it runs, and for ten minutes after it ends. */
export function lipsyncJobOf(machine: string): LipsyncSetupJob | null {
  const job = lipsyncJobs.get(machine);
  if (!job) return null;
  if (job.finishedAt && Date.now() - job.finishedAt > 10 * 60_000) return null;
  return { ...job, progress: job.progress ? { ...job.progress } : null };
}
