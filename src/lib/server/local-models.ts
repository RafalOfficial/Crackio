import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { allLocalModels } from "./local-templates";
import { regionOf } from "@/lib/local/families";
import type { Download, LocalEstimate, LocalFile, LocalModel, LocalStatus, LocalVariant, MacHeat, Machine, TargetStatus } from "@/lib/local/types";
import { cardWork, pictureWork, type MeasuredSpeed, type ModelSpeeds, type SpeedMode } from "@/lib/local/work";
import { fitModel, fitVariant, shortGpuName, speedOf } from "@/lib/local/fit";
import { estimateJob, mainMode, machineFactor, pcieGBps, recipeKey, type Estimate, type Live, type MachineRuns } from "@/lib/local/estimate";

export type { Download, LocalStatus };
import { comfyMachine, thisComputer, type BridgeInfo, type SystemStats } from "./hardware";
import { addedId, comfyTargets, currentTarget, forgetTargets, isHere, samePlace, targetById, withTarget, type ComfyTarget } from "./comfy-targets";
import { serverlessEndpoints } from "./serverless/endpoints";
import { fetchModels } from "./serverless/shim";
import { comfyCloudBlocked } from "./serverless/comfy-cloud";
import { closeTunnels } from "./ssh";
import { busyCount, isBusy } from "./comfy-busy";
import { getSettings, updateSettings } from "./settings";
import { DATA_DIR } from "./paths";
import { writeFileAtomic } from "./atomic-write";

/**
 * The Local page's server side, for each ComfyUI Crackio knows (comfy-targets): which machine it is and what it can hold,
 * which catalog files are already in its model folders, and installs. A ComfyUI with the Crackio bridge node
 * (comfyui/crackio_bridge) downloads files itself, wherever it runs; a ComfyUI on this computer without it gets them
 * written straight into its model folders from here. Everything here talks to `currentTarget()`.
 */

/** Every model folder any Local model uses, for checking what's installed. */
function localFolders() {
  return [...new Set(allLocalModels().flatMap((m) => m.variants.flatMap((v) => v.files.map((f) => f.folder))))];
}
const localModel = (id: string) => allLocalModels().find((m) => m.id === id) ?? null;

type DirectDownload = Download & { stop: boolean; target: string };

const g = globalThis as unknown as {
  __crackioLocalDirect?: Map<string, DirectDownload>;
  __crackioThisComputer?: { at: number; machine: Promise<Machine> };
  /** ComfyUIs that got a custom node: restarted once their downloads finish, so it loads. */
  __crackioRestartFor?: Set<string>;
  __crackioInstalledFor?: Map<string, { at: number; files: Promise<Set<string>> }>;
};
const direct = (g.__crackioLocalDirect ??= new Map());
const restartPending = (g.__crackioRestartFor ??= new Set());
const installedCache = (g.__crackioInstalledFor ??= new Map());

