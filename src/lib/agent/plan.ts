import "server-only";
import { createHmac } from "node:crypto";
import { POST as etaRoute } from "@/app/api/local/eta/route";
import { comfyQuote } from "@/lib/engines/comfy-quote";
import { AUTO_PREFERENCE, type ModelAvailability, type ModelKind } from "@/lib/models/catalog";
import { formatMoney } from "@/lib/models/pricing";
import { listModels } from "@/lib/models/resolve";
import { getSettings } from "@/lib/server/settings";
import { setupSnapshot } from "@/lib/server/setup/status";
import { aspectById, type AspectId } from "@/lib/shot";
import { fail } from "./errors";
import { chooseMachine, noMachineOnline, paidMachineIds, type EtaMachine } from "./machines";
import { agentSecret, spendNow, type AgentPrefs } from "./prefs";

/**
 * What a job will take before it runs: the model, the machine, the wait, the price and anything in the way. Every make
 * and edit tool answers a dry run with one of these, and runs the same checks before it starts anything.
 */
export type Plan = {
  model: { id: string; name: string };
  machine?: { id: string; name: string; gpu: string | null };
  /** Seconds for the whole job once it starts, with the likely range when Crackio has one. */
  seconds: number | null;
  range?: [number, number];
  /** Where the time comes from: "measured on this machine", "typical for this model"… */
  basis?: string;
  /** Jobs ahead of it: on that machine's ComfyUI, and in Crackio's own queue. */
  ahead: number;
  cost: { free: true } | { free: false; amount: number | null; text: string };
  /** The size a local picture comes out at, and how ("1024×576", "drawn at 1024×576, then enlarged"). */
  size?: string;
  notes?: string[];
};

/** How many single-letter changes turn `a` into `b`. */
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Close ids or names, for "did you mean": one that holds the words asked for, or is a typo or two away. */
export function nearest(wanted: string, options: { id: string; name?: string }[], max = 4): string[] {
  const bare = (s: string) => s.toLowerCase().replace(/^(local:|comfy:|@)/, "");
  const w = bare(wanted);
  const score = (o: { id: string; name?: string }) => {
    const hay = `${o.id} ${o.name ?? ""}`.toLowerCase();
    if (hay.includes(w)) return 0;
    const typos = Math.min(edits(w, bare(o.id)), o.name ? edits(w, o.name.toLowerCase()) : Infinity);
    if (typos <= Math.max(1, Math.floor(w.length / 4))) return 0.5 + typos / 10;
    const parts = w.split(/[^a-z0-9]+/).filter((p) => p.length > 1);
    const hits = parts.filter((p) => hay.includes(p)).length;
    return parts.length ? 1 + (parts.length - hits) / parts.length : 3;
  };
  return options
    .map((o) => ({ o, s: score(o) }))
    .filter((x) => x.s < 2)
    .sort((a, b) => a.s - b.s)
    .slice(0, max)
    .map((x) => x.o.id);
}

const isPaidModel = (m: ModelAvailability) => m.via !== "comfy-local" && !m.id.startsWith("local:");

/**
 * The model a job uses: the one asked for, else the user's default for that kind, else the first that can run, among
 * those the user lets agents use (free ones only, unless they allowed paid jobs).
 */
