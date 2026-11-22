import "server-only";
import type { FeedKind, Hunt, RentKit, RentOffer } from "@/lib/rent/types";
import { forgetRentedBoxes } from "@/lib/server/cloud-accounts";
import { getSettings } from "@/lib/server/settings";
import { creditFresh, setAutoStop } from "@/lib/server/setup/cloud-money";
import { block, blockedMap } from "./store";
import { box as lookAtBox, brokenWhy, deleteBox, lookForFits, rentOffer, searchBudget, VastError, VastQuota, type VastBox } from "./vast";

/**
 * A hunt: a kit switched on. Every few seconds it looks at the market and rents the first fit, then watches that box
 * until its cloud says it runs. Its rails:
 * - it rents the kit's number of boxes (one, unless you set more) and stops;
 * - the price cap counts the disk, and is checked again on the rented box;
 * - it stops when the account's balance is under the kit's floor, and by itself after the kit's hours;
 * - every rented box gets the kit's idle stop the moment it's rented;
 * - it deletes only a box that never ran (one that failed to start), and puts that machine on the blacklist;
 * - a hunt lives in this server only: it never starts by itself, and a restart ends it;
 * - vast.ai allows an account only so many search rows a day: a look asks for the fits alone, leaves out machines it
 *   already turned down, slows down when looks cost rows, and waits when vast says the day's allowance is gone.
 */

type Watch = {
  id: string;
  offer: RentOffer;
  rentedAt: number;
  seen: string;
  changedAt: number;
  bad: number;
  priced: boolean;
  ready: boolean;
};

type Live = {
  hunt: Hunt;
  kit: RentKit;
  abort: AbortController;
  /** Stop looking for more; boxes still starting are watched to the end. */
  enough: boolean;
  boxes: Map<string, Watch>;
  /** Offers not asked for again before a time: gone when asked, or a ghost listing. */
  later: Map<number, number>;
  gone: Map<number, number>;
  /** "Rent now": this one offer, then nothing more. */
  only?: number;
  lastOffers: { fits: RentOffer[]; near: RentOffer[] };
  /** Machines turned down for a reason that won't change (not verified, a weak card): left out of the next looks. */
  turned: Set<number>;
};

const g = globalThis as unknown as { __crackioRentHunts?: Map<string, Live> };
const hunts = () => (g.__crackioRentHunts ??= new Map());

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const STALL_MIN = 4; // a working host shows signs of life within a minute or two of the rent
const OFFLINE_MIN = 3; // a host its cloud reports offline this long isn't coming back soon
const QUIET_MIN = 10; // one unchanged status this long before the box runs means it's stuck
const BOOT_MIN = 30; // rent to running

const money = (n: number) => `$${n.toFixed(3)}/h`;
const card = (o: RentOffer) => `${o.gpu} · ${money(o.price)} · ${o.place}`;

function say(live: Live, kind: FeedKind, text: string) {
  live.hunt.feed.push({ at: Date.now(), kind, text });
  if (live.hunt.feed.length > 80) live.hunt.feed.splice(0, live.hunt.feed.length - 80);
}

function end(live: Live, state: Hunt["state"], why: string) {
  live.hunt.state = state;
  live.hunt.why = why;
  say(live, state === "done" ? "ready" : state === "failed" ? "failed" : "stopped", why);
  live.abort.abort();
}

export const allHunts = (): Hunt[] => [...hunts().values()].map((l) => l.hunt);
export const huntOffers = (kit: string) => hunts().get(kit)?.lastOffers ?? null;
const running = (l: Live | undefined) => Boolean(l && (l.hunt.state === "hunting" || l.hunt.state === "renting" || l.hunt.state === "starting"));
export const hunting = (kit: string) => running(hunts().get(kit));

export function startHunt(kit: RentKit, opts: { dry?: boolean; only?: number } = {}): Hunt {
  if (hunting(kit.id)) return hunts().get(kit.id)!.hunt;
  const now = Date.now();
  const live: Live = {
    hunt: { kit: kit.id, state: "hunting", dry: Boolean(opts.dry), startedAt: now, endsAt: now + kit.hours * 3600_000, looks: 0, fits: 0, rented: [], feed: [] },
    kit,
    abort: new AbortController(),
    enough: false,
    boxes: new Map(),
    later: new Map(),
    gone: new Map(),
    only: opts.only,
    lastOffers: { fits: [], near: [] },
    turned: new Set(),
  };
  hunts().set(kit.id, live);
  say(live, "hunt", `${opts.dry ? "Test run: looking" : "Looking"} for ${kit.gpus.join(", ") || "no card yet"} at ${money(kit.maxPrice)} or less, ${kit.diskGb} GB disk.`);
  void run(live).catch((err) => {
    if (running(live)) end(live, "failed", err instanceof Error ? err.message : String(err));
  });
  return live.hunt;
}

