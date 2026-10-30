/**
 * The showcase's film engine. A demo is a timeline built once from the card's real layout:
 * keyframed channels on elements, a pointer that travels to elements (not guessed percentages),
 * typed text, video and canvas tracks. Every frame is a pure function of the playhead, so the
 * loop has no seams, pausing freezes a real frame, and any moment can be rendered exactly.
 *
 * One requestAnimationFrame drives every demo that's on screen; the rest cost nothing. The rail
 * decides what's on screen (ShowcaseRail): a card plays from the moment any of it is in view.
 */

export type Ease = (p: number) => number;
export type Pt = { x: number; y: number };

/* ------------------------------------------------------------------ easing */

/** A CSS cubic-bezier as a function (Newton steps with a bisection fallback). */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 6; i++) {
      const err = sx(t) - p;
      const d = dx(t);
      if (Math.abs(err) < 1e-5) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = p;
    for (let i = 0; i < 24; i++) {
      const v = sx(t);
      if (Math.abs(v - p) < 1e-5) break;
      if (v < p) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

export const E = {
  linear: ((p) => p) as Ease,
  /** Holds the previous value until the key's time, then jumps. */
  step: ((p) => (p >= 1 ? 1 : 0)) as Ease,
  /** Soft start, long landing: cameras and the pointer. */
  glide: bezier(0.45, 0, 0.15, 1),
  /** Quick out of the gate, gentle stop: UI arriving. */
  settle: bezier(0.22, 1, 0.36, 1),
  /** Symmetric and calm: crossfades and wipes. */
  inOut: bezier(0.65, 0, 0.35, 1),
  /** Accelerating away: UI leaving. */
  leave: bezier(0.55, 0, 0.75, 0.2),
  /** A small overshoot, like a spring that's well damped. */
  pop: bezier(0.34, 1.45, 0.64, 1),
  /** Material's standard curve. */
  swift: bezier(0.4, 0, 0.2, 1),
  sine: ((p) => -(Math.cos(Math.PI * p) - 1) / 2) as Ease,
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
/** 0 before `a`, 1 after `b`, eased between. */
export const span = (t: number, a: number, b: number, e: Ease = E.linear) => e(clamp((t - a) / (b - a)));

/* ------------------------------------------------------------------ channels */

type Key = { t: number; v: number; e: Ease };

/** One number over time: keys with an ease for the stretch that leads into each. */
export class Channel {
  keys: Key[] = [];
  private hint = 0;
  constructor(readonly fallback: number) {}

  add(t: number, v: number, e: Ease) {
    let i = this.keys.length;
    while (i > 0 && this.keys[i - 1].t > t) i--;
    this.keys.splice(i, 0, { t, v, e });
  }

  at(t: number): number {
    const k = this.keys;
    if (!k.length) return this.fallback;
    if (t <= k[0].t) return k[0].v;
    const last = k[k.length - 1];
    if (t >= last.t) return last.v;
    let i = this.hint < k.length && k[this.hint].t <= t ? this.hint : 0;
    while (i < k.length - 1 && k[i + 1].t <= t) i++;
    this.hint = i;
    const a = k[i];
    const b = k[i + 1];
    if (b.t === a.t) return b.v;
    return a.v + (b.v - a.v) * b.e((t - a.t) / (b.t - a.t));
  }

  /** The value at the very start of the loop. */
  get initial() {
    return this.keys.length ? this.keys[0].v : this.fallback;
  }
}

/** A number over time that isn't on an element (a WebGL scene's state): tween it, read it each frame. */
export class Num {
  readonly c: Channel;
  constructor(v: number) {
    this.c = new Channel(v);
    this.c.add(0, v, E.step);
  }
  /** Ease from wherever it is at `t0` to `v`. */
  to(v: number, t0: number, dur: number, e: Ease = E.inOut) {
    this.c.add(t0, this.c.at(t0), E.step);
    this.c.add(t0 + dur, v, e);
    return t0 + dur;
  }
  /** Jump to `v` at `t`. */
  set(v: number, t: number) {
    this.c.add(t, v, E.step);
  }
  at(t: number) {
    return this.c.at(t);
  }
}

/* ------------------------------------------------------------------ element writer */

/** Every animatable property and its resting value. */
const DEFAULTS = {
  /** Offsets in px. */
  x: 0,
  y: 0,
  /** Absolute position in % of the stage (the element sits at left/top 0). */
  X: 0,
  Y: 0,
  /** Offsets in % of the element's own box. */
  xp: 0,
  yp: 0,
  s: 1,
  sx: 1,
  sy: 1,
  r: 0,
  o: 1,
  blur: 0,
  bright: 1,
  sat: 1,
  /** clip-path: inset(top right bottom left) in %, with a corner radius in px. */
  ct: 0,
  cr: 0,
  cb: 0,
  cl: 0,
  cround: 0,
  /** clip-path: circle(radius at x y), all in %. Radius 150 shows everything. */
  cc: 150,
  ccx: 50,
  ccy: 50,
} as const;

export type Prop = keyof typeof DEFAULTS | `--${string}`;
/** A target value, [from, to], or several values spread evenly over the tween (keyframes). */
export type Props = Partial<Record<Prop, number | number[]>>;

const TRANSFORM: Prop[] = ["x", "y", "X", "Y", "xp", "yp", "s", "sx", "sy", "r"];
const FILTER: Prop[] = ["blur", "bright", "sat"];
const INSET: Prop[] = ["ct", "cr", "cb", "cl", "cround"];
const CIRCLE: Prop[] = ["cc", "ccx", "ccy"];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

class Bound {
  ch = new Map<Prop, Channel>();
  private last: Record<string, string> = {};
  constructor(readonly el: HTMLElement | SVGElement) {}

  channel(p: Prop) {
    let c = this.ch.get(p);
    if (!c) {
      c = new Channel(p.startsWith("--") ? 0 : DEFAULTS[p as keyof typeof DEFAULTS]);
      this.ch.set(p, c);
    }
    return c;
  }

  private put(key: string, value: string, apply: () => void) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply();
  }

  /**
   * Layers cost the whole page, so an element only gets its own once it animates (will-change), and gives it back when
   * it's hidden or its demo stops. It used to give it back after a fifth of a second at rest too, but each give-back
   * repaints it into the card, and Safari, with the card gliding up the rail on the GPU, skipped those repaints near the
   * rail's edges: a toolbar at rest vanished until the pointer's next click moved it again. A demo keeps a few dozen
   * layers at most, and only the two or three cards in view play.
   */
  private sig = "";
  /** Frames in a row it has changed: a jump (one frame) isn't animation and doesn't earn a layer. */
  private moving = 0;
  private promoted = false;

  private promote(on: boolean) {
    if (on === this.promoted) return;
    this.promoted = on;
    (this.el as HTMLElement).style.willChange = on ? "transform, opacity" : "";
  }

  release() {
    this.promote(false);
    this.moving = 0;
  }

  write(t: number, W: number, H: number) {
    const v = (p: Prop) => this.ch.get(p)?.at(t) ?? (DEFAULTS as Record<string, number>)[p];
    const has = (list: Prop[]) => list.some((p) => this.ch.has(p));
    const style = (this.el as HTMLElement).style;
    const hidden = this.ch.has("o") && v("o") <= 0.001;
    // What this element looks like this frame; when it changes, the element is animating.
    let sig = "";

    if (has(TRANSFORM)) {
      // A plain 2D transform (none at identity): the layer comes from will-change, not 3D.
      const tx = r3((v("X") * W) / 100 + v("x"));
      const ty = r3((v("Y") * H) / 100 + v("y"));
      let rest = tx || ty ? `translate(${tx}px,${ty}px)` : "";
      const xp = r3(v("xp"));
      const yp = r3(v("yp"));
      if (xp || yp) rest += ` translate(${xp}%,${yp}%)`;
      const rot = r3(v("r"));
      if (rot) rest += ` rotate(${rot}deg)`;
      const s = v("s");
      const sx = r3(s * v("sx"));
      const sy = r3(s * v("sy"));
      if (sx !== 1 || sy !== 1) rest += ` scale(${sx},${sy})`;
      const tf = rest.trim() || "none";
      sig += tf;
      this.put("transform", tf, () => (style.transform = tf));
    }
    if (this.ch.has("o")) {
      const o = clamp(v("o"));
      const os = String(r3(o));
      sig += "|" + os;
      this.put("opacity", os, () => (style.opacity = os));
      // Fully transparent layers stop painting and compositing altogether.
      const vis = o <= 0.001 ? "hidden" : "";
      this.put("visibility", vis, () => (style.visibility = vis));
    }
    if (has(FILTER)) {
      const parts: string[] = [];
      const blur = v("blur");
      if (blur > 0.05) parts.push(`blur(${r3(blur)}px)`);
      const br = v("bright");
      if (Math.abs(br - 1) > 0.002) parts.push(`brightness(${r3(br)})`);
      const sat = v("sat");
      if (Math.abs(sat - 1) > 0.002) parts.push(`saturate(${r3(sat)})`);
      const f = parts.join(" ");
      sig += "|" + f;
      this.put("filter", f, () => (style.filter = f));
    }
    if (has(INSET)) {
      const c = `inset(${r3(v("ct"))}% ${r3(v("cr"))}% ${r3(v("cb"))}% ${r3(v("cl"))}% round ${r3(v("cround"))}px)`;
      this.put("clip", c, () => (style.clipPath = c));
    } else if (has(CIRCLE)) {
      const rad = v("cc");
      const c = rad >= 149.9 ? "none" : `circle(${r3(Math.max(0, rad))}% at ${r3(v("ccx"))}% ${r3(v("ccy"))}%)`;
      this.put("clip", c, () => (style.clipPath = c));
    }
    for (const [p, c] of this.ch) {
      if (!p.startsWith("--")) continue;
      const s = String(r3(c.at(t)));
      this.put(p, s, () => style.setProperty(p, s));
    }
    if (hidden) {
      this.release();
    } else if (sig !== this.sig) {
      // The very first frame only sets the scene; promotion starts with real movement.
      if (this.sig && ++this.moving >= 2) this.promote(true);
    } else {
      this.moving = 0;
    }
    this.sig = sig;
  }
}

/* ------------------------------------------------------------------ the pointer */

type Seg = { t0: number; t1: number; pts: Pt[]; e: Ease };

/** Catmull-Rom through the points, with `u` running 0…1 across the whole path. */
function spline(pts: Pt[], u: number): Pt {
  if (pts.length === 2) return { x: lerp(pts[0].x, pts[1].x, u), y: lerp(pts[0].y, pts[1].y, u) };
  if (pts.length === 3) {
    const a = 1 - u;
    return { x: a * a * pts[0].x + 2 * a * u * pts[1].x + u * u * pts[2].x, y: a * a * pts[0].y + 2 * a * u * pts[1].y + u * u * pts[2].y };
  }
  const n = pts.length - 1;
  const f = clamp(u) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const l = f - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n, i + 2)];
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * l + (2 * a - 5 * b + 4 * c - d) * l * l + (-a + 3 * b - 3 * c + d) * l * l * l);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/** The demo's pointer: one source of truth for where the hand is, so anything it drags follows exactly. */
export class Pointer {
  segs: Seg[] = [];
  press = new Channel(1);
  shown = new Channel(0);
  constructor(public home: Pt) {}