export async function chooseModel(
  kind: ModelKind,
  asked: string | undefined,
  prefs: AgentPrefs,
  /** What the job needs of the model beyond its kind (an edit needs one that takes a picture), and how to say so. */
  need?: { fits: (m: ModelAvailability) => boolean; what: string; prefer?: string[]; /** Said when no model that fits is set up anywhere. */ none?: string },
): Promise<ModelAvailability> {
  const models = await listModels();
  const ofKind = models.filter((m) => m.kind === kind && (!need || need.fits(m)));
  if (asked && asked !== "auto" && need) {
    const m = models.find((x) => x.id === asked);
    if (m && m.kind === kind && !need.fits(m)) {
      throw fail("option_not_supported", { field: "model", what: `${m.name} ${need.what}.`, did_you_mean: ofKind.filter((x) => x.available && (prefs.spend !== "free" || x.id.startsWith("local:"))).map((x) => x.id).slice(0, 6) });
    }
  }
  if (asked && asked !== "auto") {
    const m = models.find((x) => x.id === asked);
    if (!m) throw fail("model_not_found", { field: "model", did_you_mean: nearest(asked, [...ofKind].sort((a, b) => Number(isPaidModel(a)) - Number(isPaidModel(b)))) });
    if (m.kind !== kind) {
      // What can run now and may be used, free ones first.
      const instead = ofKind.filter((x) => x.available && (prefs.spend !== "free" || !isPaidModel(x))).sort((a, b) => Number(isPaidModel(a)) - Number(isPaidModel(b)));
      throw fail("option_not_supported", { what: `${m.name} doesn't make ${kind === "image" ? "pictures" : kind === "video" ? "clips" : kind}.`, field: "model", did_you_mean: (instead.length ? instead : ofKind.filter((x) => !isPaidModel(x))).map((x) => x.id).slice(0, 6) });
    }
    if (!m.available) {
      // "Connect ComfyUI" on an own-GPU model: no ComfyUI answers at all, so every machine is off.
      const connect = /^Connect /.test(m.reason ?? "");
      if (connect && m.id.startsWith("local:")) throw await noMachineOnline(`${m.name} can't run now: no machine is online.`, prefs);
      throw fail(connect ? "key_missing" : "model_not_installed", { what: `${m.name} can't run now.`, why: m.reason });
    }
    if (isPaidModel(m) && prefs.spend === "free") throw fail("paid_not_allowed", { what: `${m.name} runs on Comfy credits, and the user lets agents use free models only.` });
    return m;
  }
  const saved = (await getSettings()).models?.[kind];
  const order = [saved, ...(need?.prefer ?? []), ...AUTO_PREFERENCE[kind], ...ofKind.map((m) => m.id)];
  const usable = (m: ModelAvailability | undefined): m is ModelAvailability => Boolean(m?.available && m.kind === kind && (!need || need.fits(m)));
  for (const id of order) {
    const m = models.find((x) => x.id === id);
    if (usable(m) && (prefs.spend !== "free" || !isPaidModel(m))) return m;
  }
  // Own-GPU models that only wait for a machine: the cause is the machines, whatever paid models could run.
  if (ofKind.some((m) => m.id.startsWith("local:") && !m.available && /^Connect /.test(m.reason ?? ""))) throw await noMachineOnline(`No machine is online to make ${kind === "image" ? "pictures" : kind === "video" ? "clips" : `${kind}s`} for free.`, prefs);
  if (ofKind.some((m) => m.available)) throw fail("paid_not_allowed", { what: `Only paid ${kind} models can run now, and the user lets agents use free models only.` });
  throw fail("model_not_installed", { what: need?.none ?? `No ${kind} model is set up yet.`, do: "Ask the user to set one up in Crackio → Settings → Tools, or to add a Comfy key in Settings → Accounts." });
}

type EtaAnswer = {
  eta: { seconds: number; low: number; high: number; why: string; gpu: string; machine: string; target: string; size: { native: string; target: string; how: string; asked: string } | null } | null;
  machines?: EtaMachine[];
  runOn?: string;
};

/** Crackio's own queue: jobs running and waiting (server/runner keeps them on globalThis). */
export function crackioQueue() {
  const state = (globalThis as unknown as { __crackioRunnerState?: { queue: string[]; active: Map<string, unknown> } }).__crackioRunnerState;
  return { running: state?.active.size ?? 0, queued: state?.queue.length ?? 0, ids: state ? [...state.active.keys(), ...state.queue] : [] };
}

const TYPICAL: Record<ModelAvailability["speed"], number> = { fast: 15, medium: 40, slow: 90 };

export type LocalAsk = {
  kind: "image" | "video" | "upscale";
  count: number;
  references: number;
  resolution?: string;
  ratio?: number;
  duration?: number;
  source?: { width: number; height: number };
  scale?: number;
  nativeOnly?: boolean;
  /**
   * The job can't be told which machine to use (a Cast member's pictures, a tool that starts its own jobs): the plan is
   * for the machine Crackio's Auto takes, and it's refused when that one costs money the user didn't allow.
   */
  unpinned?: boolean;
};

