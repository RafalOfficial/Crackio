import "server-only";
import { askText } from "@/lib/engines/refine";
import { mentionedCast } from "@/lib/server/cast";
import { urlToPath } from "@/lib/server/media";
import type { Character } from "@/lib/cast/types";
import type { ReferenceRef } from "@/lib/generations/types";
import { lookById, type Bible, type BibleEntry, type KitItem, type Shot, type Storyboard, type Treatment } from "./types";

/**
 * The storyboard's director: it works the film out with you (questions, then a story to approve),
 * plans it, checks every frame, watches every clip and decides where to cut it, and turns your
 * follow-ups into changes. Everything it knows about making films with image and video models is
 * written down here, learned by making them:
 *
 * - A one-line brief is a starting point, not a script. Shot literally ("he takes the watch and
 *   walks away") it gives everything asked for and nothing worth watching. A director builds a
 *   small story around it (who these people are, a setup, a misdirection, a payoff, a reveal) and
 *   asks before betting the film on it.
 * - People in AI clips stand like mannequins unless each one is given something to play: a want, a
 *   reaction, a glance, a gesture. Crowds and places freeze unless they're given something to do.
 * - Stories break when nobody tracks who has what: the watch stays on the victim's wrist after it's
 *   stolen, a man vanishes between shots. Every shot states where everyone and every key prop is
 *   when it ends, and the checks hold the next shot to it.
 * - A clip only knows its first frame and the pictures it's given. Every shot starts from the exact
 *   frame where the one before was cut, and gets pictures of its cast, props and place, so faces
 *   and props stay themselves even when they turn or come back.
 * - Real actions are quick: a bird lands in about 2 s. A shot with too little to do fills the rest
 *   by doing the next shot's action (then the next shot repeats it) or by stalling. Each shot gets
 *   one full beat, ends on a held moment, and says what hasn't happened yet.
 * - Video drifts: the small character slowly grows, colors and line work slide. Clips are cut at
 *   the beat, before the drift, and a new camera setup (redrawn by the image model) resets it.
 * - Image models give every character the same presence: the small one comes out too big, most of
 *   all in close shots and in the foreground. Every frame is checked against true sizes; a fix is
 *   checked again (an edit asked to shrink something does it only partly).
 * - "A new angle" gets nearly the same picture, which plays as a jump cut. A new setup has to be
 *   spelled out: where the camera stands, and what is in the foreground, middle and background.
 * - A clip that starts on someone's back invents their face when they turn. Start where the
 *   features the shot will show are visible.
 * - Long prompts drown the action. Models don't know names. Prompts are short, action first, with
 *   plain nouns ("the pigeon"), and the same style and motion words close every one of them.
 */

/* ------------------------------------------------------------------ helpers */

export function parseJson<T>(text: string): T {
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
}

export const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const sentence = (s?: string) => (s ? `${s.trim().replace(/[.;,\s]+$/, "")}.` : "");

/** The words a model reads instead of a name: "@sigeon" and "Sigeon" both become "the pigeon". */
export function plain(b: Storyboard, text: string) {
  let out = text;
  for (const e of b.bible?.characters ?? []) {
    const noun = e.noun?.trim();
    if (!noun) continue;
    const bare = e.name.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "@hamster" always; "Mia" only as a proper name, so "the hamster" never becomes "the the hamster".
    out = out.replace(new RegExp(`@${bare}(?![\\w])`, "gi"), noun);
    out = out.replace(new RegExp(`(^|[^\\w@])(?<!\\b(?:the|a|an) )(${bare})(?![\\w])`, "gi"), (all, lead: string, word: string) =>
      word[0] !== word[0].toLowerCase() ? `${lead}${noun}` : all,
    );
  }
  // "the pigeon lands. the hamster…": sentences start with a capital.
  return out.replace(/(^|[.!?]\s+)(the|a|an)\b/g, (_m, lead: string, word: string) => `${lead}${word[0].toUpperCase()}${word.slice(1)}`);
}

/** The recurring cast a board involves (they have pictures to keep them the same). */
export function boardCast(b: Storyboard): Character[] {
  const names = [b.scene, b.dev?.brief ?? "", ...(b.bible?.characters ?? []).map((c) => c.name)].join(" ");
  return mentionedCast(names);
}

/**
 * What the recurring cast really looks like, for the planner and the checks: their traits, how
 * you described them yourself (the traits can miss what matters most, like a gold name chain),
 * and what to always keep.
 */
