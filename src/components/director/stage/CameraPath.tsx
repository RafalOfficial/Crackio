"use client";

import { useMemo } from "react";
import { Line } from "@react-three/drei";
import { Vector3 } from "three";
import { useDirector } from "@/lib/director/store";
import { cameraPosition, focusPoint } from "@/lib/director/camera";
import { cameraAt, focusResolver, hasKeys } from "@/lib/director/timeline";
import type { Scene } from "@/lib/director/types";

/**
 * Director v2's Set tab: the way the Camera travels over the shot, drawn on the set (the challenge winner left this out
 * and missed it): a line through every frame and a dot at each key. A helper: never in the shot.
 */
export function CameraPath() {
  const timeline = useDirector((s) => s.scene.timeline);
  const elements = useDirector((s) => s.scene.elements);
  const path = useMemo(() => {
    if (!hasKeys(timeline) || timeline.camera.length < 2) return null;
    const where = focusResolver(elements);
    const scene = { ...useDirector.getState().scene, elements } as Scene;
    const at = (t: number) => {
      const rig = cameraAt(timeline, t, where);
      return rig ? cameraPosition(rig, focusPoint({ ...scene, camera: rig })) : null;
    };
    const points: Vector3[] = [];
    const step = Math.max(1, Math.round(timeline.length / 120));
    for (let t = 0; t <= timeline.length; t += step) {
      const p = at(t);
      if (p) points.push(p);
    }
    const keys = timeline.camera.map((k) => at(k.t)).filter((p): p is Vector3 => Boolean(p));
    return points.length >= 2 ? { points, keys } : null;
  }, [timeline, elements]);
  if (!path) return null;
  return (
    <group>
      <Line points={path.points} color="#ff5b2e" lineWidth={2} transparent opacity={0.85} />
      {path.keys.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.07, 16, 12]} />
          <meshBasicMaterial color="#ffd2c2" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
