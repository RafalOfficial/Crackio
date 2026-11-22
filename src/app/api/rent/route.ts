import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { MarketGpu, RentLook, RentOffer } from "@/lib/rent/types";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import { allHunts, dismissHunt, huntOffers, hunting, startHunt, stopHunt } from "@/lib/server/rent/hunt";
import { block, blockedMap, clean, deleteKit, rentBlocked, rentKit, rentKits, saveKit, unblock } from "@/lib/server/rent/store";
import { boxes, lookAround, lookForFits, market, searchBudget, VastError, VastQuota } from "@/lib/server/rent/vast";
import { getSettings } from "@/lib/server/settings";
import { creditNow } from "@/lib/server/setup/cloud-money";

/**
 * Settings → Rent. GET: the kits, the hunts under way, the blacklist, the account's balance and how much of the day's
 * search allowance is used; `?market=1` adds the cards on offer (kept for a day; `&refresh=1` reads them again),
 * `?boxes=1` the boxes on the account. POST: save or delete a kit, look at what fits a kit now (`wide`: what's close
 * too), switch a hunt on or off, rent one offer, block or unblock a machine.
 *
 * Renting spends the user's money, so switching a hunt on (and renting an offer) is only taken from Crackio's own
 * screen: a request that a browser sent from this site. No agent tool reaches it.
 *
 * vast.ai counts every row a search returns against a daily allowance, so nothing here searches more than it must: the
 * card list is read once a day, a look is kept for a while, and what's close is only looked up when asked for.
 */

const noStore = { headers: { "Cache-Control": "no-store" } };

async function look(): Promise<RentLook> {
  const [s, kits, blocked] = await Promise.all([getSettings(), rentKits(), rentBlocked()]);
  return { key: Boolean(s.keys.vast), balance: creditNow().find((c) => c.provider === "vast")?.balance ?? null, kits, hunts: allHunts(), blocked, search: searchBudget() };
}

/* The cards on offer: some 600 search rows to read, so the answer is kept on disk and read again once a day at most. */
type Cards = { at: number; disk: number; cards: MarketGpu[] };
const CARDS_FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "rent-market.json");
const DAY = 24 * 3600_000;
const cache = globalThis as unknown as { __crackioRentCards?: Promise<Cards | null>; __crackioRentCardsAsked?: number; __crackioRentCardsReading?: Promise<Cards | null> | null };

async function cards(key: string, refresh: boolean): Promise<Cards | null> {
  cache.__crackioRentCards ??= fs.readFile(/*turbopackIgnore: true*/ CARDS_FILE, "utf8").then((t) => JSON.parse(t) as Cards, () => null);
  const have = await cache.__crackioRentCards;
  // One read at a time: the page's first request and its next poll both arrive before the first read is back, and each
  // read is some 600 rows of the day's search allowance (the first night it ran, the list was read twice at once).
  if (cache.__crackioRentCardsReading) return cache.__crackioRentCardsReading;
  const stale = !have || Date.now() - have.at > DAY;
  // And never two reads close together, whatever the first one came to: by hand ten minutes apart at the earliest, by
  // itself half an hour (a read that fails or comes back empty must not be tried again on every poll).
  const since = Date.now() - (cache.__crackioRentCardsAsked ?? 0);
  if (!(refresh ? since > 600_000 : stale && since > 1_800_000) || searchBudget().blockedUntil) return have;
  cache.__crackioRentCardsAsked = Date.now();
  const reading = (async () => {
    try {
      const next: Cards = { at: Date.now(), disk: 120, cards: await market(key, 120) };
      if (!next.cards.length) return have;
      cache.__crackioRentCards = Promise.resolve(next);
      await writeFileAtomic(CARDS_FILE, JSON.stringify(next));
      return next;
    } catch {
      return have;
    }
  })().finally(() => (cache.__crackioRentCardsReading = null));
  cache.__crackioRentCardsReading = reading;
  return reading;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const out: Record<string, unknown> = { ...(await look()) };
  const key = (await getSettings()).keys.vast;
  // Each on its own: the card list failing (a used-up search allowance) mustn't take the list of your boxes with it.
  const tried = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (!(err instanceof VastQuota)) out.error = err instanceof VastError ? err.message : "vast.ai didn't answer.";
    }
  };
  if (q.get("market") && key) {
    await tried(async () => {
      const have = await cards(key, Boolean(q.get("refresh")));
      out.market = have?.cards ?? [];
      out.marketAt = have?.at ?? null;
    });
  }
  if (q.get("boxes") && key) {
    await tried(async () => {
      out.boxes = (await boxes(key)).map((b) => ({ id: b.id, label: b.label ?? `#${b.id}`, gpu: b.gpu, state: b.status ?? "starting", price: b.price || null, machine: b.machine, host: b.host, place: b.place }));
    });
  }
  out.search = searchBudget();
  return Response.json(out, noStore);
}

