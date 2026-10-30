import type { LocalModel } from "./types";

/**
 * What Crackio knows about each open model family beyond ComfyUI's templates: who makes it, its licence (and the
 * regions it excludes), and how good it is where there's evidence (public arenas, community tests, our own runs;
 * Oct 2026). Families are recognised by their main model file's name.
 */

type Licence = LocalModel["licence"];
export type FamilyInfo = {
  key: string;
  name: string;
  maker: string;
  licence: Licence;
  /** 0–100 among open models for its main job; left out when there's no evidence. */
  quality?: number;
  /** Regions its licence leaves out (ISO-ish codes: EU, UK, US, KR). */
  excludes?: string[];
  gated?: boolean;
  blurb?: string;
};

const APACHE: Licence = { name: "Apache-2.0", commercial: "yes" };
const MIT: Licence = { name: "MIT", commercial: "yes" };
const NC = (name: string, note?: string): Licence => ({ name, commercial: "no", note: note ?? "Non-commercial use only." });
const UNKNOWN: Licence = { name: "See the model card", commercial: "limited", note: "Check its licence on Hugging Face before using it commercially." };
const LTX: Licence = { name: "LTX-2 Community", commercial: "limited", note: "Free under $10M yearly revenue; label AI output; no products that compete with Lightricks." };

