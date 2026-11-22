import "server-only";
import { z } from "zod";
import { CAMERAS, FINISHES, FORMATS, LIGHTS, MOMENTS, SCENES, studioSummary, WHO, type StudioSpec } from "@/lib/product/vocab";
import { getCharacter } from "@/lib/server/cast";
import { characterByHandle } from "@/lib/server/cast-store";
import { readProduct } from "@/lib/server/product";
import { fail } from "./errors";
import { startJob } from "./jobs";
import { checkMachine } from "./machines";
import { chooseModel, crackioQueue, planJob, requireConfirm } from "./plan";
import { answerJob, confirm, dryAnswer, dryRun, existingKind, fileArg, machineArg, showArg, SIZES, startedView, tool, waitArg } from "./shared";
import { EDITS } from "./tools-edit";

/**
 * Product Studio: pictures of a product in use. Crackio reads the product from its photos; the agent picks the moment,
 * place, camera, light and look, and can write each take's prompt itself. Crackio's own shot director (a text model)
 * never runs for an agent.
 */

/** One of a list's ids, as picked by the agent; the failure names the ones there are. */
function pick<T extends readonly { id: string }[]>(list: T, value: string | undefined, field: string): T[number]["id"] {
  if (value === undefined) return list[0].id;
  const hit = list.find((o) => o.id === value);
  if (!hit) throw fail("invalid_input", { field, what: `"${value.slice(0, 20)}" isn't a ${field} Product Studio has.`, allowed: list.map((o) => o.id) });
  return hit.id;
}
const lines = (list: readonly { id: string; label: string; caption: string }[]) => list.map((o) => `${o.id} · ${o.label}: ${o.caption}`);

