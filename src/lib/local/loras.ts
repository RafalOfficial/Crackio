import type { LocalModel } from "./types";

/**
 * The LoRA library: small add-ons that change how one open model draws (a look, a camera move, a fix). Crackio's picks
 * for each model (lib/local/lora-catalog.json, checked files from Hugging Face) and any other LoRA found there, downloaded
 * into a ComfyUI's models/loras and switched on per model (hooks/use-model-loras): every job that model runs then carries
 * them (engines/comfy-local `withLoras`). Client-safe: the pages and the server share these shapes.
 */

export type LoraCategory = "looks" | "detail" | "light" | "angles" | "motion" | "effects" | "edit" | "characters" | "world" | "design" | "speed";

export const LORA_CATEGORIES: { id: LoraCategory; label: string; hint: string }[] = [
  { id: "looks", label: "Looks", hint: "Styles: film and photo looks, illustration, anime, 3D" },
  { id: "detail", label: "Detail & fixes", hint: "Realism, skin and texture, sliders, hands" },
  { id: "light", label: "Light", hint: "Relighting and lighting styles" },
  { id: "angles", label: "Camera angles", hint: "The same subject from another viewpoint" },
  { id: "motion", label: "Camera & motion", hint: "Camera moves, slow motion, loops" },
  { id: "effects", label: "Effects", hint: "Explode, melt, inflate, transform" },
  { id: "edit", label: "Edit tools", hint: "Outpaint, remove, try-on, the next scene" },
  { id: "characters", label: "Characters", hint: "Character sheets and turnarounds" },
  { id: "world", label: "World & 360", hint: "Panoramas and places" },
  { id: "design", label: "Design & text", hint: "Typography, posters, icons, UI" },
  { id: "speed", label: "Speed", hint: "Fewer steps, quicker results" },
];

export const categoryLabel = (c: LoraCategory) => LORA_CATEGORIES.find((x) => x.id === c)?.label ?? c;

/**
 * One file of a LoRA. `match`: a pattern on the model file a loader loads, when the file belongs on one of a graph's models
 * only (a Wan 2.2 A14B pair: its high-noise file on the high-noise model, its low-noise file on the other).
 */
export type LoraFile = { path: string; bytes: number; sha256?: string; match?: string };

export type LoraEntry = {
  id: string;
  name: string;
  /** The Local models (`LocalModel.id`) it's made for. */
  models: string[];
  /** Its Hugging Face repo, and the commit its files were read at. */
  repo: string;
  revision?: string;
  files: LoraFile[];
  category: LoraCategory;
  /** One sentence: what it does. */
  blurb: string;
  /** Words that wake it, put in every prompt it goes with: first, or last when its maker says so. */
  trigger?: string;
  triggerAt?: "end";
  /** How strong by default, and the range that makes sense (sliders go below zero). */
  strength: number;
  range: [number, number];
  licence: { name: string; commercial: "yes" | "limited" | "no" };
  downloads?: number;
  likes?: number;
  /** Its repo makes you accept terms on Hugging Face first. */
  gated?: boolean;
  /** An example from its repo: a picture, or a clip. Shown only when it was looked at (a pick's, or lora-gallery.json's). */
  preview?: string;
  /** Its example moves (a clip, an animated picture): a card plays it while the pointer is on it. */
  clip?: boolean;
  /** Found on Hugging Face and looked at by nobody here: its example is its maker's, unseen. */
  unchecked?: boolean;
  /** An unchecked one whose words say its example may be suggestive: it shows blurred until asked for. */
  blur?: boolean;
  /** An adult LoRA: listed only where an adult chose to see them (`LoraPolicy`), and marked 18+. */
  adult?: boolean;
  /** How many LoRA files its repo holds (a find's: Crackio picks the one to get, `pickFiles`). */
  fileCount?: number;
  /** When its repo was made (ISO), for "newest first". */
  created?: string;
  author: string;
  note?: string;
  /** Found by a Hugging Face search: not one of Crackio's checked picks. */
  found?: boolean;
  /** When Crackio ran it on a GPU, with and without it on the same seed, and it did what it promises. */
  tested?: string;
  /** The file names it has (or will have) in models/loras, one per file. */
  local?: string[];
  /** Trained here (the Train page's job id): it has no repo to download from; Crackio keeps a copy of its file. */
  trained?: string;
  /** Your own file, uploaded from your computer (when): no repo either; Crackio keeps it and sends it to machines. */
  uploaded?: string;
  /** Said under an uploaded file on this model's page: its layers look like another model's. */
  warning?: string;
  /** An uploaded file whose layers are this model's. */
  fits?: boolean;
};

