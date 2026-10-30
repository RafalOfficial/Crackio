import {
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { fit, glEpoch, present, renderer, texture } from "../gl";
import META from "./director-meta.json";

/**
 * Director's demo stage, the way Director works: one location photo becomes a 3D set (its depth
 * pushes every pixel back along its own ray, so from the photo's own camera nothing changes, and
 * from anywhere else it's a place), the cast stands in it as cut-outs (the car from 17 real angles,
 * so it turns), and the shot is taken from the photo's own camera, so the set is the photo.
 */

const A = "/assets/showcase/director";
export type V3 = [number, number, number];
export type Cam = { eye: V3; at: V3; fov: number };
export type ItemId = "woman" | "car";
export const ITEMS: ItemId[] = ["woman", "car"];

/** The photo's own camera: at the origin, looking down -z, with this field of view. */
export const PHOTO_FOV = 55;
const ASPECT = 0.8;
const TAN = Math.tan(((PHOTO_FOV / 2) * Math.PI) / 180);
/** Depth (1 near … 0 far) to distance: an inverse mapping, like the depth model's disparity. */
const Z_NEAR = 3.2;
const Z_FAR = 90;
/** Where the photo hangs while it's still a flat picture. */
const Z_FLAT = 11;
const zOf = (d: number) => 1 / (d / Z_NEAR + (1 - d) / Z_FAR);
/** Where the place runs out: a deep warm dark from the place itself, not a black hole. */
const VOID_HEX = "#24170f";
const VOID = `vec3(${[0x24, 0x17, 0x0f].map((x) => (x / 255).toFixed(3)).join(", ")})`;
/** How far the set runs past the picture's edges (across, and below it), out of focus. */
const PAST = 0.6;

/** Real heights (the car's atlas cells have a little room above it). */
const HEIGHT: Record<ItemId, number> = { woman: 1.7, car: 1.3 };

export type Piece = {
  /** Where it stands, as a point of the photo (u across, v up). */
  u: number;
  v: number;
  o: number;
  /** Height above the ground while it drops in (0 landed). */
  drop: number;
  /** How much of it has materialized, from the feet up. */
  reveal: number;
  s: number;
  sy: number;
};

export type StageState = {
  cam: Cam;
  /** How far the photo has become a set (0 a flat picture … 1 the place), built from the bottom up. */
  inflate: number;
  /** The preview grid over the ground (it goes as the shot becomes a photograph again). */
  grid: number;
  pieces: Record<ItemId, Piece>;
  /** How far round from its nose the photo's camera sees the car (35° front three-quarter … 180° behind). */
  carYaw: number;
  ring: { id: ItemId; o: number };
  turn: { o: number; a: number };
  dust: number;
  /** The render: 0 the set … 1 the photograph, burning outward from `center` (card fractions, y up). */
  dissolve: number;
  center: [number, number];
};

const VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uInflate;
uniform float uTan;
uniform float uAspect;
varying vec2 vUv;
varying float vDepth;
varying float vBuilt;
varying vec3 vWorld;
void main() {
  vUv = uv;
  float d = texture2D(uDepth, clamp(uv, 0.0, 1.0)).r;
  vDepth = d;
  // The set is built from the bottom of the picture up (what lies past its edges, with the edge).
  float k = clamp(uInflate * 1.6 - clamp(uv.y, 0.0, 1.0) * 0.6, 0.0, 1.0);
  vBuilt = k;
  float zd = 1.0 / (d / ${Z_NEAR.toFixed(2)} + (1.0 - d) / ${Z_FAR.toFixed(2)});
  // Below the picture the ground goes on: the further down a ray looks, the nearer it meets it.
  zd /= 1.0 - 2.0 * min(uv.y, 0.0);
  float z = mix(${Z_FLAT.toFixed(2)}, zd, k);
  vec3 p = vec3((uv.x * 2.0 - 1.0) * uTan * uAspect, (uv.y * 2.0 - 1.0) * uTan, -1.0) * z;
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPhoto;
uniform float uInflate;
uniform float uGrid;
uniform float uAway;
uniform vec3 uHue;
varying vec2 vUv;
varying float vDepth;
varying float vBuilt;
varying vec3 vWorld;
void main() {
  // How far past the picture's sides and bottom (negative inside it).
  float sd = max(max(-vUv.x, vUv.x - 1.0), -vUv.y);
  float out_ = max(sd, 0.0);
  vec3 c = texture2D(uPhoto, clamp(vUv, 0.0, 1.0)).rgb;
  // Past its edges the place goes on out of focus (mirrored, blurrier and darker the further out) into the dark,
  // and once the camera has left the photo's spot, the picture's own edges soften into that.
  float soft = sd > 0.0 ? 1.0 : smoothstep(-0.05, 0.0, sd) * uAway;
  if (soft > 0.0) {
    vec2 m = 1.0 - abs(mod(vUv, 2.0) - 1.0);
    float r = 0.012 * uAway + out_ * 0.12;
    vec3 b = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 2.39996;
      vec2 q = m + vec2(cos(a), sin(a) * 0.8) * r * sqrt((float(i) + 0.5) / 12.0);
      b += texture2D(uPhoto, clamp(q, 0.0, 1.0)).rgb;
    }
    c = mix(c, b / 12.0, soft);
    c = mix(c * (1.0 - 0.18 * smoothstep(0.0, 0.25, out_)), ${VOID}, smoothstep(0.08, 0.55, out_));
  }
  float inside = 1.0 - smoothstep(0.0, 0.3, out_);
  // The building edge: a band of light, with the set's grid glowing just behind it.
  float glow = exp(-pow((vBuilt - 0.5) * 7.0, 2.0)) * step(0.001, uInflate) * step(uInflate, 0.999);
  vec2 g = abs(fract(vWorld.xz * 0.9) - 0.5);
  float line = 1.0 - smoothstep(0.0, 0.035, min(g.x, g.y));
  float ground = smoothstep(0.02, 0.2, vDepth) * (1.0 - smoothstep(12.0, 32.0, length(vWorld))) * inside;
  c += uHue * line * ground * (glow * 1.4 + uGrid * 0.2);
  c += vec3(1.0, 0.85, 0.7) * glow * 0.3 * inside;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** A cut-out that materializes from its feet up, with a seam of light at the edge. */
const SPRITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SPRITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec2 uOffset;
uniform vec2 uRepeat;
uniform float uOpacity;
uniform float uReveal;
uniform vec3 uHue;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, uOffset + vUv * uRepeat);
  if (t.a < 0.04) discard;
  float at = uReveal * 1.08;
  float shown = step(vUv.y, at);
  float seam = exp(-pow((vUv.y - at) * 40.0, 2.0)) * step(uReveal, 0.999);
  gl_FragColor = vec4(t.rgb + uHue * seam * 1.6, t.a * uOpacity * max(shown, seam));
}
`;

/** From the set to the photograph: a burn of light spreading from one point. */
const MIX_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const MIX_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSet;
uniform sampler2D uShot;
uniform float uK;
uniform vec2 uCenter;
uniform float uAspect;
uniform vec3 uHue;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 a = texture2D(uSet, vUv).rgb;
  vec3 b = texture2D(uShot, vUv).rgb;
  float n = noise(vUv * 9.0) * 0.6 + noise(vUv * 23.0) * 0.4;
  float t = length((vUv - uCenter) * vec2(uAspect, 1.0)) * 0.9 + n * 0.35;
  float r = uK * 1.6;
  float m = 1.0 - smoothstep(r - 0.04, r, t);
  float rim = exp(-pow((t - r + 0.02) * 26.0, 2.0)) * step(0.001, uK) * step(uK, 0.999);
  gl_FragColor = vec4(mix(a, b, m) + (uHue * 1.3 + 0.35) * rim, 1.0);
}
`;

