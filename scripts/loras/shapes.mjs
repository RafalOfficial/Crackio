/**
 * Makes src/lib/local/lora-shapes.json: for every model with LoRA picks (lora-catalog.json), the layers those LoRAs
 * change, as lib/local/lora-file names them. Crackio compares a LoRA you upload against it, to say when the file was
 * made for another model. Reads each pick's safetensors header from Hugging Face (two small range requests a file).
 *
 *   node scripts/loras/shapes.mjs [--extra <model id>=<local .safetensors>]...
 *
 * `--extra` adds a file on this computer to a model (a LoRA Crackio's own trainer made: it changes more layers than
 * most). A gated repo needs HF_TOKEN.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookAtLora } from "../../src/lib/local/lora-file.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await fs.readFile(path.join(root, "src/lib/local/lora-catalog.json"), "utf8"));
const out = path.join(root, "src/lib/local/lora-shapes.json");
const token = process.env.HF_TOKEN ?? "";

async function remoteHeader(repo, revision, file) {
  const url = `https://huggingface.co/${repo}/resolve/${revision ?? "main"}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { "User-Agent": "crackio", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const head = await fetch(url, { headers: { ...headers, Range: "bytes=0-7" }, signal: AbortSignal.timeout(30_000) });
  if (!head.ok) throw new Error(`HTTP ${head.status}`);
  const size = Number(Buffer.from(await head.arrayBuffer()).readBigUInt64LE(0));
  if (!size || size > 100 * 1024 ** 2) throw new Error("no safetensors header");
  const body = await fetch(url, { headers: { ...headers, Range: `bytes=8-${8 + size - 1}` }, signal: AbortSignal.timeout(60_000) });
  if (!body.ok) throw new Error(`HTTP ${body.status}`);
  return JSON.parse(Buffer.from(await body.arrayBuffer()).toString("utf8"));
}

async function localHeader(file) {
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(8);
    await handle.read(head, 0, 8, 0);
    const size = Number(head.readBigUInt64LE(0));
    const body = Buffer.alloc(size);
    await handle.read(body, 0, size, 8);
    return JSON.parse(body.toString("utf8"));
  } finally {
    await handle.close();
  }
}

const models = new Map();
const depths = new Map();
const add = (ids, look) => {
  for (const id of ids) {
    const set = models.get(id) ?? new Set();
    for (const v of look.vocab) set.add(v);
    models.set(id, set);
    const depth = depths.get(id) ?? {};
    for (const [block, reach] of Object.entries(look.depth)) depth[block] = Math.max(depth[block] ?? 0, reach);
    depths.set(id, depth);
  }
};

const jobs = catalog.entries.flatMap((e) => e.files.map((f) => ({ e, f })));
let done = 0;
let failed = 0;
async function worker() {
  for (;;) {
    const job = jobs.shift();
    if (!job) return;
    try {
      const look = lookAtLora(await remoteHeader(job.e.repo, job.e.revision, job.f.path));
      if (look.layers) add(job.e.models, look);
      else console.warn(`no model layers: ${job.e.repo}/${job.f.path}`);
    } catch (err) {
      failed++;
      console.warn(`skipped ${job.e.repo}/${job.f.path}: ${err.message}`);
    }
    if (++done % 20 === 0) console.log(`${done} read`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--extra") continue;
  const [id, file] = (args[++i] ?? "").split(/=(.*)/s);
  const look = lookAtLora(await localHeader(file));
  add([id], look);
  console.log(`extra for ${id}: ${look.layers} layers`);
}

const sorted = Object.fromEntries([...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, set]) => [id, [...set].sort()]));
const depth = Object.fromEntries(Object.keys(sorted).map((id) => [id, Object.fromEntries(Object.entries(depths.get(id)).sort(([a], [b]) => a.localeCompare(b)))]));
await fs.writeFile(out, `${JSON.stringify({ made: new Date().toISOString().slice(0, 10), models: sorted, depth })}\n`);
console.log(`${Object.keys(sorted).length} models, ${done} files read, ${failed} skipped -> ${path.relative(root, out)}`);
for (const [id, list] of Object.entries(sorted)) console.log(`  ${id}: ${list.length} layer kinds`);
