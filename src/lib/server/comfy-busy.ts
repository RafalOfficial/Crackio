import "server-only";

/**
 * Crackio's jobs in progress on each ComfyUI (by target id), counted from before their inputs go up until their results
 * are down: ComfyUI's own queue is empty between those steps, and a restart then (to load a new custom node) failed jobs.
 * On globalThis, so it survives hot reloads in dev.
 */
const g = globalThis as unknown as { __crackioComfyBusy?: Map<string, number>; __crackioComfyUsed?: Map<string, number> };
const busy = (g.__crackioComfyBusy ??= new Map());
const used = (g.__crackioComfyUsed ??= new Map());

/** Counts a job on a ComfyUI while `run` goes. */
export async function whileBusy<T>(target: string, run: () => Promise<T>): Promise<T> {
  busy.set(target, (busy.get(target) ?? 0) + 1);
  used.set(target, Date.now());
  try {
    return await run();
  } finally {
    used.set(target, Date.now());
    const n = (busy.get(target) ?? 1) - 1;
    if (n > 0) busy.set(target, n);
    else busy.delete(target);
  }
}

/** How many of Crackio's jobs are on that ComfyUI right now. */
export const busyCount = (target: string) => busy.get(target) ?? 0;

/** Whether Crackio has a job on that ComfyUI right now, or had one in the last `quietMs` (jobs often come one after another). */
export const isBusy = (target: string, quietMs = 0) => (busy.get(target) ?? 0) > 0 || Date.now() - (used.get(target) ?? 0) < quietMs;
