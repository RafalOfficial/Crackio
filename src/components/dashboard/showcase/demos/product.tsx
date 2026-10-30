"use client";

import { Heart, MessageCircle, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, type Builder } from "../engine";
import { Clip, Demo, EndSlate, GLASS, Img, Pointer, RollSticker, S, Sticker, Tag, finale, peel, roll, rollAt, slap } from "../kit";

const A = `${S}/product`;
/** Each tap pours the next scene out of the bottle, and the scene is alive (a clip that starts on that very frame). */
const SCENES = [
  { id: "marble", name: "Marble" },
  { id: "splash", name: "Splash" },
  { id: "peony", name: "Peonies" },
  { id: "neon", name: "Neon night" },
  { id: "snow", name: "First snow" },
  { id: "dune", name: "Dunes" },
  { id: "moss", name: "Misty forest" },
  { id: "beach", name: "Golden shore" },
] as const;
/** The bottle's middle, where every scene pours out from (card %). */
const BOTTLE = { x: 50, y: 54 };
/** How long each scene holds before the next tap: long enough to watch the first ones move, never a blur. */
const HOLD = [1.2, 1.1, 1.0, 0.55, 0.55, 0.55, 0.6, 1.0];
/** Creators' posts with the same bottle (made in Product Studio as UGC). */
const POSTS = [
  { id: "mirror", who: "maya.daily", likes: "3,412", at: "right-[5%] top-[7%]" },
  { id: "cafe", who: "itsjules", likes: "8,950", at: "right-[5%] top-[51%]" },
] as const;

/**
 * Product Studio: a plain packshot. Each tap on a scene and a new world pours out of the bottle,
 * alive, while the bottle never moves or changes. Then the same bottle goes to creators: a video
 * on a phone, and posts all around it, all made from the one packshot.
 */
