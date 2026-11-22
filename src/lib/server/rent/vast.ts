import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MarketGpu, RentKit, RentOffer, Verification } from "@/lib/rent/types";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * vast.ai's market, through its own REST API with the user's key (what its CLI does underneath): the offers that fit a
 * kit, renting one, and how a rented box is doing. Nothing here reads the website. The rules for what fits and what a
 * failed box looks like were learned by renting real boxes.
 */

const API = "https://console.vast.ai/api";

export class VastError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No more searches today: vast.ai's daily allowance of search rows is used up, or Crackio's own share of it is. */
export class VastQuota extends VastError {
  constructor(
    /** When it searches again (ms). */
    public until: number,
    /** Crackio's own cap was reached, not vast's: the user can still search and rent on vast's site. */
    public own = false,
  ) {
    super(own ? "Crackio has used the share of vast.ai's daily searches it allows itself." : "vast.ai's daily search allowance is used up.", 429);
  }
}

/**
 * vast.ai counts every ROW a search returns against a daily allowance per account (20,000 when this was written; its
 * refusal names the number) and refuses searches past it until its day turns. Found the hard way: a market list made of
 * three 2,000-row searches and a page that searched every ten seconds used a day's allowance in one evening of testing.
 * So every search here asks for as few rows as it can, the rows it gets are counted, and nothing searches while the
 * allowance is known to be gone.
 */
type Budget = { day: string; rows: number; limit: number; blockedUntil: number };
const budgets = globalThis as unknown as { __crackioVastBudget?: Budget; __crackioVastBudgetSave?: ReturnType<typeof setTimeout> | null };
/**
 * The share of vast's daily allowance Crackio lets itself use. The allowance is the account's, shared with vast's own
 * site: once Crackio had used all of it, searching for a box to rent by hand failed for the rest of the day. So
 * Crackio stops itself well short, and the rest stays free for searching by hand.
 */
const OWN_SHARE = 0.3;
/** Kept on disk: a restart mustn't forget what was used today, or that vast said to wait. */
const BUDGET_FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "rent-search.json");
const today = () => new Date().toISOString().slice(0, 10);
/** When vast's day turns (midnight UTC), in ms. */
const dayEnd = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
function budget(): Budget {
  let b = budgets.__crackioVastBudget;
  if (!b) {
    b = { day: today(), rows: 0, limit: 20_000, blockedUntil: 0 };
    try {
      const saved = JSON.parse(readFileSync(/*turbopackIgnore: true*/ BUDGET_FILE, "utf8")) as Partial<Budget>;
      if (Number(saved.limit) > 0) b.limit = Number(saved.limit);
      if (saved.day === b.day && Number(saved.rows) > 0) b.rows = Number(saved.rows);
      if (Number(saved.blockedUntil) > Date.now()) b.blockedUntil = Number(saved.blockedUntil);
    } catch {
      /* nothing kept yet */
    }
    budgets.__crackioVastBudget = b;
  }
  if (b.day !== today()) Object.assign(b, { day: today(), rows: 0 });
  return b;
}
function keepBudget() {
  if (budgets.__crackioVastBudgetSave) return;
  budgets.__crackioVastBudgetSave = setTimeout(() => {
    budgets.__crackioVastBudgetSave = null;
    void writeFileAtomic(BUDGET_FILE, JSON.stringify(budget())).catch(() => undefined);
  }, 1500);
}
/**
 * Search rows Crackio used today, the rows it allows itself (its share of vast's allowance), vast's own allowance, and
 * until when searching is refused (null: it isn't). `own`: by Crackio's own cap, with vast's allowance still open.
 */
export function searchBudget(): { used: number; limit: number; vastLimit: number; blockedUntil: number | null; own: boolean } {
  const b = budget();
  const cap = Math.round(b.limit * OWN_SHARE);
  const byVast = b.blockedUntil > Date.now();
  const byUs = !byVast && b.rows >= cap;
  return { used: b.rows, limit: cap, vastLimit: b.limit, blockedUntil: byVast ? b.blockedUntil : byUs ? dayEnd() : null, own: byUs };
}

