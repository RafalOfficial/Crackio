import type { LocalFile } from "@/lib/local/types";
import type { TrainGoal } from "./types";

/**
 * What Crackio knows about training each model family: which weights to train on (the family's undistilled base where
 * its makers publish one: a LoRA trained there runs on the fast model), how ComfyUI loads them, the makers' own recipe
 * where there is one, and what a step costs. Client-safe.
 *
 * Sources (Nov 2026; .research/lora-training-2026-11-14): Black Forest Labs' FLUX 3 Klein and FLUX.2 klein fine-tuning
 * guides, ostris/ai-toolkit's per-model defaults, kohya musubi-tuner's docs, Civitai's trainer defaults. Times are per
 * step at 1 megapixel on an RTX 5090, one picture a step, memory saved by redoing blocks (gradient checkpointing); a
 * run on your own card replaces them (server/train/speeds).
 */

const hf = (repo: string, path: string) => `https://huggingface.co/${repo}/resolve/main/${path}`;
const file = (role: string, folder: LocalFile["folder"], name: string, repo: string, path: string, bytes: number, sha256?: string): LocalFile => ({ role, folder, name, url: hf(repo, path), bytes, sha256 });

/** A set of weights a family can be trained on. */
export type TrainWeights = {
  id: string;
  /** "Full precision", "INT8". */
  label: string;
  /** Its file: one of the catalog's by name (looked up on the server), or a file of the trainer's own. */
  name: string;
  file?: LocalFile;
  /** GPU memory a run needs at 1 MP with everything on the card, in GB. */
  needGb: number;
  /** GPU memory it runs in with most of the model streamed from RAM (slower), in GB. */
  streamGb: number;
  quantized?: boolean;
  /** NVIDIA only (ComfyUI's INT8 kernels). */
  nvidia?: boolean;
  /** What a step costs next to the family's `seconds5090` (a quantized model's backward pass unpacks its weights). */
  cost?: number;
};

export type TrainProfile = {
  id: string;
  name: string;
  maker: string;
  /** One line: why you'd train this one. */
  blurb: string;
  /** How ComfyUI loads it: a model file with its text encoder and VAE, or one checkpoint that holds all three. */
  loader: { kind: "parts"; clipType: string; text: string[]; vae: string[]; dual?: { name: string[]; type: string } } | { kind: "checkpoint" };
  /** Best first: the first that fits the machine is trained on. */
  weights: TrainWeights[];
  /** Catalog models (`LocalModel.id`) the LoRA works on: it's listed under each, and the first one installed draws the test pictures. */
  uses: string[];
  /** ComfyUI's names for this architecture (bridge `inspect`: the model config's class), to recognise your own files. */
  architectures: string[];
  /** Picture sides are multiples of this many pixels. */
  grid: number;
  /** Flow matching (velocity), or the older noise prediction. */
  flow: boolean;
  /** How noise levels are drawn: "shift" (any level alike, then the model's own time shift), "sigmoid" (round the middle). */
  timestep: "shift" | "sigmoid" | "uniform";
  /** Guidance the model is told while training, for models that take it as an input (FLUX.1 dev: 1). */
  guidance?: number;
  lr: number;
  rank: number;
  /** The longest side to train at by default, and the most that makes sense. */
  resolution: number;
  maxResolution: number;
  /** Seconds a step at 1 MP on an RTX 5090. */
  seconds5090: number;
  /** How strong to run the LoRA on the fast model (BFL: 0.75 for FLUX 3 Klein; 1 elsewhere). */
  strength: number;
  /** Steps next to the usual budget for a set this size (a family that overfits sooner gets fewer). */
  stepScale?: number;
  /** When Crackio trained it end to end on a GPU and looked at the result. */
  tested?: string;
  /** Kept off the Train page, and why: it runs, but what it makes isn't right yet. */
  hold?: string;
  /** Something to know before training it. */
  note?: string;
  /** The oldest helper (Crackio bridge) that can train it: a machine with an older one is updated before the run. */
  helper?: string;
  /**
   * The model takes a picture to change beside the prompt, so before/after pairs can teach it an edit. How it takes
   * that picture: "reference" (encoded by the VAE, beside the picture being made) or "vision" (its text encoder looks
   * at it with the words as well) or "qwen-edit" (the Qwen-Image-Edit models' own way: a small copy for the text
   * encoder under their system prompt).
   */
  edit?: "reference" | "vision" | "qwen-edit";
  /** An edit model: it only learns from before and after pairs (it isn't offered for a person, a thing or a look). */
  editOnly?: boolean;
  licence: { name: string; commercial: "yes" | "limited" | "no"; note?: string };
  /** Its weights' Hugging Face repo makes you accept terms first. */
  gated?: string;
};