function comfyFetch(pathname: string, init?: RequestInit & { timeoutMs?: number }) {
  const t = currentTarget();
  return fetch(`${t.url}${pathname}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(init?.timeoutMs ?? (isHere(t) ? 3000 : 8000)),
    headers: { ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}), ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
}

async function comfyJson<T>(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<T | null> {
  try {
    const res = await comfyFetch(pathname, init);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Whether one of your machines' ComfyUI answers now (asked afresh, unlike `answers`). */
export async function machineAnswers(targetId: string, timeoutMs = 5000): Promise<boolean> {
  const t = (await comfyTargets()).find((x) => x.id === targetId);
  return t ? withTarget(t, async () => (await comfyJson("/system_stats", { timeoutMs })) !== null) : false;
}

/** This computer's hardware, read once every ten minutes (the Windows registry read takes a second). */
function computer() {
  const hit = g.__crackioThisComputer;
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.machine;
  const machine = thisComputer();
  g.__crackioThisComputer = { at: Date.now(), machine };
  machine.catch(() => (g.__crackioThisComputer = undefined));
  return machine;
}

async function hfToken() {
  return (await getSettings()).keys.hf?.trim() || process.env.HF_TOKEN?.trim() || "";
}

const ACTIVE = ["queued", "downloading", "checking"];

const others = new Map<string, { gb: number; at: number }>();

/**
 * What a ComfyUI's card really has for models: its size less what other apps hold on it (a desktop, browsers), so a
 * model that would spill into shared memory, several times slower on Windows, isn't called a fit. Other apps' share is
 * the card's use outside ComfyUI's own PyTorch memory, at its lowest over the last ten minutes (ComfyUI's working buffers
 * count in it while a job runs).
 */
function freeForModels(id: string, machine: Machine, stats: SystemStats) {
  const dev = stats.devices?.[0];
  const gpu = machine.gpus[0];
  if (!gpu || gpu.unified || !dev?.vram_total || typeof dev.vram_free !== "number") return machine.modelMemoryGb;
  const now = (dev.vram_total - dev.vram_free - (dev.torch_vram_total ?? 0)) / 1024 ** 3;
  const seen = others.get(id);
  const low = seen && Date.now() - seen.at < 10 * 60_000 && seen.gb <= now ? seen : { gb: Math.max(0, now), at: Date.now() };
  others.set(id, low);
  return Math.round(Math.min(machine.modelMemoryGb, dev.vram_total / 1024 ** 3 - low.gb) * 10) / 10;
}

/** One ComfyUI: the machine it runs on, what it has installed, its downloads and what its models measured there. */
async function targetStatus(t: ComfyTarget, mine: Machine): Promise<{ status: TargetStatus; machine: Machine | null }> {
  return withTarget(t, async () => {
    const onThisComputer = isHere(t);
    const [stats, bridge] = await Promise.all([comfyJson<Parameters<typeof comfyMachine>[1]>("/system_stats"), comfyJson<BridgeInfo>("/crackio/info")]);
    let machine: Machine | null = null;
    if (stats) {
      const theirs = comfyMachine(t.url, stats, bridge);
      // On this computer: the OS's own reading, with what ComfyUI really computes on.
      machine = onThisComputer
        ? {
            ...mine,
            where: "comfyui",
            accel: theirs.accel,
            comfy: theirs.comfy,
            // What the card has free for models now, other apps on it counted.
            modelMemoryGb: theirs.accel === "cpu" ? 0 : Math.min(mine.modelMemoryGb || theirs.modelMemoryGb, theirs.modelMemoryGb || mine.modelMemoryGb),
            // The drive ComfyUI keeps its models on, which may not be the system drive.
            diskFreeGb: theirs.diskFreeGb ?? mine.diskFreeGb,
            gpus: mine.gpus.map((gpu, i) => ({ ...gpu, compute: gpu.compute ?? (i === 0 ? theirs.gpus[0]?.compute : undefined) })),
            target: t.id,
          }
        : { ...theirs, target: t.id };
      // A card on this computer also drives its screens; a rented box's is ComfyUI's alone (its own models unload for a job).
      machine.modelMemoryGb = freeForModels(t.id, machine, stats);
    }
    // The rest in one round: a far-away box answers each request in half a second.
    const [installed, rawDownloads, measured, lends, live, speeds] = stats
      ? await Promise.all([
          listInstalled(bridge?.version),
          bridge ? comfyJson<Download[]>("/crackio/downloads") : null,
          measuredOn(gpuKeyFrom(stats, bridge)),
          bridge ? comfyJson<{ free?: number; held?: number }>("/crackio/pool") : null,
          liveHere(),
          readSpeeds(),
        ])
      : [new Set<string>(), null, {}, null, {} as Live, {} as Speeds];
    const ran = stats ? machineRuns(speeds, gpuKeyFrom(stats, bridge)) : undefined;
    const est = machine && stats ? await estimatesFor(machine, installed, ran, live) : null;
    const mineDirect = [...direct.values()].filter((d) => d.target === t.id);
    for (const d of mineDirect) if (d.state === "done") installed.add(`${d.folder}/${d.filename}`);
    // A fresh look is the model pickers' look too: an install that just finished is usable at once.
    if (stats) installedCache.set(t.id, { at: Date.now(), files: Promise.resolve(new Set(installed)) });

    const fromBridge = (rawDownloads ?? []).map((d) => ({ ...d, via: "bridge" as const }));
    const downloads = [...fromBridge, ...mineDirect.map((d): Download => ({ id: d.id, folder: d.folder, filename: d.filename, state: d.state, received: d.received, total: d.total, error: d.error, via: d.via }))];
    // New custom nodes load when ComfyUI restarts: once its downloads are done, and never while it's working on a job
    // (the restart would lose it).
    // Only a machine that's been quiet for two minutes: jobs come one after another, and the next one's upload met the
    // restart. A job that needs the new node restarts it itself first (restartIfPending).
    if (restartPending.has(t.id) && bridge && !fromBridge.some((d) => ACTIVE.includes(d.state)) && !isBusy(t.id, 2 * 60_000)) {
      const queue = await comfyJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue");
      if (queue && !queue.queue_running?.length && !queue.queue_pending?.length) {
        restartPending.delete(t.id);
        // Turned away (a node still installing, a download just queued): asked again on a later check.
        void comfyFetch("/crackio/restart", { method: "POST", body: "{}" })
          .then((res) => void (res.ok || restartPending.add(t.id)))
          .catch(() => undefined);
      }
    }
    return {
      status: {
        id: t.id,
        label: t.label,
        url: t.url,
        source: t.source,
        ...(t.implicit ? { implicit: true } : {}),
        ...(t.cloud ? { cloud: { provider: t.cloud.provider, instance: t.cloud.instance, tunnel: Boolean(t.tunnel) } } : {}),
        connected: Boolean(stats),
        onThisComputer,
        bridge: bridge?.version ?? null,
        installed: [...installed],
        downloads,
        measured,
        lendsGb: typeof lends?.free === "number" ? Math.round((((lends.free ?? 0) + (lends.held ?? 0)) / 1024 ** 3) * 10) / 10 : null,
        ...(est ? { estimates: est.estimates, live: { ...(live.busy !== undefined ? { busy: live.busy } : {}), ...(live.pcieGBps ? { pcieGBps: live.pcieGBps } : {}), factor: est.factor, ...(est.accuracy ? { accuracy: est.accuracy } : {}), ...(live.mac ? { mac: live.mac } : {}) } } : {}),
      },
      machine,
    };
  });
}

export async function localStatus(): Promise<LocalStatus> {
  const [targets, mine, token, settings] = await Promise.all([comfyTargets(), computer(), hfToken(), getSettings()]);
  const all = await Promise.all(targets.map((t) => targetStatus(t, mine)));
  const main = all[0].status;
  // The ComfyUIs that answer, then this computer when none of them runs on it.
  const machines = all.map((x) => x.machine).filter((m): m is Machine => m !== null);
  if (!all.some((x) => x.machine && x.status.onThisComputer)) machines.push(mine);
  const region = regionOf(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return {
    comfy: { url: main.url, connected: main.connected, onThisComputer: main.onThisComputer, bridge: main.bridge },
    machines,
    installed: main.installed,
    downloads: main.downloads,
    hfToken: Boolean(token),
    pooling: settings.pooling ?? "auto",
    // A machine chosen and since gone is Auto again.
    runOn: settings.runOn && targets.some((t) => t.id === settings.runOn) ? settings.runOn : "auto",
    measured: main.measured,
    region,
    targets: all.map((x) => x.status),
  };
}

/**
 * `folder/name` of every model file in the folders Local models use. ComfyUI lists GGUF files apart, under the folders
 * ComfyUI-GGUF adds (unet_gguf, clip_gguf), and only while that node is loaded, which is when they can run.
 */
async function listInstalled(bridge?: string): Promise<Set<string>> {
  // The bridge (1.1+) lists every model folder in one answer.
  if (bridge && bridge.localeCompare("1.1.0", undefined, { numeric: true }) >= 0) {
    const all = await comfyJson<Record<string, string[]>>("/crackio/files", { timeoutMs: 15_000 });
    if (all) {
      const out = new Set<string>();
      const as: Record<string, string> = { unet_gguf: "diffusion_models", clip_gguf: "text_encoders", unet: "diffusion_models", clip: "text_encoders" };
      for (const [folder, names] of Object.entries(all)) for (const name of names) out.add(`${as[folder] ?? folder}/${name.replace(/\\/g, "/")}`);
      return out;
    }
  }
  const asked: [string, string][] = [...localFolders().map((f): [string, string] => [f, f]), ["unet_gguf", "diffusion_models"], ["clip_gguf", "text_encoders"]];
  const lists = await Promise.all(asked.map(async ([route, folder]) => [folder, (await comfyJson<string[]>(`/models/${route}`)) ?? []] as const));
  const out = new Set<string>();
  for (const [folder, names] of lists) for (const name of names) out.add(`${folder}/${name.replace(/\\/g, "/")}`);
  return out;
}

/** ComfyUIs that didn't answer lately, until when they're skipped (a stopped box shouldn't slow every model list). */
const quiet = new Map<string, number>();

/** Whether the current ComfyUI answers, asked at most every 30 s once it hasn't. */
async function answers() {
  const t = currentTarget();
  if ((quiet.get(t.id) ?? 0) > Date.now()) return false;
  const ok = (await comfyJson("/system_stats", { timeoutMs: isHere(t) ? 1500 : 4000 })) !== null;
  if (ok) quiet.delete(t.id);
  else quiet.set(t.id, Date.now() + 30_000);
  return ok;
}

/** The current ComfyUI's files are looked at again on the next ask (one was just installed). */
export function forgetInstalled() {
  installedCache.delete(currentTarget().id);
}

/** The last files each ComfyUI was seen with, and when. */
const lastSeen = new Map<string, { at: number; files: Set<string> }>();

/**
 * `folder/name` of every catalog file the current ComfyUI has, read at most every 20 s (model lists ask often). A box
 * busy rendering can miss a check; for 15 minutes it keeps the files it was last seen with, so its models don't vanish
 * from the pickers mid-render (Templates fell back to a cloud model while a swap ran).
 */
export function installedFiles(): Promise<Set<string>> {
  const t = currentTarget();
  const hit = installedCache.get(t.id);
  if (hit && Date.now() - hit.at < 20_000) return hit.files;
  const files = (async () => {
    if (await answers()) {
      const seen = await listInstalled();
      if (seen.size) lastSeen.set(t.id, { at: Date.now(), files: seen });
      return seen;
    }
    const last = lastSeen.get(t.id);
    return last && Date.now() - last.at < 15 * 60_000 ? last.files : new Set<string>();
  })();
  installedCache.set(t.id, { at: Date.now(), files });
  return files;
}

/** Custom nodes Crackio can set up, and a node of each that shows it loaded. */
const NODE_PROOF: Record<string, string> = { "ComfyUI-GGUF": "UnetLoaderGGUF", ComfyUI_FlashVSR: "FlashVSR_SM_Model" };

/**
 * The custom nodes a variant needs: loaded already, or installed through the bridge (git clone + its packages). True when
 * ComfyUI has to restart to load one: the caller asks for that once the model's downloads are requested (see targetStatus).
 */
async function ensureNodes(names: string[]): Promise<boolean> {
  const known = await comfyJson<Record<string, { installed: boolean; loaded: boolean }>>("/crackio/nodes");
  if (!known) {
    const loaded = await Promise.all(names.map(async (n) => Object.keys((await comfyJson<Record<string, unknown>>(`/object_info/${NODE_PROOF[n] ?? n}`)) ?? {}).length > 0));
    if (loaded.every(Boolean)) return false;
    throw new LocalError(
      `This version runs through the ${names.join(" and ")} custom node${names.length > 1 ? "s" : ""}. Install it with ComfyUI-Manager and restart ComfyUI, or add the Crackio bridge (comfyui/crackio_bridge) so Crackio sets it up.`,
    );
  }
  let restart = false;
  for (const name of names) {
    if (known[name]?.loaded) continue;
    if (!known[name]?.installed) {
      const res = await comfyFetch("/crackio/nodes/install", { method: "POST", body: JSON.stringify({ name }), timeoutMs: 20 * 60_000 }).catch(() => null);
      const body = ((await res?.json().catch(() => null)) ?? {}) as { error?: string };
      if (!res?.ok) throw new LocalError(`Couldn't set up ${name}: ${body.error ?? "ComfyUI didn't answer"}.`, 502);
    }
    restart = true;
  }
  return restart;
}

