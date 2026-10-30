import { aspectChoice, type AspectChoice, type Caps } from "@/lib/models/caps";
import type { ModelDef } from "@/lib/models/catalog";
import { DEFAULT_RESOLUTION, IMAGE_RESOLUTIONS, tuningFor, type Tuning } from "@/lib/local/resolution";

/**
 * What Crackio's built-in models accept, in the same terms the schema reader gives Comfy Router
 * models, so every model's controls are built the same way.
 */

const shapes = (ids: string[]) => ids.map(aspectChoice).filter((c): c is AspectChoice => c !== null);

const none = {
  negative: null,
  refs: null,
  end: null,
  video: null,
  duration: null,
  resolution: null,
  quality: null,
  aspect: null,
  size: null,
  audio: null,
  count: null,
  scale: null,
  seed: null,
  fixed: {},
  missing: [],
} satisfies Partial<Caps>;

/**
 * Open models on your own ComfyUI (comfy-local). LTX-2.5: 24 fps, 1–20 s, from words or a start
 * frame, with sound; ~0.9 MP at 720p (1280×704 at 16:9), ~2 MP at 1080p. SCAIL-2 (Templates' swap):
 * a clip and one photo of who goes in; 896×512 at 16:9 by default, ~0.9 MP at 704p.
 */
const LTX_VIDEO: Caps = {
  ...none,
  output: "video",
  prompt: { field: "prompt", required: true },
  image: { field: "first_frame", required: false, array: false, min: 0, max: 1 },
  duration: { field: "duration", mode: "range", min: 1, max: 20, integer: true, encode: "number", auto: false, default: 5 },
  // 1440p is the same two passes, the first at 1280×736 (141 s for 5 s on an RTX 5090, against 83 s at 1080p).
  resolution: { field: "resolution", choices: ["540p", "720p", "1080p", "1440p"].map((v) => ({ value: v, label: v })), default: "720p" },
  aspect: { field: "aspect", choices: shapes(["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"]), default: "16:9" },
  audio: { field: "sound", default: true },
  // The distilled model's two passes are fixed noise lists (8 and 3 steps), at guidance 1.
  tuning: tuningFor(8, 1, true),
};

const SCAIL_SWAP: Caps = {
  ...none,
  output: "video",
  prompt: { field: "prompt", required: false },
  image: null,
  // Two people go in one pass, side by side in one picture (see comfy-local-recipes).
  refs: { field: "reference_image", required: true, array: true, min: 1, max: 2 },
  video: { field: "pose_video", required: true, array: false, min: 1, max: 1, limits: { maxDuration: 15 } },
  resolution: { field: "resolution", choices: [{ value: "512p", label: "512p", height: 512 }, { value: "704p", label: "704p", height: 704 }], default: "704p" },
};

/** LTX-2.5 + Ripple: the clip and up to three characters' pictures (its first frame is redrawn with them); 24 fps, 5 s a pass. */
const RIPPLE_SWAP: Caps = {
  ...none,
  output: "video",
  prompt: { field: "prompt", required: false },
  image: null,
  refs: { field: "reference_image", required: false, array: true, min: 0, max: 3 },
  video: { field: "video", required: true, array: false, min: 1, max: 1, limits: { maxDuration: 20 } },
  resolution: { field: "resolution", choices: [{ value: "540p", label: "540p", height: 540 }, { value: "720p", label: "720p", height: 720 }], default: "720p" },
};

