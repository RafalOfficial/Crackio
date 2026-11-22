import { TOOLS, type ToolSlug } from "@/lib/tools";
import { DIRECTOR_MODELS, REDRAW_MODELS, SHOT_MODELS } from "@/components/director/models";
import { CAST_PREFER } from "@/lib/cast/types";
import { LOCAL_RIPPLE_ID, LOCAL_SWAP_ID } from "@/lib/models/catalog";
import type { LocalModel } from "@/lib/local/types";
import type { Kit, KitId, Need, Requirement } from "./types";

/**
 * What each tool needs to run on one machine, best choice first. Client-safe: Settings, the setup pills and the model
 * pickers all read these, and the server judges them on each machine (server/setup/status).
 *
 * Model lists come from the tools' own lists where those are plain modules (Director, Cast); the others follow the tool's
 * order as written in it (Angles' PREFER, Motion's LOCAL_*, use-model-choice's FIRST). Keep them in step when a tool's
 * own order changes.
 *
 * A tool whose picker takes any open model for its job (the Image and Video pages, Relight, Retouch, Cast, Product,
 * Angles, Upscale) has an `open` part: the models named here are Crackio's picks, in order, and every other model in
 * the catalog that does the job follows them (`modelsFor`), so Settings sets up whatever the model library's Get models
 * installs. A tool that runs only the models it names (the Director's shots and places, Motion, the swaps) keeps a
 * closed list: another model set up for it would never be used.
 */

const local = (ids: readonly string[]) => ids.filter((id) => id.startsWith("local:"));

/** Open picture models, best first (use-model-choice FIRST.image). */
const PICTURES = ["local:flux3-klein", "local:z-image-turbo", "local:flux2-klein-4b", "local:tpl:qwen-image-2.1"];
/** Open models that change a picture you give them. */
const EDITORS = ["local:flux3-klein", "local:flux2-klein-4b", "local:tpl:qwen-image-2.1"];
/** Open clip models, best first (FIRST.video). */
const CLIPS = ["local:ltx-2.5", "local:wan2.2-5b"];
/** Picture upscalers, best first (AUTO_PREFERENCE.upscale), then the heavier ones. */
const UPSCALERS = ["local:nomos2-hq", "local:realesrgan-x4", "local:nomos-webphoto", "local:seedvr2-3b", "local:seedvr2-7b"];
/** Clip upscalers. */
const CLIP_UPSCALERS = ["local:seedvr2-7b", "local:seedvr2-3b", "local:flashvsr-plus"];

/**
 * Open models that are one tool's own though the catalog doesn't tie them to it (`LocalModel.tool`): the Director's
 * redraw models are a picture model with its depth ControlNet, set up under the Director, not as a page's picture model.
 */
const ONE_TOOLS = new Set<string>(REDRAW_MODELS);

type ModelNeed = Extract<Need, { kind: "model" }>;

/** A model that starts from a picture you give it: hand-tuned clip models all do; a template one when a template of its does. */
const takesPicture = (m: LocalModel) => m.variants.some((v) => !v.templates || Boolean(v.templates.i2v || v.templates.flf2v));

/**
 * Every catalog model a tool's model part can use, in Crackio's order: the ones it names first, and for an `open` part
 * every other open model that does its job (as the model library's Get models lists them: by task, a model made for one
 * tool only in that tool), best first.
 */
export function modelsFor(need: ModelNeed, catalog: readonly LocalModel[]): LocalModel[] {
  const by = new Map<string, LocalModel>();
  for (const m of catalog) if (m.crackio) by.set(m.crackio, m);
  const named = [...need.anyOf, ...(need.also ?? [])].map((id) => by.get(id)).filter((m): m is LocalModel => Boolean(m));
  const task = need.task;
  if (!need.open || !task) return named;
  const taken = new Set(named);
  const rest = catalog
    .filter((m) => m.crackio && !taken.has(m) && !m.tool && !ONE_TOOLS.has(m.crackio) && m.tasks.includes(task) && (!need.unit || m.unit === need.unit) && (need.from !== "image" || takesPicture(m)))
    .sort((a, b) => b.quality - a.quality);
  return [...named, ...rest];
}

/** The tools (kit ids) whose model parts can use a catalog model. */
export function kitsUsing(model: LocalModel, catalog: readonly LocalModel[]): KitId[] {
  return KITS.filter((k) => k.needs.some((r) => r.need.kind === "model" && modelsFor(r.need, catalog).some((m) => m.id === model.id))).map((k) => k.id);
}

const COMFY = "on your Comfy key";
/**
 * Crackio's prompt enhancer (engines/enhance): LFM3-VL 2B with its fine-tune writes your words out as a full prompt on
 * the machine itself. An add-on of the Image and Video pages; without it the prompt writer under Models does.
 */
const ENHANCER = { label: "Crackio's prompt enhancer", need: { kind: "lfm3-lora", lora: "enhance" }, optional: true, instead: `Gemini 3.5 Flash ${COMFY}` } satisfies Omit<Requirement, "id">;
/** What the Director shoots and makes places with on a Comfy key (components/director/models CLOUD_MODELS). */
const DIRECTOR_CLOUD = `Nano Banana or FLUX 3 ${COMFY}`;

