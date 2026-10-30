"use client";

import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, Line, OrbitControls, useTexture } from "@react-three/drei";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type Group,
  type Mesh,
  MathUtils,
  MeshBasicMaterial,
  MeshDepthMaterial,
  type PerspectiveCamera,
  Plane,
  Raycaster,
  RGBADepthPacking,
  BackSide,
  Matrix3,
  Matrix4,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { mainElement, useDirector } from "@/lib/director/store";
import { angleDelta, cameraHeight, cameraPosition, focusPoint, orbitFrom, pedestalTo, shotCamera, verticalFov } from "@/lib/director/camera";
import { walking } from "../walk";
import { ELEMENT_DEFAULTS, kelvinToRgb } from "@/lib/director/vocab";
import { fitPlaceView, photoCamera, photoFov, placeSurface, type DepthMap } from "@/lib/director/reconstruct";
import { reliefSurface } from "@/lib/director/relief";
import { blockingLook, shotLook } from "@/lib/director/look";
import { standInColor } from "@/lib/director/standin";
import { useDepth } from "@/lib/director/vision";
import type { CameraRig, LightRig, PlacePhoto, PlaceView, PlaceWorld, Scene, SceneElement } from "@/lib/director/types";
import { loadedViews, makeCapture, makePlateCapture, NO_DEPTH, PLACE_SET, registerCapture, registerPlateCapture, showView, SUBJECT, UNKNOWN_GRAY, VIEW_MODEL, VIEW_NORMAL } from "./capture";
import { PhotoBody, StandIn } from "./StandIn";
import { WalkIn } from "./WalkIn";
import { zoomed } from "@/lib/director/room";
import { useStageView } from "./view";
import { HELPER_LAYER, ShotRenderer, STAGE_BACKGROUND } from "./post";

const SPIKE = "#ff5b2e";
const floorPlane = new Plane(new Vector3(0, 1, 0), 0);
const rad = MathUtils.degToRad;

type Pose = { target: Vector3; azimuth: number; elevation: number; distance: number; focal: number; roll: number };

export default function Stage3D() {
  // The camera the viewer sees glides toward the scene's camera; captures use the exact one.
  const pose = useRef<Pose | null>(null);
  const scout = useStageView((s) => s.scout);
  return (
    <Canvas
      flat
      shadows="percentage"
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov: 40, near: 0.05, far: 1000, position: [0, 1.4, 5] }}
      onPointerMissed={() => useDirector.getState().select(null)}
      className="touch-none"
    >
      <ShotCamera pose={pose} />
      {scout ? <ScoutCamera /> : null}
      <Pipeline pose={pose} />
      <World />
      <ScriptHandle />
    </Canvas>
  );
}

/** In development, test scripts reach the 3D scene (to look at one part of the set at a time). */
function ScriptHandle() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __crackioThree?: unknown }).__crackioThree = get;
  }, [get]);
  return null;
}

function goalPose(scene: Scene): Pose {
  const { azimuth, elevation, distance, focal, roll } = scene.camera;
  return { target: focusPoint(scene), azimuth, elevation, distance, focal, roll };
}

/** Moves the canvas camera smoothly to the scene's shot camera: presets glide, drags feel weighted. */
function ShotCamera({ pose }: { pose: React.RefObject<Pose | null> }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const scene = useDirector((s) => s.scene);
  const goal = useMemo(() => goalPose(scene), [scene]);

  useEffect(() => invalidate(), [goal, size, invalidate]);

  useFrame((_, delta) => {
    const cur = (pose.current ??= { ...goal, target: goal.target.clone() });
    // Walking moves smoothly on its own: followed exactly (eased again, a turn swung the view about).
    const k = walking.active ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 15);
    cur.target.lerp(goal.target, k);
    cur.azimuth += angleDelta(cur.azimuth, goal.azimuth) * k;
    cur.elevation += (goal.elevation - cur.elevation) * k;
    cur.distance = Math.exp(MathUtils.lerp(Math.log(cur.distance), Math.log(goal.distance), k));
    cur.focal = Math.exp(MathUtils.lerp(Math.log(cur.focal), Math.log(goal.focal), k));
    cur.roll += (goal.roll - cur.roll) * k;
    const settled =
      cur.target.distanceTo(goal.target) < 0.001 &&
      Math.abs(angleDelta(cur.azimuth, goal.azimuth)) < 0.02 &&
      Math.abs(cur.elevation - goal.elevation) < 0.02 &&
      Math.abs(cur.distance / goal.distance - 1) < 0.0005 &&
      Math.abs(cur.focal / goal.focal - 1) < 0.0005 &&
      Math.abs(cur.roll - goal.roll) < 0.02;
    if (settled) Object.assign(cur, { ...goal, target: cur.target.copy(goal.target) });
    else invalidate();
    // Scouting, the canvas looks from wherever you put it (ScoutCamera); the shot camera stands in the set.
    if (useStageView.getState().scout) return;

    // three.js cameras are mutable objects owned by the canvas; read it fresh and update in place.
    const camera = get().camera as PerspectiveCamera;
    const aspect = size.width / Math.max(1, size.height);
    camera.fov = verticalFov(cur.focal, aspect);
    camera.aspect = aspect;
    camera.near = 0.05;
    camera.far = 1000;
    camera.position.copy(cameraPosition(cur as unknown as CameraRig, cur.target));
    camera.up.set(0, 1, 0);
    camera.lookAt(cur.target);
    camera.rotateZ(rad(-cur.roll));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, -1);
  return null;
}

/** Draws every frame: the set through the lens (blur + grade), then on-set helpers on top. */
function Pipeline({ pose }: { pose: React.RefObject<Pose | null> }) {
  const gl = useThree((s) => s.gl);
  const threeScene = useThree((s) => s.scene);
  const scene = useDirector((s) => s.scene);
  const renderer = useMemo(() => new ShotRenderer(), []);
  useEffect(() => () => renderer.dispose(), [renderer]);
  const model = useStageView((s) => s.model);
  const scout = useStageView((s) => s.scout);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [model, scout, invalidate]);
  // Scouting is plain and sharp: the lens's blur and grade belong to the shot.
  const look = useMemo(() => {
    const l = shotLook(scene, scene.camera.distance);
    return model || scout ? blockingLook(l) : l;
  }, [scene, model, scout]);

  // The renderer, scene and camera are mutable objects owned by the canvas: use the frame's own handles.
  useFrame((state) => {
    const { gl: r, scene: world, size } = state;
    const camera = state.camera as PerspectiveCamera;
    const dpr = r.getPixelRatio();
    renderer.setSize(Math.max(1, Math.round(size.width * dpr)), Math.max(1, Math.round(size.height * dpr)));
    // The model's view: the blocking frame the image model gets, live.
    const restore = model ? showView(world, "model") : null;
    renderer.render(r, world, camera, { ...look, focus: pose.current?.distance ?? look.focus }, null);
    // Before the helpers: a color background makes three.js clear the canvas on every render, even without autoClear.
    restore?.();
    const autoClear = r.autoClear;
    const shadows = r.shadowMap.autoUpdate;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    camera.layers.set(HELPER_LAYER);
    r.render(world, camera);
    camera.layers.set(0);
    r.autoClear = autoClear;
    r.shadowMap.autoUpdate = shadows;
  }, 1);

  useEffect(() => {
    const exact = (aspect: number) => {
      const cam = shotCamera(useDirector.getState().scene);
      cam.aspect = aspect;
      cam.far = 1000;
      cam.updateProjectionMatrix();
      return cam;
    };
    const lookNow = () => {
      const s = useDirector.getState().scene;
      return shotLook(s, s.camera.distance);
    };
    registerCapture(makeCapture(gl, threeScene, exact, lookNow));
    registerPlateCapture(makePlateCapture(gl, threeScene, lookNow));
    return () => {
      registerCapture(null);
      registerPlateCapture(null);
    };
  }, [gl, threeScene]);
  return null;
}

