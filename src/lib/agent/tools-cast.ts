import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { defaultViews, formatHeight, toHandle, type Character, type SheetView } from "@/lib/cast/types";
import { createCharacter, deleteCharacter, getCharacter, listCharacters, updateCharacter } from "@/lib/server/cast";
import { characterByHandle } from "@/lib/server/cast-store";
import { urlToPath } from "@/lib/server/media";
import { fail } from "./errors";
import { allMade, forgetMade, madeBy, noteMade } from "./made";
import { sheet, small } from "./pictures";
import { chooseModel, nearest, planJob, requireConfirm } from "./plan";
import { agentSecret } from "./prefs";
import { confirm, dryAnswer, dryRun, existingKind, fileArg, tool, type ToolContext } from "./shared";
import { castFrameModel } from "./tools-create";

/**
 * Cast: the people, pets, characters and things that come back in shot after shot. A member is named in any prompt as
 * @handle and Crackio brings its pictures along. Agents list and view all of them, and change or delete only the ones
 * an agent made.
 */

const VIEWS = ["front", "three-quarter", "side", "back"] as const;

async function member(handle: string | undefined): Promise<Character> {
  if (!handle) throw fail("invalid_input", { field: "handle", what: "Say which Cast member: its handle." });
  const h = handle.replace(/^@/, "").toLowerCase();
  const c = characterByHandle(h);
  if (c) return (await getCharacter(c.id)) ?? c;
  const all = await listCharacters();
  throw fail("cast_not_found", { field: "handle", what: `There's no Cast member "@${h.slice(0, 40)}".`, did_you_mean: nearest(h, all.map((x) => ({ id: `@${x.handle}`, name: x.name }))) });
}

const row = (c: Character, by: string | null) => ({
  handle: `@${c.handle}`,
  name: c.name,
  kind: c.kind,
  status: c.status,
  ...(c.status === "building" && c.progress != null ? { progress: Math.round(c.progress * 100) / 100 } : {}),
  made_by: by ?? "the user",
});

const detail = (c: Character, by: string | null) => ({
  ...row(c, by),
  ...(c.noun ? { is: c.noun } : {}),
  ...(c.traits ? { looks: c.traits } : {}),
  ...(c.notes ? { always_keep: c.notes } : {}),
  ...(c.height ? { height: formatHeight(c.height) } : {}),
  ...(c.error ? { problem: c.error } : {}),
  ...(c.portrait ? { portrait: c.portrait } : {}),
  ...(c.sheet ? { sheet: c.sheet } : {}),
  ...(c.photos.length ? { photos: c.photos } : {}),
  ...(c.builtWith ? { drawn_by: c.builtWith } : {}),
  use: `Write @${c.handle} in a make_image or make_video prompt.`,
});

/** A member that an agent made, or the failure that says agents leave the user's own alone. */
async function mine(c: Character, doing: string) {
  const by = await madeBy("cast", c.id);
  if (!by) throw fail("not_yours", { what: `${c.name} was added by the user, not by an agent: agents don't ${doing} those.` });
  return by;
}

const deleteToken = (id: string) => createHmac("sha256", agentSecret()).update(`delete-cast:${id}`).digest("hex").slice(0, 10);

async function waitBuilt(id: string, seconds: number, signal: AbortSignal) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const c = await getCharacter(id);
    if (!c || c.status !== "building" || Date.now() >= until || signal.aborted) return c;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function shownMember(c: Character, ctx: ToolContext) {
  if (!ctx.prefs.seePictures) return [];
  const files = [c.portrait, c.sheet].map((u) => (u ? urlToPath(u) : null));
  const tiles = [
    ...(files[0] ? [{ file: files[0], label: "portrait" }] : []),
    ...(files[1] ? [{ file: files[1], label: "sheet" }] : []),
  ];
  if (!tiles.length) return [];
  const s = tiles.length === 1 ? await small(tiles[0].file, 768) : await sheet(tiles, { edge: 1280, cols: 2 });
  return [{ ...s, label: `${c.name}: ${tiles.map((t) => t.label).join(" and ")}.` }];
}

