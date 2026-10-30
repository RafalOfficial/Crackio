import {
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Camera,
  type Texture,
  TextureLoader,
  Vector2,
  WebGLRenderer,
} from "three";

/**
 * One WebGL context for the whole showcase. Browsers allow only a handful, and the rail holds two
 * copies of every demo, so each demo draws into a plain 2D canvas: the shared renderer renders its
 * scene, and the picture is copied across in the same frame.
 */
let R: WebGLRenderer | null = null;
const size = new Vector2();
/** Bumped when the GPU gives the context back after losing it: every scene draws again from scratch. */
let epoch = 0;
export const glEpoch = () => epoch;

export function renderer() {
  if (!R) {
    const canvas = document.createElement("canvas");
    R = new WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: "low-power" });
    R.setPixelRatio(1);
    R.outputColorSpace = SRGBColorSpace;
    R.shadowMap.enabled = true;
    R.shadowMap.type = PCFShadowMap;
    // three.js keeps the context restorable; once it's back, nothing may skip its next frame.
    canvas.addEventListener("webglcontextrestored", () => epoch++);
  }
  return R;
}

/** Render `scene` at the target canvas's pixel size and copy it there. */
export function present(target: HTMLCanvasElement, scene: Scene, camera: Camera) {
  const r = renderer();
  const w = target.width;
  const h = target.height;
  if (!w || !h) return;
  r.getSize(size);
  if (size.x !== w || size.y !== h) r.setSize(w, h, false);
  r.render(scene, camera);
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(r.domElement, 0, 0);
}