/**
 * The Director's shots from a moved Camera the challenge winner's way (MoGe-3, Panorama Studio, Qwen-Image 2.1 +
 * AnyAngle: local/catalog `director-world`), with the stage's 3D set measured as they shoot it. Got wherever it runs;
 * elsewhere a moved Camera's shot edits the stage's own view (a step down).
 */
const WORLD_3D = { label: "Shots from a moved camera", need: { kind: "model", anyOf: ["local:director-world"] }, whereItRuns: true } satisfies Omit<Requirement, "id">;
/**
 * The Director's video mode: a dropped video filmed again from a new Camera path (local/catalog `director-video`: LTX-2.5
 * with Layout to Render, MoGe-3, the node; its first frame comes from the 3D World above). Got wherever it runs.
 */
const VIDEO_RESHOOT = { label: "Videos filmed from a new camera", need: { kind: "model", anyOf: ["local:director-video"] }, whereItRuns: true } satisfies Omit<Requirement, "id">;

type KitBody = Pick<Kit, "needs"> & Partial<Pick<Kit, "cloud">>;

const BODIES: Record<KitId, KitBody> = {
  image: {
    needs: [
      { id: "image.model", label: "A picture model", need: { kind: "model", anyOf: PICTURES, task: "image", open: true }, instead: `FLUX 3 or Nano Banana ${COMFY}` },
      { id: "image.enhance", ...ENHANCER },
    ],
    cloud: "FLUX 3 and Nano Banana",
  },
  video: {
    needs: [
      { id: "video.model", label: "A clip model", need: { kind: "model", anyOf: CLIPS, task: "video", open: true }, instead: `Seedance 2.5 or MiniMax H3 ${COMFY}` },
      { id: "video.enhance", ...ENHANCER },
    ],
    cloud: "Seedance 2.5 and MiniMax H3",
  },
  director: {
    needs: [
      { id: "director.shot", label: "A shot model", need: { kind: "model", anyOf: [...SHOT_MODELS] }, instead: DIRECTOR_CLOUD },
      { id: "director.place", label: "A place model", need: { kind: "model", anyOf: [...DIRECTOR_MODELS] }, instead: DIRECTOR_CLOUD },
      { id: "director.eyes", label: "Depth and cut-outs", need: { kind: "host-vision", models: ["depth", "cutout"] } },
      { id: "director.world", ...WORLD_3D },
      { id: "director.video", ...VIDEO_RESHOOT },
    ],
    cloud: "Nano Banana, FLUX 3 and GPT Image 2.5",
  },
  angles: {
    needs: [
      // AnglesTool PREFER, its open models; any other picture editor re-shoots from its words.
      { id: "angles.model", label: "An angles model", need: { kind: "model", anyOf: ["local:qwen-angles", "local:flux3-klein", "local:flux2-klein-4b"], task: "edit", open: true }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` },
      { id: "angles.eyes", label: "3D from a picture", need: { kind: "host-vision", models: ["geometry", "cutout"] } },
    ],
    cloud: "GPT Image 2.5 and Nano Banana",
  },
  relight: {
    needs: [{ id: "relight.model", label: "A picture editor", need: { kind: "model", anyOf: EDITORS, task: "edit", open: true }, instead: `any picture editor ${COMFY}` }],
    cloud: "Nano Banana and GPT Image",
  },
  cast: {
    needs: [{ id: "cast.model", label: "A model that draws from photos", need: { kind: "model", anyOf: local(CAST_PREFER), task: "edit", open: true }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` }],
    cloud: "GPT Image 2.5 and Nano Banana",
  },
  retouch: {
    needs: [
      { id: "retouch.model", label: "A picture editor", need: { kind: "model", anyOf: EDITORS, task: "edit", open: true }, instead: `any picture editor ${COMFY}` },
      { id: "retouch.eyes", label: "Crackio's eyes", need: { kind: "lfm3-lora", lora: "retouch" }, optional: true, instead: `Gemini 3.5 Flash ${COMFY}` },
    ],
    cloud: "Nano Banana and GPT Image",
  },
  product: {
    needs: [
      { id: "product.model", label: "A picture model", need: { kind: "model", anyOf: ["local:flux3-klein", "local:flux2-klein-4b"], task: "edit", open: true }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` },
      { id: "product.film", label: "A clip model, for product films", need: { kind: "model", anyOf: CLIPS, task: "video", open: true, from: "image" }, optional: true, instead: `MiniMax H3 or Seedance ${COMFY}` },
    ],
    cloud: "GPT Image 2.5, Nano Banana and Seedance",
  },
  motion: {
    needs: [
      // Motion makes its pictures and clips with these alone (motion/media LOCAL_*): closed lists.
      // The agent thinks with a hosted model: local text models are too small to run it (motion/brain).
      { id: "motion.brain", label: "The agent's brain", need: { kind: "key", key: "comfy" } },
      { id: "motion.pictures", label: "A picture model", need: { kind: "model", anyOf: ["local:flux3-klein", "local:z-image-turbo", "local:flux2-klein-4b"], task: "image" }, optional: true, instead: `FLUX 3 ${COMFY}` },
      { id: "motion.clips", label: "A clip model", need: { kind: "model", anyOf: CLIPS, task: "video" }, optional: true, instead: `MiniMax H3 ${COMFY}` },
    ],
    // All it must have is the Comfy key (its brain); pictures and clips have hosted stand-ins. With every machine off the
    // page still said "Motion isn't ready on your machines yet · Fix in Settings" over a Motion that worked.
    cloud: "Gemini 3.5 Flash, FLUX 3 and MiniMax H3",
  },
  recast: {
    needs: [
      // Templates' own swaps (models/catalog LOCAL_SWAP_IDS): LTX-2.5 Ripple is Crackio's, SCAIL-2 the other choice.
      { id: "swap.pack", label: "Character Swap", need: { kind: "model", anyOf: [LOCAL_RIPPLE_ID], also: [LOCAL_SWAP_ID], task: "swap" } },
      { id: "swap.judge", label: "Crackio's judge", need: { kind: "lfm3-lora", lora: "judge" }, optional: true, instead: `Gemini 3.5 Flash ${COMFY}` },
    ],
  },
  upscale: {
    needs: [
      { id: "upscale.pictures", label: "A picture upscaler", need: { kind: "model", anyOf: UPSCALERS, task: "upscale", open: true, unit: "image" }, instead: `Freepik or SeedVR2 ${COMFY}` },
      { id: "upscale.clips", label: "A clip upscaler", need: { kind: "model", anyOf: CLIP_UPSCALERS, task: "upscale" }, optional: true },
    ],
    cloud: "Freepik and SeedVR2",
  },
  storyboard: {
    needs: [
      { id: "storyboard.shot", label: "A shot model", need: { kind: "model", anyOf: [...SHOT_MODELS] }, instead: DIRECTOR_CLOUD },
      { id: "storyboard.place", label: "A place model", need: { kind: "model", anyOf: [...DIRECTOR_MODELS] }, instead: DIRECTOR_CLOUD },
      { id: "storyboard.eyes", label: "Depth and cut-outs", need: { kind: "host-vision", models: ["depth", "cutout"] } },
      { id: "storyboard.world", ...WORLD_3D },
      { id: "storyboard.video", ...VIDEO_RESHOOT },
      { id: "storyboard.clips", label: "A clip model, for Make a clip", need: { kind: "model", anyOf: CLIPS, task: "video", open: true }, optional: true, instead: `Seedance or MiniMax H3 ${COMFY}` },
    ],
    cloud: "Nano Banana, FLUX 3 and GPT Image 2.5",
  },
  voice: {
    needs: [
      { id: "voice.voice", label: "A voice model", need: { kind: "voice" } },
      { id: "voice.talk", label: "Talk: LFM3-VL 2B", need: { kind: "lfm3" }, optional: true },
      { id: "voice.chat", label: "Talk's chat voice", need: { kind: "lfm3-lora", lora: "chat" }, optional: true },
    ],
  },
  lipsync: {
    needs: [
      { id: "lipsync.engine", label: "LatentSync", need: { kind: "lipsync" } },
      { id: "lipsync.voice", label: "A voice that clones", need: { kind: "voice", clone: true } },
      // Best quality (32 GB cards): HuMo 17B redraws LatentSync's mouths with the person's own teeth and lips.
      { id: "lipsync.best", label: "Best quality: HuMo 17B", need: { kind: "model", anyOf: ["local:humo-lipsync"], task: "video" }, optional: true },
    ],
  },
};

const PAGES: Record<"image" | "video", Omit<Kit, "id" | "needs" | "cloud">> = {
  image: { name: "Image", summary: "Pictures from words and references.", hue: "", glyph: "/icons/image.png", href: "/create", media: "/assets/hero/hero-lighthouse.webp" },
  video: { name: "Video", summary: "Clips from words or a still.", hue: "", glyph: "/icons/video.png", href: "/video", media: "/assets/feature-video.webp" },
};

/** Every kit, in the sidebar's order: the Image and Video pages, then the tools. */
export const KITS: Kit[] = [
  ...(["image", "video"] as const).map((id) => ({ id, ...PAGES[id], ...BODIES[id] })),
  ...TOOLS.map((t) => ({ id: t.slug, name: t.name, summary: t.summary, hue: t.hue, glyph: t.glyph, href: t.href, media: t.media, ...BODIES[t.slug] })),
];

export const KIT_IDS = KITS.map((k) => k.id);

export const kitById = (id: string) => KITS.find((k) => k.id === id);

export const isKitId = (id: string): id is KitId => KITS.some((k) => k.id === id);

/** The requirements a set-up installs by default: the required ones (optional ones have their own "Add"). */
export const requiredNeeds = (kit: Kit): Requirement[] => kit.needs.filter((r) => !r.optional);

export type { KitId, ToolSlug };
