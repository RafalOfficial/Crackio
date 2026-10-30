"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDirector } from "@/lib/director/store";
import { useThree } from "@react-three/fiber";
import { BufferGeometry, Float32BufferAttribute, type Mesh, ShaderMaterial, type Texture, Vector3, Vector4 } from "three";
import type { WorldDepth } from "@/lib/director/types";
import { NO_DEPTH, PLACE_SET } from "./capture";
import { walkable } from "../walk";

/**
 * The place's world as a place you walk into: its 360 picture laid on the shapes its depth measured (server/world-depth)
 * around the spot it was made from, so walking up to the shelves brings them closer, the floor stays put under the
 * people, and a counter hides who stands behind it. The floor and a ceiling are exactly flat; the sky is far away.
 *
 * Where the depth jumps (a shelf's edge against the wall behind it) the surface is cut instead of stretched across the
 * gap (stretched, things melted as the camera moved, like the red car on the old ground); what the gap uncovers is a
 * soft, far layer behind (the picture blurred over the shapes around), as a photo has nothing there to show.
 */

const FLOOR = 1;
const CEILING = 2;
const SKY = 3;
const FAR = 300;
/** Neighbors farther apart than this (a ratio of distances) aren't one surface. */
const CUT = 1.25;

type DepthMap = { w: number; h: number; r: Float32Array; cls: Uint8Array };
const maps = new Map<string, Promise<DepthMap>>();

function loadMap(depth: WorldDepth) {
  let p = maps.get(depth.url);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.src = depth.url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const n = canvas.width * canvas.height;
      const r = new Float32Array(n);
      const cls = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        r[i] = (depth.rMin * 65535) / Math.max(1, data[i * 4] * 256 + data[i * 4 + 1]);
        cls[i] = data[i * 4 + 2];
      }
      return { w: canvas.width, h: canvas.height, r, cls };
    })();
    maps.set(depth.url, p);
    p.catch(() => maps.delete(depth.url));
  }
  return p;
}

