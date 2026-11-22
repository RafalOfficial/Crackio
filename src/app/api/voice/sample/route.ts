import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { DATA_DIR } from "@/lib/server/paths";
import { readSample, VoiceSetupError } from "@/lib/server/voice/setup";
import { AudioError } from "@/lib/server/voice/audio";

const MAX = 200 * 1024 * 1024;

/**
 * A clip to clone a voice from (a recording, an audio file, or a video with someone talking): cleaned to a mono WAV of up
 * to 30 seconds, checked, and typed out by speech to text when a machine has it.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Send the clip as a file." }, { status: 400 });
  if (file.size > MAX) return Response.json({ error: "That file is over 200 MB. A 10–30 second clip is all it needs." }, { status: 413 });
  const ext = (path.extname(file.name) || ".bin").replace(/[^.a-z0-9]/gi, "").slice(0, 8);
  const dir = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "voice");
  await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const raw = path.join(/*turbopackIgnore: true*/ dir, `${nanoid(10)}${ext}`);
  await fs.writeFile(/*turbopackIgnore: true*/ raw, Buffer.from(await file.arrayBuffer()));
  try {
    return Response.json(await readSample(raw, request.signal));
  } catch (err) {
    const status = err instanceof VoiceSetupError ? err.status : err instanceof AudioError ? 400 : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ raw, { force: true });
  }
}