/**
 * Before a job on the current ComfyUI: a custom node installed there but not loaded yet (its restart waits for a quiet
 * moment, and jobs back to back never leave one) loads now. ComfyUI restarts once its downloads are done, and the job
 * waits for it to answer again (at most 3 minutes). Nothing when no restart is due.
 */
export async function restartIfPending(onProgress?: (stage: string) => void) {
  const t = currentTarget();
  // Not under another of Crackio's jobs there (this one counts itself).
  if (!restartPending.has(t.id) || busyCount(t.id) > 1) return;
  const downloads = await comfyJson<{ state: string }[]>("/crackio/downloads");
  if (downloads?.some((d) => ACTIVE.includes(d.state))) return;
  onProgress?.("Restarting ComfyUI to load a new custom node");
  const res = await comfyFetch("/crackio/restart", { method: "POST", body: "{}" }).catch(() => null);
  if (!res?.ok) return;
  restartPending.delete(t.id);
  await new Promise((r) => setTimeout(r, 4000));
  for (let i = 0; i < 60; i++) {
    if (await comfyJson("/system_stats", { timeoutMs: 4000 })) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Whether a variant of a model has every file on the current ComfyUI. */
export async function hasModelHere(model: { variants: { files: LocalFile[] }[] }) {
  const have = await installedFiles().catch(() => new Set<string>());
  return model.variants.some((v) => v.files.every((f) => have.has(`${f.folder}/${f.name}`)));
}

/**
 * Whether a Crackio model (`local:…`) has every file of one of its variants on any ComfyUI Crackio knows; null when the
 * catalog doesn't list it.
 */
export async function localModelReady(crackioId: string): Promise<boolean | null> {
  const model = allLocalModels().find((m) => m.crackio === crackioId);
  if (!model) return null;
  for (const t of await comfyTargets()) if (await withTarget(t, () => hasModelHere(model))) return true;
  return false;
}

/** Add a ComfyUI on another computer (a Mac on the same network) to run models on. */
export async function addMachine(url: string, token?: string, label?: string) {
  let clean: string;
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`);
    clean = `${u.protocol}//${u.host}`;
  } catch {
    throw new LocalError("That isn't an address (try http://192.168.1.20:8188).");
  }
  const t: ComfyTarget = { id: "probe", url: clean, token: token?.trim() || undefined, label: label?.trim() || "ComfyUI", source: "added" };
  const stats = await withTarget(t, () => comfyJson<Parameters<typeof comfyMachine>[1]>("/system_stats", { timeoutMs: 6000 }));
  if (!stats) throw new LocalError(`No ComfyUI answered at ${clean}. On that computer, start ComfyUI with --listen so others on the network can reach it.`);
  const machine = comfyMachine(clean, stats, null);
  await updateSettings((s) => ({
    ...s,
    comfyMachines: [...(s.comfyMachines ?? []).filter((m) => !samePlace(m.url, clean)), { url: clean, ...(t.token ? { token: t.token } : {}), label: label?.trim() || machine.label.replace(/ running ComfyUI$/, "") }],
  }));
  forgetTargets();
  return { added: clean };
}

export async function removeMachine(id: string) {
  const t = await targetById(id);
  if (t.id !== id || t.source !== "added") throw new LocalError("Only machines added here can be removed.", 400);
  // Jobs chosen to run on it go back to Auto.
  await updateSettings((s) => ({
    ...s,
    comfyMachines: (s.comfyMachines ?? []).filter((m) => addedId(m) !== id && !(m.url && !t.tunnel && samePlace(m.url, t.url))),
    runOn: s.runOn === id ? undefined : s.runOn,
  }));
  if (t.cloud?.ssh) closeTunnels(t.cloud.ssh);
  forgetTargets();
  installedCache.delete(id);
  return { removed: id };
}

/* ------------------------------------------------------------------ measured speeds */

const SPEEDS_FILE = path.join(DATA_DIR, "local-speeds.json");
/**
 * One finished run: its GPU seconds, its work in units (local/work), whether the model was loaded already, the kind of job,
 * and what Crackio estimated for it beforehand (`e`, seconds), so the estimates' own accuracy shows.
 */
type Run = { s: number; u: number; warm: boolean; mode?: SpeedMode; at?: number; e?: number };
/**
 * Per GPU, per model: its last runs and the version that made them. Files from before runs kept their work (v2: seconds
 * per picture, warm `samples` and `cold` apart) read as runs of one unit of the model's main job.
 */
type SpeedEntry = { runs?: Run[]; samples?: number[]; cold?: number[]; at: number; v?: 2 | 3; variant?: string };
type Speeds = Record<string, Record<string, SpeedEntry>>;

/** Runs kept per kind of job, per model and GPU: what estimates learn from (local/estimate weighs the recent ones most). */
const KEEP = 40;

/** A ComfyUI's GPU from its system stats, as the key its speeds are kept under. */
const gpuKey = (stats: { devices?: { name?: string }[] } | null) =>
  (stats?.devices?.[0]?.name ?? "unknown").replace(/^(cuda|mps|xpu):\d*\s*/i, "").replace(/\s*:\s*\w+$/, "").trim() || "unknown";

/** GPU names that only say the backend: PyTorch calls every Mac's GPU "mps". */
const GENERIC_GPU = /^(mps|xpu|cpu|privateuseone|unknown)$/i;

/** A ComfyUI's GPU as its speeds are kept: PyTorch's name for it, or the bridge's ("Apple M2") where that only names the backend. */
function gpuKeyFrom(stats: { devices?: { name?: string }[] } | null, bridge: BridgeInfo | null | undefined) {
  const key = gpuKey(stats);
  return GENERIC_GPU.test(key) && bridge?.gpus?.[0]?.name ? bridge.gpus[0].name : key;
}

const bridges = new Map<string, { at: number; info: Promise<BridgeInfo | null> }>();

/** The current ComfyUI's bridge report (its CPU, disk and GPU names), looked up at most once a minute. */
function bridgeHere(): Promise<BridgeInfo | null> {
  const url = currentTarget().url;
  const hit = bridges.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.info;
  const info = comfyJson<BridgeInfo>("/crackio/info", { timeoutMs: 6000 });
  bridges.set(url, { at: Date.now(), info });
  return info;
}

/** The current ComfyUI's GPU, as the key its speeds are kept under. */
async function machineKey() {
  const stats = await comfyJson<{ devices?: { name?: string }[] }>("/system_stats", { timeoutMs: 20_000 });
  return gpuKeyFrom(stats, GENERIC_GPU.test(gpuKey(stats)) ? await bridgeHere() : null);
}

async function readSpeeds(): Promise<Speeds> {
  return JSON.parse(await fs.readFile(SPEEDS_FILE, "utf8").catch(() => "{}")) as Speeds;
}

function runsOf(e: SpeedEntry): Run[] {
  if (e.v === 3) return e.runs ?? [];
  if (e.v === 2) return [...(e.cold ?? []).map((s) => ({ s, u: 1, warm: false })), ...(e.samples ?? []).map((s) => ({ s, u: 1, warm: true }))];
  return (e.samples ?? []).map((s) => ({ s, u: 1, warm: false }));
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * One finished run on the ComfyUI it ran on: its GPU seconds and how much work it was (local/work: pictures, their size and
 * their reference pictures; 5 s clips), so a 4-reference edit and a plain picture measure the same speed. The last few of
 * each kind of job are kept.
 */
export async function recordSpeed(modelId: string, run: { seconds: number; work: number; warm: boolean; mode: SpeedMode; variant?: string; estimate?: number }) {
  if (!Number.isFinite(run.seconds) || run.seconds <= 0 || !(run.work > 0)) return;
  const key = await machineKey();
  // A busy box can miss the question: better no sample than one filed under the wrong GPU.
  if (key === "unknown") return;
  const all = await readSpeeds();
  const mine = (all[key] ??= {});
  const old = mine[modelId];
  // Another version of the model starts its record over.
  const kept = old && !(run.variant && old.variant && old.variant !== run.variant) ? runsOf(old) : [];
  const runs = [...kept, { s: round(run.seconds, 2), u: round(run.work, 3), warm: run.warm, mode: run.mode, at: Date.now(), ...(run.estimate ? { e: round(run.estimate, 1) } : {}) }];
  const mode = (r: Run) => r.mode ?? "main";
  const last = runs.filter((r, i) => runs.slice(i + 1).filter((x) => mode(x) === mode(r)).length < KEEP);
  mine[modelId] = { v: 3, variant: run.variant ?? old?.variant, at: Date.now(), runs: last };
  await fs.mkdir(path.dirname(SPEEDS_FILE), { recursive: true });
  await writeFileAtomic(SPEEDS_FILE, JSON.stringify(all, null, 2));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/**
 * Seconds per unit from runs: the median over runs that found the model loaded; what loading added, from the others (their
 * time less their work at that speed). Only cold runs: their median, loading included.
 */
function summary(runs: Run[]): MeasuredSpeed | undefined {
  if (!runs.length) return undefined;
  const warm = runs.filter((r) => r.warm);
  if (!warm.length) return { seconds: round(median(runs.map((r) => r.s / r.u)), 2), runs: runs.length, coldOnly: true };
  const seconds = median(warm.map((r) => r.s / r.u));
  const cold = runs.filter((r) => !r.warm);
  const load = cold.length ? Math.max(0, median(cold.map((r) => r.s - seconds * r.u))) : undefined;
  return { seconds: round(seconds, 2), runs: runs.length, ...(load !== undefined ? { load: round(load, 1) } : {}) };
}

/** A model's speeds from its runs: its main job (runs from before modes were kept count as it), and edits apart. */
function speedsOf(e: SpeedEntry): ModelSpeeds | undefined {
  const runs = runsOf(e);
  const edit = summary(runs.filter((r) => r.mode === "edit"));
  const main = summary(runs.filter((r) => r.mode !== "edit"));
  if (main) return edit ? { ...main, edit } : main;
  return edit ? { ...edit, edit } : undefined;
}

/** What each model has measured on a GPU, per unit of work. */
async function measuredOn(key: string): Promise<LocalStatus["measured"]> {
  const mine = key !== "unknown" ? (await readSpeeds())[key] : undefined;
  const out: LocalStatus["measured"] = {};
  for (const [id, e] of Object.entries(mine ?? {})) {
    const s = speedsOf(e);
    if (s) out[id] = e.variant ? { ...s, variant: e.variant } : s;
  }
  return out;
}

/**
 * Real RTX 5090 times (loaded, per unit) for the versions that have run on one, by recipe id: the base every other GPU's
 * estimate scales from, instead of a guess from the model's size.
 */
export async function measured5090(): Promise<Record<string, { variant?: string; seconds: number }>> {
  const all = await readSpeeds();
  const out: Record<string, { variant?: string; seconds: number }> = {};
  for (const [gpu, models] of Object.entries(all)) {
    if (!/5090/.test(gpu)) continue;
    for (const [id, e] of Object.entries(models)) {
      const s = speedsOf(e);
      if (s && !s.coldOnly) out[id] = { variant: e.variant, seconds: s.seconds };
    }
  }
  return out;
}

/** Every model with the RTX 5090 times measured here in place of the catalog's (each version that ran; the first one when unknown). */
export async function withMeasured5090<M extends LocalModel>(models: M[]): Promise<M[]> {
  const seen = await measured5090().catch(() => ({}) as Awaited<ReturnType<typeof measured5090>>);
  return models.map((m) => {
    const hit = m.crackio ? seen[m.crackio.replace(/^local:/, "")] : undefined;
    if (!hit) return m;
    const which = m.variants.find((v) => v.id === hit.variant) ?? m.variants[0];
    return { ...m, variants: m.variants.map((v) => (v === which ? { ...v, seconds5090: hit.seconds, measured: true } : v)) };
  });
}

/** Picture upscales kept before their work counted the picture's size (Oct 24, 2026, 21:14 UTC): sizes unknown, left out. */
const UPSCALES_SIZED = Date.parse("2026-10-24T21:14:00Z");

/** A GPU's record of every model it ran, as the estimates read it (local/estimate). */
function machineRuns(speeds: Speeds, gpu: string): MachineRuns | undefined {
  const mine = gpu !== "unknown" ? speeds[gpu] : undefined;
  if (!mine) return undefined;
  const upscaler = (k: string) => allLocalModels().find((m) => recipeKey(m) === k)?.tasks.includes("upscale") ?? false;
  return Object.fromEntries(
    Object.entries(mine).map(([k, e]) => [k, { variant: e.variant, runs: runsOf(e).filter((r) => !(upscaler(k) && (r.at ?? 0) < UPSCALES_SIZED && (r.mode ?? "upscale") === "upscale")) }]),
  );
}

const lives = new Map<string, { at: number; info: Promise<Live> }>();

/**
 * The current ComfyUI's GPU right now (the bridge's /crackio/live, 1.5.5 and later, read at most every 5 seconds): how busy
 * other apps keep it and what its PCIe link carries. Empty from an older bridge or a GPU nvidia-smi doesn't know.
 */
function liveHere(): Promise<Live> {
  const url = currentTarget().url;
  const hit = lives.get(url);
  if (hit && Date.now() - hit.at < 5000) return hit.info;
  const info = comfyJson<{ others_util?: number | null; pcie_gen?: number | null; pcie_width?: number | null; mac?: MacHeat }>("/crackio/live", { timeoutMs: 4000 }).then((x) => {
    const link = pcieGBps(x?.pcie_gen, x?.pcie_width);
    return { ...(typeof x?.others_util === "number" ? { busy: x.others_util / 100 } : {}), ...(link ? { pcieGBps: link } : {}), ...(x?.mac ? { mac: x.mac } : {}) };
  });
  lives.set(url, { at: Date.now(), info });
  return info;
}

/** The version of a model this machine has every file of (the one its runs were filed under first); null when none. */
function variantOn(model: LocalModel, have: Set<string>, recorded?: string): LocalVariant | null {
  const complete = model.variants.filter((v) => v.files.length > 0 && v.files.every((f) => have.has(`${f.folder}/${f.name}`)));
  return complete.find((v) => v.id === recorded) ?? complete[0] ?? null;
}

/** Everything a job's estimate on the current ComfyUI needs, read once (`estimateFor` computes from it). */
export type EstimateContext = { machine: Machine; model: LocalModel; variant: LocalVariant; runs: MachineRuns | undefined; models: LocalModel[]; live: Live; gpu: string };

export async function estimateContext(modelId: string): Promise<EstimateContext | null> {
  const t = currentTarget();
  const stats = await comfyJson<SystemStats & Parameters<typeof comfyMachine>[1]>("/system_stats", { timeoutMs: 6000 });
  if (!stats) return null;
  const [bridge, live, speeds, models, have] = await Promise.all([bridgeHere(), liveHere(), readSpeeds(), withMeasured5090(allLocalModels()), installedFiles().catch(() => new Set<string>())]);
  const model = models.find((m) => m.crackio === `local:${modelId}`);
  if (!model) return null;
  const gpu = gpuKeyFrom(stats, bridge);
  const machine = comfyMachine(t.url, stats, bridge);
  machine.modelMemoryGb = freeForModels(t.id, machine, stats);
  const runs = machineRuns(speeds, gpu);
  const variant = variantOn(model, have, runs?.[modelId]?.variant) ?? fitModel(machine, model).variant;
  if (!variant) return null;
  const loaded = await lastRunUsed(new Set(variant.files.map((f) => f.name))).catch(() => false);
  return { machine, model, variant, runs, models, live: { ...live, freeGb: machine.modelMemoryGb, loaded }, gpu: shortGpuName(gpu) };
}

/** A job's estimate from its context: its kind and its work (local/work units). */
export const estimateFor = (ctx: EstimateContext, mode: SpeedMode, work: number): Estimate | null => estimateJob({ ...ctx, mode, work });

/**
 * Every model's time on one machine for the Local page: a unit of its main job and an edit with one picture, the version it
 * has (else the one that would install), at what the machine is doing now; and how the machine compares (1 = as benchmarked).
 */
async function estimatesFor(machine: Machine, have: Set<string>, runs: MachineRuns | undefined, live: Live): Promise<{ estimates: Record<string, LocalEstimate>; factor: number; accuracy?: { runs: number; within: number } }> {
  const models = await withMeasured5090(allLocalModels());
  const estimates: Record<string, LocalEstimate> = {};
  const round1 = (n: number) => Math.round(n * 10) / 10;
  for (const model of models) {
    const variant = variantOn(model, have, runs?.[recipeKey(model)]?.variant) ?? fitModel(machine, model).variant;
    if (!variant) continue;
    const ctx = { machine, model, variant, runs, models, live: { ...live, freeGb: machine.modelMemoryGb } };
    // The card's job: a picture or 5 s clip, and for an upscaler a 1 MP picture made 2× (local/work `cardWork`).
    const main = estimateJob({ ...ctx, mode: mainMode(model), work: cardWork(model) });
    if (!main) continue;
    const edit = model.tasks.includes("edit") ? estimateJob({ ...ctx, mode: "edit", work: pictureWork({ references: 1 }) }) : null;
    // Loading apart: the page says what a first run adds.
    estimates[model.id] = {
      seconds: round1(main.seconds - main.load),
      low: round1(main.low - main.load * 0.7),
      high: round1(main.high - main.load * 1.4),
      load: round1(main.load),
      basis: main.basis,
      runs: main.runs,
      from: main.from,
      variant: variant.id,
      ...(edit ? { edit: { seconds: round1(edit.seconds - edit.load), low: round1(edit.low - edit.load * 0.7), high: round1(edit.high - edit.load * 1.4), basis: edit.basis, runs: edit.runs } } : {}),
    };
  }
  return { estimates, factor: Math.round(machineFactor(machine, models, runs) * 100) / 100, accuracy: accuracyOf(runs) };
}

/** Of a machine's last 30 runs that had an estimate beforehand, the share within 25% of it; null before there are 5. */
function accuracyOf(runs: MachineRuns | undefined) {
  const judged = Object.values(runs ?? {})
    .flatMap((e) => e.runs ?? [])
    .filter((r): r is typeof r & { e: number } => (r.e ?? 0) > 0)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 30);
  if (judged.length < 5) return undefined;
  const near = judged.filter((r) => Math.abs(Math.log(r.s / r.e)) <= Math.log(1.25)).length;
  return { runs: judged.length, within: Math.round((near / judged.length) * 100) / 100 };
}

/**
 * For the model pickers: what each local model (by Crackio id) takes per picture or 5 s clip on the fastest machine that has
 * it, measured on that GPU, else estimated for it. One look at each ComfyUI for all of them.
 */
export async function localTimes(crackioIds: string[]): Promise<Map<string, { seconds: number; measured: boolean; gpu: string }>> {
  const out = new Map<string, { seconds: number; measured: boolean; gpu: string }>();
  if (!crackioIds.length) return out;
  const [targets, speeds, models] = await Promise.all([comfyTargets(), readSpeeds(), withMeasured5090(allLocalModels())]);
  const looks = await Promise.all(
    targets.map((t) =>
      withTarget(t, async () => {
        const stats = await comfyJson<SystemStats & Parameters<typeof comfyMachine>[1]>("/system_stats", { timeoutMs: 4000 });
        if (!stats) return null;
        const bridge = await bridgeHere();
        const machine = comfyMachine(t.url, stats, bridge);
        machine.modelMemoryGb = freeForModels(t.id, machine, stats);
        return { t, machine, gpu: gpuKeyFrom(stats, bridge), speed: speedOf(machine) ?? 0 };
      }).catch(() => null),
    ),
  );
  const fastest = looks.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => b.speed - a.speed);
  for (const id of crackioIds) {
    const model = models.find((m) => m.crackio === id);
    if (!model) continue;
    for (const look of fastest) {
      if (!(await withTarget(look.t, () => hasModelHere(model)).catch(() => false))) continue;
      const runs = machineRuns(speeds, look.gpu);
      const have = await withTarget(look.t, () => installedFiles()).catch(() => new Set<string>());
      const variant = variantOn(model, have, runs?.[recipeKey(model)]?.variant) ?? fitModel(look.machine, model).variant;
      const e = variant ? estimateJob({ machine: look.machine, model, variant, mode: mainMode(model), work: cardWork(model), runs, models, live: { freeGb: look.machine.modelMemoryGb, loaded: true } }) : null;
      if (e) out.set(id, { seconds: e.seconds, measured: e.basis === "measured", gpu: shortGpuName(look.gpu) });
      break;
    }
  }
  return out;
}

/**
 * The ComfyUI to run a model (by recipe id) on: of those that answer and have its files, an idle one before a busy one,
 * then the fastest GPU. The main one when none has them (the run then says what's missing). The machine chosen to run on
 * (settings `runOn`, or a job's own `options.machine`) gets it whenever it's online and has the model.
 */
export async function pickTarget(modelId: string, pinned?: unknown): Promise<ComfyTarget> {
  const targets = await comfyTargets();
  if (targets.length < 2) return targets[0];
  const chosen = typeof pinned === "string" && pinned !== "auto" ? pinned : (await getSettings()).runOn;
  const asked = chosen ? targets.find((t) => t.id === chosen) : undefined;
  const model = allLocalModels().find((m) => m.crackio === `local:${modelId}`);
  const probe = (t: ComfyTarget) =>
    withTarget(t, async () => {
      const stats = await comfyJson<Parameters<typeof comfyMachine>[1]>("/system_stats", { timeoutMs: isHere(t) ? 1500 : 6000 });
      if (!stats) quiet.set(t.id, Date.now() + 30_000);
      else quiet.delete(t.id);
      if (!stats || (model && !(await hasModelHere(model)))) return null;
      const q = await comfyJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue", { timeoutMs: 6000 });
      const busy = (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0) > 0;
      return { t, busy, speed: speedOf(comfyMachine(t.url, stats, await bridgeHere())) ?? 0.01 };
    }).catch(() => null);
  // A machine that didn't answer in the last 30 s (switched off, a stopped box) is skipped: every job would wait out its
  // timeout first.
  // A billed machine (RunPod, Comfy Cloud) only when it's the one chosen: each job there costs money.
  const ready = await Promise.all(targets.map((t) => ((quiet.get(t.id) ?? 0) > Date.now() || (t.metered && t.id !== asked?.id) ? null : probe(t))));
  const ok = ready.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => Number(a.busy) - Number(b.busy) || b.speed - a.speed);
  return (asked && ok.find((x) => x.t.id === asked.id)?.t) ?? ok[0]?.t ?? targets[0];
}

