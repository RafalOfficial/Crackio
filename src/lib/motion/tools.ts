import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { engineFor } from "@/lib/engines";
import { EngineError, type EngineJob, type EngineOutput } from "@/lib/engines/types";
import type { ModelAvailability } from "@/lib/models/catalog";
import { resolveModel } from "@/lib/models/resolve";
import { estimateDepth, subjectMask } from "@/lib/server/vision";
import { ASPECTS, sizeFor, type AspectId } from "@/lib/shot";
import { colorStats, describeColor, describeLoudness, loudness, neutralize, summarizeVideoColor, videoColor, yellowCast } from "./analyze";
import type { ToolCall, ToolSpec } from "./brain";
import { critique, formatReview } from "./critic";
import { checkRoom, clock, estimateBytes, fetchMedia, fetchTranscript, findInTranscript, foundLine, readInfo, readTranscript, searchVideos, size, span, stamp, transcriptWindow, type SourceInfo } from "./download";
import { contactSheet, ffmpegPath, frameTimes, kindOf, probe, runFfmpeg, toDataUrl, waveform } from "./ffmpeg";
import { drawIdeas, formatIdea, IDEA_KINDS, lintPlan, type IdeaKind, type MotionPlan, type PlanShot } from "./playbook";
import type { MotionMedia } from "./media";
import { describeRecent, type RecentPiece } from "./recent";
import { renderComposition } from "./render";
import { renderSound } from "./sound";
import type { MotionComposition, MotionFile } from "./store";
import { cleanName, fileLine, folderUrl, resolveFile, snapshot, ToolError, uniqueName } from "./workspace";

/** Render limits and review rounds per turn. Image and clip budgets come with the route (media.ts): roomy on the user's plans, tight when billed. */
export const LIMITS = { renderSeconds: 600, soundSeconds: 600, reviews: 1 };

/** What a turn knows about itself: its plan, the reviews it has had, and what it has drawn. */
export type TurnState = { plan: MotionPlan | null; reviews: number; reviewed: Set<string>; draws: number };

export type ToolEnv = {
  projectId: string;
  dir: string;
  origin: string;
  canvas: { aspect: AspectId | "auto"; width: number; height: number };
  signal: AbortSignal;
  usage: { images: number; videos: number };
  /** The image and video models this turn may use, and their budgets. */
  media: MotionMedia;
  /** The model running Motion; the critic is a fresh conversation with it. */
  model: ModelAvailability;
  /** The user's request this turn. */
  brief: string;
  turn: TurnState;
  /** Saves the plan to the project (and to the recent-pieces list). */
  savePlan: (plan: MotionPlan) => Promise<void>;
  recent: RecentPiece[];
  /** Live progress for the running step. */
  detail: (text: string) => void;
  /** Measure a new or rewritten file and add it to the project. */
  addFile: (name: string, source: MotionFile["source"], extra?: Partial<MotionFile>) => Promise<MotionFile>;
  addComposition: (c: MotionComposition) => Promise<void>;
  files: () => Promise<MotionFile[]>;
};

/** `summary` is the line the step shows the user once it's done (the plan's concept, the review's verdict). */
export type ToolOutcome = { ok: boolean; output: string; summary?: string; images?: string[]; files?: string[]; finish?: { file: string; message: string } };

