import "server-only";
import { allLocalModels } from "../local-templates";
import { rentedBoxes } from "../cloud-accounts";
import { pricePerSecond } from "../serverless/runpod";
import { shortGpuName } from "@/lib/local/fit";
import { apiQuote } from "@/lib/setup/api-prices";
import type { JobSpec } from "@/lib/setup/knobs";
import type { LocalModel } from "@/lib/local/types";
import { recentTakes, sizeClass, type Take } from "./takes";

/**
 * What your takes saved: each finished take with a recipe (since Oct 29, on your own or rented GPUs) priced on its
 * model's official API (setup/api-prices, the same table the estimates use) for the same job (a picture at its size, an
 * edit, a clip or swap of its length and size, an upscale), next to what its GPU time cost here: nothing on your own
 * computers, the box's hourly price for the time it worked on a rented one (what that card rents for now on your account,
 * else RunPod's price for it), the per-second price on RunPod Serverless.
 */

export type SavingsRow = { key: string; label: string; takes: number; api: number; here: number };
export type Savings = {
  days: number | null;
  takes: number;
  /** Takes with no price to compare (voice, lip sync, models without a paid API): not counted either side. */
  skipped: number;
  api: number;
  here: number;
  byTool: SavingsRow[];
  byModel: SavingsRow[];
  note: string;
};

const TOOL_NAMES: Record<string, string> = {
  image: "Create",
  video: "Video",
  cast: "Cast",
  director: "Director",
  storyboard: "Storyboard",
  angles: "Angles",
  relight: "Relight",
  retouch: "Retouch",
  product: "Product Studio",
  upscale: "Upscale",
  templates: "Swap",
  recast: "Swap",
  showcase: "Showcase demos",
  motion: "Motion",
};
/** Tools whose pictures are edits of a photo you give them. */
const EDITS = new Set(["cast", "angles", "relight", "retouch", "product"]);

/** A picture's size class from its megapixels, as the price tables read it. */
const pictureSize = (mp: number) => (mp <= 0.6 ? "draft" : mp <= 1.2 ? "1k" : mp <= 4.5 ? "2k" : "4k");

function jobOf(model: LocalModel, t: Take): JobSpec | null {
  if (model.tasks.includes("swap")) return t.seconds ? { kind: "swap", seconds: t.seconds, resolution: sizeClass(t.width, t.height) } : null;
  if (model.tasks.includes("upscale")) return t.width && t.height ? { kind: "upscale", source: { width: Math.round(t.width / 2), height: Math.round(t.height / 2) }, scale: 2 } : null;
  if (model.unit === "clip") return t.seconds ? { kind: "video", seconds: t.seconds, resolution: sizeClass(t.width, t.height) } : null;
  if (!t.width || !t.height) return null;
  return { kind: "image", resolution: pictureSize((t.width * t.height) / 1e6), count: 1, ...(EDITS.has(t.tool ?? "") ? { references: 1 } : {}) };
}

export async function savingsSummary(days: number | null = 30): Promise<Savings> {
  const since = days == null ? 0 : Date.now() - days * 86_400_000;
  const takes = (await recentTakes()).filter((t) => t.at >= since);
  const models = allLocalModels();
  // What each card rents for now on your account, for takes on rented boxes.
  const listing = await rentedBoxes().catch(() => null);
  const renting = new Map<string, number>();
  for (const b of listing?.boxes ?? []) if (b.price && b.gpu) renting.set(shortGpuName(b.gpu), b.price);
  const hourly = (t: Take) => {
    const label = t.label ?? "";
    if (/runpod serverless/i.test(label)) return pricePerSecond(t.gpu) * 3600;
    if (!/vast|runpod|cloud/i.test(label)) return 0;
    return renting.get(shortGpuName(t.gpu)) ?? pricePerSecond(t.gpu) * 3600;
  };

  const byTool = new Map<string, SavingsRow>();
  const byModel = new Map<string, SavingsRow>();
  let api = 0;
  let here = 0;
  let counted = 0;
  let skipped = 0;
  for (const t of takes) {
    const model = models.find((m) => m.crackio === t.model);
    const job = model ? jobOf(model, t) : null;
    const quote = model && job ? apiQuote(model.id, job) : null;
    if (!model || !quote) {
      skipped++;
      continue;
    }
    const cost = (t.spanMs / 3_600_000) * hourly(t);
    counted++;
    api += quote.usd;
    here += cost;
    const tool = TOOL_NAMES[t.tool ?? ""] ?? "Other";
    for (const [map, key, label] of [
      [byTool, tool, tool],
      [byModel, model.id, model.name],
    ] as const) {
      const row = map.get(key) ?? { key, label, takes: 0, api: 0, here: 0 };
      row.takes++;
      row.api += quote.usd;
      row.here += cost;
      map.set(key, row);
    }
  }
  const order = (rows: Iterable<SavingsRow>) => [...rows].sort((a, b) => b.api - b.here - (a.api - a.here));
  return {
    days,
    takes: counted,
    skipped,
    api,
    here,
    byTool: order(byTool.values()),
    byModel: order(byModel.values()),
    note: "Takes kept with a recipe since Oct 29, priced on the official API of the model that made them (or the closest paid one). Rent: what that card costs you now, else RunPod's price for it.",
  };
}
