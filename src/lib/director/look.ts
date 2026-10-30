import { kelvinToRgb } from "./vocab";
import type { Scene } from "./types";
import { aspectById } from "@/lib/shot";

/**
 * What the camera does to the picture: depth of field from the lens and aperture, and a grade
 * from the light's color, the mood and the style. Director's preview and the layout guide sent
 * to the model both go through it, so what you see is what the model is asked for.
 */
export type ShotLook = {
  /** Thin-lens depth of field. Distances in meters, focal length in meters. */
  focus: number;
  focal: number;
  aperture: number;
  /** Sensor height in meters for the frame's aspect (full-frame diagonal). */
  sensor: number;
  /** Largest blur radius, as a share of the frame height. */
  maxBlur: number;
  exposure: number;
  /** Per-channel white balance multiplier. */
  balance: [number, number, number];
  contrast: number;
  saturation: number;
  /** Colors pushed into the shadows and highlights (split toning), with strength in the 4th value. */
  shadows: [number, number, number, number];
  highlights: [number, number, number, number];
  /** Lift of the blacks (faded film). */
  lift: number;
  vignette: number;
  grain: number;
};

type Grade = Partial<Omit<ShotLook, "focus" | "focal" | "aperture" | "sensor" | "maxBlur" | "balance">>;

const MOOD_GRADES: Record<string, Grade> = {
  golden: { exposure: 1.04, contrast: 1.08, saturation: 1.12, highlights: [1, 0.72, 0.38, 0.16], shadows: [0.45, 0.25, 0.2, 0.06] },
  midday: { exposure: 1.06, contrast: 1.16, saturation: 1.02 },
  overcast: { exposure: 0.98, contrast: 0.86, saturation: 0.86, shadows: [0.55, 0.6, 0.66, 0.05] },
  "blue-hour": { exposure: 0.8, contrast: 0.95, saturation: 0.92, shadows: [0.2, 0.32, 0.62, 0.16], highlights: [0.75, 0.8, 1, 0.06] },
  "night-neon": { exposure: 0.74, contrast: 1.12, saturation: 1.18, shadows: [0.12, 0.42, 0.6, 0.16], highlights: [1, 0.35, 0.8, 0.1] },
  studio: { exposure: 1.04, contrast: 0.98, saturation: 1 },
  candle: { exposure: 0.66, contrast: 1.14, saturation: 1.05, highlights: [1, 0.62, 0.3, 0.18], shadows: [0.3, 0.15, 0.08, 0.1] },
  moonlight: { exposure: 0.62, contrast: 1.04, saturation: 0.72, shadows: [0.18, 0.26, 0.5, 0.18], highlights: [0.7, 0.8, 1, 0.08] },
};

const STYLE_GRADES: Record<string, Grade> = {
  photo: {},
  cinematic: { contrast: 1.06, saturation: 0.96, shadows: [0.1, 0.36, 0.42, 0.1], highlights: [1, 0.7, 0.45, 0.07], vignette: 0.28, grain: 0.035 },
  editorial: { contrast: 1.1, saturation: 1.04, vignette: 0.08 },
  documentary: { contrast: 0.97, saturation: 0.92, grain: 0.02 },
  product: { contrast: 1.08, saturation: 1.06 },
  analog: { contrast: 0.94, saturation: 0.88, lift: 0.05, highlights: [1, 0.86, 0.66, 0.1], vignette: 0.24, grain: 0.07 },
  anime: { contrast: 1.04, saturation: 1.22 },
  "3d": { contrast: 1.02, saturation: 1.1 },
  painting: { contrast: 0.96, saturation: 1.08, lift: 0.02 },
};

const NEUTRAL: Required<Grade> = {
  exposure: 1,
  contrast: 1,
  saturation: 1,
  shadows: [0.5, 0.5, 0.5, 0],
  highlights: [0.5, 0.5, 0.5, 0],
  lift: 0,
  vignette: 0,
  grain: 0,
};

function combine(a: Required<Grade>, b: Grade): Required<Grade> {
  return {
    exposure: a.exposure * (b.exposure ?? 1),
    contrast: a.contrast * (b.contrast ?? 1),
    saturation: a.saturation * (b.saturation ?? 1),
    shadows: b.shadows && b.shadows[3] > a.shadows[3] ? b.shadows : a.shadows,
    highlights: b.highlights && b.highlights[3] > a.highlights[3] ? b.highlights : a.highlights,
    lift: a.lift + (b.lift ?? 0),
    vignette: Math.max(a.vignette, b.vignette ?? 0),
    grain: Math.max(a.grain, b.grain ?? 0),
  };
}

/** The look for a scene, given how far the camera is from what it focuses on. */
export function shotLook(scene: Scene, focusDistance: number): ShotLook {
  const a = aspectById(scene.aspect);
  const sensor = Math.hypot(36, 24) / Math.sqrt((a.w / a.h) ** 2 + 1) / 1000;
  // White balance: the key light's color tints the whole frame, gently (the camera is set to ~5000K).
  const [r, g, b] = kelvinToRgb(scene.light.kelvin).map((c) => c / 255);
  const [nr, ng, nb] = kelvinToRgb(5200).map((c) => c / 255);
  const mix = 0.4;
  const balance: [number, number, number] = [1 + (r / nr - 1) * mix, 1 + (g / ng - 1) * mix, 1 + (b / nb - 1) * mix];
  const grade = combine(combine(NEUTRAL, STYLE_GRADES[scene.style] ?? {}), MOOD_GRADES[scene.light.mood ?? ""] ?? {});
  // Hard light reads punchier; soft light flatter.
  grade.contrast *= 1.05 - scene.light.softness * 0.1;
  return {
    focus: Math.max(0.2, focusDistance),
    focal: scene.camera.focal / 1000,
    aperture: scene.camera.aperture,
    sensor,
    maxBlur: 0.022,
    balance,
    ...grade,
  };
}

/**
 * The look of the blocking frame sent to the image model: the set as it is, sharp and ungraded. The prompt asks
 * for the focus, light and grade; blur, grain or a tint on the stand-ins and the place would only be copied.
 */
export function blockingLook(look: ShotLook): ShotLook {
  return {
    ...look,
    maxBlur: 0,
    exposure: 1,
    balance: [1, 1, 1],
    contrast: 1,
    saturation: 1,
    shadows: [0.5, 0.5, 0.5, 0],
    highlights: [0.5, 0.5, 0.5, 0],
    lift: 0,
    vignette: 0,
    grain: 0,
  };
}
