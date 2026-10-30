/**
 * A take's recipe: every ComfyUI graph its job queued, in order, exactly as it was sent (after Crackio's post-passes,
 * with its seed and file names), where it ran and how long it took; a Comfy Router job's request body. The server keeps
 * one next to each Library item (server/recipes); the Library viewer shows it ("How it was made"), opens a graph in
 * ComfyUI again and downloads it. Pure: shared by the server and the page.
 */

/** An API-format ComfyUI graph: node id → its class and inputs (a link is `[node id, output index]`). */
export type ApiGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;

export type RecipeStep = {
  /**
   * A graph on one of your ComfyUIs, a request to a Comfy Router model, or a step Crackio did itself outside ComfyUI (a
   * text model writing the prompt or answering a check, ffmpeg laying the sound back, a blend), listed so the recipe is
   * the whole job.
   */
  kind: "comfyui" | "router" | "outside";
  /** What Crackio called it ("FLUX 3 Klein", "SAM 3.1 outline", "FLUX 3 Klein (preparing)", a Router model's id). */
  name: string;
  /** Outside steps: what did it ("Grok 4.3", "ffmpeg"). */
  detail?: string;
  /**
   * ComfyUI: the machine, its name and GPU. Kept as a key that can't be turned back into its address (machine ids carry
   * one); `id` is only in the Library's answer, found again from the key, to open the graph on that machine.
   */
  machine?: { key: string; label: string; gpu?: string | null; id?: string };
  promptId?: string;
  /** ComfyUI: the graph exactly as it was queued. */
  graph?: ApiGraph;
  /** Router: the model's endpoint and the body sent (pictures shortened to their size, see `lean`). */
  endpoint?: string;
  request?: unknown;
  /** When it was sent (ms since 1970). */
  at: number;
  /** ComfyUI's own working time, from its execution messages. */
  ms?: number | null;
  /** From sending to the last file. */
  wallMs?: number;
  /** Its models were already loaded. */
  warm?: boolean;
  /** On RunPod Serverless: what it billed, in milliseconds as its /status says (running, and waiting for a worker). */
  executionTime?: number;
  delayTime?: number;
  /** On Comfy Cloud: the GPU time it ran (ms) and the credits that comes to at its API rate. */
  executionMs?: number;
  comfyCredits?: number;
  /** The files it wrote. */
  outputs?: string[];
  /** ComfyUI: its nodes that come from custom node packs (the machine's /object_info says which), and the pack. */
  custom?: { node: string; pack: string }[];
  status: "running" | "done" | "error";
  error?: string;
};

export type RecipeSettings = {
  /** Diffusion models and checkpoints the graph loads (and upscale models). */
  models: string[];
  /** Text encoders and VAEs. */
  encoders: string[];
  loras: { name: string; strength: number }[];
  seed?: number;
  steps?: number;
  cfg?: number;
  guidance?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  /** Sampling passes (a detail pass or a clip's segments add one each). */
  samplers: number;
  nodes: number;
};

export type JobRecipe = {
  version: 1;
  /** The Library item's (generation's) id. */
  id: string;
  tool: string;
  model?: string;
  modelName?: string;
  engine?: string;
  prompt?: string;
  createdAt: number;
  finishedAt?: number;
  /** The take's own size, as saved. */
  size?: { width: number; height: number };
  /** Which step made the take (the last finished one that samples): its settings. */
  main: number;
  settings?: RecipeSettings;
  steps: RecipeStep[];
};

