"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import { MathUtils, Vector3 } from "three";
import type { CameraRig, ElementKind, LightRig, PlaceView, Scene, SceneElement, WorldDepth, WorldLight } from "./types";
import { ANGLES, ELEMENT_DEFAULTS, LIGHT_SETUPS, MOODS, SHOT_SIZES } from "./vocab";
import { cameraPosition, focusPoint, orbitFrom, shotCamera, verticalFov, yawTowardCamera } from "./camera";
import { keptInRoom } from "./room";
import { hiddenShare, photoCamera, photoFov, photoRig } from "./reconstruct";
import { readyDepths } from "./vision";
import { compileScene } from "./compile";
import { guessKind } from "./standin";
import { ASPECTS, aspectById, type AspectId } from "@/lib/shot";

export const DEFAULT_CAMERA: CameraRig = {
  azimuth: 0,
  elevation: 2,
  distance: 5.2,
  focal: 35,
  aperture: 2.8,
  roll: 0,
  focusHeight: 1.2,
  focusId: null,
};

export const DEFAULT_LIGHT: LightRig = { azimuth: 48, elevation: 35, softness: 0.4, kelvin: 4300, mood: null };

export const emptyScene = (): Scene => ({
  elements: [],
  place: { text: "" },
  camera: { ...DEFAULT_CAMERA },
  light: { ...DEFAULT_LIGHT },
  style: "cinematic",
  aspect: "3:2",
  notes: "",
});

type ElementInput = Partial<SceneElement> & { kind: ElementKind; name: string };
type PlaceImage = { url: string; width: number; height: number };

type DirectorState = {
  scene: Scene;
  selectedId: string | null;
  past: Scene[];
  future: Scene[];

  /** Save an undo point. Call once at the start of a drag, then update with `live`. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  select: (id: string | null) => void;
  addElement: (input: ElementInput) => string;
  updateElement: (id: string, patch: Partial<SceneElement>, live?: boolean) => void;
  removeElement: (id: string) => void;
  /** Aim the camera at an element without moving it; shot sizes then frame that element. */
  focusOn: (id: string) => void;
  setCamera: (patch: Partial<CameraRig>, live?: boolean) => void;
  setLight: (patch: Partial<LightRig>, live?: boolean) => void;
  setScene: (patch: Partial<Pick<Scene, "style" | "aspect" | "notes" | "place">>) => void;

  /** Use a photo as the location (or clear it). The camera moves to where the photo was taken. */
  setPlace: (image: PlaceImage | null, text?: string) => void;
  /** The 3D set for the location is built: remember how the photo was taken and look through it. */
  setPlaceView: (url: string, view: PlaceView) => void;
  setPlaceScale: (scale: number, live?: boolean) => void;
  /** Put the camera back where the location photo was taken. */
  toPhotoView: () => void;
  /** Another photo of the place from the same spot, facing another way; photos that weren't turned by hand spread evenly. */
  addPlacePhoto: (image: PlaceImage, turn?: number) => void;
  setPlacePhotoTurn: (url: string, turn: number, live?: boolean) => void;
  /** The main photo replaced by itself with its things lifted out: the camera and its 3D set's pose stay. */
  swapPlacePhoto: (image: PlaceImage | null) => void;
  /** The place's world, built or drawn again (or cleared). */
  setPlaceWorld: (world: { url: string; width: number; height: number } | null) => void;
  /**
   * Extend: the place made again from where the camera stands (`photo`, drawn from its view): the set turns and moves
   * so this camera is the new photo's camera (photo cameras look down -z from x = 0), the cast keeps its place around
   * it, and the new photo's 360 world is built next (DirectorWorkspace).
   */
  /**
   * The place made again from the shot camera's spot (extend): `frame` is where the camera was when it began (else
   * where it is now), `world` the new place's world when it was built with it.
   */
  extendPlaceTo: (photo: { url: string; width: number; height: number }, frame?: ExtendFrame, world?: { url: string; width: number; height: number }) => void;
  /** The world measured (server/world-depth): its depth, and its light put on the set the first time. */
  setWorldDepth: (url: string, depth: WorldDepth, light: WorldLight) => void;
  /** The same world in a sharper picture (sharpened after it was handed over): its measuring and light stay. */
  sharpenWorld: (url: string, sharp: { url: string; width: number; height: number }) => void;
  /** A view around the spot replaced by another drawing of it (redone, or changed in words): same turn, its set rebuilt. */
  replacePlacePhoto: (url: string, image: PlaceImage) => void;
  /** Its 3D set is built: remember how it was taken (not an undo step). */
  setPlacePhotoView: (url: string, view: PlaceView) => void;
  removePlacePhoto: (url: string) => void;

  applyAngle: (id: (typeof ANGLES)[number]["id"]) => void;
  applyShotSize: (id: (typeof SHOT_SIZES)[number]["id"]) => void;
  applyLens: (focal: number) => void;
  applyLightSetup: (id: (typeof LIGHT_SETUPS)[number]["id"]) => void;
  applyMood: (id: (typeof MOODS)[number]["id"] | null) => void;

  /** Bring back the whole set from an earlier take. */
  loadScene: (scene: Scene) => void;
  reset: () => void;
};