/** Stops looking. A box already rented stays rented, and one still starting is watched until it runs or fails. */
export function stopHunt(kit: string) {
  const live = hunts().get(kit);
  if (!live || !running(live)) return;
  live.enough = true;
  const starting = [...live.boxes.values()].filter((b) => !b.ready).length;
  if (!starting) end(live, live.hunt.rented.length ? "done" : "stopped", live.hunt.rented.length ? "Stopped. What it rented stays yours." : "Stopped. Nothing was rented.");
  else say(live, "info", `Stopped looking. ${starting === 1 ? "The box that's starting is" : `${starting} boxes that are starting are`} watched until ${starting === 1 ? "it runs" : "they run"}.`);
}

/** Forgets a hunt that ended (its card goes from the screen). */
export function dismissHunt(kit: string) {
  if (!hunting(kit)) hunts().delete(kit);
}

async function balance(): Promise<number | null> {
  const credit = await creditFresh().catch(() => []);
  const v = credit.find((c) => c.provider === "vast");
  return v ? v.balance : null;
}

async function run(live: Live) {
  const { hunt, kit, abort } = live;
  const key = (await getSettings()).keys.vast;
  if (!key) return end(live, "failed", "Add your vast.ai key under Settings → Accounts first.");
  if (!kit.gpus.length) return end(live, "failed", "Pick at least one card for this kit.");
  let turn = Math.floor(Math.random() * 600);
  let balanceAt = 0;
  let boxesAt = 0;
  let cost = 0;
  while (!abort.signal.aborted) {
    const now = Date.now();
    const starting = [...live.boxes.values()].filter((b) => !b.ready);
    const want = live.only != null ? 1 : kit.boxes;
    const need = live.enough ? 0 : want - live.boxes.size;

    if (now - boxesAt > 10_000 && starting.length) {
      boxesAt = now;
      for (const b of starting) await tend(live, key, b).catch((err) => say(live, "info", `Couldn't read box ${b.id}: ${(err as Error).message.slice(0, 120)}`));
    }
    if (!live.boxes.size || [...live.boxes.values()].every((b) => b.ready)) {
      if (live.boxes.size >= want) return end(live, "done", `${live.boxes.size === 1 ? "Your box is" : `${live.boxes.size} boxes are`} running. Crackio connects ${live.boxes.size === 1 ? "it" : "them"} by itself.`);
      if (live.enough) return end(live, live.hunt.rented.length ? "done" : "stopped", live.hunt.rented.length ? "Stopped. What it rented stays yours." : "Stopped. Nothing was rented.");
    }
    hunt.state = need > 0 ? "hunting" : "starting";

    if (need > 0) {
      if (now > hunt.endsAt) {
        live.enough = true;
        say(live, "stopped", `Nothing fit in ${kit.hours} h: it stopped looking by itself.`);
        continue;
      }
      if (now - balanceAt > 60_000 && !hunt.dry) {
        balanceAt = now;
        const left = await balance();
        if (left != null && left < kit.minBalance) {
          live.enough = true;
          say(live, "stopped", `Your vast.ai balance ($${left.toFixed(2)}) is under the kit's floor ($${kit.minBalance}): it stopped looking.`);
          continue;
        }
      }
      try {
        const before = searchBudget().used;
        const fits = await lookForFits(key, kit, await blockedMap(), turn++, abort.signal, [...live.turned], live.turned);
        cost = searchBudget().used - before;
        live.lastOffers = { fits, near: [] };
        hunt.looks++;
        hunt.fits = fits.length;
        const have = new Set([...live.boxes.values()].map((b) => b.offer.machine));
        const open = fits.filter((o) => !have.has(o.machine) && Date.now() >= (live.later.get(o.id) ?? 0) && (live.only == null || o.id === live.only));
        if (live.only != null && !open.length) {
          live.enough = true;
          say(live, "missed", "That offer is gone: someone else rented it, or its price changed.");
          continue;
        }
        let left = need;
        for (const o of open) {
          if (left <= 0 || abort.signal.aborted) break;
          if (hunt.dry) {
            say(live, "found", `Would rent ${card(o)} · ${o.verification}${o.reliability ? ` · ${Math.round(o.reliability * 100)}% reliable` : ""}. A test run rents nothing.`);
            return end(live, "done", "Test run over: a fit was there.");
          }
          hunt.state = "renting";
          say(live, "found", `${card(o)}: renting it.`);
          const got = await rentOffer(key, o, kit);
          if ("gone" in got) {
            const times = (live.gone.get(o.id) ?? 0) + 1;
            live.gone.set(o.id, times);
            // A ghost listing fails every time: after two tries it's left alone for the rest of the hunt.
            live.later.set(o.id, times >= 2 ? Number.MAX_SAFE_INTEGER : Date.now() + 30_000);
            say(live, "missed", `${card(o)}: gone before it could be rented.`);
            continue;
          }
          left--;
          live.boxes.set(got.id, { id: got.id, offer: o, rentedAt: Date.now(), seen: "", changedAt: Date.now(), bad: 0, priced: false, ready: false });
          hunt.rented.push({ id: got.id, gpu: o.gpu, price: o.price, place: o.place, ready: false });
          say(live, "rented", `Rented ${card(o)} (box ${got.id})${kit.template === "pytorch" ? " on PyTorch: Crackio installs ComfyUI there once it has joined" : ""}. It stops itself after ${kit.idleStopMin} idle minutes.`);
          // The idle stop goes on at once: a box nobody comes back to never bills for long.
          await setAutoStop(`vast:${got.id}`, kit.idleStopMin, undefined, "stop").catch(() => say(live, "info", `Couldn't set box ${got.id}'s idle stop: set it under Settings → Machines.`));
          forgetRentedBoxes();
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        if (err instanceof VastQuota) {
          // The day's search allowance is gone: nothing to do but wait for vast's day to turn (or for the hunt's own end).
          const until = Math.min(err.until, hunt.endsAt);
          say(live, "info", `${err.own ? "Crackio has used its own share of vast.ai's daily searches" : "vast.ai's daily search allowance is used up"}. ${until < hunt.endsAt ? `Looking again at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}.` : "This hunt ends before it comes back."}`);
          await sleep(Math.max(5000, until - Date.now()), abort.signal);
          continue;
        }
        const refused = err instanceof VastError && (err.status === 401 || err.status === 403);
        if (refused) return end(live, "failed", (err as Error).message);
        say(live, "info", (err as Error).message.slice(0, 200));
        if (err instanceof VastError && err.status === 429) await sleep(30_000, abort.signal);
      }
    }
    // A steady look every 5 to 8 seconds, never all hunts on the same beat. A look that came back with rows (offers
    // that didn't fit after all) costs the day's allowance, so the next one waits longer in proportion, up to a minute.
    await sleep(Math.min(60_000, (5000 + Math.random() * 3000) * Math.max(1, cost / 3)), abort.signal);
    cost = 0;
  }
}

