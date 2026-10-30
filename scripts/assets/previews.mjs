#!/usr/bin/env node
// Makes the Video tool's hover previews (camera moves, pace, aspect ratios, start/end frames)
// through a running Crackio (pnpm dev) and the plans you've connected.
// Usage: node scripts/assets/previews.mjs [id ...]      (needs Crackio on http://127.0.0.1:3210)
import { execFile } from "node:child_process";
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
const LOOK = "Photorealistic, true-to-life color, natural texture, subtle film grain. No text, no watermark, no logo.";
const FFMPEG = createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg").path;

const still = (id, aspect, prompt, extra = {}) => ({ id, aspect, prompt: `${prompt} ${LOOK}`, ...extra });
const clip = (id, from, prompt, extra = {}) => ({ id, video: true, from, prompt, ...extra });

/**
 * `from`: the start frame; `to`: an optional end frame. `copy` starts from a file instead of a
 * generation (`flop` mirrors it); `internal` keeps a still out of public/.
 */
const JOBS = [
  { id: "base-file", copy: "public/assets/video/base.webp", aspect: "1:1", internal: true },
  still("base", "1:1", "A young woman in a white linen dress standing still in a golden wheat field at sunset, looking toward the horizon, wind gently moving her hair and the wheat, distant soft hills, warm backlight, cinematic 35mm."),
  clip("cam-static", "base", "Locked-off tripod shot: the camera does not move at all. Only the wind moves her hair, her dress and the wheat."),
  clip("cam-push", "base", "The camera slowly pushes in toward her, steady and smooth, ending on a medium close-up."),
  clip("cam-pull", "base", "The camera slowly pulls back, revealing more of the golden field and the hills around her."),
  clip("cam-orbit-l", "base", "The camera orbits smoothly to the left around her in a half circle, keeping her centered."),
  // Video models swing toward the sun in this frame whatever the prompt says, so the right orbit
  // starts from the frame mirrored (sun on the left), where turning toward the sun is a right orbit.
  { id: "base-flop", copy: "public/assets/video/base.webp", aspect: "1:1", internal: true, flop: true },
  clip("cam-orbit-r", "base-flop", "The camera orbits smoothly to the right around her in a half circle, keeping her centered. She stays still; only the wind moves her hair and the wheat."),
  clip("cam-pan", "base", "The camera pans slowly from left to right across the field, passing her."),
  clip("cam-tilt", "base", "The camera tilts up slowly from the wheat at her feet to her face and the sky."),
  clip("cam-crane", "base", "The camera cranes up smoothly, rising high above her to reveal the whole field."),
  clip("cam-handheld", "base", "Handheld camera following her with subtle natural shake, documentary feel."),
  clip("cam-dolly-zoom", "base", "A dolly zoom vertigo effect: the camera moves back while zooming in, so she stays the same size while the background stretches away."),
  {
    id: "fpv-start",
    aspect: "1:1",
    from: "base-file",
    internal: true,
    prompt: `Pull the camera far back: the same woman in the same white linen dress stands still in the same golden wheat field at sunset, now seen from about fifteen meters behind her at shoulder height. She is small in the frame, just right of center, the low sun on the horizon ahead of her, rolling hills and a wide valley beyond, a long stretch of open wheat between the camera and her. Same light, colors and season. ${LOOK}`,
  },
  clip(
    "cam-fpv",
    "fpv-start",
    "FPV drone fly-through: the camera glides forward fast and low over the wheat toward her, passes close over her right shoulder, and keeps flying forward out over the field toward the setting sun, revealing the wide valley and hills ahead. She stays standing still in place the whole time; only her hair and dress move in the wind. One smooth continuous forward flight, no cuts.",
  ),
  // POV: the same field and sunset, seen through her own eyes (her hands in front of her, never her face).
  {
    id: "pov-start",
    aspect: "1:1",
    from: "base-file",
    internal: true,
    prompt: `Re-shoot this exact scene from inside the woman's own eyes: a first-person point-of-view shot at her eye height. We see what she sees: the same golden wheat field stretching ahead toward the same valley, rolling hills and the low sun on the horizon. Her own bare forearms and hands reach forward into the lower part of the frame, fingertips lightly brushing the tops of the wheat, and a few strands of her long brown hair drift in at one edge. Her face and body are never seen from outside. Same sunset light, colors and season. ${LOOK}`,
  },
  clip(
    "cam-pov",
    "pov-start",
    "First-person POV: the camera is the woman's own eyes. She walks slowly forward through the wheat toward the setting sun, her hands in the foreground brushing the tops of the wheat as she goes, with the gentle, natural sway and step rhythm of a real person walking; strands of her hair blow across the edge of the view. One continuous take, no cuts, never showing her from outside.",
  ),
  clip("pace-subtle", "base", "Very gentle, minimal motion: the camera stays nearly still; her hair and the wheat sway softly in a light breeze."),
  clip("pace-natural", "base", "Natural motion at real-life pace: she turns her head toward the camera and smiles as the wind moves the wheat."),
  clip("pace-dynamic", "base", "Energetic, dynamic motion: a strong gust whips her hair and dress, she spins around laughing, and the camera moves quickly around her."),
  still("wide", "16:9", "A lone hiker woman in a red jacket standing on a rocky ridge above a sea of clouds at sunrise, layered mountains in the distance, epic wide landscape."),
  still("tall", "9:16", "A woman in a beige trench coat walking toward the camera down a narrow rainy Paris street at blue hour, warm shop windows, reflections on wet cobblestones."),
  still("square", "1:1", "A ginger cat sitting on a sunlit windowsill between potted plants, looking outside, dust motes floating in the warm light."),
  clip("aspect-wide", "wide", "A slow, steady cinematic push forward over the ridge as the clouds drift below and the sun rises."),
  clip("aspect-tall", "tall", "She walks toward the camera through the rain with a gentle tracking shot; raindrops fall and the reflections shimmer."),
  clip("aspect-square", "square", "The cat slowly turns its head toward the camera and blinks, its tail flicks, and the sunbeam shimmers with dust."),
  { id: "frames-start", copy: "public/assets/video/frames-start.webp", aspect: "4:5", internal: true },
  { id: "frames-end", from: "frames-start", aspect: "4:5", prompt: "The same woman in the same café seat now turned toward the camera with a warm smile, lifting her cup slightly. Same face, hair, sweater, cup, table, window and light." },
  clip("frames-clip", "frames-start", "She slowly turns from the window toward the camera and smiles, lifting her cup.", { to: "frames-end" }),
];

