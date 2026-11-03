import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { localStatus } from "../local-models";
import { allLocalModels } from "../local-templates";
import { voiceMachines } from "../voice/machines";
import { lipsyncMachines } from "../lipsync/machines";
import { setupStatus, type SetupStatus } from "../comfy-install";
import { comfyTargets, type ComfyTarget } from "../comfy-targets";
import { getSettings } from "../settings";
import { visionOnDisk } from "../vision";
import { fitRows, installState, installedVariant, runsWell, type Row } from "@/lib/local/rows";
import { cardWork } from "@/lib/local/work";
import { knobsFor, VOICE_KNOBS } from "@/lib/setup/knobs";
import { boxPrice } from "../cloud-accounts";
import { autoStopNow, creditNow } from "./cloud-money";
import { pricePerSecond } from "../serverless/runpod";
import { fitVariant, mainGpu, shortGpuName, speedOf } from "@/lib/local/fit";
import { KITS } from "@/lib/setup/kits";
import { bridgeHas, versionAtLeast } from "@/lib/setup/bridge";
import { LFM3_BYTES, LFM3_LORAS, LFM3_NAME, lfm3LoraUrl, type Lfm3LoraKey } from "@/lib/local/lfm3";
import { AUDIOCPP_BYTES, HEARING, VOICE_MODELS, variantFor } from "@/lib/voice/models";
import { LIPSYNC_BEST_VRAM_GB, LIPSYNC_FILES, LIPSYNC_VRAM_GB, type LipsyncMachine } from "@/lib/lipsync/machines";
import type { LocalModel, LocalStatus, LocalVariant, Machine, TargetStatus } from "@/lib/local/types";
import type { VoiceMachine } from "@/lib/voice/types";
import type { Kit, KitId, MachineKind, ModelOption, OptionVariant, Requirement, ReqStatus, SetupMachine, SetupPart, SetupSnapshot, ToolState, ToolStatus } from "@/lib/setup/types";
import { setupJobs } from "./jobs";

/**
 * Settings' one look at every machine and every tool on it (GET /api/setup). Nothing here probes a machine itself: it reads
 * what the Local page (localStatus), Voice (voiceMachines) and Lip Sync (lipsyncMachines) read, through their own caches,
 * and judges each tool's kit (setup/kits) with the same functions they use (fitRows, installedVariant, variantFor), so a
 * tool reads the same here, on its own page and in the model pickers.
 */

const BRIDGE_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), "comfyui", "crackio_bridge", "__init__.py");
let bridgeVersion: Promise<string> | null = null;

/** The bridge version this Crackio carries (what machines are brought up to). */
export function latestBridge(): Promise<string> {
  bridgeVersion ??= fs
    .readFile(BRIDGE_FILE, "utf8")
    .then((t) => /^VERSION = "([^"]+)"/m.exec(t)?.[1] ?? "0")
    .catch(() => "0");
  return bridgeVersion;
}

/** Voice models that can copy a voice from a recording (Lip Sync speaks the new words in the speaker's own voice). */
const CLONERS = new Set(VOICE_MODELS.filter((m) => m.can.clone).map((m) => m.id));
const HEARING_BYTES = HEARING.reduce((s, f) => s + f.bytes, 0);
const LIPSYNC_ENGINE_BYTES = 1.5e9;
/** What a fresh ComfyUI install downloads (Python, PyTorch for the card, ComfyUI): about this, on any card. */
const COMFY_BYTES = 4.5e9;

type Ctx = {
  local: LocalStatus;
  models: Map<string, LocalModel>;
  voice: Map<string, VoiceMachine>;
  lipsync: Map<string, LipsyncMachine>;
  vision: Awaited<ReturnType<typeof visionOnDisk>>;
  keys: SetupSnapshot["keys"];
};

type Place = {
  id: string;
  kind: MachineKind;
  target: TargetStatus | null;
  hw: Machine | null;
  online: boolean;
  /** No ComfyUI on this computer yet: a set-up installs it first. */
  noComfy: boolean;
};

const ready = (r: Requirement, has: string): ReqStatus => ({ id: r.id, label: r.label, state: "ready", why: has, has, optional: r.optional, instead: r.instead });
const say = (r: Requirement, state: ReqStatus["state"], why: string, extra: Partial<ReqStatus> = {}): ReqStatus => ({
  id: r.id,
  label: r.label,
  state,
  why,
  optional: r.optional,
  instead: r.instead,
  ...extra,
});

