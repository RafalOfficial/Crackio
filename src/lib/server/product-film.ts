import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { askText } from "@/lib/engines/refine";
import { jsonObject } from "@/lib/json-answer";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput, type EngineReference } from "@/lib/engines/types";
import type { ModelDef } from "@/lib/models/catalog";
import { durationTicks, fitDuration, fitResolution, type Caps } from "@/lib/models/caps";
import { sheetTimes, timedSheet } from "@/lib/storyboard/film";
import {
  FILM_CAMERAS,
  FILM_HOOKS,
  FILM_MOODS,
  FILM_PACES,
  FILM_STORIES,
  FILM_STYLES,
  LANGUAGES,
  byFilmId,
  countWords,
  type FilmCheck,
  type FilmPlan,
  type FilmSpec,
} from "@/lib/product/film";
import type { ProductRead } from "@/lib/product/vocab";
import { listModels } from "@/lib/models/resolve";
import { engineFor } from "@/lib/engines";
import { sizeFor } from "@/lib/shot";
import { getGeneration } from "./db";
import { saveUpload, urlToPath } from "./media";
import { DATA_DIR } from "./paths";
import { readProduct } from "./product";
import { transcribe, type Transcript } from "./speech";
import { joinParts, keepShape, lastFrame, lengthOf, punchIns, type Punch } from "./film-edit";
import { scoreFor, withScore } from "./film-score";
import { soundOf } from "@/lib/product/film-fit";
import { burnCaptions } from "./film-captions";

/**
 * Product Studio's Video mode, carried out like a small film crew:
 *  1. Know the product: the reading made in Image mode travels with the picture (or is made now).
 *  2. Direct: a director who sees the picture and the product fits every pick to them, writes what
 *     the person says, and writes the prompt in the syntax the chosen video model follows best.
 *  3. Film: every clip renders from its picture (longer takes in parts, each from the last frame).
 *  4. Watch: an ad buyer checks each clip frame by frame (and what was really said) against the
 *     product and the plan, and re-films once with a fix when a client would reject it.
 *  5. Cut: the clip keeps its picture's shape; punch-ins and snap zooms land on the spoken words.
 */

/** Hooks where the product arrives: filmed as a lead-in that lands on the picture. */
const LEAD_HOOKS = new Set(["toss", "reveal", "drop", "lights"]);

/** Vision models that look at the picture and write every line: a hosted one on your Comfy key, else the open one on your own GPU. */
const DIRECTORS = ["comfy:google/gemini-3.5-flash", "local:text"];

/* ------------------------------------------------------------------ models */

/** How a video model wants to be talked to. */
type Profile = { name: string; dialogue: string; tags: string | null; format: string; maxChars: number; negatives: boolean };

const GROK: Omit<Profile, "name"> = {
  dialogue: 'Each line inside its beat with ONE delivery cue before it, then the words in double quotes: she looks into the lens and says, casually: "the words". The first line starts within the first second ("In the first second she…"). Grok lip-syncs it in the language you write it in (name the language and accent outside the quotes when it isn\'t English).',
  tags: "The first frame is <IMAGE_0>; reference pictures are <IMAGE_1>, <IMAGE_2>… in the order listed; a preset voice is <AUDIO_0>. Refer to them by these tags.",
  format:
    "Labelled prose: one or two sentences on what kind of footage it is and how it should feel; a short camera paragraph (who or what holds the camera and how it moves); timecoded beat lines (\"0-3s: …\"), one per beat, covering the whole clip; one or two lock sentences (what never changes); a last line starting \"Audio:\".",
  maxChars: 3800,
  negatives: false,
};

function profileFor(def: Pick<ModelDef, "id" | "name" | "vendor" | "family">): Profile {
  const id = def.id.toLowerCase();
  if (id.includes("grok")) return { name: def.name, ...GROK };
  if (id.includes("veo"))
    return {
      name: def.name,
      dialogue: "Speech as: The woman says: the words (a colon and NO quotation marks: quotes make Veo burn subtitles into the picture). Short lines.",
      tags: null,
      format: "Labelled prose with bracketed timecodes ([00:00-00:03] …), one beat per block; a final line with the sound and \"No music, no subtitles\".",
      maxChars: 2400,
      negatives: true,
    };
  if (id.includes("kling"))
    return {
      name: def.name,
      dialogue: 'Speech in quotes after a speaker tag: The woman says, "the words."',
      tags: null,
      format: "Subject and what they do first, then the place, then one camera move, light and atmosphere; beats in order with \"then\". Keep it under 2,400 characters.",
      maxChars: 2400,
      negatives: true,
    };
  if (id.includes("seedance"))
    return {
      name: def.name,
      dialogue: 'Speech in double quotes after the speaker: she says "the words".',
      tags: "Pictures are Image 1, Image 2… in the order listed.",
      format: "Subject and action first, then the setting, look, camera and audio; second-level timecodes (0-3s: …) for beats; say \"one continuous take\" when there are no cuts.",
      maxChars: 3500,
      negatives: false,
    };
  if (id.includes("minimax") || id.includes("hailuo"))
    return {
      name: def.name,
      dialogue: 'Speech in double quotes after the speaker: she says "the words".',
      tags: null,
      format: "Dense structured prose: the shot and its beats with timecodes, then the soundscape, then \"Music: none\".",
      maxChars: 3500,
      negatives: false,
    };
  if (id.includes("ltx"))
    return {
      name: def.name,
      dialogue: 'Speech in double quotes with the accent named: she says in a casual American accent, "the words."',
      tags: null,
      format: "One flowing paragraph in the present tense, four to eight sentences, in the order things happen; sounds in the same paragraph.",
      maxChars: 1600,
      negatives: true,
    };
  if (id.includes("wan"))
    return {
      name: def.name,
      dialogue: 'Speech in double quotes: she says, "the words."',
      tags: "Pictures are Image 1, Image 2… in the order listed.",
      format: "Clear prose in the order things happen, with simple timecodes for beats; keep it under 1,500 characters.",
      maxChars: 1500,
      negatives: true,
    };
  return {
    name: def.name,
    dialogue: 'Speech in double quotes: she says, "the words."',
    tags: null,
    format: "Clear labelled prose in the order things happen, with simple timecodes for beats.",
    maxChars: 2400,
    negatives: false,
  };
}

/** What the model can do, in plain terms. */
export function filmCaps(def: Pick<ModelDef, "id" | "model">, caps: Caps | null) {
  const ticks = caps?.duration ? durationTicks(caps.duration) : null;
  return {
    maxSeconds: ticks?.max ?? 8,
    minSeconds: ticks?.min ?? 1,
    // Models that always make sound show no sound switch in their settings (see soundOf).
    sound: soundOf(def.id, caps) !== "no",
    startFrame: Boolean(caps?.image || caps?.keyframes),
    refs: caps?.refs?.max ?? 0,
    endFrame: Boolean(caps?.end),
    voices: def.model === "grok-imagine-video-1.5",
  };
}

/* ------------------------------------------------------------------ the director */