/** One machine a job could run on, for the "Run on" pickers: whether it has the model, how busy it is, its estimate. */
export type MachineChoice = {
  id: string;
  label: string;
  gpu: string | null;
  online: boolean;
  hasModel: boolean;
  /** Jobs in its ComfyUI's queue now. */
  queue: number;
  estimate: Estimate | null;
  cloud: boolean;
  onThisComputer: boolean;
  /** Why a billed machine can't take jobs now ("Needs a paid Comfy Cloud plan"): it counts as offline. */
  note?: string;
};

/**
 * Every machine Crackio knows, for one local model and job: online or not, with the model or not, its queue and the job's
 * estimate there (`kind` and `work` as local/estimate takes them). In the order Auto would pick them.
 */
export async function machinesFor(modelId: string, mode: SpeedMode, work: (perUnit: number | null) => number): Promise<MachineChoice[]> {
  const targets = await comfyTargets();
  const model = allLocalModels().find((m) => m.crackio === `local:${modelId}`);
  const looks = await Promise.all(
    targets.map((t) =>
      withTarget(t, async (): Promise<MachineChoice> => {
        const blocked = t.metered === "comfy-cloud" ? comfyCloudBlocked() : null;
        const base = { id: t.id, label: t.label, cloud: Boolean(t.cloud), onThisComputer: isHere(t), ...(blocked ? { note: blocked } : {}) };
        const stats = await comfyJson<SystemStats & Parameters<typeof comfyMachine>[1]>("/system_stats", { timeoutMs: 5000 });
        if (!stats) return { ...base, gpu: null, online: false, hasModel: false, queue: 0, estimate: null };
        const [has, q, ctx] = await Promise.all([
          model ? hasModelHere(model) : Promise.resolve(false),
          comfyJson<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue", { timeoutMs: 5000 }),
          estimateContext(modelId).catch(() => null),
        ]);
        const pace = ctx ? estimateFor(ctx, mode, 1) : null;
        const estimate = ctx ? estimateFor(ctx, mode, work(pace?.perUnit ?? null)) : null;
        return {
          ...base,
          gpu: ctx?.gpu ?? shortGpuName(gpuKeyFrom(stats, await bridgeHere())),
          online: true,
          hasModel: has,
          queue: (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0),
          estimate: has ? estimate : null,
        };
      }).catch(() => ({ id: t.id, label: t.label, cloud: Boolean(t.cloud), onThisComputer: isHere(t), gpu: null, online: false, hasModel: false, queue: 0, estimate: null })),
    ),
  );
  return looks.sort((a, b) => Number(b.hasModel) - Number(a.hasModel) || Number(a.queue > 0) - Number(b.queue > 0) || (a.estimate?.seconds ?? Infinity) - (b.estimate?.seconds ?? Infinity));
}

