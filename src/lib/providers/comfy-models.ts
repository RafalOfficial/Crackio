import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { comfy } from "@comfyorg/sdk";
import { getSettings } from "@/lib/server/settings";
import { writeFileAtomic } from "@/lib/server/atomic-write";
import { DATA_DIR } from "@/lib/server/paths";
import { capsFromOpenApi } from "@/lib/models/openapi";
import { CAPS_FIXES, familyFor, FLAT_FIXES } from "@/lib/engines/comfy-families";
import type { Caps } from "@/lib/models/caps";

/**
 * Every model on Comfy Router, for the Custom tab. The catalog lists only ids, so what each model
 * makes and takes comes from the OpenAPI document Router publishes per model (read with your key,
 * or from Comfy's public copy when that fails). Nested request shapes (Seedance, Wan, Veo, Kling
 * Omni…) are described by hand in comfy-families.
 */
const CACHE_DIR = path.join(DATA_DIR, "cache", "comfy");
const CATALOG_FILE = path.join(CACHE_DIR, "catalog.json");
const CAPS_FILE = path.join(CACHE_DIR, "caps.json");
/** Bump when the readers change, so cached capabilities are read again. */
const CAPS_VERSION = 2;
const CATALOG_TTL = 12 * 3600_000;
const CAPS_TTL = 24 * 3600_000;

export type ComfyModel = {
  id: string;
  /** What it makes; null for text, audio and 3D models. */
  output: "image" | "video" | null;
  /** Another provider's raw body behind a Comfy id (hidden: it doesn't take the native shape). */
  alias: boolean;
  caps: Caps | null;
  at: number;
};

type State = {
  catalog: { at: number; ids: string[] } | null;
  loading: Promise<string[]> | null;
  models: Map<string, ComfyModel> | null;
  /** The caps version `models` was read for: a hot reload with a new version reads again. */
  version?: number;
  warm: { running: boolean; done: number; total: number };
};
const g = globalThis as unknown as { __crackioComfyModels?: State };
const state: State = (g.__crackioComfyModels ??= { catalog: null, loading: null, models: null, warm: { running: false, done: 0, total: 0 } });

export async function comfyKey() {
  return (await getSettings()).keys.comfy || process.env.COMFY_API_KEY || null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, data: unknown) {
  await writeFileAtomic(file, JSON.stringify(data));
}

/** Every model id your key can run (cached on disk for 12 hours; a stale list is served while a fresh one loads). */
export async function comfyCatalog(): Promise<string[]> {
  const key = await comfyKey();
  if (!key) return [];
  if (!state.catalog) {
    const disk = await readJson<{ at: number; ids: string[] }>(CATALOG_FILE);
    if (disk?.ids?.length) state.catalog = disk;
  }
  const fresh = state.catalog && Date.now() - state.catalog.at < CATALOG_TTL;
  if (!fresh && !state.loading) {
    state.loading = (async () => {
      comfy.config({ credentials: key });
      const ids: string[] = [];
      for await (const m of comfy.models.list({ limit: 100 })) ids.push(m.id);
      state.catalog = { at: Date.now(), ids };
      await writeJson(CATALOG_FILE, state.catalog).catch(() => {});
      return ids;
    })().finally(() => {
      state.loading = null;
    });
  }
  if (state.catalog) {
    state.loading?.catch(() => {});
    return state.catalog.ids;
  }
  return state.loading!.catch(() => []);
}

async function models() {
  if (!state.models || state.version !== CAPS_VERSION) {
    const disk = await readJson<{ version: number; items: Record<string, ComfyModel> }>(CAPS_FILE);
    state.models = new Map(disk?.version === CAPS_VERSION ? Object.entries(disk.items) : []);
    state.version = CAPS_VERSION;
  }
  return state.models;
}

let saving: Promise<void> | null = null;
function save() {
  saving ??= (async () => {
    await new Promise((r) => setTimeout(r, 800));
    saving = null;
    await writeJson(CAPS_FILE, { version: CAPS_VERSION, items: Object.fromEntries(await models()) }).catch(() => {});
  })();
}

