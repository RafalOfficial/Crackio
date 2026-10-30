import "server-only";
import { comfyKey, comfyModel, comfyName, type ComfyModel } from "@/lib/providers/comfy-models";
import { capsBadges, capsFit, imageSlots, type Caps, type ModelTask } from "@/lib/models/caps";
import type { ModelAvailability, ModelKind } from "@/lib/models/catalog";
import type { CustomRow } from "@/lib/models/custom-types";

/**
 * Models beyond Crackio's built-in list: every image and video model on Comfy Router (your Comfy key), known by its
 * published schema. Their ids carry the provider: "comfy:<provider>/<model>".
 */

/** The company behind a model, from its endpoint ("fal-ai/kling-video/…" → Kling). */
const VENDORS: [RegExp, string][] = [
  [/kling/, "Kling"],
  [/seedance|seedream|seedvr|bytedance|omnihuman|lynx|dreamina/, "ByteDance"],
  [/veo|imagen|gemini|nano-banana|google/, "Google"],
  [/minimax|hailuo/, "MiniMax"],
  [/wan[-/]|wan\d|qwen|alibaba|happy-horse/, "Alibaba"],
  [/ltx|lightricks/, "Lightricks"],
  [/grok|xai\//, "xAI"],
  [/flux|blackforestlabs|bfl/, "Black Forest Labs"],
  [/gpt-image|dall-e|sora|openai/, "OpenAI"],
  [/hunyuan|tencent/, "Tencent"],
  [/luma|ray|photon/, "Luma"],
  [/pika/, "Pika"],
  [/pixverse/, "PixVerse"],
  [/vidu/, "Vidu"],
  [/kandinsky/, "Kandinsky"],
  [/recraft/, "Recraft"],
  [/ideogram/, "Ideogram"],
  [/topaz/, "Topaz"],
  [/clarity|crystal-upscaler/, "Clarity"],
  [/bria|fibo/, "Bria"],
  [/krea/, "Krea"],
  [/runway/, "Runway"],
  [/heygen/, "HeyGen"],
  [/microsoft|mai-image/, "Microsoft"],
  [/meta\/|muse/, "Meta"],
  [/nvidia|cosmos/, "NVIDIA"],
  [/stability|stable-|sdxl|sd3/, "Stability AI"],
  [/hidream/, "HiDream"],
  [/decart|lucy/, "Decart"],
  [/veed/, "VEED"],
  [/creatify/, "Creatify"],
  [/sync-lipsync|sync\//, "Sync"],
  [/moonvalley|marey/, "Moonvalley"],
];

export function vendorOf(endpoint: string) {
  const e = endpoint.toLowerCase();
  const hit = VENDORS.find(([re]) => re.test(e));
  if (hit) return hit[1];
  const [owner, app] = e.split("/");
  const name = owner === "fal-ai" ? (app ?? owner) : owner;
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const UPSCALE = /upscal|super[\s-]?res|esrgan|seedvr|aura[\s-]?sr|ccsr|clarity|crystal|topaz\/(upscale|sharpen|restore|adjust)|enhanc|restor/;
/** Clip tools that take a clip and a prompt but don't edit what's in it (sound, length, frame rate, cleanup). */
const NOT_AN_EDIT = /extend|sfx|foley|audio|sound|music|upscal|interpolat|lip[\s-]?sync|background[\s-]?remov|remove[\s-]?background|matting|birefnet|frame[\s-]?rate|\bfps\b|depth|pose|caption|subtitle|trim|merge|concat|reverse|denois|deblur|sharpen|stabili|hdr|3d[\s-]?to|to[\s-]?3d|avatar|dubb|translat|loop/;
const REFRAME = /expand|outpaint|reframe|uncrop|extend[\s-]?image|zoom[\s-]?out/;
/** Whether an id names a model from a provider's own catalog (callers check Crackio's own list first). */
export const isCustomId = (id: string | undefined | null) => Boolean(id && /^comfy:/.test(id));

/** Whether a Comfy model can do what a tool needs (its schema has been read). */
export function comfyFits(m: ComfyModel, task: ModelTask): boolean {
  if (!m.caps || m.alias || !m.output) return false;
  const text = m.id.toLowerCase();
  const upscaler = UPSCALE.test(text);
  if (task === "upscale" && !upscaler) return false;
  if (task === "reframe" && !REFRAME.test(text)) return false;
  if ((task === "edit" || task === "retouch") && upscaler) return false;
  if ((task === "video-edit" || task === "video-swap") && NOT_AN_EDIT.test(text)) return false;
  return capsFit(m.caps, task);
}

export function comfyRow(m: ComfyModel, available: boolean): CustomRow {
  return {
    id: `comfy:${m.id}`,
    provider: "comfy-cloud",
    name: comfyName(m.id),
    vendor: vendorOf(m.id),
    description: "",
    isNew: false,
    badges: m.caps ? capsBadges(m.caps) : [],
    caps: m.caps,
    builtin: false,
    available,
    reason: available ? undefined : "Add your Comfy key in Connections",
  };
}

/** The Custom-tab row for one custom model (with what it accepts), or null when unknown. */
export async function customRow(id: string): Promise<CustomRow | null> {
  if (!isCustomId(id)) return null;
  const m = await comfyModel(id.slice("comfy:".length)).catch(() => null);
  return m?.caps ? comfyRow(m, Boolean(await comfyKey())) : null;
}

/**
 * A custom model, ready for a job of `kind`: availability, the connection that runs it and what it
 * accepts. Null when the id isn't a custom model at all.
 */
export async function customModel(kind: ModelKind, id: string): Promise<(ModelAvailability & { caps: Caps | null }) | null> {
  if (!isCustomId(id)) return null;
  return comfyCustomModel(kind, id);
}

/** A Comfy Router model from the Custom tab, ready for a job of `kind`. */
async function comfyCustomModel(kind: ModelKind, id: string): Promise<ModelAvailability & { caps: Caps | null }> {
  const model = id.slice("comfy:".length);
  const key = await comfyKey();
  const info = await comfyModel(model).catch(() => null);
  const caps = info?.caps ?? null;
  const wantVideo = kind === "video";
  let reason: string | undefined;
  if (!key) reason = "Add your Comfy key in Connections";
  else if (!caps) reason = "Crackio couldn't read this model's settings from Comfy";
  else if ((caps.output === "video") !== wantVideo) reason = wantVideo ? "This model doesn't make video" : "This model makes video, not images";
  else if (caps.missing.length) reason = `Needs inputs Crackio can't send yet (${caps.missing.join(", ")})`;
  return {
    id,
    kind,
    providers: ["comfy-cloud"],
    model,
    name: comfyName(model),
    vendor: vendorOf(model),
    maxRefs: caps ? imageSlots(caps) : 0,
    speed: "medium",
    bestFor: "",
    family: "comfy-custom",
    runnable: true,
    available: !reason,
    via: key ? "comfy-cloud" : null,
    reason,
    caps,
  };
}
