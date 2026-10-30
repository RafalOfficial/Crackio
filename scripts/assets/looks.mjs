#!/usr/bin/env node
// Draws the hover previews for Storyboard's looks: one sample scene in every look, from exactly the
// look prompts Storyboard uses (src/lib/storyboard/looks.json), through a running Crackio.
// Usage: node scripts/assets/looks.mjs [look-id ...]      (needs Crackio on http://127.0.0.1:3210)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const MODEL = process.env.IMAGE_MODEL ?? "codex:gpt-image-2";
const { looks } = JSON.parse(await fs.readFile(path.join(root, "src/lib/storyboard/looks.json"), "utf8"));
const outDir = path.join(root, "public/assets/storyboard");
await fs.mkdir(outDir, { recursive: true });

const only = new Set(process.argv.slice(2));
const made = [];

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function draw(look) {
  const body = {
    tool: "showcase",
    prompt: "",
    compiledPrompt: `${look.prompt}. ${look.preview} No text, no watermark.`,
    aspect: "3:2",
    count: 1,
    model: MODEL,
    refine: false,
    references: [],
    params: { kind: "image", options: { longEdge: 1536 } },
  };
  const { item } = await api("/api/generations", { method: "POST", body: JSON.stringify(body) });
  made.push(item.id);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const g = (await api(`/api/generations?ids=${item.id}`)).items[0];
    if (g.status === "error") throw new Error(`${look.id}: ${g.error}`);
    if (g.status !== "done") continue;
    const file = path.join(root, "data/media", path.basename(g.outputs[0].url));
    await sharp(file).resize({ width: 640 }).webp({ quality: 80 }).toFile(path.join(outDir, `look-${look.id}.webp`));
    console.log(`done ${look.id}`);
    return;
  }
}

const wanted = looks.filter((l) => !only.size || only.has(l.id));
const results = await Promise.allSettled(wanted.map(draw));
for (const [i, r] of results.entries()) if (r.status === "rejected") console.log(`FAILED ${wanted[i].id}: ${r.reason?.message ?? r.reason}`);
for (const id of made) await fetch(`${BASE}/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
console.log("all finished");
