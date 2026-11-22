"use client";

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { Generation } from "@/lib/generations/types";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";

/**
 * A tool's own takes, beyond the newest 60 of every tool that the shared list holds (lib/hooks/use-generations): the
 * Director said "No takes yet" to someone with 260 Director takes, and the edit tools lost a picture's older takes.
 * Each tool's are fetched once (`/api/generations?tool=`), older pages on request; the shared list's copy of a take wins
 * (the poll keeps that one fresh), and a take removed from it goes from here too.
 */
type ToolTakes = { items: Generation[]; loading: boolean; error: boolean; done: boolean; cursor: number | null };

const EMPTY: ToolTakes = { items: [], loading: false, error: false, done: false, cursor: null };
const PAGE = 200;

const useToolTakesStore = create<{ byTool: Record<string, ToolTakes> }>(() => ({ byTool: {} }));

const patch = (tool: string, p: Partial<ToolTakes>) =>
  useToolTakesStore.setState((s) => ({ byTool: { ...s.byTool, [tool]: { ...(s.byTool[tool] ?? EMPTY), ...p } } }));

let watching = false;
/** Takes deleted from the shared list (the Library, a tool's Remove) leave every tool's list too. */
function watchRemovals() {
  if (watching) return;
  watching = true;
  useGenerationsStore.subscribe((s, prev) => {
    if (!prev.loaded || s.items === prev.items || s.items.length >= prev.items.length) return;
    const left = new Set(s.items.map((g) => g.id));
    const gone = new Set(prev.items.filter((g) => !left.has(g.id)).map((g) => g.id));
    if (!gone.size) return;
    useToolTakesStore.setState((st) => ({
      byTool: Object.fromEntries(Object.entries(st.byTool).map(([tool, t]) => [tool, t.items.some((g) => gone.has(g.id)) ? { ...t, items: t.items.filter((g) => !gone.has(g.id)) } : t])),
    }));
  });
}

/**
 * Fetch a tool's takes (`more`: the page older than what's here). The server filters by tool where it can; where it
 * doesn't yet, a page is every tool's newest and this one's are picked out of it, so paging on still finds the rest.
 */
export async function loadToolTakes(tool: string, more = false) {
  watchRemovals();
  const now = useToolTakesStore.getState().byTool[tool];
  if (now?.loading || (!more && now && (now.items.length || now.done)) || (more && now?.done)) return;
  patch(tool, { loading: true, error: false });
  try {
    const before = more ? now?.cursor : null;
    const res = await fetch(`/api/generations?tool=${encodeURIComponent(tool)}&limit=${PAGE}${before ? `&before=${before}` : ""}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { items?: Generation[] };
    if (!res.ok || !Array.isArray(data.items)) throw new Error(`Takes didn't load (${res.status})`);
    const page = data.items;
    const had = useToolTakesStore.getState().byTool[tool]?.items ?? [];
    const byId = new Map(had.map((g) => [g.id, g]));
    for (const g of page) if (g.tool === tool && !byId.has(g.id)) byId.set(g.id, g);
    patch(tool, {
      items: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
      loading: false,
      done: page.length < PAGE,
      cursor: page.length ? Math.min(...page.map((g) => g.createdAt)) : (now?.cursor ?? null),
    });
  } catch {
    patch(tool, { loading: false, error: true });
  }
}

/** Whether older takes are there to fetch, and whether a page is on its way. */
export function useToolTakesStatus(tool: string) {
  const loading = useToolTakesStore((s) => s.byTool[tool]?.loading ?? false);
  const done = useToolTakesStore((s) => s.byTool[tool]?.done ?? false);
  const error = useToolTakesStore((s) => s.byTool[tool]?.error ?? false);
  return { loading, done, error };
}

/** Every take this tool made, newest first: the shared list's (live, fresh) merged over the ones fetched for it. */
export function useToolTakes(tool: string) {
  const shared = useGenerations((s) => s.items);
  const own = useToolTakesStore((s) => s.byTool[tool]?.items);
  useEffect(() => {
    void loadToolTakes(tool);
  }, [tool]);
  return useMemo(() => {
    const mine = shared.filter((g) => g.tool === tool);
    if (!own?.length) return mine;
    const byId = new Map(own.map((g) => [g.id, g]));
    for (const g of mine) byId.set(g.id, g);
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [shared, own, tool]);
}

/** The same list read once, outside React (a key handler stepping through the takes). */
export function toolTakesNow(tool: string): Generation[] {
  const mine = useGenerationsStore.getState().items.filter((g) => g.tool === tool);
  const own = useToolTakesStore.getState().byTool[tool]?.items;
  if (!own?.length) return mine;
  const byId = new Map(own.map((g) => [g.id, g]));
  for (const g of mine) byId.set(g.id, g);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}
