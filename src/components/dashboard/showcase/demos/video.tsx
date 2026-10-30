"use client";

import { MoveUp, Rotate3d, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/cn";
import { E, type Builder } from "../engine";
import { CHIP, Clip, Demo, EndSlate, GLASS, Img, Pointer, RollSticker, S, Sticker, Tag, finale, onChip, peel, roll, rollAt, slap } from "../kit";

const A = `${S}/video`;
/** Every move starts on the very same frame (the still), so each tap is a match cut. */
const MOVES = [
  { id: "orbit", chip: "Orbit", name: "Orbit", icon: Rotate3d },
  { id: "crane", chip: "Crane", name: "Crane up", icon: MoveUp },
  { id: "push", chip: "Push", name: "Push in", icon: ZoomIn },
  { id: "pull", chip: "Pull", name: "Pull back", icon: ZoomOut },
] as const;
const RATE = 1.5;
const BEAT = 2.3;

/**
 * Video: one still and four camera moves. Each tap snaps back to the same photograph and sends
 * the camera somewhere else: around her, up over the city, in close, out wide.
 */
function script(b: Builder) {
  const p = b.pointer;
  b.set("[data-still]", { o: 1 }, 0);
  b.set("[data-clip-orbit], [data-clip-crane], [data-clip-push], [data-clip-pull]", { o: 0 }, 0);
  // The bar of moves fits the card, however narrow (it's centered, so it shrinks about its middle).
  const fit = Math.min(1, (b.W - 16) / b.box("[data-chips]").w);
  b.set("[data-chips]", { o: 0, y: 14, s: fit }, 0);
  b.set("[data-chip]", { "--on": 0, s: 1 }, 0);
  b.set("[data-seg]", { sx: 0 }, 0);
  b.set("[data-segs]", { o: 0 }, 0);
  b.set("[data-photo-tag]", { o: 0 }, 0);
  rollAt(b, "move", 0);

  b.to("[data-photo-tag]", { o: [0, 1] }, 0.1, 0.3, E.inOut);
  b.to("[data-chips]", { o: [0, 1], y: [14, 0] }, 0.2, 0.45, E.settle);
  const chips = b.$$("[data-chip]");
  const segs = b.$$("[data-seg]");
  p.show(0.45);
  let at = 0.45;
  let prev: string | null = null;
  MOVES.forEach((m, i) => {
    const reach = p.move(b.point(chips[i], at + 0.5), at, i === 0 ? 0.55 : 0.35, { arc: 0.05 });
    b.click(reach);
    b.to(chips[i], { s: [1, 0.86, 1.08, 1] }, reach, 0.34, E.swift);
    b.set(chips[i], { "--on": 1 }, reach + 0.04);
    if (i > 0) b.set(chips[i - 1], { "--on": 0 }, reach + 0.04);
    const t0 = reach + 0.06;
    const last = i === MOVES.length - 1;
    const t1 = last ? t0 + BEAT + 2.4 : t0 + BEAT;
    b.set(`[data-clip-${m.id}]`, { o: 1 }, t0);
    if (prev) b.set(`[data-clip-${prev}]`, { o: 0 }, t0 + 0.02);
    b.video(`[data-clip-${m.id}]`, t0, t1, { rate: last ? 1.15 : RATE });
    b.to(segs[i], { sx: [0, 1] }, t0, BEAT, E.linear);
    if (i === 0) {
      b.set("[data-still]", { o: 0 }, t0 + 0.02);
      b.to("[data-photo-tag]", { o: 0 }, t0, 0.2, E.inOut);
      b.to("[data-segs], [data-move]", { o: [0, 1] }, t0, 0.25, E.inOut);
    }
    roll(b, "move", i, t0, 0.26);
    prev = m.id;
    at = t0 + BEAT - 0.45;
  });
  const done = at + 0.45;
  p.hide(done - 0.3, 0.3);
  b.to("[data-chips]", { o: 0, y: 12 }, done, 0.35, E.leave);
  b.to("[data-segs], [data-move]", { o: 0 }, done, 0.3, E.inOut);
  slap(b, "claim", done + 0.25);
  peel(b, "claim", done + 1.35);
  finale(b, done + 1.5, 1.5);
}

export function VideoDemo() {
  return (
    <Demo name="video" hue="#ff5470" script={script}>
      {MOVES.map((m) => (
        <Clip key={m.id} src={`${A}/${m.id}.mp4`} hook={`clip-${m.id}`} className="opacity-0" />
      ))}
      <Img src={`${A}/first.webp`} hook="still" />
      {/* Story-style progress: one segment per move. */}
      <div data-segs className="absolute inset-x-3 top-2 z-20 flex gap-[3px] opacity-0">
        {MOVES.map((m) => (
          <span key={m.id} className="h-[2px] flex-1 overflow-hidden rounded-full bg-white/30">
            <span data-seg className="block h-full origin-left bg-white" style={{ transform: "scaleX(0)" }} />
          </span>
        ))}
      </div>
      <Tag hook="photo-tag" className="left-3 top-3">
        1 photo
      </Tag>
      <RollSticker hook="move" words={MOVES.map((m) => m.name)} size={19} className="left-3 top-[16px]" />
      <Sticker hook="claim" lines={["Any still.", "Any move."]} size={30} className="left-[10%] top-[36%]" />

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <div data-chips className={cn(GLASS, "flex w-max shrink-0 items-center gap-1 rounded-full p-1 opacity-0")}>
          {MOVES.map(({ id, chip, icon: Icon }) => (
            <span key={id} data-chip className={cn(CHIP, "h-[24px] px-2")} style={onChip}>
              <Icon size={11} strokeWidth={2.4} />
              {chip}
            </span>
          ))}
        </div>
      </div>

      <EndSlate title="Video" />
      <Pointer />
    </Demo>
  );
}
