"use client";

import { Camera } from "lucide-react";
import { E, lerp, span, type Builder, type Pt } from "../engine";
import { Clip, Demo, EndSlate, Img, Pointer, S, Sticker, finale, peel, slap } from "../kit";

const A = `${S}/angles`;
/** One continuous move, filmed once: front → side → rear (0–11.2 s), then up to straight down (11.2–16.8 s). */
const ORBIT_END = 11.2;
const CRANE_END = 16.8;
/** The ground ring around the car (viewBox 100 × 125). */
const RING = { cx: 50, cy: 88, rx: 41, ry: 8.5 };
const ringPt = (deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return { x: RING.cx + RING.rx * Math.cos(a), y: ((RING.cy + RING.ry * Math.sin(a)) / 125) * 100 };
};
/** The dot goes from the near side, round the right, to the far side of the ring. */
const FROM = 110;
const TO = -90;
const TOP = { x: 50, y: 13 };

/**
 * Angles: grab the camera and drag it around the car (front, side, all the way to the back),
 * then up into the sky until it looks straight down. Let go, and it whips all the way back round
 * to where it started. One photo, every angle, live.
 */
function script(b: Builder) {
  const p = b.pointer;
  const o0 = 0.95;
  const o1 = o0 + 3.0;
  const c0 = o1 + 0.2;
  const c1 = c0 + 1.65;
  const orbit = (t: number) => span(t, o0, o1, E.inOut);
  const crane = (t: number) => span(t, c0, c1, E.inOut);
  // Let go, and the camera whips back down and round to the front.
  const w0 = c1 + 0.45;
  const w1 = w0 + 1.15;
  const whip = (t: number) => span(t, w0, w1, E.inOut);
  const dotAt = (t: number): Pt => {
    let ko = orbit(t);
    let kc = t < c0 ? 0 : crane(t);
    if (t >= w0) {
      // The whip runs the same move backwards: down the arc, then round the ring.
      const tour = CRANE_END * (1 - whip(t));
      kc = tour > ORBIT_END ? (tour - ORBIT_END) / (CRANE_END - ORBIT_END) : 0;
      ko = Math.min(1, tour / ORBIT_END);
    }
    if (kc <= 0) return ringPt(lerp(FROM, TO, ko));
    const far = ringPt(TO);
    // Up and over: a gentle arc toward the top of the frame.
    return { x: lerp(far.x, TOP.x, kc) + Math.sin(kc * Math.PI) * 6, y: lerp(far.y, TOP.y, kc) };
  };

  b.set("[data-first]", { o: 1 }, 0);
  b.set("[data-gizmo]", { o: 0, s: 0.96 }, 0);
  b.set("[data-up]", { o: 0 }, 0);
  b.set("[data-ring]", { o: 1 }, 0);
  b.set("[data-cam]", { s: 1, o: 1, blur: 0 }, 0);
  b.to("[data-gizmo]", { o: [0, 1], s: [0.96, 1] }, 0.2, 0.45, E.settle);

  // The clip is the live view: it follows the drag frame by frame.
  b.set("[data-first]", { o: 0 }, o0 + 0.05);
  b.scrub("[data-tour]", (t) => {
    if (t >= b.seam || t < o0) return 0;
    if (t < c0) return orbit(t) * ORBIT_END;
    if (t < w0) return ORBIT_END + crane(t) * (CRANE_END - ORBIT_END);
    return CRANE_END * (1 - whip(t));
  });
  b.to("[data-cam]", { blur: [0, 1.6, 0], s: [1, 1.04, 1] }, w0, w1 - w0, E.inOut);

  p.show(0.35);
  p.move(dotAt(0), 0.35, o0 - 0.4);
  p.hold(o0 - 0.02, c1);
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) pts.push(dotAt(lerp(o0, o1, i / 24)));
  p.path(pts, o0, o1 - o0, (x) => x);
  const up: Pt[] = [];
  for (let i = 0; i <= 12; i++) up.push(dotAt(lerp(c0, c1, i / 12)));
  b.to("[data-up]", { o: [0, 1] }, c0 - 0.1, 0.25, E.inOut);
  // The ground ring means less from overhead: it fades as the camera climbs.
  b.to("[data-ring]", { o: 0.15 }, c0 + 0.2, 0.9, E.inOut);
  p.path(up, c0, c1 - c0, (x) => x);
  p.hide(c1 + 0.25, 0.3);
  b.to("[data-up]", { o: 0 }, c1 + 0.15, 0.35, E.inOut);
  b.to("[data-gizmo]", { o: 0 }, w1 - 0.2, 0.3, E.inOut);
  b.to("[data-ring]", { o: 1 }, w0, 0.3, E.inOut);

  const dot = b.$("[data-dot]");
  const readout = b.$("[data-readout]");
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    const d = dotAt(tt);
    dot.style.left = `${d.x}%`;
    dot.style.top = `${d.y}%`;
    const text = tt < c0 ? `Orbit ${Math.round(orbit(tt) * 180)}°` : tt < w0 ? `Orbit 180° · Height ${Math.round(crane(tt) * 90)}°` : "Back to the front";
    if (readout.textContent !== text) readout.textContent = text;
  });

  slap(b, "claim", w1 - 0.1);
  peel(b, "claim", w1 + 1.1);
  finale(b, w1 + 1.2, 1.45);
}

export function AnglesDemo() {
  return (
    <Demo name="angles" hue="var(--color-tool-angles)" script={script}>
      <div data-cam className="absolute inset-0">
        <Clip src={`${A}/tour.mp4`} hook="tour" />
        <Img src={`${A}/first.webp`} hook="first" />
      </div>

      <div data-gizmo className="pointer-events-none absolute inset-0 z-10 opacity-0">
        <svg data-ring className="absolute inset-0 size-full" viewBox="0 0 100 125" preserveAspectRatio="none" aria-hidden="true">
          {/* The far half of the ring sits behind the car: fainter. */}
          <path d={`M ${RING.cx - RING.rx} ${RING.cy} A ${RING.rx} ${RING.ry} 0 0 1 ${RING.cx + RING.rx} ${RING.cy}`} fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="0.5" strokeDasharray="1.2 1.4" />
          <path d={`M ${RING.cx - RING.rx} ${RING.cy} A ${RING.rx} ${RING.ry} 0 0 0 ${RING.cx + RING.rx} ${RING.cy}`} fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="0.6" />
        </svg>
        <span data-dot className="pointer-events-none absolute grid size-[24px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-[#16131b] shadow-[0_0_0_3px_rgb(92_200_242/0.5),0_4px_12px_rgb(0_0_0/0.45)]" style={{ left: "50%", top: "76%" }}>
          <Camera size={12} strokeWidth={2.4} />
        </span>
        <span className="ad-label absolute left-3 top-3 rounded-[4px] bg-[#16131b] px-1.5 py-[3px] text-[9px] leading-none text-[#f6f3ee]">
          <span data-readout>Orbit 0°</span>
        </span>
      </div>
      {/* The way up: a dashed arc from the far side of the ring to overhead. */}
      <svg data-up className="pointer-events-none absolute inset-0 z-10 size-full opacity-0" viewBox="0 0 100 125" preserveAspectRatio="none" aria-hidden="true">
        <path d={`M 50 ${RING.cy - RING.ry} Q 62 60, 50 ${(TOP.y / 100) * 125}`} fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="0.55" strokeDasharray="1.4 1.2" />
      </svg>
      <Sticker hook="claim" lines={["Every angle.", "One photo."]} size={30} className="left-[10%] top-[36%]" />

      <EndSlate title="Angles" />
      <Pointer />
    </Demo>
  );
}