/** Keep a canvas's backing store at its CSS size × device pixels (capped at 2×). */
export function fit(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/* ------------------------------------------------------------------ textures */

type Entry = { tex: Texture | null; promise: Promise<Texture>; used: number; idle: boolean };
const textures = new Map<string, Entry>();
const loader = new TextureLoader();

/** A texture by URL, shared by every demo. Raw sRGB values in, raw out: no color management. */
export function texture(url: string): Entry {
  let e = textures.get(url);
  if (!e) {
    const entry: Entry = { tex: null, used: performance.now(), idle: false, promise: null as unknown as Promise<Texture> };
    entry.promise = loader.loadAsync(url).then((t) => {
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      t.generateMipmaps = false;
      entry.tex = t;
      return t;
    });
    textures.set(url, entry);
    e = entry;
  }
  touch(e);
  return e;
}

function touch(e: Entry) {
  e.used = performance.now();
  e.idle = false;
}

// Pictures nobody has drawn for a while give their GPU memory back; three.js uploads them again
// the next time they're drawn (the decoded image stays in memory, so that takes a few ms).
if (typeof window !== "undefined") {
  setInterval(() => {
    const now = performance.now();
    for (const e of textures.values()) {
      if (e.tex && !e.idle && now - e.used > 45_000) {
        e.tex.dispose();
        e.idle = true;
      }
    }
  }, 10_000);
}

/* ------------------------------------------------------------------ the living photo */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * A photo with depth: every pixel is pushed by its depth as the camera drifts, so a still breathes
 * like a slow dolly shot. Two looks of the same picture blend through one of three transitions
 * (a crossfade, a pour from a point, or a straight wipe), optionally only inside a mask.
 */
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform sampler2D uDepth;
uniform sampler2D uMask;
uniform float uK;
uniform float uR;
uniform float uEdge;
uniform float uMode;
uniform float uSoft;
uniform float uMasked;
uniform float uZoom;
uniform float uFocus;
uniform float uAspect;
uniform float uAngle;
uniform vec2 uCenter;
uniform vec2 uZ;
uniform vec2 uPar;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec2 uv = (vUv - uZ) / uZoom + uZ;
  float d = texture2D(uDepth, uv).r;
  vec2 st = clamp(uv + uPar * (d - uFocus), 0.001, 0.999);
  vec4 a = texture2D(uFrom, st);
  vec4 b = texture2D(uTo, st);
  float m = uK;
  if (uMode > 0.5 && uMode < 1.5) {
    vec2 q = (st - uCenter) * vec2(uAspect, 1.0);
    m = 1.0 - smoothstep(uR - uSoft, uR, length(q));
  } else if (uMode > 1.5) {
    vec2 n = vec2(cos(uAngle), sin(uAngle));
    float s = dot((st - 0.5) * vec2(uAspect, 1.0), n);
    m = 1.0 - smoothstep(uEdge - uSoft, uEdge, s);
  }
  if (uMasked > 0.5) m *= texture2D(uMask, st).a;
  gl_FragColor = vec4(mix(a.rgb, b.rgb, m) * uFade, 1.0);
}
`;

/**
 * Where a straight wipe's edge is at `k` (0…1), in card heights from the center along the wipe's
 * direction: from just before the first corner to just past the last, so it never idles off screen.
 */
export function wipeEdge(k: number, angle: number, aspect: number, soft = 0) {
  const ext = 0.5 * aspect * Math.abs(Math.cos(angle)) + 0.5 * Math.abs(Math.sin(angle)) + soft;
  return -ext + 2 * ext * k;
}

/** A pour's radius at `k`, in card heights: reaching the farthest corner exactly at 1. */
export function pourRadius(k: number, center: { x: number; y: number }, aspect: number, soft = 0) {
  const cx = (center.x / 100) * aspect;
  const cy = center.y / 100;
  const far = Math.max(Math.hypot(cx, cy), Math.hypot(aspect - cx, cy), Math.hypot(cx, 1 - cy), Math.hypot(aspect - cx, 1 - cy));
  return k * (far + soft);
}

/**
 * The wipe edge as a line on the card, for an overlay: its center (card %) and CSS rotation.
 * `angle` 0 moves left to right; positive angles tilt the edge counter-clockwise.
 */
export function wipeLine(k: number, angle: number, aspect: number, soft = 0) {
  const e = wipeEdge(k, angle, aspect, soft) - soft / 2;
  return { x: 50 + ((e * Math.cos(angle)) / aspect) * 100, y: 50 - e * Math.sin(angle) * 100, rotate: (-angle * 180) / Math.PI };
}

export type Look = {
  /** Indexes into the photo's pictures. */
  from: number;
  to: number;
  /** 0…1 through the transition. */
  k: number;
  /** 0 crossfade · 1 pour from `center` · 2 wipe along `angle` (radians, 0 = left to right). */
  mode: 0 | 1 | 2;
  /** Pour center, in card % (top-left origin). */
  center?: { x: number; y: number };
  angle?: number;
  soft?: number;
  /** Apply the change only inside the mask (the selection). */
  masked?: boolean;
  /** Zoom about a point in card %. */
  zoom?: number;
  zx?: number;
  zy?: number;
  /** Parallax push in fractions of the frame (x, y); the depth `focus` stays still. */
  px?: number;
  py?: number;
  focus?: number;
  /** Brightness multiplier (fade to black). */
  fade?: number;
};

export class Photo {
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: ShaderMaterial;
  private pics: Entry[];
  private depth: Entry | null;
  private mask: Entry | null;
  /** What was drawn last, so a held frame isn't drawn again. */
  private last = "";
  readonly ready: Promise<unknown>;

  constructor(pictures: string[], opts: { depth?: string; mask?: string } = {}) {
    this.pics = pictures.map(texture);
    this.depth = opts.depth ? texture(opts.depth) : null;
    this.mask = opts.mask ? texture(opts.mask) : null;
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFrom: { value: null },
        uTo: { value: null },
        uDepth: { value: null },
        uMask: { value: null },
        uK: { value: 0 },
        uR: { value: 0 },
        uEdge: { value: 0 },
        uMode: { value: 0 },
        uSoft: { value: 0.12 },
        uMasked: { value: 0 },
        uZoom: { value: 1 },
        uFocus: { value: 0.5 },
        uAspect: { value: 0.8 },
        uAngle: { value: 0 },
        uCenter: { value: new Vector2(0.5, 0.5) },
        uZ: { value: new Vector2(0.5, 0.5) },
        uPar: { value: new Vector2(0, 0) },
        uFade: { value: 1 },
      },
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.mat));
    this.ready = Promise.all([...this.pics.map((p) => p.promise), this.depth?.promise, this.mask?.promise]);
  }

  /** Draw one frame of the look into the canvas. */
  draw(canvas: HTMLCanvasElement, look: Look) {
    fit(canvas);
    const from = this.pics[look.from];
    const to = this.pics[look.to];
    if (!from?.tex || !to?.tex) return;
    for (const e of [from, to, this.depth, this.mask]) if (e) touch(e);
    const key = [glEpoch(), canvas.width, canvas.height, look.from, look.to, look.k, look.mode, look.center?.x, look.center?.y, look.angle, look.soft, look.masked, look.zoom, look.zx, look.zy, look.px, look.py, look.focus, look.fade, !!this.depth?.tex, !!this.mask?.tex]
      .map((v) => (typeof v === "number" ? v.toFixed(4) : String(v)))
      .join("|");
    if (key === this.last) return;
    this.last = key;
    const u = this.mat.uniforms;
    u.uFrom.value = from.tex;
    u.uTo.value = to.tex;
    // Without a depth map the photo is flat; without a mask the change is everywhere.
    u.uDepth.value = this.depth?.tex ?? from.tex;
    u.uMask.value = this.mask?.tex ?? from.tex;
    const aspect = canvas.width / canvas.height;
    const soft = look.soft ?? 0.12;
    u.uK.value = look.k;
    u.uR.value = pourRadius(look.k, look.center ?? { x: 50, y: 50 }, aspect, soft);
    u.uEdge.value = wipeEdge(look.k, look.angle ?? 0, aspect, soft);
    u.uMode.value = look.mode;
    u.uSoft.value = soft;
    u.uMasked.value = look.masked && this.mask?.tex ? 1 : 0;
    u.uZoom.value = look.zoom ?? 1;
    // Card % (top-left origin) to texture space (bottom-left origin).
    u.uZ.value.set((look.zx ?? 50) / 100, 1 - (look.zy ?? 50) / 100);
    u.uCenter.value.set((look.center?.x ?? 50) / 100, 1 - (look.center?.y ?? 50) / 100);
    u.uPar.value.set(this.depth?.tex ? (look.px ?? 0) : 0, this.depth?.tex ? -(look.py ?? 0) : 0);
    u.uFocus.value = look.focus ?? 0.5;
    u.uAspect.value = aspect;
    u.uAngle.value = look.angle ?? 0;
    u.uFade.value = look.fade ?? 1;
    present(canvas, this.scene, this.camera);
  }

  dispose() {
    this.mat.dispose();
  }
}
