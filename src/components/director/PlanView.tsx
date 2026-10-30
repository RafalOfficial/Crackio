"use client";

import { useMemo, useRef, useState } from "react";
import { MathUtils } from "three";
import { useDirector } from "@/lib/director/store";
import { cameraPosition, focusPoint, horizontalFov } from "@/lib/director/camera";
import { kelvinToRgb } from "@/lib/director/vocab";
import { aspectById } from "@/lib/shot";
import { cn } from "@/lib/cn";

type DragTarget = { kind: "element"; id: string } | { kind: "camera" } | { kind: "light" };

/**
 * The set seen from above: drag people and props around, swing the camera, move the light.
 * World x maps to SVG x, world z maps to SVG y (toward the bottom = toward the default camera).
 */
export function PlanView({ className }: { className?: string }) {
  const scene = useDirector((s) => s.scene);
  const selectedId = useDirector((s) => s.selectedId);
  const { select, updateElement, setCamera, setLight, checkpoint } = useDirector.getState();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const moved = useRef(false);

  const target = focusPoint(scene);
  const cam = cameraPosition(scene.camera, target);
  const a = aspectById(scene.aspect);
  const hfov = horizontalFov(scene.camera.focal, a.w / a.h);

  // Fit the view around everything, never tighter than 7 m across.
  const extent = useMemo(() => {
    const xs = [target.x, cam.x, ...scene.elements.map((e) => e.x)];
    const zs = [target.z, cam.z, ...scene.elements.map((e) => e.z)];
    const half = Math.max(3.5, ...xs.map((x) => Math.abs(x - target.x)), ...zs.map((z) => Math.abs(z - target.z))) * 1.28;
    return half;
  }, [scene.elements, cam.x, cam.z, target.x, target.z]);

  const vb = { x: target.x - extent, y: target.z - extent, w: extent * 2, h: extent * 2 };
  const px = extent / 160; // ~1 screen px in world units for a 320px panel

  const toWorld = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, z: p.y };
  };

  const start = (t: DragTarget) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    moved.current = false;
    if (t.kind === "element") select(t.id);
    setDrag(t);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const w = toWorld(e);
    if (!moved.current) {
      checkpoint();
      moved.current = true;
    }
    if (drag.kind === "element") {
      updateElement(drag.id, { x: round(w.x), z: round(w.z) }, true);
    } else if (drag.kind === "camera") {
      const dx = w.x - target.x;
      const dz = w.z - target.z;
      const horizontal = Math.max(0.3, Math.hypot(dx, dz));
      const el = MathUtils.degToRad(scene.camera.elevation);
      setCamera(
        {
          azimuth: MathUtils.radToDeg(Math.atan2(dx, dz)),
          distance: Math.min(120, horizontal / Math.max(0.08, Math.cos(el))),
        },
        true,
      );
    } else {
      setLight({ azimuth: MathUtils.radToDeg(Math.atan2(w.x - target.x, w.z - target.z)), mood: scene.light.mood }, true);
    }
  };

  const end = () => setDrag(null);

  // Camera wedge
  const camAngle = Math.atan2(target.x - cam.x, target.z - cam.z);
  const wedgeLen = Math.max(scene.camera.distance * 1.35, extent * 0.9);
  const half = MathUtils.degToRad(hfov / 2);
  const w1 = { x: cam.x + Math.sin(camAngle - half) * wedgeLen, z: cam.z + Math.cos(camAngle - half) * wedgeLen };
  const w2 = { x: cam.x + Math.sin(camAngle + half) * wedgeLen, z: cam.z + Math.cos(camAngle + half) * wedgeLen };

  // Light marker sits on a ring around the focus point.
  const lightR = extent * 0.82;
  const laz = MathUtils.degToRad(scene.light.azimuth);
  const lp = { x: target.x + Math.sin(laz) * lightR, z: target.z + Math.cos(laz) * lightR };
  const [lr, lg, lb] = kelvinToRgb(scene.light.kelvin);
  const lightColor = `rgb(${lr} ${lg} ${lb})`;

  return (
    <svg
      ref={svgRef}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      className={cn("touch-none select-none", className)}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerDown={() => select(null)}
      role="application"
      aria-label="Set plan, seen from above"
    >
      <defs>
        <pattern id="plan-grid" width="1" height="1" patternUnits="userSpaceOnUse" x="0" y="0">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={px} />
        </pattern>
        <radialGradient id="plan-light">
          <stop offset="0%" stopColor={lightColor} stopOpacity="0.9" />
          <stop offset="100%" stopColor={lightColor} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill="url(#plan-grid)" />

      {/* Light: ray toward the set */}
      <line x1={lp.x} y1={lp.z} x2={target.x} y2={target.z} stroke={lightColor} strokeOpacity={0.35} strokeWidth={px * 1.5} strokeDasharray={`${px * 6} ${px * 5}`} />

      {/* Camera field of view */}
      <path d={`M ${cam.x} ${cam.z} L ${w1.x} ${w1.z} L ${w2.x} ${w2.z} Z`} fill="rgb(255 91 46 / 0.08)" />
      <line x1={cam.x} y1={cam.z} x2={w1.x} y2={w1.z} stroke="rgb(255 91 46 / 0.55)" strokeWidth={px * 1.2} />
      <line x1={cam.x} y1={cam.z} x2={w2.x} y2={w2.z} stroke="rgb(255 91 46 / 0.55)" strokeWidth={px * 1.2} />

      {/* Elements */}
      {scene.elements.map((el) => {
        // Real footprint, but never smaller than an easy-to-grab dot.
        const base = el.kind === "product" ? 0.17 : el.kind === "animal" ? 0.28 : el.kind === "vehicle" ? 0.5 : 0.26;
        const r = Math.max(base, extent * 0.075);
        const sel = el.id === selectedId;
        const yaw = MathUtils.degToRad(el.yaw);
        const tip = { x: el.x + Math.sin(yaw) * (r + 0.2), z: el.z + Math.cos(yaw) * (r + 0.2) };
        const clip = `clip-${el.id}`;
        return (
          <g key={el.id} onPointerDown={start({ kind: "element", id: el.id })} className="cursor-grab active:cursor-grabbing">
            <defs>
              <clipPath id={clip}>
                <circle cx={el.x} cy={el.z} r={r} />
              </clipPath>
            </defs>
            <line x1={el.x} y1={el.z} x2={tip.x} y2={tip.z} stroke={sel ? "#ff5b2e" : "rgb(243 242 238 / 0.7)"} strokeWidth={px * 2} strokeLinecap="round" />
            <circle cx={tip.x} cy={tip.z} r={px * 3.2} fill={sel ? "#ff5b2e" : "#f3f2ee"} />
            <circle cx={el.x} cy={el.z} r={r + px * 2.5} fill={sel ? "#ff5b2e" : "#2f3239"} />
            {el.image ? (
              <image
                href={el.image.url}
                x={el.x - r}
                y={el.z - r * 1.15}
                width={r * 2}
                height={r * 2.6}
                preserveAspectRatio="xMidYMin slice"
                clipPath={`url(#${clip})`}
              />
            ) : (
              <circle cx={el.x} cy={el.z} r={r} fill="#8b8f99" />
            )}
            <text
              x={el.x}
              y={el.z + r + px * 14}
              textAnchor="middle"
              fontSize={px * 11}
              fontWeight={600}
              fill={sel ? "#ff5b2e" : "#a3a5ac"}
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {el.name}
            </text>
          </g>
        );
      })}

      {/* Light handle */}
      <g onPointerDown={start({ kind: "light" })} className="cursor-grab active:cursor-grabbing">
        <circle cx={lp.x} cy={lp.z} r={px * 22} fill="url(#plan-light)" />
        <circle cx={lp.x} cy={lp.z} r={px * 8} fill={lightColor} stroke="#101114" strokeWidth={px * 2} />
        <title>Key light — drag to move it around the set</title>
      </g>

      {/* Camera handle */}
      <g
        onPointerDown={start({ kind: "camera" })}
        transform={`translate(${cam.x} ${cam.z}) rotate(${-MathUtils.radToDeg(camAngle)})`}
        className="cursor-grab active:cursor-grabbing"
      >
        <rect x={-px * 12} y={-px * 20} width={px * 24} height={px * 22} rx={px * 4} fill="#f3f2ee" stroke="#101114" strokeWidth={px * 2} />
        <path d={`M ${-px * 7} ${px * 2} L ${px * 7} ${px * 2} L ${px * 11} ${px * 12} L ${-px * 11} ${px * 12} Z`} fill="#ff5b2e" stroke="#101114" strokeWidth={px * 1.5} />
        <circle cx={0} cy={-px * 9} r={px * 4} fill="#101114" />
        <title>Camera — drag to move it around the subject</title>
      </g>
    </svg>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
