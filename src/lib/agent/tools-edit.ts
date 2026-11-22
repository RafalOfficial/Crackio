import "server-only";
import { z } from "zod";
import { anglePrompt, angleSummary, isOriginal } from "@/lib/angles/prompt";
import { angleBase, angleFacts, orbitFor, provisionalPlace, resolveShot, type AngleView } from "@/lib/angles/rig";
import { LIGHT_SETUPS, MOODS } from "@/lib/director/vocab";
import { CLIP_TARGETS, UPSCALERS, upscaledSize } from "@/lib/local/upscalers";
import type { ModelAvailability } from "@/lib/models/catalog";
import { describeLight, relightPrompt, type Light } from "@/lib/relight";
import { fail } from "./errors";
import { startJob } from "./jobs";
import { checkMachine } from "./machines";
import { chooseModel, planJob, requireConfirm } from "./plan";
import { answerJob, aspectNear, confirm, dryAnswer, dryRun, existing, existingKind, fileArg, machineArg, showArg, SIZES, startedView, tool, waitArg } from "./shared";

/** The tools that change a picture or a clip the user already has: Relight and Upscale (Retouch, Angles and Swap live beside them). */

/** An edit needs an image model that takes the picture to change. */
export const EDITS = { fits: (m: ModelAvailability) => (m.caps ? Boolean(m.caps.image || m.caps.refs) : m.maxRefs > 0), what: "makes pictures from words only: it can't change a picture", prefer: ["local:flux3-klein", "local:flux2-klein-4b"] };

const setupIds = LIGHT_SETUPS.map((s) => s.id) as [string, ...string[]];
const moodIds = MOODS.map((m) => m.id) as [string, ...string[]];

