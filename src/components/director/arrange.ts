"use client";

import { create } from "zustand";
import { MathUtils, Vector3 } from "three";
import { useDirector } from "@/lib/director/store";
import { shotCamera } from "@/lib/director/camera";
import { BODIES, hipHeight, poseOf, type Pose } from "@/lib/director/standin";
import { ANGLES, SHOT_SIZES } from "@/lib/director/vocab";
import type { Scene, SceneElement } from "@/lib/director/types";

/** An arrange in progress, or why it couldn't be done. */
export const useArrange = create<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));

type Plan = {
  subjects?: { id: string; pose?: string | null; action?: string | null; on?: string | null; near?: { id: string; side?: string; gap?: number } | null; facing?: string | null }[];
  camera?: { shot?: string; angle?: string; focus?: string; from?: string } | null;
};

const round = (n: number) => Math.round(n * 100) / 100;
const wrap = (deg: number) => Math.round(((((deg % 360) + 540) % 360) - 180) * 10) / 10;

/** The set in words for the arranger: who and what, where in the frame, which way they face, and how. */
function described(scene: Scene) {
  const cam = shotCamera(scene);
  cam.updateMatrixWorld(true);
  return scene.elements
    .map((el) => {
      const p = new Vector3(el.x, el.lift + el.height / 2, el.z).project(cam);
      const where = Math.abs(p.z) > 1 ? "behind the camera" : `${p.x < -0.33 ? "left" : p.x > 0.33 ? "right" : "middle"} of the frame`;
      const toward = MathUtils.radToDeg(Math.atan2(cam.position.x - el.x, cam.position.z - el.z));
      const turn = Math.abs(MathUtils.euclideanModulo(el.yaw - toward + 180, 360) - 180);
      const facing = turn < 45 ? "facing the camera" : turn > 135 ? "facing away" : "side-on";
      const what = el.read?.noun ? `${el.kind}, ${el.read.noun}` : el.kind;
      const doing = [el.kind === "person" || el.kind === "animal" ? poseOf(el) : "", el.action?.trim()].filter(Boolean).join(", ");
      return `- ${el.id}: ${el.name} (${what}), ${where}, ${facing}${doing ? `, ${doing}` : ""}`;
    })
    .join("\n");
}

/** How high one sits on a thing, meters: a motorbike's saddle, a horse's back, a chair's seat, else its top. */
function seatOf(el: SceneElement) {
  const words = `${el.name} ${el.read?.noun ?? ""}`.toLowerCase();
  if (/motor|scooter|vespa|moped|dirt ?bike|sport ?bike|harley|ducati|yamaha|kawasaki|suzuki/.test(words)) return 0.82;
  if (/bike|bicycle|cycle|rower/.test(words)) return 0.9;
  if (/horse|pony|ko[nń]/.test(words)) return 1.45;
  if (/chair|bench|stool|sofa|couch|seat|krzes|ławk/.test(words)) return 0.46;
  if (el.kind === "vehicle") return Math.min(el.height, 1) * 0.85;
  return Math.max(0, el.height);
}

/** Where `near` puts someone: on that side of the other one (as it faces), the gap past its edge. */
function besides(other: SceneElement, side: string | undefined, gap: number) {
  const y = MathUtils.degToRad(other.yaw);
  const front = { x: Math.sin(y), z: Math.cos(y) };
  const right = { x: -Math.cos(y), z: Math.sin(y) };
  const half = other.kind === "vehicle" ? 1.1 : other.kind === "person" ? 0.25 : 0.4;
  const d = gap + half;
  const dir = side === "front" ? front : side === "behind" ? { x: -front.x, z: -front.z } : side === "left" ? { x: -right.x, z: -right.z } : right;
  return { x: round(other.x + dir.x * d), z: round(other.z + dir.z * d) };
}

/**
 * Arrange the set from words ("Lena rides the motorbike through traffic, close on her face"): the arranger's plan
 * (api/director/arrange) placed exactly: poses from the shared list, a rider on the saddle facing where the ride goes,
 * someone beside someone on the side asked, facings, then the camera's subject, size, angle and side. One undo step
 * (two when the shot size changes). Then the bar shoots it as it is now.
 */