/**
 * vast.ai also allows each kind of call only so often (a minimum time between two of the same) and answers 429 past
 * that. The page, the card list and every hunt all search, so their calls take turns here: one of a kind at a time,
 * spaced apart, and all of that kind wait when the market says to slow down.
 */
const SPACING: Record<string, number> = { search: 1500, boxes: 700, other: 400 };
const kindOf = (path: string) => (path.includes("/bundles") ? "search" : path.includes("/instances") ? "boxes" : "other");
const lanes = globalThis as unknown as { __crackioVastLanes?: Map<string, { turn: Promise<void>; free: number }> };
const lane = (kind: string) => {
  const all = (lanes.__crackioVastLanes ??= new Map());
  let l = all.get(kind);
  if (!l) all.set(kind, (l = { turn: Promise.resolve(), free: 0 }));
  return l;
};

/** Waits for this call's turn among the calls of its kind. */
function myTurn(kind: string): Promise<void> {
  const l = lane(kind);
  const mine = l.turn.then(async () => {
    const wait = l.free - Date.now();
    if (wait > 0) await sleep(wait);
    l.free = Date.now() + SPACING[kind];
  });
  l.turn = mine.catch(() => undefined);
  return mine;
}

/** One call, in its turn. "Too frequent" holds every call of its kind back and is tried again up to three times; a used-up search allowance isn't tried again at all. */
async function vast<T>(key: string, method: string, path: string, opts: { params?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const url = `${API}${path}${opts.params ? `?${new URLSearchParams(opts.params)}` : ""}`;
  const kind = kindOf(path);
  for (let attempt = 0; ; attempt++) {
    if (kind === "search") {
      const now = searchBudget();
      if (now.blockedUntil) throw new VastQuota(now.blockedUntil, now.own);
    }
    await myTurn(kind);
    if (opts.signal?.aborted) throw new VastError("Stopped.");
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        cache: "no-store",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new VastError(`vast.ai didn't answer (${(err as Error).name}).`);
    }
    if (res.status === 429) {
      const told = await res.text().catch(() => "");
      let said: { error?: string; retry_after?: number; limit?: number } = {};
      try {
        said = JSON.parse(told) as typeof said;
      } catch {
        /* plain words */
      }
      if (said.error === "search_quota_exceeded") {
        const b = budget();
        b.blockedUntil = Date.now() + Math.max(60, Number(said.retry_after) || 3600) * 1000;
        if (Number(said.limit) > 0) b.limit = Number(said.limit);
        b.rows = b.limit;
        keepBudget();
        console.warn(`[crackio] vast.ai's daily search allowance (${b.limit} rows) is used up; it searches again at ${new Date(b.blockedUntil).toISOString()}`);
        throw new VastQuota(b.blockedUntil);
      }
      // "API requests too frequent: endpoint threshold=2.0": seconds between two calls. vast sends no Retry-After, so that
      // number becomes this kind's spacing from then on, with a little room.
      const threshold = Number(/threshold[ ]*=[ ]*([0-9.]+)/i.exec(told)?.[1]);
      if (threshold > 0 && threshold < 120) SPACING[kind] = Math.max(SPACING[kind], Math.round(threshold * 1000 * 1.25));
      lane(kind).free = Date.now() + Math.min(Math.max(SPACING[kind], 3000 * (attempt + 1)), 30_000);
      if (attempt < 3) continue;
      throw new VastError("vast.ai says too many requests: Crackio is waiting a little.", 429);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new VastError("vast.ai refused the key: check it under Settings → Accounts.", res.status);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new VastError(`vast.ai answered ${res.status}: ${text.replace(/[ \t\r\n]+/g, " ").slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new VastError(`vast.ai answered ${res.status}: ${JSON.stringify(data).slice(0, 300)}`, res.status);
    return data as T;
  }
}

/* ------------------------------------------------------------------ offers */

type Raw = Record<string, unknown>;
const num = (o: Raw, k: string) => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : 0);
const str = (o: Raw, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");

const verificationOf = (o: Raw): Verification => {
  const v = str(o, "verification");
  return v === "verified" || v === "deverified" || v === "unverified" ? v : o.verified ? "verified" : "unverified";
};
const countryOf = (o: Raw) => (str(o, "geolocation").split(",").pop() ?? "").trim().toUpperCase();

/**
 * The CUDA a host's driver has to reach for the box to start: vast's ComfyUI image runs from 12.8 (its cuda-12.9 build),
 * its PyTorch image from 12.4, so a kit on PyTorch can take hosts with older drivers too.
 */
const minCuda = (kit: RentKit) => (kit.template === "pytorch" ? 12.4 : 12.8);
/** An offer up to this much over the cap still shows, as a near miss with why. */
export const NEAR = 0.15;
/** SSD speed below this (MB/s) is a spinning disk or a tired one: models load from it. */
const MIN_DISK_MBPS = 300;
/** A card scoring under this share of its kind's usual DLPerf is throttled or broken (one 5090 scored a quarter). */
const WEAK = 0.6;

function offerOf(o: Raw, kit: RentKit, usual: Map<string, number>, blocked: Map<number, string>): RentOffer {
  const price = num(o, "dph_total");
  const tb = Math.max(num(o, "inet_down_cost"), num(o, "inet_up_cost")) * 1000;
  const reliability = num(o, "reliability2") || num(o, "reliability") || null;
  const v = verificationOf(o);
  const country = countryOf(o);
  const gpu = str(o, "gpu_name");
  const misses: string[] = [];
  if (!kit.gpus.includes(gpu)) misses.push("not on your list");
  if (!(price > 0 && price <= kit.maxPrice)) misses.push(`$${price.toFixed(3)}/h is over $${kit.maxPrice}`);
  if (!kit.verification.includes(v)) misses.push(v);
  if (kit.minRamGb && num(o, "cpu_ram") < kit.minRamGb * 1000) misses.push(`${Math.round(num(o, "cpu_ram") / 1000)} GB RAM`);
  if (kit.minDown && num(o, "inet_down") < kit.minDown) misses.push(`↓${Math.round(num(o, "inet_down"))} Mb/s`);
  if (kit.minUp && num(o, "inet_up") < kit.minUp) misses.push(`↑${Math.round(num(o, "inet_up"))} Mb/s`);
  if (kit.maxTbCost != null && tb > kit.maxTbCost) misses.push(`$${tb.toFixed(2)}/TB`);
  if (num(o, "disk_space") < kit.diskGb) misses.push(`${Math.round(num(o, "disk_space"))} GB disk`);
  if (num(o, "disk_bw") && num(o, "disk_bw") < MIN_DISK_MBPS) misses.push("slow disk");
  if (num(o, "cuda_max_good") && num(o, "cuda_max_good") < minCuda(kit)) misses.push(`old driver (CUDA ${num(o, "cuda_max_good")})`);
  if (kit.minReliability && (reliability ?? 0) < kit.minReliability) misses.push(`${Math.round((reliability ?? 0) * 100)}% reliable`);
  if (kit.skipCountries.includes(country)) misses.push(`in ${country}`);
  const norm = usual.get(gpu);
  if (norm && num(o, "dlperf") > 0 && num(o, "dlperf") < norm * WEAK) misses.push("weak card");
  if (num(o, "duration") && num(o, "duration") < 86_400) misses.push("listing ends today");
  if (o.rentable === false || o.rented === true) misses.push("taken");
  if (num(o, "num_gpus") !== 1) misses.push(`${num(o, "num_gpus")} GPUs`);
  const block = blocked.get(num(o, "machine_id"));
  return {
    id: num(o, "id"),
    machine: num(o, "machine_id"),
    host: num(o, "host_id") || null,
    gpu,
    gpuGb: Math.round(num(o, "gpu_ram") / 1024),
    price,
    country,
    place: str(o, "geolocation").replace(/^[, ]+/, "") || "?",
    ramGb: Math.round(num(o, "cpu_ram") / 1000),
    down: Math.round(num(o, "inet_down")),
    up: Math.round(num(o, "inet_up")),
    tbCost: Math.round(tb * 100) / 100,
    reliability,
    verification: v,
    cuda: num(o, "cuda_max_good") || null,
    misses,
    ...(block ? { blocked: block } : {}),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** What a healthy card of a kind scores (DLPerf), where a real one was measured; others are judged against their peers. */
const HEALTHY: Record<string, number> = { "RTX 5090": 200, "H100 SXM": 340, "H100 NVL": 340, "H100 PCIE": 256 };

/** One search, its rows counted against the day's allowance. */
async function search(key: string, query: Record<string, unknown>, signal?: AbortSignal): Promise<Raw[]> {
  const res = await vast<{ offers?: Raw[] }>(key, "POST", "/v0/bundles/", { body: query, signal });
  const rows = Array.isArray(res.offers) ? res.offers : [];
  budget().rows += rows.length;
  keepBudget();
  return rows;
}

function sorted(rows: Raw[], kit: RentKit, blocked: Map<number, string>): { fits: RentOffer[]; near: RentOffer[] } {
  const usual = new Map<string, number>();
  for (const g of new Set(rows.map((o) => str(o, "gpu_name")))) {
    const peers = rows.filter((o) => str(o, "gpu_name") === g && num(o, "dlperf") > 0).map((o) => num(o, "dlperf"));
    // Too few peers say nothing about what's usual.
    const norm = HEALTHY[g] ?? (peers.length >= 6 ? median(peers) : 0);
    if (norm) usual.set(g, norm);
  }
  const all = rows.map((o) => offerOf(o, kit, usual, blocked)).filter((o) => o.price > 0);
  const fit = all.filter((o) => !o.misses.length && !o.blocked);
  fit.sort(kit.order === "reliable" ? (a, b) => (b.reliability ?? 0) - (a.reliability ?? 0) || a.price - b.price : (a, b) => a.price - b.price);
  // One machine can list several offers: its best one only.
  const seen = new Set<number>();
  const fits = fit.filter((o) => !seen.has(o.machine) && seen.add(o.machine));
  return { fits, near: all.filter((o) => o.misses.length || o.blocked).sort((a, b) => a.price - b.price) };
}

/** What every search of a kit asks for. vast lists one offer per bundle of look-alikes, picked by the query, and gives the same pick for minutes: each look asks for a few seconds less of listing time (`turn`), which picks differently. */
const about = (kit: RentKit, turn: number) => ({
  gpu_name: { in: kit.gpus },
  num_gpus: { eq: 1 },
  duration: { gte: Math.max(0, 86_400 - (turn % 3600)) },
  rentable: { eq: true },
  rented: { eq: false },
  external: { eq: false },
  type: "on-demand",
  allocated_storage: kit.diskGb,
});

/** Rows a look for fits asks for: the first few are all a hunt can rent. */
const FIT_ROWS = 16;
/** Whether vast takes a list of machines to leave out; one refusal and it's never sent again. */
const skips = globalThis as unknown as { __crackioVastNoSkip?: boolean };

/**
 * The fits of a kit now, best first. Every limit vast can check is checked there, and machines already turned down
 * (`skip`: the blacklist, and offers a hunt found unfit for a reason that won't change) are left out there too, so a
 * look that finds nothing new costs next to no rows of the day's allowance. What vast can't check (verified or not, a
 * weak card) and its price, which can leave the disk out, are checked again here; `turned` gets the machines that
 * failed for such a reason.
 */
export async function lookForFits(key: string, kit: RentKit, blocked: Map<number, string>, turn = 0, signal?: AbortSignal, skip: number[] = [], turned?: Set<number>): Promise<RentOffer[]> {
  if (!kit.gpus.length) return [];
  const out = [...new Set([...blocked.keys(), ...skip])].slice(0, 300);
  const query = (withSkip: boolean) => ({
    ...about(kit, turn),
    dph_total: { lte: kit.maxPrice },
    disk_space: { gte: kit.diskGb },
    disk_bw: { gte: MIN_DISK_MBPS },
    cuda_max_good: { gte: minCuda(kit) },
    ...(kit.minRamGb ? { cpu_ram: { gte: kit.minRamGb * 1000 } } : {}),
    ...(kit.minDown ? { inet_down: { gte: kit.minDown } } : {}),
    ...(kit.minUp ? { inet_up: { gte: kit.minUp } } : {}),
    ...(kit.maxTbCost != null ? { inet_down_cost: { lte: kit.maxTbCost / 1000 }, inet_up_cost: { lte: kit.maxTbCost / 1000 } } : {}),
    ...(kit.minReliability ? { reliability2: { gte: kit.minReliability } } : {}),
    ...(kit.skipCountries.length ? { geolocation: { notin: kit.skipCountries } } : {}),
    ...(withSkip && out.length ? { machine_id: { notin: out } } : {}),
    order: kit.order === "reliable" ? [["reliability2", "desc"], ["dph_total", "asc"]] : [["dph_total", "asc"]],
    limit: FIT_ROWS,
  });
  let rows: Raw[];
  try {
    rows = await search(key, query(!skips.__crackioVastNoSkip), signal);
  } catch (err) {
    if (!(err instanceof VastError) || err.status !== 400 || skips.__crackioVastNoSkip || !out.length) throw err;
    skips.__crackioVastNoSkip = true;
    rows = await search(key, query(false), signal);
  }
  const { fits, near } = sorted(rows, kit, blocked);
  // Unfit for good (not just dearer this minute): never asked for again in this hunt.
  if (turned) for (const o of near) if (o.blocked || o.misses.some((m) => m === "weak card" || m === o.verification || m === "slow disk")) turned.add(o.machine);
  return fits;
}

/** Rows a look at what's close asks for. */
const NEAR_ROWS = 30;

/** The fits and the near misses of a kit (up to a little over its price cap), each miss with why: for the page, on request. */
export async function lookAround(key: string, kit: RentKit, blocked: Map<number, string>, turn = 0, signal?: AbortSignal): Promise<{ fits: RentOffer[]; near: RentOffer[] }> {
  if (!kit.gpus.length) return { fits: [], near: [] };
  const rows = await search(key, { ...about(kit, turn), dph_total: { lte: kit.maxPrice + NEAR }, order: [["dph_total", "asc"]], limit: NEAR_ROWS }, signal);
  const { fits, near } = sorted(rows, kit, blocked);
  return { fits, near: near.filter((o) => o.price <= kit.maxPrice + NEAR) };
}

/**
 * The cards on offer (one GPU, on demand), each with how many and from what price: the picker's list. Two searches (all
 * cards, then the big ones again by themselves, because one offer per bundle of look-alikes hides most of them in a
 * search of everything): some 600 rows, so the page keeps the answer for a day (see the route).
 */
export async function market(key: string, diskGb: number, signal?: AbortSignal): Promise<MarketGpu[]> {
  const base = { num_gpus: { eq: 1 }, rentable: { eq: true }, rented: { eq: false }, external: { eq: false }, type: "on-demand", allocated_storage: diskGb, order: [["dph_total", "asc"]] };
  const seen = new Map<number, Raw>();
  for (const o of await search(key, { ...base, limit: 350 }, signal)) seen.set(num(o, "id"), o);
  // The closer look only adds to the list, so its failing costs nothing.
  for (const o of await search(key, { ...base, gpu_ram: { gte: 20_000 }, limit: 250 }, signal).catch(() => [] as Raw[])) seen.set(num(o, "id"), o);
  const by = new Map<string, MarketGpu>();
  for (const o of seen.values()) {
    const name = str(o, "gpu_name");
    const price = num(o, "dph_total");
    if (!name || !(price > 0)) continue;
    const g = by.get(name) ?? { name, gb: Math.round(num(o, "gpu_ram") / 1024), count: 0, from: price };
    g.count++;
    g.from = Math.min(g.from, price);
    by.set(name, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ renting */

type Template = { hash: string; image: string; tag: string; cuda: number };
type Which = RentKit["template"];
/** vast's own templates as they were when this was written (ComfyUI 2026-10-31, PyTorch 2026-11-03), for when the lookup fails. */
const PINNED: Record<Which, Template & { name: string }> = {
  comfyui: { name: "ComfyUI", hash: "433eb09ebc5e2eec355d62f8187c940f", image: "vastai/comfy", tag: "v0.43.0-cuda-13.2-py312", cuda: 13.2 },
  pytorch: { name: "PyTorch (Vast)", hash: "cd01fef018f5123708641836aaedffc7", image: "vastai/pytorch", tag: "", cuda: 12.4 },
};
const FALLBACK_CUDA = 12.9;

const g = globalThis as unknown as { __crackioRentTemplates?: Partial<Record<Which, { at: number; value: Promise<{ tpl: Template; fallback: string | null }> }>> };

/**
 * One of vast's official templates by its own name, looked up (they change with each release), and for ComfyUI that
 * release's CUDA 12.9 build, for hosts whose driver stops short of the template's own.
 */
function template(key: string, which: Which = "comfyui") {
  const kept = (g.__crackioRentTemplates ??= {});
  const hit = kept[which];
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;
  const value = (async () => {
    const pinned = PINNED[which];
    let tpl: Template = pinned;
    try {
      const rows = await vast<{ templates?: Raw[] }>(key, "GET", "/v0/template/", { params: { select_cols: JSON.stringify(["*"]), select_filters: JSON.stringify({ recommended: { eq: true } }) } });
      const t = (rows.templates ?? []).find((x) => x.name === pinned.name && x.image === pinned.image);
      if (t && typeof t.hash_id === "string") {
        const f = typeof t.extra_filters === "string" ? (JSON.parse(t.extra_filters) as Raw) : ((t.extra_filters as Raw | undefined) ?? {});
        const cuda = Number((f.cuda_max_good as { gte?: number } | undefined)?.gte ?? 0);
        tpl = { hash: t.hash_id, image: pinned.image, tag: typeof t.tag === "string" ? t.tag : "", cuda: cuda || pinned.cuda };
      }
    } catch {
      /* the pinned one */
    }
    let fallback: string | null = null;
    if (which === "comfyui" && tpl.cuda > FALLBACK_CUDA && tpl.tag) {
      const tag = tpl.tag.replace(/cuda-[0-9.]+/, `cuda-${FALLBACK_CUDA}`);
      const there = await fetch(`https://hub.docker.com/v2/repositories/${tpl.image}/tags/${tag}`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.ok, () => false);
      if (there) fallback = `${tpl.image}:${tag}`;
    }
    return { tpl, fallback };
  })();
  kept[which] = { at: Date.now(), value };
  value.catch(() => delete kept[which]);
  return value;
}

