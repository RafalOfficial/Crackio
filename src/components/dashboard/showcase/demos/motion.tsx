"use client";

import { ArrowUp, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, type Builder } from "../engine";
import { Clip, Demo, EndSlate, GLASS, PRIMARY, Pointer, S, Sticker, Tag, finale, peel, slap } from "../kit";

const A = `${S}/motion`;
const AD = 7.29;
/** The seven shots the agent makes, in the order they're cut (the ad is these, back to back). */
const SHOTS = ["Sky", "Splash", "Deck", "Sand", "Walk", "Towel"];
/** What the agent says it's doing. */
const STATUS = ["Writing the brief", "Shooting 6 scenes", "Bringing them to life", "Cutting to the beat"];

/**
 * Motion: one product photo and one sentence. The agent works like a studio in fast-forward,
 * in plain sight: each scene develops on the monitor and drops into the timeline, the cut runs to
 * the beat, and the monitor opens into the finished ad.
 */
function script(b: Builder) {
  const p = b.pointer;
  const W = b.W;
  const H = b.H;
  const MON = 0.66;
  const monY = -H * 0.035;
  b.set("[data-glasses]", { o: 0, s: 1.3, r: -8, x: 0, y: 0 }, 0);
  b.set("[data-yours]", { o: 0 }, 0);
  b.set("[data-ask]", { o: 0, y: 14 }, 0);
  b.set("[data-status]", { o: 0, y: -6 }, 0);
  b.set("[data-status-line]", { o: 0, y: 6 }, 0);
  b.set("[data-monitor]", { o: 0, s: MON * 0.9, y: monY, cround: 14 / MON, blur: 0, bright: 1 }, 0);
  b.set("[data-shot]", { o: 0, bright: 1.8, s: 1.06 }, 0);
  b.set("[data-tile]", { o: 0, s: 0.6, y: 6 }, 0);
  b.set("[data-strip]", { o: 0 }, 0);
  b.set("[data-head]", { o: 0, X: 0 }, 0);
  b.set("[data-film]", { o: 0 }, 0);
  b.set("[data-t1] > span", { o: 0, "--ls": 0.6 }, 0);
  b.set("[data-t2]", { o: 0, y: 8 }, 0);
  b.set("[data-bar]", { sx: 0 }, 0);

  // The product lands in the sun.
  b.to("[data-glasses]", { o: [0, 1], s: [1.3, 1], r: [-8, -3] }, 0.1, 0.6, E.pop);
  b.to("[data-yours]", { o: [0, 1] }, 0.3, 0.3, E.inOut);
  b.to("[data-ask]", { o: [0, 1], y: [14, 0] }, 0.45, 0.45, E.settle);
  p.show(0.5);
  const send = p.move(b.point("[data-send]", 1.1), 0.5, 0.58);
  b.click(send);
  b.to("[data-send]", { s: [1, 0.84, 1] }, send, 0.3, E.swift);
  b.to("[data-ask]", { o: 0, y: 10 }, send + 0.15, 0.35, E.leave);
  b.to("[data-yours]", { o: 0 }, send + 0.1, 0.25, E.inOut);
  p.hide(send + 0.3, 0.3);

  // The studio, fast: the brief tucks into the corner and the monitor lights up.
  const s0 = send + 0.25;
  const g = b.box("[data-glasses]");
  b.to("[data-glasses]", { s: 0.34, x: 14 + (g.w * 0.34) / 2 - (g.x + g.w / 2), y: 34 - (g.y + g.h / 2), r: 0 }, s0, 0.6, E.glide);
  b.to("[data-status]", { o: [0, 1], y: [-6, 0] }, s0 + 0.1, 0.35, E.settle);
  b.to("[data-monitor]", { o: [0, 1], s: [MON * 0.9, MON] }, s0 + 0.15, 0.5, E.settle);
  b.to("[data-strip]", { o: [0, 1] }, s0 + 0.3, 0.3, E.inOut);
  const lines = b.$$("[data-status-line]");
  const say = (i: number, at: number) => {
    b.to(lines[i], { o: [0, 1], y: [6, 0] }, at, 0.3, E.settle);
    if (i > 0) b.to(lines[i - 1], { o: 0, y: -6 }, at - 0.05, 0.22, E.leave);
  };
  say(0, s0 + 0.2);
  // Each scene develops on the monitor and drops into the timeline.
  const shots = b.$$("[data-shot]");
  const tiles = b.$$("[data-tile]");
  const r0 = s0 + 0.38;
  const gap = 0.34;
  say(1, r0);
  shots.forEach((el, i) => {
    const at = r0 + i * gap;
    b.set(el, { o: 1 }, at);
    b.to(el, { bright: [1.8, 1], s: [1.06, 1] }, at, 0.3, E.settle);
    if (i > 0) b.set(shots[i - 1], { o: 0 }, at + 0.02);
    b.to(tiles[i], { o: [0, 1], s: [0.6, 1], y: [6, 0] }, at + 0.12, 0.32, E.pop);
  });
  say(2, r0 + 3 * gap);
  // The cut: a playhead runs the timeline on the beat.
  const c0 = r0 + SHOTS.length * gap + 0.1;
  say(3, c0);
  b.to("[data-head]", { o: [0, 1] }, c0, 0.15, E.inOut);
  b.to("[data-head]", { X: [0, 100] }, c0, 0.75, E.linear);
  tiles.forEach((el, i) => b.to(el, { s: [1, 1.14, 1] }, c0 + (i / SHOTS.length) * 0.75, 0.2, E.inOut));
  b.to("[data-head]", { o: 0 }, c0 + 0.75, 0.15, E.inOut);
  b.to("[data-done]", { o: [0, 1], s: [0.6, 1] }, c0 + 0.8, 0.3, E.pop);
  b.set("[data-done]", { o: 0, s: 0.6 }, 0);

  // The monitor opens into the ad.
  const open = c0 + 1.05;
  b.to("[data-monitor]", { s: 1, y: 0, cround: 0 }, open, 0.6, E.glide);
  b.to("[data-status], [data-strip], [data-glasses], [data-done]", { o: 0 }, open, 0.3, E.inOut);
  b.set("[data-film]", { o: 1 }, open);
  b.set(shots[shots.length - 1], { o: 0 }, open + 0.02);
  b.video("[data-ad]", open, open + AD);
  b.to("[data-bar]", { sx: [0, 1] }, open, AD, E.linear);
  b.to("[data-t1] > span", { o: [0, 1], "--ls": [0.6, 0.16] }, open + 0.35, 1.3, E.settle);
  b.to("[data-t1] > span", { o: 0 }, open + 1.85, 0.3, E.inOut);
  b.to("[data-t2]", { o: [0, 1], y: [8, 0] }, open + AD - 1.6, 0.5, E.settle);
  // The ad ends: its title goes, the last frame stills and softens, and only then the claim.
  b.to("[data-t2], [data-bar-box]", { o: 0 }, open + AD - 0.25, 0.3, E.inOut);
  b.to("[data-monitor]", { blur: [0, 8], bright: [1, 0.65] }, open + AD - 0.1, 0.6, E.inOut);
  slap(b, "claim", open + AD + 0.25);
  peel(b, "claim", open + AD + 1.45);
  finale(b, open + AD + 1.5, 1.35);
  void W;
}

