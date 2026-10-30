#!/usr/bin/env node
// Makes the Templates library's clips through a running Crackio (pnpm dev) on your Grok plan.
// Every template in scripts/assets/templates.json gets:
//   still  the opening frame (Grok Imagine 2.0 at 9:16, a few takes; `pick` is the one kept)
//   clip   that frame animated (Grok Imagine Video 1.5, with sound when the trend has it), or a
//          clip written from words alone for templates without a still
// A template's own `imageModel` / `videoModel` replaces those two (e.g. local:flux3-klein and
// local:ltx-2.5: open models on your own GPU through ComfyUI).
// A template made of `parts` (a hard cut, like the costume reveal) gets a still and a clip per part,
// joined in order by the finish step.
// Originals land in assets-src/templates/ (gitignored). `--finish` then cuts each kept clip
// (`clipPick`) to its part (`trim`), encodes it for the web and writes
//   public/assets/templates/<id>.mp4    the clip (for swaps, the base clip a remix keeps)
//   public/assets/templates/<id>.webp   its poster (the frame at `poster` seconds)
//
// Usage: node scripts/assets/templates.mjs [id ...] [--stills] [--clips] [--finish]
//   (no step flag runs all three; needs Crackio on http://127.0.0.1:3210 for stills and clips)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const IMAGE = "grok:grok-imagine-image-2.0";
const VIDEO = "grok:grok-imagine-video-1.5";
const srcDir = path.join(root, "assets-src", "templates");
const outDir = path.join(root, "public", "assets", "templates");
const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");

