import type { ModelAvailability } from "./catalog";

/**
 * What the model library shows for each model. Open models on your GPUs bring their preview from the Local catalog
 * (`LocalModel.thumb`); the rest are named here by the official ComfyUI template that previews them
 * (Comfy-Org/workflow_templates, MIT), served by api/models/preview. Client-safe.
 */
export const PREVIEW_OF: Record<string, string> = {
  // Pictures
  "comfy:bfl/flux-3-image": "api_bfl_flux3_t2i",
  "comfy:openai/gpt-image-2.5-sunburst": "api_openai_gpt_image_25_sunburst_t2i",
  "comfy:openai/gpt-image-2.5-flare": "api_openai_gpt_image_25_flare_t2i",
  "comfy:vertexai/gemini-nano-banana-2.1": "api_nano_banana_2_1_t2i",
  "comfy:byteplus/seedream-5-0-pro-260628": "api_bytedance_seedream_5_0_pro_t2i",
  "comfy:qwen/qwen-image-3.0": "api_qwen3_t2i",
  "comfy:qwen/qwen-image-3.0-pro": "api_qwen3_image_edit",
  "comfy:krea/krea-3": "api_krea3_t2i",
  "comfy:ideogram/ideogram-4-5": "api_ideogram_v4_5_t2i",
  "comfy:xai/grok-imagine-image-2.0": "api_grok_imagine_image_2_t2i",
  // Video
  "comfy:minimax/minimax-h3": "api_minimax_h3_t2v",
  "comfy:fal/h3-max": "api_minimax_h3_max_t2v",
  "comfy:fal/flux-3-max": "api_flux3_max_t2v",
  // Comfy retired its Veo templates; the archived Veo 3 one is the official preview left (its badge trimmed, below).
  "comfy:veo/veo-3.1-generate-001": "api_veo3",
  "comfy:ltx/ltx-2-5-pro": "api_ltx2_5_t2v",
  "comfy:kling/kling-v3": "api_kling_v3_video",
  "comfy:kling/kling-v3-omni": "api_kling_o3_i2v",
  "comfy:byteplus/dreamina-seedance-2-5-260628": "api_seedance2_5_t2v",
  "comfy:wan/wan3.0-video": "api_wan3_0_t2v",
  "comfy:xai/grok-imagine-video-1.5": "api_grok_imagine_video_1_5",
  // Upscale and reframe
  "comfy:fal/crystal-upscaler": "api_clarity_ai_crystal_upscale",
  "comfy:wavespeed/seedvr2": "api_wavespeed_seedvr2_ai_image_fix",
  "comfy:bria/image-edit-increase-resolution": "utility_bria_increase_resolution",
  "comfy:bria/image-edit-expand": "api_bria_expand_image",
};

/**
 * Edges cut off a template's preview (pixels of its 350 or 400), where it carries something a card shouldn't show: Veo's
 * "Veo3" badge, black bars beside a tall photo, the small reference pictures an edit template pins to its side (a card
 * would cut them in half). The bottom goes before the top when a photo needs shortening to the card's 4:5: the card's
 * name sits there.
 */
export type PreviewTrim = { top?: number; right?: number; bottom?: number; left?: number };
export const PREVIEW_TRIM: Record<string, PreviewTrim> = {
  api_veo3: { top: 66 },
  image_flux2_klein_9b_kv_image_edit: { left: 95, right: 41, bottom: 66 },
  image_qwen_image_2_1_image_edit: { left: 74 },
  image_flux2_klein_image_edit_4b_base: { left: 140, top: 20, bottom: 55 },
};

export const trimKey = (t: PreviewTrim) => [t.top ?? 0, t.right ?? 0, t.bottom ?? 0, t.left ?? 0].join("-");

/** A template's preview address (api/models/preview); a trimmed one names its trim, so a browser that kept the uncut picture asks again. */
export function previewSrc(template: string, kind: "still" | "clip" | "before" = "still") {
  const trim = PREVIEW_TRIM[template];
  const query = [kind === "still" ? "" : `v=${kind}`, trim ? `t=${trimKey(trim)}` : ""].filter(Boolean).join("&");
  return `/api/models/preview/${encodeURIComponent(template)}${query ? `?${query}` : ""}`;
}

/** Where a model runs: on your own GPUs, on Comfy Cloud (your Comfy key), or through a plan or another key. */
export type ModelHome = "local" | "cloud" | "plan";

export const homeOf = (m: Pick<ModelAvailability, "providers">): ModelHome =>
  m.providers.includes("comfy-local") ? "local" : m.providers.includes("comfy-cloud") ? "cloud" : "plan";

/** "LTX-2.5 (your GPU)" → "LTX-2.5": the library already says where each model runs. */
export const cardName = (name: string) => name.replace(/\s*\((your GPU|Router|API)\)$/i, "");

/** Released this recently: marked new. */
export const NEW_DAYS = 45;
