import { resolutionHeight } from "@/lib/models/caps";

/**
 * What a generation will cost, before you run it. Providers price models per second, image, clip,
 * run, megapixel, token or frame (fal publishes each model's unit price, and the rates behind it:
 * per resolution, with or without sound, per quality), per run on average, or by quote (Comfy
 * prices the exact request); plans include it. `estimateCost` turns a model's pricing and the
 * settings on screen into dollars, so the number follows every change you make.
 */

export type PriceUnit = "second" | "minute" | "image" | "video" | "run" | "megapixel" | "ktoken" | "frame";

/** One price and the settings it applies to; a missing condition applies to any value. */
export type Rate = {
  price: number;
  /** "720p", "2K"… as the provider names it. */
  resolution?: string | null;
  /** With sound (true) or silent (false). */
  audio?: boolean | null;
  /** "low", "medium", "high"… */
  quality?: string | null;
  /** For a price per clip: the clip length it's quoted for. */
  seconds?: number | null;
};

export type Pricing =
  /** Paid by a subscription (ChatGPT, Grok). */
  | { kind: "plan"; plan: string }
  /**
   * A price per unit. `rates` (or `byResolution`) when it depends on the settings; `per` when the
   * price covers a block of units (fal's "5 seconds", "30 frames", "1M tokens"); `approximate`
   * when only a base rate is known that some options (sound, 4K) raise. `refining` while the
   * detailed rates are still being read (ask again in a moment).
   */
  | {
      kind: "unit";
      unit: PriceUnit;
      price: number;
      per?: number;
      byResolution?: Record<string, number>;
      rates?: Rate[];
      approximate?: boolean;
      refining?: boolean;
      provider: string;
    }
  /** Only an average per run is known (fal's history for models priced in their own units). */
  | { kind: "run"; perRun: number; refining?: boolean; provider: string }
  /** The provider quotes the exact request (Comfy Router): ask the server with the settings. */
  | { kind: "quote"; provider: string }
  | { kind: "none"; refining?: boolean };

export type CostInput = {
  output: "image" | "video";
  /** Clip length; "auto" (or unknown) is counted at five seconds. */
  seconds?: number | "auto";
  /** "720p", "1080P", "2K"… */
  resolution?: string | number | null;
  /** "low", "medium", "high"… for models with a quality setting. */
  quality?: string | null;
  /** Sound on or off, for clips. */
  sound?: boolean;
  /** Width / height of the result. */
  ratio?: number;
  /** Takes. */
  count: number;
  /** Megapixels of a picture result when known (an edit keeps the source's size). */
  megapixels?: number;
};

export type Cost = { amount: number; detail: string; approximate: boolean };

/** The settings a quote is asked for (Comfy prices the exact request they make). */
export type QuoteSettings = {
  output: "image" | "video";
  seconds?: number | "auto";
  resolution?: string | null;
  quality?: string | null;
  /** The exact shape value picked, when one was. */
  aspectValue?: string | null;
  aspect: "1:1" | "4:5" | "2:3" | "9:16" | "3:2" | "16:9" | "21:9";
  count: number;
  sound?: boolean;
  /** Pictures that ride along: a start or end frame, or references. */
  start?: boolean;
  end?: boolean;
  images?: number;
};

/** Frames a second, for prices counted in frames when the clip's own rate isn't known. */
const FPS = 30;

