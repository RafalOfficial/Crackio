"use client";

import {
  Box3,
  Color,
  Fog,
  LinearSRGBColorSpace,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type PerspectiveCamera,
  type Scene as ThreeScene,
  ShaderMaterial,
  Sphere,
  type Texture,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { blockingLook, type ShotLook } from "@/lib/director/look";
import { ShotRenderer } from "./post";

/**
 * Renders the Director set from the shot camera into images:
 *  - guide: exactly what the camera view shows (lens blur and grade included), for you to compare takes against
 *  - blocking: what the image model gets: the place, sharp and ungraded, its unknown parts flat gray, and a colored
 *    stand-in with real 3D shape where each subject stands (never the photo cut-outs, which turn flat and squashed)
 *  - depth: real depth of the blocking set (near = white, inverse depth like MiDaS), for depth ControlNets
 */
export type CaptureResult = {
  guide: Blob;
  blocking: Blob;
  depth: Blob;
  /** The place alone through the camera, as in the blocking frame (unknown parts gray), with no subjects. */
  plate: Blob;
  /**
   * The camera view as you see it (the place, each subject's own picture from this side, their shadows), sharp and
   * ungraded, with what no picture shows flat LOOK_KEY gray: the picture a kept shot edits.
   */
  look: Blob;
  /** The place alone in the Camera's view (Director v2's photo in 3D, the world around, gaps gray), no cast; null without the 3D photo. */
  set: Blob | null;
  /** The cast's own pictures in the camera view, white on black (behind what of the place covers them). */
  cuts: Blob;
  /** Each subject's visible pixels in its own flat color (`ids`), everything else black: who covers whom. */
  ids: Blob;
  /**
   * Each subject's whole silhouette in the frame (its stand-in, nothing covering it), in pixels, past the frame's
   * edges when it's cut off; and its distance from the camera (nearer ones go on top).
   */
  boxes: { id: string; box: [number, number, number, number]; distance: number; color: [number, number, number] }[];
  width: number;
  height: number;
};

type CaptureFn = (width: number, height: number) => Promise<CaptureResult>;
type PlateFn = (camera: PerspectiveCamera, width: number, height: number) => Promise<Blob>;

/**
 * The stages that can be captured, newest last: the Director's page and Storyboard's Director can both be mounted (one
 * of them hidden), and with one slot whichever went away last left Shoot with no stage ("The stage isn't ready yet.").
 * Each registers itself and takes back only its own; the one shown (mounted or shown last) is used.
 */
const captures: CaptureFn[] = [];
const plates: PlateFn[] = [];

function keep<T>(list: T[], fn: T) {
  list.push(fn);
  return () => {
    const i = list.lastIndexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Register a stage's capture; the function returned takes it back. */
export const registerCapture = (fn: CaptureFn) => keep(captures, fn);

export async function captureShot(width: number, height: number) {
  // Shoot pressed while the stage is still coming up (a big world loading, the page just opened) waits for it, up to
  // 20 s: it used to fail at once with "The stage isn't ready yet." (the A40 test, Shoot 5 s after opening a set).
  for (let waited = 0; !captures.length && waited < 20_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
  const fn = captures.at(-1);
  if (!fn) throw new Error("The stage isn't ready yet.");
  return fn(width, height);
}

/** Register a stage's plate capture; the function returned takes it back. */
export const registerPlateCapture = (fn: PlateFn) => keep(plates, fn);

/** The place alone as a camera sees it (the model's view: unknown parts gray, no stand-ins), from any camera. */
export async function capturePlateFrom(camera: PerspectiveCamera, width: number, height: number) {
  const fn = plates.at(-1);
  if (!fn) throw new Error("The stage isn't ready yet.");
  return fn(camera, width, height);
}

export function makePlateCapture(gl: WebGLRenderer, scene: ThreeScene, look: () => ShotLook): PlateFn {
  return async (cam, width, height) => {
    const renderer = new ShotRenderer(width, height);
    const out = new WebGLRenderTarget(width, height);
    const restore = showView(scene, "model");
    const hidden: Object3D[] = [];
    scene.traverse((o) => {
      if (o.userData[STANDIN] && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    try {
      cam.layers.set(0);
      renderer.render(gl, scene, cam, blockingLook(look()), out);
      return await toBlob(read(gl, out, width, height), width, height);
    } finally {
      for (const o of hidden) o.visible = true;
      restore();
      renderer.dispose();
      out.dispose();
    }
  };
}

/**
 * One frame of the shot exactly as the camera view shows it (lens blur and grade), as RGBA rows bottom-up (WebGL's
 * order): Director v2's "Save preview" records the timeline with it. One pass, its buffers kept between frames.
 */
type GrabFn = (width: number, height: number) => Uint8Array;
const grabs: GrabFn[] = [];
export const registerFrameGrab = (fn: GrabFn) => keep(grabs, fn);
export function grabFrame(width: number, height: number) {
  const fn = grabs.at(-1);
  if (!fn) throw new Error("The stage isn't ready yet.");
  return fn(width, height);
}
export function makeFrameGrab(gl: WebGLRenderer, scene: ThreeScene, shotCamera: (aspect: number) => PerspectiveCamera, look: () => ShotLook): GrabFn {
  let held: { renderer: ShotRenderer; out: WebGLRenderTarget; key: string } | null = null;
  return (width, height) => {
    const key = `${width}x${height}`;
    if (held?.key !== key) {
      held?.renderer.dispose();
      held?.out.dispose();
      held = { renderer: new ShotRenderer(width, height), out: new WebGLRenderTarget(width, height), key };
    }
    const cam = shotCamera(width / height);
    cam.layers.set(0);
    const restore = showView(scene, "camera");
    try {
      held.renderer.render(gl, scene, cam, look(), held.out);
      return read(gl, held.out, width, height);
    } finally {
      restore();
    }
  };
}

/** Objects left out of the depth pass: invisible catchers and shadow overlays. */
export const NO_DEPTH = "crackioNoDepth";
/** Objects that are subjects (they set the near end of the depth range). */
export const SUBJECT = "crackioSubject";
/** Only in the camera view: photo cut-outs, the dark stage floor. */
export const VIEW_NORMAL = "crackioNormalView";
/** Only in the model's view: stand-ins, the floor grid. Hidden until a view shows them. */
export const VIEW_MODEL = "crackioModelView";
/** The location's 3D set: in the model's view its stretched and missing parts turn flat gray. */
export const PLACE_SET = "crackioPlaceSet";
/** A stand-in's group, by the id of the element it stands in for. */
export const STANDIN = "crackioStandIn";
/** Flat colors of the ID pass, by cast order: pure channels, so no color space or blending can confuse them. */
export const ID_COLORS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];
/** "Nothing known here": the backdrop of the model's view and the location's unknown parts. */
export const UNKNOWN_GRAY = new Color("#8a8a8a");
/**
 * "Nothing known here" in the kept shot's camera view (`look`): the challenge winner's neutral gray for the parts no
 * picture shows (Panorama Stickers' renders for Qwen-Image 2.1), which the model is told to fill (server/director-real
 * counts it to know).
 */
export const LOOK_KEY = new Color("#949494");

/** Pictures of the place the surround (Stage3D) has on screen: a view built around the spot counts once it's there. */
export const loadedViews = new Set<string>();

/**
 * Show one view of the set: "camera" (what you see while you work) or "model" (the blocking frame). Returns a
 * function that puts everything back, so the live preview and the capture can both switch for one render.
 */
/** The empty stage's own floors (one per view): never swapped by showStandIns. */
export const STAGE_FLOOR = "crackioStageFloor";

/**
 * Director v2's Set tab: every subject as its stand-in, a body that reads from any side (their photo cut-outs are flat
 * cards that stretch into streaks seen from beside), with the place as it looks. Undone by the function returned.
 */
export function showStandIns(scene: ThreeScene) {
  const flipped: Object3D[] = [];
  scene.traverse((o) => {
    if (o.userData[STAGE_FLOOR]) return;
    if (o.userData[VIEW_NORMAL] || o.userData[VIEW_MODEL]) {
      const want = Boolean(o.userData[VIEW_MODEL]);
      if (o.visible !== want) {
        o.visible = want;
        flipped.push(o);
      }
    }
  });
  return () => {
    for (const o of flipped) o.visible = !o.visible;
  };
}

/**
 * "look" is the kept shot's camera view: everything as you see it (the place, each subject's own picture), with what no
 * picture shows (past a world's top, the stretched ground in front of a photo, a walk-in's guesses) left flat LOOK_KEY
 * gray for the model to fill, and no stage fog over the real pixels.
 */
export function showView(scene: ThreeScene, view: "camera" | "model" | "look") {
  const flipped: Object3D[] = [];
  const uniforms: { u: { value: number }; was: number }[] = [];
  scene.traverse((o) => {
    if (o.userData[VIEW_NORMAL] || o.userData[VIEW_MODEL]) {
      const want = Boolean(o.userData[view === "model" ? VIEW_MODEL : VIEW_NORMAL]);
      if (o.visible !== want) {
        o.visible = want;
        flipped.push(o);
      }
    }
    if (o.userData[PLACE_SET] && o instanceof Mesh) {
      const u = (o.material as ShaderMaterial).uniforms?.unknown as { value: number } | undefined;
      if (u) {
        uniforms.push({ u, was: u.value });
        u.value = view === "camera" ? 0 : 1;
      }
    }
  });
  const background = scene.background;
  const fog = scene.fog;
  if (view === "model") {
    scene.background = UNKNOWN_GRAY;
    if (fog) scene.fog = new Fog(UNKNOWN_GRAY, (fog as Fog).near ?? 14, (fog as Fog).far ?? 46);
  } else if (view === "look") {
    scene.background = LOOK_KEY;
    scene.fog = null;
  }
  return () => {
    for (const o of flipped) o.visible = !o.visible;
    for (const { u, was } of uniforms) u.value = was;
    scene.background = background;
    scene.fog = fog;
  };
}

const depthVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const depthFragment = /* glsl */ `
  uniform float uNear;
  uniform float uFar;
  uniform sampler2D uMap;
  uniform bool uHasMap;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    if (uHasMap && texture2D(uMap, vUv).a < 0.5) discard;
    float inv = (1.0 / max(vDepth, 0.001) - 1.0 / uFar) / (1.0 / uNear - 1.0 / uFar);
    gl_FragColor = vec4(vec3(clamp(inv, 0.0, 1.0)), 1.0);
  }
`;

/** The cast's pictures white (cut-outs keep their outlines), everything else black. */
const flatFragment = /* glsl */ `
  uniform float uWhite;
  uniform sampler2D uMap;
  uniform bool uHasMap;
  varying vec2 vUv;
  void main() {
    if (uHasMap && texture2D(uMap, vUv).a < 0.5) discard;
    gl_FragColor = vec4(vec3(uWhite), 1.0);
  }
`;

function toBlob(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  // WebGL rows start at the bottom; flip while copying.
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    img.data.set(pixels.subarray(src, src + width * 4), y * width * 4);
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Capture failed"))), "image/png"));
}

function read(gl: WebGLRenderer, rt: WebGLRenderTarget, w: number, h: number) {
  const pixels = new Uint8Array(w * h * 4);
  gl.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
  return pixels;
}

/** Whether an object is drawn: it and every parent are visible. */
function drawn(o: Object3D) {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Nearest subject and farthest surface seen from the camera, for the depth pass's range. */
function depthRange(scene: ThreeScene, camPos: Vector3) {
  let near = Infinity;
  let far = 0;
  const box = new Box3();
  const sphere = new Sphere();
  scene.traverse((o) => {
    if (!(o instanceof Mesh) || !drawn(o) || !o.layers.isEnabled(0) || o.userData[NO_DEPTH]) return;
    box.setFromObject(o);
    if (box.isEmpty()) return;
    box.getBoundingSphere(sphere);
    const d = sphere.center.distanceTo(camPos);
    far = Math.max(far, d + sphere.radius);
    if (o.userData[SUBJECT]) near = Math.min(near, Math.max(0.1, d - sphere.radius));
  });
  if (!Number.isFinite(near)) near = 0.6;
  return { near: Math.max(0.08, near * 0.8), far: Math.min(1000, Math.max(near * 3, far, 8)) };
}

export function makeCapture(
  gl: WebGLRenderer,
  scene: ThreeScene,
  shotCamera: (aspect: number) => PerspectiveCamera,
  look: () => ShotLook,
): CaptureFn {
  return async (width, height) => {
    const cam = shotCamera(width / height);
    cam.layers.set(0);

    const renderer = new ShotRenderer(width, height);
    const out = new WebGLRenderTarget(width, height);
    const shot = (view: "camera" | "model") => {
      const restore = showView(scene, view);
      try {
        renderer.render(gl, scene, cam, view === "model" ? blockingLook(look()) : look(), out);
        return read(gl, out, width, height);
      } finally {
        restore();
      }
    };
    const guide = shot("camera");
    const blocking = shot("model");
    const sharpLook = (() => {
      const restore = showView(scene, "look");
      try {
        renderer.render(gl, scene, cam, blockingLook(look()), out);
        return read(gl, out, width, height);
      } finally {
        restore();
      }
    })();
    // Director v2's place alone in the camera view (its photo in 3D, the world around it, gaps gray), the cast's pictures
    // and their shadows left out: what a re-shoot from a new angle gets (server/director-real). The A40 test: with the
    // world around it the re-shot astronaut came out whole; with only gray around it, black space and his tears kept.
    const setOnly = (() => {
      let photoSet = false;
      scene.traverse((o) => {
        const u = o.userData[PLACE_SET] && o instanceof Mesh ? ((o.material as ShaderMaterial).uniforms?.photoSet as { value: number } | undefined) : undefined;
        if (u && u.value > 0.5) photoSet = true;
      });
      if (!photoSet) return null;
      const restore = showView(scene, "look");
      const cast: Object3D[] = [];
      scene.traverse((o) => {
        if (o.userData[SUBJECT] && o.visible) {
          o.visible = false;
          cast.push(o);
        }
      });
      try {
        renderer.render(gl, scene, cam, blockingLook(look()), out);
        return read(gl, out, width, height);
      } finally {
        for (const o of cast) o.visible = true;
        restore();
      }
    })();
    // The plate: the model's view with every stand-in gone (their shadows go with them).
    const standIns: Object3D[] = [];
    scene.traverse((o) => {
      if (o.userData[STANDIN]) standIns.push(o);
    });
    const plate = (() => {
      const restore = showView(scene, "model");
      const shown = standIns.filter((o) => o.visible);
      for (const o of shown) o.visible = false;
      try {
        renderer.render(gl, scene, cam, blockingLook(look()), out);
        return read(gl, out, width, height);
      } finally {
        for (const o of shown) o.visible = true;
        restore();
      }
    })();
    renderer.dispose();
    out.dispose();

    // Where each stand-in is in the frame, whole: every vertex projected through the camera.
    const order = new Map<string, number>();
    const boxes: CaptureResult["boxes"] = [];
    const p = new Vector3();
    const ahead = new Vector3();
    const forward = cam.getWorldDirection(new Vector3());
    for (const group of standIns) {
      const id = group.userData[STANDIN] as string;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      group.updateWorldMatrix(true, true);
      group.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const pos = o.geometry.getAttribute("position");
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          // Points behind the camera don't project; a subject reaching behind it is cut by the frame's edge anyway.
          if (ahead.copy(p).sub(cam.position).dot(forward) <= cam.near) continue;
          p.project(cam);
          const x = ((p.x + 1) / 2) * width;
          const y = ((1 - p.y) / 2) * height;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      });
      if (!Number.isFinite(x0) || x1 < 0 || y1 < 0 || x0 > width || y0 > height) continue;
      const color = ID_COLORS[order.size % ID_COLORS.length];
      order.set(id, order.size);
      const distance = new Vector3().setFromMatrixPosition(group.matrixWorld).distanceTo(cam.position);
      boxes.push({ id, box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)], distance, color });
    }

    // The ID pass: each stand-in in its flat color, the place in black (it still hides what's behind it, but not where
    // the photo never showed it), no blending.
    const ids = (() => {
      const restore = showView(scene, "model");
      const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
      const hiddenNow: Object3D[] = [];
      scene.traverse((o) => {
        if (!(o instanceof Mesh) || !o.layers.isEnabled(0)) return;
        const placeUnknown = o.userData[PLACE_SET] ? ((o.material as ShaderMaterial).uniforms?.unknown as { value: number } | undefined) : undefined;
        if (placeUnknown) {
          placeUnknown.value = 2;
          return;
        }
        if (o.userData[NO_DEPTH]) {
          if (o.visible) {
            o.visible = false;
            hiddenNow.push(o);
          }
          return;
        }
        let owner: string | null = null;
        for (let a: Object3D | null = o; a && !owner; a = a.parent) owner = (a.userData[STANDIN] as string | undefined) ?? null;
        const k = owner ? order.get(owner) : undefined;
        const [r, g, b] = k === undefined ? [0, 0, 0] : ID_COLORS[k % ID_COLORS.length];
        const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material;
        swapped.push({ mesh: o, material: o.material });
        o.material = new MeshBasicMaterial({ color: new Color().setRGB(r / 255, g / 255, b / 255, LinearSRGBColorSpace), side: src.side, fog: false });
      });
      const prev = { background: scene.background, fog: scene.fog, clear: gl.getClearColor(new Color()), alpha: gl.getClearAlpha() };
      scene.background = null;
      scene.fog = null;
      const rt = new WebGLRenderTarget(width, height, { samples: 0 });
      gl.setRenderTarget(rt);
      gl.setClearColor(0x000000, 1);
      gl.clear();
      gl.render(scene, cam);
      gl.setRenderTarget(null);
      gl.setClearColor(prev.clear, prev.alpha);
      const pixels = read(gl, rt, width, height);
      rt.dispose();
      for (const { mesh, material } of swapped) {
        (mesh.material as Material).dispose();
        mesh.material = material;
      }
      for (const o of hiddenNow) o.visible = true;
      scene.background = prev.background;
      scene.fog = prev.fog;
      restore();
      return pixels;
    })();

    // The cast's own pictures as the camera view shows them, white on black, behind whatever of the place covers them:
    // where a kept shot re-shot from a new angle puts them back (server/director-real).
    const cuts = (() => {
      const restore = showView(scene, "look");
      const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
      const hiddenNow: Object3D[] = [];
      scene.traverse((o) => {
        if (!(o instanceof Mesh) || !o.visible || !o.layers.isEnabled(0)) return;
        const placeUnknown = o.userData[PLACE_SET] ? ((o.material as ShaderMaterial).uniforms?.unknown as { value: number } | undefined) : undefined;
        if (placeUnknown) {
          placeUnknown.value = 2;
          return;
        }
        if (o.userData[NO_DEPTH]) {
          o.visible = false;
          hiddenNow.push(o);
          return;
        }
        const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material & { map?: Texture | null };
        const cutout = (src.userData.cutoutMap as Texture | undefined) ?? (src.transparent || src.alphaTest > 0 ? src.map : null);
        swapped.push({ mesh: o, material: o.material });
        o.material = new ShaderMaterial({
          vertexShader: depthVertex,
          fragmentShader: flatFragment,
          uniforms: { uWhite: { value: o.userData[SUBJECT] ? 1 : 0 }, uMap: { value: cutout ?? null }, uHasMap: { value: Boolean(cutout) } },
          side: src.side,
        });
      });
      const prev = { background: scene.background, fog: scene.fog, clear: gl.getClearColor(new Color()), alpha: gl.getClearAlpha() };
      scene.background = null;
      scene.fog = null;
      const rt = new WebGLRenderTarget(width, height, { samples: 4 });
      gl.setRenderTarget(rt);
      gl.setClearColor(0x000000, 1);
      gl.clear();
      gl.render(scene, cam);
      gl.setRenderTarget(null);
      gl.setClearColor(prev.clear, prev.alpha);
      const pixels = read(gl, rt, width, height);
      rt.dispose();
      for (const { mesh, material } of swapped) {
        (mesh.material as Material).dispose();
        mesh.material = material;
      }
      for (const o of hiddenNow) o.visible = true;
      scene.background = prev.background;
      scene.fog = prev.fog;
      restore();
      return pixels;
    })();

    // Depth pass of the blocking set: every mesh draws its inverse depth, cutouts keep their silhouettes.
    const restore = showView(scene, "model");
    const { near, far } = depthRange(scene, cam.position);
    const swapped: { mesh: Mesh; material: Material | Material[] }[] = [];
    const hidden: Object3D[] = [];
    scene.traverse((o) => {
      if (!(o instanceof Mesh) || !o.visible || !o.layers.isEnabled(0)) return;
      if (o.userData[NO_DEPTH]) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      const src = (Array.isArray(o.material) ? o.material[0] : o.material) as Material & { map?: Texture | null };
      // Cutouts keep their silhouettes: their map is on the material, or on userData for custom shaders.
      const cutout = (src.userData.cutoutMap as Texture | undefined) ?? (src.transparent || src.alphaTest > 0 ? src.map : null);
      swapped.push({ mesh: o, material: o.material });
      o.material = new ShaderMaterial({
        vertexShader: depthVertex,
        fragmentShader: depthFragment,
        uniforms: {
          uNear: { value: near },
          uFar: { value: far },
          uMap: { value: cutout ?? null },
          uHasMap: { value: Boolean(cutout) },
        },
        side: src.side,
      });
    });
    const prevBackground = scene.background;
    const prevFog = scene.fog;
    scene.background = new Color(0, 0, 0);
    scene.fog = null;
    const rt = new WebGLRenderTarget(width, height, { samples: 4 });
    const prevClear = gl.getClearColor(new Color());
    const prevAlpha = gl.getClearAlpha();
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(scene, cam);
    gl.setRenderTarget(null);
    gl.setClearColor(prevClear, prevAlpha);
    const depth = read(gl, rt, width, height);
    rt.dispose();

    for (const { mesh, material } of swapped) {
      (mesh.material as Material).dispose();
      mesh.material = material;
    }
    for (const o of hidden) o.visible = true;
    scene.background = prevBackground;
    scene.fog = prevFog;
    restore();

    const [guideBlob, blockingBlob, depthBlob, plateBlob, idsBlob, lookBlob, setBlob, cutsBlob] = await Promise.all([
      toBlob(guide, width, height),
      toBlob(blocking, width, height),
      toBlob(depth, width, height),
      toBlob(plate, width, height),
      toBlob(ids, width, height),
      toBlob(sharpLook, width, height),
      setOnly ? toBlob(setOnly, width, height) : Promise.resolve(null),
      toBlob(cuts, width, height),
    ]);
    return { guide: guideBlob, blocking: blockingBlob, depth: depthBlob, plate: plateBlob, ids: idsBlob, look: lookBlob, set: setBlob, cuts: cutsBlob, boxes, width, height };
  };
}
