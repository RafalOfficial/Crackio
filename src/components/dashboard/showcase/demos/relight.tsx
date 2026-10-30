"use client";

import { cn } from "@/lib/cn";
import { E, lerp, span, type Builder, type Pt } from "../engine";
import { Photo } from "../gl";
import { Canvas, Demo, EndSlate, GLASS, Img, Pointer, RollSticker, S, Sticker, finale, peel, roll, rollAt, sequence, slap, type Change } from "../kit";

const A = `${S}/relight`;
const FRAMES = ["base", "left", "right", "golden", "neon", "noir", "candle", "sunset", "studio"] as const;
const F = (id: (typeof FRAMES)[number]) => FRAMES.indexOf(id);
/** The looks, one tap each, and the gel each is shown as. */
const LOOKS = [
  { id: "golden", name: "Golden hour", gel: "linear-gradient(135deg, #ffd27f, #e9832b)" },
  { id: "neon", name: "Neon", gel: "linear-gradient(135deg, #ff3fb4 50%, #35d3ff 50%)" },
  { id: "noir", name: "Noir", gel: "repeating-linear-gradient(0deg, #eee 0 2.5px, #111 2.5px 5px)" },
  { id: "candle", name: "Candlelight", gel: "radial-gradient(circle at 50% 70%, #ffd27a, #b8500e)" },
  { id: "sunset", name: "Sunset", gel: "linear-gradient(180deg, #ffb35c, #ff5e62)" },
  { id: "studio", name: "Studio", gel: "radial-gradient(circle, #fff 30%, #cdd5df)" },
] as const;
/** Her face, where the camera leans in while the light is dragged. */
const FACE = { x: 54, y: 30 };