const KLEIN_REPO = "black-forest-labs/flux-3-image-klein-comfy";
const QWEN21_REPO = "Comfy-Org/Qwen-Image-2.1";
const QWEN_REPO = "Comfy-Org/Qwen-Image_ComfyUI";
const KREA_REPO = "Comfy-Org/Krea-2";

export const TRAIN_PROFILES: TrainProfile[] = [
  {
    id: "flux3-klein",
    name: "FLUX 3 Klein",
    maker: "Black Forest Labs",
    blurb: "Crackio's main picture model. Its makers publish the Base weights for training: a LoRA trained there runs on the fast model you generate with.",
    loader: { kind: "parts", clipType: "flux3", text: ["qwen3vl_4b_int8_convrot.safetensors", "qwen3vl_4b_bf16.safetensors"], vae: ["flux2-vae.safetensors"] },
    weights: [
      {
        id: "bf16",
        label: "Full precision",
        name: "flux3-image-klein-base-bf16.safetensors",
        file: file("model", "diffusion_models", "flux3-image-klein-base-bf16.safetensors", KLEIN_REPO, "diffusion_models/flux3-image-klein-base-bf16.safetensors", 11_076_957_072, "5c921759dc03663dbb67df11d8e3d317d2d5b893b31b969c95dc77ebf861b19c"),
        needGb: 16.5,
        streamGb: 9,
      },
      {
        id: "int8",
        label: "INT8",
        name: "flux3-image-klein-base-int8-convrot.safetensors",
        file: file("model", "diffusion_models", "flux3-image-klein-base-int8-convrot.safetensors", KLEIN_REPO, "diffusion_models/flux3-image-klein-base-int8-convrot.safetensors", 5_807_427_339, "8949ecfc1bf3871b08be02cf43ec7276a4914e1a86eade6b5eb8f4204426bc92"),
        // Measured on the same RTX 4090: 1.2 s a step, 9 GB in use. Lighter and quicker than full precision; whether its
        // LoRAs are as good hasn't been compared yet, so full precision stays first where it fits.
        needGb: 10.5,
        streamGb: 7,
        quantized: true,
        nvidia: true,
        cost: 0.8,
      },
    ],
    uses: ["flux3-klein"],
    architectures: ["Flux3"],
    edit: "reference",
    grid: 32,
    flow: true,
    timestep: "shift",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1536,
    // Measured on a rented RTX 4090 (Nov 2026): 1.5 s a step at 1 MP on the full-precision Base, 16 GB in use.
    seconds5090: 1.0,
    strength: 0.75,
    tested: "2026-11-14",
    licence: { name: "FLUX Kommunity", commercial: "limited", note: "Free commercial use under $5M yearly revenue." },
    gated: KLEIN_REPO,
  },
  {
    id: "qwen-image-2.1",
    name: "Qwen-Image 2.1",
    // 2026-11-15, RTX 3090: a 20-picture look trained for 1,200 steps (89 minutes) took over both test pictures from
    // step 800, where the same set on FLUX 3 Klein left the close-up a photo. On the way there the faces break for a
    // while (around step 600 of that run): the versions saved along the way show when it has settled.
    tested: "2026-11-15",
    maker: "Alibaba Qwen",
    blurb: "The most used picture model in ComfyUI: strong at people, text and following a long prompt. Trained on the full model; the LoRA also runs on Qwen-Image 2.1 Turbo.",
    loader: { kind: "parts", clipType: "qwen_image", text: ["qwen3vl_8b_int8_convrot.safetensors", "qwen3vl_8b_bf16.safetensors"], vae: ["qwen_image_2.1_vae_bf16.safetensors"] },
    weights: [
      {
        id: "bf16",
        label: "Full precision",
        name: "qwen_image_2.1_bf16.safetensors",
        file: file("model", "diffusion_models", "qwen_image_2.1_bf16.safetensors", QWEN21_REPO, "diffusion_models/qwen_image_2.1_bf16.safetensors", 14_230_280_616, "89f4158d066cc33906a199fca85634f766892dd78f49b6698dabf187ac86c4bc"),
        // Measured on a rented RTX 3090 (Nov 2026): 4.1 s a step at 1024 px, 18.2 GB in use; streamed from RAM at
        // 768 px it ran in 5.2 GB at 3.6 s a step.
        needGb: 20,
        streamGb: 8,
      },
      // Measured on the same RTX 3090: 3.1 s a step at 1024 px in 11.6 GB; every layer of its LoRA loads.
      { id: "int8", label: "INT8", name: "qwen_image_2.1_int8_convrot.safetensors", needGb: 13, streamGb: 7, quantized: true, nvidia: true, cost: 0.75 },
    ],
    uses: ["tpl-qwen-image-2.1"],
    architectures: ["QwenImage21"],
    edit: "vision",
    // Its training form (train_patches.py) and the plain loading it needs came with this helper.
    helper: "1.13.2",
    grid: 32,
    flow: true,
    timestep: "shift",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1536,
    seconds5090: 1.45,
    strength: 1,
    licence: { name: "Qwen Research", commercial: "no", note: "Research and non-commercial use only, and a LoRA trained on it carries the same limit: don't sell it or what it makes." },
  },
  {
    id: "qwen-image-2512",
    name: "Qwen-Image 2512",
    // 2026-11-16, RTX 3090 (24 GB): on its FP8 weights with the model streamed from RAM, 300 steps of a 20-picture
    // look at 1024 px ran at 6.7 s a step in 7.7 GB, and both test pictures were in the look by the end (a 590 MB
    // LoRA: it has 840 layers). Whole on a card of 32 GB and up, and on its full-precision weights, it hasn't run.
    tested: "2026-11-16",
    maker: "Alibaba Qwen",
    blurb: "The December 2025 Qwen-Image: a 20B model with a free licence, good at text in pictures and realistic people. Big: it trains whole on 32 GB cards and up, streamed from RAM on 24 GB.",
    loader: { kind: "parts", clipType: "qwen_image", text: ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen_2.5_vl_7b.safetensors"], vae: ["qwen_image_vae.safetensors"] },
    weights: [
      {
        id: "bf16",
        label: "Full precision",
        name: "qwen_image_2512_bf16.safetensors",
        file: file("model", "diffusion_models", "qwen_image_2512_bf16.safetensors", QWEN_REPO, "split_files/diffusion_models/qwen_image_2512_bf16.safetensors", 40_861_031_488, "cbf55390fff27dbc785046d7007b04e0c5dd7421e7ef128f2831eacb53a8e075"),
        needGb: 46,
        streamGb: 12,
      },
      { id: "fp8", label: "FP8", name: "qwen_image_2512_fp8_e4m3fn.safetensors", needGb: 27, streamGb: 11, quantized: true, cost: 1.2 },
    ],
    uses: ["tpl-qwen-image-2512"],
    architectures: ["QwenImage"],
    grid: 32,
    flow: true,
    timestep: "shift",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1328,
    seconds5090: 1.6,
    strength: 1,
    licence: { name: "Apache-2.0", commercial: "yes" },
  },
  {
    id: "qwen-image-edit-2511",
    name: "Qwen-Image-Edit 2511",
    // 2026-11-16, RTX 3090 (24 GB), before/after pairs at 768 px with the model streamed from RAM: on its INT8 weights
    // it trained a dozen steps at a time (8.6 s a step, 11.5 GB) before ComfyUI went down with a CUDA illegal memory
    // access, four times over; on its FP8 ("fp8mixed") weights the gradients weren't numbers at the first step, at any
    // learning rate. Its check before the first step passes on both. Not offered until it has trained through: whole
    // on a card that holds it (32 GB and up, INT8 or FP8) is the next thing to try, then full precision streamed.
    hold: "Doesn't train through on a 24 GB card yet",
    maker: "Alibaba Qwen",
    blurb: "The December 2025 edit model, with a free licence: made to change a picture you give it, so it learns edits from before and after pairs. Big: it trains whole on 32 GB cards and up, streamed from RAM on 24 GB.",
    loader: { kind: "parts", clipType: "qwen_image", text: ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen_2.5_vl_7b.safetensors"], vae: ["qwen_image_vae.safetensors"] },
    weights: [
      { id: "bf16", label: "Full precision", name: "qwen_image_edit_2511_bf16.safetensors", needGb: 46, streamGb: 12 },
      { id: "int8", label: "INT8", name: "qwen_image_edit_2511_int8_convrot.safetensors", needGb: 27, streamGb: 11, quantized: true, nvidia: true, cost: 0.9 },
      { id: "fp8", label: "FP8", name: "qwen_image_edit_2511_fp8mixed.safetensors", needGb: 27, streamGb: 11, quantized: true, cost: 1.2 },
    ],
    uses: ["tpl-qwen-image-edit-2511"],
    architectures: ["QwenImageEdit"],
    edit: "qwen-edit",
    editOnly: true,
    helper: "1.14.0",
    grid: 32,
    flow: true,
    timestep: "shift",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1328,
    seconds5090: 3.0,
    strength: 1,
    licence: { name: "Apache-2.0", commercial: "yes" },
  },
  {
    id: "krea-2",
    name: "Krea 2",
    // 2026-11-16, RTX 3090: on its INT8 Raw weights, 800 steps of a 20-picture look at 1024 px ran at 4.6 s a step in
    // 18 GB. Like FLUX 3 Klein it takes the look in scenes and leaves a close-up face photographic.
    tested: "2026-11-16",
    maker: "Krea",
    blurb: "A 13B model made for looks: photo styles, film, illustration. Trained on its undistilled weights (Krea 2 Raw); the LoRA also runs on Krea 2 Turbo.",
    loader: { kind: "parts", clipType: "krea2", text: ["qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_bf16.safetensors"], vae: ["qwen_image_vae.safetensors"] },
    weights: [
      {
        id: "bf16",
        label: "Full precision",
        name: "krea2_raw_bf16.safetensors",
        file: file("model", "diffusion_models", "krea2_raw_bf16.safetensors", KREA_REPO, "diffusion_models/krea2_raw_bf16.safetensors", 26_283_332_608, "f99bb0ff8e362b77342bc4994e0c50906fe7ef7074864b181b7d48d2fa6d03d7"),
        needGb: 32,
        streamGb: 11,
      },
      {
        id: "int8",
        label: "INT8",
        name: "krea2_raw_int8_convrot.safetensors",
        file: file("model", "diffusion_models", "krea2_raw_int8_convrot.safetensors", KREA_REPO, "diffusion_models/krea2_raw_int8_convrot.safetensors", 13_492_686_496, "5585a4a38c4bcfb6fde2d480a4aa6edf7f665721ebde56d30662c35a45f5fa5c"),
        needGb: 19,
        streamGb: 9,
        quantized: true,
        nvidia: true,
        cost: 0.9,
      },
      {
        id: "fp8",
        label: "FP8",
        name: "krea2_raw_fp8_scaled.safetensors",
        file: file("model", "diffusion_models", "krea2_raw_fp8_scaled.safetensors", KREA_REPO, "diffusion_models/krea2_raw_fp8_scaled.safetensors", 13_141_730_784, "48cd5d6c100297968349b41a8e77c6591d1dac18a215807f5f25f59e5c54cd61"),
        needGb: 19,
        streamGb: 9,
        quantized: true,
        cost: 1.2,
      },
    ],
    uses: ["tpl-krea-2"],
    architectures: ["Krea2"],
    grid: 32,
    flow: true,
    timestep: "shift",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1536,
    seconds5090: 1.85,
    strength: 1,
    licence: { name: "Krea 2 Community", commercial: "limited", note: "Free commercial use below US$1M in yearly revenue." },
  },
  {
    id: "flux2-klein-4b",
    name: "FLUX.2 klein 4B",
    // 2026-11-15, RTX 3090: at a rate of 1e-4, 500 steps on 28 pictures changed nothing in the test pictures (FLUX 3
    // Klein shows the same look by step 150). Overfitting one picture for 150 steps took the loss from 0.52 to 0.49 at
    // 1e-4 and to 0.27 at 5e-4 (a shifted noise schedule didn't help), so the rate below is 5e-4 (a style runs at 4e-4).
    // At that rate the same 28 pictures showed their look in the test pictures at step 300 (2.4 s a step, 10.9 GB), all
    // 80 layers loading. It comes late and all at once (steps 100 and 200 still look like the model alone).
    tested: "2026-11-15",
    maker: "Black Forest Labs",
    blurb: "Small and freely licensed (Apache-2.0): trains on 12 GB cards and its LoRAs can be sold.",
    loader: { kind: "parts", clipType: "flux2", text: ["qwen_3_4b.safetensors", "qwen_3_4b_fp4_flux2.safetensors"], vae: ["flux2-vae.safetensors"] },
    weights: [
      { id: "bf16", label: "Full precision", name: "flux-2-klein-base-4b.safetensors", needGb: 13, streamGb: 7 },
      { id: "fp8", label: "FP8", name: "flux-2-klein-base-4b-fp8.safetensors", needGb: 10, streamGb: 7, quantized: true, cost: 1.2 },
    ],
    uses: ["flux2-klein-4b", "flux2-klein-base-4b-360"],
    architectures: ["Flux2"],
    grid: 32,
    flow: true,
    timestep: "sigmoid",
    lr: 5e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1536,
    seconds5090: 0.9,
    strength: 1,
    licence: { name: "Apache-2.0", commercial: "yes" },
  },
  {
    id: "z-image",
    name: "Z-Image",
    tested: "2026-11-15",
    maker: "Tongyi-MAI",
    blurb: "A 6B model with a free licence and sharp photos. Trained on the base model; the LoRA also runs on Z-Image Turbo.",
    loader: { kind: "parts", clipType: "lumina2", text: ["qwen_3_4b.safetensors", "qwen_3_4b_fp4_mixed.safetensors"], vae: ["ae.safetensors"] },
    weights: [
      { id: "bf16", label: "Full precision", name: "z_image_bf16.safetensors", needGb: 18, streamGb: 9 },
      { id: "int8", label: "INT8", name: "z_image_int8_convrot.safetensors", needGb: 12, streamGb: 8, quantized: true, nvidia: true, cost: 1.25 },
    ],
    uses: ["tpl-z-image", "z-image-turbo"],
    architectures: ["ZImage", "Lumina2"],
    grid: 32,
    flow: true,
    timestep: "sigmoid",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1536,
    seconds5090: 1.3,
    strength: 1,
    licence: { name: "Apache-2.0", commercial: "yes" },
  },
  {
    id: "sdxl",
    name: "SDXL",
    tested: "2026-11-15",
    maker: "Stability AI",
    blurb: "The classic, with thousands of community checkpoints. Trains on 8 GB cards.",
    loader: { kind: "checkpoint" },
    weights: [{ id: "checkpoint", label: "Checkpoint", name: "sd_xl_base_1.0.safetensors", needGb: 9, streamGb: 6 }],
    uses: ["tpl-sdxl"],
    architectures: ["SDXL"],
    grid: 64,
    flow: false,
    timestep: "uniform",
    lr: 1e-4,
    rank: 32,
    resolution: 1024,
    maxResolution: 1024,
    seconds5090: 0.5,
    strength: 1,
    licence: { name: "OpenRAIL++-M", commercial: "yes" },
  },
  {
    id: "sd15",
    name: "Stable Diffusion 1.5",
    maker: "Stability AI",
    blurb: "Tiny and quick: trains on almost any GPU, at 512 px.",
    loader: { kind: "checkpoint" },
    weights: [{ id: "checkpoint", label: "Checkpoint", name: "v1-5-pruned-emaonly-fp16.safetensors", file: file("model", "checkpoints", "v1-5-pruned-emaonly-fp16.safetensors", "Comfy-Org/stable-diffusion-v1-5-archive", "v1-5-pruned-emaonly-fp16.safetensors", 2_132_696_762), needGb: 4.5, streamGb: 3 }],
    uses: [],
    architectures: ["SD15"],
    grid: 64,
    flow: false,
    timestep: "uniform",
    lr: 1e-4,
    rank: 16,
    resolution: 512,
    maxResolution: 768,
    seconds5090: 0.1,
    strength: 1,
    licence: { name: "CreativeML OpenRAIL-M", commercial: "yes" },
  },
];

export const profileById = (id: string | null | undefined) => TRAIN_PROFILES.find((p) => p.id === id) ?? null;

/** The profile a model file of your own trains with, from what ComfyUI says its architecture is. */
export const profileForArchitecture = (architecture: string | null | undefined) => (architecture ? (TRAIN_PROFILES.find((p) => p.architectures.includes(architecture)) ?? null) : null);

/** How many pictures a goal needs: fewer than `least` can't work, fewer than `few` is thin, `ideal` is where it's good. */
export const GOAL_IMAGES: Record<TrainGoal, { least: number; few: number; ideal: [number, number] }> = {
  person: { least: 5, few: 12, ideal: [20, 40] },
  character: { least: 5, few: 12, ideal: [20, 40] },
  object: { least: 5, few: 12, ideal: [15, 40] },
  style: { least: 8, few: 15, ideal: [20, 60] },
  // Pairs. An edit that's the same everywhere (a look, a relight) is learned from few; one that depends on what's in
  // the picture needs more.
  edit: { least: 5, few: 10, ideal: [20, 50] },
};

/**
 * Steps for a set of this size, at one picture a step: [pictures, steps], read between the rows. Sets grow faster than
 * the steps they need: about 100 looks at each picture for 10, about 25 for 200 (BFL's 65-picture FLUX 3 run was best at
 * 2,000 steps; its 27-picture klein run at 1,500).
 */
export const STEP_TABLE: Record<TrainGoal, [number, number][]> = {
  person: [[5, 1000], [10, 1200], [20, 2000], [40, 2800], [80, 3500], [150, 4200], [200, 4500], [300, 5000]],
  character: [[5, 1000], [10, 1200], [20, 2000], [40, 2800], [80, 3500], [150, 4200], [200, 4500], [300, 5000]],
  object: [[5, 1000], [10, 1200], [20, 2000], [40, 2800], [80, 3500], [150, 4200], [200, 4500], [300, 5000]],
  style: [[8, 1000], [10, 1200], [20, 1500], [40, 2000], [80, 2500], [150, 3200], [200, 3500], [300, 4000]],
  edit: [[5, 800], [10, 1000], [20, 1500], [40, 2000], [80, 2500], [150, 3200], [200, 3500], [300, 4000]],
};
