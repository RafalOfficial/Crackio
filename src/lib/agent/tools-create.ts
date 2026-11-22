import "server-only";
import { z } from "zod";
import { CAST_PREFER, castFits, mentionedHandles } from "@/lib/cast/types";
import { durationTicks, fitDuration, fitResolution, nearestAspect, type AspectChoice, type Caps } from "@/lib/models/caps";
import type { ModelAvailability } from "@/lib/models/catalog";
import { listModels } from "@/lib/models/resolve";
import { allCharacters, characterByHandle } from "@/lib/server/cast-store";
import { aspectById, type AspectId } from "@/lib/shot";
import { fail } from "./errors";
import { startJob } from "./jobs";
import { checkMachine, loraFilesOnMachines } from "./machines";
import { chooseModel, nearest, planJob, requireConfirm } from "./plan";
import { answerJob, aspectIds, aspectNear, confirm, dryAnswer, dryRun, existingKind, fileArg, machineArg, showArg, SIZES, startedView, tool, waitArg, type ToolContext } from "./shared";

/** Pictures and clips from a prompt the agent writes. Crackio sends the words as written: the enhancer is never on. */

export const loras = z.array(z.object({ file: z.string().max(200).describe("A LoRA file name from loras."), strength: z.number().min(-3).max(3).optional() })).max(6).optional().describe("LoRAs on the model (own-GPU models only). Crackio adds their trigger words.");
const seed = z.number().int().min(0).max(2 ** 48).optional();
const negative = z.string().max(2000).optional();

/** The Advanced options a job carries, as the screens send them. */
const tuning = (a: { seed?: number; negative?: string; steps?: number; cfg?: number }) => ({
  ...(a.seed != null ? { seed: a.seed } : {}),
  ...(a.negative ? { negative: a.negative } : {}),
  ...(a.steps != null ? { steps: a.steps } : {}),
  ...(a.cfg != null ? { cfg: a.cfg } : {}),
});

/**
 * quality "best": the model's full version on the machine that takes the job. Refused when only its turbo is there (a
 * fallback to the fast version is never silent); a note when the model has one version, or when the wait shown is the
 * fast version's.
 */
async function fullVersion(model: ModelAvailability, machine: { id: string; name: string } | undefined): Promise<{ full: boolean; note?: string }> {
  const [{ allLocalModels }, { installedFiles }, { comfyTargets, withTarget }] = await Promise.all([import("@/lib/server/local-templates"), import("@/lib/server/local-models"), import("@/lib/server/comfy-targets")]);
  const versions = allLocalModels().find((m) => m.crackio === model.id)?.variants ?? [];
  const turbo = (id: string) => /turbo|lightning|distill/i.test(id);
  if (!versions.some((v) => turbo(v.id)) || !versions.some((v) => !turbo(v.id))) return { full: false, note: `${model.name} has one kind of version: "quality" changes nothing.` };
  const target = machine ? (await comfyTargets()).find((t) => t.id === machine.id) : undefined;
  if (!target) return { full: true };
  const have = await withTarget(target, () => installedFiles()).catch(() => null);
  if (!have) return { full: true };
  const there = versions.filter((v) => v.files.every((f) => have.has(`${f.folder}/${f.name}`)));
  if (!there.some((v) => !turbo(v.id))) {
    throw fail("model_not_installed", {
      what: `${model.name}'s full version isn't on ${machine!.name}: only its fast one is.`,
      do: 'Leave "quality" out to use the fast version, or ask the user whether to set the full one up (Crackio → Settings → Tools, under the model\'s versions).',
    });
  }
  // The fast version comes first when both are there, and the estimate is its.
  return { full: true, ...(there.length && turbo(there[0].id) ? { note: "The wait shown is the fast version's: the full one takes about twice as long." } : {}) };
}

/** A seed of the tool's own when the agent gave none, so every result can be made again. */
const newSeed = () => Math.floor(Math.random() * 2 ** 32);

/** Every @handle in a prompt is a Cast member: a typo would go to the model as plain text. */
function checkHandles(prompt: string) {
  for (const h of mentionedHandles(prompt)) {
    if (characterByHandle(h)) continue;
    throw fail("cast_not_found", { field: "prompt", what: `The prompt names @${h}, and there's no Cast member by that handle.`, did_you_mean: nearest(h, allCharacters().map((c) => ({ id: `@${c.handle}`, name: c.name }))), do: "Fix the handle (cast lists them), or write the name without @ if it isn't a Cast member." });
  }
}

