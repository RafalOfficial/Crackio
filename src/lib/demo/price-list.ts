/**
 * The live demo's prices in credits (1 cent is 2 credits), shared by the server's charges and the demo page. They're what
 * each job would cost on RunPod serverless with an RTX 5090 ($1.79 an hour, about $0.0005 a second), starting cold:
 * loading the model and the 5 s the worker idles after are billed too. So they stay true if the demo moves there.
 */
export const PRICES = {
  /** One picture (or an edit), by resolution; each extra picture in the same job adds `extraPicture`. */
  picture: { draft: 6, "720p": 6, "1k": 6, "2k": 7, "4k": 8 } as Record<string, number>,
  extraPicture: 2,
  /** A 5 s clip by resolution; longer clips cost in proportion. */
  clip: { "480p": 15, "512p": 15, "540p": 15, "704p": 15, "720p": 15, "1080p": 23, "1440p": 23 } as Record<string, number>,
  /** A swap or template run on a clip (up to the swap limit). */
  swap: 48,
  upscalePicture: 3,
  /** Upscaling a 5 s clip; longer clips cost in proportion. */
  upscaleClip: 20,
};
