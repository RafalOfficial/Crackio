"use client";

import { create } from "zustand";
import { MathUtils, PerspectiveCamera, Raycaster, Vector2 } from "three";
import { useDirector } from "@/lib/director/store";
import { photoCamera } from "@/lib/director/reconstruct";
import type { ElementKind } from "@/lib/director/types";
import { drawAllSides } from "./intake";
import { placeModel } from "./place-model";

/**
 * The cars, people and objects a place photo shows, lifted out of it onto the set (server/director `liftThings`): each
 * stands where the photo has it, turned the way it faces there, and is drawn from the camera's angle like anything
 * staged, instead of being a relief of the photo's one side that smears and melts as the camera moves (the user's gas
 * station Mustang). The photo is then the place without them.
 */
export const useLift = create<{ busy: string | null; error: string | null }>(() => ({ busy: null, error: null }));

type Thing = {
  kind: ElementKind;
  box: [number, number, number, number];
  cutout: { url: string; width: number; height: number };
  read: { kind: ElementKind; noun: string; identity: string; height: number | null; around: number | null } | null;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function liftFromPlace() {
  const scene = useDirector.getState().scene;
  const image = scene.place.image;
  if (!image?.view || scene.place.lifted || useLift.getState().busy || placeModel() === "auto") return;
  useLift.setState({ busy: "Looking for cars, people and things in the photo", error: null });
  try {
    const res = await fetch("/api/director/things", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: image.url, place: scene.place.text, model: placeModel() }),
    });
    const data = (await res.json().catch(() => ({}))) as { things?: Thing[]; clean?: { url: string; width: number; height: number } | null; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Couldn't look through the photo.");
    const now = useDirector.getState().scene;
    if (now.place.image?.url !== image.url || !now.place.image.view) return; // another place meanwhile
    const view = now.place.image.view;
    const scale = now.place.scale ?? 1;
    const pose = photoCamera(view, scale);
    const cam = new PerspectiveCamera(view.fov, image.width / image.height, 0.05, 1000);
    cam.position.copy(pose.position);
    cam.quaternion.copy(pose.quaternion);
    cam.updateMatrixWorld(true);
    const ray = new Raycaster();
    const { addElement, updateElement, swapPlacePhoto } = useDirector.getState();
    for (const t of data.things ?? []) {
      // Where it stands: the ray through the bottom middle of its outline, down to the floor.
      ray.setFromCamera(new Vector2(((t.box[0] + t.box[2]) / 2000) * 2 - 1, 1 - (t.box[3] / 1000) * 2), cam);
      const d = ray.ray.direction;
      if (d.y > -0.005) continue;
      const along = -ray.ray.origin.y / d.y;
      if (along > 80) continue;
      const x = ray.ray.origin.x + d.x * along;
      const z = ray.ray.origin.z + d.z * along;
      const kind = t.read?.kind ?? t.kind;
      const noun = t.read?.noun?.replace(/^(a|an|the)\s+/i, "") ?? kind;
      const id = addElement({
        kind,
        name: capitalize(noun).slice(0, 40),
        fromPlace: true,
        ...(t.read?.height ? { height: t.read.height } : {}),
        image: { url: t.cutout.url, width: t.cutout.width, height: t.cutout.height, cutout: true, sourceUrl: t.cutout.url },
        ...(t.read ? { read: { noun: t.read.noun, identity: t.read.identity, around: t.read.around ?? 0 } } : {}),
      });
      // Turned the way it faces in the photo: the side the photo shows, from where the photo was taken.
      const toward = MathUtils.radToDeg(Math.atan2(cam.position.x - x, cam.position.z - z));
      const yaw = ((((toward - (t.read?.around ?? 0)) % 360) + 540) % 360) - 180;
      updateElement(id, { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(yaw) }, true);
      void drawAllSides(id);
    }
    swapPlacePhoto(data.clean ?? null);
  } catch (err) {
    useLift.setState({ error: (err as Error).message });
  } finally {
    useLift.setState({ busy: null });
  }
}
