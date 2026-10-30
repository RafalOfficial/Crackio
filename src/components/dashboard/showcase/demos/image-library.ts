import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  type Texture,
  TextureLoader,
  Vector2,
} from "three";
import { fit, glEpoch, present, texture } from "../gl";

/**
 * Image's finale: every world she walked through, floating in the dark like a library you could
 * reach into. The film's own frame is one of them (the hero, at the origin); the camera starts
 * flush against it, so the montage plays on the hero, and then it pulls back and drifts round.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** A picture card: rounded corners, a soft "develop" (bright and blurred to sharp), a glow at its edge. */
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec2 uSize;
uniform float uRadius;
uniform float uOpacity;
uniform float uDevelop;
uniform float uDim;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 q = abs(p) - (uSize * 0.5 - uRadius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float a = 1.0 - smoothstep(-0.004, 0.004, d);
  vec3 c = texture2D(uMap, vUv).rgb;
  if (uDevelop < 0.999) {
    float r = (1.0 - uDevelop) * 0.018;
    vec3 b = c;
    b += texture2D(uMap, vUv + vec2(r, 0.0)).rgb;
    b += texture2D(uMap, vUv - vec2(r, 0.0)).rgb;
    b += texture2D(uMap, vUv + vec2(0.0, r)).rgb;
    b += texture2D(uMap, vUv - vec2(0.0, r)).rgb;
    b /= 5.0;
    c = mix(b, c, uDevelop) * mix(1.8, 1.0, uDevelop);
  }
  gl_FragColor = vec4(c * uDim, a * uOpacity);
}
`;

const ASPECT = 0.8;
/** The camera's vertical field of view, and how far back it sits for the hero to fill the card exactly. */
const FOV = 40;
export const FLUSH = 0.5 / Math.tan(((FOV / 2) * Math.PI) / 180);

/** A small seeded random, so the library is laid out the same way every time. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

type Card = { mesh: Mesh; mat: ShaderMaterial; home: [number, number, number]; phase: number; spin: number; shown?: boolean };

export type LibraryState = {
  /** Which world the hero shows, how developed it is, and its corner radius (0 while it fills the card). */
  hero: number;
  develop: number;
  radius: number;
  /** How far the camera has pulled back (0 flush on the hero … 1 the whole library) and gone round (radians). */
  back: number;
  orbit: number;
  /** A push into the hero during the montage (1 = none). */
  push: number;
  /** The other cards' presence (0 … 1), and the clock for their drift. */
  others: number;
  t: number;
};

export class Library {
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, ASPECT, 0.05, 80);
  private cards: Card[] = [];
  private full: ReturnType<typeof texture>[];
  private thumbs: Texture[] = [];
  private loader = new TextureLoader();
  private stars: Points;
  private last = "";
  readonly ready: Promise<unknown>;

  /** `full` are the montage pictures (the hero shows them), `small` the same worlds for the far cards. */
  constructor(full: string[], small: string[]) {
    this.scene.background = new Color("#07060b");
    this.full = full.map((u) => texture(u));
    const geo = new PlaneGeometry(ASPECT, 1);
    const rand = rng(11);
    // The hero, then the rest on a loose grid with depth, kept out of the camera's way.
    const slots: [number, number, number][] = [[0, 0, 0]];
    for (let row = -3; row <= 3; row++)
      for (let col = -4; col <= 4; col++) {
        if (!row && !col) continue;
        const central = Math.abs(col) <= 1 && Math.abs(row) <= 1;
        slots.push([col * 1.18 + (rand() - 0.5) * 0.5, row * 1.38 + (rand() - 0.5) * 0.45, central ? -1.6 - rand() * 2.2 : 0.9 - rand() * 4.4]);
      }
    // Nearest the hero first, so the first ring of worlds is there as soon as the camera leaves.
    const ordered = [slots[0], ...slots.slice(1).sort((a, b) => Math.hypot(a[0], a[1] * 0.8) - Math.hypot(b[0], b[1] * 0.8) + (rand() - 0.5) * 0.6)];
    for (let i = 0; i < full.length; i++) {
      const mat = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMap: { value: null },
          uSize: { value: new Vector2(ASPECT, 1) },
          uRadius: { value: i === 0 ? 0 : 0.035 },
          uOpacity: { value: 1 },
          uDevelop: { value: 1 },
          uDim: { value: 1 },
        },
      });
      const mesh = new Mesh(geo, mat);
      const home = ordered[i];
      mesh.position.set(...home);
      this.scene.add(mesh);
      this.cards.push({ mesh, mat, home, phase: rand() * Math.PI * 2, spin: (rand() - 0.5) * 0.5 });
      if (i === 0) continue;
      const card = this.cards[this.cards.length - 1];
      // Until its picture is in, a card would draw as a black square: it stays hidden, and shows the frame it lands.
      const tex = this.loader.load(small[i], () => {
        card.shown = true;
        this.last = "";
      });
      // Raw sRGB in, raw out, like every picture in the showcase (see gl.texture).
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = true;
      this.thumbs.push(tex);
      mat.uniforms.uMap.value = tex;
    }
    // A sky of faint stars far behind.
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rand() - 0.5) * 60;
      pos[i * 3 + 1] = (rand() - 0.5) * 40;
      pos[i * 3 + 2] = -12 - rand() * 30;
    }
    const sg = new BufferGeometry();
    sg.setAttribute("position", new BufferAttribute(pos, 3));
    this.stars = new Points(sg, new PointsMaterial({ color: "#c9c3ff", size: 0.07, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }));
    this.scene.add(this.stars);
    this.ready = Promise.all(this.full.map((e) => e.promise));
  }

  draw(canvas: HTMLCanvasElement, st: LibraryState) {
    fit(canvas);
    // The hero falls back to the last world that has loaded.
    let hero = st.hero;
    while (hero > 0 && !this.full[hero]?.tex) hero--;
    const tex = this.full[hero]?.tex;
    if (!tex) return;
    const key = [glEpoch(), canvas.width, canvas.height, hero, st.develop.toFixed(3), st.radius.toFixed(3), st.back.toFixed(4), st.orbit.toFixed(4), st.push.toFixed(4), st.others.toFixed(3), st.back > 0 ? st.t.toFixed(3) : 0].join("|");
    if (key === this.last) return;
    this.last = key;

    const cam = this.camera;
    cam.aspect = canvas.width / canvas.height;
    // Flush on the hero, then back and round the middle of the library (it sits a little behind the hero).
    const b = st.back;
    const center = -1.2 * b;
    const dist = FLUSH / st.push + b * b * 6.8 + b * 1.4;
    const lift = b * 0.9;
    cam.position.set(Math.sin(st.orbit) * (dist - center) * 0.98, lift, center + Math.cos(st.orbit) * (dist - center));
    cam.lookAt(0, lift * 0.25, center);
    cam.updateProjectionMatrix();

    this.cards.forEach((c, i) => {
      const u = c.mat.uniforms;
      if (i === 0) {
        u.uMap.value = tex;
        u.uDevelop.value = st.develop;
        u.uRadius.value = st.radius;
        // It comes up out of the dark as it develops.
        u.uOpacity.value = 0.32 + 0.68 * Math.min(1, st.develop * 2.5);
        return;
      }
      c.mesh.visible = st.others > 0.005 && c.shown === true;
      if (!c.mesh.visible) return;
      // Each card bobs and turns a little on its own.
      const ph = c.phase + st.t * 0.55;
      c.mesh.position.set(c.home[0], c.home[1] + Math.sin(ph) * 0.06, c.home[2]);
      c.mesh.rotation.set(Math.sin(ph * 0.7) * 0.06, c.spin * 0.4 + Math.sin(ph * 0.5) * 0.08, 0);
      // Farther cards are dimmer, like depth haze.
      const far = Math.min(1, Math.max(0, (cam.position.distanceTo(c.mesh.position) - 4) / 14));
      u.uOpacity.value = st.others;
      u.uDim.value = 1 - far * 0.45;
    });
    (this.stars.material as PointsMaterial).opacity = 0.55 * st.others;
    present(canvas, this.scene, cam);
  }

  dispose() {
    for (const c of this.cards) c.mat.dispose();
    this.thumbs.forEach((t) => t.dispose());
    this.cards[0]?.mesh.geometry.dispose();
    this.stars.geometry.dispose();
    (this.stars.material as PointsMaterial).dispose();
  }
}
