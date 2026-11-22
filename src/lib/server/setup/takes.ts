import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../paths";

/**
 * What whole takes really took, from their recipes (data/recipes, "How it was made"): the span from a take's first step
 * to the end of its last on one machine, every step counted (a swap's looks, redraws, checks and passes, not only the
 * model's own pass the tools time), with the clip's length and size. Settings' estimate leans on these where a tool runs
 * more than its model. Read at most every five minutes (about 8 MB for 500 takes).
 */

export type Take = {
  model: string;
  gpu: string;
  /** The machine it ran on, as the recipe names it ("RTX 5090 · vast.ai", "This computer", "RunPod Serverless"). */
  label?: string;
  tool?: string;
  /** Its steps' names ("FLUX 3 Klein", "LTX-2.5 Ripple swap (preparing)"): the models it used besides its own. */
  steps: string[];
  seconds: number | null;
  width: number | null;
  height: number | null;
  spanMs: number;
  at: number;
};

type Step = { at?: number; wallMs?: number; status?: string; name?: string; machine?: { gpu?: string; label?: string } };

const g = globalThis as unknown as { __crackioTakesV3?: { at: number; takes: Promise<Take[]> } };

export function recentTakes(): Promise<Take[]> {
  const hit = g.__crackioTakesV3;
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.takes;
  const takes = readTakes().catch(() => []);
  g.__crackioTakesV3 = { at: Date.now(), takes };
  return takes;
}

async function readTakes(): Promise<Take[]> {
  // Not traced by Turbopack: tracing data/ makes the dev server rebuild (and reload open pages) on every database write.
  const dir = path.join(/*turbopackIgnore: true*/ DATA_DIR, "recipes");
  const files = (await fs.readdir(/*turbopackIgnore: true*/ dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const out: Take[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, f), "utf8")) as {
        model?: string;
        tool?: string;
        createdAt?: number;
        size?: { width?: number; height?: number };
        settings?: { frames?: number; fps?: number };
        steps?: Record<string, Step>;
      };
      const steps = Object.values(j.steps ?? {});
      const gpu = steps.find((s) => s.machine?.gpu)?.machine?.gpu;
      if (!j.model || !gpu || !steps.length || steps.some((s) => s.status && s.status !== "done")) continue;
      // One machine only: a take split over two (a pool) or moved mid-way doesn't say how fast either is.
      if (steps.some((s) => s.machine?.gpu && s.machine.gpu !== gpu)) continue;
      const start = Math.min(...steps.map((s) => s.at ?? Infinity));
      const end = Math.max(...steps.map((s) => (s.at ?? 0) + (s.wallMs ?? 0)));
      if (!Number.isFinite(start) || end <= start) continue;
      const frames = j.settings?.frames;
      const fps = j.settings?.fps;
      out.push({
        model: j.model,
        gpu,
        label: steps.find((s) => s.machine?.label)?.machine?.label,
        tool: j.tool,
        steps: [...new Set(steps.map((s) => s.name).filter((n): n is string => Boolean(n)))],
        seconds: frames && fps ? frames / fps : null,
        width: j.size?.width ?? null,
        height: j.size?.height ?? null,
        spanMs: end - start,
        at: j.createdAt ?? start,
      });
    } catch {
      // A recipe being written, or an old shape: skipped.
    }
  }
  return out;
}

/** A clip's size class from its short side: 704 → "720p", 512 → "540p", 1088 → "1080p". */
export function sizeClass(width: number | null, height: number | null) {
  const short = Math.min(width ?? 720, height ?? 720);
  return short < 620 ? "540p" : short < 900 ? "720p" : short < 1260 ? "1080p" : "1440p";
}