/** Puts everything inside it on the helper layer: seen while you work, never in the shot. */
function Helper({ children }: { children: ReactNode }) {
  const ref = useRef<Group>(null);
  useLayoutEffect(() => {
    ref.current?.traverse((o) => o.layers.set(HELPER_LAYER));
  });
  return <group ref={ref}>{children}</group>;
}

type LightUniforms = { dir: Vector3; color: Color; softness: number };

function lightFor(light: LightRig, target: Vector3): LightUniforms & { position: Vector3 } {
  const az = rad(light.azimuth);
  const el = rad(Math.max(-20, light.elevation));
  const dir = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const [r, g, b] = kelvinToRgb(light.kelvin).map((c) => c / 255);
  const color = new Color(1, 1, 1).lerp(new Color(r, g, b), 0.55);
  return { dir, color, softness: light.softness, position: target.clone().addScaledVector(dir, 14) };
}

function World() {
  const scene = useDirector((s) => s.scene);
  const selectedId = useDirector((s) => s.selectedId);
  const scout = useStageView((s) => s.scout);
  const target = focusPoint(scene);
  const light = lightFor(scene.light, target);
  const image = scene.place.image;
  const shadowOpacity = 0.55 - scene.light.softness * 0.35;

  return (
    <>
      <directionalLight
        position={light.position}
        intensity={1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={0.5}
        shadow-camera-far={50}
        shadow-radius={2 + scene.light.softness * 10}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      >
        <object3D attach="target" position={[target.x, 0, target.z]} />
      </directionalLight>

      {scout ? <CameraOnSet /> : <OrbitCatcher />}

      {image ? (
        <Safe key={image.url} fallback={<EmptyStage shadowOpacity={shadowOpacity} />}>
          <Suspense fallback={null}>
            <Location image={image} scale={scene.place.scale ?? 1} light={light} shadowOpacity={shadowOpacity} />
          </Suspense>
        </Safe>
      ) : (
        <EmptyStage shadowOpacity={shadowOpacity} />
      )}

      {scene.elements.map((el, i) => (
        <Subject key={el.id} el={el} color={standInColor(i).hex} selected={el.id === selectedId} light={light} />
      ))}
    </>
  );
}

/**
 * Scouting the set: a camera of its own, like a 3D editor's viewport. Drag empty space to look around, right-drag to
 * slide, scroll to come closer, without touching the shot. Framing by dragging the shot camera itself was the hard part
 * (the user: "moving the camera around is already hard enough"). It starts behind and above the shot camera, looking at
 * what it frames, and the shot camera's helpers become clickable.
 */
function ScoutCamera() {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const [start] = useState(() => {
    const scene = useDirector.getState().scene;
    const target = focusPoint(scene);
    const shot = cameraPosition(scene.camera, target);
    const back = shot.clone().sub(target).setY(0);
    if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
    back.normalize();
    const eye = shot
      .clone()
      .addScaledVector(back, 2.5 + scene.camera.distance * 0.35)
      .add(new Vector3(0, 2.2 + scene.camera.distance * 0.25, 0));
    return { eye, target: new Vector3(target.x, Math.min(target.y, 1.2), target.z) };
  });
  useLayoutEffect(() => {
    // three.js cameras are mutable objects owned by the canvas; read it fresh and update in place.
    const { camera, raycaster } = get();
    const cam = camera as PerspectiveCamera;
    cam.position.copy(start.eye);
    cam.up.set(0, 1, 0);
    cam.fov = 50;
    cam.near = 0.05;
    cam.far = 2000;
    cam.aspect = size.width / Math.max(1, size.height);
    cam.lookAt(start.target);
    cam.updateProjectionMatrix();
    raycaster.layers.enable(HELPER_LAYER);
    invalidate();
    return () => {
      raycaster.layers.disable(HELPER_LAYER);
      invalidate();
    };
  }, [get, size, start, invalidate]);
  return <OrbitControls makeDefault target={start.target} enableDamping={false} maxPolarAngle={Math.PI * 0.495} onChange={() => invalidate()} />;
}

/**
 * The shot camera standing on the set while scouting: its body, the cone of what it sees and its line of sight to what
 * it frames. Grab it to move it around on the ground (it keeps looking at what it frames), Shift- or right-drag to raise
 * or lower it. A helper: never in the shot.
 */
function CameraOnSet() {
  const scene = useDirector((s) => s.scene);
  const get = useThree((s) => s.get);
  const hold = (still: boolean) => {
    const controls = get().controls as unknown as { enabled: boolean } | null;
    if (controls) controls.enabled = !still;
  };
  const cam = useMemo(() => shotCamera(scene), [scene]);
  const target = useMemo(() => focusPoint(scene), [scene]);
  const drag = useRef<{ plane: Plane; offset: Vector3; raise: boolean; y: number; height: number; moved: boolean } | null>(null);
  const hit = useMemo(() => new Vector3(), []);
  const [hover, setHover] = useState(false);
  const [held, setHeld] = useState(false);
  // The cone of view out to 1.4 m, with a notch on its top edge: what the shot sees, and which way is up.
  const cone = useMemo(() => {
    const L = 1.4;
    const h = Math.tan(rad(cam.fov / 2)) * L;
    const w = h * cam.aspect;
    const c = [new Vector3(-w, -h, -L), new Vector3(w, -h, -L), new Vector3(w, h, -L), new Vector3(-w, h, -L)];
    const o = new Vector3();
    const up = [new Vector3(-w * 0.35, h * 1.08, -L), new Vector3(0, h * 1.35, -L), new Vector3(w * 0.35, h * 1.08, -L)];
    return [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0], up[0], up[1], up[1], up[2]];
  }, [cam.fov, cam.aspect]);
  const color = hover || held ? "#ffb35c" : SPIKE;

  return (
    <Helper>
      <group position={cam.position} quaternion={cam.quaternion}>
        <mesh
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 2) return;
            e.stopPropagation();
            hold(true);
            const plane = new Plane(new Vector3(0, 1, 0), -cam.position.y);
            if (!e.ray.intersectPlane(plane, hit)) return;
            drag.current = { plane, offset: hit.clone().sub(cam.position).setY(0), raise: e.button === 2 || e.shiftKey, y: e.clientY, height: cameraHeight(scene.camera), moved: false };
            setHeld(true);
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            e.stopPropagation();
            const { checkpoint, setCamera } = useDirector.getState();
            if (!d.moved) checkpoint();
            d.moved = true;
            const rig = useDirector.getState().scene.camera;
            if (d.raise) {
              document.body.style.cursor = "ns-resize";
              setCamera(pedestalTo(rig, d.height - (e.clientY - d.y) * 0.01), true);
              return;
            }
            if (!e.ray.intersectPlane(d.plane, hit)) return;
            document.body.style.cursor = "grabbing";
            const at = hit.clone().sub(d.offset).setY(cam.position.y);
            // Never onto what it frames: a step away at least.
            const flat = new Vector3(at.x - target.x, 0, at.z - target.z);
            if (flat.length() < 0.35) at.set(target.x + flat.x, at.y, target.z + flat.z).add(flat.clone().setLength(0.35 - flat.length()));
            const { azimuth, elevation, distance } = orbitFrom(at, target);
            setCamera({ azimuth, elevation, distance: Math.round(distance * 100) / 100 }, true);
          }}
          onPointerUp={(e) => {
            (e.target as Element).releasePointerCapture?.(e.pointerId);
            drag.current = null;
            setHeld(false);
            hold(false);
            document.body.style.cursor = "";
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
            document.body.style.cursor = "grab";
          }}
          onPointerOut={() => {
            setHover(false);
            if (!drag.current) document.body.style.cursor = "";
          }}
          onContextMenu={(e) => e.nativeEvent.preventDefault()}
        >
          <boxGeometry args={[0.26, 0.2, 0.34]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, -0.24]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.075, 0.095, 0.14, 20]} />
          <meshBasicMaterial color="#2a1a12" toneMapped={false} />
        </mesh>
        <Line points={cone} segments color={color} lineWidth={1.5} transparent opacity={0.9} />
      </group>
      <Line points={[cam.position, target]} color={color} lineWidth={1} dashed dashSize={0.12} gapSize={0.08} transparent opacity={0.55} />
      <mesh position={[cam.position.x, 0.012, cam.position.z]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.16, 0.2, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} depthTest={false} toneMapped={false} />
      </mesh>
    </Helper>
  );
}