function radial(stops: [number, string][], size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const v3 = (p: V3) => new Vector3(p[0], p[1], p[2]);

type Sprite = { mesh: Mesh; mat: ShaderMaterial; shadow: Mesh };

export class Stage {
  private scene = new Scene();
  private camera = new PerspectiveCamera(PHOTO_FOV, ASPECT, 0.05, 200);
  private setMat: ShaderMaterial;
  private sprites = {} as Record<ItemId, Sprite>;
  private puffs: Mesh[] = [];
  private ring: Mesh;
  private turn: Group;
  private handle: Mesh;
  private target: WebGLRenderTarget | null = null;
  private mix: { scene: Scene; camera: OrthographicCamera; mat: ShaderMaterial };
  private depth: Float32Array | null = null;
  private depthSize = [0, 0];
  private carCells: number;
  private disposables: (BufferGeometry | Material | Texture)[] = [];
  private last = "";
  readonly ready: Promise<unknown>;

  constructor(hue: string) {
    const keep = <T extends BufferGeometry | Material | Texture>(x: T) => {
      this.disposables.push(x);
      return x;
    };
    const hueC = new Color(hue);
    const hueV = () => new Vector3(hueC.r, hueC.g, hueC.b);
    this.scene.background = new Color(VOID_HEX);
    const photo = texture(`${A}/loc.webp`);
    const depth = texture(`${A}/loc-depth.png`);
    this.setMat = keep(
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: DoubleSide,
        uniforms: { uPhoto: { value: null }, uDepth: { value: null }, uInflate: { value: 0 }, uGrid: { value: 0 }, uAway: { value: 0 }, uTan: { value: TAN }, uAspect: { value: ASPECT }, uHue: { value: hueV() } },
      }),
    );
    void photo.promise.then((t) => (this.setMat.uniforms.uPhoto.value = t));
    void depth.promise.then((t) => {
      this.setMat.uniforms.uDepth.value = t;
      this.readDepth(t.image as HTMLImageElement);
    });
    // The picture and what lies past its sides and bottom edge (the same density of vertices inside it as before).
    const geo = keep(new PlaneGeometry(1, 1, Math.round(140 * (1 + 2 * PAST)), Math.round(175 * (1 + PAST))));
    const uvs = geo.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, -PAST + uvs.getX(i) * (1 + 2 * PAST), -PAST + uvs.getY(i) * (1 + PAST));
    const set = new Mesh(geo, this.setMat);
    set.frustumCulled = false;
    this.scene.add(set);

    // The cast.
    const contact = keep(radial([[0, "rgba(0,0,0,0.6)"], [0.55, "rgba(0,0,0,0.26)"], [1, "rgba(0,0,0,0)"]]));
    const meta = META as unknown as { woman: { w: number; h: number }; car: { cell: number[]; cols: number; rows: number; n: number } };
    this.carCells = meta.car.n;
    const loads: Promise<unknown>[] = [photo.promise, depth.promise];
    for (const id of ITEMS) {
      const tex = texture(`${A}/${id}.webp`);
      loads.push(tex.promise);
      const h = id === "car" ? HEIGHT.car * (meta.car.cell[1] / 140) : HEIGHT.woman;
      const w = id === "car" ? h * (meta.car.cell[0] / meta.car.cell[1]) : h * (meta.woman.w / meta.woman.h);
      const geo = keep(new PlaneGeometry(w, h));
      geo.translate(0, h / 2, 0);
      const mat = keep(
        new ShaderMaterial({
          vertexShader: SPRITE_VERT,
          fragmentShader: SPRITE_FRAG,
          transparent: true,
          depthWrite: false,
          uniforms: {
            uMap: { value: null },
            uOffset: { value: new Vector2(0, 0) },
            uRepeat: { value: id === "car" ? new Vector2(1 / meta.car.cols, 1 / meta.car.rows) : new Vector2(1, 1) },
            uOpacity: { value: 1 },
            uReveal: { value: 1 },
            uHue: { value: hueV() },
          },
        }),
      );
      void tex.promise.then((t) => (mat.uniforms.uMap.value = t));
      const mesh = new Mesh(geo, mat);
      mesh.renderOrder = id === "woman" ? 3 : 2;
      const shadow = new Mesh(keep(new PlaneGeometry(id === "car" ? 4.6 : 1.1, id === "car" ? 2.2 : 0.55)), keep(new MeshBasicMaterial({ map: contact, transparent: true, depthWrite: false })));
      shadow.rotation.x = -Math.PI / 2;
      shadow.renderOrder = 1;
      this.scene.add(shadow, mesh);
      this.sprites[id] = { mesh, mat, shadow };
    }
    const dust = keep(radial([[0, "rgba(232,214,190,0.8)"], [1, "rgba(232,214,190,0)"]], 64));
    for (let i = 0; i < 8; i++) {
      const p = new Mesh(keep(new PlaneGeometry(0.9, 0.9)), keep(new MeshBasicMaterial({ map: dust, transparent: true, depthWrite: false, opacity: 0 })));
      p.renderOrder = 4;
      this.puffs.push(p);
      this.scene.add(p);
    }
    // Selection and the car's turntable, on the ground.
    this.ring = new Mesh(keep(new RingGeometry(0.5, 0.58, 64)), keep(new MeshBasicMaterial({ color: hueC, transparent: true, depthWrite: false, side: DoubleSide })));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 1;
    this.scene.add(this.ring);
    this.turn = new Group();
    const torus = new Mesh(keep(new TorusGeometry(2.4, 0.03, 8, 120)), keep(new MeshBasicMaterial({ color: hueC, transparent: true, depthWrite: false })));
    torus.rotation.x = Math.PI / 2;
    this.handle = new Mesh(keep(new SphereGeometry(0.16, 20, 12)), keep(new MeshBasicMaterial({ color: "#ffffff", transparent: true })));
    this.turn.add(torus, this.handle);
    this.turn.renderOrder = 1;
    this.scene.add(this.turn);

    // The render: the set and the photograph, mixed by a burn of light.
    const shot = texture(`${A}/render.webp`);
    loads.push(shot.promise);
    const mixMat = keep(
      new ShaderMaterial({
        vertexShader: MIX_VERT,
        fragmentShader: MIX_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: { uSet: { value: null }, uShot: { value: null }, uK: { value: 0 }, uCenter: { value: new Vector2(0.5, 0.5) }, uAspect: { value: ASPECT }, uHue: { value: hueV() } },
      }),
    );
    void shot.promise.then((t) => (mixMat.uniforms.uShot.value = t));
    const mixScene = new Scene();
    mixScene.add(new Mesh(keep(new PlaneGeometry(2, 2)), mixMat));
    this.mix = { scene: mixScene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), mat: mixMat };
    this.ready = Promise.all(loads);
  }

  /** Keep the depth on the CPU too, to stand the cast on the ground. */
  private readDepth(img: HTMLImageElement) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const out = new Float32Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4] / 255;
    this.depth = out;
    this.depthSize = [c.width, c.height];
    this.last = "";
  }

  /** Whether the depth has been read (the cast can only stand on the ground once it has). */
  get grounded() {
    return this.depth !== null;
  }

  /** The set's depth (1 near … 0 far) at a point of the photo (u across, v up). */
  depthAt(u: number, v: number) {
    if (!this.depth) return 0.85;
    const [w, h] = this.depthSize;
    const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const y = Math.min(h - 1, Math.max(0, Math.round((1 - v) * (h - 1))));
    return this.depth[y * w + x];
  }

  /** Where a point of the photo is in the built set. */
  where(u: number, v: number): V3 {
    const z = zOf(this.depthAt(u, v));
    return [(u * 2 - 1) * TAN * ASPECT * z, (v * 2 - 1) * TAN * z, -z];
  }

  /** A point of the set on the card, in %. */
  static project(p: V3, cam: Cam) {
    const c = new PerspectiveCamera(cam.fov, ASPECT, 0.05, 200);
    c.position.copy(v3(cam.eye));
    c.lookAt(v3(cam.at));
    c.updateMatrixWorld();
    const q = v3(p).project(c);
    return { x: (q.x * 0.5 + 0.5) * 100, y: (-q.y * 0.5 + 0.5) * 100 };
  }

  static handleAt(c: V3, a: number): V3 {
    return [c[0] + Math.sin(a) * 2.4, c[1] + 0.04, c[2] + Math.cos(a) * 2.4];
  }

  /** The car's picture for this view (and whether it's seen from its other side). */
  private carFrame(st: StageState, at: V3) {
    const az = (e: V3) => (Math.atan2(e[0] - at[0], e[2] - at[2]) * 180) / Math.PI;
    const phi = st.carYaw + az(st.cam.eye) - az([0, 0, 0]);
    const n = this.carCells - 1;
    return { frame: Math.max(0, Math.min(n, Math.round(((Math.abs(phi) - 35) / 145) * n))), flip: phi < 0 };
  }

  draw(canvas: HTMLCanvasElement, st: StageState) {
    fit(canvas);
    if (!this.setMat.uniforms.uPhoto.value || !this.setMat.uniforms.uDepth.value) return;
    const key = JSON.stringify(st) + canvas.width + "x" + canvas.height + "@" + glEpoch() + (this.depth ? "d" : "");
    if (key === this.last) return;
    this.last = key;
    const cam = this.camera;
    cam.fov = st.cam.fov;
    cam.aspect = canvas.width / canvas.height;
    cam.position.copy(v3(st.cam.eye));
    cam.lookAt(v3(st.cam.at));
    cam.updateProjectionMatrix();
    this.setMat.uniforms.uInflate.value = st.inflate;
    this.setMat.uniforms.uGrid.value = st.grid;
    this.setMat.uniforms.uAway.value = Math.min(1, Math.hypot(...st.cam.eye) / 0.6);

    const meta = META.car;
    for (const id of ITEMS) {
      const sp = this.sprites[id];
      const p = st.pieces[id];
      const on = p.o > 0.01;
      sp.mesh.visible = sp.shadow.visible = on;
      if (!on) continue;
      const base = this.where(p.u, p.v);
      const lift = p.drop * 3.2;
      sp.mesh.position.set(base[0], base[1] + lift, base[2]);
      sp.mesh.rotation.set(0, Math.atan2(cam.position.x - base[0], cam.position.z - base[2]), 0);
      const view = id === "car" ? this.carFrame(st, base) : null;
      sp.mesh.scale.set(p.s * (view?.flip ? -1 : 1), p.s * p.sy, p.s);
      const u = sp.mat.uniforms;
      u.uOpacity.value = p.o;
      u.uReveal.value = p.reveal;
      if (view) (u.uOffset.value as Vector2).set((view.frame % meta.cols) / meta.cols, 1 - (Math.floor(view.frame / meta.cols) + 1) / meta.rows);
      sp.shadow.position.set(base[0], base[1] + 0.01, base[2]);
      const near = Math.max(0, 1 - lift / 2.5);
      sp.shadow.scale.setScalar(p.s * (0.5 + 0.5 * near));
      (sp.shadow.material as MeshBasicMaterial).opacity = near * p.o * Math.min(1, p.reveal * 1.5);
    }
    // The car's landing kicks up dust.
    const car = this.where(st.pieces.car.u, st.pieces.car.v);
    this.puffs.forEach((m, i) => {
      const d = st.dust;
      m.visible = d > 0 && d < 1;
      if (!m.visible) return;
      const a = (i / this.puffs.length) * Math.PI * 2;
      const r = 0.4 + d * 2.6;
      m.position.set(car[0] + Math.sin(a) * r, car[1] + 0.15 + d * 0.4, car[2] + Math.cos(a) * r * 0.5);
      m.quaternion.copy(cam.quaternion);
      m.scale.setScalar(0.6 + d * 2.2);
      (m.material as MeshBasicMaterial).opacity = 0.6 * (1 - d);
    });
    // Selection, the turntable.
    const sel = this.where(st.pieces[st.ring.id].u, st.pieces[st.ring.id].v);
    this.ring.visible = st.ring.o > 0.01;
    this.ring.position.set(sel[0], sel[1] + 0.02, sel[2]);
    this.ring.scale.setScalar(st.ring.id === "car" ? 4 : 1);
    (this.ring.material as MeshBasicMaterial).opacity = st.ring.o;
    this.turn.visible = st.turn.o > 0.01;
    this.turn.position.set(car[0], car[1] + 0.04, car[2]);
    this.turn.children.forEach((c) => (((c as Mesh).material as MeshBasicMaterial).opacity = st.turn.o));
    this.handle.position.set(Math.sin(st.turn.a) * 2.4, 0, Math.cos(st.turn.a) * 2.4);

    if (st.dissolve <= 0) {
      present(canvas, this.scene, cam);
      return;
    }
    // The render: the set into a texture, then burned into the photograph.
    const r = renderer();
    if (!this.target || this.target.width !== canvas.width || this.target.height !== canvas.height) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(canvas.width, canvas.height, { minFilter: LinearFilter, magFilter: LinearFilter });
    }
    const size = new Vector2();
    r.getSize(size);
    if (size.x !== canvas.width || size.y !== canvas.height) r.setSize(canvas.width, canvas.height, false);
    r.setRenderTarget(this.target);
    r.render(this.scene, cam);
    r.setRenderTarget(null);
    const m = this.mix.mat.uniforms;
    m.uSet.value = this.target.texture;
    m.uK.value = st.dissolve;
    (m.uCenter.value as Vector2).set(st.center[0], st.center[1]);
    present(canvas, this.mix.scene, this.mix.camera);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.target?.dispose();
  }
}
