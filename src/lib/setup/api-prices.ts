import { imagePixels } from "@/lib/local/resolution";
import type { JobSpec } from "./knobs";

/**
 * What the same job costs through a model's official API (its maker's), or where it has none, the paid API people would
 * use for that job, for Settings' "you save" next to Crackio's own cost. List prices as published on 2026-11-02 (research:
 * notes kept outside this repo, every alternative in its JSON); `official` says whose they are.
 * Where two prices were found, the lower one is used, so a saving is never overstated. Client-safe.
 *
 * The models run from ComfyUI's templates were priced on 2026-11-20 (notes kept outside this repo
 * and its JSON, every alternative inside). A model has no entry, and Settings shows no comparison for it, where nobody
 * sells it by the job (Ming-Image, Mage-Flow, JoyAI, Bernini-R, Lens, PixelDiT, Causal Forcing, Capybara, NewBie, Chroma)
 * or where the only figure found was a guess from GPU time or one small reseller's far above the going rate (Anima,
 * Kandinsky 5 clips, ChronoEdit, OmniGen2, LongCat-Image).
 */

export type ApiPrice = {
  /** Crackio's model ids it stands for (catalog ids; voice models by their Crackio id). */
  models: string[];
  /** Whose API, as Settings names it: "BFL API", "LTX API", "Topaz API". */
  provider: string;
  product: string;
  official: boolean;
  /**
   * What one price buys: a picture (by the result's size, `byMp`); a second of clip; a clip of up to `clipSeconds`; 1,000
   * characters of speech.
   */
  unit: "image" | "second" | "clip" | "1k-chars";
  /** Pictures: up to `mp` megapixels of result costs `usd`, smallest first (the last stands for anything bigger). */
  byMp?: { mp: number; usd: number }[];
  /** An edit's prices when they differ from a picture's. */
  editByMp?: { mp: number; usd: number }[];
  /** Clips: dollars by size ("720p", "1080p"…); "*" for any size. */
  usd?: Record<string, number>;
  clipSeconds?: number;
  /** The shortest clip it bills (LTX's API: 6 s). */
  minSeconds?: number;
  source: string;
  checked: string;
  note?: string;
};

export type ApiQuote = {
  usd: number;
  provider: string;
  product: string;
  official: boolean;
  source: string;
  checked: string;
  note?: string;
  /** The price it comes from, in words: "$0.09 a second at 720p". */
  rate: string;
};

const CHECKED = "2 Nov 2026";
/** The template models' prices. */
const CHECKED_TPL = "20 Nov 2026";
/** A price per megapixel of result, as the 1, 2 and 4 MP tiers (bigger pictures read the 4 MP price: never more than it costs). */
const perMp = (usd: number) => [1, 2, 4].map((n) => ({ mp: n * 1.05, usd: Math.round(usd * n * 1e4) / 1e4 }));
/** One price whatever the size. */
const flat = (usd: number) => [{ mp: 4.2, usd }];
const FAL = (path: string) => `https://fal.ai/models/${path}`;
const BFL = "https://docs.bfl.ai/quick_start/pricing";
const STUDIO_Z = "https://www.alibabacloud.com/help/en/model-studio/z-image-turbo";
const STUDIO_QWEN = "https://www.alibabacloud.com/help/en/model-studio/qwen-image-2-1-turbo";
const TOPAZ = "https://www.topazlabs.com/api";
const ELEVEN = "https://elevenlabs.io/pricing/api";

