"use client";

import { Suspense, useEffect, useMemo, useRef, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { Color, DoubleSide, MathUtils, type Mesh, type PerspectiveCamera, Raycaster, type ShaderMaterial, type Texture, Vector2, type Vector3 } from "three";
import { photoCamera, type DepthMap } from "@/lib/director/reconstruct";
import type { PlaceView } from "@/lib/director/types";
import type { SubjectMask } from "@/lib/director/vision";
import { angleBase, angleCamera, wrapDegrees, type AngleShot } from "@/lib/angles/rig";
import { sampleMask } from "@/lib/angles/surface";
import { asPhoto, buildSet, disposeSet, setMaterial, SCREEN_VOID } from "./place";

/** The point of the photo under a spot of the view (0…1 from the top-left), or null over the void. */
export type PickPoint = (x: number, y: number) => { u: number; v: number } | null;

type Props = {
  url: string;
  aspect: number;
  depth: DepthMap | null;
  /** The subject's matte once it's ready; until then (or without a subject) the set is one surface. */
  mask: SubjectMask | null;
  place: PlaceView;
  shot: AngleShot;
  /** The point the camera orbits, in the set. */
  pivot: Vector3;
  pickRef: RefObject<PickPoint | null>;
};

type Glide = AngleShot & { pivot: Vector3 };

/** Photos that already swelled into 3D, and where the camera last was for each, so coming back doesn't replay. */
const revealed = new Set<string>();
const lastGlide = new Map<string, Glide>();

/** The photo as a soft 3D set, seen from the Angles camera: exactly the frame the guide will show. */
export default function AngleStage(props: Props) {
  return (
    <Canvas flat frameloop="demand" dpr={[1, 2]} camera={{ near: 0.05, far: 2000 }} style={{ background: SCREEN_VOID }}>
      <AngleCamera {...props} />
      <Suspense fallback={null}>
        <Photo {...props} />
      </Suspense>
    </Canvas>
  );
}

/** Glides the camera into the chosen angle; the first time, from where the photo was taken. */
function AngleCamera({ url, place, shot, pivot }: Props) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const glide = useRef<{ url: string; g: Glide } | null>(null);

  useEffect(() => invalidate(), [shot, pivot, place, size, invalidate]);

  useFrame((_, delta) => {
    if (glide.current?.url !== url) {
      const g = lastGlide.get(url) ?? { azimuth: 0, elevation: angleBase(place, pivot).elevation, zoom: 0, pivot: pivot.clone() };
      glide.current = { url, g };
      lastGlide.set(url, g);
    }
    const { g } = glide.current;
    const k = 1 - Math.exp(-Math.min(delta, 1 / 30) * 8);
    g.azimuth = wrapDegrees(g.azimuth + wrapDegrees(shot.azimuth - g.azimuth) * k);
    g.elevation += (shot.elevation - g.elevation) * k;
    g.zoom += (shot.zoom - g.zoom) * k;
    g.pivot.lerp(pivot, k);
    const settled =
      Math.abs(wrapDegrees(shot.azimuth - g.azimuth)) < 0.02 &&
      Math.abs(shot.elevation - g.elevation) < 0.02 &&
      Math.abs(shot.zoom - g.zoom) < 0.0005 &&
      g.pivot.distanceTo(pivot) < 0.001;
    if (settled) {
      Object.assign(g, shot);
      g.pivot.copy(pivot);
    } else invalidate();

    const cam = angleCamera(angleBase(place, g.pivot), g);
    // three.js cameras are mutable objects owned by the canvas; read it fresh and update in place.
    const camera = get().camera as PerspectiveCamera;
    camera.fov = cam.fov;
    camera.aspect = size.width / Math.max(1, size.height);
    camera.near = Math.max(0.02, cam.distance * 0.02);
    camera.far = (cam.distance + place.far) * 6;
    camera.position.copy(cam.position);
    camera.quaternion.copy(cam.quaternion);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, -1);
  return null;
}

function Photo({ url, aspect, depth, mask, place, pickRef }: Props) {
  const texture = useTexture(url, asPhoto) as Texture;
  return depth ? (
    <PlaceSet key={url} url={url} texture={texture} depth={depth} mask={mask} place={place} aspect={aspect} pickRef={pickRef} />
  ) : (
    <PlaceCard texture={texture} place={place} aspect={aspect} />
  );
}

/** Before the depth map: the photo as a card, centered on the point the camera orbits. */
function PlaceCard({ texture, place, aspect }: { texture: Texture; place: PlaceView; aspect: number }) {
  const { position, quaternion, forward } = photoCamera(place);
  const h = 2 * place.pivot * Math.tan(MathUtils.degToRad(place.fov / 2));
  return (
    <mesh position={position.clone().addScaledVector(forward, place.pivot)} quaternion={quaternion}>
      <planeGeometry args={[h * aspect, h]} />
      <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
    </mesh>
  );
}

function PlaceSet({
  url,
  texture,
  depth,
  mask,
  place,
  aspect,
  pickRef,
}: {
  url: string;
  texture: Texture;
  depth: DepthMap;
  mask: SubjectMask | null;
  place: PlaceView;
  aspect: number;
  pickRef: RefObject<PickPoint | null>;
}) {
  const camera = useThree((s) => s.camera);
  const set = useMemo(() => buildSet(depth, place, aspect, mask), [depth, place, aspect, mask]);
  useEffect(() => () => disposeSet(set), [set]);
  const materials = useMemo(() => {
    const background = new Color(SCREEN_VOID);
    const reveal = revealed.has(url) ? 1 : 0;
    return { place: setMaterial(texture, set, "place", background, reveal), subject: set.subject ? setMaterial(texture, set, "subject", background, reveal) : null };
  }, [texture, set, url]);
  useEffect(
    () => () => {
      materials.place.dispose();
      materials.subject?.dispose();
    },
    [materials],
  );
  const placeRef = useRef<Mesh>(null);
  const subjectRef = useRef<Mesh>(null);

  // Reveal: the flat photo swells into its 3D shape. Uniforms change in place through the meshes.
  const started = useRef<number | null>(null);
  useFrame((state) => {
    const all = [placeRef.current, subjectRef.current].map((m) => (m?.material as ShaderMaterial | undefined)?.uniforms).filter((u) => u !== undefined);
    if (!all.length || all.every((u) => u.reveal.value >= 1)) return;
    started.current ??= state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - started.current) / 0.9);
    for (const u of all) u.reveal.value = 1 - Math.pow(1 - t, 3);
    if (t >= 1) revealed.add(url);
    else state.invalidate();
  });

  // The surfaces' texture coordinates are the photo's, so a hit says which point of the photo it is.
  // Holes the shader cuts (the subject's spot in the set, the solid's empty corners) don't count.
  useEffect(() => {
    const raycaster = new Raycaster();
    pickRef.current = (x, y) => {
      const meshes = [placeRef.current, subjectRef.current].filter((m) => m !== null);
      raycaster.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      for (const hit of raycaster.intersectObjects(meshes, false)) {
        if (!hit.uv) continue;
        const p = { u: hit.uv.x, v: 1 - hit.uv.y };
        const onSubject = mask ? sampleMask(mask, p.u, p.v) > 0.5 : false;
        const drawn = hit.object === subjectRef.current ? onSubject : !onSubject;
        if (drawn) return p;
      }
      return null;
    };
    return () => {
      pickRef.current = null;
    };
  }, [camera, pickRef, mask]);

  return (
    <>
      <mesh ref={placeRef} geometry={set.place} material={materials.place} frustumCulled={false} />
      {set.subject && materials.subject ? <mesh ref={subjectRef} geometry={set.subject} material={materials.subject} frustumCulled={false} /> : null}
    </>
  );
}
