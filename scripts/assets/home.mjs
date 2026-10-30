#!/usr/bin/env node
// Makes the home page's imagery through a running Crackio (pnpm dev) and the plans you've connected:
// the hero backdrops (hero.json), the "Prompts that worked" gallery (examples.json, each made from
// exactly the prompt shown with it) and the Video card's still and clip.
// Usage: node scripts/assets/home.mjs [id ...] [--force]      (needs Crackio on http://127.0.0.1:3210)
// Without ids it makes whatever is missing; --force remakes everything it would touch.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "codex:gpt-image-2";
const VIDEO_MODEL = process.env.VIDEO_MODEL ?? "grok:grok-imagine-video-1.5";
const FFMPEG = createRequire(import.meta.url)("ffmpeg-static");
const read = async (name) => JSON.parse(await fs.readFile(path.join(here, name), "utf8"));

const assets = path.join(root, "public", "assets");
const { backdrops } = await read("hero.json");
const { examples } = await read("examples.json");

/** out: the file in public/; long: its long edge. */
const JOBS = [
  ...backdrops.map((b) => ({ id: b.id, aspect: "3:2", longEdge: 2560, prompt: b.prompt, out: path.join(assets, "hero", `${b.id}.webp`), long: 2560, quality: 80 })),
  ...examples.map((e) => ({ id: e.id, aspect: e.aspect, longEdge: 2048, prompt: e.prompt, out: path.join(assets, `${e.id}.webp`), long: 1600, quality: 84 })),
  {
    id: "feature-video",
    aspect: "16:9",
    longEdge: 1920,
    out: path.join(assets, "feature-video.webp"),
    long: 1920,
    quality: 82,
    prompt:
      "Cinematic tracking shot of a single cyclist riding through an empty, rain-wet city street at blue hour, the camera moving alongside at the same speed: the rider is sharp while the background melts into soft horizontal streaks of warm streetlight and cool shop glow. No cars and no crowds; a clean, calm composition with the rider slightly left of center and open space ahead. 35mm anamorphic lens, natural color, gentle film grain, unretouched. No readable signs, no text.",
  },
  {
    id: "feature-video-clip",
    video: true,
    from: "feature-video",
    aspect: "16:9",
    out: path.join(assets, "feature-video.mp4"),
    prompt:
      "The camera tracks smoothly alongside the cyclist at the same speed as they ride steadily through the wet street; the background streams past in soft streaks of light, the wheels turn and the wet road shimmers. One calm, continuous shot with no cuts.",
  },
];

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = new Set(args.filter((a) => !a.startsWith("--")));
const wanted = JOBS.filter((j) => (only.size ? only.has(j.id) : force || !existsSync(j.out)));
const made = [];

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function upload(file) {
  const body = new FormData();
  body.append("file", new Blob([await sharp(file).png().toBuffer()], { type: "image/png" }), `${path.basename(file, path.extname(file))}.png`);
  const res = await fetch(`${BASE}/api/uploads`, { method: "POST", body });
  return (await res.json()).items[0].url;
}

async function generate(job, startUrl) {
  const body = {
    tool: "showcase",
    prompt: "",
    compiledPrompt: job.prompt,
    aspect: job.aspect,
    count: 1,
    model: job.video ? VIDEO_MODEL : IMAGE_MODEL,
    refine: false,
    references: startUrl ? [{ url: startUrl, label: "the start frame", role: "subject" }] : [],
    params: job.video
      ? { kind: "video", options: { duration: 6, resolution: "720p", sound: false }, startUrl }
      : { kind: "image", options: { longEdge: job.longEdge } },
  };
  const { item } = await api("/api/generations", { method: "POST", body: JSON.stringify(body) });
  made.push(item.id);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { items } = await api(`/api/generations?ids=${item.id}`);
    const g = items[0];
    if (g.status === "done") return g.outputs[0].url;
    if (g.status === "error") throw new Error(`${job.id}: ${g.error} ${g.stage ?? ""}`);
  }
}

// Cards stay light: re-encoded without sound, 960 wide, at a modest bitrate.
const run$ = promisify(execFile);
const encode = (src, dest) =>
  run$(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "25", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", dest]);

const done = new Map();
function produce(job) {
  if (done.has(job.id)) return done.get(job.id);
  const p = (async () => {
    let startUrl;
    if (job.from) {
      const parent = JOBS.find((j) => j.id === job.from);
      startUrl = wanted.includes(parent) ? await produce(parent) : await upload(parent.out);
    }
    const started = Date.now();
    const url = await generate(job, startUrl);
    const file = path.join(root, "data", "media", path.basename(url));
    await fs.mkdir(path.dirname(job.out), { recursive: true });
    if (job.video) await encode(file, job.out);
    else await sharp(file).resize({ width: job.long, height: job.long, fit: "inside", withoutEnlargement: true }).webp({ quality: job.quality, effort: 5 }).toFile(job.out);
    console.log(`done ${job.id} in ${Math.round((Date.now() - started) / 1000)}s`);
    return url;
  })();
  done.set(job.id, p);
  return p;
}

console.log(`making ${wanted.length}: ${wanted.map((j) => j.id).join(", ")}`);
const results = await Promise.allSettled(wanted.map(produce));
for (const [i, r] of results.entries()) if (r.status === "rejected") console.log(`FAILED ${wanted[i].id}: ${r.reason?.message ?? r.reason}`);
for (const id of made) await fetch(`${BASE}/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
console.log("all finished");
