"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { nanoid } from "nanoid";
import { MathUtils, Vector3 } from "three";
import type { CameraRig, ElementKind, LightRig, PlaceVideo, PlaceView, Scene, SceneElement, WorldDepth, WorldLight } from "./types";
import { ANGLES, ELEMENT_DEFAULTS, LIGHT_SETUPS, MOODS, SHOT_SIZES } from "./vocab";
import { angleDelta, cameraPosition, focusPoint, orbitFrom, shotCamera, verticalFov, yawTowardCamera } from "./camera";
import {
  DEFAULT_LENGTH,
  cameraMove,
  cameraValue,
  clampFrame,
  cleanTimeline,
  deleteSelection,
  easeSelection,
  elementAt,
  elementValue,
  emptyTimeline,
  hasKeys,
  inheritedEase,
  keyAt,
  movedTimeline,
  moveSelection,
  removeKey,
  sceneAt,
  selectionShift,
  setKey,
  withFps,
  withinLength,
  type CameraKey,
  type CameraMoveKind,
  type Ease,
  type ElementKey,
  type KeySelection,
  type Timeline,
} from "./timeline";
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
/**
 * How a change lands in the history: an undo step (the default), `true` live (the drag's checkpoint already holds the
 * step), or "typing": one undo step per burst of keys, so Undo takes back the words, not the last letter.
 */
type Live = boolean | "typing";
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
  updateElement: (id: string, patch: Partial<SceneElement>, live?: Live) => void;
  removeElement: (id: string) => void;
  /** Aim the camera at an element without moving it; shot sizes then frame that element. */
  focusOn: (id: string) => void;
  setCamera: (patch: Partial<CameraRig>, live?: boolean) => void;
  setLight: (patch: Partial<LightRig>, live?: boolean) => void;
  setScene: (patch: Partial<Pick<Scene, "style" | "aspect" | "notes" | "place">>, live?: Live) => void;

  /** Use a photo as the location (or clear it). The camera moves to where the photo was taken. */
  setPlace: (image: PlaceImage | null, text?: string) => void;
  /**
   * Director video mode: a video as the place. Its first frame (`poster`) is the photo the 3D set is built from; the cast
   * goes (a video brings its own people); the timeline becomes the video's length (up to 10 s at 24 fps), the camera
   * where the video's was.
   */
  setPlaceVideo: (video: PlaceVideo, poster: PlaceImage) => void;
  /** The 3D set for the location is built: remember how the photo was taken and look through it. */
  setPlaceView: (url: string, view: PlaceView) => void;
  /**
   * Director video mode: the point the camera turns round put `distance` (set units) along its view, where the video's
   * middle is (its measured depth), the camera itself where it is. Only while the camera has no keys; not an undo step.
   */
  focusVideoAt: (url: string, distance: number) => void;
  setPlaceScale: (scale: number, live?: boolean) => void;
  /** Put the camera back where the location photo was taken. */
  toPhotoView: () => void;
  /** Another photo of the place from the same spot, facing another way; photos that weren't turned by hand spread evenly. */
  addPlacePhoto: (image: PlaceImage, turn?: number) => void;
  setPlacePhotoTurn: (url: string, turn: number, live?: boolean) => void;
  /** The main photo replaced by itself with its things lifted out: the camera and its 3D set's pose stay. */
  swapPlacePhoto: (image: PlaceImage | null) => void;
  /**
   * Small extend: the main photo grown around itself (server/grow-photo) with its wider view (lib/director/grow). The
   * camera, the cast and the set's pose stay; a fix made in the world's copy of the photo is in the grown one now.
   */
  growPlacePhoto: (image: PlaceImage, view: PlaceView) => void;
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
  sharpenWorld: (url: string, sharp: { url: string; width: number; height: number; photo?: { url: string; width: number; height: number } }) => void;
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

  /*
   * The shot's timeline (lib/director/timeline). The recording rule lives in setCamera, focusOn and updateElement: a
   * lane without keys changes as it always did; a lane with keys also writes the change into the key at the playhead.
   */
  /** Show one frame of the shot: the camera and every keyed element as they are then. Live: no undo step. */
  seek: (frame: number) => void;
  /** Key the camera as it is at the playhead, or take away the key there. A still's first key goes on frame 0 and gives it 5 s. */
  keyCamera: () => void;
  /** The same for an element: where it stands, faces, how high and its pose. */
  keyElement: (id: string) => void;
  /** The shot's length (frames, 1–20 s) or frame rate (keys keep their seconds). */
  setTimeline: (patch: { fps?: number; length?: number }, live?: Live) => void;
  /** How the camera moves on from the keys on frames `ts` (one key: its own stretch; several: all between them). */
  setCameraEase: (ts: readonly number[], ease: Ease) => void;
  /** The same for keys picked in any lanes. */
  setKeysEase: (sel: KeySelection, ease: Ease) => void;
  /**
   * Move the picked keys `dt` frames, together, within the shot; returns how far they really went. A drag passes the
   * timeline it started from (`from`) with `live`, after one `checkpoint()`: a key passed over comes back.
   */
  moveKeys: (sel: KeySelection, dt: number, live?: boolean, from?: Timeline) => number;
  moveCameraKeys: (ts: readonly number[], dt: number, live?: boolean, from?: Timeline) => number;
  deleteKeys: (sel: KeySelection) => void;
  /** A ready-made camera move over the whole shot (it replaces the camera's keys), from the camera as it is. */
  applyCameraMove: (kind: CameraMoveKind) => void;
  /** Every key gone: the set is a still again, as it looks now. */
  clearTimeline: () => void;

  /** Bring back the whole set from an earlier take. */
  loadScene: (scene: Scene) => void;
  reset: () => void;
};