function script(b: Builder) {
  const p = b.pointer;
  const W = b.W;
  const H = b.H;
  b.set("[data-thumbs]", { o: 0, y: 16 }, 0);
  b.set("[data-thumb]", { "--on": 0, s: 1 }, 0);
  b.set("[data-yours]", { o: 0 }, 0);
  b.set("[data-scene]", { cc: 0, ccx: BOTTLE.x, ccy: BOTTLE.y, o: 0 }, 0);
  b.set("[data-world]", { s: 1, x: 0, y: 0, cround: 0, o: 1 }, 0);
  b.set("[data-social]", { o: 0 }, 0);
  b.set("[data-phone]", { y: 60, o: 0 }, 0);
  b.set("[data-post]", { o: 0, s: 0.8, x: 24 }, 0);
  b.set("[data-social]", { blur: 0, bright: 1 }, 0);
  b.set("[data-heart]", { s: 1 }, 0);
  rollAt(b, "name", 0);

  b.to("[data-yours]", { o: [0, 1] }, 0.12, 0.35, E.inOut);
  b.to("[data-thumbs]", { o: [0, 1], y: [16, 0] }, 0.3, 0.45, E.settle);

  // The taps: each pours a living scene out of the bottle.
  const thumbs = b.$$("[data-thumb]");
  const scenes = b.$$("[data-scene]");
  const pours: { t0: number; dur: number }[] = [];
  p.show(0.5);
  let at = 0.5;
  SCENES.forEach((s, i) => {
    const reach = p.move(b.point(thumbs[i], at + 0.5), at, i === 0 ? 0.6 : i < 3 ? 0.42 : 0.32, { arc: 0.06 });
    b.click(reach);
    b.to(thumbs[i], { s: [1, 0.82, 1.12, 1] }, reach, 0.36, E.swift);
    b.set(thumbs[i], { "--on": 1 }, reach + 0.04);
    if (i > 0) b.set(thumbs[i - 1], { "--on": 0 }, reach + 0.04);
    const dur = i < 3 ? 0.62 : 0.48;
    // Only the scene pouring in and the one under it are on the page; covered ones step out (a clip each).
    b.set(scenes[i], { o: 1 }, reach + 0.04);
    b.to(scenes[i], { cc: [0, 82] }, reach + 0.04, dur, E.inOut);
    if (i > 0) b.set(scenes[i - 1], { o: 0 }, reach + 0.04 + dur + 0.02);
    pours.push({ t0: reach + 0.04, dur });
    b.video(`[data-v-${s.id}]`, reach + 0.04, reach + 0.04 + dur + HOLD[i] + 0.6);
    if (i === 0) {
      b.to("[data-yours]", { o: 0 }, reach, 0.25, E.inOut);
      b.to("[data-name]", { o: [0, 1] }, reach + 0.1, 0.25, E.inOut);
    }
    roll(b, "name", i, reach + 0.08, 0.28);
    at = reach + dur * 0.5 + HOLD[i] - 0.4;
  });
  const done = at + 0.35;
  p.hide(done - 0.15, 0.3);
  b.to("[data-thumbs]", { o: 0, y: 12 }, done, 0.35, E.leave);
  b.to("[data-name]", { o: 0 }, done, 0.3, E.inOut);

  // Then it goes to creators: the last scene steps back, a phone rises with a creator's video of the same bottle…
  const s0 = done + 0.25;
  b.to("[data-world]", { s: 0.9, o: 0 }, s0, 0.55, E.inOut);
  b.to("[data-social]", { o: [0, 1] }, s0, 0.45, E.inOut);
  b.to("[data-phone]", { o: [0, 1], y: [60, 0] }, s0 + 0.15, 0.6, E.settle);
  b.video("[data-v-ugc]", s0 + 0.2, s0 + 4.4);
  b.to("[data-heart]", { s: [1, 1.35, 1] }, s0 + 1.6, 0.35, E.pop);
  // … then it steps aside and their posts land next to it, one above the other.
  const side = s0 + 2.2;
  b.to("[data-phone]", { x: -W * 0.2, s: 0.86 }, side, 0.55, E.glide);
  const posts = b.$$("[data-post]");
  posts.forEach((el, i) => b.to(el, { o: [0, 1], s: [0.8, 1], x: [24, 0] }, side + 0.25 + i * 0.18, 0.45, E.settle));
  // Everything softens, and the line has the frame to itself.
  const c0 = side + 1.45;
  b.to("[data-social]", { blur: [0, 5], bright: [1, 0.62] }, c0, 0.5, E.inOut);
  slap(b, "claim", c0 + 0.3);
  peel(b, "claim", c0 + 1.5);

  // The ring of light at the edge of each pour.
  const ring = b.$("[data-pour]");
  const ref = Math.hypot(W, H) / Math.SQRT2;
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    let shown = false;
    for (const pour of pours) {
      if (tt < pour.t0 || tt > pour.t0 + pour.dur) continue;
      const k = E.inOut((tt - pour.t0) / pour.dur);
      const r = ((82 * k) / 100) * ref;
      ring.style.width = ring.style.height = `${(2 * r).toFixed(1)}px`;
      ring.style.opacity = String((1 - k * 0.7).toFixed(3));
      shown = true;
    }
    if (!shown) ring.style.opacity = "0";
  });
  finale(b, c0 + 1.6, 1.4);
}

