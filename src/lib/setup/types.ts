/**
 * Settings' one picture of what's set up where (server/setup builds it, every setup surface reads it). Client-safe.
 *
 * A *kit* is what one tool needs to run on a machine (setup/kits). Each requirement is judged on each machine by the
 * same code the tools use (fitModel for catalog models, Voice's and Lip Sync's machine reads, the Comfy key), so
 * Settings, the tool pages, their setup pills and the model pickers can't disagree.
 */

import type { ToolSlug } from "@/lib/tools";
// Type only: erased at build time, so this client-safe file never loads the server module.
import type { VisionModelId } from "@/lib/server/vision";
import type { VoiceModelId } from "@/lib/voice/models";
import type { Lfm3LoraKey } from "@/lib/local/lfm3";
import type { Knobs } from "./knobs";

/** The tools and pages Settings sets up: every tool, plus the Image and Video pages. */
export type KitId = ToolSlug | "image" | "video";

export type Need =
  /** A catalog model (Crackio ids, best first); the version that fits the machine is chosen by fitModel. */
  | { kind: "model"; anyOf: string[]; task?: "image" | "edit" | "video" | "upscale" | "swap" }
  /** Voice's engine (audio.cpp) and a voice model, with speech to text and a spoken test line (setUpVoice). */
  | { kind: "voice"; clone?: boolean }
  /** LFM3-VL 2B, the small model Talk answers with and Crackio's checks read pictures with (setUpTalk). */
  | { kind: "lfm3" }
  /** One of Crackio's LFM3-VL fine-tunes: the swap judge, Retouch's eyes, Talk's chat voice. */
  | { kind: "lfm3-lora"; lora: "judge" | "retouch" | "chat" }
  /** Lip Sync's engine and LatentSync's files (setUpLipsync). */
  | { kind: "lipsync" }
  /** An account key: the Comfy key (hosted models, Motion's agent) or the Hugging Face token (gated downloads). */
  | { kind: "key"; key: "comfy" | "hf" }
  /** Small models the Crackio app itself runs (depth, cut-outs, 3D geometry): they come by themselves on first use. */
  | { kind: "host-vision"; models: VisionModelId[] };

export type Requirement = {
  id: string;
  /** Plain words: "A picture model", "Speech to text". */
  label: string;
  need: Need;
  /** The tool works without it; it adds something. */
  optional?: boolean;
  /** What stands in when it isn't here, in words ("Gemini 3.5 Flash on your Comfy key"). */
  instead?: string;
};

export type Kit = {
  id: KitId;
  name: string;
  /** One line: what it does. */
  summary: string;
  /** CSS colour (a tool hue) and its glyph, as the sidebar shows them. */
  hue: string;
  glyph: string;
  href: string;
  /** Its artwork (public/assets), as the Home page's tool tiles show it. */
  media: string;
  needs: Requirement[];
  /** What the tool can do without anything installed (a hosted model on the Comfy key), in words. */
  cloud?: string;
};

/**
 * A requirement on one machine:
 * - ready: there and usable.
 * - missing: not there; `plan` says what a set-up gets.
 * - installing: being set up now.
 * - outdated: there, but its bridge or package is too old (`fix` says how).
 * - broken: there, but it failed its check (`why` says what failed).
 * - unsupported: can't run on this machine (`why` says why).
 * - needs-key: an account key is missing first.
 * - blocked: its licence leaves this region out.
 * - unpublished: Crackio can't download it yet.
 * - auto: comes by itself the first time it's used.
 */
export type ReqState = "ready" | "missing" | "installing" | "outdated" | "broken" | "unsupported" | "needs-key" | "blocked" | "unpublished" | "auto";

export type ReqStatus = {
  id: string;
  label: string;
  state: ReqState;
  /** One line, plain words. */
  why: string;
  optional?: boolean;
  instead?: string;
  /** What it has now, in words ("FLUX 3 Klein, INT8"). */
  has?: string;
  /** What a set-up would get here. */
  plan?: SetupPart;
  /** Download progress while installing. */
  progress?: { received: number; total: number } | null;
  /** The key it waits for. */
  key?: "comfy" | "hf";
  /** What fixes it first: the machine's Crackio helper (bridge) needs an update. */
  fix?: "bridge";
  /**
   * A model part: every model it can use on this machine, Crackio's pick first (the one installed, else the plan's).
   * Settings lets you set the tool up with any of them, or add another to try.
   */
  options?: ModelOption[];
};

/** The fit words a model library card uses: runs well, just about, slowly, or not by Crackio's estimate. */
export type FitState = "great" | "ok" | "slow" | "no";

