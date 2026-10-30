"use client";

import { Moon, Shirt, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, lerp, span, type Builder } from "../engine";
import { CHIP, Clip, Demo, EndSlate, GLASS, Pointer, RollSticker, S, Sticker, Tag, WipeEdge, finale, onChip, peel, placeEdge, roll, rollAt, slap } from "../kit";

const A = `${S}/recast`;
/** One clip holds all four takes side by side (original, red silk, gold, summer night), so they never drift apart. */
const TAKES = ["Original", "Red silk", "Gold sequins", "Summer night"];
const CHIPS = [
  { take: 1, label: "Red silk", icon: Shirt },
  { take: 2, label: "Gold", icon: Sparkles },
  { take: 3, label: "Night", icon: Moon },
] as const;
const LOOP = 6;
const WIPE = 0.6;
const TILT = 0.16;

/**
 * Recast: a clip of her twirling. Each tap changes what she wears, or when it is, mid-twirl:
 * a line sweeps across and the twirl never breaks. Then all four takes play side by side.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-canvas]");
  const src = b.$<HTMLVideoElement>("[data-src]");
  const W = b.W;
  const H = b.H;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  rollAt(b, "take", 0);
  b.set("[data-chips]", { o: 0, y: 14 }, 0);
  b.set("[data-chip]", { "--on": 0, s: 1 }, 0);
  b.set("[data-label]", { o: 0, y: 6 }, 0);
  b.set("[data-yours]", { o: 0 }, 0);
  b.video(src, 0, 60, { loop: LOOP });

  b.to("[data-yours]", { o: [0, 1] }, 0.1, 0.3, E.inOut);
  b.to("[data-chips]", { o: [0, 1], y: [14, 0] }, 0.3, 0.45, E.settle);
  const chips = b.$$("[data-chip]");
  /** When each wipe starts, and which take it brings in. */
  const wipes: { t0: number; to: number; dir: 1 | -1 }[] = [];
  p.show(0.45);
  let at = 0.5;
  CHIPS.forEach((c, i) => {
    const reach = p.move(b.point(chips[i], at + 0.5), at, i === 0 ? 0.6 : 0.4, { arc: 0.05 });
    b.click(reach);
    b.to(chips[i], { s: [1, 0.86, 1.08, 1] }, reach, 0.34, E.swift);
    b.set(chips[i], { "--on": 1 }, reach + 0.04);
    if (i > 0) b.set(chips[i - 1], { "--on": 0 }, reach + 0.04);
    wipes.push({ t0: reach + 0.06, to: c.take, dir: i % 2 ? -1 : 1 });
    if (i === 0) {
      b.to("[data-yours]", { o: 0 }, reach, 0.2, E.inOut);
      b.to("[data-take]", { o: [0, 1] }, reach + 0.1, 0.25, E.inOut);
    }
    roll(b, "take", c.take, reach + 0.12, 0.28);
    at = reach + 1.25;
  });
  const done = at - 0.4;
  p.hide(done - 0.2, 0.3);
  b.to("[data-chips]", { o: 0, y: 12 }, done, 0.35, E.leave);
  b.to("[data-take]", { o: 0 }, done, 0.3, E.inOut);

  // All four takes side by side, still in step.
  const k0 = done + 0.25;
  const k1 = k0 + 0.95;
  b.stagger("[data-label]", { o: [0, 1], y: [6, 0] }, k1 - 0.15, 0.4, 0.07, E.settle);
  slap(b, "claim", k1 + 0.5);
  peel(b, "claim", k1 + 1.65);

  const takeAt = (t: number) => {
    let cur = 0;
    for (const w of wipes) if (t >= w.t0 + WIPE) cur = w.to;
    return cur;
  };
  const edge = b.$("[data-edge]");
  let last = 0;
  const draw = (tt: number) => {
    last = tt;
    if (!ctx || src.readyState < 2) return;
    const vw = src.videoWidth / 4;
    const vh = src.videoHeight;
    const s = Math.max(H / vh, W / vw);
    const sw = W / s;
    const sh = H / s;
    const ox = (vw - sw) / 2;
    const oy = (vh - sh) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const full = (take: number) => ctx.drawImage(src, take * vw + ox, oy, sw, sh, 0, 0, W, H);
    const split = span(tt, k0, k1, E.glide);
    let edgeShown = false;
    if (split > 0) {
      // Four strips open out from the middle, each showing its take's own middle.
      const n = 4;
      for (let i = 0; i < n; i++) {
        const x0 = lerp(0, (W * i) / n, split);
        const x1 = lerp(W, (W * (i + 1)) / n, split);
        const dw = x1 - x0;
        if (dw < 0.5) continue;
        const swi = dw / s;
        ctx.drawImage(src, i * vw + (vw - swi) / 2, oy, swi, sh, x0, 0, dw, H);
      }
      ctx.fillStyle = "#0f0d13";
      for (let i = 1; i < n; i++) ctx.fillRect(lerp(0, (W * i) / n, split) - 1, 0, 2, H);
    } else {
      const w = wipes.find((x) => tt >= x.t0 && tt < x.t0 + WIPE);
      const base = takeAt(tt);
      full(base);
      if (w) {
        // The new take behind a slanted line sweeping across.
        const k = E.inOut((tt - w.t0) / WIPE);
        const tilt = TILT * W;
        const e = -tilt + (W + 2 * tilt) * k;
        const xa = w.dir > 0 ? e + tilt : W - e - tilt;
        const xb = w.dir > 0 ? e - tilt : W - e + tilt;
        ctx.save();
        ctx.beginPath();
        if (w.dir > 0) {
          ctx.moveTo(0, 0);
          ctx.lineTo(xa, 0);
          ctx.lineTo(xb, H);
          ctx.lineTo(0, H);
        } else {
          ctx.moveTo(W, 0);
          ctx.lineTo(xa, 0);
          ctx.lineTo(xb, H);
          ctx.lineTo(W, H);
        }
        ctx.closePath();
        ctx.clip();
        full(w.to);
        ctx.restore();
        placeEdge(edge, { x: (((xa + xb) / 2) / W) * 100, y: 50, rotate: (Math.atan2(xa - xb, H) * 180) / Math.PI }, W, H, true);
        edgeShown = true;
      }
    }
    if (!edgeShown) placeEdge(edge, { x: -50, y: 50, rotate: 0 }, W, H, false);
  };
  src.onseeked = () => draw(last);
  b.track((t0) => draw(t0 >= b.seam ? 0 : t0));
  finale(b, k1 + 1.75, 1.5);
}

