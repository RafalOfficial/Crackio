import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { UPLOADS_DIR } from "./paths";
import { urlToPath } from "./media";
import { sizeFor, type AspectId } from "@/lib/shot";
import { EngineError, type EngineContext, type EngineJob } from "@/lib/engines/types";

/** Words that ask for a drawn look; anything else is a photograph. */
const DRAWN_LOOK = /\b(anime|cartoon|illustrat\w*|paint(ed|ing)|watercolou?r|pixel ?art|3d render|cgi|pixar|claymation|comic|sketch\w*|stylized|ghibli|low[- ]poly|voxel)\b/i;

/**
 * Extend: the place as the camera sees it now (the set's own view from here, gray where its 360 never saw), drawn
 * again as a real photograph from this very spot, carried on as asked ("this street goes on, a pub on the right").
 * It becomes the place's new photo, and the new 360 world is built around where the camera stands (server/world):
 * far from where a world was made it warped and smeared, so you walk on by making the place again from where you are.
 */
export async function extendView(viewUrl: string, place: string, words: string, model: string, aspect: AspectId, signal: AbortSignal, machine?: string, resolution?: string) {
  const file = urlToPath(viewUrl);
  if (!file) throw new EngineError("Crackio can't find the view to extend.");
  const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry")]);
  const def = await resolveModel("image", model);
  const engine = def.via ? engineFor(def.via) : null;
  if (!engine) throw new EngineError(`${def.name} has no engine connected.`, "Open Connections.");
  const where = place.trim().replace(/[.\s]+$/, "");
  const ask = words.trim().replace(/[.\s]+$/, "");
  const kind = DRAWN_LOOK.test(`${where} ${ask}`) ? "picture" : "photograph";
  const prompt = [
    `A real ${kind}${where ? ` of ${where}` : ""}, taken from exactly this spot: image 1 is a rough view from here.`,
    "Keep the camera, its height, the level horizon and the perspective, and keep what's there where it is; draw it all fresh, sharp and real, with straight, upright walls.",
    "The flat gray areas were never seen: fill them with the place as it naturally carries on, in the same style, light and time of day.",
    ask ? `What changes or carries on: ${ask}.` : "The place carries on further than before, with more to see and walk into.",
    "Nobody in the foreground and no one close to the camera; no text, no watermark.",
  ].join(" ");
  const { width, height } = sizeFor(aspect, resolution === "4k" ? 3840 : 2048);
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
    aspect,
    width,
    height,
    count: 1,
    references: [{ path: file, label: "the view from here", role: "edit-target" }],
    mode: "image",
  };
  const ctx: EngineContext = { signal, progress: () => undefined };
  const result = await engine.run(job, ctx);
  if (!result.outputs[0]) throw new EngineError("The model returned nothing.");
  return saveFull(result.outputs[0].data, width, height);
}

/** Saved as big as it was made (uploads are capped at 2560 wide, which would undo a 4K place). */
async function saveFull(data: Buffer, width: number, height: number) {
  const name = `${nanoid(12)}.jpg`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name), await sharp(data).resize(width, height, { fit: "cover" }).jpeg({ quality: 93 }).toBuffer());
  return { url: `/api/media/uploads/${name}`, width, height };
}

