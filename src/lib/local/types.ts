import type { ModelSpeeds } from "./work";

/**
 * The "Local" catalog: open-weights models Crackio can install into a ComfyUI and run there, free. Client-safe:
 * the page and the server share these shapes. Machines are read by `server/hardware.ts`; fits come from `fit.ts`.
 */

export type LocalTask = "image" | "edit" | "video" | "swap" | "upscale";

/** ComfyUI model folders (folder_paths names). */
export type ModelFolder =
  | "diffusion_models"
  | "text_encoders"
  | "vae"
  | "loras"
  | "checkpoints"
  | "clip_vision"
  | "latent_upscale_models"
  | "upscale_models"
  | "model_patches"
  | "vae_approx"
  | "frame_interpolation"
  /** FlashVSR+'s own folder (models/FlashVSR; the Crackio bridge 1.5+ and its node both add it). */
  | "FlashVSR";

/**
 * A file the model needs, where ComfyUI looks for it, and what it is to the recipe (`role`: "model", "text", "vae"…;
 * the recipe asks for the installed variant's file by role). Shared files (a text encoder two models use) are listed by each.
 */
export type LocalFile = { folder: ModelFolder; name: string; url: string; bytes: number; sha256?: string; role: string; /** `bytes` is a guess (a gated file whose size its host won't say). */ sizeEstimated?: boolean };

export type Backend = "cuda" | "mps" | "rocm" | "xpu" | "directml" | "cpu";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

export type Gpu = {
  name: string;
  vendor: GpuVendor;
  /** Its own memory in GB; on Apple Silicon, the unified memory it shares with the CPU. */
  memoryGb: number | null;
  unified: boolean;
  driver?: string;
  /** NVIDIA compute capability: 8.9 runs fp8 fast (RTX 40), 12.0 runs nvfp4 (RTX 50). */
  compute?: number;
  /** Apple GPU cores. */
  cores?: number;
};

/** A machine that runs (or could run) ComfyUI. */
export type Machine = {
  /** A detected machine, or one of the examples people can compare against. */
  where: "this-computer" | "comfyui" | "example";
  /** "Mac with Apple M3 Pro", "Windows PC", "Linux machine running ComfyUI". */
  label: string;
  os: { family: "macos" | "windows" | "linux" | "other"; name: string; arch: string };
  cpu: { model: string; threads: number } | null;
  ramGb: number;
  gpus: Gpu[];
  diskFreeGb: number | null;
  /** What ComfyUI computes on (or would, on this computer). */
  accel: Backend;
  /** Where models live while they run: the GPU's memory, or what macOS lets the GPU take of unified memory. */
  modelMemoryGb: number;
  /** For a ComfyUI: where it answers, its version and PyTorch build, and the Crackio bridge's version when installed. */
  comfy?: { url: string; version?: string; torch?: string; bridge?: string };
  /** For a ComfyUI: which of Crackio's ComfyUIs it is (`TargetStatus.id`). */
  target?: string;
};