/** "$12", "$0.56", "$0.035", "$0.0031": cents always shown, smaller amounts to two significant digits. */
export function formatMoney(n: number) {
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 0.1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3).replace(/(\.\d{2}\d*?)0+$/, "$1")}`;
  return `$${Number(n.toPrecision(2))}`;
}

/** A clip's frame size at a resolution and shape (fal and Comfy count tokens and megapixels on it). */
function frame(input: CostInput) {
  const h = (input.resolution !== undefined && input.resolution !== null ? resolutionHeight(input.resolution) : null) ?? 720;
  const r = input.ratio ?? 16 / 9;
  // "720p" names the short side.
  return r >= 1 ? { w: h * r, h } : { w: h, h: h / r };
}

/**
 * The rate that applies to these settings: the one whose sound, quality and resolution match
 * (the nearest resolution when the exact one isn't listed). `exact` is false when a setting the
 * price depends on isn't known or isn't listed.
 */
export function pickRate(rates: Rate[], input: CostInput, standard?: number): { rate: Rate; exact: boolean } | null {
  let pool = rates.filter((r) => Number.isFinite(r.price) && r.price > 0);
  if (!pool.length) return null;
  let exact = true;
  const narrow = (keep: (r: Rate) => boolean) => {
    const next = pool.filter(keep);
    if (next.length) pool = next;
    else exact = false;
  };
  if (pool.some((r) => typeof r.audio === "boolean")) {
    if (typeof input.sound !== "boolean") exact = false;
    else narrow((r) => typeof r.audio !== "boolean" || r.audio === input.sound);
  }
  if (pool.some((r) => r.quality)) {
    const q = input.quality ? String(input.quality).toLowerCase() : null;
    if (!q) exact = false;
    else narrow((r) => !r.quality || r.quality.toLowerCase() === q);
  }
  if (pool.some((r) => r.resolution)) {
    const want = input.resolution !== undefined && input.resolution !== null ? resolutionHeight(input.resolution) : null;
    const listed = pool.filter((r) => r.resolution && resolutionHeight(r.resolution) !== null);
    // A rate without a resolution is the standard one: it covers every resolution the note doesn't name.
    const general = pool.filter((r) => !r.resolution);
    const dist = (r: Rate) => Math.abs(Math.log(resolutionHeight(r.resolution!)! / (want ?? 1)));
    const named = want !== null ? listed.filter((r) => dist(r) <= 0.02) : [];
    if (named.length) pool = named;
    else if (general.length) {
      pool = general;
      if (want === null) exact = false;
    } else if (want !== null && listed.length) {
      const best = Math.min(...listed.map(dist));
      pool = listed.filter((r) => dist(r) === best);
      exact = false;
    } else exact = false;
  }
  if (pool.some((r) => r.seconds)) {
    const s = typeof input.seconds === "number" ? input.seconds : null;
    if (s === null) exact = false;
    else {
      const timed = pool.filter((r) => r.seconds);
      const best = Math.min(...timed.map((r) => Math.abs(r.seconds! - s)));
      pool = timed.filter((r) => Math.abs(r.seconds! - s) === best);
    }
  }
  // Several left: the one that names the most settings, then the standard price, then the first listed.
  const specific = (r: Rate) => Number(Boolean(r.resolution)) + Number(typeof r.audio === "boolean") + Number(Boolean(r.quality)) + Number(Boolean(r.seconds));
  const isStandard = (r: Rate) => (standard !== undefined && Math.abs(r.price - standard) < 1e-9 ? 1 : 0);
  const rate = [...pool].sort((a, b) => specific(b) - specific(a) || isStandard(b) - isStandard(a))[0];
  return { rate, exact };
}

/** "at 1080p, with sound" for the detail line. */
function conditions(r: Rate | null) {
  if (!r) return "";
  const bits = [r.resolution ? `at ${r.resolution}` : "", r.audio === true ? "with sound" : r.audio === false ? "silent" : "", r.quality ? `${r.quality.toLowerCase()} quality` : ""].filter(Boolean);
  return bits.length ? ` ${bits.join(", ")}` : "";
}

/** Dollars for these settings, or null when the price can't be worked out here (plans, quotes, unknown). */
export function estimateCost(p: Pricing, input: CostInput): Cost | null {
  const seconds = input.seconds === "auto" || input.seconds === undefined ? 5 : input.seconds;
  const guessed = input.seconds === "auto" || input.seconds === undefined;
  const takes = Math.max(1, input.count);
  const times = takes > 1 ? ` × ${takes}` : "";
  if (p.kind === "run") return { amount: p.perRun * takes, detail: takes > 1 ? `about ${formatMoney(p.perRun)} a run${times}` : `${p.provider}'s average for this model`, approximate: true };
  if (p.kind !== "unit") return null;
  const res = input.resolution !== undefined && input.resolution !== null ? String(input.resolution).toLowerCase() : null;
  const picked = p.rates?.length ? pickRate(p.rates, input, p.price) : null;
  const price = picked?.rate.price ?? (res ? p.byResolution?.[res] : undefined) ?? p.price;
  const per = p.per && p.per > 1 ? p.per : 1;
  // Approximate when only a base rate is known, or a setting the rate depends on isn't.
  const base = picked ? !picked.exact : Boolean(p.approximate);
  const when = conditions(picked?.rate ?? null);
  switch (p.unit) {
    case "second": {
      if (input.output !== "video") return { amount: price * takes, detail: `${formatMoney(price)} each${when}`, approximate: true };
      // A price per block of seconds is paid for every block begun.
      if (per > 1) {
        const blocks = Math.ceil(seconds / per);
        return { amount: price * blocks * takes, detail: `${formatMoney(price)} per ${per} s${when} × ${blocks}${times}`, approximate: guessed || base };
      }
      return { amount: price * seconds * takes, detail: `${formatMoney(price)}/s${when} × ${seconds} s${times}`, approximate: guessed || base };
    }
    case "minute":
      return { amount: (price * seconds * takes) / 60 / per, detail: `${formatMoney(price)}/min${when} × ${seconds} s${times}`, approximate: guessed || base };
    case "frame": {
      const blocks = Math.ceil((seconds * FPS) / per);
      return { amount: price * blocks * takes, detail: `${formatMoney(price)} per ${per} frames × ${blocks}${times}`, approximate: true };
    }
    case "image":
      return { amount: price * takes, detail: `${formatMoney(price)}/image${when}${times}`, approximate: base };
    case "video": {
      // A per-clip price quoted for another length scales with it.
      const quoted = picked?.rate.seconds;
      const scale = quoted && input.output === "video" && !guessed && quoted !== seconds ? seconds / quoted : 1;
      return {
        amount: price * scale * takes,
        detail: quoted ? `${formatMoney(price)} a ${quoted} s clip${when}${scale !== 1 ? `, scaled to ${seconds} s` : ""}${times}` : `${formatMoney(price)}/clip${when}${times}`,
        approximate: base || scale !== 1 || (Boolean(quoted) && guessed),
      };
    }
    case "run":
      return { amount: price * takes, detail: `${formatMoney(price)} a run${when}${times}`, approximate: base };
    case "megapixel": {
      if (input.output === "video") {
        const f = frame(input);
        const mp = (f.w * f.h * 24 * seconds) / 1e6;
        return { amount: price * mp * takes, detail: `${formatMoney(price)}/MP × ${Math.round(mp)} MP of frames`, approximate: true };
      }
      const mp = input.megapixels ?? (input.resolution ? Math.max(0.25, (resolutionHeight(input.resolution) ?? 1024) ** 2 / 1e6) : 1);
      return { amount: price * mp * takes, detail: `${formatMoney(price)}/MP × ${mp.toFixed(1)} MP${times}`, approximate: true };
    }
    case "ktoken": {
      // Video models priced in tokens count width × height × frames / 1024 (ByteDance's formula).
      const f = frame(input);
      const k = (f.w * f.h * 24 * seconds) / 1024 / 1000;
      const rate = price / per;
      return { amount: rate * k * takes, detail: `${formatMoney(price)} per ${per > 1 ? `${per / 1000}M` : "1K"} tokens × ${Math.round(k)}K`, approximate: true };
    }
  }
}