  posAt(t: number): Pt {
    let p = this.home;
    for (const s of this.segs) {
      if (t < s.t0) break;
      if (t >= s.t1) {
        p = s.pts[s.pts.length - 1];
        continue;
      }
      return spline(s.pts, s.e((t - s.t0) / (s.t1 - s.t0)));
    }
    return p;
  }

  /** Glide to a point (stage %) along a gentle arc, the way a hand moves a mouse. */
  move(to: Pt, t0: number, dur: number, opts: { arc?: number; e?: Ease } = {}) {
    const from = this.posAt(t0);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const arc = opts.arc ?? 0.14;
    // The bend sits a little past the middle and to the side, so the path reads as human.
    const mid = { x: from.x + dx * 0.55 - dy * arc, y: from.y + dy * 0.55 + dx * arc };
    this.segs.push({ t0, t1: t0 + dur, pts: [from, mid, to], e: opts.e ?? E.glide });
    this.segs.sort((a, b) => a.t0 - b.t0);
    return t0 + dur;
  }

  /** Follow a path of points (a drag, a brush stroke). */
  path(points: Pt[], t0: number, dur: number, e: Ease = E.inOut) {
    const from = this.posAt(t0);
    const pts = Math.hypot(points[0].x - from.x, points[0].y - from.y) < 0.01 ? points : [from, ...points];
    this.segs.push({ t0, t1: t0 + dur, pts, e });
    this.segs.sort((a, b) => a.t0 - b.t0);
    return t0 + dur;
  }