/** GB of 1024³ bytes, as the model library and Storage count them. */
const gbText = (bytes: number) => {
  const gb = bytes / 1024 ** 3;
  return gb < 0.1 ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : Math.round(gb)} GB`;
};

/** A catalog model the kit lists, by its Crackio id ("local:flux3-klein"). */
function candidates(r: Extract<Requirement["need"], { kind: "model" }>, ctx: Ctx) {
  return r.anyOf.map((id) => ctx.models.get(id)).filter((m): m is LocalModel => Boolean(m) && (!r.task || !m!.tasks.length || m!.tasks.includes(r.task)));
}

/** `left`: the disk the tool's set-up can still use for this part, once the parts before it took theirs (toolOn). */
function judgeModel(r: Requirement, need: Extract<Requirement["need"], { kind: "model" }>, place: Place, ctx: Ctx, left?: number | null): ReqStatus {
  const list = candidates(need, ctx);
  if (!list.length) return say(r, "unsupported", "No open model does this yet");
  const hw = place.hw;
  const rows = hw ? fitRows({ machine: hw, catalog: list, target: place.target, status: ctx.local }) : [];
  const room = roomOn(place);
  const missing = (v: LocalVariant) => installState(v, place.target).missingGb * 1024 ** 3;
  // Every model it can use here, for Settings' chooser (each against the whole free disk): the status below marks
  // Crackio's pick among them, which fits what the tool's other parts leave.
  const options = hw ? modelOptions(rows, hw, place, room, need.task) : undefined;
  const budget = left === undefined ? room : left;
  const out = (s: ReqStatus, model?: string, variant?: string): ReqStatus =>
    options ? { ...s, options: options.map((o) => (o.model === model ? { ...o, pick: true, variant: variant ?? o.variant } : o)).sort(byPick) } : s;

  for (const model of list) {
    const v = installedVariant(model, place.target);
    if (v) return out(ready(r, `${model.name}, ${v.label}`), model.id, v.id);
  }
  if (!hw) return say(r, "missing", "Not answering");
  // A download under way, of any version of these (one picked in Settings too): the version Crackio would pick first.
  for (const row of rows) {
    const versions = [...(row.fit.variant ? [row.fit.variant] : []), ...row.model.variants.filter((v) => v.id !== row.fit.variant?.id)];
    for (const v of versions) {
      const st = installState(v, place.target);
      if (!st.active.length) continue;
      // Its plan too: a set-up started now follows this download to the end instead of saying there's nothing to do.
      const plan: SetupPart = { kind: "model", model: row.model.id, name: row.model.name, variant: v.id, variantLabel: v.label, bytes: Math.round(st.missingGb * 1024 ** 3), gated: Boolean(row.model.gated) };
      return out(say(r, "installing", st.checking ? `Checking ${row.model.name}` : `Downloading ${row.model.name}`, { progress: { received: st.done, total: st.total }, plan }), row.model.id, v.id);
    }
  }
  let pick = rows.find((x) => !x.blocked && runsWell(x.fit)) ?? rows.find((x) => !x.blocked && x.fit.state === "slow");
  if (!pick || !pick.fit.variant) {
    if (rows.length && rows.every((x) => x.blocked)) return out(say(r, "blocked", `Its licence leaves out ${ctx.local.region ?? "your region"}`));
    return out(say(r, "unsupported", rows.find((x) => !x.blocked)?.fit.why ?? "Doesn't run on this machine"));
  }
  // Too big for the disk there (a box rented with 16 GB keeps ~9 GB once ComfyUI and PyTorch are in): the best version
  // of any of these models that fits its free disk instead, so a set-up can finish. None fits: the best one, and the
  // Set up button says to make room.
  let roomy = "";
  if (budget !== null && missing(pick.fit.variant) > budget) {
    const smaller = rows
      .filter((x) => !x.blocked)
      .flatMap((x) => x.model.variants.map((v) => ({ model: x.model, fit: fitVariant(hw, v) })))
      .filter((o) => o.fit.state !== "no" && o.fit.variant && missing(o.fit.variant) <= budget)
      .sort(
        (a, b) =>
          Number(runsWell(b.fit)) - Number(runsWell(a.fit)) ||
          b.model.quality * b.fit.variant!.fidelity - a.model.quality * a.fit.variant!.fidelity ||
          (a.fit.seconds ?? Infinity) - (b.fit.seconds ?? Infinity),
      )[0];
    if (smaller) {
      pick = { ...smaller, blocked: false };
      roomy = ", fits the disk";
    }
  }
  const variant = pick.fit.variant!;
  const st = installState(variant, place.target);
  const bytes = Math.round(st.missingGb * 1024 ** 3);
  const plan: SetupPart = {
    kind: "model",
    model: pick.model.id,
    name: pick.model.name,
    variant: variant.id,
    variantLabel: variant.label,
    bytes,
    gated: Boolean(pick.model.gated),
  };
  const slow = pick.fit.state === "slow" ? ", slow here" : "";
  const picked = pick.model.id;
  const said = (s: ReqStatus) => out(s, picked, variant.id);
  if (st.failed && !st.active.length) return said(say(r, "broken", `${pick.model.name}: its download stopped (${st.failed.error ?? "failed"})`, { plan }));
  if (pick.model.gated && !ctx.keys.hf) return said(say(r, "needs-key", `${pick.model.name} needs your Hugging Face token`, { plan, key: "hf" }));
  return said(say(r, "missing", `${pick.model.name}, ${variant.label}${slow}${roomy}`, { plan }));
}

/** Crackio's pick first, then what's there, then what runs well, then the best looking. */
function byPick(a: ModelOption, b: ModelOption) {
  const there = (o: ModelOption) => Number(o.variants.some((v) => v.installed));
  const well = (o: ModelOption) => {
    const v = o.variants.find((x) => x.id === o.variant);
    return v ? (v.fit === "great" || v.fit === "ok" ? 2 : v.fit === "slow" ? 1 : 0) : 0;
  };
  return Number(b.pick) - Number(a.pick) || there(b) - there(a) || Number(a.blocked) - Number(b.blocked) || well(b) - well(a) || b.quality - a.quality;
}

/**
 * Each model a requirement can use on a machine, with every version of it: how it runs there (the model library's fit),
 * what's left to download, whether that fits the disk. Its version to get: the one there, else the one that runs best
 * and fits the disk.
 */
function modelOptions(rows: Row[], hw0: Machine, place: Place, room: number | null, task?: string): ModelOption[] {
  const have = new Set(place.target?.installed ?? []);
  // Planned for a free card (as Settings' estimate is): a ComfyUI's budget is what its GPU has free right now, which a
  // model still loaded from the last job shrinks (a 4090 with LTX loaded showed 13 GB, and LTX "spilling 11 GB").
  const gpu = mainGpu(hw0);
  const hw: Machine = gpu && !gpu.unified && gpu.memoryGb ? { ...hw0, modelMemoryGb: Math.max(hw0.modelMemoryGb, gpu.memoryGb) } : hw0;
  return rows.map((row) => {
    const work = cardWork(row.model);
    const variants: OptionVariant[] = row.model.variants
      .filter((v) => v.files.length > 0)
      .map((v) => {
        // How it fits this machine's GPU, RAM and disk (pooling with another computer, for the version that does); its time
        // comes from Settings' estimate, which reads this machine's runs on a free GPU (the library's "measured far slower"
        // can be another job sharing the GPU).
        const f = v.id === row.fit.variant?.id && row.fit.pool ? row.fit : fitVariant(hw, v);
        const left = Math.round(installState(v, place.target).missingGb * 1024 ** 3);
        const seconds = f.seconds === null ? null : f === row.fit ? f.seconds : f.seconds * work;
        return {
          id: v.id,
          label: v.label,
          bytes: left,
          fit: f.state,
          why: f.why,
          seconds,
          installed: v.files.every((x) => have.has(`${x.folder}/${x.name}`)),
          fitsDisk: room === null || left <= room,
          fidelity: v.fidelity,
          needGb: v.needGb,
        };
      });
    const there = variants.find((v) => v.installed);
    const runs = (v: OptionVariant) => (v.fit === "great" || v.fit === "ok" ? 2 : v.fit === "slow" ? 1 : 0);
    const best = variants.find((v) => v.id === row.fit.variant?.id);
    const roomy = [...variants]
      .filter((v) => v.fitsDisk && runs(v) > 0)
      .sort((a, b) => runs(b) - runs(a) || fidelity(row.model, b.id) - fidelity(row.model, a.id) || (a.seconds ?? Infinity) - (b.seconds ?? Infinity))[0];
    const variant = there ?? (best && best.fitsDisk ? best : (roomy ?? best ?? variants[0]));
    return {
      model: row.model.id,
      name: row.model.name,
      maker: row.model.maker,
      blurb: row.model.blurb,
      quality: row.model.quality,
      qualityKnown: Boolean(row.model.qualityKnown),
      audio: Boolean(row.model.audio),
      licence: { name: row.model.licence.name, commercial: row.model.licence.commercial, ...(row.model.licence.url ? { url: row.model.licence.url } : {}) },
      unit: row.model.unit,
      gated: Boolean(row.model.gated),
      blocked: row.blocked,
      pick: false,
      variant: variant?.id ?? "",
      variants,
      knobs: knobsFor(row.model, task),
    };
  });
}

const fidelity = (model: LocalModel, variant: string) => model.variants.find((v) => v.id === variant)?.fidelity ?? 1;

/**
 * Bytes a set-up can still download on a machine: its free disk where models go, less what's already queued there and
 * the room a set-up keeps spare (storage planInstall: 2 GB, 10 GB on the drive Crackio itself runs from). Null when unknown.
 */
function roomOn(place: Place): number | null {
  const free = place.hw?.diskFreeGb;
  if (free == null) return null;
  const queued = (place.target?.downloads ?? [])
    .filter((d) => d.state === "queued" || d.state === "downloading" || d.state === "checking")
    .reduce((n, d) => n + Math.max(0, (d.total || 0) - (d.received || 0)), 0);
  return free * 1024 ** 3 - queued - spareGb(place.kind) * 1024 ** 3;
}

/** What a machine costs an hour: a rented box's price on its cloud, a pay-per-job GPU's price for an hour of work. */
function hourly(kind: MachineKind, cloud: { provider?: string; instance?: string } | undefined, gpu: string | undefined): Pick<SetupMachine, "pricePerHour" | "priceFrom"> {
  if (kind === "serverless") {
    const perSecond = pricePerSecond(gpu);
    return perSecond ? { pricePerHour: perSecond * 3600, priceFrom: "RunPod Serverless" } : { pricePerHour: null, priceFrom: null };
  }
  const price = cloud ? boxPrice(cloud.provider, cloud.instance) : null;
  return price ? { pricePerHour: price, priceFrom: cloud?.provider === "vast" ? "vast.ai" : cloud?.provider === "runpod" ? "RunPod" : "your cloud" } : { pricePerHour: null, priceFrom: null };
}

/** The room a set-up keeps free on a machine's download drive, as planInstall does. */
const spareGb = (kind: MachineKind) => (kind === "this-computer" ? 10 : 2);

/**
 * The voice models a machine can run (only those that copy a voice, for Lip Sync), as Settings' chooser lists them: the
 * version its installer would get there (the biggest that fits the GPU whole, else with part of it in RAM), what it
 * downloads with the engine and speech to text it still needs, and whether it's there.
 */
function voiceOptions(clone: boolean, gpuGb: number | null, ramGb: number | null, unified: boolean, have: string[], extra: number, room: number | null): ModelOption[] {
  return VOICE_MODELS.filter((m) => !clone || m.can.clone).map((m) => {
    const fit = variantFor(m, gpuGb, ramGb, unified);
    const v = fit?.variant ?? m.variants.at(-1)!;
    const installed = have.includes(m.id);
    const bytes = installed ? 0 : v.file.bytes + extra;
    const variant: OptionVariant = {
      id: v.id,
      label: v.label,
      bytes,
      fit: !fit ? "no" : fit.offload ? "slow" : "great",
      why: !fit ? `Needs ${v.minGb} GB of GPU memory` : fit.offload ? "Part of it runs from RAM" : `Fits in ${Math.round(gpuGb ?? 0)} GB`,
      seconds: null,
      installed,
      fitsDisk: room === null || bytes <= room,
      fidelity: 1,
      needGb: v.needGb,
    };
    return {
      model: m.id,
      name: m.name,
      maker: m.maker,
      blurb: m.blurb,
      quality: m.quality,
      qualityKnown: false,
      audio: true,
      licence: { name: m.licence.name, commercial: m.licence.commercial, url: m.licence.url },
      unit: "clip",
      gated: false,
      blocked: false,
      pick: false,
      variant: v.id,
      variants: [variant],
      knobs: VOICE_KNOBS,
    };
  });
}

/** A voice model there (one that clones, for Lip Sync), with its engine: what setUpVoice gets. */
function judgeVoice(r: Requirement, clone: boolean, place: Place, ctx: Ctx): ReqStatus {
  const vm = ctx.voice.get(place.id);
  const pickFor = (gpuGb: number | null, ramGb: number | null, unified: boolean) =>
    VOICE_MODELS.filter((m) => !clone || m.can.clone)
      .map((m) => ({ m, fit: variantFor(m, gpuGb, ramGb, unified) }))
      .find((x) => x.fit && (x.m.id !== "local:voice:drama3" || !x.fit.offload));
  const room = roomOn(place);
  // Its list for the chooser, Crackio's pick (the one there, else the plan's) marked first.
  const listed = (s: ReqStatus, gpuGb: number | null, ramGb: number | null, unified: boolean, have: string[], extra: number, pick?: string | null): ReqStatus => {
    const options = voiceOptions(clone, gpuGb, ramGb, unified, have, extra, room).map((o) => (o.model === pick ? { ...o, pick: true } : o));
    return { ...s, options: options.sort((a, b) => Number(b.pick) - Number(a.pick)) };
  };
  if (place.noComfy || !vm) {
    const gpu = place.hw ? mainGpu(place.hw) : undefined;
    const gpuGb = place.hw?.modelMemoryGb ?? gpu?.memoryGb ?? null;
    const pick = pickFor(gpuGb, place.hw?.ramGb ?? null, Boolean(gpu?.unified));
    if (!pick?.fit) return say(r, "unsupported", "No voice model fits this machine");
    const bytes = pick.fit.variant.file.bytes + 1e9 + HEARING_BYTES;
    return listed(say(r, "missing", pick.m.name, { plan: { kind: "voice", bytes, clone, model: pick.m.id } }), gpuGb, place.hw?.ramGb ?? null, Boolean(gpu?.unified), [], 1e9 + HEARING_BYTES, pick.m.id);
  }
  if (!bridgeHas(vm.bridge, "voiceSetup")) return say(r, "outdated", "Needs a newer Crackio helper there", { fix: "bridge" });
  if (vm.setup?.state === "running") return say(r, "installing", vm.setup.detail || "Setting up Voice", { progress: vm.setup.progress });
  const have = vm.models.filter((id) => !clone || CLONERS.has(id));
  const engineLeft = (vm.engine ? 0 : (AUDIOCPP_BYTES[vm.builds[0] ?? ""] ?? 1e9)) + (vm.hearing ? 0 : HEARING_BYTES);
  if (vm.engine && have.length) {
    const names = have.map((id) => VOICE_MODELS.find((m) => m.id === id)?.name ?? id).join(", ");
    return listed(ready(r, vm.hearing ? names : `${names} (no speech to text yet)`), vm.gpuGb, vm.ramGb, vm.unified, have, engineLeft, have[0]);
  }
  if (vm.setup?.state === "error") return say(r, "broken", vm.setup.error ?? "Voice's set-up stopped", { plan: { kind: "voice", bytes: 0, clone, model: null } });
  const pick = pickFor(vm.gpuGb, vm.ramGb, vm.unified);
  if (!pick?.fit) return say(r, "unsupported", clone ? "No voice model that clones fits this machine" : "No voice model fits this machine");
  const engine = vm.engine ? 0 : (AUDIOCPP_BYTES[vm.builds[0] ?? ""] ?? 1e9);
  const bytes = (have.length ? 0 : pick.fit.variant.file.bytes) + engine + (vm.hearing ? 0 : HEARING_BYTES);
  return listed(
    say(r, "missing", `${pick.m.name}${vm.engine ? "" : " and its engine"}`, { plan: { kind: "voice", bytes, clone, model: have.length ? null : pick.m.id } }),
    vm.gpuGb,
    vm.ramGb,
    vm.unified,
    have,
    engineLeft,
    have[0] ?? pick.m.id,
  );
}

/** LFM3-VL 2B and a transformers it runs on (Talk's set-up). */
function judgeLfm3(r: Requirement, place: Place, ctx: Ctx): ReqStatus {
  const vm = ctx.voice.get(place.id);
  if (place.noComfy || !vm) return say(r, "missing", "LFM3-VL 2B", { plan: { kind: "lfm3", bytes: LFM3_BYTES } });
  if (!bridgeHas(vm.bridge, "lfm3Setup")) return say(r, "outdated", "Needs a newer Crackio helper there", { fix: "bridge" });
  if (vm.brainSetup?.state === "running") return say(r, "installing", vm.brainSetup.detail || "Setting up LFM3-VL", { progress: vm.brainSetup.progress });
  const b = vm.brain;
  if (b?.ready) return ready(r, "LFM3-VL 2B");
  if (vm.brainSetup?.state === "error") return say(r, "broken", vm.brainSetup.error ?? "Its set-up stopped", { plan: { kind: "lfm3", bytes: b?.files ? 0 : LFM3_BYTES } });
  if (b?.files) return say(r, "outdated", b.restart ? "Waits for a ComfyUI restart" : "Needs a newer transformers", { plan: { kind: "lfm3", bytes: 0.2e9 } });
  return say(r, "missing", "LFM3-VL 2B", { plan: { kind: "lfm3", bytes: LFM3_BYTES } });
}

/**
 * One of Crackio's LFM3-VL fine-tunes, which runs on LFM3-VL itself: a set-up gets the fine-tune and what LFM3-VL
 * lacks in one go (setUpTalk). One that isn't published can't download (lib/local/lfm3), and while its repo is
 * private the download needs the Hugging Face token.
 */
function judgeLora(r: Requirement, lora: Lfm3LoraKey, place: Place, ctx: Ctx): ReqStatus {
  const l = LFM3_LORAS[lora];
  const base = judgeLfm3(r, place, ctx);
  if (ctx.voice.get(place.id)?.brain?.loras.includes(lora)) {
    // There: ready with LFM3-VL, else what LFM3-VL needs first (its plan gets just that).
    return base.state === "ready" ? ready(r, "On this machine") : base;
  }
  if (!lfm3LoraUrl(lora)) return say(r, "unpublished", "Not published yet");
  // An old helper is updated first; a set-up running there takes this one too when it's asked again.
  if (base.state === "installing" || (base.state === "outdated" && base.fix === "bridge")) return base;
  const plan: SetupPart = { kind: "lfm3", bytes: (base.state === "ready" ? 0 : (base.plan?.bytes ?? LFM3_BYTES)) + l.bytes, loras: [lora] };
  if (l.private && !ctx.keys.hf) return say(r, "needs-key", `${l.label} needs your Hugging Face token while it's private`, { plan, key: "hf" });
  if (base.state === "broken") return { ...base, plan };
  return say(r, "missing", base.state === "ready" ? l.label : `${LFM3_NAME} and ${l.label}`, { plan });
}

