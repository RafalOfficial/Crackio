"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The model Director shoots with (picked under the camera); subjects are drawn from every side with it too. */
export const useShotModel = create<{ model: string }>(() => ({ model: "auto" }));

/**
 * Which ControlNet model draws the shots (models.ts SHOT_MODELS): Z-Image Director (the most cinematic, 4 s) or Qwen
 * Director (keeps the cast's faces and clothes from their pictures, 14 s). Kept in this browser.
 */
export const useDirectorShot = create<{ model: string }>()(persist(() => ({ model: "" }), { name: "crackio-director-shot-model" }));

/**
 * How big shots are drawn, and how carefully (2K asks for each model's full version, comfy-local-recipes): 2K by default, where a face in a full-body two-shot is about 125 px tall (at 1K it was about
 * 80 and models drew soft, wrong eyes; the user's crop), at two to three times the time. 1K when speed matters.
 */
export const useShotSize = create<{ size: string }>()(persist(() => ({ size: "2k" }), { name: "crackio-director-shot-size" }));

/**
 * The people in the shot's depth (server/director-fresh): by default each one by their action ("auto": a pose to hold
 * keeps its stand-in, standing people act freely), or all free (the ground alone), a soft glow where each one stands,
 * or the stand-ins as they are, pose and all.
 */
/** How big the place is made (its picture, an extend's redraw, and the 360 world's drawing): 2K by default, 4K for the best. */
export const usePlaceSize = create<{ size: string }>()(persist(() => ({ size: "2k" }), { name: "crackio-director-place-size" }));

export type DepthFigures = "auto" | "none" | "soft" | "stand-ins";
export const useDepthFigures = create<{ figures: DepthFigures }>()(persist(() => ({ figures: "auto" as DepthFigures }), { name: "crackio-director-depth-figures-2" }));

type Choices = { choices: { value: string | number; label: string }[]; default: string | number | null } | null | undefined;

/** The size a shot is drawn at with this model: your pick when the model offers it, else 2K, else the model's own default. */
export function shotSizeFor(resolution: Choices, picked: string) {
  const values = (resolution?.choices ?? []).map((c) => String(c.value));
  if (!values.length) return picked;
  if (values.includes(picked)) return picked;
  if (values.includes("2k")) return "2k";
  return String(resolution?.default ?? values[0]);
}