  show(t: number, dur = 0.3) {
    this.shown.add(t, this.shown.at(t), E.step);
    this.shown.add(t + dur, 1, E.settle);
  }

  hide(t: number, dur = 0.3) {
    this.shown.add(t, this.shown.at(t), E.step);
    this.shown.add(t + dur, 0, E.inOut);
  }

  /** Press and release. */
  click(t: number) {
    this.press.add(t, 1, E.step);
    this.press.add(t + 0.09, 0.84, E.swift);
    this.press.add(t + 0.26, 1, E.settle);
  }

  /** Hold the button down from `t0` (a drag) and let go at `t1`. */
  hold(t0: number, t1: number) {
    this.press.add(t0, 1, E.step);
    this.press.add(t0 + 0.1, 0.86, E.swift);
    this.press.add(t1, 0.86, E.step);
    this.press.add(t1 + 0.16, 1, E.settle);
  }
}

/* ------------------------------------------------------------------ the builder */

export type Track = (t: number) => void;

/** Loads a film has already been planned again for (see Builder.ready). */
const replanned = new WeakSet<Promise<unknown>>();

type Target = string | HTMLElement | SVGElement;

/** Natural typing: uneven gaps, a breath after words and commas. */
function keystrokes(text: string, t0: number, cps: number, seed = 7) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const times: number[] = [];
  let t = t0;
  for (const ch of text) {
    times.push(t);
    let gap = (1 / cps) * (0.65 + rand() * 0.7);
    if (ch === " ") gap *= 1.35;
    if (ch === "," || ch === ".") gap *= 2.6;
    t += gap;
  }
  return { times, end: t };
}