/** How people talk in a UGC video: shared by the director and the script writer. */
const SPEECH_RULES = `- Budget about 2.3-2.5 words per second of speaking after the first second: 6 s ≈ 11 words, 8 s ≈ 16, 10 s ≈ 21, 12 s ≈ 25, 15 s ≈ 32, 20 s ≈ 44, 30 s ≈ 68. Fewer words beat rushed words; a whisper is about 2 words a second.
- The first line is the hook: it lands within the first 1.5 seconds and never names the brand. It's about THEM or the viewer, not the product: a moment, a small surprise, a callout, a question, a contrarian line. Shapes that work: "Okay, I need to talk about…", "Nobody told me…", "Wait— feel this.", "If you ___, watch this.", "Stop buying ___ that ___.", "Why does nobody talk about…", "Don't tell anyone, but…", "I wasn't going to post this…".
- Then one concrete detail a viewer can picture (where it lives in their home, the moment of the day, a texture, a taste, a sound) and one honest or funny aside. First person, contractions, short sentences and fragments ("Sized down. Worth it."), at most one filler per ten words ("okay so", "honestly", "like", "I mean", "wait"), one small self-correction ("it's like a— okay, it's basically…"). End on a natural, slightly throwaway line, not a slogan. The brand once, clearly, after the hook. Keep hard-to-say things out of speech: no abbreviations, model numbers, sizes or long product names ("NAD+ Complex", "500 ml"); say what it is in plain words.
- Never: "game changer", "obsessed", "this changed my life", "I was skeptical but", "you need to try this", "elevate", "innovative", "next-level", "you won't believe", "fits right into my routine", "must-have", feature lists, prices, "link in bio" (unless asked).
- Honest by design: speak as someone showing or trying the product right now (a first impression), never invented usage history ("two weeks in", "I've been using this for months"), results ("my skin cleared up"), reviews or credentials, unless the client's notes give them as true. Health, supplements and skincare: how it feels or fits their day, never that it treats or cures anything.
- The level of the writing (other products; never reuse these words): a lip balm at 8 s: "I have one in every bag. Every single one. This is the only one I actually finish." A coffee grinder at 10 s: "Okay, nobody warned me fresh-ground would ruin all other coffee for me. Thirty seconds. That's it." Running socks at 12 s: "Wait— why did nobody tell me socks matter? These don't slip. I stopped thinking about my feet, which, honestly, is the point."
- The client's own lines are said exactly as written; you only place them on the beats.`;

const DIRECTOR_INSTRUCTIONS = `You are the director, director of photography and writer of short product ads made with an AI video model. You get the client's picture (the clip's first frame), their product photo when there is one, a reading of the product, the style and picks they chose, the video model and its limits. You decide what happens and what is said, and you write the exact prompt the video model renders. The bar is not "good for AI": a viewer must not be able to tell it isn't real footage, and it must be good enough to run as an ad today.

HOW VIDEO MODELS BEHAVE (write for this)
- The first frame is given. Write what happens next and how it moves; never re-describe the picture. Name people and the product only as much as it takes to keep them consistent ("the woman", "the amber EVERA jar").
- Anything left open, the model invents: music, extra people, cuts, captions, a second product. Close every gap that matters here; say nothing about what can't happen.
- Count beats, not adjectives. One beat per 3-4 seconds (6 s: 2 beats; 8-10 s: 3; 12 s: 3-4; 15 s: 4-5). A beat is one camera behaviour, one action written as countable events, and at most one line of speech. Give beats different lengths. Cover the whole clip, no gaps.
- Emotion is behaviour, never a label: "she laughs once and pushes her hair back", not "she's excited".
- Contact is where video models fail: lips on a spout, fingertips on a tiny cap, pouring into a small opening, an object changing hands. Show the beat just before or after it, keep grips simple (a whole hand around the product), and when an object must change hands, have it pass once, slowly and clearly, from one hand straight into the other.
- The product stays exactly as in the picture: same shape, colors, label and print. It never morphs, duplicates or changes size. Whenever it's shown to the camera, the label faces the lens, upright and steady for a beat.
- Never ask for on-screen text, captions, subtitles, logos, stickers or watermarks; say there are none.
- Sound is half of realism. Name sounds that have a visible cause (a voice close to the phone mic, room tone, footsteps, the pouch crinkling, a cap clicking, a bottle set down). Always say "No music" — the edit adds music later if it wants any.
- End deliberately: say what the last second shows (a held look, a small smile, the product set down and still). Never a fade, never a freeze.

- The video model gets ONLY the pictures listed under "What it gets". Anything else you are shown (the product photo, other angles) is for your eyes only: never tag it, never mention it in a prompt.
- Zooms, punch-ins and jump cuts are cut by Crackio in the edit afterwards, timed to the words. Never ask the model for zooms, punch-ins, jump cuts or "edits": write one continuous take with steady framing (except the camera behaviour of the style), and pick the emphasis phrases in your answer.

THE STYLES
Creator (UGC talking): it must pass as a real creator's phone video.
- Selfie physics: the phone is the camera, so it is never visible. One arm stays stretched toward the lens holding it for the whole clip, so only ONE hand is free: that hand holds the product, touches hair, gestures. The product never goes into both hands (to show the label, the free hand turns it with the wrist); never a second phone. The frame lives with the body: a constant small sway, it dips when they laugh or shrug and drifts back, the face is never perfectly centered, the wide phone lens makes the near arm big.
- Propped phone: nobody holds it, the frame never reframes; they lean in and out and partly leave the frame. Friend filming: the friend never appears, the camera reacts a beat late. Walk and talk: every step bobs the frame and the background slides past.
- Real people talking: two or three small human cues per clip, not more (one flaw reads as real, five read as a filter): a glance off to the side while thinking and back to the lens to land a point; a touch of hair or face; a small breath before a line; a laugh mid-sentence; looking down at the product while talking about it. Natural blinking, mouth relaxed between lines, no big head turn while a line is being said. Never an announcer or presenter voice, never a sales pitch.
- Phone behaviour, each at most once: the focus hunts for a beat when the product comes close to the lens; the exposure shifts a little toward a window. The background stays readable (front cameras don't blur it).
- Phone footage: wide phone lens, deep focus, everyday sharpness, available light, a small auto-exposure shift when something comes close to the lens. Not cinematic, not stabilized, not color-graded.
Real life (lifestyle): the person uses or wears the product in a real moment and never performs for the lens or talks to it. A camera with a person behind it (or a still tripod they move through). Small real actions counted out; the product clearly used the way it's meant to be.
Living photo: the camera is fixed and the picture stays exactly as it is: product, people, composition, light. Only one or two small natural motions bring it alive, slowly, in real time (steam from something hot, condensation sliding, a flame moving, light shifting, a breeze in fabric or leaves). Nothing else moves, nothing appears, people barely breathe and blink. No sparkles, no glitter, no dust that glows. Quiet ambient sound only.
Hero shot: a studio commercial. Controlled light, one slow motivated camera move, the product the hero of every frame, one product moment (a highlight traveling across it, a splash, a reveal, a slow turn). Precise and real: real materials, real physics, no CGI gloss, no floating sparkles.
- Light moves ON the product, never through the air: write a highlight sliding across its surface as the light source moves off-screen, never a visible beam, band, streak or flare in the frame.
- The product is rigid and stays exactly where it stands unless the story turns it; an orbit is a short, slow arc of the camera (15-25 degrees) around a product that doesn't move.
Hands-on: real hands doing the real thing, close: opening, pouring, applying, showing, every move counted ("two twists of the cap", "three taps"). Crisp close-mic contact sounds (ASMR). Hands only unless the picture shows more.
- One simple action carried through, not a sequence of fiddly steps: open it and use it, then hold it. Never put a cap, lid or dropper back on (models lose it): end with it open, in hand or set down beside the product, still visible.
Campaign: one shot per picture, each a few seconds with one strong move that suits it, ordered to build. Each shot starts from its own picture.

HOOKS, MOODS, STORIES
The client's picks are suggestions: keep their spirit, but fit them to this product, picture and length, and never break physics or the product to honour one. A hook is the first second; a story is how the clip unfolds; a mood is how the person behaves and sounds.
A lead-in (when the brief has one) is filmed toward the picture: the model gets the picture as its LAST frame, so write the two seconds just before it (the product tossed in and caught, coming up into view, dropping onto the surface, the light snapping on) ending in exactly the picture's composition, with the product and the people exactly where they are in it. Don't tag the picture in a lead-in; describe the action that lands on it. No speech in a lead-in.

WHAT THEY SAY (only when there is speech)
${SPEECH_RULES}

PEOPLE
Keep them who they are in the picture: same face, hair, clothes. Women and men act like real people, not models. A second person (a friend, or someone from the client's Cast shown in a reference picture) enters only when the story asks for it, from the side of the frame, and stays consistent; with a Cast person, refer to their reference picture by its tag and describe them in a few words too.

OUTPUT
Write each clip's prompt in the model's own syntax (given in the brief), in English (speech in the language asked), within its character limit. Close every prompt with the locks that matter for it (the product unchanged; who is in the video) and the "Audio:" line with "No music." and "No subtitles, no captions, no on-screen text."
Answer with JSON only:
{"idea": "at most 10 plain words a shopper would understand", "speaker": "woman" | "man" | "none", "focus": {"x": 0-1, "y": 0-1}, "clips": [{"picture": 1, "seconds": 10, "script": "the exact words said, in order, or \\"\\"", "emphasis": ["2-3 short phrases from the script that deserve a punch-in"], "prompt": "..."}]}
"focus" is where the speaker's face (or the product, when nobody talks) is in the first picture, as fractions of its width and height.`;

