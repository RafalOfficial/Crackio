import "server-only";
import sharp from "sharp";
import { lfm3LoraOf, lfm3Text, localText, routerText } from "./comfy-text";
import { listModels } from "@/lib/models/resolve";
import { AUTO_PREFERENCE, ENHANCER_TEXT, INTERNAL_TEXT, modelById, type ModelAvailability } from "@/lib/models/catalog";
import { getSettings } from "@/lib/server/settings";
import { toDataUrl } from "./util";
import type { EngineReference } from "./types";
import { outside } from "@/lib/server/recipes";
import { freeOnlyNow } from "@/lib/server/job-scope";

/**
 * Crackio's "understand me" step: turn someone's own words (any language, any vocabulary)
 * into a precise English prompt, without inventing things they didn't ask for. Where Crackio's prompt enhancer is
 * installed (Settings → Tools → Add-ons; engines/enhance) it writes them, unless that's turned off in Settings → Preferences; otherwise the
 * prompt writer picked in Settings → Models does (Auto: a hosted model on your Comfy key, else an open model on your
 * own ComfyUI's biggest GPU), with the instructions below.
 */
export const REFINE_INSTRUCTIONS = `You write prompts for an image model. Rewrite the person's request below as one precise English image prompt.
Rules:
- Keep every concrete detail they gave (subjects, colors, clothing, places, actions, camera hints). Translate faithfully if it isn't in English.
- Do not add new subjects, objects, brands or text they didn't ask for.
- Where they imply it, make explicit: subject and action, setting, shot size and camera angle, lens feel, lighting and time of day, mood, style.
- Natural prose, 2 to 5 sentences, front-load the subject. No lists, no quotation marks, no preamble.
- If reference images are listed, refer to them as "the person in image 1", "the product in image 2", and so on, and describe what matters about them only when the request depends on it.
Output only the prompt.`;

const VIDEO_INSTRUCTIONS = `You write prompts for a video model. Rewrite the person's request below as one precise English prompt for a short clip.
Rules:
- Keep every concrete detail they gave. Translate faithfully if it isn't in English. Add nothing they didn't imply.
- Say what moves and how: the subject's action, the camera move (push in, pull out, orbit, pan, tilt, crane, handheld, static), the pace, and how the shot ends.
- If a start image is given, describe motion that starts from it; don't re-describe the whole picture.
- One to three sentences of natural prose. No lists, no quotation marks, no preamble.
Output only the prompt.`;

type RefineInput = {
  text: string;
  references?: (Partial<EngineReference> & { label?: string; role?: string })[];
  aspect?: string;
  signal?: AbortSignal;
  kind?: "image" | "video";
  /** A different job than writing a prompt (see askText). */
  instructions?: string;
  /** Reasoning effort for this call; the Settings value otherwise. */
  effort?: "low" | "medium" | "high" | "xhigh";
  /** Text models to try first, in this order (then your pick in Settings, then Auto's order). */
  prefer?: string[];
  /** Long edge the pictures are sent at: 512 is enough to know what's in them; finding exact spots needs more. */
  imageEdge?: number;
  /** How closely vision models look at the pictures. */
  detail?: "low" | "high" | "auto";
  /** Give up after this long (two minutes by default). */
  timeoutMs?: number;
  /** LFM3 only: JSON keys it answers true or false, and where to report how likely "true" was at each (a judge's yes and
   * how sure it is). Other models answer without. */
  odds?: { keys: string[]; got: (odds: Record<string, number>) => void };
  /** LFM3 only: the answer so far, as it's written (Retouch draws each thing as soon as it's complete). */
  onText?: (soFar: string) => void;
  /** An open model on your own GPUs is asked on this machine first (a training run's own, which is known to be on). */
  machine?: string;
  /** Told the name of the model that answered ("Gemini 3.5 Flash"), for a caller that keeps who wrote something. */
  answeredBy?: (name: string) => void;
  /** Filled with each model that didn't answer and why ("Gemini 3.5 Flash: out of credits"), for a caller that must say so. */
  failed?: string[];
};

/**
 * Until when hosted models are left alone: a Comfy workspace that says it's out of credits says so to every model on
 * it, and a set of thirty captions asked four hosted models each, all four refused, before any local model got a turn.
 */
const credits = globalThis as unknown as { __crackioNoComfyCreditsUntil?: number };
const outOfCredits = () => (credits.__crackioNoComfyCreditsUntil ?? 0) > Date.now();
function noted(input: RefineInput, m: { name: string; family: string }, err: unknown) {
  const why = err instanceof Error ? err.message : String(err);
  if (m.family === "comfy-text" && /out of credits|insufficient credit/i.test(why)) credits.__crackioNoComfyCreditsUntil = Date.now() + 5 * 60_000;
  input.failed?.push(`${m.name}: ${why.split(/[ \t\r\n]+/).join(" ").slice(0, 160)}`);
}