function judgeLipsync(r: Requirement, place: Place, ctx: Ctx): ReqStatus {
  const lm = ctx.lipsync.get(place.id);
  const gpu = place.hw ? mainGpu(place.hw) : undefined;
  const nvidia = gpu?.vendor === "nvidia";
  const gpuGb = lm?.gpuGb ?? gpu?.memoryGb ?? 0;
  const fits = nvidia && !gpu?.unified && gpuGb >= LIPSYNC_VRAM_GB;
  const need = LIPSYNC_FILES.filter((f) => f.key !== "syncnet");
  if (lm && !place.noComfy) {
    if (!bridgeHas(lm.bridge, "lipsync")) return say(r, "outdated", "Needs a newer Crackio helper there", { fix: "bridge" });
    if (lm.setup?.state === "running") return say(r, "installing", lm.setup.detail || "Setting up Lip Sync", { progress: lm.setup.progress });
    if (lm.engine && lm.hasModels) return ready(r, "LatentSync 1.6");
    if (lm.setup?.state === "error") return say(r, "broken", lm.setup.error ?? "Its set-up stopped", { plan: { kind: "lipsync", bytes: 0 } });
  }
  if (!fits) return say(r, "unsupported", `Needs an NVIDIA card with ${LIPSYNC_VRAM_GB} GB or more`);
  const bytes = need.filter((f) => !lm?.models[f.key]).reduce((s, f) => s + f.bytes, 0) + (lm?.engine ? 0 : LIPSYNC_ENGINE_BYTES);
  if (!ctx.keys.hf) return say(r, "needs-key", "LatentSync's files need your Hugging Face token", { plan: { kind: "lipsync", bytes }, key: "hf" });
  return say(r, "missing", "LatentSync 1.6", { plan: { kind: "lipsync", bytes } });
}

