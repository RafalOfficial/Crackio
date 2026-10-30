import "server-only";
import { askText } from "@/lib/engines/refine";
import { urlToPath } from "@/lib/server/media";
import type { KitItem, Shot, Storyboard } from "./types";

/**
 * How each video model wants a clip written. A clip prompt isn't the shot's plan: the start frame
 * already shows who is where and how everything looks, so the words carry only what moves, in the
 * order and length the model follows best. Sent the whole plan (476 words for a 3 s clip, half of
 * it adjectives), models smear the action, stiffen the people and invent the rest.
 *
 * The craft every model shares: describe the motion, not the picture; one beat per three or four
 * seconds, written as countable events; one camera move; emotion as behaviour; each prop counted,
 * owned and sized against a hand; end on a held moment; the look as one capture-format sentence,
 * word for word the same in every clip. The house rules per model come from the vendors' own guides.
 */

export type ClipGuide = {
  family: string;
  /** Words for a clip of up to five seconds (longer clips get proportionally more). */
  words: [number, number];
  /** The platform cuts prompts off past this many characters. */
  chars?: number;
  /** "inline": a few short exclusions in the text; "positive": never negate, say what is there instead. */
  negatives: "inline" | "positive";
  /** How the prompt names the reference pictures sent with the start frame (only models that take them). */
  tag?: (n: number) => string;
  /** The model's own rules, from its vendor's guide. */
  rules: string[];
};

const GUIDES: [RegExp, ClipGuide][] = [
  [
    /grok/,
    {
      family: "Grok Imagine",
      words: [40, 110],
      chars: 1600,
      negatives: "inline",
      tag: (n) => `<IMAGE_${n}>`,
      rules: [
        "Plain, physical verbs in short declarative sentences; it follows concrete movement best and drifts on abstract wording.",
        "One camera move per clip.",
        "Reference pictures are named <IMAGE_1>, <IMAGE_2>… (<IMAGE_0> is the start frame): put each tag once, in brackets right after the noun it shows, where it first comes up ('the waiter (<IMAGE_1>) stops', 'across the ballroom (<IMAGE_3>)'), never as a list at the end.",
      ],
    },
  ],
  [
    /kling/i,
    {
      family: "Kling",
      words: [50, 140],
      chars: 2500,
      negatives: "inline",
      rules: ["Kling's own order: subject (with a short description), subject movement, scene, camera language, lighting, atmosphere.", "One main camera move per shot, in film terms (push in, pan, track, tilt)."],
    },
  ],
  [
    /veo/i,
    {
      family: "Veo",
      words: [50, 140],
      negatives: "inline",
      rules: [
        "Lead with the cinematography (shot size, camera move, lens feel), then subject, action, setting, light.",
        "One moment per prompt.",
        "Veo burns in gibberish subtitles and adds music when nothing rules them out: end with 'No subtitles, no on-screen text.'",
      ],
    },
  ],
  [
    /seedance|byteplus|bytedance/i,
    {
      family: "Seedance",
      words: [50, 160],
      negatives: "inline",
      rules: ["Order: subject, action, scene, visual style, camera movement, audio. Subject and action within the first twenty words.", "Exclusions few, specific and inline."],
    },
  ],
  [
    /minimax|hailuo/i,
    {
      family: "MiniMax Hailuo",
      words: [60, 180],
      chars: 2000,
      negatives: "positive",
      rules: ["Camera as motion type, amplitude and speed: 'the camera pushes in with small amplitude at slow speed'.", "State what should be there instead of 'no …'."],
    },
  ],
  [
    /runway|gen-?4/i,
    {
      family: "Runway",
      words: [25, 80],
      chars: 1000,
      negatives: "positive",
      rules: ["Its formula: '[Camera] shot of [subject] [action] in [environment]. [One or two supporting details].'", "Image-to-video: describe only the motion. Positive phrasing only ('the camera remains still', never 'no movement')."],
    },
  ],
  [/luma|\bray-?\d/i, { family: "Luma Ray", words: [25, 80], negatives: "positive", rules: ["Mid-action verbs ('running', not 'begins to run'); describe only what changes. Never negate."] }],
  [/ltx|^auto$/i, { family: "LTX", words: [50, 130], negatives: "inline", rules: ["One flowing paragraph, present tense, four to eight sentences. No emotional labels, no on-screen text."] }],
  [/\bwan\b|wan-?\d|\/wan/i, { family: "Wan", words: [40, 110], chars: 800, negatives: "inline", rules: ["Short and literal: subject, action, scene, camera, light."] }],
  [/pika|midjourney/i, { family: "Pika", words: [20, 60], negatives: "inline", rules: ["Very short: one subject, one action, one camera move."] }],
];

const ANY: ClipGuide = { family: "an image-to-video model", words: [40, 120], negatives: "inline", rules: [] };

export const guideFor = (model: string) => GUIDES.find(([re]) => re.test(model))?.[1] ?? ANY;

/** The word budget for a clip this long: the guide's for up to five seconds, more for longer clips. */
export function budget(g: ClipGuide, seconds: number): [number, number] {
  const k = seconds <= 5 ? 1 : seconds <= 8 ? 1.4 : 1.8;
  const [lo, hi] = g.words.map((w) => Math.round(w * k)) as [number, number];
  return g.chars ? [lo, Math.min(hi, Math.floor(g.chars / 6.5))] : [lo, hi];
}

