import { nanoid } from "nanoid";
import { z } from "zod";
import { saveGeneration } from "@/lib/server/db";
import { runner } from "@/lib/server/runner";
import { urlToPath } from "@/lib/server/media";
import { ClipError, prepareClip } from "@/lib/server/clip";
import { resolveMentions } from "@/lib/server/cast";
import { customModel, isCustomId } from "@/lib/models/custom";
import { ASPECTS } from "@/lib/shot";
import type { Generation, ReferenceRef } from "@/lib/generations/types";

/** The clip editor Recast runs on unless you pick another: Kling 3 Omni on Comfy Router. */
const DEFAULT_EDITOR = "comfy:kling/kling-v3-omni";
/** A clip editor's own longest input, else this. */
const DEFAULT_SECONDS = 30;

const Body = z.object({
  source: z.string().min(1).max(500),
  start: z.number().min(0).max(36_000).default(0),
  /** What changes, in plain words (built by the Recast page from the swap you picked). */
  prompt: z.string().trim().min(4).max(6000),
  /** A short label for the take ("Person → @mia"). */
  label: z.string().max(120).optional(),
  /** The clip editor: a Comfy Router video-to-video model. */
  model: z.string().max(300).default(DEFAULT_EDITOR),
  /** Pictures attached to changes, sent to models that take reference pictures. */
  images: z.array(z.string().max(500)).max(8).default([]),
});

/** Recast a clip: trim it to what the clip editor accepts, then queue the edit as a take. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const { source, start, prompt, label, images } = parsed.data;
  const file = urlToPath(source);
  if (!file) return Response.json({ error: "Upload the clip first." }, { status: 400 });

  // Which editor, and what it accepts.
  const custom = isCustomId(parsed.data.model) ? await customModel("video", parsed.data.model).catch(() => null) : null;
  if (!custom) return Response.json({ error: "Unknown model." }, { status: 400 });
  if (!custom.available) return Response.json({ error: `${custom.name} can't run here: ${custom.reason}.` }, { status: 400 });
  if (!custom.caps?.video) return Response.json({ error: `${custom.name} doesn't edit clips. Pick a video-to-video model.` }, { status: 400 });
  const limits = custom.caps.video.limits;
  const maxSeconds = Math.max(1, (limits?.maxDuration ?? DEFAULT_SECONDS) - 0.1);

  // An mp4 the editor accepts, up to 1080p (the engine fits each model's own limits).
  let clip: Awaited<ReturnType<typeof prepareClip>>;
  try {
    clip = await prepareClip(file, { start, maxSeconds, minSeconds: limits?.minDuration, box: 1920, model: custom.name });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: err instanceof ClipError ? err.status : 422 });
  }
  const { url: clipUrl, start: from, length } = clip;

  const ratio = clip.width / clip.height;
  const aspect = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best));

  // Models that take pictures get the attached ones and your @cast; others get the cast in words.
  const takesPictures = Boolean(custom.caps.image || custom.caps.refs);
  const attached: ReferenceRef[] = takesPictures
    ? images.filter((u) => urlToPath(u)).map((url) => ({ url, label: "how the changed part should look", role: "subject" as const }))
    : [];
  const mentioned = resolveMentions({ prompt: "", compiledPrompt: prompt, references: attached, kind: takesPictures ? "image" : "video" });
  const needs = custom.caps.image?.required || custom.caps.refs?.required;
  if (needs && !mentioned.references.length) {
    return Response.json({ error: `${custom.name} needs a reference picture: attach an image to a change, or @mention someone from your cast.` }, { status: 400 });
  }

  const gen: Generation = {
    id: nanoid(14),
    tool: "recast",
    engine: "auto",
    model: parsed.data.model,
    status: "queued",
    prompt: label ?? prompt,
    compiledPrompt: mentioned.compiledPrompt,
    aspect: aspect.id,
    count: 1,
    references: mentioned.references,
    outputs: [],
    params: { kind: "video", refine: false, videoUrl: clipUrl, sourceUrl: source, start: from, length, ...(mentioned.cast.length ? { cast: mentioned.cast } : {}) },
    progress: 0,
    stage: "Queued",
    createdAt: Date.now(),
  };
  saveGeneration(gen);
  runner().enqueue(gen.id);
  return Response.json({ item: gen }, { status: 201 });
}