const ASPECT_IDS = ASPECTS.map((a) => a.id);
const title = { type: "string", description: "A short status line for the user, present tense, e.g. 'Generating the hero shot'." };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "ideas",
    description:
      "Draw concrete moves from Motion's playbook of about 400 studio techniques: formats, hooks, structures, camera moves (clip prompts and virtual cameras), transitions (with ffmpeg and HTML recipes), type treatments, effects (HTML, GSAP, three.js), grades (ffmpeg filter chains), sound design, editing, endings, realism tactics for generated media, and the habits that make work look cheap ('avoid'). Every draw is a fresh hand that fits what you describe and steers away from what recent projects used. Draw before you plan, and again whenever you need a specific solution.",
    parameters: {
      type: "object",
      properties: {
        title,
        about: { type: "string", description: "What you're making, in a few words: subject, purpose, platform, mood." },
        kinds: { type: "array", items: { type: "string", enum: IDEA_KINDS }, description: "Which kinds to draw (default: format, hook, structure, look, sound, transition)." },
        count: { type: "integer", minimum: 4, maximum: 30, description: "How many ideas (default 14)." },
      },
      required: ["about"],
    },
  },
  {
    name: "plan",
    description:
      "Write (or revise) the creative plan. Required before the first image, clip or render of a project. One concept in a sentence or two, the format, the look and palette, the type (or none), the sound (the score and effects you'll write in code), and a shot list with real timings: what happens, how the camera or the subject moves, where it comes from (image, clip, render, footage), how it enters, and any on-screen text. Name 2-4 signature moves by playbook id. Returns a senior's notes on pacing, text, sound, color and repetition: act on the ones that apply and call plan again if the plan changes.",
    parameters: {
      type: "object",
      properties: {
        title,
        concept: { type: "string" },
        format: { type: "string", description: "The format, ideally a playbook id or name." },
        audience: { type: "string", description: "Who it's for and where it plays." },
        seconds: { type: "number" },
        look: { type: "string", description: "The grade and light: e.g. 'neutral daylight, true whites, soft contrast, fine grain'." },
        palette: { type: "string" },
        type: { type: "string", description: "Typefaces and how text is used, or 'none'." },
        music: { type: "string", description: "The score you'll write with render_audio (tempo, key, instruments, where it builds and lands), or empty for none." },
        sfx: { type: "string", description: "Sound design (hits, whooshes, ticks, beds) and any clip sound you'll keep." },
        shots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              seconds: { type: "number" },
              what: { type: "string", description: "What we see and what moves." },
              camera: { type: "string" },
              source: { type: "string", enum: ["image", "clip", "render", "footage"] },
              transition: { type: "string", description: "How it enters: cut on action, match cut, whip, dissolve..." },
              text: { type: "string", description: "Exact on-screen words, if any (most shots have none)." },
            },
            required: ["seconds", "what"],
          },
        },
        moves: { type: "array", items: { type: "string" }, description: "Playbook ids of the signature moves." },
      },
      required: ["concept", "seconds", "look", "shots"],
    },
  },
  {
    name: "generate_image",
    description:
      "Make a new image with the user's image model (on their plans). Use it for keyframes, start and end frames for clips, backgrounds, products, characters, textures and plates. To edit an image, or keep a character, product or place consistent, list project images in `references` (up to 5) and say what to keep and what to change. Write the prompt as a photographer's or art director's notes: subject and action, the real place, composition, camera and lens, the real light source and the hour, white balance, palette, materials, imperfections. Never write 'cinematic', 'epic', 'hyperrealistic', '8k' or 'masterpiece'. Keep text out of images; set type with render_html. A yellow cast is measured on every image and taken out automatically (pass keep_color when warm light is truly intended). Returns the file with a color reading and shows it to you. Takes 20-60 s.",
    parameters: {
      type: "object",
      properties: {
        title,
        prompt: { type: "string" },
        aspect: { type: "string", enum: ASPECT_IDS },
        references: { type: "array", items: { type: "string" }, description: "Project image file names to edit or to match." },
        engine: {
          type: "string",
          enum: ["auto", "ideogram"],
          description: "auto (default): the route's picture model for new pictures and its edit model for edits of a reference. ideogram is only available on the billed route, for edits heavy on text or layout. Unavailable choices fall back to auto.",
        },
        keep_color: { type: "boolean", description: "Keep a warm or colored cast as generated (a real sunset, candlelight)." },
        name: { type: "string", description: "File name to save as, e.g. 'hero.png'." },
      },
      required: ["title", "prompt", "aspect"],
    },
  },
  {
    name: "generate_video",
    description:
      "Make a video clip with the user's video model (Grok Imagine on their plan): 1-15 s, up to 1080p, with generated sound unless sound is false. For continuity and control give start_image (image to video), and end_image to land exactly on a frame; without a start image it is text to video at `aspect`. Describe one clear action at real-time speed (generated clips drift into dreamy slow motion unless told otherwise) and one camera move (push in, orbit left, handheld follow, crane up, fly-through...). For on-camera speech, write the exact line in quotes and who says it; the clip's sound will carry it. Returns the clip with frames and a color reading. Takes 1-3 minutes, so plan your shots and make independent ones in parallel. Use only the best seconds of each clip.",
    parameters: {
      type: "object",
      properties: {
        title,
        prompt: { type: "string" },
        start_image: { type: "string", description: "Project image to start from." },
        end_image: { type: "string", description: "Project image to end on (needs start_image)." },
        duration: { type: "integer", minimum: 1, maximum: 15 },
        aspect: { type: "string", enum: ASPECT_IDS, description: "Shape of the clip. With a start image of another shape, the image is center-cropped to it." },
        sound: { type: "boolean", description: "Generate sound with the clip (default true)." },
        name: { type: "string", description: "File name to save as, e.g. 'shot-1.mp4'." },
      },
      required: ["title", "prompt", "duration"],
    },
  },
  {
    name: "render_html",
    description:
      "Design motion as ONE self-contained HTML document and render it to video on this computer (headless Chrome with WebGL, frame-accurate). Use it for 2.5D camera moves on stills (three.js with a depth map), virtual cameras through image planes, shader transitions, typography, captions, UI and product animations, diagrams, collages, overlays on footage and complete designed pieces. Follow the timing rules in your instructions. Project files load by plain name: <img src=\"hero.png\">, <video src=\"clip.mp4\" muted playsinline preload=\"auto\" data-start=\"2\">. Libraries: GSAP <script src=\"/api/motion/lib/gsap.min.js\"></script> plus plugins from the same folder (SplitText, CustomEase, MotionPathPlugin, Flip, ScrambleTextPlugin, DrawSVGPlugin, MorphSVGPlugin, Physics2DPlugin, CustomWiggle, CustomBounce, TextPlugin .min.js); three.js as a module via <script type=\"importmap\">{\"imports\":{\"three\":\"/api/motion/lib/three.module.js\",\"three/addons/\":\"/api/motion/lib/addons/\"}}</script> (addons such as postprocessing/EffectComposer.js, postprocessing/UnrealBloomPass.js, postprocessing/RenderPass.js, shaders/...). Audio is not rendered; add sound afterwards with ffmpeg. transparent: true renders a VP9 .webm with alpha for overlaying with ffmpeg (decode it with -c:v libvpx-vp9 placed before its -i). Returns the file and shows you frames.",
    parameters: {
      type: "object",
      properties: {
        title,
        html: { type: "string" },
        duration: { type: "number", description: "Seconds." },
        width: { type: "integer", description: "Defaults to the canvas width." },
        height: { type: "integer", description: "Defaults to the canvas height." },
        fps: { type: "integer", enum: [24, 25, 30, 60] },
        transparent: { type: "boolean" },
        name: { type: "string", description: "File name to save as, e.g. 'titles.mp4'." },
      },
      required: ["title", "html", "duration"],
    },
  },
  {
    name: "ffmpeg",
    description:
      "Run ffmpeg 6.1 in the project folder: cut, trim, scale, crop, concatenate, crossfade (xfade, acrossfade), speed ramps, overlays, color, mixing, ducking, fading and normalizing audio, burning subtitles (subtitles, ass), extracting frames, converting. Pass the arguments as a list without the program name; Crackio adds -y -hide_banner -loglevel error. Inputs and outputs are plain file names in the project folder (no paths, URLs or devices). Write new output names: the user's own files are read-only. Returns new and changed files with their details, and frames of the newest video.",
    parameters: { type: "object", properties: { title, args: { type: "array", items: { type: "string" } } }, required: ["title", "args"] },
  },
  {
    name: "capture_web",
    description:
      "Capture a public web page the user mentions (their site, app, store page, article): a screenshot, or a smooth top-to-bottom scroll recording as video. Good for website and app promos and for showing real pages in an edit. Returns the file and shows it to you.",
    parameters: {
      type: "object",
      properties: {
        title,
        url: { type: "string", description: "http(s) address of a public page." },
        mode: { type: "string", enum: ["screenshot", "scroll"], description: "screenshot (default) or scroll." },
        width: { type: "integer", description: "Viewport width (default 1440; 390 for a phone view)." },
        height: { type: "integer", description: "Viewport height (default 900; 844 for a phone view)." },
        full_page: { type: "boolean", description: "Screenshot the whole page, not just the first screen." },
        seconds: { type: "number", description: "Length of a scroll recording (default 8)." },
        name: { type: "string" },
      },
      required: ["title", "url"],
    },
  },
  {
    name: "download",
    description:
      "Get a video, song or podcast from the internet into the project folder (yt-dlp): YouTube (videos, Shorts, podcasts, past streams), X, TikTok, Reddit, Vimeo, Twitch, SoundCloud, Bandcamp, news sites, direct media links and most other video sites. Use it whenever the user links footage, music or a talk to edit or remix, or asks for a specific real video. get 'info' reads the title, length and chapters and saves the transcript (timed to the word when the site has captions; read it with transcript) without downloading the media: do this first for anything longer than a few minutes. get 'video' (default) downloads it at up to max_height (720 by default: plenty for edits, and fast; 1080 only when the piece needs it); get 'audio' only the sound. start and end (seconds of the source) download just that part: small, but slower per minute than a whole video, so use them for a few minutes of something long. A whole download keeps the source's clock, so transcript times are file times; a part starts at 0. get 'search' finds YouTube videos for query, only when the user wants real footage and gave no link. Downloads are read-only. Returns the file with frames.",
    parameters: {
      type: "object",
      properties: {
        title,
        url: { type: "string", description: "The page or media address (http or https)." },
        get: { type: "string", enum: ["video", "audio", "info", "search"], description: "video (default), audio, info or search." },
        query: { type: "string", description: "What to look for (get 'search')." },
        max_height: { type: "integer", enum: [360, 480, 720, 1080, 1440, 2160], description: "Tallest picture to download (default 720)." },
        start: { type: "number", description: "Download from this second of the source." },
        end: { type: "number", description: "Download up to this second of the source." },
        name: { type: "string", description: "File name to save as, e.g. 'podcast.mp4' (default: from the title)." },
      },
    },
  },
  {
    name: "transcript",
    description:
      "Read a transcript that download saved (NAME.transcript.json). from and to (seconds, up to 15 minutes at a time) list what's said, each line with its start; windows of 2 minutes or less also give every word's start, so you can cut single words. find lists every place a word or phrase is said, with the exact start and end of those words: for sentence mixing, supercuts, and finding the best lines of a long talk. Times are seconds of the source.",
    parameters: {
      type: "object",
      properties: {
        title,
        file: { type: "string" },
        from: { type: "number" },
        to: { type: "number" },
        find: { type: "array", items: { type: "string" }, description: "Words or short phrases to find." },
      },
      required: ["file"],
    },
  },
  {
    name: "write_file",
    description: "Write a text file into the project folder: concat lists, .ass or .srt subtitles, SVG, JSON, CSS, notes. Up to 300 KB.",
    parameters: { type: "object", properties: { title, name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] },
  },
  {
    name: "render_audio",
    description:
      "Make sound from code: write Web Audio code and Crackio renders it offline (deterministic, free) to a stereo WAV of exactly `duration` seconds. Schedule everything at the seconds your picture needs: hits on cuts, whooshes under moves, a riser into the reveal, a bed or a beat under the piece. Your code runs as the body of an async function with (ctx, kit, duration); ctx is an OfflineAudioContext (48 kHz). Route sounds to kit.master (a gentle compressor into the output) or to a kit.bus(). The kit, all times in seconds: kit.beat(bpm, t0, t1, { kick: 'x...x...', snare: '....x...', clap, hat, open, gain, dest }) returns hit times; kit.kick(t) kit.snare(t) kit.clap(t) kit.hat(t, { open }); kit.tone(note, t, dur, { type, gain, attack, release, to, cutoff, pan, send }); kit.pad(['A3','C4','E4'], t, dur, { gain, cutoff, open }); kit.pluck(note, t, { decay, pan }); kit.bass(note, t, dur); kit.whoosh(t, dur, { from, to, pan }); kit.riser(t, dur) (lands at t + dur); kit.impact(t); kit.tick(t) (UI taps); kit.shimmer(t, dur); kit.room(t, dur) (a quiet bed); kit.bus({ gain, send }); kit.duck(bus, times, { depth, release }); kit.reverb (a send input); kit.hz('C#4'); kit.rand() (seeded). Plain Web Audio works too (oscillators, filters, convolvers, AudioBufferSourceNode). Notes are names like 'A3' or Hz. The result is peak-normalized; set the final loudness when you mix it under the picture with ffmpeg. Returns the WAV and its waveform.",
    parameters: {
      type: "object",
      properties: {
        title,
        code: { type: "string" },
        duration: { type: "number", description: "Seconds." },
        name: { type: "string", description: "File name, e.g. 'score.wav'." },
      },
      required: ["code", "duration"],
    },
  },
  {
    name: "image_map",
    description:
      "Make a map of a project image on this computer: 'depth' (white near, black far) for 2.5D parallax camera moves in three.js, depth of field, fog or separating the sky; 'subject' (white subject on black) for putting type behind a person or object, pop-outs and selective grades. Same size as the image. Returns the map.",
    parameters: {
      type: "object",
      properties: { title, image: { type: "string" }, map: { type: "string", enum: ["depth", "subject"] }, name: { type: "string" } },
      required: ["image", "map"],
    },
  },
  {
    name: "look",
    description:
      "See a project file: an image (with a color reading: white-balance cast, saturation, clipping); a video as a grid of frames (8 evenly spaced, or at `times` in seconds, left to right, top to bottom) with its color reading and loudness; an audio file as a waveform with its loudness; a text file's contents. Use it to understand the user's material and to check your work.",
    parameters: { type: "object", properties: { file: { type: "string" }, times: { type: "array", items: { type: "number" } } }, required: ["file"] },
  },
  {
    name: "list_files",
    description: "List every file in the project folder with its kind, size, dimensions, duration and where it came from.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "review",
    description: `An independent creative director reviews a finished cut before you deliver it: a fresh model that didn't make it sees frames across the whole video, three large stills and measurements (cuts, color cast, loudness), and returns scores, what works, and the fixes that matter, with a ship or fix verdict. Required before finish. At most ${LIMITS.reviews} rounds per turn: fix what it flags as high (and quick medium items), then review the new file.`,
    parameters: { type: "object", properties: { title, file: { type: "string" } }, required: ["file"] },
  },
  {
    name: "finish",
    description:
      "Deliver the result and end your turn: the final file (normally an .mp4) and a short, plain message to the user, 1-3 sentences on what you made and what they could change. The file needs a review first (unless the review rounds are used up).",
    parameters: { type: "object", properties: { file: { type: "string" }, message: { type: "string" } }, required: ["file", "message"] },
  },
];