/** Wan 2.2 TI2V 5B: 24 fps at 720p, 1–10 s, from words or a start frame; no sound. */
/** Wan 2.2 5B: up to 121 frames (5 s at 24 fps); 540p for small GPUs and Macs, 720p where it fits. */
const WAN5B_VIDEO: Caps = {
  ...none,
  output: "video",
  prompt: { field: "prompt", required: true },
  image: { field: "start_image", required: false, array: false, min: 0, max: 1 },
  duration: { field: "duration", mode: "range", min: 1, max: 5, integer: true, encode: "number", auto: false, default: 5 },
  resolution: { field: "resolution", choices: [{ value: "540p", label: "540p" }, { value: "720p", label: "720p" }], default: "540p" },
  aspect: { field: "aspect", choices: shapes(["16:9", "9:16"]), default: "16:9" },
  // FastWan's three steps are a fixed schedule; guidance stays adjustable.
  tuning: tuningFor(3, 1, true),
};

/** The Advanced section of Crackio's tuned picture models (their recipes: steps, CFG). */
const LOCAL_IMAGE_TUNING: Record<string, Tuning> = {
  "local:z-image-turbo": tuningFor(8, 1),
  "local:z-image-director": tuningFor(8, 1),
  "local:flux2-klein-4b": tuningFor(4, 1),
  "local:flux3-klein": tuningFor(15, 1),
};

/** FlashVSR+ upscales clips only: the Upscale tool's Video section offers it, its picture picker doesn't. */
const FLASHVSR_UPSCALE: Caps = {
  ...none,
  output: "video",
  prompt: null,
  image: null,
  video: { field: "video", required: true, array: false, min: 1, max: 1 },
};

const BUILTIN: Record<string, Caps> = {
  "local:wan2.2-5b": WAN5B_VIDEO,
  "local:flashvsr-plus": FLASHVSR_UPSCALE,
  "local:ltx-2.5": LTX_VIDEO,
  "local:scail-2": SCAIL_SWAP,
  "local:ltx-2.5-ripple": RIPPLE_SWAP,
};

/** The sizes a built-in image model renders at. */
function imageSettings(m: Pick<ModelDef, "id" | "family">): Pick<Caps, "resolution" | "quality"> {
  // Comfy Router models, at the sizes each makes itself (their schemas, Oct 2026): FLUX 3, Nano Banana 2.1 and GPT Image 2.5
  // up to 4K; Seedream 5.0 Pro, Qwen-Image 3.0 and Grok up to 2K. engines/comfy turns the choice into each one's request.
  const tiers = (top: "2k" | "4k") => ({ field: "resolution", choices: ["1k", "2k", "4k"].slice(0, top === "4k" ? 3 : 2).map((v) => ({ value: v, label: v.toUpperCase() })), default: "2k" });
  if (m.family === "flux3" || m.family === "gemini" || m.family === "openai") return { resolution: tiers("4k"), quality: null };
  if (m.family === "seedream" || m.family === "qwen" || m.family === "grok-router") return { resolution: tiers("2k"), quality: null };
  // Open models on your own GPU: Draft to 4K (local/resolution), natively as far as each renders well, enlarged past that.
  if (m.family === "comfy-local") return { resolution: { field: "resolution", choices: IMAGE_RESOLUTIONS, default: DEFAULT_RESOLUTION }, quality: null };
  return { resolution: null, quality: null };
}

/** Capabilities of a built-in model, or null when Crackio only knows it by name. */
export function builtinCaps(m: Pick<ModelDef, "id" | "kind" | "family" | "maxRefs">): Caps | null {
  const known = BUILTIN[m.id];
  if (known) return known;
  if (m.kind === "image") {
    return {
      ...none,
      output: "image",
      prompt: { field: "prompt", required: true },
      image: m.maxRefs > 0 ? { field: "images", required: false, array: true, min: 0, max: m.maxRefs } : null,
      count: { field: "n", min: 1, max: 4 },
      ...imageSettings(m),
      ...(LOCAL_IMAGE_TUNING[m.id] ? { tuning: LOCAL_IMAGE_TUNING[m.id] } : {}),
    };
  }
  if (m.kind === "upscale" || m.kind === "reframe") {
    return { ...none, output: "image", prompt: null, image: { field: "image", required: true, array: false, min: 1, max: 1 } };
  }
  return null;
}
