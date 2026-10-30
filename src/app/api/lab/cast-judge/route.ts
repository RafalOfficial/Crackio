import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { urlToPath } from "@/lib/server/media";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * Research tool for Cast's benchmark: a vision model scores one generated picture against the reference sheets of the
 * cast it should show and the brief: identity, real-world scale, naturalness, the brief, how many times each one appears,
 * and whether the sheet itself leaked into the picture. `{ image, cast: [{ name, url, noun?, height? }], brief }`.
 * The picture goes first and the sheets share one second picture, since vision models read only a few pictures each.
 */
const RUBRIC = `You are a strict photo editor checking a generated picture of recurring cast members (people, animals, objects) against their references and the brief.
Image 1 is the generated picture. Image 2 stacks the cast's references, top to bottom in the order listed: each shows one subject, as a photo of it or as a reference sheet drawing it from several sides.
Score each from 1 (bad) to 10 (perfect):
- identity: does every cast member look exactly like its reference (a person's face, hair, skin, build and signature accessories; an animal's species, colors and markings; an object's shape, colors, materials and details; a car's body, color and wheels)? Score the worst one; a missing member scores 1.
- details: are the small identifying details of every cast member there and right, wherever they would be visible (jewelry and pendants, pins and patches, logos and printed words, eye colors, marks, small parts like buckles or a whistle cap)? Score the worst one; a detail that should be visible but is missing or changed costs a lot.
- scale: is every cast member its real-world size against the others and the surroundings (the brief gives real sizes)? A pigeon as big as a person, a handbag as big as a torso, or a car shrunk to a toy scores 1 to 3.
- relation: when the brief says something is worn, held, carried or ridden (a backpack on someone's back, a bag on a shoulder, a kettle in a hand), is it really, on the right one? 1 to 3 if it stands or lies apart instead; 10 when it is right or the brief says nothing of the kind.
- natural: does image 1 look like one real photograph (or one frame in the references' own style)? Penalize hard: pasted or sticker-like subjects, light that doesn't match, warped anatomy, smeared areas.
- brief: does image 1 show what the brief asks (the place, the action, the framing)?
Also:
- count: for each cast member by name, how many times it appears in image 1 (0 if missing, 2 or more if duplicated).
- sheet: true if image 1 copies a reference itself: several views of the same subject side by side, a plain studio backdrop instead of the scene, or a turnaround layout.
Answer with JSON only: {"identity": 0, "details": 0, "scale": 0, "relation": 0, "natural": 0, "brief": 0, "count": {"Name": 1}, "sheet": false, "flaw": "the biggest flaw in a few words"}`;

type Member = { name: string; url: string; noun?: string; height?: number };

/** The sheets one under the other, at one width. */
async function stack(files: string[]) {
  const key = createHash("sha1").update(files.join("|")).digest("hex").slice(0, 20);
  const out = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "cast", `judge-${key}.png`);
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
  const body = (await request.json().catch(() => null)) as { image?: string; cast?: Member[]; brief?: string } | null;
  const image = body?.image ? urlToPath(body.image) : null;
  const cast = (body?.cast ?? []).flatMap((m) => {
    const p = m.url ? urlToPath(m.url) : null;
    return p ? [{ ...m, path: p }] : [];
  });
  if (!image || !body?.brief || !cast.length) return Response.json({ error: "Send the image, its cast and the brief." }, { status: 400 });
  const who = cast
    .map((m, i) => `${i === 0 ? "top" : i === cast.length - 1 ? "bottom" : `sheet ${i + 1}`}: ${m.name}${m.noun ? `, ${m.noun}` : ""}${m.height ? `, about ${m.height >= 1 ? `${m.height} m` : `${Math.round(m.height * 100)} cm`} tall in real life` : ""}`)
    .join("; ");
  const sheets = await stack(cast.map((m) => m.path));
  const answer = await askText({
    instructions: RUBRIC,
    text: `Brief: ${body.brief}\nCast in image 2, ${who}.`,
    references: [
      { path: image, label: "the generated picture" },
      { path: sheets, label: "the cast's references" },
    ],
    imageEdge: 1536,
    detail: "high",
    effort: "medium",
    timeoutMs: 120_000,
  }).catch(() => null);
  const scores = answer ? jsonObject(answer) : null;
  if (!scores) return Response.json({ error: "No vision model answered." }, { status: 502 });
  return Response.json({ scores });
}
