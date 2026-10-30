import "server-only";
import { formatSeconds } from "@/lib/local/fit";
import { localJob } from "@/lib/local/work";
import { listModels } from "@/lib/models/resolve";
import { builtinCaps } from "@/lib/models/builtin-caps";
import { capsBadges, type ModelTask } from "@/lib/models/caps";
import { comfyFits, comfyRow } from "@/lib/models/custom";
import { comfyCatalog, comfyKey, comfyKnown, comfyWarmState, warmComfyModels } from "@/lib/providers/comfy-models";
import { LOCAL_SWAP_IDS, MODELS } from "@/lib/models/catalog";
import { engineShortName } from "@/lib/providers/names";
import type { ModelAvailability } from "@/lib/models/catalog";
import type { CustomRow, CustomSearch } from "@/lib/models/custom-types";
import type { ProviderId } from "@/lib/providers/types";

/**
 * The Custom tab's search: every model of the kind a tool needs (Crackio's own list plus Comfy Router's full catalog),
 * ranked by what you typed, a page at a time.
 */

function builtinFits(m: ModelAvailability, task: ModelTask) {
  switch (task) {
    case "image":
      return m.kind === "image";
    case "edit":
    case "retouch":
      return m.kind === "image" && m.maxRefs > 0;
    case "video":
      return m.kind === "video";
    case "animate":
      return m.kind === "video" && Boolean(builtinCaps(m)?.image);
    case "video-edit":
    case "video-swap":
      // Comfy Router's clip editors that are built in (Kling 3 Omni), and for swaps the ones on your own ComfyUI.
      return (m.family === "comfy-custom" && m.kind === "video" && Boolean(m.caps?.video)) || (task === "video-swap" && LOCAL_SWAP_IDS.includes(m.id));
    case "upscale":
      return m.kind === "upscale";
    case "reframe":
      return m.kind === "reframe";
  }
}

function builtinRow(m: ModelAvailability): CustomRow {
  const caps = m.caps ?? builtinCaps(m);
  return {
    id: m.id,
    provider: m.via ?? m.providers[0],
    name: m.name,
    vendor: m.vendor,
    description: m.bestFor,
    isNew: false,
    badges: caps ? capsBadges(caps) : [],
    // A local model's cost is time: what it takes on the machine that runs it.
    price: m.localTime ? `free · ${m.localTime.measured ? "" : "~"}${formatSeconds(m.localTime.seconds)} ${localJob(m.kind)} on ${m.localTime.gpu}` : undefined,
    caps,
    builtin: true,
    available: m.available,
    reason: m.reason,
  };
}

/** Shorthands people type for kinds of model. */
const SYNONYMS: [RegExp, string][] = [
  [/\bi2v\b/g, "image to video"],
  [/\bt2v\b/g, "text to video"],
  [/\bt2i\b/g, "text to image"],
  [/\bi2i\b/g, "image to image"],
  [/\bv2v\b/g, "video edit"],
  [/\bflf\b|\bfirst[\s-]?last\b|\bstart[\s-]?end\b/g, "start end"],
  [/\b4k\b/g, "4k"],
];

const norm = (s: string) => s.toLowerCase().replace(/[_./()[\]:+→-]+/g, " ").replace(/\s+/g, " ").trim();

function terms(q: string) {
  let s = q.toLowerCase();
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  return norm(s).split(" ").filter(Boolean).slice(0, 8);
}

function inOrder(needle: string, hay: string) {
  let i = 0;
  for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
  return false;
}

/** How well a model matches every word typed: name and maker count most, then id, badges, tags, description. */
function score(row: CustomRow, tags: string, words: string[]) {
  if (!words.length) return 1;
  const fields: [string, number][] = [
    [norm(row.name), 6],
    [norm(row.vendor), 4],
    [norm(row.id.replace(/^[\w-]+:/, "")), 4],
    [norm(engineShortName(row.provider)), 3],
    [norm(row.badges.join(" ")), 2],
    [norm(tags), 2],
    [norm(row.description), 1],
  ];
  const compact = norm(`${row.name} ${row.id}`).replace(/ /g, "");
  let total = 0;
  for (const w of words) {
    let best = 0;
    for (const [f, weight] of fields) {
      const i = f.indexOf(w);
      if (i < 0) continue;
      const start = i === 0 || f[i - 1] === " ";
      const whole = start && (i + w.length === f.length || f[i + w.length] === " ");
      best = Math.max(best, weight * (whole ? 2 : start ? 1.5 : 1));
    }
    if (!best && w.length >= 3 && inOrder(w, compact)) best = 0.5;
    if (!best) return 0;
    total += best;
  }
  return total;
}

const PROVIDER_NAME: Partial<Record<ProviderId, string>> = { "comfy-cloud": "Comfy" };

export async function searchCustom({
  task,
  q = "",
  page = 1,
  limit = 12,
  provider,
}: {
  task: ModelTask;
  q?: string;
  page?: number;
  limit?: number;
  provider?: ProviderId | null;
}): Promise<CustomSearch> {
  const words = terms(q);
  const hasComfy = Boolean(await comfyKey());
  const [models, comfyIds, comfyLookup] = await Promise.all([
    listModels(),
    hasComfy ? comfyCatalog().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    comfyKnown(),
  ]);
  if (hasComfy) void warmComfyModels();

  type Hit = { row: CustomRow; score: number; tags: string };
  const hits: Hit[] = [];
  for (const m of models) {
    if (!m.available || !builtinFits(m, task)) continue;
    const row = builtinRow(m);
    const s = score(row, "", words);
    if (s > 0) hits.push({ row, score: s, tags: "" });
  }

  // Comfy Router: every catalog model whose schema has been read (built-in ones already appear above).
  const builtin = new Set(MODELS.map((m) => m.id));
  for (const id of comfyIds) {
    const m = comfyLookup(id);
    if (!m || builtin.has(`comfy:${id}`) || !comfyFits(m, task)) continue;
    const row = comfyRow(m, true);
    const s = score(row, "", words);
    if (s > 0) hits.push({ row, score: s, tags: "" });
  }

  const newest = (h: Hit) => (h.row.date ? Date.parse(h.row.date) : 0);
  hits.sort((a, b) =>
    words.length
      ? b.score - a.score || Number(b.row.builtin) - Number(a.row.builtin) || newest(b) - newest(a)
      : Number(b.row.builtin) - Number(a.row.builtin) || newest(b) - newest(a),
  );

  const counts = new Map<ProviderId, number>();
  for (const h of hits) counts.set(h.row.provider, (counts.get(h.row.provider) ?? 0) + 1);
  const shown = provider ? hits.filter((h) => h.row.provider === provider) : hits;
  const size = Math.min(20, Math.max(5, limit));
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const slice = shown.slice((current - 1) * size, current * size);

  const items = slice.map((h) => h.row);

  const warmComfy = comfyWarmState();
  const warming = warmComfy.running ? { done: warmComfy.done, total: warmComfy.total } : null;
  return {
    items,
    total: shown.length,
    page: current,
    pages,
    providers: [...counts].map(([id, count]) => ({ id, name: PROVIDER_NAME[id] ?? engineShortName(id), count })).sort((a, b) => b.count - a.count),
    unconnected: hasComfy ? [] : [{ id: "comfy-cloud" as const, name: "Comfy" }],
    warming,
    task,
  };
}