export class Builder {
  readonly bound = new Map<Element, Bound>();
  readonly tracks: Track[] = [];
  /** What the film is still waiting on (see ready): the card doesn't start playing before these are in. */
  readonly readies: Promise<unknown>[] = [];
  readonly pointer: Pointer;
  duration = 10;
  /** When the loop resets under the dip (set by the finale); text and clips go back to their start. */
  seam = Infinity;
  private rings: HTMLElement[];
  private ringTurn = 0;

  constructor(
    readonly stage: HTMLElement,
    readonly W: number,
    readonly H: number,
    private kept: Map<string, { value: unknown; destroy: () => void }> = new Map(),
    /** Repaints the current frame, or rebuilds the film, once something it shows has loaded. */
    private repaint: (rebuild: boolean) => void = () => {},
  ) {
    this.pointer = new Pointer({ x: 108, y: 112 });
    this.rings = Array.from(stage.querySelectorAll<HTMLElement>("[data-ring]"));
  }

  $<T extends Element = HTMLElement>(sel: string): T {
    const el = this.stage.querySelector<T>(sel);
    if (!el) throw new Error(`showcase: no ${sel}`);
    return el;
  }

  $$<T extends Element = HTMLElement>(sel: string): T[] {
    return Array.from(this.stage.querySelectorAll<T>(sel));
  }

  private bind(target: Target) {
    const el = typeof target === "string" ? this.$(target) : target;
    let b = this.bound.get(el);
    if (!b) {
      b = new Bound(el as HTMLElement);
      this.bound.set(el, b);
    }
    return b;
  }

  private targets(target: Target | Target[]) {
    if (Array.isArray(target)) return target.flatMap((t) => (typeof t === "string" ? this.$$(t) : [t]));
    return typeof target === "string" ? this.$$(target) : [target];
  }

  /** Tween properties from their value at `t0` (or explicit keyframes) over `dur`. */
  to(target: Target | Target[], props: Props, t0: number, dur: number, e: Ease = E.settle) {
    for (const el of this.targets(target)) {
      const b = this.bind(el);
      for (const [p, val] of Object.entries(props) as [Prop, number | number[]][]) {
        const c = b.channel(p);
        const keys = Array.isArray(val) ? val : [c.at(t0), val];
        c.add(t0, keys[0], E.step);
        for (let i = 1; i < keys.length; i++) c.add(t0 + (dur * i) / (keys.length - 1), keys[i], e);
      }
    }
    return t0 + dur;
  }

  /** Jump properties at `t` (at 0 this sets where the loop starts). */
  set(target: Target | Target[], props: Props, t = 0) {
    for (const el of this.targets(target)) {
      const b = this.bind(el);
      for (const [p, val] of Object.entries(props) as [Prop, number][]) b.channel(p).add(t, val, E.step);
    }
  }

  /** A property's scripted value at `t` (what's been keyed so far). */
  valueAt(target: Target, prop: Prop, t: number) {
    const el = this.targets(target)[0];
    const c = el ? this.bound.get(el)?.ch.get(prop) : undefined;
    return c ? c.at(t) : prop.startsWith("--") ? 0 : DEFAULTS[prop as keyof typeof DEFAULTS];
  }

  /** Snap elements back to how the loop starts, at `t` (do it while they're out of sight). */
  reset(target: Target | Target[], t: number) {
    for (const el of this.targets(target)) {
      const b = this.bound.get(el);
      if (!b) continue;
      for (const c of b.ch.values()) c.add(t, c.initial, E.step);
    }
  }

  /** Several elements one after another. */
  stagger(target: Target | Target[], props: Props, t0: number, dur: number, gap: number, e: Ease = E.settle) {
    const els = this.targets(target);
    els.forEach((el, i) => this.to(el, props, t0 + i * gap, dur, e));
    return t0 + (els.length - 1) * gap + dur;
  }

  /**
   * Type `text` into an element; returns when the last key lands. From `clear.at` on it's empty
   * again (set it once the script knows when the field is out of sight).
   */
  type(target: Target, text: string, t0: number, cps = 26, seed = 7, clear: { at: number } = { at: Infinity }) {
    const el = this.targets(target)[0] as HTMLElement;
    const { times, end } = keystrokes(text, t0, cps, seed);
    let shown = -1;
    this.track((t) => {
      let n = 0;
      if (t < Math.min(clear.at, this.seam)) while (n < times.length && times[n] <= t) n++;
      if (n !== shown) {
        shown = n;
        el.textContent = text.slice(0, n);
      }
    });
    return end;
  }

  /** Swap an element's text at given times. */
  text(target: Target, keys: [number, string][]) {
    const el = this.targets(target)[0] as HTMLElement;
    let shown: string | null = null;
    this.track((t) => {
      let v = keys[0][1];
      if (t < this.seam) for (const [kt, kv] of keys) if (t >= kt) v = kv;
      if (v !== shown) {
        shown = v;
        el.textContent = v;
      }
    });
  }

