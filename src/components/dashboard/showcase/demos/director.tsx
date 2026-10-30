"use client";

import { Camera, Hand, Rotate3d, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, Num, type Builder, type Ease, type Pt } from "../engine";
import { Canvas, Clip, Demo, EndSlate, GLASS, PRIMARY, Pointer, S, Sticker, Tag, finale, peel, slap } from "../kit";
import { ITEMS, PHOTO_FOV, Stage, type Cam, type ItemId, type Piece, type StageState, type V3 } from "./director-stage";

const A = `${S}/director`;
const HUE = "#ff5b2e";

/** Where the cast stands, as points of the location photo (u across, v up). */
const CAR = { u: 0.58, v: 0.33 };
const START = { u: 0.24, v: 0.2 };
const MARK = { u: 0.4, v: 0.255 };
/** The car lands showing its back, and is turned to show its front three-quarter (degrees round from its nose). */
const CAR_LANDS = 165;
const CAR_TURNED = 40;

/**
 * Director: one photo of a place becomes a 3D set. Maya and the car drop into it; she's walked to
 * her mark, the car is turned to face the lens, the camera goes to the hero shot, and Render turns
 * that exact set into the photograph, which comes to life.
 */
function script(b: Builder) {
  const p = b.pointer;
  const canvas = b.$<HTMLCanvasElement>("[data-set]");
  const stage = b.keep("stage", () => new Stage(HUE), (s) => s.dispose());
  // The cast stands on the set's depth, so the film is planned again once it has loaded.
  b.ready(stage.ready, !stage.grounded);

  // Cameras: the photo's own, the staging view, and the hero shot (from the photo's own spot, so the set is the photo).
  const PHOTO: Cam = { eye: [0, 0, 0], at: [0, 0, -1], fov: PHOTO_FOV };
  // Between her mark and the car, a little above the ground.
  const target = (): V3 => {
    const c = stage.where(CAR.u, CAR.v);
    const w = stage.where(MARK.u, MARK.v);
    return [(c[0] + w[0]) / 2, (c[1] + w[1]) / 2 + 0.9, (c[2] + w[2]) / 2];
  };
  // A small step off the photo's spot is enough to see the place has depth (any further and its edges show).
  const STAGING = (): Cam => {
    const t = target();
    return { eye: [0, 1.05, 0.25], at: [t[0], t[1] - 0.6, t[2]], fov: 54 };
  };
  const HERO = (): Cam => {
    const t = target();
    // Turned only a little from the photo's own direction, so the frame never runs past the picture.
    return { eye: [0, 0, 0], at: [t[0], -Math.tan(0.03) * Math.abs(t[2]), t[2]], fov: 44 };
  };
  const cam = { ex: new Num(PHOTO.eye[0]), ey: new Num(PHOTO.eye[1]), ez: new Num(PHOTO.eye[2]), ax: new Num(PHOTO.at[0]), ay: new Num(PHOTO.at[1]), az: new Num(PHOTO.at[2]), fov: new Num(PHOTO.fov) };
  const fly = (to: Cam, t0: number, dur: number, e: Ease = E.glide) => {
    cam.ex.to(to.eye[0], t0, dur, e);
    cam.ey.to(to.eye[1], t0, dur, e);
    cam.ez.to(to.eye[2], t0, dur, e);
    cam.ax.to(to.at[0], t0, dur, e);
    cam.ay.to(to.at[1], t0, dur, e);
    cam.az.to(to.at[2], t0, dur, e);
    cam.fov.to(to.fov, t0, dur, e);
    return t0 + dur;
  };
  const camAt = (t: number): Cam => ({ eye: [cam.ex.at(t), cam.ey.at(t), cam.ez.at(t)], at: [cam.ax.at(t), cam.ay.at(t), cam.az.at(t)], fov: cam.fov.at(t) });

  const inflate = new Num(0);
  const grid = new Num(0);
  const pieces = Object.fromEntries(
    ITEMS.map((id) => [id, { u: new Num(id === "car" ? CAR.u : START.u), v: new Num(id === "car" ? CAR.v : START.v), o: new Num(0), drop: new Num(0), reveal: new Num(0), s: new Num(1), sy: new Num(1) }]),
  ) as Record<ItemId, Record<keyof Piece, Num>>;
  const carYaw = new Num(CAR_LANDS);
  const ring = { ids: [] as { t: number; id: ItemId }[], o: new Num(0) };
  const turn = { o: new Num(0), a: new Num(0.5) };
  const dust = new Num(-1);
  const dissolve = new Num(0);
  const stateAt = (t: number): StageState => {
    let id: ItemId = "woman";
    for (const r of ring.ids) if (t >= r.t) id = r.id;
    const pc = (i: ItemId) => {
      const q = pieces[i];
      return { u: q.u.at(t), v: q.v.at(t), o: q.o.at(t), drop: q.drop.at(t), reveal: q.reveal.at(t), s: q.s.at(t), sy: q.sy.at(t) };
    };
    return {
      cam: camAt(t),
      inflate: inflate.at(t),
      grid: grid.at(t),
      pieces: { woman: pc("woman"), car: pc("car") },
      carYaw: carYaw.at(t),
      ring: { id, o: ring.o.at(t) },
      turn: { o: turn.o.at(t), a: turn.a.at(t) },
      dust: dust.at(t),
      dissolve: dissolve.at(t),
      center: [0.42, 0.36],
    };
  };
  const on = (pt: V3, t: number): Pt => Stage.project(pt, camAt(t));
  const chest = (t: number): V3 => {
    const w = stage.where(pieces.woman.u.at(t), pieces.woman.v.at(t));
    return [w[0], w[1] + 1.15, w[2]];
  };

  b.set("[data-tag-photo], [data-tag-set], [data-tag-hero], [data-tag-render], [data-bar], [data-life]", { o: 0 }, 0);
  b.set("[data-bar]", { y: 14 }, 0);
  b.set("[data-piece-tag]", { o: 0, s: 0.7 }, 0);

  // ── One photo of a place … ────────────────────────────────────────────────────────────────
  b.to("[data-tag-photo]", { o: [0, 1] }, 0.15, 0.3, E.inOut);
  // … becomes a 3D set: the camera leaves the photo's spot and the place is built from the bottom up.
  inflate.to(1, 0.7, 1.5, E.inOut);
  grid.to(1, 1.4, 0.6, E.inOut);
  fly(STAGING(), 1.3, 1.9, E.glide);
  b.to("[data-tag-photo]", { o: 0 }, 1.05, 0.25, E.inOut);
  b.to("[data-tag-set]", { o: [0, 1] }, 1.3, 0.3, E.inOut);

  // The cast drops in: the car lands with a puff of dust, Maya materializes.
  const land = 2.55;
  pieces.car.o.set(1, land - 0.42);
  pieces.car.drop.set(1, land - 0.42);
  pieces.car.drop.to(0, land - 0.42, 0.42, (x) => x * x);
  pieces.car.reveal.set(1, land - 0.42);
  pieces.car.sy.to(0.9, land, 0.08, E.linear);
  pieces.car.sy.to(1, land + 0.08, 0.3, E.settle);
  dust.set(0, land);
  dust.to(1, land, 0.7, E.settle);
  dust.set(-1, land + 0.71);
  pieces.woman.o.set(1, land + 0.1);
  pieces.woman.reveal.to(1, land + 0.1, 0.6, E.inOut);
  const tags = b.$$("[data-piece-tag]");
  tags.forEach((el, i) => {
    b.to(el, { o: [0, 1], s: [0.7, 1] }, i === 0 ? land + 0.5 : land + 0.05, 0.3, E.pop);
    b.to(el, { o: 0 }, 4.1 + i * 0.05, 0.25, E.inOut);
  });

  // ── Direct it ─────────────────────────────────────────────────────────────────────────────
  b.to("[data-bar]", { o: [0, 1], y: [14, 0] }, 3.0, 0.4, E.settle);
  const tools = b.$$("[data-tool]");
  const toolOn = (i: number, t0: number, t1: number) => {
    b.set(tools[i], { "--on": 0 }, 0);
    b.to(tools[i], { "--on": 1 }, t0, 0.15, E.inOut);
    b.to(tools[i], { "--on": 0 }, t1, 0.2, E.inOut);
  };
  p.show(3.1);
  // 1 · Walk her to her mark beside the car.
  let t = p.move(on(chest(3.75), 3.75), 3.15, 0.55);
  ring.ids.push({ t: t - 0.05, id: "woman" });
  ring.o.to(1, t - 0.05, 0.18, E.settle);
  toolOn(0, t - 0.05, t + 0.85);
  const w0 = t + 0.06;
  pieces.woman.u.to(MARK.u, w0, 0.75, E.inOut);
  pieces.woman.v.to(MARK.v, w0, 0.75, E.inOut);
  p.hold(w0 - 0.05, w0 + 0.75);
  const walk: Pt[] = [];
  for (let i = 0; i <= 12; i++) walk.push(on(chest(w0 + (0.75 * i) / 12), w0 + (0.75 * i) / 12));
  p.path(walk, w0, 0.75, E.linear);
  t = w0 + 0.75;
  ring.o.to(0, t + 0.1, 0.25, E.inOut);

  // 2 · Turn the car to face the lens.
  const carAt = stage.where(CAR.u, CAR.v);
  const a0 = turn.a.at(0);
  const a1 = a0 + 2.3;
  const handle = (a: number, tt: number) => on(Stage.handleAt(carAt, a), tt);
  t = p.move(handle(a0, t + 0.5), t + 0.12, 0.38, { arc: 0.08 });
  ring.ids.push({ t: t - 0.1, id: "car" });
  turn.o.to(1, t - 0.12, 0.2, E.settle);
  toolOn(1, t - 0.1, t + 0.9);
  const r0 = t + 0.06;
  turn.a.to(a1, r0, 0.8, E.inOut);
  carYaw.to(CAR_TURNED, r0, 0.8, E.inOut);
  p.hold(r0 - 0.05, r0 + 0.8);
  const spin: Pt[] = [];
  for (let i = 0; i <= 14; i++) spin.push(handle(a0 + (a1 - a0) * E.inOut(i / 14), r0 + (0.8 * i) / 14));
  p.path(spin, r0, 0.8, E.linear);
  t = r0 + 0.8;
  turn.o.to(0, t + 0.1, 0.25, E.inOut);

  // 3 · The hero shot: back to the photo's own spot, a longer lens. The set reads as a photograph again.
  t = p.move(b.point(tools[2], t + 0.5), t + 0.15, 0.36, { arc: 0.06 });
  b.click(t);
  b.to(tools[2], { s: [1, 0.85, 1] }, t, 0.3, E.swift);
  toolOn(2, t, t + 0.9);
  const h0 = t + 0.05;
  fly(HERO(), h0, 1.05, E.glide);
  grid.to(0, h0, 0.7, E.inOut);
  b.to("[data-tag-set]", { o: 0 }, h0, 0.25, E.inOut);
  b.to("[data-tag-hero]", { o: [0, 1] }, h0 + 0.5, 0.3, E.inOut);

  // 4 · Render: the set burns into the photograph, from her outward, and then it's alive.
  const go = b.$("[data-render]");
  t = p.move(b.point(go, h0 + 1.3), h0 + 0.85, 0.42, { arc: 0.06 });
  b.click(t);
  b.to(go, { s: [1, 0.88, 1] }, t, 0.3, E.swift);
  p.hide(t + 0.25, 0.25);
  b.to("[data-bar], [data-tag-hero]", { o: 0 }, t + 0.15, 0.3, E.inOut);
  const d0 = t + 0.2;
  dissolve.to(1, d0, 1.25, E.inOut);
  const live = d0 + 1.3;
  b.set("[data-life]", { o: 1 }, live);
  b.video("[data-life-clip]", live, live + 6);
  b.to("[data-tag-render]", { o: [0, 1] }, live - 0.1, 0.3, E.inOut);
  slap(b, "claim", live + 2.1);
  peel(b, "claim", live + 3.3);
  b.to("[data-tag-render]", { o: 0 }, live + 3.2, 0.3, E.inOut);

  // The labels follow their pieces; the set is drawn every frame.
  b.track((t0) => {
    const tt = t0 >= b.seam ? 0 : t0;
    const st = stateAt(tt);
    stage.draw(canvas, st);
    tags.forEach((el, i) => {
      const id = ITEMS[i];
      const q = st.pieces[id];
      const base = stage.where(q.u, q.v);
      const top = on([base[0], base[1] + (id === "car" ? 1.5 : 1.85) + q.drop * 3.2, base[2]], tt);
      // On the tag's 0×0 holder: percentages on the tag itself would be of nothing.
      const at = el.parentElement!.style;
      at.left = `${top.x.toFixed(2)}%`;
      at.top = `${top.y.toFixed(2)}%`;
    });
  });
  if (process.env.NODE_ENV !== "production") {
    const w = window as unknown as { __stageState?: typeof stateAt; __renders?: number[] };
    w.__stageState = stateAt;
    w.__renders = [d0 - 0.01];
  }
  finale(b, live + 3.4, 1.35);
}