export function MotionDemo() {
  return (
    <Demo name="motion" hue="var(--color-tool-motion)" script={script}>
      {/* Summer light, not a dark room: the pool's own colors, soft. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${A}/backdrop.webp`} alt="" className="absolute inset-0 size-full scale-110 object-cover" />
      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_42%,rgb(255_250_240/0.55),rgb(255_244_228/0.15)_60%,rgb(20_16_24/0.25))]" />

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img data-glasses src={`${A}/sunglasses.webp`} alt="" draggable={false} className="pointer-events-none absolute left-[11%] top-[33%] z-20 w-[78%] opacity-0 drop-shadow-[0_18px_22px_rgb(60_40_20/0.45)]" />
      <Tag hook="yours" className="left-3 top-3">
        1 product photo
      </Tag>

      {/* What the agent is doing. */}
      <div data-status className={cn(GLASS, "absolute right-3 top-3 z-20 h-[22px] w-[138px] overflow-hidden rounded-full opacity-0")}>
        {STATUS.map((s) => (
          <p key={s} data-status-line className="ad-serif absolute inset-0 flex items-center justify-center gap-1.5 text-[12.5px] italic text-white opacity-0">
            <span className="size-1.5 animate-pulse rounded-full bg-spike" />
            {s}
          </p>
        ))}
      </div>

      {/* The monitor: each scene develops here, then it opens into the finished ad. */}
      <div data-monitor className="absolute inset-0 z-10 overflow-hidden opacity-0 shadow-[0_24px_44px_-14px_rgb(0_0_0/0.7)]">
        <div className="absolute inset-0 bg-[linear-gradient(160deg,#f3e4cf,#d9c2a5_55%,#bfa286)]" />
        {SHOTS.map((s, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={s} data-shot src={`${A}/shot-${i}.webp`} alt="" className="absolute inset-0 size-full object-cover opacity-0" />
        ))}
        <div data-film className="absolute inset-0 opacity-0">
          <Clip src={`${A}/ad.mp4`} hook="ad" poster={`${A}/shot-0.webp`} />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgb(0_0_0/0.25),transparent_30%,transparent_62%,rgb(0_0_0/0.45))]" />
          <p data-t1 className="absolute inset-x-0 top-[15%] text-center font-serif text-[30px] leading-none text-white [text-shadow:0_2px_18px_rgb(0_0_0/0.35)]">
            <span className="inline-block opacity-0" style={{ letterSpacing: "calc(var(--ls, 0.6) * 1em)" }}>
              SOLARE
            </span>
          </p>
          <div data-t2 className="absolute inset-x-0 bottom-[16%] text-center opacity-0">
            <p className="ad-serif text-[24px] italic leading-none text-white [text-shadow:0_2px_14px_rgb(0_0_0/0.4)]">Summer, in focus.</p>
            <p className="ad-label mt-1.5 text-[8.5px] tracking-[0.3em] text-white/85">Solare · Riviera 27</p>
          </div>
          <span data-bar-box className="absolute inset-x-3 bottom-2 h-[2px] overflow-hidden rounded-full bg-white/25">
            <span data-bar className="block h-full origin-left bg-white" style={{ transform: "scaleX(0)" }} />
          </span>
        </div>
      </div>

      {/* The timeline: each scene drops in as it's made. */}
      <div data-strip className="pointer-events-none absolute inset-x-0 bottom-[13px] z-20 flex justify-center opacity-0">
        <div className={cn(GLASS, "relative flex gap-[3px] rounded-[9px] p-[4px]")}>
          {SHOTS.map((s, i) => (
            <span key={s} data-tile className="relative block h-[36px] w-[27px] overflow-hidden rounded-[4px] opacity-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${A}/shot-${i}.webp`} alt="" className="size-full object-cover" />
            </span>
          ))}
          <span data-head className="absolute inset-y-[2px] left-[4px] right-[4px] opacity-0">
            <span className="absolute inset-y-0 left-0 w-[2px] -translate-x-1/2 bg-white shadow-[0_0_6px_rgb(255_255_255/0.9)]" />
          </span>
        </div>
      </div>
      <span data-done className="absolute right-3 top-[38px] z-20 inline-flex items-center gap-1 rounded-full bg-chroma px-2 py-[3px] text-[9px] font-bold text-[#0d1a14] opacity-0">
        <Check size={10} strokeWidth={3} />
        Ad ready
      </span>

      <div data-ask className={cn(GLASS, "absolute inset-x-0 bottom-3 z-20 mx-auto flex h-[32px] w-fit items-center gap-2 rounded-full pl-3 pr-1 text-[11.5px] font-medium text-white opacity-0")}>
        Summer ad for SOLARE
        <span data-send className={cn(PRIMARY, "size-[26px] !p-0")}>
          <ArrowUp size={13} strokeWidth={2.8} />
        </span>
      </div>
      <Sticker hook="claim" lines={["One sentence.", "A whole ad."]} size={28} className="left-[8%] top-[38%] z-[31]" />

      <EndSlate title="Motion" />
      <Pointer />
    </Demo>
  );
}