/** One way to run a model: a precision (bf16, fp8, int8, nvfp4, a GGUF quant), its files and what it needs. */
export type LocalVariant = {
  id: string;
  /** "INT8", "FP8", "GGUF Q4_K_M". */
  label: string;
  files: LocalFile[];
  /** Memory it runs in without offloading, in GB: the weights that stay loaded plus the working set at the default size. */
  needGb: number;
  /**
   * GPU memory below which it doesn't run alone at all: its working set, not its weights, overflows (out of memory), so
   * streaming weights from RAM doesn't save it. Only pooling with another computer does.
   */
  minGb?: number;
  /** Quality next to the full-precision model: 1 is no visible loss. */
  fidelity: number;
  /** Seconds per unit (see `LocalModel.unit`) on an RTX 5090; measured on one when `measured`. */
  seconds5090: number;
  measured?: boolean;
  /**
   * The share of its RTX 5090 time that doesn't follow the GPU's speed (reading and writing the frames, the CPU's part):
   * seconds5090 × (fixedShare + (1 − fixedShare) / speed). None (the default) for diffusion, whose steps are all GPU math.
   */
  fixedShare?: number;
  /** Denoising passes over its weights in one job (what doesn't fit in the GPU streams from RAM each one). */
  steps?: number;
  /** For models run from ComfyUI's official templates: which template does each job (by what it's given). */
  templates?: Partial<Record<TemplateMode, string>>;
  /** Fast paths: fp8 math wants compute 8.9+ (RTX 40/50), nvfp4 wants 12.0 (RTX 50). Backends it runs on at all. */
  requires?: { compute?: number; backends?: Backend[]; customNodes?: string[] };
  /**
   * Splits across two computers' GPUs when one can't hold it: this machine keeps the first blocks of the model, another
   * computer's ComfyUI (Crackio's bridge 1.3+) the rest, and only the activations between them cross the network each
   * step. GGUF models only (comfyui/crackio_bridge/pool.py).
   */
  pool?: boolean;
  /**
   * Its steps are long next to moving its weights: a 14B video model working on tens of thousands of tokens computes for
   * minutes a step, while streaming what the GPU can't hold from RAM takes a second or two. A card smaller than `needGb`
   * still runs it at nearly full speed, as long as RAM holds the files.
   */
  streams?: boolean;
  /**
   * What its GPU work costs on GTX 10 and older cards (compute below 7: no tensor cores, ComfyUI computes in fp32 there)
   * next to what their speed ratio predicts: the ratios come from FLUX-style diffusion, and some models lose more.
   */
  oldGpuCost?: number;
  /** For a GGUF version Crackio adds to a template model: the template's model file it runs in place of. */
  replaces?: string;
};

export type LocalModel = {
  id: string;
  name: string;
  maker: string;
  tasks: LocalTask[];
  /** One sentence: what it's best at. */
  blurb: string;
  /** Standing among open models for its main task, 0–100 (public arenas, community tests, our own runs). */
  quality: number;
  /** What `seconds5090` counts: one 1-megapixel image, or one 5-second clip at 720p. */
  unit: "image" | "clip";
  /** Makes sound with the picture. */
  audio?: boolean;
  licence: { name: string; url?: string; commercial: "yes" | "limited" | "no"; note?: string };
  variants: LocalVariant[];
  /** Crackio's model id once its tools can run it (`local:…`). */
  crackio?: string;
  /** Its Hugging Face repo makes you accept its terms first (and installs need your token). */
  gated?: { repo: string };
  /** Hand-tuned recipe in Crackio, or run from ComfyUI's official template. */
  source?: "curated" | "template";
  /** Newest release date among its templates (YYYY-MM-DD). */
  released?: string;
  /** How often ComfyUI users open its templates. */
  usage?: number;
  /** A template whose preview picture shows what it makes. */
  thumb?: string;
  /** Regions its licence leaves out. */
  excludes?: string[];
  /** `quality` comes from evidence (arenas, tests); otherwise it's only for sorting and isn't shown. */
  qualityKnown?: boolean;
};

/** What a template does with what it's given. */
/** "r2v": reference to video, a clip guided by one composite reference sheet (LTX-2.3's IC-LoRA "ingredients"). */
export type TemplateMode = "t2i" | "edit" | "t2v" | "i2v" | "flf2v" | "r2v" | "upscale" | "vupscale" | "swap";

export type FitState = "great" | "ok" | "slow" | "no";

export type Fit = {
  state: FitState;
  /** The variant to install here. */
  variant: LocalVariant | null;
  /** Estimated seconds per unit on this machine. */
  seconds: number | null;
  /** Why, in a few words ("Fits in 32 GB", "Spills 6 GB into RAM", "Needs 24 GB"). */
  why: string;
  /** `seconds` is what it really took on this machine, not an estimate. */
  measured?: boolean;
  /** What loading the model added to runs that found it unloaded (measured); `seconds` includes it when `coldOnly`. */
  load?: number;
  coldOnly?: boolean;
  /** Seconds per unit of edits, when edits have run here (some run a heavier graph); else edits scale `seconds` (local/work). */
  edit?: number;
  /** It runs split with this other computer, which lends its GPU memory (variants with `pool`). */
  pool?: string;
  /** The estimate its time comes from (local/estimate): where from, and a likely range. */
  estimate?: LocalEstimate;
};

export type Download = {
  id: string;
  folder: string;
  filename: string;
  state: "queued" | "downloading" | "checking" | "done" | "error" | "stopped";
  received: number;
  total: number;
  error?: string | null;
  via: "bridge" | "direct";
};

