"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useModelsStore } from "@/lib/hooks/use-models";
import { DIRECTOR_MODELS } from "./models";
import { useShotModel } from "./shot-model";

/**
 * The model that makes the place: lifts its things out of the photo, builds it all around, fills in what the photo
 * doesn't show when you shoot. Null: the model you shoot with.
 */
export const usePlaceModel = create<{ model: string | null }>()(persist(() => ({ model: null as string | null }), { name: "crackio-director-place-model" }));

/** The place's model as it runs: the one chosen for the place, else the shot's. */
export function placeModel() {
  const own = usePlaceModel.getState().model;
  return own && own !== "auto" ? own : useShotModel.getState().model;
}

/**
 * The place's model once it can be known: on a first visit the model list is still loading when someone presses
 * Create, and "auto" opened the model drawer instead of making the place (Director v2's test). Waits up to 10 s for the
 * list, then takes the first place model that's ready; null when none is.
 */
export async function readyPlaceModel(): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    const chosen = placeModel();
    if (chosen && chosen !== "auto") return chosen;
    const models = useModelsStore.getState().models;
    const ready = DIRECTOR_MODELS.find((id) => models.find((m) => m.id === id)?.available);
    if (ready) return ready;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The 360 place maker trained for exactly this (nomadoor's FLUX.2 klein 4B LoRA, Apache-2.0). */
export const WORLD_360 = "local:flux2-klein-base-4b-360";
/**
 * The challenge winner's 360 place maker (nomadoor's ComfyUI-Panorama-Stickers): Qwen-Image 2.1 with his 360 panorama
 * LoRA (Qwen Research License: non-commercial).
 */
export const WORLD_360_QWEN = "local:qwen-image-2.1-360";

/**
 * The model that draws the place all around: a 360 maker whenever one is ready on a GPU (one seamless, level panorama
 * where general models pasted the photo as a framed picture into another world: an astronaut test photo, 2026-11-12), the
 * challenge winner's first (klein 360 left the astronaut's beach dark, empty fog away from the photo), else the place's
 * model.
 */
export function worldModel() {
  const models = useModelsStore.getState().models;
  return [WORLD_360_QWEN, WORLD_360].find((id) => models.find((m) => m.id === id)?.available) ?? placeModel();
}
