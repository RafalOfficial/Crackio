"use client";

import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, Num, type Builder } from "../engine";
import { Canvas, Caption, Demo, EndSlate, PRIMARY, Pill, Pointer, S, Tag, finale, roll, rollAt, say } from "../kit";
import { Library } from "./image-library";

const A = `${S}/image`;
/**
 * One woman, one stride, 52 worlds: each changes one word of the prompt. They start with the
 * places she's been in before and end on the Moon, which is where the camera leaves for space.
 */
const WORLDS = [
  ["salt", "salt flats"], ["lavender", "lavender"], ["sahara", "the Sahara"], ["glacier", "Iceland"], ["snow", "first snow"], ["paris", "Paris"],
  ["kyoto", "Kyoto"], ["lagoon", "the Maldives"], ["santorini", "Santorini"], ["aurora", "the aurora"], ["tulips", "tulips"], ["mars", "Mars"],
  ["sunflowers", "sunflowers"], ["uyuni", "Uyuni"], ["clouds", "the clouds"], ["pinksand", "pink sand"], ["poppies", "poppies"], ["meadow", "a meadow"],
  ["venice", "Venice"], ["alps", "the Alps"], ["bali", "Bali"], ["biolum", "glowing tides"], ["coral", "a reef"], ["oasis", "an oasis"],
  ["vineyard", "a vineyard"], ["deadvlei", "Deadvlei"], ["spacestation", "orbit"], ["icecave", "an ice cave"], ["autumn", "autumn"], ["canyon", "the canyon"],
  ["marrakech", "Marrakech"], ["tokyo", "Tokyo"], ["hongkong", "Hong Kong"], ["cyber", "2099"], ["london", "London"], ["library", "the library"],
  ["torii", "Fushimi"], ["havana", "Havana"], ["amalfi", "Amalfi"], ["patagonia", "Patagonia"], ["dubai", "Dubai"], ["greenhouse", "the glasshouse"],
  ["fjord", "a fjord"], ["bamboo", "bamboo"], ["milkyway", "the Milky Way"], ["monument", "Monument Valley"], ["cappadocia", "Cappadocia"], ["bled", "Lake Bled"],
  ["miami", "Miami"], ["waterfall", "the jungle"], ["antelope", "Antelope Canyon"], ["moon", "the Moon"],
].map(([id, word]) => ({ id, word }));

/** The montage speeds up from a beat you can read to a flicker: each gap is shorter than the last. */
const beat = (i: number) => 0.04 + 0.4 * Math.pow(1 - i / (WORLDS.length - 2), 4);