/** The line shown for a step when the model gave no title. */
export function stepTitle(call: ToolCall): string {
  const a = call.args;
  const given = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 90) : "";
  if (given) return given;
  switch (call.name) {
    case "look":
      return `Looking at ${String(a.file ?? "a file")}`;
    case "list_files":
      return "Checking the project folder";
    case "write_file":
      return `Writing ${String(a.name ?? "a file")}`;
    case "finish":
      return "Delivering";
    case "generate_image":
      return "Generating an image";
    case "generate_video":
      return "Generating a clip";
    case "render_html":
      return "Rendering motion graphics";
    case "ffmpeg":
      return "Editing with ffmpeg";
    case "capture_web":
      return "Capturing a web page";
    case "download":
      return a.get === "search" ? "Searching YouTube" : a.get === "info" ? "Reading the link" : a.get === "audio" ? "Downloading the sound" : "Downloading the video";
    case "transcript":
      return a.find ? "Searching the transcript" : "Reading the transcript";
    case "ideas":
      return "Drawing ideas from the playbook";
    case "plan":
      return "Planning the piece";
    case "render_audio":
      return "Designing the sound";
    case "image_map":
      return a.map === "subject" ? "Separating the subject" : "Measuring depth";
    case "review":
      return "Getting a second opinion";
    default:
      return call.name;
  }
}

/* ---------------------------------------------------------------- helpers */

