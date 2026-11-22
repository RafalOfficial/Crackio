"use client";

import { useDirector } from "@/lib/director/store";
import { askForModel } from "@/lib/hooks/use-model-choice";
import { placeModel, readyPlaceModel } from "./place-model";
import { usePlaceSize } from "./shot-model";
import { useLocation } from "./status";

// The busy flag lives in status.ts (no three.js there); still importable from here.
export { useLocation } from "./status";

/**
 * A place from words: one wide picture by the place's model becomes the location like a photo of your own, and its 360
 * world is built next (DirectorWorkspace). It's made empty, so there is nothing to lift out of it.
 */
export async function generateLocation(words: string) {
  const text = words.trim();
  if (!text || useLocation.getState().busy) return;
  useLocation.setState({ busy: true, error: null, since: Date.now(), words: text });
  const model = await readyPlaceModel();
  if (!model) {
    useLocation.setState({ busy: false, since: null });
    if (!askForModel("image")) useLocation.setState({ error: "Making a place needs a picture model: set one up on a GPU in Settings, or pick Nano Banana or FLUX 3 on your Comfy key." });
    return;
  }
  try {
    const res = await fetch("/api/director/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: text, model, resolution: usePlaceSize.getState().size }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; error?: string };
    if (!res.ok || !data.url || !data.width || !data.height) throw new Error(data.error ?? "The model couldn't draw the place.");
    const { scene, setPlace } = useDirector.getState();
    const aspect = scene.aspect;
    setPlace({ url: data.url, width: data.width, height: data.height }, text);
    // The shot keeps its shape (the place is drawn wide to cover more of the world).
    const now = useDirector.getState().scene;
    useDirector.setState({ scene: { ...now, aspect, place: { ...now.place, lifted: true } } });
  } catch (err) {
    useLocation.setState({ error: (err as Error).message });
  } finally {
    useLocation.setState({ busy: false, since: null });
  }
}
