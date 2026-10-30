import { PRICES } from "./price-list";

/**
 * What the live demo holds for a job before it runs, in credits: the same price list the server charges from
 * (lib/demo/prices), worked out in the page for the settings on screen. A job is charged for the GPU time it really
 * uses, at RunPod's price, up to this; what it doesn't use comes back.
 */
export function demoCredits(job: {
  kind: "image" | "video" | "upscale";
  count?: number;
  resolution?: string;
  /** A clip's seconds. */
  duration?: number;
  /** Retouch, Relight, Angles: an edit is priced as about one megapixel, whatever size it's drawn at. */
  edit?: boolean;
  /** An upscale of a clip, and its seconds. */
  clipSeconds?: number;
}): number {
  const perClip = (base: number, seconds: number) => Math.ceil(base * Math.max(1, seconds / 5));
  if (job.kind === "video") {
    const base = PRICES.clip[(job.resolution ?? "720p").toLowerCase()] ?? PRICES.clip["720p"];
    return perClip(base, job.duration ?? 5);
  }
  if (job.kind === "upscale") return job.clipSeconds ? perClip(PRICES.upscaleClip, job.clipSeconds) : PRICES.upscalePicture;
  const res = job.edit ? "1k" : (job.resolution ?? "1k").toLowerCase();
  const base = PRICES.picture[res] ?? PRICES.picture["1k"];
  return base + (Math.max(1, Math.min(4, job.count ?? 1)) - 1) * PRICES.extraPicture;
}

/** A swap (Swap, Templates): one flat price for any clip up to the demo's swap limit (lib/demo/prices priceSwap). */
export const demoSwapCredits = () => PRICES.swap;

/** The tooltip beside every estimate. */
export const DEMO_CREDITS_HINT = "You pay for the GPU time the job really uses, at RunPod's price; this is the most it holds. Unused credits come back.";
