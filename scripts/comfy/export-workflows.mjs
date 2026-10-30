#!/usr/bin/env node
/**
 * Writes workflows/runs/: the exact ComfyUI graphs (API format) that real Crackio jobs ran, taken from the recipes every
 * Library take keeps (data/recipes/<id>.json, see src/lib/server/recipes.ts), and the table in workflows/README.md
 * (tool → file → models → custom nodes → where it ran).
 *
 *   node scripts/comfy/export-workflows.mjs              the takes listed in workflows/runs.json, again
 *   node scripts/comfy/export-workflows.mjs --add <id> [--as <name>]
 *                                                        adds a take (its id is in the Library's ?view= link) to the list
 *   node scripts/comfy/export-workflows.mjs --redact     free text (prompts, descriptions) replaced by what it is
 *
 * runs.json lists the takes: { id, name, label?, labels? } (a step's name in the table, one per step for several).
 *
 * A take made of several steps (a swap: outline, redraw, clip) writes one file per step, numbered in the order they ran.
 * CRACKIO_DATA_DIR points at another data folder, as for the app.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const dataDir = path.resolve(process.env.CRACKIO_DATA_DIR || path.join(root, "data"));
const recipesDir = path.join(dataDir, "recipes");
const outDir = path.join(root, "workflows", "runs");
const listFile = path.join(root, "workflows", "runs.json");
const readme = path.join(root, "workflows", "README.md");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const TOOLS = {
  image: "Image",
  create: "Image",
  video: "Video",
  recast: "Swap",
  swap: "Swap",
  templates: "Templates",
  director: "Director",
  angles: "Angles",
  relight: "Relight",
  retouch: "Retouch",
  upscale: "Upscale",
  cast: "Cast",
  product: "Product Studio",
  storyboard: "Storyboard",
};

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

let list = readJson(listFile, []);
const added = value("--add");
if (added) {
  const recipe = readJson(path.join(recipesDir, `${added}.json`), null);
  if (!recipe) throw new Error(`No recipe for ${added} in ${recipesDir}.`);
  const name = value("--as") || slug(`${TOOLS[recipe.tool] ?? recipe.tool}-${recipe.steps[recipe.main]?.name ?? recipe.modelName ?? ""}`);
  list = [...list.filter((r) => r.id !== added && r.name !== name), { id: added, name }];
  fs.writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
}

/** Free text in a graph, for --redact: what it is instead of what it says. */
const TEXT_KEYS = new Set(["text", "prompt", "positive", "negative", "system_prompt", "caption", "string", "value"]);
function redact(graph) {
  const out = structuredClone(graph);
  for (const node of Object.values(out)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (typeof v === "string" && TEXT_KEYS.has(k) && v.length > 24 && /\s/.test(v)) node.inputs[k] = `(set by Crackio: ${k})`;
    }
  }
  return out;
}

/** The files a graph loads, by kind, and its LoRAs. */
function filesOf(graph) {
  const models = new Set();
  const encoders = new Set();
  const loras = [];
  for (const node of Object.values(graph)) {
    const i = node.inputs ?? {};
    for (const k of ["unet_name", "ckpt_name", "model_name"]) if (typeof i[k] === "string") models.add(i[k]);
    for (const k of ["clip_name", "clip_name1", "clip_name2", "clip_name3", "vae_name"]) if (typeof i[k] === "string") encoders.add(i[k]);
    if (typeof i.lora_name === "string") loras.push(`${i.lora_name} × ${i.strength_model ?? i.strength ?? 1}`);
  }
  return { models: [...models], encoders: [...encoders], loras };
}

const seconds = (ms) => (ms ? (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`) : "");

fs.mkdirSync(outDir, { recursive: true });
const keep = new Set();
const rows = [];
for (const entry of list) {
  const recipe = readJson(path.join(recipesDir, `${entry.id}.json`), null);
  if (!recipe) {
    console.warn(`skip ${entry.name}: no recipe ${entry.id} here`);
    // Files written from it before stay.
    for (const f of fs.readdirSync(outDir)) if (f.startsWith(`${entry.name}.`) || f.startsWith(`${entry.name}--`)) keep.add(f);
    continue;
  }
  const steps = recipe.steps.filter((s) => s.status === "done" && (s.graph || s.request));
  steps.forEach((step, n) => {
    const many = steps.length > 1;
    const base = many ? `${entry.name}--${n + 1}-${slug(step.name)}` : entry.name;
    const file = `${base}.${step.graph ? "api" : "request"}.json`;
    const body = step.graph ? (flag("--redact") ? redact(step.graph) : step.graph) : { endpoint: step.endpoint, request: step.request };
    fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(body, null, 2)}\n`);
    keep.add(file);
    const f = step.graph ? filesOf(step.graph) : { models: [step.endpoint], encoders: [], loras: [] };
    rows.push({
      tool: TOOLS[recipe.tool] ?? recipe.tool,
      // runs.json can name a step better than the engine did ("labels", one per step; "label" for a one-step take).
      step: many ? `${n + 1}. ${entry.labels?.[n] ?? step.name}` : (entry.label ?? step.name),
      file,
      nodes: step.graph ? Object.keys(step.graph).length : 0,
      models: [...f.models, ...f.loras.map((l) => `LoRA ${l}`)],
      encoders: f.encoders,
      custom: [...new Set((step.custom ?? []).map((c) => c.pack))],
      ran: [step.machine?.gpu ?? step.machine?.label, seconds(step.ms ?? step.wallMs)].filter(Boolean).join(", "),
    });
  });
}
// Files of takes no longer listed go.
for (const f of fs.readdirSync(outDir)) if (f.endsWith(".json") && !keep.has(f)) fs.rmSync(path.join(outDir, f));

const code = (s) => `\`${s}\``;
const table = [
  "| Tool | Step | File | Models and LoRAs | Text encoders, VAE | Custom node packs | Ran on |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) =>
    [
      r.tool,
      r.step,
      `[${r.file}](runs/${r.file})${r.nodes ? ` (${r.nodes} nodes)` : ""}`,
      r.models.map(code).join("<br>") || "–",
      r.encoders.map(code).join("<br>") || "–",
      r.custom.join(", ") || "core only",
      r.ran || "–",
    ].join(" | "),
  ).map((line) => `| ${line} |`),
].join("\n");

const START = "<!-- runs:start (written by scripts/comfy/export-workflows.mjs) -->";
const END = "<!-- runs:end -->";
const text = fs.readFileSync(readme, "utf8");
const block = `${START}\n${table}\n${END}`;
const next = text.includes(START) ? text.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}`), block) : `${text.trimEnd()}\n\n${block}\n`;
fs.writeFileSync(readme, next);
console.log(`${rows.length} graphs from ${list.length} takes → workflows/runs/, table in workflows/README.md`);
