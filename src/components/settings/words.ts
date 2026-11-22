import type { KitId, ReqStatus, SetupMachine, SetupSnapshot, ToolState, ToolStatus } from "@/lib/setup/types";
import { KITS } from "@/lib/setup/kits";

/**
 * Settings' words and tones, in one place: every view (and the tools' pills, later) says a state the same way.
 * Plain words first; the technical ones live in details.
 */

export type Tone = "ready" | "busy" | "needs" | "problem" | "off";

/** Sizes in GB of 1024³ bytes, as the model library, Local's sizes and Storage count them ("29 MB", "4.5 GB"). */
export const bytesText = (bytes: number | null | undefined) => {
  if (bytes == null) return "?";
  if (bytes < 1024 ** 2) return bytes <= 0 ? "0 MB" : "under 1 MB";
  const gb = bytes / 1024 ** 3;
  if (gb < 0.1) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : Math.round(gb)} GB`;
};

/** A machine's GB (its free space, its memory), already in GB of 1024³ bytes. Under 0.1 GB reads "almost none". */
export const gbText = (gb: number | null | undefined) => (gb == null ? "?" : gb < 0.1 ? "almost no space" : bytesText(gb * 1024 ** 3));

/** Too little memory reads "Won't fit"; anything else that rules a tool out, "Not here". */
const wontFit = (why: string) => /\b\d+(\.\d+)? ?GB\b|memory|VRAM|too big/i.test(why);

/** Fit's reasons, rewritten for people: the technical words go to details. */
export function plainWhy(why: string) {
  return why
    .replace(/^NVFP4 needs a newer NVIDIA GPU$/i, "Needs an RTX 50 card, or an NVIDIA card with more memory")
    .replace(/^INT8 needs .*$/i, "Needs an NVIDIA card, RTX 20 or newer")
    .replace(/\bVRAM\b/g, "graphics memory");
}

export function toolWords(t: ToolStatus): { label: string; tone: Tone; why: string } {
  const why = plainWhy(t.why);
  switch (t.state) {
    case "ready":
      return { label: "Ready", tone: "ready", why };
    case "missing":
      return { label: "Set up", tone: "off", why };
    case "no-comfy":
      return { label: "Set up", tone: "off", why };
    case "installing":
      return { label: "Setting up", tone: "busy", why };
    case "needs-update":
      return { label: "Update", tone: "needs", why };
    case "needs-key":
      return { label: "Needs a key", tone: "needs", why };
    case "broken":
      return { label: "Needs a fix", tone: "problem", why };
    case "offline":
      return { label: "Not answering", tone: "off", why };
    case "unsupported":
      return { label: wontFit(why) ? "Won't fit" : "Not here", tone: "off", why };
  }
}

/** What a machine's lamp says: busy while it sets up or downloads, else ready, a problem, or off. */
export function machineTone(m: SetupMachine): Tone {
  if (!m.online) return "off";
  if (m.downloads.count || Object.values(m.tools).some((t) => t.state === "installing")) return "busy";
  if (Object.values(m.tools).some((t) => t.state === "broken")) return "problem";
  if (m.bridge.outdated && m.bridge.update !== "never") return "needs";
  return "ready";
}

export const machineWords = (m: SetupMachine) => {
  const tone = machineTone(m);
  return !m.online ? "Not answering" : tone === "busy" ? "Setting up" : tone === "problem" ? "Needs a fix" : tone === "needs" ? "Helper update" : "Ready";
};

/** Which machine a page shows: the one asked for, else where jobs go first, else the first that answers. */
export function pickMachine(snap: SetupSnapshot | null, asked: string | null): SetupMachine | null {
  if (!snap?.machines.length) return null;
  const own = snap.machines.filter((m) => !m.metered);
  return (
    snap.machines.find((m) => m.id === asked) ??
    own.find((m) => m.runOn && m.online) ??
    own.find((m) => m.online) ??
    own[0] ??
    snap.machines[0]
  );
}

/** The order rows read in: what works first, then what's moving, then what can be set up, then the rest. */
const ORDER: Record<ToolState, number> = {
  ready: 0,
  installing: 1,
  missing: 2,
  "no-comfy": 2,
  "needs-update": 3,
  "needs-key": 3,
  broken: 4,
  unsupported: 5,
  offline: 6,
};

export function toolsInOrder(m: SetupMachine) {
  return KITS.map((k) => ({ kit: k, status: m.tools[k.id] })).sort((a, b) => ORDER[a.status.state] - ORDER[b.status.state]);
}

/**
 * Tools that run well here and aren't set up: what "Set up all" gets. A tool whose model would run slowly here is left
 * for you to set up by itself (its part says "slow here"; the tool's own line only names what it gets).
 */
export function settable(m: SetupMachine): KitId[] {
  const slow = (why: string) => /slow here/.test(why);
  return KITS.filter((k) => {
    const t = m.tools[k.id];
    return ["missing", "no-comfy"].includes(t.state) && !slow(t.why) && !t.reqs.some((r) => !r.optional && r.state === "missing" && slow(r.why));
  }).map((k) => k.id);
}

export function countReady(m: SetupMachine) {
  return Object.values(m.tools).filter((t) => t.state === "ready").length;
}

/** Room for `bytes` more on a machine (2 GB kept spare, 10 on the drive Crackio runs from), as its set-up would check. */
export const fits = (m: SetupMachine, bytes: number) => m.diskFreeGb == null || bytes / 1024 ** 3 <= m.diskFreeGb - (m.spareGb ?? 2);

/** "RTX 5090" for most; this computer says so. */
export const machineName = (m: SetupMachine) => (m.kind === "this-computer" ? `This PC · ${m.label}` : m.label);

/** A part's lamp: ready, on its way, waiting for you, broken, or not here. */
export const REQ_TONE: Record<ReqStatus["state"], Tone> = {
  ready: "ready",
  auto: "ready",
  installing: "busy",
  missing: "off",
  outdated: "needs",
  "needs-key": "needs",
  broken: "problem",
  unsupported: "off",
  blocked: "off",
  unpublished: "off",
};
