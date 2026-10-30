"use client";

import { Clapperboard } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, lerp, span, type Builder } from "../engine";
import { Caption, Clip, Demo, EndSlate, PRIMARY, Pointer, S, Sticker, finale, peel, say, slant, slap } from "../kit";

const A = `${S}/storyboard`;
const IDEA = ["He", "follows", "the", "car", "into", "the", "night."];
const PANELS = 6;
const FILM = 7.0;

/**
 * Storyboard: one line. One tap and it's six pencil panels; one sweep and they're frames of the
 * same man on the same rainy night (the chase, the wheel, the docks, the door, the flashlight, the
 * clue); then the first panel opens into the film: the car tearing through the rain, him stepping
 * out with a flashlight, the warehouse. When the film ends it stills and softens, and only then the
 * line: one line, one film. Frames and clips made in Crackio (Grok Imagine; the sketches with
 * FLUX.2 klein on a GPU).
 */
function script(b: Builder) {
  const p = b.pointer;
  const W = b.W;
  const H = b.H;
  b.set("[data-idea-box]", { o: 1, y: 0, s: 1 }, 0);
  b.set("[data-go]", { o: 0, s: 0.8 }, 0);
  b.set("[data-panel]", { o: 0, s: 0.86, y: 10 }, 0);
  b.set("[data-num]", { o: 0 }, 0);
  b.set("[data-film]", { o: 0, s: 1, x: 0, y: 0, cround: 0, blur: 0, bright: 1 }, 0);
  b.set("[data-bar]", { sx: 0 }, 0);
  b.set("[data-bar-box]", { o: 0 }, 0);

  // The line, like the opening of a film.
  let t = say(b, "idea", 0.3, 0.13);
  b.to("[data-go]", { o: [0, 1], s: [0.8, 1] }, t + 0.05, 0.35, E.pop);
  p.show(t);
  const go = b.$("[data-go]");
  t = p.move(b.point(go, t + 0.6), t + 0.05, 0.55, { arc: 0.06 });
  b.click(t);
  b.to(go, { s: [1, 0.88, 1] }, t, 0.3, E.swift);
  p.hide(t + 0.25, 0.3);
  b.to("[data-go]", { o: 0, s: 0.9 }, t + 0.15, 0.3, E.leave);
  b.to("[data-idea-box]", { o: 0, y: -10 }, t + 0.1, 0.35, E.leave);

  // Six pencil panels deal in.
  const p0 = t + 0.3;
  const panels = b.$$("[data-panel]");
  panels.forEach((el, i) => b.to(el, { o: [0, 1], s: [0.86, 1], y: [10, 0] }, p0 + i * 0.07, 0.42, E.settle));
  b.stagger("[data-num]", { o: [0, 1] }, p0 + 0.35, 0.25, 0.05, E.inOut);

  // One sweep, and they're frames.
  const r0 = p0 + 1.05;
  const frames = b.$$("[data-frame]");
  const wipes = frames.map((el, i) => ({ el, t0: r0 + (i % 2) * 0.08 + Math.floor(i / 2) * 0.12 }));

  // The first panel opens into the film.
  const o0 = r0 + 1.15;
  const first = b.box(panels[0]);
  const k = Math.max(first.w / W, first.h / H);
  b.set("[data-film]", { o: 1, s: k, x: first.x + first.w / 2 - W / 2, y: first.y + first.h / 2 - H / 2, cround: 7 / k }, o0);
  b.to("[data-film]", { s: 1, x: 0, y: 0, cround: 0 }, o0, 0.6, E.glide);
  b.to("[data-panel]", { o: 0 }, o0 + 0.5, 0.2, E.inOut);
  const f0 = o0 + 0.1;
  b.video("[data-film-clip]", f0, f0 + FILM);
  b.to("[data-bar-box]", { o: [0, 1] }, f0 + 0.3, 0.3, E.inOut);
  b.to("[data-bar]", { sx: [0, 1] }, f0, FILM, E.linear);

  // The film ends: it stills and softens. Then the line.
  const end = f0 + FILM - 0.05;
  b.to("[data-bar-box]", { o: 0 }, end - 0.1, 0.3, E.inOut);
  b.to("[data-film]", { blur: [0, 9], bright: [1, 0.62] }, end, 0.7, E.inOut);
  slap(b, "claim", end + 0.45);
  peel(b, "claim", end + 1.75);

  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    for (const w of wipes) {
      const q = span(tt, w.t0, w.t0 + 0.55, E.inOut);
      w.el.style.clipPath = q <= 0 ? "polygon(0 0, 0 0, 0 0)" : q >= 1 ? "none" : slant(q, 100, 125).clip;
    }
  });
  finale(b, end + 1.85, 1.35);
  void lerp;
}

export function StoryboardDemo() {
  return (
    <Demo name="storyboard" hue="var(--color-tool-storyboard)" script={script}>
      <div className="absolute inset-0 bg-[radial-gradient(110%_80%_at_50%_35%,#1f2636_0%,#11141c_60%,#0b0c10_100%)]" />

      {/* The idea: one line, and one button. */}
      <div data-idea-box className="absolute inset-x-6 top-[34%] z-10">
        <Caption hook="idea" words={IDEA} className="!static ad-serif !text-[22px] !font-normal italic !leading-[1.15]" />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-[58%] z-10 flex justify-center">
        <span data-go className={cn(PRIMARY, "h-[30px] px-3.5 text-[11px] opacity-0")}>
          <Clapperboard size={12} strokeWidth={2.6} />
          Storyboard it
        </span>
      </div>

      {/* Six panels: a pencil sketch, then the frame. */}
      <div className="absolute inset-[10px] z-10 grid grid-cols-2 grid-rows-3 gap-[6px]">
        {Array.from({ length: PANELS }, (_, i) => (
          <div key={i} data-panel className="relative overflow-hidden rounded-[7px] bg-[#ece6dc] opacity-0 shadow-[0_8px_18px_-10px_rgb(0_0_0/0.8)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${A}/sketch-${i + 1}.webp`} alt="" className="absolute inset-0 size-full object-cover" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img data-frame src={`${A}/frame-${i + 1}.webp`} alt="" className="absolute inset-0 size-full object-cover" style={{ clipPath: "polygon(0 0, 0 0, 0 0)" }} />
            <span data-num className="ad-label absolute left-1.5 top-1.5 rounded-[3px] bg-black/55 px-1 py-[2px] text-[7px] text-white opacity-0">
              0{i + 1}
            </span>
          </div>
        ))}
      </div>

      {/* The film, full frame, out of the first panel. */}
      <div data-film className="absolute inset-0 z-20 overflow-hidden opacity-0">
        <Clip src={`${A}/film.mp4`} poster={`${A}/film-first.webp`} hook="film-clip" />
        <span data-bar-box className="absolute inset-x-3 bottom-2.5 h-[2px] overflow-hidden rounded-full bg-white/25 opacity-0">
          <span data-bar className="block h-full origin-left bg-white" style={{ transform: "scaleX(0)" }} />
        </span>
      </div>
      <Sticker hook="claim" lines={["One line.", "One film."]} size={36} className="left-[14%] top-[38%] z-[31]" />

      <EndSlate title="Storyboard" />
      <Pointer />
    </Demo>
  );
}