export const relight = tool({
  name: "relight",
  title: "Relight a picture",
  description: "Change only the light in a picture: its direction, height, softness, colour and mood. Everything else stays. Starts a job.",
  input: z.object({
    file: fileArg("The picture."),
    setup: z.enum(setupIds).optional().describe("Sets direction and height."),
    direction: z.number().min(-180).max(180).optional().describe("Where the light comes from, in degrees round the subject: 0 the camera, 90 right, -90 left, 180 behind."),
    height: z.number().min(-20).max(85).optional().describe("Degrees above the subject (below 0: from underneath)."),
    softness: z.number().min(0).max(1).optional().describe("0 hard shadows, 1 very soft."),
    kelvin: z.number().min(1800).max(10000).optional().describe("Colour temperature, 1800 (candle) to 10000 (blue)."),
    mood: z.enum(moodIds).optional(),
    background: z.boolean().optional().describe("false: the background's light stays."),
    model: z.string().max(300).optional().describe("Model id (models)."),
    size: z.enum(SIZES).optional(),
    count: z.number().int().min(1).max(4).optional(),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["file"],
  async run(args, ctx) {
    await checkMachine(args.machine, ctx.prefs);
    const src = await existingKind(args.file, "file", "image");
    const preset = LIGHT_SETUPS.find((s) => s.id === args.setup);
    const mood = MOODS.find((m) => m.id === args.mood);
    const light: Light = {
      azimuth: args.direction ?? preset?.offset ?? 55,
      elevation: args.height ?? preset?.elevation ?? 40,
      softness: args.softness ?? mood?.softness ?? 0.3,
      kelvin: args.kelvin ?? mood?.kelvin ?? 3400,
      mood: mood?.id ?? null,
      background: args.background ?? true,
    };
    const model = await chooseModel("image", args.model, ctx.prefs, EDITS);
    const ratio = src.info.width && src.info.height ? src.info.width / src.info.height : 1;
    const aspect = aspectNear(ratio);
    const count = args.count ?? 1;
    const local = model.id.startsWith("local:");
    const plan = await planJob(model, { kind: "image", aspect, count, references: 1, resolution: local ? (args.size ?? "1k") : undefined, ratio, machine: args.machine }, ctx.prefs);
    const light_in_words = describeLight(light);
    if (args.dry_run) return dryAnswer(plan, { light: light_in_words });
    requireConfirm("relight", args, plan);
    const gen = await startJob(
      {
        tool: "relight",
        prompt: `Relight · ${light_in_words.split(";")[0]}`,
        compiledPrompt: relightPrompt(light),
        aspect,
        count,
        model: model.id,
        references: [{ url: src.url, label: "the original image", role: "edit-target" }],
        params: { kind: "image", sourceUrl: src.url, light, options: { ...(local ? { resolution: args.size ?? "1k" } : {}), ...(plan.machine ? { machine: plan.machine.id } : {}) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(gen.id, plan), light: light_in_words });
  },
});

/* ------------------------------------------------------------------ upscale */

const clipTargets = CLIP_TARGETS.map((t) => t.value) as [string, ...string[]];
const clipUpscalers = new Set(UPSCALERS.filter((u) => u.video).map((u) => u.id));

export const upscale = tool({
  name: "upscale",
  title: "Upscale",
  description: "Make a picture 2× or 4× larger, or a clip 1080p, 2K or 4K. The result is not shown to you (a small preview says nothing about it): give the user its file.",
  input: z.object({
    file: fileArg("The picture or clip."),
    scale: z.number().int().min(2).max(8).optional().describe("A picture: 2 or 4 (default 2)."),
    to: z.enum(clipTargets).optional().describe("A clip: the height to reach (default 1080p)."),
    model: z.string().max(300).optional().describe("Upscaler id (models)."),
    creativity: z.number().min(0).max(1).optional().describe("Hosted upscalers that have it: how much new detail to invent (default 0)."),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
  }),
  files: ["file"],
  async run(args, ctx) {
    await checkMachine(args.machine, ctx.prefs);
    const src = await existing(args.file, "file");
    const { width, height } = src.info;
    if ((src.info.kind !== "image" && src.info.kind !== "video") || !width || !height) throw fail("file_wrong_type", { field: "file", what: "Upscale takes a picture or a clip." });
    const aspect = aspectNear(width / height);
    const notes = ["You aren't shown an upscale. Hand the user the file itself (attach it if you can, else its path) as soon as it's done, with its new size: don't only say it worked."];

    if (src.info.kind === "video") {
      if (args.scale) throw fail("option_not_supported", { field: "scale", what: 'A clip is upscaled to a height: use "to".', allowed: clipTargets, do: 'Leave "scale" out and pass "to".' });
      const model = await chooseModel("upscale", args.model, ctx.prefs, { fits: (m) => clipUpscalers.has(m.id), what: "upscales pictures only, not clips", prefer: [...clipUpscalers], none: "No clip upscaler (SeedVR2 or FlashVSR+) is set up on a machine that's online; the picture upscalers can't do clips. settings install with tool \"upscale\" and extras: true adds one." });
      const target = args.to ?? "1080p";
      const size = upscaledSize(width, height, CLIP_TARGETS.find((t) => t.value === target)!.height);
      if (size.factor <= 1.01) throw fail("invalid_input", { field: "to", what: `The clip is already ${width}×${height}: ${target} wouldn't make it larger.`, allowed: clipTargets.filter((t) => CLIP_TARGETS.find((x) => x.value === t)!.height > Math.min(width, height)) });
      const seconds = Math.min(60, Math.max(1, Math.round(src.info.duration ?? 5)));
      const plan = await planJob(model, { kind: "upscale", aspect, count: 1, references: 0, resolution: target, duration: seconds, ratio: width / height, machine: args.machine }, ctx.prefs);
      const result = `${size.width}×${size.height}`;
      if (args.dry_run) return dryAnswer(plan, { result_size: result });
      requireConfirm("upscale", args, plan);
      const gen = await startJob(
        { tool: "upscale", prompt: `Upscale to ${CLIP_TARGETS.find((t) => t.value === target)!.label} · ${result}`, aspect, count: 1, model: model.id, params: { kind: "upscale", videoUrl: src.url, options: { resolution: target, ...(plan.machine ? { machine: plan.machine.id } : {}) } } },
        ctx.caller,
      );
      return answerJob([gen.id], args.wait ?? 20, false, ctx, { started: startedView(gen.id, plan), result_size: result, notes });
    }

    if (args.to) throw fail("option_not_supported", { field: "to", what: 'A picture is upscaled by a factor: use "scale".', allowed: [2, 4], do: 'Leave "to" out and pass "scale".' });
    const model = await chooseModel("upscale", args.model, ctx.prefs);
    const local = model.id.startsWith("local:");
    // Own-GPU upscalers do 2× and 4×; a hosted one has its own factors (or a fixed one).
    const factors = local ? [2, 4] : (model.caps?.scale?.choices ?? (model.caps?.scale ? Array.from({ length: Math.floor(model.caps.scale.max) - Math.ceil(model.caps.scale.min) + 1 }, (_, i) => Math.ceil(model.caps!.scale!.min) + i) : [2, 4]));
    const scale = args.scale ?? (factors.includes(2) ? 2 : factors[0]);
    if (!factors.includes(scale)) throw fail("option_not_supported", { field: "scale", what: `${model.name} doesn't upscale ${scale}×.`, allowed: factors });
    const plan = await planJob(model, { kind: "upscale", aspect, count: 1, references: 1, ratio: width / height, source: { width, height }, scale, machine: args.machine }, ctx.prefs);
    const result = `${width * scale}×${height * scale}`;
    if (args.dry_run) return dryAnswer(plan, { result_size: result });
    requireConfirm("upscale", args, plan);
    const gen = await startJob(
      {
        tool: "upscale",
        prompt: `Upscale ${scale}×${args.creativity ? ` · creativity ${Math.round(args.creativity * 100)}%` : ""}`,
        aspect,
        count: 1,
        model: model.id,
        references: [{ url: src.url, label: "the original image", role: "edit-target" }],
        params: { kind: "upscale", sourceUrl: src.url, options: { scale, creativity: args.creativity ?? 0, flavor: "photo", ...(plan.machine ? { machine: plan.machine.id } : {}) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, false, ctx, { started: startedView(gen.id, plan), result_size: result, notes });
  },
});

/* ------------------------------------------------------------------ angles */

/** Models that re-shoot from a picture of the 3D view (the Angles page draws it): not usable without that page. */
const FROM_VIEW = new Set(["local:qwen-angles", "local:director-world"]);

export const angles = tool({
  name: "angles",
  title: "Angles",
  description: "The same picture from another camera angle: the camera goes round the subject, higher or lower, closer or farther. By words only, so small moves work best; it's Crackio's weakest tool for agents.",
  input: z.object({
    file: fileArg("The picture."),
    turn: z.number().min(-180).max(180).optional().describe("Degrees round the subject; positive moves the camera to its right."),
    height: z.number().min(-70).max(89).optional().describe("Camera height seen from the subject: 0 level, 90 straight overhead. Default: the photo's own."),
    zoom: z.number().min(-1).max(1).optional().describe("-1 much farther back, 1 much closer."),
    model: z.string().max(300).optional(),
    size: z.enum(SIZES).optional(),
    count: z.number().int().min(1).max(4).optional(),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["file"],
  async run(args, ctx) {
    await checkMachine(args.machine, ctx.prefs);
    const src = await existingKind(args.file, "file", "image");
    const ratio = src.info.width && src.info.height ? src.info.width / src.info.height : 1;
    // The move in the photo's own terms, as the Angles page works it out when it has no 3D measurement of the photo.
    const view: AngleView = { azimuth: args.turn ?? 0, zoom: args.zoom ?? 0, ...(args.height !== undefined ? { elevation: args.height } : {}) };
    const place = provisionalPlace(ratio);
    const orbit = orbitFor(place, null, ratio, null);
    const base = angleBase(place, orbit.point);
    const shot = resolveShot(base, view);
    const facts = angleFacts(base, shot, orbit);
    if (isOriginal(facts)) throw fail("invalid_input", { field: "turn", what: "That's the photo's own camera: nothing would change.", do: "Give turn, height or zoom." });
    if (args.model && FROM_VIEW.has(args.model)) throw fail("option_not_supported", { field: "model", what: "That model re-shoots from Crackio's 3D view of the photo, which only the Angles page draws.", do: "Leave model out, or use an image model that edits pictures." });
    const model = await chooseModel("image", args.model, ctx.prefs, { ...EDITS, fits: (m) => EDITS.fits(m) && !FROM_VIEW.has(m.id) });
    const aspect = aspectNear(ratio);
    const count = args.count ?? 1;
    const local = model.id.startsWith("local:");
    const plan = await planJob(model, { kind: "image", aspect, count, references: 1, resolution: local ? (args.size ?? "1k") : undefined, ratio, machine: args.machine }, ctx.prefs);
    const move = angleSummary(facts);
    plan.notes = ["Angles goes by words: the model is told the move, not shown it. Expect the likeness to hold on small moves and drift on big ones."];
    if (args.dry_run) return dryAnswer(plan, { move });
    requireConfirm("angles", args, plan);
    const gen = await startJob(
      {
        tool: "angles",
        prompt: `Angles · ${move}`,
        compiledPrompt: anglePrompt(facts, { guide: false }),
        aspect,
        count,
        model: model.id,
        references: [{ url: src.url, label: "the original image", role: "edit-target" }],
        params: { kind: "image", sourceUrl: src.url, view, shot, options: { ...(local ? { resolution: args.size ?? "1k" } : {}), ...(plan.machine ? { machine: plan.machine.id } : {}) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(gen.id, plan), move });
  },
});