const WRITER = `You write the prompt for one image-to-video clip of a short film. The video model sees the start frame (attached) and your words. It is a very literal second-unit director: it invents whatever you leave unsaid, forgets what it was doing after a couple of seconds, and smears anything crowded.
- Describe the motion, not the picture. The start frame already shows who is where, what they wear and how it all looks; describing it again competes with it. Point at people by what the camera sees ("the silver-haired man on the right"), never by name alone: the model doesn't know names.
- Count the beats: one per three or four seconds of clip, an action and its follow-through or a reaction. Write them as countable events in time order ("takes two steps, stops, looks down at the glass"), present tense, one per sentence. Keep the beat the story needs and drop the rest.
- Exactly one camera move, as type, amount and speed ("the camera pushes in slowly, a short way"), or "the camera holds still". The camera's position is already in the frame: write only its move.
- People are alive: give each one who matters one small visible behaviour (a breath, a glance, a weight shift, a hand that fidgets). Emotion is only ever behaviour: never "nervous", "angry", "determined".
- Only what a camera can record: no thoughts, intentions, sounds, or facts like "the theft is complete".
- Props that matter: say how many and whose they are once ("one wristwatch, on his left wrist"), and give small things a size against a hand ("glass shards no bigger than a fingernail"). An object never passes from one person to another or vanishes in shot: the model makes a second one.
- Nobody new enters, and no one leaves, unless the shot says so.
- The last action sentence says what the clip settles and holds on: the next shot starts from that frame.
- Then the look sentence, word for word as given. Then, if the guide allows, at most one short sentence of exclusions for failures this clip is likely to have.
- Never: "the video shows", "we see", "create", "you", quality words (4K, masterpiece, cinematic), stacked adjectives, timecodes for a clip this short.
- Keep to the word budget and the model's house rules.
Answer with JSON only: {"prompt": "the prompt", "dropped": "what from the plan you left out, in a few words, or empty"}`;

export type WrittenClip = { text: string; dropped?: string; words: number; guide: string };

/**
 * The clip's prompt, written for its model from the shot's plan and its start frame. `refs` are the
 * pictures that go with it (the cast, props and place in the shot), named in the model's syntax.
 */
export async function writeClip(b: Storyboard, s: Shot, model: string, seconds: number, refs: KitItem[], look: string): Promise<WrittenClip | null> {
  const frame = s.frame ? urlToPath(s.frame) : null;
  if (!frame) return null;
  const g = guideFor(model);
  const [lo, hi] = budget(g, seconds);
  const named = g.tag ? refs.map((k, i) => `${g.tag!(i + 1)}: ${k.kind === "place" ? "the place" : (k.noun ?? k.name)}${k.kind === "character" && k.noun ? ` (${k.name.replace(/^@/, "")})` : ""}`) : [];
  const text = [
    `Video model: ${g.family}. Word budget: ${lo} to ${hi} words.${g.chars ? ` Never over ${g.chars} characters.` : ""} ${g.negatives === "positive" ? "Never negate anything: say what is there instead." : "Exclusions: one short sentence at most."}`,
    g.rules.length ? `House rules for this model:\n- ${g.rules.join("\n- ")}` : "",
    named.length ? `Reference pictures sent with the start frame:\n${named.join("\n")}` : "",
    `The clip runs ${seconds} s and is cut after about ${s.duration} s, so the beat must land by then.`,
    `The director's plan for this shot (the start frame shows how it begins):`,
    `- What happens: ${s.action}`,
    s.acting ? `- How they play it: ${s.acting}` : "",
    s.background ? `- Around them: ${s.background}` : "",
    s.end ? `- It ends on: ${s.end}` : "",
    s.state ? `- Where everyone and every key prop is at the end (for you; write only what this clip must get right): ${s.state}` : "",
    `- Camera notes from the plan: ${s.camera}`,
    s.note ? `The last take went wrong; this one must fix it first: ${s.note}` : "",
    `The look sentence, to use word for word: ${look}`,
  ]
    .filter(Boolean)
    .join("\n");
  const answer = await askText({ instructions: WRITER, text, references: [{ path: frame, label: "the start frame" }], effort: "medium", imageEdge: 1024, timeoutMs: 3 * 60_000 });
  if (!answer) return null;
  let raw: { prompt?: unknown; dropped?: unknown };
  try {
    raw = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  let prompt = String(raw.prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!prompt) return null;
  // Every picture sent is named, or the model may not know what it's for.
  const missing = g.tag ? refs.map((k, i) => ({ k, tag: g.tag!(i + 1) })).filter((x) => !prompt.includes(x.tag)) : [];
  if (missing.length) prompt += ` ${missing.map((x) => `${x.tag} is ${x.k.kind === "place" ? "the place" : (x.k.noun ?? x.k.name)}.`).join(" ")}`;
  if (g.chars && prompt.length > g.chars) prompt = prompt.slice(0, g.chars).replace(/\s+\S*$/, "");
  return { text: prompt, dropped: raw.dropped ? String(raw.dropped).slice(0, 300) : undefined, words: prompt.split(/\s+/).length, guide: g.family };
}