function judge(r: Requirement, place: Place, ctx: Ctx): ReqStatus {
  const need = r.need;
  switch (need.kind) {
    case "model": {
      // Lip Sync's best quality (HuMo 17B) only runs on 28 GB or more, and the Lip Sync page refuses it below that: never
      // offer its 27 GB download there, though the model judge alone would call it "slow here".
      const gpu = r.id === "lipsync.best" && place.hw ? mainGpu(place.hw) : undefined;
      if (gpu) {
        const gpuGb = ctx.lipsync.get(place.id)?.gpuGb ?? gpu.memoryGb ?? 0;
        if (gpu.vendor !== "nvidia" || gpu.unified || gpuGb < LIPSYNC_BEST_VRAM_GB) return say(r, "unsupported", "Needs a GPU with 32 GB");
      }
      return judgeModel(r, need, place, ctx);
    }
    case "voice":
      return judgeVoice(r, Boolean(need.clone), place, ctx);
    case "lfm3":
      return judgeLfm3(r, place, ctx);
    case "lfm3-lora":
      return judgeLora(r, need.lora, place, ctx);
    case "lipsync":
      return judgeLipsync(r, place, ctx);
    case "key":
      return ctx.keys[need.key] ? ready(r, need.key === "comfy" ? "Your Comfy key" : "Your Hugging Face token") : say(r, "needs-key", need.key === "comfy" ? "Needs your Comfy key" : "Needs your Hugging Face token", { key: need.key });
    case "host-vision": {
      const missing = need.models.filter((m) => !ctx.vision[m]?.present);
      if (!missing.length) return ready(r, "On this computer");
      const bytes = missing.reduce((s, m) => s + (ctx.vision[m]?.bytes ?? 0), 0);
      return say(r, "auto", `Comes by itself the first time (${gbText(bytes)})`);
    }
  }
}