/** Each LoRA is a file on the machine the job runs on: an unknown name, or one on another machine only, is said before the job starts. */
/**
 * A LoRA has to be where the job runs: on that machine already, or one Crackio keeps on this computer (the user's own
 * upload or training result), which the job sends there first. Answers with a note for each that has to travel.
 */
export async function checkLorasOn(machine: string | undefined, given: { file: string }[]): Promise<string[]> {
  if (!given.length) return [];
  const listed = await loraFilesOnMachines();
  const { homeCopy } = await import("@/lib/server/lora-home");
  const notes: string[] = [];
  for (const [i, l] of given.entries()) {
    const on = listed.get(l.file);
    if (!on || (machine && !on.includes(machine))) {
      const copy = await homeCopy(l.file).catch(() => null);
      if (copy) {
        notes.push(`${l.file} (${Math.max(1, Math.round(copy.bytes / 1e6))} MB) is sent from the user's computer to the machine first: the first job with it takes longer.`);
        continue;
      }
    }
    if (!on) throw fail("file_not_found", { field: `loras.${i}.file`, what: `No machine that's online has a LoRA file "${l.file.slice(0, 120)}".`, did_you_mean: nearest(l.file.replace(/\.safetensors$/, ""), [...listed.keys()].map((id) => ({ id }))), do: "Call loras for the model and use a file name from it." });
    if (machine && !on.includes(machine)) throw fail("option_not_supported", { field: `loras.${i}.file`, what: `${l.file} is on machine ${on.join(", ")}, not on ${machine}, where this job would run.`, allowed: on, do: 'Pass "machine" with one that has it, or leave the LoRA out.' });
  }
  // A two-file LoRA given by one file: its other half went on with it (checkLoras), said so the agent knows what ran.
  for (const l of given) {
    const half = ADDED.get(l);
    if (half) notes.push(`${half} is one file of a two-file LoRA: Crackio added its other half, ${l.file}, at the same strength.`);
  }
  // A LoRA that carries notes on how to prompt it, or was trained here (its real captions are known): said where it's used.
  const records = await import("@/lib/server/loras").then((m) => m.loraRecords()).catch(() => null);
  const noted = given.map((l) => l.file).filter((f) => records?.[f]?.notes || records?.[f]?.trained);
  if (noted.length) notes.push(`How to prompt ${noted.join(" and ")}: loras with file (its notes${noted.some((f) => records?.[f]?.trained) ? " and the captions it was trained on" : ""}). Read it once before you judge the results.`);
  // What went wrong in its training explains bad results better than a new prompt: said with the job.
  const { loraWarnings } = await import("@/lib/server/lora-notes");
  for (const f of noted) {
    const rec = records?.[f];
    const first = rec?.trained ? (await loraWarnings(rec).catch(() => []))[0] : undefined;
    if (first) notes.push(`${f}: ${first}`);
  }
  return notes;
}

/** A half Crackio added to a job's LoRAs, and the file it was added for (checkLorasOn says so in the job's notes). */
const ADDED = new WeakMap<object, string>();

/**
 * The LoRAs a job asked for, each with its other half: a Wan 2.2 A14B LoRA is two files (one for the high-noise model,
 * one for the low-noise one), and one alone ran half the LoRA with no error or note (seen Nov 2026).
 */
