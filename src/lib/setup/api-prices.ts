import { imagePixels } from "@/lib/local/resolution";
import type { JobSpec } from "./knobs";

/**
 * What the same job costs through a model's official API (its maker's), or where it has none, the paid API people would
 * use for that job, for Settings' "you save" next to Crackio's own cost. List prices as published on 2026-11-02 (research:
 * C:\CrackioTemp\settings-v1\research\05-api-prices.md, every alternative in its JSON); `official` says whose they are.
 * Where two prices were found, the lower one is used, so a saving is never overstated. Client-safe.
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
    models: ["qwen-director", "qwen-angles"],
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
    models: ["ltx-2.5"],
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