const PRECEDENCE: ToolState[] = ["installing", "unsupported", "needs-update", "broken", "needs-key", "missing"];

function toolOn(kit: Kit, place: Place, ctx: Ctx): ToolStatus {
  // Each part against the whole free disk first; when the tool's parts together don't fit, each model part again against
  // what the others leave, so a smaller version of one makes room for all (Director's shot model and place model).
  const first = kit.needs.map((r) => judge(r, place, ctx));
  const takes = (s: ReqStatus) => (!s.optional && s.plan && (s.state === "missing" || s.state === "needs-key" || s.state === "broken") ? s.plan.bytes : 0);
  const room = roomOn(place);
  const total = first.reduce((n, s) => n + takes(s), 0);
  const reqs =
    room !== null && total > room
      ? kit.needs.map((r, i) => (r.need.kind === "model" && !r.optional && takes(first[i]) ? judgeModel(r, r.need, place, ctx, room - (total - takes(first[i]))) : first[i]))
      : first;
  const required = reqs.filter((r) => !r.optional);
  const cloud = Boolean(kit.cloud && ctx.keys.comfy);
  const bytes = required.reduce((s, r) => s + (r.state === "missing" || r.state === "needs-key" || r.state === "broken" || r.state === "outdated" ? (r.plan?.bytes ?? 0) : 0), 0);
  if (!place.online && !place.noComfy) return { kit: kit.id, state: "offline", why: "Not answering", bytes: 0, reqs, cloud };
  const stateOf = (r: ReqStatus): ToolState | null => {
    if (r.state === "installing") return "installing";
    if (r.state === "unsupported" || r.state === "blocked") return "unsupported";
    if (r.state === "outdated") return "needs-update";
    if (r.state === "broken") return "broken";
    if (r.state === "needs-key") return "needs-key";
    if (r.state === "missing") return "missing";
    return null;
  };
  for (const state of PRECEDENCE) {
    const hit = required.find((r) => stateOf(r) === state);
    if (!hit) continue;
    if (state === "missing" && place.noComfy) {
      return { kit: kit.id, state: "no-comfy", why: `Sets up ComfyUI first, then ${missingNames(required)}`, bytes: bytes + COMFY_BYTES, reqs, cloud };
    }
    const why = state === "missing" ? `Gets ${missingNames(required)}` : hit.why;
    return { kit: kit.id, state, why, bytes, reqs, cloud };
  }
  const main = required.find((r) => r.has && r.state === "ready");
  return { kit: kit.id, state: "ready", why: main?.has ?? "Ready", bytes: 0, reqs, cloud };
}

