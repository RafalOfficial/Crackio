import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { writeFileAtomic } from "./atomic-write";
import { getGeneration } from "./db";
import { comfyTargets } from "./comfy-targets";
import { graphSettings, leak, mainStep, scrub, type JobRecipe, type RecipeStep } from "@/lib/recipes/recipe";

/**
 * Every Library item keeps the recipe that made it (lib/recipes): the job runs with a recorder, every ComfyUI graph it
 * queues (engines/comfy-local `runWorkflow`) and every Comfy Router request (engines/comfy) is added to it as it's sent,
 * and a job that finished keeps them in data/recipes/<id>.json. Steps run inside the job's own calls, nested engines
 * included (a swap's outline, redraw and clip passes), so a multi-step tool keeps each step's graph in order. What Crackio
 * does itself on the way (a text model writing the prompt, ffmpeg laying the sound back) is listed too, as "outside" steps.
 *
 * Recipes are shown and shared, so nothing private goes in: machines by a key, not their id (which carries their address),
 * and every string is scrubbed of links, addresses, keys, logins and paths before it's kept (`scrub`, then `leak` as a check).
 */
export const RECIPES_DIR = path.join(DATA_DIR, "recipes");

// On globalThis: a job that started before a code reload records into the same store the new code reads.
const g = globalThis as unknown as { __crackioRecipeStore?: AsyncLocalStorage<RecipeStep[]>; __crackioMachineSalt?: Buffer };
const store = (g.__crackioRecipeStore ??= new AsyncLocalStorage<RecipeStep[]>());

const fileFor = (id: string) => (/^[\w-]{1,80}$/.test(id) ? path.join(RECIPES_DIR, `${id}.json`) : null);

/** This install's secret for machine keys, made once (data/recipes/.machine-salt). */
function salt() {
  if (g.__crackioMachineSalt) return g.__crackioMachineSalt;
  const file = path.join(RECIPES_DIR, ".machine-salt");
  let value: Buffer;
  try {
    value = fsSync.readFileSync(file);
    if (value.length < 16) throw new Error("short");
  } catch {
    value = randomBytes(32);
    fsSync.mkdirSync(RECIPES_DIR, { recursive: true });
    fsSync.writeFileSync(file, value);
  }
  return (g.__crackioMachineSalt = value);
}

/** A machine as recipes name it: the same key every time, which can't be turned back into the machine's address. */
export const machineKey = (machineId: string) => `m-${createHmac("sha256", salt()).update(machineId).digest("hex").slice(0, 16)}`;

/** Runs a Library job with its steps recorded; when it finished, keeps them next to it. */
export async function recording(id: string, run: () => Promise<void>) {
  const steps: RecipeStep[] = [];
  try {
    await store.run(steps, run);
  } finally {
    if (steps.length) await keep(id, steps).catch((err) => console.warn(`[recipes] couldn't keep ${id}'s recipe:`, (err as Error).message));
  }
}

/**
 * Runs one step of the current job (a graph, a Router request, a step outside ComfyUI), recorded as sent; `done` adds what
 * came back. Outside a recorded job (a click's outline, a page's preview) it just runs.
 */
export async function recorded<T>(
  step: Omit<RecipeStep, "at" | "status">,
  work: (step: RecipeStep | null) => Promise<T>,
  done?: (result: T, step: RecipeStep) => void,
): Promise<T> {
  const steps = store.getStore();
  const s: RecipeStep | null = steps ? { ...step, at: Date.now(), status: "running" } : null;
  if (s) steps!.push(s);
  try {
    const result = await work(s);
    if (s) {
      s.status = "done";
      s.wallMs = Date.now() - s.at;
      done?.(result, s);
    }
    return result;
  } catch (err) {
    if (s) {
      s.status = "error";
      s.error = (err as Error).message?.slice(0, 400);
      s.wallMs = Date.now() - s.at;
    }
    throw err;
  }
}

/** A step Crackio does itself, outside ComfyUI (ffmpeg, a blend, a text model), listed in the recipe so it's the whole job. */
export const outside = <T>(name: string, detail: string | undefined, work: () => Promise<T>, after?: (result: T, step: RecipeStep) => void) =>
  recorded({ kind: "outside", name, ...(detail ? { detail } : {}) }, () => work(), after);

/** Whether the code running now is part of a recorded job. */
export const recordingNow = () => Boolean(store.getStore());

/** A recipe as it may be kept: machines by key, every string scrubbed. Older recipes (machine ids) come out the same way. */
function clean(recipe: JobRecipe): JobRecipe {
  const steps = recipe.steps.map((s) => {
    if (!s.machine) return s;
    const { id, ...machine } = s.machine as RecipeStep["machine"] & { id?: string };
    return { ...s, machine: { ...machine, key: machine.key ?? (id ? machineKey(id) : "m-unknown") } };
  });
  return scrub({ ...recipe, steps });
}

async function keep(id: string, steps: RecipeStep[]) {
  const gen = getGeneration(id);
  const file = fileFor(id);
  // Takes made without ComfyUI (a Grok picture) keep nothing: their outside steps alone aren't a recipe.
  if (!gen || gen.status !== "done" || !file || !steps.some((s) => s.kind !== "outside")) return;
  const main = mainStep(steps);
  const graph = steps[main]?.graph;
  const out = gen.outputs[0];
  const recipe = clean({
    version: 1,
    id,
    tool: gen.tool,
    model: gen.model,
    modelName: gen.modelName,
    engine: gen.engine,
    prompt: gen.compiledPrompt ?? gen.prompt,
    createdAt: gen.createdAt,
    finishedAt: gen.finishedAt,
    ...(out?.width && out.height ? { size: { width: out.width, height: out.height } } : {}),
    main,
    ...(graph ? { settings: graphSettings(graph) } : {}),
    steps,
  });
  // Fails closed: a recipe that still holds something private isn't kept at all.
  const left = leak(recipe);
  if (left) throw new Error(`it still held something private ("${left}")`);
  await writeFileAtomic(file, JSON.stringify(recipe));
}

/** A Library item's recipe; null for one made before recipes were kept, or by an engine without graphs. */
export async function readRecipe(id: string): Promise<JobRecipe | null> {
  const file = fileFor(id);
  if (!file) return null;
  let raw: JobRecipe;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8")) as JobRecipe;
  } catch {
    return null;
  }
  const recipe = clean(raw);
  if (leak(recipe)) return null;
  // One kept before the guard is written again the way it is now.
  if (JSON.stringify(recipe) !== JSON.stringify(raw)) await writeFileAtomic(file, JSON.stringify(recipe)).catch(() => undefined);
  return recipe;
}

/**
 * For the Library's own answer only (never kept or downloaded): each step's machine id, found again from its key among the
 * machines Crackio knows now, so "Open in ComfyUI" opens the graph on the machine that ran it.
 */
export async function withMachineIds(recipe: JobRecipe): Promise<JobRecipe> {
  const targets = await comfyTargets().catch(() => []);
  // A billed machine (RunPod, Comfy Cloud) has no interface to open a graph in here: the page's own pick (your ComfyUI) does.
  const byKey = new Map(targets.filter((t) => !t.metered && !t.serverless).map((t) => [machineKey(t.id), t.id]));
  return { ...recipe, steps: recipe.steps.map((s) => (s.machine && byKey.has(s.machine.key) ? { ...s, machine: { ...s.machine, id: byKey.get(s.machine.key) } } : s)) };
}

/** Forget a deleted item's recipe. */
export async function dropRecipe(id: string) {
  const file = fileFor(id);
  if (file) await fs.rm(file, { force: true }).catch(() => undefined);
}