const HISTORY = 80;

/**
 * Scenes from before kinds were guessed added everything as a person: a "car" (or a long, low cut-out) becomes a
 * vehicle, so its stand-in and its words are a car's. A kind someone picked stays.
 */
function withGuessedKinds(scene: Scene): Scene {
  let changed = false;
  const elements = scene.elements.map((e) => {
    if (e.kindAuto !== undefined || e.kind !== "person") return e;
    const kind = guessKind(e.name, e.image?.cutout ? e.image.width / e.image.height : undefined);
    if (!kind || kind === "person") return e;
    changed = true;
    return { ...e, kind, kindAuto: true, height: e.height === ELEMENT_DEFAULTS.person.height ? ELEMENT_DEFAULTS[kind].height : e.height };
  });
  return changed ? { ...scene, elements } : scene;
}

export function mainElement(scene: Scene) {
  return scene.elements.find((e) => e.id === scene.camera.focusId) ?? scene.elements[0] ?? null;
}

export function nearestAspect(width: number, height: number): AspectId {
  const r = width / height;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? a : best)).id;
}

/**
 * Camera distance + focus height that frame the main element at a given shot size, measured
 * through the real camera (its tilt and lens included), so a tilted "medium shot" is still waist-up.
 */
function framingFor(given: Scene, sizeId: string, focal = given.camera.focal) {
  // Measured around the subject itself, not a point walked to.
  const scene: Scene = { ...given, camera: { ...given.camera, free: null } };
  const size = SHOT_SIZES.find((s) => s.id === sizeId) ?? SHOT_SIZES[3];
  const el = mainElement(scene);
  const height = el?.height ?? 1.7;
  const lift = el?.lift ?? 0;
  const isPerson = !el || el.kind === "person";
  const share = isPerson ? size.body : size.object;
  const extent = share * height;
  const a = aspectById(scene.aspect);
  const tanHalf = Math.tan((verticalFov(focal, a.w / a.h) * Math.PI) / 360);
  // What must fill the frame, and where its ends should land (NDC, -1 bottom … 1 top).
  const top = lift + height;
  const span =
    isPerson && share <= 1
      ? { hi: top, lo: top - extent, hiY: 0.9, loY: -1 } // a little headroom, the cut at the frame's bottom edge
      : { hi: lift + height / 2 + extent / 2, lo: lift + height / 2 - extent / 2, hiY: 0.94, loY: -0.94 };

  let distance = Math.max(0.35, (span.hi - span.lo) / ((span.hiY - span.loY) * tanHalf));
  let focusHeight = (span.hi + span.lo) / 2;
  const x = el?.x ?? 0;
  const z = el?.z ?? 0;
  const p = new Vector3();
  for (let i = 0; i < 8; i++) {
    const cam = shotCamera({ ...scene, camera: { ...scene.camera, focal, distance, focusHeight } });
    const yHi = p.set(x, span.hi, z).project(cam).y;
    const yLo = p.set(x, span.lo, z).project(cam).y;
    const have = yHi - yLo;
    if (!(have > 0.01)) break;
    distance = MathUtils.clamp(distance * (have / (span.hiY - span.loY)), 0.35, 150);
    const off = (yHi + yLo) / 2 - (span.hiY + span.loY) / 2;
    focusHeight = MathUtils.clamp(focusHeight + off * distance * tanHalf, 0, top + 3);
  }
  return { distance: Math.round(distance * 1000) / 1000, focusHeight: Math.round(focusHeight * 1000) / 1000, free: null };
}

