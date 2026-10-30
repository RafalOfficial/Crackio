"use client";

import { create } from "zustand";
import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { useDirector } from "@/lib/director/store";
import { angleDelta } from "@/lib/director/camera";
import { photoCamera } from "@/lib/director/reconstruct";
import { capturePlateFrom, loadedViews } from "./stage/capture";
import { placeModel } from "./place-model";
import type { WorldDepth, WorldLight } from "@/lib/director/types";

/**
 * The place all around the photo's spot, from one photo: the view turned 60 degrees is rendered (what the photo showed
 * where it overlaps, gray where it didn't), a model fills only the gray, carrying on what borders it, and the result
 * joins the set as another photo at that turn; the next turn builds on it, then the next. A landmark stays where the
 * photo has it, so turning away from a gas station shows the coast, not a second gas station.
 */
export const useAround = create<{ busy: boolean; done: number; total: number; error: string | null }>(() => ({ busy: false, done: 0, total: 0, error: null }));

/**
 * The views to build, as the user laid it out: each keeps the outer third of the one before it and the model expands the
 * rest, to the right, then to the left, and so on outward; the last one, behind, has both chains' ends at its edges and
 * only its middle to draw, which closes the circle. A 58 degree photo: 36 degree steps, nine views.
 */
export function turnsFor(vfov: number, aspect: number) {
  const width = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(vfov / 2)) * aspect));
  const n = Math.max(2, Math.ceil(180 / ((width * 2) / 3)));
  const step = 180 / n;
  const turns: number[] = [];
  for (let k = 1; k < n; k++) turns.push(-Math.round(k * step), Math.round(k * step));
  turns.push(180);
  return turns;
}

async function upload(blob: Blob) {
  const body = new FormData();
  body.append("file", new File([blob], "view.png", { type: "image/png" }));
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Couldn't save the view.");
  return data.items[0].url;
}

const until = async (ok: () => boolean, ms: number) => {
  for (let t = 0; t < ms; t += 400) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

/** Build the place all around (or just the views at `only`, drawn again). */
export async function buildAround(only?: number[]) {
  const start = useDirector.getState().scene;
  const image = start.place.image;
  if (!image?.view || useAround.getState().busy) return;
  if (placeModel() === "auto") {
    useAround.setState({ error: "Choose the model that makes the place first." });
    return;
  }
  const turns = turnsFor(image.view.fov, image.width / image.height);
  const near = (360 / turns.length) * 0.5;
  const todo = only ?? turns.filter((t) => !(start.place.more ?? []).some((p) => Math.abs(angleDelta(p.turn, t)) < near));
  useAround.setState({ busy: true, done: 0, total: todo.length, error: null });
  try {
    const aspect = image.width / image.height;
    const width = aspect >= 1 ? 1344 : Math.round(1344 * aspect);
    const height = aspect >= 1 ? Math.round(1344 / aspect) : 1344;
    for (const turn of todo) {
      const scene = useDirector.getState().scene;
      if (scene.place.image?.url !== image.url) return; // another place meanwhile
      const pose = photoCamera(image.view, scene.place.scale ?? 1);
      const cam = new PerspectiveCamera(image.view.fov, aspect, 0.05, 1000);
      cam.position.copy(pose.position);
      cam.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(turn)).multiply(pose.quaternion));
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const view = await upload(await capturePlateFrom(cam, width, height));
      const res = await fetch("/api/director/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: view, place: scene.place.text, photo: image.url, model: placeModel(), bridge: Math.abs(turn) >= 179 }),
      });
      const filled = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; error?: string };
      if (!res.ok || !filled.url) throw new Error(filled.error ?? "The model couldn't fill that view.");
      useDirector.getState().addPlacePhoto({ url: filled.url, width: filled.width ?? width, height: filled.height ?? height }, turn);
      // On screen first, so the next turn sees it.
      await until(() => loadedViews.has(filled.url!), 90_000);
      await new Promise((r) => setTimeout(r, 800));
      useAround.setState((s) => ({ done: s.done + 1 }));
    }
  } catch (err) {
    useAround.setState({ error: (err as Error).message });
  } finally {
    useAround.setState({ busy: false });
  }
}