/**
 * Rents an offer with the kit's disk on the kit's template (vast's ComfyUI, or its PyTorch: Crackio's own connect then
 * installs ComfyUI there). Answers with the new box's id. "gone": someone was faster.
 */
export async function rentOffer(key: string, offer: RentOffer, kit: RentKit): Promise<{ id: string } | { gone: string }> {
  const which: Which = kit.template === "pytorch" ? "pytorch" : "comfyui";
  const { tpl, fallback } = await template(key, which);
  // ComfyUI's image is built for one CUDA; a host a little behind gets the same release's CUDA 12.9 build.
  const behind = which === "comfyui" && (offer.cuda ?? 99) < tpl.cuda;
  const image = behind ? fallback : null;
  if (behind && !fallback) return { gone: "its driver is too old for vast's ComfyUI image" };
  const label = `crackio-${kit.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "rent"}`;
  try {
    const r = await vast<{ success?: boolean; new_contract?: number }>(key, "PUT", `/v0/asks/${offer.id}/`, {
      body: { client_id: "me", template_hash_id: tpl.hash, disk: kit.diskGb, label, cancel_unavail: true, ...(image ? { image } : {}) },
    });
    if (r.success && r.new_contract) return { id: String(r.new_contract) };
    return { gone: JSON.stringify(r).slice(0, 200) };
  } catch (err) {
    // A listing that's gone by the time it's asked for (someone else rented it), or a ghost listing.
    if (err instanceof VastError && (err.status === 400 || err.status === 404 || err.status === 410 || /no_such_ask|not available|unavail/i.test(err.message))) return { gone: err.message.slice(0, 200) };
    throw err;
  }
}