const SAMPLER = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Node ids in the order they were added ("9" before "10", "12:3" after "12"). */
export const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** What a graph was made with: its models, LoRAs and sampling settings (the first sampling pass's, in node order). */
export function graphSettings(graph: ApiGraph): RecipeSettings {
  const nodes = Object.entries(graph).sort(([a], [b]) => byId(a, b));
  const s: RecipeSettings = { models: [], encoders: [], loras: [], samplers: 0, nodes: nodes.length };
  const add = (list: string[], v: string | undefined) => v && !list.includes(v) && list.push(v);
  for (const [, node] of nodes) {
    const type = node.class_type ?? "";
    const i = node.inputs ?? {};
    if (SAMPLER.test(type)) s.samplers++;
    for (const key of ["unet_name", "ckpt_name", "model_name"]) add(s.models, str(i[key]));
    for (const key of ["clip_name", "clip_name1", "clip_name2", "clip_name3", "vae_name"]) add(s.encoders, str(i[key]));
    const lora = str(i.lora_name);
    if (lora) s.loras.push({ name: lora, strength: num(i.strength_model) ?? num(i.strength) ?? 1 });
    s.seed ??= num(i.seed) ?? num(i.noise_seed);
    s.steps ??= num(i.steps);
    s.cfg ??= num(i.cfg);
    s.guidance ??= num(i.guidance);
    s.sampler ??= str(i.sampler_name);
    s.scheduler ??= str(i.scheduler);
    if (SAMPLER.test(type) || /Scheduler$/.test(type)) s.denoise ??= num(i.denoise);
    if (/^Empty.*Latent/.test(type)) {
      s.width ??= num(i.width);
      s.height ??= num(i.height);
      s.frames ??= num(i.length);
    }
    s.fps ??= num(i.frame_rate) ?? num(i.fps);
  }
  return s;
}

/** The step a take came from: the last finished one that samples, else the last finished graph or request. */
export function mainStep(steps: RecipeStep[]) {
  let found = -1;
  steps.forEach((step, i) => {
    if (step.status !== "done" || step.kind === "outside") return;
    const samples = step.kind === "router" || Object.values(step.graph ?? {}).some((n) => SAMPLER.test(n.class_type ?? ""));
    if (samples || found < 0) found = i;
  });
  return found < 0 ? steps.length - 1 : found;
}

/**
 * What a recipe must never keep, since takes are shown and shared: links (a signed asset link carries its token),
 * machine addresses (also written with dashes, as machine ids are), keys and tokens, logins, and paths on a computer.
 */
const PRIVATE: [RegExp, string][] = [
  [/\b(?:https?|wss?|ssh|sftp):\/\/[^\s"'<>]+/gi, "(a link, not kept)"],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, "(a token, not kept)"],
  [/\b(?:sk|xai|hf|ghp|gho|ghs|github_pat|comfyui|key)[-_][\w-]{16,}/gi, "(a key, not kept)"],
  [/\b(?:AKIA|AIza)[\w-]{12,}/g, "(a key, not kept)"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "(an address, not kept)"],
  [/\b(?:\d{1,3}-){3}\d{1,3}(?:-\d{2,5})?\b/g, "(an address, not kept)"],
  [/\b[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}\b/gi, "(a login, not kept)"],
  [/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, "(a path, not kept)"],
  [/(?<![\w.~-])\/(?:home|root|Users|workspace|mnt|opt|tmp|var|srv|etc|usr|private|Volumes)\/[^\s"'<>]*/g, "(a path, not kept)"],
];

/** A copy with everything `PRIVATE` names taken out of every string. */
export function scrub<T>(value: T): T {
  if (typeof value === "string") return PRIVATE.reduce((s, [re, note]) => s.replace(re, note), value as string) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) as T;
  return value;
}

/** The first private thing left in a value (as JSON), or null: what Crackio checks before it keeps a recipe. */
export function leak(value: unknown): string | null {
  const text = JSON.stringify(value);
  for (const [re] of PRIVATE) {
    re.lastIndex = 0;
    const found = re.exec(text);
    re.lastIndex = 0;
    if (found) return found[0].slice(0, 80);
  }
  return null;
}

/**
 * A copy small enough to keep: pictures sent inline (data URLs, raw base64) become a note of their size. ComfyUI graphs
 * name their files instead, so they stay exactly as sent; only a string past `limit` is shortened.
 */
export function lean(value: unknown, limit = 4096): unknown {
  if (typeof value === "string") {
    if (value.length <= limit) return value;
    const kb = Math.round((value.length * 3) / 4 / 1024);
    const data = /^data:([^;,]+)[;,]/.exec(value);
    return data ? `data:${data[1]} (${kb} KB, not kept)` : `(${kb} KB of data, not kept)`;
  }
  if (Array.isArray(value)) return value.map((v) => lean(v, limit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lean(v, limit)]));
  return value;
}

/** A downloaded graph's file name: "crackio-image-flux-3-klein-3f9a2c.api.json". */
export function workflowFileName(recipe: Pick<JobRecipe, "id" | "tool">, step: RecipeStep, index: number, count: number) {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  const part = count > 1 ? `-step${index + 1}` : "";
  return `crackio-${slug(recipe.tool) || "take"}-${slug(step.name) || step.kind}-${recipe.id.slice(-6)}${part}.${step.kind === "router" ? "request" : "api"}.json`;
}
