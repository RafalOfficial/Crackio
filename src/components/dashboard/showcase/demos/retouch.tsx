"use client";

import type { CSSProperties } from "react";
import { MousePointerClick } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, span, type Builder } from "../engine";
import { Photo, wipeLine } from "../gl";
import { Canvas, Caption, Demo, EndSlate, GLASS, Img, Pointer, S, Sticker, Tag, WipeEdge, finale, peel, placeEdge, say, sequence, slap, unsay, type Change } from "../kit";
import META from "./retouch-meta.json";

const A = `${S}/retouch`;
/** Every picture the film shows: the original, each colorway of the bag, and the black sweater on the red bag. */
const FRAMES = ["camel", "red", "emerald", "cobalt", "butter", "lilac", "black", "blush", "red-sweater"] as const;
const F = (id: (typeof FRAMES)[number]) => FRAMES.indexOf(id);
/** The swatch row, in the order the pointer taps it (it ends back on red, the bag the sweater goes with). */
const SWATCHES = [
  { id: "emerald", color: "#17734a" },
  { id: "cobalt", color: "#2449b5" },
  { id: "butter", color: "#efdf86" },
  { id: "lilac", color: "#c6a8e0" },
  { id: "black", color: "#121014" },
  { id: "blush", color: "#e9b6b0" },
  { id: "red", color: "#b3121c" },
] as const;
const BAG = META.bag;
const SWEATER = META.sweater;
const WIPE_ANGLE = 0.24;

/**
 * Retouch: tap the bag and it's outlined; say "make it cherry red" and it pours red from the
 * spot you touched. Seven colorways in seven taps, the sweater too, then before and after.
 * Only what was touched ever changes: every other pixel is the original photo.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-photo]");
  const photo = b.keep("photo", () => new Photo(FRAMES.map((f) => `${A}/f-${f}.webp`), { depth: `${A}/depth.png` }), (x) => x.dispose());
  b.ready(photo.ready);
  const changes: Change[] = [];
  const over = b.$("[data-over]");

  b.set(over, { s: 1 }, 0);
  b.set("[data-line-bag], [data-line-sweater]", { o: 1 }, 0);
  /** When each outline draws itself on. */
  const draws: { el: SVGPathElement; t0: number }[] = [];
  b.set("[data-tag-bag], [data-tag-sweater]", { o: 0, s: 0.8 }, 0);
  b.set("[data-swatches]", { o: 0, y: 16 }, 0);
  b.set("[data-dot]", { "--on": 0, s: 1 }, 0);
  b.set("[data-tag-before], [data-tag-after]", { o: 0 }, 0);

  // The camera leans in toward the bag.
  b.to(over, { s: 1.12 }, 0.2, 2.8, E.inOut);

  // Tap the bag: its outline draws itself around it.
  const tap = { x: BAG.cx - 5, y: BAG.cy + 2 };
  p.show(0.3);
  let t = p.move(tap, 0.3, 0.85);
  b.click(t);
  draws.push({ el: b.$<SVGPathElement>("[data-line-bag]"), t0: t + 0.05 });
  b.to("[data-tag-bag]", { o: [0, 1], s: [0.8, 1] }, t + 0.15, 0.4, E.pop);

  // Say it; it pours in from where you touched.
  t = say(b, "say-red", t + 0.55);
  changes.push({ at: t + 0.12, dur: 0.7, to: F("red"), center: tap, soft: 0.07 });
  unsay(b, "say-red", t + 0.9);
  b.to("[data-line-bag], [data-tag-bag]", { o: 0 }, t + 0.9, 0.35, E.inOut);
  p.move({ x: 50, y: 92 }, t + 0.5, 0.6);

  // The whole range, one tap each.
  const run = t + 1.0;
  b.to("[data-swatches]", { o: [0, 1], y: [16, 0] }, run, 0.42, E.settle);
  const dots = b.$$("[data-dot]");
  let at = run + 0.45;
  SWATCHES.forEach((sw, i) => {
    const reach = p.move(b.point(dots[i], at + 0.4), at, i === 0 ? 0.42 : 0.3, { arc: 0.05 });
    b.click(reach);
    b.to(dots[i], { s: [1, 0.8, 1.12, 1] }, reach, 0.36, E.swift);
    b.set(dots[i], { "--on": 1 }, reach + 0.04);
    if (i > 0) b.set(dots[i - 1], { "--on": 0 }, reach + 0.04);
    changes.push({ at: reach + 0.06, dur: 0.4, to: F(sw.id), center: { x: BAG.cx, y: BAG.cy }, soft: 0.05 });
    at = reach + 0.2;
  });
  slap(b, "claim", run + 1.3);
  peel(b, "claim", at + 0.15);
  b.to("[data-swatches]", { o: 0, y: 12 }, at + 0.25, 0.35, E.leave);

  // The sweater, the same way.
  const swTap = { x: SWEATER.cx - 4, y: SWEATER.cy + 6 };
  t = p.move(swTap, at + 0.3, 0.6);
  b.click(t);
  draws.push({ el: b.$<SVGPathElement>("[data-line-sweater]"), t0: t + 0.05 });
  b.to("[data-tag-sweater]", { o: [0, 1], s: [0.8, 1] }, t + 0.15, 0.4, E.pop);
  t = say(b, "say-black", t + 0.5);
  changes.push({ at: t + 0.12, dur: 0.8, to: F("red-sweater"), center: swTap, soft: 0.07 });
  unsay(b, "say-black", t + 0.95);
  b.to("[data-line-sweater], [data-tag-sweater]", { o: 0 }, t + 0.95, 0.35, E.inOut);
  p.hide(t + 0.6, 0.3);

  // Before and after: the camera settles back and a wipe splits the frame.
  const w0 = t + 1.15;
  b.to(over, { s: 1 }, w0 - 0.2, 0.7, E.inOut);
  const w1 = w0 + 0.65;
  const w2 = w1 + 0.7;
  const w3 = w2 + 0.55;
  const split = (tt: number) => (tt < w0 || tt > w3 ? -1 : tt < w1 ? 0.5 * span(tt, w0, w1, E.inOut) : tt < w2 ? 0.5 : 0.5 * (1 - span(tt, w2, w3, E.inOut)));
  b.to("[data-tag-before], [data-tag-after]", { o: [0, 1] }, w0 + 0.2, 0.3, E.inOut);
  b.to("[data-tag-before], [data-tag-after]", { o: 0 }, w2 + 0.1, 0.3, E.inOut);

  const look = sequence(F("camel"), changes);
  const edge = b.$("[data-edge]");
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    for (const d of draws) d.el.style.strokeDashoffset = (1 - span(tt, d.t0, d.t0 + 0.6, E.inOut)).toFixed(4);
    const z = b.valueAt(over, "s", tt);
    const drift = { px: 0.01 * Math.sin(tt * 0.55), py: 0.006 * Math.sin(tt * 0.42 + 1), focus: BAG.depth, zoom: z, zx: BAG.cx, zy: BAG.cy };
    const k = split(tt);
    const aspect = b.W / b.H;
    if (k >= 0) {
      photo.draw(canvas, { from: F("red-sweater"), to: F("camel"), k, mode: 2, angle: WIPE_ANGLE, soft: 0.006, ...drift });
      placeEdge(edge, wipeLine(k, WIPE_ANGLE, aspect, 0.006), b.W, b.H, k > 0.001);
    } else {
      photo.draw(canvas, { ...look(tt), ...drift });
      placeEdge(edge, { x: -50, y: 50, rotate: 0 }, b.W, b.H, false);
    }
  });
  finale(b, w3 + 0.25, 1.5);
}

