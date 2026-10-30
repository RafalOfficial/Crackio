"use client";

import { Scan } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, Num, lerp, span, type Builder, type Pt } from "../engine";
import { Canvas, Demo, EndSlate, PRIMARY, Pointer, S, Sticker, Tag, finale, peel, slap } from "../kit";
import META from "./upscale-meta.json";

const A = `${S}/upscale`;
/** Level 1 (the deer) sits in this box of the landscape, level 2 (its eye) in this box of level 1; [x, y, w, h], fractions. */
const C1 = META.c1;
const C2 = META.c2;
/** Real pixel sizes, for the readout: the landscape's width, and the two crops before they're upscaled. */
const WIDE = 1776;
const CROP1 = [144, 180];
const CROP2 = [160, 200];
const X = 16;

type View = { cx: number; cy: number; s: number };
/** The second box, in the landscape's coordinates. */
const C2L = [C1[0] + C2[0] * C1[2], C1[1] + C2[1] * C1[3], C2[2] * C1[2], C2[3] * C1[3]];
const view = (r: number[], s = r[2]): View => ({ cx: r[0] + r[2] / 2, cy: r[1] + r[3] / 2, s });
const FULL: View = { cx: 0.5, cy: 0.5, s: 1 };
const V1 = view(C1);
const V2 = view(C2L);
const EYE: View = { ...V2, s: V2.s * 0.72 };

/**
 * A zoom between two views that reads as one move: the scale changes evenly (in log space) about
 * the one point of the picture that stays put on screen.
 */
function zoom(a: View, b: View, k: number): View {
  const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s), k));
  if (Math.abs(a.s - b.s) < 1e-9) return { cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k), s };
  const fx = (b.cx - a.cx) / (a.s - b.s);
  const fy = (b.cy - a.cy) / (a.s - b.s);
  return { cx: a.cx + fx * a.s - fx * s, cy: a.cy + fy * a.s - fy * s, s };
}

