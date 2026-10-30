import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { urlToPath } from "@/lib/server/media";

/**
 * Research tool: a vision model scores one generated picture (sent last) against its references and its brief, so
 * ways of building a shot can be compared on many pictures. `{ image, refs: [{ url, label }], brief }`.
 */
const RUBRIC = `You are a strict photo editor. Judge the LAST picture, a generated image, against the reference pictures before it and the brief.
Score each from 1 (bad) to 10 (perfect):
- natural: does it look like one real photograph? Penalize hard: pasted or sticker-like subjects, cut-out halos or white outlines, light on a subject that doesn't match the place, flat or paper-like faces or vehicles, warped anatomy, smeared areas.
- identity: do the people, animals and things look exactly like their references (face, hair, clothes, colors; a vehicle's make and model)?
- place: is it the place in its reference?
- camera: does the framing match the brief's camera: how close, from how high, the angle, where each subject is in the frame and which way it faces?
Answer with JSON only: {"natural": 0, "identity": 0, "place": 0, "camera": 0, "flaw": "the biggest flaw in a few words"}`;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { image?: string; refs?: { url: string; label: string }[]; brief?: string } | null;
  const image = body?.image ? urlToPath(body.image) : null;
  if (!image || !body?.brief) return Response.json({ error: "Send the image, its references and the brief." }, { status: 400 });
  const refs = (body.refs ?? []).flatMap((r) => {
    const p = urlToPath(r.url);
    return p ? [{ path: p, label: r.label }] : [];
  });
  const answer = await askText({
    instructions: RUBRIC,
    text: `Brief: ${body.brief}\nThe references, in order: ${refs.map((r, i) => `image ${i + 1}: ${r.label}`).join("; ")}. The generated picture is the last image.`,
    references: [...refs, { path: image, label: "the generated picture" }],
    imageEdge: 1024,
    detail: "high",
    effort: "low",
    timeoutMs: 90_000,
  }).catch(() => null);
  const scores = answer ? jsonObject<Record<string, unknown>>(answer) : null;
  return scores ? Response.json({ scores }) : Response.json({ error: "No vision model answered." }, { status: 502 });
}
