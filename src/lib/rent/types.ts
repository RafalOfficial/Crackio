/**
 * Rent (Settings → Rent): finding a GPU on a cloud market and renting it the moment one fits. A kit is a saved set of
 * limits ("cheap 5090"); a hunt is a kit switched on: Crackio looks every few seconds and rents the first fit. Shared
 * by the server (lib/server/rent) and the screen.
 */

export type RentProvider = "vast";

export type Verification = "verified" | "unverified" | "deverified";

export type RentKit = {
  id: string;
  name: string;
  provider: RentProvider;
  /** The cards it may rent, by the market's own names ("RTX 5090", "A100 SXM4"). */
  gpus: string[];
  /** Disk to rent with the box, GB. The price cap counts its cost. */
  diskGb: number;
  /** Dollars an hour at most, disk included. A hard cap. */
  maxPrice: number;
  /** Dollars per TB at most, each way; null: any. */
  maxTbCost: number | null;
  /** Mb/s at least, down and up; null: any. */
  minDown: number | null;
  minUp: number | null;
  /** System memory, GB at least; null: any. */
  minRamGb: number | null;
  /** Share of time the host was up (0–1) at least; null: any. */
  minReliability: number | null;
  verification: Verification[];
  /** Countries never rented in, by two-letter code. */
  skipCountries: string[];
  /** Which fit is taken first. */
  order: "cheapest" | "reliable";
  /**
   * What the box starts with. "comfyui": vast.ai's ComfyUI template, ready sooner. "pytorch": its PyTorch template,
   * which also runs on hosts with older drivers (more boxes to pick from, often cheaper ones); Crackio installs
   * ComfyUI there itself once the box has joined, a few minutes more.
   */
  template: "comfyui" | "pytorch";
  /** How many boxes one hunt rents before it stops. */
  boxes: number;
  /** A rented box stops itself after this many idle minutes. */
  idleStopMin: number;
  /** A hunt gives up by itself after this many hours. */
  hours: number;
  /** A hunt stops when the account's balance is under this, dollars. */
  minBalance: number;
};

export const RENT_LIMITS = {
  disk: [20, 2000],
  price: [0.02, 20],
  boxes: [1, 4],
  idleStop: [5, 24 * 60],
  hours: [0.25, 24],
  minBalance: [0, 500],
} as const;

export const newKit = (id: string): RentKit => ({
  id,
  name: "New kit",
  provider: "vast",
  gpus: [],
  diskGb: 120,
  maxPrice: 0.4,
  maxTbCost: 5,
  minDown: 200,
  minUp: 200,
  minRamGb: 32,
  minReliability: null,
  verification: ["verified", "unverified"],
  skipCountries: [],
  order: "cheapest",
  template: "comfyui",
  boxes: 1,
  idleStopMin: 15,
  hours: 3,
  minBalance: 1,
});

/** One box on offer, as the screen shows it. */
export type RentOffer = {
  id: number;
  machine: number;
  host: number | null;
  gpu: string;
  gpuGb: number;
  /** Dollars an hour with the kit's disk. */
  price: number;
  country: string;
  place: string;
  ramGb: number;
  down: number;
  up: number;
  /** Dollars per TB, the dearer of down and up. */
  tbCost: number;
  reliability: number | null;
  verification: Verification;
  cuda: number | null;
  /** Why it isn't a fit, in a few words each; empty for a fit. */
  misses: string[];
  blocked?: string;
};

/** A card on the market now: how many are on offer and from what price. */
export type MarketGpu = { name: string; gb: number; count: number; from: number };

export type Blocked = {
  provider: RentProvider;
  /** The physical machine (a host can have several). */
  machine: number;
  host?: number | null;
  gpu?: string;
  place?: string;
  reason: string;
  at: number;
  /** Crackio put it here itself, after a box there failed to start. */
  auto?: boolean;
};

export type FeedKind = "hunt" | "found" | "missed" | "rented" | "boot" | "ready" | "failed" | "stopped" | "info";
export type FeedLine = { at: number; kind: FeedKind; text: string };

export type HuntState = "hunting" | "renting" | "starting" | "done" | "stopped" | "failed";

export type Hunt = {
  kit: string;
  state: HuntState;
  /** A test: it finds and says what it would rent, and rents nothing. */
  dry: boolean;
  startedAt: number;
  endsAt: number;
  /** Looks at the market so far. */
  looks: number;
  /** Fits seen on the last look. */
  fits: number;
  /** Boxes rented and kept, by their id on the cloud. */
  rented: { id: string; gpu: string; price: number; place: string; ready: boolean }[];
  feed: FeedLine[];
  /** Why it ended, in plain words. */
  why?: string;
};

export type RentedNow = { id: string; label: string; gpu: string; state: string; price: number | null; machine: number | null; host: number | null; place: string | null };

export type RentLook = {
  /** The cloud account's key is saved. */
  key: boolean;
  balance: number | null;
  kits: RentKit[];
  hunts: Hunt[];
  blocked: Blocked[];
  /**
   * Searching the cloud's market: the rows Crackio used today, the rows a day it allows itself (a share of the cloud's
   * own allowance, `vastLimit`, so the rest stays for renting by hand), and until when searching is refused (ms; null:
   * it isn't). `own`: stopped by Crackio's own cap, not the cloud's.
   */
  search: { used: number; limit: number; vastLimit: number; blockedUntil: number | null; own: boolean };
};

/** Cards worth offering in the picker before the market has been read (or while it can't be). */
export const KNOWN_GPUS: MarketGpu[] = [
  ["RTX 5090", 32],
  ["RTX 4090", 24],
  ["RTX 3090", 24],
  ["RTX 3090 Ti", 24],
  ["RTX 5080", 16],
  ["H200", 140],
  ["H100 SXM", 80],
  ["H100 NVL", 94],
  ["H100 PCIE", 80],
  ["A100 SXM4", 40],
  ["A100 PCIE", 40],
  ["L40S", 45],
  ["L40", 45],
  ["A40", 45],
  ["RTX PRO 6000 WS", 96],
  ["RTX 6000Ada", 48],
  ["RTX A6000", 48],
  ["RTX 5000Ada", 32],
  ["RTX A5000", 24],
].map(([name, gb]) => ({ name: name as string, gb: gb as number, count: 0, from: 0 }));

/** The cards people rent most, grouped for the picker; the market's own list fills in the rest. */
export const GPU_GROUPS: { title: string; match: RegExp }[] = [
  // (5050–5090, not "RTX 5000Ada": that one is a workstation card.)
  { title: "RTX 50", match: /^RTX 50[5-9]\d/ },
  { title: "RTX 40", match: /^RTX 40[5-9]\d/ },
  { title: "RTX 30", match: /^RTX 30[5-9]\d/ },
  { title: "Data centre", match: /^(A100|A800|H100|H200|L40|L4$|A40|A10$|A16|V100|Tesla|G?B\d{2,3}$)/ },
  { title: "Workstation", match: /^(RTX PRO|RTX A\d|RTX \d{4}Ada|RTX \d000|Q RTX|Quadro|Titan)/i },
];
