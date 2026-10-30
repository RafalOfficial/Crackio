"use client";

import { create } from "zustand";
import { Euler, MathUtils, PerspectiveCamera, Vector3 } from "three";
import { extendFrame, useDirector } from "@/lib/director/store";
import { shotCamera } from "@/lib/director/camera";
import type { Scene, WorldDepth, WorldLight } from "@/lib/director/types";
import { sizeFor } from "@/lib/shot";
import { askForModel } from "@/lib/hooks/use-model-choice";
import { capturePlateFrom } from "./stage/capture";
import { placeModel } from "./place-model";
import { usePlaceSize } from "./shot-model";
import { sharpWhenReady } from "./around";

/** An extend in progress (what it's doing), or why it couldn't be done. */
export const useExtend = create<{ stage: string | null; error: string | null }>(() => ({ stage: null, error: null }));

async function upload(blob: Blob) {
  const body = new FormData();
  body.append("file", new File([blob], "view.png", { type: "image/png" }));
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Couldn't save the view.");
  return data.items[0].url;
}

/**
 * The place as it is all around the shot camera's spot: the set's six square views from there (ahead, right, behind,
 * left, up, down, level and turned with the camera), gray where its world never saw. An extend builds its new world
 * into them (server/world `canvasAround`), so what was beside and behind you stays.
 */
async function aroundFrom(scene: Scene) {
  const cam = shotCamera(scene);
  const forward = cam.getWorldDirection(new Vector3());
  const yaw = Math.atan2(-forward.x, -forward.z);
  const faces: [number, number][] = [
    [0, 0],
    [-90, 0],
    [180, 0],
    [90, 0],
    [0, 90],
    [0, -90],
  ];
  const urls: string[] = [];
  for (const [turn, tilt] of faces) {
    const face = new PerspectiveCamera(90, 1, 0.05, 1000);
    face.position.copy(cam.position);
    face.quaternion.setFromEuler(new Euler(MathUtils.degToRad(tilt), yaw + MathUtils.degToRad(turn), 0, "YXZ"));
    face.updateMatrixWorld(true);
    urls.push(await upload(await capturePlateFrom(face, 1024, 1024)));
  }
  return urls;
}

/**
 * Extend the place where the camera looks ("this street goes on, a pub on the right"): what the camera sees now (the
 * set's own view, gray where the 360 never saw) is drawn again by the place's model as a real photo from this spot,
 * carried on as asked, and the place is made again around where the camera stands (server/extend, then the world)
 * into what it already was there: the set's views all around from here are kept, and only what they never saw and
 * the photo's edges are drawn. Made from the photo alone, it was a whole new place (the user: extend INTO it).
 */
export async function extendPlace(words: string) {
  const { scene } = useDirector.getState();
  if (!scene.place.image?.view || useExtend.getState().stage) return;
  const model = placeModel();
  if (model === "auto") {
    if (!askForModel("image")) useExtend.setState({ error: "Choose the model that makes the place first." });
    return;
  }
  useExtend.setState({ stage: "Looking where the camera looks", error: null });
  try {
    // Where the camera stands now: the new place is made from here even if the camera moves on meanwhile.
    const frame = extendFrame(scene);
    const { width, height } = sizeFor(scene.aspect, 1536);
    const view = await upload(await capturePlateFrom(shotCamera(scene), width, height));
    const around = scene.place.world?.depth ? await aroundFrom(scene) : null;
    useExtend.setState({ stage: "Drawing the place on from here" });
    const res = await fetch("/api/director/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: view, place: scene.place.text, words, model, aspect: scene.aspect, resolution: usePlaceSize.getState().size }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; error?: string };
    if (!res.ok || !data.url || !data.width || !data.height) throw new Error(data.error ?? "The model couldn't extend the place.");
    // Someone changed the place meanwhile: theirs stands.
    if (useDirector.getState().scene.place.image?.url !== scene.place.image.url) return;
    const photo = { url: data.url, width: data.width, height: data.height };
    if (!around) return useDirector.getState().extendPlaceTo(photo, frame);
    // Built into the place it had all around (the world's measuring comes with it).
    useExtend.setState({ stage: "Building it into the place around you" });
    const built = await fetch("/api/director/world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: photo.url, view: frame.view, place: scene.place.text, model, around }),
    });
    const world = (await built.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; depth?: WorldDepth; light?: WorldLight; error?: string };
    if (!built.ok || !world.url || !world.width || !world.height) throw new Error(world.error ?? "The model couldn't build the place on.");
    if (useDirector.getState().scene.place.image?.url !== scene.place.image.url) return;
    const { extendPlaceTo, setWorldDepth } = useDirector.getState();
    extendPlaceTo(photo, frame, { url: world.url, width: world.width, height: world.height });
    if (world.depth && world.light) setWorldDepth(world.url, world.depth, world.light);
    void sharpWhenReady(world.url);
  } catch (err) {
    useExtend.setState({ error: (err as Error).message });
  } finally {
    useExtend.setState({ stage: null });
  }
}