/** First match wins: more specific names first. */
const FAMILIES: [RegExp, FamilyInfo][] = [
  [/^flux3-image-klein/i, { key: "flux3-klein", name: "FLUX 3 Klein", maker: "Black Forest Labs", licence: { name: "FLUX Kommunity", commercial: "limited", note: "Free commercial use under $5M yearly revenue." }, quality: 91, gated: true }],
  [/^flux-2-klein-(base-)?4b/i, { key: "flux2-klein-4b", name: "FLUX.2 klein 4B", maker: "Black Forest Labs", licence: APACHE, quality: 62 }],
  [/^flux-2-klein-(base-)?9b/i, { key: "flux2-klein-9b", name: "FLUX.2 klein 9B", maker: "Black Forest Labs", licence: NC("FLUX Non-Commercial"), quality: 75, gated: true }],
  [/^flux2[_-]dev/i, { key: "flux2-dev", name: "FLUX.2 dev", maker: "Black Forest Labs", licence: NC("FLUX [dev] Non-Commercial"), quality: 85 }],
  [/^flux1-kontext/i, { key: "flux1-kontext", name: "FLUX.1 Kontext dev", maker: "Black Forest Labs", licence: NC("FLUX [dev] Non-Commercial"), quality: 70 }],
  [/^flux1-krea/i, { key: "flux1-krea", name: "FLUX.1 Krea dev", maker: "Black Forest Labs and Krea", licence: NC("FLUX [dev] Non-Commercial"), quality: 72 }],
  [/^flux1-schnell/i, { key: "flux1-schnell", name: "FLUX.1 schnell", maker: "Black Forest Labs", licence: APACHE, quality: 60 }],
  [/^flux1-(dev|fill|depth)/i, { key: "flux1-dev", name: "FLUX.1 dev", maker: "Black Forest Labs", licence: NC("FLUX [dev] Non-Commercial"), quality: 60 }],
  [/^qwen_image_2\.1/i, { key: "qwen-image-2.1", name: "Qwen-Image 2.1", maker: "Alibaba Qwen", licence: NC("Qwen Research", "Research and non-commercial use only."), quality: 91 }],
  [/^qwen_image_edit_2511/i, { key: "qwen-image-edit-2511", name: "Qwen-Image-Edit 2511", maker: "Alibaba Qwen", licence: APACHE, quality: 86, blurb: "The best freely licensed editor: precise changes that keep faces and products." }],
  [/^qwen_image_edit_2509/i, { key: "qwen-image-edit-2509", name: "Qwen-Image-Edit 2509", maker: "Alibaba Qwen", licence: APACHE, quality: 78 }],
  [/^qwen_image_edit/i, { key: "qwen-image-edit", name: "Qwen-Image-Edit", maker: "Alibaba Qwen", licence: APACHE, quality: 72 }],
  [/^qwen_image_2512/i, { key: "qwen-image-2512", name: "Qwen-Image 2512", maker: "Alibaba Qwen", licence: APACHE, quality: 80 }],
  [/^qwen_image/i, { key: "qwen-image", name: "Qwen-Image", maker: "Alibaba Qwen", licence: APACHE, quality: 70 }],
  [/^z_image_turbo/i, { key: "z-image-turbo", name: "Z-Image Turbo", maker: "Tongyi-MAI", licence: APACHE, quality: 75 }],
  [/^z_image/i, { key: "z-image", name: "Z-Image", maker: "Tongyi-MAI", licence: APACHE, quality: 80 }],
  [/^krea2/i, { key: "krea-2", name: "Krea 2", maker: "Krea", licence: { name: "Krea 2 Community", commercial: "limited", note: "Free commercial use for teams under 50 seats." }, quality: 85 }],
  [/^ideogram4/i, { key: "ideogram-4", name: "Ideogram 4", maker: "Ideogram", licence: NC("Ideogram Non-Commercial"), quality: 88 }],
  // Oct 2026; no arena placing yet (its makers' own RealLayoutArena and LongLongTextBench only), so no quality score.
  [/^moss_image/i, { key: "moss-image", name: "MOSS-Image", maker: "OpenMOSS", licence: APACHE, blurb: "A freely licensed 5B model that sets long text and layouts cleanly; best with a detailed description of the picture." }],
  [/^mage_flow/i, { key: "mage-flow", name: "Mage-Flow", maker: "Mage", licence: MIT, quality: 74 }],
  [/^boogu/i, { key: "boogu", name: "Boogu", maker: "Boogu", licence: APACHE, quality: 70 }],
  [/^lens/i, { key: "lens", name: "Lens", maker: "Lens", licence: MIT, quality: 72 }],
  [/^hidream_o1/i, { key: "hidream-o1", name: "HiDream-O1", maker: "HiDream.ai", licence: MIT, quality: 81 }],
  [/^hidream_e1/i, { key: "hidream-e1", name: "HiDream-E1", maker: "HiDream.ai", licence: MIT, quality: 64 }],
  [/^hidream_i1/i, { key: "hidream-i1", name: "HiDream-I1", maker: "HiDream.ai", licence: MIT, quality: 70 }],
  [/^ernie/i, { key: "ernie-image", name: "ERNIE-Image", maker: "Baidu", licence: APACHE, quality: 76 }],
  [/^longcat/i, { key: "longcat-image", name: "LongCat-Image", maker: "Meituan", licence: APACHE, quality: 74 }],
  [/^ming_image/i, { key: "ming-image", name: "Ming-Image", maker: "inclusionAI", licence: MIT, quality: 80 }],
  [/^joyai/i, { key: "joyai-edit", name: "JoyAI Image Edit", maker: "JD", licence: UNKNOWN, quality: 76 }],
  [/^firered/i, { key: "firered-edit", name: "FireRed Image Edit", maker: "FireRed", licence: UNKNOWN, quality: 74 }],
  [/^chroma/i, { key: "chroma", name: "Chroma", maker: "Lodestone Rock", licence: APACHE, quality: 66 }],
  [/^kandinsky5.*t2v|^kandinsky5.*i2v|^kandinsky5lite_(t|i)2v/i, { key: "kandinsky-5-video", name: "Kandinsky 5 Lite (video)", maker: "Kandinsky Lab", licence: MIT, quality: 60 }],
  [/^kandinsky5/i, { key: "kandinsky-5", name: "Kandinsky 5", maker: "Kandinsky Lab", licence: MIT, quality: 64 }],
  [/^omnigen2/i, { key: "omnigen2", name: "OmniGen2", maker: "VectorSpaceLab", licence: APACHE, quality: 62 }],
  [/^capybara/i, { key: "capybara", name: "Capybara", maker: "Capybara", licence: UNKNOWN }],
  [/^pixeldit|^pid_/i, { key: "pixeldit", name: "PixelDiT", maker: "NVIDIA", licence: NC("NVIDIA Source Code License") }],
  [/^newbie/i, { key: "newbie", name: "NewBie Image", maker: "NewBie", licence: UNKNOWN }],
  [/^anima/i, { key: "anima", name: "Anima", maker: "Anima", licence: UNKNOWN }],
  [/netayume|lumina/i, { key: "netayume", name: "NetaYume Lumina", maker: "Neta", licence: APACHE }],
  [/^sd_xl|sdxl/i, { key: "sdxl", name: "SDXL", maker: "Stability AI", licence: { name: "OpenRAIL++-M", commercial: "yes" }, quality: 52 }],
  [/^v1-5|sd15|sd1\.5/i, { key: "sd15", name: "Stable Diffusion 1.5", maker: "Stability AI", licence: { name: "CreativeML OpenRAIL-M", commercial: "yes" }, quality: 38 }],
  [/^ltx-2\.5/i, { key: "ltx-2.5", name: "LTX-2.5", maker: "Lightricks", licence: LTX, quality: 88, gated: true }],
  [/^ltx-2\.3/i, { key: "ltx-2.3", name: "LTX-2.3", maker: "Lightricks", licence: LTX, quality: 84 }],
  [/^ltx-2-19b|^ltx-2[^.]/i, { key: "ltx-2", name: "LTX-2", maker: "Lightricks", licence: LTX, quality: 76 }],
  [/^wan2\.2_ti2v_5B/i, { key: "wan2.2-5b", name: "Wan 2.2 5B", maker: "Alibaba", licence: APACHE, quality: 58 }],
  [/^wan2\.2_(i2v|t2v|fun|s2v)/i, { key: "wan2.2-14b", name: "Wan 2.2 14B", maker: "Alibaba", licence: APACHE, quality: 80 }],
  [/scail/i, { key: "scail-2", name: "SCAIL-2", maker: "Zhipu AI", licence: MIT, quality: 88 }],
  [/wan.*animate/i, { key: "wan-animate-2", name: "Wan Animate 2", maker: "Alibaba", licence: APACHE, quality: 76 }],
  [/vace/i, { key: "wan-vace", name: "Wan VACE", maker: "Alibaba", licence: APACHE, quality: 64 }],
  [/^chrono_edit/i, { key: "chronoedit", name: "ChronoEdit 14B", maker: "NVIDIA", licence: APACHE, quality: 70, blurb: "Edits by imagining the change as a short video, so poses and objects move in physically plausible ways." }],
  [/^wan2\.1/i, { key: "wan2.1", name: "Wan 2.1", maker: "Alibaba", licence: APACHE, quality: 64 }],
  [/hunyuanvideo1\.5|hunyuan_video_1\.5/i, { key: "hunyuanvideo-1.5", name: "HunyuanVideo 1.5", maker: "Tencent", licence: { name: "Tencent Hunyuan Community", commercial: "limited", note: "Not licensed in the EU, the UK or South Korea." }, quality: 78, excludes: ["EU", "UK", "KR"] }],
  [/minimax_h3|fasth3/i, { key: "minimax-h3", name: "MiniMax H3", maker: "MiniMax", licence: { name: "MiniMax H3 Community", commercial: "limited", note: "Not licensed in the EU, the UK, the US or South Korea." }, quality: 95, excludes: ["EU", "UK", "US", "KR"] }],
  [/causal_forcing/i, { key: "causal-forcing", name: "Causal Forcing", maker: "Causal Forcing", licence: APACHE, quality: 52 }],
  [/bernini/i, { key: "bernini-r", name: "Bernini-R", maker: "ByteDance", licence: APACHE, quality: 78 }],
  [/^seedvr2_7b/i, { key: "seedvr2-7b", name: "SeedVR2 7B", maker: "ByteDance", licence: APACHE, quality: 90 }],
  [/^seedvr2_3b/i, { key: "seedvr2-3b", name: "SeedVR2 3B", maker: "ByteDance", licence: APACHE, quality: 60 }],
  [/realesrgan/i, { key: "realesrgan-x4", name: "Real-ESRGAN ×4", maker: "Xintao Wang", licence: { name: "BSD-3-Clause", commercial: "yes" }, quality: 62 }],
];

/** The family a template's main model file belongs to, or a plain one named after the template's own family. */
export function familyOf(mainFile: string, fallbackName: string): FamilyInfo {
  const hit = FAMILIES.find(([re]) => re.test(mainFile))?.[1];
  if (hit) return hit;
  const key = fallbackName.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  return { key, name: fallbackName, maker: "", licence: UNKNOWN };
}

/** The user's region from this computer's time zone, for licences that leave regions out. */
export function regionOf(timeZone: string): string | null {
  if (/^Europe\/London$|^Europe\/Belfast$/.test(timeZone)) return "UK";
  if (/^Europe\//.test(timeZone)) return "EU";
  if (/^Asia\/Seoul$/.test(timeZone)) return "KR";
  if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana|Boise|Juneau)/.test(timeZone) || /^Pacific\/Honolulu$/.test(timeZone)) return "US";
  return null;
}
