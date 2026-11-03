import type { SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { KITS } from "@/lib/setup/kits";
import { gbText } from "./words";

/**
 * What needs the user, worked out once from Settings' snapshot: Overview's "Needs you", the Doctor and the rail's count
 * all read this list, so they always agree. Each problem says what happened, what it blocks and one fix.
 */
export type Fix =
  | { kind: "link"; href: string; label: string }
  | { kind: "run-on-auto"; label: string }
  | { kind: "setup"; machine: string; kits: string[]; label: string }
  | { kind: "start-comfy"; label: string };

export type Problem = {
  id: string;
  machine: string | null;
  tone: "problem" | "needs";
  title: string;
  why: string;
  fix?: Fix;
};

export function findProblems(snap: SetupSnapshot): Problem[] {
  const out: Problem[] = [];
  const own = snap.machines.filter((m) => !m.metered);
  const pinned = snap.machines.find((m) => m.runOn);

  if (pinned?.metered) {
    out.push({
      id: "run-on-billed",
      machine: pinned.id,
      tone: "needs",
      title: `Jobs go to ${pinned.label} first, a pay-per-job machine`,
      why: "Every job it has the model for is billed there while it's on. Auto uses your own GPUs first.",
      fix: { kind: "run-on-auto", label: "Use Auto" },
    });
  } else if (pinned && !pinned.online) {
    out.push({
      id: "run-on-offline",
      machine: pinned.id,
      tone: "needs",
      title: `Jobs go to ${pinned.label} first, and it isn't answering`,
      why: "Crackio falls back to your other machines meanwhile.",
      fix: { kind: "run-on-auto", label: "Use Auto" },
    });
  }

  // A cloud account's credit running low at what its boxes cost now: a box stops when it runs out, mid-job or not.
  for (const c of snap.credit ?? []) {
    if (c.hoursLeft === null || c.until === null || c.hoursLeft >= 2) continue;
    const name = c.provider === "vast" ? "vast.ai" : "RunPod";
    out.push({
      id: `credit-${c.provider}`,
      machine: null,
      tone: c.hoursLeft < 0.5 ? "problem" : "needs",
      title: `Your ${name} credit runs out around ${new Date(c.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      why: `$${c.balance.toFixed(2)} left, and your running ${c.running === 1 ? "box costs" : "boxes cost"} $${c.perHour.toFixed(2)} an hour. When it runs out ${name} stops ${c.running === 1 ? "it" : "them"}, mid-job or not. Top up, or stop what you don't need (Machines → Cost).`,
      fix: { kind: "link", href: c.provider === "vast" ? "https://cloud.vast.ai/billing/" : "https://www.runpod.io/console/user/billing", label: "Top up" },
    });
  }

  for (const m of own) {
    if (m.online && m.diskFreeGb != null && m.diskFreeGb < 2) {
      out.push({
        id: `disk-${m.id}`,
        machine: m.id,
        tone: "problem",
        title: m.diskFreeGb < 0.1 ? `${cap(placeName(m))} is out of space where models download` : `${cap(placeName(m))} has ${gbText(m.diskFreeGb)} free where models download`,
        why: "New models and set-ups stop there until there's room. Pick another folder for downloads, or free some space.",
        fix: { kind: "link", href: `/settings/storage?machine=${encodeURIComponent(m.id)}`, label: "Open Storage" },
      });
    }
    const broken = KITS.filter((k) => m.tools[k.id]?.state === "broken");
    if (m.online && broken.length) {
      out.push({
        id: `broken-${m.id}`,
        machine: m.id,
        tone: "problem",
        title: `${broken.map((k) => k.name).join(", ")} on ${placeName(m)} ${broken.length === 1 ? "needs" : "need"} a fix`,
        why: m.tools[broken[0].id].why,
        fix: { kind: "setup", machine: m.id, kits: broken.map((k) => k.id), label: "Try again" },
      });
    }
    if (m.online && m.bridge.outdated && m.bridge.update === "this-computer") {
      out.push({
        id: `bridge-${m.id}`,
        machine: m.id,
        tone: "needs",
        title: `Crackio's helper on ${placeName(m)} is out of date`,
        why: `It has ${m.bridge.version ?? "none"}; this Crackio brings ${m.bridge.latest}. Newer tools need it.`,
        fix: { kind: "link", href: `/settings/machines?machine=${encodeURIComponent(m.id)}`, label: "Update it" },
      });
    }
    if (m.kind === "this-computer" && !m.comfy.installed) {
      out.push({
        id: "no-comfy",
        machine: m.id,
        tone: "needs",
        title: "This computer doesn't run ComfyUI yet",
        why: "Crackio sets it up for your graphics card in one go, then the tools you pick.",
        fix: { kind: "link", href: "/settings/tools?machine=this-computer", label: "Set it up" },
      });
    }
  }

  if (!own.some((m) => m.online && m.comfy.installed) && !snap.keys.comfy) {
    out.push({
      id: "nothing-runs",
      machine: null,
      tone: "problem",
      title: "Nothing can make pictures yet",
      why: "Set this computer up, connect a GPU, or add a Comfy key to use hosted models.",
      fix: { kind: "link", href: "/settings/machines?add=1", label: "Add a computer" },
    });
  }
  return out;
}

const placeName = (m: SetupMachine) => (m.kind === "this-computer" ? "this computer" : m.label);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