  /**
   * Play a clip from `t0`: its time follows the playhead (`from` + elapsed × rate) and only gets
   * nudged when it drifts, so playback stays smooth. Before `t0` it waits on `from`; after `t1` it
   * rests on its last frame.
   */
  video(target: Target, t0: number, t1: number, opts: { from?: number; rate?: number; loop?: number } = {}) {
    const el = this.targets(target)[0] as HTMLVideoElement;
    const from = opts.from ?? 0;
    const rate = opts.rate ?? 1;
    const L = opts.loop;
    if (L) el.loop = true;
    // How far the clip is from where it should be; around a loop, the short way.
    const off = (a: number, b: number) => {
      const d = Math.abs(a - b);
      return L ? Math.min(d, L - d) : d;
    };
    /** How far it lags behind (positive) or runs ahead (negative); around a loop, the short way. */
    const lag = (want: number) => {
      let d = want - el.currentTime;
      if (L) d -= Math.round(d / L) * L;
      return d;
    };
    const timeAt = (t: number) => {
      const v = (t - t0) * rate;
      return from + (L ? v % L : v);
    };
    this.track((t) => {
      const exact = Showcase.exact;
      if (t >= this.seam) t = 0;
      if (t >= t0 && t < t1) {
        const want = timeAt(t);
        // Past its last frame it rests there: a clip that has ended and is told to play starts over from 0, and the
        // next frame's nudge sends it back to the end, so it flickered between its first and last frames.
        const last = Number.isFinite(el.duration) ? el.duration - 0.05 : Infinity;
        if (!L && want >= last) {
          if (!el.paused) el.pause();
          if (el.readyState > 0 && Math.abs(el.currentTime - last) > 0.03) el.currentTime = Math.max(0, last);
          return;
        }
        if (exact) {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > 0.01) el.currentTime = want;
          return;
        }
        if (el.paused) {
          if (el.playbackRate !== rate) el.playbackRate = rate;
          if (off(el.currentTime, want) > 0.08) el.currentTime = want;
          void el.play().catch(() => {});
          return;
        }
        // A clip that drifts (a decode hiccup, a busy frame) catches up by playing a touch faster or slower; only one
        // far off is sent there, since every jump shows as a skip.
        const d = lag(want);
        if (Math.abs(d) > 0.6) {
          el.currentTime = want;
          if (el.playbackRate !== rate) el.playbackRate = rate;
        } else {
          const next = Math.abs(d) > 0.04 ? rate * (1 + Math.max(-0.12, Math.min(0.12, d * 0.5))) : rate;
          if (Math.abs(el.playbackRate - next) > 0.005) el.playbackRate = next;
        }
      } else {
        if (!el.paused) el.pause();
        const rest = t < t0 ? from : timeAt(t1);
        if (Math.abs(el.currentTime - rest) > 0.05 && el.readyState > 0) el.currentTime = Math.min(rest, (el.duration || rest + 1) - 0.04);
      }
    });
  }

  /**
   * Scrub a clip: its time is `at(t)` seconds, sought frame by frame (clips made for this are
   * encoded with every frame a keyframe, so seeking is instant). `at` returns null to leave it.
   */
  scrub(target: Target, at: (t: number) => number | null) {
    const el = this.targets(target)[0] as HTMLVideoElement;
    let last = -1;
    this.track((t) => {
      const want = at(t);
      if (want === null) return;
      if (!el.paused) el.pause();
      if (Math.abs(want - last) < 1 / 60 || el.readyState < 1) return;
      last = want;
      el.currentTime = Math.max(0, Math.min(want, (el.duration || want + 1) - 0.02));
    });
  }

  /** Anything else that's a function of time (canvas, WebGL, masks). */
  track(fn: Track) {
    this.tracks.push(fn);
  }

  /** An element's resting box on the stage, in px (layout position; transforms ignored). */
  box(target: Target) {
    const el = this.targets(target)[0] as HTMLElement;
    let x = 0;
    let y = 0;
    let node: HTMLElement | null = el;
    // offsetLeft/Top skip transforms, so this is where the element rests in the layout.
    while (node && node !== this.stage) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
      if (node && !this.stage.contains(node)) break;
    }
    const w = el.offsetWidth || (el as unknown as SVGGraphicsElement).getBoundingClientRect?.().width || 0;
    const h = el.offsetHeight || (el as unknown as SVGGraphicsElement).getBoundingClientRect?.().height || 0;
    return { x, y, w, h };
  }

  /** Where an element's point (fractions of its box) sits on the stage, in %. Ignores transforms. */
  anchor(target: Target, ax = 0.5, ay = 0.5): Pt {
    const { x, y, w, h } = this.box(target);
    return { x: ((x + w * ax) / this.W) * 100, y: ((y + h * ay) / this.H) * 100 };
  }

  /**
   * Where an element's point is on screen at time `t`, through every scripted transform on it and
   * its ancestors (each about its own center): what the pointer must aim at when the UI is zoomed.
   */
  point(target: Target, t: number, ax = 0.5, ay = 0.5): Pt {
    const el = this.targets(target)[0] as HTMLElement;
    const r = this.box(el);
    let px = r.x + r.w * ax;
    let py = r.y + r.h * ay;
    for (let node: HTMLElement | null = el; node && node !== this.stage; node = node.parentElement) {
      const b = this.bound.get(node);
      if (!b) continue;
      const v = (p: Prop) => b.ch.get(p)?.at(t) ?? (DEFAULTS as Record<string, number>)[p];
      const box = this.box(node);
      const ox = box.x + box.w / 2;
      const oy = box.y + box.h / 2;
      const sx = v("s") * v("sx");
      const sy = v("s") * v("sy");
      const a = (v("r") * Math.PI) / 180;
      const dx = (px - ox) * sx;
      const dy = (py - oy) * sy;
      px = ox + dx * Math.cos(a) - dy * Math.sin(a) + (v("X") * this.W) / 100 + v("x") + (v("xp") * box.w) / 100;
      py = oy + dx * Math.sin(a) + dy * Math.cos(a) + (v("Y") * this.H) / 100 + v("y") + (v("yp") * box.h) / 100;
    }
    return { x: (px / this.W) * 100, y: (py / this.H) * 100 };
  }

  /**
   * Transform that lays a full-card layer exactly over `target`'s box (for a picture that grows
   * out of a thumbnail): scale and offsets for the `s`, `x`, `y` channels.
   */
  over(target: Target) {
    const r = this.box(target);
    const k = Math.max(r.w / this.W, r.h / this.H);
    return { s: k, x: r.x + r.w / 2 - this.W / 2, y: r.y + r.h / 2 - this.H / 2, w: r.w, h: r.h };
  }

  /** The pointer presses here at `t`, with a ring blooming from its tip. */
  click(t: number) {
    this.pointer.click(t);
    this.ring(t, this.pointer.posAt(t));
  }

  ring(t: number, at: Pt, size = 1) {
    const ring = this.rings[this.ringTurn++ % Math.max(1, this.rings.length)];
    if (!ring) return;
    this.set(ring, { X: at.x, Y: at.y, s: 0.3 * size, o: 0 }, t);
    this.to(ring, { s: [0.3 * size, 1.25 * size], o: [0.85, 0] }, t, 0.55, E.settle);
  }

  /**
   * The loop's way home: everything still on screen eases back to how the loop starts, so the
   * next pass begins on the very frame this one ends on.
   */
  rewind(t0: number, dur: number, e: Ease = E.inOut, skip: Element[] = []) {
    for (const [el, b] of this.bound) {
      if (skip.includes(el)) continue;
      for (const c of b.ch.values()) {
        const now = c.at(t0);
        const start = c.initial;
        if (Math.abs(now - start) < 1e-6) continue;
        c.add(t0, now, E.step);
        c.add(t0 + dur, start, e);
      }
    }
    return t0 + dur;
  }

  end(t: number) {
    this.duration = t;
  }

  /** A resource that survives rebuilds (a WebGL scene), destroyed when the card goes away. */
  keep<T>(key: string, create: () => T, destroy: (v: T) => void): T {
    const hit = this.kept.get(key);
    if (hit) return hit.value as T;
    const value = create();
    this.kept.set(key, { value, destroy: () => destroy(value) });
    return value;
  }

  /**
   * Something the film shows is still loading: repaint when it lands (or rebuild, when the
   * script needs it to plan), and mark the card ready.
   */
  ready(p: Promise<unknown>, rebuild = false) {
    this.readies.push(p);
    this.stage.removeAttribute("data-ready");
    void p.then(() => {
      this.stage.setAttribute("data-ready", "");
      // A film planned again because something arrived plans once; after that it only repaints.
      const again = rebuild && !replanned.has(p);
      replanned.add(p);
      this.repaint(again);
    }, () => {});
  }

  /** Give back every layer (the demo stopped playing). */
  release() {
    for (const b of this.bound.values()) b.release();
  }

  /** Write frame `t`. */
  render(t: number) {
    const p = this.pointer;
    const cursor = this.stage.querySelector<HTMLElement>("[data-cursor]");
    if (cursor) {
      const pos = p.posAt(t);
      const press = p.press.at(t);
      const shown = clamp(p.shown.at(t));
      cursor.style.transform = `translate(${r3((pos.x * this.W) / 100)}px,${r3((pos.y * this.H) / 100)}px) scale(${r3(press)})`;
      cursor.style.willChange = shown > 0.001 ? "transform" : "";
      cursor.style.opacity = String(r3(shown));
      cursor.style.visibility = shown <= 0.001 ? "hidden" : "";
    }
    for (const b of this.bound.values()) b.write(t, this.W, this.H);
    for (const fn of this.tracks) fn(t);
  }
}

