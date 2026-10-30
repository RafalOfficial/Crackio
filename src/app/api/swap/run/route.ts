import { nanoid } from "nanoid";
import { z } from "zod";
import { saveGeneration } from "@/lib/server/db";
import { runner } from "@/lib/server/runner";
import { urlToPath } from "@/lib/server/media";
import { ClipError, prepareClip } from "@/lib/server/clip";
import { getCharacter } from "@/lib/server/cast";
import { describePhoto } from "@/lib/server/template-describe";
import { LOCAL_RIPPLE_ID } from "@/lib/models/catalog";
import { listModels } from "@/lib/models/resolve";
import { ASPECTS, type AspectId } from "@/lib/shot";
import type { Generation, ReferenceRef } from "@/lib/generations/types";
import { demoOn } from "@/lib/demo/config";
import { demoJob } from "@/lib/demo/gate";
import { DEMO_LIMITS, priceSwap } from "@/lib/demo/prices";

const Point = z.object({ t: z.number().min(0).max(36_000), x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

/** One thing clicked in the clip and what it becomes. */
const Change = z.object({
  /** The click: when in the clip (seconds, from its very start) and where on that frame (0–1 across and down). */
  at: Point,
  /** What it is, in words ("the woman in the green sweater"), as named on the page. */
  what: z.string().trim().max(200).default(""),
  /** cast: one of your Cast; picture: a picture you added (a product, a car); words: anything you describe; remove: gone. */
  to: z.enum(["cast", "picture", "words", "remove"]),
  cast: z.string().max(40).optional(),
  image: z.string().max(500).optional(),
  words: z.string().trim().max(400).optional(),
});

const Body = z.object({
  clip: z.object({ url: z.string().min(1).max(500), start: z.number().min(0).max(36_000).default(0) }),
  changes: z.array(Change).max(4).default([]),
  /** A new place behind everything, in words. */
  background: z.string().trim().max(400).optional(),
  resolution: z.enum(["540p", "720p"]).default("720p"),
  /** Each pass finished by LTX's ×2 latent upscaler, on the clip at up to 1080p. */
  sharp: z.boolean().default(false),
  /** The whole frame is LTX-2.5's either way; on, everyone else is put back from the clip so their clothes stay. */
  lock: z.boolean().default(false),
  /** How much of the clip, from `start`. */
  seconds: z.number().min(1).max(20).default(15),
  /** Everyone in the pictures agreed, and is an adult. */
  consent: z.boolean().default(false),
  /** Where the clip came from (a preset's title), for the take's name. */
  title: z.string().trim().max(80).optional(),
  /** Fast draft: fewer steps and EasyCache (a quick look before the full swap). */
  fast: z.boolean().default(false),
  /** Benchmarks: Ripple's strength and steps, EasyCache's threshold, a redrawn frame to reuse. */
  ripple: z
    .object({ strength: z.number().min(0.3).max(2.5), steps: z.number().int().min(2).max(16), cache: z.number().min(0).max(3), firstFrame: z.string().max(500), inpaint: z.boolean(), zoom: z.boolean() })
    .partial()
    .optional(),
});

const aspectFor = (ratio: number): AspectId =>
  ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

const PERSON = /\b(man|woman|person|girl|boy|guy|lady|child|kid|teen|people|someone|dancer|singer|model)\b/i;
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * Swap things in a clip on your own GPU: everything you clicked is outlined by SAM 3.1 through the clip, the frame where
 * it shows best is redrawn with each change, and LTX-2.5 with the Ripple IC-LoRA carries that through every frame; the
 * rest of the clip, its motion and its sound stay exactly as they were. Queued as a take.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const body = parsed.data;
  // The live demo swaps a shorter part of the clip (lib/demo).
  if (demoOn()) body.seconds = Math.min(body.seconds, DEMO_LIMITS.swapSeconds);
  const background = body.background?.trim() ?? "";
  if (!body.changes.length && !background) return Response.json({ error: "Click something in the clip and pick what it becomes." }, { status: 400 });
  const file = urlToPath(body.clip.url);
  if (!file) return Response.json({ error: "Upload the clip first." }, { status: 400 });
  const model = (await listModels()).find((m) => m.id === LOCAL_RIPPLE_ID);
  if (!model?.available) return Response.json({ error: `${model?.name ?? "LTX-2.5 Ripple"} can't run here: ${model?.reason ?? "ComfyUI isn't answering"}.` }, { status: 400 });
  if (body.changes.some((c) => c.to === "cast" || c.to === "picture") && !body.consent) {
    return Response.json({ error: "Confirm that everyone in the pictures agreed to this and is an adult." }, { status: 400 });
  }

  let clip: Awaited<ReturnType<typeof prepareClip>>;
  try {
    // A clip shorter than LTX takes is held on its last frame, and the result is cut back to its length.
    clip = await prepareClip(file, { start: body.clip.start, maxSeconds: body.seconds - 0.1, pad: true, box: body.sharp ? 1920 : 1280, fps: 24, model: "LTX-2.5 Ripple" });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof ClipError ? err.status : 422 });
  }

  // What each change becomes: Cast members and pictures go along as references (a Cast sheet, then its portrait).
  const references: ReferenceRef[] = [];
  const views: string[][] = [];
  const edits: Record<string, unknown>[] = [];
  const said: string[] = [];
  const names: string[] = [];
  for (const c of body.changes) {
    const what = c.what || "the one clicked";
    const base = { at: { ...c.at, t: Math.max(0, c.at.t - clip.start) }, what };
    if (c.to === "remove") {
      edits.push({ ...base, to: "remove" });
      said.push(`${cap(what)} is gone.`);
      names.push("removed");
      continue;
    }
    if (c.to === "words") {
      if (!c.words) return Response.json({ error: `Say what ${what} becomes.` }, { status: 400 });
      edits.push({ ...base, to: "words", words: c.words });
      said.push(`${cap(what)}: ${c.words.replace(/[.\s]+$/, "")}.`);
      names.push(c.words.length > 28 ? `${c.words.slice(0, 26)}…` : c.words);
      continue;
    }
    if (c.to === "cast") {
      const character = c.cast ? await getCharacter(c.cast) : null;
      if (!character) return Response.json({ error: "That Cast member is gone." }, { status: 400 });
      const photo = character.sheet ?? character.portrait ?? character.photos[0];
      if (!photo || !urlToPath(photo)) return Response.json({ error: `${character.name} has no pictures yet.` }, { status: 400 });
      references.push({ url: photo, label: character.name, role: character.kind === "object" ? "product" : "subject" });
      views.push(character.sheet && character.portrait ? [character.portrait] : []);
      const noun = character.noun ?? (character.kind === "object" ? "object" : character.kind === "pet" ? "animal" : "character");
      const look = character.traits ?? character.description ?? "";
      edits.push({ ...base, to: "cast", ref: references.length - 1, noun, look, wearing: "", kind: character.kind === "character" ? "person" : character.kind });
      said.push(`${cap(what)} is now ${character.name}, ${noun}${look ? `: ${look.replace(/[.\s]+$/, "")}` : ""}.`);
      names.push(character.name);
      continue;
    }
    const picture = c.image ? urlToPath(c.image) : null;
    if (!picture) return Response.json({ error: "Upload the picture first." }, { status: 400 });
    const read = await describePhoto(picture, "object").catch(() => null);
    const noun = read?.noun?.trim() || "thing";
    references.push({ url: c.image!, label: "what it becomes", role: "product" });
    views.push([]);
    edits.push({ ...base, to: "cast", ref: references.length - 1, noun, look: read?.look ?? "", wearing: "", kind: PERSON.test(noun) ? "person" : "object" });
    said.push(`${cap(what)} is now ${noun}${read?.look ? `: ${read.look.replace(/[.\s]+$/, "")}` : ""}.`);
    names.push(noun.replace(/^(a|an|the)\s+/i, ""));
  }
  if (background) said.push(`The background is now ${background.replace(/[.\s]+$/, "")}.`);
  const label = `${body.title ?? "Swap"} · ${[...names, ...(background ? ["new background"] : [])].join(", ")}`.slice(0, 120);

  const id = nanoid(14);
  // The live demo: a signed-in code, one job at a time, paid in credits (lib/demo).
  const demo = await demoJob(request, id, () => priceSwap(clip.length));
  if (demo.response) return demo.response;

  const gen: Generation = {
    id,
    tool: "recast",
    engine: "auto",
    model: LOCAL_RIPPLE_ID,
    status: "queued",
    prompt: label,
    compiledPrompt: said.join(" "),
    aspect: aspectFor(clip.width / clip.height),
    count: 1,
    references,
    outputs: [],
    params: {
      kind: "video",
      refine: false,
      videoUrl: clip.url,
      sourceUrl: body.clip.url,
      start: clip.start,
      length: clip.length,
      padded: clip.padded,
      // The clip's own sound, laid back over the swap.
      keepSound: true,
      swap: { changes: body.changes, background, title: body.title },
      options: {
        resolution: body.resolution,
        duration: clip.length,
        extra: {
          edits,
          views,
          ...(background ? { background } : {}),
          // Only a new background, nothing clicked: the first frame is redrawn from the words.
          ...(!edits.length && background ? { instruction: `Replace the background with ${background.replace(/[.\s]+$/, "")}, keeping every person and thing in front exactly as they are` } : {}),
          ...(body.sharp ? { sharp: true } : {}),
          ...(body.lock ? { keep: true } : {}),
          // Fast draft: one redraw take (no vision pick), 5 steps and EasyCache.
          ...(body.fast ? { steps: 5, cache: 0.2, tries: 1 } : {}),
          // Only removals: Lightricks' in/outpainting IC-LoRA fills each one's tracked outline on every frame, a clean
          // plate (over the whole frame Ripple brought the removed woman back at a table behind, on Café Duo).
          ...(edits.length && edits.every((e) => e.to === "remove") && !background && !body.sharp ? { inpaint: true } : {}),
          ...body.ripple,
        },
      },
    },
    progress: 0,
    stage: "Queued",
    createdAt: Date.now(),
    ...(demo.owner ? { owner: demo.owner } : {}),
  };
  saveGeneration(gen);
  runner().enqueue(gen.id);
  return Response.json({ item: gen }, { status: 201 });
}