const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${what} is required.`);
  return v.trim();
};
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);
const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

function aspectOf(v: unknown, env: ToolEnv): AspectId {
  if (typeof v === "string" && (ASPECT_IDS as string[]).includes(v)) return v as AspectId;
  return env.canvas.aspect === "auto" ? "16:9" : env.canvas.aspect;
}

function nearestAspect(width?: number, height?: number): AspectId {
  if (!width || !height) return "16:9";
  const r = width / height;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? a : best)).id;
}

function extFor(mime: string) {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "bin";
}

async function save(env: ToolEnv, data: Buffer, wanted: unknown, fallback: string, ext: string) {
  const name = await uniqueName(env.dir, cleanName(typeof wanted === "string" && wanted.trim() ? wanted : fallback, ext));
  await fs.writeFile(path.join(env.dir, name), data);
  return name;
}

async function preview(file: string, size = 768) {
  return toDataUrl(await sharp(file).resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).flatten({ background: "#101012" }).jpeg({ quality: 78 }).toBuffer());
}

async function sheetOf(file: string, count = 6, times?: number[]) {
  const info = await probe(file);
  const at = times?.length ? times.map((t) => Math.max(0, Math.min(t, (info.duration ?? 0) - 0.05))) : frameTimes(info.duration ?? 1, count);
  return { info, at, image: toDataUrl(await contactSheet(file, info, at)) };
}

const fmtTimes = (at: number[]) => at.map((t) => t.toFixed(2)).join(", ");

/** The picture model for this call: what the route allows, with the agent's preference where there's a choice. */
function imageModel(engine: unknown, edit: boolean, media: MotionMedia): string | null {
  if (media.mode === "local") return edit ? media.edit : media.image;
  if (media.mode === "api") return edit ? (engine === "ideogram" ? media.editAlt : media.edit) : media.image;
  return null;
}

/** Runs the user's image or video model, the same engines the rest of Crackio uses. */
async function runEngine(
  kind: "image" | "video",
  { prompt, aspect, references, options, model }: { prompt: string; aspect: AspectId; references: string[]; options?: EngineJob["options"]; model?: string },
  env: ToolEnv,
) {
  if (!model) throw new ToolError(`There's no ${kind} model on this route.`);
  const def = await resolveModel(kind, model).catch((err: unknown) => {
    throw new ToolError(`${model} can't run right now: ${err instanceof Error ? err.message : String(err)}`);
  });
  const engine = def.via ? engineFor(def.via) : null;
  if (!engine) throw new ToolError(`${def.name} has no connection, so there's no ${kind} model to use. Tell the user to connect one in Connections.`);
  const { width, height } = sizeFor(aspect);
  const job: EngineJob = {
    kind,
    model: def.model,
    via: def.via ?? undefined,
    family: def.family,
    options,
    prompt,
    userPrompt: prompt,
    refine: false,
    aspect,
    width,
    height,
    count: 1,
    references: references.map((p, i) => ({ path: p, label: kind === "video" ? (i === 0 ? "the start frame" : "the end frame") : `reference ${i + 1}`, role: "subject" })),
    mode: kind,
  };
  const result = await engine.run(job, { signal: env.signal, progress: (v, stage) => env.detail(`${stage ?? "Working"} · ${Math.round(v * 100)}%`) });
  const out: EngineOutput | undefined = result.outputs[0];
  if (!out) throw new ToolError(`${def.name} returned nothing. Try a different prompt.`);
  return { out, modelName: def.name };
}

/* ---------------------------------------------------------------- tools */

/** Generating, rendering and scoring wait for a plan: a project's first frames are designed, not improvised. */
function needPlan(env: ToolEnv) {
  if (!env.turn.plan) throw new ToolError("Plan first: draw from ideas, then call plan with the concept, look, sound and shot list. Then make the assets.");
}

async function generateImage(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  needPlan(env);
  const prompt = str(a.prompt, "prompt");
  const aspect = aspectOf(a.aspect, env);
  const refs = await Promise.all((Array.isArray(a.references) ? a.references : []).slice(0, 5).map((n) => resolveFile(env.dir, n)));
  for (const r of refs) if (kindOf(r) !== "image") throw new ToolError(`${path.basename(r)} isn't an image.`);
  const model = imageModel(a.engine, refs.length > 0, env.media);
  if (!model) throw new ToolError("No image model is connected. Make this in code (render_html: shapes, type, canvas painting, three.js), or use the user's attachments.");
  const cap = env.media.limits.images;
  if (env.usage.images >= cap) throw new ToolError(`This turn has used its ${cap} images. Work with what you have, or make the rest in code.`);
  env.usage.images++;
  const billed = env.media.mode === "api";
  const options: EngineJob["options"] | undefined = billed && !model.includes("ideogram") ? { resolution: "2k" } : undefined;
  const { out, modelName } = await runEngine("image", { prompt, aspect, references: refs, model, options }, env);
  const name = await save(env, out.data, a.name, "image", extFor(out.mime));
  const file = path.join(env.dir, name);
  // The yellow wash is the first thing people read as "AI": measure it and take most of it out.
  let stats = await colorStats(file);
  let note = "";
  if (yellowCast(stats) && a.keep_color !== true) {
    const before = stats.castB;
    await fs.writeFile(file, await neutralize(file, stats));
    stats = await colorStats(file);
    note = ` A yellow cast was taken out (neutral b* ${before.toFixed(1)} → ${stats.castB.toFixed(1)}).`;
  }
  const f = await env.addFile(name, "image");
  return {
    ok: true,
    output: `Saved ${name} (${f.width}x${f.height}) with ${modelName}.${note} Color: ${describeColor(stats)}. It's attached: check realism (hands, faces, materials, light) and that it fits the plan's look.`,
    files: [name],
    images: [await preview(file)],
  };
}

async function generateVideo(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  needPlan(env);
  const prompt = str(a.prompt, "prompt");
  const start = a.start_image ? await resolveFile(env.dir, a.start_image) : null;
  const end = a.end_image ? await resolveFile(env.dir, a.end_image) : null;
  if (end && !start) throw new ToolError("end_image needs a start_image too.");
  for (const f of [start, end]) if (f && kindOf(f) !== "image") throw new ToolError(`${path.basename(f)} isn't an image.`);
  const duration = Math.round(Math.min(15, Math.max(1, num(a.duration, 6))));
  let aspect = aspectOf(a.aspect, env);
  if (start && typeof a.aspect !== "string") {
    const m = await sharp(start).metadata();
    aspect = nearestAspect(m.width, m.height);
  }
  const model = start ? env.media.video : env.media.videoFromText;
  if (!model) throw new ToolError("No video model is installed or connected. Animate stills yourself in render_html (2.5D depth moves, montage, Ken Burns with intent) instead.");
  const cap = env.media.limits.videos;
  if (env.usage.videos >= cap) throw new ToolError(`This turn has used its ${cap} clips. Work with what you have, or animate stills in render_html.`);
  env.usage.videos++;
  const billed = env.media.mode === "api";
  const { out, modelName } = await runEngine(
    "video",
    {
      prompt,
      aspect,
      references: [start, end].filter((f): f is string => Boolean(f)),
      model,
      options: billed
        ? { duration: Math.min(10, duration), cropFrames: Boolean(start && typeof a.aspect === "string") }
        : { duration, resolution: "1080p", sound: a.sound !== false, cropFrames: Boolean(start && typeof a.aspect === "string") },
    },
    env,
  );
  const name = await save(env, out.data, a.name, "clip", "mp4");
  const f = await env.addFile(name, "video");
  const sheet = await sheetOf(path.join(env.dir, name));
  const color = await videoColor(path.join(env.dir, name), f.duration ?? duration, 3).catch(() => []);
  return {
    ok: true,
    output: `Saved ${fileLine(f)}, made with ${modelName}. Color: ${summarizeVideoColor(color)}. Attached: frames at ${fmtTimes(sheet.at)} s. Check faces, hands, physics and drift; note which seconds are usable and trim the rest.`,
    files: [name],
    images: [sheet.image],
  };
}