export function ProductDemo() {
  return (
    <Demo name="product" hue="var(--color-tool-product)" script={script}>
      {/* The world: the packshot, then each scene poured over the last. */}
      <div data-world className="absolute inset-0 overflow-hidden">
        <Img src={`${A}/base.webp`} />
        {SCENES.map((s) => (
          <div key={s.id} data-scene className="absolute inset-0" style={{ clipPath: "circle(0% at 50% 54%)" }}>
            <Clip src={`${A}/${s.id}.mp4`} poster={`${A}/${s.id}.webp`} hook={`v-${s.id}`} />
          </div>
        ))}
        <span
          data-pour
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0"
          style={{ left: `${BOTTLE.x}%`, top: `${BOTTLE.y}%`, boxShadow: "0 0 0 1.5px rgb(255 255 255 / 0.85), 0 0 18px 4px color-mix(in oklab, var(--hue) 60%, transparent), inset 0 0 18px 2px color-mix(in oklab, var(--hue) 45%, transparent)" }}
        />
      </div>

      {/* Creators: a video on a phone, and their posts around it. */}
      <div data-social className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_30%,#f6dfd6_0%,#e7c4bc_55%,#cfa39d_100%)] opacity-0">
        <div data-phone className="absolute left-[25%] top-[7%] h-[86%] w-[50%] overflow-hidden rounded-[20px] bg-black opacity-0 shadow-[0_0_0_3.5px_#16131b,0_26px_40px_-14px_rgb(60_30_30/0.65)]">
          <Clip src={`${A}/ugc.mp4`} poster={`${A}/ugc.webp`} hook="v-ugc" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_62%,rgb(0_0_0/0.55))]" />
          <div className="absolute bottom-[14%] right-1.5 flex flex-col items-center gap-2 text-white">
            <span data-heart className="flex flex-col items-center">
              <Heart size={13} strokeWidth={2.4} className="fill-[#ff4d6d] text-[#ff4d6d]" />
              <span className="mt-[1px] text-[6.5px] font-bold">24.8K</span>
            </span>
            <span className="flex flex-col items-center">
              <MessageCircle size={12} strokeWidth={2.4} />
              <span className="mt-[1px] text-[6.5px] font-bold">1,203</span>
            </span>
            <Send size={12} strokeWidth={2.4} />
          </div>
          <div className="absolute inset-x-2 bottom-2.5 text-white">
            <p className="text-[7.5px] font-bold">@sofi.scents</p>
            <p className="mt-[1px] text-[7px] leading-tight text-white/90">my new signature scent</p>
          </div>
        </div>
        {POSTS.map((post) => (
          <div key={post.id} className={cn("absolute w-[36%]", post.at)}>
            <div data-post className="overflow-hidden rounded-[8px] bg-white opacity-0 shadow-[0_14px_26px_-12px_rgb(60_30_30/0.7)]">
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="size-[9px] rounded-full bg-[conic-gradient(#f6c1a6,#f08aa4,#f6c1a6)]" />
                <span className="text-[6px] font-bold text-[#16131b]">{post.who}</span>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${A}/ugc-${post.id}.webp`} alt="" className="block aspect-[4/5] w-full object-cover" />
              <div className="flex items-center gap-1 px-1.5 py-1 text-[6px] font-bold text-[#16131b]">
                <Heart size={7} strokeWidth={2.6} className="fill-[#ff4d6d] text-[#ff4d6d]" />
                {post.likes}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Tag hook="yours" className="left-3 top-3">
        Your packshot
      </Tag>
      <RollSticker hook="name" words={SCENES.map((s) => s.name)} size={19} className="left-3 top-[14px]" />
      <Sticker hook="claim" lines={["One packshot.", "Endless content."]} size={25} className="left-[9%] top-[40%] z-[31]" />

      <div data-thumbs className={cn(GLASS, "absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit items-center gap-[4px] rounded-full p-[5px] opacity-0")}>
        {SCENES.map((s) => (
          <span key={s.id} data-thumb className="block size-[21px] shrink-0 overflow-hidden rounded-full" style={{ boxShadow: "0 0 0 1px rgb(255 255 255 / 0.22), 0 0 0 calc(var(--on, 0) * 2px) rgb(15 13 19), 0 0 0 calc(var(--on, 0) * 3.5px) #fff" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${A}/${s.id}-t.webp`} alt="" className="size-full object-cover" />
          </span>
        ))}
      </div>

      <EndSlate title="Product Studio" />
      <Pointer />
    </Demo>
  );
}