export async function arrangeFromWords(words: string) {
  const text = words.trim();
  if (!text || useArrange.getState().busy) return false;
  const { scene } = useDirector.getState();
  if (!scene.elements.length) {
    useArrange.setState({ error: "Add someone or something from Cast first." });
    return false;
  }
  useArrange.setState({ busy: true, error: null });
  try {
    const res = await fetch("/api/director/arrange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ words: text, set: described(scene) }) });
    const data = (await res.json().catch(() => ({}))) as { plan?: Plan; error?: string };
    if (!res.ok || !data.plan) throw new Error(data.error ?? "Couldn't arrange the set.");
    apply(data.plan);
    return true;
  } catch (err) {
    useArrange.setState({ error: (err as Error).message });
    return false;
  } finally {
    useArrange.setState({ busy: false });
  }
}

function apply(plan: Plan) {
  const store = useDirector.getState();
  store.checkpoint();
  const byId = (id?: string | null) => (id ? useDirector.getState().scene.elements.find((e) => e.id === id) : undefined);
  const camPos = () => shotCamera(useDirector.getState().scene).position;
  const subjects = plan.subjects ?? [];
  // What's ridden or sat on first (its facing decides the rider's), then everyone else.
  const order = [...subjects].sort((a, b) => Number(Boolean(a.on)) - Number(Boolean(b.on)));
  for (const s of order) {
    const el = byId(s.id);
    if (!el) continue;
    const patch: Partial<SceneElement> = {};
    const pose = s.pose && s.pose in BODIES && (el.kind === "person" || el.kind === "animal") ? (s.pose as Pose) : undefined;
    if (pose) patch.pose = pose;
    if (s.action?.trim()) patch.action = s.action.trim().slice(0, 120);
    const ride = byId(s.on);
    if (ride && ride.id !== el.id) {
      // On the saddle: its hips at the seat, where the ride stands, facing the way it goes.
      const sitting = pose ?? poseOf({ ...el, ...patch });
      patch.x = ride.x;
      patch.z = ride.z;
      patch.lift = round(Math.max(0, seatOf(ride) - hipHeight(sitting) * el.height));
      patch.yaw = ride.yaw;
    } else {
      const other = byId(s.near?.id);
      if (other && other.id !== el.id) {
        Object.assign(patch, besides(other, s.near?.side, MathUtils.clamp(Number(s.near?.gap) || 0.6, 0.2, 6)), { lift: 0 });
      }
    }
    useDirector.getState().updateElement(el.id, patch, true);
  }
  // Then which way each faces, once everyone is where they go (Noor faced where Kai stood before he got on the bike).
  for (const s of order) {
    const el = byId(s.id);
    const facing = s.facing?.trim();
    if (!el || !facing || byId(s.on)) continue;
    const toward = (x: number, z: number) => wrap(MathUtils.radToDeg(Math.atan2(x - el.x, z - el.z)));
    const cam = camPos();
    const face = byId(facing);
    let yaw: number | null = null;
    if (facing === "camera") yaw = toward(cam.x, cam.z);
    else if (facing === "away") yaw = wrap(toward(cam.x, cam.z) + 180);
    else if (facing === "left" || facing === "right") {
      // Across the frame: the camera's own right, or its left.
      const az = MathUtils.degToRad(useDirector.getState().scene.camera.azimuth);
      const r = { x: Math.cos(az), z: -Math.sin(az) };
      yaw = facing === "right" ? toward(el.x + r.x, el.z + r.z) : toward(el.x - r.x, el.z - r.z);
    } else if (face && face.id !== el.id) yaw = toward(face.x, face.z);
    if (yaw === null) continue;
    useDirector.getState().updateElement(el.id, { yaw }, true);
    // A ride turned turns its rider with it.
    for (const r of order) if (r.on === el.id && byId(r.id)) useDirector.getState().updateElement(r.id, { yaw }, true);
  }
  const camera = plan.camera;
  const focus = byId(camera?.focus) ?? byId(subjects.find((s) => byId(s.id)?.kind === "person")?.id);
  if (camera && focus) {
    const sides: Record<string, number> = { front: 0, behind: 180, left: 90, right: -90, "front-left": 45, "front-right": -45 };
    const from = camera.from && camera.from in sides ? sides[camera.from] : null;
    useDirector.getState().setCamera({ focusId: focus.id, free: null, ...(from !== null ? { azimuth: wrap(focus.yaw + from) } : {}) }, true);
    if (camera.angle && ANGLES.some((a) => a.id === camera.angle)) useDirector.getState().applyAngle(camera.angle as (typeof ANGLES)[number]["id"]);
    if (camera.shot && SHOT_SIZES.some((x) => x.id === camera.shot)) useDirector.getState().applyShotSize(camera.shot as (typeof SHOT_SIZES)[number]["id"]);
  }
}