/** A stand-in for the photo's camera until its 3D set is built: level, at eye height. */
function provisionalView(image: PlaceImage): PlaceView {
  const aspect = image.width / image.height;
  return { fov: photoFov(aspect), height: 1.6, pitch: 0, roll: 0, pivot: 6, near: 3, far: 40, floor: false };
}

/**
 * Look through the location photo's camera. The cast moves with the set's center so the
 * element the camera frames stands where the photo is centered.
 */
function alignedToPhoto(scene: Scene, view: PlaceView): Scene {
  const image = scene.place.image;
  if (!image) return scene;
  const a = aspectById(scene.aspect);
  const main = mainElement(scene);
  const dx = main?.x ?? 0;
  const dz = main?.z ?? 0;
  const elements = scene.elements.map((e) => ({ ...e, x: round(e.x - dx), z: round(e.z - dz) }));
  const rig = photoRig(view, image.width / image.height, a.w / a.h, scene.place.scale ?? 1);
  return { ...scene, elements, camera: { ...scene.camera, ...rig, focusId: main?.id ?? null, free: null } };
}

/** Where an extend makes the place again from: the shot camera as the new photo's camera, and where it stands. */
export type ExtendFrame = { view: PlaceView; x: number; z: number; heading: number };

export function extendFrame(scene: Scene): ExtendFrame {
  const cam = shotCamera(scene);
  const forward = cam.getWorldDirection(new Vector3());
  // The new photo's camera: this one (its lens, height, tilt and roll), looking at what it frames.
  const pitch = MathUtils.radToDeg(Math.asin(MathUtils.clamp(forward.y, -1, 1)));
  const view: PlaceView = { fov: cam.fov, height: Math.max(0.2, cam.position.y), pitch, roll: scene.camera.roll, pivot: Math.max(1, scene.camera.distance), near: 1.5, far: 60, floor: true };
  return { view, x: cam.position.x, z: cam.position.z, heading: Math.atan2(forward.x, -forward.z) };
}