async function renderHtml(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  needPlan(env);
  const html = str(a.html, "html");
  const duration = num(a.duration, 0);
  if (!(duration > 0)) throw new ToolError("duration (seconds) is required.");
  if (duration > LIMITS.renderSeconds) throw new ToolError(`Render at most ${LIMITS.renderSeconds} s at a time; split longer pieces and join them with ffmpeg.`);
  const width = even(Math.min(3840, num(a.width, env.canvas.width)));
  const height = even(Math.min(3840, num(a.height, env.canvas.height)));
  const fps = [24, 25, 30, 60].includes(num(a.fps, 30)) ? num(a.fps, 30) : 30;
  const transparent = a.transparent === true;
  const { data, errors } = await renderComposition({
    html,
    stage: { width, height, duration, fps },
    origin: env.origin,
    base: `${env.origin}${folderUrl(env.projectId)}`,
    transparent,
    signal: env.signal,
    onProgress: (done, total) => env.detail(`Frame ${done} of ${total}`),
  });
  const name = await save(env, data, a.name, "motion", transparent ? "webm" : "mp4");
  const composition: MotionComposition = { id: nanoid(10), html, aspect: `${width}x${height}`, width, height, duration, fps, base: folderUrl(env.projectId), file: name, createdAt: Date.now() };
  await env.addComposition(composition);
  const f = await env.addFile(name, "render", { compositionId: composition.id });
  const sheet = await sheetOf(path.join(env.dir, name));
  const warn = errors.length ? ` The page reported errors while rendering (check the frames, something may be missing): ${errors.join(" | ")}.` : "";
  return { ok: true, output: `Rendered ${fileLine(f)}${transparent ? ", with alpha" : ""}.${warn} Attached: frames at ${fmtTimes(sheet.at)} s.`, files: [name], images: [sheet.image] };
}

/** Capture devices and network sources stay off limits; everything else ffmpeg can do is fair game. */
const DEVICES = /^(dshow|gdigrab|vfwcap|avfoundation|x11grab|kmsgrab|fbdev|v4l2|video4linux2|alsa|pulse|openal|oss|jack|decklink|ddagrab)$/i;
const OUTSIDE = /(^|[=:'",;|(])(\/|\\\\|[A-Za-z]:[\\/])/;
const PARENT = /(^|[\\/=:'",;|])\.\.([\\/]|$)/;
const SYSTEM_FONTS = /[A-Za-z]\\?:[\\/]+Windows[\\/]+Fonts[\\/]/i;

function checkArgs(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) throw new ToolError("args must be a non-empty list of strings.");
  const args = raw.map((x) => String(x));
  if (/^ffmpeg(\.exe)?$/i.test(args[0])) args.shift();
  for (const a of args) {
    const shown = a.length > 80 ? `${a.slice(0, 80)}…` : a;
    if (a.includes("://")) throw new ToolError(`Network sources aren't allowed ("${shown}"). Use files in the project folder.`);
    if (DEVICES.test(a)) throw new ToolError(`Capture devices aren't allowed ("${a}").`);
    if ((OUTSIDE.test(a) && !SYSTEM_FONTS.test(a)) || PARENT.test(a)) throw new ToolError(`"${shown}" points outside the project folder. Use plain file names.`);
  }
  return args;
}

async function ffmpeg(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const args = checkArgs(a.args);
  const before = await snapshot(env.dir);
  const started = Date.now();
  const tick = setInterval(() => env.detail(`Running · ${Math.round((Date.now() - started) / 1000)} s`), 2000);
  let run;
  try {
    run = await runFfmpeg(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args], { cwd: env.dir, signal: env.signal, timeoutMs: 30 * 60_000 });
  } finally {
    clearInterval(tick);
  }
  if (env.signal.aborted) throw new EngineError("Cancelled.");
  const after = await snapshot(env.dir);
  const changed = [...after.keys()].filter((n) => before.get(n) !== after.get(n));
  const files: MotionFile[] = [];
  for (const name of changed.slice(0, 60)) files.push(await env.addFile(name, "ffmpeg"));
  const log = run.stderr.trim();
  if (run.code !== 0) {
    return { ok: false, output: `ffmpeg failed (exit ${run.code}).\n${log.slice(-2500) || "No error text."}${files.length ? `\nIt still wrote: ${files.map((f) => f.name).join(", ")}` : ""}`, files: files.map((f) => f.name) };
  }
  const lines = files.slice(0, 20).map(fileLine);
  const more = files.length > 20 ? `\n…and ${files.length - 20} more.` : "";
  const newest = [...files].reverse().find((f) => f.kind === "video");
  const sheet = newest ? await sheetOf(path.join(env.dir, newest.name)).catch(() => null) : null;
  return {
    ok: true,
    output: `${files.length ? `Wrote:\n${lines.join("\n")}${more}` : "Done, but no file in the folder changed."}${log ? `\nffmpeg said:\n${log.slice(-1200)}` : ""}${sheet ? `\nAttached: frames of ${newest!.name} at ${fmtTimes(sheet.at)} s.` : ""}`,
    files: files.map((f) => f.name),
    images: sheet ? [sheet.image] : undefined,
  };
}

/** Public pages only: nothing on this computer or the local network. */
function publicUrl(raw: unknown, verb = "captured"): URL {
  const url = (() => {
    try {
      return new URL(String(raw ?? ""));
    } catch {
      throw new ToolError("Give a full http(s) address.");
    }
  })();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError(`Only http(s) pages can be ${verb}.`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    !host.includes(".");
  if (local) throw new ToolError(`Only public web pages can be ${verb}, nothing on this computer or the local network.`);
  return url;
}

async function captureWeb(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const url = publicUrl(a.url);
  const width = Math.round(Math.min(2560, Math.max(320, num(a.width, 1440))));
  const height = Math.round(Math.min(2560, Math.max(320, num(a.height, 900))));
  const scroll = a.mode === "scroll";
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars", "--mute-audio"] }).catch(() => chromium.launch({ channel: "msedge", headless: true, args: ["--hide-scrollbars", "--mute-audio"] }));
  const stop = () => void browser.close().catch(() => {});
  env.signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    // Redirects and subresources get the same check as the page itself.
    await page.route("**/*", (route) => {
      try {
        publicUrl(route.request().url());
        return route.continue();
      } catch {
        return route.request().url().startsWith("data:") || route.request().url().startsWith("blob:") ? route.continue() : route.abort();
      }
    });
    env.detail(`Opening ${url.hostname}`);
    await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 45_000 }).catch(() => page.waitForLoadState("load"));
    await page.waitForTimeout(800);
    if (!scroll) {
      const shot = await page.screenshot({ type: "png", fullPage: a.full_page === true });
      const name = await save(env, shot, a.name, `${url.hostname}`, "png");
      const f = await env.addFile(name, "image");
      return { ok: true, output: `Saved ${name} (${f.width}x${f.height}) from ${url.toString()}.`, files: [name], images: [await preview(path.join(env.dir, name))] };
    }
    const seconds = Math.min(60, Math.max(2, num(a.seconds, 8)));
    const fps = 30;
    const total = Math.round(seconds * fps);
    const travel = Math.max(0, (await page.evaluate(() => document.documentElement.scrollHeight)) - height);
    const name = await uniqueName(env.dir, cleanName(typeof a.name === "string" && a.name.trim() ? a.name : `${url.hostname}-scroll`, "mp4"));
    const proc = spawn(
      // Ignored by the bundler, as in runFfmpeg: otherwise production builds trace the whole project.
      /*turbopackIgnore: true*/ ffmpegPath(),
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", name],
      { cwd: env.dir, windowsHide: true },
    );
    const done = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)));
    for (let i = 0; i < total; i++) {
      if (env.signal.aborted) throw new EngineError("Cancelled.");
      const t = i / (total - 1);
      // Ease in and out, with a short hold at both ends.
      const p = t < 0.08 ? 0 : t > 0.92 ? 1 : 0.5 - Math.cos(((t - 0.08) / 0.84) * Math.PI) / 2;
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(p * travel));
      await page.waitForTimeout(16);
      const frame = await page.screenshot({ type: "jpeg", quality: 90 });
      if (!proc.stdin.write(frame)) await new Promise((r) => proc.stdin.once("drain", r));
      if (i % 15 === 0) env.detail(`Frame ${i + 1} of ${total}`);
    }
    proc.stdin.end();
    if ((await done) !== 0) throw new ToolError("Couldn't encode the scroll recording.");
    const f = await env.addFile(name, "video");
    const sheet = await sheetOf(path.join(env.dir, name));
    return { ok: true, output: `Recorded ${fileLine(f)} scrolling ${url.toString()}. Attached: frames at ${fmtTimes(sheet.at)} s.`, files: [name], images: [sheet.image] };
  } finally {
    env.signal.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}

