import "server-only";
import { detectConnections } from "@/lib/providers/detect";
import { implementedEngines } from "@/lib/engines/registry";
import { getSettings } from "@/lib/server/settings";
import { EngineError } from "@/lib/engines/types";
import { AUTO_PREFERENCE, MODELS, type ModelAvailability, type ModelKind } from "./catalog";
import { builtinCaps } from "./builtin-caps";
import type { Caps } from "./caps";
import { comfyKnown, comfyModel, comfyServed } from "@/lib/providers/comfy-models";
import { customModel, isCustomId } from "./custom";
import { engineShortName } from "@/lib/providers/names";
import { forgetInstalled, localModelReady, localTimes } from "@/lib/server/local-models";
import { templateDefs } from "@/lib/server/local-templates";
import { lfm3LoraOf, lfm3Machine, localLlm } from "@/lib/engines/comfy-text";
import { demoOn, demoWords } from "@/lib/demo/config";
import { epoch } from "@/lib/server/epoch";

type ListEntry = { at: number; epoch: number; list: ModelAvailability[] };
const g = globalThis as unknown as {
  __crackioModelList?: ListEntry;
  __crackioModelListPending?: { epoch: number; value: Promise<ModelAvailability[]> };
  __crackioModelLookAgain?: { at: number; value: Promise<ModelAvailability[]> };
};

/**
 * Every model with whether it can run on this machine right now, and through which connection. Every picker, price, job
 * start and pipeline step asks (about 27 callers), and a list reads every machine (5–7 s with one switched off): a list
 * under 5 s old is answered as is, one up to 60 s old is answered while a new one is made in the background, and one from
 * before a change (lib/server/epoch: settings, a machine online or offline, an install, a set-up finishing) never is.
 */
export async function listModels(): Promise<ModelAvailability[]> {
  const now = epoch();
  const hit = g.__crackioModelList;
  if (hit && hit.epoch === now) {
    const age = Date.now() - hit.at;
    if (age < 5000) return hit.list;
    if (age < 60_000) {
      void rebuildModels(now).catch(() => undefined);
      return hit.list;
    }
  }
  return rebuildModels(now);
}

/** A new list for this epoch, or the one being made for it already. */
function rebuildModels(now: number): Promise<ModelAvailability[]> {
  const pending = g.__crackioModelListPending;
  if (pending && pending.epoch === now) return pending.value;
  const value = buildModels().then((list) => {
    g.__crackioModelList = { at: Date.now(), epoch: now, list };
    return list;
  });
  const entry = { epoch: now, value };
  g.__crackioModelListPending = entry;
  void value
    .catch(() => undefined)
    .finally(() => {
      if (g.__crackioModelListPending === entry) g.__crackioModelListPending = undefined;
    });
  return value;
}

