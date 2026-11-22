import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { demoOn } from "@/lib/demo/config";
import type { LoraPolicy } from "@/lib/local/loras";
import { writeFileAtomic } from "./atomic-write";
import { DATA_DIR } from "./paths";

/**
 * What the LoRA library may show of adult LoRAs on this computer (Settings → Preferences), kept in data/lora-policy.json:
 * - `age`: who is using Crackio says so themselves. "minor": under 18, and with that everything adult stays out and the
 *   answer can't be changed from the app again (only by deleting the file). "adult": 18 or older. null: not asked yet,
 *   which reads as "minor" does.
 * - `adult`: an adult chose to see adult LoRAs in searches (off until they do).
 * - `blur`: those show blurred behind a button (on until they say otherwise).
 * What is never listed, whatever is chosen here: anything with minors, real people, and the rest of server/loras `NEVER`.
 * The hosted demo has none of this: it answers as if nobody had been asked.
 */
const FILE = path.join(/*turbopackIgnore: true*/ DATA_DIR, "lora-policy.json");
const NOBODY: LoraPolicy = { age: null, adult: false, blur: true, locked: false };

const tidy = (raw: Partial<LoraPolicy> | null): LoraPolicy => {
  const age = raw?.age === "adult" || raw?.age === "minor" ? raw.age : null;
  return { age, adult: age === "adult" && raw?.adult === true, blur: raw?.blur !== false, locked: age === "minor" };
};

export async function loraPolicy(): Promise<LoraPolicy> {
  if (demoOn()) return NOBODY;
  const raw = await fs.readFile(/*turbopackIgnore: true*/ FILE, "utf8").then((text) => JSON.parse(text) as Partial<LoraPolicy>, () => null);
  return tidy(raw);
}

/** Whether adult LoRAs may be listed and added: an adult said so. */
export async function adultAllowed(): Promise<{ adult: boolean; blur: boolean }> {
  const p = await loraPolicy();
  return { adult: p.adult, blur: p.blur };
}

export class PolicyLocked extends Error {}

export async function setLoraPolicy(change: { age?: "adult" | "minor"; adult?: boolean; blur?: boolean }): Promise<LoraPolicy> {
  if (demoOn()) throw new PolicyLocked("Not in the demo.");
  const now = await loraPolicy();
  if (now.locked) throw new PolicyLocked("Adult LoRAs are off on this computer: someone using it said they are under 18.");
  const next = tidy({ age: change.age ?? now.age, adult: change.adult ?? now.adult, blur: change.blur ?? now.blur });
  await fs.mkdir(/*turbopackIgnore: true*/ DATA_DIR, { recursive: true });
  await writeFileAtomic(FILE, JSON.stringify({ age: next.age, adult: next.adult, blur: next.blur }, null, 1));
  return next;
}