const HISTORY = 80;

/** A burst of typing ends after this long without a key (then the next key is a new undo step). */
const TYPING_PAUSE = 600;
let typingBurst: ReturnType<typeof setTimeout> | null = null;
function endTyping() {
  if (typingBurst) clearTimeout(typingBurst);
  typingBurst = null;
}

/**
 * localStorage, written at most every 0.4 s and only when the saved set changed: every key typed and every step of a
 * drag wrote the whole scene synchronously (61 writes for one orbit). Written at once when the page hides or closes.
 */
function lazyStorage(): StateStorage {
  if (typeof window === "undefined") throw new Error("No storage on the server");
  const pending = new Map<string, string>();
  const written = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const [key, value] of pending) {
      try {
        localStorage.setItem(key, value);
        written.set(key, value);
      } catch {
        /* full or blocked: the set stays in memory */
      }
    }
    pending.clear();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  return {
    getItem: (key) => pending.get(key) ?? localStorage.getItem(key),
    setItem: (key, value) => {
      if (value === (pending.get(key) ?? written.get(key))) return;
      pending.set(key, value);
      timer ??= setTimeout(flush, 400);
    },
    removeItem: (key) => {
      pending.delete(key);
      written.delete(key);
      localStorage.removeItem(key);
    },
  };
}

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

/**
 * Director video mode: the camera turned round the video's middle at its measured depth (Place.video.focus), the camera
 * itself where it is: the point it looks at slides along its view. The same scene without a measured video.
 */