/**
 * The place all around as one 360 picture (server/world), by the place's model: one world with one light, where the
 * views built one by one came out as different worlds side by side. `again` draws it anew.
 */
export const useWorld = create<{ busy: boolean; error: string | null; measuring: boolean }>(() => ({ busy: false, error: null, measuring: false }));

/** Bumped when the measuring changes: worlds measured before are measured again. */
export const WORLD_DEPTH_VERSION = 8;

/**
 * The world measured (server/world-depth): how far everything in it is, so the set is a place you walk into, and its
 * light, put on the set the first time. Without it the world stays a backdrop around the camera.
 */
export async function measureWorld() {
  const scene = useDirector.getState().scene;
  const world = scene.place.world;
  if (!world || useWorld.getState().measuring) return;
  useWorld.setState({ measuring: true });
  try {
    const res = await fetch("/api/director/world-depth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: world.url, eye: scene.place.image?.view?.height ?? 1.6 }),
    });
    const data = (await res.json().catch(() => ({}))) as { depth?: WorldDepth; light?: WorldLight; error?: string };
    if (!res.ok || !data.depth || !data.light) throw new Error(data.error ?? "Couldn't measure the place.");
    useDirector.getState().setWorldDepth(world.url, data.depth, data.light);
  } catch (err) {
    console.warn("[director] world depth:", (err as Error).message);
  } finally {
    useWorld.setState({ measuring: false });
  }
}

/**
 * The world's 8K picture, sharpened on the server after the world was handed over (about a minute from a rented GPU):
 * swapped in when it's ready, while the place is still this world.
 */
export async function sharpWhenReady(url: string) {
  for (let tries = 0; tries < 60; tries++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (useDirector.getState().scene.place.world?.url !== url) return;
    const data = (await fetch(`/api/director/world?sharp=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .catch(() => ({ pending: true }))) as { url?: string; width?: number; height?: number; pending?: boolean };
    if (data.url && data.width && data.height) return useDirector.getState().sharpenWorld(url, { url: data.url, width: data.width, height: data.height });
    if (!data.pending) return;
  }
}

/** "about 50 s", "about 1 min", "about 2½ min". */
export function aboutTime(seconds: number) {
  if (seconds < 75) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} s`;
  const halves = Math.round(seconds / 30);
  return `about ${Math.floor(halves / 2) || ""}${halves % 2 ? "½" : ""} min`;
}

/** How long a new place usually takes here (seconds: its photo, its world), from the runs the server kept. */
export const useTypical = create<{ photo: number | null; world: number | null; loaded: boolean }>(() => ({ photo: null, world: null, loaded: false }));
export function loadTypical() {
  if (useTypical.getState().loaded) return;
  useTypical.setState({ loaded: true });
  void fetch("/api/director/world")
    .then((r) => r.json())
    .then((t: { photo?: number | null; world?: number | null }) => useTypical.setState({ photo: t.photo ?? null, world: t.world ?? null }))
    .catch(() => undefined);
}

export async function buildWorld(again = false) {
  const scene = useDirector.getState().scene;
  const image = scene.place.image;
  if (!image?.view || useWorld.getState().busy) return;
  if (placeModel() === "auto") {
    useWorld.setState({ error: "Choose the model that makes the place first." });
    return;
  }
  useWorld.setState({ busy: true, error: null });
  try {
    const res = await fetch("/api/director/world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: image.url, view: image.view, place: scene.place.text, model: placeModel(), fresh: again }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; depth?: WorldDepth; light?: WorldLight; error?: string };
    if (!res.ok || !data.url || !data.width || !data.height) throw new Error(data.error ?? "The model couldn't draw the place.");
    if (useDirector.getState().scene.place.image?.url !== image.url) return; // another place meanwhile
    useDirector.getState().setPlaceWorld({ url: data.url, width: data.width, height: data.height });
    // Measured before it was handed over: a place to walk into right away.
    if (data.depth && data.light) useDirector.getState().setWorldDepth(data.url, data.depth, data.light);
    void sharpWhenReady(data.url);
  } catch (err) {
    useWorld.setState({ error: (err as Error).message });
  } finally {
    useWorld.setState({ busy: false });
    // This run's time counts toward the next estimate.
    useTypical.setState({ loaded: false });
    loadTypical();
  }
}
