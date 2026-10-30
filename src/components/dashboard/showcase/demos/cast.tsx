"use client";

import { E, type Builder } from "../engine";
import {
  Demo,
  EndSlate,
  Img,
  Pill,
  Pointer,
  S,
  Sticker,
  Tag,
  finale,
  peel,
  roll,
  rollAt,
  slap,
} from "../kit";

const A = `${S}/cast`;
/** Every scene is aligned on her eyes, so each cut keeps her face exactly where it was. */
const SCENES = [
  { id: "tokyo", word: "Tokyo rain" },
  { id: "paris", word: "Paris" },
  { id: "seventies", word: "1975" },
  { id: "snow", word: "the Alps" },
  { id: "mars", word: "Mars" },
  { id: "ibiza", word: "Ibiza" },
  { id: "kyoto", word: "Kyoto" },
  { id: "gala", word: "the premiere" },
] as const;
const VIEWS = ["Front", "3/4", "Profile"];
/** Between her eyes: the point the camera leans in on. */
const EYES = { x: 50, y: 35 };

/**
 * Cast: one selfie becomes a character, with a sheet and a name. Then "@maya in …": one word
 * changes and she's somewhere else, cut after cut, the same face in exactly the same place.
 */
function script(b: Builder) {
  const p = b.pointer;
  const scenes = b.$$("[data-scene]");
  rollAt(b, "prompt", 0);
  b.set("[data-cam]", { s: 1, o: 1 }, 0);
  b.set("[data-selfie]", { o: 1, bright: 1 }, 0);
  b.set(scenes, { o: 0, bright: 1 }, 0);
  b.set("[data-scan]", { o: 0, Y: 6 }, 0);
  b.set("[data-tile]", { o: 0, s: 0.3, x: 0, y: 0 }, 0);
  b.set("[data-prompt]", { o: 0, y: 14 }, 0);
  b.set("[data-one]", { o: 0 }, 0);

  // One selfie, read.
  b.to("[data-one]", { o: [0, 1] }, 0.1, 0.3, E.inOut);
  b.to("[data-scan]", { o: [0, 1, 1, 0], Y: [6, 64] }, 0.35, 0.95, E.inOut);

  // It becomes a character: three views fly out of her face, and she gets a name.
  const t0 = 1.35;
  b.to("[data-one]", { o: 0 }, t0, 0.25, E.inOut);
  b.to("[data-selfie]", { bright: 0.42 }, t0, 0.45, E.inOut);
  const tiles = b.$$("[data-tile]");
  tiles.forEach((tile, i) => {
    const box = b.box(tile);
    const dx = (EYES.x / 100) * b.W - (box.x + box.w / 2);
    const dy = (EYES.y / 100) * b.H - (box.y + box.h / 2);
    b.set(tile, { x: dx, y: dy }, 0);
    b.to(
      tile,
      { o: [0, 1], s: [0.3, 1], x: [dx, 0], y: [dy, 0] },
      t0 + 0.05 + i * 0.09,
      0.6,
      E.glide,
    );
  });
  slap(b, "handle", t0 + 0.55);

  // "@maya in Tokyo": the sheet clears, and one word starts sending her places.
  const t1 = t0 + 1.55;
  b.stagger(tiles, { o: 0, y: -18, s: 0.9 }, t1, 0.3, 0.04, E.leave);
  peel(b, "handle", t1);
  b.to("[data-prompt]", { o: 1, y: 0 }, t1 + 0.1, 0.45, E.settle);
  p.show(t1 + 0.1);
  const tap = p.move(b.point("[data-prompt-slot]", t1 + 0.9), t1 + 0.1, 0.55);
  b.click(tap);
  b.to("[data-prompt-slot]", { s: [1, 1.12, 1] }, tap, 0.35, E.pop);
  p.hide(tap + 0.35, 0.3);

  const m0 = tap + 0.2;
  const beat = 0.7;
  b.to("[data-cam]", { s: 1.14 }, m0, beat * SCENES.length + 0.2, E.linear);
  SCENES.forEach((s, i) => {
    const at = m0 + i * beat;
    if (i > 0) roll(b, "prompt", i, at - 0.05, 0.26);
    b.set(scenes[i], { o: 1 }, at);
    b.to(scenes[i], { bright: [1.3, 1] }, at, 0.22, E.settle);
    if (i === 0) b.set("[data-selfie]", { o: 0 }, at + 0.02);
    else b.set(scenes[i - 1], { o: 0 }, at + 0.02);
  });

  // Every place at once: the last scene steps back into a ring of all of them, turning.
  const g = m0 + SCENES.length * beat + 0.05;
  b.to("[data-prompt]", { o: 0, y: 12 }, g - 0.15, 0.35, E.leave);
  b.set("[data-ring3d]", { o: 0, s: 1.6 }, 0);
  b.set("[data-spin]", { "--a": 0 }, 0);
  b.to("[data-cam]", { s: 0.42, o: 0 }, g, 0.55, E.glide);
  b.to("[data-ring3d]", { o: [0, 1], s: [1.6, 1] }, g + 0.05, 0.6, E.glide);
  b.to("[data-spin]", { "--a": -250 }, g + 0.05, 3.4, E.inOut);
  // Her name above the ring, the line below it: nothing sits on the pictures.
  slap(b, "handle-top", g + 0.55);
  slap(b, "claim", g + 1.25);
  peel(b, "claim", g + 2.5);
  peel(b, "handle-top", g + 2.5);
  finale(b, g + 2.6, 1.4);
}

