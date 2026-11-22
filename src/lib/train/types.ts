/**
 * Train: a LoRA of your own from a set of pictures, trained on one of your GPUs and kept for every tool to use.
 * These shapes are shared by the page and the server (server/train). Client-safe.
 *
 * A job is one LoRA: its pictures, what they teach, the model it's for, the machine it trains on, its settings (Crackio's
 * picks until you change one), and how its training went. Jobs live in data/training/<id>/ (job.json, the pictures, the
 * log, preview pictures and a copy of the finished LoRA).
 */

/**
 * What the pictures teach: one person, one character or animal, one thing, a look, or a change ("edit": pairs of
 * pictures, each the same picture before and after the change, for a LoRA that makes that change to a picture you give it).
 */
export type TrainGoal = "person" | "character" | "object" | "style" | "edit";

/** One picture of the set, as Crackio keeps it (turned upright, JPEG, at most 2048 px on its long side). */
export type TrainImage = {
  id: string;
  /** The file's name when you added it. */
  name: string;
  /** Its file in the job's images folder. */
  file: string;
  width: number;
  height: number;
  bytes: number;
  /** A fingerprint of how it looks, to spot the same picture added twice. */
  hash: string;
  /** Words for this picture: yours, or Crackio's. Empty: the job's caption rule writes one. */
  caption?: string;
  captionBy?: "you" | "crackio";
  /** The text model that wrote Crackio's caption ("Gemini 3.5 Flash", "Qwen3-VL 8B"), for runs since this was kept. */
  captionModel?: string;
  /** Left out of training (a double, or too small to learn from), with why. */
  skip?: string;
  /**
   * An edit LoRA's pair: the picture before the change (this picture is the one after it). Kept like the pictures
   * themselves (upright, JPEG, at most 2048 px) in the job's images folder.
   */
  source?: { file: string; name: string; width: number; height: number };
  /** A "before" picture with no "after" picture yet: it trains nothing, and is what the test pictures redo. */
  waiting?: boolean;
};

/** How pictures get their words. */
export type CaptionMode =
  /** Crackio looks at each picture and writes what's around the subject (needs a text model that sees pictures). */
  | "auto"
  /** Every picture gets the same short line with the trigger word. */
  | "trigger";

/**
 * A training run's settings. Each has Crackio's pick for this set, model and machine (train/plan `planFor`); `auto`
 * says which are still Crackio's. A pick follows the set as it grows; one you set stays put.
 */
export type TrainSettings = {
  /** How many times the model is shown a picture and corrected. */
  steps: number;
  /** How much the LoRA can hold (its rank): more room learns more detail, and more of the set's quirks. */
  rank: number;
  /** How hard each correction pushes (the learning rate). */
  lr: number;
  /** The longest side pictures are trained at, in pixels (each keeps its own shape). */
  resolution: number;
  /** How many versions are saved along the way, the last one included. */
  checkpoints: number;
  /** Draw test pictures with each saved version. */
  previews: boolean;
  captions: CaptionMode;
  /** Show the model a picture without its words now and then (in percent), so it leans on the trigger less blindly. */
  captionDropout: number;
  /** Keep most of the model in RAM and stream it to the GPU: fits smaller cards, slower. */
  offload: boolean;
  /** The same number gives the same run. */
  seed: number;
};

export type SettingKey = keyof TrainSettings;

/** The model a LoRA is trained on. */
export type TrainBase =
  /** One of Crackio's models (its catalog id), on the files of one of its versions. */
  | { kind: "catalog"; family: string }
  /** A model file of yours in the machine's models/diffusion_models or models/checkpoints. */
  | { kind: "custom"; family: string; folder: "diffusion_models" | "checkpoints"; file: string };

export type TrainState =
  /** Being put together: nothing runs. */
  | "draft"
  /** Waiting for the machine (another LoRA is training there). */
  | "queued"
  /** Getting the machine ready: its helper, the model's files. */
  | "starting"
  /** Writing captions and sending the pictures. */
  | "uploading"
  /** The machine is turning the pictures into what the model learns from. */
  | "preparing"
  | "training"
  /** Drawing test pictures with a saved version. */
  | "previewing"
  /** Bringing the finished LoRA home and adding it to the model's LoRAs. */
  | "saving"
  | "paused"
  | "done"
  | "error";

export const ACTIVE_STATES: TrainState[] = ["queued", "starting", "uploading", "preparing", "training", "previewing", "saving"];
export const isActive = (s: TrainState) => ACTIVE_STATES.includes(s);

/** A version saved along the way: a LoRA file on the machine, and the test pictures drawn with it. */
export type TrainCheckpoint = {
  step: number;
  file: string;
  bytes: number;
  /** The smoothed loss when it was saved. */
  loss: number | null;
  /** Test pictures drawn with it (addresses under /api/train/<id>/file/…), in the order of the job's test prompts. */
  previews?: string[];
  /** A copy of it is in Crackio's own folder on this computer (false: that copy is behind the one on the machine). */
  home?: boolean;
};

/** Something Crackio fixed by itself, in words, so nothing happens behind your back. */
export type TrainHeal = { at: number; what: string };

