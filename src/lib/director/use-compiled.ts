"use client";

import { useShallow } from "zustand/react/shallow";
import { useDirector } from "./store";
import { compileScene, type CompiledShot } from "./compile";
import type { Scene } from "./types";

const compiled = new WeakMap<Scene, CompiledShot>();

/** A scene compiled once, however many panels ask (each change compiled it three to five times). */
export function compiledOf(scene: Scene): CompiledShot {
  let c = compiled.get(scene);
  if (!c) {
    c = compileScene(scene);
    compiled.set(scene, c);
  }
  return c;
}

/** The current scene, compiled into a prompt and shot sheet. Recomputes on every scene change. */
export function useCompiled() {
  return compiledOf(useDirector((s) => s.scene));
}

/**
 * The scene without its notes, for panels that show the camera, the light and the cast: typing in the prompt bar
 * doesn't redraw them. The same object until something besides the notes changes.
 */
export function useSetScene(): Scene {
  return useDirector(useShallow((s) => ({ ...s.scene, notes: "" })));
}

/** The shot sheet and measurements (shot size, angle, lens), which the notes don't change. */
export function useShotCompiled() {
  return compiledOf(useSetScene());
}