/** One version of a model on one machine. */
export type OptionVariant = {
  id: string;
  label: string;
  /** Still to download for it there (0 once it's there). */
  bytes: number;
  fit: FitState;
  /** Why, in a line: "Fits in 24 GB", "Needs 23 GB of RAM". */
  why: string;
  /** Seconds the tool's usual job takes with it there (a picture, a 5 s clip), by Crackio's estimate. */
  seconds: number | null;
  installed: boolean;
  /** Room for what's left of it where models download (2 GB kept spare, 10 on the drive Crackio runs from). */
  fitsDisk: boolean;
  /** How close it looks to the full model (1 = the full weights; INT8 ≈ 0.99). */
  fidelity: number;
  /** GPU memory it works in, in GB. */
  needGb: number;
};

/** A model a requirement can use on a machine, with the version Crackio would get and every other version. */
export type ModelOption = {
  /** Catalog id ("ltx-2.5"). */
  model: string;
  name: string;
  /** Who makes it, and what it's best at in a sentence (the model library's words). */
  maker: string;
  blurb: string;
  /** Crackio's one quality scale (the model library's); `qualityKnown` when it comes from evidence (else it only sorts). */
  quality: number;
  qualityKnown: boolean;
  /** Makes sound with the picture. */
  audio: boolean;
  licence: { name: string; commercial: "yes" | "limited" | "no"; url?: string };
  /** What its time is for: a picture, or a 5 s clip. */
  unit: "image" | "clip";
  gated: boolean;
  /** Its licence leaves your region out. */
  blocked: boolean;
  /** Crackio's pick for this requirement here. */
  pick: boolean;
  /** The version to get (or the one there): the one that runs best and fits the disk. */
  variant: string;
  variants: OptionVariant[];
  /** What its estimate can be set to (a clip's length and size, a picture's size…): setup/knobs. */
  knobs: Knobs;
};

/** One thing a set-up gets on a machine. Model parts carry the catalog model and the version chosen for the machine. */
export type SetupPart =
  | { kind: "model"; model: string; name: string; variant: string; variantLabel: string; bytes: number; gated?: boolean }
  | { kind: "voice"; bytes: number; clone?: boolean; /** The voice model to get, or null when one is there already. */ model: VoiceModelId | null }
  /** LFM3-VL 2B (what of it isn't there) and the fine-tunes listed (setUpTalk gets both). */
  | { kind: "lfm3"; bytes: number; loras?: Lfm3LoraKey[] }
  | { kind: "lipsync"; bytes: number }
  | { kind: "host-vision"; models: VisionModelId[]; bytes: number }
  | { kind: "comfyui"; bytes: number };

/**
 * A tool on one machine, summed up from its requirements:
 * - ready: every required part is there (optional ones may be missing).
 * - missing: something required isn't there and a set-up can get it (`bytes`).
 * - installing: a set-up is running for it.
 * - needs-update: its bridge or packages must be updated first.
 * - needs-key: a key is missing before anything else.
 * - unsupported: a required part can't run on this machine.
 * - broken: a required part failed its check.
 * - offline: the machine isn't answering.
 * - no-comfy: this computer has no ComfyUI yet (a set-up installs it first).
 */
export type ToolState = "ready" | "missing" | "installing" | "needs-update" | "needs-key" | "unsupported" | "broken" | "offline" | "no-comfy";

export type ToolStatus = {
  kit: KitId;
  state: ToolState;
  /** One line, plain words. */
  why: string;
  /** What a set-up downloads here, in bytes. */
  bytes: number;
  reqs: ReqStatus[];
  /** It can still run on a hosted model with the Comfy key. */
  cloud: boolean;
};

export type MachineKind = "this-computer" | "lan" | "rented" | "serverless" | "comfy-cloud";

