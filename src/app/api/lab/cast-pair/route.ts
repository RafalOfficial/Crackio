import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { urlToPath } from "@/lib/server/media";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * Research tool for Cast's benchmark: which of two takes of the same brief shows the cast more faithfully. A vision model
 * sees the cast's references, then take A, then take B, and picks per criterion. Comparing two pictures side by side is
 * steadier than scoring each on its own (one take's 1–10 swung 4 points between runs). Ask twice with A and B swapped.
 * `{ a, b, cast: [{ name, url }], brief }` → `{ identity, details, brief, natural, overall }`, each "A", "B" or "tie".
 */
const RUBRIC = `You are a strict photo editor comparing two generated pictures of recurring cast members (people, animals, objects) against their references and the brief.
Image 1 stacks the cast's references, top to bottom in the order listed (a photo of each, or a reference sheet drawing it from several sides). Image 2 is take A. Image 3 is take B.
For each question answer "A", "B" or "tie" (tie only when they are truly equal):
- identity: in which take does every cast member look more exactly like its reference (face, hair, build, species and markings, an object's shape and materials)?
- details: in which take are the small identifying details more complete and right (jewelry and pendants, pins, logos and printed words, eye colors, small parts)?
- brief: which take follows the brief better (place, action, framing, who wears or holds what)?
- natural: which take looks more like one real photograph, with nothing pasted in or warped?
- overall: which take would you pick to show a client?
Answer with JSON only: {"identity": "A", "details": "A", "brief": "A", "natural": "A", "overall": "A", "why": "a few words"}`;

type Member = { name: string; url: string };

async function stack(files: string[]) {
  const key = createHash("sha1").update(files.join("|")).digest("hex").slice(0, 20);
  const out = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "cast", `pair-${key}.png`);
  try {
    await fs.access(out);
    return out;
  } catch {
    const width = 1024;
    const rows = await Promise.all(files.map((f) => sharp(f).resize({ width }).png().toBuffer({ resolveWithObject: true })));
    let top = 0;
    const layers = rows.map((r) => {
      const layer = { input: r.data, left: 0, top };
      top += r.info.height + 16;
      return layer;
    });
    await fs.mkdir(path.dirname(out), { recursive: true });
    await sharp({ create: { width, height: top - 16, channels: 3, background: "#202020" } }).composite(layers).png().toFile(out);
    return out;
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { a?: string; b?: string; cast?: Member[]; brief?: string } | null;
  const a = body?.a ? urlToPath(body.a) : null;
  const b = body?.b ? urlToPath(body.b) : null;
  const cast = (body?.cast ?? []).flatMap((m) => {
    const p = m.url ? urlToPath(m.url) : null;
    return p ? [{ ...m, path: p }] : [];
  });
  if (!a || !b || !body?.brief || !cast.length) return Response.json({ error: "Send both takes, their cast and the brief." }, { status: 400 });
  const refs = await stack(cast.map((m) => m.path));
  const answer = await askText({
    instructions: RUBRIC,
    text: `Brief: ${body.brief}\nCast in image 1, top to bottom: ${cast.map((m) => m.name).join("; ")}.`,
    references: [
      { path: refs, label: "the cast's references" },
      { path: a, label: "take A" },
      { path: b, label: "take B" },
    ],
    imageEdge: 1536,
    detail: "high",
    effort: "medium",
    timeoutMs: 120_000,
  }).catch(() => null);
  const verdict = answer ? jsonObject(answer) : null;
  if (!verdict) return Response.json({ error: "No vision model answered." }, { status: 502 });
  return Response.json({ verdict });
}