async function buildModels(): Promise<ModelAvailability[]> {
  const connected = new Set((await detectConnections()).filter((c) => c.state === "connected").map((c) => c.id));
  const implemented = new Set(implementedEngines());
  const all = [...MODELS];
  // Comfy models driven from their Router schema bring what they accept once it's been read.
  const comfy = await comfyKnown();
  if (connected.has("comfy-cloud")) for (const m of all) if (m.family === "comfy-custom" && !comfy(m.model)) void comfyModel(m.model).catch(() => null);
  // Whether Router runs each one is learnt from a free price check, each model at most every 12 hours (loaded here, not
  // at the top: the engines read this module).
  const { notServed } = await comfyServed();
  if (connected.has("comfy-cloud")) {
    const ask = all.filter((m) => m.runnable && m.providers.includes("comfy-cloud") && (m.kind === "image" || m.kind === "video")).map((m) => ({ model: m.model, family: m.family, kind: m.kind as "image" | "video" }));
    void import("@/lib/engines/comfy-quote").then((q) => q.probeServed(ask)).catch(() => {});
  }

  // Open models on your ComfyUI run once their files are there (the Local page installs them). Models from ComfyUI's
  // official templates join the list only once they're installed, so the pickers don't fill up with dozens of maybes.
  const localReady = new Map<string, boolean | null>();
  const templateCaps = new Map<string, Caps>();
  if (connected.has("comfy-local")) {
    // All at once (each asks the machines' file lists, which are shared and kept 20 s), in the order they were listed.
    const defs = templateDefs();
    const defReady = await Promise.all(defs.map((t) => localModelReady(t.def.id).catch(() => null)));
    defs.forEach((t, i) => {
      if (defReady[i] !== true) return;
      all.push(t.def);
      templateCaps.set(t.def.id, t.caps);
    });
    const local = all.filter((m) => m.family === "comfy-local");
    const localOk = await Promise.all(local.map((m) => localModelReady(m.id).catch(() => null)));
    local.forEach((m, i) => localReady.set(m.id, localOk[i]));
    const texts = all.filter((m) => m.family === "comfy-local-text");
    // One look for a Qwen text model serves every one of them.
    const llm = texts.some((m) => !m.model.startsWith("lfm3")) ? localLlm().catch(() => null) : null;
    const textOk = await Promise.all(texts.map((m) => (m.model.startsWith("lfm3") ? lfm3Machine(lfm3LoraOf(m.model)).catch(() => null) : llm)));
    texts.forEach((m, i) => localReady.set(m.id, textOk[i] !== null));
  }
  // What each installed one takes on the machine that would run it, in place of a fixed "fast" (a small card takes minutes).
  const times = await localTimes([...localReady].filter(([, ready]) => ready).map(([id]) => id)).catch(() => new Map<string, NonNullable<ModelAvailability["localTime"]>>());

  const demo = demoOn();
  return all.map((m) => {
    let via = m.providers.find((p) => connected.has(p) && implemented.has(p)) ?? null;
    let reason: string | undefined;
    if (via === "comfy-local" && localReady.get(m.id) === false) {
      via = null;
      reason = m.family === "comfy-local-text" && !m.model.startsWith("lfm3") ? "Needs Qwen 3.5 9B or Qwen3-VL 8B in your ComfyUI's text_encoders" : "Set it up in Settings → Tools";
    }
    // Listed on Comfy Router, not run by it yet: a job would fail, so it isn't offered as ready.
    if (via === "comfy-cloud" && notServed(m.model)) {
      via = null;
      reason = "Comfy lists this model but doesn't run it yet";
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
 * A fresh look at each of your ComfyUI machines, then a new list. One at a time, and at most every 8 s, whoever asks:
 * sixteen jobs queued in the same second share it.
 */
function lookAgain(): Promise<ModelAvailability[]> {
  const again = g.__crackioModelLookAgain;
  if (again && Date.now() - again.at < 8000) return again.value;
  const value = (async () => {
    const [{ comfyTargets, withTarget }, { machineLook }] = await Promise.all([import("@/lib/server/comfy-targets"), import("@/lib/server/machine-probe")]);
    const targets = (await comfyTargets().catch(() => [])).filter((t) => !t.serverless && !t.metered);
    await Promise.all(targets.map((t) => machineLook(t, { fresh: true }).catch(() => null)));
    for (const t of targets) withTarget(t, () => forgetInstalled());
    return rebuildModels(epoch());
  })();
  g.__crackioModelLookAgain = { at: Date.now(), value };
  return value;
}

/**
 * The model a job should use. `requested` is a catalog id, or "auto" to use the saved default
 * for this kind, then the first connected model in Crackio's preference order.
 */
export async function resolveModel(kind: ModelKind, requested: string | undefined): Promise<ModelAvailability> {
  let models = await listModels();
  const find = (id?: string) => models.find((m) => m.id === id);
  // A model from ComfyUI's templates is in the list only while a machine that answers has its files.
  const template = requested && requested !== "auto" && !find(requested) ? templateDefs().find((t) => t.def.id === requested)?.def : undefined;

  if (requested && requested !== "auto") {
    // One of your machines' models that this list leaves out or marks as not set up: the list may have been made while
    // its machine missed a check (a busy rented box answers in 1 to 7 s, and the check gives up at 6). One fresh look
    // before a job is refused for a model that drew pictures a minute ago.
    const listed = find(requested);
    if (template || (listed && !listed.available && listed.runnable && listed.providers.includes("comfy-local"))) {
      const before = models;
      models = await lookAgain().catch(() => before);
    }
    // A model from a provider's own catalog (Custom tab), known by its schema.
    if (isCustomId(requested) && !find(requested)) {
      const custom = await customModel(kind, requested);
      if (!custom) throw new EngineError(`Unknown model "${requested}".`, "Pick another model.");
      if (!custom.available) throw new EngineError(`${custom.name} can't run here.`, custom.reason);
      return custom;
    }
    const m = find(requested);
    if (!m && template) throw new EngineError(`${template.name} isn't on a machine that answers right now.`, "Start that machine, or set the model up on one that's on (Settings → Tools).");
    if (!m) throw new EngineError(`Unknown model "${requested}".`, "Pick another model.");
    if (m.kind !== kind) throw new EngineError(`${m.name} can't do this.`, "Pick another model.");
    if (!m.available) throw new EngineError(`${m.name} isn't available.`, m.reason ? `${m.reason}.` : undefined);
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
      "No text model can run yet: add a Comfy key in Settings → Accounts, or put Qwen 3.5 9B or Qwen3-VL 8B in your ComfyUI's text_encoders.",
      "Add a Comfy key in Settings → Accounts, or set up a text model in Settings → Tools.",
    );
  const needs = find(AUTO_PREFERENCE[kind][0]);
  const what = { image: "make images", video: "make video", upscale: "upscale", reframe: "reframe", text: "write prompts" }[kind];
  throw new EngineError(
    `Nothing connected can ${what} yet.`,
    needs ? `Connect ${needs.providers.map(engineShortName).join(" or ")} in Settings → Accounts.` : "Open Settings.",
  );
}
