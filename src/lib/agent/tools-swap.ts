import "server-only";
import { z } from "zod";
import { POST as frameRoute } from "@/app/api/recast/frame/route";
import { POST as swapRoute } from "@/app/api/swap/run/route";
import type { Generation } from "@/lib/generations/types";
import { LOCAL_RIPPLE_ID } from "@/lib/models/catalog";
import { characterByHandle } from "@/lib/server/cast-store";
import { detectThings } from "@/lib/server/detect";
import { urlToPath } from "@/lib/server/media";
import { fail, failure, jobFailure } from "./errors";
import { agentMark } from "./jobs";
import { checkMachine } from "./machines";
import { overlay } from "./pictures";
import { chooseModel, planJob, requireConfirm } from "./plan";
import { answerJob, aspectNear, confirm, dryAnswer, dryRun, existingKind, fileArg, machineArg, showArg, startedView, tool, waitArg } from "./shared";
import { eyesAllowed } from "./tools-retouch";

/**
 * Swap: replace a person, pet, car or thing in a clip. The clip's motion, camera, background and sound stay. The agent
 * gets one frame with everything in it numbered, says what each pick becomes, and Crackio carries it through the clip.
 */

const SKIP_FINDING = 'Or skip finding: pass changes with a point each (x, y as fractions of the frame) and "what" (who or what is there).';