export function RecastDemo() {
  return (
    <Demo name="recast" hue="var(--color-tool-recast)" script={script}>
      <Clip src={`${A}/quad.mp4`} hook="src" className="!inset-auto !left-0 !top-0 !size-px opacity-0" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${A}/first.webp`} alt="" className="absolute inset-0 size-full object-cover" />
      <canvas data-canvas className="absolute inset-0 size-full" />
      <WipeEdge />
      <Tag hook="yours" className="left-3 top-3">
        Your clip
      </Tag>
      <RollSticker hook="take" words={TAKES} size={19} className="left-3 top-[14px]" />

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 grid grid-cols-4">
        {TAKES.map((l) => (
          <span key={l} data-label data-before-end className="ad-label mx-auto rounded-[3px] bg-[#16131b] px-1 py-[2px] text-[7.5px] text-[#f6f3ee] opacity-0">
            {l}
          </span>
        ))}
      </div>
      <Sticker hook="claim" lines={["Same motion.", "New everything."]} size={26} className="left-[8%] top-[36%]" />

      <div data-chips className={cn(GLASS, "absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit items-center gap-1 rounded-full p-1 opacity-0")}>
        {CHIPS.map(({ label, icon: Icon }) => (
          <span key={label} data-chip className={cn(CHIP, "px-2.5")} style={onChip}>
            <Icon size={11} strokeWidth={2.4} />
            {label}
          </span>
        ))}
      </div>

      <EndSlate title="Swap" />
      <Pointer />
    </Demo>
  );
}