const LINE: CSSProperties = { strokeDasharray: "1 1", strokeDashoffset: 1, filter: "drop-shadow(0 0 1.5px rgb(150 170 255)) drop-shadow(0 0 4px rgb(120 140 255 / 0.9))" };

export function RetouchDemo() {
  return (
    <Demo name="retouch" hue="var(--color-tool-retouch)" script={script}>
      {/* The photo itself, under the living one, so the card is never empty while it loads. */}
      <Img src={`${A}/f-camel.webp`} />
      <Canvas hook="photo" />
      {/* Everything drawn over the photo follows its zoom (about the bag). */}
      <div data-over className="pointer-events-none absolute inset-0" style={{ transformOrigin: `${BAG.cx}% ${BAG.cy}%` }}>
        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 125" preserveAspectRatio="none" aria-hidden="true">
          <path data-line-bag d={BAG.path} pathLength={1} fill="none" stroke="#fff" strokeWidth={0.55} strokeLinejoin="round" style={LINE} />
          <path data-line-sweater d={SWEATER.path} pathLength={1} fill="none" stroke="#fff" strokeWidth={0.55} strokeLinejoin="round" style={LINE} />
        </svg>
        <SelTag hook="tag-bag" x={BAG.x0 + 2} y={BAG.y0 - 1.5} label="Handbag" />
        <SelTag hook="tag-sweater" x={Math.max(4, SWEATER.cx - 16)} y={SWEATER.y0 + 6} label="Sweater" />
      </div>

      <Caption hook="say-red" words={["make", "it", "cherry", "red"]} className="top-[9%]" />
      <Caption hook="say-black" words={["now", "black", "cashmere"]} className="top-[9%]" />
      <Sticker hook="claim" lines={["7 colorways.", "One photo."]} size={20} className="right-[5%] top-[4%]" />

      <div data-swatches className={cn(GLASS, "absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit items-center gap-[7px] rounded-full py-[7px] pl-3 pr-[9px] opacity-0")}>
        <span className="ad-label mr-0.5 text-[8.5px] text-white/55">Color</span>
        {SWATCHES.map((s) => (
          <span key={s.id} data-dot className="block size-[15px] rounded-full" style={{ background: s.color, boxShadow: "0 0 0 1px rgb(255 255 255 / 0.25), 0 0 0 calc(var(--on, 0) * 2.5px) rgb(15 13 19), 0 0 0 calc(var(--on, 0) * 4px) #fff" }} />
        ))}
      </div>

      <WipeEdge />
      <Tag hook="tag-before" className="bottom-3 left-3">
        Before
      </Tag>
      <Tag hook="tag-after" tone="hue" className="bottom-3 right-3">
        After
      </Tag>

      <EndSlate title="Retouch" />
      <Pointer />
    </Demo>
  );
}

function SelTag({ hook, x, y, label }: { hook: string; x: number; y: number; label: string }) {
  return (
    <span {...{ [`data-${hook}`]: "" }} className="absolute inline-flex -translate-y-full items-center gap-1 rounded-full bg-[rgb(98_118_255)] px-1.5 py-[3px] text-[9px] font-bold text-white opacity-0 shadow-[0_4px_12px_-4px_rgb(60_80_255/0.9)]" style={{ left: `${x}%`, top: `${y}%` }}>
      <MousePointerClick size={9} strokeWidth={2.6} />
      {label}
    </span>
  );
}