/** A ComfyUI that runs the last blocks of a model the job's ComfyUI can't hold (comfyui/crackio_bridge/pool.py). */
export type PoolHelper = { url: string; token?: string; label: string };

/**
 * Another computer to split a model with, when the job's ComfyUI can't hold it: the version installed there has to pool
 * (its catalog variant's `pool`), its GPU be too small for it, and another of Crackio's ComfyUIs lend memory through the
 * bridge's /crackio/pool. The one with the most free; null when the model fits, or nobody lends.
 */
export async function poolFor(modelId: string, head: ComfyTarget): Promise<PoolHelper | null> {
  const model = allLocalModels().find((m) => m.crackio === `local:${modelId}`);
  if (!model?.variants.some((v) => v.pool)) return null;
  const mode = (await getSettings()).pooling ?? "auto";
  if (mode === "off") return null;
  // Pooling is for computers on one network: every step's activations go between the two. A rented box is never split
  // with another machine, either way (two vast.ai boxes, one in Korea and one in California, were paired in a test).
  if (head.cloud) return null;
  const [have, stats, bridge] = await withTarget(head, () =>
    Promise.all([installedFiles(), comfyJson<SystemStats>("/system_stats", { timeoutMs: 6000 }), comfyJson<BridgeInfo>("/crackio/info", { timeoutMs: 6000 })]),
  );
  const variant = model.variants.find((v) => v.files.length > 0 && v.files.every((f) => have.has(`${f.folder}/${f.name}`)));
  if (!variant?.pool || !stats) return null;
  // What the card has for models, its own earlier models included (ComfyUI unloads those for this one): what's free at
  // this moment made a 16 GB card that holds the model look full after a few other jobs.
  const machine = comfyMachine(head.url, stats, bridge);
  const room = freeForModels(head.id, machine, stats);
  if (room >= variant.needGb) return null;
  // Auto: only what this computer can't run alone; it streams from RAM what its GPU can't hold, often quicker than it
  // would wait on a slower second GPU (a GTX 1060 alone beat it split with an M2 by 1.8×).
  if (mode === "auto" && fitVariant({ ...machine, modelMemoryGb: room }, variant).state !== "no") return null;
  // The job's ComfyUI connects to the helper itself: a helper on this computer is out of reach of a ComfyUI elsewhere.
  const others = (await comfyTargets()).filter((t) => t.id !== head.id && !t.cloud && !samePlace(t.url, head.url) && (isHere(head) || !isHere(t)) && (quiet.get(t.id) ?? 0) <= Date.now());
  const offers = await Promise.all(
    others.map((t) =>
      withTarget(t, () => comfyJson<{ free?: number; held?: number }>("/crackio/pool", { timeoutMs: 5000 }))
        .then((p) => (typeof p?.free === "number" ? { t, gb: (p.free + (p.held ?? 0)) / 1024 ** 3 } : null))
        .catch(() => null),
    ),
  );
  const best = offers.filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => b.gb - a.gb)[0];
  return best && best.gb >= 2 ? { url: best.t.url, token: best.t.token, label: best.t.label } : null;
}