/** The cheapest and dearest rate, for a model list's price badge. */
export function rateRange(rates: Rate[]): { min: number; max: number } | null {
  const prices = rates.map((r) => r.price).filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

/**
 * fal's unit names in Crackio's terms, with how many units the price covers ("5 seconds" → 5,
 * "1m tokens" → 1,000 thousand tokens); null when the unit isn't one a price can be worked out
 * from (compute seconds, credits, "units": fal's average per run stands in for those).
 */
export function falUnit(raw: string): { unit: PriceUnit; per: number } | null {
  const m = /^\s*(?:(\d+(?:\.\d+)?)\s*([km])?\s+)?(.+?)\s*$/i.exec(raw.toLowerCase());
  if (!m) return null;
  const n = (m[1] ? Number(m[1]) : 1) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1);
  const word = m[3];
  if (!(n > 0)) return null;
  if (word === "seconds" || word === "second") return { unit: "second", per: n };
  if (word === "minutes" || word === "minute") return { unit: "minute", per: n };
  if (word === "images" || word === "image") return n === 1 ? { unit: "image", per: 1 } : null;
  if (word === "videos" || word === "video") return n === 1 ? { unit: "video", per: 1 } : null;
  if (word === "generations" || word === "generation") return n === 1 ? { unit: "run", per: 1 } : null;
  if (word === "megapixels" || word === "megapixel" || word === "processed megapixels") return n === 1 ? { unit: "megapixel", per: 1 } : null;
  if (word === "frames" || word === "frame") return { unit: "frame", per: n };
  if (word === "tokens" && n >= 1000) return { unit: "ktoken", per: n / 1000 };
  return null;
}