/* ------------------------------------------------------------------ the stage as drawn */

/**
 * How a stage looked before any film touched it: React's markup, with its own inline styles and text. A film is planned
 * from measurements (where a button is, how wide a prompt is), so every build first puts the stage back like this.
 * Planning from a frame instead (half a prompt typed, a word's slot at another width, a zoom halfway) gave each new plan
 * a little more of the last one's state: leave Home and come back (Next keeps the page and runs its effects again) and
 * the Image demo's prompt opened too big for its card. Kept per stage element, so a page that comes back still has it.
 */
type Pristine = { els: Element[]; style: (string | null)[]; text: Map<Element, string> };
/** Kept on the stage element itself, so it outlives a reload of this module (a code change while the page is open). */
const held = (stage: HTMLElement) => stage as HTMLElement & { __crackioPristine?: Pristine };

function remember(stage: HTMLElement) {
  if (held(stage).__crackioPristine) return;
  const els = [stage, ...Array.from(stage.querySelectorAll("*"))];
  const text = new Map<Element, string>();
  for (const el of els) if (!el.children.length) text.set(el, el.textContent ?? "");
  held(stage).__crackioPristine = { els, style: els.map((el) => el.getAttribute("style")), text };
}

/** Put the stage back as it was drawn: no film's transforms, layers, clips or text left on it. */
function restore(stage: HTMLElement) {
  const p = held(stage).__crackioPristine;
  if (!p) return;
  p.els.forEach((el, i) => {
    const style = p.style[i];
    if (el.getAttribute("style") === style) return;
    if (style === null) el.removeAttribute("style");
    else el.setAttribute("style", style);
  });
  for (const [el, text] of p.text) if (el.textContent !== text) el.textContent = text;
}

