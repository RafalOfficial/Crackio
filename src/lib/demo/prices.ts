import "server-only";
import { mediaInfo } from "@/lib/server/media-info";
import { urlToPath } from "@/lib/server/media";
import { PRICES } from "./price-list";

/** What a job costs in the live demo, in credits (lib/demo/price-list), and the limits that keep one shared GPU moving. */
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
export const DEMO_LIMITS = {
  clipSeconds: num(process.env.CRACKIO_DEMO_CLIP_SECONDS, 5),
  swapSeconds: num(process.env.CRACKIO_DEMO_SWAP_SECONDS, 10),
  imageTop: process.env.CRACKIO_DEMO_IMAGE_TOP === "2k" ? "2k" : "4k",
};

type Priced = { credits: number } | { error: string };
const options = (params: Record<string, unknown> | undefined) => (params?.options ?? {}) as Record<string, unknown>;
/** A 5 s price for a clip of `seconds`. */
const perClip = (base: number, seconds: number) => Math.ceil(base * Math.max(1, seconds / 5));

/** A picture, clip, edit or upscale sent through /api/generations. */
export async function priceGeneration(tool: string, count: number, params: Record<string, unknown> | undefined): Promise<Priced> {
  const kind = params?.kind ?? "image";
  const o = options(params);
  if (kind === "video") {
    const seconds = typeof o.duration === "number" ? o.duration : 5;
    if (seconds > DEMO_LIMITS.clipSeconds) return { error: `The live demo makes clips up to ${DEMO_LIMITS.clipSeconds} s.` };
    const base = PRICES.clip[String(o.resolution ?? "720p").toLowerCase()];
    if (!base) return { error: "The live demo makes clips up to 1440p." };
    return { credits: perClip(base, seconds) };
  }
  if (kind === "upscale") {
    if (typeof params?.videoUrl !== "string") return { credits: PRICES.upscalePicture };
    const file = urlToPath(params.videoUrl);
    const seconds = file ? ((await mediaInfo(file).catch(() => null))?.duration ?? 0) : 0;
    if (!seconds) return { error: "That clip couldn't be read." };
    if (seconds > DEMO_LIMITS.swapSeconds) return { error: `The live demo upscales clips up to ${DEMO_LIMITS.swapSeconds} s.` };
    return { credits: perClip(PRICES.upscaleClip, seconds) };
  }
  const extra = (Math.max(1, Math.min(4, count)) - 1) * PRICES.extraPicture;
  // Edits (Retouch, Relight, Angles, reframing) are about one megapixel.
  const edit = tool === "retouch" || tool === "relight" || tool === "angles" || kind === "reframe";
  const res = edit ? "1k" : String(o.resolution ?? "1k").toLowerCase();
  if (res === "4k" && DEMO_LIMITS.imageTop !== "4k") return { error: "The live demo makes pictures up to 2K." };
  const base = PRICES.picture[res];
  if (!base) return { error: "The live demo makes pictures up to 4K." };
  return { credits: base + extra };
}

/** A swap on a clip (Swap and Templates). */
export function priceSwap(seconds: number): Priced {
  if (seconds > DEMO_LIMITS.swapSeconds + 0.05) return { error: `The live demo swaps up to ${DEMO_LIMITS.swapSeconds} s of a clip.` };
  return { credits: PRICES.swap };
}