function userMessage({ text, references = [], aspect }: RefineInput) {
  const refs = references.map((r, i) => `Image ${i + 1}: ${r.label ?? r.role ?? "reference"}`).join("\n");
  return [refs ? `Reference images:\n${refs}` : "", aspect ? `Aspect ratio: ${aspect}` : "", `Request: ${text}`].filter(Boolean).join("\n\n");
}

async function run(m: ModelAvailability, input: RefineInput): Promise<string> {
  const system = input.instructions ?? (input.kind === "video" ? VIDEO_INSTRUCTIONS : REFINE_INSTRUCTIONS);
  // Careful thinking can take a while; past two minutes, the original words go through instead. An open model on your own
  // GPU waits for the render it's in line behind (it goes to the front, but a running job isn't stopped): a minute was
  // too short beside a 2-minute place build or a video (Director v2 on a rented A40: "Qwen on your GPU failed:
  // Cancelled"), so it gets six.
  const limit = m.family === "comfy-local-text" ? Math.max(input.timeoutMs ?? 120_000, 360_000) : (input.timeoutMs ?? 120_000);
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(limit)]);
  const edge = input.imageEdge ?? 512;
  switch (m.family) {
    case "comfy-text": {
      const files = (input.references ?? []).filter((r): r is EngineReference => Boolean(r.path)).slice(0, m.maxRefs);
      const images = await Promise.all(files.map((r) => toDataUrl(r, edge)));
      return routerText({ model: m.model, system, prompt: userMessage(input), images, what: m.name, signal });
    }
    case "comfy-local-text": {
      // A model that sees gets them all: LFM3-VL each at its own size, Qwen as one labelled contact sheet (comfy-text).
      const files = (input.references ?? []).filter((r): r is EngineReference => Boolean(r.path)).slice(0, 6);
      const images = await Promise.all(files.map(async (r) => Buffer.from((await toDataUrl(r, edge)).split(",")[1] ?? "", "base64")));
      // The enhancer reads its own instructions, and the pictures as words (engines/enhance).
      if (m.id === ENHANCER_TEXT) {
        const { enhance } = await import("./enhance");
        return enhance({ text: input.text, references: input.references, kind: input.kind, signal });
      }
      if (m.model.startsWith("lfm3")) {
        // JPEG for the trip: a swap's PNG takes are about 1 MB each, three or four a check, often over a long link to a
        // rented GPU.
        const jpegs = await Promise.all(images.map((b) => sharp(b).jpeg({ quality: 90 }).toBuffer()));
        return lfm3Text({ system, prompt: userMessage(input), images: jpegs, lora: lfm3LoraOf(m.model), odds: input.odds, onText: input.onText, signal });
      }
      return localText({ system, prompt: userMessage(input), images, signal, machine: input.machine });
    }
    default:
      throw new Error(`no text route for ${m.family}`);
  }
}

/**
 * The model list takes 2-10 s (every machine and model is asked), and a swap checks a take every 10-30 s, Retouch on
 * every picture: the last list answers at once, however old, while a fresh one is fetched behind it past 15 s (each
 * model still finds its own machine when it runs, and one that fails hands on to the next). Only the server's very
 * first question waits for one, and the server fetches it when it starts (warmTextModels). On globalThis: the
 * server's start-up and its requests load this module apart.
 */
const lists = ((globalThis as unknown as { __crackioTextModels?: { known: { at: number; models: ModelAvailability[] } | null; fetching: Promise<ModelAvailability[]> | null } }).__crackioTextModels ??= { known: null, fetching: null });
function recentModels(): Promise<ModelAvailability[]> {
  const age = lists.known ? Date.now() - lists.known.at : Infinity;
  if (age > 15_000 && !lists.fetching) {
    const fetching = listModels()
      .then((models) => (lists.known = { at: Date.now(), models }).models)
      .finally(() => (lists.fetching = null));
    fetching.catch(() => {}); // a refresh in the background fails quietly; the next question fetches again
    lists.fetching = fetching;
  }
  return lists.known ? Promise.resolve(lists.known.models) : lists.fetching!;
}

/**
 * A new look at which text models can answer, waited for. For work that mustn't be told "none" by an old list: a
 * training run's captions start right after its machine came up or its model's files arrived, and the list every other
 * question is answered from can be from before that (seen after a restart: a reader that was on went unasked for a
 * minute and a half).
 */
export async function freshTextModels(): Promise<void> {
  const fetching = listModels().then((models) => (lists.known = { at: Date.now(), models }).models);
  await fetching.catch(() => null);
}