const HEIGHTS = [360, 480, 720, 1080, 1440, 2160];

/** A file name from a title: plain words, short enough to carry a part's times. */
const slug = (title: string) => cleanName(title.replace(/\./g, " ")).slice(0, 48).replace(/[-_]+$/, "") || "download";

function describeInfo(info: SourceInfo) {
  const facts = [
    `"${info.title}"${info.channel ? ` by ${info.channel}` : ""}`,
    info.duration ? `${span(info.duration)} long (${info.duration.toFixed(0)} s)` : "length unknown",
    info.uploaded ? `uploaded ${info.uploaded}` : "",
    info.views ? `${info.views.toLocaleString("en-US")} views` : "",
  ].filter(Boolean);
  const top = info.heights.at(-1);
  const sizes =
    info.duration && top
      ? `Whole: about ${size(estimateBytes(info, "video", 720, info.duration))} at 720p${top > 720 ? `, ${size(estimateBytes(info, "video", 1080, info.duration))} at 1080p` : ""}, ${size(estimateBytes(info, "audio", 0, info.duration))} for the sound only.`
      : "";
  const chapters = info.chapters.length ? `Chapters:\n${info.chapters.slice(0, 80).map((c) => `${c.start.toFixed(1)} (${clock(c.start)}) ${c.title}`).join("\n")}` : "No chapters.";
  const about = info.description?.trim() ? `Description: ${info.description.replace(/\s+/g, " ").trim().slice(0, 400)}` : "";
  return [`${facts.join(", ")}.`, top ? `Picture up to ${top}p. ${sizes}` : sizes, chapters, about].filter(Boolean).join("\n");
}

/** The link's transcript, saved in the folder once (NAME.transcript.json) and reused by later downloads of the same link. */
async function keepTranscript(info: SourceInfo, stem: string, env: ToolEnv): Promise<string> {
  const known = (await env.files()).find((f) => f.name.endsWith(".transcript.json") && f.origin?.url === info.url);
  if (known) return `Transcript: ${known.name} (read it with transcript).`;
  env.detail("Fetching the transcript");
  const { transcript: t, why } = await fetchTranscript(info, env.signal).catch((err: unknown) => {
    if (env.signal.aborted) throw err;
    return { transcript: null, why: err instanceof Error ? err.message : String(err) };
  });
  if (!t) return `No transcript: ${why}.`;
  const name = await uniqueName(env.dir, `${stem}.transcript.json`);
  await fs.writeFile(path.join(env.dir, name), JSON.stringify(t));
  await env.addFile(name, "download", { origin: { url: info.url, title: info.title } });
  const timed = t.words ? `${t.words.length.toLocaleString("en-US")} words, each timed` : `${t.lines.length.toLocaleString("en-US")} lines, timed by line`;
  return `Transcript: saved ${name} (${t.captions === "auto" ? "machine captions" : "the creator's captions"}, ${timed}). Read it with transcript: find words and phrases, or read a span of time.`;
}