export const useDirector = create<DirectorState>()(
  persist(
    (set, get) => {
      // Whatever moved it, the camera stays in the place's room (lib/director/room): zoomed or swung out through a
      // wall, it saw the place from outside.
      const commit = (next: Scene, live?: boolean) => {
        const camera = keptInRoom(next, next.camera);
        const scene = camera === next.camera ? next : { ...next, camera };
        set((s) => (live ? { scene } : { scene, past: [...s.past, s.scene].slice(-HISTORY), future: [] }));
      };

      return {
        scene: emptyScene(),
        selectedId: null,
        past: [],
        future: [],

        checkpoint: () => set((s) => ({ past: [...s.past, s.scene].slice(-HISTORY), future: [] })),
        undo: () =>
          set((s) => {
            const prev = s.past.at(-1);
            if (!prev) return s;
            return { scene: prev, past: s.past.slice(0, -1), future: [s.scene, ...s.future].slice(0, HISTORY) };
          }),
        redo: () =>
          set((s) => {
            const next = s.future[0];
            if (!next) return s;
            return { scene: next, future: s.future.slice(1), past: [...s.past, s.scene].slice(-HISTORY) };
          }),

        select: (selectedId) => set({ selectedId }),

        addElement: (input) => {
          const { scene } = get();
          const id = nanoid(8);
          const n = scene.elements.length;
          const anchor = mainElement(scene);
          const target = focusPoint(scene);
          const camPos = cameraPosition(scene.camera, target);
          // Newcomers line up beside the framed subject, across the frame from the camera's point of view.
          const right = new Vector3(camPos.z - target.z, 0, -(camPos.x - target.x)).normalize();
          if (!Number.isFinite(right.x)) right.set(1, 0, 0);
          const spread = [0, 0.95, -0.95, 1.8, -1.8, 2.6, -2.6];
          const offset = n === 0 ? 0 : spread[n % spread.length] || 0.95;
          const back = n > 2 ? 0.7 : 0;
          const toward = new Vector3(camPos.x - target.x, 0, camPos.z - target.z).normalize();
          const base = anchor ? { x: anchor.x, z: anchor.z } : { x: target.x, z: target.z };
          let x = round(base.x + right.x * offset - toward.x * back);
          let z = round(base.z + right.z * offset - toward.z * back);

          // If the location photo has a wall or a rock right there, step toward the camera until they're in view.
          const place = scene.place.image;
          const depth = place?.view ? readyDepths.get(place.url) : undefined;
          if (place?.view && depth) {
            const s = scene.place.scale ?? 1;
            const eye = photoCamera(place.view, s).position;
            const height = input.height ?? ELEMENT_DEFAULTS[input.kind].height;
            const width = height * (input.image ? Math.min(3, input.image.width / input.image.height) : 0.4);
            for (let i = 0; i < 30; i++) {
              if (hiddenShare(depth, place.view, s, place.width / place.height, { x, z, height, width, lift: input.lift ?? 0 }) < 0.1) break;
              const step = new Vector3(eye.x - x, 0, eye.z - z);
              if (step.length() < 1.6) break;
              step.multiplyScalar(0.08);
              x = round(x + step.x);
              z = round(z + step.z);
            }
          }

          const el: SceneElement = {
            id,
            x,
            z,
            height: ELEMENT_DEFAULTS[input.kind].height,
            lift: 0,
            yaw: Math.round(yawTowardCamera({ x, z } as SceneElement, camPos)),
            ...input,
          };
          const next: Scene = { ...scene, elements: [...scene.elements, el] };
          if (n === 0) {
            next.camera = { ...next.camera, focusId: id, free: null };
            // Walked somewhere first: the camera stays where it is, turned to them.
            if (scene.camera.free) Object.assign(next.camera, orbitFrom(camPos, new Vector3(x, scene.camera.focusHeight, z)));
            // They stepped forward: keep the camera exactly where and how it looks, with its pivot moved
            // onto them (the point of its line of sight right above where they stand).
            if (place && (x !== base.x || z !== base.z)) {
              const dir = target.clone().sub(camPos).normalize();
              const flat = dir.x * dir.x + dir.z * dir.z;
              const t = flat > 1e-6 ? ((x - camPos.x) * dir.x + (z - camPos.z) * dir.z) / flat : 1;
              const aim = camPos.clone().addScaledVector(dir, t);
              Object.assign(next.camera, orbitFrom(camPos, new Vector3(x, aim.y, z)), { focusHeight: aim.y });
            }
            // On an empty stage, frame the first subject so it's visible straight away. On a location,
            // they step onto the spot the camera is already looking at, and the camera stays put.
            if (!scene.place.image) Object.assign(next.camera, framingFor(next, el.kind === "person" ? "full" : "ms"));
          }
          commit(next);
          set({ selectedId: id });
          return id;
        },

        updateElement: (id, patch, live) => {
          const { scene } = get();
          const el = scene.elements.find((e) => e.id === id);
          let next = patch;
          // Renamed "car" or "my dog": a kind that was only guessed follows the name.
          if (el?.kindAuto && patch.name !== undefined && patch.kind === undefined) {
            const kind = guessKind(patch.name);
            if (kind && kind !== el.kind) next = { ...patch, kind, ...(el.height === ELEMENT_DEFAULTS[el.kind].height ? { height: ELEMENT_DEFAULTS[kind].height } : {}) };
          }
          commit({ ...scene, elements: scene.elements.map((e) => (e.id === id ? { ...e, ...next } : e)) }, live);
        },

        removeElement: (id) => {
          const { scene, selectedId } = get();
          // Whoever rode or sat on what goes comes down, and an action about it goes with it: with the motorbike gone,
          // Lena still rode it in every shot (her pose, lift and "riding the motorbike" from Arrange stayed).
          const gone = scene.elements.find((e) => e.id === id);
          const about = (t: string | undefined) => Boolean(gone && t && gone.name.trim().length > 1 && t.toLowerCase().includes(gone.name.trim().toLowerCase()));
          const elements = scene.elements
            .filter((e) => e.id !== id)
            .map((e) => {
              if (!gone) return e;
              const mounted = e.lift > 0.05 && Math.hypot(e.x - gone.x, e.z - gone.z) < 0.6;
              const told = about(e.action);
              if (!mounted && !told) return e;
              return { ...e, ...(mounted ? { lift: 0 } : {}), ...(mounted || (told && (e.pose === "riding" || e.pose === "sitting")) ? { pose: undefined } : {}), ...(told ? { action: "" } : {}) };
            });
          let camera = scene.camera;
          if (mainElement(scene)?.id === id) {
            // The camera stays where it is and turns to whoever is framed next (or the set's center).
            const pos = cameraPosition(scene.camera, focusPoint(scene));
            const next = elements[0];
            const target = new Vector3(next?.x ?? 0, scene.camera.focusHeight, next?.z ?? 0);
            camera = { ...scene.camera, ...orbitFrom(pos, target), focusId: next?.id ?? null, free: null };
          }
          commit({ ...scene, elements, camera });
          if (selectedId === id) set({ selectedId: null });
        },

        focusOn: (id) => {
          const { scene } = get();
          const el = scene.elements.find((e) => e.id === id);
          if (!el) return;
          const pos = cameraPosition(scene.camera, focusPoint(scene));
          const focusHeight = el.lift + el.height * (el.kind === "person" ? 0.82 : 0.55);
          const target = new Vector3(el.x, focusHeight, el.z);
          commit({ ...scene, camera: { ...scene.camera, ...orbitFrom(pos, target), focusHeight, focusId: id, free: null } });
        },

        setCamera: (patch, live) => {
          const { scene } = get();
          commit({ ...scene, camera: { ...scene.camera, ...patch } }, live);
        },

        setLight: (patch, live) => {
          const { scene } = get();
          commit({ ...scene, light: { ...scene.light, ...patch } }, live);
        },

        setScene: (patch) => {
          const { scene } = get();
          commit({ ...scene, ...patch });
        },

        setPlace: (image, text) => {
          const { scene } = get();
          if (!image) {
            commit({ ...scene, place: { text: text ?? scene.place.text } });
            return;
          }
          // A new main photo is another place: the photos around the old one go with it.
          const base: Scene = {
            ...scene,
            aspect: nearestAspect(image.width, image.height),
            place: { text: text ?? scene.place.text, image: { url: image.url, width: image.width, height: image.height }, scale: 1 },
          };
          commit(alignedToPhoto(base, provisionalView(image)));
        },

        setPlaceView: (url, view) => {
          const { scene } = get();
          const image = scene.place.image;
          if (!image || image.url !== url || image.view) return;
          const next: Scene = { ...scene, place: { ...scene.place, image: { ...image, view } } };
          // Not an undo step: it completes the setPlace that's already in history.
          set({ scene: alignedToPhoto(next, view) });
        },

        setPlaceScale: (scale, live) => {
          const { scene } = get();
          commit({ ...scene, place: { ...scene.place, scale } }, live);
        },

        toPhotoView: () => {
          const { scene } = get();
          const image = scene.place.image;
          if (!image) return;
          commit(alignedToPhoto(scene, image.view ?? provisionalView(image)));
        },

        swapPlacePhoto: (image) => {
          const { scene } = get();
          const now = scene.place.image;
          if (!now) return;
          commit({ ...scene, place: { ...scene.place, lifted: true, image: image ? { ...now, url: image.url, width: image.width, height: image.height } : now } });
        },

        setPlaceWorld: (world) => {
          const { scene } = get();
          commit({ ...scene, place: { ...scene.place, world: world ?? undefined } });
        },

        extendPlaceTo: (photo, frame, world) => {
          const { scene } = get();
          const { view, x, z, heading } = frame ?? extendFrame(scene);
          const spot = view.pivot * Math.cos(MathUtils.degToRad(view.pitch));
          // Everything turned by the camera's heading about the camera, then moved so the camera stands at the photo's spot.
          const c = Math.cos(heading);
          const s = Math.sin(heading);
          const turn = MathUtils.radToDeg(heading);
          const elements = scene.elements.map((e) => {
            const dx = e.x - x;
            const dz = e.z - z;
            return { ...e, x: round(dx * c + dz * s), z: round(-dx * s + dz * c + spot), yaw: Math.round(((((e.yaw + turn) % 360) + 540) % 360) - 180) };
          });
          const a = aspectById(scene.aspect);
          commit({
            ...scene,
            elements,
            camera: { ...scene.camera, ...photoRig(view, photo.width / photo.height, a.w / a.h), free: { x: 0, z: 0 } },
            place: { ...scene.place, image: { url: photo.url, width: photo.width, height: photo.height, view }, more: [], scale: 1, lifted: true, world: world ?? undefined },
          });
        },

        setWorldDepth: (url, depth, light) => {
          const { scene } = get();
          const world = scene.place.world;
          if (world?.url !== url) return;
          const first = !world.lit;
          commit(
            {
              ...scene,
              place: { ...scene.place, world: { ...world, depth, light, lit: true } },
              light: first ? { ...scene.light, azimuth: light.azimuth, elevation: light.elevation, softness: light.softness, kelvin: light.kelvin, mood: null } : scene.light,
            },
            true,
          );
        },

        sharpenWorld: (url, sharp) => {
          const { scene } = get();
          const world = scene.place.world;
          if (world?.url !== url) return;
          commit({ ...scene, place: { ...scene.place, world: { ...world, ...sharp } } }, true);
        },

        replacePlacePhoto: (url, image) => {
          const { scene } = get();
          const more = (scene.place.more ?? []).map((p) => (p.url === url ? { url: image.url, width: image.width, height: image.height, turn: p.turn, turnSet: p.turnSet } : p));
          commit({ ...scene, place: { ...scene.place, more } });
        },

        addPlacePhoto: (image, turn) => {
          const { scene } = get();
          if (!scene.place.image || scene.place.more?.some((p) => p.url === image.url)) return;
          // A view built at a known turn keeps it.
          if (turn !== undefined) {
            commit({ ...scene, place: { ...scene.place, more: [...(scene.place.more ?? []), { url: image.url, width: image.width, height: image.height, turn, turnSet: true }] } });
            return;
          }
          const more = [...(scene.place.more ?? []), { url: image.url, width: image.width, height: image.height, turn: 180 }];
          // Evenly around the spot: one more is behind, two more are a third of the way round each side, and so on.
          const n = more.length + 1;
          const spread = more.map((p, i) => (p.turnSet ? p : { ...p, turn: Math.round(((((i + 1) * 360) / n + 180) % 360) - 180) || 180 }));
          commit({ ...scene, place: { ...scene.place, more: spread } });
        },

        setPlacePhotoTurn: (url, turn, live) => {
          const { scene } = get();
          const more = scene.place.more?.map((p) => (p.url === url ? { ...p, turn, turnSet: true } : p));
          commit({ ...scene, place: { ...scene.place, more } }, live);
        },

        setPlacePhotoView: (url, view) => {
          const { scene } = get();
          const more = scene.place.more?.map((p) => (p.url === url && !p.view ? { ...p, view } : p));
          set({ scene: { ...scene, place: { ...scene.place, more } } });
        },

        removePlacePhoto: (url) => {
          const { scene } = get();
          commit({ ...scene, place: { ...scene.place, more: scene.place.more?.filter((p) => p.url !== url) } });
        },

        applyAngle: (id) => {
          const preset = ANGLES.find((a) => a.id === id);
          if (!preset) return;
          const { scene } = get();
          const next: Scene = { ...scene, camera: { ...scene.camera, elevation: preset.elevation, roll: 0 } };
          // Same shot size from the new height: a medium shot stays a medium shot, just seen from below or above.
          const keep = mainElement(scene) ? compileScene(scene).measured.shotSize : null;
          get().setCamera({ elevation: preset.elevation, roll: 0, ...(keep ? framingFor(next, keep) : {}) });
        },

        applyShotSize: (id) => {
          const { scene } = get();
          get().setCamera(framingFor(scene, id));
        },

        applyLens: (focal) => {
          const { scene } = get();
          // Keep the subject the same size in frame: a longer lens steps the camera back (and the background closes in).
          const ratio = focal / scene.camera.focal;
          const keep = mainElement(scene) ? compileScene(scene).measured.shotSize : null;
          const next: Scene = { ...scene, camera: { ...scene.camera, focal } };
          get().setCamera({ focal, ...(keep ? framingFor(next, keep, focal) : { distance: Math.max(0.35, scene.camera.distance * ratio) }) });
        },

        applyLightSetup: (id) => {
          const preset = LIGHT_SETUPS.find((l) => l.id === id);
          if (!preset) return;
          const { scene } = get();
          get().setLight({ azimuth: scene.camera.azimuth + preset.offset, elevation: preset.elevation });
        },

        applyMood: (id) => {
          if (!id) return get().setLight({ mood: null });
          const mood = MOODS.find((m) => m.id === id);
          if (!mood) return;
          get().setLight({ mood: id, kelvin: mood.kelvin, softness: mood.softness, elevation: mood.elevation });
        },

        loadScene: (scene) => {
          commit(withGuessedKinds(structuredClone(scene)));
          set({ selectedId: null });
        },

        reset: () => {
          commit(emptyScene());
          set({ selectedId: null });
        },
      };
    },
    {
      name: "crackio-director",
      version: 3,
      partialize: (s) => ({ scene: s.scene }),
      // v1 scenes are a subset of v2 (new fields are optional); v3 guesses the kinds v2 left as "person".
      migrate: (state) => {
        const { scene } = state as { scene: Scene };
        return { scene: scene ? withGuessedKinds(scene) : emptyScene() };
      },
      // A set saved before removing a ride brought its rider back still riding: they come down on loading.
      merge: (persisted, current) => {
        const p = persisted as { scene?: Scene } | undefined;
        return { ...current, ...(p?.scene ? { scene: withoutLostRides(p.scene) } : {}) };
      },
    },
  ),
);