export const cast = tool({
  name: "cast",
  title: "Cast",
  description: "The user's Cast: people, pets, characters and things kept consistent across shots, named in prompts as @handle. List them, view one with its pictures, create one from photos or a description, update or delete one an agent made.",
  input: z.object({
    action: z.enum(["list", "view", "create", "update", "delete"]).describe("What to do."),
    handle: z.string().max(41).optional().describe("view, update, delete: the member's @handle."),
    name: z.string().min(1).max(40).optional().describe("create, update: its name (the handle comes from it)."),
    kind: z.enum(["person", "pet", "character", "object"]).optional().describe("create: what it is (default person)."),
    photos: z.array(fileArg("Path.")).max(4).optional().describe("create: 1–4 pictures of it. Without photos, give description."),
    description: z.string().max(1200).optional().describe("create without photos: how it looks, in full."),
    notes: z.string().max(400).optional().describe('create, update: what to always keep ("round glasses", "a scar over the left eyebrow").'),
    looks: z.string().max(600).optional().describe("update: its lasting look, one sentence."),
    height_m: z.number().positive().max(200).optional().describe("create, update: real height in meters, when known."),
    views: z.array(z.enum(VIEWS)).min(1).max(4).optional().describe("create: the sides to draw (default front, side, back)."),
    model: z.string().max(300).optional().describe("create: the image model that draws it. Default: Crackio's pick among those you may use."),
    wait: z.number().min(0).max(50).optional().describe("create, view: seconds to wait while it's being drawn (default 0)."),
    dry_run: dryRun,
    confirm,
  }),
  files: ["photos.*"],
  destructive: true,
  async run(args, ctx) {
    if (args.action === "list") {
      const [all, made] = await Promise.all([listCharacters(), allMade("cast")]);
      // One short line each: a long Cast is listed in a few hundred tokens. cast view has the rest.
      const line = (c: Character) => `@${c.handle} · ${c.name} · ${c.kind}${c.status === "ready" ? "" : ` · ${c.status}`}${made[c.id] ? ` · made by ${made[c.id]}` : ""}`;
      return { data: { cast: all.map(line), ...(all.length ? { note: "Members without \"made by\" are the user's own: use them, don't change them." } : { note: "No Cast yet. Create one from photos or a description." }) } };
    }

    if (args.action === "view") {
      let c = await member(args.handle);
      if (args.wait && c.status === "building") c = (await waitBuilt(c.id, args.wait, ctx.signal)) ?? c;
      return { data: detail(c, await madeBy("cast", c.id)), images: await shownMember(c, ctx) };
    }

    if (args.action === "create") {
      if (!args.name) throw fail("invalid_input", { field: "name", what: "A Cast member needs a name." });
      const kind = args.kind ?? "person";
      const photos = await Promise.all((args.photos ?? []).map((p, i) => existingKind(p, `photos.${i}`, "image")));
      if (!photos.length && !args.description?.trim()) throw fail("invalid_input", { field: "photos", what: "Give 1–4 photos, or a description of how it looks." });
      if (!photos.length && args.description!.trim().length < 30) throw fail("invalid_input", { field: "description", what: "The description is too short to draw someone from.", do: "Say age, build, face, hair, skin and what they wear, in a sentence or two." });
      // The sides to draw, said by the agent or by Crackio's fixed rule: no text model plans them.
      const views: SheetView[] = args.views ?? defaultViews(kind, `${args.name} ${args.description ?? ""} ${args.notes ?? ""}`);
      const modelId = args.model ?? (await castFrameModel(ctx)) ?? undefined;
      const model = await chooseModel("image", modelId, ctx.prefs);
      if (photos.length && model.maxRefs < 1) throw fail("option_not_supported", { field: "model", what: `${model.name} takes no pictures, and a Cast member is drawn from its photos.`, do: "Leave model out, or pick one from models with references above 0." });
      const plan = await planJob(model, { kind: "image", aspect: "2:3", count: views.length + 1, references: Math.max(1, photos.length), resolution: "2k", unpinned: true }, ctx.prefs);
      plan.notes = [`${views.length + 1} pictures are drawn one after another: a portrait and ${views.length === 1 ? "one view" : `${views.length} views`} (${views.join(", ")}).`];
      if (args.dry_run) return dryAnswer(plan, { handle: `@${toHandle(args.name)}` });
      requireConfirm("cast", args, plan);
      const made = await createCharacter({
        name: args.name,
        kind,
        photos: photos.map((p) => p.url),
        description: args.description,
        notes: args.notes,
        model: model.id,
        ...(args.height_m ? { height: args.height_m, heightSet: true } : {}),
        views,
      });
      await noteMade("cast", made.id, ctx.caller.client);
      const now = args.wait ? ((await waitBuilt(made.id, args.wait, ctx.signal)) ?? made) : made;
      return {
        data: {
          ...detail(now, ctx.caller.client),
          ...(now.status === "building" ? { note: `Being drawn (about ${plan.seconds ?? "?"} s in all). Call cast view with wait until its status is "ready" before using @${now.handle}.` } : {}),
        },
        images: now.status === "ready" ? await shownMember(now, ctx) : [],
      };
    }

    const c = await member(args.handle);
    if (args.action === "update") {
      await mine(c, "change");
      const next = await updateCharacter(c.id, {
        ...(args.name ? { name: args.name, handle: args.name } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.looks !== undefined ? { traits: args.looks } : {}),
        ...(args.height_m ? { height: args.height_m } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
      });
      return { data: detail(next ?? c, await madeBy("cast", c.id)) };
    }

    await mine(c, "delete");
    const token = deleteToken(c.id);
    if (args.confirm !== token) throw fail("confirm_needed", { what: `Deleting ${c.name} (@${c.handle}) can't be undone. Takes made with it stay in the Library.`, confirm: token });
    deleteCharacter(c.id);
    await forgetMade("cast", c.id);
    return { data: { deleted: `@${c.handle}` } };
  },
});