/**
 * Image: one line, one click, and the picture develops. One tap on the place, and the world
 * changes around her, faster and faster, 52 worlds, until the camera pulls out of the last one
 * into a library of every one of them, floating in the dark.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-lib]");
  const lib = b.keep(
    "library",
    () => new Library(WORLDS.map((w) => `${A}/${w.id}.webp`), WORLDS.map((w) => `${A}/${w.id}-t.webp`)),
    (l) => l.dispose(),
  );
  b.ready(lib.ready);
  const develop = new Num(0);
  const push = new Num(1);
  const back = new Num(0);
  const orbit = new Num(0);
  const others = new Num(0);
  const radius = new Num(0);
  const cuts: number[] = [];

  rollAt(b, "prompt", 0);
  // The line starts big in the middle, as big as the card allows.
  const zoom = Math.min(1.35, (b.W - 18) / b.box("[data-prompt]").w);
  b.set("[data-pillcam]", { s: zoom, y: -b.H * 0.36 }, 0);
  b.set("[data-prompt]", { o: 0 }, 0);
  b.set("[data-count]", { o: 0 }, 0);
  b.set("[data-flash]", { o: 0 }, 0);

  // The line, big in the middle of a dark frame; one click.
  b.to("[data-prompt]", { o: [0, 1], y: [10, 0] }, 0.15, 0.5, E.settle);
  p.show(0.35);
  let t = p.move(b.point("[data-go]", 1.0), 0.35, 0.62);
  b.click(t);
  b.to("[data-go]", { s: [1, 0.86, 1] }, t, 0.3, E.swift);

  // The picture develops behind it, and the line drops to its place at the bottom.
  const dev = t + 0.12;
  develop.to(1, dev, 0.85, E.settle);
  b.to("[data-pillcam]", { s: 1, y: 0 }, dev, 0.8, E.glide);
  p.move({ x: 62, y: 96 }, dev + 0.1, 0.75, { arc: 0.04 });

  // One tap on the place: the word rolls, the world cuts, she keeps walking, faster and faster.
  t = p.move(b.point("[data-prompt-slot]", dev + 1.3), dev + 0.9, 0.4);
  b.click(t);
  b.to("[data-prompt-slot]", { s: [1, 1.12, 1] }, t, 0.35, E.pop);
  p.hide(t + 0.35, 0.3);
  b.to("[data-count]", { o: [0, 1] }, t + 0.2, 0.25, E.inOut);
  let at = t + 0.38;
  const m0 = at;
  for (let i = 1; i < WORLDS.length; i++) {
    cuts.push(at);
    const gap = beat(i - 1);
    roll(b, "prompt", i, at - 0.02, Math.min(0.26, Math.max(0.03, gap * 0.7)));
    at += gap;
  }
  const m1 = at;
  push.to(1.16, m0, m1 - m0, E.linear);
  b.text(
    "[data-count-n]",
    [[0, "1"], ...cuts.map((c, i): [number, string] => [c, String(i + 2)])],
  );

  // Out of the Moon and into space: every world she walked through, floating around the last.
  const g = m1 + 0.06;
  b.to("[data-flash]", { o: [0, 0.75, 0] }, g - 0.06, 0.32, E.inOut);
  b.to("[data-prompt]", { o: 0, y: 12 }, g - 0.12, 0.3, E.leave);
  b.to("[data-count]", { o: 0 }, g + 0.9, 0.3, E.inOut);
  push.to(1, g, 0.35, E.inOut);
  back.to(1, g, 2.5, E.glide);
  radius.to(0.035, g, 0.5, E.inOut);
  others.to(1, g + 0.05, 0.6, E.inOut);
  orbit.to(0.62, g + 0.2, 5.2, E.sine);
  const h0 = say(b, "line-b", say(b, "line-a", g + 1.3, 0.12) - 0.05, 0.12);

  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    let hero = 0;
    while (hero < cuts.length && cuts[hero] <= tt) hero++;
    lib.draw(canvas, { hero, develop: develop.at(tt), radius: radius.at(tt), back: back.at(tt), orbit: orbit.at(tt), push: push.at(tt), others: others.at(tt), t: tt });
  });
  finale(b, h0 + 1.1, 1.4);
}

export function ImageDemo() {
  return (
    <Demo name="image" hue="#c6f36b" script={script}>
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_30%,#2a2433_0%,#121016_70%)]" />
      <Canvas hook="lib" />
      <span data-flash className="pointer-events-none absolute inset-0 z-10 bg-white opacity-0" />
      <Tag hook="count" className="left-3 top-3 tabular-nums">
        <span data-count-n>1</span> worlds
      </Tag>
      <Caption hook="line-a" words={["Every", "world,"]} className="ad-serif top-[38%] !text-[27px] !font-normal italic !leading-none" />
      <Caption hook="line-b" words={["one", "line", "away."]} className="ad-serif top-[48%] !text-[27px] !font-normal italic !leading-none" />

      <div data-pillcam className="absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <Pill
          hook="prompt"
          before="Silk dress ·"
          tokens={WORLDS.map((w) => w.word)}
          className="!relative"
          end={
            <span data-go className={cn(PRIMARY, "ml-0.5 size-[26px] shrink-0 !p-0")}>
              <ArrowUp size={13} strokeWidth={2.8} />
            </span>
          }
        />
      </div>

      <EndSlate title="Image" />
      <Pointer />
    </Demo>
  );
}
