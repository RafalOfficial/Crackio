import type { ProviderId } from "@/lib/providers/types";
import type { Caps } from "@/lib/models/caps";

/**
 * Every model Crackio can drive, grouped by what it makes. The `id` is what's stored in
 * settings and generations: "<engine>:<model>", e.g. "comfy:bfl/flux-3-image" (Comfy Router, on your Comfy key) or
 * "local:flux3-klein" (an open model on your own ComfyUI).
 */
export type ModelKind = "image" | "video" | "upscale" | "reframe" | "text";
export const MODEL_KINDS: ModelKind[] = ["image", "video", "upscale", "reframe", "text"];

export type ModelDef = {
  id: string;
  kind: ModelKind;
  /** Connections that can run it, in order of preference. */
  providers: ProviderId[];
  /** The id the engine sends to the provider. */
  model: string;
  name: string;
  vendor: string;
  /** How many reference images it accepts (0 = text only). */
  maxRefs: number;
  speed: "fast" | "medium" | "slow";
  /** One plain sentence: what it's best at. */
  bestFor: string;
  /** Request shape the engine uses for this model. */
  family: string;
  /** False while Crackio can list the model but not run it yet. */
  runnable: boolean;
};

const comfy = (m: Omit<ModelDef, "providers" | "id"> & { id?: string }): ModelDef => ({
  ...m,
  id: m.id ?? `comfy:${m.model}`,
  providers: ["comfy-cloud"],
});

/** Open models on your own ComfyUI (a GPU box, or this computer), run from workflows in engines/comfy-local-recipes. */
const local = (m: Omit<ModelDef, "providers" | "id" | "family" | "runnable">): ModelDef => ({
  ...m,
  id: `local:${m.model}`,
  providers: ["comfy-local"],
  family: "comfy-local",
  runnable: true,
});

/** The character swap that runs on your own ComfyUI (Templates). */
export const LOCAL_SWAP_ID = "local:scail-2";
/** The swap that also takes pets, cars and objects: the first frame redrawn, LTX-2.5 + Ripple carries it through the clip. */
export const LOCAL_RIPPLE_ID = "local:ltx-2.5-ripple";
/** Every swap on your own ComfyUI; Templates picks the first one that runs here. */
export const LOCAL_SWAP_IDS = [LOCAL_RIPPLE_ID, LOCAL_SWAP_ID];

