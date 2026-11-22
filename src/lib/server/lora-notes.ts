import "server-only";
import type { LoraRecord } from "@/lib/local/loras";
import type { TrainJob } from "@/lib/train/types";
import { changeRecord } from "./loras";

/**
 * What the next agent (or person) needs to prompt a LoRA well, kept with the LoRA itself: notes someone wrote after
 * testing it, and what Train knows about one it made without anyone writing it down, including how its training went.
 *
 * Why: an agent that helped train a LoRA prompts it well because it wrote the captions and saw sixty test pictures. A
 * new conversation knew the file name, the trigger and the strength, and made the same mistakes again. And a LoRA that
 * trained without captions (a text model didn't answer) was found out only by reading the server's log: a day lost on
 * a version that could never follow a prompt.
 */

export const NOTES_MAX = 4000;

/** What Train knows about a LoRA it made. */
export type LoraTrained = {
  /** The Train page's name for it. */
  name: string;
  made_for: string;
  /** What went wrong or was left out, in plain lines: read these first. */
  warnings?: string[];
  /** The model it was trained on, and which weights. */
  base: string;
  pictures: number;
  /** The longest side the pictures were trained at, in pixels. */
  trained_at_px: number;
  rank: number;
  /** The step this file is from, and how many the run trained in all. */
  version_step: number;
  steps: number;
  trigger?: string;
  /** An edit LoRA's instruction: what you type to get the change. */
  instruction?: string;
  /** How its pictures were described: how many had a caption of their own, who wrote them, and three real ones. */
  captions?: { with_one: number; of: number; written_by: Record<string, number>; samples: string[] };
  /** Every version it saved: the loss there, and how many test pictures were drawn with it. */
  versions: { step: number; loss: number | null; test_pictures: number; kept?: true }[];
  /** What its test pictures were asked for. */
  test_prompts: string[];
  /** What Crackio corrected or fell back to during the run, in its own words. */
  run_notes?: string[];
};

const used = (job: TrainJob) => job.images.filter((i) => !i.skip && !i.waiting && (job.goal !== "edit" || Boolean(i.source)));

/**
 * What went wrong or was left out in a training, in plain lines ("Trained WITHOUT captions…"). The same lines for the
 * MCP's list, one LoRA's detail and a job that uses the LoRA.
 */
export function trainingWarnings(job: TrainJob, bare: string): string[] {
  const out: string[] = [];
  const set = used(job);
  if (job.goal !== "edit" && set.length) {
    const none = set.filter((i) => !i.caption?.trim()).length;
    const chosen = job.settings.captions !== "auto" ? " (the user chose to train that way)" : "";
    if (none === set.length) {
      out.push(`Trained WITHOUT captions${chosen}: all ${set.length} pictures went in with only "${bare}". A LoRA trained this way can't tell its subject from the poses and backgrounds, so it tends to repeat its training pictures and follow prompts poorly. Retraining with captions is the fix.`);
    } else if (none) out.push(`${none} of ${set.length} pictures trained without a caption of their own${chosen}, with only "${bare}".`);
  }
  if (job.settings.previews && job.checkpoints.length && !job.checkpoints.some((k) => k.previews?.length)) out.push(`No test pictures were drawn during training${job.run?.noPreviews ? ` (${job.run.noPreviews})` : ""}: nobody has seen what its versions do.`);
  if (job.result?.works === false) out.push("Its test pictures looked the same with and without it: it may load and change nothing.");
  return out;
}

/** A trained LoRA's Train job; null for one that wasn't trained here (or whose job is gone). */
async function jobOf(record: Pick<LoraRecord, "trained">): Promise<TrainJob | null> {
  if (!record.trained) return null;
  const { getJob } = await import("./train/store");
  return getJob(record.trained).catch(() => null);
}

/** Only the warnings of a trained LoRA (the list, and a job that uses it): empty when all went well or it wasn't trained here. */
export async function loraWarnings(record: Pick<LoraRecord, "trained">): Promise<string[]> {
  const job = await jobOf(record);
  if (!job) return [];
  const { captionFor } = await import("@/lib/train/plan");
  return trainingWarnings(job, captionFor(job, {}));
}

/** A trained LoRA's facts, from its Train job; null for one that wasn't trained here (or whose job is gone). */
export async function loraTrained(record: Pick<LoraRecord, "trained" | "step">): Promise<LoraTrained | null> {
  const job = await jobOf(record);
  if (!job) return null;
  const [{ profileById }, { captionFor, testPrompts }] = await Promise.all([import("@/lib/train/profiles"), import("@/lib/train/plan")]);
  const set = used(job);
  const own = set.filter((i) => i.caption?.trim());
  const worded = [...new Set(own.map((i) => captionFor(job, i)).filter(Boolean))];
  // Spread over the set: the first, the middle and the last differ more than three in a row.
  const samples = worded.length <= 3 ? worded : [worded[0], worded[Math.floor(worded.length / 2)], worded[worded.length - 1]];
  const writers: Record<string, number> = {};
  for (const i of own) {
    // (Which text model wrote Crackio's captions isn't kept for runs before this was added.)
    const who = i.captionBy === "you" ? "by hand" : i.captionModel ? `Crackio (${i.captionModel})` : "Crackio's captioner";
    writers[who] = (writers[who] ?? 0) + 1;
  }
  const profile = job.base?.kind === "catalog" ? profileById(job.base.family) : undefined;
  const base = job.base?.kind === "custom" ? job.base.file : (profile?.name ?? job.base?.family ?? "unknown");
  const weights = profile?.weights.find((w) => w.id === job.run?.weights)?.label;
  const version = record.step ?? job.result?.step ?? job.progress.step;
  const warnings = trainingWarnings(job, captionFor(job, {}));
  return {
    name: job.name,
    made_for: { person: "a person", character: "a character", object: "an object", style: "a style", edit: "an edit (before and after pairs)" }[job.goal],
    ...(warnings.length ? { warnings } : {}),
    base: weights ? `${base} (${weights} weights)` : base,
    pictures: set.length,
    trained_at_px: job.settings.resolution,
    rank: job.settings.rank,
    version_step: version,
    steps: job.progress.step || job.settings.steps,
    ...(job.trigger ? { trigger: job.trigger } : {}),
    ...(job.goal === "edit" && job.instruction ? { instruction: job.instruction } : {}),
    ...(job.goal === "edit" ? {} : { captions: { with_one: own.length, of: set.length, written_by: writers, samples: samples.map((c) => c.slice(0, 400)) } }),
    versions: job.checkpoints.map((k) => ({ step: k.step, loss: k.loss == null ? null : Math.round(k.loss * 1000) / 1000, test_pictures: k.previews?.length ?? 0, ...(k.step === version ? { kept: true as const } : {}) })),
    test_prompts: job.goal === "edit" ? [] : testPrompts(job).slice(0, 2),
    ...(job.heals.length ? { run_notes: job.heals.slice(-12).map((h) => h.what.slice(0, 240)) } : {}),
  };
}

/** A LoRA's notes written (an empty text takes them away). Null: Crackio has no record of that file. */
export function setLoraNotes(file: string, text: string, by: string): Promise<LoraRecord | null> {
  const clean = text.replace(/\r\n/g, "\n").trim().slice(0, NOTES_MAX);
  return changeRecord(file, (r) => {
    if (clean) r.notes = { text: clean, by: by.slice(0, 60), at: new Date().toISOString() };
    else delete r.notes;
  });
}