/** One frame of the clip, saved as a picture (the Swap page's own route, which keeps frames it already made). */
async function frameOf(clipUrl: string, t: number) {
  const res = await frameRoute(new Request("http://crackio.internal/api/recast/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: clipUrl, t }) }));
  const answer = (await res.json().catch(() => null)) as { frame?: { url: string; width: number; height: number }; error?: string } | null;
  const path = answer?.frame ? urlToPath(answer.frame.url) : null;
  if (!answer?.frame || !path) throw fail("file_wrong_type", { field: "clip", what: "Crackio couldn't read a frame from that clip.", why: answer?.error });
  return { ...answer.frame, path };
}

export const swap = tool({
  name: "swap",
  title: "Swap in a clip",
  description: 'Replace people or things in a clip; motion, camera and sound stay. Call with only the clip for a frame with everything numbered, then again with what each pick becomes. Read guide("swap") first.',
  input: z.object({
    clip: fileArg("The clip."),
    at: z.number().min(0).max(36000).optional().describe("The second of the frame to pick from (default 0)."),
    changes: z
      .array(
        z.object({
          thing: z.string().max(10).optional().describe("Its number on the frame."),
          point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional().describe("Or a point on it: x, y as fractions (0–1) from the top-left."),
          what: z.string().max(200).optional().describe('With point: what it is ("the man in the pink shirt").'),
          cast: z.string().max(41).optional().describe("It becomes this Cast member (@handle)."),
          picture: fileArg("It becomes what this picture shows.").optional(),
          words: z.string().max(400).optional().describe("It becomes what you describe."),
          remove: z.boolean().optional().describe("true: it's removed."),
        }),
      )
      .min(1)
      .max(4)
      .optional()
      .describe("Up to 4 picks; each becomes one of cast, picture, words, remove."),
    background: z.string().max(400).optional().describe("A new place behind everything, in words."),
    start: z.number().min(0).max(36000).optional().describe("Second the swap starts at (default 0)."),
    seconds: z.number().min(1).max(20).optional().describe("How much of the clip (default all, up to 15)."),
    size: z.enum(["540p", "720p"]).optional().describe("Default 720p."),
    fast: z.boolean().optional().describe("A quick draft."),
    sharp: z.boolean().optional().describe("Finished at up to 1080p."),
    keep_others: z.boolean().optional().describe("Everyone not picked is put back from the clip."),
    consent: z.boolean().optional().describe("With cast or picture: true only after the user said everyone shown agreed and is an adult."),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["clip", "changes.*.picture"],
  async run(args, ctx) {
    const clip = await existingKind(args.clip, "clip", "video");
    const length = clip.info.duration ?? 0;
    const at = args.at ?? 0;
    if (at > length) throw fail("invalid_input", { field: "at", what: `"at" is ${at} s, but the clip is ${Math.round(length * 100) / 100} s long.` });
    const picking = !args.changes?.length && !args.background?.trim();

    if (picking) {
      await eyesAllowed(ctx, SKIP_FINDING);
      const frame = await frameOf(clip.url, at);
      const found = (await detectThings(frame.path, ctx.signal))?.things ?? [];
      const shown = ctx.prefs.seePictures && found.length ? [{ ...(await overlay(frame.path, found.map((t, i) => ({ box: t.box, label: String(i + 1) })))), label: `The frame at ${at} s, every thing numbered.` }] : [];
      return {
        data: {
          clip_seconds: Math.round(length * 100) / 100,
          frame_at: at,
          things: found.map((t, i) => ({ id: String(i + 1), name: t.label, ...(t.detail !== t.label ? { is: t.detail } : {}) })),
          next: found.length ? 'Call swap again with at (the same second) and changes: [{thing: "<id>", cast | picture | words | remove}].' : "Nothing was found on this frame. Try another second with at, or pass changes with a point each.",
        },
        images: shown,
      };
    }

    await checkMachine(args.machine, ctx.prefs);
    const given = args.changes ?? [];
    const found = given.some((c) => c.thing) ? await (async () => (await eyesAllowed(ctx, SKIP_FINDING), (await detectThings((await frameOf(clip.url, at)).path, ctx.signal))?.things ?? []))() : [];
    const changes: Record<string, unknown>[] = [];
    for (const [i, c] of given.entries()) {
      const kinds = [c.cast ? "cast" : null, c.picture ? "picture" : null, c.words?.trim() ? "words" : null, c.remove ? "remove" : null].filter(Boolean) as ("cast" | "picture" | "words" | "remove")[];
      if (kinds.length !== 1) throw fail("invalid_input", { field: `changes.${i}`, what: "Each pick becomes exactly one of: cast, picture, words, remove." });
      const t = c.thing ? found[Number(c.thing) - 1] : null;
      if (c.thing && !t) throw fail("invalid_input", { field: `changes.${i}.thing`, what: `There's no thing "${c.thing}" on the frame at ${at} s.`, allowed: found.map((_, n) => String(n + 1)) });
      if (!t && !c.point) throw fail("invalid_input", { field: `changes.${i}`, what: "Each pick needs a thing (its number) or a point." });
      if (c.thing && c.point) throw fail("invalid_input", { field: `changes.${i}`, what: "A pick has a thing or a point, not both." });
      if (!t && !c.what?.trim()) throw fail("invalid_input", { field: `changes.${i}.what`, what: 'A pick by point needs "what": who or what is there ("the man in the pink shirt").' });
      const [x, y] = t ? [(t.box[0] + t.box[2]) / 2000, (t.box[1] + t.box[3]) / 2000] : [c.point!.x, c.point!.y];
      const base = { at: { t: at, x, y }, what: t?.detail ?? c.what?.trim() ?? "" };
      if (kinds[0] === "cast") {
        const who = characterByHandle(c.cast!.replace(/^@/, "").toLowerCase());
        if (!who) throw fail("cast_not_found", { field: `changes.${i}.cast`, what: `There's no Cast member "${c.cast}".` });
        changes.push({ ...base, to: "cast", cast: who.id });
      } else if (kinds[0] === "picture") {
        changes.push({ ...base, to: "picture", image: (await existingKind(c.picture!, `changes.${i}.picture`, "image")).url });
      } else if (kinds[0] === "words") changes.push({ ...base, to: "words", words: c.words!.trim() });
      else changes.push({ ...base, to: "remove" });
    }
    if (changes.some((c) => c.to === "cast" || c.to === "picture") && !args.consent) {
      throw fail("confirm_needed", { field: "consent", what: "Putting a person or a pictured thing into a clip needs the user's word that everyone shown agreed to it and is an adult.", do: "Ask the user exactly that. If they say yes, call again with consent: true.", confirm: undefined });
    }

    const start = args.start ?? 0;
    const seconds = Math.min(args.seconds ?? 15, Math.max(1, length - start));
    const model = await chooseModel("video", LOCAL_RIPPLE_ID, ctx.prefs);
    const ratio = clip.info.width && clip.info.height ? clip.info.width / clip.info.height : 16 / 9;
    const plan = await planJob(model, { kind: "video", aspect: aspectNear(ratio), count: 1, references: changes.length, duration: Math.round(seconds), resolution: args.size ?? "720p", ratio, machine: args.machine, unpinned: !args.machine }, ctx.prefs);
    plan.notes = ["A swap also outlines each pick through the clip and redraws one frame first: allow a few minutes more than the estimate."];
    if (args.dry_run) return dryAnswer(plan, { swap_seconds: Math.round(seconds * 10) / 10 });
    requireConfirm("swap", args, plan);

    const res = await swapRoute(
      new Request("http://crackio.internal/api/swap/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clip: { url: clip.url, start },
          changes,
          ...(args.background?.trim() ? { background: args.background.trim() } : {}),
          resolution: args.size ?? "720p",
          sharp: Boolean(args.sharp),
          lock: Boolean(args.keep_others),
          seconds,
          consent: Boolean(args.consent),
          fast: Boolean(args.fast),
          ...(plan.machine ? { machine: plan.machine.id } : {}),
          agent: agentMark(ctx.caller),
        }),
      }),
    );
    const answer = (await res.json().catch(() => null)) as { item?: Generation; error?: string; hint?: string } | null;
    if (!res.ok || !answer?.item) {
      // The route's own words are plain; its cause gets a code where one fits.
      const f = jobFailure(answer?.error, answer?.hint);
      throw fail(f.code === "job_failed" ? "invalid_input" : f.code, f.code === "job_failed" ? { ...failure("invalid_input"), what: answer?.error ?? "Crackio refused the swap.", why: answer?.hint } : f);
    }
    return answerJob([answer.item.id], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(answer.item.id, plan) });
  },
});