export const MODELS: ModelDef[] = [
  // ---- Images ------------------------------------------------------------
  comfy({ kind: "image", model: "bfl/flux-3-image", name: "FLUX 3", vendor: "Black Forest Labs", maxRefs: 10, speed: "medium", family: "flux3", runnable: true, bestFor: "Following a layout: it reads Director's subject boxes and up to 10 references." }),
  comfy({ kind: "image", model: "openai/gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", vendor: "OpenAI", maxRefs: 16, speed: "slow", family: "openai", runnable: true, bestFor: "The most precise edits, faces and text." }),
  comfy({ kind: "image", model: "openai/gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", vendor: "OpenAI", maxRefs: 16, speed: "medium", family: "openai", runnable: true, bestFor: "High quality at everyday speed." }),
  comfy({ kind: "image", model: "vertexai/gemini-nano-banana-2.1", name: "Nano Banana 2.1", vendor: "Google", maxRefs: 14, speed: "fast", family: "gemini", runnable: true, bestFor: "Fast edits that keep identity across many references." }),
  comfy({ kind: "image", model: "byteplus/seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", vendor: "ByteDance", maxRefs: 10, speed: "medium", family: "seedream", runnable: true, bestFor: "Rich, cinematic images up to 4K." }),
  comfy({ kind: "image", model: "qwen/qwen-image-3.0", name: "Qwen-Image 3.0", vendor: "Alibaba", maxRefs: 3, speed: "medium", family: "qwen", runnable: true, bestFor: "Clean compositions and legible text." }),
  comfy({ kind: "image", model: "qwen/qwen-image-3.0-pro", name: "Qwen-Image 3.0 Pro", vendor: "Alibaba", maxRefs: 3, speed: "medium", family: "qwen", runnable: true, bestFor: "Qwen's top tier: richer detail and better edits than 3.0." }),
  comfy({ kind: "image", model: "krea/krea-3", name: "Krea 3", vendor: "Krea", maxRefs: 8, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Photoreal, art-directed looks and strong edits from up to 8 pictures." }),
  comfy({ kind: "image", model: "ideogram/ideogram-4-5", name: "Ideogram 4.5", vendor: "Ideogram", maxRefs: 4, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Posters, logos and long text set cleanly in the picture." }),
  comfy({ kind: "image", model: "xai/grok-imagine-image-2.0", name: "Grok Imagine 2.0 (Router)", vendor: "xAI", maxRefs: 0, speed: "fast", family: "grok-router", runnable: true, bestFor: "Fast text-to-image through your Comfy key." }),
  // Open weights on your own ComfyUI (the Local page installs them).
  local({ kind: "image", model: "flux3-klein", name: "FLUX 3 Klein (your GPU)", vendor: "Black Forest Labs", maxRefs: 10, speed: "fast", bestFor: "FLUX 3 on your own card: sharp pictures and edits from up to 10 references." }),
  local({ kind: "image", model: "z-image-turbo", name: "Z-Image Turbo (your GPU)", vendor: "Tongyi-MAI", maxRefs: 0, speed: "fast", bestFor: "Photoreal pictures from words, free on your own GPU." }),
  local({ kind: "image", model: "qwen-director", name: "Qwen Director (your GPU)", vendor: "Alibaba Qwen + Alibaba PAI", maxRefs: 4, speed: "medium", bestFor: "The Director’s shots that keep your cast’s faces and clothes from their pictures (a depth ControlNet)." }),
  local({ kind: "image", model: "z-image-director", name: "Z-Image Director (your GPU)", vendor: "Tongyi-MAI + Alibaba PAI", maxRefs: 0, speed: "fast", bestFor: "The Director’s shots: your set drawn as a real, cinematic film still (a depth ControlNet)." }),
  local({ kind: "image", model: "flux2-klein-4b", name: "FLUX.2 klein 4B (your GPU)", vendor: "Black Forest Labs", maxRefs: 4, speed: "fast", bestFor: "Pictures and edits from up to 4 references, free on your own GPU; the lightest good one for small cards." }),

  // ---- Upscale -------------------------------------------------------------
  comfy({ kind: "upscale", model: "fal/crystal-upscaler", name: "Crystal Upscaler", vendor: "fal", maxRefs: 1, speed: "fast", family: "crystal", runnable: true, bestFor: "Faithful 2–4× upscales with an optional creativity dial." }),
  comfy({ kind: "upscale", model: "freepik/ai-image-upscaler-precision-v2", name: "Precision Upscaler V2", vendor: "Freepik", maxRefs: 1, speed: "medium", family: "freepik-precision", runnable: true, bestFor: "Photos: restores fine texture, skin and fabric." }),
  comfy({ kind: "upscale", model: "wavespeed/seedvr2", name: "SeedVR2", vendor: "ByteDance", maxRefs: 1, speed: "medium", family: "wavespeed-upscale", runnable: true, bestFor: "Straight to 2K, 4K or 8K." }),
  comfy({ kind: "upscale", model: "bria/image-edit-increase-resolution", name: "Bria Increase Resolution", vendor: "Bria", maxRefs: 1, speed: "fast", family: "bria-upscale", runnable: true, bestFor: "Commercially safe 2× and 4× upscales." }),
  // Pictures, best first for AI renders (Crackio's test: 1K renders halved and brought back, against the originals).
  local({ kind: "upscale", model: "nomos2-hq", name: "Nomos2 HQ (your GPU)", vendor: "Phips", maxRefs: 1, speed: "fast", bestFor: "Best for AI renders: by far the closest to the original in Crackio's test, crisp edges and text, nothing invented." }),
  local({ kind: "upscale", model: "seedvr2-7b", name: "SeedVR2 7B (your GPU)", vendor: "ByteDance", maxRefs: 1, speed: "medium", bestFor: "Restores soft, old or compressed photos with real-looking detail (it adds texture to clean ones). About 11 GB of GPU memory." }),
  local({ kind: "upscale", model: "nomos-webphoto", name: "Nomos WebPhoto (your GPU)", vendor: "Phips", maxRefs: 1, speed: "fast", bestFor: "Real photos: cleans JPEG and web compression while it sharpens." }),
  local({ kind: "upscale", model: "realesrgan-x4", name: "Real-ESRGAN (your GPU)", vendor: "Xintao Wang", maxRefs: 1, speed: "fast", bestFor: "Fastest, on any machine: sharpens what's there and adds no new detail." }),
  local({ kind: "upscale", model: "seedvr2-3b", name: "SeedVR2 3B (your GPU)", vendor: "ByteDance", maxRefs: 1, speed: "fast", bestFor: "SeedVR2 for 12–16 GB cards (from 9 GB); less faithful than 7B." }),
  local({ kind: "upscale", model: "flashvsr-plus", name: "FlashVSR+ (your GPU)", vendor: "OpenImagingLab", maxRefs: 0, speed: "fast", bestFor: "Clips only: a one-step video upscaler built for 4×, about twice as fast as SeedVR2 7B." }),

  // ---- Reframe (change the aspect ratio by extending the picture) -----------
  comfy({ kind: "reframe", model: "bria/image-edit-expand", name: "Bria Expand", vendor: "Bria", maxRefs: 1, speed: "fast", family: "bria-expand", runnable: true, bestFor: "Extends the scene to a new aspect ratio." }),

  // ---- Video ------------------------------------------------------------------
  // Driven from each model's Router schema (see providers/comfy-models and engines/comfy-families).
  comfy({ kind: "video", model: "minimax/minimax-h3", name: "MiniMax H3", vendor: "MiniMax", maxRefs: 2, speed: "slow", family: "comfy-custom", runnable: true, bestFor: "Expressive motion with native audio; start and end frames." }),
  comfy({ kind: "video", model: "fal/h3-max", name: "MiniMax H3 Max", vendor: "MiniMax", maxRefs: 0, speed: "slow", family: "comfy-custom", runnable: true, bestFor: "H3 at 1080p: long, detailed clips with sound, from words." }),
  comfy({ kind: "video", model: "fal/flux-3-max", name: "FLUX 3 Max", vendor: "Black Forest Labs", maxRefs: 0, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Cinematic clips with sound up to 20 s at 1080p; it thinks the prompt through first." }),
  comfy({ kind: "video", model: "ltx/ltx-2-5-pro", name: "LTX 2.5 Pro", vendor: "Lightricks", maxRefs: 0, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Fast, sharp text-to-video up to 1080p." }),
  comfy({ kind: "video", model: "kling/kling-v3", name: "Kling 3", vendor: "Kling", maxRefs: 0, speed: "slow", family: "comfy-custom", runnable: true, bestFor: "Precise camera moves (orbit, push, crane), from words." }),
  comfy({ kind: "video", model: "kling/kling-v3-omni", name: "Kling 3 Omni", vendor: "Kling", maxRefs: 2, speed: "slow", family: "comfy-custom", runnable: true, bestFor: "Kling from a start and end frame, or editing a clip." }),
  comfy({ kind: "video", model: "veo/veo-3.1-generate-001", name: "Veo 3.1", vendor: "Google", maxRefs: 2, speed: "slow", family: "comfy-custom", runnable: true, bestFor: "Cinematic clips with sound, from words or frames (4, 6 or 8 s)." }),
  comfy({ kind: "video", model: "byteplus/dreamina-seedance-2-5-260628", name: "Seedance 2.5", vendor: "ByteDance", maxRefs: 2, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Long, coherent shots up to 30 s, from words or frames." }),
  comfy({ kind: "video", model: "wan/wan3.0-video", name: "Wan 3.0", vendor: "Alibaba", maxRefs: 2, speed: "medium", family: "comfy-custom", runnable: true, bestFor: "Up to 30 s with sound, at a low price." }),
  comfy({ kind: "video", model: "xai/grok-imagine-video-1.5", name: "Grok Imagine Video 1.5 (Router)", vendor: "xAI", maxRefs: 1, speed: "fast", family: "comfy-custom", runnable: true, bestFor: "Grok video through your Comfy key." }),
  // Open weights on your own ComfyUI. (MiniMax H3's licence excludes the EU, UK, US and Korea, so it stays on Router.)
  local({ kind: "video", model: "ltx-2.5", name: "LTX-2.5 (your GPU)", vendor: "Lightricks", maxRefs: 1, speed: "fast", bestFor: "Sharp clips with sound from words or a start frame, up to 1080p." }),
  local({ kind: "video", model: "scail-2", name: "SCAIL-2 Swap (your GPU)", vendor: "Zhipu AI", maxRefs: 1, speed: "slow", bestFor: "Puts your character into a clip: its background, camera, light and motion stay." }),
  local({ kind: "video", model: "ltx-2.5-ripple", name: "LTX-2.5 Ripple Swap (your GPU)", vendor: "Lightricks", maxRefs: 3, speed: "medium", bestFor: "Swaps a person, pet, car or object in a clip: the first frame redrawn with your Cast, carried through every frame." }),
  local({ kind: "video", model: "wan2.2-5b", name: "Wan 2.2 5B (your GPU)", vendor: "Alibaba", maxRefs: 1, speed: "medium", bestFor: "The small open Wan: 720p clips from words or a start frame on an 8–12 GB card." }),

  // ---- Text: the prompt writer behind Refine, and the checks and notes the tools ask for ----
  // Through ComfyUI: hosted models on your Comfy key (Comfy Router's chat endpoint, paid in Comfy credits), and an open
  // model on your own ComfyUI (core Generate Text), free.
  { id: "comfy:google/gemini-3.5-flash", kind: "text", providers: ["comfy-cloud"], model: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", vendor: "Google", maxRefs: 4, speed: "fast", family: "comfy-text", runnable: true, bestFor: "Fast, sharp-eyed prompt writing on your Comfy key; reads pictures well." },
  { id: "comfy:anthropic/claude-sonnet-5", kind: "text", providers: ["comfy-cloud"], model: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", vendor: "Anthropic", maxRefs: 4, speed: "medium", family: "comfy-text", runnable: true, bestFor: "The steadiest hand for Motion's code and long plans, on your Comfy key." },
  { id: "comfy:anthropic/claude-opus-5", kind: "text", providers: ["comfy-cloud"], model: "anthropic/claude-opus-5", name: "Claude Opus 5", vendor: "Anthropic", maxRefs: 4, speed: "slow", family: "comfy-text", runnable: true, bestFor: "The most capable writer and coder on Comfy; slower and pricier." },
  { id: "comfy:deepseek/deepseek-v4-pro", kind: "text", providers: ["comfy-cloud"], model: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", vendor: "DeepSeek", maxRefs: 0, speed: "medium", family: "comfy-text", runnable: true, bestFor: "An open model on your Comfy key, at a fraction of the price; words only." },
  { id: "local:text", kind: "text", providers: ["comfy-local"], model: "text", name: "Qwen on your GPU", vendor: "Alibaba", maxRefs: 1, speed: "fast", family: "comfy-local-text", runnable: true, bestFor: "Free: an open model on your own ComfyUI writes the prompts and answers the checks." },
];

export const modelById = (id: string | undefined | null) => (id ? MODELS.find((m) => m.id === id) : undefined);

export const KIND_LABEL: Record<ModelKind, string> = {
  image: "Images",
  video: "Video",
  upscale: "Upscale",
  reframe: "Reframe",
  text: "Prompt writer",
};

/** Auto picks the first model of a kind whose engine is connected. */
export const AUTO_PREFERENCE: Record<ModelKind, string[]> = {
  // Open models on your own GPU first (free), then Comfy Router on your Comfy key.
  image: ["local:flux3-klein", "local:z-image-turbo", "local:flux2-klein-4b", "comfy:bfl/flux-3-image", "comfy:vertexai/gemini-nano-banana-2.1"],
  upscale: ["local:nomos2-hq", "local:realesrgan-x4", "comfy:freepik/ai-image-upscaler-precision-v2", "comfy:wavespeed/seedvr2"],
  reframe: ["comfy:bria/image-edit-expand"],
  video: ["local:ltx-2.5", "local:wan2.2-5b", "comfy:byteplus/dreamina-seedance-2-5-260628", "comfy:minimax/minimax-h3"],
  // A hosted model on your Comfy key (it sees pictures), else the open one on your own ComfyUI's biggest GPU.
  text: ["comfy:google/gemini-3.5-flash", "local:text"],
};

export type ModelAvailability = ModelDef & {
  /** Connected and runnable right now. */
  available: boolean;
  /** Which connection will run it. */
  via: ProviderId | null;
  /** Why it can't run, in plain words. */
  reason?: string;
  /** What it accepts (lengths, resolutions, shapes, frames), when Crackio knows. */
  caps?: Caps | null;
  /** Local models: seconds per picture, 5 s clip or 1 MP picture upscaled 2× (`localJob`) on the fastest machine that has it, measured there or estimated. */
  localTime?: { seconds: number; measured: boolean; gpu: string };
};