/** A model's OpenAPI document: Router's (with your key), else Comfy's public copy of it. */
async function schemaOf(id: string): Promise<Record<string, unknown> | null> {
  const key = await comfyKey();
  if (key) {
    try {
      comfy.config({ credentials: key });
      const r = await comfy.models.schema<Record<string, unknown>>(id, { timeoutMs: 20_000 });
      if (!r.unchanged && r.document) return r.document;
    } catch {
      /* fall back to the public copy */
    }
  }
  try {
    const res = await fetch(`https://docs.comfy.org/router-schemas/${id}.json`, { signal: AbortSignal.timeout(12_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function read(id: string, doc: Record<string, unknown> | null): ComfyModel {
  const outs = (doc?.["x-comfy-router-output-modalities"] as string[] | undefined) ?? [];
  const output = outs.includes("video") ? "video" : outs.includes("image") ? "image" : null;
  const alias = Boolean(doc?.["x-comfy-router-alias-of"]) || doc?.["x-comfy-input-schema-authored"] === false;
  let caps: Caps | null = null;
  if (doc && output && !alias) {
    const family = familyFor(id);
    try {
      caps = family ? family.caps(id) : capsFromOpenApi(doc, output);
    } catch {
      caps = null;
    }
    const fix = FLAT_FIXES.find(([re]) => re.test(id))?.[1];
    if (caps && fix) caps = { ...caps, fixed: { ...caps.fixed, ...fix }, missing: caps.missing.filter((m) => !(m in fix)) };
    const choices = CAPS_FIXES.find(([re]) => re.test(id))?.[1];
    if (caps && choices) caps = { ...caps, ...choices, missing: caps.missing.filter((m) => !Object.values(choices).some((c) => c && typeof c === "object" && "field" in c && c.field === m)) };
  }
  return { id, output, alias, caps, at: Date.now() };
}

/** What one Comfy model makes and accepts (cached for a day). */
export async function comfyModel(id: string): Promise<ComfyModel> {
  const map = await models();
  const hit = map.get(id);
  if (hit && Date.now() - hit.at < CAPS_TTL) return hit;
  const model = read(id, await schemaOf(id));
  // A failed read keeps the last good answer rather than forgetting the model.
  if (!model.caps && hit?.caps) return hit;
  map.set(id, model);
  save();
  return model;
}

/** Models already read, without a network call. */
export async function comfyKnown(): Promise<(id: string) => ComfyModel | undefined> {
  const map = await models();
  return (id) => map.get(id);
}

export function comfyWarmState() {
  return { ...state.warm };
}

/** Read every catalog model's schema in the background (a few at a time), so search can classify them. */
export async function warmComfyModels() {
  if (state.warm.running || !(await comfyKey())) return;
  const ids = await comfyCatalog();
  const map = await models();
  const todo = ids.filter((id) => {
    const hit = map.get(id);
    return !hit || Date.now() - hit.at > CAPS_TTL;
  });
  if (!todo.length) return;
  state.warm = { running: true, done: 0, total: todo.length };
  void (async () => {
    try {
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map((id) => comfyModel(id).catch(() => null)));
        state.warm.done = Math.min(todo.length, i + 4);
      }
    } finally {
      state.warm.running = false;
      save();
    }
  })();
}

/** "byteplus/dreamina-seedance-2-5-260628" → "Dreamina Seedance 2.5"; "kling/kling-v3-omni" → "Kling V3 Omni". */
export function comfyName(id: string) {
  const model = id.split("/")[1] ?? id;
  const words = model
    .replace(/-\d{6}$/, "")
    .replace(/-generate-\d{3}$/, "")
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (/^(ltx|gpt|ai|hd|vto|r2v|t2v|i2v|i2i|t2i|sd|fibo)$/i.test(w) ? w.toUpperCase() : /^v\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return words.join(" ").replace(/\bFlux\b/, "FLUX").replace(/\bGemini Nano Banana\b/, "Nano Banana").replace(/\bGrok Imagine\b/, "Grok Imagine");
}