function missingNames(reqs: ReqStatus[]) {
  const names = reqs
    .filter((r) => r.state === "missing" || r.state === "needs-key")
    .map((r) => (r.plan?.kind === "model" ? r.plan.name : r.why))
    .filter((n, i, all) => all.indexOf(n) === i);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function kindOf(t: TargetStatus, ct: ComfyTarget | undefined): MachineKind {
  if (ct?.serverless) return "serverless";
  if (ct?.metered === "comfy-cloud" || t.id === "comfy-cloud") return "comfy-cloud";
  if (t.onThisComputer) return "this-computer";
  if (t.cloud) return "rented";
  return "lan";
}

const WHERE: Record<MachineKind, string> = {
  "this-computer": "This computer",
  lan: "On your network",
  rented: "Rented",
  serverless: "RunPod Serverless · pay per job",
  "comfy-cloud": "Comfy Cloud · pay per job",
};

function labelOf(hw: Machine | null, t: TargetStatus | null) {
  const gpu = hw ? mainGpu(hw) : undefined;
  if (gpu && gpu.vendor !== "other") return shortGpuName(gpu.name);
  if (hw?.label) return hw.label;
  return t?.label ?? "This computer";
}

function placeOf(p: Place, ctx: Ctx, latest: string, runOn: string, comfy: SetupStatus | null, ct: ComfyTarget | undefined): SetupMachine {
  const t = p.target;
  const hw = p.hw;
  const gpu = hw ? mainGpu(hw) : undefined;
  const have = new Set(t?.installed ?? []);
  const seen = new Set<string>();
  let modelBytes = 0;
  for (const m of ctx.models.values()) {
    for (const v of m.variants) {
      for (const f of v.files) {
        const key = `${f.folder}/${f.name}`;
        if (have.has(key) && !seen.has(key)) {
          seen.add(key);
          modelBytes += f.bytes;
        }
      }
    }
  }
  const active = (t?.downloads ?? []).filter((d) => d.state === "queued" || d.state === "downloading" || d.state === "checking");
  const bridge = t?.bridge ?? null;
  const update: SetupMachine["bridge"]["update"] =
    p.kind === "serverless" || p.kind === "comfy-cloud" ? "never" : p.kind === "this-computer" ? "this-computer" : ct?.cloud?.ssh ? "reconnect" : "by-hand";
  const thisComfy = p.kind === "this-computer" ? comfy : null;
  return {
    id: p.id,
    label: labelOf(hw, t),
    where: p.kind === "rented" && t?.cloud ? `Rented on ${t.cloud.provider === "vast" ? "vast.ai" : t.cloud.provider === "runpod" ? "RunPod" : "the cloud"}` : WHERE[p.kind],
    kind: p.kind,
    online: p.online,
    gpu: gpu ? { name: gpu.name, vendor: gpu.vendor, memoryGb: gpu.memoryGb, unified: gpu.unified, compute: gpu.compute } : null,
    ramGb: hw?.ramGb ?? null,
    os: hw?.os.name ?? null,
    accel: hw?.accel ?? null,
    diskFreeGb: hw?.diskFreeGb ?? null,
    spareGb: spareGb(p.kind),
    ...hourly(p.kind, t?.cloud, gpu?.name),
    modelBytes,
    comfy: {
      installed: p.kind !== "this-computer" || Boolean(thisComfy?.installed) || Boolean(t),
      running: p.online,
      version: hw?.comfy?.version ?? thisComfy?.comfyui ?? null,
      url: t?.url ?? thisComfy?.url ?? null,
    },
    bridge: { version: bridge, latest, outdated: Boolean(t) && !versionAtLeast(bridge, latest), update },
    runOn: Boolean(t) && runOn === t!.id,
    metered: Boolean(ct?.metered),
    cloud: t?.cloud ? { provider: t.cloud.provider, instance: t.cloud.instance } : undefined,
    tools: Object.fromEntries(KITS.map((k) => [k.id, toolOn(k, p, ctx)])) as Record<KitId, ToolStatus>,
    downloads: { count: active.length, received: active.reduce((s, d) => s + d.received, 0), total: active.reduce((s, d) => s + d.total, 0) },
  };
}

const cache = globalThis as unknown as { __crackioSetupSnapshot?: { at: number; snap: Promise<SetupSnapshot> } };

/** Every machine × every tool, looked at afresh at most every 2 s (Settings and the pills poll it). */
export function setupSnapshot(fresh = false): Promise<SetupSnapshot> {
  const hit = cache.__crackioSetupSnapshot;
  if (!fresh && hit && Date.now() - hit.at < 2000) return hit.snap;
  const snap = build();
  cache.__crackioSetupSnapshot = { at: Date.now(), snap };
  snap.catch(() => {
    if (cache.__crackioSetupSnapshot?.snap === snap) cache.__crackioSetupSnapshot = undefined;
  });
  return snap;
}

/** Forget the last look, so the next one is fresh (a set-up just changed something). */
export function forgetSetupSnapshot() {
  cache.__crackioSetupSnapshot = undefined;
}

async function build(): Promise<SetupSnapshot> {
  const [local, voice, lipsync, comfy, settings, targets, vision, latest] = await Promise.all([
    localStatus(),
    voiceMachines().catch(() => [] as VoiceMachine[]),
    lipsyncMachines().catch(() => [] as LipsyncMachine[]),
    setupStatus().catch(() => null),
    getSettings(),
    comfyTargets(),
    visionOnDisk().catch(() => ({}) as Awaited<ReturnType<typeof visionOnDisk>>),
    latestBridge(),
  ]);
  const models = new Map<string, LocalModel>();
  for (const m of allLocalModels()) if (m.crackio) models.set(m.crackio, m);
  const keys = {
    comfy: Boolean(settings.keys.comfy || process.env.COMFY_API_KEY),
    hf: local.hfToken,
    vast: Boolean(settings.keys.vast),
    runpod: Boolean(settings.keys.runpod || process.env.RUNPOD_API_KEY),
  };
  const ctx: Ctx = { local, models, voice: new Map(voice.map((m) => [m.id, m])), lipsync: new Map(lipsync.map((m) => [m.id, m])), vision, keys };
  const byTarget = new Map(targets.map((t) => [t.id, t]));
  const hwOf = new Map(local.machines.filter((m) => m.target).map((m) => [m.target!, m]));
  const thisComputer = local.machines.find((m) => m.where === "this-computer") ?? null;

  const places: Place[] = [];
  for (const t of local.targets) {
    const ct = byTarget.get(t.id);
    const kind = kindOf(t, ct);
    // ComfyUI's usual address, looked at in case one runs there: only a machine once it answers. Comfy Cloud is a key
    // (Accounts), not a machine to set up.
    if ((t.implicit && !t.connected) || kind === "comfy-cloud") continue;
    const hw = hwOf.get(t.id) ?? (t.onThisComputer ? thisComputer : null);
    places.push({ id: t.id, kind, target: t, hw, online: t.connected, noComfy: false });
  }
  // This computer with no ComfyUI yet (or none Crackio knows): a set-up installs one first.
  if (!places.some((p) => p.kind === "this-computer") && thisComputer && !comfy?.installed) {
    places.unshift({ id: "this-computer", kind: "this-computer", target: null, hw: thisComputer, online: true, noComfy: true });
  }
  // This computer first, then the rest by GPU speed.
  places.sort((a, b) => Number(b.kind === "this-computer") - Number(a.kind === "this-computer") || Number(b.online) - Number(a.online) || (b.hw ? (speedOf(b.hw) ?? 0) : 0) - (a.hw ? (speedOf(a.hw) ?? 0) : 0));

  const runOn = local.runOn;
  const machines = places.map((p) => placeOf(p, ctx, latest, runOn, comfy, byTarget.get(p.id)));

  const runsOn: SetupSnapshot["runsOn"] = {};
  const recommended: SetupSnapshot["recommended"] = {};
  const speed = (m: SetupMachine) => {
    const p = places.find((x) => x.id === m.id);
    return p?.hw ? (speedOf(p.hw) ?? 0) : 0;
  };
  for (const kit of KITS) {
    const usable = machines.filter((m) => m.online && !m.metered);
    const readyOn = usable.filter((m) => m.tools[kit.id].state === "ready");
    const pinned = readyOn.find((m) => m.runOn);
    runsOn[kit.id] = (pinned ?? [...readyOn].sort((a, b) => speed(b) - speed(a))[0])?.id ?? null;
    const can = usable.filter((m) => !["unsupported", "offline"].includes(m.tools[kit.id].state));
    const pin = can.find((m) => m.runOn);
    recommended[kit.id] = (pin ?? [...can].sort((a, b) => Number(b.tools[kit.id].state === "ready") - Number(a.tools[kit.id].state === "ready") || speed(b) - speed(a))[0])?.id ?? null;
  }

  return { at: Date.now(), machines, runsOn, recommended, jobs: setupJobs(), keys, bridge: latest, credit: creditNow(), autoStop: await autoStopNow().catch(() => ({})) };
}