export function castNotes(b: Storyboard | string) {
  const text = typeof b === "string" ? b : `${b.scene} ${b.dev?.brief ?? ""}`;
  return mentionedCast(text)
    .map((c) =>
      [
        `@${c.handle} (${c.name}): ${c.traits ?? "see their reference pictures"}`,
        c.description ? `Described by their owner as: ${sentence(c.description)}` : "",
        c.notes ? `Always: ${sentence(c.notes)}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");
}

/** The cast's portraits, for a text model to look at. */
function castPictures(cast: Character[]) {
  return cast.flatMap((c) => {
    const p = urlToPath(c.portrait ?? c.photos[0] ?? c.sheet ?? "");
    return p ? [{ path: p, label: `@${c.handle}: exactly how ${c.name} looks` }] : [];
  });
}

/** The bible as prompt lines: with names for the director's own checks, with plain nouns for the image model. */
function bibleLines(b: Storyboard, forModel = false) {
  const bible = b.bible;
  if (!bible) return "";
  const entry = (e: BibleEntry) => `${forModel ? (e.noun ?? e.name) : e.noun ? `${e.noun} (${e.name})` : e.name}: ${[e.look, e.size].filter(Boolean).join("; ")}`;
  return [
    bible.setting ? `Place: ${sentence(bible.setting)}` : "",
    bible.characters.length ? `Characters: ${bible.characters.map(entry).join(" ")}` : "",
    bible.props.length ? `Props: ${bible.props.map(entry).join(" ")}` : "",
    bible.scale ? `Scale: ${sentence(bible.scale)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What you settled with the director before planning: answers, notes and the approved story. */
function developed(b: Storyboard) {
  const d = b.dev;
  if (!d) return "";
  const answers = Object.entries(d.answers).map(([k, v]) => `${k}: ${v}`);
  return [answers.length ? `Decided with them: ${answers.join("; ")}.` : "", d.notes.length ? `They also said: ${d.notes.join(" / ")}` : "", d.treatment ? `The story they approved:\n${treatmentText(d.treatment)}` : ""]
    .filter(Boolean)
    .join("\n");
}

/** A treatment as plain text, for prompts and for the conversation. */
export function treatmentText(t: Treatment) {
  return [
    `${t.title}: ${sentence(t.logline)}`,
    t.world ? `World: ${sentence(t.world)}` : "",
    t.characters.length ? `Characters: ${t.characters.map((c) => `${c.name}, ${c.role}${c.want ? ` (wants ${c.want.replace(/\.$/, "")})` : ""}: ${c.look.replace(/\.$/, "")}`).join("; ")}.` : "",
    t.props?.length ? `Props: ${t.props.map((p) => `${p.name}, ${p.role}: ${p.look.replace(/\.$/, "")}`).join("; ")}.` : "",
    `Beats: ${t.beats.map((x, i) => `${i + 1}. ${x.title}: ${x.what.replace(/\.$/, "")}`).join(" ")}.`,
    t.ending ? `Ending: ${sentence(t.ending)}` : "",
    t.tone ? `Tone: ${sentence(t.tone)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ locks */

/** The camera feel each look shoots with, for the motion lock. */
const LOOK_MOTION: Record<string, string> = {
  cinematic: "Smooth, steady cinematic camera work; moves are motivated and unhurried.",
  documentary: "Handheld camera with a light, natural sway, observing.",
  pov: "First-person camera at head height that moves with the character's head and steps.",
  "third-person": "Game camera that follows just behind and above the character at a steady distance.",
  animation: "Smooth animated-feature motion with clear, readable poses.",
  anime: "Anime timing: crisp key poses, held moments, a smooth camera.",
  claymation: "Stop-motion feel: tactile, slightly stepped movement on miniature sets.",
  comic: "Dynamic comic-book energy, punchy but readable motion.",
  noir: "Slow, deliberate camera, long shadows.",
  super8: "Handheld home-movie camera with a gentle shake.",
  watercolor: "Gentle, flowing motion and a calm camera.",
  sketch: "Smooth, steady camera; the drawing style holds in every frame.",
};

/** The motion words every clip of a board ends with. */
export function motionLock(lookId: string) {
  return `Real-time speed with natural weight and physics: no slow motion, no speed-up, no time-lapse. ${LOOK_MOTION[lookId] ?? LOOK_MOTION.cinematic} The camera makes only the move described and never zooms. People and animals move like living beings, never like mannequins: they breathe, blink, shift their weight, gesture, glance and react to each other; everyone in the background keeps living their own moment. Every character keeps exactly the face, colors, markings, clothing, size and proportions of their reference; nothing appears that isn't described. No text, captions or subtitles.`;
}

/* ------------------------------------------------------------------ development */

const DEVELOP_INSTRUCTIONS = `You are a film director meeting someone who wants a short film made with AI. Read their brief and decide whether to ask them a few quick questions before anything is made.
Ask ("mode": "ask") when the brief is short or leaves the important choices open (where it happens, who is there, how it plays): a dozen words is a starting point, not a script. Go straight ahead ("mode": "go") only when they already pinned down the place, the people and what happens in real detail, or attached what to use, or told you to just make it.
When you ask, make every option worth choosing: each place should make the story better and be genuinely different from the other two (for a pickpocket: a crowded rooftop gala, a carnival midway at dusk, a rainy train platform at rush hour); never offer three versions of the same idea.
Answer with JSON only:
{"mode": "ask" | "go",
 "note": "one or two short sentences to them, in their language: what you see in it, and that a few choices will make it much better",
 "places": [{"label": "2 to 5 words", "detail": "one line: what's there and why it helps the story", "prompt": "an image prompt for a wide establishing shot of this place at the moment the film happens: the space, the light, the time of day, the weather, the atmosphere and a few anonymous background people (none of the story's characters in focus)"}],
 "questions": [
   {"key": "crowd", "question": "How busy is it?", "options": [{"label": "Packed", "detail": "a sea of people to hide in"}, {"label": "A few people", "detail": "..."}, {"label": "Nearly empty", "detail": "..."}]},
   {"key": "pace", "question": "How should it play?", "options": [{"label": "Slow burn", "detail": "..."}, {"label": "Steady", "detail": "..."}, {"label": "Fast and punchy", "detail": "..."}]},
   {"key": "a short word for what the story hinges on", "question": "the one question about this story that matters most (the ending, the twist, the tone, who wins)", "options": [three options, specific to this story]}]}
Three places and three questions exactly; two or three options each, labels of two to five words. In "go" mode, places and questions can be empty.`;

export type DevelopPlan = {
  mode: "ask" | "go";
  note: string;
  places: { label: string; detail: string; prompt: string }[];
  questions: { key: string; question: string; options: { label: string; detail?: string }[] }[];
};

/** Read the brief: ask a few questions (with pictures of three places), or go straight ahead. */
export async function developBrief(b: Storyboard): Promise<DevelopPlan> {
  const cast = castNotes(b);
  const answer = await askText({
    instructions: DEVELOP_INSTRUCTIONS,
    text: [`Their brief: ${b.dev?.brief ?? b.scene}`, cast ? `Recurring characters they brought in:\n${cast}` : "", `Look: ${lookById(b.look).label}. Shape: ${b.aspect}. Length: about ${b.target ?? 30} seconds.`]
      .filter(Boolean)
      .join("\n\n"),
    effort: "medium",
    timeoutMs: 4 * 60_000,
  });
  if (!answer) throw new Error("No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok to make films.");
  const p = parseJson<Partial<DevelopPlan>>(answer);
  return {
    mode: p.mode === "go" ? "go" : "ask",
    note: clean(p.note, 400),
    places: (Array.isArray(p.places) ? p.places : []).slice(0, 3).map((x) => ({ label: clean(x?.label, 40), detail: clean(x?.detail, 200), prompt: clean(x?.prompt, 900) })).filter((x) => x.label && x.prompt),
    questions: (Array.isArray(p.questions) ? p.questions : [])
      .slice(0, 3)
      .map((q) => ({
        key: clean(q?.key, 30).toLowerCase() || "story",
        question: clean(q?.question, 140),
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, 3).map((o) => ({ label: clean(o?.label, 40), detail: clean(o?.detail, 160) || undefined })).filter((o) => o.label),
      }))
      .filter((q) => q.question && q.options.length >= 2),
  };
}

/** A place option as a picture, in the film's look. */
export function placePicture(b: Storyboard, prompt: string) {
  return `${sentence(lookById(b.look).prompt)} ${sentence(prompt)} Wide establishing shot, no text, no captions, no panels or borders.`;
}

const TREATMENT_INSTRUCTIONS = `You are a film director developing a short film from a brief, the way a good director would with a client. Don't illustrate their sentence literally: build a small story around it that makes sense, has a reason, and pays off, so the film has value beyond "it happened". Respect everything they asked for and every choice they made; add to it, never contradict it.
Think like this:
- Who are these people? Give each a name, a role in the world and a want. Why are they here, now?
- Setup, complication, turn, payoff, button. For a trick or a heist: show the target and the prize, a misdirection the audience can follow (a bump, a spill, a distraction), the move itself, the getaway, and a reveal that lands (to the camera, or to the victim too late).
- The key moment must be legible on screen: plan a close shot of it (hands, the prop), and a reaction.
- Give the place and the background people life: something happens around them.
- One place, a few characters, no dialogue (people can react and gesture), achievable in about the length asked.
Answer with JSON only:
{"reply": "two or three sentences to them, in their language: the idea in a nutshell and why it works",
 "treatment": {"title": "", "logline": "the whole film in one sentence",
   "world": "where and when, what's going on there, and why these people are there",
   "characters": [{"name": "a name, or the @handle if they brought one", "role": "who they are", "want": "what they want here", "look": "age, build, face, hair, clothing, distinctive details: enough to cast and dress them"}],
   "props": [{"name": "the watch", "role": "what it does in the story", "look": "what it looks like exactly"}],
   "beats": [{"title": "two to four words", "what": "what we see happen, concretely"}],
   "ending": "the last image and why it lands",
   "tone": "a few words"}}`;

/** Work the brief and the answers into a story worth shooting, for them to approve. */
export async function writeTreatment(b: Storyboard, placePicturePath?: string | null) {
  const cast = castNotes(b);
  const d = b.dev;
  const answer = await askText({
    instructions: TREATMENT_INSTRUCTIONS,
    text: [
      `Their brief: ${d?.brief ?? b.scene}`,
      d && Object.keys(d.answers).length ? `Their choices: ${Object.entries(d.answers).map(([k, v]) => `${k}: ${v}`).join("; ")}.` : "",
      d?.notes.length ? `They also said: ${d.notes.join(" / ")}` : "",
      d?.treatment ? `Your previous pitch, which they want changed:\n${treatmentText(d.treatment)}` : "",
      cast ? `Recurring characters they brought in (keep their looks exactly):\n${cast}` : "",
      placePicturePath ? "The attached picture is the place they chose: set the story there." : "",
      `Look: ${lookById(b.look).label}. Length: about ${b.target ?? 30} seconds.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    references: [...(placePicturePath ? [{ path: placePicturePath, label: "the place they chose" }] : []), ...castPictures(boardCast(b))].slice(0, 4),
    imageEdge: 768,
    effort: "high",
    timeoutMs: 6 * 60_000,
  });
  if (!answer) throw new Error("No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok to make films.");
  const p = parseJson<{ reply?: string; treatment?: Partial<Treatment> }>(answer);
  const t = p.treatment ?? {};
  const list = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  const treatment: Treatment = {
    title: clean(t.title, 80) || "Untitled",
    logline: clean(t.logline, 300),
    world: clean(t.world, 600),
    characters: list<Treatment["characters"][number]>(t.characters)
      .slice(0, 6)
      .map((c) => ({ name: clean(c?.name, 60), role: clean(c?.role, 120), want: clean(c?.want, 160) || undefined, look: clean(c?.look, 400) }))
      .filter((c) => c.name),
    props: list<NonNullable<Treatment["props"]>[number]>(t.props)
      .slice(0, 4)
      .map((x) => ({ name: clean(x?.name, 60), role: clean(x?.role, 160), look: clean(x?.look, 300) }))
      .filter((x) => x.name),
    beats: list<Treatment["beats"][number]>(t.beats)
      .slice(0, 10)
      .map((x) => ({ title: clean(x?.title, 60), what: clean(x?.what, 400) }))
      .filter((x) => x.what),
    ending: clean(t.ending, 400),
    tone: clean(t.tone, 120) || undefined,
  };
  if (!treatment.beats.length) throw new Error("The story didn't come through. Try again, or add a little more to the brief.");
  return { reply: clean(p.reply, 800), treatment };
}

/* ------------------------------------------------------------------ planning */

export const PLAN_INSTRUCTIONS = (target: number, lookId: string) => {
  const look = lookById(lookId);
  return `You are the director, storyboard artist and continuity supervisor of a short film made with AI. Plan it so it can actually be shot with these tools, and so it plays as a real little film: people with intentions, a story the audience can follow, and a payoff.

How it gets made: the first shot's first frame is drawn by an image model. Every shot is then animated by an image-to-video model that sees that first frame, pictures of the characters, props and place, and your words. Each next shot starts from the exact frame where the previous clip is cut: either the same camera keeps rolling ("continuous"), or that same instant is redrawn from a new camera setup ("cut"). Plan every shot so this chain works.

Answer with JSON only, no prose:
{"title": "a short title",
 "logline": "the whole film in one sentence",
 "bible": {
   "setting": "the place, specific enough to draw the same way every time: landmarks, surfaces, materials, time of day, weather, where the light comes from, palette",
   "characters": [{"name": "@handle or a name", "noun": "what a camera sees: 'the detective in the grey trench coat', 'the pigeon'", "tag": "6 to 12 words that tell them apart: colors, clothing, markings, signature items", "look": "age or species, build, face, hair, clothing, distinctive details", "size": "real-world size, e.g. about 1.8 m tall"}],
   "props": [{"name": "the watch", "noun": "the gold wristwatch", "look": "shape, color, material", "size": "real-world size"}],
   "scale": "sizes only: how big everyone and every prop is next to each other, as comparisons a painter can check by eye, worked out from the real sizes. Never say where anyone is or what they do here: these words go into every frame, and a pose written here shows up in frames where it doesn't belong."},
 "style": "one paragraph that fixes the look of every frame: medium and technique, line and texture, palette, light, lens feel, weather and atmosphere. It is pasted word for word into every prompt.",
 "shots": [{"title": "two to four words", "transition": "cut | continuous", "framing": "Wide | Medium | Close-up | Extreme close-up | Over-the-shoulder | POV | Aerial | Two-shot | Insert", "camera": "where the camera stands and its one move", "layout": "the first frame", "action": "what happens", "acting": "how each character in the shot plays it", "background": "what the place and the people around them do meanwhile", "end": "the held moment it ends on", "state": "where everyone and every key prop is at that moment", "seconds": 4}]}

The rules that make it a film:
- Tell the approved story, beat by beat, and make it legible: the audience must see the setup, the misdirection, the key moment (give it a close shot of the hands or the prop) and the reaction or reveal. Use inserts and reaction shots; end on an image that lands.
- acting: for every character the shot shows, what they feel and how it shows: expressions, glances, gestures, posture, a small natural business (sipping, adjusting a cuff, laughing at a joke). Nobody ever just stands there; a person with nothing to play is a mannequin on screen.
- background: what the place and the extras do meanwhile, matched to how busy it is (guests chatting and laughing, a waiter passing with a tray, steam drifting, string lights swaying). Leave it empty only for an empty place.
- state: the continuity ledger. Who is in the scene and where, and where each key prop is (on whose wrist, in which pocket, on the floor). The next shot must start from exactly that state, and nobody vanishes or reappears without a reason on screen.
- Length: the seconds add up to about ${target}. Each shot is one clear beat that fills its seconds at real-time speed, usually 3 to 6 seconds. Real actions are quick: a bird lands in about 2 s, a person crosses a room in about 3 s, a glass hits the floor in under a second, a glance or a reaction about 1 s. Give a shot enough to do: an action plus its follow-through or a reaction. Never split one quick action across two shots, and never stretch it to fill a long shot: a clip with too little to do runs ahead into the next shot's action, or stalls. Vary the seconds the way an editor would (a 2 s reaction, a 5 s move): equal lengths read as machine rhythm.
- Every shot ends on a held moment the next shot can start from: a look, a pause, a pose. "end" says exactly what is visible then, and what has not happened yet ("…looking at each other; she has not noticed the watch is gone yet").
- transition: "continuous" when the camera setup stays and the action simply goes on; "cut" for a new camera setup. A cut changes the shot size by at least one step (wide, medium, close-up) or moves the camera at least 30 degrees around the subject; anything less is a jump cut, so make it continuous instead. Keep screen direction across cuts. The first shot is a cut, and so is any shot after an insert or a close shot that doesn't show the faces it needs (hands, a prop): rolling on from there, the video model makes the faces up. Mix both, and never more than two continuous shots in a row: every clip drifts a little in color and line, and a cut is redrawn fresh, which resets it.
- camera: where the camera physically is and its one move, concretely: "low behind the bar, looking past the bartender at the two men; slow push in", "handheld at shoulder height, drifting with the detective through the crowd". One move at most: slow push in, pull back, pan or tilt to follow, tracking, a gentle handheld drift, or static. A locked-off frame where little moves looks dead; give it a motivated drift unless stillness is the point.
- layout: the first frame as a painter needs it: what is in the foreground, the middle and the background, where each character is in the frame, which way they face, their pose. When characters differ a lot in size, keep the small one at the same distance from the camera as the big one, or farther: image models draw whatever is nearest the camera far too big. For a cut it describes the same instant the previous shot ends on, seen from the new camera. Everyone the shot will show has their face and identifying details visible in it: a clip that starts on someone's back invents their face when they turn.
- action: concrete and visible, in time order, at real-time speed, and at most two countable events (the action and its follow-through, or a reaction): more than that smears together on screen; say when something has to happen early ("within the first second the glass slips"). Write it the way an animator briefs a shot, in plain, natural terms: no distances in centimeters, no exact foot placements, no choreography a model can't hit. Video models can't do fine hand work (unclasping a watch, tying a knot), and they can't pass an object from one person to another or make it vanish: they make a second one instead. Put such a change on a cut: the shot ends as a hand covers the thing, and the next shot, a cut to a new camera, starts with the change already done (the wrist bare, the watch in the other palm); the "state" of the shot that ends on the cover already says where the thing is now. A prop exists once: say whose hand, wrist or pocket it is in, and never give a second character the same kind of object. Name characters by @handle or name. Only what a camera can see: no thoughts, no sounds, no text on screen. Never mention anyone who is off screen in a shot's layout, action, acting or end: the video model puts whoever is named into the picture.
- Characters: use the names and looks from the approved story exactly, so their pictures match. Real-world physics and true scale in every shot.
- Recurring characters (@handles) have reference pictures, attached: look at them. Copy their look into the bible exactly as the pictures and notes show it, signature accessories included, and never invent or contradict a detail. Keep every @handle exactly as written.
- style: start from this look and make it specific to this film: "${look.prompt}". ${look.plan}
- Write everything in English, whatever language the brief is in.`;
};

type RawEntry = Partial<BibleEntry>;
export type Plan = {
  title?: string;
  logline?: string;
  bible?: { setting?: string; characters?: RawEntry[]; props?: RawEntry[]; scale?: string };
  style?: string;
  shots?: Partial<Shot & { seconds: number }>[];
};

export const entries = (list: unknown): BibleEntry[] =>
  (Array.isArray(list) ? list : [])
    .slice(0, 8)
    .map((e: RawEntry) => ({
      name: clean(e.name, 60),
      look: clean(e.look, 400),
      size: clean(e.size, 160),
      ...(e.noun ? { noun: clean(e.noun, 60) } : {}),
      ...(e.tag ? { tag: clean(e.tag, 120) } : {}),
    }))
    .filter((e) => e.name);

export function toBible(p: Plan["bible"]): Bible {
  return { setting: clean(p?.setting, 800), characters: entries(p?.characters), props: entries(p?.props), ...(p?.scale ? { scale: clean(p.scale, 500) } : {}) };
}

/** Plan the film: bible, style and shots, as JSON. */
export async function writePlan(b: Storyboard, extra?: string) {
  const cast = castNotes(b);
  const place = b.dev?.place ? urlToPath(b.dev.place) : null;
  const text = [
    `The brief: ${b.dev?.brief ?? b.scene}`,
    developed(b),
    extra ? `Also: ${extra}` : "",
    cast ? `Recurring characters and their fixed looks:\n${cast}` : "",
    place ? "The first attached picture is the place: set every shot there, and match its look." : "",
    `Shape: ${b.aspect}. Length: about ${b.target ?? 30} seconds.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const answer = await askText({
    instructions: PLAN_INSTRUCTIONS(b.target ?? 30, b.look),
    text,
    references: [...(place ? [{ path: place, label: "the place" }] : []), ...castPictures(boardCast(b))].slice(0, 4),
    imageEdge: 768,
    effort: "high",
    timeoutMs: 6 * 60_000,
  });
  if (!answer) throw new Error("No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok to plan the film.");
  const p = parseJson<Plan>(answer);
  if (!Array.isArray(p.shots) || !p.shots.length) throw new Error("The plan had no shots. Try describing the film a little more.");
  return p;
}

/* ------------------------------------------------------------------ the kit */

/** A cast member or prop as a reference picture, in the film's look, on a plain backdrop. */
export function kitPrompt(b: Storyboard, item: KitItem) {
  const style = sentence(b.locks?.style ?? lookById(b.look).prompt);
  if (item.kind === "prop")
    return `${style} Prop reference for a film: ${sentence(item.look)} The object alone, whole and centered, on a plain neutral grey backdrop, soft even light, sharp detail. No hands, no people, no text.`;
  return `${style} Character reference for a film: ${sentence(item.look)} Full figure from head to toe, standing in a relaxed natural pose and turned three-quarters toward the camera, the face clearly visible, on a plain neutral grey backdrop with soft even light. Only this one character, nobody else. No text.`;
}

/** A crowd isn't one person: drawn as a reference, "the guests" becomes one man who turns up everywhere. */
export const isGroup = (e: { name: string; noun?: string }) =>
  /\b(guests|crowd|people|extras|passers-?by|commuters|bystanders|onlookers|dancers|diners|patrons|audience|staff|customers|shoppers|pedestrians|spectators|travell?ers)\b/i.test(`${e.name} ${e.noun ?? ""}`);

/** Kit pictures of the characters and props a shot shows, by what the shot's words mention. */
function kitInShot(b: Storyboard, s: Shot, kinds: KitItem["kind"][] = ["character", "prop"]) {
  const text = plain(b, `${s.layout ?? ""} ${s.action} ${s.acting ?? ""} ${s.end ?? ""}`).toLowerCase();
  const raw = `${s.layout ?? ""} ${s.action} ${s.acting ?? ""} ${s.end ?? ""}`.toLowerCase();
  return (b.kit ?? []).filter((k) => {
    if (!k.image || !kinds.includes(k.kind) || isGroup(k)) return false;
    const name = k.name.replace(/^@/, "").toLowerCase();
    return (k.noun && text.includes(k.noun.toLowerCase())) || raw.includes(name) || raw.includes(`@${name}`);
  });
}

/** The characters a shot shows, in the order its words first mention them (the first is who it's about). */
export function shotCast(b: Storyboard, s: Shot) {
  const text = `${s.layout ?? ""} ${s.action}`.toLowerCase();
  const plainText = plain(b, `${s.layout ?? ""} ${s.action}`).toLowerCase();
  const at = (k: KitItem) => {
    const spots = [text.indexOf(k.name.replace(/^@/, "").toLowerCase()), k.noun ? plainText.indexOf(k.noun.toLowerCase()) : -1].filter((i) => i >= 0);
    return spots.length ? Math.min(...spots) : Infinity;
  };
  return kitInShot(b, s, ["character"])
    .map((k) => ({ k, at: at(k) }))
    .sort((x, y) => x.at - y.at)
    .map((x) => x.k);
}

/** How a kit picture is introduced: "the detective (Marlowe)". */
const kitWho = (k: KitItem) => (k.noun && k.noun.toLowerCase() !== k.name.toLowerCase() ? `${k.noun} (${k.name.replace(/^@/, "")})` : k.noun ?? k.name);

/**
 * A character pictured again from the frame they first show clearly in: the same person, alone on
 * the kit's plain backdrop, so every later frame and clip is shown who is really on screen.
 */
export function recastFrame(b: Storyboard, k: KitItem, frame: string, where?: string) {
  const prompt = [
    `Image 1 is a still from a film. Make a character reference picture of one person in it: ${kitWho(k)}${where ? `, ${where.trim().replace(/[.;,\s]+$/, "")}` : ""}.`,
    "Draw the very same person: the same face, age, build, hair and skin, and the same clothes and accessories, exactly as in image 1. Only the pose and the background change.",
    "Full figure from head to toe, standing in a relaxed natural pose and turned three-quarters toward the camera, the face clearly visible, hands empty, on a plain neutral grey backdrop with soft even light. Only this one person, nobody else. No text.",
    `Style: ${sentence(b.locks?.style ?? lookById(b.look).prompt)}`,
  ].join("\n");
  return { prompt, references: [{ url: frame, label: "the film still", role: "edit-target" as const }] };
}

/** Pictures for a frame: whatever leads the list, then the cast and props in the shot (five at most in all, the image models' limit). */
function frameRefs(b: Storyboard, s: Shot, before: ReferenceRef[]) {
  const refs = [...before];
  const lines: string[] = [];
  for (const k of kitInShot(b, s)) {
    if (refs.length >= 5) break;
    refs.push({ url: k.image!, label: `${k.name}: keep consistent`, role: k.kind === "prop" ? "product" : "subject" });
    lines.push(`image ${refs.length} shows ${kitWho(k)}`);
  }
  const note = lines.length ? `${lines.join("; ").replace(/^i/, "I")}: keep their exact look, colors, clothing and details, at the sizes in the scale above, each exactly once.` : "";
  return { refs, note };
}

/* ------------------------------------------------------------------ prompts */

function closing(b: Storyboard) {
  return [b.locks?.style ? `Style: ${sentence(b.locks.style)}` : `Style: ${sentence(lookById(b.look).prompt)}`, "One single frame filling the whole picture: no text except what is part of a character's design, no captions, no panels, no borders."].join(" ");
}

/** The first frame of the film, drawn from words, the place and the cast's pictures. */
export function firstFrame(b: Storyboard, s: Shot) {
  const place = (b.kit ?? []).find((k) => k.kind === "place" && k.image);
  const { refs, note } = frameRefs(b, s, place ? [{ url: place.image!, label: "the place", role: "place" }] : []);
  const prompt = [
    place ? "Image 1 is the place: set the frame there, with its architecture, light and atmosphere, seen from the camera below." : "",
    `${s.framing} shot. Camera: ${sentence(plain(b, s.camera))}`,
    sentence(plain(b, s.layout || s.start || s.action)),
    s.acting ? `Expressions and poses: ${sentence(plain(b, s.acting))}` : "",
    s.background ? `Around them: ${sentence(plain(b, s.background))}` : "",
    plain(b, bibleLines(b, true)),
    s.frameNote ? `Important: ${sentence(plain(b, s.frameNote))}` : "",
    note,
    closing(b),
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, references: refs };
}

/**
 * A cut: the instant the previous shot was cut on, redrawn from this shot's camera. Coming out of a
 * close-up, the last wider frame goes along too: the close-up doesn't show who's off screen.
 */
export function bridgeFrame(b: Storyboard, prev: Shot, s: Shot) {
  const at = b.shots.findIndex((x) => x.id === s.id);
  const wider = /close|insert|detail/i.test(prev.framing)
    ? b.shots
        .slice(0, Math.max(0, at - 1))
        .reverse()
        .find((x) => x.outFrame && !/close|insert|detail/i.test(x.framing))
    : undefined;
  const start: ReferenceRef[] = [{ url: prev.outFrame!, label: "the last frame of the previous shot", role: "edit-target" }];
  if (wider?.outFrame) start.push({ url: wider.outFrame, label: "an earlier, wider frame of the same scene", role: "place" });
  const { refs, note } = frameRefs(b, s, start);
  const prompt = [
    "New camera setup, same instant. Image 1 is the last frame of the previous shot: keep everything in it exactly as it is at that instant (where everyone is, their poses, the props and their state, the place, the weather and the light) and show it from a different camera:",
    wider?.outFrame
      ? "Image 2 is an earlier, wider view of the same scene, only a reference: use it for the place and for anyone not visible in image 1 (how they look and where they are, unless the story has moved them). Draw one scene, the moment of image 1, with every person and animal exactly once: never both pictures."
      : "",
    `${s.framing} shot. Camera: ${sentence(plain(b, s.camera))}`,
    sentence(plain(b, s.layout || s.start || "")),
    s.acting ? `Expressions and poses: ${sentence(plain(b, s.acting))}` : "",
    prev.state ? `Where everyone and everything is now (where image 1 differs, this wins: a change the last shot hid has happened): ${sentence(plain(b, prev.state))}` : "",
    `This must clearly be a new camera position, not the same picture moved closer or farther. Previous camera: ${sentence(plain(b, prev.camera))}`,
    "Who is in the frame follows the description above; anything in image 1 that isn't part of the story (a stray person, a glitch) is left out.",
    b.bible?.scale ? `Scale: ${sentence(plain(b, b.bible.scale))}` : "",
    s.frameNote ? `Important: ${sentence(plain(b, s.frameNote))}` : "",
    note,
    closing(b),
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, references: refs };
}

/**
 * A cut drawn fresh, for when redrawing the last frame keeps coming back with the same camera: the
 * place and the cast lead, and the last frame comes along only to say where everyone is and what
 * they have. Edit models hold on to the first picture's framing, so it goes last.
 */
export function freshCut(b: Storyboard, prev: Shot, s: Shot) {
  const place = (b.kit ?? []).find((k) => k.kind === "place" && k.image);
  const { refs, note } = frameRefs(b, s, place ? [{ url: place.image!, label: "the place", role: "place" }] : []);
  const moment = refs.length < 5 && prev.outFrame ? refs.push({ url: prev.outFrame, label: "the same instant from the previous camera", role: "style" }) : 0;
  const prompt = [
    place ? "Image 1 is the place." : "",
    note,
    moment ? `Image ${moment} is this exact instant seen from the previous camera: copy where everyone is, their poses, clothing and what they hold, and the props' state, but not its camera, framing or composition.` : "",
    `A new camera setup: ${s.framing} shot. Camera: ${sentence(plain(b, s.camera))}`,
    sentence(plain(b, s.layout || s.start || "")),
    s.acting ? `Expressions and poses: ${sentence(plain(b, s.acting))}` : "",
    prev.state ? `Where everyone and everything is: ${sentence(plain(b, prev.state))}` : "",
    plain(b, bibleLines(b, true)),
    s.frameNote ? `Important: ${sentence(plain(b, s.frameNote))}` : "",
    closing(b),
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, references: refs };
}

/**
 * Fix what the check found, keeping everything else. Only the frame goes along: given the cast's
 * pictures too, edit models add the character from them as a second one.
 */
export function fixFrame(b: Storyboard, s: Shot, issues: { what: string; fix: string }[]) {
  const list = issues.map((i, n) => `${n + 1}) ${plain(b, i.what).replace(/\.$/, "")}: ${plain(b, i.fix).replace(/\.$/, "")}.`).join(" ");
  const count = (b.bible?.characters ?? []).filter((c) => c.noun && plain(b, `${s.layout ?? ""} ${s.action}`).toLowerCase().includes(c.noun.toLowerCase())).length;
  const prompt = [
    `This is a film frame. Fix only these problems and keep everything else exactly the same (composition, camera, framing, poses, the place, the light and the drawing style): ${list}`,
    "When something must get smaller or bigger, change it decisively: an edit that only nudges the size doesn't read on screen.",
    count ? `Add no one and move no one: the frame shows ${count === 1 ? "one main character" : `${count} main characters`}, each exactly once, where they already are.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, references: [{ url: s.frame!, label: "the frame to fix", role: "edit-target" as const }] };
}

/**
 * The clip: the action first, the acting and the life around it, then the same motion and style
 * words as every other clip. The cast, props and place in the shot go along as pictures, which the
 * prompt names <IMAGE_1>, <IMAGE_2>… (<IMAGE_0> is the start frame).
 */
export function clipPrompt(b: Storyboard, s: Shot, withRefs = true) {
  const refs = withRefs ? clipRefs(b, s) : [];
  // Only who's in this shot: naming someone else is how they end up in the picture.
  const text = plain(b, `${s.layout ?? ""} ${s.action} ${s.end ?? ""}`).toLowerCase();
  const tags = (b.bible?.characters ?? []).filter((c) => c.noun && c.tag && text.includes(c.noun.toLowerCase())).map((c) => `${c.noun}: ${c.tag!.replace(/\.$/, "")}`);
  const prompt = [
    `${sentence(plain(b, s.camera))} ${plain(b, sentence(s.action))}`,
    s.acting ? `Acting: ${sentence(plain(b, s.acting))}` : "",
    s.background ? `Around them: ${sentence(plain(b, s.background))}` : "",
    s.end ? `The shot ends on this: ${sentence(plain(b, s.end))}` : "",
    s.state ? `At the end: ${sentence(plain(b, s.state))}` : "",
    s.note ? `Important: ${sentence(plain(b, s.note))}` : "",
    refs.length ? `References: ${refs.map((k, i) => `<IMAGE_${i + 1}> is ${kitWho(k)}`).join("; ")}. They look exactly like their pictures throughout.` : tags.length ? `Who is who: ${tags.join("; ")}.` : "",
    `Motion: ${b.locks?.motion ?? motionLock(b.look)}`,
    `Style, the same in every frame as in the first frame: ${sentence(b.locks?.style ?? lookById(b.look).prompt)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, refs: refs.map((k) => ({ url: k.image!, label: k.name })) };
}

/**
 * The kit pictures a clip is given: the cast it shows, the props it shows that aren't in its first
 * frame yet, then the place (up to six). Shown a picture of a prop it can already see, the video
 * model makes a second one (the watch stays on the wrist and another turns up in the thief's palm).
 */
export function clipRefs(b: Storyboard, s: Shot) {
  const place = (b.kit ?? []).find((k) => k.kind === "place" && k.image);
  const first = plain(b, s.layout ?? s.start ?? "").toLowerCase();
  const head = (t?: string) => t?.toLowerCase().replace(/[^a-z\s]/g, " ").trim().split(/\s+/).at(-1);
  const inFirstFrame = (k: KitItem) => [head(k.noun), head(k.name)].some((w) => w && w.length > 2 && new RegExp(`\\b${w}`).test(first));
  return [...kitInShot(b, s).filter((k) => k.kind !== "prop" || !inFirstFrame(k)), ...(place ? [place] : [])].slice(0, 6);
}

/** Seconds to ask the video model for: the beat plus a little room, cut on review. */
export const clipSeconds = (s: Shot) => Math.min(15, Math.max(3, Math.round(s.duration + 1)));

/* ------------------------------------------------------------------ the look */

const LOOK_INSTRUCTIONS = `You are a film's art director. The picture is the approved first frame of the film; every later frame and clip must look exactly like it. Describe its look in one dense paragraph that another artist could match without seeing it: the medium and technique, line work and texture, the palette with named colors, contrast and how dark it is, the light and its direction and color, the atmosphere and weather, the lens feel. Describe only the look, never the content (no characters, objects, poses or places).
Answer with JSON only: {"style": "that paragraph", "capture": "the same look as one sentence of at most 25 words that a camera crew could shoot to: a real capture format or film stock, the lens feel, the light, the grain. For example: 'Shot on 35mm black-and-white film, 40mm lens, hard low-key light from above, deep blacks, fine grain.'"}`;

/**
 * The look of the approved first frame, in words: it replaces the planned style, so every later
 * prompt matches what the film really looks like. The paragraph goes to the frames; the one
 * sentence goes, word for word, to every clip.
 */
export async function describeLook(frame: string) {
  const p = urlToPath(frame);
  if (!p) return null;
  const answer = await askText({ instructions: LOOK_INSTRUCTIONS, text: "Describe the look of this frame.", references: [{ path: p, label: "the first frame" }], effort: "low", imageEdge: 1024, timeoutMs: 2 * 60_000 });
  if (!answer) return null;
  try {
    const v = parseJson<{ style?: unknown; capture?: unknown }>(answer);
    const style = clean(v.style, 1100);
    return style ? { style, capture: clean(v.capture, 240) || undefined } : null;
  } catch {
    return { style: clean(answer, 1100), capture: undefined };
  }
}

/* ------------------------------------------------------------------ checking frames */

const CHECK_INSTRUCTIONS = `You are the continuity supervisor of an AI-made film. Check one first frame before it is animated: anything wrong in it ends up in the film.
Look for real problems only:
- Story logic: who is where and who has what must match the continuity notes (a stolen watch that is still on the victim's wrist, a person missing who should be there, someone present who left).
- Scale: sizes that plainly contradict the scale notes. Image models nearly always draw the smaller character too big, most of all in close shots and in the foreground, so look. But judge by eye, the way a viewer would, allowing for perspective (closer looks bigger) and pose: flag a size only when it's off by about half again or more.
- Identity: a character who doesn't match their reference pictures (face, hair, colors, clothing, markings, signature accessories). A missing accessory is a mistake.
- Anatomy and objects: extra or missing limbs, fingers or eyes; melted, fused or duplicated subjects; things floating for no reason; broken perspective; garbled text.
- The brief: the wrong camera, framing or layout; someone in the wrong place or facing the wrong way; a character the shot will show with their face hidden (the video model would invent it).
- Continuity, when image 2 is the previous shot's last frame: this is the same instant, so the same positions, poses, props, weather and light, seen from the new camera. Continuity serves the story, though: if image 2 shows something the shot list doesn't have (a stray person, a glitch), the new frame is right not to repeat it.
- Jump cut, for a cut: if the camera is nearly the same as in image 2 (same angle, shot size within one step), the cut will look like a glitch.
- Look, for a cut: the overall look (medium, palette, darkness, line and texture) must be the same film as image 2 and the style notes. A cut that is clearly lighter, darker or drawn differently jumps on screen.
- The place, for the opening frame, when its picture is attached: the same place at the same time of day, in the same light. A night scene that comes out as day, sunbeams where the place has lamplight, or a different room is wrong.
Never flag style choices within that look, harmless creative details, or what the scene asks for on purpose. Don't nitpick exact positions or measurements, or which hand (left or right) holds something unless the story turns on that very hand, and leave the weather and the background alone unless they contradict the previous shot's last frame or the place: every edit risks the rest of the picture, so only ask for what would really show.
Answer with JSON only: {"verdict": "pass" | "fix" | "redraw" | "continuous", "issues": [{"what": "the problem and where it is", "fix": "how it must look instead"}], "serious": true | false, "jump": true | false, "summary": "one short line", "seen": [{"name": "a name from the cast list, exactly", "where": "how to pick them out in this frame: 'the silver-haired man on the right, holding a glass'"}]}.
"jump" is true when this is a cut and its camera is nearly the same as in image 2 (a jump cut), whatever else is wrong.
"seen" lists every character from the cast list whose face shows clearly in this frame and is big enough to recognize; leave out anyone seen from behind, hidden, cut off or tiny.
"serious" is true only when a problem would ruin the shot if it were animated: a character duplicated or missing, someone who doesn't look like themselves, the story's prop with the wrong person or duplicated, broken anatomy, a size at least twice what it should be, the wrong moment. Anything a viewer would forgive is not serious.
- "pass": nothing that would show in the film.
- "fix": problems an edit of this picture can solve (a wrong size, a missing accessory, a prop in the wrong place, a wrong color, an extra limb, someone facing the wrong way). Write each fix decisively.
- "redraw": the picture is wrong as a whole (wrong camera or layout, a face hidden that must show, the moment doesn't match the previous shot).
- "continuous": only for a jump cut that is otherwise fine: the film will keep rolling from the previous shot's last frame instead.
At most 4 issues, the most important first; an empty list for "pass".`;

export type FrameVerdict = { verdict: "pass" | "fix" | "redraw" | "continuous"; issues: { what: string; fix: string }[]; serious: boolean; jump: boolean; summary?: string; seen: { name: string; where: string }[] };

/** Pictures of how the people in a shot must look, for the checks (the kit first, then the @cast). */
function lookPictures(b: Storyboard, s: Shot, max: number) {
  const fromKit = kitInShot(b, s, ["character", "prop"]).map((k) => ({ url: k.image, label: `how ${k.name} must look` }));
  const cast = boardCast(b).map((c) => ({ url: c.portrait ?? c.photos[0], label: `how ${c.name} must look` }));
  return [...fromKit, ...cast].slice(0, max);
}

export async function checkFrame(b: Storyboard, s: Shot, index: number): Promise<FrameVerdict | null> {
  const prev = index > 0 ? b.shots[index - 1] : undefined;
  const place = index === 0 ? (b.kit ?? []).find((k) => k.kind === "place" && k.image) : undefined;
  const images = [
    { url: s.frame, label: "the frame to check" },
    ...(prev?.outFrame && s.frameFrom === "bridge" ? [{ url: prev.outFrame, label: "the previous shot's last frame" }] : []),
    ...(place ? [{ url: place.image, label: "the place the film is set in (its time of day and light too)" }] : []),
    ...lookPictures(b, s, 2),
  ].flatMap(({ url, label }) => {
    const p = url ? urlToPath(url) : null;
    return p ? [{ path: p, label }] : [];
  });
  const notes = castNotes(b);
  const cast = (b.kit ?? []).filter((k) => k.kind === "character" && !isGroup(k));
  const brief = [
    `Film: ${b.dev?.treatment?.logline ?? b.scene}`,
    bibleLines(b),
    notes ? `Recurring characters:\n${notes}` : "",
    cast.length ? `Cast list (for "seen"): ${cast.map((k) => `${k.name} (${k.noun ?? "no description"})`).join("; ")}` : "",
    `This is shot ${index + 1} of ${b.shots.length}${s.frameFrom === "bridge" ? ", a cut to a new camera setup" : ""}: ${s.framing} shot. Camera: ${s.camera}. First frame: ${s.layout || s.start || ""}`,
    s.acting ? `How they play it: ${s.acting}` : "",
    prev?.state ? `Continuity at this instant (from the shot before): ${prev.state}` : "",
    `What will happen in it: ${s.action}`,
    prev && s.frameFrom === "bridge" ? `Previous camera: ${prev.camera}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const answer = await askText({ instructions: CHECK_INSTRUCTIONS, text: brief, references: images, effort: "medium", imageEdge: 1024, detail: "high", timeoutMs: 4 * 60_000 });
  if (!answer) return null;
  const v = parseJson<Partial<FrameVerdict>>(answer);
  const issues = (v.issues ?? []).filter((i): i is { what: string; fix: string } => Boolean(i?.what && i?.fix)).slice(0, 4);
  // A pass stays a pass even with remarks attached; no verdict at all falls back on the issues.
  const verdict = v.verdict === "pass" || v.verdict === "fix" || v.verdict === "redraw" || v.verdict === "continuous" ? v.verdict : issues.length ? "fix" : "pass";
  const seen = (Array.isArray(v.seen) ? v.seen : [])
    .flatMap((x) => {
      const k = cast.find((c) => c.name.toLowerCase() === String(x?.name ?? "").trim().toLowerCase());
      return k ? [{ name: k.name, where: clean(x.where, 160) }] : [];
    })
    .filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i);
  return { verdict, issues, serious: Boolean(v.serious) && verdict !== "pass", jump: v.jump === true && verdict !== "pass", summary: v.summary ? clean(v.summary, 200) : undefined, seen };
}

const SAME_INSTRUCTIONS = `You check casting for a film. Image 1 is a frame of the film; image 2 is meant to be a reference picture of one person in it. Answer with JSON only: {"same": true | false, "why": "one short line"}.
"same" is true when image 2 is recognizably that very person: the same face, age, build, hair and clothes (the pose, backdrop and light may differ), alone. It is false for someone else, a blend of two people, a clearly different age or build, different clothes, or more than one person.`;

/** Whether a picture taken from a frame really is that person (an edit can pick the wrong one, or blend two). */
export async function sameOnScreen(k: KitItem, frame: string, picture: string) {
  const a = urlToPath(frame);
  const p = urlToPath(picture);
  if (!a || !p) return null;
  const answer = await askText({
    instructions: SAME_INSTRUCTIONS,
    text: `The person: ${kitWho(k)}${k.where ? `, ${k.where}` : ""}, in image 1.`,
    references: [
      { path: a, label: "the film frame" },
      { path: p, label: "the reference picture" },
    ],
    effort: "low",
    imageEdge: 1024,
    detail: "high",
    timeoutMs: 2 * 60_000,
  });
  if (!answer) return null;
  try {
    return parseJson<{ same?: unknown }>(answer).same !== false;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ reviewing clips */

const REVIEW_INSTRUCTIONS = `You are the film's editor. Image 1 is a clip as a grid of frames, each stamped with its time in seconds (top left; the last frame is the clip's end). Decide whether the shot worked and where to cut it.
The cut point ("out") is where the next shot starts: it begins from exactly this frame. Choose the moment the shot's end state is first clearly reached, plus about half a second of hold, and before anything from the next beat starts. Cut earlier if a problem creeps in later in the clip (someone grows, a face or colors change, the style slides, a limb melts): the cut frame has to be clean, because the next shot is built on it. Never cut in the middle of a fast movement unless the shot list says the next shot continues it. "in" is where the shot should start: 0 unless the first moments are dead.
Judge the story beat, not the letter of the plan: the shot works when its moment happens in a natural, believable way, the people in it act like people, and it ends somewhere the next shot can carry on from. A different pose, a position a step or two off, or extra natural movement is fine. Something moving toward the camera looks bigger; that's perspective, not growth.
Retake only when: the beat doesn't happen at all, or isn't finished by the end; the story logic breaks (the prop ends up in the wrong hands, someone vanishes or appears without a reason); the clip runs into the next shot's beat with no usable cut before it; a character changes identity (face, clothing, colors), visibly balloons or shrinks beyond perspective, duplicates or morphs; everyone stands frozen like mannequins through a moment that needed acting; the camera does an unasked move that ruins the shot; heavy artifacts. When such a problem starts late, cut before it instead: the cut frame must not contain it. If a clean stretch that tells the beat ends in a usable state, accept it with that cut instead of retaking: a retake costs as much as the first take and often repeats the same habit of the model.
Answer with JSON only: {"verdict": "accept" | "retake", "in": 0, "out": 3.5, "score": 1-10, "summary": "one short line on what the clip does", "issues": ["what went wrong"], "note": "for a retake: one sentence the next take's prompt adds to fix it, e.g. 'Within the first second the glass slips from his hand.' or 'The watch stays out of sight in the detective's pocket.'"}`;

export type ClipVerdict = { verdict: "accept" | "retake"; in: number; out: number; score: number; summary?: string; issues: string[]; note?: string };

export async function reviewClip(b: Storyboard, s: Shot, index: number, sheetPath: string, length: number): Promise<ClipVerdict | null> {
  const next = b.shots[index + 1];
  const images = [
    { path: sheetPath, label: "the clip, frame by frame, with times" },
    ...lookPictures(b, s, 2).flatMap((x) => {
      const p = urlToPath(x.url ?? "");
      return p ? [{ path: p, label: x.label }] : [];
    }),
  ];
  const brief = [
    bibleLines(b),
    `Shot ${index + 1} of ${b.shots.length}, planned for about ${s.duration} s (the clip runs ${length.toFixed(1)} s). ${s.framing} shot. Camera: ${s.camera}.`,
    `What should happen: ${s.action}`,
    s.acting ? `How they play it: ${s.acting}` : "",
    s.end ? `It should end on: ${s.end}` : "",
    s.state ? `Continuity at the end: ${s.state}` : "",
    next ? `The next shot (${next.transition === "continuous" ? "continuing the same take from the cut frame" : "a cut to a new camera on the same instant"}): ${next.action}` : "This is the last shot of the film: end on a moment that feels like an ending.",
    s.note ? `This take was asked for: ${s.note}` : "",
    // Every take starts from the same frame: retaking for what's already in it only costs a take.
    s.check?.status === "flagged" && s.check.issues?.length
      ? `Already in the start frame, which every take starts from, so a retake can't change it: ${s.check.issues.join(" ")} Never retake for this; the next shots carry on from it as it is. Judge everything else.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const answer = await askText({ instructions: REVIEW_INSTRUCTIONS, text: brief, references: images, effort: "medium", imageEdge: 1700, detail: "high", timeoutMs: 4 * 60_000 });
  if (!answer) return null;
  const v = parseJson<Partial<ClipVerdict> & { in?: unknown; out?: unknown }>(answer);
  const out = Math.min(length, Math.max(0.5, Number(v.out) || length));
  const start = Math.max(0, Math.min(out - 0.5, Number(v.in) || 0));
  return {
    verdict: v.verdict === "retake" ? "retake" : "accept",
    in: Math.round(start * 100) / 100,
    out: Math.round(out * 100) / 100,
    score: Math.max(1, Math.min(10, Number(v.score) || 5)),
    summary: v.summary ? clean(v.summary, 200) : undefined,
    issues: (Array.isArray(v.issues) ? v.issues : []).map((i) => clean(i, 200)).filter(Boolean).slice(0, 4),
    note: v.note ? clean(v.note, 300) : undefined,
  };
}

/* ------------------------------------------------------------------ follow-ups */

export const EDIT_INSTRUCTIONS = `You are the director of a short AI-made film, talking with the person you're making it for. They just sent a message about the film. Decide what to change and answer them.
How the film is made: one shot at a time, in order. Each shot starts from the exact frame where the previous shot was cut, so changing a shot means redoing it and every shot after it; mention that when it applies. Prefer the smallest change that does what they asked. When they ask for something vague ("make it more exciting", "it's boring"), make a real creative decision and say what it is.
Answer with JSON only: {"reply": "what you'll do, in one to three short sentences, in their language", "ops": [...]}
Operations (shots are numbered from 1, always as the list is now, before any of your changes):
{"op": "edit", "shot": 3, "title"?: "", "framing"?: "", "camera"?: "", "layout"?: "", "action"?: "", "acting"?: "", "background"?: "", "end"?: "", "state"?: "", "seconds"?: 4, "transition"?: "cut" | "continuous"}: rewrite a shot's plan (it's redone, and everything after it).
{"op": "add", "after": 3, "shot": {"title", "transition", "framing", "camera", "layout", "action", "acting", "background", "end", "state", "seconds"}}: a new shot after shot 3 (0 for the very start).
{"op": "remove", "shot": 3}
{"op": "move", "shot": 5, "to": 2}
{"op": "retake", "shot": 3, "note": "what the new take must do differently"}: animate the shot again from the same first frame.
{"op": "redraw", "shot": 3, "note": "what the first frame must show differently"}: draw the first frame again, then animate.
{"op": "trim", "shot": 3, "in"?: 0, "out"?: 2.5}: cut the shot's clip differently (seconds within the clip).
{"op": "style", "text": "the full new style paragraph"}: a new look for the whole film (everything is redone).
{"op": "motion", "text": "the full new motion paragraph"}: new pacing or camera feel for every clip (every clip is redone).
{"op": "bible", "setting"?: "", "scale"?: "", "characters"?: [...], "props"?: [...]}: change the place, sizes or how someone looks (everything is redone).
{"op": "title", "text": ""}
{"op": "length", "seconds": 45}: a new target length; add or remove shots with other ops to match it.
{"op": "replan", "brief": "the film to make now"}: start the plan over, for a different film or a total rethink.
{"op": "pause"} / {"op": "resume"}: stop or continue making shots.
{"op": "film"}: put the finished film together again.
Rules: keep @handles exactly as written. Write shots the way the plan does: a concrete camera position and one move, the first frame's layout, one full beat of real-time action, how each character plays it, what happens around them, a held end state that says what hasn't happened yet, and where everyone and every key prop is at the end. Video models can't do fine hand work (unclasping a watch, tying a knot), and they can't pass an object from one person to another or make it vanish: they make a second one instead. Put such a change on a cut: the shot ends as a hand covers the thing, and the next shot, a cut to a new camera, starts with the change already done (the wrist bare, the watch in the other palm); the "state" of the shot that ends on the cover already says where the thing is now. A prop exists once: say whose hand, wrist or pocket it is in, and never give a second character the same kind of object. If they only ask a question, answer it with no ops. If something can't be done, say so plainly.`;

export type EditOp = { op: string; [key: string]: unknown };

/** The board as the director needs it to make changes: compact, numbered from 1. */
function boardState(b: Storyboard) {
  return JSON.stringify({
    title: b.title,
    film: b.dev?.treatment ? treatmentText(b.dev.treatment) : b.scene,
    target: b.target,
    look: lookById(b.look).label,
    aspect: b.aspect,
    paused: Boolean(b.paused),
    bible: b.bible,
    style: b.locks?.style,
    motion: b.locks?.motion,
    shots: b.shots.map((s, i) => ({
      n: i + 1,
      title: s.title,
      transition: s.transition,
      framing: s.framing,
      camera: s.camera,
      layout: s.layout,
      action: s.action,
      acting: s.acting,
      background: s.background,
      end: s.end,
      state: s.state,
      seconds: s.duration,
      made: s.clip ? `clip cut at ${s.review?.in ?? 0}-${s.review?.out ?? "?"} s${s.review?.summary ? `: ${s.review.summary}` : ""}` : s.frame ? "first frame only" : "not made yet",
      ...(s.review?.issues?.length ? { problems: s.review.issues } : {}),
    })),
  });
}

export async function readFollowUp(b: Storyboard, text: string) {
  const history = (b.messages ?? [])
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.text}`)
    .join("\n");
  const notes = castNotes(b);
  const answer = await askText({
    instructions: EDIT_INSTRUCTIONS,
    text: [`The film so far:\n${boardState(b)}`, notes ? `Recurring characters:\n${notes}` : "", history ? `Conversation so far:\n${history}` : "", `Their new message: ${text}`].filter(Boolean).join("\n\n"),
    effort: "medium",
    timeoutMs: 4 * 60_000,
  });
  if (!answer) throw new Error("No text model answered. Add a Comfy key in Connections, or sign in to ChatGPT or Grok.");
  const parsed = parseJson<{ reply?: string; ops?: EditOp[] }>(answer);
  return { reply: clean(parsed.reply, 1200) || "Done.", ops: Array.isArray(parsed.ops) ? parsed.ops.filter((o) => o && typeof o.op === "string").slice(0, 24) : [] };
}
