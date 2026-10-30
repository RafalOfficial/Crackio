/**
 * The sizes a picture from an open model (Local, on ComfyUI) can be made at, and the knobs its Advanced section offers.
 * Client-safe: the pickers and the engine share these.
 *
 * Draft, 720p and 1K are about the size these models were trained at; 2K and 4K are named by their long edge, the way
 * screens are (4K is 3840 px wide at 16:9). A model renders natively up to the most it handles well (`maxMp`, local
 * catalog); past that the picture is made at that size and enlarged to the one asked for with Real-ESRGAN, which sharpens
 * what's there rather than inventing new detail.
 */

export type ResolutionId = "draft" | "720p" | "1k" | "2k" | "4k";

export const IMAGE_RESOLUTIONS: { value: ResolutionId; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "720p", label: "720p" },
  { value: "1k", label: "1K" },
  { value: "2k", label: "2K" },
  { value: "4k", label: "4K" },
];

export const DEFAULT_RESOLUTION: ResolutionId = "1k";

const snap = (n: number, grid = 16) => Math.max(grid, Math.round(n / grid) * grid);

/** Width × height of a picture at a resolution, in a shape (width / height), on a grid of 16. */
export function imagePixels(id: string | undefined, ratio: number): { width: number; height: number; mp: number } {
  const r = Math.min(3, Math.max(1 / 3, ratio || 1));
  const byArea = (mp: number) => {
    const h = Math.sqrt((mp * 1e6) / r);
    return { width: h * r, height: h };
  };
  const byLong = (edge: number) => (r >= 1 ? { width: edge, height: edge / r } : { width: edge * r, height: edge });
  const raw =
    id === "draft"
      ? byArea(0.35)
      : id === "720p"
        ? r >= 1
          ? { width: 720 * r, height: 720 }
          : { width: 720, height: 720 / r }
        : id === "2k"
          ? byLong(2048)
          : id === "4k"
            ? byLong(3840)
            : byArea(1.05);
  const width = snap(raw.width);
  const height = snap(raw.height);
  return { width, height, mp: (width * height) / 1e6 };
}

/** A picture's size from its megapixels, in a shape, its longer side at most `edge`. */
export function pixelsAt(mp: number, ratio: number, edge = Infinity) {
  const r = Math.min(3, Math.max(1 / 3, ratio || 1));
  const h = Math.min(Math.sqrt((mp * 1e6) / r), edge / Math.max(r, 1), edge);
  return { width: snap(Math.min(h * r, edge)), height: snap(h) };
}

/**
 * What a local model's Advanced section offers, from the graph it runs: denoising steps (none when its schedule is a fixed
 * list, as distilled few-step models' often are), guidance (CFG), a negative prompt (it only counts with guidance above 1),
 * and the seed.
 */
export type Tuning = {
  steps: { default: number; min: number; max: number } | null;
  cfg: { default: number; min: number; max: number } | null;
  negative: boolean;
  seed: boolean;
};

/** The Advanced section's values, in a job's options. */
export type TuningOptions = { negative?: string; steps?: number; cfg?: number; seed?: number };

export function tuningFor(steps: number | null, cfg: number | null, stepsFixed = false): Tuning {
  return {
    steps: steps && !stepsFixed ? { default: steps, min: 1, max: Math.max(80, steps * 2) } : null,
    cfg: cfg !== null ? { default: cfg, min: 1, max: 20 } : null,
    negative: true,
    seed: true,
  };
}