/**
 * Upscale: a landscape, and in it a speck. Box it: up close it's blocks. Upscale: a red deer, every
 * hair. Box its eye: blocks again. Upscale: the sunrise in its eye. Then all the way back out,
 * sharp the whole way.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-view]");
  const ctx = canvas.getContext("2d");
  const imgs = b.keep(
    "levels",
    () => {
      const load = (n: string) => {
        const i = new Image();
        i.decoding = "async";
        i.src = `${A}/${n}.webp`;
        return i;
      };
      return { l0: load("l0"), l0lo: load("l0-lo"), l1: load("l1"), l1lo: load("l1-lo"), l2: load("l2") };
    },
    () => {},
  );
  b.ready(Promise.all(Object.values(imgs).map((i) => i.decode().catch(() => {}))));

  // The camera's moves, and how far each upscale has swept down the frame (0 … 1).
  const legs: { t0: number; t1: number; a: View; b: View; e: (x: number) => number }[] = [];
  const go = (a: View, to: View, t0: number, dur: number, e = E.glide) => {
    legs.push({ t0, t1: t0 + dur, a, b: to, e });
    return t0 + dur;
  };
  const viewAt = (t: number): View => {
    let v = FULL;
    for (const l of legs) {
      if (t < l.t0) break;
      v = t >= l.t1 ? l.b : zoom(l.a, l.b, l.e((t - l.t0) / (l.t1 - l.t0)));
    }
    return v;
  };
  const sweep1 = new Num(0);
  const sweep2 = new Num(0);

  /** A point of the landscape on the card, in %. */
  const onCard = (x: number, y: number, v: View): Pt => ({ x: ((x - (v.cx - v.s / 2)) / v.s) * 100, y: ((y - (v.cy - v.s / 2)) / v.s) * 100 });

  b.set("[data-box]", { o: 0 }, 0);
  b.set("[data-go]", { o: 0, y: 12, s: 1 }, 0);
  b.set("[data-res], [data-zoom]", { o: 0 }, 0);
  b.set("[data-photo]", { o: 0 }, 0);
  b.to("[data-photo]", { o: [0, 1] }, 0.1, 0.3, E.inOut);
  b.to("[data-photo]", { o: 0 }, 1.05, 0.3, E.inOut);

  /** Drag a box from one corner of a region to the other (the camera flies into it next). */
  const boxes: { t0: number; t1: number; z0: number; z1: number; r: number[] }[] = [];
  const select = (r: number[], from: View, t0: number) => {
    const a = onCard(r[0], r[1], from);
    const z = onCard(r[0] + r[2], r[1] + r[3], from);
    let t = p.move(a, t0, 0.5, { arc: 0.1 });
    p.hold(t + 0.02, t + 0.58);
    p.path([a, { x: lerp(a.x, z.x, 0.55), y: lerp(a.y, z.y, 0.45) }, z], t + 0.04, 0.54, E.inOut);
    const drawn = t + 0.04;
    t += 0.62;
    b.to("[data-box]", { o: [0, 1] }, drawn, 0.08, E.linear);
    boxes.push({ t0: drawn, t1: drawn + 0.54, z0: t + 0.05, z1: t + 1.35, r });
    p.hide(t + 0.05, 0.25);
    return t;
  };
  const upscale = (t0: number, sweep: Num) => {
    b.to("[data-go]", { o: [0, 1], y: [12, 0] }, t0, 0.35, E.settle);
    p.show(t0 + 0.05);
    const tap = p.move(b.point("[data-go]", t0 + 0.6), t0 + 0.05, 0.5, { arc: 0.06 });
    b.click(tap);
    b.to("[data-go]", { s: [1, 0.88, 1] }, tap, 0.3, E.swift);
    b.to("[data-go]", { o: 0, y: 10 }, tap + 0.2, 0.3, E.leave);
    p.hide(tap + 0.25, 0.3);
    sweep.to(1, tap + 0.1, 1.0, E.inOut);
    return tap + 1.1;
  };

  // 1 · The speck: box it, fly in, upscale.
  p.show(0.6);
  let t = select(C1, FULL, 0.65);
  const z1 = go(FULL, V1, t + 0.05, 1.3);
  b.to("[data-box]", { o: 0 }, z1 - 0.25, 0.25, E.inOut);
  b.to("[data-zoom]", { o: [0, 1] }, t + 0.2, 0.25, E.inOut);
  b.to("[data-res]", { o: [0, 1] }, z1 - 0.1, 0.25, E.inOut);
  const e1 = upscale(z1 + 0.1, sweep1);
  const res1 = { t0: e1 - 1.0, t1: e1 };

  // 2 · Its eye: box it, fly in again, upscale again.
  t = select(C2L, V1, e1 + 0.2);
  const z2 = go(V1, V2, t + 0.05, 1.25);
  b.to("[data-box]", { o: 0 }, z2 - 0.25, 0.25, E.inOut);
  const e2 = upscale(z2 + 0.1, sweep2);
  const res2 = { t0: e2 - 1.0, t1: e2 };

  // Lean into the eye; then all the way back out.
  const push = go(V2, EYE, e2 + 0.05, 1.3, E.inOut);
  slap(b, "claim", e2 + 0.2);
  peel(b, "claim", push + 0.05);
  b.to("[data-res], [data-zoom]", { o: 0 }, push - 0.1, 0.3, E.inOut);
  const out = go(EYE, FULL, push + 0.1, 1.7, E.inOut);

  // The readouts: how far in, and how many real pixels are on screen.
  const zoomEl = b.$("[data-zoom-n]");
  const resEl = b.$("[data-res-n]");
  const boxEl = b.$("[data-box]");
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    const v = viewAt(tt);
    const zText = `×${Math.max(1, Math.round(1 / v.s))}`;
    if (zoomEl.textContent !== zText) zoomEl.textContent = zText;
    let w = Math.round(WIDE * v.s);
    if (tt >= res2.t0) w = Math.round(lerp(CROP2[0], CROP2[0] * X, span(tt, res2.t0, res2.t1, E.inOut)));
    else if (tt >= boxes[1].z0) w = Math.round(CROP1[0] * X * (v.s / C1[2]));
    else if (tt >= res1.t0) w = Math.round(lerp(CROP1[0], CROP1[0] * X, span(tt, res1.t0, res1.t1, E.inOut)));
    const rText = `${w.toLocaleString("en-US")} × ${Math.round(w * 1.25).toLocaleString("en-US")}`;
    if (resEl.textContent !== rText) resEl.textContent = rText;

    // The selection box: drawn by the pointer, then it grows into the frame with the zoom.
    for (const bx of boxes) {
      if (tt < bx.t0 || tt > bx.z1) continue;
      const vv = tt < bx.z0 ? viewAt(bx.t0) : v;
      const a = onCard(bx.r[0], bx.r[1], vv);
      const z = onCard(bx.r[0] + bx.r[2], bx.r[1] + bx.r[3], vv);
      const k = tt < bx.z0 ? span(tt, bx.t0, bx.t1, E.inOut) : 1;
      boxEl.style.left = `${a.x.toFixed(2)}%`;
      boxEl.style.top = `${a.y.toFixed(2)}%`;
      boxEl.style.width = `${(lerp(a.x, z.x, k) - a.x).toFixed(2)}%`;
      boxEl.style.height = `${(lerp(a.y, z.y, k) - a.y).toFixed(2)}%`;
    }
    draw(v, sweep1.at(tt), sweep2.at(tt), tt >= out - 1.7);
  });

  /** Paint the view: the landscape, the deer inside it, the eye inside that, each blocks until it's upscaled. */
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function draw(v: View, k1: number, k2: number, backOut: boolean) {
    if (!ctx) return;
    const cw = Math.round(b.W * dpr);
    const ch = Math.round(b.H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.fillStyle = "#0f0d13";
    ctx.fillRect(0, 0, cw, ch);
    const x0 = v.cx - v.s / 2;
    const y0 = v.cy - v.s / 2;
    /** Draw `img` over region r (landscape fractions), cropped to what's in view, down to a scan line. */
    const layer = (img: HTMLImageElement, r: number[], smooth: boolean, scan = 1) => {
      if (!img.complete || !img.naturalWidth) return;
      const L = ((r[0] - x0) / v.s) * cw;
      const T = ((r[1] - y0) / v.s) * ch;
      const Wd = (r[2] / v.s) * cw;
      const Hd = (r[3] / v.s) * ch;
      const cl = Math.max(0, L);
      const ct = Math.max(0, T);
      const cr = Math.min(cw, L + Wd);
      const cb = Math.min(ch * scan, T + Hd);
      if (cr <= cl || cb <= ct) return;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      ctx.imageSmoothingEnabled = smooth;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, ((cl - L) / Wd) * iw, ((ct - T) / Hd) * ih, Math.max(0.01, ((cr - cl) / Wd) * iw), Math.max(0.01, ((cb - ct) / Hd) * ih), cl, ct, cr - cl, cb - ct);
    };
    // The landscape is the photo you have: a few pixels across that speck, so up close it's blocks.
    const blocks0 = !backOut && k1 < 1 && v.s < 0.45;
    layer(blocks0 ? imgs.l0lo : imgs.l0, [0, 0, 1, 1], !blocks0);
    const blocks1 = !backOut && k2 < 1 && v.s < C1[2] * 0.42;
    if (k1 > 0) layer(blocks1 ? imgs.l1lo : imgs.l1, C1, !blocks1, k1);
    if (k2 > 0) layer(imgs.l2, C2L, true, k2);
    // The scan line rides each sweep.
    for (const k of [k1, k2]) {
      if (k <= 0 || k >= 1) continue;
      const y = k * ch;
      const g = ctx.createLinearGradient(0, y - 26 * dpr, 0, y + 2 * dpr);
      g.addColorStop(0, "rgba(63,208,192,0)");
      g.addColorStop(1, "rgba(63,208,192,0.45)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 26 * dpr, cw, 28 * dpr);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, y - dpr, cw, 2 * dpr);
    }
  }
  finale(b, out + 0.25, 1.4);
}

export function UpscaleDemo() {
  return (
    <Demo name="upscale" hue="var(--color-tool-upscale)" script={script}>
      <Canvas hook="view" />
      <span data-box className="pointer-events-none absolute z-10 rounded-[2px] border-[1.5px] border-dashed border-white opacity-0 shadow-[0_0_0_9999px_rgb(0_0_0/0.28)]" />
      <Tag hook="photo" className="left-3 top-3">
        Your photo
      </Tag>
      <Tag hook="zoom" className="left-3 top-3 tabular-nums">
        <span data-zoom-n>×1</span>
      </Tag>
      <Tag hook="res" tone="paper" className="right-3 top-3 tabular-nums">
        <span data-res-n>1,776 × 2,220</span> px
      </Tag>
      <Sticker hook="claim" lines={["Zoom.", "Enhance."]} size={34} className="left-[10%] top-[60%]" />

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <span data-go className={cn(PRIMARY, "h-[30px] px-3.5 text-[11px] opacity-0")}>
          <Scan size={12} strokeWidth={2.6} />
          Upscale {X}×
        </span>
      </div>

      <EndSlate title="Upscale" />
      <Pointer />
    </Demo>
  );
}
