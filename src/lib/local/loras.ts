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
  /** An example picture from its repo. */
  preview?: string;
  author: string;
  note?: string;
  /** Found by a Hugging Face search: not one of Crackio's checked picks. */
  found?: boolean;
  /** When Crackio ran it on a GPU, with and without it on the same seed, and it did what it promises. */
  tested?: string;
  /** The file names it has (or will have) in models/loras, one per file. */
  local?: string[];
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
  licence: LoraEntry["licence"];
  bytes: number;
  found?: boolean;
};

/** What `/api/local/loras/library` answers. */
export type LoraLibrary = {
  entries: LoraEntry[];
  /** Hugging Face base repos whose LoRAs fit each model (`LocalModel.id`), for a search of its own. */
  bases: Record<string, string[]>;
  /** Every LoRA file Crackio downloaded, by its file name. */
  records: Record<string, LoraRecord>;
};

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