export type SetupMachine = {
  /** A ComfyUI target id; "this-computer" for this computer while it has no ComfyUI. */
  id: string;
  /** The GPU's short name ("RTX 5090"), else the machine's ("MacBook Air"). */
  label: string;
  /** Where it is, in words ("This computer", "Rented on vast.ai", "On your network"). */
  where: string;
  kind: MachineKind;
  online: boolean;
  gpu: { name: string; vendor: string; memoryGb: number | null; unified: boolean; compute?: number } | null;
  ramGb: number | null;
  os: string | null;
  /** What ComfyUI computes on: cuda, mps, rocm, xpu, directml, cpu. */
  accel: string | null;
  diskFreeGb: number | null;
  /** What a set-up leaves free on its download drive, in GB (10 on the drive Crackio runs from, else 2). */
  spareGb: number;
  /** What it costs an hour, for a rented GPU (its cloud's price) or one paid per job (that price for an hour's work). */
  pricePerHour: number | null;
  /** Whose price that is: "vast.ai", "RunPod", "RunPod Serverless". */
  priceFrom: string | null;
  /** Catalog model files on it, in bytes (what Crackio installed there). */
  modelBytes: number;
  comfy: { installed: boolean; running: boolean; version: string | null; url: string | null };
  bridge: { version: string | null; latest: string; outdated: boolean; update: "this-computer" | "reconnect" | "by-hand" | "never" };
  /** Jobs go here when it's free (Settings → Preferences → Run on). */
  runOn: boolean;
  /** Billed per job: never picked by Auto. */
  metered: boolean;
  /** A rented GPU: its cloud and instance there (to connect it again, or open its page). */
  cloud?: { provider: "vast" | "runpod" | "other"; instance?: string };
  tools: Record<KitId, ToolStatus>;
  /** Files downloading there now. */
  downloads: { count: number; received: number; total: number };
};

/** One machine's GPU right now (Settings' meters): load, memory, heat, and what ComfyUI is doing. */
export type LiveGpu = {
  machine: string;
  at: number;
  online: boolean;
  /** GPU load, 0–100. */
  util: number | null;
  memUsedGb: number | null;
  memTotalGb: number | null;
  tempC: number | null;
  powerW: number | null;
  /** ComfyUI has work running or queued. */
  working: boolean;
  queue: number;
  /** The model the running graph loads ("LTX-2.5 INT8"), when Crackio knows it. */
  running: string | null;
  /** A Mac's own thermal state ("nominal", "fair", "serious", "critical"). */
  thermal?: string | null;
};

/** A cloud account's credit, and how long it lasts at what its running boxes cost now. */
export type CloudCredit = {
  provider: "vast" | "runpod";
  balance: number;
  /** Dollars an hour the account's running boxes cost now. */
  perHour: number;
  running: number;
  /** Hours the credit lasts at that rate, and when it runs out (ms); null when nothing runs. */
  hoursLeft: number | null;
  until: number | null;
  at: number;
};

/** A rented box's idle stop: after how many idle minutes, how long it has been idle, and whether Crackio stopped it. */
export type AutoStop = {
  /** "vast:58824818" */
  box: string;
  minutes: number | null;
  /** It counts as idle while its GPU load stays under this, in % (10 unless you pick another). */
  load: number;
  /** Once idle that long: stop it (its disk stays) or delete it for good (a one-time box). */
  then: "stop" | "delete";
  idleMinutes: number | null;
  /** Why the idle clock isn't running, from Crackio's last look ("its GPU is at 34%"); null while idle or before a look. */
  why: string | null;
  stoppedAt?: number;
};

/** Something worth a notification: a long take done, a set-up ended, a box stopped, credit running out. */
export type CrackioEvent = {
  /** Stable: a notification's tag, so the same event never shows twice. */
  id: string;
  at: number;
  kind: "take" | "setup" | "box" | "credit";
  ok: boolean;
  title: string;
  body: string;
  /** Where clicking it goes. */
  href: string;
  icon: string;
};

export type SetupStepState = "waiting" | "running" | "done" | "error" | "skipped";

export type SetupStep = {
  id: string;
  /** "FLUX 3 Klein", "Voice", "ComfyUI". */
  label: string;
  state: SetupStepState;
  detail: string;
  progress: { received: number; total: number } | null;
  error: string | null;
};

export type SetupJob = {
  id: string;
  machine: string;
  machineLabel: string;
  kits: KitId[];
  state: "queued" | "running" | "done" | "error" | "stopped";
  steps: SetupStep[];
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type SetupSnapshot = {
  at: number;
  machines: SetupMachine[];
  /** The machine each tool runs on now (the same pick its jobs make), or null when none is set up for it. */
  runsOn: Partial<Record<KitId, string | null>>;
  /** Where to set each tool up when you don't pick: the machine it would run best on. */
  recommended: Partial<Record<KitId, string | null>>;
  jobs: SetupJob[];
  keys: { comfy: boolean; hf: boolean; vast: boolean; runpod: boolean };
  /** The bridge version this Crackio carries. */
  bridge: string;
  /** Your cloud accounts' credit and how long it lasts (vast.ai, RunPod), when Crackio has their keys. */
  credit: CloudCredit[];
  /** Rented boxes that stop themselves when idle, by "provider:instance". */
  autoStop: Record<string, AutoStop>;
};
