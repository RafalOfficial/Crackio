/**
 * How much work a job is, in the Local page's units: one ~1 MP picture from words, or 5 s of 720p clip. Client-safe: the
 * page, the tools' time line and the engine share it, so what's shown before a run is what the run is measured against.
 */

/**
 * An image model reads each reference picture next to the one it makes, at every step, and its time grows a little faster
 * than the pixels it reads (attention). Measured on a GTX 1060 6GB with FLUX.2 klein 4B, Oct 2026: one 1 MP reference took
 * 2.5× a plain picture and four took 8× (9.4 min); four at 0.25 MP each took what one at 1 MP does. 1.3 fits all three.
 */
export const WORK_POWER = 1.3;

export function pictureWork({ count = 1, megapixels = 1, references = 0, referenceMp = 1 }: { count?: number; megapixels?: number; references?: number; referenceMp?: number }) {
  return Math.max(1, count) * (megapixels + Math.max(0, references) * referenceMp) ** WORK_POWER;
}

/**
 * A ~1 MP picture made 2× (the Upscale tool's default), in a picture upscaler's units: a ×4 model works at 4× whatever's
 * asked (4 times the megapixels in), SeedVR2 restores the 4 MP result. One unit is only a quarter of a megapixel in, so a
 * card that showed a unit's time put Nomos2 HQ at ~65 s where a 1312×736 picture took 4 times that.
 */
export const UPSCALE_PICTURE_WORK = 4;

/**
 * The job the Local page and the model pickers time for a model, in its own units: a ~1 MP picture from words or 5 s of
 * 720p clip (one unit each), and for a picture upscaler a ~1 MP picture made 2× (ComfyUI's template upscalers count
 * pictures, so one).
 */
export function cardWork(model: { tasks: string[]; unit: "image" | "clip"; crackio?: string }) {
  if (!model.tasks.includes("upscale") || model.unit === "clip") return 1;
  return model.crackio?.startsWith("local:tpl:") ? 1 : UPSCALE_PICTURE_WORK;
}

/** That job in words, by the kind of model: "a picture", "a 5 s clip", "a 1 MP picture 2×". */
export const localJob = (kind: string) => (kind === "video" ? "a 5 s clip" : kind === "upscale" ? "a 1 MP picture 2×" : "a picture");

/** What a run's speed is kept under: an edit can run a heavier graph than a picture from words (another template, more steps). */
export type SpeedMode = "t2i" | "edit" | "clip" | "upscale";

/** The kind of job a run is, for its measured speed. */
export const speedModeFor = (output: "image" | "video", kind: string, references: number): SpeedMode =>
  output === "video" ? "clip" : kind === "upscale" ? "upscale" : references > 0 ? "edit" : "t2i";

/** Seconds per unit a model takes on one machine, for the kind of job (see `SpeedMode`). */
export type MeasuredSpeed = {
  /** With the model already loaded (or including loading, when `coldOnly`). */
  seconds: number;
  /** What loading the model adds to a run that finds it unloaded (the first after a restart or another model). */
  load?: number;
  runs: number;
  coldOnly?: boolean;
};

/** A model's measured speeds on one machine: its main job (pictures from words, clips, upscales), edits when they ran, and the version that ran. */
export type ModelSpeeds = MeasuredSpeed & { edit?: MeasuredSpeed; variant?: string };

/**
 * How fast a model's files load the first time (read from disk, then onto the GPU), in GB/s: on rented boxes' NVMe a
 * first run took 1–2 GB/s of its files longer than the next (FLUX.2 klein, FLUX 3 Klein, Z-Image Turbo, Wan 2.2 5B,
 * SeedVR2, Oct 2026); slower disks take longer.
 */
export const LOAD_GB_PER_S = 1.2;

/** A run's seconds from per-unit seconds: the work, plus loading when the model isn't loaded yet. */
export const runSeconds = (s: Pick<MeasuredSpeed, "seconds" | "load">, work: number, cold = false) => s.seconds * work + (cold ? (s.load ?? 0) : 0);