/** One look at a box on its way up: running (kept from then on, whatever happens), or failed before it ever ran. */
async function tend(live: Live, key: string, b: Watch) {
  const { kit, hunt } = live;
  const now = Date.now();
  const inst = await lookAtBox(key, b.id);
  const row = hunt.rented.find((r) => r.id === b.id);
  const drop = () => {
    live.boxes.delete(b.id);
    hunt.rented = hunt.rented.filter((r) => r.id !== b.id);
  };
  if (!inst) {
    say(live, "failed", `Box ${b.id} is gone from the account.`);
    return drop();
  }
  // The price it really bills: the cap is a hard one.
  if (!b.priced && inst.price > 0) {
    b.priced = true;
    if (row) row.price = inst.price;
    if (inst.price > kit.maxPrice + 0.001 && inst.status !== "running") {
      say(live, "failed", `Box ${b.id} bills ${money(inst.price)}, over your ${money(kit.maxPrice)} cap: deleting it before it starts.`);
      if (!(await deleteBox(key, b.id))) say(live, "failed", `Box ${b.id} still shows after deleting it: delete it on vast.ai by hand.`);
      live.later.set(b.offer.id, Number.MAX_SAFE_INTEGER);
      return drop();
    }
  }
  const status = inst.status ?? "creating";
  const seen = `${status}|${inst.note}`;
  if (seen !== b.seen) {
    b.seen = seen;
    b.changedAt = now;
    if (status !== "running") say(live, "boot", `Box ${b.id}: ${status}${inst.note ? ` · ${inst.note.slice(0, 120)}` : ""}`);
  }
  if (status === "running") {
    b.ready = true;
    if (row) row.ready = true;
    say(live, "ready", `Box ${b.id} (${b.offer.gpu}) is running.`);
    forgetRentedBoxes();
    return;
  }
  const why = failed(inst, b, now);
  if (!why) return;
  say(live, "failed", `Box ${b.id} (${b.offer.place}) didn't start: ${why}. Deleting it and never renting that machine again.`);
  const gone = await deleteBox(key, b.id);
  if (!gone) say(live, "failed", `Box ${b.id} still shows after deleting it: delete it on vast.ai by hand.`);
  await block({ machine: b.offer.machine, host: b.offer.host, gpu: b.offer.gpu, place: b.offer.place, reason: why.slice(0, 200), auto: true });
  drop();
}

/** Why a box that isn't running yet is given up on; null while it may still get there. */
function failed(inst: VastBox, b: Watch, now: number): string | null {
  const broken = brokenWhy(inst);
  b.bad = broken ? b.bad + 1 : 0;
  // Three looks in a row: one odd status between two good ones isn't a failure.
  if (broken && b.bad >= 3) return broken;
  const status = inst.status ?? "creating";
  const age = (now - (inst.startedAt ?? b.rentedAt)) / 60_000;
  const quiet = (now - b.changedAt) / 60_000;
  if (status === "creating" && !inst.note && age > STALL_MIN) return `no sign of life ${Math.round(age)} min after the rent`;
  if (status === "offline" && quiet > OFFLINE_MIN) return `its host went offline for ${Math.round(quiet)} min`;
  if (quiet > QUIET_MIN) return `stuck at "${status}" for ${Math.round(quiet)} min`;
  if (age > BOOT_MIN) return `not running ${Math.round(age)} min after the rent`;
  return null;
}
