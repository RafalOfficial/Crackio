#!/usr/bin/env node
// Records each "See it work" demo to an MP4 so it can be watched (and scrubbed) without the rail.
// Every frame is the engine's own exact render of that moment (window.__showcase.seek), so the
// video is smooth whatever the machine; it's rendered, not screen-recorded.
//
// Writes assets-src/showcase-previews/: <demo>.mp4 for each demo, all.mp4 (all of them back to
// back) and grid.mp4 (all twelve at once, each looping).
//
// Usage: node scripts/assets/showcase-record.mjs [demo ...]   (needs Crackio on http://127.0.0.1:3210)
// Env: CHROME (path to Chrome), FPS (default 30), TABS (demos recorded at once, default 3), CRACKIO_URL.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(root, "assets-src", "showcase-previews");
const BASE = process.env.CRACKIO_URL ?? "http://127.0.0.1:3210";
const FPS = Number(process.env.FPS ?? 30);
const TABS = Number(process.env.TABS ?? 3);
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ALL = ["image", "director", "retouch", "video", "relight", "cast", "angles", "motion", "product", "recast", "storyboard", "upscale"];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

await fs.mkdir(out, { recursive: true });

/** Run ffmpeg; resolves when it exits cleanly. */
function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-y", ...args], { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`))));
    if (input) input(p.stdin);
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--use-angle=d3d11"],
});
/** A tab of Home with the live rail held still and clips seeking to exact frames. */
async function tab() {
  // At this width the rail's cards are 256 × 320; twice that is what a sharp screen shows.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: "load", timeout: 180000 });
  await page.waitForFunction(() => window.__showcase && document.querySelector("[data-rail-card]"), null, { timeout: 120000 });
  await page.click('aside[data-rail] button[aria-label="Pause the tool demos"]');
  await page.evaluate(() => (window.__showcase.exact = true));
  return page;
}

const made = [];
async function record(page, name) {
  // Bring the card into view, still, on its own.
  const box = await page.evaluate(async (name) => {
    const stage = document.querySelector(`[data-demo="${name}"]`);
    const card = stage.closest("[data-rail-card]");
    document.querySelectorAll("[data-rail-card]").forEach((c) => {
      c.getAnimations().forEach((a) => a.cancel());
      c.style.transform = "translateY(-2000px)";
    });
    card.style.transform = "translateY(200px)";
    window.__showcase.seek(name, 0);
    const vids = [...stage.querySelectorAll("video")];
    vids.forEach((v) => {
      v.preload = "auto";
      v.load();
    });
    await Promise.all([...stage.querySelectorAll("img")].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 10000); }))));
    await Promise.all(vids.map((v) => (v.readyState >= 2 ? null : new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 10000); }))));
    // WebGL demos say when their pictures are on the GPU.
    for (let i = 0; i < 200 && stage.querySelector("canvas") && !stage.hasAttribute("data-ready"); i++) await new Promise((r) => setTimeout(r, 100));
    window.__showcase.seek(name, 0);
    const r = stage.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, name);
  const duration = await page.evaluate((name) => window.__showcase.list().find((d) => d.name === name)?.duration ?? 0, name);
  const frames = Math.round(duration * FPS);
  const file = path.join(out, `${name}.mp4`);
  const started = Date.now();
  await run(["-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], async (stdin) => {
    for (let i = 0; i < frames; i++) {
      const t = i / FPS;
      await page.evaluate(async ({ name, t }) => {
        window.__showcase.seek(name, t);
        // Clips seek to the exact frame; draw again once they're there (canvases copy them).
        const vids = [...document.querySelector(`[data-demo="${name}"]`).querySelectorAll("video")].filter((v) => v.seeking);
        if (vids.length) {
          await Promise.all(vids.map((v) => new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 1500); })));
          await new Promise((r) => requestAnimationFrame(() => r()));
          window.__showcase.seek(name, t);
        }
      }, { name, t });
      const png = await page.screenshot({ clip: box, type: "png" });
      if (!stdin.write(png)) await new Promise((r) => stdin.once("drain", r));
    }
    stdin.end();
  });
  made.push({ name, file, duration });
  console.log(`${name}: ${duration.toFixed(1)} s, ${frames} frames, ${Math.round((Date.now() - started) / 1000)} s to render`);
}

// A few tabs at once, each taking the next demo.
const queue = [...names];
await Promise.all(
  Array.from({ length: Math.min(TABS, names.length) }, async () => {
    const page = await tab();
    while (queue.length) await record(page, queue.shift());
    await page.close();
  }),
);
await browser.close();
made.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));

// Remember every demo's length, so the reel can be rebuilt after re-recording only some of them.
const lengths = path.join(out, "lengths.json");
const known = JSON.parse(await fs.readFile(lengths, "utf8").catch(() => "{}"));
for (const m of made) known[m.name] = m.duration;
await fs.writeFile(lengths, JSON.stringify(known, null, 1));
const all = ALL.map((name) => ({ name, file: path.join(out, `${name}.mp4`), duration: known[name] }));
const ready = await Promise.all(all.map((m) => fs.stat(m.file).then(() => !!m.duration, () => false)));
if (ready.every(Boolean)) {
  made.splice(0, made.length, ...all);
  // Back to back.
  const list = path.join(out, "all.txt");
  await fs.writeFile(list, made.map((m) => `file '${m.file.replace(/\\/g, "/")}'`).join("\n"));
  await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", path.join(out, "all.mp4")]);
  await fs.rm(list);
  // All twelve at once, four across, each looping for as long as the longest.
  const longest = Math.max(...made.map((m) => m.duration));
  const inputs = made.flatMap((m) => ["-stream_loop", "-1", "-i", m.file]);
  const tiles = made.map((_, i) => `[${i}:v]scale=256:320,setsar=1[v${i}]`).join(";");
  const layout = made.map((_, i) => `${(i % 4) * 256}_${Math.floor(i / 4) * 320}`).join("|");
  await run([...inputs, "-filter_complex", `${tiles};${made.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${made.length}:layout=${layout}:fill=black[g]`, "-map", "[g]", "-t", longest.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(out, "grid.mp4")]);
  console.log("all.mp4 and grid.mp4 written");
}
console.log(`previews in ${out}`);
