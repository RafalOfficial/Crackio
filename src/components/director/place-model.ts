"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
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