export async function checkLoras(given: { file: string; strength?: number }[] | undefined, model: ModelAvailability) {
  if (!given?.length) return [];
  if (!model.id.startsWith("local:")) throw fail("option_not_supported", { field: "loras", what: `${model.name} is a hosted model: LoRAs go on models on the user's own GPUs.` });
  const library = await import("@/lib/server/loras").then((m) => m.loraLibrary()).catch(() => null);
  // A LoRA made for another model loads with no error and changes nothing (and its trigger words still go in the
  // prompt): refused here, as the screens only ever offer a model its own. A file Crackio knows nothing of goes through.
  const locals = await import("@/lib/server/local-templates").then((m) => m.allLocalModels()).catch(() => []);
  const local = locals.find((m) => m.crackio === model.id);
  for (const [i, l] of given.entries()) {
    const madeFor = library?.entries.find((e) => e.local?.includes(l.file))?.models ?? library?.records[l.file]?.models;
    if (!local || !madeFor?.length || madeFor.includes(local.id)) continue;
    const names = madeFor.map((id) => locals.find((m) => m.id === id)?.name ?? id).slice(0, 4);
    throw fail("option_not_supported", { field: `loras.${i}.file`, what: `${l.file} is a LoRA for ${names.join(", ")}, not for ${model.name}: it would load and change nothing.`, do: "Call loras with this model to see the LoRAs it takes." });
  }
  const halves = (file: string) => {
    const pick = library?.entries.find((e) => (e.local?.length ?? 0) > 1 && e.local?.includes(file));
    return (pick?.local ?? library?.records[file]?.pair ?? []).filter((f) => f !== file);
  };
  const out: { file: string; strength: number }[] = [];
  for (const l of given) {
    if (out.some((x) => x.file === l.file)) continue;
    out.push({ file: l.file, strength: l.strength ?? 1 });
    for (const other of halves(l.file)) {
      if (given.some((x) => x.file === other) || out.some((x) => x.file === other)) continue;
      const added = { file: other, strength: l.strength ?? 1 };
      ADDED.set(added, l.file);
      out.push(added);
    }
  }
  // A job takes six files (comfy-local `lorasOf`): a seventh would be dropped in silence, and with it half a pair.
  if (out.length > 6) throw fail("option_not_supported", { field: "loras", what: `That's ${out.length} LoRA files, and one job takes six (a two-file LoRA counts as two).`, do: "Use fewer LoRAs." });
  return out;
}