/** A LoRA file Crackio downloaded, and what it is (data/loras.json on the server). */
export type LoraRecord = {
  file: string;
  entry: string;
  name: string;
  repo: string;
  path: string;
  models: string[];
  category: LoraCategory;
  trigger?: string;
  triggerAt?: "end";
  strength: number;
  range: [number, number];
  match?: string;
  /** The other files it came with (a Wan 2.2 pair's other half): they're one LoRA, switched on and off together. */
  pair?: string[];
  licence: LoraEntry["licence"];
  bytes: number;
  found?: boolean;
  /** Trained here: the Train page's job id, and the step of the version the file holds. */
  trained?: string;
  step?: number;
  /**
   * Machines (their ids) whose file of this name holds another version: one was picked while they were off. The file
   * goes there again before the next job that uses it.
   */
  stale?: string[];
  /** Uploaded from your computer (when, ISO): Crackio keeps the file in data/loras (server/lora-home). */
  uploaded?: string;
  sha256?: string;
  /**
   * How to prompt it, for the next agent or person: the words that work, the strength, its quirks. Written by you (the
   * Train page) or by an agent after testing it (the MCP's loras tool); `by` says who wrote it last.
   */
  notes?: { text: string; by: string; at: string };
  /** An uploaded file's check against each model it's for: the models whose layers it has, and what to say where it hasn't. */
  fits?: string[];
  warn?: Record<string, string>;
};

/** What `/api/local/loras/library` answers. */
export type LoraLibrary = {
  entries: LoraEntry[];
  /** Hugging Face base repos whose LoRAs fit each model (`LocalModel.id`), for a search of its own. */
  bases: Record<string, string[]>;
  /** Every LoRA file Crackio downloaded, by its file name. */
  records: Record<string, LoraRecord>;
};

/** What the library's listing of one model answers (`/api/local/loras/hub?model=`). */
/**
 * What the LoRA library may show of adult LoRAs on this computer (Settings → Preferences; server/lora-policy):
 * `age` as whoever uses Crackio says it themselves (null: not asked), `adult`: an adult chose to see adult LoRAs,
 * `blur`: those show blurred behind a button, `locked`: someone said they're under 18, and it stays off.
 */
export type LoraPolicy = { age: "adult" | "minor" | null; adult: boolean; blur: boolean; locked: boolean };

export type LoraBrowse = {
  /** Every LoRA on Hugging Face made for the model that the library shows, most popular first; the picks aren't among them. */
  entries: LoraEntry[];
  /** How many times the picks' repos were downloaded lately and liked, read just now (the catalog's numbers are a month old). */
  counts: Record<string, { downloads?: number; likes?: number }>;
};

