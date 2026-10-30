import { nanoid } from "nanoid";
import { z } from "zod";
import { saveGeneration } from "@/lib/server/db";
import { runner } from "@/lib/server/runner";
import { saveFileUpload, saveUpload, urlToPath } from "@/lib/server/media";
import { ClipError, prepareClip } from "@/lib/server/clip";
import fs from "node:fs/promises";
import { getCharacter, sheetViews } from "@/lib/server/cast";
import { withSubjectMatte } from "@/lib/server/vision";
import { describePhoto } from "@/lib/server/template-describe";
import { askText } from "@/lib/engines/refine";
import { customModel, isCustomId } from "@/lib/models/custom";
import { LOCAL_RIPPLE_ID, LOCAL_SWAP_IDS } from "@/lib/models/catalog";
import { imageSlots } from "@/lib/models/caps";
import { listModels } from "@/lib/models/resolve";
import { templateById } from "@/lib/templates/library";
import { shotPrompt, swapPrompt, type SlotFill } from "@/lib/templates/prompt";
import { clipLimit, profileOf } from "@/lib/templates/models";
import { ASPECTS, type AspectId } from "@/lib/shot";
import type { Generation, ReferenceRef } from "@/lib/generations/types";
import { demoJob } from "@/lib/demo/gate";
import { priceGeneration, priceSwap } from "@/lib/demo/prices";

