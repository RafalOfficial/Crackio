"use client";

import { create } from "zustand";

/**
 * Which view the stage shows: the camera view (your photos on set) or the model's view: the blocking frame the
 * image model gets, with a colored stand-in for each subject and the place's unknown parts in flat gray. `scout`: the
 * set seen from anywhere, with the shot camera standing in it, instead of through the lens (Director v2's Set tab).
 *
 * Director v2 (`v2`): one controller for both tabs (stage/Nav), the canvas fills the stage and the Camera tab shows the
 * shot's frame inside it with the world dimmed around (`fit`: how much taller the canvas is than the frame, and the
 * frame's aspect), and the Set tab shows a small live picture of the shot (`pip`, CSS px on the canvas).
 */
type StageView = {
  model: boolean;
  scout: boolean;
  v2: boolean;
  preview: boolean;
  fit: { scale: number; aspect: number };
  pip: { x: number; y: number; w: number; h: number };
};

export const useStageView = create<StageView>(() => ({
  model: false,
  scout: false,
  v2: false,
  preview: true,
  fit: { scale: 1, aspect: 1.5 },
  pip: { x: 0, y: 0, w: 0, h: 0 },
}));
