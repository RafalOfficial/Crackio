"use client";

import { create } from "zustand";

/**
 * Which view the stage shows: the camera view (your photos on set) or the model's view: the blocking frame the
 * image model gets, with a colored stand-in for each subject and the place's unknown parts in flat gray. `scout`: the
 * set seen from anywhere, with the shot camera standing in it, instead of through the lens.
 */
export const useStageView = create<{ model: boolean; scout: boolean }>(() => ({ model: false, scout: false }));