const Point = z.object({ t: z.number().min(0).max(36_000), x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

const Slot = z.object({
  /** A photo you uploaded, or one of your Cast characters (its sheet and portrait go along). */
  image: z.string().max(500).optional(),
  cast: z.string().max(40).optional(),
  /** What the photo shows, as read (and maybe corrected) on the page; read here when missing. */
  noun: z.string().max(120).optional(),
  look: z.string().max(1200).optional(),
  traits: z.string().max(400).optional(),
  wearing: z.string().max(500).optional(),
  outfit: z.enum(["trend", "own"]).optional(),
  /** Your own clip: who or what this replaces. */
  target: z.string().max(300).optional(),
  /** Where you clicked what this replaces: a time in the clip (seconds) and a point on its frame (0–1 across and down), or several on one frame. */
  pick: z
    .union([Point, z.array(Point).min(1).max(5)])
    .optional()
    .transform((p) => (p ? (Array.isArray(p) ? p : [p]) : undefined)),
});

const Body = z.object({
  template: z.string().min(1).max(60),
  model: z.string().max(300).default("auto"),
  slots: z.record(z.string(), Slot).default({}),
  fields: z.record(z.string(), z.string().max(200)).default({}),
  /** Swaps: your own clip instead of the template's. */
  clip: z.object({ url: z.string().max(500), start: z.number().min(0).max(36_000).default(0) }).optional(),
  /** Swaps on the template's clip, when the model takes less than all of it: where its part starts. */
  start: z.number().min(0).max(600).optional(),
  options: z
    .object({
      resolution: z.string().max(20).optional(),
      duration: z.number().min(1).max(60).optional(),
      sound: z.boolean().optional(),
      aspectValue: z.string().max(40).optional(),
      /** LTX-2.5 Ripple: each pass finished by LTX's ×2 latent upscaler, on the clip at up to 1080p. */
      sharp: z.boolean().optional(),
      /** LTX-2.5 Ripple, each step switchable (benchmarks): the best frame, the zoomed redraw, takes, the paste-back. */
      ripple: z.object({ best: z.boolean(), zoom: z.boolean(), keep: z.boolean(), tries: z.number().int().min(1).max(4), v1: z.boolean() }).partial().optional(),
    })
    .default({}),
  /** The prompt as you edited it on the page (otherwise it's written here). */
  prompt: z.string().trim().max(6000).optional(),
  extra: z.string().max(600).optional(),
  /** Everyone in the photos agreed, and is an adult. */
  consent: z.boolean().default(false),
});

const aspectFor = (ratio: number): AspectId =>
  ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

/**
 * A picture stored with its subject's cutout matte as alpha (as-is: re-encoding could drop the alpha). Without a
 * clear subject, the plain picture; or nothing, when `mattedOnly` (an extra view is no use without its matte).
 */
async function mattedUpload(picture: Buffer, mattedOnly = false) {
  const saved = await saveUpload(picture).catch(() => null);
  const savedFile = saved ? urlToPath(saved.url) : null;
  const matted = savedFile ? await withSubjectMatte(savedFile).catch(() => null) : null;
  if (matted) return saveFileUpload(matted, "png", "file").catch(() => null);
  return mattedOnly ? null : saved;
}

/** Make a template: read your photos, write the exact prompt for the model you picked, and queue it as a take. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const body = parsed.data;
  const t = templateById(body.template);
  if (!t) return Response.json({ error: "Unknown template." }, { status: 404 });
  const swap = t.kind === "swap";
  if (t.slots.some((s) => s.kind === "person" || s.kind === "face") && !body.consent) {
    return Response.json({ error: "Confirm that everyone in the photos agreed to this and is an adult." }, { status: 400 });
  }

  // The model, and what it accepts. Swaps run on a clip editor (Comfy Router's, or the swap on your own ComfyUI); effects and kits on any video model.
  const local = LOCAL_SWAP_IDS.includes(body.model);
  // LTX-2.5 Ripple: your picture model redraws the clip's first frame from each character's sheet and close-up.
  const ripple = body.model === LOCAL_RIPPLE_ID;
  if (swap && !isCustomId(body.model) && !local) return Response.json({ error: "Pick a model for the swap: the one on your own ComfyUI, or a Comfy Router clip editor." }, { status: 400 });
  if (local) {
    const m = (await listModels()).find((x) => x.id === body.model);
    if (!m?.available) return Response.json({ error: `${m?.name ?? "This model"} can't run here: ${m?.reason ?? "ComfyUI isn't answering"}.` }, { status: 400 });
  }
  const custom = isCustomId(body.model) ? await customModel("video", body.model).catch(() => null) : null;
  if (isCustomId(body.model)) {
    if (!custom) return Response.json({ error: "Unknown model." }, { status: 400 });
    if (!custom.available) return Response.json({ error: `${custom.name} can't run here: ${custom.reason}.` }, { status: 400 });
    if (swap && !custom.caps?.video) return Response.json({ error: `${custom.name} doesn't edit clips. Pick one of the models listed for this template.` }, { status: 400 });
  }
  const caps = custom?.caps ?? (await listModels()).find((m) => m.id === body.model)?.caps ?? null;
  const takesPictures = Boolean(caps && imageSlots(caps) > 0);
  const room = caps ? imageSlots(caps) : 0;

  // Your photos (or Cast characters), each with what it shows.
  const fills: SlotFill[] = [];
  const references: ReferenceRef[] = [];
  /** Your own ComfyUI's swap: more views of each character, in the order of `references`. */
  const views: string[][] = [];
  for (const slot of t.slots) {
    const s = body.slots[slot.id];
    if (!s?.image && !s?.cast) {
      if (slot.optional) continue;
      return Response.json({ error: `Add ${slot.label.toLowerCase() === "you" ? "your photo" : `a photo for “${slot.label}”`} first.` }, { status: 400 });
    }
    const character = s.cast ? await getCharacter(s.cast) : null;
    if (s.cast && !character) return Response.json({ error: "That Cast character is gone." }, { status: 400 });
    const photo = character ? (character.portrait ?? character.photos[0] ?? character.sheet) : s.image;
    const file = photo ? urlToPath(photo) : null;
    if (!photo || !file) return Response.json({ error: "Upload the photo first." }, { status: 400 });
    let { noun, look, traits, wearing } = s;
    if (!look?.trim()) {
      const read = await describePhoto(file, slot.kind).catch(() => null);
      if (!read && !character?.traits) return Response.json({ error: "No text model could read the photo. Describe it on the page and try again." }, { status: 502 });
      noun ??= read?.noun ?? "a person";
      look = read?.look ?? character?.traits ?? "";
      traits ??= read?.traits;
      wearing ??= read?.wearing ?? "";
    }
    // A Cast sheet (front, three-quarter and profile) shows the model one person from every side. SCAIL-2 tracks the
    // person in its reference picture and wants exactly one full-body figure: the sheet's front view, cut out. The
    // portrait and the other two views go along as extra views of the same character (SCAIL-2 takes those too).
    // Every figure carries its cutout matte as alpha, so SCAIL-2 knows exactly which pixels are the character
    // (SAM 3.1 sees a pumpkin head as a pumpkin, not a person).
    const scail = local && !ripple;
    const sheet = Boolean(character?.sheet) && takesPictures && (!local || ripple);
    const sheetFile = scail && character?.sheet ? urlToPath(character.sheet) : null;
    const sheetCut = sheetFile ? await sheetViews(sheetFile).catch(() => null) : null;
    const figure = !scail ? null : (sheetCut?.[0] ?? (await fs.readFile(file).catch(() => null)));
    let localRef: string | undefined;
    const moreViews: string[] = [];
    if (figure) {
      localRef = (await mattedUpload(figure))?.url;
      const portrait = character?.portrait ? urlToPath(character.portrait) : null;
      const more = [portrait ? await fs.readFile(portrait).catch(() => null) : null, ...(sheetCut?.slice(1) ?? [])];
      for (const view of more) {
        const up = view ? await mattedUpload(view, true) : null;
        if (up) moreViews.push(up.url);
      }
    }
    const picture = references.length + 1;
    if (takesPictures) {
      references.push({ url: sheet ? character!.sheet! : (localRef ?? photo), label: `${slot.label}${character ? ` (${character.name})` : ""}`, role: slot.kind === "object" ? "product" : slot.kind === "place" ? "place" : "subject" });
      if (ripple) views.push(sheet && character?.portrait ? [character.portrait] : []);
      else if (local) views.push(moreViews);
    }
    fills.push({
      slot,
      noun: noun?.trim() || "a person",
      look: look.trim(),
      traits: traits?.trim() || undefined,
      wearing: wearing?.trim() ?? "",
      outfit: s.outfit ?? slot.outfit?.default ?? "own",
      name: character?.name,
      picture: takesPictures ? picture : undefined,
      sheet,
      // Your own clip's target, or whoever you clicked in the template's clip.
      target: body.clip || s.pick ? s.target?.trim() || undefined : undefined,
    });
  }
  if (takesPictures && references.length > room) {
    return Response.json({ error: `${custom?.name ?? "This model"} takes ${room} picture${room === 1 ? "" : "s"}; this template needs ${references.length}. Pick another model.` }, { status: 400 });
  }
  if (caps && (caps.image?.required || caps.refs?.required) && !references.length && swap) {
    return Response.json({ error: `${custom?.name ?? "This model"} needs a reference picture.` }, { status: 400 });
  }

  // How this model names its inputs, what else it wants, and its shortest clip.
  const profile = profileOf(body.model, takesPictures);
  const extra = { ...profile.extra, ...profile.extraFor?.[t.slots[0]?.kind ?? "person"] };
  let prompt = body.prompt?.trim() || (swap ? swapPrompt(t, fills, profile, { ownClip: Boolean(body.clip), extra: body.extra }) : shotPrompt(t, fills, body.fields));
  // Kits: a text model writes the beats and voiceover from your blanks.
  if (t.writer && prompt.includes("{script}")) {
    const blanks = (t.fields ?? []).map((f) => `${f.label}: ${(body.fields[f.id] ?? "").trim() || f.examples[0]}`).join("\n");
    const script = await askText({ instructions: t.writer, text: blanks, effort: "low", timeoutMs: 60_000 }).catch(() => null);
    if (!script) return Response.json({ error: "No text model answered to write the script. Add a Comfy key in Connections, or install a text model on the Local page." }, { status: 502 });
    prompt = prompt.replace("{script}", script.trim());
  }
  const names = fills.map((f) => f.name ?? f.slot.label).join(" & ");
  const label = `${t.title}${names ? ` · ${names}` : ""}`;

  if (swap) {
    // The template's clip, or yours: trimmed to what the editor accepts.
    const source = body.clip?.url ?? t.base?.url;
    const file = source ? urlToPath(source) : null;
    if (!source || !file) return Response.json({ error: body.clip ? "Upload the clip first." : "This template has no clip yet. Bring your own." }, { status: 400 });
    const limits = caps?.video?.limits;
    // A little under what the model takes, so rounding can't push the clip over.
    const maxSeconds = Math.max(1, (clipLimit(body.model, caps) ?? 30) - 0.1);
    const minSeconds = Math.max(limits?.minDuration ?? 0, profile.minSeconds ?? 0) || undefined;
    // On the template's clip, a model that takes less than all of it gets the part you picked (or the template's best part).
    const start = body.clip ? body.clip.start : (t.base?.seconds ?? 0) > maxSeconds ? (body.start ?? t.base?.focus ?? 0) : 0;
    let clip: Awaited<ReturnType<typeof prepareClip>>;
    try {
      // A clip shorter than the model takes is held on its last frame, and the result is cut back to its length.
      // Your own ComfyUI makes the swapped people inside a 720p clip (its resolution sets how much detail they get) and
      // pastes them back onto it.
      // Ripple's sharp mode finishes at up to 1080p, so it gets the clip at that size.
      const box = local && !(ripple && body.options.sharp) ? 1280 : 1920;
      clip = await prepareClip(file, { start, maxSeconds, minSeconds, pad: true, box, fps: profile.fps, model: custom?.name });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: err instanceof ClipError ? err.status : 422 });
    }
    const id = nanoid(14);
    // The live demo: a signed-in code, one job at a time, paid in credits (lib/demo).
    const demo = await demoJob(request, id, () => priceSwap(clip.length));
    if (demo.response) return demo.response;
    const gen: Generation = {
      id,
      tool: "templates",
      engine: "auto",
      model: body.model,
      status: "queued",
      prompt: label,
      compiledPrompt: prompt,
      aspect: aspectFor(clip.width / clip.height),
      count: 1,
      references,
      outputs: [],
      params: {
        kind: "video",
        refine: false,
        videoUrl: clip.url,
        sourceUrl: source,
        start: clip.start,
        length: clip.length,
        padded: clip.padded,
        template: t.id,
        templateTitle: t.title,
        options: {
          ...((body.options.resolution ?? profile.resolution) ? { resolution: body.options.resolution ?? profile.resolution } : {}),
          ...(local ? { duration: clip.length } : {}),
          // SCAIL-2 finds each character in its reference picture by what it is ("a pumpkin-headed scarecrow"), not only "human",
          // and sees each one from more sides when there are more views.
          // and is given each character drawn in the pose of the person it replaces (where a picture model can).
          // Ripple's first frame is redrawn from each one's look and what they wear (the trend's costume, or their own clothes).
          ...(Object.keys(extra).length || local
            ? {
                extra: {
                  ...extra,
                  ...(local ? { subjects: fills.map((f) => f.noun), views, pose: true, targets: fills.map((f) => f.target ?? f.slot.target) } : {}),
                  ...(ripple
                    ? {
                        looks: fills.map((f) => f.traits || f.look),
                        wearing: fills.map((f) => (f.outfit === "trend" && f.slot.outfit?.trend ? f.slot.outfit.trend : f.wearing)),
                        kinds: fills.map((f) => f.slot.kind),
                        // What you clicked, on the clip as cut: the first slot clicked, and each character's own
                        // (several characters are each followed and redrawn when every one is clicked).
                        ...(() => {
                          const cut = (pick: { t: number; x: number; y: number }[]) => pick.map((p) => ({ ...p, t: Math.max(0, pick[0].t - clip.start) }));
                          const pick = t.slots.map((s) => body.slots[s.id]?.pick).find(Boolean);
                          const each = fills.map((f) => body.slots[f.slot.id]?.pick);
                          return {
                            ...(pick ? { picks: cut(pick) } : {}),
                            ...(fills.length > 1 && each.every((p) => p?.length) ? { slotPicks: each.map((p) => cut(p!)) } : {}),
                          };
                        })(),
                        ...(body.options.sharp ? { sharp: true } : {}),
                        ...body.options.ripple,
                      }
                    : {}),
                },
              }
            : {}),
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

  // Effects and kits: your photo opens the clip (effects), the template's words make the rest.
  const start = t.kind === "effect" ? body.slots[t.slots[0]?.id ?? ""] : undefined;
  const startUrl = start?.cast ? ((await getCharacter(start.cast))?.portrait ?? undefined) : start?.image;
  const id = nanoid(14);
  const duration = body.options.duration ?? t.seconds ?? 6;
  const demo = await demoJob(request, id, () =>
    priceGeneration("templates", 1, { kind: "video", options: { duration, ...(body.options.resolution ? { resolution: body.options.resolution } : {}) } }),
  );
  if (demo.response) return demo.response;
  const gen: Generation = {
    id,
    tool: "templates",
    engine: "auto",
    model: body.model,
    status: "queued",
    prompt: label,
    compiledPrompt: prompt,
    aspect: t.aspect,
    count: 1,
    references: startUrl ? [{ url: startUrl, label: "the start frame", role: "subject" }] : [],
    outputs: [],
    params: {
      kind: "video",
      refine: false,
      ...(startUrl ? { startUrl } : {}),
      template: t.id,
      templateTitle: t.title,
      options: {
        duration,
        ...(body.options.resolution ? { resolution: body.options.resolution } : {}),
        sound: body.options.sound ?? t.sound ?? true,
        ...(body.options.aspectValue ? { aspectValue: body.options.aspectValue } : {}),
        ...(startUrl ? { cropFrames: true } : {}),
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