/**
 * Invisible shell around the set: drag it to orbit the camera, Shift-drag or right-drag to raise or lower it without
 * turning it (a pedestal move), scroll to move in and out.
 */
function OrbitCatcher() {
  const setCamera = useDirector((s) => s.setCamera);
  const checkpoint = useDirector((s) => s.checkpoint);
  const drag = useRef<{ x: number; y: number; az: number; el: number; distance: number; height: number; raise: boolean; moved: boolean } | null>(null);
  const wheelIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <mesh
      userData={{ [NO_DEPTH]: true }}
      onContextMenu={(e) => e.nativeEvent.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        const cam = useDirector.getState().scene.camera;
        drag.current = { x: e.clientX, y: e.clientY, az: cam.azimuth, el: cam.elevation, distance: cam.distance, height: cameraHeight(cam), raise: e.button === 2 || e.shiftKey, moved: false };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        if (!d.moved) checkpoint();
        d.moved = true;
        if (d.raise) {
          // Up the screen raises the camera, faster the farther it stands back.
          const cam = useDirector.getState().scene.camera;
          document.body.style.cursor = "ns-resize";
          setCamera(pedestalTo(cam, d.height - dy * 0.004 * Math.max(0.75, cam.distance * 0.6)), true);
          return;
        }
        document.body.style.cursor = "grabbing";
        // At the distance it started at, where the room allows: swung toward a wall it comes in, and back out after.
        setCamera({ azimuth: d.az - dx * 0.3, elevation: MathUtils.clamp(d.el + dy * 0.25, -80, 89), distance: d.distance }, true);
      }}
      onPointerUp={(e) => {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
        drag.current = null;
        document.body.style.cursor = "";
      }}
      onWheel={(e) => {
        e.nativeEvent.preventDefault();
        // One undo step per scroll gesture.
        if (!wheelIdle.current) checkpoint();
        else clearTimeout(wheelIdle.current);
        wheelIdle.current = setTimeout(() => (wheelIdle.current = null), 400);
        // In and out within the place; at its walls (or right up close) the lens zooms on instead (room.ts).
        setCamera(zoomed(useDirector.getState().scene, e.deltaY), true);
      }}
    >
      <sphereGeometry args={[600, 16, 12]} />
      <meshBasicMaterial side={DoubleSide} colorWrite={false} depthWrite={false} />
    </mesh>
  );
}

const gridVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const gridFragment = /* glsl */ `
  uniform vec3 floorColor;
  uniform vec3 lineColor;
  uniform vec3 fogColor;
  varying vec3 vWorld;
  float lines(vec2 c) {
    vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  void main() {
    // A line every meter, one every 5: the ground plane in perspective, which shows the camera's height and tilt.
    vec3 col = mix(floorColor, lineColor, max(lines(vWorld.xz) * 0.75, lines(vWorld.xz / 5.0)));
    col = mix(col, fogColor, smoothstep(10.0, 42.0, distance(vWorld.xz, cameraPosition.xz)));
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** The model's view of an empty stage: a gray floor grid out to a plain horizon. */
function FloorGrid() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: gridVertex,
        fragmentShader: gridFragment,
        uniforms: {
          floorColor: { value: new Color("#6c6e74") },
          lineColor: { value: new Color("#a9acb2") },
          fogColor: { value: UNKNOWN_GRAY.clone() },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh rotation-x={-Math.PI / 2} material={material} visible={false} userData={{ [VIEW_MODEL]: true }}>
      <planeGeometry args={[400, 400]} />
    </mesh>
  );
}

function EmptyStage({ shadowOpacity }: { shadowOpacity: number }) {
  return (
    <>
      <fog attach="fog" args={[STAGE_BACKGROUND.getStyle(), 14, 46]} />
      <mesh rotation-x={-Math.PI / 2} userData={{ [VIEW_NORMAL]: true }}>
        <planeGeometry args={[90, 90]} />
        <meshBasicMaterial color="#1f2126" />
      </mesh>
      <FloorGrid />
      <mesh rotation-x={-Math.PI / 2} position-y={0.002} receiveShadow userData={{ [NO_DEPTH]: true }}>
        <planeGeometry args={[90, 90]} />
        <shadowMaterial transparent opacity={shadowOpacity} depthWrite={false} />
      </mesh>
      <Helper>
        <Grid
          position={[0, 0.004, 0]}
          args={[60, 60]}
          cellSize={0.5}
          cellThickness={0.6}
          cellColor="#3a3d44"
          sectionSize={2}
          sectionThickness={1}
          sectionColor="#4c5059"
          fadeDistance={26}
          fadeStrength={1.4}
          infiniteGrid
        />
      </Helper>
    </>
  );
}

// ---------------------------------------------------------------- Location

const placeVertex = /* glsl */ `
  attribute vec3 flatPos;
  attribute float outside;
  attribute float stretch;
  uniform float reveal;
  varying vec2 vUv;
  varying float vOutside;
  varying float vStretch;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vOutside = outside;
    vStretch = stretch;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(flatPos, position, reveal), 1.0);
  }