/** Riders whose ride is gone (no vehicle or animal under them) stand on the ground again, without "riding…". */
function withoutLostRides(scene: Scene): Scene {
  const lost = (e: SceneElement) =>
    (e.pose === "riding" || (e.lift > 0.05 && /\brid(e|es|ing)\b/i.test(e.action ?? ""))) &&
    !scene.elements.some((o) => o.id !== e.id && (o.kind === "vehicle" || o.kind === "animal") && Math.hypot(o.x - e.x, o.z - e.z) < 0.6);
  if (!scene.elements.some(lost)) return scene;
  // The camera framed on a rider comes down with them (a close-up kept aiming where her head had been).
  const framedOn = scene.elements.find((e) => e.id === scene.camera.focusId && lost(e));
  return {
    ...scene,
    camera: framedOn ? { ...scene.camera, focusHeight: Math.max(0.2, scene.camera.focusHeight - framedOn.lift) } : scene.camera,
    elements: scene.elements.map((e) => (lost(e) ? { ...e, lift: 0, pose: undefined, action: /\brid(e|es|ing)\b/i.test(e.action ?? "") ? "" : e.action } : e)),
  };
}

export function useSelected() {
  return useDirector((s) => s.scene.elements.find((e) => e.id === s.selectedId) ?? null);
}

const round = (n: number) => Math.round(n * 100) / 100;

export type { AspectId };
