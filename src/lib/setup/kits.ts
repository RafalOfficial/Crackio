import { TOOLS, type ToolSlug } from "@/lib/tools";
import { DIRECTOR_MODELS, SHOT_MODELS } from "@/components/director/models";
import { CAST_PREFER } from "@/lib/cast/types";
import type { Kit, KitId, Requirement } from "./types";

/**
 * What each tool needs to run on one machine, best choice first. Client-safe: Settings, the setup pills and the model
 * pickers all read these, and the server judges them on each machine (server/setup/status).
 *
 * Model lists come from the tools' own lists where those are plain modules (Director, Cast); the others follow the tool's
 * order as written in it (Angles' PREFER, Motion's LOCAL_*, use-model-choice's FIRST). Keep them in step when a tool's
 * own order changes.
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

const COMFY = "on your Comfy key";

type KitBody = Pick<Kit, "needs"> & Partial<Pick<Kit, "cloud">>;

const BODIES: Record<KitId, KitBody> = {
  image: {
    needs: [{ id: "image.model", label: "A picture model", need: { kind: "model", anyOf: PICTURES, task: "image" }, instead: `FLUX 3 or Nano Banana ${COMFY}` }],
    cloud: "FLUX 3 and Nano Banana",
  },
  video: {
    needs: [{ id: "video.model", label: "A clip model", need: { kind: "model", anyOf: CLIPS, task: "video" }, instead: `Seedance 2.5 or MiniMax H3 ${COMFY}` }],
    cloud: "Seedance 2.5 and MiniMax H3",
  },
  director: {
    needs: [
      { id: "director.shot", label: "A shot model", need: { kind: "model", anyOf: [...SHOT_MODELS] } },
      { id: "director.place", label: "A place model", need: { kind: "model", anyOf: [...DIRECTOR_MODELS] } },
      { id: "director.eyes", label: "Depth and cut-outs", need: { kind: "host-vision", models: ["depth", "cutout"] } },
    ],
  },
  angles: {
    needs: [
      // AnglesTool PREFER, its open models.
      { id: "angles.model", label: "An angles model", need: { kind: "model", anyOf: ["local:qwen-angles", "local:flux3-klein", "local:flux2-klein-4b"] }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` },
      { id: "angles.eyes", label: "3D from a picture", need: { kind: "host-vision", models: ["geometry", "cutout"] } },
    ],
    cloud: "GPT Image 2.5 and Nano Banana",
  },
  relight: {
    needs: [{ id: "relight.model", label: "A picture editor", need: { kind: "model", anyOf: EDITORS, task: "edit" }, instead: `any picture editor ${COMFY}` }],
    cloud: "Nano Banana and GPT Image",
  },
  cast: {
    needs: [{ id: "cast.model", label: "A model that draws from photos", need: { kind: "model", anyOf: local(CAST_PREFER), task: "edit" }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` }],
    cloud: "GPT Image 2.5 and Nano Banana",
  },
  retouch: {
    needs: [
      { id: "retouch.model", label: "A picture editor", need: { kind: "model", anyOf: EDITORS, task: "edit" }, instead: `any picture editor ${COMFY}` },
      { id: "retouch.eyes", label: "Crackio's eyes", need: { kind: "lfm3-lora", lora: "retouch" }, optional: true, instead: `Gemini 3.5 Flash ${COMFY}` },
    ],
    cloud: "Nano Banana and GPT Image",
  },
  product: {
    needs: [
      { id: "product.model", label: "A picture model", need: { kind: "model", anyOf: ["local:flux3-klein", "local:flux2-klein-4b"], task: "edit" }, instead: `GPT Image 2.5 or Nano Banana ${COMFY}` },
      { id: "product.film", label: "A clip model, for product films", need: { kind: "model", anyOf: CLIPS, task: "video" }, optional: true, instead: `MiniMax H3 or Seedance ${COMFY}` },
    ],
    cloud: "GPT Image 2.5, Nano Banana and Seedance",
  },
  motion: {
    needs: [
      // The agent thinks with a hosted model: local text models are too small to run it (motion/brain).
      { id: "motion.brain", label: "The agent's brain", need: { kind: "key", key: "comfy" } },
      { id: "motion.pictures", label: "A picture model", need: { kind: "model", anyOf: ["local:flux3-klein", "local:z-image-turbo", "local:flux2-klein-4b"], task: "image" }, optional: true, instead: `FLUX 3 ${COMFY}` },
      { id: "motion.clips", label: "A clip model", need: { kind: "model", anyOf: CLIPS, task: "video" }, optional: true, instead: `MiniMax H3 ${COMFY}` },
    ],
  },
  recast: {
    needs: [
      { id: "swap.pack", label: "Character Swap", need: { kind: "model", anyOf: ["local:ltx-2.5-ripple"], task: "swap" } },
      { id: "swap.judge", label: "Crackio's judge", need: { kind: "lfm3-lora", lora: "judge" }, optional: true, instead: `Gemini 3.5 Flash ${COMFY}` },
    ],
  },
  upscale: {
    needs: [
      { id: "upscale.pictures", label: "A picture upscaler", need: { kind: "model", anyOf: UPSCALERS, task: "upscale" }, instead: `Freepik or SeedVR2 ${COMFY}` },
      { id: "upscale.clips", label: "A clip upscaler", need: { kind: "model", anyOf: CLIP_UPSCALERS, task: "upscale" }, optional: true },
    ],
    cloud: "Freepik and SeedVR2",
  },
  storyboard: {
    needs: [
      { id: "storyboard.shot", label: "A shot model", need: { kind: "model", anyOf: [...SHOT_MODELS] } },
      { id: "storyboard.place", label: "A place model", need: { kind: "model", anyOf: [...DIRECTOR_MODELS] } },
      { id: "storyboard.eyes", label: "Depth and cut-outs", need: { kind: "host-vision", models: ["depth", "cutout"] } },
      { id: "storyboard.clips", label: "A clip model, for Make a clip", need: { kind: "model", anyOf: CLIPS, task: "video" }, optional: true, instead: `Seedance or MiniMax H3 ${COMFY}` },
    ],
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
