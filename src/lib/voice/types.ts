import type { Lfm3LoraKey } from "@/lib/local/lfm3";
import type { VoiceModelId } from "./models";
import type { SceneLine } from "./script";

/** A voice to speak with: Crackio's own ready ones, or one you cloned or designed. Client-safe. */
export type VoiceCard = {
  id: string;
  name: string;
  /** A few words: how it sounds. */
  desc: string;
  tags: string[];
  /** Its orb's two colours. */
  hues: [string, string];
  source: "ready" | "clone" | "design";
  /** The clip models clone it from, and exactly what the clip says. */
  sample: string;
  text: string;
  /** Supertonic's closest voice of its own, for models that can't clone. */
  preset: string;
  language?: string;
  createdAt?: number;
  /** A clone was saved only after its owner said the voice is theirs or they have permission. */
  consent?: boolean;
};

/** A machine as Voice sees it (server/voice/machines). */
export type VoiceMachine = {
  id: string;
  label: string;
  online: boolean;
  gpu: string | null;
  gpuGb: number | null;
  ramGb: number | null;
  /** Free space where voice models go. */
  diskGb: number | null;
  bridge: string | null;
  /** Its bridge has the Voice nodes (1.8+). */
  voiceReady: boolean;
  /** audio.cpp's build there, once installed. */
  engine: string | null;
  installing: { received: number; total: number } | null;
  installError: string | null;
  /** The kind of computer: Windows, Linux (most rented GPUs) or macOS. */
  platform: "windows" | "linux" | "macos" | null;
  /** Its GPU shares the computer's memory (a Mac): gpuGb is the share a model can use. */
  unified: boolean;
  /** The audio.cpp builds for it, best first (bridge 1.8.5+): a GPU one, then the ones that run anywhere. */
  builds: string[];
  /** What installing audio.cpp is doing, and the builds that didn't run there (bridge 1.8.5+). */
  installStage: "downloading" | "unpacking" | "checking" | null;
  installTried: { build: string; error: string }[];
  /** The GPU audio.cpp found there. */
  engineGpu: string | null;
  /** The engine has spoken its test line there (bridge 1.8.5+). */
  engineSpoke: boolean;
  /** The test line: a model speaking a short line and speech to text hearing it back. */
  check: VoiceCheck | null;
  /** Crackio setting Voice up there, while it runs and a while after. */
  setup: VoiceSetupJob | null;
  files: string[];
  models: VoiceModelId[];
  /** Speech to text is there (Qwen3-ASR and its aligner). */
  hearing: boolean;
  downloads: { id: string; file: string; received: number; total: number }[];
  runOn: boolean;
  /** LFM3-VL 2B there, which writes Talk's answers, as bridge 1.9.2+ says (null where the bridge can't say). */
  brain: TalkBrain | null;
  /** Crackio setting LFM3-VL up there for Talk, while it runs and a while after. */
  brainSetup: TalkSetupJob | null;
  /** Not answering now: what it had when it last did (a rented GPU switched off still has its models). */
  away?: { gpu: string | null; models: VoiceModelId[]; at: number };
};

/** LFM3-VL 2B on a machine, for Talk (bridge 1.9.2's /crackio/lfm3/setup). */
export type TalkBrain = {
  /** Its files, and a transformers it runs on in use: Talk can answer from here. */
  ready: boolean;
  /** Both its files are there. */
  files: boolean;
  /** transformers installed there, and whether it's one LFM3-VL runs on (5.21 or newer, under 6). */
  transformers: string | null;
  transformersOk: boolean;
  /** A newer transformers is installed than the one ComfyUI runs: a restart brings it. */
  restart: boolean;
  /** Crackio's fine-tunes there ("chat" makes Talk sound like a person). */
  loras: string[];
  /** Free space where its files go. */
  diskGb: number | null;
};

/**
 * Setting LFM3-VL up on a machine for Talk: its files, transformers, a restart when needed, a hello it must answer; and
 * the fine-tunes asked for (Swap's judge, Retouch's eyes), each checked by answering with it.
 */
export type TalkSetupJob = {
  machine: string;
  label: string;
  /** Crackio's fine-tunes it gets too (one asked for while it runs joins). */
  loras: Lfm3LoraKey[];
  state: "running" | "done" | "error";
  step: "bridge" | "files" | "packages" | "restart" | "check";
  detail: string;
  progress: { received: number; total: number } | null;
  error: string | null;
  /** The hello's answer, and how long it took (its first load included). */
  answer: string | null;
  seconds: number | null;
  startedAt: number;
  finishedAt: number | null;
};

export type VoiceCheck = {
  state: "running" | "switching" | "done" | "error";
  model: string | null;
  seconds: number | null;
  heard: string | null;
  error: string | null;
  build: string | null;
  tried: { build: string | null; error: string }[];
};

/** Setting Voice up on a machine: audio.cpp (the build that runs there), the model and speech to text, a test line. */
export type VoiceSetupJob = {
  machine: string;
  label: string;
  model: VoiceModelId | null;
  state: "running" | "done" | "error";
  step: "engine" | "files" | "check";
  /** What it's doing, in words. */
  detail: string;
  /** What its download step gets, in words ("Drama 3", "speech to text"); empty when there's nothing to get. */
  fetches: string[];
  progress: { received: number; total: number } | null;
  error: string | null;
  /** Builds that didn't run there, on the way. */
  tried: { build: string | null; error: string }[];
  result: { build: string | null; gpu: string | null; model: string | null; seconds: number | null; heard: string | null } | null;
  /** Something it left out, said once it's done (speech to text on a full disk). */
  note: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/** What a Voice take was asked for (Generation.params.voice). */
export type VoiceAsk = {
  model: VoiceModelId;
  /** One voice: its id. A conversation: the cast in order, and its lines. */
  voice?: string;
  cast?: string[];
  lines?: SceneLine[];
  direction: string;
  speed: number;
  /** 0 steady, 1 natural, 2 lively. */
  lively: number;
  language: string;
  seed?: number;
  /** Who speaks, as they looked when it was made (names and orb colours), for pages that don't load the voices. */
  who?: { name: string; hues: [string, string] }[];
  /** "Again, but…": the note, and the take it's another go at. */
  note?: string;
  of?: string;
};

/** What came back with a take (Generation.params.heard). */
export type VoiceHeard = {
  /** Each spoken word and when it's said, in seconds. */
  words: { word: string; start: number; end: number }[];
  /** The waveform, 0–1, for drawing it without loading the file. */
  peaks: number[];
  /** What speech to text heard, and the share of words that didn't match the script. */
  heard?: string;
  missed?: number;
  /** Made a second time because the first skipped words. */
  redone?: boolean;
};