export function DirectorDemo() {
  return (
    <Demo name="director" hue="var(--color-tool-director)" script={script}>
      <Canvas hook="set" />
      {ITEMS.map((id) => (
        <span key={id} className="pointer-events-none absolute left-0 top-0 z-10 h-0 w-0">
          <span data-piece-tag className="ad-label absolute bottom-1 left-1/2 block -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-1.5 py-[3px] text-[7.5px] text-white opacity-0 ring-1 ring-white/15">
            {id === "woman" ? "Maya" : "Coupe ’64"}
          </span>
        </span>
      ))}
      {/* The render, alive. */}
      <div data-life className="absolute inset-0 z-[12] opacity-0">
        <Clip src={`${A}/render.mp4`} poster={`${A}/render.webp`} hook="life-clip" />
      </div>
      <Tag hook="tag-photo" className="left-3 top-3 z-[15]">
        1 photo
      </Tag>
      <Tag hook="tag-set" className="left-3 top-3 z-[15]">
        3D set
      </Tag>
      <Tag hook="tag-hero" className="left-3 top-3 z-[15]">
        Hero · 35mm
      </Tag>
      <Tag hook="tag-render" tone="hue" className="left-3 top-3 z-[15]">
        Render
      </Tag>

      {/* Director's toolbar: move, turn, camera, and Render. */}
      <div data-bar className={cn(GLASS, "absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit items-center gap-[3px] rounded-full p-[4px] opacity-0")}>
        {[Hand, Rotate3d, Camera].map((Icon, i) => (
          <span
            key={i}
            data-tool
            className="grid size-[24px] place-items-center rounded-full"
            style={{ background: "color-mix(in oklab, white calc(var(--on, 0) * 92%), rgb(255 255 255 / 0.08))", color: "color-mix(in oklab, #16131b calc(var(--on, 0) * 100%), rgb(255 255 255 / 0.85))" }}
          >
            <Icon size={12} strokeWidth={2.3} />
          </span>
        ))}
        <span data-render className={cn(PRIMARY, "ml-[3px] h-[24px] px-2.5 text-[10.5px]")}>
          <Sparkles size={11} strokeWidth={2.6} />
          Render
        </span>
      </div>

      <Sticker hook="claim" lines={["Stage it.", "Shoot it."]} size={28} className="left-[9%] top-[8%] z-[15]" />
      <EndSlate title="Director" />
      <Pointer />
    </Demo>
  );
}

// In development, render clean frames of the set at any moment (the layout guide for the render).
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __stage: (t: number, w: number, h: number) => Promise<string> }).__stage = (t, w, h) => {
    const c = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.style.cssText = `position:fixed;left:-9999px;top:0;width:${w / dpr}px;height:${h / dpr}px`;
    document.body.appendChild(c);
    const run = (window as unknown as { __stageState?: (t: number) => StageState }).__stageState;
    const stage = new Stage(HUE);
    return new Promise<string>((done) => {
      void stage.ready.then(() => {
        // The depth is read off the GPU's copy a moment after it loads; the cast stands on it.
        setTimeout(() => {
          if (run) stage.draw(c, { ...run(t), dissolve: 0 });
          done(c.toDataURL("image/png"));
          stage.dispose();
          c.remove();
        }, 300);
      });
    });
  };
}
