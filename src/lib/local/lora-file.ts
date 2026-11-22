/**
 * What a LoRA file says about itself, read from its safetensors header alone (tensor names and shapes, never the weights):
 * whether it's a LoRA at all, how its layers are named (ComfyUI's, kohya's or diffusers' way), its rank, the notes its
 * trainer left (a name, trigger words, the model it was trained on), and the layers it changes, written the same way for
 * every naming (`single_blocks_#_q_proj:3072x3072`) so two files can be compared. Used for LoRAs you upload from your
 * computer (server/lora-home): Crackio can't ask Hugging Face what those are for. Client-safe, no imports: the script
 * that makes lora-shapes.json (scripts/loras/shapes.mjs) loads it in plain Node.
 */

/** A safetensors header as parsed JSON: each tensor's shape, and `__metadata__` (strings). */
export type LoraHeader = Record<string, unknown>;

export type LoraNaming = "comfy" | "kohya" | "diffusers" | "other";

export type LoraLook = {
  /** Layers of the picture (or clip) model it changes, and of the text encoder. None of either: not a LoRA. */
  layers: number;
  textLayers: number;
  /** Its size (the smaller side of its pairs), when it's the plain kind. */
  rank: number | null;
  /** How most of its layers are named, and how many are named each way. */
  naming: LoraNaming;
  namings: Record<LoraNaming, number>;
  /** LoHa, LoKr and the like: ComfyUI loads them, Crackio can't compare their shapes. */
  lycoris: boolean;
  /** Its layers, written the same way whatever the naming, with what goes in and out of each. */
  vocab: string[];
  /** How far into each run of blocks it reaches: the highest block number it changes (`single_blocks: 27`). */
  depth: Record<string, number>;
  /** From its trainer's notes. */
  name?: string;
  trigger?: string;
  base?: string;
  /** Crackio's own trainer's family (lib/train/profiles), when it made the file. */
  family?: string;
};

const MARK = /^(.+?)\.(lora_(?:down|up|mid|A|B)|lora\.(?:down|up)|lokr_\w+|hada_\w+|oft_\w+|alpha|dora_scale|diff|diff_b|w_norm|b_norm|rescale|on_input|scale)(?:\.default)?(?:\.weight)?$/;
const TEXT = /^(?:lora_te\d*_|text_encoders?[._]|lora_prior_te_|clip_[lg][._]|t5xxl[._]|te\d*[._])/i;
const PREFIX = /^(?:model\.)?(?:base_model\.model\.)?(diffusion_model\.|transformer\.|unet\.|lora_unet_|lora_transformer_|lycoris_)?/;
const NAMING: Record<string, LoraNaming> = { "diffusion_model.": "comfy", lora_unet_: "kohya", lora_transformer_: "kohya", lycoris_: "kohya", "transformer.": "diffusers", "unet.": "diffusers" };
/** Parts of a layer that carry no weights of their own. */
const SMALL = new Set(["alpha", "dora_scale", "scale", "rescale", "on_input"]);

const first = (meta: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.trim() && v.trim().length <= 200 && v.trim().toLowerCase() !== "none") return v.trim();
  }
  return undefined;
};

