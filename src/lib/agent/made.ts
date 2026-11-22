import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";

/**
 * What agents made that isn't a take (takes carry their own mark in `params.agent`): Cast members, places, voices, by
 * their id, with the agent that made each. Agents may change and delete only these; the user's own are never touched.
 * Kept in data/agent-made.json.
 */
type Made = Record<"cast" | "place" | "voice", Record<string, string>>;

const FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "agent-made.json");
const g = globalThis as unknown as { __crackioAgentMade?: Promise<Made>; __crackioAgentMadeWrites?: Promise<unknown> };

const empty = (): Made => ({ cast: {}, place: {}, voice: {} });
const read = (): Promise<Made> =>
  (g.__crackioAgentMade ??= fs
    .readFile(/*turbopackIgnore: true*/ FILE, "utf8")
    .then((t): Made => ({ ...empty(), ...(JSON.parse(t) as Partial<Made>) }))
    .catch(empty));

function change(fn: (m: Made) => void) {
  const next = (g.__crackioAgentMadeWrites ?? Promise.resolve()).then(async () => {
    const all = structuredClone(await read());
    fn(all);
    g.__crackioAgentMade = Promise.resolve(all);
    await writeFileAtomic(FILE, JSON.stringify(all, null, 1));
  });
  g.__crackioAgentMadeWrites = next.catch(() => undefined);
  return next;
}

export const noteMade = (kind: keyof Made, id: string, client: string) => change((m) => void (m[kind][id] = client));
export const forgetMade = (kind: keyof Made, id: string) => change((m) => void delete m[kind][id]);
/** The agent that made it, or null when the user did. */
export const madeBy = async (kind: keyof Made, id: string): Promise<string | null> => (await read())[kind][id] ?? null;
export const allMade = async (kind: keyof Made): Promise<Record<string, string>> => ({ ...(await read())[kind] });
