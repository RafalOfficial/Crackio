"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { create } from "zustand";
import { cn } from "@/lib/cn";
import { E, Showcase, type Builder, type Script } from "./engine";

/**
 * Building blocks for the dashboard's showcase: each demo is a short ad (a hook, one action, the
 * payoff, a claim, the lockup) made of real frames, clips, three.js and a miniature of Crackio's
 * UI, played by the engine (./engine) from the card's real layout.
 */

/** Pause every demo (and the rail's drift) at once. */
export const useShowcase = create<{ paused: boolean; toggle: () => void }>((set) => ({
  paused: false,
  toggle: () => set((s) => ({ paused: !s.paused })),
}));

export const S = "/assets/showcase";

/**
 * The card. In the rail, the rail plays it while any of it is in view (ShowcaseRail); anywhere
 * else it watches the viewport itself. `hue` is the tool's color: stickers and the lockup wear it.
 */
export function Demo({ name, hue, script, children, className }: { name: string; hue: string; script: Script; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scriptRef = useRef(script);
  useEffect(() => {
    scriptRef.current = script;
  });

  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    const run = Showcase.mount(name, stage, (b) => scriptRef.current(b));
    const ro = new ResizeObserver(() => run.resize());
    ro.observe(stage);
    if (stage.closest("[data-rail]")) {
      return () => {
        ro.disconnect();
        run.dispose();
      };
    }
    let seen = false;
    const sync = () => {
      const hold = useShowcase.getState().paused || document.hidden;
      run.play(seen && !hold, { hold });
    };
    // Any pixel in view plays it; half a screen away it gets ready.
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      sync();
    });
    const near = new IntersectionObserver(([e]) => e.isIntersecting && run.warm(), { rootMargin: "50% 0px" });
    io.observe(stage);
    near.observe(stage);
    const unsub = useShowcase.subscribe(sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      near.disconnect();
      ro.disconnect();
      unsub();
      document.removeEventListener("visibilitychange", sync);
      run.dispose();
    };
  }, [name]);

  return (
    <div
      ref={ref}
      data-demo={name}
      aria-hidden="true"
      className={cn("relative isolate aspect-[4/5] overflow-hidden rounded-[14px] bg-[#0f0d13] select-none", className)}
      style={{ "--hue": hue } as CSSProperties}
    >
      {children}
      {/* The loop's seam: a curtain in the tool's color, while the film resets underneath (see finale). */}
      <span
        data-wipe
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[45] opacity-0"
        style={{ background: "radial-gradient(120% 90% at 20% 100%, color-mix(in oklab, var(--hue) 70%, #0f0d13), color-mix(in oklab, var(--hue) 28%, #0f0d13) 70%)" }}
      />
      {/* The hairline sits inside, on top: the rail clips anything drawn outside a card. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 rounded-[inherit] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" />
    </div>
  );
}

/** A full-bleed picture. `hook` names it for the script (`[data-<hook>]`). */
export function Img({ src, hook, className, style, alt = "" }: { src: string; hook?: string; className?: string; style?: CSSProperties; alt?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...(hook ? { [`data-${hook}`]: "" } : {})}
      src={src}
      alt={alt}
      draggable={false}
      decoding="async"
      className={cn("pointer-events-none absolute inset-0 size-full object-cover", className)}
      style={style}
    />
  );
}

/** A muted clip that the script plays (`b.video`) or scrubs (`b.scrub`). */
export function Clip({ src, hook, poster, className, style }: { src: string; hook: string; poster?: string; className?: string; style?: CSSProperties }) {
  return (
    <video
      {...{ [`data-${hook}`]: "" }}
      src={src}
      poster={poster}
      muted
      playsInline
      preload="none"
      disablePictureInPicture
      className={cn("pointer-events-none absolute inset-0 size-full object-cover", className)}
      style={style}
    />
  );
}

/** A canvas the script draws into (three.js scenes and living photos, through ./gl). */
export function Canvas({ hook, className, style }: { hook: string; className?: string; style?: CSSProperties }) {
  return <canvas {...{ [`data-${hook}`]: "" }} className={cn("pointer-events-none absolute inset-0 size-full", className)} style={style} />;
}

/**
 * The pointer: a crisp arrow whose tip is exactly the point the script aims at, and two rings
 * that bloom from that tip on a click.
 */
export function Pointer() {
  return (
    <>
      {[0, 1].map((i) => (
        <span key={i} data-ring className="pointer-events-none absolute left-0 top-0 z-40 -ml-[18px] -mt-[18px] size-[36px] rounded-full border-[1.5px] border-white/90 opacity-0 shadow-[0_0_12px_rgb(255_255_255/0.35)]" />
      ))}
      <div data-cursor className="pointer-events-none absolute left-0 top-0 z-40 origin-top-left opacity-0">
        <svg width="19" height="25" viewBox="0 0 17 22" className="-ml-[1.8px] -mt-[1.8px] block drop-shadow-[0_3px_5px_rgb(0_0_0/0.55)]" aria-hidden="true">
          <path d="M1.6 1.6 L1.6 17.4 L5.7 13.6 L8.5 20 L11.3 18.8 L8.6 12.5 L14.2 12.5 Z" fill="#fff" stroke="#0d0b10" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
}

/** Smoked glass: Crackio's panels, floating over a picture. */
export const GLASS =
  "border border-white/[0.12] bg-[linear-gradient(180deg,rgb(38_33_46/0.84),rgb(20_17_26/0.88))] shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_14px_30px_-12px_rgb(0_0_0/0.75)]";

/** A pill the pointer can press. */
export const CHIP = "inline-flex h-[24px] items-center gap-1 whitespace-nowrap rounded-full bg-white/[0.1] px-2.5 text-[10.5px] font-semibold text-white/90";

/** The orange button. */
export const PRIMARY =
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full bg-spike font-bold text-spike-ink shadow-[inset_0_-2px_0_var(--color-spike-lip),inset_0_1px_0_rgb(255_255_255/0.28),0_6px_16px_-6px_rgb(255_91_46/0.75)]";

/** A selected-or-not chip: white when `--on` is 1 (the script flips it). */
export const onChip: CSSProperties = {
  background: "color-mix(in oklab, white calc(var(--on, 0) * 94%), rgb(255 255 255 / 0.1))",
  color: "color-mix(in oklab, #16131b calc(var(--on, 0) * 100%), rgb(255 255 255 / 0.9))",
};

/* ------------------------------------------------------------------ ad typography */

/** Sticker colors: the tool's own hue (the card's --hue), paper and ink. */
const TONES = {
  hue: { background: "var(--hue)", color: "#16131b" },
  paper: { background: "#f6f3ee", color: "#16131b" },
  ink: { background: "#16131b", color: "#f6f3ee" },
} as const;
type Tone = keyof typeof TONES;

/**
 * A sticker title: heavy condensed italic caps in slanted boxes, like a label slapped on the frame.
 * Each line is its own box; the next sits a little to the right.
 */
export function Sticker({
  hook = "sticker",
  lines,
  tones = ["hue", "paper"],
  size = 30,
  className,
  style,
}: {
  hook?: string;
  lines: string[];
  tones?: Tone[];
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div {...{ [`data-${hook}`]: "" }} className={cn("pointer-events-none absolute z-30", className)} style={{ fontSize: size, ...style }}>
      <div style={{ transform: "rotate(-4deg)" }}>
        {lines.map((l, i) => (
          <span
            key={l}
            {...{ [`data-${hook}-line`]: "" }}
            className="ad-sticker block w-fit opacity-0 shadow-[0_10px_24px_-10px_rgb(0_0_0/0.7)]"
            style={{ ...TONES[tones[i % tones.length]], marginLeft: `${i * 0.42}em`, marginTop: i ? "-0.04em" : 0, padding: "0.04em 0.16em 0.02em" }}
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Shrink an element so it fits inside the card with `margin` px to spare on the right (never grows it), scaling from its
 * top-left corner. Cards are 215 px wide on a 1280-1535 px screen and 255 px on a wide one, and fonts measure a little
 * differently on a Mac: a sticker sized for the wide card ran off the narrow one.
 */
export function fitRight(b: Builder, el: HTMLElement, margin = 10) {
  const { x, w } = b.box(el);
  const k = Math.min(1, (b.W - margin - x) / Math.max(1, w));
  el.style.transformOrigin = "0 0";
  el.style.transform = k < 1 ? `scale(${k.toFixed(3)})` : "";
}

/** Slap a sticker on: each line lands big and settles, a beat apart. */
export function slap(b: Builder, hook: string, t: number) {
  const sticker = b.$(`[data-${hook}]`);
  if (!b.bound.has(sticker)) fitRight(b, sticker);
  b.stagger(`[data-${hook}-line]`, { o: [0, 1, 1], s: [1.7, 0.94, 1], r: [-7, 1, 0] }, t, 0.42, 0.08, E.settle);
  return t + 0.5;
}

/** Peel it off: the lines slide away, a beat apart. */
export function peel(b: Builder, hook: string, t: number) {
  b.stagger(`[data-${hook}-line]`, { o: [1, 0], x: [0, 36] }, t, 0.3, 0.05, E.leave);
  return t + 0.35;
}

/**
 * Spoken words: a caption whose words appear one by one, the way you'd say the change out loud.
 * Pass the words already split so the script can time them.
 */
export function Caption({ hook, words, className }: { hook: string; words: string[]; className?: string }) {
  return (
    <p {...{ [`data-${hook}`]: "" }} className={cn("pointer-events-none absolute inset-x-3 z-30 text-center text-[15px] font-semibold leading-[1.25] text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.6)]", className)}>
      {words.map((w, i) => (
        <span key={i} {...{ [`data-${hook}-w`]: "" }} className={cn("inline-block opacity-0", i < words.length - 1 && "mr-[0.26em]")}>
          {w}
        </span>
      ))}
    </p>
  );
}

/** Say the caption: word after word. Returns when the last word is up. */
export function say(b: Builder, hook: string, t: number, gap = 0.17) {
  const words = b.$$(`[data-${hook}-w]`);
  words.forEach((w, i) => b.to(w, { o: [0, 1], y: [5, 0] }, t + i * gap, 0.22, E.settle));
  return t + (words.length - 1) * gap + 0.22;
}

/** And take it away again (all at once). */
export function unsay(b: Builder, hook: string, t: number) {
  b.to(`[data-${hook}-w]`, { o: 0, y: -4 }, t, 0.25, E.leave);
}

/**
 * A one-line prompt: words around a token that rolls like a slot machine (`roll`) to show
 * that changing one word changes everything.
 */
export function Pill({ hook, before, tokens, after, end, className }: { hook: string; before?: ReactNode; tokens: string[]; after?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div {...{ [`data-${hook}`]: "" }} className={cn(GLASS, "pointer-events-none absolute z-20 inline-flex h-[32px] items-center gap-[5px] rounded-full pl-3 pr-1 text-[11.5px] font-medium text-white/80", className)}>
      {before ? <span className="whitespace-nowrap">{before}</span> : null}
      <span {...{ [`data-${hook}-slot`]: "" }} className="relative inline-block h-[20px] overflow-hidden rounded-[6px] bg-spike/20 align-middle shadow-[inset_0_0_0_1px_rgb(255_91_46/0.45)]" style={{ width: "calc(var(--w, 40) * 1px)" }}>
        {tokens.map((tk) => (
          <span key={tk} {...{ [`data-${hook}-tok`]: "" }} className="absolute left-0 top-0 whitespace-nowrap px-[6px] text-[11.5px] font-semibold leading-[20px] text-[#ffb59b]">
            {tk}
          </span>
        ))}
      </span>
      {after ? <span className="whitespace-nowrap">{after}</span> : null}
      {end}
    </div>
  );
}

/** Where token `j` waits when `index` shows: just above the slot if it's been, just below if it's next. */
const slotY = (j: number, index: number) => Math.max(-100, Math.min(100, (j - index) * 100));

/**
 * Roll a pill's token to `index` at `t` (its slot resizes to the word). Call once per change.
 * Only the word leaving and the word arriving move, so a long list costs two layers, not fifty.
 */
export function roll(b: Builder, hook: string, index: number, t: number, dur = 0.3) {
  const toks = b.$$(`[data-${hook}-tok]`);
  const slot = b.$(`[data-${hook}-slot]`);
  toks.forEach((el, j) => {
    const to = slotY(j, index);
    if (b.valueAt(el, "yp", t) !== to) b.to(el, { yp: to }, t, dur, E.swift);
  });
  b.to(slot, { "--w": toks[index].offsetWidth }, t, dur, E.swift);
}

/**
 * Set a pill's token at the loop's start. The slot takes that word's width at once too: the script measures the stage
 * as it is at the first frame (how big the prompt opens, where the pointer taps), and the slot's resting width is only
 * a stand-in.
 */
export function rollAt(b: Builder, hook: string, index: number) {
  const toks = b.$$(`[data-${hook}-tok]`);
  const slot = b.$(`[data-${hook}-slot]`);
  const w = toks[index].offsetWidth;
  toks.forEach((el, j) => b.set(el, { yp: slotY(j, index) }, 0));
  b.set(slot, { "--w": w }, 0);
  slot.style.setProperty("--w", String(w));
}

/**
 * A sticker whose word rolls (`roll` drives it like a Pill's token): the name of the current look,
 * lens or place, slapped in the corner.
 */
export function RollSticker({ hook, words, size = 22, tone = "hue", className }: { hook: string; words: string[]; size?: number; tone?: Tone; className?: string }) {
  return (
    <div {...{ [`data-${hook}`]: "" }} className={cn("pointer-events-none absolute z-30 opacity-0", className)} style={{ fontSize: size, transform: "rotate(-4deg)" }}>
      <span
        {...{ [`data-${hook}-slot`]: "" }}
        className="ad-sticker relative block overflow-hidden shadow-[0_10px_24px_-10px_rgb(0_0_0/0.7)]"
        style={{ ...TONES[tone], width: "calc(var(--w, 60) * 1px)", height: "1.02em" }}
      >
        {words.map((w) => (
          <span key={w} {...{ [`data-${hook}-tok`]: "" }} className="absolute left-0 top-0 whitespace-nowrap" style={{ padding: "0.06em 0.16em 0" }}>
            {w}
          </span>
        ))}
      </span>
    </div>
  );
}

/** A small label in the corner of a frame: BEFORE, AFTER, a lens, a look. */
export function Tag({ hook, children, tone = "ink", className }: { hook: string; children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span {...{ [`data-${hook}`]: "" }} className={cn("ad-label pointer-events-none absolute z-30 rounded-[4px] px-1.5 py-[3px] text-[9px] leading-none opacity-0", className)} style={TONES[tone]}>
      {children}
    </span>
  );
}

/** The bright edge of a wipe; `placeEdge` puts it where the shader's wipe is (see gl.wipeLine). */
export function WipeEdge({ hook = "edge" }: { hook?: string }) {
  return (
    <span
      {...{ [`data-${hook}`]: "" }}
      className="pointer-events-none absolute left-0 top-0 z-20 h-[170%] w-[2px] opacity-0"
      style={{ background: "#fff", boxShadow: "0 0 10px 2px color-mix(in oklab, var(--hue) 85%, transparent), 0 0 2px 1px #fff" }}
    />
  );
}

/** Put a wipe's edge at its line: `at` is gl.wipeLine's result (center in card %, rotation in degrees). */
export function placeEdge(el: HTMLElement, at: { x: number; y: number; rotate: number }, W: number, H: number, shown: boolean) {
  el.style.transform = `translate(${((at.x / 100) * W).toFixed(2)}px,${((at.y / 100) * H).toFixed(2)}px) translate(-50%,-50%) rotate(${at.rotate.toFixed(2)}deg)`;
  el.style.opacity = shown ? "1" : "0";
}

/**
 * A slanted wipe from left to right at `k` (0…1): the CSS clip for the revealed side, and where
 * its edge line is (for placeEdge). `tilt` is how far the top leads the bottom, in % of the width.
 */
export function slant(k: number, W: number, H: number, tilt = 9) {
  const e = -tilt + (100 + 2 * tilt) * k;
  const top = e + tilt;
  const bottom = e - tilt;
  const clip = `polygon(-2% -2%, ${top.toFixed(2)}% -2%, ${bottom.toFixed(2)}% 102%, -2% 102%)`;
  const rotate = (Math.atan2((2 * tilt * W) / 100, H) * 180) / Math.PI;
  return { clip, edge: { x: e, y: 50, rotate } };
}

/**
 * The CSS matrix3d that lays a w × h box onto a four-cornered shape (px; top-left, top-right,
 * bottom-right, bottom-left), so a flat picture sits on a surface seen in perspective.
 */
export function quad(w: number, h: number, q: { x: number; y: number }[]) {
  const [{ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const k = (dx1 * sy - sx * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + k * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + k * y3;
  return `matrix3d(${a / w},${d / w},0,${g / w},${b / h},${e / h},0,${k / h},0,0,1,0,${x0},${y0},0,1)`;
}

/* ------------------------------------------------------------------ looks over time */

/** One change of a living photo: at `at`, over `dur`, to picture `to` (see gl.Look for the rest). */
export type Change = { at: number; dur: number; to: number; mode?: 0 | 1 | 2; center?: { x: number; y: number }; angle?: number; soft?: number; ease?: (p: number) => number };

/** A photo's changes as a function of time: which two pictures are on, and how far between them. */
export function sequence(first: number, changes: Change[]) {
  const list = [...changes].sort((a, b) => a.at - b.at);
  return (t: number) => {
    let cur = first;
    for (const c of list) {
      if (t < c.at) break;
      if (t < c.at + c.dur) return { from: cur, to: c.to, k: (c.ease ?? E.inOut)((t - c.at) / c.dur), mode: c.mode ?? 1, center: c.center, angle: c.angle, soft: c.soft };
      cur = c.to;
    }
    return { from: cur, to: cur, k: 0, mode: 0 as const };
  };
}

/* ------------------------------------------------------------------ the lockup */

/**
 * The closing lockup: the brand up top, the tool's name in its own color, and a Try button in the
 * far corner. `scrim` "dark" lays a gradient over the last frame; "none" keeps the frame as is
 * (for endings that already sit on dark).
 */
export function EndSlate({ title, scrim = "dark" }: { title: string; scrim?: "dark" | "none" }) {
  return (
    <div data-end className="pointer-events-none absolute inset-0 z-30">
      {scrim === "dark" ? (
        <div data-end-scrim className="absolute inset-0 opacity-0" style={{ background: "linear-gradient(to top, rgb(11 9 15 / 0.92) 0%, rgb(11 9 15 / 0.55) 30%, rgb(11 9 15 / 0) 58%, rgb(11 9 15 / 0.3) 100%)" }}>
          <div className="absolute inset-0" style={{ background: "radial-gradient(80% 36% at 18% 100%, color-mix(in oklab, var(--hue) 34%, transparent), transparent 72%)" }} />
        </div>
      ) : (
        <span data-end-scrim className="hidden" />
      )}
      <p data-end-brand className="ad-label absolute inset-x-0 top-3 text-center text-[9px] tracking-[0.32em] text-white/75 opacity-0 [text-shadow:0_1px_8px_rgb(0_0_0/0.5)]">
        Crackio
      </p>
      <div className="absolute inset-x-3.5 bottom-3.5 flex items-end justify-between gap-2">
        <span data-end-fit className="block min-w-0 origin-bottom-left">
          <span data-end-title className="ad-sticker block w-fit whitespace-nowrap text-[30px] opacity-0" style={{ ...TONES.hue, padding: "0.04em 0.16em 0.02em", transform: "rotate(-3deg)" }}>
            {title}
          </span>
        </span>
        <span data-end-cta className="relative mb-[2px] inline-flex h-[26px] shrink-0 items-center gap-[3px] overflow-hidden rounded-full bg-white pl-2.5 pr-2 text-[11px] font-bold text-[#16131b] opacity-0 shadow-[0_8px_18px_-8px_rgb(0_0_0/0.8)]">
          Try
          <ArrowUpRight size={12} strokeWidth={2.6} />
          <span data-end-shine className="absolute inset-y-0 left-0 w-full" style={{ background: "linear-gradient(100deg, transparent 30%, color-mix(in oklab, var(--hue) 55%, transparent) 50%, transparent 70%)", transform: "translateX(-120%)" }} />
        </span>
      </div>
    </div>
  );
}

/**
 * The ending: the lockup lands and holds, then the card breathes out to dark, everything snaps
 * back to the first frame underneath, and it breathes in again, so the loop has no seam.
 * Returns the loop's length.
 */
export function finale(b: Builder, t: number, hold = 1.6) {
  // A long name shrinks to fit beside the button.
  const fit = b.$("[data-end-fit]");
  const room = b.W - 28 - b.box("[data-end-cta]").w - 10;
  const need = b.box("[data-end-title]").w * 1.02;
  fit.style.transform = need > room ? `scale(${(room / need).toFixed(3)})` : "";
  b.to("[data-before-end]", { o: 0 }, t - 0.15, 0.35, E.inOut);
  b.set("[data-end-scrim], [data-end-cta], [data-end-brand], [data-end-title]", { o: 0 }, 0);
  b.to("[data-end-scrim]", { o: [0, 1] }, t, 0.55, E.inOut);
  b.to("[data-end-brand]", { o: [0, 1], y: [-4, 0] }, t + 0.1, 0.5, E.settle);
  b.to("[data-end-title]", { o: [0, 1, 1], s: [1.6, 0.95, 1], r: [-6, 1, 0] }, t + 0.15, 0.45, E.settle);
  b.to("[data-end-cta]", { o: [0, 1], x: [10, 0], s: [0.8, 1] }, t + 0.42, 0.45, E.pop);
  b.set("[data-end-shine]", { xp: -120 }, 0);
  b.to("[data-end-shine]", { xp: [-120, 120] }, t + 0.95, 0.7, E.inOut);
  const out = t + 0.75 + hold;
  b.pointer.hide(Math.max(0, out - 0.6), 0.3);
  // The loop's way home: the tool's color blooms out of its title and covers the card, everything
  // snaps back to the first frame underneath, and the curtain lifts off it. No dark gap.
  const wipe = b.$("[data-wipe]");
  const from = b.anchor("[data-end-title]", 0.5, 0.5);
  b.set(wipe, { o: 0, cc: 0, ccx: from.x, ccy: from.y, yp: 0 }, 0);
  b.set(wipe, { o: 1 }, out);
  b.to(wipe, { cc: [0, 142] }, out, 0.42, E.inOut);
  b.rewind(out + 0.43, 0.02, E.linear, [wipe]);
  b.seam = out + 0.44;
  b.to(wipe, { yp: [0, -102] }, out + 0.5, 0.5, E.inOut);
  const end = out + 1.02;
  b.end(end);
  return end;
}
