import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { comfyTargets, type ComfyTarget } from "../comfy-targets";
import { machineLook } from "../machine-probe";
import { DATA_DIR } from "../paths";
import { getSettings } from "../settings";
import { lfm3TransformersOk } from "@/lib/local/lfm3";
import { HEARING, VOICE_MODELS, modelOfFile, variantFor, type VoiceModelId } from "@/lib/voice/models";
import type { TalkBrain, VoiceCheck, VoiceMachine } from "@/lib/voice/types";
import { setupJobOf, talkSetupJobOf } from "./jobs";

/**
 * Where Voice runs: every ComfyUI Crackio knows (this computer, a rented GPU), as the Crackio bridge 1.8+ describes it
 * (comfyui/crackio_bridge/voice.py): its GPU and memory, whether audio.cpp is installed, which voice models it has.
 */

const BRIDGE = "1.8.0";
const newer = (a: string | null, b: string) => Boolean(a) && a!.localeCompare(b, undefined, { numeric: true }) >= 0;

export async function ask<T>(t: ComfyTarget, pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<T | null> {
  try {
    const res = await fetch(`${t.url}${pathname}`, {
      ...init,
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 6000),
      headers: { ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}), ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type Info = { version?: string; ram_total?: number; gpus?: { name: string; memory: number | null; backend?: string }[]; os?: { system?: string } };
/** Bridge 1.8.5 checks audio.cpp builds before keeping one, and proves Voice with a test line. */
export const SETUP_BRIDGE = "1.8.5";
export const bridgeAtLeast = newer;
export type VoiceStatus = {
  folder: string;
  disk_free: number | null;
  ram_free: number | null;
  engine: { build: string; gpu?: string | null; spoke?: number } | null;
  build: string | null;
  /** Bridge 1.8.5+: the builds for this machine best first, the system, the test line. */
  builds?: string[];
  platform?: { system: string; machine: string };
  install: { state: string; received: number; total: number; error: string | null; build?: string | null; tried?: { build: string; error: string }[]; gpu?: string | null };
  check?: Omit<VoiceCheck, "state"> & { state: VoiceCheck["state"] | "idle" };
  server: { running: boolean };
  models: { file: string; family: string; kind: string; bytes: number }[];
};
type Download = { id: string; folder: string; filename: string; state: string; received: number; total: number; error: string | null };

/** Bridge 1.9.2 says what LFM3-VL (Talk's answers) has on a machine, and sets it up (lfm3_setup.py). */
export const BRAIN_BRIDGE = "1.9.2";
/** What GET /crackio/lfm3/setup says. */
export type Lfm3Status = {
  weights: boolean;
  tokenizer: boolean;
  loras: string[];
  transformers: string | null;
  transformers_used: string | null;
  transformers_ok: boolean;
  restart: boolean;
  want: string;
  folder: string;
  disk_free: number | null;
  packages: { state: "idle" | "running" | "done" | "error"; error: string | null; upgraded: string | null };
};

function brainOf(s: Lfm3Status | null): TalkBrain | null {
  if (!s) return null;
  const files = s.weights && s.tokenizer;
  return {
    ready: files && s.transformers_ok && !s.restart && lfm3TransformersOk(s.transformers_used ?? s.transformers),
    files,
    transformers: s.transformers,
    transformersOk: s.transformers_ok,
    restart: s.restart,
    loras: s.loras,
    diskGb: s.disk_free != null ? s.disk_free / 1e9 : null,
  };
}

/**
 * What each machine had when it last answered (data/cache/voice-seen.json): a rented GPU that's switched off still says
 * where your voice models are, so Voice doesn't offer to download them again somewhere else.
 */
type Seen = Record<string, { gpu: string | null; models: VoiceModelId[]; at: number }>;
const SEEN_FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "voice-seen.json");
const gs = globalThis as unknown as { __crackioVoiceSeen?: Promise<Seen> };

async function remember(list: VoiceMachine[]): Promise<Seen> {
  const seen = await (gs.__crackioVoiceSeen ??= fs
    .readFile(/*turbopackIgnore: true*/ SEEN_FILE, "utf8")
    .then((t) => JSON.parse(t) as Seen)
    .catch(() => ({}) as Seen));
  let changed = false;
  for (const m of list) {
    if (!m.online || !m.voiceReady) continue;
    const was = seen[m.id];
    if (was && was.gpu === m.gpu && was.models.join() === m.models.join() && Date.now() - was.at < 24 * 3600_000) continue;
    seen[m.id] = { gpu: m.gpu, models: m.models, at: Date.now() };
    changed = true;
  }
  if (changed) {
    const tmp = `${SEEN_FILE}.${process.pid}-${Date.now()}.tmp`;
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(SEEN_FILE), { recursive: true });
    await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(seen));
    await fs.rename(/*turbopackIgnore: true*/ tmp, SEEN_FILE).catch(() => fs.rm(/*turbopackIgnore: true*/ tmp, { force: true }));
  }
  return seen;
}

const g = globalThis as unknown as { __crackioVoiceMachines?: { at: number; list: Promise<VoiceMachine[]> } };