export const API_PRICES: ApiPrice[] = [
  {
    models: ["flux3-klein"],
    provider: "BFL API",
    product: "FLUX 3 Image Klein",
    official: true,
    unit: "image",
    byMp: [
      { mp: 0.6, usd: 0.008 },
      { mp: 1.05, usd: 0.009 },
      { mp: 2.1, usd: 0.011 },
      { mp: 4.2, usd: 0.014 },
      { mp: 16.8, usd: 0.036 },
    ],
    source: BFL,
    checked: CHECKED,
    note: "edits cost the same",
  },
  {
    models: ["flux2-klein-4b"],
    provider: "BFL API",
    product: "FLUX.2 [klein] 4B",
    official: true,
    unit: "image",
    byMp: [
      { mp: 1.05, usd: 0.014 },
      { mp: 2.1, usd: 0.015 },
      { mp: 4.2, usd: 0.017 },
    ],
    editByMp: [
      { mp: 1.05, usd: 0.015 },
      { mp: 2.1, usd: 0.016 },
      { mp: 4.2, usd: 0.018 },
    ],
    source: BFL,
    checked: CHECKED,
    note: "its API makes up to 4 MP",
  },
  {
    models: ["tpl-flux2-klein-9b-edit", "flux2-klein-9b-edit"],
    provider: "BFL API",
    product: "FLUX.2 [klein] 9B",
    official: true,
    unit: "image",
    byMp: [
      { mp: 1.05, usd: 0.017 },
      { mp: 2.1, usd: 0.019 },
      { mp: 4.2, usd: 0.023 },
    ],
    source: BFL,
    checked: CHECKED,
    note: "an edit with one photo; up to 4 MP",
  },
  {
    models: ["z-image-turbo"],
    provider: "Alibaba Model Studio",
    product: "z-image-turbo",
    official: true,
    unit: "image",
    byMp: [{ mp: 4.2, usd: 0.015 }],
    source: STUDIO_Z,
    checked: CHECKED,
    note: "any size up to 2048²",
  },
  {
    models: ["z-image-director"],
    provider: "Alibaba Model Studio",
    product: "z-image-turbo",
    official: true,
    unit: "image",
    byMp: [{ mp: 4.2, usd: 0.015 }],
    source: STUDIO_Z,
    checked: CHECKED,
    note: "the base model: its API has no depth ControlNet",
  },
  {
    models: ["tpl-qwen-image-2.1", "qwen-image-2.1"],
    provider: "Alibaba Model Studio",
    product: "qwen-image-2.1-turbo",
    official: true,
    unit: "image",
    byMp: [{ mp: 4.2, usd: 0.014133 }],
    source: STUDIO_QWEN,
    checked: CHECKED,
    note: "Global regions; $0.016 in Singapore; edits cost the same",
  },
  {
    models: ["qwen-director", "qwen-angles", "director-world"],
    provider: "Alibaba Model Studio",
    product: "qwen-image-2.1-turbo",
    official: true,
    unit: "image",
    byMp: [{ mp: 4.2, usd: 0.014133 }],
    source: STUDIO_QWEN,
    checked: CHECKED,
    note: "the base model: its API has no Crackio LoRA",
  },
  {
    models: ["ltx-2.5", "director-video"],
    provider: "LTX API",
    product: "ltx-2-5-fast",
    official: true,
    unit: "second",
    usd: { "720p": 0.09, "1080p": 0.13, "1440p": 0.19, "2160p": 0.3 },
    minSeconds: 6,
    source: "https://docs.ltx.io/pricing",
    checked: CHECKED,
    note: "sound included; it bills 6 s at least",
  },
  {
    models: ["wan2.2-5b"],
    provider: "fal",
    product: "Wan 2.2 5B",
    official: false,
    unit: "clip",
    usd: { "*": 0.15 },
    clipSeconds: 6,
    source: "https://fal.ai/models/fal-ai/wan/v2.2-5b/text-to-video",
    checked: CHECKED,
    note: "the same model; Alibaba's API doesn't serve the 5B",
  },
  {
    models: ["nomos2-hq", "nomos-webphoto", "realesrgan-x4", "seedvr2-3b", "seedvr2-7b"],
    provider: "Topaz API",
    product: "Enhance, precision upscale",
    official: false,
    unit: "image",
    byMp: [{ mp: 24, usd: 0.1 }],
    source: TOPAZ,
    checked: CHECKED,
    note: "a commercial upscaler: no paid API runs this open model as such",
  },
  {
    models: ["flashvsr-plus"],
    provider: "Topaz Video API",
    product: "precision video upscale, 720p to 1080p",
    official: false,
    unit: "second",
    usd: { "*": 0.0217 },
    source: "https://developer.topazlabs.com/getting-started/model-pricing/video-models",
    checked: CHECKED,
    note: "its lowest rate; to 4K it's $0.087 a second",
  },
  {
    models: ["ltx-2.5-ripple"],
    provider: "Alibaba Model Studio",
    product: "Wan 2.2 Animate, character replacement",
    official: false,
    unit: "second",
    usd: { "720p": 0.18 },
    source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    checked: CHECKED,
    note: "the closest paid swap; Runway and Luma charge more",
  },
  {
    models: ["scail-2"],
    provider: "Alibaba Model Studio",
    product: "Wan 2.2 Animate, character replacement",
    official: false,
    unit: "second",
    usd: { "720p": 0.18 },
    source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    checked: CHECKED,
    note: "the closest paid swap",
  },
  // ---- Models run from ComfyUI's templates (checked 20 Nov 2026) ----
  {
    models: ["tpl-flux2-klein-9b"],
    provider: "BFL API",
    product: "FLUX.2 [klein] 9B",
    official: true,
    unit: "image",
    byMp: [
      { mp: 1.05, usd: 0.015 },
      { mp: 2.1, usd: 0.017 },
      { mp: 4.2, usd: 0.021 },
    ],
    source: "https://bfl.ai/pricing",
    checked: CHECKED_TPL,
    note: "up to 4 MP",
  },
  {
    models: ["tpl-flux2-dev"],
    provider: "fal",
    product: "FLUX.2 [dev]",
    official: false,
    unit: "image",
    byMp: perMp(0.012),
    editByMp: [
      { mp: 1.05, usd: 0.024 },
      { mp: 2.1, usd: 0.036 },
      { mp: 4.2, usd: 0.06 },
    ],
    source: FAL("fal-ai/flux-2"),
    checked: CHECKED_TPL,
    note: "the same model; BFL's own API doesn't sell [dev]",
  },
  {
    models: ["tpl-flux1-dev"],
    provider: "BFL API",
    product: "FLUX.1 [dev]",
    official: true,
    unit: "image",
    byMp: flat(0.025),
    source: "https://bfl.ai/pricing",
    checked: CHECKED_TPL,
    note: "any size; edits (Kontext [dev]) cost the same on fal",
  },
  {
    models: ["tpl-flux1-krea"],
    provider: "fal",
    product: "FLUX.1 Krea [dev]",
    official: false,
    unit: "image",
    byMp: perMp(0.025),
    source: FAL("fal-ai/flux/krea"),
    checked: CHECKED_TPL,
    note: "the same model; neither BFL nor Krea sells it",
  },
  {
    models: ["tpl-flux1-schnell"],
    provider: "fal",
    product: "FLUX.1 [schnell]",
    official: false,
    unit: "image",
    byMp: perMp(0.003),
    source: FAL("fal-ai/flux/schnell"),
    checked: CHECKED_TPL,
    note: "the same model; BFL's own API doesn't sell it",
  },
  {
    models: ["tpl-ideogram-4"],
    provider: "Ideogram API",
    product: "Ideogram 4.0, Default speed",
    official: true,
    unit: "image",
    byMp: flat(0.06),
    source: "https://ideogram.ai/pricing/?pricing_tab=api",
    checked: CHECKED_TPL,
    note: "any size; Turbo is $0.03, Quality $0.10",
  },
  {
    models: ["tpl-krea-2"],
    provider: "fal",
    product: "Krea 2 Turbo",
    official: false,
    unit: "image",
    byMp: perMp(0.008),
    source: FAL("fal-ai/krea-2/turbo"),
    checked: CHECKED_TPL,
    note: "the same open model; Krea's own API is $0.015 at 1K",
  },
  {
    models: ["tpl-z-image"],
    provider: "fal",
    product: "Z-Image (base)",
    official: false,
    unit: "image",
    byMp: perMp(0.01),
    source: FAL("fal-ai/z-image/base"),
    checked: CHECKED_TPL,
    note: "the same model; Alibaba's API sells only Z-Image Turbo",
  },
  {
    models: ["tpl-qwen-image", "tpl-qwen-image-2512"],
    provider: "fal",
    product: "Qwen-Image",
    official: false,
    unit: "image",
    byMp: perMp(0.02),
    source: FAL("fal-ai/qwen-image"),
    checked: CHECKED_TPL,
    note: "the same model; Alibaba's API no longer lists it",
  },
  {
    models: ["tpl-qwen-image-edit-2511"],
    provider: "fal",
    product: "Qwen-Image-Edit 2511",
    official: false,
    unit: "image",
    byMp: perMp(0.03),
    source: FAL("fal-ai/qwen-image-edit-2511"),
    checked: CHECKED_TPL,
    note: "the same model; Alibaba's API no longer lists it",
  },
  {
    models: ["tpl-qwen-image-edit"],
    provider: "WaveSpeed",
    product: "Qwen-Image-Edit",
    official: false,
    unit: "image",
    byMp: flat(0.02),
    source: "https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit",
    checked: CHECKED_TPL,
    note: "an edit of one photo; fal's listing is $0.03 per MP",
  },
  {
    models: ["tpl-hidream-o1"],
    provider: "fal",
    product: "HiDream-O1 Dev",
    official: false,
    unit: "image",
    byMp: perMp(0.005),
    source: FAL("fal-ai/hidream-o1-image"),
    checked: CHECKED_TPL,
    note: "edits cost the same; the full model is $0.01 per MP",
  },
  {
    models: ["tpl-hidream-i1"],
    provider: "Runware",
    product: "HiDream-I1 Dev",
    official: false,
    unit: "image",
    byMp: [
      { mp: 1.05, usd: 0.0026 },
      { mp: 4.2, usd: 0.0069 },
    ],
    source: "https://runware.ai/docs/models/hidream-i1-dev.md",
    checked: CHECKED_TPL,
    note: "billed by compute time; fal's Full model is $0.05 per MP",
  },
  {
    models: ["tpl-hidream-e1"],
    provider: "WaveSpeed",
    product: "HiDream-E1 Full",
    official: false,
    unit: "image",
    byMp: flat(0.024),
    source: "https://wavespeed.ai/models/wavespeed-ai/hidream-e1-full",
    checked: CHECKED_TPL,
    note: "the first E1 release; no one sells E1.1 at a fixed price",
  },
  {
    models: ["tpl-ernie-image"],
    provider: "fal",
    product: "ERNIE-Image Turbo",
    official: false,
    unit: "image",
    byMp: perMp(0.01),
    source: FAL("fal-ai/ernie-image/turbo"),
    checked: CHECKED_TPL,
    note: "Turbo; the full model is $0.03 per MP",
  },
  {
    models: ["tpl-moss-image"],
    provider: "fal",
    product: "MOSS-Image",
    official: false,
    unit: "image",
    byMp: perMp(0.05),
    source: FAL("fal-ai/moss-image"),
    checked: CHECKED_TPL,
    note: "the same model; OpenMOSS has no API",
  },
  {
    models: ["tpl-boogu"],
    provider: "fal",
    product: "Boogu-Image",
    official: false,
    unit: "image",
    byMp: perMp(0.04),
    source: FAL("fal-ai/boogu-image"),
    checked: CHECKED_TPL,
    note: "fal doesn't say whether it runs Turbo, as Crackio does",
  },
  {
    models: ["tpl-boogu-edit"],
    provider: "fal",
    product: "Boogu-Image Edit",
    official: false,
    unit: "image",
    byMp: perMp(0.04),
    source: FAL("fal-ai/boogu-image/edit"),
    checked: CHECKED_TPL,
    note: "an edit of one photo; Boogu has no API",
  },
  {
    models: ["tpl-firered-edit"],
    provider: "each::labs",
    product: "FireRed Image Edit 1.1",
    official: false,
    unit: "image",
    byMp: perMp(0.0325),
    source: "https://www.eachlabs.ai/firered/image-edit/firered-image-edit-v1-1",
    checked: CHECKED_TPL,
    note: "the lower of its two hosts (WaveSpeed: $0.15)",
  },
  {
    models: ["tpl-kandinsky-5"],
    provider: "Runware",
    product: "Kandinsky 5.0 Image Lite, 50 steps",
    official: false,
    unit: "image",
    byMp: flat(0.0283),
    source: "https://runware.ai/docs/models/kandinsky-5-0-image-lite.md",
    checked: CHECKED_TPL,
    note: "billed by compute time, at 1 MP",
  },
  {
    models: ["tpl-netayume"],
    provider: "WaveSpeed",
    product: "Neta Lumina",
    official: false,
    unit: "image",
    byMp: flat(0.01),
    source: "https://wavespeed.ai/models/wavespeed-ai/neta-lumina",
    checked: CHECKED_TPL,
    note: "the model NetaYume is tuned from; nobody hosts NetaYume itself",
  },
  {
    models: ["tpl-sdxl"],
    provider: "Stability AI API",
    product: "SDXL 1.0",
    official: true,
    unit: "image",
    byMp: flat(0.009),
    source: "https://docs.stability.ai/pricing",
    checked: CHECKED_TPL,
    note: "its lowest price ('from 0.9 credits')",
  },
  {
    models: ["tpl-minimax-h3-video"],
    provider: "fal",
    product: "MiniMax H3",
    official: false,
    unit: "second",
    usd: { "480p": 0.05, "720p": 0.06 },
    minSeconds: 5,
    source: FAL("minimax/h3/text-to-video"),
    checked: CHECKED_TPL,
    note: "MiniMax's listing on fal, at 768p; its own API is $0.08 a second",
  },
  {
    models: ["tpl-ltx-2.3-video"],
    provider: "fal",
    product: "LTX-2.3 22B distilled",
    official: false,
    unit: "second",
    usd: { "480p": 0.012, "720p": 0.0269, "1080p": 0.0605 },
    source: FAL("fal-ai/ltx-2.3-22b/distilled/text-to-video"),
    checked: CHECKED_TPL,
    note: "the same open weights, billed by the megapixel of video at 24 fps; LTX's own API is $0.03 a second, 6 s at least",
  },
  {
    models: ["tpl-ltx-2-video"],
    provider: "fal",
    product: "LTX-2 19B distilled",
    official: false,
    unit: "second",
    usd: { "480p": 0.0079, "720p": 0.0179, "1080p": 0.0402 },
    source: FAL("fal-ai/ltx-2-19b/distilled/text-to-video"),
    checked: CHECKED_TPL,
    note: "the distilled model, billed by the megapixel of video at 24 fps; the full one is about $0.04 a second at 720p",
  },
  {
    models: ["tpl-wan2.2-14b-video"],
    provider: "Alibaba Model Studio",
    product: "wan2.2-i2v-plus",
    official: true,
    unit: "second",
    usd: { "480p": 0.02, "1080p": 0.1 },
    source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    checked: CHECKED_TPL,
    note: "Alibaba's own Wan 2.2; the open 14B on fal is $0.04 a second at 480p",
  },
  {
    models: ["tpl-wan-vace-video"],
    provider: "fal",
    product: "Wan VACE 14B",
    official: false,
    unit: "second",
    usd: { "480p": 0.04, "720p": 0.08 },
    source: FAL("fal-ai/wan-vace-14b"),
    checked: CHECKED_TPL,
    note: "the same model, at 16 frames a second; fal retires it on 4 Jan 2027",
  },
  {
    models: ["tpl-hunyuanvideo-1.5-video"],
    provider: "WaveSpeed",
    product: "HunyuanVideo 1.5",
    official: false,
    unit: "second",
    usd: { "480p": 0.02, "720p": 0.04 },
    minSeconds: 5,
    source: "https://wavespeed.ai/models/wavespeed-ai/hunyuan-video-1.5/text-to-video",
    checked: CHECKED_TPL,
    note: "the same model; Tencent's own price wasn't found",
  },
  {
    models: ["local:voice:drama3"],
    provider: "Fish Audio API",
    product: "drama-3",
    official: true,
    unit: "1k-chars",
    usd: { "*": 0.05 },
    source: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
    checked: CHECKED,
    note: "list price; $0.01 in a promotion until 12 Nov",
  },
  {
    models: ["local:voice:voxcpm2"],
    provider: "ElevenLabs API",
    product: "Eleven v4",
    official: false,
    unit: "1k-chars",
    usd: { "*": 0.08 },
    source: ELEVEN,
    checked: CHECKED,
    note: "VoxCPM2 has no paid API; ElevenLabs is what people use",
  },
  {
    models: ["local:voice:supertonic"],
    provider: "ElevenLabs API",
    product: "Eleven v4 Turbo",
    official: false,
    unit: "1k-chars",
    usd: { "*": 0.04 },
    source: ELEVEN,
    checked: CHECKED,
    note: "Supertone's own price needs a sign-in",
  },
];

