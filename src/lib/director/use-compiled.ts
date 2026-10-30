"use client";

import { useMemo } from "react";
import { useDirector } from "./store";
import { compileScene } from "./compile";

/** The current scene, compiled into a prompt and shot sheet. Recomputes on every scene change. */
export function useCompiled() {
  const scene = useDirector((s) => s.scene);
  return useMemo(() => compileScene(scene), [scene]);
}
