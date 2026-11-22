import fs from "node:fs";
import { z } from "zod";
import { frameAt } from "@/lib/motion/ffmpeg";
import { saveUpload, urlToPath } from "@/lib/server/media";

const Body = z.object({ source: z.string().min(1).max(500), t: z.number().min(0).max(36_000).default(0) });

type Saved = Awaited<ReturnType<typeof saveUpload>>;

// The frames already saved, by clip (its size and time) and moment: picking the same moment again (clicking back to a
// frame, changing the clip's start and back) hands back the picture already made instead of running ffmpeg and saving
// another copy. On globalThis, so a hot reload keeps it.
const g = globalThis as unknown as { __crackioRecastFrames?: Map<string, Saved> };
const saved = (g.__crackioRecastFrames ??= new Map());

/** One frame of a clip, saved as a picture: Recast shows it right away, then finds the things in it. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const file = urlToPath(parsed.data.source);
  if (!file) return Response.json({ error: "Upload the clip first." }, { status: 400 });
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ file);
    const key = `${file}|${st.size}|${st.mtimeMs}|${parsed.data.t.toFixed(3)}`;
    const known = saved.get(key);
    const knownFile = known ? urlToPath(known.url) : null;
    if (known && knownFile && fs.existsSync(/*turbopackIgnore: true*/ knownFile)) return Response.json({ frame: known });
    const frame = await saveUpload(await frameAt(file, parsed.data.t, 1600));
    saved.set(key, frame);
    if (saved.size > 400) saved.delete(saved.keys().next().value!);
    return Response.json({ frame });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
