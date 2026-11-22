import "server-only";
import { z } from "zod";
import { lfm3Machine } from "@/lib/engines/comfy-text";
import type { RetouchChange, RetouchSpec } from "@/lib/retouch/plan";
import { detectParts, detectThings, type Thing } from "@/lib/server/detect";
import { getSettings } from "@/lib/server/settings";
import { fail } from "./errors";
import { startJob } from "./jobs";
import { checkMachine, paidMachineIds } from "./machines";
import { overlay } from "./pictures";
import { chooseModel, planJob, requireConfirm } from "./plan";
import { answerJob, aspectNear, boxOf, confirm, dryAnswer, dryRun, existingKind, fileArg, machineArg, region, showArg, SIZES, startedView, tool, waitArg, type ToolContext } from "./shared";
import { checkLoras, checkLorasOn, loras } from "./tools-create";
import { EDITS } from "./tools-edit";

/**
 * Retouch: Crackio finds every thing in a picture; the agent picks some, writes a note for each, and they're changed
 * up close (each on a crop of its own, set back into the picture) or in one edit of the whole picture.
 */

const sentence = (s: string) => s.trim().replace(/[.;:,\s]+$/, "");

/**
 * Finding things reads the picture with Crackio's own eyes on one of the user's GPUs, or with Gemini on Comfy credits.
 * An agent held to free paths gets the first only.
 */
export async function eyesAllowed(ctx: ToolContext, instead = "Or skip finding: pass changes with a region each (x, y, w, h as fractions of the picture) and say what is there.") {
  if (ctx.prefs.spend !== "free") return;
  const picked = (await getSettings()).retouchEyes ?? "auto";
  const own = await lfm3Machine("retouch").catch(() => null);
  if (picked !== "cloud" && own && !(await paidMachineIds()).has(own.id)) return;
  if (picked !== "cloud" && own) throw fail("paid_not_allowed", { what: `Finding things would run on ${own.label}, which costs money, and the user lets agents use free machines only.`, do: `Tell the user. ${instead}` });
  throw fail(picked === "cloud" ? "paid_not_allowed" : "no_machine_online", {
    what: picked === "cloud" ? "Finding things is set to Gemini on Comfy credits, and the user lets agents use free paths only." : "Finding things needs Crackio's eyes on one of the user's machines, and none with them is online.",
    do: `Tell the user which machines are off (status). ${instead}`,
  });
}

async function things(file: string, ctx: ToolContext): Promise<Thing[]> {
  await eyesAllowed(ctx);
  const found = await detectThings(file, ctx.signal);
  if (!found) {
    throw fail("model_not_installed", {
      what: "The small model that finds things in a picture (Retouch's eyes) isn't on a machine that's online.",
      do: "Look at the picture yourself (look) and pass changes with a region each and what is there. Or ask the user to add Retouch's eyes (Crackio → Settings → Tools → Retouch, about 4 GB): settings read shows Retouch as ready without them, because only its find needs them.",
    });
  }
  return found.things;
}

/**
 * A thing's parts as the finder gave them, without the ones it lists only to say they aren't there ("glasses: none
 * visible"): the numbers an agent sees and the numbers it sends back are of this list.
 */