export type VastBox = {
  id: string;
  /** null while it's placed; "loading" while its image pulls; then "running" (or "exited", "offline"). */
  status: string | null;
  intended: string | null;
  note: string;
  price: number;
  machine: number | null;
  host: number | null;
  gpu: string;
  place: string | null;
  label: string | null;
  startedAt: number | null;
};

const boxOf = (i: Raw): VastBox => ({
  id: String(i.id),
  status: str(i, "actual_status") || null,
  intended: str(i, "intended_status") || str(i, "cur_state") || null,
  note: str(i, "status_msg").replace(/\s+/g, " ").trim().slice(0, 200),
  price: num(i, "dph_total"),
  machine: num(i, "machine_id") || null,
  host: num(i, "host_id") || null,
  gpu: str(i, "gpu_name"),
  place: str(i, "geolocation") || null,
  label: str(i, "label") || null,
  startedAt: num(i, "start_date") ? num(i, "start_date") * 1000 : null,
});

/** One box on the account; null when it's gone. */
export async function box(key: string, id: string): Promise<VastBox | null> {
  const one = await vast<{ instances?: Raw | null }>(key, "GET", `/v0/instances/${encodeURIComponent(id)}/`, { params: { owner: "me" } });
  return one.instances && typeof one.instances === "object" && one.instances.id ? boxOf(one.instances) : null;
}

