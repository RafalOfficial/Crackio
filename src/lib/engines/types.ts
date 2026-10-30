import type { AspectId } from "@/lib/shot";
import type { ProviderId } from "@/lib/providers/types";
import type { Caps } from "@/lib/models/caps";

export type EngineReference = {
  /** Absolute path on disk (uploads are stored locally). */
  path: string;
  label?: string;
  role?: string;
};

export type EngineJob = {
  /** What to make: a new or edited image, an upscale, or a reframe to another aspect ratio. */
  kind: "image" | "video" | "upscale" | "reframe" | "text";
  /** Provider-side model id, e.g. "bfl/flux-3-image". */
  model: string;
  /** The connection to run it through, when an engine serves more than one (a subscription or an API key). */
  via?: ProviderId;
  /** Request shape for that model (see the catalog). */
  family: string;
  /** What the model accepts, for models driven from their published schema (fal, Comfy Router). */
  caps?: Caps;
  /** Tool options: upscale scale/creativity/flavor, reframe target aspect, video duration/resolution. */
  options?: {
    scale?: number;
    /** An upscale's picture size, for the work it is (the engine reads it from the picture). */
    sourceWidth?: number;
    sourceHeight?: number;
    creativity?: number;
    targetAspect?: string;
    flavor?: string;
    /** Video length in seconds, or "auto" to let a model that can pick its own length. */
    duration?: number | "auto";
    /** Resolution as the model names it: "480p", "1080p" for clips; "1K", "2K", "4K" (or a long edge, "2048") for pictures. */
    resolution?: string;
    /** Megapixels for a picture, for models that take any width and height. */
    megapixels?: number;
    /** The exact shape value a model offers ("16:9", "landscape_16_9", "auto"), picked in the tool. */
    aspectValue?: string;
    /** Image quality for models that have the setting ("low", "medium", "high"). */
    quality?: string;
    /** Whether a video model should generate sound (when it can). */
    sound?: boolean;
    /** A preset voice the people in a clip speak with (Grok's voices: "ara", "leo"…), for models that take one. */
    voice?: string;
    /** Crop the start and end frames to the job's aspect, for a clip in a different shape than the picture. */
    cropFrames?: boolean;
    /** Long edge in pixels, for engines that render at a size you choose. */
    longEdge?: number;
    /** Extra request fields a tool knows a model wants (from its published schema), sent as they are. */
    extra?: Record<string, unknown>;
    /** Local models: which of Crackio's ComfyUIs to run on (its id from the Local page), when it has the model. */
    machine?: string;
    /** Local models' Advanced section (local/resolution `Tuning`): what to avoid, denoising steps, guidance, a fixed seed. */
    negative?: string;
    steps?: number;
    cfg?: number;
    seed?: number;
    /** A local edit redrawn over its picture (image to image): how much changes, 0 to 1 (comfy-local-templates `redrawLatent`). */
    denoise?: number;
    /** Local template models: which installed version to run ("int8" over "int8-turbo"), when it can do the job. */
    variant?: string;
    /**
     * LoRAs on the model (local ComfyUI): files in its models/loras, strength -3…3 (1 by default). Their trigger words and
     * which of a graph's models each goes on come from the LoRA library (server/loras).
     */
    loras?: { file: string; strength?: number }[];
    /** How hard a ControlNet holds the depth it was given (`depth`), 0.3 to 1: the Director’s shots, 0.9 when missing. */
    control?: number;
    /** How far through the steps the ControlNet holds (0.2 to 1): the details after it are the model’s own. */
    controlEnd?: number;
  };
  /** Where an inpainting model paints: white changes, black stays (the main picture's size or shape). */
  mask?: EngineReference;
  /** Pictures the clip passes through between its start and end frames, and when (seconds). */
  keyframes?: (EngineReference & { t: number })[];
  /** Who and what a clip should show, as pictures (people, props, a place), for models that take reference images alongside the start frame. */
  refImages?: EngineReference[];
  /** Final prompt to send (already refined, if refinement was on). */
  prompt: string;
  /** The person's original words, for engines that refine internally. */
  userPrompt: string;
  refine: boolean;
  aspect: AspectId;
  width: number;
  height: number;
  count: number;
  references: EngineReference[];
  /** Optional guide image (e.g. a Director layout render) the output must follow. */
  guide?: EngineReference;
  /** Optional depth pass rendered from the Director set (white = near), for depth-conditioned workflows. */
  depth?: EngineReference;
  /** A clip to edit instead of making one (Recast): its motion and timing stay, the prompt says what changes. */
  source?: EngineReference;
  /** A clip's first and last frames, when the tool set them (they're also the first references). */
  start?: EngineReference;
  end?: EngineReference;
  /** Optional subject boxes (0–1000 `[ymin, xmin, ymax, xmax]`), for layout-aware models. */
  layout?: { id: string; bbox: [number, number, number, number]; desc: string }[];
  mode: "image" | "video";
};

export type EngineOutput = {
  data: Buffer;
  mime: string;
  width?: number;
  height?: number;
};

export type EngineResult = {
  outputs: EngineOutput[];
  /** The prompt the engine finally used, if it rewrote it. */
  usedPrompt?: string;
};

export type EngineContext = {
  signal: AbortSignal;
  progress: (value: number, stage?: string) => void;
};

export interface Engine {
  id: ProviderId;
  label: string;
  supports: (job: Pick<EngineJob, "mode">) => boolean;
  run: (job: EngineJob, ctx: EngineContext) => Promise<EngineResult>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    /** Plain-language next step shown to the person. */
    public readonly hint?: string,
  ) {
    super(message);
  }
}