/** A rented cloud GPU's ComfyUI: the cloud, its instance there, and how Crackio logs in to set it up. */
export type CloudGpu = {
  provider: "vast" | "runpod" | "other";
  /** The instance or pod id at that cloud. */
  instance?: string;
  ssh?: { host: string; port: number; user: string };
  /** Jobs reach its ComfyUI through an SSH tunnel to this port on the box, when it shows no web address. */
  tunnel?: number;
};

/** One ComfyUI Crackio runs models on, and what it has: each machine keeps its own models, downloads and speeds. */
export type TargetStatus = {
  id: string;
  label: string;
  url: string;
  source: "main" | "installed" | "added";
  /** A rented GPU (connected on the Local page). */
  cloud?: { provider: CloudGpu["provider"]; instance?: string; tunnel?: boolean };
  /** Nobody set it up: ComfyUI's usual address, checked in case one already runs there (not worth a warning when none does). */
  implicit?: boolean;
  connected: boolean;
  onThisComputer: boolean;
  bridge: string | null;
  installed: string[];
  downloads: Download[];
  measured: Record<string, ModelSpeeds>;
  /** GPU memory this machine can lend to another one's model (its bridge's /crackio/pool), in GB; null when it can't. */
  lendsGb?: number | null;
  /** How long each model takes on this machine now (local/estimate), by model id. */
  estimates?: Record<string, LocalEstimate>;
  /**
   * What the estimates allowed for: other apps' load on the GPU (0–1), its PCIe link, how this machine compares (1 = as
   * benchmarked); and how they did: of its recent runs, the share that took within 25% of the time estimated beforehand.
   */
  live?: { busy?: number; pcieGBps?: number; factor: number; accuracy?: { runs: number; within: number }; mac?: MacHeat };
};

/**
 * A Mac's heat and battery right now (the bridge's /crackio/live, 1.6.0 and later): what its Crackio Mac Tuning node rests
 * by. `thermal` is macOS's own reading; `fanless` a MacBook Air, whose case is its heatsink.
 */
export type MacHeat = {
  thermal: "nominal" | "fair" | "serious" | "critical" | null;
  battery: { temp: number; percent: number | null; plugged: boolean } | null;
  fanless: boolean | null;
  /** macOS's energy mode: Low Power Mode, and on Macs that have one (MacBook Pros with a Max chip) the mode itself. */
  power?: { low: boolean; mode: "automatic" | "low" | "high" | null } | null;
};

/**
 * A model's time on one machine: one unit of its main job (a 1 MP picture, a 5 s clip, an upscale to 1 MP) and an edit with
 * one picture, with the model loaded; `load` what a first run adds. `basis`: measured here, benchmarked on this card, from
 * other cards' benchmarks, or the catalog's estimate.
 */
export type LocalEstimate = {
  seconds: number;
  low: number;
  high: number;
  load: number;
  basis: "measured" | "same-gpu" | "series" | "others" | "catalog";
  runs: number;
  from: string | null;
  variant: string;
  edit?: { seconds: number; low: number; high: number; basis: LocalEstimate["basis"]; runs: number };
};

export type LocalStatus = {
  comfy: { url: string; connected: boolean; onThisComputer: boolean; bridge: string | null };
  /** The ComfyUI's machine first (when it answers), then this computer when that's another one. */
  machines: Machine[];
  /** `folder/name` of every catalog file the ComfyUI already has. */
  installed: string[];
  downloads: Download[];
  /** Whether a Hugging Face token is set (gated models like LTX-2.5 need one). */
  hfToken: boolean;
  /** When models too big for one GPU are split with another computer (settings `pooling`). */
  pooling: "auto" | "always" | "off";
  /** What each model has really taken on the main ComfyUI's GPU, per unit of work (local/work). */
  measured: Record<string, ModelSpeeds>;
  /** This computer's region (from its time zone), for licences that leave regions out. */
  region: string | null;
  /** Every ComfyUI Crackio knows, main first; the fields above are the main one's. */
  targets: TargetStatus[];
  /** Where local jobs run: a target's id, or "auto" (settings `runOn`). */
  runOn: string;
};