/** Every machine that could run Voice, looked at afresh at most every 3 s. */
export function voiceMachines(fresh = false): Promise<VoiceMachine[]> {
  const hit = g.__crackioVoiceMachines;
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.list;
  const list = (async () => {
    const targets = (await comfyTargets()).filter((t) => !t.metered && !t.serverless);
    const runOn = (await getSettings()).runOn ?? null;
    const out = await Promise.all(
      targets.map(async (t): Promise<VoiceMachine> => {
        // A machine that isn't answering (a rented GPU switched off) is known at once from the shared look
        // (server/machine-probe, re-asked in the background), so these four questions never wait out its timeout.
        const look = await machineLook(t);
        const [info, voice, downloads, lfm3] = look.stats
          ? await Promise.all([
              ask<Info>(t, "/crackio/info"),
              ask<VoiceStatus>(t, "/crackio/voice"),
              ask<Download[]>(t, "/crackio/downloads"),
              ask<Lfm3Status>(t, "/crackio/lfm3/setup"),
            ])
          : [null, null, null, null];
        const gpu = info?.gpus?.[0] ?? null;
        const ramGb = info?.ram_total ? info.ram_total / 1024 ** 3 : null;
        // A Mac's GPU shares its memory: a model can use about two thirds of it (three quarters on the big ones).
        const unified = gpu?.backend === "mps";
        const gpuGb = unified ? (ramGb ? ramGb * (ramGb >= 36 ? 0.75 : 0.66) : null) : gpu?.memory ? gpu.memory / 1024 ** 3 : null;
        const files = (voice?.models ?? []).map((m) => m.file);
        const system = (voice?.platform?.system ?? info?.os?.system ?? "").toLowerCase();
        const stage = voice?.install?.state;
        const check = voice?.check && voice.check.state !== "idle" ? { ...voice.check, state: voice.check.state } : null;
        return {
          id: t.id,
          label: t.label,
          online: Boolean(info),
          gpu: gpu?.name?.replace(/^NVIDIA (GeForce )?/i, "") ?? null,
          gpuGb,
          ramGb,
          diskGb: voice?.disk_free != null ? voice.disk_free / 1e9 : null,
          bridge: info?.version ?? null,
          voiceReady: newer(info?.version ?? null, BRIDGE) && Boolean(voice),
          engine: voice?.engine ? voice.engine.build : null,
          installing: voice?.install && ["downloading", "unpacking", "checking"].includes(voice.install.state) ? { received: voice.install.received, total: voice.install.total } : null,
          installError: voice?.install?.state === "error" ? voice.install.error : null,
          platform: system === "windows" ? "windows" : system === "darwin" ? "macos" : system === "linux" ? "linux" : null,
          unified,
          builds: voice?.builds ?? (voice?.build ? [voice.build] : []),
          installStage: stage === "downloading" || stage === "unpacking" || stage === "checking" ? stage : null,
          installTried: voice?.install?.tried ?? [],
          engineGpu: voice?.engine?.gpu ?? null,
          engineSpoke: Boolean(voice?.engine?.spoke),
          check,
          setup: setupJobOf(t.id),
          files,
          models: VOICE_MODELS.filter((m) => m.variants.some((v) => files.includes(v.file.name))).map((m) => m.id),
          hearing: HEARING.every((h) => files.includes(h.name)),
          downloads: (downloads ?? []).filter((d) => d.folder === "audiocpp" && ["queued", "downloading", "checking"].includes(d.state)).map((d) => ({ id: d.id, file: d.filename, received: d.received, total: d.total })),
          runOn: runOn === t.id,
          brain: brainOf(lfm3),
          brainSetup: talkSetupJobOf(t.id),
        };
      }),
    );
    // A machine that isn't answering keeps what it had when it last did.
    const seen = await remember(out).catch(() => ({}) as Seen);
    return out.map((m) => (m.online || !seen[m.id]?.models.length ? m : { ...m, away: seen[m.id] }));
  })();
  g.__crackioVoiceMachines = { at: Date.now(), list };
  return list;
}

export function forgetVoiceMachines() {
  g.__crackioVoiceMachines = undefined;
}

/**
 * The machine a take of this model runs on: the one picked under Run on when it has the model, else the one with the
 * biggest GPU that has it. Null when no machine has it.
 */
export async function machineFor(model: VoiceModelId): Promise<{ target: ComfyTarget; machine: VoiceMachine } | null> {
  const machines = (await voiceMachines()).filter((m) => m.online && m.voiceReady && m.engine && m.models.includes(model));
  const pick = machines.find((m) => m.runOn) ?? machines.sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  if (!pick) return null;
  const target = (await comfyTargets()).find((t) => t.id === pick.id);
  return target ? { target, machine: pick } : null;
}

/** The machine that should get a model: the one asked for, else the biggest GPU it runs on. */
export async function installTarget(model: VoiceModelId, machineId?: string) {
  const m = VOICE_MODELS.find((x) => x.id === model);
  if (!m) return null;
  const machines = (await voiceMachines(true)).filter((x) => x.online);
  const fits = machines.filter((x) => variantFor(m, x.gpuGb, x.ramGb, x.unified));
  const pick = machines.find((x) => x.id === machineId) ?? fits.find((x) => x.runOn) ?? fits.sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  if (!pick) return null;
  const target = (await comfyTargets()).find((t) => t.id === pick.id);
  return target ? { target, machine: pick } : null;
}

export { modelOfFile };