async function download(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const get = a.get === "audio" || a.get === "info" || a.get === "search" ? a.get : "video";
  if (get === "search") {
    const query = str(a.query ?? a.url, "query");
    env.detail("Searching YouTube");
    const hits = await searchVideos(query, env.signal);
    return {
      ok: true,
      output: hits.length ? `YouTube, "${query}":\n${hits.map(foundLine).join("\n")}\nDownload one by its url (get "info" first when it's long).` : `Nothing came up for "${query}". Try other words.`,
    };
  }
  const url = publicUrl(a.url, "downloaded").toString();
  env.detail(`Reading ${new URL(url).hostname.replace(/^www\./, "")}`);
  const info = await readInfo(url, env.signal);
  if (info.playlist) {
    const list = info.playlist.entries.slice(0, 25);
    const more = info.playlist.entries.length - list.length;
    return { ok: true, output: `That's a playlist, "${info.playlist.title}", of ${info.playlist.entries.length} videos. Download them one at a time by url:\n${list.map(foundLine).join("\n")}${more > 0 ? `\n…and ${more} more.` : ""}` };
  }
  if (info.live) throw new ToolError("That stream is live (or hasn't started). It can be downloaded once it has ended.");
  const stem = slug(typeof a.name === "string" && a.name.trim() ? a.name.replace(/\.[a-z0-9]{2,4}$/i, "") : info.title);
  const transcriptNote = await keepTranscript(info, stem, env);
  if (get === "info") return { ok: true, output: `${describeInfo(info)}\n${transcriptNote}` };

  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  let section: { start: number; end: number } | undefined;
  if (given(a.start) || given(a.end)) {
    const start = Math.max(0, num(a.start, 0));
    const end = Math.min(num(a.end, info.duration ?? NaN), info.duration ?? Infinity);
    if (!Number.isFinite(end) || end <= start) throw new ToolError(`end must come after start, in seconds of the source${info.duration ? ` (it's ${info.duration.toFixed(1)} s long)` : ""}.`);
    section = { start, end };
  }
  const seconds = section ? section.end - section.start : (info.duration ?? 0);
  const most = get === "audio" ? 6 : 3;
  if (seconds > most * 3600) throw new ToolError(`That's ${span(seconds)} long. Download at most ${most} hours at a time: pick the parts you need with start and end.`);
  const height = HEIGHTS.includes(num(a.max_height, 720)) ? num(a.max_height, 720) : 720;
  await checkRoom(env.dir, estimateBytes(info, get, height, seconds || 600));
  const name = await fetchMedia({
    url: info.url,
    dir: env.dir,
    stem: section ? `${stem}-${stamp(section.start)}-${stamp(section.end)}` : stem,
    get,
    height,
    section,
    signal: env.signal,
    onProgress: env.detail,
  });
  const file = path.join(env.dir, name);
  await fs.chmod(file, 0o444).catch(() => {});
  const f = await env.addFile(name, "download", { origin: { url: info.url, title: info.title, ...section } });
  const clockNote = section ? "" : " It keeps the source's clock: transcript times are times in this file.";
  if (f.kind === "video") {
    const sheet = await sheetOf(file, 8);
    return { ok: true, output: `Saved ${fileLine(f)}.${clockNote} ${transcriptNote} Attached: frames at ${fmtTimes(sheet.at)} s.`, files: [name], images: [sheet.image] };
  }
  return { ok: true, output: `Saved ${fileLine(f)}.${clockNote} ${transcriptNote} Attached: its waveform, start to end.`, files: [name], images: [toDataUrl(await waveform(file))] };
}

async function transcript(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const t = await readTranscript(await resolveFile(env.dir, a.file));
  const find = (Array.isArray(a.find) ? a.find : typeof a.find === "string" ? [a.find] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  if (find.length) return { ok: true, output: findInTranscript(t, find) };
  const from = Math.max(0, num(a.from, 0));
  const to = Math.min(from + 900, Math.max(from + 1, num(a.to, from + 600)));
  return { ok: true, output: transcriptWindow(t, from, to) };
}

const TEXT_EXT = ["txt", "srt", "ass", "vtt", "svg", "json", "css", "html", "md", "csv", "lrc"];

async function writeFile(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const raw = str(a.name, "name");
  const ext = path.extname(raw).slice(1).toLowerCase();
  if (!TEXT_EXT.includes(ext)) throw new ToolError(`write_file makes text files (${TEXT_EXT.join(", ")}).`);
  const content = typeof a.content === "string" ? a.content : "";
  if (content.length > 300_000) throw new ToolError("That's more than 300 KB.");
  const name = cleanName(raw);
  const target = path.join(env.dir, name);
  const existing = (await env.files()).find((f) => f.name === name);
  if (existing?.source === "upload" || existing?.source === "download") throw new ToolError(`${name} is ${existing.source === "upload" ? "the user's file" : "a download"} and stays as it is. Pick another name.`);
  await fs.writeFile(target, content, "utf8");
  await env.addFile(name, "write");
  return { ok: true, output: `Wrote ${name} (${content.length} characters).`, files: [name] };
}

async function look(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const file = await resolveFile(env.dir, a.file);
  const name = path.basename(file);
  const info = await probe(file);
  const meta = fileLine({ name, kind: info.kind, width: info.width, height: info.height, duration: info.duration, fps: info.fps, audio: info.audio, bytes: info.bytes, source: "write" }).replace(/, made by write$/, "");
  if (info.kind === "image") return { ok: true, output: `${meta}. Color: ${describeColor(await colorStats(file))}. Attached.`, images: [await preview(file, 1280)] };
  if (info.kind === "video") {
    const times = Array.isArray(a.times) ? a.times.map((t) => num(t, 0)).slice(0, 16) : undefined;
    const sheet = await sheetOf(file, 8, times);
    const [color, sound] = await Promise.all([videoColor(file, info.duration ?? 1, 4).catch(() => []), info.audio ? loudness(file, env.signal).catch(() => null) : Promise.resolve(null)]);
    return {
      ok: true,
      output: `${meta}. Color: ${summarizeVideoColor(color)}. Sound: ${sound ? describeLoudness(sound) : "no audio track"}. Attached: frames at ${fmtTimes(sheet.at)} s, left to right, top to bottom.`,
      images: [sheet.image],
    };
  }
  if (info.kind === "audio") {
    const sound = await loudness(file, env.signal).catch(() => null);
    return { ok: true, output: `${meta}. Loudness: ${sound ? describeLoudness(sound) : "unknown"}. Attached: its waveform, start to end.`, images: [toDataUrl(await waveform(file))] };
  }
  if (info.kind === "text") {
    const text = await fs.readFile(file, "utf8");
    return { ok: true, output: `${meta}:\n${text.slice(0, 8000)}${text.length > 8000 ? "\n…(truncated)" : ""}` };
  }
  return { ok: true, output: `${meta}. There's nothing to show for this kind of file.` };
}

async function listFiles(_: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const files = await env.files();
  return { ok: true, output: files.length ? files.map(fileLine).join("\n") : "The project folder is empty." };
}

async function finish(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const file = await resolveFile(env.dir, a.file);
  const kind = kindOf(file);
  if (kind !== "video" && kind !== "image") throw new ToolError("Deliver a video or an image.");
  const name = path.basename(file);
  // A video goes out only after a second opinion (or once the review rounds are spent).
  if (kind === "video" && !env.turn.reviewed.has(name) && env.turn.reviews < LIMITS.reviews) throw new ToolError(`Run review on ${name} first, then finish.`);
  const message = typeof a.message === "string" ? a.message.trim().slice(0, 1200) : "";
  return { ok: true, output: "Delivered.", finish: { file: name, message } };
}

/* ---------------------------------------------------------------- the craft tools */

async function ideas(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const about = str(a.about, "about");
  const asked = Array.isArray(a.kinds) ? a.kinds.filter((k): k is IdeaKind => (IDEA_KINDS as string[]).includes(String(k))) : [];
  const kinds: IdeaKind[] = asked.length ? asked : ["format", "hook", "structure", "look", "sound", "transition"];
  const count = Math.round(Math.min(30, Math.max(4, num(a.count, 14))));
  env.turn.draws++;
  const avoid = env.recent.flatMap((r) => r.moves ?? []);
  const hand = drawIdeas({ about, kinds, count, seed: `${env.projectId}:${env.turn.draws}:${about}`, avoid });
  const recent = describeRecent(env.recent);
  return {
    ok: true,
    output: `A hand of ${hand.length} from the playbook (draw again for more):\n${hand.map(formatIdea).join("\n")}${recent ? `\n\nRecent projects used (make this one different unless the brief asks for the same):\n${recent}` : ""}`,
  };
}

function shotOf(raw: unknown): PlanShot | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || typeof s.what !== "string") return null;
  const text = typeof s.text === "string" && s.text.trim() ? s.text.trim() : undefined;
  const pick = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).trim() : undefined);
  return { seconds: num(s.seconds, 0), what: s.what.trim(), camera: pick("camera"), source: pick("source"), transition: pick("transition"), text };
}

