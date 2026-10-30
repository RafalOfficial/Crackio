"use client";

import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Pause, Play } from "lucide-react";
import { toolBySlug, type ToolSlug } from "@/lib/tools";
import { AppIcon, ToolTile } from "@/components/ui/ToolTile";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { S, useShowcase } from "./showcase/kit";
import { Showcase } from "./showcase/engine";
import { AD_FONTS } from "./showcase/fonts";
import { AnglesDemo, CastDemo, DirectorDemo, ImageDemo, MotionDemo, ProductDemo, RecastDemo, RelightDemo, RetouchDemo, StoryboardDemo, UpscaleDemo, VideoDemo } from "./showcase/demos";
import { onOverlay, overlayOpen } from "@/lib/hooks/use-overlay";

/** What opening a demo hands its tool, so you start from the very picture (or words) in the film. */
type Start = { photo: string; name: string; prompt?: string } | { prompt: string; aspect?: string };

type RailItem = { name: string; href: string; caption: string; mark: ReactNode; Demo: ComponentType; start?: Start };

const tool = (slug: ToolSlug, caption: string, Demo: ComponentType, start?: Start): RailItem => {
  const t = toolBySlug(slug)!;
  return { name: t.name, href: t.href, caption, mark: <ToolTile icon={t.icon} glyph={t.glyph} hue={t.hue} size={20} />, Demo, start };
};
const page = (name: string, href: string, glyph: string, caption: string, Demo: ComponentType, start?: Start): RailItem => ({
  name,
  href,
  caption,
  mark: <AppIcon glyph={glyph} size={20} />,
  Demo,
  start,
});

const TRY = `${S}/try`;

const DEMOS: RailItem[] = [
  page("Image", "/create", "/icons/image.png", "Change a word, change the world", ImageDemo, { prompt: "A woman in a flowing saffron-yellow silk dress walking across pink salt flats at sunrise", aspect: "4:5" }),
  tool("director", "Stage it, then shoot it", DirectorDemo, { photo: `${TRY}/director.webp`, name: "Woman in a white linen dress", prompt: "She stands by a red 1960s coupe on an empty desert highway at golden hour" }),
  tool("retouch", "Point, say it, done", RetouchDemo, { photo: `${TRY}/retouch.webp`, name: "Café portrait" }),
  page("Video", "/video", "/icons/video.png", "Any still, any camera move", VideoDemo, { photo: `${TRY}/video.webp`, name: "Rooftop in Marrakech" }),
  tool("relight", "Move the light", RelightDemo, { photo: `${TRY}/relight.webp`, name: "Studio portrait" }),
  tool("cast", "One face, every shot", CastDemo),
  tool("angles", "Every angle from one photo", AnglesDemo, { photo: `${TRY}/angles.webp`, name: "Red coupe" }),
  tool("motion", "An ad from one sentence", MotionDemo),
  tool("product", "Any scene, every placement", ProductDemo, { photo: `${TRY}/product.webp`, name: "Perfume packshot" }),
  tool("recast", "Same motion, new look", RecastDemo),
  tool("storyboard", "From idea to film", StoryboardDemo),
  tool("upscale", "From a speck to every hair", UpscaleDemo, { photo: `${TRY}/upscale.webp`, name: "Deer at dawn (a 144 px crop)" }),
];

function handOff(start?: Start) {
  if (!start) return;
  const references = "photo" in start ? [{ url: start.photo, name: start.name }] : [];
  useHandoff.getState().send({ prompt: start.prompt ?? "", references, aspect: "aspect" in start ? start.aspect : undefined, from: "showcase" });
}

/** Space between cards, and how long each card's worth of rail takes to drift by. */
const GAP = 20;
const PER_CARD = 15_000;
/** Where the first card sits when the rail starts. */
const TOP = 16;
/** Where the drift was when Home was last left, so coming back picks up there rather than at the top. */
let resumeAt: number | null = null;

/**
 * Drift the cards up the rail forever and play each one exactly while it's in view.
 *
 * Every demo exists once: each card runs its own copy of one compositor animation (from just
 * below the bottom of the loop to just above the top, phase-shifted by its place in the list),
 * so a card wraps around while it's out of sight and the rail never needs a second set. Where a
 * card is follows from its animation's clock, so each frame tells, without touching layout,
 * which cards show any pixel (they play), which are about to come up from below (they load and
 * draw their first frame), and which are away (they stop and start over next time).
 */