const spec = JSON.parse(await fs.readFile(path.join(here, "templates.json"), "utf8"));
const args = process.argv.slice(2);
const only = new Set(args.filter((a) => !a.startsWith("--")));
const steps = new Set(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));
const all = !steps.size;
const jobs = spec.templates.filter((t) => !only.size || only.has(t.id));
await Promise.all([srcDir, outDir].map((d) => fs.mkdir(d, { recursive: true })));

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, { ...init, headers: { ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function upload(file) {
  const body = new FormData();
  body.append("file", new Blob([await fs.readFile(file)], { type: file.endsWith(".mp4") ? "video/mp4" : "image/png" }), path.basename(file));
  const res = await fetch(`${BASE}/api/uploads`, { method: "POST", body });
  return (await res.json()).items[0].url;
}

const mediaPath = (url) => path.join(root, "data", "media", url.slice("/api/media/out/".length));
const exists = (f) => fs.stat(f).then(() => true, () => false);

/** Queue one generation, wait for it, copy its outputs to `names`, and remove it from the Library. */
async function generate(body, names) {
  const { item } = await api("/api/generations", { method: "POST", body: JSON.stringify({ tool: "showcase", prompt: "", refine: false, ...body }) });
  let started = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { items } = await api(`/api/generations?ids=${item.id}`).catch(() => ({ items: [] }));
    const g = items[0];
    if (g?.status === "running" && !started) started = Date.now();
    if (!g || g.status === "queued" || g.status === "running") continue;
    // Copy first: deleting the take removes its files too.
    try {
      if (g.status === "error") throw new Error(g.error);
      // How long it ran once it left the queue (to the nearest poll), for the GPU time a template costs.
      if (started) console.log(`      ${path.basename(names[0])}: ran ${Math.round((Date.now() - started) / 1000)} s`);
      for (const [i, o] of g.outputs.entries()) if (names[i]) await fs.copyFile(mediaPath(o.url), names[i]);
      return g.outputs.length;
    } finally {
      await fetch(`${BASE}/api/generations/${item.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

/** The pieces a template is generated in: itself, or each of its parts ("<id>-p1", "<id>-p2"…). */
const piecesOf = (t) => (t.parts ? t.parts.map((p, i) => ({ imageModel: t.imageModel, videoModel: t.videoModel, ...p, id: `${t.id}-p${i + 1}`, aspect: t.aspect })) : [t]);

async function stills(t) {
  for (const piece of piecesOf(t)) {
    if (!piece.still) continue;
    const takes = piece.takes ?? 2;
    const names = Array.from({ length: takes }, (_, i) => path.join(srcDir, `${piece.id}-still-${i + 1}.png`));
    if (!steps.has("stills") && (await exists(names[0]))) continue;
    await generate({ compiledPrompt: piece.still, aspect: piece.aspect ?? "9:16", count: takes, model: piece.imageModel ?? IMAGE, references: [], params: { kind: "image" } }, names);
    console.log(`still ${piece.id} (${takes})`);
  }
}

async function clips(t) {
  for (const piece of piecesOf(t)) await clip(piece);
}

async function clip(t) {
  const takes = t.clipTakes ?? 1;
  for (let n = 1; n <= takes; n++) {
    const name = path.join(srcDir, `${t.id}-clip-${n}.mp4`);
    if (!steps.has("clips") && (await exists(name))) continue;
    const still = t.still ? path.join(srcDir, `${t.id}-still-${t.pick ?? 1}.png`) : null;
    const startUrl = still ? await upload(still) : null;
    await generate(
      {
        compiledPrompt: t.motion,
        aspect: t.aspect ?? "9:16",
        count: 1,
        model: t.videoModel ?? VIDEO,
        references: startUrl ? [{ url: startUrl, label: "the start frame", role: "subject" }] : [],
        params: { kind: "video", options: { duration: t.seconds ?? 8, resolution: "720p", sound: t.sound ?? true }, ...(startUrl ? { startUrl } : {}) },
      },
      [name],
    );
    console.log(`clip  ${t.id} #${n}`);
  }
}

function run(argv) {
  const r = spawnSync(ffmpeg, ["-v", "error", "-y", ...argv]);
  if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 400));
}

async function finish(t) {
  const pieces = piecesOf(t).map((p) => ({ src: path.join(srcDir, `${p.id}-clip-${p.clipPick ?? 1}.mp4`), trim: p.trim ?? [0, p.seconds ?? 8] }));
  for (const p of pieces) if (!(await exists(p.src))) return console.log(`skip  ${t.id}: no clip yet`);
  const out = path.join(outDir, `${t.id}.mp4`);
  // 720×1280 at 24 fps, H.264 for every browser, the moov atom first so it starts playing at once.
  const fit = "scale=720:1280:force_original_aspect_ratio=increase:flags=lanczos,crop=720:1280,fps=24,setsar=1";
  // Capped at 3 Mb/s: rain and crowds stay clean, and the whole library stays light enough for the repo.
  const video = ["-c:v", "libx264", "-preset", "slow", "-crf", "23", "-maxrate", "3M", "-bufsize", "6M", "-pix_fmt", "yuv420p"];
  const audio = t.sound === false ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"];
  // `gain` (dB) lifts a soundtrack the model made too quiet to hear (LTX-2.5's road ambience peaked at -40 dB).
  const gain = t.gain && t.sound !== false ? `volume=${t.gain}dB` : null;
  if (pieces.length === 1) {
    const [from, to] = pieces[0].trim;
    run(["-ss", String(from), "-i", pieces[0].src, "-t", String(to - from), "-vf", fit, ...(gain ? ["-af", gain] : []), ...video, ...audio, "-movflags", "+faststart", out]);
  } else {
    // A hard cut between the parts, each trimmed to its own part.
    const inputs = pieces.flatMap((p) => ["-ss", String(p.trim[0]), "-t", String(p.trim[1] - p.trim[0]), "-i", p.src]);
    const chains = pieces.map((_, i) => `[${i}:v]${fit}[v${i}];[${i}:a]aresample=48000${gain ? `,${gain}` : ""}[a${i}]`).join(";");
    const joined = pieces.map((_, i) => `[v${i}][a${i}]`).join("");
    run([...inputs, "-filter_complex", `${chains};${joined}concat=n=${pieces.length}:v=1:a=1[v][a]`, "-map", "[v]", "-map", "[a]", ...video, ...audio, "-movflags", "+faststart", out]);
  }
  const frame = path.join(srcDir, `${t.id}-poster.png`);
  run(["-ss", String(t.poster ?? 0.3), "-i", out, "-frames:v", "1", frame]);
  await sharp(frame).webp({ quality: 82 }).toFile(path.join(outDir, `${t.id}.webp`));
  console.log(`done  ${t.id}`);
}

// Three at a time, like Crackio's own queue.
const queue = [...jobs];
const failures = [];
async function worker() {
  for (let t = queue.shift(); t; t = queue.shift()) {
    try {
      if (all || steps.has("stills")) await stills(t);
      if (all || steps.has("clips")) await clips(t);
      if (all || steps.has("finish")) await finish(t);
    } catch (err) {
      failures.push(t.id);
      console.log(`FAILED ${t.id}: ${err.message}`);
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(failures.length ? `finished with ${failures.length} failed: ${failures.join(", ")}` : "finished");
