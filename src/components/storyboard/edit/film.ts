"use client";

import { create } from "zustand";
import type { FilmEngine } from "./engine";
import type { EditFile } from "@/lib/storyboard/edit";

/** The monitor's engine, for everything that moves the film (the timeline, the keys, the transport). */
let engine: FilmEngine | null = null;

export const setFilmEngine = (e: FilmEngine | null) => {
  engine = e;
};

export const film = {
  seek: (t: number) => engine?.seek(t),
  toggle: () => engine?.toggle(),
  play: () => engine?.play(),
  pause: () => engine?.pause(),
};

/** A file being dragged from the project's files (the timeline reads it while it's over a track). */
export const useFileDrag = create<{ file: EditFile | null }>(() => ({ file: null }));

export const FILE_DRAG = "application/x-crackio-edit-file";
