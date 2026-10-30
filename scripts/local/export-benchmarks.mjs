// Turns measured runs (data/local-speeds.json: ComfyUI's own seconds per job, filed by GPU and model) into the
// benchmarks Crackio ships (src/lib/local/benchmarks.ts), the base every machine's estimates start from. Published timings
// of the models Crackio didn't run (scripts/local/reported-times.json: each with its source, converted to the job Crackio's
// template runs) join them as "reported" rows, which count for less.
//   node scripts/local/export-benchmarks.mjs [speeds.json]
// Only GPUs listed in MACHINES are exported: what each ran on (memory, OS, PyTorch build) decides how its times carry
// over to other cards. Add a machine there after measuring a new card.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const SPEEDS = process.argv[2] ?? path.join(ROOT, "data/local-speeds.json");
const OUT = path.join(ROOT, "src/lib/local/benchmarks.ts");

/**
 * The machines measured through Crackio, Oct 2026: rented vast.ai boxes (Linux, the official ComfyUI template), the
 * maintainer's Windows PC. `cu13From`: the moment its PyTorch became the CUDA 13 build (ComfyUI's int8/fp8 kernels on).
 */
const MACHINES = {
  "NVIDIA GeForce RTX 5090": { vram: 32, os: "linux", build: "cu13" },
  "NVIDIA GeForce RTX 5070 Ti": { vram: 16, os: "linux", build: "cu12" },
  "NVIDIA GeForce RTX 4070": { vram: 12, os: "linux", build: "cu13" },
  "NVIDIA GeForce RTX 5060 Ti": { vram: 16, os: "linux", build: "cu13" },
  "NVIDIA GeForce RTX 4060 Ti": { vram: 16, os: "linux", build: "cu12", cu13From: "2026-10-24T19:50:00Z" },
  "NVIDIA GeForce RTX 3060 Ti": { vram: 8, os: "linux", build: "cu13" },
  "NVIDIA GeForce RTX 2080 Ti": { vram: 11, os: "linux", build: "cu13" },
  "NVIDIA GeForce GTX 1080 Ti": { vram: 11, os: "linux", build: "cu12" },
  "NVIDIA GeForce GTX 1060 6GB": { vram: 6, os: "windows", build: "cu12" },
};
/** Upscales recorded before their work counted the picture's size (2026-10-24 21:14 UTC) were the 640×424 test picture made 2×. */
const SIZED_FROM = Date.parse("2026-10-24T21:14:00Z");
const TEST_PICTURE_UNITS = 1.085;
/** A run's kind before kinds were kept: the model's main job. */
const MAIN = (key) => (/realesrgan|nomos|seedvr2|flashvsr/.test(key) ? "upscale" : /wan|ltx|scail|video|hunyuan/.test(key) ? "clip" : "t2i");
/**
 * The size of job each kind is summed up at (local/work: the Local page's job): a 1 MP picture, an edit with one 1 MP
 * reference (2^1.3 units), 5 s of 720p, a 1 MP picture made 2× (4 units). A job has a part that doesn't grow with its
 * size (reading the prompt, the decoder, saving), so its seconds per unit fall as it grows: on a GTX 1060 FLUX.2 klein
 * took 31 s for a Draft picture (0.26 units) and 65 s for 1 MP. Runs within ×1.7 of that size make the row when there
 * are any.
 */
const SIZE_OF = { t2i: 1, edit: 2.46, clip: 1, upscale: 4 };
const nearSize = (mode, u) => Math.abs(Math.log(u / (SIZE_OF[mode] ?? 1))) <= Math.log(1.7);