/**
 * The plan for a job on `model`: which machine takes it and how long it takes there (the same estimate the screens
 * show, from /api/local/eta), or Comfy's quote for a hosted model. Throws when the user's rules or the machines rule it out.
 */
export async function planJob(model: ModelAvailability, ask: LocalAsk & { aspect: AspectId; machine?: string; sound?: boolean; start?: boolean; end?: boolean }, prefs: AgentPrefs): Promise<Plan> {
  const queue = crackioQueue();
  if (!model.id.startsWith("local:")) {
    if (prefs.spend === "free") throw fail("paid_not_allowed", { what: `${model.name} runs on Comfy credits, and the user lets agents use free models only.` });
    if (ask.machine && ask.machine !== "auto") {
      // A machine was named and a hosted model came up: say what would run there, or that nothing for this is set up.
      const kit = model.kind === "upscale" ? "upscale" : model.kind === "video" ? "video" : "image";
      const own = (await listModels().catch(() => [])).filter((m) => m.kind === model.kind && m.id.startsWith("local:") && m.available).map((m) => m.id);
      throw fail("option_not_supported", {
        what: `${model.name} is a hosted model: it doesn't run on one of the user's machines.`,
        field: "machine",
        ...(own.length
          ? { did_you_mean: own.slice(0, 6), do: `For that machine, pass one of these as "model". Or leave "machine" out to use ${model.name}.` }
          : { why: `Nothing for this is set up on the user's machines, so Crackio picked a hosted model.`, do: `Set it up there: settings with action "install", tool "${kit}" and that machine (it says the size and time first; ask the user). Or leave "machine" out to use ${model.name}.` }),
      });
    }
    const output = ask.kind === "video" ? "video" : "image";
    const quote = await comfyQuote(model.model, model.family, { output, aspect: ask.aspect, count: ask.count, resolution: ask.resolution ?? null, seconds: ask.duration, sound: ask.sound, start: ask.start, end: ask.end, images: ask.references }).catch(() => null);
    const typical = TYPICAL[model.speed] * (output === "video" ? 4 : 1);
    return {
      model: { id: model.id, name: model.name },
      seconds: typical,
      basis: "typical for this model",
      ahead: queue.queued,
      cost: { free: false, amount: quote ? Math.round(quote.amount * 10000) / 10000 : null, text: quote ? `${quote.approximate ? "about " : ""}${formatMoney(quote.amount)} of Comfy credits (${quote.detail})` : "Comfy credits; Comfy gave no quote for this request" },
    };
  }

  const a = aspectById(ask.aspect);
  const res = await etaRoute(
    new Request("http://crackio.internal/api/local/eta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        kind: ask.kind,
        count: ask.count,
        references: ask.references,
        ratio: ask.ratio ?? a.w / a.h,
        ...(ask.resolution ? { resolution: ask.resolution } : {}),
        ...(ask.duration ? { duration: ask.duration } : {}),
        ...(ask.source ? { source: ask.source } : {}),
        ...(ask.scale ? { scale: ask.scale } : {}),
        ...(ask.nativeOnly ? { nativeOnly: true } : {}),
      }),
    }),
  );
  const answer = (await res.json().catch(() => ({}))) as EtaAnswer;
  const machines = answer.machines ?? [];
  const paid = await paidMachineIds();
  const autos = ask.unpinned ? machines.find((m) => m.id === answer.eta?.target && m.online && m.hasModel) : undefined;
  if (autos && paid.has(autos.id) && prefs.spend === "free") {
    throw fail("paid_not_allowed", { what: `This runs on the machine Crackio picks by itself, and right now that's ${autos.label}, which costs money. The user lets agents use free machines only.`, do: "Ask the user to set Run on to one of their own computers (Crackio → Settings → Preferences), or to allow paid jobs in Settings → Agents." });
  }
  const { machine, paid: costs } = autos ? { machine: autos, paid: paid.has(autos.id) } : chooseMachine({ machines, asked: ask.machine, runOn: answer.runOn && answer.runOn !== "auto" ? answer.runOn : undefined, paid, prefs, modelName: model.name });
  const onPicked = answer.eta?.target === machine.id ? answer.eta : null;
  const seconds = onPicked?.seconds ?? machine.seconds;
  const size = onPicked?.size;
  let cost: Plan["cost"] = { free: true };
  if (costs) {
    // A rented GPU bills by the hour while it's on; a job's share of that is its time there.
    const perHour = (await setupSnapshot().catch(() => null))?.machines.find((m) => m.id === machine.id)?.pricePerHour ?? null;
    const amount = perHour != null && seconds != null ? Math.round(((perHour * seconds) / 3600) * 10000) / 10000 : null;
    cost = { free: false, amount, text: perHour != null ? `${machine.label} costs ${formatMoney(perHour)} an hour while it's on${amount != null ? `; this job is about ${formatMoney(amount)} of that` : ""}` : `${machine.label} is billed; Crackio doesn't know its price` };
  }
  return {
    model: { id: model.id, name: model.name },
    machine: { id: machine.id, name: machine.label, gpu: machine.gpu },
    seconds: seconds ?? null,
    ...(onPicked ? { range: [onPicked.low, onPicked.high] as [number, number], basis: onPicked.why } : machine.seconds != null ? { basis: machine.measured ? "measured on this machine" : "estimated for this machine" } : {}),
    ahead: machine.queue + queue.queued,
    cost,
    ...(size ? { size: size.how === "native" || size.how === "kept" ? size.target : `drawn at ${size.native}, then ${size.how === "detail" ? "redrawn" : "enlarged"} to ${size.target}` } : {}),
  };
}

