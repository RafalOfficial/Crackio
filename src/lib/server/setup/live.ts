import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { comfyTargets, isHere, type ComfyTarget } from "../comfy-targets";
import { allLocalModels } from "../local-templates";
import { sshRun } from "../ssh";
import type { LiveGpu } from "@/lib/setup/types";

/**
 * Each machine's GPU right now, for Settings' meters: how busy it is, its memory in use, how hot it runs and what it
 * draws, whether ComfyUI is working and on which model. This computer reads nvidia-smi itself; another machine answers
 * through its Crackio helper (/crackio/live), and a rented box's temperature comes over its SSH. Read at most every
 * 2.5 s per machine, however many pages ask.
 */

const run = promisify(execFile);
const QUERY = "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw";

type Cached = { at: number; value: Promise<LiveGpu> };
const g = globalThis as unknown as { __crackioLive?: Map<string, Cached>; __crackioLiveHeat?: Map<string, { at: number; value: Promise<Heat | null> }> };
const cache = (g.__crackioLive ??= new Map());
const heats = (g.__crackioLiveHeat ??= new Map());

type Heat = { tempC: number | null; powerW: number | null; util: number | null; memUsedGb: number | null; memTotalGb: number | null };

const num = (s: string | undefined) => {
  const n = Number.parseFloat(String(s ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** nvidia-smi's first GPU line: load %, memory MiB used and total, °C, watts. */
function parseSmi(out: string): Heat | null {
  const line = out.trim().split(/\r?\n/)[0];
  if (!line) return null;
  const [util, used, total, temp, power] = line.split(",").map((x) => x.trim());
  return { util: num(util), memUsedGb: num(used) !== null ? num(used)! / 1024 : null, memTotalGb: num(total) !== null ? num(total)! / 1024 : null, tempC: num(temp), powerW: num(power) };
}

/** A rented box's nvidia-smi over SSH, every 12 s at most (its helper doesn't say the temperature). */
function sshHeat(t: ComfyTarget): Promise<Heat | null> {
  const login = t.cloud?.ssh;
  if (!login) return Promise.resolve(null);
  const hit = heats.get(t.id);
  if (hit && Date.now() - hit.at < 12_000) return hit.value;
  const value = sshRun(login, `nvidia-smi ${QUERY} --format=csv,noheader,nounits`, { timeoutMs: 8000 })
    .then((r) => (r.code === 0 ? parseSmi(r.stdout) : null))
    .catch(() => null);
  heats.set(t.id, { at: Date.now(), value });
  return value;
}

async function getJson<T>(t: ComfyTarget, path: string, timeoutMs = 4000): Promise<T | null> {
  try {
    const res = await fetch(`${t.url}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: t.token ? { Authorization: `Bearer ${t.token}` } : {},
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type Queue = { queue_running?: unknown[][]; queue_pending?: unknown[][] };

/** The model a running graph loads, by its files: "LTX-2.5 INT8". */
function runningModel(queue: Queue | null) {
  const graph = queue?.queue_running?.[0]?.[2] as Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | undefined;
  if (!graph) return null;
  const files = new Set<string>();
  for (const n of Object.values(graph)) {
    if (!/Loader|GGUF/i.test(n.class_type ?? "")) continue;
    for (const v of Object.values(n.inputs ?? {})) if (typeof v === "string") files.add(v.split(/[\\/]/).pop()!);
  }
  for (const m of allLocalModels()) {
    for (const v of m.variants) {
      if (v.files.some((f) => f.role === "model" || f.folder === "diffusion_models" || f.folder === "checkpoints") && v.files.some((f) => files.has(f.name))) return `${m.name} ${v.label}`;
    }
  }
  return files.size ? "a workflow" : null;
}

async function read(t: ComfyTarget): Promise<LiveGpu> {
  const base: LiveGpu = { machine: t.id, at: Date.now(), online: false, util: null, memUsedGb: null, memTotalGb: null, tempC: null, powerW: null, working: false, queue: 0, running: null };
  if (t.metered) return base;
  const queueP = getJson<Queue>(t, "/queue");
  if (isHere(t)) {
    const [smi, queue] = await Promise.all([
      run("nvidia-smi", [QUERY, "--format=csv,noheader,nounits"], { timeout: 4000, windowsHide: true })
        .then((r) => parseSmi(r.stdout))
        .catch(() => null),
      queueP,
    ]);
    const queued = (queue?.queue_running?.length ?? 0) + (queue?.queue_pending?.length ?? 0);
    return { ...base, online: Boolean(queue), ...(smi ?? {}), working: queued > 0, queue: queued, running: runningModel(queue) };
  }
  type Live = { util?: number | null; memory_used?: number | null; memory_total?: number | null; comfy_working?: boolean; mac?: { thermal?: string | null } };
  const [live, queue, heat] = await Promise.all([getJson<Live>(t, "/crackio/live"), queueP, sshHeat(t)]);
  const queued = (queue?.queue_running?.length ?? 0) + (queue?.queue_pending?.length ?? 0);
  return {
    ...base,
    online: Boolean(live || queue),
    util: live?.util ?? heat?.util ?? null,
    memUsedGb: live?.memory_used != null ? live.memory_used / 1024 : (heat?.memUsedGb ?? null),
    memTotalGb: live?.memory_total != null ? live.memory_total / 1024 : (heat?.memTotalGb ?? null),
    tempC: heat?.tempC ?? null,
    powerW: heat?.powerW ?? null,
    working: Boolean(live?.comfy_working) || queued > 0,
    queue: queued,
    running: runningModel(queue),
    thermal: live?.mac?.thermal ?? null,
  };
}

/** Machines' GPUs now: the ones asked (by id), else every one that isn't billed per job. */
export async function liveGpus(ids?: string[]): Promise<LiveGpu[]> {
  // Not ComfyUI's usual address checked in case one runs there (it isn't one of your machines unless it answers).
  const targets = (await comfyTargets()).filter((t) => !t.metered && !t.implicit && (!ids?.length || ids.includes(t.id)));
  return Promise.all(
    targets.map((t) => {
      const hit = cache.get(t.id);
      if (hit && Date.now() - hit.at < 2500) return hit.value;
      const value = read(t).catch(() => ({ machine: t.id, at: Date.now(), online: false, util: null, memUsedGb: null, memTotalGb: null, tempC: null, powerW: null, working: false, queue: 0, running: null }));
      cache.set(t.id, { at: Date.now(), value });
      return value;
    }),
  );
}
