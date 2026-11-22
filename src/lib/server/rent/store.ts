import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import { newKit, RENT_LIMITS, type Blocked, type RentKit, type Verification } from "@/lib/rent/types";

/**
 * Rent's saved things, in data/rent.json: the kits and the blacklist (machines never rented again, each with why). The
 * first read takes over the hosts the old watcher script learned not to rent (data/gpu/vast-skip.json).
 */
type Saved = { kits: RentKit[]; blocked: Blocked[] };

const FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "rent.json");
const OLD_SKIPS = path.join(/*turbopackIgnore: true*/ DATA_DIR, "gpu", "vast-skip.json");
const g = globalThis as unknown as { __crackioRent?: Promise<Saved>; __crackioRentWrites?: Promise<unknown> };

async function first(): Promise<Saved> {
  const text = await fs.readFile(/*turbopackIgnore: true*/ FILE, "utf8").catch(() => null);
  if (text) {
    try {
      const j = JSON.parse(text) as Partial<Saved>;
      return { kits: (j.kits ?? []).map(clean), blocked: j.blocked ?? [] };
    } catch {
      /* a broken file starts over, below */
    }
  }
  const old = await fs.readFile(/*turbopackIgnore: true*/ OLD_SKIPS, "utf8").then((t) => JSON.parse(t) as Record<string, string>, () => ({}) as Record<string, string>);
  const blocked: Blocked[] = Object.entries(old)
    .filter(([id]) => Number.isInteger(Number(id)))
    .map(([id, reason]) => ({ provider: "vast" as const, machine: Number(id), reason: String(reason).slice(0, 240), at: Date.now(), auto: true }));
  return { kits: [], blocked };
}

const read = () => (g.__crackioRent ??= first());

function change<T>(fn: (s: Saved) => T): Promise<T> {
  const next = (g.__crackioRentWrites ?? Promise.resolve()).then(async () => {
    const all = structuredClone(await read());
    const out = fn(all);
    g.__crackioRent = Promise.resolve(all);
    await writeFileAtomic(FILE, JSON.stringify(all, null, 1));
    return out;
  });
  g.__crackioRentWrites = next.catch(() => undefined);
  return next;
}

const between = (v: unknown, [lo, hi]: readonly [number, number], or: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : or);
const orNull = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : null);
const VERIFICATIONS: Verification[] = ["verified", "unverified", "deverified"];

/** A kit as it's saved: every number inside its limits, whatever was sent. */
export function clean(k: Partial<RentKit> & { id: string }): RentKit {
  const d = newKit(k.id);
  const verification = (Array.isArray(k.verification) ? k.verification : d.verification).filter((v) => VERIFICATIONS.includes(v));
  return {
    id: k.id,
    name: (typeof k.name === "string" ? k.name : d.name).trim().slice(0, 40) || d.name,
    provider: "vast",
    gpus: [...new Set((Array.isArray(k.gpus) ? k.gpus : []).filter((x) => typeof x === "string" && x.length <= 40))].slice(0, 40),
    diskGb: Math.round(between(k.diskGb, RENT_LIMITS.disk, d.diskGb)),
    maxPrice: Math.round(between(k.maxPrice, RENT_LIMITS.price, d.maxPrice) * 1000) / 1000,
    maxTbCost: orNull(k.maxTbCost, 0.01, 1000),
    minDown: orNull(k.minDown, 1, 100_000),
    minUp: orNull(k.minUp, 1, 100_000),
    minRamGb: orNull(k.minRamGb, 1, 4096),
    minReliability: orNull(k.minReliability, 0.5, 0.999),
    verification: verification.length ? verification : d.verification,
    skipCountries: [...new Set((Array.isArray(k.skipCountries) ? k.skipCountries : []).map((c) => String(c).toUpperCase().slice(0, 2)).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 60),
    order: k.order === "reliable" ? "reliable" : "cheapest",
    template: k.template === "pytorch" ? "pytorch" : "comfyui",
    boxes: Math.round(between(k.boxes, RENT_LIMITS.boxes, d.boxes)),
    idleStopMin: Math.round(between(k.idleStopMin, RENT_LIMITS.idleStop, d.idleStopMin)),
    hours: between(k.hours, RENT_LIMITS.hours, d.hours),
    minBalance: between(k.minBalance, RENT_LIMITS.minBalance, d.minBalance),
  };
}

export const rentKits = async () => (await read()).kits;
export const rentKit = async (id: string) => (await read()).kits.find((k) => k.id === id) ?? null;
export const rentBlocked = async () => (await read()).blocked;

/** The blacklist as the search wants it: machine → why. */
export async function blockedMap(): Promise<Map<number, string>> {
  return new Map((await read()).blocked.map((b) => [b.machine, b.reason]));
}

export function saveKit(kit: RentKit): Promise<RentKit> {
  const k = clean(kit);
  return change((s) => {
    const at = s.kits.findIndex((x) => x.id === k.id);
    if (at >= 0) s.kits[at] = k;
    else s.kits.push(k);
    return k;
  });
}

export const deleteKit = (id: string) => change((s) => void (s.kits = s.kits.filter((k) => k.id !== id)));

export function block(entry: Omit<Blocked, "at" | "provider">): Promise<void> {
  return change((s) => {
    s.blocked = s.blocked.filter((b) => b.machine !== entry.machine);
    s.blocked.unshift({ ...entry, provider: "vast", reason: entry.reason.trim().slice(0, 240) || "Blocked by you", at: Date.now() });
  });
}

export const unblock = (machine: number) => change((s) => void (s.blocked = s.blocked.filter((b) => b.machine !== machine)));