type HistoryGraph = Record<string, { prompt?: [unknown, unknown, Record<string, { class_type?: string; inputs?: Record<string, unknown> }>] }>;

/** Whether the current ComfyUI's last job loaded any of these files: its model is then most likely still loaded. */
export async function lastRunUsed(files: Set<string>) {
  const last = await comfyJson<HistoryGraph>("/history?max_items=1", { timeoutMs: 6000 });
  const graph = Object.values(last ?? {})[0]?.prompt?.[2];
  return Boolean(graph && Object.values(graph).some((n) => /Loader/.test(n.class_type ?? "") && Object.values(n.inputs ?? {}).some((v) => typeof v === "string" && files.has(v))));
}

export class LocalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Fetch every file of a model's variant the ComfyUI doesn't have yet. */
export async function installModel(modelId: string, variantId: string, targetId?: string) {
  const target = await targetById(targetId);
  if (target.serverless) return installServerless(target.serverless.endpointId, modelId, variantId);
  if (target.metered === "comfy-cloud") throw new LocalError("Comfy Cloud has its own model library: Crackio offers the models it has there.", 400);
  return withTarget(target, () => installHere(modelId, variantId));
}

/**
 * On a RunPod Serverless endpoint a model's files go into its network volume through one "fetch" job on the endpoint (a
 * few GPU-minutes for a big model); its model list shows them once the job is done.
 */