const only = new Set(process.argv.slice(2));
const outDir = path.join(root, "public", "assets", "video");
await fs.mkdir(outDir, { recursive: true });
const made = [];

async function api(route, init) {
  const res = await fetch(`${BASE}${route}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function upload(data, name) {
  const body = new FormData();
  body.append("file", new Blob([data], { type: "image/png" }), name);
  const res = await fetch(`${BASE}/api/uploads`, { method: "POST", body });
  return (await res.json()).items[0].url;
}

// Hover previews stay small: re-encoded without sound at a modest bitrate.
const run$ = promisify(execFile);
const encode = (src, dest) => run$(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", dest]);

async function run(job, refs) {
  const aspect = job.aspect ?? "1:1";
  const body = {
    tool: "showcase",
    prompt: "",
    compiledPrompt: job.prompt,
    aspect,
    count: 1,
    model: job.video ? VIDEO_MODEL : IMAGE_MODEL,
    refine: false,
    references: refs.map((url, i) => ({ url, label: i === 0 ? (job.video ? "the start frame" : "the original image") : "the end frame", role: job.video ? "subject" : "edit-target" })),
    params: job.video ? { kind: "video", options: { duration: 6, resolution: "480p", sound: false } } : { kind: "image", options: { longEdge: 1536 } },
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

const done = new Map();
function produce(id) {
  if (done.has(id)) return done.get(id);
  const job = JOBS.find((j) => j.id === id);
  const p = (async () => {
    if (job.copy) {
      const img = sharp(path.join(root, job.copy));
      const data = await (job.flop ? img.flop() : img).png().toBuffer();
      if (!job.internal) await sharp(data).webp({ quality: 84 }).toFile(path.join(outDir, `${job.id}.webp`));
      return upload(data, `${job.id}.png`);
    }
    const refs = [];
    if (job.from) refs.push(await produce(job.from));
    if (job.to) refs.push(await produce(job.to));
    const started = Date.now();
    const url = await run({ ...job, aspect: job.aspect ?? JOBS.find((j) => j.id === job.from)?.aspect }, refs);
    const file = path.join(root, "data", "media", path.basename(url));
    const dest = path.join(outDir, `${job.id}.mp4`);
    if (job.video) await encode(file, dest);
    else if (!job.internal) await sharp(file).resize({ width: 1024, height: 1024, fit: "inside" }).webp({ quality: 84 }).toFile(path.join(outDir, `${job.id}.webp`));
    console.log(`done ${job.id} in ${Math.round((Date.now() - started) / 1000)}s`);
    return url;
  })();
  done.set(id, p);
  return p;
}

const wanted = JOBS.filter((j) => !only.size || only.has(j.id));
const results = await Promise.allSettled(wanted.map((j) => produce(j.id)));
for (const [i, r] of results.entries()) if (r.status === "rejected") console.log(`FAILED ${wanted[i].id}: ${r.reason?.message ?? r.reason}`);
for (const id of made) await fetch(`${BASE}/api/generations/${id}`, { method: "DELETE" }).catch(() => {});
console.log("all finished");
