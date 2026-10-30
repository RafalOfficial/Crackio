import "server-only";
import { detectConnections } from "@/lib/providers/detect";
import { implementedEngines } from "@/lib/engines/registry";
import { getSettings } from "@/lib/server/settings";
import { EngineError } from "@/lib/engines/types";
import { AUTO_PREFERENCE, MODELS, type ModelAvailability, type ModelKind } from "./catalog";
import { builtinCaps } from "./builtin-caps";
import type { Caps } from "./caps";
import { comfyKnown, comfyModel } from "@/lib/providers/comfy-models";
import { customModel, isCustomId } from "./custom";
import { engineShortName } from "@/lib/providers/names";
import { localModelReady, localTimes } from "@/lib/server/local-models";
import { templateDefs } from "@/lib/server/local-templates";
import { localLlm } from "@/lib/engines/comfy-text";
import { demoOn, demoWords } from "@/lib/demo/config";

/** Every model with whether it can run on this machine right now, and through which connection. */
export async function listModels(): Promise<ModelAvailability[]> {
  const connected = new Set((await detectConnections()).filter((c) => c.state === "connected").map((c) => c.id));
  const implemented = new Set(implementedEngines());
  const all = [...MODELS];
  // Comfy models driven from their Router schema bring what they accept once it's been read.
  const comfy = await comfyKnown();
  if (connected.has("comfy-cloud")) for (const m of all) if (m.family === "comfy-custom" && !comfy(m.model)) void comfyModel(m.model).catch(() => null);

  // Open models on your ComfyUI run once their files are there (the Local page installs them). Models from ComfyUI's
  // official templates join the list only once they're installed, so the pickers don't fill up with dozens of maybes.
  const localReady = new Map<string, boolean | null>();
  const templateCaps = new Map<string, Caps>();
  if (connected.has("comfy-local")) {
    for (const t of templateDefs()) {
      if ((await localModelReady(t.def.id).catch(() => null)) !== true) continue;
      all.push(t.def);
      templateCaps.set(t.def.id, t.caps);
    }
    for (const m of all) if (m.family === "comfy-local") localReady.set(m.id, await localModelReady(m.id).catch(() => null));
    for (const m of all) if (m.family === "comfy-local-text") localReady.set(m.id, (await localLlm().catch(() => null)) !== null);
  }
  // What each installed one takes on the machine that would run it, in place of a fixed "fast" (a small card takes minutes).
  const times = await localTimes([...localReady].filter(([, ready]) => ready).map(([id]) => id)).catch(() => new Map<string, NonNullable<ModelAvailability["localTime"]>>());

  const demo = demoOn();
  return all.map((m) => {
    let via = m.providers.find((p) => connected.has(p) && implemented.has(p)) ?? null;
    let reason: string | undefined;
    if (via === "comfy-local" && localReady.get(m.id) === false) {
      via = null;
      reason = m.family === "comfy-local-text" ? "Needs Qwen 3.5 9B or Qwen3-VL 8B in your ComfyUI's text_encoders" : "Install it on the Local page";
    }
    if (!m.runnable) reason = "Coming soon";
    else if (!via) reason ??= `Connect ${m.providers.map(engineShortName).join(" or ")}`;
    const caps = m.family === "comfy-custom" ? (comfy(m.model)?.caps ?? null) : (templateCaps.get(m.id) ?? builtinCaps(m));
    const localTime = times.get(m.id);
    // In the live demo the open models run on the demo's GPU, not the visitor's: no "(your GPU)" in their names.
    const words = demo ? { name: demoWords(m.name, true), bestFor: demoWords(m.bestFor, true) } : {};
    return { ...m, ...words, available: m.runnable && via !== null, via, reason, caps, ...(localTime ? { localTime } : {}) };
  });
}

/**
 * The model a job should use. `requested` is a catalog id, or "auto" to use the saved default
 * for this kind, then the first connected model in Crackio's preference order.
 */
export async function resolveModel(kind: ModelKind, requested: string | undefined): Promise<ModelAvailability> {
  const models = await listModels();
  const find = (id?: string) => models.find((m) => m.id === id);

  if (requested && requested !== "auto") {
    // A model from a provider's own catalog (Custom tab), known by its schema.
    if (isCustomId(requested) && !find(requested)) {
      const custom = await customModel(kind, requested);
      if (!custom) throw new EngineError(`Unknown model "${requested}".`, "Pick another model.");
      if (!custom.available) throw new EngineError(`${custom.name} can't run here.`, custom.reason);
      return custom;
    }
    const m = find(requested);
    if (!m) throw new EngineError(`Unknown model "${requested}".`, "Pick another model.");
    if (m.kind !== kind) throw new EngineError(`${m.name} can't do this.`, "Pick another model.");
    if (!m.available) throw new EngineError(`${m.name} isn't available.`, m.reason ? `${m.reason} in Connections.` : undefined);
    return m;
  }

  const saved = (await getSettings()).models?.[kind];
  // A saved default can be a Custom-tab model too.
  if (saved && isCustomId(saved) && !find(saved)) {
    const custom = await customModel(kind, saved).catch(() => null);
    if (custom?.available) return custom;
  }
  const candidates = [saved, ...AUTO_PREFERENCE[kind], ...models.filter((m) => m.kind === kind).map((m) => m.id)];
  for (const id of candidates) {
    const m = find(id);
    if (m?.available && m.kind === kind) return m;
  }
  if (kind === "text")
    throw new EngineError(
      "No text model can run yet: add a Comfy key in Connections, or put Qwen 3.5 9B or Qwen3-VL 8B in your ComfyUI's text_encoders.",
      "Add a Comfy key in Connections, or install a text model on the Local page.",
    );
  const needs = find(AUTO_PREFERENCE[kind][0]);
  const what = { image: "make images", video: "make video", upscale: "upscale", reframe: "reframe", text: "write prompts" }[kind];
  throw new EngineError(
    `Nothing connected can ${what} yet.`,
    needs ? `Connect ${needs.providers.map(engineShortName).join(" or ")} in Connections.` : "Open Connections.",
  );
}