/** The far layer: each direction's distance the farthest around it (what's behind a thing's edge is the wall). */
function behind(map: DepthMap, R = 6) {
  const { w, h, r } = map;
  const rows = new Float32Array(r.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -R; k <= R; k++) m = Math.max(m, r[y * w + ((x + k + w) % w)]);
      rows[y * w + x] = m;
    }
  }
  const out = new Float32Array(r.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R); k++) m = Math.max(m, rows[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}


/**
 * The place kept behind the people and things on set: a wall or awning measured a little short (a cafe front taken for
 * the chairs before it) stood through the cast. In each one's direction from the eye, nothing but the floor comes
 * nearer than just behind them.
 */
function clearedFor(map: DepthMap, distances: Float32Array, center: Vector3, span: number, marks: { x: number; z: number; bottom: number; top: number }[]) {
  if (!marks.length) return distances;
  const out = distances.slice();
  // Bent back smoothly around them, so no edge (a step showed as a pale rectangle round the cast): across, and a
  // little above their heads (further up, the awning they stood under bent away in pale cups).
  const FEATHER = 0.15;
  const ABOVE = 0.04;
  for (const m of marks) {
    const dx = m.x - center.x;
    const dz = m.z - center.z;
    const reach = Math.hypot(dx, dz);
    if (reach < 0.5) continue;
    const half = 0.6;
    const near = Math.max(0.3, reach - half);
    const lon0 = Math.atan2(dx, -dz);
    const dLon = Math.atan(half / near);
    const latTop = Math.atan2(m.top + 0.2 - center.y, near);
    const latBottom = Math.atan2(m.bottom - center.y, near);
    const need = reach + half;
    const x0 = Math.floor(((lon0 - dLon - FEATHER) / (2 * Math.PI) + 0.5) * map.w);
    const x1 = Math.ceil(((lon0 + dLon + FEATHER) / (2 * Math.PI) + 0.5) * map.w);
    const y0 = Math.max(0, Math.floor((0.5 - (latTop + ABOVE) / span) * map.h));
    const y1 = Math.min(map.h - 1, Math.ceil((0.5 - (latBottom - FEATHER) / span) * map.h));
    for (let y = y0; y <= y1; y++) {
      const lat = (0.5 - (y + 0.5) / map.h) * span;
      const c = Math.cos(lat);
      const offLat = Math.max(0, ((lat - latTop) * FEATHER) / ABOVE, latBottom - lat);
      for (let xx = x0; xx <= x1; xx++) {
        const k = y * map.w + (((xx % map.w) + map.w) % map.w);
        if (map.cls[k] === FLOOR || map.cls[k] === CEILING) continue;
        let lon = ((xx + 0.5) / map.w - 0.5) * 2 * Math.PI - lon0;
        lon = Math.atan2(Math.sin(lon), Math.cos(lon));
        const off = Math.hypot(Math.max(0, Math.abs(lon) - dLon), offLat);
        // Only what stands where they stand, at their height: an awning over their heads stays over them.
        const height = center.y + out[k] * Math.sin(lat);
        const t = (1 - Math.min(1, off / FEATHER)) * (1 - Math.min(1, Math.max(0, (height - m.top - 0.2) / 0.3)));
        const want = need / c;
        if (t > 0 && out[k] < want) out[k] += (want - out[k]) * t * t * (3 - 2 * t);
      }
    }
  }
  return out;
}

/**
 * How far the camera may walk from the eye in each direction (one per longitude): to the nearest wall, shelf or car at
 * body height, less a margin, and never between two things a gap apart. Walked through the cafe's front, the camera
 * ended up inside its walls with nothing to see.
 */
function reachOf(map: DepthMap, distances: Float32Array, center: Vector3, span: number) {
  const { w, h } = map;
  const near = new Float32Array(w).fill(40);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * span;
    const up = Math.sin(lat);
    const across = Math.cos(lat);
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const c = map.cls[k];
      if (c === FLOOR || c === CEILING || c === SKY) continue;
      const height = center.y + distances[k] * up;
      if (height < 0.25 || height > 2.4) continue;
      near[x] = Math.min(near[x], distances[k] * across);
    }
  }
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let j = -4; j <= 4; j++) m = Math.min(m, near[(x + j + w) % w]);
    // Kept back from them: up close the picture's limits show (an awning's top it never saw, a car's side).
    out[x] = Math.max(0.3, m - 0.8);
  }
  return out;
}

/**
 * How far the place's walls are in each direction (one per column, meters): the farthest thing at body height, past
 * the shelves and counters walking stops at, kept a little back, gaps like doorways closed. Where the camera may be
 * for every move but walking (lib/director/room): past them, it saw the place from outside.
 */
function wallsOf(map: DepthMap, distances: Float32Array, center: Vector3, span: number) {
  const { w, h } = map;
  const far = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * span;
    const up = Math.sin(lat);
    const across = Math.cos(lat);
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const c = map.cls[k];
      if (c === FLOOR || c === CEILING || c === SKY) continue;
      const height = center.y + distances[k] * up;
      if (height < 0.25 || height > 2.4) continue;
      far[x] = Math.max(far[x], distances[k] * across);
    }
  }
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let j = -6; j <= 6; j++) m = Math.min(m, far[(x + j + w) % w] || 40);
    out[x] = Math.max(0.6, m - 0.8);
  }
  return out;
}

/**
 * The world's surface around `center` (the eye it was made from, `center.y` over the floor): a grid of directions out
 * to their distance, `cols` around, closed at the top and bottom. `cut`: no surface across depth jumps.
 */