async function plan(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const text = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
  const shots = (Array.isArray(a.shots) ? a.shots : []).map(shotOf).filter((s): s is PlanShot => Boolean(s));
  if (!shots.length) throw new ToolError("A plan needs a shot list (seconds and what happens in each shot).");
  const p: MotionPlan = {
    concept: str(a.concept, "concept"),
    format: text("format"),
    audience: text("audience"),
    seconds: num(a.seconds, shots.reduce((s, x) => s + x.seconds, 0)),
    look: str(a.look, "look"),
    palette: text("palette"),
    type: text("type"),
    music: text("music"),
    sfx: text("sfx"),
    captions: a.captions === true,
    shots,
    moves: Array.isArray(a.moves) ? a.moves.map(String).slice(0, 8) : [],
    at: Date.now(),
  };
  const notes = lintPlan(p, env.recent);
  env.turn.plan = p;
  await env.savePlan(p);
  return {
    ok: true,
    output: notes.length
      ? `Plan saved. A senior's notes on it:\n${notes.map((n) => `- ${n}`).join("\n")}\nIf any of these apply, call plan again with the fix; otherwise go ahead and make it.`
      : "Plan saved. No notes: go ahead and make it.",
    summary: `${p.shots.length} shots, ${Math.round(p.seconds)} s. ${p.concept}`.slice(0, 220),
  };
}

async function renderAudio(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const code = str(a.code, "code");
  const duration = num(a.duration, 0);
  if (!(duration > 0)) throw new ToolError("duration (seconds) is required.");
  if (duration > LIMITS.soundSeconds) throw new ToolError(`Render at most ${LIMITS.soundSeconds} s of sound at a time.`);
  env.detail("Rendering the sound");
  const { data, peak, rms } = await renderSound({ code, duration, signal: env.signal });
  const name = await save(env, data, a.name, "sound", "wav");
  const f = await env.addFile(name, "sound");
  const level = 20 * Math.log10(Math.max(1e-6, rms / Math.max(1e-6, peak)));
  return {
    ok: true,
    output: `Rendered ${fileLine(f)} (crest ${(-level).toFixed(1)} dB${-level < 6 ? ": very compressed, little dynamics" : -level > 22 ? ": very sparse or quiet" : ""}). Attached: its waveform, start to end; check that hits land where the picture needs them.`,
    files: [name],
    images: [toDataUrl(await waveform(path.join(env.dir, name)))],
  };
}

async function imageMap(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const file = await resolveFile(env.dir, a.image);
  if (kindOf(file) !== "image") throw new ToolError(`${path.basename(file)} isn't an image.`);
  const meta = await sharp(file).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const subject = a.map === "subject";
  env.detail(subject ? "Finding the subject" : "Estimating depth");
  let raw: Buffer;
  let w: number;
  let h: number;
  if (subject) {
    const m = await subjectMask(file);
    raw = Buffer.from(m.data, "base64");
    w = m.width;
    h = m.height;
    if (!raw.some((v) => v > 0)) throw new ToolError("No clear subject stands out in this image.");
  } else {
    const d = await estimateDepth(file);
    const u16 = Buffer.from(d.data, "base64");
    raw = Buffer.alloc(d.width * d.height);
    for (let i = 0; i < raw.length; i++) raw[i] = u16.readUInt16LE(i * 2) >> 8;
    w = d.width;
    h = d.height;
  }
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 1 } }).resize(width, height, { kernel: "lanczos3" }).blur(subject ? 0.6 : 1.2).png().toBuffer();
  const base = path.basename(file, path.extname(file));
  const name = await save(env, png, a.name, `${base}-${subject ? "subject" : "depth"}`, "png");
  await env.addFile(name, "depth");
  return {
    ok: true,
    output: `Saved ${name} (${width}x${height}), ${subject ? "white = subject" : "white = near, black = far"}. Load it beside the image in render_html (as a texture or a CSS mask).`,
    files: [name],
    images: [await preview(path.join(env.dir, name), 640)],
  };
}

async function review(a: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const file = await resolveFile(env.dir, a.file);
  if (kindOf(file) !== "video") throw new ToolError("Review a video.");
  if (env.turn.reviews >= LIMITS.reviews) throw new ToolError(`The ${LIMITS.reviews} review rounds are used up. Make the last fixes you're sure about and finish.`);
  env.turn.reviews++;
  env.detail("Watching the cut");
  const sounds = (await env.files()).filter((f) => f.kind === "audio" || f.source === "sound").map((f) => `${f.name} (${f.source})`);
  const { review: r, raw, measured } = await critique({ model: env.model, file, brief: env.brief, plan: env.turn.plan, sounds, signal: env.signal });
  env.turn.reviewed.add(path.basename(file));
  if (!r) return { ok: true, output: `The reviewer answered without a verdict:\n${raw.slice(0, 1500)}\n\nMeasurements:\n${measured.join("\n")}` };
  const high = r.fixes.filter((x) => x.severity === "high").length;
  return {
    ok: true,
    output: `${formatReview(r, env.turn.reviews, LIMITS.reviews)}\n\nMeasurements:\n${measured.join("\n")}`,
    summary: `${r.overall}/10 · ${r.verdict === "ship" ? "ready to ship" : `${r.fixes.length} fix${r.fixes.length === 1 ? "" : "es"}${high ? `, ${high} important` : ""}`}${r.fixes[0] ? `: ${r.fixes[0].problem}` : ""}`.slice(0, 220),
  };
}

const HANDLERS: Record<string, (a: Record<string, unknown>, env: ToolEnv) => Promise<ToolOutcome>> = {
  ideas,
  plan,
  generate_image: generateImage,
  generate_video: generateVideo,
  render_html: renderHtml,
  ffmpeg,
  capture_web: captureWeb,
  download,
  transcript,
  render_audio: renderAudio,
  image_map: imageMap,
  write_file: writeFile,
  look,
  list_files: listFiles,
  review,
  finish,
};

/** Runs one tool call. Mistakes come back as text the model can fix; only cancelling throws. */
export async function runTool(call: ToolCall, env: ToolEnv): Promise<ToolOutcome> {
  if (call.invalid) return { ok: false, output: "Error: those arguments weren't valid JSON. Send the call again." };
  const handler = HANDLERS[call.name];
  if (!handler) return { ok: false, output: `Error: there's no tool called "${call.name}".` };
  try {
    return await handler(call.args, env);
  } catch (err) {
    if (env.signal.aborted) throw err;
    if (err instanceof EngineError) return { ok: false, output: `Error: ${err.message}${err.hint ? ` (${err.hint})` : ""}` };
    return { ok: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
