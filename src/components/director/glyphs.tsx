/** Small diagrams that explain a camera choice by showing it. */

const STROKE = "currentColor";

/** A person silhouette cropped the way a shot size frames them. `share` = visible part of the body from the top. */
export function ShotSizeGlyph({ share }: { share: number }) {
  // Silhouette is 100 units tall; frame shows `share` of it (more than 1 = extra room around).
  const visible = Math.max(0.08, share);
  const frameH = visible <= 1 ? visible * 100 : visible * 100;
  const frameW = frameH * 1.5;
  const cx = 50;
  const top = visible <= 1 ? -2 : -(frameH - 100) / 2 - 4;
  return (
    <svg viewBox={`${cx - frameW / 2} ${top} ${frameW} ${frameH}`} className="size-full" aria-hidden="true">
      <g fill={STROKE} opacity={0.9}>
        <circle cx={50} cy={9} r={7} />
        <path d="M50 17c-9 0-15 4-16 12l-3 26h6l2-20h2l-1 26-2 37h8l3-30h2l3 30h8l-2-37-1-26h2l2 20h6l-3-26c-1-8-7-12-16-12z" />
      </g>
    </svg>
  );
}

/** Side view: subject on the right, camera on an arc at the given elevation. */
export function AngleGlyph({ elevation }: { elevation: number }) {
  const r = 34;
  const a = (elevation * Math.PI) / 180;
  const sx = 70;
  const sy = 40;
  const cx = sx - r * Math.cos(a);
  const cy = sy - r * Math.sin(a);
  return (
    <svg viewBox="0 0 100 64" className="size-full" aria-hidden="true">
      <line x1={4} y1={58} x2={96} y2={58} stroke={STROKE} strokeOpacity={0.25} strokeWidth={1.5} />
      <path d={`M ${sx - r} ${sy} A ${r} ${r} 0 0 1 ${sx} ${sy - r}`} fill="none" stroke={STROKE} strokeOpacity={0.15} strokeDasharray="2 3" />
      <path d={`M ${sx - r} ${sy} A ${r} ${r} 0 0 0 ${sx} ${sy + r}`} fill="none" stroke={STROKE} strokeOpacity={0.15} strokeDasharray="2 3" />
      <g fill={STROKE}>
        <circle cx={sx} cy={26} r={5} />
        <rect x={sx - 5} y={32} width={10} height={26} rx={4} />
      </g>
      <line x1={cx} y1={cy} x2={sx} y2={sy - 6} stroke="#ff5b2e" strokeWidth={1.6} strokeDasharray="3 2.5" />
      <g transform={`translate(${cx} ${cy}) rotate(${-elevation})`}>
        <rect x={-9} y={-6} width={13} height={12} rx={2.5} fill="#ff5b2e" />
        <path d="M4 -4 L10 -7 L10 7 L4 4 Z" fill="#ff5b2e" />
      </g>
    </svg>
  );
}

/** Field-of-view wedge for a lens (horizontal FOV in degrees). */
export function LensGlyph({ fov }: { fov: number }) {
  const half = ((Math.min(fov, 150) / 2) * Math.PI) / 180;
  const len = 52;
  const ox = 10;
  const oy = 32;
  const x2 = ox + len * Math.cos(half);
  const y1 = oy - len * Math.sin(half);
  const y2 = oy + len * Math.sin(half);
  return (
    <svg viewBox="0 0 100 64" className="size-full" aria-hidden="true">
      <path d={`M ${ox} ${oy} L ${x2} ${y1} A ${len} ${len} 0 0 1 ${x2} ${y2} Z`} fill="#ff5b2e" fillOpacity={0.18} stroke="#ff5b2e" strokeWidth={1.4} />
      <rect x={ox - 8} y={oy - 6} width={10} height={12} rx={2} fill={STROKE} />
    </svg>
  );
}

/** Aperture blades: a wider opening for smaller f-numbers. */
export function ApertureGlyph({ f }: { f: number }) {
  const open = Math.max(0.18, Math.min(0.92, 1.6 / Math.sqrt(f)));
  const r = 26;
  const inner = r * open;
  const blades = 7;
  const pts = Array.from({ length: blades }, (_, i) => {
    const t = (i / blades) * Math.PI * 2 - Math.PI / 2;
    return `${50 + inner * Math.cos(t)},${32 + inner * Math.sin(t)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 100 64" className="size-full" aria-hidden="true">
      <circle cx={50} cy={32} r={r} fill={STROKE} fillOpacity={0.85} />
      <polygon points={pts} fill="#101114" />
      <circle cx={50} cy={32} r={inner * 0.55} fill="#ff5b2e" fillOpacity={0.25} />
    </svg>
  );
}