function shell(
  map: DepthMap,
  distances: Float32Array,
  ceiling: number | null,
  center: Vector3,
  span: number,
  cols: number,
  cut: boolean,
) {
  const rows = Math.max(8, Math.round((cols * map.h) / map.w));
  const count = (cols + 1) * (rows + 1);
  const position = new Float32Array((count + 2) * 3);
  const dist = new Float32Array(count);
  const kind = new Uint8Array(count);
  const eye = Math.max(0.05, center.y);
  for (let j = 0; j <= rows; j++) {
    const lat = (0.5 - j / rows) * span;
    const y = Math.min(map.h - 1, Math.max(0, Math.round((j / rows) * map.h - 0.5)));
    for (let i = 0; i <= cols; i++) {
      const lon = (i / cols - 0.5) * 2 * Math.PI;
      const dx = Math.sin(lon) * Math.cos(lat);
      const dy = Math.sin(lat);
      const dz = -Math.cos(lon) * Math.cos(lat);
      const x = ((Math.round((i / cols) * map.w - 0.5) % map.w) + map.w) % map.w;
      const k = y * map.w + x;
      const c = map.cls[k];
      let r = distances[k];
      // The floor and a ceiling exactly flat, from this eye.
      if (c === FLOOR && dy < -1e-3) r = Math.min(FAR, eye / -dy);
      else if (c === CEILING && ceiling && ceiling > eye && dy > 1e-3) r = (ceiling - eye) / dy;
      const n = j * (cols + 1) + i;
      dist[n] = r;
      kind[n] = c;
      position[n * 3] = center.x + dx * r;
      position[n * 3 + 1] = center.y + dy * r;
      position[n * 3 + 2] = center.z + dz * r;
    }
  }
  // Closed past the picture's top and bottom: the ceiling (or the sky) right above, the floor right below.
  let zenith = 0;
  for (let i = 0; i < cols; i++) zenith += dist[i];
  zenith /= cols;
  if (ceiling && ceiling > eye) zenith = ceiling - eye;
  const top = count;
  const bottom = count + 1;
  position.set([center.x, center.y + zenith, center.z], top * 3);
  position.set([center.x, 0, center.z], bottom * 3);

  const index: number[] = [];
  const one = (a: number, b: number, c: number, d: number) => {
    if (!cut) return true;
    const k = kind[a];
    if (k && kind[b] === k && kind[c] === k && kind[d] === k) return true;
    const lo = Math.min(dist[a], dist[b], dist[c], dist[d]);
    const hi = Math.max(dist[a], dist[b], dist[c], dist[d]);
    return hi < lo * CUT;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // Wound to face the eye inside: seen from outside (scouting), the near walls drop away like a cutaway.
      if (one(a, b, c, d)) index.push(a, c, b, b, c, d);
    }
  }
  for (let i = 0; i < cols; i++) {
    index.push(top, i, i + 1);
    const a = rows * (cols + 1) + i;
    index.push(bottom, a + 1, a);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

const vertex = /* glsl */ `
  uniform vec3 center;
  varying vec3 vDir;
  varying vec3 vWorld;
  varying vec3 vCenter;
  void main() {
    vDir = position - center;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vCenter = (modelMatrix * vec4(center, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const fragment = /* glsl */ `
  uniform sampler2D world;
  uniform float span;
  uniform float unknown;
  uniform float blur;
  uniform float front;
  uniform vec4 eyeLock;
  varying vec3 vDir;
  varying vec3 vWorld;
  varying vec3 vCenter;
  // The picture's color in a direction from where it was made. Longitude wraps behind the photo's forward: whichever
  // of the two is smooth there is sampled (Surround's line fix).
  vec3 seen(vec3 d, float bias) {
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float u1 = atan(d.x, -d.z) / 6.28318530718 + 0.5;
    float u2 = fract(u1 + 0.5) - 0.5;
    vec2 uv = vec2(fwidth(u1) <= fwidth(u2) ? u1 : u2, clamp(0.5 + lat / span, 0.001, 0.999));
    return texture2D(world, uv, bias).rgb;
  }
  void main() {
    if (unknown > 1.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // Each point takes the picture's color in its direction from where the picture was made: it stays on its shape.
    vec3 d = normalize(vDir);
    // Past the picture's top and bottom: left for the model to draw in its view, the edge rows in yours.
    if (unknown > 0.5 && abs(asin(clamp(d.y, -1.0, 1.0))) > span * 0.5) discard;
    vec3 color = seen(d, blur);
    // Seen from far off the angle the picture saw it from (a chair the camera now stands beside), a point's color is
    // a guess that smears: there the model's view leaves it for the model to draw.
    // Only low down, where the clutter is: walls and buildings hold up from any angle on their shapes (taken further
    // up, a cafe vanished from behind the cast once the camera went round them).
    vec3 viewer = eyeLock.w > 0.5 ? eyeLock.xyz : cameraPosition;
    float off = 1.0 - dot(normalize(vWorld - vCenter), normalize(vWorld - viewer));
    float guess = smoothstep(0.1, 0.3, off) * smoothstep(1.3, 0.8, vWorld.y);
    if (unknown > 0.5) {
      // The model's view keeps only what the picture really shows from here; the rest is gray for the model to draw
      // fresh. Walked 9 m off, the user's street came back with a warped curb and blurred chunks the model copied:
      // the soft layer behind the cuts, low clutter seen from far off its photographed angle (walls hold up: grayed at
      // any height, a cafe front seen 40 degrees round went), and anything shown over three times bigger than the
      // picture saw it from its spot, or twice and stretched one way (cobbles in streaks in front of the camera).
      if (front < 0.5) discard;
      if (guess > 0.5) discard;
      vec3 ray = normalize(vWorld - cameraPosition);
      float pixel = max(length(dFdx(ray)), length(dFdy(ray)));
      float near = min(length(dFdx(d)), length(dFdy(d)));
      float far = max(length(dFdx(d)), length(dFdy(d)));
      if (3.0 * near < pixel || (2.0 * near < pixel && far > 2.0 * near)) discard;
    } else if (front > 0.5 && guess > 0.0) {
      // Yours: softened by degrees (cut away past a threshold, things popped in and out as the camera walked).
      color = mix(color, seen(d, blur + 6.0), guess);
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

function material(blur: number, front: boolean) {
  return new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: {
      world: { value: null },
      center: { value: new Vector3() },
      span: { value: 2.69 },
      unknown: { value: 0 },
      blur: { value: blur },
      front: { value: front ? 1 : 0 },
      eyeLock: { value: new Vector4() },
    },
  });
}

/**
 * The world built around `center`; `children` (the world as a backdrop) until its depth has loaded. It stays the place
 * from any height: up high it went back to a flat backdrop, and the switch was the place suddenly turning into a 2D
 * picture (the user); seen from above, the tops of things it never saw stretch instead. `eye`: the shot camera while
 * scouting (the place looks the way the shot sees it).
 */
export function WalkIn({
  depth,
  world,
  center,
  span,
  eye,
  children,
}: {
  depth: WorldDepth;
  world: Texture;
  center: Vector3;
  span: number;
  eye: Vector3 | null;
  children: ReactNode;
}) {
  const [map, setMap] = useState<DepthMap | null>(null);
  useEffect(() => {
    let live = true;
    loadMap(depth)
      .then((m) => live && setMap(m))
      .catch((err) => console.warn("[director] world depth map:", err));
    return () => {
      live = false;
    };
  }, [depth]);
  const { x, y, z } = center;
  // Where everyone stands, in the place's own scale; settled a moment after a drag (the place is rebuilt around them).
  const placeScale = useDirector((s) => s.scene.place.scale ?? 1);
  const standing = useDirector((s) =>
    s.scene.elements.map((e) => `${(e.x / placeScale).toFixed(2)},${(e.z / placeScale).toFixed(2)},${(e.lift / placeScale).toFixed(2)},${((e.lift + e.height) / placeScale).toFixed(2)}`).join(";"),
  );
  const [marksKey, setMarksKey] = useState(standing);
  useEffect(() => {
    const t = setTimeout(() => setMarksKey(standing), 250);
    return () => clearTimeout(t);
  }, [standing]);
  const geometries = useMemo(() => {
    if (!map) return null;
    const at = new Vector3(x, y, z);
    const marks = marksKey
      .split(";")
      .filter(Boolean)
      .map((m) => {
        const [mx, mz, bottom, top] = m.split(",").map(Number);
        return { x: mx, z: mz, bottom, top };
      });
    const near = clearedFor(map, map.r, at, span, marks);
    return {
      front: shell(map, near, depth.ceiling, at, span, 512, true),
      back: shell(map, clearedFor(map, behind(map), at, span, marks), depth.ceiling, at, span, 192, false),
      reach: reachOf(map, near, at, span),
      walls: wallsOf(map, map.r, at, span),
    };
  }, [map, depth.ceiling, x, y, z, span, marksKey]);
  // Where walking may take the camera, in the stage's own units (the place is scaled by its group).
  useEffect(() => {
    if (!geometries) return;
    // Openings, and walls the measuring missed, end well past most of the room's walls, and nothing goes past 12 m:
    // the user's store had a 47 m corridor behind the camera, and zooming out down it showed the place from outside.
    const most = Float32Array.from(geometries.walls).sort()[Math.floor(geometries.walls.length * 0.75)];
    const far = Math.min(12, Math.max(3, most * 1.25));
    const room = {
      center: new Vector3(x, y, z).multiplyScalar(placeScale),
      reach: geometries.reach.map((r) => Math.min(r, far) * placeScale),
      walls: geometries.walls.map((r) => Math.min(r, far) * placeScale),
      seen: { w: map!.w, h: map!.h, r: map!.r, span, far, scale: placeScale },
      // Walking: a little over the eye the world was made from, under any ceiling (higher, it shows the tops of things
      // it never saw: an awning from above came out torn). Every other move: under the ceiling only.
      top: Math.min((y + 0.6) * placeScale, depth.ceiling && depth.ceiling > y ? depth.ceiling * placeScale - 0.3 : Infinity),
      ceiling: depth.ceiling && depth.ceiling > y ? depth.ceiling * placeScale : null,
      key: depth.url,
    };
    walkable.current = room;
    // The camera into it now, wherever it was left (every move after keeps it there: the store's commit).
    useDirector.getState().setCamera({}, true);
    return () => {
      if (walkable.current === room) walkable.current = null;
    };
  }, [geometries, map, span, x, y, z, placeScale, depth.ceiling, depth.url]);
  useEffect(() => () => [geometries?.front, geometries?.back].forEach((g) => g?.dispose()), [geometries]);
  const materials = useMemo(() => {
    const front = material(0, true);
    // Behind everything, blurred: only seen through the cuts.
    const back = material(4.5, false);
    back.polygonOffset = true;
    back.polygonOffsetFactor = 4;
    back.polygonOffsetUnits = 16;
    return { front, back };
  }, []);
  useEffect(() => () => [materials.front, materials.back].forEach((m) => m.dispose()), [materials]);
  const invalidate = useThree((s) => s.invalidate);
  const [ex, ey, ez, locked] = [eye?.x ?? 0, eye?.y ?? 0, eye?.z ?? 0, eye ? 1 : 0];
  // Uniforms change in place through the mesh (three.js materials are mutable, React state isn't).
  const front = useRef<Mesh>(null);
  const back = useRef<Mesh>(null);
  useLayoutEffect(() => {
    for (const mesh of [front.current, back.current]) {
      const u = (mesh?.material as ShaderMaterial | undefined)?.uniforms;
      if (!u) continue;
      u.world.value = world;
      (u.center.value as Vector3).set(x, y, z);
      u.span.value = span;
      (u.eyeLock.value as Vector4).set(ex, ey, ez, locked);
    }
    invalidate();
  }, [materials, world, x, y, z, span, ex, ey, ez, locked, geometries, invalidate]);

  if (!geometries) return <>{children}</>;
  return (
    <>
      <mesh ref={front} geometry={geometries.front} material={materials.front} userData={{ [PLACE_SET]: true, [NO_DEPTH]: true }} />
      <mesh ref={back} geometry={geometries.back} material={materials.back} userData={{ [PLACE_SET]: true, [NO_DEPTH]: true }} />
    </>
  );
}
