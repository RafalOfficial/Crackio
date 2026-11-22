import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "./paths";

/**
 * Every swap check, kept for review: the original frame, the character's picture and each take (JPEGs), what the checker
 * said about each look at each take and how sure it was, what passed, and the redraw's own words and pose read. A dropped
 * keyframe can be looked at afterwards, and the judge's least sure calls can go to /rate, where the user's picks become
 * its labels. The newest 1,500 checks are kept (about 1 GB).
 */
const LOG = path.join(/*turbopackIgnore: true*/ DATA_DIR, "feedback", "swap-log");
const KEEP = 1500;

export type SwapLogEntry = {
  who: string;
  costume: string;
  /** The redraw's own words and the pose read it was given, when the caller knows them. */
  prompt?: string;
  pose?: string;
  /** The model that checked, and the bar a take had to clear (the judge's chance of "replaced"). */
  checker: string;
  bar?: number;
  /** A keyframe's check, and the first drawing's surest take its bar was set from (bestTake); null before it. */
  keyframe?: boolean;
  anchorSure?: number | null;
  takes: { looks: { verdict: unknown; odds?: Record<string, number> }[]; sure?: number; pass: boolean }[];
  chosen: number;
  passed: boolean;
};

export async function logSwapCheck(frame: string, takes: string[], picture: string, entry: SwapLogEntry) {
  try {
    const dir = path.join(/*turbopackIgnore: true*/ LOG, `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const jpeg = (from: string, to: string) => sharp(from).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(/*turbopackIgnore: true*/ dir, to));
    await Promise.all([jpeg(frame, "frame.jpg"), jpeg(picture, "character.jpg"), ...takes.map((t, k) => jpeg(t, `take-${k}.jpg`))]);
    await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, "check.json"), JSON.stringify({ at: Date.now(), ...entry }, null, 1));
    const all = (await fs.readdir(/*turbopackIgnore: true*/ LOG)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await fs.rm(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ LOG, old), { recursive: true, force: true });
  } catch (err) {
    console.warn("[swap-log]", (err as Error).message);
  }
}