function useDrift(mask: React.RefObject<HTMLDivElement | null>, aside: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const box = mask.current;
    const rail = aside.current;
    if (!box || !rail) return;
    const cards = Array.from(box.querySelectorAll<HTMLElement>("[data-rail-card]"));
    const stages = cards.map((c) => c.querySelector<HTMLElement>("[data-demo]"));
    const N = cards.length;
    if (!N) return;
    const D = N * PER_CARD;
    let H = 0;
    let P = 0;
    let L = 0;
    let stageH = 0;
    let hover = false;
    let anims: Animation[] = [];
    const state: string[] = new Array(N).fill("");
    const progress = (a: Animation) => {
      const ct = Number(a.currentTime ?? 0);
      return (((ct / D) % 1) + 1) % 1;
    };

    const motion = () => {
      const still = hover || useShowcase.getState().paused || overlayOpen();
      for (const a of anims) {
        if (still && a.playState === "running") a.pause();
        else if (!still && a.playState === "paused") a.play();
      }
    };

    const layout = () => {
      const h = box.clientHeight;
      const p = cards[0].offsetHeight + GAP;
      if (!h || p <= GAP) {
        H = 0;
        wake();
        return;
      }
      // Keep the rail where it is through a resize, and where it was when Home was last left.
      const phase = anims.length ? progress(anims[0]) - (N - 1) / N : (resumeAt ?? -TOP / (N * p));
      H = h;
      P = p;
      L = N * P;
      stageH = stages[0]?.offsetHeight ?? P - GAP;
      anims.forEach((a) => a.cancel());
      anims = cards.map((c, i) => {
        const a = c.animate([{ transform: `translate3d(0,${L - P}px,0)` }, { transform: `translate3d(0,${-P}px,0)` }], { duration: D, iterations: Infinity, easing: "linear" });
        a.currentTime = (((((N - 1 - i) / N + phase) % 1) + 1) % 1) * D;
        return a;
      });
      motion();
      wake();
    };

    let raf = 0;
    // Runs while the rail is laid out. Below xl it isn't: one last pass stops every card, then it rests.
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const tick = () => {
      raf = H ? requestAnimationFrame(tick) : 0;
      const hold = useShowcase.getState().paused || document.hidden || overlayOpen();
      for (let i = 0; i < N; i++) {
        const stage = stages[i];
        const a = anims[i];
        let s = "off";
        if (a && H && stage) {
          const y = L - P - L * progress(a);
          if (y < H && y + stageH > 0) s = hold ? "hold" : "on";
          else if (y >= H && y < H + P * 1.25) s = "near";
        }
        if (s === state[i]) continue;
        const ctl = stage && Showcase.controls(stage);
        if (!ctl) continue;
        state[i] = s;
        if (s === "on") ctl.play(true);
        else if (s === "hold") ctl.play(false, { hold: true });
        else {
          ctl.play(false);
          if (s === "near") ctl.warm();
        }
      }
    };

    const ro = new ResizeObserver(layout);
    ro.observe(box);
    ro.observe(cards[0]);
    const enter = () => {
      hover = true;
      motion();
    };
    const leave = () => {
      hover = false;
      motion();
    };
    rail.addEventListener("pointerenter", enter);
    rail.addEventListener("pointerleave", leave);
    const unsub = useShowcase.subscribe(motion);
    // Under the model library the rail holds still (its glass would redraw every frame of the drift).
    const offOverlay = onOverlay(() => {
      motion();
      wake();
    });
    layout();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      rail.removeEventListener("pointerenter", enter);
      rail.removeEventListener("pointerleave", leave);
      unsub();
      offOverlay();
      if (anims.length) resumeAt = progress(anims[0]) - (N - 1) / N;
      anims.forEach((a) => a.cancel());
    };
  }, [mask, aside]);
}

/**
 * The dashboard's right edge: every tool, shown working in a short film, drifting by on an
 * endless loop. Hover pauses the drift; the button pauses everything. Opening one starts the
 * tool from the film's own picture, so you can make the same change yourself.
 */
export function ShowcaseRail() {
  const { paused, toggle } = useShowcase();
  const mask = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  useDrift(mask, aside);
  return (
    <aside
      ref={aside}
      data-rail
      aria-label="What each tool does"
      data-paused={paused || undefined}
      className={`rail motion-always ${AD_FONTS} fixed inset-y-0 right-0 z-20 hidden w-[248px] border-l border-line bg-stage xl:block 2xl:w-[288px]`}
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-4">
        <span className="label">See it work</span>
        <button
          onClick={toggle}
          className="grid size-7 place-items-center rounded-full text-fog transition-colors hover:bg-white/[0.06] hover:text-paper"
          aria-label={paused ? "Play the tool demos" : "Pause the tool demos"}
          title={paused ? "Play" : "Pause"}
        >
          {paused ? <Play size={13} className="translate-x-px" /> : <Pause size={13} />}
        </button>
      </div>
      <div ref={mask} className="relative h-[calc(100%-3rem)] overflow-hidden">
        {DEMOS.map(({ name, href, caption, mark, Demo, start }, i) => (
          <Link
            key={name}
            href={href}
            onClick={() => handOff(start)}
            data-rail-card
            className="group absolute inset-x-4 top-0 block"
            // Where it starts, before the drift takes over (its own height plus the gap, per place).
            style={{ transform: `translateY(calc(${i} * (100% + ${GAP}px) + ${TOP}px))` }}
          >
            <Demo />
            <div className="mt-2.5 flex items-center gap-2 px-0.5">
              {mark}
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-tight">{name}</span>
                <span className="block truncate text-[11px] text-haze">{caption}</span>
              </span>
              <span className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2.5 text-[11.5px] font-semibold text-paper transition-colors group-hover:bg-spike group-hover:text-spike-ink">
                Try
                <ArrowUpRight size={12} />
              </span>
            </div>
          </Link>
        ))}
        {/* The rail's soft top and bottom edges: the background drawn over the cards, not a CSS mask. Under a mask, Safari
            stopped drawing parts of a card as it glided through the faded edge (a toolbar gone until it next moved). */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[7%] bg-gradient-to-b from-stage to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[7%] bg-gradient-to-t from-stage to-transparent" />
      </div>
    </aside>
  );
}
