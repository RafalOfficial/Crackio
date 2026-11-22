import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * What the user lets agents do (Settings → Agents). Kept in its own file, data/agent.json, beside settings.json: the
 * agent door reads it on every call, and nothing else in Crackio depends on it.
 */
export type AgentPrefs = {
  /** Off: every agent call is refused (`agents_off`). */
  enabled: boolean;
  /**
   * "free": only this computer and the user's other computers. "confirm": rented GPUs, RunPod Serverless and Comfy
   * credits too, each paid job after the user agreed to its quoted price. "all": the same, with no question asked:
   * the user switched the confirmations off (on Crackio's own screen, with a tick and a double-click).
   */
  spend: "free" | "confirm" | "all";
  /** Off: tools return file paths only, never a picture for the agent's model to look at. */
  seePictures: boolean;
};

const DEFAULTS: AgentPrefs = { enabled: true, spend: "free", seePictures: true };

const FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "agent.json");
const cached = globalThis as unknown as { __crackioAgentPrefs?: { at: number; value: AgentPrefs }; __crackioAgentSecret?: string };

export async function agentPrefs(): Promise<AgentPrefs> {
  const hit = cached.__crackioAgentPrefs;
  if (hit && Date.now() - hit.at < 1000) return { ...hit.value };
  let value = { ...DEFAULTS };
  try {
    const raw = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ FILE, "utf8")) as Partial<AgentPrefs>;
    value = {
      enabled: raw.enabled !== false,
      spend: raw.spend === "confirm" || raw.spend === "all" ? raw.spend : "free",
      seePictures: raw.seePictures !== false,
    };
  } catch {
    // No file yet: the defaults.
  }
  cached.__crackioAgentPrefs = { at: Date.now(), value };
  return { ...value };
}

export async function setAgentPrefs(patch: Partial<AgentPrefs>): Promise<AgentPrefs> {
  const next = { ...(await agentPrefs()), ...patch };
  await writeFileAtomic(FILE, JSON.stringify(next, null, 2));
  cached.__crackioAgentPrefs = { at: Date.now(), value: next };
  return { ...next };
}

/** What agents may spend as last read (every agent call reads it first): for checks that have no call at hand. */
export const spendNow = (): AgentPrefs["spend"] => cached.__crackioAgentPrefs?.value.spend ?? "free";

/** This run's secret for confirm values (a quoted price, a delete): they stop working when Crackio restarts. */
export const agentSecret = () => (cached.__crackioAgentSecret ??= randomBytes(24).toString("hex"));
