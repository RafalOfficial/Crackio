import type { LocalFile, LocalModel } from "./types";

/**
 * Open-weights models the Local page offers, with the exact files each precision needs (Hugging Face links and
 * sizes in bytes, checked Oct 2026). Variants are listed best first; a recipe runs the first one whose files are
 * all installed. Times are for one RTX 5090: `measured` ones were run there through Crackio's own recipes, the
 * rest come from published runs or format ratios (int8_convrot ≈ 1.9× bf16 speed on RTX 40/50, fp8 ≈ 1.3×).
 *
 * Formats: int8_convrot and fp8 need NVIDIA (Apple's MPS can't run either); bf16 runs everywhere, Macs included;
 * nvfp4 is fast only on RTX 50 (compute 12.0).
 */

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
const file = (role: string, folder: LocalFile["folder"], name: string, repo: string, path: string, bytes: number, sha256?: string): LocalFile => ({
  role,
  folder,
  name,
  url: hf(repo, path),
  bytes,
  sha256,
});

const NVIDIA = { backends: ["cuda" as const], compute: 7.5 };
/** FlashVSR+ computes in bf16 through its custom node (the Crackio bridge installs it): RTX 30 and newer. */
const FLASHVSR = { backends: ["cuda" as const], compute: 8.0, customNodes: ["ComfyUI_FlashVSR"] };
/** Its small decoder and its prompt embedding (the embedding from the official repo, pinned). */
const FLASHVSR_DECODER = file("decoder", "FlashVSR", "TCDecoder_plus.ckpt", "ruchangyao/FlashVSR_plus", "TCDecoder.ckpt", 189_018_333, "e224bdcf2f52745cbf4d393ff5374c2ba09e90285d5d19062d2bf63b915b6161");
const FLASHVSR_PROMPT: LocalFile = {
  role: "prompt",
  folder: "FlashVSR",
  name: "posi_prompt_plus.pth",
  url: "https://github.com/OpenImagingLab/FlashVSR_Plus/raw/b548a2cc2c929d3d4676f2973abe27876ec4dee7/prompt_tensor/posi_prompt.pth",
  bytes: 4_195_504,
  sha256: "4601107a11e4e11a936a6b79df579e54dbc99872132bf542151f0ffd65b4b1ef",
};
const FP8 = { backends: ["cuda" as const, "rocm" as const, "xpu" as const] };
const RTX50 = { backends: ["cuda" as const], compute: 12.0 };
/** GGUF quants run anywhere ComfyUI does (Macs, older NVIDIA cards), through city96's ComfyUI-GGUF loaders. */
const GGUF = { customNodes: ["ComfyUI-GGUF"] };

/* ------------------------------------------------------------------ shared files */

const QWEN3_4B = file("text", "text_encoders", "qwen_3_4b.safetensors", "Comfy-Org/z_image_turbo", "split_files/text_encoders/qwen_3_4b.safetensors", 8_044_982_048, "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a");
const QWEN3_4B_Q5 = file("text", "text_encoders", "Qwen3-4B-Q5_K_M.gguf", "unsloth/Qwen3-4B-GGUF", "Qwen3-4B-Q5_K_M.gguf", 2_889_514_272, "37edbd37f5b7a4d4e7a766400c57def1f790e809de03513b86bf11bb06979695");
const QWEN3_4B_Q4 = file("text", "text_encoders", "Qwen3-4B-Q4_K_M.gguf", "unsloth/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf", 2_497_281_312, "f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a");
const FLUX2_VAE = file("vae", "vae", "flux2-vae.safetensors", "Comfy-Org/flux2-dev", "split_files/vae/flux2-vae.safetensors", 336_213_556, "d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5");
const UMT5_FP8 = file("text", "text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", 6_735_906_897, "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68");
const UMT5_FP16 = file("text", "text_encoders", "umt5_xxl_fp16.safetensors", "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/text_encoders/umt5_xxl_fp16.safetensors", 11_366_399_385, "7b8850f1961e1cf8a77cca4c964a358d303f490833c6c087d0cff4b2f99db2af");
const WAN21_VAE = file("vae", "vae", "Wan2_1_VAE_bf16.safetensors", "Kijai/WanVideo_comfy", "Wan2_1_VAE_bf16.safetensors", 253_806_278);
const WAN22_VAE = file("vae", "vae", "wan2.2_vae.safetensors", "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/vae/wan2.2_vae.safetensors", 1_409_400_960, "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156");
const WAN22_5B_FP16 = file("model", "diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors", "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", 9_999_658_848, "456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e");
/** FastVideo's few-step distill of the 5B as a LoRA (Apache-2.0): 3 steps at CFG 1 in place of 20 at CFG 5. */
const FASTWAN_5B = file("lora", "loras", "Wan2_2_5B_FastWanFullAttn_lora_rank_128_bf16.safetensors", "Kijai/WanVideo_comfy", "FastWan/Wan2_2_5B_FastWanFullAttn_lora_rank_128_bf16.safetensors", 660_874_456, "79290493711b022e1c6e655d803715cd8a91a75cdb139856cad46f354e2f681c");
/** LightX2V's tiny Wan 2.2 decoder (core VAELoader, models/vae_approx): 0.4 GB to decode a clip where the full VAE takes 12. */
const LIGHTTAE_W22 = file("tiny", "vae_approx", "lighttaew2_2.safetensors", "lightx2v/Autoencoders", "lighttaew2_2.safetensors", 45_684_280, "10124099e0c9864db4e6bcd0f09d822282753e553d344fcf2748cf50140ba16a");
const UMT5_Q5 = file("text", "text_encoders", "umt5-xxl-encoder-Q5_K_M.gguf", "city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q5_K_M.gguf", 4_145_878_880, "eaea358bb438c5d211721a4feecc162000e3636e9cb96f51e216f1f44ebd12ce");
const UMT5_Q8 = file("text", "text_encoders", "umt5-xxl-encoder-Q8_0.gguf", "city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q8_0.gguf", 6_043_068_256, "2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc");
const wan5bGguf = (quant: string, bytes: number, sha256: string) =>
  file("model", "diffusion_models", `Wan2.2-TI2V-5B-${quant}.gguf`, "QuantStack/Wan2.2-TI2V-5B-GGUF", `Wan2.2-TI2V-5B-${quant}.gguf`, bytes, sha256);
