import "server-only";
import { createHash } from "node:crypto";
import { comfyKey, comfyModel } from "@/lib/providers/comfy-models";
import { encodeDuration, fitDuration, fitResolution, nearestAspect, type Caps } from "@/lib/models/caps";
import { formatMoney, type Cost, type QuoteSettings } from "@/lib/models/pricing";
import { aspectById } from "@/lib/shot";
import { buildBody } from "./comfy";
import { familyFor } from "./comfy-families";
import type { EngineJob } from "./types";

/**
 * Comfy Router prices the exact request (`POST /v2/models/{id}/estimate`): nothing runs and nothing
 * is charged. The body is built from the settings on screen, with a one-pixel stand-in where a
 * picture goes (prices depend on length, resolution and mode, not on what's in the picture).
 */
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export type { QuoteSettings };

/** The flat settings a schema-driven model would get for these choices (the generic builder's choices, without files). */
function flatFor(caps: Caps, s: QuoteSettings): Record<string, unknown> {
  const f: Record<string, unknown> = { ...caps.fixed };
  if (caps.prompt) f[caps.prompt.field] = "A price check.";
  if (caps.image && (s.start || (s.images ?? 0) > 0)) f[caps.image.field] = caps.image.array ? [PIXEL] : PIXEL;
  if (caps.end && s.end) f[caps.end.field] = PIXEL;
  if (caps.duration && s.output === "video") Object.assign(f, encodeDuration(caps.duration, fitDuration(caps.duration, s.seconds)));
  if (caps.resolution) {
    const v = fitResolution(caps.resolution.choices, s.resolution ?? undefined, caps.resolution.default);
    if (v !== null) f[caps.resolution.field] = v;
  }
  if (caps.aspect) {
    const a = aspectById(s.aspect);
    const pick = caps.aspect.choices.find((c) => c.value === s.aspectValue) ?? (s.start ? caps.aspect.choices.find((c) => c.ratio === null) : undefined) ?? nearestAspect(caps.aspect.choices, a.w / a.h);
    if (pick) f[caps.aspect.field] = pick.value;
  }
  if (caps.audio && s.output === "video") {
    const on = s.sound ?? caps.audio.default;
    f[caps.audio.field] = caps.audio.values ? caps.audio.values[on ? 0 : 1] : on;
  }
  if (caps.count && s.output === "image") f[caps.count.field] = Math.min(caps.count.max, Math.max(caps.count.min, s.count));
  return f;
}

const cache = new Map<string, { at: number; cost: Cost | null }>();

/** Comfy's price for one take with these settings, times the takes; null when Comfy can't quote it yet. */
export async function comfyQuote(model: string, family: string, s: QuoteSettings): Promise<Cost | null> {
  const key = await comfyKey();
  if (!key) return null;
  let body: Record<string, unknown>;
  if (family === "comfy-custom") {
    const info = await comfyModel(model).catch(() => null);
    if (!info?.caps) return null;
    const flat = flatFor(info.caps, s);
    const fam = familyFor(model);
    body = fam ? fam.nest(model, flat) : flat;
  } else {
    const a = aspectById(s.aspect);
    const job = { kind: s.output, model, family, aspect: s.aspect, width: a.w >= a.h ? 1536 : Math.round((1536 * a.w) / a.h), height: a.h >= a.w ? 1536 : Math.round((1536 * a.h) / a.w), count: 1, references: [], prompt: "", userPrompt: "", refine: false, mode: s.output } as unknown as EngineJob;
    try {
      body = buildBody(job, "A price check.", Array.from({ length: Math.max(s.images ?? 0, 0) }, () => PIXEL));
    } catch {
      return null;
    }
  }
  const id = createHash("sha1").update(model + JSON.stringify(body)).digest("hex");
  const hit = cache.get(id);
  const takes = Math.max(1, s.count);
  const scale = (c: Cost | null) => (c ? { ...c, amount: c.amount * takes, detail: takes > 1 ? `${c.detail} × ${takes}` : c.detail } : null);
  if (hit && Date.now() - hit.at < 10 * 60_000) return scale(hit.cost);
  let cost: Cost | null = null;
  try {
    const res = await fetch(`https://api.comfy.org/v2/models/${model}/estimate`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { source?: string; amount?: string; min_amount?: string; max_amount?: string };
      if (j.source === "exact" && j.amount) cost = { amount: Number(j.amount), detail: "Comfy's quote", approximate: false };
      else if (j.source === "estimated" && j.min_amount && j.max_amount) {
        const lo = Number(j.min_amount);
        const hi = Number(j.max_amount);
        cost = { amount: (lo + hi) / 2, detail: `Comfy's estimate: ${formatMoney(lo)}–${formatMoney(hi)}`, approximate: true };
      }
    }
  } catch {
    cost = null;
  }
  if (cost && !Number.isFinite(cost.amount)) cost = null;
  cache.set(id, { at: Date.now(), cost });
  return scale(cost);
}