export type TrainProgress = {
  step: number;
  steps: number;
  /** Smoothed loss, and its history as [step, loss] pairs (thinned to a few hundred). */
  loss: number | null;
  losses: [number, number][];
  /** Seconds a step takes, measured. */
  pace: number | null;
  /** GPU memory in use at its highest, in GB. */
  peakGb: number | null;
  /** GPU memory other programs held when the last stretch began (a game, a 3D app, a browser), in GB. */
  othersGb?: number | null;
  /** What's happening right now, in words. */
  stage: string;
  /** Something to know while it runs (the rented GPU's credit won't last the run). */
  notice?: string | null;
  /** 0–1 of the current stage when it isn't the training itself (downloads, uploads, preparing pictures). */
  share: number | null;
  startedAt: number | null;
  /** When training itself began (the first step), for the time left. */
  trainingAt: number | null;
  finishedAt: number | null;
  /** Seconds spent training so far, over every segment. */
  trainedSeconds: number;
  /**
   * The time it has run for, without the hours it sat paused or stopped: the stretches that are over (`ranMs`) and when
   * the one going on began (`runningSince`, null between them). What "Took" and its cost are counted from.
   */
  ranMs?: number;
  runningSince?: number | null;
};

export type TrainResult = {
  /** The LoRA's file name in models/loras. */
  file: string;
  bytes: number;
  /** The step it was taken at (a run stopped early, or an earlier version picked). */
  step: number;
  /** A copy is kept in Crackio's own folder. */
  kept: boolean;
  /** Machines (target ids) that have it in their models/loras. */
  on: string[];
  /** Whether the test pictures with it differ from the ones without it (false: it loads but changes nothing). */
  works?: boolean | null;
};

export type TrainJob = {
  id: string;
  /** Your name for it ("Lena", "Clay look"). */
  name: string;
  goal: TrainGoal;
  /** The word that calls it in a prompt; Crackio adds it for you when the LoRA is on. */
  trigger: string;
  /** What it is in a word or two ("woman", "corgi", "sneaker"): goes beside the trigger in captions. Not for styles. */
  noun: string;
  /**
   * An edit LoRA: the change in words, as you'd ask for it ("turn it into a clay figure"). Every pair trains with it,
   * unless a pair has words of its own, and it's what you type to get the edit afterwards.
   */
  instruction?: string;
  base: TrainBase | null;
  /** The machine it trains on (a ComfyUI target id). */
  machine: string | null;
  images: TrainImage[];
  settings: TrainSettings;
  /** The settings that are still Crackio's picks. */
  auto: SettingKey[];
  /** What the test pictures show (the trigger is added); empty: Crackio's for this goal. */
  testPrompts: string[];
  state: TrainState;
  progress: TrainProgress;
  checkpoints: TrainCheckpoint[];
  /** Test pictures drawn without the LoRA, to compare (same prompts, same seeds). */
  baseline?: string[];
  result: TrainResult | null;
  heals: TrainHeal[];
  error: { message: string; hint?: string; code?: string } | null;
  /** What was planned when it started: the estimate, to say afterwards how it did. */
  planned?: { seconds: number; machine: string; gpu: string | null; pricePerHour: number | null };
  /** The server's own notes on where a run stands on the machine, so it's picked up again after Crackio restarts. */
  run?: TrainRun;
  createdAt: number;
  updatedAt: number;
};

export type TrainRun = {
  /** The ComfyUI job in progress there, and what it is. */
  promptId?: string;
  kind?: "prepare" | "train" | "final";
  /** What the pictures on the machine were prepared for (model, size, words): a change prepares them again. */
  prepared?: string;
  /** The weights it trains on there (a family has several). */
  weights?: string;
  /** After a loss that stopped being a number: every correction scaled by this. */
  lrScale?: number;
  /** The next stretch starts over (the kept state no longer fits the settings). */
  fresh?: boolean;
  /** How often each kind of failure was answered, so none is answered forever. */
  tried?: Record<string, number>;
  /** Said once: why there are no test pictures. */
  noPreviews?: string;
  /**
   * A copy of what the run carries on from (its state, about a gigabyte) kept on this computer, and the step it's from:
   * with it the run can carry on on another machine, or outlive a rented one that won't start again.
   */
  home?: { step: number; bytes: number };
  /** Asked to move: the machine it carries on on next (the state comes home from the old one first). */
  moveTo?: string;
  /** Moved: the copy at home goes to the machine before the next stretch. */
  carry?: boolean;
  /** The last of the trainer's log lines taken into the job's log (its own count), so a run picked up again repeats none. */
  logSeq?: number;
  /** When Start (or Carry on, Try again) was last pressed: runs take a machine in this order. */
  askedAt?: number;
  /** Seconds a step was expected to take on this machine, and whether one far slower than that was said. */
  expectPace?: number;
  /** Where that expectation is from: a run on this very card, or one carried over from another card's. */
  expectFrom?: "measured" | "scaled" | "table";
  slowSaid?: boolean;
  /**
   * Asked to pause (or to finish with what's trained), not there yet. Kept here, not only in memory: a pause on its way
   * when Crackio restarted was forgotten, and the run it picked up trained on, on a GPU you meant to stop paying for.
   */
  pausing?: "pause" | "finish";
};

/** A job in the list: enough to draw its row. */
export type TrainSummary = Pick<TrainJob, "id" | "name" | "goal" | "state" | "createdAt" | "updatedAt"> & {
  images: number;
  cover: string | null;
  family: string | null;
  step: number;
  steps: number;
  done: boolean;
};

/** A log line: its number (they only grow) and its text. */
export type LogLine = [number, string];