const speeds = JSON.parse(fs.readFileSync(SPEEDS, "utf8"));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const r2 = (n) => Math.round(n * 100) / 100;
const rows = [];
for (const [gpu, byModel] of Object.entries(speeds)) {
  const m = MACHINES[gpu];
  if (!m) continue;
  for (const [model, e] of Object.entries(byModel)) {
    // A record that didn't say which version ran can't be told apart.
    if (!e.variant) continue;
    const groups = new Map();
    for (const r of e.runs ?? []) {
      const at = r.at ?? 0;
      const build = m.cu13From && at >= Date.parse(m.cu13From) ? "cu13" : m.build;
      const mode = r.mode ?? MAIN(model);
      let u = r.u;
      if (mode === "upscale" && (!at || at < SIZED_FROM) && r.u === 1) {
        // The Windows PC upscaled its own pictures, of sizes nobody kept.
        if (m.os === "windows") continue;
        u = TEST_PICTURE_UNITS;
      }
      const key = `${mode}|${build}`;
      const g = groups.get(key) ?? { mode, build, warm: [], cold: [], units: [], at: 0 };
      (r.warm ? g.warm : g.cold).push({ s: r.s, u });
      g.units.push(u);
      g.at = Math.max(g.at, at);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      // The runs of the size the row stands for, when there are any (see SIZE_OF).
      const near = [...g.warm, ...g.cold].some((r) => nearSize(g.mode, r.u));
      if (near) {
        g.warm = g.warm.filter((r) => nearSize(g.mode, r.u));
        g.cold = g.cold.filter((r) => nearSize(g.mode, r.u));
        g.units = [...g.warm, ...g.cold].map((r) => r.u);
      }
      const warm = median(g.warm.map((r) => r.s / r.u));
      const cold = median(g.cold.map((r) => r.s / r.u));
      // What loading added: a first run's time less its work at the loaded pace.
      const load = warm !== null && g.cold.length ? Math.max(0, median(g.cold.map((r) => r.s - warm * r.u))) : null;
      rows.push({
        gpu: gpu.replace(/^NVIDIA GeForce /, "").replace(/ 6GB$/, ""),
        vram: m.vram,
        os: m.os,
        build: g.build,
        model,
        variant: e.variant,
        mode: g.mode,
        ...(warm !== null ? { warm: r2(warm) } : {}),
        ...(cold !== null ? { cold: r2(cold) } : {}),
        ...(load !== null ? { load: Math.round(load * 10) / 10 } : {}),
        units: r2(median(g.units)),
        runs: g.warm.length + g.cold.length,
        date: g.at ? new Date(g.at).toISOString().slice(0, 10) : "2026-10",
      });
    }
  }
}
const REPORTED = path.join(ROOT, "scripts/local/reported-times.json");
if (fs.existsSync(REPORTED)) {
  // Their quotes and original settings stay in the JSON, for anyone checking a number against its source.
  for (const r of JSON.parse(fs.readFileSync(REPORTED, "utf8"))) {
    const row = { ...r };
    delete row.quote;
    delete row.reported;
    rows.push(row);
  }
}
rows.sort((a, b) => a.model.localeCompare(b.model) || (a.source ?? "").localeCompare(b.source ?? "") || a.gpu.localeCompare(b.gpu) || a.mode.localeCompare(b.mode));

const body = rows.map((r) => `  { ${Object.entries(r).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} },`).join("\n");
fs.writeFileSync(
  OUT,
  `import type { SpeedMode } from "./work";

/**
 * Runs measured through Crackio on real cards (scripts/local/export-benchmarks.mjs writes this file from them): ComfyUI's
 * own seconds per unit of work (local/work), \`warm\` with the model loaded, \`cold\` a first run (loading in it), \`load\`
 * what loading added. \`build\`: PyTorch's CUDA 12 or 13 build (ComfyUI's int8/fp8 kernels need 13). \`units\`: the size
 * of the jobs that ran. Every estimate starts here: the same card's numbers, else its series', else every card that ran
 * the model, scaled by the cards' speed (local/estimate).
 */
export type Benchmark = {
  gpu: string;
  vram: number;
  os: "linux" | "windows" | "macos";
  build: "cu12" | "cu13";
  model: string;
  variant: string;
  mode: SpeedMode;
  warm?: number;
  cold?: number;
  load?: number;
  units: number;
  runs: number;
  date: string;
  /** A published timing (scripts/local/reported-times.json), converted to Crackio's job, and how sure its source is. */
  source?: "reported";
  confidence?: "high" | "medium" | "low";
  ref?: string;
};

export const BENCHMARKS: Benchmark[] = [
${body}
];
`,
);
console.log(`${rows.filter((r) => !r.source).length} measured and ${rows.filter((r) => r.source).length} reported benchmarks from ${new Set(rows.map((r) => r.gpu)).size} GPUs → ${path.relative(ROOT, OUT)}`);