const CLIP_VISION_H = file("vision", "clip_vision", "clip_vision_h.safetensors", "Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/clip_vision/clip_vision_h.safetensors", 1_264_219_396);
const SAM31 = file("sam", "checkpoints", "sam3.1_multiplex_fp16.safetensors", "Comfy-Org/sam3.1", "checkpoints/sam3.1_multiplex_fp16.safetensors", 1_745_546_848);

const LTX_VAES = [
  file("vae", "vae", "ltx-2.5-video-vae-bf16.safetensors", "Lightricks/LTX-2.5", "vae/ltx-2.5-video-vae-bf16.safetensors", 1_472_223_346),
  file("audio", "vae", "ltx-2.5-audio-vae-bf16.safetensors", "Lightricks/LTX-2.5", "vae/ltx-2.5-audio-vae-bf16.safetensors", 364_866_540),
];
const LTX_REST = [
  ...LTX_VAES,
  file("upscaler", "latent_upscale_models", "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", "Lightricks/LTX-2.5", "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", 995_778_752),
];
const LTX_INT8 = file("model", "diffusion_models", "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "Lightricks/LTX-2.5", "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", 21_504_034_224);
const LTX_NVFP4 = file("model", "diffusion_models", "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors", "Lightricks/LTX-2.5", "diffusion_models/ltx-2.5-22b-distilled-transformer-nvfp4.safetensors", 18_721_548_408);
const LTX_TEXT_INT8 = file("text", "text_encoders", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "Lightricks/LTX-2.5", "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", 15_372_969_374);
const LTX_LICENCE: LocalModel["licence"] = {
  name: "LTX-2 Community",
  url: "https://huggingface.co/Lightricks/LTX-2.5",
  commercial: "limited",
  note: "Free under $10M yearly revenue; label AI output; no products that compete with Lightricks.",
};
/** WepeNerd's first-frame-all-frames IC-LoRA for LTX-2.5 (v1.1, under the LTX-2 licence): an edited first frame carried through a clip. */
const RIPPLE_LORA = file("lora", "loras", "LTX25_Ripple_v11.safetensors", "WepeNerd/LTX-Ripple", "LTX25_Ripple_v11.safetensors", 654_443_392, "bde543610144e5bba78782fb0ac18daa663fc087c2212244b8116deb1925ee2a");

const scailGguf = (quant: string, bytes: number, sha256: string) =>
  file("model", "diffusion_models", `SCAIL-2-${quant}.gguf`, "realrebelai/SCAIL-2_GGUF", `SCAIL-2-${quant}.gguf`, bytes, sha256);
/** Google's FILM, repackaged for ComfyUI's own Frame Interpolate node: on a slow GPU SCAIL-2 makes every 2nd frame and this draws the rest. */
const FILM = file("film", "frame_interpolation", "film_net_fp16.safetensors", "Comfy-Org/Frame-Interpolation", "frame_interpolation/film_net_fp16.safetensors", 68_882_302, "f226e51375dc839d4b40e5c3d63da560dd1ea1c962364ec78f5adf2d05db05c0");
const SCAIL_REST = [
  file("dpo", "loras", "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", "Comfy-Org/SCAIL-2", "loras/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", 1_226_936_552),
  file("turbo", "loras", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "Kijai/WanVideo_comfy", "Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", 738_005_744),
  CLIP_VISION_H,
  WAN21_VAE,
  SAM31,
  FILM,
];

export const LOCAL_MODELS: LocalModel[] = [
  /* ---------------------------------------------------------------- video */
  {
    id: "ltx-2.5",
    name: "LTX-2.5",
    maker: "Lightricks",
    tasks: ["video"],
    blurb: "Words or a start frame to a clip with its own soundtrack, up to 20 s. Second only to MiniMax H3 among open video models in public arenas, and the best of them licensed in the EU, UK and US.",
    quality: 88,
    unit: "clip",
    audio: true,
    licence: LTX_LICENCE,
    gated: { repo: "Lightricks/LTX-2.5" },
    crackio: "local:ltx-2.5",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 24,
        fidelity: 0.99,
        seconds5090: 30,
        steps: 8,
        measured: true,
        requires: NVIDIA,
        files: [LTX_INT8, LTX_TEXT_INT8, ...LTX_REST],
      },
      {
        id: "nvfp4",
        label: "NVFP4",
        needGb: 21,
        fidelity: 0.96,
        seconds5090: 36,
        steps: 8,
        requires: RTX50,
        files: [LTX_NVFP4, LTX_TEXT_INT8, ...LTX_REST],
      },
      {
        id: "bf16",
        label: "BF16",
        needGb: 46,
        fidelity: 1,
        seconds5090: 57,
        steps: 8,
        files: [
          file("model", "diffusion_models", "ltx-2.5-22b-distilled-transformer-bf16.safetensors", "Lightricks/LTX-2.5", "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors", 42_018_190_584),
          file("text", "text_encoders", "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", "Lightricks/LTX-2.5", "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", 26_263_858_182),
          ...LTX_REST,
        ],
      },
      {
        // Unsloth's dynamic 3-bit GGUF (LPIPS 0.31 against bf16, on par with their Q4_K_XL for the distilled model). Its
        // 12 GB fit no small card, so it pools: a 6 GB card and a 16 GB Mac hold it together. The int8 text encoder
        // runs on the computer that has the files (NVIDIA, AMD or Intel; it ran on a GTX 1060).
        id: "gguf-q3",
        label: "GGUF Q3 (pools)",
        needGb: 14,
        // On a 12 GB RTX 4070 a 5 s 720p clip ran out of memory in its sampler (rented box, Oct 2026): alone it needs this.
        minGb: 14,
        fidelity: 0.94,
        seconds5090: 45,
        steps: 8,
        requires: { ...GGUF, backends: ["cuda", "rocm", "xpu"] },
        pool: true,
        files: [
          file("model", "diffusion_models", "ltx-2.5-22b-distilled-UD-Q3_K_XL.gguf", "unsloth/LTX-2.5-GGUF", "distilled/ltx-2.5-22b-distilled-UD-Q3_K_XL.gguf", 12_000_207_232, "252fef358340eba8d8a0427641b56e1d034ad1f4f8c307a507b7b265a0f8ff22"),
          LTX_TEXT_INT8,
          ...LTX_REST,
        ],
      },
    ],
  },
  {
    id: "wan2.2-5b",
    name: "Wan 2.2 5B",
    maker: "Alibaba",
    tasks: ["video"],
    blurb: "The open video model for every GPU: clips from words or a start frame, in 3 steps with FastWan. 6 GB cards and 16 GB Macs run its GGUF versions at 540p; 12 GB cards run it whole at 720p. No sound.",
    quality: 58,
    unit: "clip",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B", commercial: "yes" },
    crackio: "local:wan2.2-5b",
    // Its official ComfyUI template's preview (the model library's card).
    thumb: "video_wan2_2_5B_ti2v",
    // Every version carries FastWan (3 steps at CFG 1) and the tiny decoder; the full VAE still encodes a start frame.
    // RTX 5090 times are estimates for 5 s at 720p, 3 steps (the 20-step template measured 137 s), until a run measures them.
    variants: [
      {
        id: "fp16",
        label: "FP16",
        needGb: 13,
        fidelity: 1,
        // Measured: 24 s a clip on a rented RTX 5070 Ti, 48 s from cold on a 4060 Ti (Oct 2026).
        seconds5090: 11,
        steps: 3,
        requires: FP8,
        files: [WAN22_5B_FP16, UMT5_FP8, WAN22_VAE, FASTWAN_5B, LIGHTTAE_W22],
      },
      {
        id: "gguf-q8",
        label: "GGUF Q8",
        needGb: 8.5,
        fidelity: 0.99,
        // Measured: 61 s a clip from cold on a rented RTX 4070 (Q8), 85 s on a 2080 Ti (Q6); a GTX 1060 took 2.2× what its
        // ratio predicts (Q4, 540p: 9 min), GGUF on a card without tensor cores (Oct 2026).
        seconds5090: 15,
        steps: 3,
        oldGpuCost: 2.2,
        requires: GGUF,
        files: [wan5bGguf("Q8_0", 5_400_179_040, "57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f"), UMT5_Q8, WAN22_VAE, FASTWAN_5B, LIGHTTAE_W22],
      },
      {
        id: "gguf-q6",
        label: "GGUF Q6",
        needGb: 6.5,
        fidelity: 0.98,
        seconds5090: 15,
        steps: 3,
        oldGpuCost: 2.2,
        requires: GGUF,
        files: [wan5bGguf("Q6_K", 4_211_683_680, "355f6bee35c4c6cbd0f275112619fe8ac6f7b9b067b885723667b3bde29497c3"), UMT5_Q5, WAN22_VAE, FASTWAN_5B, LIGHTTAE_W22],
      },
      {
        id: "gguf-q4",
        label: "GGUF Q4",
        needGb: 5.5,
        fidelity: 0.96,
        seconds5090: 15,
        steps: 3,
        oldGpuCost: 2.2,
        requires: GGUF,
        files: [wan5bGguf("Q4_K_M", 3_433_116_000, "95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2"), UMT5_Q5, WAN22_VAE, FASTWAN_5B, LIGHTTAE_W22],
      },
    ],
  },

  /* ---------------------------------------------------------------- swap */
  {
    id: "scail-2",
    name: "SCAIL-2",
    maker: "Zhipu AI",
    tasks: ["swap"],
    blurb: "Puts your characters in place of the people in a clip: same background, camera and moves, two at once.",
    quality: 88,
    unit: "clip",
    licence: { name: "MIT", url: "https://huggingface.co/zai-org/SCAIL-2", commercial: "yes" },
    crackio: "local:scail-2",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 22,
        fidelity: 0.99,
        // 81 frames at 1280×704, 6 steps (704p); 512p takes about a third.
        seconds5090: 325,
        steps: 6,
        measured: true,
        requires: NVIDIA,
        files: [file("model", "diffusion_models", "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", "Comfy-Org/SCAIL-2", "diffusion_models/wan2.1_14B_SCAIL_2_int8_convrot.safetensors", 16_654_506_256), UMT5_FP8, ...SCAIL_REST],
      },
      {
        id: "fp16",
        label: "FP16",
        needGb: 38,
        fidelity: 1,
        seconds5090: 620,
        steps: 6,
        files: [
          file("model", "diffusion_models", "wan2.1_14B_SCAIL_2_fp16.safetensors", "Comfy-Org/SCAIL-2", "diffusion_models/wan2.1_14B_SCAIL_2_fp16.safetensors", 32_794_040_328, "e3f9cd52184949ee8ffdc01ba14de4c619e0ddfa09ae105cb7efce5c8dc9fe43"),
          UMT5_FP16,
          ...SCAIL_REST,
        ],
      },
      {
        // RealRebelAI's GGUF builds: any card with 4 GB free and the RAM to hold the files streams the rest of the model each
        // step (Crackio's bridge cuts the attention work and makes only the people's box). Macs hold it in unified memory.
        id: "gguf-q8",
        label: "GGUF Q8",
        needGb: 21,
        fidelity: 0.99,
        seconds5090: 360,
        steps: 6,
        requires: GGUF,
        streams: true,
        files: [scailGguf("Q8_0", 17_666_268_832, "ba4e6ef95eb071b8df357bb0d171a406b9b0acd501483be46e95046d4e3112dd"), UMT5_Q8, ...SCAIL_REST],
      },
      {
        id: "gguf-q4",
        label: "GGUF Q4",
        needGb: 14,
        fidelity: 0.95,
        seconds5090: 360,
        steps: 6,
        requires: GGUF,
        streams: true,
        files: [scailGguf("Q4_K_M", 10_862_812_832, "ced59d192230b56990c7cb2ce905ae72cac08f564639f6198edff57e035f2646"), UMT5_Q5, ...SCAIL_REST],
      },
    ],
  },
  {
    id: "ltx-2.5-ripple",
    name: "LTX-2.5 Ripple",
    maker: "Lightricks · WepeNerd",
    tasks: ["swap"],
    blurb:
      "Swaps anyone or anything in a clip: your picture model redraws its first frame with your Cast in place, and LTX-2.5 with the Ripple IC-LoRA carries that change through every frame. The moves, mouth, camera and place stay; people, pets, cars and objects.",
    quality: 86,
    unit: "clip",
    licence: { ...LTX_LICENCE, note: `${LTX_LICENCE.note} The Ripple LoRA is under the same licence.` },
    gated: { repo: "Lightricks/LTX-2.5" },
    crackio: "local:ltx-2.5-ripple",
    variants: [
      {
        // 121 frames (5 s) at 704×1248 in one 8-step pass, measured on an RTX 5090 with Crackio's graph (Oct 2026).
        id: "int8",
        label: "INT8",
        needGb: 24,
        fidelity: 0.99,
        seconds5090: 80,
        steps: 8,
        measured: true,
        requires: NVIDIA,
        files: [LTX_INT8, LTX_TEXT_INT8, ...LTX_VAES, RIPPLE_LORA],
      },
      {
        id: "nvfp4",
        label: "NVFP4",
        needGb: 21,
        fidelity: 0.96,
        seconds5090: 96,
        steps: 8,
        requires: RTX50,
        files: [LTX_NVFP4, LTX_TEXT_INT8, ...LTX_VAES, RIPPLE_LORA],
      },
    ],
  },

  /* ---------------------------------------------------------------- images */
  {
    id: "flux3-klein",
    name: "FLUX 3 Klein",
    maker: "Black Forest Labs",
    tasks: ["image", "edit"],
    blurb: "FLUX 3 on your own card: pictures and edits from up to 10 references, from an 8 GB GPU up. Needs full scene descriptions (Crackio writes them); faces in wide shots are its weak spot.",
    quality: 91,
    unit: "image",
    licence: {
      name: "FLUX Kommunity",
      url: "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy",
      commercial: "limited",
      note: "Free commercial use under $5M yearly revenue. Accept it on Hugging Face first.",
    },
    gated: { repo: "black-forest-labs/flux-3-image-klein-comfy" },
    crackio: "local:flux3-klein",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 9,
        fidelity: 0.99,
        // From rented cards on PyTorch's CUDA 13 build, the model loaded: an RTX 4070 4.8 s a picture, a 3060 Ti 8 s, a
        // 4060 Ti 6 s per unit of an edit. The 4.1 s an RTX 5090 measured earlier ran on its CUDA 12 build, which leaves
        // ComfyUI's int8 kernels off (fit's formatCost, Oct 2026).
        seconds5090: 1.6,
        steps: 16,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "flux3-image-klein-int8-convrot.safetensors", "black-forest-labs/flux-3-image-klein-comfy", "diffusion_models/flux3-image-klein-int8-convrot.safetensors", 5_827_874_779, "847d8933548afd93df4af2cac2498e70891bf28d9dae06d695f536992e168fe2"),
          file("text", "text_encoders", "qwen3vl_4b_int8_convrot.safetensors", "black-forest-labs/flux-3-image-klein-comfy", "text_encoders/qwen3vl_4b_int8_convrot.safetensors", 4_858_559_240),
          FLUX2_VAE,
        ],
      },
      {
        id: "bf16",
        label: "BF16",
        needGb: 14,
        fidelity: 1,
        seconds5090: 7.8,
        steps: 16,
        files: [
          file("model", "diffusion_models", "flux3-image-klein-bf16.safetensors", "black-forest-labs/flux-3-image-klein-comfy", "diffusion_models/flux3-image-klein-bf16.safetensors", 11_097_404_512),
          file("text", "text_encoders", "qwen3vl_4b_bf16.safetensors", "black-forest-labs/flux-3-image-klein-comfy", "text_encoders/qwen3vl_4b_bf16.safetensors", 8_875_719_408),
          FLUX2_VAE,
        ],
      },
    ],
  },
  {
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    maker: "Tongyi-MAI",
    tasks: ["image"],
    blurb: "Photoreal pictures with real faces and clean text, in a couple of seconds on a big GPU. Words only (no edits); needs about 6 GB free, so a 6 GB card that also drives a screen runs it slowly.",
    quality: 75,
    unit: "image",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo", commercial: "yes" },
    crackio: "local:z-image-turbo",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 9,
        fidelity: 0.99,
        seconds5090: 1.7,
        steps: 8,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "z_image_turbo_int8_convrot.safetensors", "Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors", 6_201_001_296, "be517ebd47c912a5626a588e1aeea43e6be4a43c0cdcd2b48a2a780d9f358635"),
          QWEN3_4B,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
        ],
      },
      {
        id: "nvfp4",
        label: "NVFP4",
        needGb: 6,
        fidelity: 0.95,
        seconds5090: 2.1,
        steps: 8,
        requires: RTX50,
        files: [
          file("model", "diffusion_models", "z_image_turbo_nvfp4.safetensors", "Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_nvfp4.safetensors", 4_509_509_600, "a553c889dbcb910de4c98293237573219a37007c1074a3f04576646a088bd5c8"),
          file("text", "text_encoders", "qwen_3_4b_fp4_mixed.safetensors", "Comfy-Org/z_image_turbo", "split_files/text_encoders/qwen_3_4b_fp4_mixed.safetensors", 3_479_416_193, "7ca32dcf07dfe7692945d80fff86e3a74cb83c6206b9b223ac6836b939bb85d6"),
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
        ],
      },
      {
        id: "bf16",
        label: "BF16",
        needGb: 15,
        fidelity: 1,
        seconds5090: 3.2,
        steps: 8,
        files: [
          file("model", "diffusion_models", "z_image_turbo_bf16.safetensors", "Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_bf16.safetensors", 12_309_866_400, "2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6"),
          QWEN3_4B,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
        ],
      },
      {
        // Macs with 16 GB, and NVIDIA cards older than RTX 20 (no int8 math): unsloth's quants, text encoder quantized too.
        id: "gguf-q5",
        label: "GGUF Q5",
        needGb: 7,
        fidelity: 0.97,
        seconds5090: 4,
        steps: 8,
        // A GTX 1080 Ti took 2× what its ratio predicts (Q5, 137 s from cold): no tensor cores (Oct 2026).
        oldGpuCost: 2,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "z-image-turbo-Q5_K_M.gguf", "unsloth/Z-Image-Turbo-GGUF", "z-image-turbo-Q5_K_M.gguf", 4_619_474_496, "53b6f401c922192403e362e342d84e80b39703a4debd93a45191b4dcee9a1bff"),
          QWEN3_4B_Q5,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
        ],
      },
      {
        id: "gguf-q4",
        label: "GGUF Q4",
        needGb: 6,
        fidelity: 0.94,
        seconds5090: 4,
        steps: 8,
        oldGpuCost: 2,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "z-image-turbo-Q4_K_M.gguf", "unsloth/Z-Image-Turbo-GGUF", "z-image-turbo-Q4_K_M.gguf", 3_850_130_496, "4ab6bceb1f0b82c9e725f123848018eac662a6fc1d467c019e13e701afb7b55c"),
          QWEN3_4B_Q4,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
        ],
      },
    ],
  },
  {
    // The Director's shot model that keeps faces: Qwen-Image 2.1 Turbo's files and its Fun ControlNet (engines/
    // comfy-local-recipes QWEN_DIRECTOR). Installing it next to Qwen-Image 2.1 adds only the ControlNet.
    id: "qwen-director",
    name: "Qwen Director",
    maker: "Alibaba Qwen + Alibaba PAI",
    tasks: ["image"],
    blurb: "The Director's shots with your cast's own faces and clothes from their pictures: Qwen-Image 2.1 drawing your set's depth through a ControlNet. About 14 s a shot on an RTX 5090. Research and non-commercial use only.",
    quality: 78,
    unit: "image",
    licence: { name: "Qwen Research", url: "https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union", commercial: "no" },
    crackio: "local:qwen-director",
    thumb: "image_qwen_Image_2512_controlnet",
    variants: [
      {
        id: "int8-turbo",
        label: "INT8 Turbo",
        needGb: 17,
        fidelity: 0.97,
        seconds5090: 14,
        steps: 8,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "qwen_image_2.1_turbo_int8_convrot.safetensors", "Comfy-Org/Qwen-Image-2.1", "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors", 7_256_787_829, "8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c"),
          file("text", "text_encoders", "qwen3vl_8b_int8_convrot.safetensors", "Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_int8_convrot.safetensors", 9_350_798_360, "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f"),
          file("vae", "vae", "qwen_image_2.1_vae_bf16.safetensors", "Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors", 675_509_688, "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"),
          file("control", "model_patches", "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors", "alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union", "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors", 7_550_979_904),
        ],
      },
    ],
  },
  {
    // The Director's shot model: Z-Image Turbo's files and the Fun ControlNet that makes it draw the set's depth
    // (engines/comfy-local-recipes Z_IMAGE_DIRECTOR). Installing it next to Z-Image Turbo adds only the ControlNet.
    id: "z-image-director",
    name: "Z-Image Director",
    maker: "Tongyi-MAI + Alibaba PAI",
    tasks: ["image"],
    blurb: "The Director's shots: your set's camera and everyone's marks drawn as a real, cinematic film still (Z-Image Turbo with a depth ControlNet). About 4 s a shot on an RTX 5090.",
    quality: 80,
    unit: "image",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", commercial: "yes" },
    crackio: "local:z-image-director",
    // ComfyUI's own template for this ControlNet: its preview is the card's picture.
    thumb: "image_z_image_turbo_fun_union_controlnet",
    variants: [
      {
        id: "nvfp4",
        label: "NVFP4",
        needGb: 12,
        fidelity: 0.95,
        seconds5090: 4,
        steps: 8,
        requires: RTX50,
        files: [
          file("model", "diffusion_models", "z_image_turbo_nvfp4.safetensors", "Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_nvfp4.safetensors", 4_509_509_600, "a553c889dbcb910de4c98293237573219a37007c1074a3f04576646a088bd5c8"),
          file("text", "text_encoders", "qwen_3_4b_fp4_mixed.safetensors", "Comfy-Org/z_image_turbo", "split_files/text_encoders/qwen_3_4b_fp4_mixed.safetensors", 3_479_416_193, "7ca32dcf07dfe7692945d80fff86e3a74cb83c6206b9b223ac6836b939bb85d6"),
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
          file("control", "model_patches", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors", "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors", 6_712_485_600),
        ],
      },
      {
        id: "int8",
        label: "INT8",
        needGb: 15,
        fidelity: 0.99,
        seconds5090: 4,
        steps: 8,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "z_image_turbo_int8_convrot.safetensors", "Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors", 6_201_001_296, "be517ebd47c912a5626a588e1aeea43e6be4a43c0cdcd2b48a2a780d9f358635"),
          QWEN3_4B,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
          file("control", "model_patches", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors", "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors", 6_712_485_600),
        ],
      },
      {
        // Macs with 16 GB, older NVIDIA cards: Z-Image Turbo's Q5 quant (its text encoder too), the lite ControlNet.
        id: "gguf-q5",
        label: "GGUF Q5",
        needGb: 10,
        fidelity: 0.93,
        seconds5090: 6,
        steps: 8,
        oldGpuCost: 2,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "z-image-turbo-Q5_K_M.gguf", "unsloth/Z-Image-Turbo-GGUF", "z-image-turbo-Q5_K_M.gguf", 4_619_474_496, "53b6f401c922192403e362e342d84e80b39703a4debd93a45191b4dcee9a1bff"),
          QWEN3_4B_Q5,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
          file("control", "model_patches", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors", "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors", 2_016_627_488),
        ],
      },
      {
        // Macs and older NVIDIA cards: the quantized model and the lite ControlNet (control on fewer layers, 2 GB).
        id: "gguf-q4",
        label: "GGUF Q4",
        needGb: 9,
        fidelity: 0.9,
        seconds5090: 6,
        steps: 8,
        oldGpuCost: 2,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "z-image-turbo-Q4_K_M.gguf", "unsloth/Z-Image-Turbo-GGUF", "z-image-turbo-Q4_K_M.gguf", 3_850_130_496, "4ab6bceb1f0b82c9e725f123848018eac662a6fc1d467c019e13e701afb7b55c"),
          QWEN3_4B_Q4,
          file("vae", "vae", "ae.safetensors", "Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 335_304_388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"),
          file("control", "model_patches", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors", "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors", 2_016_627_488),
        ],
      },
    ],
  },
  {
    id: "flux2-klein-4b",
    name: "FLUX.2 klein 4B",
    maker: "Black Forest Labs",
    tasks: ["image", "edit"],
    blurb: "The best small editor: pictures and edits from up to 4 references. About a second each on an RTX 5090; on a 6 GB GTX 1060, about a minute a picture and 2–3 min an edit.",
    quality: 62,
    unit: "image",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8", commercial: "yes" },
    crackio: "local:flux2-klein-4b",
    variants: [
      {
        id: "fp8",
        label: "FP8",
        needGb: 6,
        fidelity: 0.98,
        // Measured on rented cards: a 3060 Ti 5 s a picture (Oct 2026).
        seconds5090: 0.75,
        steps: 4,
        requires: FP8,
        files: [
          file("model", "diffusion_models", "flux-2-klein-4b-fp8.safetensors", "black-forest-labs/FLUX.2-klein-4b-fp8", "flux-2-klein-4b-fp8.safetensors", 4_070_624_520, "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6"),
          QWEN3_4B,
          FLUX2_VAE,
        ],
      },
      {
        id: "nvfp4",
        label: "NVFP4",
        needGb: 4,
        fidelity: 0.94,
        seconds5090: 1.1,
        steps: 4,
        requires: RTX50,
        files: [
          file("model", "diffusion_models", "flux-2-klein-4b-nvfp4.safetensors", "black-forest-labs/FLUX.2-klein-4b-nvfp4", "flux-2-klein-4b-nvfp4.safetensors", 2_460_413_488, "d8c5007b6a3bbbdfd38538bbcef5101a55dfde81894f58d2e3c8701cdef3542b"),
          file("text", "text_encoders", "qwen_3_4b_fp4_flux2.safetensors", "Comfy-Org/vae-text-encorder-for-flux-klein-4b", "split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors", 3_848_213_998, "3eab03a77adb0ee5304a4e677d5c10ac22f9049c1d7c894adca4f8bb39206ca8"),
          FLUX2_VAE,
        ],
      },
      {
        id: "bf16",
        label: "BF16",
        needGb: 10,
        fidelity: 1,
        // Measured on rented cards: a 5070 Ti 2.4 s a picture, a 4070 3.2 s, a 4060 Ti 4 s per unit of an edit (Oct 2026).
        seconds5090: 1.2,
        steps: 4,
        files: [
          file("model", "diffusion_models", "flux-2-klein-4b.safetensors", "Comfy-Org/vae-text-encorder-for-flux-klein-4b", "split_files/diffusion_models/flux-2-klein-4b.safetensors", 7_751_105_712, "ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343"),
          QWEN3_4B,
          FLUX2_VAE,
        ],
      },
      {
        id: "gguf-q8",
        label: "GGUF Q8",
        needGb: 6,
        fidelity: 0.99,
        seconds5090: 2.6,
        steps: 4,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "flux-2-klein-4b-Q8_0.gguf", "unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q8_0.gguf", 4_300_644_928, "24a812e8f9b640e21c784164ea48571d8017ca22873696f4badeeabb006d509c"),
          QWEN3_4B_Q5,
          FLUX2_VAE,
        ],
      },
      {
        id: "gguf-q5",
        label: "GGUF Q5",
        needGb: 4.5,
        fidelity: 0.97,
        seconds5090: 2.6,
        steps: 4,
        requires: GGUF,
        files: [
          file("model", "diffusion_models", "flux-2-klein-4b-Q5_K_M.gguf", "unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q5_K_M.gguf", 3_073_368_640, "58c01c75fee2272eadb127f53e26dd05a5a8e7f812e37c36fa44603301f91e54"),
          QWEN3_4B_Q4,
          FLUX2_VAE,
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- upscale */
  {
    id: "seedvr2-3b",
    name: "SeedVR2 3B",
    maker: "ByteDance",
    tasks: ["upscale"],
    blurb: "SeedVR2 in less memory, for 12–16 GB cards: one-step diffusion restoration, clearly less faithful than 7B (last in each of Crackio's tests).",
    quality: 60,
    unit: "image",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/ByteDance-Seed/SeedVR2-3B", commercial: "yes" },
    crackio: "local:seedvr2-3b",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 9,
        fidelity: 0.99,
        // 1.9 s for that picture on the RTX 5090; shares as SeedVR2 7B's.
        seconds5090: 1.8,
        steps: 1,
        fixedShare: 0.8,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "seedvr2_3b_int8_convrot.safetensors", "Comfy-Org/SeedVR2", "diffusion_models/seedvr2_3b_int8_convrot.safetensors", 3_458_259_704, "c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157"),
          file("vae", "vae", "seedvr2_ema_vae_fp16.safetensors", "Comfy-Org/SeedVR2", "vae/seedvr2_ema_vae_fp16.safetensors", 501_324_814, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"),
        ],
      },
      {
        id: "fp16",
        label: "FP16",
        needGb: 12,
        fidelity: 1,
        seconds5090: 2.5,
        steps: 1,
        fixedShare: 0.8,
        files: [
          file("model", "diffusion_models", "seedvr2_3b_fp16.safetensors", "Comfy-Org/SeedVR2", "diffusion_models/seedvr2_3b_fp16.safetensors", 6_784_268_336, "98669fd2c06df5eca88baf68cd5c478775c8e61fc110e598c52b350145ea2660"),
          file("vae", "vae", "seedvr2_ema_vae_fp16.safetensors", "Comfy-Org/SeedVR2", "vae/seedvr2_ema_vae_fp16.safetensors", 501_324_814, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"),
        ],
      },
    ],
  },
  {
    id: "seedvr2-7b",
    name: "SeedVR2 7B",
    maker: "ByteDance",
    tasks: ["upscale"],
    blurb: "One-step diffusion restoration for pictures and clips: the closest of all to real footage in Crackio's test, and the one that brings soft, old or compressed photos back with real-looking detail.",
    quality: 90,
    unit: "image",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/ByteDance-Seed/SeedVR2-7B", commercial: "yes" },
    crackio: "local:seedvr2-7b",
    variants: [
      {
        id: "int8",
        label: "INT8",
        needGb: 10.8,
        fidelity: 0.99,
        // A megapixel made: 640×424 made 2× (1.09 MP) took 1.5–2.2 s on every rented card from the RTX 5090 down to a 3060
        // Ti, and a 5 s clip to 1080p 1.5× the 5090's time on an RTX 4070, not 3× (Oct 2026).
        seconds5090: 1.7,
        steps: 1,
        fixedShare: 0.8,
        requires: NVIDIA,
        files: [
          file("model", "diffusion_models", "seedvr2_7b_int8_convrot.safetensors", "Comfy-Org/SeedVR2", "diffusion_models/seedvr2_7b_int8_convrot.safetensors", 8_334_897_976, "5aa0d25fc9d35e449b659d0c9a5dcb22e2a4fa04032101b95a39da42b32c1be6"),
          file("vae", "vae", "seedvr2_ema_vae_fp16.safetensors", "Comfy-Org/SeedVR2", "vae/seedvr2_ema_vae_fp16.safetensors", 501_324_814, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"),
        ],
      },
    ],
  },
  {
    id: "flashvsr-plus",
    name: "FlashVSR+",
    maker: "OpenImagingLab (Shanghai AI Lab, Tsinghua, CUHK)",
    tasks: ["upscale"],
    blurb: "A one-step streaming video upscaler (Wan 2.1 1.3B, distilled from a 14B teacher) built for 4×: in Crackio's test second only to SeedVR2 7B on real footage, in half its time.",
    quality: 80,
    unit: "clip",
    licence: { name: "Apache-2.0", url: "https://huggingface.co/ruchangyao/FlashVSR_plus", commercial: "yes" },
    crackio: "local:flashvsr-plus",
    // Turbo only: on a 5 s clip shrunk to 864×360 and brought back to 1920×800, its Base version came out
    // further from them (LPIPS 0.138 vs 0.121) and took longer (121 s vs 105 s on the 5090).
    variants: [
      {
        id: "turbo",
        label: "Turbo",
        needGb: 16,
        // A 5 s clip to 1080p ran out of memory on a 12 GB RTX 4070 (rented box, Oct 2026).
        minGb: 14,
        fidelity: 1,
        seconds5090: 105,
        steps: 1,
        measured: true,
        requires: FLASHVSR,
        files: [
          file("model", "FlashVSR", "flashvsr_plus_turbo_dit.safetensors", "ruchangyao/FlashVSR_plus", "turbo/dit.safetensors", 5_676_070_392, "7862b92178176fa3aebc34c6c071daca6b56ab1dddb8e7ff9a01c47f5226ec8b"),
          file("proj", "FlashVSR", "flashvsr_plus_turbo_lq_proj_in.safetensors", "ruchangyao/FlashVSR_plus", "turbo/lq_proj_in.safetensors", 1_151_384_272, "e77b378ae12342eefbb58f924256f362a151b93ce73dd32808fcdaca9c051496"),
          FLASHVSR_DECODER,
          FLASHVSR_PROMPT,
        ],
      },
    ],
  },
  {
    id: "realesrgan-x4",
    name: "Real-ESRGAN ×4",
    maker: "Xintao Wang",
    tasks: ["upscale"],
    blurb: "The classic 67 MB upscaler: runs on any machine (even without a GPU), seconds on a big card and under a minute on a small one; no new detail invented.",
    quality: 62,
    unit: "image",
    licence: { name: "BSD-3-Clause", url: "https://github.com/xinntao/Real-ESRGAN", commercial: "yes" },
    crackio: "local:realesrgan-x4",
    variants: [
      {
        id: "fp32",
        label: "FP32",
        needGb: 1.5,
        fidelity: 1,
        seconds5090: 0.8,
        steps: 1,
        // A 640×424 picture made 2× (1.09 units): 0.85 s on the RTX 5090, 1.4 s on a 5070 Ti, 2.2 s on a 3060 Ti, 5.4 s on
        // a GTX 1080 Ti (Oct 2026).
        fixedShare: 0.7,
        files: [file("model", "upscale_models", "RealESRGAN_x4plus.safetensors", "Comfy-Org/Real-ESRGAN_repackaged", "RealESRGAN_x4plus.safetensors", 66_857_836, "37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb")],
      },
    ],
  },
  {
    id: "nomos2-hq",
    name: "Nomos2 HQ",
    maker: "Philip Hofmann (Phips)",
    tasks: ["upscale"],
    blurb: "A DAT2 transformer upscaler trained on clean pictures: in Crackio's test, by far the closest to the original on AI renders (crisp edges and text, nothing invented).",
    quality: 90,
    unit: "image",
    licence: { name: "CC-BY-4.0", url: "https://huggingface.co/Phips/4xNomos2_hq_dat2", commercial: "yes", note: "Credit Philip Hofmann (Phips)." },
    crackio: "local:nomos2-hq",
    variants: [
      {
        id: "fp32",
        label: "FP32",
        needGb: 4,
        fidelity: 1,
        // 3.5 s for a 640×424 picture made 2× (1.09 units) on the RTX 5090 and on a 5070 Ti, 7 s on a 3060 Ti; 32 s on a
        // GTX 1080 Ti (43 s the first time), whose fp32 attention has no tensor cores (Oct 2026).
        seconds5090: 3.2,
        steps: 1,
        fixedShare: 0.8,
        oldGpuCost: 2.5,
        files: [file("model", "upscale_models", "4xNomos2_hq_dat2.safetensors", "Phips/4xNomos2_hq_dat2", "4xNomos2_hq_dat2.safetensors", 139_792_588, "278c78ba9fd333ace4b02b3aeaa0254428baea20a63d3e995e2e4f8a60173f6f")],
      },
    ],
  },
  {
    id: "nomos-webphoto",
    name: "Nomos WebPhoto",
    maker: "Philip Hofmann (Phips)",
    tasks: ["upscale"],
    blurb: "A fast RealPLKSR upscaler for real photos: cleans JPEG and web compression while it sharpens, nothing invented.",
    quality: 78,
    unit: "image",
    licence: { name: "CC-BY-4.0", url: "https://huggingface.co/Phips/4xNomosWebPhoto_RealPLKSR", commercial: "yes", note: "Credit Philip Hofmann (Phips)." },
    crackio: "local:nomos-webphoto",
    variants: [
      {
        id: "fp32",
        label: "FP32",
        needGb: 2,
        fidelity: 1,
        // 0.58 s for that picture on the RTX 5090; not measured off it: shares as Real-ESRGAN's.
        seconds5090: 0.55,
        steps: 1,
        fixedShare: 0.7,
        files: [file("model", "upscale_models", "4xNomosWebPhoto_RealPLKSR.safetensors", "Phips/4xNomosWebPhoto_RealPLKSR", "4xNomosWebPhoto_RealPLKSR.safetensors", 29_590_440, "9be0228f98156a100d6636d99b373ed2785b999723f9adc4cca504329ab157f2")],
      },
    ],
  },
];

export const localModel = (id: string) => LOCAL_MODELS.find((m) => m.id === id) ?? null;

/** Every model folder the catalog uses, for checking what's installed. */
export const LOCAL_FOLDERS = [...new Set(LOCAL_MODELS.flatMap((m) => m.variants.flatMap((v) => v.files.map((f) => f.folder))))];