async function partsOf(file: string, root: Thing, ctx: ToolContext) {
  const looked = await detectParts(file, root, ctx.signal);
  const parts = (looked?.parts ?? []).filter((p) => !/\b(none|not|isn't|no longer) (visible|present|shown)\b|\bnot in (the )?(picture|frame)\b/i.test(p.detail));
  return { box: looked?.box ?? root.box, parts };
}

/** A thing by its number ("3"), or one of its parts ("3.2"). */
async function byNumber(file: string, id: string, all: Thing[], ctx: ToolContext, field: string): Promise<Thing> {
  const [n, part] = id.split(".").map(Number);
  const root = Number.isInteger(n) ? all[n - 1] : undefined;
  if (!root) throw fail("invalid_input", { field, what: `There's no thing "${id.slice(0, 20)}" in this picture.`, allowed: all.map((_, i) => String(i + 1)) });
  if (part === undefined) return root;
  const { parts } = await partsOf(file, root, ctx);
  const hit = Number.isInteger(part) ? parts[part - 1] : undefined;
  if (!hit) throw fail("invalid_input", { field, what: `Thing ${n} (${root.label}) has no part "${id.slice(0, 20)}".`, allowed: parts.map((_, i) => `${n}.${i + 1}`), do: `Call retouch with parts_of: "${n}" to see its parts.` });
  return hit;
}

export const retouch = tool({
  name: "retouch",
  title: "Retouch a picture",
  description: "Change things inside a picture. Call it with just the file first: Crackio finds every thing and returns them numbered on one picture. Then call again with a note for each thing to change; all are made in one edit.",
  input: z.object({
    file: fileArg("The picture."),
    parts_of: z.string().max(10).optional().describe("One thing's parts (its number, like 3), numbered: a face's eyes, a car's wheels."),
    view: z.enum(["closeup", "whole"]).optional().describe("With parts_of: closeup (default) shows only that thing, enlarged, its parts inside it; whole draws the same parts on the full picture."),
    changes: z
      .array(
        z.object({
          thing: z.string().max(10).optional().describe('Its number from the find ("3"), or a part ("3.2").'),
          region: region.optional().describe("Or a region of your own: x, y, w, h as fractions (0–1) from the top-left."),
          what: z.string().max(160).optional().describe("With region: what is there."),
          note: z.string().min(1).max(600).describe("What it should become."),
          look: fileArg("A picture of how it should look.").optional(),
        }),
      )
      // (An empty list means none: the things are found and listed, as with no list at all.)
      .max(12)
      .optional()
      .describe("What to change. With none, the things are found and listed."),
    also: z.string().max(600).optional().describe("A change to the whole picture, in words."),
    keep_rest: z.boolean().optional().describe("Keep the original's pixels outside the changes (default true)."),
    mode: z
      .enum(["closeup", "whole", "redraw"])
      .optional()
      .describe("closeup (default): each change on a crop of its own, the picture keeps its size; best for a change of colour, material or a small fix. redraw: the whole picture is redrawn with the changes, then only the changed areas are set back into the original at its own size; best when a thing becomes another thing (a bouquet of other flowers), with the picture's style LoRA in loras. whole: one edit of the whole picture, returned at the model's size."),
    loras,
    model: z.string().max(300).optional().describe("Model id (models)."),
    size: z.enum(SIZES).optional(),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["file", "changes.*.look"],
  async run(args, ctx) {
    const src = await existingKind(args.file, "file", "image");
    const editing = Boolean(args.changes?.length || args.also?.trim());

    if (!editing) {
      const all = await things(src.path, ctx);
      if (args.parts_of) {
        const root = await byNumber(src.path, args.parts_of.split(".")[0], all, ctx, "parts_of");
        const n = all.indexOf(root) + 1;
        const looked = await partsOf(src.path, root, ctx);
        const parts = looked.parts;
        // The agent picks how to look: a close-up of that one thing (its own box, tightened when its parts were found) with
        // its parts numbered inside it, or the same parts drawn on the whole picture, where they sit among everything else.
        const whole = args.view === "whole";
        const numbered = parts.map((p, i) => ({ box: p.box, label: `${n}.${i + 1}` }));
        const shown = !ctx.prefs.seePictures
          ? []
          : whole
            ? [{ ...(await overlay(src.path, [{ box: looked.box, label: String(n) }, ...numbered])), label: `The whole picture: thing ${n} (${root.label}) and its parts, numbered.` }]
            : [{ ...(await overlay(src.path, numbered, 1024, looked.box)), label: parts.length ? `A close-up of thing ${n} (${root.label}), its parts numbered.` : `A close-up of thing ${n} (${root.label}).` }];
        return { data: { thing: `${n} ${root.label}`, parts: parts.map((p, i) => ({ id: `${n}.${i + 1}`, name: p.label, ...(p.detail !== p.label ? { is: p.detail } : {}) })), ...(parts.length ? { next: `Change a part with changes: [{thing: "${n}.1", note: "…"}], or the whole thing with thing: "${n}". view: "${whole ? "closeup" : "whole"}" shows these parts ${whole ? "enlarged, on that thing alone" : "on the full picture"}.` } : { note: "No parts found. Change the thing as a whole, or pass a region." }) }, images: shown };
      }
      const shown = ctx.prefs.seePictures && all.length ? [{ ...(await overlay(src.path, all.map((t, i) => ({ box: t.box, label: String(i + 1) })))), label: "Every thing found, numbered." }] : [];
      return {
        data: {
          things: all.map((t, i) => ({ id: String(i + 1), name: t.label, ...(t.detail !== t.label ? { is: t.detail } : {}) })),
          next: all.length ? 'Call retouch again with changes: [{thing: "<id>", note: "<what it becomes>"}], all at once. parts_of: "<id>" gives a close-up of one thing with its parts numbered, for a closer look or a smaller change.' : "Nothing was found. Pass changes with a region each and say what is there.",
        },
        images: shown,
      };
    }

    await checkMachine(args.machine, ctx.prefs);
    const given = args.changes ?? [];
    // What's wrong with the changes themselves is said before anything is looked for.
    given.forEach((c, i) => {
      if (Boolean(c.thing) === Boolean(c.region)) throw fail("invalid_input", { field: `changes.${i}`, what: c.thing ? "A change has a thing or a region, not both." : "Each change needs a thing (its number) or a region." });
      if (c.region && !c.what?.trim()) throw fail("invalid_input", { field: `changes.${i}.what`, what: 'A change with a region of your own needs "what": the thing that is there.' });
    });
    const found = given.some((c) => c.thing) ? await things(src.path, ctx) : [];
    const changes: RetouchChange[] = [];
    const looks: { url: string; n: number }[] = [];
    for (const [i, c] of given.entries()) {
      if (Boolean(c.thing) === Boolean(c.region)) throw fail("invalid_input", { field: `changes.${i}`, what: c.thing ? "A change has a thing or a region, not both." : "Each change needs a thing (its number) or a region." });
      const t = c.thing ? await byNumber(src.path, c.thing, found, ctx, `changes.${i}.thing`) : null;
      if (!t && !c.what?.trim()) throw fail("invalid_input", { field: `changes.${i}.what`, what: 'A change with a region of your own needs "what": the thing that is there.' });
      const look = c.look ? await existingKind(c.look, `changes.${i}.look`, "image") : null;
      if (look) looks.push({ url: look.url, n: i + 1 });
      changes.push({ id: `a${i + 1}`, box: t?.box ?? boxOf(c.region!), target: t?.detail ?? sentence(c.what!), text: sentence(c.note), ...(look ? { image: { url: look.url } } : {}) });
    }
    // Up close (the default): each change is made on a crop of its own and set back in, so the picture keeps its size and
    // every pixel outside the crops. Whole: one edit of the whole picture, which comes back at the edit model's size.
    const mode = args.mode ?? "closeup";
    const spec: RetouchSpec = { version: 2, mode, changes, extra: args.also?.trim() || undefined, lock: args.keep_rest ?? true };
    const model = await chooseModel("image", args.model, ctx.prefs, EDITS);
    // A style LoRA draws the changed parts in the picture's own look (every edit of the job carries it).
    const useLoras = await checkLoras(args.loras, model);
    // Redraw sets areas of the redrawn picture back into the original: drawn small, they come back soft. Its size
    // follows the picture's unless one is given.
    const long = Math.max(src.info.width ?? 0, src.info.height ?? 0);
    const size = args.size ?? (mode === "redraw" ? (long >= 3000 ? "4k" : long >= 1700 ? "2k" : "1k") : "1k");
    const ratio = src.info.width && src.info.height ? src.info.width / src.info.height : 1;
    const aspect = aspectNear(ratio);
    const local = model.id.startsWith("local:");
    const plan = await planJob(model, { kind: "image", aspect, count: 1, references: 1 + looks.length, resolution: local ? size : undefined, ratio, machine: args.machine }, ctx.prefs);
    const loraNotes = await checkLorasOn(plan.machine?.id, useLoras);
    if (loraNotes.length) plan.notes = [...(plan.notes ?? []), ...loraNotes];
    // In close-up mode the picture keeps its size. The plan's size is the crop each change is drawn on, and read as the
    // result's ("1360×768" for a 3840×2160 picture that stayed 3840×2160).
    if (mode === "closeup" && plan.size && src.info.width && src.info.height) plan.size = `${src.info.width}×${src.info.height}, kept; each change is drawn on a crop of its own (at up to ${plan.size}) and set back in`;
    if (mode === "redraw" && plan.size && src.info.width && src.info.height) plan.size = `${src.info.width}×${src.info.height}, kept; the picture is redrawn once (${plan.size}) and only the changed areas are set back in`;
    // The record of what was asked, as the page writes it; the server makes the edit from `retouch`.
    const asked = [...changes.map((c, i) => `${i + 1}. ${c.target}: ${c.text}.`), spec.extra ? `Also: ${sentence(spec.extra)}.` : ""].filter(Boolean).join("\n");
    if (args.dry_run) return dryAnswer(plan, { changes: asked });
    requireConfirm("retouch", args, plan);
    const gen = await startJob(
      {
        tool: "retouch",
        prompt: `Retouch · ${[...changes.map((c) => c.text), spec.extra ?? ""].filter(Boolean).join(" · ")}`.slice(0, 160),
        compiledPrompt: asked,
        aspect,
        count: 1,
        model: model.id,
        references: [{ url: src.url, label: "the original image", role: "edit-target" }, ...looks.map((l) => ({ url: l.url, label: `how change ${l.n} should look`, role: "style" as const }))],
        params: { kind: "image", sourceUrl: src.url, retouch: spec, options: { ...(local ? { resolution: size } : {}), ...(plan.machine ? { machine: plan.machine.id } : {}), ...(useLoras.length ? { loras: useLoras } : {}) } },
      },
      ctx.caller,
    );
    return answerJob([gen.id], args.wait ?? 20, args.show ?? true, ctx, {
      started: startedView(gen.id, plan),
      notes: [
        '"done" doesn\'t mean changed: look at each changed spot (look with a crop) before you show the user.',
        ...loraNotes,
        ...(mode === "redraw" && spec.extra ? ['"also" changes the whole picture, so with it a redraw returns the whole redrawn picture at your picture\'s size, not the original with patches.'] : []),
        ...(mode === "whole" && src.info.width && Math.max(src.info.width, src.info.height ?? 0) > 1400 ? [`mode "whole" re-makes the picture at the edit model's size, so this ${src.info.width}×${src.info.height} picture comes back smaller. mode "closeup" keeps its size.`] : []),
      ],
    });
  },
});
