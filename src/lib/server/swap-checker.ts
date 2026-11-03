import "server-only";
import { EngineError } from "@/lib/engines/types";
import { getSettings } from "./settings";

/**
 * Who checks a swap's drawings (is the character fully swapped in, is the pose kept), as picked on the Swap page and kept
 * in settings: "local", Crackio's own judge (LFM3-VL 2B with the judge LoRA) on your GPU; "cloud", Gemini 3.5 Flash on
 * your Comfy API key; "auto", the judge where it's installed, else Gemini. A swap whose pick can't run is refused before
 * it starts (`swapChecks`), never halfway through.
 */
export type SwapChecker = "auto" | "local" | "cloud";

export const GEMINI = "comfy:google/gemini-3.5-flash";
export const JUDGE = "local:lfm3-judge";

/**
 * The text models a swap asks, in order: `judges` pick the best take (the judge reads one take at a time, see the recipe's
 * bestTake), `lookers` read poses and check changes in words. `basic`: neither the judge nor Gemini, only LFM3-VL or the
 * Qwen3-VL picture reader (Auto, as before the choice existed).
 */
/** How sure Crackio's judge must be before a drawing is kept (bestTake's JUDGE_PASS); the setting, lenient by default. */
export type SwapStrictness = "strict" | "normal" | "lenient";

export type SwapChecks = { checker: "local" | "cloud" | "basic"; judges: string[]; lookers: string[]; label: string; strictness: SwapStrictness };

const LOCAL: Omit<SwapChecks, "label" | "strictness"> = { checker: "local", judges: [JUDGE, "local:lfm3", "local:text"], lookers: ["local:lfm3", "local:text"] };
const CLOUD: Omit<SwapChecks, "label" | "strictness"> = { checker: "cloud", judges: [GEMINI], lookers: [GEMINI] };
const BASIC: Omit<SwapChecks, "label" | "strictness"> = { checker: "basic", judges: ["local:lfm3", "local:text"], lookers: ["local:lfm3", "local:text"] };

export type CheckerState = {
  picked: SwapChecker;
  local: { ok: boolean; where?: string; why?: string };
  cloud: { ok: boolean; why?: string };
};

// Gemini's answer to a one-word question, kept a while: a key that's out of credits or refused shows up here, before a
// swap starts, instead of as unchecked drawings halfway through.
const g = globalThis as unknown as { __crackioGeminiProbe?: { at: number; key: string; ok: boolean; why?: string } };

async function geminiState(probe: boolean): Promise<{ ok: boolean; why?: string }> {
  const [{ listModels }, { comfyTextKey, routerText }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/comfy-text")]);
  const model = (await listModels()).find((m) => m.id === GEMINI);
  if (!model?.available) return { ok: false, why: "Add a Comfy API key in Settings → Accounts." };
  if (!probe) return { ok: true };
  const key = (await comfyTextKey()) ?? "";
  const hit = g.__crackioGeminiProbe;
  if (hit && hit.key === key && Date.now() - hit.at < (hit.ok ? 10 : 1) * 60_000) return { ok: hit.ok, why: hit.why };
  let state: { ok: boolean; why?: string };
  try {
    await routerText({ model: model.model ?? "google/gemini-3.5-flash", system: "Answer with the one word OK.", prompt: "OK?", what: "Gemini 3.5 Flash", signal: AbortSignal.timeout(30_000) });
    state = { ok: true };
  } catch (err) {
    const e = err as EngineError;
    state = { ok: false, why: [e.message, e.hint].filter(Boolean).join(" ") };
  }
  g.__crackioGeminiProbe = { at: Date.now(), key, ...state };
  return state;
}

/** Whether each checker can run now; `probe` also asks Gemini for one word (a fraction of a cent), kept 10 minutes. */
export async function checkerState(probe = false): Promise<CheckerState> {
  const [{ lfm3Machine }, settings] = await Promise.all([import("@/lib/engines/comfy-text"), getSettings()]);
  const [judge, cloud] = await Promise.all([lfm3Machine("judge").catch(() => null), geminiState(probe)]);
  return {
    picked: settings.swapChecker ?? "auto",
    local: judge ? { ok: true, where: judge.label } : { ok: false, why: "Crackio's judge isn't on any of your machines yet: Settings → Tools → Swap shows it once it's published." },
    cloud,
  };
}

/**
 * The checks a swap runs with (`asked`, else the setting), or an EngineError saying why they can't run and what to do.
 * With Auto and neither the judge nor Gemini, LFM3-VL or Qwen3-VL on your GPU check the drawings, as before.
 */
export async function swapChecks(asked?: unknown, askedStrictness?: unknown): Promise<SwapChecks> {
  const settings = await getSettings();
  const picked: SwapChecker = asked === "local" || asked === "cloud" || asked === "auto" ? asked : (settings.swapChecker ?? "auto");
  const strictness: SwapStrictness =
    askedStrictness === "strict" || askedStrictness === "normal" || askedStrictness === "lenient" ? askedStrictness : (settings.swapStrictness ?? "lenient");
  return { ...(await pickChecks(picked)), strictness };
}

async function pickChecks(picked: SwapChecker): Promise<Omit<SwapChecks, "strictness">> {
  const state = await checkerState(picked !== "local");
  if (picked === "local") {
    if (!state.local.ok) throw new EngineError("Your GPU can't check this swap's drawings yet: Crackio's judge isn't installed.", "Pick Gemini under Checks, or set the judge up once it's published (Settings → Tools → Swap).");
    return { ...LOCAL, label: `Crackio's judge on ${state.local.where}` };
  }
  if (picked === "cloud") {
    if (!state.cloud.ok) throw new EngineError(`Gemini can't check this swap's drawings: ${state.cloud.why ?? "it didn't answer"}`, "Pick Your GPU under Checks, or fix the Comfy key in Settings → Accounts.");
    return { ...CLOUD, label: "Gemini 3.5 Flash" };
  }
  if (state.local.ok) return { ...LOCAL, label: `Crackio's judge on ${state.local.where}` };
  if (state.cloud.ok) return { ...CLOUD, label: "Gemini 3.5 Flash" };
  const { lfm3Machine, localLlm } = await import("@/lib/engines/comfy-text");
  if ((await lfm3Machine().catch(() => null)) || (await localLlm(true).catch(() => null))) return { ...BASIC, label: "a picture reader on your GPU" };
  throw new EngineError("Swap needs a model to check its drawings.", "Add a Comfy API key in Settings → Accounts for Gemini, or set Crackio's judge up in Settings → Tools → Swap.");
}
