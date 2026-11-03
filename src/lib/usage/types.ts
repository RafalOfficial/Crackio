/**
 * Settings → Usage (server/usage, /api/settings/usage): what Crackio made, how each take went, where it ran and how long
 * that took. Client-safe.
 *
 * Where each number comes from: counts, outcomes and days from the Library's own record of every take (a take's row goes
 * when the take is deleted); machines and times from each take's recipe (kept since Oct 29, for takes that finished); the
 * comparison with Crackio's estimates from the runs the Local page measures (data/local-speeds.json).
 */

/** The last 7, 30 or 90 days (today included), or everything (null). */
export type UsageDays = 7 | 30 | 90 | null;

export type UsageTotals = {
  /** Every take started in the range, whatever became of it (one still running included). */
  generations: number;
  done: number;
  /** Takes that ended in an error, the ones stopped when Crackio restarted included (`interrupted`). */
  failed: number;
  /** Of `failed`: stopped when Crackio restarted. Not the model's doing, but each had to be run again. */
  interrupted: number;
  /** Stopped by you. */
  cancelled: number;
  /** done ÷ (done + failed), cancelled left out. Null when nothing finished or failed, and for one machine (failures don't say where they ran). */
  firstTry: number | null;
  /** ComfyUI's own working time on every machine, in hours (each graph counted once). */
  gpuHours: number;
  /** Of `gpuHours`: on rented boxes, RunPod Serverless and Comfy Cloud. Work time, not what was billed. */
  rentedHours: number;
  /** Finished takes by what they made: a take of four pictures is one. */
  pictures: number;
  clips: number;
  audio: number;
};

/** One day, local time: finished takes by what they made, and failed ones. */
export type UsageDay = { day: string; pictures: number; clips: number; audio: number; other: number; failed: number };

export type UsageTool = { tool: string; label: string; done: number; failed: number; cancelled: number };

/** One model on one machine. `machine` null: where it ran isn't known (before Oct 29, failed, or not on a ComfyUI). */
export type UsageModel = {
  /** Catalog id ("local:flux3-klein"); "auto" for takes that failed before a model was picked, "unknown" when none was kept. */
  model: string;
  name: string;
  /** The engine's name ("ComfyUI", "Comfy Router", "Grok (removed)"); `engineId` is its id. */
  engine: string;
  engineId: string;
  /** The GPU, short ("RTX 5090", "Apple silicon (Metal)", "Comfy Cloud"). */
  machine: string | null;
  /** Finished takes. */
  runs: number;
  /** ComfyUI's working time per take there, every graph of the take on that machine: the usual (median) and the fastest. */
  medianSeconds: number | null;
  fastestSeconds: number | null;
  /** Median of actual ÷ estimated − 1 for its main graph: 0.12 took 12% longer than Crackio said beforehand, −0.1 was 10% quicker. */
  vsEstimate: number | null;
  /** How many runs `vsEstimate` is from. */
  estimateRuns: number;
  failed: number;
  /** When its latest take there ended (or was started, when it never ended). */
  lastAt: number | null;
};

/** One GPU (every machine with it). */
export type UsageMachine = {
  machine: string;
  gpuHours: number;
  /** Of `gpuHours`: while rented. */
  rentedHours: number;
  /** Finished takes whose main graph ran on it. */
  runs: number;
  /** The machines it was in, as Crackio names them ("This computer", "RTX 5090 · vast.ai", "RunPod Serverless"). */
  where: string[];
};

export type UsageStorage = { kind: "image" | "video" | "audio"; files: number; bytes: number };

export type UsageSummary = {
  range: { days: number | null; from: number; to: number };
  totals: UsageTotals;
  /** Every day of the range, oldest first, empty ones included. */
  days: UsageDay[];
  tools: UsageTool[];
  models: UsageModel[];
  /** Every GPU in the range, whichever machine was asked for: the choices for that filter. */
  machines: UsageMachine[];
  storage: UsageStorage[];
  /** What the numbers can't say, in plain words. */
  notes: string[];
};
