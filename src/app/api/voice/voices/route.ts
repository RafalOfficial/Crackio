import { z } from "zod";
import { addVoice, myVoices, scratchDir } from "@/lib/server/voice/store";
import { READY_VOICES } from "@/lib/voice/ready";
import path from "node:path";
import fs from "node:fs/promises";

/** Crackio's ready voices (with the words each was designed from) and yours. */
export async function GET() {
  return Response.json({ ready: READY_VOICES, yours: await myVoices() });
}

const Body = z.object({
  name: z.string().min(1).max(40),
  desc: z.string().max(90).optional(),
  text: z.string().min(1).max(2000),
  /** A scratch clip from /api/voice/sample or /api/voice/design. */
  file: z.string().regex(/^[\w-]{6,40}\.wav$/),
  source: z.enum(["clone", "design"]),
  consent: z.boolean().optional(),
  language: z.string().max(10).optional(),
});

/** Keep a clip as one of your voices. A clone needs its owner's word that the voice is theirs, or that they may use it. */
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Name the voice and say what it says." }, { status: 400 });
  const b = body.data;
  if (b.source === "clone" && !b.consent) return Response.json({ error: "Confirm the voice is yours, or that its owner agreed." }, { status: 400 });
  const file = path.join(scratchDir, b.file);
  if (!(await fs.stat(file).catch(() => null))) return Response.json({ error: "That clip is gone. Add it again." }, { status: 404 });
  const voice = await addVoice({ name: b.name, desc: b.desc, text: b.text, sampleFile: file, source: b.source, consent: b.consent, language: b.language });
  await fs.rm(file, { force: true });
  return Response.json({ voice }, { status: 201 });
}