async function installServerless(endpointId: string, modelId: string, variantId: string) {
  const variant = localModel(modelId)?.variants.find((v) => v.id === variantId);
  const ep = (await serverlessEndpoints()).find((e) => e.endpointId === endpointId);
  if (!variant || !ep) throw new LocalError("Unknown model or endpoint.", 404);
  const files = variant.files.map((f) => ({ url: f.url, folder: f.folder, name: f.name, ...(f.sizeEstimated ? {} : { bytes: f.bytes }) }));
  void fetchModels(ep, files).catch((err) => console.warn(`[serverless] fetching ${modelId} on ${ep.label} failed: ${(err as Error).message}`));
  return { started: files.length };
}

async function installHere(modelId: string, variantId: string) {
  const model = localModel(modelId);
  const variant = model?.variants.find((v) => v.id === variantId);
  if (!model || !variant) throw new LocalError("Unknown model.", 404);
  const region = regionOf(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (region && model.excludes?.includes(region)) throw new LocalError(`${model.name}'s licence doesn't cover where you are (${region}).`, 403);
  const { status } = await targetStatus(currentTarget(), await computer());
  if (!status.connected) throw new LocalError("That ComfyUI isn't answering. Start it (or check its address) first.");
  const have = new Set(status.installed);
  const busy = new Set(status.downloads.filter((d) => ACTIVE.includes(d.state)).map((d) => `${d.folder}/${d.filename}`));
  const missing = variant.files.filter((f) => !have.has(`${f.folder}/${f.name}`) && !busy.has(`${f.folder}/${f.name}`));
  const token = await hfToken();
  const restart = variant.requires?.customNodes?.length ? await ensureNodes(variant.requires.customNodes) : false;
  if (status.bridge) {
    for (const f of missing) {
      const res = await comfyFetch("/crackio/download", { method: "POST", body: JSON.stringify({ url: f.url, folder: f.folder, filename: f.name, size: f.sizeEstimated ? undefined : f.bytes, sha256: f.sha256, token: token || undefined }) });
      if (!res.ok) throw new LocalError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `ComfyUI refused ${f.name}.`);
    }
    // Only now: asked for earlier, a status check between the node's install and these requests restarted ComfyUI with
    // no download running yet, and the restart cut off the ones that started just then.
    if (restart) restartPending.add(currentTarget().id);
    return { started: missing.length };
  }
  if (!status.onThisComputer) {
    throw new LocalError("That ComfyUI runs on another machine: add the Crackio bridge to it (copy comfyui/crackio_bridge into its custom_nodes folder and restart it), then install from here.");
  }
  const folders = await comfyJson<Record<string, string[]>>("/internal/folder_paths");
  if (!folders) throw new LocalError("ComfyUI didn't say where its model folders are.");
  for (const f of missing) startDirect(f, folderFor(folders, f.folder), token, currentTarget().id);
  return { started: missing.length };
}

/** The folder named like its type (models/diffusion_models before the legacy models/unet), else the first. */
function folderFor(folders: Record<string, string[]>, folder: string) {
  const list = (folders[folder] ?? []) as (string | [string, ...unknown[]])[];
  const paths = list.map((p) => (Array.isArray(p) ? p[0] : p)).filter((p): p is string => typeof p === "string");
  if (!paths.length) throw new LocalError(`ComfyUI has no ${folder} folder.`);
  return paths.find((p) => path.basename(p) === folder) ?? paths[0];
}

export async function stopDownload(id: string, targetId?: string) {
  const d = direct.get(id);
  if (d) {
    d.stop = true;
    return;
  }
  const res = await withTarget(await targetById(targetId), () => comfyFetch(`/crackio/downloads/${encodeURIComponent(id)}/stop`, { method: "POST" }).catch(() => null));
  if (!res?.ok) throw new LocalError("No such download.", 404);
}

/** Remove a variant's files, except ones another installed model still uses. */
export async function removeModel(modelId: string, variantId: string, targetId?: string) {
  const target = await targetById(targetId);
  return withTarget(target, () => removeHere(modelId, variantId));
}

async function removeHere(modelId: string, variantId: string) {
  const model = localModel(modelId);
  const variant = model?.variants.find((v) => v.id === variantId);
  if (!model || !variant) throw new LocalError("Unknown model.", 404);
  const { status } = await targetStatus(currentTarget(), await computer());
  const have = new Set(status.installed);
  const others = allLocalModels().flatMap((m) =>
    m.variants.filter((v) => !(m.id === modelId && v.id === variantId) && v.files.every((f) => have.has(`${f.folder}/${f.name}`))).flatMap((v) => v.files),
  );
  const keep = new Set(others.map((f) => `${f.folder}/${f.name}`));
  const drop = variant.files.filter((f) => have.has(`${f.folder}/${f.name}`) && !keep.has(`${f.folder}/${f.name}`));
  if (status.bridge) {
    for (const f of drop) await comfyFetch("/crackio/delete", { method: "POST", body: JSON.stringify({ folder: f.folder, filename: f.name }) });
    installedCache.delete(currentTarget().id);
    return { removed: drop.length };
  }
  if (!status.onThisComputer) throw new LocalError("Add the Crackio bridge to that ComfyUI to manage its models from here.");
  const folders = await comfyJson<Record<string, string[]>>("/internal/folder_paths");
  if (!folders) throw new LocalError("ComfyUI didn't say where its model folders are.");
  for (const f of drop) {
    for (const p of ((folders[f.folder] ?? []) as (string | string[])[]).map((x) => (Array.isArray(x) ? x[0] : x))) {
      await fs.rm(path.join(p, f.name), { force: true });
    }
    for (const [id, d] of direct) if (d.folder === f.folder && d.filename === f.name) direct.delete(id);
  }
  return { removed: drop.length };
}