/** No font still on its way: text measured now is measured in its own face, not a stand-in. */
const fontsIn = () => typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded";

/* ------------------------------------------------------------------ playback */

export type Script = (b: Builder) => void;

type Run = {
  kept: Map<string, { value: unknown; destroy: () => void }>;
  name: string;
  stage: HTMLElement;
  script: Script;
  b: Builder | null;
  /** Playhead in seconds when last paused; time origin while playing. */
  t: number;
  origin: number;
  active: boolean;
  hiddenAt: number;
  size: string;
  /** Planned while fonts were still loading: planned again once they're in. */
  early: boolean;
  /** Its clips, pictures and textures are in (or it stopped waiting for them). */
  loaded: boolean;
  loading: Promise<void> | null;
  /** Asked to play while still loading: it starts once everything's in. */
  wanted: boolean;
};

const runs = new Set<Run>();
let raf = 0;

function frame(now: number) {
  raf = 0;
  let any = false;
  for (const r of runs) {
    if (!r.active || !r.b) continue;
    any = true;
    r.t = ((now - r.origin) / 1000) % r.b.duration;
    r.b.render(r.t);
  }
  if (any) raf = requestAnimationFrame(frame);
}

const wake = () => {
  if (!raf && typeof window !== "undefined") raf = requestAnimationFrame(frame);
};

function build(r: Run) {
  const W = r.stage.clientWidth;
  const H = r.stage.clientHeight;
  if (!W || !H) return false;
  const size = `${W}x${H}`;
  if (r.b && r.size === size) return true;
  restore(r.stage);
  r.early = !fontsIn();
  try {
    const b = new Builder(r.stage, W, H, r.kept, (rebuild) => {
      if (r.b !== b) return;
      if (rebuild) {
        r.size = "";
        build(r);
      } else b.render(r.t % b.duration);
    });
    r.script(b);
    r.b = b;
    r.size = size;
    b.render(r.t % b.duration);
    return true;
  } catch (err) {
    console.warn(`[showcase] ${r.name} couldn't start:`, err);
    return false;
  }
}

/** A demo away longer than this starts over from its first frame (its hook) when it's back. */
const AWAY = 2500;

/** The longest a card waits for its pieces before it plays anyway (a Mac on Wi-Fi fetches them over the network). */
const LOAD_WAIT = 12_000;

/**
 * Everything the film shows that comes over the network: its clips (a first frame decoded), its pictures, and what its
 * script said it waits on (textures, a 3D set; Builder.ready). Played before these were in, a card showed empty boxes,
 * a black set or a poster where a clip should move, and jumped when they turned up.
 */
function load(r: Run) {
  if (r.loaded) return Promise.resolve();
  if (r.loading) return r.loading;
  const clips = Array.from(r.stage.querySelectorAll("video")).map((v) =>
    v.readyState >= 2
      ? null
      : new Promise<void>((done) => {
          v.addEventListener("loadeddata", () => done(), { once: true });
          v.addEventListener("error", () => done(), { once: true });
        }),
  );
  const pictures = Array.from(r.stage.querySelectorAll("img")).map((img) => (img.complete ? null : img.decode().catch(() => {})));
  const waits = [...clips, ...pictures, ...(r.b?.readies ?? []).map((p) => p.catch(() => {}))].filter(Boolean);
  r.loading = Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, LOAD_WAIT))]).then(() => {
    r.loaded = true;
    r.loading = null;
  });
  return r.loading;
}