/** Characters of text in a second of speech, for prices per character. */
export const CHARS_PER_SECOND = 15;

const money = (n: number) => (n >= 0.1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);

/** "1440p" reads the nearest size priced at or above it ("540p" reads "720p"); else the biggest priced, else "*". */
function sizeKey(usd: Record<string, number>, resolution: string | undefined) {
  const r = resolution?.toLowerCase();
  if (r && usd[r] !== undefined) return r;
  const priced = Object.keys(usd)
    .filter((k) => /^\d+p$/.test(k))
    .map((k) => Number.parseInt(k, 10))
    .sort((a, b) => a - b);
  if (r && /^\d+p$/.test(r) && priced.length) {
    const want = Number.parseInt(r, 10);
    return `${priced.find((h) => h >= want) ?? priced.at(-1)}p`;
  }
  return usd["*"] !== undefined ? "*" : priced.length ? `${priced[0]}p` : (Object.keys(usd)[0] ?? "*");
}

const tier = (byMp: { mp: number; usd: number }[], mp: number) => (byMp.find((t) => mp <= t.mp) ?? byMp.at(-1))!.usd;

/** The official (or the closest paid) API's price for this job with this model, or null when Crackio has none to show. */
export function apiQuote(model: string, job: JobSpec): ApiQuote | null {
  const p = API_PRICES.find((x) => x.models.includes(model));
  if (!p) return null;
  const quote = (usd: number, rate: string): ApiQuote => ({ usd, rate, provider: p.provider, product: p.product, official: p.official, source: p.source, checked: p.checked, note: p.note });
  if (p.unit === "image") {
    const table = (job.references && p.editByMp) || p.byMp;
    if (!table) return null;
    const mp = job.kind === "upscale" && job.source ? (job.source.width * job.source.height * (job.scale ?? 2) ** 2) / 1e6 : imagePixels(job.resolution ?? "1k", 1).mp;
    const each = tier(table, mp);
    const n = job.kind === "image" ? (job.count ?? 1) : 1;
    return quote(each * n, `${money(each)} a picture${job.kind === "upscale" ? "" : ` at ${mp < 1.2 ? "1" : Math.round(mp)} MP`}`);
  }
  const usd = p.usd ?? {};
  if (p.unit === "1k-chars") {
    const each = usd["*"] ?? Object.values(usd)[0];
    return quote((each * (job.seconds ?? 30) * CHARS_PER_SECOND) / 1000, `${money(each)} per 1,000 characters (about ${CHARS_PER_SECOND} a second)`);
  }
  const key = sizeKey(usd, job.resolution);
  const each = usd[key];
  if (each === undefined) return null;
  const at = key === "*" ? "" : ` at ${key === "2160p" ? "4K" : key}`;
  if (p.unit === "clip") {
    const per = p.clipSeconds ?? 5;
    return quote(each * Math.max(1, Math.ceil((job.seconds ?? per) / per)), `${money(each)} a clip of up to ${per} s${at}`);
  }
  const seconds = Math.max(job.seconds ?? 5, p.minSeconds ?? 0);
  return quote(each * seconds, `${money(each)} a second${at}`);
}
