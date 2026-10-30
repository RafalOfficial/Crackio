"use client";

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PerspectiveCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { photoCamera, placeSurface, type DepthMap } from "@/lib/director/reconstruct";
import type { PlaceView } from "@/lib/director/types";
import type { SubjectMask } from "@/lib/director/vision";
import { angleCamera, type AngleBase, type AngleShot } from "@/lib/angles/rig";
import { openCurtains, subjectSurface } from "@/lib/angles/surface";

/**
 * The photo as a soft 3D set for the Angles tool: Director's surface (reconstruct.ts) with its soft
 * smear, plus the subject as a solid with a back (subject.ts). What the photo never saw is left
 * open, so the model is told plainly what to invent: streaks across depth edges become holes and
 * the backs of things show only a wash of their colors. Drawn straight to sRGB, so the screen and
 * the guide image the model gets look the same.
 */

/** Around the set on screen. */
export const SCREEN_VOID = "#101114";
/** Around the set in the guide: flat mid-gray, which the prompt calls "never seen". */
const GUIDE_GRAY = 0.5;

const vertex = /* glsl */ `
  attribute vec3 flatPos;
  attribute float outside;
  attribute float stretch;
  attribute float back;
  uniform float reveal;
  varying vec2 vUv;
  varying float vOutside;
  varying float vStretch;
  varying float vBack;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vOutside = outside;
    vStretch = stretch;
    vBack = back;
    vec4 world = modelMatrix * vec4(mix(flatPos, position, reveal), 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D mask;
  uniform float cut;
  uniform vec3 background;
  uniform vec3 eye;
  varying vec2 vUv;
  varying float vOutside;
  varying float vStretch;
  varying float vBack;
  varying vec3 vWorld;

  vec3 toSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }

  void main() {
    // The subject is its own solid: the set leaves a hole where it stood, the solid keeps only it.
    if (cut > 0.5) {
      float subject = texture2D(mask, vec2(vUv.x, 1.0 - vUv.y)).r;
      if (cut < 1.5 ? subject > 0.5 : subject <= 0.5) discard;
    }
    // How squarely the photo saw this surface (1 = head-on, 0 = edge-on, from where it was taken).
    // Surfaces it only grazed hold almost no detail: they blur and fade into the void, not streak.
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float seen = smoothstep(0.06, 0.3, abs(dot(n, normalize(vWorld - eye))));
    vec3 c = texture2D(map, vUv, vStretch * 4.5 + (1.0 - seen) * 3.0).rgb * (1.0 - 0.25 * vStretch);
    c = mix(background, c, seen);
    // Backs were never photographed: only a wash of their colors, so no face ends up on the back of a head.
    if (vBack > 0.5 || !gl_FrontFacing) c = mix(texture2D(map, vUv, 7.0).rgb, background, 0.3);
    // Past the photo's edges, the stretched border fades into the void.
    c = mix(c, background, smoothstep(0.0, 1.0, vOutside) * 0.9);
    gl_FragColor = vec4(toSrgb(c), 1.0);
  }
`;