`;
const placeFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 lightDir;
  uniform vec3 lightColor;
  uniform float relight;
  uniform vec3 background;
  uniform float unknown;
  uniform vec3 unknownColor;
  uniform vec2 texSize;
  varying vec2 vUv;
  varying float vOutside;
  varying float vStretch;
  varying vec3 vNormal;
  void main() {
    // The model's view: what the photo never showed is left out, so the flat gray behind it shows, to be filled, and a
    // smear never hides a subject standing behind it. That's the stretched curtains between near and far, past its
    // edges, and wherever one photo pixel is smeared across many screen pixels in one direction (a wall seen edge-on from
    // the new camera): the singular values of the photo-pixels-per-screen-pixel Jacobian. unknown = 2 is the ID pass:
    // what the photo did show is black there.
    if (unknown > 0.5) {
      vec2 dx = dFdx(vUv) * texSize;
      vec2 dy = dFdy(vUv) * texSize;
      float a = dot(dx, dx) + dot(dy, dy);
      float det = dx.x * dy.y - dx.y * dy.x;
      float disc = sqrt(max(a * a - 4.0 * det * det, 0.0));
      float smax = sqrt(max(0.5 * (a + disc), 0.0));
      float smin = sqrt(max(0.5 * (a - disc), 0.0));
      if (vStretch > 0.3 || vOutside > 0.3 || smax > 3.0 * max(smin, 1e-5) || smin < 0.12) discard;
      if (unknown > 1.5) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
    }
    // Stretched curtains between near and far parts become a soft, slightly darker smear.
    vec3 c = texture2D(map, vUv, vStretch * 4.5).rgb * (1.0 - 0.25 * vStretch);
    // The photo keeps its own light; the key light only nudges surfaces that face it.
    float lambert = max(dot(normalize(vNormal), lightDir), 0.0);
    c *= mix(vec3(1.0), (0.78 + 0.5 * lambert) * lightColor, relight);
    // Past the photo's edges, the stretched border fades into the dark.
    c = mix(c, background, smoothstep(0.0, 1.0, vOutside) * 0.9);
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Photos are sRGB; set once when a texture first loads (it's cached and shared by URL). */
function asPhoto(texture: Texture | Texture[]) {
  for (const t of Array.isArray(texture) ? texture : [texture]) {
    if (t.colorSpace === SRGBColorSpace) continue;
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
}

function provisionalView(aspect: number): PlaceView {
  return { fov: photoFov(aspect), height: 1.6, pitch: 0, roll: 0, pivot: 6, near: 3, far: 40, floor: false };
}

function Location({
  image,
  scale,
  light,
  shadowOpacity,
}: {
  image: NonNullable<Scene["place"]["image"]>;
  scale: number;
  light: LightUniforms;
  shadowOpacity: number;
}) {
  const texture = useTexture(image.url, asPhoto) as Texture;
  const { depth } = useDepth(image.url);
  const setPlaceView = useDirector((s) => s.setPlaceView);
  const aspect = image.width / image.height;

  // First time this photo gets depth: work out how it was taken and look through it.
  useEffect(() => {
    if (depth && !image.view) setPlaceView(image.url, fitPlaceView(depth, aspect));
  }, [depth, image.view, image.url, aspect, setPlaceView]);

  const more = useDirector((s) => s.scene.place.more);
  const world = useDirector((s) => s.scene.place.world);
  return (
    <group scale={scale}>
      {image.view ? (
        <Surround main={{ ...image, view: image.view }} more={world ? [] : (more ?? [])} world={world} shadowOpacity={shadowOpacity} />
      ) : (
        <PlaceCard texture={texture} view={provisionalView(aspect)} aspect={aspect} />
      )}
    </group>
  );
}

/**
 * A world's 360 picture, loaded without suspending the set: while a sharper picture of the same world loads (its 8K one,
 * swapped in a minute after the place is made) the one on screen stays, where suspending blanked the whole place until
 * it was in. With no world, none. A picture left behind gives its GPU memory back (8K is 150 MB with its mips).
 */
function useWorldPicture(url: string | undefined) {
  const [shown, setShown] = useState<{ url: string; texture: Texture } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    new TextureLoader()
      .loadAsync(url)
      .then((texture) => {
        if (!live) return texture.dispose();
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = 8;
        // Its ends meet behind you: sampled across them, they blend instead of showing a line.
        texture.wrapS = RepeatWrapping;
        setShown({ url, texture });
      })
      .catch((err) => console.warn("[director] world picture:", (err as Error).message));
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => () => shown?.texture.dispose(), [shown]);
  return url && shown ? shown.texture : null;
}

/** How many pictures the surround blends: the photo and up to eleven views around it. */
const SURROUND_MAX = 12;
const surroundVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
// Unrolled: a sampler array can only be indexed by constants.
const surroundFragment = /* glsl */ `
  uniform sampler2D maps[${SURROUND_MAX}];
  uniform mat3 turns[${SURROUND_MAX}];
  uniform vec2 halfTan[${SURROUND_MAX}];
  uniform float weights[${SURROUND_MAX}];
  uniform int count;
  uniform vec3 center;
  uniform float unknown;
  uniform vec3 background;
  uniform float ground;
  uniform float photoRes;
  uniform sampler2D world;
  uniform float hasWorld;
  uniform float worldLat;
  uniform vec4 eyeLock;
  varying vec3 vWorld;
  void main() {
    // A world is seen as from wherever the camera stands (a 360 backdrop): laid on the floor around the photo's spot, its
    // pumps and rocks below the horizon came out flat on the ground and its bottom swirled, once the camera stood a few
    // meters away (the user's shots).
    // Its floor, though, is laid on the real floor as seen from right above the camera at the photo's height: as a
    // backdrop alone it stays where a 1.6 m eye sees it, and from a low camera a woman's feet hovered over it (FLUX 3).
    // Scouting, the world is the one the shot camera sees (eyeLock): from a camera flying about it slid underfoot.
    vec3 viewer = eyeLock.w > 0.5 ? eyeLock.xyz : cameraPosition;
    vec3 eye = hasWorld > 0.5 ? (ground > 0.5 ? vec3(viewer.x, center.y, viewer.z) : viewer) : center;
    vec3 d = normalize(vWorld - eye);
    // Below the horizon is the ground's: the dome there would show the same ground at infinity, stretched.
    // (A little past it: the floor's far edge doesn't quite reach the horizon, and the gap showed as a line.)
    if (ground < 0.5 && d.y < -0.01) discard;
    // The model's view: ground the photo shows magnified over 3 times (right in front of the camera) is left for the
    // model to draw: stretched, its puddles and reflections came back as streaks (FLUX 3 Klein kept them).
    if (hasWorld < 0.5 && ground > 0.5 && unknown > 0.5 && max(length(dFdx(d)), length(dFdy(d))) < photoRes / 3.0) discard;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    // The place's world: one 360 picture, longitude 0 the photo's forward, latitude 0 the horizon.
    if (hasWorld > 0.5) {
      float lat = asin(clamp(d.y, -1.0, 1.0));
      if (abs(lat) < worldLat * 0.5) {
        // Where longitude wraps (behind the photo's forward), its jump made the GPU pick the blurriest mip for one column
        // of pixels: a line down the world behind you (the user's alley). The same longitude half a turn round is smooth
        // there; whichever of the two is smooth is sampled (the texture repeats).
        float u1 = atan(d.x, -d.z) / 6.28318530718 + 0.5;
        float u2 = fract(u1 + 0.5) - 0.5;
        vec2 uv = vec2(fwidth(u1) <= fwidth(u2) ? u1 : u2, 0.5 + lat / worldLat);
        sum = texture2D(world, uv).rgb;
        total = 1.0;
      }
    }
    ${Array.from(
      { length: SURROUND_MAX },
      (_, k) => `
    if (${k} < count && hasWorld < 0.5) {
      vec3 c = turns[${k}] * d;
      if (c.z < -0.0001) {
        vec2 p = c.xy / -c.z / halfTan[${k}];
        float edge = max(abs(p.x), abs(p.y));
        if (edge < 1.0) {
          float w = weights[${k}] * (smoothstep(1.0, 0.55, edge) + 0.002);
          sum += texture2D(maps[${k}], p * 0.5 + 0.5).rgb * w;
          total += w;
        }
      }
    }`,
    ).join("")}
    if (total <= 0.0) {
      if (unknown > 0.5) discard;
      gl_FragColor = vec4(background, 1.0);
      return;
    }
    if (unknown > 1.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    gl_FragColor = vec4(sum / total, 1.0);
  }
`;

/**
 * The place as one clean picture all around the photo's spot: every direction takes its color from the pictures that
 * show it (the photo first, then the views around it, blended where they overlap), as seen from where the photo was
 * taken; the ground is that same picture laid on the floor, so moving or raising the camera keeps the ground's
 * perspective. The 3D relief smeared and melted wherever the camera left the photo's spot, and its views met in hard,
 * square seams, which every model copied into the take (the user's Qwen-Image takes: the sky in panels). Here nothing
 * is stretched: each pixel is one of a real picture's, and the parts no picture shows are left out (gray to fill, in
 * the model's view).
 */
function Surround({
  main,
  more,
  world,
  shadowOpacity,
}: {
  main: { url: string; width: number; height: number; view: PlaceView };
  more: PlacePhoto[];
  world?: PlaceWorld;
  shadowOpacity: number;
}) {
  const views = more.slice(0, SURROUND_MAX - 1);
  const scout = useStageView((s) => s.scout);
  const rig = useDirector((s) => s.scene.camera);
  const shotEye = scout ? cameraPosition(rig, focusPoint(useDirector.getState().scene)) : null;
  const urls = [main.url, ...views.map((p) => p.url)];
  const textures = useTexture(urls, asPhoto) as Texture[];
  const worldTexture = useWorldPicture(world?.url);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    for (const u of urls) loadedViews.add(u);
    invalidate();
  }, [urls.join("|"), invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  const pose = photoCamera(main.view);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: surroundVertex,
        fragmentShader: surroundFragment,
        side: BackSide,
        uniforms: {
          maps: { value: new Array(SURROUND_MAX).fill(null) },
          turns: { value: Array.from({ length: SURROUND_MAX }, () => new Matrix3()) },
          halfTan: { value: Array.from({ length: SURROUND_MAX }, () => new Vector2(1, 1)) },
          weights: { value: new Array(SURROUND_MAX).fill(0) },
          count: { value: 0 },
          center: { value: new Vector3() },
          unknown: { value: 0 },
          background: { value: new Color(STAGE_BACKGROUND).convertSRGBToLinear() },
          ground: { value: 0 },
          photoRes: { value: 0.001 },
          world: { value: null },
          hasWorld: { value: 0 },
          worldLat: { value: 2.69 },
          eyeLock: { value: new Vector4() },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  const ground = useMemo(() => {
    const m = material.clone();
    m.side = DoubleSide;
    m.uniforms.ground.value = 1;
    return m;
  }, [material]);
  useEffect(() => () => ground.dispose(), [ground]);

  // Each picture's camera: the photo's own, the views turned around it by their turn (built from the photo's pose).
  const mainAspect = main.width / main.height;
  const vTan = Math.tan(rad(main.view.fov / 2));
  const sources = [
    { quaternion: pose.quaternion, halfTan: new Vector2(vTan * mainAspect, vTan), weight: 4 },
    ...views.map((p) => {
      const aspect = p.width / Math.max(1, p.height);
      // Views built here share the photo's lens; a photo of your own has its own.
      const fov = Math.abs(aspect - mainAspect) < 0.02 ? main.view.fov : (p.view?.fov ?? photoFov(aspect));
      const t = Math.tan(rad(fov / 2));
      return { quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad(p.turn)).multiply(pose.quaternion), halfTan: new Vector2(t * aspect, t), weight: 1 };
    }),
  ];
  for (const m of [material, ground]) {
    const u = m.uniforms;
    sources.forEach((s, i) => {
      u.maps.value[i] = textures[i];
      (u.turns.value[i] as Matrix3).setFromMatrix4(new Matrix4().makeRotationFromQuaternion(s.quaternion.clone().invert()));
      (u.halfTan.value[i] as Vector2).copy(s.halfTan);
      u.weights.value[i] = s.weight;
    });
    for (let i = sources.length; i < SURROUND_MAX; i++) u.maps.value[i] = textures[0];
    u.count.value = sources.length;
    (u.center.value as Vector3).copy(pose.position);
    // The angle one of the photo's pixels spans.
    u.photoRes.value = (2 * vTan) / Math.max(1, (textures[0].image as { height?: number } | undefined)?.height ?? main.height);
    u.world.value = worldTexture ?? textures[0];
    u.hasWorld.value = worldTexture ? 1 : 0;
    (u.eyeLock.value as Vector4).set(shotEye?.x ?? 0, shotEye?.y ?? 0, shotEye?.z ?? 0, shotEye ? 1 : 0);
    if (world) {
      // 21:9 of a full panorama's 2:1: its share of 180 degrees of latitude.
      u.worldLat.value = Math.PI * (world.height / (world.width / 2));
      u.photoRes.value = u.worldLat.value / Math.max(1, world.height);
    }
  }
  useEffect(() => invalidate());

  // The world as a backdrop that goes where the camera goes: its ground until (or unless) it's been measured to walk
  // into; its dome always, behind everything, so a gap in the walk-in shows the place's own picture that way instead
  // of black (the user's store, swung round its corner). Keyed: when the depth came in, React kept the ground's mesh for
  // the depth-only floor below, and dropping its `material` reset it to a plain white one, which fought the walk-in
  // floor (white blotches after an extend).
  const dome = (
    <mesh key="dome" position={pose.position} material={material} userData={{ [PLACE_SET]: true, [NO_DEPTH]: true }}>
      <sphereGeometry args={[400, 64, 32]} />
    </mesh>
  );
  const groundDisc = (
    <mesh key="ground" rotation-x={-Math.PI / 2} material={ground} userData={{ [PLACE_SET]: true }}>
      <circleGeometry args={[400, 96]} />
    </mesh>
  );
  return (
    <>
      {dome}
      {world?.depth && worldTexture ? (
        <>
          <WalkIn depth={world.depth} world={worldTexture} center={pose.position} span={Math.PI * (world.height / (world.width / 2))} eye={shotEye}>
            {groundDisc}
          </WalkIn>
          {/* The floor for the depth pass alone (the shot's depth keeps a level floor out to the horizon). */}
          <mesh key="depth-floor" rotation-x={-Math.PI / 2} userData={{ [PLACE_SET]: true }}>
            <circleGeometry args={[400, 96]} />
            <meshBasicMaterial colorWrite={false} depthWrite={false} />
          </mesh>
        </>
      ) : (
        groundDisc
      )}
      <mesh rotation-x={-Math.PI / 2} receiveShadow userData={{ [NO_DEPTH]: true }}>
        <circleGeometry args={[400, 96]} />
        <shadowMaterial transparent opacity={shadowOpacity} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-4} />
      </mesh>
    </>
  );
}

/**
 * Another photo of the place from the same spot: its own 3D set, turned around the main photo's camera by its turn and
 * moved so both cameras stand in the same spot (both are at eye height over the same floor).
 */
function MorePlace({ photo, main, light, shadowOpacity }: { photo: PlacePhoto; main: PlaceView; light: LightUniforms; shadowOpacity: number }) {
  const texture = useTexture(photo.url, asPhoto) as Texture;
  const { depth } = useDepth(photo.url);
  const setPlacePhotoView = useDirector((s) => s.setPlacePhotoView);
  const aspect = photo.width / photo.height;
  useEffect(() => {
    if (depth && !photo.view) setPlacePhotoView(photo.url, fitPlaceView(depth, aspect));
  }, [depth, photo.view, photo.url, aspect, setPlacePhotoView]);
  const view = photo.view ?? provisionalView(aspect);
  const at = photoCamera(main).position;
  const own = photoCamera(view).position;
  return (
    <group position={[at.x, 0, at.z]}>
      <group rotation-y={rad(photo.turn)}>
        <group position={[-own.x, 0, -own.z]}>
          {depth && photo.view ? (
            <PlaceSet texture={texture} depth={depth} view={photo.view} aspect={aspect} light={light} shadowOpacity={shadowOpacity} />
          ) : (
            <PlaceCard texture={texture} view={view} aspect={aspect} />
          )}
        </group>
      </group>
    </group>
  );
}

/** Before the 3D set is ready: the photo as a backdrop exactly filling the photo camera's view. */
function PlaceCard({ texture, view, aspect }: { texture: Texture; view: PlaceView; aspect: number }) {
  const { position, quaternion } = photoCamera(view);
  const distance = view.pivot * 1.8;
  const h = 2 * distance * Math.tan(rad(view.fov / 2));
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
  const center = position.clone().addScaledVector(forward, distance);
  return (
    <mesh position={center} quaternion={quaternion}>
      <planeGeometry args={[h * aspect, h]} />
      <meshBasicMaterial map={texture} toneMapped={false} fog={false} />
    </mesh>
  );
}

function PlaceSet({
  texture,
  depth,
  view,
  aspect,
  light,
  shadowOpacity,
}: {
  texture: Texture;
  depth: DepthMap;
  view: PlaceView;
  aspect: number;
  light: LightUniforms;
  shadowOpacity: number;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    const surface = placeSurface(depth, view, aspect);
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(surface.positions, 3));
    g.setAttribute("uv", new BufferAttribute(surface.uvs, 2));
    g.setAttribute("outside", new BufferAttribute(surface.outside, 1));
    g.setAttribute("stretch", new BufferAttribute(surface.stretch, 1));
    g.setIndex(new BufferAttribute(surface.index, 1));
    g.computeVertexNormals();
    // Where each vertex starts: on the flat backdrop, along its own ray, so the photo "inflates" into 3D.
    const { position: eye } = photoCamera(view);
    const flat = new Float32Array(surface.positions.length);
    const p = new Vector3();
    const distance = view.pivot * 1.8;
    for (let i = 0; i < flat.length; i += 3) {
      p.set(surface.positions[i], surface.positions[i + 1], surface.positions[i + 2]).sub(eye);
      const along = p.length();
      p.multiplyScalar(along > 0 ? distance / along : 0).add(eye);
      flat.set([p.x, p.y, p.z], i);
    }
    g.setAttribute("flatPos", new BufferAttribute(flat, 3));
    return g;
  }, [depth, view, aspect]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: placeVertex,
        fragmentShader: placeFragment,
        side: DoubleSide,
        uniforms: {
          map: { value: texture },
          reveal: { value: 0 },
          lightDir: { value: new Vector3(0, 1, 0) },
          lightColor: { value: new Color(1, 1, 1) },
          relight: { value: 0.3 },
          background: { value: new Color(STAGE_BACKGROUND).convertSRGBToLinear() },
          unknown: { value: 0 },
          unknownColor: { value: UNKNOWN_GRAY.clone() },
          texSize: { value: new Vector2((texture.image as { width?: number } | undefined)?.width ?? 1024, (texture.image as { height?: number } | undefined)?.height ?? 1024) },
        },
      }),
    [texture],
  );
  useEffect(() => () => material.dispose(), [material]);
  // Uniforms change in place through the mesh (three.js materials are mutable, React state isn't).
  const mesh = useRef<Mesh>(null);
  const uniforms = () => (mesh.current?.material as ShaderMaterial | undefined)?.uniforms;

  useEffect(() => {
    const u = uniforms();
    if (!u) return;
    u.lightDir.value.copy(light.dir);
    u.lightColor.value.copy(light.color);
    u.relight.value = 0.38 * (1 - light.softness * 0.6);
    invalidate();
  }, [material, light.dir, light.color, light.softness, invalidate]);

  // Reveal: the flat photo swells into its 3D shape.
  const [revealed, setRevealed] = useState(false);
  const started = useRef<number | null>(null);
  useFrame((state) => {
    const u = uniforms();
    if (revealed || !u) return;
    started.current ??= state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - started.current) / 0.9);
    u.reveal.value = 1 - Math.pow(1 - t, 3);
    if (t >= 1) setRevealed(true);
    else state.invalidate();
  });

  return (
    <>
      <mesh ref={mesh} geometry={geometry} material={material} userData={{ [PLACE_SET]: true }} />
      {revealed ? (
        <mesh geometry={geometry} receiveShadow userData={{ [NO_DEPTH]: true }}>
          <shadowMaterial transparent opacity={shadowOpacity} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-4} />
        </mesh>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Subjects

type Handlers = {
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: (e: ThreeEvent<PointerEvent>) => void;
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
};

/**
 * Picking up someone on set: a click selects them; dragging moves their feet with the cursor across the screen (from
 * wherever they were grabbed). Moved to where the cursor's ray met the floor, a person grabbed by the chest jumped
 * meters for a nudge of the mouse: that ray met the floor far behind them, at a glancing angle.
 */
function useDragHandlers(el: SceneElement): Handlers {
  const drag = useRef<{ offset: Vector2; x: number; y: number; moved: boolean } | null>(null);
  const hit = useMemo(() => new Vector3(), []);
  const caster = useMemo(() => new Raycaster(), []);
  // The scouting view's controls (none through the lens): held still while something is dragged.
  const get = useThree((s) => s.get);
  const hold = (still: boolean) => {
    const controls = get().controls as unknown as { enabled: boolean } | null;
    if (controls) controls.enabled = !still;
  };
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      hold(true);
      const { select } = useDirector.getState();
      select(el.id);
      // Where their feet are on screen, against the cursor: kept while dragging.
      const feet = new Vector3(el.x, 0, el.z).project(get().camera);
      drag.current = { offset: new Vector2(feet.x - e.pointer.x, feet.y - e.pointer.y), x: e.clientX, y: e.clientY, moved: false };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d) return;
      e.stopPropagation();
      // A click is a click: nothing moves until the pointer has.
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
      caster.setFromCamera(new Vector2(e.pointer.x + d.offset.x, e.pointer.y + d.offset.y), get().camera);
      if (!caster.ray.intersectPlane(floorPlane, hit)) return;
      // Not off toward the horizon: no farther than 60 m from the camera.
      const from = get().camera.position;
      const away = new Vector3(hit.x - from.x, 0, hit.z - from.z);
      if (away.length() > 60) hit.set(from.x, 0, from.z).add(away.setLength(60));
      const { checkpoint, updateElement, setCamera, scene } = useDirector.getState();
      if (!d.moved) {
        checkpoint();
        // The camera stays where it is while the one it frames is moved: aimed at them, it went along with each nudge,
        // so the next nudge reached further, and a slight move sent them meters (the user).
        if (mainElement(scene)?.id === el.id && !scene.camera.free) {
          const aim = focusPoint(scene);
          setCamera({ free: { x: aim.x, z: aim.z } }, true);
        }
      }
      d.moved = true;
      document.body.style.cursor = "grabbing";
      updateElement(el.id, { x: round(hit.x), z: round(hit.z) }, true);
    },
    onPointerUp: (e) => {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      drag.current = null;
      hold(false);
      document.body.style.cursor = "grab";
    },
    onPointerOver: (e) => {
      e.stopPropagation();
      document.body.style.cursor = "grab";
    },
    onPointerOut: () => {
      document.body.style.cursor = "";
    },
    onDoubleClick: (e) => {
      e.stopPropagation();
      useDirector.getState().focusOn(el.id);
    },
  };
}

/**
 * True while a subject is being moved or turned (in the set or with the panel's facing dial), and a moment after: its
 * body wearing its pictures shows meanwhile (PosedBody).
 */
function usePosing(id: string) {
  const [posing, setPosing] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = useDirector.subscribe((s, prev) => {
      const a = s.scene.elements.find((e) => e.id === id);
      const b = prev.scene.elements.find((e) => e.id === id);
      if (!a || !b || (a.yaw === b.yaw && a.x === b.x && a.z === b.z)) return;
      setPosing(true);
      clearTimeout(timer);
      timer = setTimeout(() => setPosing(false), 1200);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [id]);
  return posing;
}

/**
 * The subject's body wearing its own pictures (StandIn's PhotoBody): its front drawing on the front, its back one on
 * the back, so you see which way it faces while you move or turn it, instead of a drawing jumping from side to side.
 */
function PosedBody({ el, light, onShown }: { el: SceneElement; light: LightUniforms; onShown: (shown: boolean) => void }) {
  const views = el.views ?? [];
  const nearest = (deg: number) => {
    let best: (typeof views)[number] | null = null;
    for (const v of views) {
      const off = Math.abs(angleDelta(v.around, deg));
      if (off < 60 && (!best || off < Math.abs(angleDelta(best.around, deg)))) best = v;
    }
    return best;
  };
  const front = nearest(0) ?? (el.image && Math.abs(angleDelta(el.read?.around ?? 0, 0)) < 60 ? el.image : null);
  const back = nearest(180);
  if (!front && !back) return <PhotoBody el={el} front={null} back={null} light={light} onShown={onShown} />;
  return <PosedPictures el={el} front={front} back={back} light={light} onShown={onShown} />;
}

function PosedPictures({
  el,
  front,
  back,
  light,
  onShown,
}: {
  el: SceneElement;
  front: { url: string; width: number; height: number } | null;
  back: { url: string; width: number; height: number } | null;
  light: LightUniforms;
  onShown: (shown: boolean) => void;
}) {
  const pictures = [front, back].filter((p): p is { url: string; width: number; height: number } => Boolean(p));
  const textures = useTexture(
    pictures.map((p) => p.url),
    asPhoto,
  ) as Texture[];
  const of = (p: typeof front) => (p ? { texture: textures[pictures.indexOf(p)], aspect: p.width / Math.max(1, p.height) } : null);
  return <PhotoBody el={el} front={of(front)} back={of(back)} light={light} onShown={onShown} />;
}

function Subject({ el, color, selected, light }: { el: SceneElement; color: string; selected: boolean; light: LightUniforms }) {
  const handlers = useDragHandlers(el);
  const drawn = Boolean(el.views?.length);
  const posing = usePosing(el.id);
  // Its drawing stays until the posed body is on screen: hidden at once, the subject vanished for a frame.
  const [bodyShown, setBodyShown] = useState(false);
  const swapped = posing && bodyShown;
  // Its pictures loaded ahead: loaded only once it was turned, the body showed black for a moment first.
  const pictures = (el.views ?? []).map((v) => v.url).join("|");
  useEffect(() => {
    for (const url of pictures.split("|").filter(Boolean)) useTexture.preload(url);
  }, [pictures]);
  return (
    <group position={[el.x, 0, el.z]}>
      {drawn ? (
        <group visible={!swapped}>
          <Safe key={`${pictures}|${el.image?.url ?? ""}`} fallback={null}>
            <Suspense fallback={null}>
              <Drawn el={el} handlers={handlers} />
            </Suspense>
          </Safe>
        </group>
      ) : null}
      <group position-y={el.lift} rotation-y={rad(el.yaw)}>
        {posing ? (
          // Your view only: the model's view keeps its plain stand-in.
          <group userData={{ [VIEW_NORMAL]: true }}>
            <Safe key={`${pictures}|${el.image?.url ?? ""}`} fallback={null}>
              <Suspense fallback={null}>
                <PosedBody el={el} light={light} onShown={setBodyShown} />
              </Suspense>
            </Safe>
          </group>
        ) : null}
        {/* The photo card turns with the side the photo shows: yaw is where the subject itself faces. */}
        {!drawn ? (
          <group visible={!swapped}>
            <group userData={{ [VIEW_NORMAL]: true }} rotation-y={rad(el.read?.around ?? 0)}>
              {el.image ? (
                <Safe key={el.image.url} fallback={<Placeholder el={el} handlers={handlers} />}>
                  <Suspense fallback={<Placeholder el={el} handlers={handlers} />}>
                    <Relief el={el} light={light} handlers={handlers} />
                  </Suspense>
                </Safe>
              ) : el.kind === "vehicle" ? (
                // A vehicle with no picture is its stand-in's shape in grey (a car, a motorbike), the way round it
                // faces: a box three heights wide stood across the camera's view, over whoever rode it.
                <StandIn el={el} color="#8b8f99" light={light} visible handlers={handlers} />
              ) : (
                <Placeholder el={el} handlers={handlers} />
              )}
            </group>
          </group>
        ) : null}
        <StandIn el={el} color={color} light={light} visible={false} handlers={handlers} />
      </group>
      {selected ? (
        <Helper>
          <SelectionMark el={el} />
        </Helper>
      ) : null}
    </group>
  );
}

/**
 * A subject drawn from all around it: the drawing nearest to the side the camera sees, standing upright and turned to
 * face the camera, its whole height the subject's height. Shadows and the depth pass keep its silhouette.
 */
function Drawn({ el, handlers }: { el: SceneElement; handlers: Handlers }) {
  const views = el.views!;
  const textures = useTexture(
    views.map((v) => v.url),
    asPhoto,
  ) as Texture[];
  const invalidate = useThree((s) => s.invalidate);
  const mesh = useRef<Mesh>(null);
  const [pick, setPick] = useState(0);
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ map: textures[0], alphaTest: 0.5, side: DoubleSide, toneMapped: false });
    m.userData.cutoutMap = textures[0];
    return m;
  }, [textures]);
  const depthMaterial = useMemo(() => new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: textures[0], alphaTest: 0.5 }), [textures]);
  useEffect(
    () => () => {
      material.dispose();
      depthMaterial.dispose();
    },
    [material, depthMaterial],
  );
  const view = views[pick] ?? views[0];
  const width = el.height * (view.width / Math.max(1, view.height));

  useFrame(({ camera }) => {
    const m = mesh.current;
    if (!m) return;
    // Which side the camera sees: the drawing made from nearest that side.
    const toward = MathUtils.radToDeg(Math.atan2(camera.position.x - el.x, camera.position.z - el.z));
    const around = angleDelta(el.yaw, toward);
    let best = 0;
    views.forEach((v, i) => {
      if (Math.abs(angleDelta(v.around, around)) < Math.abs(angleDelta(views[best].around, around))) best = i;
    });
    if (best !== pick) {
      setPick(best);
      const mat = m.material as MeshBasicMaterial;
      mat.map = textures[best];
      mat.userData.cutoutMap = textures[best];
      mat.needsUpdate = true;
      (m.customDepthMaterial as MeshDepthMaterial | undefined)?.setValues({ map: textures[best] });
      invalidate();
    }
    m.rotation.y = MathUtils.degToRad(toward);
  });

  return (
    <mesh
      ref={mesh}
      position={[0, el.lift + el.height / 2, 0]}
      material={material}
      customDepthMaterial={depthMaterial}
      castShadow
      userData={{ [SUBJECT]: true, [VIEW_NORMAL]: true }}
      {...handlers}
    >
      <planeGeometry args={[width, el.height]} />
    </mesh>
  );
}

type Box = { x: number; y: number; w: number; h: number };

/** The cutout's coverage on a grid over its opaque area (so its height is the subject's real height). */
function coverageGrid(img: HTMLImageElement | ImageBitmap | undefined, cutout: boolean) {
  const fallback = { alpha: new Float32Array(4).fill(1), columns: 2, rows: 2, box: { x: 0, y: 0, w: 1, h: 1 }, pixelAspect: 1 };
  if (!img || typeof document === "undefined") return fallback;
  let box: Box = { x: 0, y: 0, w: 1, h: 1 };
  if (cutout) {
    const S = 256;
    const ratio = img.width / img.height;
    const c = document.createElement("canvas");
    c.width = ratio >= 1 ? S : Math.max(1, Math.round(S * ratio));
    c.height = ratio >= 1 ? Math.max(1, Math.round(S / ratio)) : S;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img as CanvasImageSource, 0, 0, c.width, c.height);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= 0) box = { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height };
    }
  }
  const pixelAspect = (img.width * box.w) / (img.height * box.h);
  const long = 120;
  const columns = pixelAspect >= 1 ? long : Math.max(8, Math.round(long * pixelAspect));
  const rows = pixelAspect >= 1 ? Math.max(8, Math.round(long / pixelAspect)) : long;
  const alpha = new Float32Array(columns * rows).fill(1);
  if (cutout) {
    const c = document.createElement("canvas");
    c.width = columns;
    c.height = rows;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img as CanvasImageSource, box.x * img.width, box.y * img.height, box.w * img.width, box.h * img.height, 0, 0, columns, rows);
      const { data } = ctx.getImageData(0, 0, columns, rows);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] / 255;
    }
  }
  return { alpha, columns, rows, box, pixelAspect };
}

const subjectVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const subjectFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 lightDir;
  uniform vec3 lightColor;
  uniform float key;
  uniform float shade;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.5) discard;
    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float lambert = max(dot(n, lightDir), 0.0);
    vec3 lit = c.rgb * ((1.0 - key) + key * 1.55 * lambert * lightColor);
    // The back of a cutout is the same silhouette, darker: it reads as "their back".
    vec3 back = mix(lit * 0.55, vec3(dot(lit, vec3(0.3, 0.55, 0.15))) * 0.5, 0.45);
    gl_FragColor = vec4(mix(lit, back, shade), 1.0);
  }
`;

function subjectMaterial(texture: Texture, shade: number) {
  const m = new ShaderMaterial({
    vertexShader: subjectVertex,
    fragmentShader: subjectFragment,
    uniforms: {
      map: { value: texture },
      lightDir: { value: new Vector3(0, 1, 0) },
      lightColor: { value: new Color(1, 1, 1) },
      key: { value: 0.4 },
      shade: { value: shade },
    },
  });
  // The depth capture reads these to keep the silhouette.
  m.userData.cutoutMap = texture;
  return m;
}

function Relief({ el, light, handlers }: { el: SceneElement; light: LightUniforms; handlers: Handlers }) {
  const image = el.image!;
  const texture = useTexture(image.url, asPhoto) as Texture;
  const invalidate = useThree((s) => s.invalidate);
  const { depth } = useDepth(image.cutout ? image.url : null);
  const grid = useMemo(() => coverageGrid(texture.image as HTMLImageElement | undefined, image.cutout), [texture, image.cutout]);
  const width = el.height * grid.pixelAspect;
  const thickness = el.height * ELEMENT_DEFAULTS[el.kind].depth;

  const { front, back } = useMemo(() => {
    const r = reliefSurface({ ...grid, width, height: el.height, thickness, depth, flat: !image.cutout });
    const make = (positions: Float32Array, index: Uint32Array) => {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(positions, 3));
      g.setAttribute("uv", new BufferAttribute(r.uvs, 2));
      g.setIndex(new BufferAttribute(index, 1));
      g.computeVertexNormals();
      return g;
    };
    return { front: make(r.front, r.frontIndex), back: make(r.back, r.backIndex) };
  }, [grid, width, el.height, thickness, depth, image.cutout]);
  useEffect(
    () => () => {
      front.dispose();
      back.dispose();
    },
    [front, back],
  );

  const materials = useMemo(() => ({ front: subjectMaterial(texture, 0), back: subjectMaterial(texture, 1) }), [texture]);
  const depthMaterial = useMemo(() => new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: texture, alphaTest: 0.5 }), [texture]);
  useEffect(
    () => () => {
      materials.front.dispose();
      materials.back.dispose();
      depthMaterial.dispose();
    },
    [materials, depthMaterial],
  );
  // Uniforms change in place through the meshes (three.js materials are mutable, React state isn't).
  const frontMesh = useRef<Mesh>(null);
  const backMesh = useRef<Mesh>(null);
  useEffect(() => {
    for (const mesh of [frontMesh.current, backMesh.current]) {
      const u = (mesh?.material as ShaderMaterial | undefined)?.uniforms;
      if (!u) continue;
      u.lightDir.value.copy(light.dir);
      u.lightColor.value.copy(light.color);
      u.key.value = 0.45 * (1 - light.softness * 0.55);
    }
    invalidate();
  }, [materials, light.dir, light.color, light.softness, invalidate]);

  return (
    <>
      <mesh ref={frontMesh} geometry={front} material={materials.front} castShadow customDepthMaterial={depthMaterial} userData={{ [SUBJECT]: true }} {...handlers} />
      <mesh ref={backMesh} geometry={back} material={materials.back} castShadow customDepthMaterial={depthMaterial} userData={{ [SUBJECT]: true }} {...handlers} />
    </>
  );
}

