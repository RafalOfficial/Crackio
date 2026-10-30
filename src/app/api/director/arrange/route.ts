import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { POSES } from "@/lib/director/standin";
import { ANGLES, SHOT_SIZES } from "@/lib/director/vocab";

/**
 * Arrange: the set from a director's words ("Lena rides the motorbike through traffic, close on her face"). A text model
 * reads who is on set and the words, and answers in a small fixed vocabulary (a pose from a list, what each one is on or
 * next to, which way they face, the shot size and angle and from which side); Crackio places everything from that
 * itself. Choosing words from a list, not writing coordinates or scripts, is what a model gets right. `{ words, set }`.
 */
const INSTRUCTIONS = `You arrange a film set from a director's words. You get the people and things on the set, with their ids, and the words. Answer with JSON only, in this shape:
{"subjects":[{"id":"…","pose":"…","action":"…","on":null,"near":null,"facing":null}],"camera":null}
- subjects: only the ones the words change; ids only from the list.
- pose (people only): one of ${POSES.map((p) => `"${p.id}" (${p.plain})`).join(", ")}.
- action: a few words of what they do, in English ("riding the motorbike fast through traffic").
- on: the id of what they ride, sit or stand on (a motorbike, a bicycle, a horse, a chair, a bench, a car's bonnet), else null.
- near: {"id": the one they're next to, "side": "left", "right", "front" or "behind" (as that one faces), "gap": meters} or null.
- facing: "camera", "away", "left", "right" (of the frame), or another one's id to face them; null to leave it. A rider faces the way their ride goes: set the ride's facing instead.
- camera: null unless the words say how it's framed or the action needs it; else {"shot": one of ${SHOT_SIZES.map((s) => `"${s.id}" (${s.term})`).join(", ")}, "angle": one of ${ANGLES.map((a) => `"${a.id}"`).join(", ")}, "focus": the id it's on, "from": "front", "behind", "left", "right", "front-left" or "front-right" (of the focus, as it faces)}.`;

type ArrangePlan = {
  subjects?: { id: string; pose?: string | null; action?: string | null; on?: string | null; near?: { id: string; side?: string; gap?: number } | null; facing?: string | null }[];
  camera?: { shot?: string; angle?: string; focus?: string; from?: string } | null;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { words?: string; set?: string } | null;
  const words = body?.words?.trim();
  if (!words || !body?.set) return Response.json({ error: "Say what happens." }, { status: 400 });
  const answer = await askText({
    instructions: INSTRUCTIONS,
    text: `On set:\n${body.set.slice(0, 4000)}\n\nThe director's words: ${words.slice(0, 600)}\n\nAnswer with the JSON.`,
    effort: "low",
    // Picking words from a list needs no long thinking: a fast model on your Comfy key, else the one on your own GPU.
    prefer: ["comfy:google/gemini-3.5-flash", "local:text"],
    timeoutMs: 60_000,
  }).catch(() => null);
  const plan = answer ? jsonObject<ArrangePlan>(answer) : null;
  if (!plan) return Response.json({ error: "No text model could arrange the set. Check Settings → text model." }, { status: 502 });
  return Response.json({ plan });
}
