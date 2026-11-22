import "server-only";
import { comfyTargets, withTarget } from "@/lib/server/comfy-targets";
import { setupSnapshot } from "@/lib/server/setup/status";
import type { SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { fail } from "./errors";
import type { AgentPrefs } from "./prefs";

/** One machine as an agent sees it: enough to pick one and to tell the user what it costs. */
export type AgentMachine = {
  id: string;
  name: string;
  gpu: string | null;
  memory_gb: number | null;
  where: string;
  online: boolean;
  /** Using it costs money: a rented GPU (billed by the hour while it's on), or one billed per job. */
  paid: boolean;
  price_per_hour?: number;
  /** A rented GPU's idle stop, in minutes (missing: none set). */
  idle_stop_min?: number;
  /** Why it isn't online, in words to pass on to the user. */
  why_offline?: string;
  /** A rented GPU that doesn't answer although its cloud says it runs: wait and try again, nobody has to start it. */
  not_answering?: true;
  /** A rented GPU that's on with no idle stop: it bills until the user stops it. */
  no_idle_stop?: true;
};

/** Why a machine isn't online: what the user would have to do about it. */
export function whyOffline(m: SetupMachine, running = false): string {
  if (m.kind === "this-computer") return m.comfy.installed ? "its ComfyUI isn't running (the user starts it in Crackio → Settings → Machines)" : "it has no ComfyUI yet (the user sets one up in Crackio → Settings)";
  // Its cloud says it runs: it's busy (a big model loading can keep its ComfyUI from answering) or restarting, not stopped.
  if (m.kind === "rented" && running) return "its cloud says it's running, but it isn't answering right now (busy loading a model, or restarting)";
  if (m.kind === "rented") return "the rented box is stopped (only the user starts it)";
  if (m.kind === "lan") return "it's switched off or asleep, or its ComfyUI isn't running";
  return "it isn't answering";
}

const paidKind = (m: SetupMachine) => m.kind === "rented" || m.kind === "serverless" || m.kind === "comfy-cloud" || m.metered;

export function machineView(m: SetupMachine, snap: SetupSnapshot, running?: Set<string>): AgentMachine {
  const boxId = m.cloud?.instance ? `${m.cloud.provider}:${m.cloud.instance}` : null;
  const box = boxId ? snap.autoStop[boxId] : undefined;
  const up = Boolean(boxId && running?.has(boxId));
  return {
    id: m.id,
    name: m.label,
    gpu: m.gpu?.name ?? null,
    memory_gb: m.gpu?.memoryGb ?? null,
    where: m.where,
    online: m.online,
    paid: paidKind(m),
    ...(m.pricePerHour != null ? { price_per_hour: Math.round(m.pricePerHour * 1000) / 1000 } : {}),
    ...(box?.minutes ? { idle_stop_min: box.minutes } : m.kind === "rented" && m.online ? { no_idle_stop: true as const } : {}),
    ...(m.online ? {} : { why_offline: whyOffline(m, up), ...(m.kind === "rented" && up ? { not_answering: true as const } : {}) }),
  };
}

/** "No machine online", with each machine the agent may use and why it's off: what the agent tells the user. */
export async function noMachineOnline(what: string, prefs: AgentPrefs) {
  const { machines } = await agentMachines().catch(() => ({ machines: [] as AgentMachine[] }));
  const mine = machines.filter((m) => !m.online && (prefs.spend !== "free" || !m.paid));
  const paidOn = machines.filter((m) => m.online && m.paid);
  return fail("no_machine_online", {
    what,
    why: [mine.length ? `${mine.map((m) => `${m.name}: ${m.why_offline}`).join("; ")}.` : "The user has no machine of their own set up.", prefs.spend === "free" && paidOn.length ? `${paidOn.map((m) => m.name).join(", ")} ${paidOn.length === 1 ? "is online but costs" : "are online but cost"} money, which the user doesn't allow agents.` : ""].filter(Boolean).join(" "),
    do: "Tell the user which machines are off and why, and ask them to switch one on. Agents can't start machines.",
  });
}

/** A `machine` argument checked before anything else: it exists, it's online, and the user lets agents use it. */
export async function checkMachine(id: string | undefined, prefs: AgentPrefs) {
  if (!id || id === "auto") return;
  const { machines } = await agentMachines();
  const m = machines.find((x) => x.id === id);
  if (!m) throw fail("machine_not_found", { field: "machine", what: `Crackio knows no machine "${id.slice(0, 60)}".`, allowed: machines.map((x) => x.id) });
  if (!m.online && m.not_answering) throw fail("machine_not_answering", { field: "machine", what: `${m.name} isn't answering right now: ${m.why_offline}.` });
  if (!m.online) throw fail(m.paid ? "box_stopped" : "no_machine_online", { field: "machine", what: `${m.name} isn't online: ${m.why_offline}.`, do: "Tell the user, or use a machine that's online (see status). Agents can't start machines." });
  if (m.paid && prefs.spend === "free") throw fail("paid_not_allowed", { field: "machine", what: `${m.name} costs money, and the user lets agents use free machines only.` });
}

export async function agentMachines(): Promise<{ machines: AgentMachine[]; snap: SetupSnapshot }> {
  const snap = await setupSnapshot();
  // What each cloud says of its boxes (one look serves 15 s): a box that runs there but doesn't answer here is busy, not stopped.
  const running = await import("@/lib/server/cloud-accounts")
    .then((m) => m.rentedBoxes())
    .then((l) => new Set(l.boxes.filter((b) => b.ready).map((b) => `${b.provider}:${b.id}`)))
    .catch(() => new Set<string>());
  return { machines: snap.machines.filter((m) => m.id !== "this-computer" || m.comfy.installed).map((m) => machineView(m, snap, running)), snap };
}

/**
 * Which machines cost money, by id, from the ComfyUI targets themselves (quick: no look at each machine). The job
 * gate uses it, so a rented box is never used by an agent the user keeps to free paths.
 */
export async function paidMachineIds(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const t of await comfyTargets()) if (t.cloud || t.metered || t.serverless) out.add(t.id);
  return out;
}