export function CastDemo() {
  return (
    <Demo name="cast" hue="var(--color-tool-cast)" script={script}>
      <div
        data-cam
        className="absolute inset-0"
        style={{ transformOrigin: `${EYES.x}% ${EYES.y}%` }}
      >
        <Img src={`${A}/selfie.webp`} hook="selfie" />
        {SCENES.map((s) => (
          <Img
            key={s.id}
            src={`${A}/${s.id}.webp`}
            hook="scene"
            className="opacity-0"
          />
        ))}
      </div>
      <div data-ring3d className="pointer-events-none absolute inset-0 opacity-0" style={{ perspective: "560px" }}>
        <div
          data-spin
          className="absolute left-1/2 top-[44%] size-0"
          style={{ transformStyle: "preserve-3d", transform: "rotateX(-9deg) rotateY(calc(var(--a, 0) * 1deg))" }}
        >
          {SCENES.map((s, i) => (
            <div
              key={s.id}
              className="absolute -left-[46px] -top-[57px] h-[114px] w-[92px] overflow-hidden rounded-[10px] shadow-[0_14px_26px_-10px_rgb(0_0_0/0.8)]"
              style={{ transform: `rotateY(${(i - (SCENES.length - 1)) * 45}deg) translateZ(118px)`, backfaceVisibility: "hidden" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${A}/${s.id}-sm.webp`} alt="" className="size-full object-cover" />
            </div>
          ))}
        </div>
      </div>
      <span
        data-scan
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] bg-white opacity-0 shadow-[0_0_14px_5px_rgb(255_121_184/0.75),0_0_2px_1px_white]"
      />
      <Tag hook="one" className="left-3 top-3">
        1 selfie
      </Tag>

      {/* The character sheet: her three views, from the one photo. */}
      <div className="pointer-events-none absolute inset-x-3 top-[46%] z-20 grid grid-cols-3 gap-1.5">
        {VIEWS.map((v, i) => (
          <div
            key={v}
            data-tile
            className="relative overflow-hidden rounded-[9px] bg-[#e9e6e2] opacity-0 shadow-[0_12px_28px_-10px_rgb(0_0_0/0.8)]"
          >
            <div
              className="aspect-[3/4] w-full"
              style={{
                backgroundImage: `url(${A}/sheet.webp)`,
                backgroundSize: "300% auto",
                backgroundPosition: `${i * 50}% 40%`,
              }}
            />
            <span className="ad-label absolute bottom-1 left-1 rounded-[3px] bg-black/60 px-1 py-[2px] text-[7.5px] text-white">
              {v}
            </span>
          </div>
        ))}
      </div>
      <Sticker
        hook="handle"
        lines={["@maya"]}
        size={36}
        className="left-[9%] top-[22%]"
      />
      <Sticker hook="handle-top" lines={["@maya"]} size={30} className="left-[26%] top-[5%]" />
      <Sticker
        hook="claim"
        lines={["One face.", "Every scene."]}
        size={26}
        className="left-[13%] top-[73%]"
      />

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <Pill
          hook="prompt"
          before={
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-[rgb(255_121_184/0.18)] py-[2px] pl-[2px] pr-1.5 text-[10.5px] font-bold text-[#ffb3d6] shadow-[inset_0_0_0_1px_rgb(255_121_184/0.4)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${A}/avatar.webp`}
                  alt=""
                  className="size-[18px] rounded-full object-cover"
                />
                @maya
              </span>
              <span className="ml-1">in</span>
            </>
          }
          tokens={SCENES.map((s) => s.word)}
          className="!relative pr-2"
        />
      </div>

      <EndSlate title="Cast" />
      <Pointer />
    </Demo>
  );
}
