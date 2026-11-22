import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getGeneration } from "./db";

/**
 * Which job the code running now belongs to, and whether it's work for an agent the user keeps to free paths
 * (lib/agent). The runner enters a job's scope as it starts it; the agent door enters the free-only scope round a tool's
 * own work. Text models that cost Comfy credits read `freeOnlyNow` and stand aside (engines/refine), so a check or a
 * reading inside an agent's job never spends money the user didn't allow. On globalThis: routes load this module apart.
 */
type Scope = { job?: string; freeOnly?: boolean };
const g = globalThis as unknown as { __crackioJobScope?: AsyncLocalStorage<Scope> };
const store = (g.__crackioJobScope ??= new AsyncLocalStorage<Scope>());

/** Runs a job's work in its own scope (server/runner). */
export const inJob = <T>(job: string, fn: () => T): T => store.run({ job }, fn);

/** Runs work an agent asked for directly (finding things, reading a product), held to free paths. */
export const freeOnly = <T>(fn: () => T): T => store.run({ freeOnly: true }, fn);

/** Whether what runs now must not cost money: an agent's own free-only work, or a job such an agent started. */
export function freeOnlyNow(): boolean {
  const scope = store.getStore();
  if (!scope) return false;
  if (scope.freeOnly) return true;
  const agent = scope.job ? (getGeneration(scope.job)?.params?.agent as { free?: unknown } | undefined) : undefined;
  return agent?.free === true;
}
