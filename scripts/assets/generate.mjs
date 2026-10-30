#!/usr/bin/env node
// Generates Crackio's own site imagery with the Codex CLI's built-in image tool.
// Usage: node scripts/assets/generate.mjs [asset-id ...] [--force]
// Originals land in assets-src/ (gitignored); optimized WebP copies go to public/assets/.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const manifest = JSON.parse(await fs.readFile(path.join(here, "manifest.json"), "utf8"));
const srcDir = path.join(root, "assets-src");
const outDir = path.join(root, "public", "assets");
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const concurrency = Number(process.env.CONCURRENCY ?? 4);

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = new Set(args.filter((a) => !a.startsWith("--")));
const queue = manifest.assets.filter((a) => only.size === 0 || only.has(a.id));

await fs.mkdir(srcDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

const maxWidth = (id) =>
  id.startsWith("feature-") ? 1920 : id.startsWith("stage-") ? 1400 : id.startsWith("vocab-") ? 480 : 1200;

function buildPrompt(asset) {
  return [
    "Generate exactly one image with your built-in image generation tool, then stop.",
    "Do not read any files, do not run shell commands, do not ask questions.",
    "",
    `Image prompt: ${asset.prompt} ${manifest.style}`,
    `Aspect ratio: ${asset.aspect}.`,
    asset.transparent
      ? "Background: fully transparent (real alpha channel), subject cleanly isolated."
      : "",
    "",
    "When the image is done, reply with the single word: done",
  ].join("\n");
}

function runCodex(asset) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--json", "-"],
      { shell: true, cwd: srcDir, windowsHide: true },
    );
    let threadId = null;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === "thread.started") threadId = evt.thread_id;
        } catch {
          /* ignore non-JSON lines */
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (!threadId) return reject(new Error(`codex exited ${code} without a thread id`));
      resolve(threadId);
    });
    child.stdin.end(buildPrompt(asset));
  });
}

async function newestPng(threadId) {
  const dir = path.join(codexHome, "generated_images", threadId);
  if (!existsSync(dir)) return null;
  const files = await Promise.all(
    (await fs.readdir(dir))
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .map(async (f) => ({ f: path.join(dir, f), t: (await fs.stat(path.join(dir, f))).mtimeMs })),
  );
  files.sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

async function optimize(asset) {
  const src = path.join(srcDir, `${asset.id}.png`);
  const dest = path.join(outDir, `${asset.id}.webp`);
  const img = sharp(src);
  const meta = await img.metadata();
  await img
    .resize({ width: Math.min(meta.width ?? 1920, maxWidth(asset.id)), withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90, effort: 5 })
    .toFile(dest);
  return { dest, width: meta.width, height: meta.height };
}

async function processAsset(asset) {
  const src = path.join(srcDir, `${asset.id}.png`);
  if (!force && existsSync(src)) {
    await optimize(asset);
    console.log(`skip  ${asset.id} (exists, re-optimized)`);
    return;
  }
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const threadId = await runCodex(asset);
      const png = await newestPng(threadId);
      if (!png) throw new Error("no image produced");
      await fs.copyFile(png, src);
      const { width, height } = await optimize(asset);
      console.log(`done  ${asset.id} ${width}x${height} in ${Math.round((Date.now() - started) / 1000)}s`);
      return;
    } catch (err) {
      console.log(`retry ${asset.id} (attempt ${attempt}): ${err.message}`);
    }
  }
  console.log(`FAIL  ${asset.id}`);
}

const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await processAsset(queue.shift());
});
await Promise.all(workers);
console.log("all assets processed");