const Kit = z
  .object({
    id: z.string().min(1).max(40),
    name: z.string().max(60),
    gpus: z.array(z.string().max(40)).max(40),
    diskGb: z.number(),
    maxPrice: z.number(),
    maxTbCost: z.number().nullable(),
    minDown: z.number().nullable(),
    minUp: z.number().nullable(),
    minRamGb: z.number().nullable(),
    minReliability: z.number().nullable(),
    verification: z.array(z.enum(["verified", "unverified", "deverified"])),
    skipCountries: z.array(z.string().max(3)).max(60),
    order: z.enum(["cheapest", "reliable"]),
    template: z.enum(["comfyui", "pytorch"]).optional(),
    boxes: z.number(),
    idleStopMin: z.number(),
    hours: z.number(),
    minBalance: z.number(),
  })
  .passthrough();

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("new-kit") }),
  z.object({ action: z.literal("save-kit"), kit: Kit }),
  z.object({ action: z.literal("delete-kit"), id: z.string().max(40) }),
  z.object({ action: z.literal("look"), kit: Kit, wide: z.boolean().optional() }),
  z.object({ action: z.literal("start"), id: z.string().max(40), dry: z.boolean().optional() }),
  z.object({ action: z.literal("stop"), id: z.string().max(40) }),
  z.object({ action: z.literal("dismiss"), id: z.string().max(40) }),
  z.object({ action: z.literal("rent"), id: z.string().max(40), offer: z.number().int() }),
  z.object({ action: z.literal("block"), machine: z.number().int(), host: z.number().int().nullable().optional(), gpu: z.string().max(40).optional(), place: z.string().max(80).optional(), reason: z.string().max(240) }),
  z.object({ action: z.literal("unblock"), machine: z.number().int() }),
]);

/** A request a browser sent from Crackio's own pages (not a script, not an agent, not another site). */
function fromOurScreen(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return Boolean(origin && host && new URL(origin).host === host);
  } catch {
    return false;
  }
}

type Seen = { fits: RentOffer[]; near: RentOffer[]; wide: boolean };
const looks = new Map<string, { at: number; value: Seen }>();

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.action === "new-kit") {
      const kit = await saveKit(clean({ id: nanoid(8) }));
      return Response.json({ kit, ...(await look()) }, noStore);
    }
    if (b.action === "save-kit") {
      // A hunt keeps the limits it started with: a kit changed under it would rent what was never agreed to.
      if (hunting(b.kit.id)) return Response.json({ error: "Stop this kit's hunt before changing it." }, { status: 409 });
      const kit = await saveKit(clean(b.kit));
      return Response.json({ kit, ...(await look()) }, noStore);
    }
    if (b.action === "delete-kit") {
      stopHunt(b.id);
      dismissHunt(b.id);
      await deleteKit(b.id);
      return Response.json(await look(), noStore);
    }
    if (b.action === "look") {
      const key = (await getSettings()).keys.vast;
      if (!key) return Response.json({ error: "Add your vast.ai key under Settings → Accounts first." }, { status: 400 });
      const kit = clean(b.kit);
      const wide = b.wide === true;
      // A running hunt has just looked: its answer is the freshest there is, and costs nothing more.
      const live = !wide && hunting(kit.id) ? huntOffers(kit.id) : null;
      if (live) return Response.json({ ...live, wide: false, search: searchBudget() }, noStore);
      const id = JSON.stringify([kit, wide]);
      const have = looks.get(id);
      // The fits are kept for 20 seconds, what's close for a minute: the same question isn't paid for twice.
      if (have && Date.now() - have.at < (wide ? 60_000 : 20_000)) return Response.json({ ...have.value, search: searchBudget() }, noStore);
      const turn = Math.floor(Date.now() / 1000) % 3600;
      const value: Seen = wide ? { ...(await lookAround(key, kit, await blockedMap(), turn, request.signal)), wide } : { fits: await lookForFits(key, kit, await blockedMap(), turn, request.signal), near: [], wide };
      looks.set(id, { at: Date.now(), value });
      if (looks.size > 30) looks.delete(looks.keys().next().value!);
      return Response.json({ ...value, search: searchBudget() }, noStore);
    }
    if (b.action === "start" || b.action === "rent") {
      const dry = b.action === "start" && b.dry === true;
      if (!dry && !fromOurScreen(request)) return Response.json({ error: "Only you can rent: switch a hunt on in Crackio → Settings → Rent." }, { status: 403 });
      const kit = await rentKit(b.id);
      if (!kit) return Response.json({ error: "No such kit." }, { status: 404 });
      if (!kit.gpus.length) return Response.json({ error: "Pick at least one card for this kit first." }, { status: 400 });
      if (hunting(kit.id)) return Response.json({ error: "This kit is hunting already." }, { status: 409 });
      startHunt(kit, { dry, ...(b.action === "rent" ? { only: b.offer } : {}) });
      return Response.json(await look(), noStore);
    }
    if (b.action === "stop") stopHunt(b.id);
    else if (b.action === "dismiss") dismissHunt(b.id);
    else if (b.action === "block") await block({ machine: b.machine, host: b.host ?? null, gpu: b.gpu, place: b.place, reason: b.reason });
    else await unblock(b.machine);
    return Response.json(await look(), noStore);
  } catch (err) {
    // (Not an error status: it's a state the page shows, and a 429 here would read as Crackio's own fault.)
    if (err instanceof VastQuota) return Response.json({ error: err.message, search: searchBudget() }, noStore);
    return Response.json({ error: err instanceof VastError ? err.message : (err as Error).message }, { status: err instanceof VastError ? 502 : 500 });
  }
}
