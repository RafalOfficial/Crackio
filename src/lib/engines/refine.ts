import "server-only";
import { localText, routerText } from "./comfy-text";
import { listModels } from "@/lib/models/resolve";
import { AUTO_PREFERENCE, type ModelAvailability } from "@/lib/models/catalog";
import { getSettings } from "@/lib/server/settings";
import { toDataUrl } from "./util";
import type { EngineReference } from "./types";
import { outside } from "@/lib/server/recipes";

/**
 * Crackio's "understand me" step: turn someone's own words (any language, any vocabulary)
 * into a precise English prompt, without inventing things they didn't ask for. It runs on the
 * prompt writer picked in Settings → Models (Auto: a hosted model on your Comfy key, else an open model on your own
 * ComfyUI's biggest GPU).
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
};

function userMessage({ text, references = [], aspect }: RefineInput) {
  const refs = references.map((r, i) => `Image ${i + 1}: ${r.label ?? r.role ?? "reference"}`).join("\n");
  return [refs ? `Reference images:\n${refs}` : "", aspect ? `Aspect ratio: ${aspect}` : "", `Request: ${text}`].filter(Boolean).join("\n\n");
}

async function run(m: ModelAvailability, input: RefineInput): Promise<string> {
  const system = input.instructions ?? (input.kind === "video" ? VIDEO_INSTRUCTIONS : REFINE_INSTRUCTIONS);
  // Careful thinking can take a while; past two minutes, the original words go through instead.
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(input.timeoutMs ?? 120_000)]);
  const edge = input.imageEdge ?? 512;
  switch (m.family) {
    case "comfy-text": {
      const files = (input.references ?? []).filter((r): r is EngineReference => Boolean(r.path)).slice(0, m.maxRefs);
      const images = await Promise.all(files.map((r) => toDataUrl(r, edge)));
      return routerText({ model: m.model, system, prompt: userMessage(input), images, what: m.name, signal });
    }
    case "comfy-local-text": {
      // A model that sees gets them all, as one labelled contact sheet when there are several (comfy-text).
      const files = (input.references ?? []).filter((r): r is EngineReference => Boolean(r.path)).slice(0, 6);
      const images = await Promise.all(files.map(async (r) => Buffer.from((await toDataUrl(r, edge)).split(",")[1] ?? "", "base64")));
      return localText({ system, prompt: userMessage(input), images, signal });
    }
    default:
      throw new Error(`no text route for ${m.family}`);
  }
}

/**
 * The first usable answer from the text models you can reach: your pick in Settings, then Auto's order. A prompt shorter
 * than `shortest` is no prompt; a question's answer can be one word (a "Yes" thrown away had every model asked in turn:
 * 106 s of a place's build).
 */
async function firstAnswer(input: RefineInput, shortest = 13): Promise<{ text: string; by: string } | null> {
  const models = (await listModels()).filter((m) => m.kind === "text" && m.available);
  const saved = (await getSettings()).models?.text;
  const order = [...(input.prefer ?? []), saved, ...AUTO_PREFERENCE.text, ...models.map((m) => m.id)];
  const seen = new Set<string>();
  for (const id of order) {
    const m = models.find((x) => x.id === id);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      const out = (await run(m, input)).replace(/^["“]|["”]$/g, "").trim();
      if (out.length >= shortest) return { text: out, by: m.name };
    } catch (err) {
      if (input.signal?.aborted) break;
      console.warn(`[text] ${m.name} failed, trying the next model: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Returns the refined prompt, or the original text if no prompt writer is reachable. */
export async function refinePrompt(input: RefineInput): Promise<{ prompt: string; by: string | null }> {
  if (!input.text.trim()) return { prompt: input.text, by: null };
  // Inside a Library job it's listed in the take's recipe as a step outside ComfyUI (server/recipes).
  return outside(
    "Your words written out as a full prompt",
    undefined,
    async () => {
      const answer = await firstAnswer(input);
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
      return answer?.text ?? null;
    },
    (_, step) => void (step.detail = `${by ?? "no text model"}: ${input.instructions.replace(/\s+/g, " ").slice(0, 120)}…`),
  );
}