/** Every box on the account. */
export async function boxes(key: string): Promise<VastBox[]> {
  const out: VastBox[] = [];
  let after: string | null | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await vast<{ instances?: Raw[]; next_token?: string | null }>(key, "GET", "/v1/instances/", { params: { limit: "25", ...(after ? { after_token: after } : {}) } });
    out.push(...(res.instances ?? []).map(boxOf));
    after = res.next_token;
    if (!after) break;
  }
  return out;
}

/**
 * Whether a box can't come up, in vast's own words: an error while it's created or exited, or exited when it was asked
 * to run. A box someone stopped on purpose exits without an error, so it never counts.
 */
export function brokenWhy(b: VastBox): string | null {
  const error = /error/i.test(b.note);
  const broken = b.status !== "running" && ((error && (b.intended === "stopped" || b.status === "created" || b.status === "exited")) || (b.status === "exited" && b.intended === "running"));
  return broken ? b.note || `the container ${b.status}` : null;
}

/** Deletes a box. Only ever called for one that never ran (the hunt's own rule). True when it's gone. */
export async function deleteBox(key: string, id: string): Promise<boolean> {
  await vast(key, "DELETE", `/v0/instances/${encodeURIComponent(id)}/`).catch(() => null);
  for (let i = 0; i < 6; i++) {
    const still = await box(key, id).catch(() => undefined);
    if (still === null) return true;
    await sleep(5000);
  }
  return false;
}