/**
 * A confirm value says "the user agreed to this request at this price". It carries the price agreed to (in hundredths
 * of a cent) and a signature over the tool, its arguments and that price, good for this run of Crackio. An estimate
 * moves a little between two calls (a job quoted at $0.0003 came back at $0.0002 and was asked for again), so a
 * confirm still holds while the price now is no more than a quarter above the one agreed, or a cent.
 */
function signed(tool: string, args: Record<string, unknown>, agreed: string) {
  const { confirm: _c, dry_run: _d, wait: _w, show: _s, ...rest } = args;
  void _c;
  void _d;
  void _w;
  void _s;
  return createHmac("sha256", agentSecret()).update(JSON.stringify([tool, rest, agreed])).digest("hex").slice(0, 10);
}

const priceKey = (plan: Plan) => (plan.cost.free || plan.cost.amount == null ? "x" : String(Math.max(1, Math.round(plan.cost.amount * 10000))));

export function confirmFor(tool: string, args: Record<string, unknown>, plan: Plan): string {
  const key = priceKey(plan);
  return `${key}.${signed(tool, args, key)}`;
}

/**
 * A paid plan runs only with the user's agreement: the call must carry a confirm value for this request. Without one
 * (or with another request's, or one for a clearly lower price), the failure says the price and the wait, and the value
 * to send.
 */
export function requireConfirm(tool: string, args: Record<string, unknown>, plan: Plan) {
  if (plan.cost.free) return;
  // "Allow everything": the user took the question away.
  if (spendNow() === "all") return;
  const given = typeof args.confirm === "string" ? args.confirm : "";
  const [agreed, mark] = given.split(".");
  if (agreed && mark && mark === signed(tool, args, agreed)) {
    const now = priceKey(plan);
    // A price agreed to stands when the estimate is missing this time (the machine was too busy to say): the request is
    // the same one, on the same machine, at the same price an hour.
    if (now === "x" && agreed !== "x") return;
    if (agreed === "x" || now === "x" ? agreed === now : Number(now) <= Number(agreed) * 1.25 + 100) return;
  }
  throw fail("cost_needs_confirming", { cost: plan.cost.text, ...(plan.seconds != null ? { seconds: plan.seconds } : {}), confirm: confirmFor(tool, args, plan) });
}