/* ------------------------------------------------------------------ single files (the LoRA library) */

/** One file into a ComfyUI's model folders (a LoRA from the library), unless it's there or on its way: as installs fetch theirs. */
export async function installFile(file: LocalFile, targetId?: string) {
  const target = await targetById(targetId);
  return withTarget(target, async () => {
    const { status } = await targetStatus(currentTarget(), await computer());
    if (!status.connected) throw new LocalError(`${target.label} isn't answering. Start its ComfyUI (or check it on the Local page) first.`);
    const key = `${file.folder}/${file.name}`;
    if (status.installed.includes(key)) return { started: 0, exists: true };
    if (status.downloads.some((d) => ACTIVE.includes(d.state) && `${d.folder}/${d.filename}` === key)) return { started: 0 };
    const token = await hfToken();
    if (status.bridge) {
      const res = await comfyFetch("/crackio/download", { method: "POST", body: JSON.stringify({ url: file.url, folder: file.folder, filename: file.name, size: file.bytes || undefined, sha256: file.sha256, token: token || undefined }) });
      if (!res.ok) throw new LocalError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `ComfyUI refused ${file.name}.`);
      return { started: 1 };
    }
    if (!status.onThisComputer) {
      throw new LocalError("That ComfyUI runs on another machine: add the Crackio bridge to it (copy comfyui/crackio_bridge into its custom_nodes folder and restart it), then download from here.");
    }
    const folders = await comfyJson<Record<string, string[]>>("/internal/folder_paths");
    if (!folders) throw new LocalError("ComfyUI didn't say where its model folders are.");
    startDirect(file, folderFor(folders, file.folder), token, currentTarget().id);
    return { started: 1 };
  });
}

/** Delete one file from a ComfyUI's model folder (a LoRA you no longer want). */
export async function removeFile(folder: LocalFile["folder"], name: string, targetId?: string) {
  const target = await targetById(targetId);
  return withTarget(target, async () => {
    const { status } = await targetStatus(currentTarget(), await computer());
    if (!status.connected) throw new LocalError(`${target.label} isn't answering.`);
    installedCache.delete(currentTarget().id);
    if (status.bridge) {
      const res = await comfyFetch("/crackio/delete", { method: "POST", body: JSON.stringify({ folder, filename: name }) });
      if (!res.ok) throw new LocalError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `ComfyUI kept ${name}.`);
      return { removed: Boolean(((await res.json().catch(() => null)) as { removed?: boolean } | null)?.removed) };
    }
    if (!status.onThisComputer) throw new LocalError("Add the Crackio bridge to that ComfyUI to manage its files from here.");
    const folders = await comfyJson<Record<string, string[]>>("/internal/folder_paths");
    if (!folders) throw new LocalError("ComfyUI didn't say where its model folders are.");
    let removed = false;
    for (const p of ((folders[folder] ?? []) as (string | string[])[]).map((x) => (Array.isArray(x) ? x[0] : x))) {
      const at = path.resolve(p, name);
      // A name is a file in that folder, never a path out of it.
      if (path.dirname(at) !== path.resolve(p) || !(await fs.stat(at).then((s) => s.isFile()).catch(() => false))) continue;
      await fs.rm(at, { force: true });
      removed = true;
    }
    for (const [id, d] of direct) if (d.folder === folder && d.filename === name) direct.delete(id);
    return { removed };
  });
}

/* ------------------------------------------------------------------ direct downloads (ComfyUI on this computer) */

const WORKERS = 12;
const CHUNK = 64 * 1024 * 1024;

/** The final link, size and (Hugging Face LFS) SHA-256 behind a model URL. */
async function resolve(url: string, token: string) {
  let next = url;
  let auth = token && /^https:\/\/(huggingface\.co|hf\.co)\//.test(url) ? token : "";
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(next, { method: "HEAD", redirect: "manual", headers: { "User-Agent": "crackio", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, signal: AbortSignal.timeout(30_000) });
    const size = Number(res.headers.get("x-linked-size") ?? 0);
    const etag = (res.headers.get("x-linked-etag") ?? "").replace(/"/g, "");
    const sha = /^[0-9a-f]{64}$/.test(etag) ? etag : undefined;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const target = new URL(location, next).toString();
      if (size) return { cdn: target, size, sha };
      next = target;
      auth = "";
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("This model is gated: accept its licence on Hugging Face and add your token in Connections.");
    if (!res.ok) throw new Error(`${res.status} from ${new URL(next).hostname}`);
    return { cdn: next, size: size || Number(res.headers.get("content-length") ?? 0), sha };
  }
  throw new Error("Too many redirects.");
}

function startDirect(f: LocalFile, dir: string, token: string, target: string) {
  const d: DirectDownload = { id: nanoid(10), folder: f.folder, filename: f.name, state: "queued", received: 0, total: f.bytes, via: "direct", stop: false, target };
  direct.set(d.id, d);
  void runDirect(d, f, path.join(dir, f.name), token);
}

async function runDirect(d: DirectDownload, f: LocalFile, target: string, token: string) {
  const part = `${target}.part`;
  try {
    const found = await resolve(f.url, token);
    const size = found.size;
    let { cdn, sha } = found;
    if (!size) throw new Error("The host didn't say how big the file is.");
    d.total = size;
    d.state = "downloading";
    await fs.mkdir(path.dirname(target), { recursive: true });
    const fh = await fs.open(part, "w+");
    try {
      await fh.truncate(size);
      const ranges: [number, number][] = [];
      for (let s = 0; s < size; s += CHUNK) ranges.push([s, Math.min(size - 1, s + CHUNK - 1)]);
      let next = 0;
      const worker = async () => {
        while (next < ranges.length && !d.stop) {
          const [start, end] = ranges[next++];
          for (let attempt = 1; ; attempt++) {
            let got = 0;
            try {
              const res = await fetch(cdn, { headers: { Range: `bytes=${start}-${end}`, "User-Agent": "crackio" }, signal: AbortSignal.timeout(120_000) });
              if (res.status !== 206 || !res.body) throw new Error(`status ${res.status}`);
              let pos = start;
              for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                if (d.stop) return;
                await fh.write(chunk, 0, chunk.length, pos);
                pos += chunk.length;
                got += chunk.length;
                d.received += chunk.length;
              }
              if (pos !== end + 1) throw new Error("short read");
              break;
            } catch (err) {
              d.received -= got;
              if (attempt >= 8) throw err;
              // An expired link or a dropped connection: ask for the link again.
              if (attempt >= 2) cdn = (await resolve(f.url, token).catch(() => ({ cdn }))).cdn;
              await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * attempt)));
            }
          }
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));
    } finally {
      await fh.close();
    }
    if (d.stop) throw Object.assign(new Error("stopped"), { stopped: true });
    sha ??= f.sha256;
    if (sha) {
      d.state = "checking";
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== sha) throw new Error("The file didn't match its checksum.");
    }
    await fs.rename(part, target);
    Object.assign(d, { state: "done", received: size });
  } catch (err) {
    Object.assign(d, (err as { stopped?: boolean }).stopped ? { state: "stopped" } : { state: "error", error: (err as Error).message.slice(0, 300) });
    await fs.rm(part, { force: true }).catch(() => {});
  }
}