/** Photos are sRGB; set once when a texture first loads (drei caches it by URL, Director shares it). */
export function asPhoto(texture: Texture | Texture[]) {
  for (const t of Array.isArray(texture) ? texture : [texture]) {
    if (t.colorSpace === SRGBColorSpace) continue;
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
}

/** Where each vertex starts on the flat photo, along its own ray, so the set can swell into 3D. */
function withFlatStart(g: BufferGeometry, positions: Float32Array, view: PlaceView) {
  const { position: eye } = photoCamera(view);
  const flat = new Float32Array(positions.length);
  const p = new Vector3();
  const distance = view.pivot * 1.8;
  for (let i = 0; i < flat.length; i += 3) {
    p.set(positions[i], positions[i + 1], positions[i + 2]).sub(eye);
    const along = p.length();
    p.multiplyScalar(along > 0 ? distance / along : 0).add(eye);
    flat.set([p.x, p.y, p.z], i);
  }
  g.setAttribute("flatPos", new BufferAttribute(flat, 3));
  return g;
}

export type AngleSet = { place: BufferGeometry; subject: BufferGeometry | null; mask: DataTexture | null; eye: Vector3 };

/** The set's geometry: the place, and the subject as a solid when the mask found one. */
export function buildSet(depth: DepthMap, view: PlaceView, aspect: number, mask: SubjectMask | null): AngleSet {
  const surface = placeSurface(depth, view, aspect);
  const count = surface.positions.length / 3;
  const place = new BufferGeometry();
  place.setAttribute("position", new BufferAttribute(surface.positions, 3));
  place.setAttribute("uv", new BufferAttribute(surface.uvs, 2));
  place.setAttribute("outside", new BufferAttribute(surface.outside, 1));
  place.setAttribute("stretch", new BufferAttribute(surface.stretch, 1));
  place.setAttribute("back", new BufferAttribute(new Float32Array(count), 1));
  // Curtains stretched across depth edges were never seen: holes, not streaks.
  place.setIndex(new BufferAttribute(openCurtains(surface.positions, surface.index, view), 1));
  withFlatStart(place, surface.positions, view);

  const eye = photoCamera(view).position;
  const solid = mask ? subjectSurface(depth, mask, view, aspect) : null;
  if (!mask || !solid) return { place, subject: null, mask: null, eye };
  const n = solid.positions.length / 3;
  const subject = new BufferGeometry();
  subject.setAttribute("position", new BufferAttribute(solid.positions, 3));
  subject.setAttribute("uv", new BufferAttribute(solid.uvs, 2));
  subject.setAttribute("outside", new BufferAttribute(new Float32Array(n), 1));
  subject.setAttribute("stretch", new BufferAttribute(new Float32Array(n), 1));
  subject.setAttribute("back", new BufferAttribute(solid.back, 1));
  subject.setIndex(new BufferAttribute(solid.index, 1));
  withFlatStart(subject, solid.positions, view);

  const texture = new DataTexture(mask.data, mask.width, mask.height, RedFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { place, subject, mask: texture, eye };
}

export function disposeSet(set: AngleSet) {
  set.place.dispose();
  set.subject?.dispose();
  set.mask?.dispose();
}

/**
 * One material per mesh. `part` says what the mask cuts: the place loses the subject, the subject
 * keeps only itself. `background` is the void everything fades into.
 */
export function setMaterial(texture: Texture, set: AngleSet, part: "place" | "subject", background: Color, reveal = 1) {
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    side: DoubleSide,
    uniforms: {
      map: { value: texture },
      mask: { value: set.mask },
      cut: { value: set.mask ? (part === "place" ? 1 : 2) : 0 },
      reveal: { value: reveal },
      background: { value: background },
      eye: { value: set.eye },
    },
  });
}

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
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't render the new angle."))), "image/png"));
}

/**
 * The set seen from the shot camera, at the photo's shape: the picture the model finishes.
 * Rendered off screen with its own renderer, so it doesn't depend on what the page is showing.
 */
export async function renderGuide(opts: {
  url: string;
  depth: DepthMap;
  mask: SubjectMask | null;
  place: PlaceView;
  aspect: number;
  base: AngleBase;
  shot: AngleShot;
  longEdge?: number;
}) {
  const long = opts.longEdge ?? 1536;
  const width = opts.aspect >= 1 ? long : Math.round(long * opts.aspect);
  const height = opts.aspect >= 1 ? Math.round(long / opts.aspect) : long;

  const texture = await new TextureLoader().loadAsync(opts.url);
  asPhoto(texture);
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas"), antialias: false });
  const set = buildSet(opts.depth, opts.place, opts.aspect, opts.mask);
  // The shader encodes to sRGB itself, so it gets the gray as a color; the clear below is raw.
  const gray = new Color().setRGB(GUIDE_GRAY, GUIDE_GRAY, GUIDE_GRAY, SRGBColorSpace);
  const materials = [setMaterial(texture, set, "place", gray)];
  const scene = new Scene();
  const placeMesh = new Mesh(set.place, materials[0]);
  placeMesh.frustumCulled = false;
  scene.add(placeMesh);
  if (set.subject) {
    materials.push(setMaterial(texture, set, "subject", gray));
    const subjectMesh = new Mesh(set.subject, materials[1]);
    subjectMesh.frustumCulled = false;
    scene.add(subjectMesh);
  }

  const cam = angleCamera(opts.base, opts.shot);
  const camera = new PerspectiveCamera(cam.fov, width / height, Math.max(0.02, cam.distance * 0.02), (cam.distance + opts.place.far) * 6);
  camera.position.copy(cam.position);
  camera.quaternion.copy(cam.quaternion);
  camera.updateMatrixWorld(true);

  const target = new WebGLRenderTarget(width, height, { samples: 4 });
  try {
    renderer.setRenderTarget(target);
    // Render targets take the clear color as it is (no sRGB step): the same gray, written raw.
    renderer.setClearColor(new Color().setRGB(GUIDE_GRAY, GUIDE_GRAY, GUIDE_GRAY, LinearSRGBColorSpace), 1);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return { blob: await toBlob(pixels, width, height), width, height };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    disposeSet(set);
    for (const m of materials) m.dispose();
    texture.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
