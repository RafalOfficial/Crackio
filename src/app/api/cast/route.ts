import { z } from "zod";
import { createCharacter, listCharacters } from "@/lib/server/cast";

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    kind: z.enum(["person", "pet", "character", "object"]).default("person"),
    photos: z.array(z.string().max(500)).max(4).default([]),
    description: z.string().max(1200).optional(),
    notes: z.string().max(400).optional(),
    /** The image model for the portrait and sheet ("auto" or missing: the best one connected). */
    model: z.string().max(300).optional(),
    /** Real height in meters, when you know it (otherwise it's read from the pictures). */
    height: z.number().positive().max(200).optional(),
    /** False when the height was read from the photo rather than typed (a later reading may correct it). */
    heightSet: z.boolean().default(true),
    /** Much longer than tall (a vehicle): its sheet puts the side view on a row of its own. */
    long: z.boolean().optional(),
    /** The views to draw (only the sides that look different), as planned on the page; else planned here. */
    views: z.array(z.enum(["front", "three-quarter", "side", "back"])).max(4).optional(),
    viewsWhy: z.string().max(200).optional(),
    /** What each side shows, as planned (see POST /api/cast/plan). */
    viewLooks: z.partialRecord(z.enum(["front", "three-quarter", "side", "back"]), z.string().max(200)).optional(),
  })
  .refine((b) => b.photos.length > 0 || (b.description?.trim().length ?? 0) > 8, { message: "Add a photo or describe them." });

export async function GET() {
  return Response.json({ items: await listCharacters() });
}

export async function POST(request: Request) {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  return Response.json({ item: await createCharacter(parsed.data) }, { status: 201 });
}