const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n) : "");

function readingText(read: ProductRead | null) {
  if (!read) return "- (No reading: work out what the product is from the pictures.)";
  return [
    `- What it is: ${read.name}${read.kind ? ` (${read.kind})` : ""}`,
    read.brand ? `- Brand: ${read.brand}` : "",
    read.text ? `- Printed on it: ${read.text}` : "",
    `- Look: ${read.look}`,
    read.size ? `- Size: ${read.size}` : "",
    `- How it's used: ${read.use}`,
    read.states.length ? `- Ways it can appear: ${read.states.join("; ")}` : "",
    read.hands ? `- Held: ${read.hands}` : "",
    read.never.length ? `- Would look wrong: ${read.never.join("; ")}` : "",
    read.people ? `- Who uses it: ${read.people}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type PlanInput = {
  spec: FilmSpec;
  read: ProductRead | null;
  notes: string;
  profile: Profile;
  can: ReturnType<typeof filmCaps>;
  /** Each clip's length, in order (one per part, or one per picture for a campaign). */
  lengths: number[];
  /** What the director sees, in order, with what each is. */
  looks: { path: string; label: string }[];
  /** The tags the video model knows the pictures by ("<IMAGE_1> Mia, from the client's Cast"). */
  tagged: string[];
  aspect: string;
  /** The first clip is a lead-in that lands on the picture. */
  lead: boolean;
  signal: AbortSignal;
};

function briefText({ spec, read, notes, profile, can, lengths: all, tagged, aspect, lead }: PlanInput) {
  // The take itself, after any lead-in.
  const lengths = lead ? all.slice(1) : all;
  const style = byFilmId(FILM_STYLES, spec.style);
  const people = spec.style === "creator" || spec.style === "lifestyle";
  const talking = spec.style === "creator" && spec.words !== "none";
  const line = (name: string, o: { label: string; brief: string }) => `- ${name}: ${o.label}. ${o.brief}`;
  const lang = LANGUAGES.find((l) => l.id === spec.language) ?? LANGUAGES[0];
  const parts = spec.style !== "campaign" && lengths.length > 1;
  return [
    "PRODUCT (read from its photo):",
    readingText(read),
    "",
    "THE CLIENT'S PICKS:",
    line("Style", style),
    spec.style !== "campaign" ? line("Camera", byFilmId(FILM_CAMERAS, spec.camera)) : "",
    line("Hook (the first second)", byFilmId(FILM_HOOKS, spec.hook)),
    people ? line("Mood", byFilmId(FILM_MOODS, spec.mood)) : line("Pace", byFilmId(FILM_PACES, spec.pace)),
    line(spec.style === "living" ? "What moves" : "Story", byFilmId(FILM_STORIES, spec.story)),
    spec.cast ? `- Who joins: ${spec.cast.name}, the client's own ${spec.cast.kind === "person" ? "person" : spec.cast.kind === "pet" ? "animal" : "character"}${spec.cast.traits ? ` (${spec.cast.traits.replace(/\.$/, "")})` : ""}; keep them exactly as in their reference picture.` : "",
    talking
      ? spec.words === "mine" && spec.script?.trim()
        ? `- What they say (the client's own words, said exactly, ${countWords(spec.script)} words): "${spec.script.trim()}"`
        : `- What they say: you write it, in ${lang.cue}.`
      : spec.style === "creator"
        ? "- What they say: nothing. No talking; they react without words (a laugh, a hum, a breath)."
        : "- Speech: none.",
    talking ? `- Language and accent: ${lang.cue}.` : "",
    spec.voice && can.voices ? `- Voice: a preset voice (<AUDIO_0>); write "she speaks with the voice from <AUDIO_0>" (or he) once.` : "",
    spec.loop ? "- Loop: the clip must end on exactly its first frame (it plays as a seamless loop)." : "",
    `- Client's notes: ${notes.trim() ? `"${notes.trim()}"` : "none"}`,
    "",
    "THE VIDEO MODEL:",
    `- ${profile.name}. Clips of ${can.minSeconds}-${can.maxSeconds} s${can.sound ? ", with sound and lip-synced speech" : ", silent (no sound at all: write no speech and no sound line)"}.`,
    `- Speech: ${profile.dialogue}`,
    profile.tags ? `- Pictures: ${profile.tags}` : "- Pictures: it can't be told about pictures by name; describe anyone who joins in words.",
    tagged.length ? `- What it gets (and nothing else): ${tagged.join("; ")}.` : "- What it gets: only the first frame.",
    `- Prompt format: ${profile.format}`,
    `- At most ${profile.maxChars} characters per prompt.`,
    "",
    "THE CUT:",
    `- Frame: ${aspect}.`,
    lead
      ? `- First a lead-in of ${all[0]} s (clip 1): the hook, filmed toward the picture, which the model gets as its LAST frame (nothing as its first). It ends exactly on the picture. Then the take below starts from the picture itself.`
      : "",
    spec.style === "campaign"
      ? `- ${lengths.length} shots, one per picture in the order given (picture 1 first), lasting ${lengths.map((s) => `${s} s`).join(", ")}.`
      : parts
        ? `- ${lengths.reduce((a, b) => a + b, 0)} s in all, filmed as ${lengths.length} parts of ${lengths.map((s) => `${s} s`).join(" + ")}. Part 1 starts from the picture; each next part starts from exactly the last frame of the one before and continues the same moment and the same sentence flow (no new hook, no reset). Write one clip per part and split the lines between them.`
        : `- ${lead ? "Then one" : "One"} clip of ${lengths[0]} s.`,
    lead ? `- Write ${all.length} clips in all: the lead-in first.` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

type DirectorAnswer = { idea: string; speaker: "woman" | "man" | "none"; focus: { x: number; y: number }; clips: (FilmPlan & { emphasis: string[] })[] };

function toAnswer(answer: string | null, lengths: number[], spec: FilmSpec): DirectorAnswer | null {
  const raw = answer ? jsonObject<{ idea?: unknown; speaker?: unknown; focus?: { x?: unknown; y?: unknown }; clips?: { picture?: unknown; seconds?: unknown; script?: unknown; emphasis?: unknown; prompt?: unknown }[] }>(answer) : null;
  const clips = (raw?.clips ?? [])
    .map((c, i) => ({
      idea: "",
      picture: Math.max(0, Math.min(spec.pictures.length - 1, (Number(c.picture) || i + 1) - 1)),
      seconds: lengths[i] ?? lengths.at(-1) ?? 8,
      script: tidy(c.script, 800),
      emphasis: Array.isArray(c.emphasis) ? c.emphasis.map((e) => tidy(e, 60)).filter(Boolean).slice(0, 3) : [],
      prompt: tidy(c.prompt, 5000),
    }))
    .filter((c) => c.prompt.length > 60);
  if (!clips.length || clips.length < lengths.length) return null;
  const n = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
  return {
    idea: tidy(raw?.idea, 90).replace(/\.$/, ""),
    speaker: raw?.speaker === "man" ? "man" : raw?.speaker === "none" ? "none" : "woman",
    focus: { x: n(raw?.focus?.x, 0.5), y: n(raw?.focus?.y, 0.4) },
    clips: clips.slice(0, lengths.length),
  };
}

async function direct(input: PlanInput): Promise<DirectorAnswer | null> {
  const ask = (prefer: string[]) =>
    askText({
      instructions: DIRECTOR_INSTRUCTIONS,
      text: briefText(input),
      references: input.looks,
      prefer,
      imageEdge: 1024,
      detail: "high",
      effort: "medium",
      timeoutMs: 3 * 60_000,
      signal: input.signal,
    }).catch(() => null);
  // A malformed answer gets one more try on another model.
  return toAnswer(await ask(DIRECTORS), input.lengths, input.spec) ?? toAnswer(await ask(DIRECTORS.slice(3).concat(DIRECTORS.slice(0, 3))), input.lengths, input.spec);
}

/** Without a text model: the picks in plain words, still kept honest about the product and the physics. */
function fallbackPlan(spec: FilmSpec, read: ProductRead | null, notes: string, lengths: number[]): DirectorAnswer {
  const style = byFilmId(FILM_STYLES, spec.style);
  const camera = byFilmId(FILM_CAMERAS, spec.camera);
  const story = byFilmId(FILM_STORIES, spec.story);
  const hook = byFilmId(FILM_HOOKS, spec.hook);
  const mood = byFilmId(FILM_MOODS, spec.mood);
  const name = read?.name ?? "the product";
  const script = spec.words === "mine" ? (spec.script?.trim() ?? "") : "";
  const clips = lengths.map((seconds, i) => ({
    idea: "",
    picture: spec.style === "campaign" ? i : 0,
    seconds,
    script,
    emphasis: [],
    prompt: [
      style.brief,
      spec.style !== "campaign" ? camera.brief : "",
      hook.id !== "none" ? hook.brief : "",
      spec.style === "creator" || spec.style === "lifestyle" ? mood.brief : "",
      story.brief,
      script ? `She says: ${script}` : "",
      notes.trim(),
      `${name[0].toUpperCase()}${name.slice(1)} stays exactly as in the first frame: same shape, colors and label.`,
      "Audio: natural sound with a visible cause. No music. No subtitles, no captions, no on-screen text.",
    ]
      .filter(Boolean)
      .join("\n"),
  }));
  return { idea: "", speaker: "woman", focus: { x: 0.5, y: 0.4 }, clips };
}

/* ------------------------------------------------------------------ the check */

const CHECK_INSTRUCTIONS = `You are the client's ad buyer checking a short product video before it runs. Image 1 is the clip as a grid of frames, each stamped with its time in seconds (the last frame is the clip's end). Image 2 is the first frame the client gave. Image 3, when given, is the client's own product photo. You also get the plan and, when someone talks, what was really said (a transcript) next to the lines that were written.
Reject it (pass: false) only for what a client would actually reject at phone size:
- the product changes: another shape, colors, label layout or logo, garbled print where it's readable; it duplicates, vanishes, melts, grows or shrinks;
- people: the face or body turns into someone else; extra, missing or fused fingers; warped hands or faces; a copy of the person; a stranger close to the camera nobody asked for; in a selfie video, the phone that films appearing in the shot, or both hands busy when one must hold the phone;
- physics that breaks the illusion: objects passing through hands or each other, teleporting, floating;
- speech: clearly garbled words, the wrong language, cut off mid-word at the end, most of the written lines missing, a second voice nobody asked for, talking when there should be none. The transcript is machine-made: it mishears brand names and abbreviations ("OAST" for OASE, "and aid plus" for NAD+), so never reject for how a name is spelled in it, and never for small rewordings, an extra or missing filler, or a synonym ("chocolate chips" for "cookies");
- captions, subtitles, logos, watermarks or any text that isn't printed on the product;
- a frozen or slideshow clip; a camera that does something wild nobody asked for; the asked action never happens;
- a living photo where the product, the people or the camera move noticeably, or something new appears.
Judge the result, not the plan's choreography: a gesture earlier or later, the product held a little differently, an extra sip, a tilt, the product briefly at the frame's edge, a different but natural ending are all fine (they often look more real). Something brought toward the lens looks bigger: that's perspective, not growth. Don't reject for taste, small drift nobody would notice, or natural extra movement.
When you reject, "fix" is for a re-film from the same first frame: one or two sentences the prompt adds, naming the exact moment to change. Make the hard moment easier (a simpler grip, the beat before contact, fewer actions, the product kept still) rather than asking for the same thing harder.
"end": if the clip's last moments are bad but everything before is good, the time in seconds where it should be cut; otherwise null.
Answer with JSON only: {"pass": true or false, "issues": ["each problem in one short plain sentence"], "fix": "", "end": null}`;

async function checkClip(
  clip: Buffer,
  { first, product, plan, read, said, signal, landing = false }: { first: string; product: string | null; plan: FilmPlan; read: ProductRead | null; said: Transcript | null; signal: AbortSignal; landing?: boolean },
): Promise<(FilmCheck & { fix: string; end: number | null }) | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-filmcheck-"));
  try {
    const file = path.join(dir, "clip.mp4");
    await fs.writeFile(file, clip);
    const length = await lengthOf(clip);
    const sheet = path.join(dir, "sheet.jpg");
    await fs.writeFile(sheet, await timedSheet(file, sheetTimes(length)));
    const answer = await askText({
      instructions: CHECK_INSTRUCTIONS,
      text: [
        `The product: ${read?.name ?? "the one in the first frame"}.`,
        read?.text ? `Printed on it: ${read.text}.` : "",
        `The plan (the prompt the video model got): ${plan.prompt.slice(0, 2400)}`,
        plan.script ? `Written lines: "${plan.script}"` : "Written lines: none (nobody should talk).",
        said ? `Really said (transcript${said.speakers > 1 ? `, ${said.speakers} different voices` : ""}): "${said.text || "(nothing)"}"` : "",
        `The clip runs ${length.toFixed(1)} s.`,
      ]
        .filter(Boolean)
        .join("\n"),
      references: [
        { path: sheet, label: "the clip, frame by frame, with times" },
        { path: first, label: landing ? "the frame the clip must end on (the client's picture)" : "the first frame the client gave" },
        ...(product ? [{ path: product, label: "the client's product photo" }] : []),
      ],
      prefer: DIRECTORS,
      imageEdge: 1700,
      detail: "high",
      effort: "low",
      timeoutMs: 3 * 60_000,
      signal,
    }).catch(() => null);
    const raw = answer ? jsonObject<{ pass?: unknown; issues?: unknown; fix?: unknown; end?: unknown }>(answer) : null;
    if (!raw || typeof raw.pass !== "boolean") return null;
    const end = typeof raw.end === "number" && raw.end > 1 && raw.end < length - 0.2 ? raw.end : null;
    return {
      pass: raw.pass,
      issues: Array.isArray(raw.issues) ? raw.issues.map((i) => tidy(i, 180)).filter(Boolean).slice(0, 4) : [],
      fix: tidy(raw.fix, 500),
      end,
      ...(said?.text ? { said: said.text.slice(0, 600) } : {}),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The re-film's prompt: the fix goes before the closing locks and the audio line. */
function withFix(prompt: string, fix: string) {
  const at = prompt.search(/\n?Audio:/);
  return at > 0 ? `${prompt.slice(0, at).trimEnd()}\nImportant: ${fix.trim()}\n${prompt.slice(at).trimStart()}` : `${prompt}\nImportant: ${fix.trim()}`;
}

/* ------------------------------------------------------------------ the shoot */

export type FilmResult = {
  outputs: EngineOutput[];
  usedPrompt: string;
  plans: (FilmPlan & { check?: FilmCheck })[];
  idea: string;
  read: ProductRead | null;
  /** The first frame, when it was re-shot for the camera. */
  startUrl?: string;
};

/** The lengths a take is filmed in: one clip, parts of a long take, or one shot per picture. */
function clipLengths(spec: FilmSpec, can: ReturnType<typeof filmCaps>, caps: Caps | null, lead = false): number[] {
  const fit = (s: number) => (caps?.duration ? (fitDuration(caps.duration, s) as number) : Math.min(can.maxSeconds, Math.max(can.minSeconds, Math.round(s))));
  if (lead) return [fit(2), ...clipLengths({ ...spec, seconds: Math.max(can.minSeconds, spec.seconds - 2) }, can, caps)];
  if (spec.style === "campaign") {
    const n = Math.max(1, spec.pictures.length);
    const each = Math.max(3, Math.min(can.maxSeconds, Math.round(spec.seconds / n)));
    return Array.from({ length: n }, () => fit(each));
  }
  const total = Math.max(can.minSeconds, Math.round(spec.seconds));
  if (total <= can.maxSeconds) return [fit(total)];
  const parts = Math.ceil(total / can.maxSeconds);
  const each = Math.ceil(total / parts);
  return Array.from({ length: parts }, () => fit(each));
}

/** Product photo and reading for a picture that came from a Product Studio take. */
function fromTake(id: string | undefined): { product: string | null; read: ProductRead | null } {
  const gen = id ? getGeneration(id) : null;
  if (!gen) return { product: null, read: null };
  const product = gen.references.find((r) => r.role === "product") ?? gen.references[0];
  const read = (gen.params?.studio as { read?: ProductRead | null } | undefined)?.read ?? null;
  return { product: product ? urlToPath(product.url) : null, read };
}

/** Picture shape (width / height) on disk. */
async function ratioOf(file: string) {
  const m = await sharp(file).metadata();
  return m.width && m.height ? m.width / m.height : 9 / 16;
}

/** The phrase's time in the transcript: where its first word is said. */
function phraseAt(said: Transcript, phrase: string, after = 0): { start: number; end: number } | null {
  const want = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  if (!want.length) return null;
  const words = said.words.map((w) => ({ ...w, t: w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") }));
  for (let i = 0; i < words.length; i++) {
    if (words[i].start < after) continue;
    if (words[i].t === want[0] && (want.length === 1 || words[i + 1]?.t === want[1])) {
      const last = words[Math.min(words.length - 1, i + want.length - 1)];
      return { start: words[i].start, end: last.end };
    }
  }
  return null;
}

/**
 * Punch-ins on the director's key phrases (held to the end of the sentence, at most ~2.4 s) and a
 * snap zoom on the first beat when that's the hook: cut in on the face, like a creator's own edit.
 */
function editPunches(spec: FilmSpec, said: Transcript | null, emphasis: string[], focus: { x: number; y: number }, length: number): Punch[] {
  const punches: Punch[] = [];
  if (spec.hook === "zoom") punches.push({ from: 0, to: Math.min(1.2, length / 4), zoom: 1.32, x: focus.x, y: focus.y, ramp: 0.12 });
  if (spec.story === "punch" && said?.words.length) {
    let after = punches.at(-1)?.to ?? 0;
    for (const phrase of emphasis) {
      const at = phraseAt(said, phrase, after + 0.4);
      if (!at) continue;
      // Until the sentence ends (or a beat after the phrase), never past the clip.
      const stop = said.words.find((w) => w.start >= at.start && /[.!?…]$/.test(w.text))?.end ?? at.end + 1;
      const to = Math.min(length - 0.3, Math.max(at.end + 0.4, Math.min(stop + 0.15, at.start + 2.4)));
      if (to - at.start < 0.6) continue;
      punches.push({ from: Math.max(0, at.start - 0.08), to, zoom: punches.length % 2 ? 1.18 : 1.26, x: focus.x, y: focus.y });
      after = to;
    }
  }
  return punches;
}

/* ------------------------------------------------------------------ the first frame */

/**
 * A video model can't move a camera from a friend's hands into the subject's own, put her in a car or
 * in front of a mirror, or add a person to a packshot. So when the camera you picked (or a creator take)
 * doesn't fit how the picture was taken, the picture is re-shot that way first, with the same person,
 * product and place, by an image model that keeps them; then it's filmed.
 */
const FRAME_INSTRUCTIONS = `Look at the picture and say how it was taken. Answer with JSON only: {"camera": one of "selfie" (a front-camera selfie at arm's length: the arm runs toward the lens), "walk" (a selfie while walking), "propped" (a phone standing on a surface, nobody holding it), "friend" (someone else filming the person from a little way off), "mirror" (filmed in a mirror, the phone visible), "car" (in a car), "pov" (first person: we see the person's own hands), "product" (the product on its own, nobody in it), "other"; "person": true when a person's face is clearly visible}`;

/** Which ways of taking a picture each camera pick can carry on from. */
const FITS: Record<string, string[]> = {
  selfie: ["selfie", "walk", "car"],
  walk: ["walk", "selfie"],
  propped: ["propped"],
  friend: ["friend", "other"],
  mirror: ["mirror"],
  car: ["car"],
  handheld: ["friend", "other", "walk"],
  tripod: ["friend", "other", "propped"],
  pov: ["pov"],
};

/** What each camera's first frame looks like, for the image model that re-shoots it. */
const STAGE: Record<string, string> = {
  selfie: "a vertical phone selfie at arm's length: the forearm enters the frame from a bottom corner toward the lens (the phone itself is never visible), the product in the other hand at chest height with its label toward the lens, looking into the lens, mouth relaxed and closed, about to speak",
  walk: "a vertical walking selfie on a sidewalk or path in the same kind of place: the forearm enters the frame from a bottom corner toward the lens (the phone itself is never visible), the product in the other hand or worn, looking into the lens mid-step, mouth closed",
  propped: "a vertical frame from a phone propped up on a table or counter facing them, nobody holding it: they sit close to it, both hands free, the product in one hand at chest height with its label toward the lens, looking into the lens, mouth closed",
  friend: "a vertical phone shot by a friend about a meter away (the friend is never visible): they face the camera, the product in hand with its label toward the camera, mouth closed, about to talk",
  mirror: "a vertical mirror selfie: they stand in front of a full-length mirror and film their reflection on a phone held at chest height (the phone visible in the reflection, covering only the chin), the product held or worn, the face fully visible",
  car: "a vertical phone selfie in the driver's seat of a parked car in daylight, seat belt off: the forearm enters the frame from a bottom corner (the phone itself is never visible), the product in the other hand with its label toward the lens, mouth closed",
  handheld: "a vertical phone shot by a friend a couple of meters away (the friend is never visible): they use the product naturally, not looking at the camera",
  tripod: "a vertical frame from a camera on a tripod at eye level: they use the product naturally, a little off-center, not looking at the camera",
  pov: "a vertical first-person view at their own eye height: only their own hands hold and use the product",
};

/** Image models that re-shoot a picture and keep the person and the product, best first. */
const STAGERS = ["comfy:openai/gpt-image-2.5-flare", "comfy:vertexai/gemini-nano-banana-2.1", "comfy:openai/gpt-image-2.5-sunburst", "local:flux3-klein", "local:flux2-klein-4b"];

const FRAME_DIR = path.join(DATA_DIR, "cache", "product", "frames");

/** How a picture was taken (cached by its bytes). */
async function readFrame(file: string, signal: AbortSignal): Promise<{ camera: string; person: boolean } | null> {
  const key = createHash("sha1").update(await fs.readFile(file)).update("|frame1").digest("hex");
  const cached = path.join(FRAME_DIR, `${key}.json`);
  const hit = await fs.readFile(cached, "utf8").then((t) => JSON.parse(t) as { camera: string; person: boolean }, () => null);
  if (hit) return hit;
  const answer = await askText({ instructions: FRAME_INSTRUCTIONS, text: "How was this picture taken?", references: [{ path: file, label: "the picture" }], prefer: DIRECTORS, imageEdge: 768, detail: "low", effort: "low", timeoutMs: 60_000, signal }).catch(() => null);
  const raw = answer ? jsonObject<{ camera?: unknown; person?: unknown }>(answer) : null;
  if (!raw || typeof raw.camera !== "string") return null;
  const frame = { camera: raw.camera, person: raw.person !== false };
  await fs.mkdir(FRAME_DIR, { recursive: true });
  await fs.writeFile(cached, JSON.stringify(frame));
  return frame;
}

/** The camera a take needs its first frame to have, or null when the picture can be filmed as it is. */
function wantedCamera(spec: FilmSpec, frame: { camera: string; person: boolean }): string | null {
  const people = spec.style === "creator" || spec.style === "lifestyle";
  if (!people) return null;
  // Nobody in it: a creator take starts from a selfie, a real-life take from a friend's phone.
  const want = spec.camera !== "auto" ? spec.camera : !frame.person || frame.camera === "product" ? (spec.style === "creator" ? "selfie" : "handheld") : null;
  if (!want || !STAGE[want]) return null;
  return frame.person && frame.camera !== "product" && FITS[want]?.includes(frame.camera) ? null : want;
}

/** Re-shoot the first frame for a camera: same person, product and place. Null when no image model managed it. */
async function stageFrame(
  { picture, product, read, camera, person, aspect, signal }: { picture: string; product: string | null; read: ProductRead | null; camera: string; person: boolean; aspect: EngineJob["aspect"]; signal: AbortSignal },
): Promise<{ path: string; url: string } | null> {
  const models = await listModels();
  const order = [...STAGERS.map((id) => models.find((m) => m.id === id && m.available)), ...models.filter((m) => m.kind === "image" && m.available && m.maxRefs > 0)].filter(
    (m, i, all): m is NonNullable<typeof m> => Boolean(m) && all.findIndex((x) => x?.id === m!.id) === i,
  );
  const who = person
    ? "the same person as in image 1 (same face, hair, skin tone, build and clothes)"
    : `a believable person who really buys this product${read?.people ? ` (${read.people})` : ""}, cast concretely (age, hair, skin tone, a casual everyday outfit), a woman unless the product is clearly for men`;
  const prompt = [
    `Image 1 is the client's picture${product ? "; image 2 is the product itself" : ""}. Make a new photo of ${who} with the same product${read?.name ? ` (${read.name})` : ""}, in the same kind of place and light as image 1, now as ${STAGE[camera]}.`,
    "A real, unposed phone photo: natural skin texture, everyday sharpness, deep focus, the background readable.",
    `Keep the product exactly as in ${product ? "image 2" : "image 1"}: same shape, colors, label and text${read?.text ? ` (${read.text.split(" / ").slice(0, 3).join(" ")})` : ""}. No added text or logos.`,
  ].join(" ");
  const size = sizeFor(aspect, 1920);
  for (const m of order.slice(0, 3)) {
    const engine = m.via ? engineFor(m.via) : null;
    if (!engine) continue;
    try {
      const out = await engine.run(
        {
          kind: "image",
          model: m.model,
          via: m.via ?? undefined,
          family: m.family,
          caps: m.caps ?? undefined,
          prompt,
          userPrompt: prompt,
          refine: false,
          aspect,
          width: size.width,
          height: size.height,
          count: 1,
          references: [{ path: picture, label: "the client's picture" }, ...(product ? [{ path: product, label: "the product" }] : [])],
          mode: "image",
        },
        { signal, progress: () => {} },
      );
      const img = out.outputs[0];
      if (!img) continue;
      const saved = await saveUpload(img.data);
      const file = urlToPath(saved.url);
      if (file) return { path: file, url: saved.url };
    } catch (err) {
      if (signal.aborted) return null;
      console.warn(`[film] re-staging on ${m.name} failed: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Read, direct, film, watch and cut. */
export async function runProductFilm(
  job: EngineJob,
  spec: FilmSpec,
  engine: Engine,
  def: ModelDef & { caps?: Caps | null },
  ctx: EngineContext,
  opts: { notes: string },
): Promise<FilmResult> {
  const caps = def.caps ?? job.caps ?? null;
  const can = filmCaps(def, caps);
  const profile = profileFor(def);
  if (!can.startFrame) throw new EngineError(`${def.name} makes clips from words only, so it can't start from your picture.`, "Pick a model that animates a picture.");
  const pictures = spec.pictures.map((p) => ({ ...p, path: urlToPath(p.url) })).filter((p): p is typeof p & { path: string } => Boolean(p.path));
  if (!pictures.length) throw new EngineError("Crackio can't find the picture to start from.", "Pick it again.");
  if (spec.style === "creator" && spec.words !== "none" && !can.sound) {
    throw new EngineError(`${def.name} makes silent clips, so nobody can talk in them.`, "Pick a model with sound (LTX-2.5 on your GPU, or MiniMax H3 or Veo 3.1 on your Comfy key), or set the words to No talking.");
  }

  // 1. The product: what Image mode read, or a fresh reading of its photo.
  ctx.progress(0.03, "Reading the product");
  const sources = pictures.map((p) => fromTake(p.from));
  const productPath = (spec.productUrl ? urlToPath(spec.productUrl) : null) ?? sources.find((s) => s.product)?.product ?? null;
  const read = spec.read ?? sources.find((s) => s.read)?.read ?? (productPath ? await readProduct([productPath], ctx.signal).catch(() => null) : null);
  if (ctx.signal.aborted) throw new EngineError("Cancelled.");

  // 1b. A first frame the camera can carry on from: re-shot first when the picture was taken another way.
  let staged: string | undefined;
  if (spec.style === "creator" || spec.style === "lifestyle") {
    const frame = await readFrame(pictures[0].path, ctx.signal).catch(() => null);
    const camera = frame ? wantedCamera(spec, frame) : null;
    if (frame && camera) {
      ctx.progress(0.05, "Re-shooting your picture for the camera");
      const shot = await stageFrame({ picture: pictures[0].path, product: productPath, read, camera, person: frame.person && frame.camera !== "product", aspect: job.aspect, signal: ctx.signal });
      if (shot) {
        pictures[0] = { ...pictures[0], url: shot.url, path: shot.path };
        staged = shot.url;
      }
    }
    if (ctx.signal.aborted) throw new EngineError("Cancelled.");
  }

  // Someone from your Cast: their pictures go to the model when it takes references.
  const castRefs: EngineReference[] = spec.cast ? job.references.filter((r) => r.role === "subject" && r.label?.startsWith(`${spec.cast!.name},`)).slice(0, Math.max(0, Math.min(2, can.refs))) : [];
  const voice = spec.voice && can.voices ? spec.voice : undefined;

  // 2. Direct.
  ctx.progress(0.08, spec.style === "creator" && spec.words !== "none" ? "Writing the script" : "Planning the shot");
  // Hooks that need the product to arrive (a toss, a reveal, a drop, the lights) are filmed as a lead-in that lands on the picture.
  const leadIn = LEAD_HOOKS.has(spec.hook) && can.endFrame && !def.id.startsWith("comfy:") && spec.style !== "campaign" && spec.style !== "living";
  const lengths = clipLengths(spec, can, caps, leadIn);
  const looks = [
    ...pictures.slice(0, spec.style === "campaign" ? 6 : 1).map((p, i) => ({ path: p.path, label: spec.style === "campaign" ? `picture ${i + 1} (the first frame of shot ${i + 1})` : "the picture: the clip's first frame" })),
    ...(productPath ? [{ path: productPath, label: "the client's product photo" }] : []),
    ...castRefs.slice(0, 1).map((r) => ({ path: r.path, label: `${spec.cast?.name}, from the client's Cast` })),
  ];
  const tagged = [
    "<IMAGE_0> the first frame",
    ...castRefs.map((r, i) => `<IMAGE_${i + 1}> ${spec.cast?.name} (${i === 0 ? "portrait" : "full figure"})`),
    ...(voice ? ["<AUDIO_0> the voice"] : []),
  ];
  const plan =
    (await direct({ spec, read, notes: opts.notes, profile, can, lengths, looks, tagged: profile.tags ? tagged : [], aspect: job.aspect, lead: leadIn, signal: ctx.signal })) ??
    fallbackPlan(spec, read, opts.notes, lengths);
  if (ctx.signal.aborted) throw new EngineError("Cancelled.");
  // Parts of one talking take need one voice from start to end: cast one when the client didn't.
  const partsVoice = voice ?? (spec.style !== "campaign" && lengths.length > 1 && can.voices && plan.speaker !== "none" && spec.words !== "none" ? (plan.speaker === "man" ? "leo" : "eve") : undefined);

  // 3 + 4. Film each clip, watch it, and re-film once when a client would reject it.
  const res = caps?.resolution ? fitResolution(caps.resolution.choices, spec.resolution ?? "1080p", caps.resolution.default) : (spec.resolution ?? "1080p");
  const total = plan.clips.length;
  const done = plan.clips.map(() => 0);
  const report = (i: number, v: number, stage: string) => {
    done[i] = Math.max(done[i], v);
    ctx.progress(0.14 + 0.74 * (done.reduce((a, b) => a + b, 0) / total), stage);
  };
  const terms = [read?.brand ?? "", ...(read?.text?.split(" / ").slice(0, 2) ?? [])].filter(Boolean);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-film-"));
  try {
    const filmOne = async (i: number, start: string, prompt: string, from: number, span: number) => {
      const seconds = plan.clips[i].seconds;
      // A lead-in lands on the picture (pinned as its last frame); a loop starts and ends on it.
      const landing = leadIn && i === 0;
      const end = landing || (spec.loop && can.endFrame && spec.style === "living") ? { path: start, label: "the end frame" } : undefined;
      const clipJob: EngineJob = {
        ...job,
        prompt,
        userPrompt: prompt,
        refine: false,
        count: 1,
        references: landing ? [] : [{ path: start, label: "the start frame" }, ...castRefs],
        start: landing ? undefined : { path: start, label: "the start frame" },
        end,
        refImages: castRefs.length ? castRefs : undefined,
        options: { ...job.options, duration: seconds, ...(res ? { resolution: String(res) } : {}), sound: can.sound ? true : undefined, ...(partsVoice ? { voice: partsVoice } : {}) },
      };
      const out = await engine.run(clipJob, { signal: ctx.signal, progress: (v) => report(i, from + v * span, total > 1 ? `Filming ${i + 1} of ${total}` : "Filming") });
      const clip = out.outputs[0];
      if (!clip) throw new EngineError("The video model returned nothing.");
      // The clip keeps its picture's shape (some models hand it back stretched to a standard one).
      const shaped = await keepShape(clip.data, await ratioOf(start));
      return { ...clip, data: shaped.data, width: shaped.width || clip.width, height: shaped.height || clip.height, prompt: out.usedPrompt || prompt };
    };

    type Made = { data: Buffer; width?: number; height?: number; check?: FilmCheck & { fix?: string; end?: number | null }; prompt: string; said: Transcript | null; start: string };
    const watch = async (i: number, made: Omit<Made, "check" | "said">): Promise<Made> => {
      const plan_ = { ...plan.clips[i], prompt: made.prompt };
      const said = can.sound ? await transcribeBuffer(made.data, terms, ctx.signal) : null;
      if (!spec.check || ctx.signal.aborted) return { ...made, said };
      report(i, 0.72, total > 1 ? "Checking the clips" : "Checking the clip");
      const verdict = await checkClip(made.data, { first: made.start, product: productPath, plan: plan_, read, said, signal: ctx.signal, landing: leadIn && i === 0 });
      return { ...made, said, check: verdict ?? undefined };
    };

    const shootClip = async (i: number, start: string): Promise<Made> => {
      const span = spec.check ? 0.7 : 1;
      let made = await watch(i, { ...(await filmOne(i, start, plan.clips[i].prompt, 0, span)), start });
      const first = made.check;
      if (first && !first.pass && first.fix && !ctx.signal.aborted) {
        report(i, 0.76, "Re-filming a clip");
        const retry = await filmOne(i, start, withFix(plan.clips[i].prompt, first.fix), 0.76, 0.16)
          .then((m) => watch(i, { ...m, start }))
          .catch(() => null);
        // Keep whichever came out better: a pass, or fewer problems.
        if (retry && (!retry.check || retry.check.pass || retry.check.issues.length < first.issues.length)) made = { ...retry, check: retry.check ? { ...retry.check, retried: true } : { pass: true, issues: [], retried: true } };
        else made = { ...made, check: { ...first, retried: true } };
      }
      report(i, 1, "Cutting");
      return made;
    };

    let made: Made[];
    if (spec.style === "campaign") {
      // Every shot from its own picture, all at once.
      made = await Promise.all(plan.clips.map((c, i) => shootClip(i, pictures[Math.min(c.picture, pictures.length - 1)].path)));
    } else {
      // A long take in parts: each part starts from the last good frame of the one before.
      made = [];
      let start = pictures[0].path;
      for (let i = 0; i < plan.clips.length; i++) {
        const m = await shootClip(i, start);
        made.push(m);
        // After a lead-in the take starts from the picture itself; each later part from the last good frame.
        if (i < plan.clips.length - 1) start = leadIn && i === 0 ? pictures[0].path : await lastFrame(m.data, path.join(work, `part${i + 1}.png`), m.check?.end ?? undefined);
      }
    }
    if (ctx.signal.aborted) throw new EngineError("Cancelled.");

    // 5. Cut: one clip, or the parts and shots joined; then the punch-ins on the words.
    ctx.progress(0.9, "Cutting");
    const sharpest = made.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a));
    const width = sharpest.width ?? 1080;
    const height = sharpest.height ?? 1920;
    let data =
      made.length === 1 && !made[0].check?.end
        ? made[0].data
        : await joinParts(
            made.map((m) => ({ data: m.data, out: m.check?.end ?? undefined })),
            { width, height, fade: spec.style === "campaign" ? 0.04 : 0 },
          );
    if (spec.style === "creator" || spec.style === "lifestyle") {
      // Word times across the joined take: each part's transcript shifted by where it starts.
      let offset = 0;
      const words: Transcript["words"] = [];
      for (const m of made) {
        for (const w of m.said?.words ?? []) words.push({ ...w, start: w.start + offset, end: w.end + offset });
        offset += m.check?.end ?? (await lengthOf(m.data));
      }
      const said: Transcript | null = words.length ? { text: made.map((m) => m.said?.text ?? "").join(" "), words, speakers: 1 } : null;
      const punches = editPunches(spec, said, plan.clips.flatMap((c) => c.emphasis), plan.focus, offset);
      if (punches.length) {
        ctx.progress(0.94, "Cutting in on the words");
        data = await punchIns(data, punches);
      }
      // Captions from what was really said, a few words at a time, the way creators burn them in.
      if (spec.captions && said) {
        ctx.progress(0.96, "Adding captions");
        data = await burnCaptions(data, said);
      }
    } else if (spec.hook === "zoom") {
      data = await punchIns(data, editPunches(spec, null, [], plan.focus, await lengthOf(data)));
    }
    // A Campaign edit gets its music, made from code and landing on every cut.
    if (spec.style === "campaign" && made.length > 1) {
      ctx.progress(0.95, "Scoring the edit");
      const lengths = await Promise.all(made.map(async (m) => m.check?.end ?? (await lengthOf(m.data))));
      const cuts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
      const total = lengths.reduce((a, b) => a + b, 0);
      const score = await scoreFor(cuts, total, spec.pace, ctx.signal);
      if (score) data = await withScore(data, score, total);
    }

    const plans = plan.clips.map((c, i) => ({
      idea: plan.idea,
      script: c.script || undefined,
      prompt: made[i]?.prompt ?? c.prompt,
      seconds: c.seconds,
      picture: c.picture,
      ...(made[i]?.check ? { check: { pass: made[i].check!.pass, issues: made[i].check!.issues, ...(made[i].check!.retried ? { retried: true } : {}), ...(made[i].said?.text ? { said: made[i].said!.text.slice(0, 600) } : {}) } } : {}),
    }));
    return { outputs: [{ data, mime: "video/mp4", width, height }], usedPrompt: plans.map((p) => p.prompt).join("\n\n---\n\n"), plans, idea: plan.idea, read, ...(staged ? { startUrl: staged } : {}) };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

const SCRIPT_INSTRUCTIONS = `You write what a creator says in a short UGC video about a product: a real person talking to their phone, not an ad. You get the picture the video starts from, the product, the client's picks and the length.
${SPEECH_RULES}
- Fit the mood, hook and story picked.
Answer with the words only: no quotes, no stage directions, no speaker names.`;

/** A first draft of what the creator says, for the client to edit before filming. */
export async function writeScript(input: { spec: Pick<FilmSpec, "style" | "camera" | "hook" | "mood" | "story" | "language" | "seconds">; picture: string | null; product: string | null; read: ProductRead | null; notes: string }): Promise<string | null> {
  const { spec } = input;
  const lang = LANGUAGES.find((l) => l.id === spec.language) ?? LANGUAGES[0];
  const read = input.read ?? (input.product ? await readProduct([input.product]).catch(() => null) : null);
  const answer = await askText({
    instructions: SCRIPT_INSTRUCTIONS,
    text: [
      "PRODUCT:",
      readingText(read),
      "",
      `Filmed: ${byFilmId(FILM_CAMERAS, spec.camera).label}. Hook: ${byFilmId(FILM_HOOKS, spec.hook).brief} Mood: ${byFilmId(FILM_MOODS, spec.mood).brief} Story: ${byFilmId(FILM_STORIES, spec.story).brief}`,
      `Language: ${lang.cue}. Length: ${spec.seconds} s.`,
      input.notes.trim() ? `Client's notes: "${input.notes.trim()}"` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    references: [...(input.picture ? [{ path: input.picture, label: "the picture the video starts from" }] : []), ...(input.product ? [{ path: input.product, label: "the product photo" }] : [])],
    prefer: DIRECTORS,
    imageEdge: 768,
    detail: "low",
    effort: "low",
    timeoutMs: 90_000,
  }).catch(() => null);
  return answer ? answer.replace(/^["“]|["”]$/g, "").replace(/\s+/g, " ").trim().slice(0, 900) : null;
}

/** A transcript of a clip held in memory. */
async function transcribeBuffer(data: Buffer, terms: string[], signal: AbortSignal) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-said-"));
  try {
    const file = path.join(dir, `${createHash("sha1").update(data).digest("hex").slice(0, 12)}.mp4`);
    await fs.writeFile(file, data);
    return await transcribe(file, { signal, terms });
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
