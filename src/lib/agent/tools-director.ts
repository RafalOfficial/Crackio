import "server-only";
import { z } from "zod";
import { ANGLES, SHOT_SIZES } from "@/lib/director/vocab";
import type { AspectId } from "@/lib/shot";
import { closePlace, moveCamera, openPlace, openPlaces, shoot, shotModel, viewOf, type Pose } from "./director";
import { fail } from "./errors";
import { agentMark } from "./jobs";
import { checkMachine } from "./machines";
import type { Shown } from "./pictures";
import { chooseModel, planJob, requireConfirm } from "./plan";
import { answerJob, confirm, dryAnswer, dryRun, existingKind, fileArg, machineArg, showArg, startedView, tool, waitArg, type ToolContext } from "./shared";

/**
 * The Director: a picture becomes a place you can move a camera through, and the shot is made from where the camera
 * stands. Every camera command answers with what the camera sees and where it is.
 */
const angleIds = ANGLES.map((a) => a.id) as [string, ...string[]];
const shotIds = SHOT_SIZES.map((s) => s.id) as [string, ...string[]];

const seen = (s: Shown, pose: Pose, ctx: ToolContext, what: string) => ({
  camera: pose,
  images: ctx.prefs.seePictures ? [{ ...s, label: what }] : [],
});

export const director = tool({
  name: "director",
  title: "Director",
  description: 'Turn a picture into a place, move a camera through it, and shoot from where it stands. open builds the place; camera moves it and returns the view; shoot makes the picture. Read guide("director") first.',
  input: z.object({
    action: z.enum(["open", "camera", "shoot", "places", "close"]).describe("What to do."),
    picture: fileArg("open: the picture the place is made from.").optional(),
    place: z.string().max(20).optional().describe("camera, shoot, close: the place id from open."),
    reset: z.boolean().optional().describe("camera: back to where the photo was taken."),
    angle: z.enum(angleIds).optional().describe("camera: a named angle."),
    shot: z.enum(shotIds).optional().describe("camera: a named shot size."),
    turn: z.number().min(-180).max(180).optional().describe("camera: degrees round the place; 0 is the photo's own side, positive to the right."),
    turn_by: z.number().min(-180).max(180).optional().describe("camera: turn this many degrees from where it is."),
    height: z.number().min(-60).max(89).optional().describe("camera: degrees above (or below) eye level."),
    closer: z.number().min(0.2).max(5).optional().describe("camera: 2 halves the distance, 0.5 doubles it."),
    lens: z.number().min(10).max(200).optional().describe("camera: focal length in mm (14 wide, 35 natural, 85 portrait)."),
    roll: z.number().min(-45).max(45).optional().describe("camera: tilt of the horizon, degrees."),
    prompt: z.string().max(4000).optional().describe("shoot: what the shot shows and what happens in it, in your words."),
    model: z.string().max(300).optional().describe("shoot: one of the Director's shot models."),
    size: z.enum(["1k", "2k"]).optional().describe("shoot: default 2k."),
    machine: machineArg,
    dry_run: dryRun,
    confirm,
    wait: waitArg,
    show: showArg,
  }),
  files: ["picture"],
  async run(args, ctx) {
    if (args.action === "places") {
      const open = openPlaces();
      return { data: { places: open, ...(open.length ? {} : { note: "No place is open. Open one from a picture." }) } };
    }
    if (args.action === "close") {
      if (!args.place) throw fail("invalid_input", { field: "place", what: "Say which place to close." });
      return { data: { closed: await closePlace(args.place) } };
    }
    if (args.action === "open") {
      if (!args.picture) throw fail("invalid_input", { field: "picture", what: "open needs the picture the place is made from." });
      const pic = await existingKind(args.picture, "picture", "image");
      if (!pic.info.width || !pic.info.height) throw fail("file_wrong_type", { field: "picture", what: "Crackio couldn't read that picture's size." });
      const made = await openPlace({ url: pic.url, width: pic.info.width, height: pic.info.height });
      const view = seen(made.shown, made.pose, ctx, "The camera's view, from where the photo was taken.");
      return {
        data: { place: made.place, built_in_seconds: made.seconds, camera: view.camera, note: "Gray or black areas are where the photo shows nothing: they're drawn in when you shoot. The place closes after 15 minutes without use." },
        images: view.images,
      };
    }

    if (!args.place) throw fail("invalid_input", { field: "place", what: `${args.action} needs "place": the id open gave.`, allowed: openPlaces().map((p) => p.place) });

    if (args.action === "camera") {
      const { reset, angle, shot, turn, turn_by, height, closer, lens, roll } = args;
      const moved = [reset, angle, shot, turn, turn_by, height, closer, lens, roll].some((v) => v !== undefined);
      const now = moved ? await moveCamera(args.place, { reset, angle, shot, turn, turn_by, height, closer, lens, roll }) : await viewOf(args.place);
      const view = seen(now.shown, now.pose, ctx, "The camera's view now.");
      return { data: { place: args.place, camera: view.camera }, images: view.images };
    }

    // shoot
    await checkMachine(args.machine, ctx.prefs);
    const set = await shotModel(args.place, args.model, args.size);
    if (!set.model || set.model === "auto") {
      throw fail("model_not_installed", { what: "None of the Director's shot models can run now.", do: "Call status: the machine with them may be off. Or ask the user to set the Director up in Crackio → Settings → Tools." });
    }
    const model = await chooseModel("image", set.model, ctx.prefs);
    const plan = await planJob(model, { kind: "image", aspect: set.aspect as AspectId, count: 1, references: 1, resolution: args.size ?? "2k", machine: args.machine }, ctx.prefs);
    plan.notes = ["A shot from a camera moved off the photo's spot is drawn in two or three steps: allow more than the estimate."];
    if (args.dry_run) return dryAnswer(plan);
    requireConfirm("director", args, plan);
    const job = await shoot(args.place, { notes: args.prompt?.trim() ?? "", machine: plan.machine?.id, mark: agentMark(ctx.caller) });
    return answerJob([job], args.wait ?? 20, args.show ?? true, ctx, { started: startedView(job, plan), next: "The finished shot can open a clip: pass its file as start to make_video." });
  },
});