/** Read a LoRA's header. `layers + textLayers === 0` means the file isn't one. */
export function lookAtLora(header: LoraHeader): LoraLook {
  const layers = new Map<string, { down?: number[]; up?: number[]; other: boolean }>();
  for (const [key, value] of Object.entries(header)) {
    if (key === "__metadata__") continue;
    const m = MARK.exec(key);
    if (!m) continue;
    const [, name, part] = m;
    const shape = Array.isArray((value as { shape?: unknown })?.shape) ? (value as { shape: number[] }).shape : undefined;
    const l = layers.get(name) ?? { other: false };
    if (part === "lora_down" || part === "lora_A" || part === "lora.down") l.down = shape;
    else if (part === "lora_up" || part === "lora_B" || part === "lora.up") l.up = shape;
    else if (!SMALL.has(part)) l.other = true;
    layers.set(name, l);
  }
  const namings: Record<LoraNaming, number> = { comfy: 0, kohya: 0, diffusers: 0, other: 0 };
  const vocab = new Set<string>();
  const depth: Record<string, number> = {};
  const ranks = new Map<number, number>();
  let model = 0;
  let text = 0;
  let lycoris = false;
  for (const [name, l] of layers) {
    // A lone alpha is no layer.
    if (!l.down && !l.up && !l.other) continue;
    if (TEXT.test(name)) {
      text++;
      continue;
    }
    model++;
    if (l.other && !l.down) lycoris = true;
    const found = PREFIX.exec(name);
    namings[NAMING[found?.[1] ?? ""] ?? "other"]++;
    const rest = name.slice(found?.[0].length ?? 0).replace(/\./g, "_");
    vocab.add(`${rest.replace(/\d+/g, "#")}:${l.down?.[1] ?? "?"}x${l.up?.[0] ?? "?"}`);
    const block = /^([A-Za-z_]+?)_(\d+)(?:_|$)/.exec(rest);
    if (block) depth[block[1]] = Math.max(depth[block[1]] ?? 0, Number(block[2]));
    const rank = l.down?.[0];
    if (rank) ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
  }
  const naming = (Object.entries(namings) as [LoraNaming, number][]).sort((a, b) => b[1] - a[1])[0][0];
  const meta = (header.__metadata__ && typeof header.__metadata__ === "object" ? header.__metadata__ : {}) as Record<string, unknown>;
  const name = first(meta, ["crackio.name", "modelspec.title", "ss_output_name", "name"]);
  const trigger = first(meta, ["crackio.trigger", "modelspec.trigger_phrase", "trigger_word", "trigger_words", "ss_trigger_words", "trigger"]);
  const base = first(meta, ["crackio.base", "modelspec.architecture", "ss_base_model_version", "ss_sd_model_name", "base_model"]);
  const family = first(meta, ["crackio.family"]);
  return {
    layers: model,
    textLayers: text,
    rank: [...ranks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    naming,
    namings,
    lycoris,
    vocab: [...vocab].sort(),
    depth,
    ...(name ? { name } : {}),
    ...(trigger ? { trigger } : {}),
    ...(base ? { base } : {}),
    ...(family ? { family } : {}),
  };
}

/**
 * Each model's LoRA layers as real LoRAs made for it name them, and how deep they reach (lora-shapes.json: read from the
 * headers of Crackio's picks by scripts/loras/shapes.mjs).
 */
export type LoraShapes = { made: string; models: Record<string, string[]>; depth: Record<string, Record<string, number>> };

export type LoraFit = {
  /** "fits": its layers are this model's. "other": they're another model's, not this one's. "unknown": can't tell. */
  verdict: "fits" | "other" | "unknown";
  /** The share of its layers this model has. */
  share: number;
  /** When "other": the models whose layers they are, best first. */
  better: string[];
};

const overlap = (a: string[], b: string[]) => {
  const set = new Set(a);
  return b.filter((v) => set.has(v)).length / Math.max(1, Math.min(a.length, b.length));
};

/**
 * Whether a LoRA's layers are a model's. Models with the same layers count as one family (FLUX.1 dev, Krea and schnell;
 * the Qwen-Image line): a LoRA for one is no stranger to the others. A LoRA that reaches into blocks the model doesn't
 * have isn't its own, whatever the names say (Qwen-Image's 60 blocks are named like FLUX.1's 19 in diffusers files).
 * Careful on purpose: "other" only when nearly all of the file's layers are another family's and at most half are this
 * one's, and "unknown" for a model no LoRA was read for.
 */
export function fitOf(look: Pick<LoraLook, "vocab" | "depth">, shapes: LoraShapes, modelId: string): LoraFit {
  const own = shapes.models[modelId];
  if (!look.vocab.length || !own?.length) return { verdict: "unknown", share: 0, better: [] };
  const family = Object.keys(shapes.models).filter((id) => id === modelId || overlap(own, shapes.models[id]) >= 0.9);
  const share = (ids: string[]) => {
    const set = new Set(ids.flatMap((id) => shapes.models[id]));
    // Deeper than any of them goes: not theirs.
    const deeper = Object.entries(look.depth).some(([block, reach]) => {
      const known = ids.map((id) => shapes.depth[id]?.[block]).filter((n): n is number => n !== undefined);
      return known.length > 0 && reach > Math.max(...known);
    });
    return deeper ? 0 : look.vocab.filter((v) => set.has(v)).length / look.vocab.length;
  };
  const mine = share(family);
  if (mine >= 0.6) return { verdict: "fits", share: mine, better: [] };
  const others = Object.keys(shapes.models)
    .filter((id) => !family.includes(id))
    .map((id) => ({ id, share: share([id]) }))
    .filter((o) => o.share >= 0.9)
    .sort((a, b) => b.share - a.share);
  if (mine <= 0.5 && others.length) return { verdict: "other", share: mine, better: others.map((o) => o.id) };
  return { verdict: "unknown", share: mine, better: [] };
}