/**
 * The LoRA files on the machines that are online, each with the ids of the machines that hold it. Read from each
 * machine by its id: the route the LoRA library reads names machines by their label, and two rented boxes can share
 * one ("RTX 3090 · vast.ai"), which listed a file on the stopped one instead of the one that had it.
 */
export async function loraFilesOnMachines(): Promise<Map<string, string[]>> {
  // Through the registry first, as the routes load engines: comfy-local loaded on its own reaches it half-built.
  await import("@/lib/engines/registry");
  const [{ loraFiles }, { machineLook }, targets] = await Promise.all([import("@/lib/engines/comfy-local"), import("@/lib/server/machine-probe"), comfyTargets()]);
  const byFile = new Map<string, string[]>();
  await Promise.all(
    targets.map(async (t) => {
      try {
        if (!(await machineLook(t)).stats) return;
        for (const f of await withTarget(t, () => loraFiles())) byFile.set(f, [...(byFile.get(f) ?? []), t.id]);
      } catch (err) {
        // A machine that doesn't answer adds none; why is kept in the log (an empty list once hid every machine's LoRAs).
        console.warn(`[agent] LoRA files on ${t.id} couldn't be read: ${(err as Error).message}`);
      }
    }),
  );
  return byFile;
}

/** One machine the ETA route lists for a job. */
export type EtaMachine = { id: string; label: string; gpu: string | null; online: boolean; hasModel: boolean; queue: number; cloud: boolean; here: boolean; seconds: number | null; measured: boolean; note?: string };

/**
 * The machine an agent's local job runs on: the one it asked for, else the user's Run on, else the first one Auto would
 * take, always among those the user lets agents use. Throws the failure that says what's in the way.
 */
export function chooseMachine({ machines, asked, runOn, paid, prefs, modelName }: { machines: EtaMachine[]; asked?: string; runOn?: string; paid: Set<string>; prefs: AgentPrefs; modelName: string }): { machine: EtaMachine; paid: boolean } {
  const allowed = (m: EtaMachine) => prefs.spend !== "free" || !paid.has(m.id);
  const usable = (m: EtaMachine) => m.online && m.hasModel && !m.note;
  if (asked && asked !== "auto") {
    const m = machines.find((x) => x.id === asked);
    if (!m) throw fail("machine_not_found", { field: "machine", allowed: machines.map((x) => x.id) });
    if (!m.online) throw fail(paid.has(m.id) ? "box_stopped" : "no_machine_online", { what: `${m.label} isn't online.` });
    if (!m.hasModel) throw fail("model_not_installed", { what: `${modelName} isn't installed on ${m.label}.`, allowed: machines.filter(usable).map((x) => x.id) });
    if (!allowed(m)) throw fail("paid_not_allowed", { what: `${m.label} costs money, and the user lets agents use free machines only.` });
    return { machine: m, paid: paid.has(m.id) };
  }
  const preferred = runOn ? machines.find((m) => m.id === runOn && usable(m) && allowed(m)) : undefined;
  // A billed-per-job machine is never taken by itself, as Auto never takes one.
  const pick = preferred ?? machines.find((m) => usable(m) && allowed(m) && !(paid.has(m.id) && !m.cloud));
  if (pick) return { machine: pick, paid: paid.has(pick.id) };
  if (machines.some((m) => usable(m))) throw fail("paid_not_allowed", { what: `${modelName} is only installed on machines that cost money, and the user lets agents use free machines only.` });
  if (machines.some((m) => m.hasModel)) {
    const off = machines.filter((m) => m.hasModel && !m.online);
    throw fail(off.some((m) => paid.has(m.id)) ? "box_stopped" : "no_machine_online", { what: `${modelName} is installed on ${off.map((m) => m.label).join(", ")}, which ${off.length === 1 ? "isn't" : "aren't"} online.` });
  }
  throw fail("model_not_installed", { what: `${modelName} isn't installed on any machine.` });
}
