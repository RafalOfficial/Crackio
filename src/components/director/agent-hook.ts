"use client";

import { useDirector } from "@/lib/director/store";
import { sizeFor } from "@/lib/shot";
import { useDirectorShot, useShotSize } from "./shot-model";
import { captureShot } from "./stage/capture";

/**
 * The page's own Shoot, its last error and the model it would shoot with, as the prompt bar has them now (it writes
 * them here on every render): an agent's shot is the same Shoot a click makes.
 */
export const agentShoot: { run: null | (() => Promise<void>); error: string | null; model: string } = { run: null, error: null, model: "auto" };

/**
 * For Crackio's own hidden browser page (lib/agent/director): the Director's scene and its camera view, reachable from
 * outside React, so an agent can open a place, move the camera and see what the camera sees. The view is the same
 * capture a shot uses, so what the agent sees is what gets shot. Only on a page opened with ?agent=1.
 */
export function installAgentHook() {
  if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("agent")) return;
  const w = window as unknown as { __crackioAgent?: unknown };
  if (w.__crackioAgent) return;
  w.__crackioAgent = {
    scene: () => useDirector.getState().scene,
    /** A store action by name ("setPlace", "setCamera", "applyAngle"…), with its arguments. */
    act: (name: string, ...args: unknown[]) => {
      const fn = (useDirector.getState() as unknown as Record<string, unknown>)[name];
      if (typeof fn !== "function") throw new Error(`The Director has no action "${name}".`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    },
    /** What the camera sees now, as a JPEG data URL, its long side `long` pixels. */
    async view(long = 768) {
      const size = sizeFor(useDirector.getState().scene.aspect, long);
      const shot = await captureShot(size.width, size.height);
      const bitmap = await createImageBitmap(shot.guide);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.85);
    },
    /** The model and size shots are made with (the picker under the camera). */
    setShot: (model?: string, size?: string) => {
      if (model) useDirectorShot.setState({ model });
      if (size) useShotSize.setState({ size });
    },
    shotModel: () => agentShoot.model,
    shootError: () => agentShoot.error,
    shoot: async () => {
      if (!agentShoot.run) throw new Error("The Director's prompt bar isn't on the page yet.");
      await agentShoot.run();
    },
  };
}