/** Clips buffer and the film is planned (pictures start loading) before the card is in view. */
function prepare(r: Run) {
  r.stage.querySelectorAll("video").forEach((v) => {
    if (v.preload === "auto") return;
    v.preload = "auto";
    // Raising preload on a clip that started at "none" doesn't fetch it in Chrome: it reports loading and never gets a
    // byte, so the card played its poster and jumped when the clip turned up (or never did). load() fetches it.
    if (v.readyState === 0) v.load();
  });
  const built = build(r);
  if (built) void load(r);
  return built;
}

export type Controls = {
  /**
   * Start or stop playing. Stopping because the card left the view (the default) means it starts
   * over when it's back; `hold` freezes the frame instead (paused, or the tab is in the background).
   */
  play(on: boolean, opts?: { hold?: boolean }): void;
  /** About to come into view: plan the film, buffer its clips and draw its first frame. */
  warm(): void;
  /** The card changed size: rebuild against the new layout, keeping the playhead. */
  resize(): void;
  dispose(): void;
};

const controls = new WeakMap<HTMLElement, Controls>();

export const Showcase = {
  /** Set while frames are captured: clips seek exactly instead of playing. */
  exact: false,

  mount(name: string, stage: HTMLElement, script: Script): Controls {
    remember(stage);
    const r: Run = { kept: new Map(), name, stage, script, b: null, t: 0, origin: 0, active: false, hiddenAt: 0, size: "", early: false, loaded: false, loading: null, wanted: false };
    runs.add(r);
    const away = (now: number) => !r.hiddenAt || now - r.hiddenAt > AWAY;
    const ctl: Controls = {
      play(on, opts = {}) {
        const now = performance.now();
        if (on) {
          if (r.active) return;
          if (!prepare(r)) return;
          if (!r.loaded) {
            // Its pieces are still on their way: it holds its first frame and starts the moment they're in.
            if (!r.wanted) {
              r.wanted = true;
              void load(r).then(() => {
                if (!r.wanted) return;
                r.wanted = false;
                ctl.play(true);
              });
            }
            return;
          }
          r.wanted = false;
          if (r.hiddenAt && now - r.hiddenAt > AWAY) r.t = 0;
          r.hiddenAt = 0;
          r.origin = now - r.t * 1000;
          r.active = true;
          r.stage.setAttribute("data-live", "");
          wake();
          return;
        }
        r.wanted = false;
        if (r.active) {
          r.active = false;
          r.stage.removeAttribute("data-live");
          r.b?.release();
          r.stage.querySelectorAll("video").forEach((v) => v.pause());
        }
        // Leaving the view starts the clock on "away"; holding keeps the moment.
        if (!opts.hold && !r.hiddenAt) r.hiddenAt = now;
      },
      warm() {
        if (r.active) return;
        const now = performance.now();
        if (!prepare(r) || !r.b) return;
        // It will start over when it comes in, so show its first frame already.
        if (away(now) && r.t !== 0) {
          r.t = 0;
          r.b.render(0);
        }
      },
      resize() {
        if (!r.b) return;
        const W = r.stage.clientWidth;
        const H = r.stage.clientHeight;
        // Hidden (0 × 0), or back at the size it was planned for: nothing to plan again.
        if (!W || !H || `${W}x${H}` === r.size) return;
        r.size = "";
        build(r);
      },
      dispose() {
        r.active = false;
        runs.delete(r);
        controls.delete(stage);
        r.kept.forEach((k) => k.destroy());
        r.kept.clear();
        // The card can outlive this (Next keeps a page you left mounted, hidden): its clips stop too, and it goes back
        // to how it was drawn, so the next mount plans from a clean stage.
        stage.querySelectorAll("video").forEach((v) => v.pause());
        restore(stage);
      },
    };
    controls.set(stage, ctl);
    return ctl;
  },

  /** The controls of the demo on this stage (the rail drives its cards through these). */
  controls(stage: HTMLElement) {
    return controls.get(stage);
  },

  /** Render one demo at an exact time (for frame-by-frame review). */
  seek(name: string, t: number) {
    for (const r of runs) {
      if (r.name !== name) continue;
      build(r);
      r.active = false;
      r.t = t;
      r.b?.render(t);
    }
  },

  list() {
    return [...runs].map((r) => ({ name: r.name, duration: r.b?.duration ?? 0, active: r.active }));
  },
};

// Fonts that land after a film was planned (the first visit, a slow network): plan those films again, in place.
if (typeof document !== "undefined" && document.fonts) {
  const replan = () => {
    if (!fontsIn()) return;
    for (const r of runs) {
      if (!r.b || !r.early) continue;
      r.size = "";
      build(r);
    }
  };
  document.fonts.addEventListener("loadingdone", replan);
  document.fonts.addEventListener("loadingerror", replan);
  void document.fonts.ready.then(replan);
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __showcase: typeof Showcase }).__showcase = Showcase;
}
