"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useModels, useModelsStore } from "@/lib/hooks/use-models";
import type { Caps, ModelTask } from "@/lib/models/caps";
import type { CustomRow, CustomSearch } from "@/lib/models/custom-types";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Custom-tab models seen in this session (from searches or loaded by id), so a picked model's
 * name and capabilities are at hand everywhere without asking the server again.
 */
type State = {
  rows: Record<string, CustomRow>;
  missing: Record<string, true>;
  remember: (rows: CustomRow[]) => void;
  load: (id: string) => Promise<CustomRow | null>;
};

const inflight = new Map<string, Promise<CustomRow | null>>();

export const useCustomModels = create<State>((set, get) => ({
  rows: {},
  missing: {},
  remember: (rows) => {
    if (!rows.length) return;
    const next = { ...get().rows };
    for (const r of rows) if (!next[r.id] || (r.caps && !next[r.id].caps) || r.price) next[r.id] = { ...next[r.id], ...r };
    set({ rows: next });
  },
  load: (id) => {
    const have = get().rows[id];
    if (have?.caps) return Promise.resolve(have);
    const running = inflight.get(id);
    if (running) return running;
    const p = fetch(`/api/models/caps?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { row?: CustomRow };
        if (!res.ok || !data.row) {
          set({ missing: { ...get().missing, [id]: true } });
          return null;
        }
        get().remember([data.row]);
        return data.row;
      })
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  },
}));

const cache = new Map<string, { at: number; data: CustomSearch }>();

/** One page of the Custom tab. Results are kept for a minute so paging back is instant. */
export async function searchCustomModels(
  params: { task: ModelTask; q: string; page: number; limit?: number; provider?: ProviderId | null },
  signal?: AbortSignal,
): Promise<CustomSearch> {
  const qs = new URLSearchParams({ task: params.task, q: params.q.trim(), page: String(params.page), limit: String(params.limit ?? 12) });
  if (params.provider) qs.set("provider", params.provider);
  const key = qs.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000 && !hit.data.warming) return hit.data;
  const res = await fetch(`/api/models/custom?${key}`, { cache: "no-store", signal });
  const data = (await res.json()) as CustomSearch & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Search failed (${res.status})`);
  cache.set(key, { at: Date.now(), data });
  useCustomModels.getState().remember(data.items);
  return data;
}

/** Whether a model id comes from a provider's own catalog (Custom tab) rather than Crackio's list. */
export const isCustomModel = (id: string | null | undefined) =>
  Boolean(id && /^(fal|comfy):/.test(id) && !useModelsStore.getState().models.some((m) => m.id === id));

/**
 * The model a tool will run and what it accepts: built-in models from the model list, Custom-tab
 * models from their schema (loaded on first use).
 */
export function useModelInfo(id: string | null | undefined): { caps: Caps | null; name: string | null; vendor: string | null; provider: ProviderId | null; loading: boolean } {
  const { models } = useModels();
  const custom = isCustomModel(id);
  const row = useCustomModels((s) => (id ? s.rows[id] : undefined));
  const missing = useCustomModels((s) => (id ? Boolean(s.missing[id]) : false));
  useEffect(() => {
    if (id && custom && !row?.caps && !missing) void useCustomModels.getState().load(id);
  }, [id, custom, row?.caps, missing]);
  if (!id) return { caps: null, name: null, vendor: null, provider: null, loading: false };
  if (custom) return { caps: row?.caps ?? null, name: row?.name ?? null, vendor: row?.vendor ?? null, provider: row?.provider ?? null, loading: !row?.caps && !missing };
  const m = models.find((x) => x.id === id);
  return { caps: m?.caps ?? null, name: m?.name ?? null, vendor: m?.vendor ?? null, provider: m?.via ?? null, loading: false };
}