export const product = tool({
  name: "product",
  title: "Product Studio",
  description: "Shoot a product in use from its photos. read: what Crackio sees the product is, and every option. shoot: takes with your picks; write a prompt per take in shots to direct them yourself.",
  input: z.object({
    action: z.enum(["read", "shoot"]).describe("read first, then shoot."),
    photos: z.array(fileArg("Path.")).min(1).max(3).describe("The product: front first, then other angles."),
    is: z.string().max(200).optional().describe("What the product is, if Crackio's reading is wrong."),
    moment: z.string().max(20).optional().describe("moment, scene, camera, light, finish, who, format: an id from read's options (default: Crackio's best fit)."),
    scene: z.string().max(20).optional(),
    camera: z.string().max(20).optional(),
    light: z.string().max(20).optional(),
    finish: z.string().max(20).optional(),
    who: z.string().max(20).optional(),
    cast: z.string().max(41).optional().describe("Or a Cast member in the shot (@handle)."),
    who_text: z.string().max(300).optional().describe("Or someone you describe."),
    headline: z.string().max(120).optional().describe("Words set on the picture, exactly as written (leaves calm space for them)."),
    shots: z.array(z.string().min(20).max(4000)).min(1).max(4).optional().describe('Your own full prompt for each take (the product is "image 1"). One take per prompt, shot as written. Without it, each take is the picks in Crackio\'s fixed words.'),
    format: z.string().max(8).optional().describe("Shape (default 4:5)."),
    count: z.number().int().min(1).max(4).optional().describe("Takes, when shots isn't given (default 1)."),
    check: z.boolean().optional().describe("true: each take is checked against the product photo and re-shot once if wrong."),
    model: z.string().max(300).optional().describe("Model id (models)."),
    size: z.enum(SIZES).optional(),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["photos.*"],
  async run(args, ctx) {
    const photos = await Promise.all(args.photos.map((p, i) => existingKind(p, `photos.${i}`, "image")));
    // The reading looks at the photos with a model that sees (kept once made). Crackio's own works without it.
    const read = await readProduct(photos.map((p) => p.path), ctx.signal).catch(() => null);

    if (args.action === "read") {
      return {
        data: {
          product: read
            ? { is: read.name, kind: read.kind, brand: read.brand || undefined, words_on_it: read.text || undefined, used: read.use, ways_to_show_it: read.states, held: read.hands, rests: read.rests, never: read.never, belongs_in: read.settings, props: read.props, people: read.people }
            : crackioQueue().running
              ? // (A model that sees shares the GPU with the job that's drawing: it read the same product two minutes later.)
                { note: 'No model that sees answered: the GPU is busy with another job. Read again when it is done (jobs shows the queue) before you shoot, so you don\'t shoot blind. Only if it still doesn\'t answer, say what it is with "is".', busy: true }
              : { note: 'No model that sees answered, so the product wasn\'t read. Say what it is with "is" when you shoot.' },
          options: { moment: lines(MOMENTS), scene: lines(SCENES), camera: lines(CAMERAS), light: lines(LIGHTS), finish: lines(FINISHES), who: lines(WHO), format: lines(FORMATS) },
          next: 'Call product with action "shoot", the same photos and your picks. Write shots (a prompt per take) to direct each take yourself.',
        },
      };
    }

    await checkMachine(args.machine, ctx.prefs);
    // Never a blind shoot in silence: without a reading Crackio doesn't know how the thing is held, worn or used, and
    // "in use" came out as hands on a pair of headphones nobody wore.
    if (!read && !args.is?.trim()) {
      throw fail("machine_not_answering", {
        what: `Crackio couldn't read the product: no model that sees answered${crackioQueue().running ? " (the GPU is busy with another job)" : ""}.`,
        why: "Without a reading it doesn't know how the product is held, worn or used.",
        do: 'Call product with action "read" again in a minute. To shoot without a reading, say in "is" what it is and how it is used or worn ("over-ear headphones, worn on the head").',
      });
    }
    const member = args.cast ? characterByHandle(args.cast.replace(/^@/, "").toLowerCase()) : null;
    if (args.cast && !member) throw fail("cast_not_found", { field: "cast", what: `There's no Cast member "${args.cast}".` });
    const who = member ? await getCharacter(member.id) : null;
    if (who?.kind === "object") throw fail("option_not_supported", { field: "cast", what: `${who.name} is a thing, not someone who can hold or use the product.` });
    const count = args.shots?.length ?? args.count ?? 1;
    const spec: StudioSpec = {
      version: 2,
      moment: pick(MOMENTS, args.moment, "moment"),
      scene: pick(SCENES, args.scene, "scene"),
      camera: pick(CAMERAS, args.camera, "camera"),
      light: pick(LIGHTS, args.light, "light"),
      finish: pick(FINISHES, args.finish, "finish"),
      who: who ? "cast" : args.who_text?.trim() ? "custom" : pick(WHO, args.who, "who"),
      ...(who ? { cast: { id: who.id, name: who.name, kind: who.kind as "person" | "pet" | "character", traits: who.traits } } : {}),
      ...(args.who_text?.trim() && !who ? { whoText: args.who_text.trim() } : {}),
      copySpace: Boolean(args.headline?.trim()),
      headline: args.headline?.trim() || undefined,
      noted: false,
      identity: args.is?.trim() || undefined,
      read,
      productImages: photos.length,
      check: Boolean(args.check),
      ...(args.shots?.length ? { shots: args.shots } : { direct: false as const }),
    };
    const noun = who ? ({ person: "person", pet: "animal", character: "character", object: "thing" } as const)[who.kind] : "";
    const castRefs = who
      ? [who.portrait, who.sheet]
          .filter((u): u is string => Boolean(u))
          .slice(0, photos.length >= 3 ? 1 : 2)
          .map((url) => ({ url, label: `${who.name}, the ${noun} to keep consistent`, role: "subject" as const }))
      : [];
    const model = await chooseModel("image", args.model, ctx.prefs, EDITS);
    const aspect = args.format ? pick(FORMATS, args.format, "format") : "4:5";
    const local = model.id.startsWith("local:");
    const plan = await planJob(model, { kind: "image", aspect, count, references: photos.length + castRefs.length, resolution: local ? (args.size ?? "1k") : undefined, machine: args.machine }, ctx.prefs);
    plan.notes = [
      ...(args.shots?.length ? [] : ["No shots given: each take is your picks in Crackio's fixed words. For takes that differ, write a prompt per take in shots."]),
      ...(read ? [] : ['Shot without a reading of the product (no model that sees answered): only your "is" says how it is used. Look closely at the result.']),
    ];
    if (!plan.notes.length) plan.notes = undefined;
    if (args.dry_run) return dryAnswer(plan, { takes: count });
    requireConfirm("product", args, plan);
    const gen = await startJob(
      {
        tool: "product",
        prompt: `${studioSummary(spec, read?.kind)}${who ? ` · ${who.name}` : ""}`,
        aspect,
        count,
        model: model.id,
        references: [...photos.map((p, i) => ({ url: p.url, label: i === 0 ? "the product" : "the same product from another angle", role: "product" as const })), ...castRefs],
        params: { kind: "image", sourceUrl: photos[0].url, studio: spec, options: { ...(local ? { resolution: args.size ?? "1k" } : {}), ...(plan.machine ? { machine: plan.machine.id } : {}) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(gen.id, plan), ...(plan.notes?.length ? { notes: plan.notes } : {}) });
  },
});