/** A LoRA's id as its example's address takes it ("hf:owner/name" has a slash). */
export const previewId = (id: string) => id.replace(/\//g, "~");

/** Models whose LoRAs come as two files, one for each of the two models a clip is drawn with (Wan 2.2 14B: high and low noise). */
const PAIRED = /wan2\.2-14b/;

/** Words in a file's name that say it's a leftover, not the LoRA to use. */
const LEFTOVER = /(^|[/_\-. ])(old|backup|bak|test|wip|draft|deprecated|unused|optimizer|ema|sample|example|emb|embedding)s?([/_\-. ]|$)|(^|\/)(ckpts?|checkpoints?)[^/]*\//;

/** What a file's name says it's for, by model family: a repo can hold another model's version beside this one's. */
const FAMILIES: [RegExp, RegExp][] = [
  [/qwen/, /qwen|qie/],
  [/flux|klein/, /flux|klein|kontext/],
  [/wan/, /(^|[^a-z])wan(?![a-z])/],
  [/ltx/, /ltx/],
  [/z-image/, /z[-_]?image|(^|[^a-z])zit(?![a-z])/],
  [/krea-2/, /krea[-_ ]?2|(^|[^a-z])k2(?![a-z])/],
  [/moss/, /(^|[^a-z])moss(?![a-z])/],
  [/hidream/, /hidream/],
  [/sdxl/, /sdxl|[_\-.]xl/],
];

/** A name (a file's, a repo's) that says it's for another model family than this one, and not for this one. */
export function namesAnotherModel(modelId: string, name: string): boolean {
  const own = FAMILIES.find(([id]) => id.test(modelId))?.[1];
  const text = name.toLowerCase();
  return Boolean(own) && !own!.test(text) && FAMILIES.some(([, says]) => says !== own && says.test(text));
}

/** What a model's own files are called, to pick its file from a repo that holds several models' (by `LocalModel.id`). */
const FILE_HINTS: [RegExp, { want?: RegExp; avoid?: RegExp }][] = [
  [/wan2\.2-14b/, { want: /i2v|14b/, avoid: /t2v|ti2v|5b|1\.3b|wan[._-]?2[._-]?1/ }],
  [/wan2\.2-5b/, { want: /5b|ti2v/, avoid: /14b|i2v_?a14|high|low/ }],
  [/^ltx-2\.5/, { want: /2[._-]?5/, avoid: /2[._-]?3|ltxv?[._-]?2(?![._-]?[35])/ }],
  [/ltx-2\.3/, { want: /2[._-]?3/, avoid: /2[._-]?5/ }],
  [/klein-4b/, { want: /4b|k4\d/, avoid: /9b|k9\d/ }],
  [/klein-9b/, { want: /9b|k9\d/, avoid: /4b|k4\d/ }],
  [/flux3-klein/, { want: /klein|flux[._-]?3/ }],
  [/turbo/, { want: /turbo/ }],
];

/**
 * The file (or the pair) to get from a repo that holds several LoRA files, so adding a LoRA is one click: leftovers out,
 * then the one named for this model (and for ComfyUI), the one named like its repo, the newest version, the finished file
 * over a training checkpoint. A Wan 2.2 14B LoRA's high- and low-noise halves come together, each for its own model
 * (`LoraFile.match`).
 */
export function pickFiles(model: Pick<LocalModel, "id">, files: LoraFile[], repo = ""): LoraFile[] {
  if (!files.length) return files;
  const name = (f: LoraFile) => f.path.toLowerCase();
  const kept = files.filter((f) => !LEFTOVER.test(name(f)));
  const pool = kept.length ? kept : files;
  const hint = FILE_HINTS.find(([id]) => id.test(model.id))?.[1];
  const own = FAMILIES.find(([id]) => id.test(model.id))?.[1];
  // Another model's version kept in the same repo ("Kontext-Relight-Lora/…" beside "Qwen-Edit-Relight").
  const foreign = (f: LoraFile) => Boolean(own) && !own!.test(name(f)) && FAMILIES.some(([, says]) => says !== own && says.test(name(f)));
  // Named for this model, not for another; the copy saved for ComfyUI; and the one its maker calls the final or favourite.
  const fits = (f: LoraFile) =>
    2 * Number(Boolean(hint?.want?.test(name(f)))) -
    4 * Number(Boolean(hint?.avoid?.test(name(f)))) -
    3 * Number(foreign(f)) +
    Number(/comfy/.test(name(f))) -
    Number(/diffusers/.test(name(f))) +
    Number(/favou?rite|final|best|recommended|main/.test(name(f)));
  // In a repo of several LoRAs, the one the repo is named after: how far its name and the repo's run alike.
  const plain = (s: string) => s.toLowerCase().replace(/\.safetensors$/, "").replace(/[^a-z0-9]+/g, "");
  const title = plain(repo.split("/").pop() ?? "");
  const alike = (f: LoraFile) => {
    const file = plain(f.path.split("/").pop() ?? "");
    let n = 0;
    while (n < title.length && n < file.length && title[n] === file[n]) n++;
    return n >= 4 ? n : 0;
  };
  // "v2", "v1.5": a step number right after it ("v1_000001500") is not part of the version.
  const version = (f: LoraFile) => Math.max(0, ...[...name(f).matchAll(/(?:^|[_\-. /])v(\d+(?:[._]\d{1,2})?)(?!\d)/g)].map((x) => Number(x[1].replace("_", "."))));
  // A training checkpoint ends in its step or epoch ("…_000002000", "…-e12"); the finished file has no number, and wins.
  const step = (f: LoraFile) => {
    const m = /(?:[_\-.](?:step|epoch|e|s)?[_-]?)(\d{2,})\.safetensors$/.exec(name(f));
    return m ? Number(m[1]) : Infinity;
  };
  const depth = (f: LoraFile) => f.path.split("/").length;
  const best = [...pool].sort((a, b) => fits(b) - fits(a) || alike(b) - alike(a) || version(b) - version(a) || step(b) - step(a) || depth(a) - depth(b) || b.bytes - a.bytes)[0];
  if (!PAIRED.test(model.id)) return [best];
  const side = /high/.test(name(best)) ? "high" : /low/.test(name(best)) ? "low" : null;
  if (!side) return [best];
  const other = side === "high" ? "low" : "high";
  // Its other half: the same name with the side swapped, else the same name apart from the side and the step it stopped
  // at ("…_v11_wan_high_50" goes with "…_v11_wan_low_100").
  const stem = (f: LoraFile) => name(f).replace(/high|low/, "").replace(/[_\-.]?\d+\.safetensors$/, "");
  const twin = pool.find((f) => name(f) === name(best).replace(side, other)) ?? pool.find((f) => new RegExp(other).test(name(f)) && stem(f) === stem(best));
  const half = (f: LoraFile, which: string): LoraFile => ({ ...f, match: `${which}_noise` });
  if (!twin) return [half(best, side)];
  return side === "high" ? [half(best, "high"), half(twin, "low")] : [half(twin, "high"), half(best, "low")];
}

/** A file name in a LoRA repo that says nothing of what it is. */
const GENERIC = /^(pytorch_lora_weights|adapter_model|diffusion_pytorch_model|model|lora|lora_weights|weights|adapter|default)$/i;

/**
 * The name a LoRA file gets in models/loras: its own name, or its repo's when that says nothing ("pytorch_lora_weights"),
 * in the characters a ComfyUI bridge accepts. Names stay flat: the bridge writes no subfolders.
 */
export function loraFileName(repo: string, filePath: string) {
  const parts = filePath.split("/");
  const base = parts.pop()!.replace(/\.safetensors$/i, "");
  const repoName = repo.split("/")[1] ?? repo;
  const stem = GENERIC.test(base) || base.length < 4 ? [repoName, ...parts, GENERIC.test(base) ? "" : base].filter(Boolean).join("-") : base;
  const tidy = (s: string) =>
    s
      .replace(/[^A-Za-z0-9_.\-+ ()[\]]+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[_.\s]+|[_.\s]+$/g, "")
      .slice(0, 180);
  // A name in another script ("白膜转材质") leaves nothing readable: its repo's name stands in.
  const clean = /[A-Za-z0-9]{2}/.test(tidy(stem)) ? tidy(stem) : tidy([repoName, ...parts].join("-"));
  return `${clean || "lora"}.safetensors`;
}

/** A file's download link, pinned to the commit it was read at. */
export function loraUrl(repo: string, revision: string | undefined, filePath: string) {
  return `https://huggingface.co/${repo}/resolve/${revision ?? "main"}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Trigger words that are words, not a pattern to fill in ("<sks> {azimuth} view"): those go in the prompt by hand. */
export const autoTrigger = (trigger: string | undefined) => (trigger && !/[{}]/.test(trigger) ? trigger.trim() : undefined);

/** The stricter of two licences: a LoRA can't be freer than the model it's made for. */
export function stricter(a: LoraEntry["licence"]["commercial"], b: LoraEntry["licence"]["commercial"]) {
  const order = ["yes", "limited", "no"] as const;
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

/** LoRAs only patch a model Crackio runs with a model loader: picture and clip makers, not upscalers or swap recipes. */
export const takesLoras = (m: LocalModel) => !m.tasks.every((t) => t === "upscale") && !m.tasks.includes("swap");