/**
 * A picture that won't load (a file gone from the disk, or one this visitor may not open) shows its fallback instead of
 * taking the whole stage down: drei's useTexture throws, and nothing inside the Canvas caught it (a cut-out the demo
 * wouldn't serve crashed the Director with "Could not load …"). Keyed by the picture, so a new one tries again.
 */
class Safe extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Director: a picture didn't load", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Placeholder({ el, handlers }: { el: SceneElement; handlers: Handlers }) {
  const color = "#8b8f99";
  if (el.kind === "person") {
    const r = Math.min(0.24, el.height * 0.13);
    return (
      <mesh position={[0, el.height / 2, 0]} castShadow userData={{ [SUBJECT]: true }} {...handlers}>
        <capsuleGeometry args={[r, Math.max(0.1, el.height - r * 2), 6, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    );
  }
  const w = el.kind === "vehicle" ? el.height * 3 : el.height * 0.8;
  const d = el.kind === "vehicle" ? el.height * 1.3 : el.height * 0.8;
  return (
    <mesh position={[0, el.height / 2, 0]} castShadow userData={{ [SUBJECT]: true }} {...handlers}>
      <boxGeometry args={[w, el.height, d]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

/** A ring of spike tape under the selected subject and an arrow for where they face. */
function SelectionMark({ el }: { el: SceneElement }) {
  const yaw = rad(el.yaw);
  const r = Math.max(0.3, Math.min(1.2, el.height * 0.24));
  return (
    <group position={[0, 0.01, 0]}>
      <mesh rotation-x={-Math.PI / 2} renderOrder={10}>
        <ringGeometry args={[r, r + 0.035, 64]} />
        <meshBasicMaterial color={SPIKE} transparent opacity={0.95} depthTest={false} toneMapped={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} rotation-z={yaw + Math.PI} position={[Math.sin(yaw) * (r + 0.12), 0, Math.cos(yaw) * (r + 0.12)]} renderOrder={10}>
        <circleGeometry args={[0.09, 3]} />
        <meshBasicMaterial color={SPIKE} transparent opacity={0.95} depthTest={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
