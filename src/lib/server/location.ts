import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import { sizeFor } from "@/lib/shot";
import { EngineError, type EngineContext, type EngineJob, type EngineResult } from "@/lib/engines/types";

const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "director");

/** Words that ask for a drawn look; anything else is a photograph. */
const DRAWN_LOOK = /\b(anime|cartoon|illustrat\w*|paint(ed|ing)|watercolou?r|pixel ?art|3d render|cgi|pixar|claymation|comic|sketch\w*|stylized|ghibli|low[- ]poly|voxel)\b/i;

/**
 * A place made from words ("a rainy neon alley at night"): one wide picture, empty and level, that the 360 world is
 * built from like a photo of your own (server/world). Wide (21:9) so the world draws as little as it can on its own;
 * empty so there is nothing to lift out and the cast has the floor to itself. An editor that can't draw from words
 * paints it over a blank picture.
 */
export async function makeLocation(words: string, model: string, signal: AbortSignal, machine?: string, resolution?: string) {
  const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry")]);
  const def = await resolveModel("image", model);
  const engine = def.via ? engineFor(def.via) : null;
  if (!engine) throw new EngineError(`${def.name} has no engine connected.`, "Open Connections.");
  const what = words.trim().replace(/[.\s]+$/, "");
  const prompt =
    `A wide establishing ${DRAWN_LOOK.test(what) ? "picture" : "photograph"} of ${what}. ` +
    "Taken from eye level, about 1.6 m above the floor, with a wide-angle lens held level: the horizon is straight and vertical lines stay vertical. " +
    "The floor shows across the bottom of the frame and everything is in focus out to the far distance. " +
    "The place is empty and ready for a scene: nobody in it, no animals, nothing standing in the open floor in front of the camera. " +
    "Natural, believable light. No text, no watermark, no border.";
  // As big as asked (4K: a 3840 wide picture, the model's full version), 2K otherwise.
  const { width, height } = sizeFor("21:9", resolution === "4k" ? 3840 : 2048);
  const job: EngineJob = {
    kind: "image",
    model: def.model,
    via: def.via ?? undefined,
    family: def.family,
    caps: def.caps ?? undefined,
    options: { ...(machine ? { machine } : {}), ...(resolution ? { resolution } : {}) },
    prompt,
    userPrompt: prompt,
    refine: false,
    aspect: "21:9",
    width,
    height,
    count: 1,
    references: [],
    mode: "image",
  };
  const ctx: EngineContext = { signal, progress: () => undefined };
  const began = Date.now();
  let result: EngineResult;
  try {
    result = await engine.run(job, ctx);
  } catch (err) {
    if (signal.aborted || !/edits pictures|add the one to change/i.test((err as Error).message)) throw err;
    await fs.mkdir(DIR, { recursive: true });
    const blank = path.join(DIR, `location-blank-${Date.now().toString(36)}.png`);
    await sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toFile(blank);
    try {
      const over = `Replace this blank gray picture completely. ${prompt}`;
      result = await engine.run({ ...job, prompt: over, userPrompt: over, references: [{ path: blank, label: "blank canvas", role: "edit-target" }] }, ctx);
    } finally {
      await fs.rm(blank, { force: true });
    }
  }
  if (!result.outputs[0]) throw new EngineError("The model returned nothing.");
  const saved = await saveFull(result.outputs[0].data, width, height);
  // Kept with the world builds' times: a new place's estimate is both.
  void import("./world").then(({ keepTime }) => keepTime("photo", (Date.now() - began) / 1000, { model: job.model, resolution: resolution ?? null }));
  return saved;
}

/** Saved as big as it was made (uploads are capped at 2560 wide, which would undo a 4K place). */
async function saveFull(data: Buffer, width: number, height: number) {
  const name = `${nanoid(12)}.jpg`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name), await sharp(data).resize(width, height, { fit: "cover" }).jpeg({ quality: 93 }).toBuffer());
  return { url: `/api/media/uploads/${name}`, width, height };
}