export const makeImage = tool({
  name: "make_image",
  title: "Make pictures",
  description: "Make 1–4 pictures from a prompt you write (Crackio sends it as written). Starts a job and waits a moment for it. Name Cast members as @handle in the prompt.",
  input: z.object({
    prompt: z.string().min(1).max(8000).describe("The full prompt."),
    model: z.string().max(300).optional().describe("Model id (models)."),
    aspect: z.enum(aspectIds).optional().describe("Shape (default 3:2)."),
    size: z.enum(SIZES).optional().describe("Your choice by GPU and wait (dry_run): 2k on a strong GPU, 720p or 1k on a weaker one (then upscale), draft or 720p to compare prompts, 4k rarely. Left out: 1k."),
    quality: z.enum(["fast", "best"]).optional().describe("best: the model's full version, when it's set up, in place of its turbo (finer detail, about twice the time). Own-GPU models."),
    never_enlarge: z.boolean().optional().describe("true: past the largest size the model draws by itself, keep that size (dry_run's size says what you get)."),
    count: z.number().int().min(1).max(4).optional().describe("How many (default 1)."),
    references: z
      .array(
        z.object({
          file: fileArg("Path."),
          role: z.enum(["subject", "product", "place", "style", "edit-target"]).optional().describe("What it's for; edit-target is the picture to change."),
          label: z.string().max(200).optional().describe("What it shows, in a few words."),
        }),
      )
      .max(16)
      .optional()
      .describe('Pictures to work from, called "image 1", "image 2"… in the prompt.'),
    loras,
    machine: machineArg,
    seed,
    negative,
    steps: z.number().int().min(1).max(100).optional(),
    cfg: z.number().min(0).max(30).optional(),
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["references.*.file"],
  async run(args, ctx) {
    await checkMachine(args.machine, ctx.prefs);
    checkHandles(args.prompt);
    const aspect = args.aspect ?? "3:2";
    const count = args.count ?? 1;
    const refs = await Promise.all((args.references ?? []).map(async (r, i) => ({ ...(await existingKind(r.file, `references.${i}.file`, "image")), role: r.role, label: r.label })));
    const model = await chooseModel("image", args.model, ctx.prefs);
    const local = model.id.startsWith("local:");
    if (refs.length > model.maxRefs) {
      throw fail("option_not_supported", { field: "references", what: model.maxRefs ? `${model.name} takes at most ${model.maxRefs} reference picture${model.maxRefs === 1 ? "" : "s"}; you gave ${refs.length}.` : `${model.name} makes pictures from words only: it takes no reference pictures.` });
    }
    const useLoras = await checkLoras(args.loras, model);
    // A hosted model names its sizes its own way ("1K", "2K"): the one that matches, or none when it has no such setting.
    let resolution: string | undefined = args.size ?? "1k";
    const notes: string[] = [];
    if (!local) {
      const choices = model.caps?.resolution?.choices ?? [];
      const match = choices.find((c) => String(c.value).toLowerCase() === resolution!.toLowerCase() || c.label.toLowerCase() === resolution!.toLowerCase());
      if (match) resolution = String(match.value);
      else if (args.size && choices.length) throw fail("option_not_supported", { field: "size", what: `${model.name} doesn't make "${args.size}".`, allowed: choices.map((c) => String(c.value).toLowerCase()) });
      else {
        if (args.size) notes.push(`${model.name} has one size of its own: "size" was left out.`);
        resolution = undefined;
      }
    }
    const a = aspectById(aspect);
    const keep = Boolean(args.never_enlarge && local);
    const plan = await planJob(model, { kind: "image", aspect, count, references: refs.length, resolution, ratio: a.w / a.h, machine: args.machine, ...(keep ? { nativeOnly: true } : {}) }, ctx.prefs);
    notes.push(...(await checkLorasOn(plan.machine?.id, useLoras)));
    // The largest size a model draws by itself depends on the machine's pace when the job runs: the plan said
    // 2752×1552 and the picture came out 2816×1584. The plan says "about"; the result carries the exact size.
    if (keep && plan.size && !/drawn at/.test(plan.size)) plan.size = `about ${plan.size}: the largest this model draws by itself here (the result says the exact size)`;
    const best = args.quality === "best" && local ? await fullVersion(model, plan.machine) : null;
    if (best?.note) notes.push(best.note);
    if (!local && (args.quality || args.never_enlarge)) notes.push(`${model.name} is a hosted model: ${[args.quality ? '"quality"' : "", args.never_enlarge ? '"never_enlarge"' : ""].filter(Boolean).join(" and ")} was left out.`);
    if (notes.length) plan.notes = notes;
    const seedUsed = args.seed ?? (local ? newSeed() : undefined);
    if (args.dry_run) return dryAnswer(plan);
    requireConfirm("make_image", args, plan);
    const gen = await startJob(
      {
        tool: "image",
        prompt: args.prompt,
        aspect,
        count,
        model: model.id,
        references: refs.map((r) => ({ url: r.url, role: r.role ?? "subject", ...(r.label ? { label: r.label } : {}) })),
        params: { kind: "image", options: { ...(resolution ? { resolution } : {}), ...(plan.machine ? { machine: plan.machine.id } : {}), ...(useLoras.length ? { loras: useLoras } : {}), ...(best?.full ? { quality: "best" } : {}), ...(keep ? { nativeOnly: true } : {}), ...tuning({ ...args, seed: seedUsed }) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(gen.id, plan), ...(notes.length ? { notes } : {}) });
  },
});

/* ------------------------------------------------------------------ clips */

const shapesOf = (caps: Caps | null | undefined): AspectChoice[] => caps?.aspect?.choices ?? caps?.size?.presets ?? [];

/** The image model that draws a clip's first frame with its Cast, among those the user lets agents use; null when none can. */
export async function castFrameModel(ctx: Pick<ToolContext, "prefs">): Promise<string | null> {
  const models = (await listModels()).filter((m) => m.kind === "image" && m.available && castFits(m) && (ctx.prefs.spend !== "free" || m.id.startsWith("local:")));
  const local = models.filter((m) => m.id.startsWith("local:"));
  return CAST_PREFER.map((id) => local.find((m) => m.id === id)).find(Boolean)?.id ?? local[0]?.id ?? models[0]?.id ?? null;
}

export const makeVideo = tool({
  name: "make_video",
  title: "Make a clip",
  description: "Make a clip from a prompt you write, from words alone or from a first frame (and a last one, where the model takes it). Say what moves and how the camera moves. Starts a job; clips take minutes, so dry_run first.",
  input: z.object({
    prompt: z.string().min(1).max(8000).describe("The full prompt: the action, the camera move, the pace, how it ends."),
    model: z.string().max(300).optional().describe("Model id (models)."),
    start: fileArg("First frame: a picture path.").optional(),
    end: fileArg("Last frame: a picture path (needs start).").optional(),
    references: z.array(z.object({ file: fileArg("Path."), label: z.string().max(200).optional().describe("Who or what it shows.") })).max(8).optional().describe("Pictures of who and what the clip shows, for models that take them."),
    aspect: z.string().max(20).optional().describe("Shape: 16:9, 9:16, 1:1, 4:5, 2:3, 3:2, 21:9, or one the model names itself (models lists them: 4:3, 3:4). Default: the first frame's, else 16:9."),
    seconds: z.number().min(1).max(60).optional().describe("Length. Default: the model's usual. models lists what each takes."),
    size: z.string().max(20).optional().describe('Resolution as the model names it ("720p", "1080p"). Default: the model\'s usual.'),
    sound: z.boolean().optional().describe("Make sound too, where the model can."),
    loras,
    machine: machineArg,
    seed,
    negative,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["start", "end", "references.*.file"],
  async run(args, ctx) {
    await checkMachine(args.machine, ctx.prefs);
    checkHandles(args.prompt);
    const [start, end] = await Promise.all([args.start ? existingKind(args.start, "start", "image") : null, args.end ? existingKind(args.end, "end", "image") : null]);
    const refs = await Promise.all((args.references ?? []).map(async (r, i) => ({ ...(await existingKind(r.file, `references.${i}.file`, "image")), label: r.label })));
    const model = await chooseModel("video", args.model, ctx.prefs);
    const caps = model.caps ?? null;
    const local = model.id.startsWith("local:");
    const notes: string[] = [];

    // What this model takes, checked before anything runs: the screens hide what it can't do, an agent has to be told.
    const takesStart = Boolean(caps?.image || caps?.keyframes || !caps);
    if (start && !takesStart) throw fail("option_not_supported", { field: "start", what: `${model.name} makes clips from words only: it takes no first frame.` });
    if (!start && caps?.image?.required) throw fail("invalid_input", { field: "start", what: `${model.name} needs a first frame.`, do: "Make one with make_image (or pass a picture) and give it as start." });
    if (end && !start) throw fail("invalid_input", { field: "end", what: "A last frame needs a first frame too." });
    if (end && !caps?.end && !caps?.keyframes) throw fail("option_not_supported", { field: "end", what: `${model.name} takes no last frame.` });
    const refsMax = caps?.refs?.max ?? 0;
    if (refs.length > refsMax) throw fail("option_not_supported", { field: "references", what: refsMax ? `${model.name} takes at most ${refsMax} reference picture${refsMax === 1 ? "" : "s"}.` : `${model.name} takes no reference pictures beside the frames.` });
    if (args.sound && !caps?.audio) throw fail("option_not_supported", { field: "sound", what: `${model.name} makes no sound.` });
    const useLoras = await checkLoras(args.loras, model);

    let duration: number | "auto" | undefined;
    if (caps?.duration) {
      const ticks = durationTicks(caps.duration);
      if (args.seconds != null && !ticks.seconds.includes(Math.round(args.seconds))) {
        throw fail("option_not_supported", { field: "seconds", what: `${model.name} doesn't make ${args.seconds} s clips.`, allowed: ticks.seconds.length > 12 ? [`${ticks.min} to ${ticks.max}`] : ticks.seconds });
      }
      duration = fitDuration(caps.duration, args.seconds);
    } else if (args.seconds != null) notes.push(`${model.name} has one length of its own: "seconds" was left out.`);

    let resolution: string | undefined;
    const sizes = caps?.resolution?.choices ?? [];
    if (sizes.length) {
      if (args.size) {
        const exact = sizes.find((c) => String(c.value).toLowerCase() === args.size!.toLowerCase() || c.label.toLowerCase() === args.size!.toLowerCase());
        if (!exact) throw fail("option_not_supported", { field: "size", what: `${model.name} doesn't make "${args.size}".`, allowed: sizes.map((c) => String(c.value)) });
        resolution = String(exact.value);
      } else {
        const usual = fitResolution(sizes, undefined, caps?.resolution?.default ?? null);
        if (usual != null) resolution = String(usual);
      }
    } else if (args.size) notes.push(`${model.name} has one size of its own: "size" was left out.`);

    // Until a shape is picked, a clip keeps its first frame's; a shape that differs from the frame's crops the frames to it.
    const startRatio = start?.info.width && start.info.height ? start.info.width / start.info.height : null;
    // One of Crackio's own shapes, or one the model names itself ("4:3", "3:4", "2:1": LTX-2.5 and others offer shapes
    // Crackio's list of seven doesn't have, and an agent asking for one was refused).
    const own = shapesOf(caps).filter((s) => s.ratio !== null);
    const ours = (aspectIds as readonly string[]).includes(args.aspect ?? "");
    const named = args.aspect && !ours ? own.find((s) => String(s.value) === args.aspect || s.label === args.aspect) : undefined;
    if (args.aspect && !ours && !named) throw fail("option_not_supported", { field: "aspect", what: `${model.name} doesn't make "${args.aspect.slice(0, 20)}".`, allowed: [...new Set([...own.map((s) => String(s.value)), ...aspectIds])] });
    const asked = named?.ratio ?? (args.aspect ? aspectById(args.aspect).w / aspectById(args.aspect).h : null);
    const ratio = asked ?? startRatio ?? 16 / 9;
    const aspect: AspectId = named ? aspectNear(ratio) : ((args.aspect as AspectId | undefined) ?? (startRatio ? aspectNear(startRatio) : "16:9"));
    // The model's own value for the shape asked, when it has one near it. One it has none for: an own-GPU model is sized
    // from the shape itself (LTX-2.5 draws 3:2 or 4:5 too; one with two shapes takes the nearer), a hosted one takes its
    // nearest value, which is said, since the clip then isn't the shape asked.
    const near = nearestAspect(own, ratio);
    const fits = Boolean(near?.ratio && Math.abs(Math.log(near.ratio / ratio)) <= 0.06);
    const shape = named ?? (fits || !local ? near : null);
    if (args.aspect && !named && near && !fits) notes.push(local ? `${model.name} offers ${own.map((s) => String(s.value)).join(", ")}: check the clip's size, it may not be ${args.aspect}.` : `${model.name} makes ${own.map((s) => String(s.value)).join(", ")}: this clip is ${String(near.value)}, not ${args.aspect}.`);
    const cropping =Boolean(asked && startRatio && Math.abs(Math.log(asked / startRatio)) > 0.03);
    if (cropping) notes.push(`The first frame is cropped to ${args.aspect}. Leave "aspect" out to keep the frame's own shape.`);

    const plan = await planJob(model, { kind: "video", aspect, count: 1, references: refs.length + (start ? 1 : 0) + (end ? 1 : 0), resolution, ratio, duration: typeof duration === "number" ? duration : undefined, machine: args.machine, sound: args.sound, start: Boolean(start), end: Boolean(end) }, ctx.prefs);
    notes.push(...(await checkLorasOn(plan.machine?.id, useLoras)));
    const seedUsed = args.seed ?? (local ? newSeed() : undefined);

    // Cast in a clip with no first frame: Crackio draws one with them first, on an image model. Which one is said here, so
    // it's never a paid one the user didn't allow; with none to use, the cast goes in as the clip model takes them.
    const cast: Record<string, unknown> = {};
    if (mentionedHandles(args.prompt).length && !start) {
      const frame = await castFrameModel(ctx);
      if (frame) {
        cast.frameModel = frame;
        notes.push(`The prompt names Cast and there's no first frame: Crackio draws one with them first (on ${frame}), then animates it. That adds a picture's time. To choose the frame yourself, make it with make_image and pass it as start.`);
      }
      else {
        cast.castFrame = false;
        notes.push("No image model the user allows can draw a first frame with the Cast: they go in as reference pictures or words. Make a first frame with make_image and pass it as start for a closer likeness.");
      }
    }
    if (notes.length) plan.notes = notes;
    if (args.dry_run) return dryAnswer(plan, { ...(duration != null ? { clip_seconds: duration } : {}), ...(resolution ? { clip_size: resolution } : {}), shape: named ? String(named.value) : aspect });
    requireConfirm("make_video", args, plan);

    const gen = await startJob(
      {
        tool: "video",
        prompt: args.prompt,
        aspect,
        count: 1,
        model: model.id,
        references: [...(start ? [{ url: start.url, label: "the start frame", role: "subject" as const }] : []), ...(end ? [{ url: end.url, label: "the end frame", role: "subject" as const }] : [])],
        params: {
          kind: "video",
          options: {
            ...(duration != null ? { duration } : {}),
            ...(resolution ? { resolution } : {}),
            ...(caps?.audio && args.sound != null ? { sound: args.sound } : {}),
            ...(shape ? { aspectValue: shape.value } : {}),
            ...(cropping ? { cropFrames: true } : {}),
            ...(local && plan.machine ? { machine: plan.machine.id } : {}),
            ...(useLoras.length ? { loras: useLoras } : {}),
            ...tuning({ ...args, seed: seedUsed }),
          },
          ...(start ? { startUrl: start.url } : {}),
          ...(end ? { endUrl: end.url } : {}),
          ...(refs.length ? { refs: refs.map((r) => ({ url: r.url, ...(r.label ? { label: r.label } : {}) })) } : {}),
          ...cast,
        },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(gen.id, plan), ...(notes.length ? { notes } : {}) });
  },
});
