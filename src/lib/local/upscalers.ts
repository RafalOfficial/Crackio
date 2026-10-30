/**
 * The upscalers the Upscale tool offers on your own GPU, best first: what each is good at, for pictures and for clips, and
 * the GPU memory it runs whole in. Client-safe. Ranked from side-by-side comparisons and Crackio's own runs
 * (.research/upscalers.md); every one runs through ComfyUI on whichever of your machines has it.
 */

export type Upscaler = {
  /** Its model id in Crackio's catalog. */
  id: string;
  name: string;
  /** One or two words on where it stands. */
  tier: "Best detail" | "Balanced" | "Fast" | "Fastest";
  image: boolean;
  video: boolean;
  /** GPU memory it runs whole in; less still runs, more slowly. */
  needGb: number;
  /** What it's like, in a sentence. */
  note: string;
};

export const UPSCALERS: Upscaler[] = [
  {
    id: "local:seedvr2-7b",
    name: "SeedVR2 7B",
    tier: "Best detail",
    image: true,
    video: true,
    needGb: 11,
    note: "One-step diffusion restoration: the closest to real footage in Crackio's tests, keeping faces, text and texture true and steady from frame to frame.",
  },
  {
    id: "local:seedvr2-3b",
    name: "SeedVR2 3B",
    tier: "Balanced",
    image: true,
    video: true,
    needGb: 9,
    note: "7B's method in less memory, the pick for 12–16 GB cards. For clips it isn't faster than 7B and lands further from the real thing.",
  },
  {
    id: "local:nomos2-hq",
    name: "Nomos2 HQ",
    tier: "Balanced",
    image: true,
    video: false,
    needGb: 4,
    note: "A transformer upscaler trained on clean pictures: crisp edges and text from AI renders, nothing invented.",
  },
  {
    id: "local:nomos-webphoto",
    name: "Nomos WebPhoto",
    tier: "Fast",
    image: true,
    video: false,
    needGb: 2,
    note: "For real photos: cleans JPEG and web compression while it sharpens.",
  },
  {
    id: "local:flashvsr-plus",
    name: "FlashVSR+",
    tier: "Fast",
    image: false,
    video: true,
    needGb: 16,
    note: "Built for clips at 4×: next closest to real footage after SeedVR2 7B, in half its time; on clean AI clips it sharpens past the original. NVIDIA RTX 30 or newer.",
  },
  {
    id: "local:realesrgan-x4",
    name: "Real-ESRGAN",
    tier: "Fastest",
    image: true,
    video: true,
    needGb: 2,
    note: "A classic GAN that invents nothing: the closest to the original on clean AI clips, and the steadiest. Runs on any machine, even without a GPU.",
  },
];

/**
 * Clips, best first, from Crackio's two tests (5 s clips shrunk to about 480p, brought back up and compared with their
 * original frames, LPIPS). Live-action footage: SeedVR2 7B 0.106, FlashVSR+ 0.121 in half the time, Real-ESRGAN 0.131,
 * SeedVR2 3B 0.172. Crackio's own LTX clip, clean and smooth: Real-ESRGAN 0.109, SeedVR2 7B 0.118, FlashVSR+ 0.161,
 * SeedVR2 3B 0.190 (the diffusion ones add texture that wasn't there).
 */
const CLIP_ORDER = ["local:seedvr2-7b", "local:flashvsr-plus", "local:realesrgan-x4", "local:seedvr2-3b"];
export const VIDEO_UPSCALERS = UPSCALERS.filter((u) => u.video).sort((a, b) => CLIP_ORDER.indexOf(a.id) - CLIP_ORDER.indexOf(b.id));

/** The heights a clip can be upscaled to. */
export const CLIP_TARGETS = [
  { value: "1080p", label: "1080p", height: 1080 },
  { value: "1440p", label: "2K", height: 1440 },
  { value: "2160p", label: "4K", height: 2160 },
] as const;

/** The size a clip comes out at: its short side at the height asked, at most 4× and 3840 px on the long side (even pixels). */
export function upscaledSize(width: number, height: number, target: number) {
  const factor = Math.max(1, Math.min(target / Math.min(width, height), 4, 3840 / Math.max(width, height)));
  const even = (n: number) => Math.round(n / 2) * 2;
  return { width: even(width * factor), height: even(height * factor), factor };
}