function pivotOnVideo(scene: Scene): Scene {
  const distance = scene.place.video?.focus;
  if (!distance || !(distance > 0.2)) return scene;
  const target = focusPoint(scene);
  const at = cameraPosition(scene.camera, target);
  const focus = at.clone().add(target.clone().sub(at).normalize().multiplyScalar(distance));
  if (focus.y < 0) return scene;
  return { ...scene, camera: { ...scene.camera, free: { x: focus.x, z: focus.z }, focusHeight: focus.y, distance } };
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
  const next: Scene = { ...scene, elements, camera: { ...scene.camera, ...rig, focusId: main?.id ?? null, free: null } };
  // Keys move with the set, so keyed things stay where they stood on it.
  if (scene.timeline && (dx || dz)) next.timeline = movedTimeline(scene.timeline, (p) => ({ x: round(p.x - dx), z: round(p.z - dz) }));
  return next;
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

/* ------------------------------------------------------------ the shot's timeline ----------------------------------- */

/**
 * The timeline's playhead: the frame the set shows, whether it plays, and whether playing goes round. Not saved and not
 * in the undo history: a set opens on its first frame.
 */
export type Playhead = { frame: number; playing: boolean; loop: boolean };
export const usePlayhead = create<Playhead>()(() => ({ frame: 0, playing: false, loop: true }));

/** Play from the playhead (from the start when it stands on the last frame), in real time at the shot's fps. */
export const play = () => usePlayhead.setState({ playing: true });
/** Stop on the frame it shows. Safe any time. */
export const pause = () => {
  if (usePlayhead.getState().playing) usePlayhead.setState({ playing: false });
};
export const togglePlay = () => (usePlayhead.getState().playing ? pause() : play());

let raf = 0;
let clock: { start: number; from: number; fps: number; loop: boolean } | null = null;

// `playing` alone says whether it plays, whoever sets it.
usePlayhead.subscribe((s, was) => {
  if (s.playing === was.playing) return;
  if (s.playing) startPlaying();
  else stopPlaying();
});

function startPlaying() {
  if (typeof window === "undefined") return;
  const tl = useDirector.getState().scene.timeline;
  if (!hasKeys(tl)) return usePlayhead.setState({ playing: false });
  const { frame, loop } = usePlayhead.getState();
  const from = frame >= tl.length ? 0 : clampFrame(tl, frame);
  if (from !== frame) useDirector.getState().seek(from);
  clock = { start: performance.now(), from, fps: tl.fps, loop };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function stopPlaying() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  clock = null;
}

/** One screen refresh of playback: the frame real time has reached is shown (once), round again or to a stop at the end. */
function tick(now: number) {
  raf = 0;
  const ph = usePlayhead.getState();
  if (!ph.playing || !clock) return;
  const tl = useDirector.getState().scene.timeline;
  if (!hasKeys(tl)) return pause();
  // Another rate or loop setting while it plays goes on from the frame it shows.
  if (tl.fps !== clock.fps || ph.loop !== clock.loop) clock = { start: now, from: ph.frame, fps: tl.fps, loop: ph.loop };
  const run = clock.from + Math.floor(((now - clock.start) / 1000) * tl.fps);
  if (run > tl.length && !ph.loop) {
    useDirector.getState().seek(tl.length);
    return pause();
  }
  const frame = run % (tl.length + 1);
  if (frame !== ph.frame) useDirector.getState().seek(frame);
  raf = requestAnimationFrame(tick);
}

const playheadFrame = (tl: Timeline | undefined) => (tl ? clampFrame(tl, usePlayhead.getState().frame) : 0);

/** The set at `frame` of its timeline, the camera kept in the place's room like after any other move. */
function synced(scene: Scene, frame: number): Scene {
  const at = sceneAt(scene, frame);
  if (at === scene) return scene;
  const camera = keptInRoom(at, at.camera);
  return camera === at.camera ? at : { ...at, camera };
}

/** Whether two sets' cameras show the same: a free point put right on the subject it framed changes nothing on screen. */
function sameView(a: Scene, b: Scene) {
  const p = a.camera;
  const q = b.camera;
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  if (!near(angleDelta(p.azimuth, q.azimuth), 0) || !near(angleDelta(p.roll, q.roll), 0)) return false;
  if (!near(p.elevation, q.elevation) || !near(p.distance, q.distance) || !near(p.focal, q.focal) || !near(p.aperture, q.aperture) || !near(p.focusHeight, q.focusHeight)) return false;
  const s = focusPoint(a);
  const t = focusPoint(b);
  return near(s.x, t.x) && near(s.z, t.z);
}

/**
 * The recording rule for the camera: without camera keys a change is just a change; with them, what the camera now
 * shows also goes into the key at the playhead (that key updated, else a new one there). Nothing is keyed when the
 * picture didn't change (a click, the stage pinning the point it looks at before a subject is dragged).
 */
function recordCamera(prev: Scene, next: Scene): Scene {
  const tl = next.timeline;
  if (!tl?.camera.length) return next;
  const camera = keptInRoom(next, next.camera);
  const kept = camera === next.camera ? next : { ...next, camera };
  if (sameView(prev, kept)) return kept;
  const t = playheadFrame(tl);
  const key: CameraKey = { t, cam: cameraValue(camera), ease: keyAt(tl.camera, t)?.ease ?? inheritedEase(tl.camera, t) };
  return { ...kept, timeline: { ...tl, camera: setKey(tl.camera, key) } };
}

/** What of an element its keys hold. Changing any of it is an edit that stops playback. */
const MOTION = ["x", "z", "yaw", "lift", "pose"] as const;

/** The recording rule for an element: with keys, where it now stands (faces, how high, its pose) goes into the key at the playhead. */
function recordElement(prev: Scene, next: Scene, id: string): Scene {
  const tl = next.timeline;
  const keys = tl?.elements[id];
  if (!tl || !keys?.length) return next;
  const a = prev.elements.find((e) => e.id === id);
  const b = next.elements.find((e) => e.id === id);
  if (!a || !b || (a.x === b.x && a.z === b.z && a.yaw === b.yaw && a.lift === b.lift && a.pose === b.pose)) return next;
  const t = playheadFrame(tl);
  const key: ElementKey = { t, v: elementValue(b), ease: keyAt(keys, t)?.ease ?? inheritedEase(keys, t) };
  return { ...next, timeline: { ...tl, elements: { ...tl.elements, [id]: setKey(keys, key) } } };
}

/**
 * Its keys gone with an element. Camera keys that framed it look at where it stood instead, so the shot doesn't jump to
 * whoever is first on the set; with camera keys the camera then shows the playhead's frame of them.
 */
function withoutElementKeys(scene: Scene, id: string, gone: SceneElement | undefined): Scene {
  const tl = scene.timeline;
  if (!tl) return scene;
  const lane = tl.elements[id];
  const elements = { ...tl.elements };
  delete elements[id];
  const camera = tl.camera.map((k) => {
    if (!gone || k.cam.focusId !== id || k.cam.free) return k;
    const at = elementAt(lane, k.t) ?? gone;
    return { ...k, cam: { ...k.cam, focusId: null, free: { x: at.x, z: at.z } } };
  });
  const timeline: Timeline = { ...tl, camera, elements };
  return synced({ ...scene, timeline }, playheadFrame(timeline));
}

/** A set from storage or a take: its timeline made safe (lib/director/timeline cleanTimeline), shown at its first frame. */
function checkedTimeline(scene: Scene): Scene {
  if (scene.timeline === undefined) return scene;
  const timeline = cleanTimeline(scene.timeline, scene.elements.map((e) => e.id));
  const next: Scene = { ...scene };
  if (timeline) next.timeline = timeline;
  else delete next.timeline;
  return timeline ? sceneAt(next, 0) : next;
}

export const useDirector = create<DirectorState>()(
  persist(
    (set, get) => {
      // Whatever moved it, the camera stays in the place's room (lib/director/room): zoomed or swung out through a
      // wall, it saw the place from outside.
      const commit = (next: Scene, live?: Live) => {
        const camera = keptInRoom(next, next.camera);
        const scene = camera === next.camera ? next : { ...next, camera };
        if (live === "typing") {
          // The first key of a burst saves the undo point; the rest of the burst lands live.
          const first = !typingBurst;
          if (typingBurst) clearTimeout(typingBurst);
          typingBurst = setTimeout(() => (typingBurst = null), TYPING_PAUSE);
          set((s) => (first ? { scene, past: [...s.past, s.scene].slice(-HISTORY), future: [] } : { scene }));
          return;
        }
        if (!live) endTyping();
        set((s) => (live ? { scene } : { scene, past: [...s.past, s.scene].slice(-HISTORY), future: [] }));
      };

      // Undo and redo bring keys back with the set; it then shows the playhead's frame of what came back.
      const afterHistory = () => {
        pause();
        const { scene } = get();
        if (!hasKeys(scene.timeline)) return;
        const frame = clampFrame(scene.timeline, usePlayhead.getState().frame);
        if (frame !== usePlayhead.getState().frame) usePlayhead.setState({ frame });
        const next = synced(scene, frame);
        if (next !== scene) set({ scene: next });
      };

      /**
       * The key at the playhead on the camera's lane (`id` null) or an element's taken away, the set then showing that
       * frame of the keys left; or, with none there, the lane as it is now keyed there.
       */
      const toggleKey = (id: string | null) => {
        const { scene } = get();
        const el = id === null ? null : scene.elements.find((e) => e.id === id);
        if (id !== null && !el) return;
        pause();
        // A still's first key starts the shot: it goes on frame 0.
        const fresh = !hasKeys(scene.timeline);
        if (fresh) usePlayhead.setState({ frame: 0 });
        const tl = withinLength(scene.timeline ?? emptyTimeline());
        const t = fresh ? 0 : clampFrame(tl, usePlayhead.getState().frame);
        if (id === null || !el) {
          if (keyAt(tl.camera, t)) return commit(synced({ ...scene, timeline: { ...tl, camera: removeKey(tl.camera, t) } }, t));
          const key: CameraKey = { t, cam: cameraValue(scene.camera), ease: inheritedEase(tl.camera, t) };
          return commit({ ...scene, timeline: { ...tl, camera: setKey(tl.camera, key) } });
        }
        const keys = tl.elements[id] ?? [];
        if (keyAt(keys, t)) {
          const elements = { ...tl.elements };
          const rest = removeKey(keys, t);
          if (rest.length) elements[id] = rest;
          else delete elements[id];
          return commit(synced({ ...scene, timeline: { ...tl, elements } }, t));
        }
        const key: ElementKey = { t, v: elementValue(el), ease: inheritedEase(keys, t) };
        commit({ ...scene, timeline: { ...tl, elements: { ...tl.elements, [id]: setKey(keys, key) } } });
      };

      return {
        scene: emptyScene(),
        selectedId: null,
        past: [],
        future: [],

        checkpoint: () => {
          endTyping();
          set((s) => ({ past: [...s.past, s.scene].slice(-HISTORY), future: [] }));
        },
        undo: () => {
          endTyping();
          set((s) => {
            const prev = s.past.at(-1);
            if (!prev) return s;
            return { scene: prev, past: s.past.slice(0, -1), future: [s.scene, ...s.future].slice(0, HISTORY) };
          });
          afterHistory();
        },
        redo: () => {
          endTyping();
          set((s) => {
            const next = s.future[0];
            if (!next) return s;
            return { scene: next, future: s.future.slice(1), past: [...s.past, s.scene].slice(-HISTORY) };
          });
          afterHistory();
        },

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
          // Moving, turning, lifting or posing it stops playback (a picture or a reading arriving doesn't).
          if (MOTION.some((k) => k in next)) pause();
          commit(recordElement(scene, { ...scene, elements: scene.elements.map((e) => (e.id === id ? { ...e, ...next } : e)) }, id), live);
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
          const after: Scene = { ...scene, elements, camera };
          commit(scene.timeline ? withoutElementKeys(after, id, gone) : after);
          if (selectedId === id) set({ selectedId: null });
        },

        focusOn: (id) => {
          const { scene } = get();
          const el = scene.elements.find((e) => e.id === id);
          if (!el) return;
          const pos = cameraPosition(scene.camera, focusPoint(scene));
          const focusHeight = el.lift + el.height * (el.kind === "person" ? 0.82 : 0.55);
          const target = new Vector3(el.x, focusHeight, el.z);
          pause();
          commit(recordCamera(scene, { ...scene, camera: { ...scene.camera, ...orbitFrom(pos, target), focusHeight, focusId: id, free: null } }));
        },

        setCamera: (patch, live) => {
          const { scene } = get();
          const next: Scene = { ...scene, camera: { ...scene.camera, ...patch } };
          // An empty patch only brings the camera back into the room (WalkIn): not an edit, so it neither stops nor keys.
          if (!Object.keys(patch).length) return commit(next, live);
          pause();
          commit(recordCamera(scene, next), live);
        },

        setLight: (patch, live) => {
          const { scene } = get();
          commit({ ...scene, light: { ...scene.light, ...patch } }, live);
        },

        setScene: (patch, live) => {
          const { scene } = get();
          commit({ ...scene, ...patch }, live);
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

        setPlaceVideo: (video, poster) => {
          const { scene } = get();
          pause();
          usePlayhead.setState({ frame: 0 });
          const length = Math.max(24, Math.min(240, Math.round(video.duration * 24) - 1));
          const base: Scene = {
            ...scene,
            elements: [],
            aspect: nearestAspect(poster.width, poster.height),
            place: { text: "", image: { url: poster.url, width: poster.width, height: poster.height }, video, scale: 1 },
            timeline: emptyTimeline(length, 24),
          };
          commit(alignedToPhoto(base, provisionalView(poster)));
        },

        focusVideoAt: (url, distance) => {
          const { scene } = get();
          const video = scene.place.video;
          if (!video || scene.place.image?.url !== url || !(distance > 0.2)) return;
          const kept: Scene = { ...scene, place: { ...scene.place, video: { ...video, focus: distance } } };
          // The camera itself only while it has no keys (a keyed path stays as it was set).
          set({ scene: scene.timeline?.camera.length ? kept : pivotOnVideo(kept) });
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
          pause();
          // A video's camera turns round its middle again (focusVideoAt).
          commit(recordCamera(scene, pivotOnVideo(alignedToPhoto(scene, image.view ?? provisionalView(image)))));
        },

        swapPlacePhoto: (image) => {
          const { scene } = get();
          const now = scene.place.image;
          if (!now) return;
          commit({ ...scene, place: { ...scene.place, lifted: true, image: image ? { ...now, url: image.url, width: image.width, height: image.height } : now } });
        },

        growPlacePhoto: (image, view) => {
          const { scene } = get();
          if (!scene.place.image) return;
          const world = scene.place.world;
          commit({
            ...scene,
            place: { ...scene.place, image: { url: image.url, width: image.width, height: image.height, view }, ...(world?.photo ? { world: { ...world, photo: undefined } } : {}) },
          });
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
          // Keys turn and move with the set, so keyed things stay where they stood on it.
          const timeline =
            scene.timeline &&
            movedTimeline(
              scene.timeline,
              (p) => {
                const dx = p.x - x;
                const dz = p.z - z;
                return { x: round(dx * c + dz * s), z: round(-dx * s + dz * c + spot) };
              },
              turn,
            );
          commit({
            ...scene,
            elements,
            camera: { ...scene.camera, ...photoRig(view, photo.width / photo.height, a.w / a.h), free: { x: 0, z: 0 } },
            place: { ...scene.place, image: { url: photo.url, width: photo.width, height: photo.height, view }, more: [], scale: 1, lifted: true, world: world ?? undefined },
            ...(timeline ? { timeline } : {}),
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

        seek: (frame) => {
          const { scene } = get();
          const tl = scene.timeline;
          const f = tl ? clampFrame(tl, frame) : 0;
          if (usePlayhead.getState().frame !== f) usePlayhead.setState({ frame: f });
          if (!hasKeys(tl)) return;
          const next = synced(scene, f);
          if (next !== scene) set({ scene: next });
        },

        keyCamera: () => toggleKey(null),

        keyElement: (id) => toggleKey(id),

        setTimeline: (patch, live) => {
          const { scene } = get();
          const was = scene.timeline ?? emptyTimeline();
          // Video mode: the timeline is the video's, at its 24 fps, never past its end (at most the 10 s it films).
          const video = scene.place.video;
          let tl = patch.fps !== undefined && !video ? withFps(was, patch.fps) : was;
          if (patch.length !== undefined && Number.isFinite(patch.length)) tl = { ...tl, length: Math.round(patch.length) };
          if (video) tl = { ...tl, length: Math.min(tl.length, Math.max(24, Math.min(240, Math.round(video.duration * 24) - 1))) };
          tl = withinLength(tl);
          if (tl === scene.timeline) return;
          const at = usePlayhead.getState().frame;
          const frame = clampFrame(tl, tl.fps === was.fps ? at : Math.round((at * tl.fps) / was.fps));
          if (frame !== at) usePlayhead.setState({ frame });
          commit(synced({ ...scene, timeline: tl }, frame), live);
        },

        setCameraEase: (ts, ease) => get().setKeysEase({ camera: ts }, ease),

        setKeysEase: (sel, ease) => {
          const { scene } = get();
          const tl = scene.timeline;
          if (!tl) return;
          const next = easeSelection(tl, sel, ease);
          if (next === tl) return;
          pause();
          commit(synced({ ...scene, timeline: next }, playheadFrame(next)));
        },

        moveKeys: (sel, dt, live, from) => {
          const { scene } = get();
          const base = from ?? scene.timeline;
          if (!base) return 0;
          const d = selectionShift(base, sel, dt);
          const next = d ? moveSelection(base, sel, d) : base;
          if (next !== scene.timeline) {
            pause();
            commit(synced({ ...scene, timeline: next }, playheadFrame(next)), live);
          }
          return d;
        },

        moveCameraKeys: (ts, dt, live, from) => get().moveKeys({ camera: ts }, dt, live, from),

        deleteKeys: (sel) => {
          const { scene } = get();
          const tl = scene.timeline;
          if (!tl) return;
          const next = deleteSelection(tl, sel);
          if (next === tl) return;
          pause();
          // Lanes left without keys keep what they show now: nothing jumps.
          commit(synced({ ...scene, timeline: next }, playheadFrame(next)));
        },

        applyCameraMove: (kind) => {
          const { scene, selectedId } = get();
          pause();
          const was = scene.timeline;
          const length = was?.length ?? DEFAULT_LENGTH;
          const subject = scene.elements.find((e) => e.id === selectedId) ?? mainElement(scene);
          const focus = focusPoint(scene);
          const [first, last] = cameraMove(kind, scene.camera, {
            length,
            focus: { x: focus.x, z: focus.z },
            subject: subject ? { x: subject.x, z: subject.z, height: subject.height, lift: subject.lift } : undefined,
            // A video's moves are half as big: its footage covers only what its own camera saw.
            strength: scene.place.video ? 0.5 : 1,
          });
          // Its end kept in the place's room like any move (its start is the camera as it is, already in it).
          const end = keptInRoom(scene, { ...scene.camera, ...last.cam });
          const timeline = withinLength({ ...(was ?? emptyTimeline(length)), length, camera: [first, { ...last, cam: cameraValue(end) }] });
          usePlayhead.setState({ frame: 0 });
          commit(synced({ ...scene, timeline }, 0));
        },

        clearTimeline: () => {
          const { scene } = get();
          if (!scene.timeline) return;
          pause();
          usePlayhead.setState({ frame: 0 });
          // A video keeps its length (video mode: the timeline is the video's), only its keys go.
          if (scene.place.video) return commit({ ...scene, timeline: emptyTimeline(scene.timeline.length, scene.timeline.fps) });
          const still: Scene = { ...scene };
          delete still.timeline;
          commit(still);
        },

        loadScene: (scene) => {
          pause();
          usePlayhead.setState({ frame: 0 });
          commit(checkedTimeline(withGuessedKinds(structuredClone(scene))));
          set({ selectedId: null });
        },

        reset: () => {
          pause();
          usePlayhead.setState({ frame: 0 });
          commit(emptyScene());
          set({ selectedId: null });
        },
      };
    },
    {
      name: "crackio-director",
      version: 3,
      storage: createJSONStorage(lazyStorage),
      partialize: (s) => ({ scene: s.scene }),
      // v1 scenes are a subset of v2 (new fields are optional); v3 guesses the kinds v2 left as "person".
      migrate: (state) => {
        const { scene } = state as { scene: Scene };
        return { scene: scene ? withGuessedKinds(scene) : emptyScene() };
      },
      // A set saved before removing a ride brought its rider back still riding: they come down on loading. A saved
      // timeline is made safe and the set opens on its first frame.
      merge: (persisted, current) => {
        const p = persisted as { scene?: Scene } | undefined;
        return { ...current, ...(p?.scene ? { scene: checkedTimeline(withoutLostRides(p.scene)) } : {}) };
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