/** The model list and the machines with Crackio's LFM3 fine-tunes, fetched when the server starts (instrumentation). */
export async function warmTextModels() {
  const { lfm3Machine } = await import("./comfy-text");
  await Promise.all([recentModels(), lfm3Machine("none"), lfm3Machine("judge"), lfm3Machine("retouch"), lfm3Machine("enhance")].map((p) => p.catch(() => null)));
}

/**
 * The first usable answer from the text models you can reach: your pick in Settings, then Auto's order. A prompt shorter
 * than `shortest` is no prompt; a question's answer can be one word (a "Yes" thrown away had every model asked in turn:
 * 106 s of a place's build).
 */
async function firstAnswer(input: RefineInput, shortest = 13): Promise<{ text: string; by: string } | null> {
  // Crackio's own LFM3 models need only their machine, not the whole model list (2-15 s when it's fetched from cold):
  // asked first by name (Retouch's eyes, the swap judge), one answers before the list is looked at.
  const own = modelById(input.prefer?.[0]);
  const seen = new Set<string>();
  if (own?.family === "comfy-local-text" && own.model.startsWith("lfm3")) {
    const { lfm3LoraOf, lfm3Machine } = await import("./comfy-text");
    if (await lfm3Machine(lfm3LoraOf(own.model)).catch(() => null)) {
      seen.add(own.id);
      try {
        const out = (await run({ ...own, available: true, via: "comfy-local" }, input)).replace(/^["“]|["”]$/g, "").trim();
        if (out.length >= shortest) return { text: out, by: own.name };
      } catch (err) {
        if (input.signal?.aborted) return null;
        noted(input, own, err);
        console.warn(`[text] ${own.name} failed, trying the next model: ${(err as Error).message}`);
      }
    }
  }
  // Work for an agent the user keeps to free paths: no model that costs Comfy credits answers (server/job-scope).
  const free = freeOnlyNow();
  const models = (await recentModels()).filter((m) => m.kind === "text" && m.available && !(free && m.family === "comfy-text"));
  const saved = (await getSettings()).models?.text;
  const order = [...(input.prefer ?? []), saved, ...AUTO_PREFERENCE.text, ...models.filter((m) => !INTERNAL_TEXT.has(m.id)).map((m) => m.id)];
  for (const id of order) {
    const m = models.find((x) => x.id === id);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.family === "comfy-text" && outOfCredits()) {
      if (!input.failed?.some((f) => f.startsWith("Comfy's hosted models"))) input.failed?.push("Comfy's hosted models: your Comfy workspace is out of credits");
      continue;
    }
    try {
      const out = (await run(m, input)).replace(/^["“]|["”]$/g, "").trim();
      if (out.length >= shortest) return { text: out, by: m.name };
      input.failed?.push(`${m.name}: it answered nothing`);
    } catch (err) {
      if (input.signal?.aborted) break;
      noted(input, m, err);
      console.warn(`[text] ${m.name} failed, trying the next model: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Whether Crackio's prompt enhancer writes prompts now: it's on a machine that answers, and not turned off in Preferences. */
export async function enhancerReady(): Promise<boolean> {
  if (((await getSettings()).promptEnhancer ?? "auto") === "off") return false;
  const { lfm3Machine } = await import("./comfy-text");
  return Boolean(await lfm3Machine("enhance").catch(() => null));
}

/** Returns the refined prompt, or the original text if no prompt writer is reachable. */
export async function refinePrompt(input: RefineInput): Promise<{ prompt: string; by: string | null }> {
  if (!input.text.trim()) return { prompt: input.text, by: null };
  // Inside a Library job it's listed in the take's recipe as a step outside ComfyUI (server/recipes).
  return outside(
    "Your words written out as a full prompt",
    undefined,
    async () => {
      // Writing a prompt (not another job's instructions): Crackio's enhancer first, where it's installed and not turned off.
      const own = !input.instructions && ((await getSettings()).promptEnhancer ?? "auto") !== "off";
      const answer = await firstAnswer(own ? { ...input, prefer: [ENHANCER_TEXT, ...(input.prefer ?? [])] } : input);
      return answer ? { prompt: answer.text, by: answer.by } : { prompt: input.text, by: null };
    },
    (r, step) => void (step.detail = r.by ?? "no text model answered, so your words went as typed"),
  );
}

/** A short answer to `instructions` about `text` (and any reference images), or null with no text model. */
export async function askText(input: RefineInput & { instructions: string }): Promise<string | null> {
  let by: string | null = null;
  return outside(
    "A text model checked or described something",
    undefined,
    async () => {
      const answer = await firstAnswer({ effort: "low", ...input }, 1);
      by = answer?.by ?? null;
      if (answer) input.answeredBy?.(answer.by);
      return answer?.text ?? null;
    },
    (_, step) => void (step.detail = `${by ?? "no text model"}: ${input.instructions.replace(/\s+/g, " ").slice(0, 120)}…`),
  );
}