/**
 * Relight: drag the light across a sphere and it rakes across her face, live. Then six looks,
 * one tap each (golden hour, neon, noir, candlelight, sunset, studio), and to finish, the light
 * circles all the way round her on its own. Her face never changes; only the light does.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-photo]");
  const photo = b.keep("photo", () => new Photo(FRAMES.map((f) => `${A}/${f}.webp`), { depth: `${A}/depth.png` }), (x) => x.dispose());
  b.ready(photo.ready);
  const sphere = b.box("[data-sphere]");
  const onSphere = (lx: number, ly: number): Pt => ({ x: ((sphere.x + (sphere.w * lx) / 100) / b.W) * 100, y: ((sphere.y + (sphere.h * ly) / 100) / b.H) * 100 });

  b.set(canvas, { s: 1, o: 1 }, 0);
  b.set("[data-panel]", { o: 0, y: 14 }, 0);
  b.set("[data-gel]", { "--on": 0, s: 1 }, 0);
  b.set("[data-zoom]", { s: 1 }, 0);
  rollAt(b, "look", 0);

  // Drag the light: across to her left, then all the way round to her right.
  b.to("[data-panel]", { o: 1, y: 0 }, 0.2, 0.5, E.settle);
  const g0 = 1.0;
  const g1 = g0 + 1.15;
  const g2 = g1 + 0.25;
  const g3 = g2 + 1.45;
  const lightAt = (t: number) => {
    if (t < g1) {
      const k = span(t, g0, g1, E.inOut);
      return { x: lerp(50, 15, k), y: lerp(40, 37, k) - Math.sin(k * Math.PI) * 6 };
    }
    const k = span(t, g2, g3, E.inOut);
    return { x: lerp(15, 85, k), y: lerp(37, 39, k) - Math.sin(k * Math.PI) * 10 };
  };
  p.show(0.4);
  p.move(onSphere(50, 40), 0.4, g0 - 0.45);
  p.hold(g0 - 0.02, g3);
  const pts1: Pt[] = [];
  for (let i = 0; i <= 10; i++) pts1.push(onSphere(lightAt(lerp(g0, g1, i / 10)).x, lightAt(lerp(g0, g1, i / 10)).y));
  p.path(pts1, g0, g1 - g0, (x) => x);
  const pts2: Pt[] = [];
  for (let i = 0; i <= 14; i++) pts2.push(onSphere(lightAt(lerp(g2, g3, i / 14)).x, lightAt(lerp(g2, g3, i / 14)).y));
  p.path(pts2, g2, g3 - g2, (x) => x);
  // The camera leans into her face while the light moves, and back out for the looks.
  b.to("[data-zoom]", { s: 1.3 }, g0 - 0.1, 1.6, E.inOut);
  b.to("[data-zoom]", { s: 1.05 }, g3 - 0.2, 0.9, E.inOut);

  // Six looks, one tap each: the new light sweeps across from the side it comes from.
  const gels = b.$$("[data-gel]");
  const changes: Change[] = [];
  let at = g3 + 0.35;
  LOOKS.forEach((l, i) => {
    const reach = p.move(b.point(gels[i], at + 0.3), at, i === 0 ? 0.5 : 0.3, { arc: 0.05 });
    b.click(reach);
    b.to(gels[i], { s: [1, 0.8, 1.15, 1] }, reach, 0.36, E.swift);
    b.set(gels[i], { "--on": 1 }, reach + 0.04);
    if (i > 0) b.set(gels[i - 1], { "--on": 0 }, reach + 0.04);
    changes.push({ at: reach + 0.05, dur: 0.5, to: F(l.id), mode: 2, angle: i % 2 ? Math.PI - 0.35 : 0.35, soft: 0.22 });
    if (i === 0) b.to("[data-look]", { o: [0, 1] }, reach + 0.05, 0.25, E.inOut);
    roll(b, "look", i, reach + 0.05, 0.28);
    at = reach + 0.3;
  });
  const done = at + 0.25;
  p.hide(done - 0.2, 0.3);
  b.to("[data-look]", { o: 0 }, done, 0.3, E.inOut);

  // To finish, the light goes all the way round her by itself, and the camera leans in to watch.
  const r0 = done + 0.15;
  const r1 = r0 + 2.1;
  const orbitAt = (t: number) => Math.PI + 2 * Math.PI * span(t, r0 + 0.25, r1, E.inOut);
  b.to("[data-zoom]", { s: 1.24 }, r0, r1 - r0, E.inOut);
  b.text("[data-readout]", [
    [0, "Front · soft"],
    [g0 + 0.5, "Left · 70°"],
    [g2 + 0.75, "Front · soft"],
    [g2 + 1.05, "Right · 70°"],
    [g3 + 0.4, "Gels"],
    [r0, "All the way round"],
  ]);
  b.to("[data-panel]", { o: 0, y: 12 }, r1 + 0.05, 0.35, E.leave);
  b.to("[data-zoom]", { s: 1.05 }, r1, 0.8, E.inOut);
  slap(b, "claim", r1 + 0.15);
  peel(b, "claim", r1 + 1.3);
  const pb = r1 + 0.05;

  const look = sequence(F("base"), changes);
  const sphereEl = b.$("[data-sphere]");
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    const z = b.valueAt("[data-zoom]", "s", tt);
    const drift = { px: 0.012 * Math.sin(tt * 0.6), py: 0.008 * Math.sin(tt * 0.45 + 0.7), focus: 0.62, zoom: z, zx: FACE.x, zy: FACE.y };
    let l = lightAt(tt);
    if (tt >= r0) {
      const a = orbitAt(tt);
      l = { x: 50 + 35 * Math.cos(a), y: 40 - 9 * Math.sin(a) };
    }
    sphereEl.style.setProperty("--lx", l.x.toFixed(2));
    sphereEl.style.setProperty("--ly", l.y.toFixed(2));
    if (tt >= r0) {
      // Out of the last look into the bare light, then round: her left, the front, her right, behind…
      const u = (l.x - 50) / 35;
      const lit = { from: F("base"), to: u < 0 ? F("left") : F("right"), k: Math.min(1, Math.abs(u)) ** 0.85, mode: 0 as const };
      const k0 = span(tt, r0, r0 + 0.3, E.inOut);
      if (k0 < 1) photo.draw(canvas, { from: F("studio"), to: F("left"), k: k0, mode: 0, ...drift });
      else photo.draw(canvas, { ...lit, ...drift });
    } else if (tt < g3 + 0.3) {
      // The light follows the hand: her left side, then her right.
      const u = (l.x - 50) / 35;
      photo.draw(canvas, { from: F("base"), to: u < 0 ? F("left") : F("right"), k: Math.min(1, Math.abs(u)) ** 0.85, mode: 0, ...drift });
    } else {
      const v = look(tt);
      photo.draw(canvas, { ...v, from: v.from === F("base") ? F("right") : v.from, to: v.to === F("base") ? F("right") : v.to, ...drift });
    }
  });
  finale(b, pb + 1.35, 1.45);
}

export function RelightDemo() {
  return (
    <Demo name="relight" hue="var(--color-tool-relight)" script={script}>
      <span data-zoom className="hidden" />
      {/* The photo itself, under the living one, so the card is never empty while it loads. */}
      <Img src={`${A}/base.webp`} />
      <Canvas hook="photo" />
      <RollSticker hook="look" words={LOOKS.map((l) => l.name)} size={19} className="left-3 top-[14px]" />
      <Sticker hook="claim" lines={["Same moment.", "New light."]} size={27} className="left-[9%] top-[36%]" />

      <div data-panel className={cn(GLASS, "absolute inset-x-2 bottom-2 z-20 flex items-center gap-2 rounded-[14px] p-1.5 opacity-0")}>
        {/* The light sphere: its highlight sits where the light is. */}
        <div
          data-sphere
          className="relative size-[46px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
          style={{ background: "radial-gradient(circle at calc(var(--lx, 50) * 1%) calc(var(--ly, 40) * 1%), #fff4e4 0%, #d9cbbb 14%, #7d7468 38%, #322d36 68%, #19161d 100%)" }}
        >
          <span className="absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-white bg-[#ffd9a0] shadow-[0_0_10px_3px_rgb(255_200_120/0.85)]" style={{ left: "calc(var(--lx, 50) * 1%)", top: "calc(var(--ly, 40) * 1%)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="ad-label text-[8.5px] text-white/50">Key light</p>
          <p data-readout className="h-[14px] truncate text-[10.5px] font-semibold leading-[14px] text-white">
            Front · soft
          </p>
          <div className="mt-1 flex gap-[5px]">
            {LOOKS.map((l) => (
              <span key={l.id} data-gel className="block size-[16px] shrink-0 rounded-full" style={{ background: l.gel, boxShadow: "0 0 0 1px rgb(255 255 255 / 0.22), 0 0 0 calc(var(--on, 0) * 2.5px) rgb(15 13 19), 0 0 0 calc(var(--on, 0) * 4px) #fff" }} />
            ))}
          </div>
        </div>
      </div>

      <EndSlate title="Relight" />
      <Pointer />
    </Demo>
  );
}
