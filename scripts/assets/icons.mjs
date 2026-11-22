#!/usr/bin/env node
// Makes the app icons' white glyphs (sidebar, tool marks) from scripts/assets/icons.json: takes each
// glyph's drawing (a PNG with a transparent background, made with any image model from the icon's
// `subject` and the file's `style`), traces it to a clean vector, evens out its optical size, and renders
//   assets-src/icons/<id>@4k.png  4096px transparent master   (gitignored, like other originals)
//   assets-src/icons/<id>.svg     the traced vector
//   public/icons/<id>.png         256px image the app shows (used as a CSS mask, see .app-icon)
//
// Usage: node scripts/assets/icons.mjs [id ...]
//   Reads the drawings in assets-src/icons/raw/<id>-<n>.png (n = the icon's `pick`, 1 without one).
// Tracing uses `potrace` when installed (`pnpm add -D potrace`); without it, edges are rebuilt from
// the alpha channel. The drawings are small (about 1K), which is why the masters are traced rather
// than upscaled.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const spec = JSON.parse(await fs.readFile(path.join(here, "icons.json"), "utf8"));
const rawDir = path.join(root, "assets-src", "icons", "raw");
const masterDir = path.join(root, "assets-src", "icons");
const uiDir = path.join(root, "public", "icons");

const MASTER = 4096;
const UI = 256;
/** Geometric mean of the glyph's box, as a share of the canvas; its longest side never passes CAP. */
const TARGET = 0.74;
const CAP = 0.86;

const args = process.argv.slice(2);
const only = new Set(args.filter((a) => !a.startsWith("--")));
const icons = spec.icons.filter((i) => only.size === 0 || only.has(i.id));

await Promise.all([rawDir, masterDir, uiDir].map((d) => fs.mkdir(d, { recursive: true })));

const potrace = await import("potrace").then((m) => m.default ?? m).catch(() => null);
if (!potrace) console.log("potrace isn't installed: rebuilding edges from the alpha channel (pnpm add -D potrace for vector tracing).");

function trace(png) {
  return new Promise((resolve, reject) => {
    const p = new potrace.Potrace();
    p.setParameters({ threshold: 128, turdSize: 4, optCurve: true, optTolerance: 0.2, alphaMax: 1, turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY, blackOnWhite: true });
    p.loadImage(png, (err) => (err ? reject(err) : resolve(/d="([^"]+)"/.exec(p.getPathTag())?.[1])));
  });
}

async function render(icon) {
  const src = path.join(rawDir, `${icon.id}-${icon.pick ?? 1}.png`);
  if (!existsSync(src)) throw new Error(`${path.relative(root, src)} is missing: put the glyph's transparent PNG there`);
  const { data: alpha, info } = await sharp(src).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (alpha[y * W + x] > 127) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const s = Math.min((TARGET * MASTER) / Math.sqrt(bw * bh), (CAP * MASTER) / Math.max(bw, bh));
  const tx = MASTER / 2 - (x0 + bw / 2) * s;
  const ty = MASTER / 2 - (y0 + bh / 2) * s;

  if (potrace) {
    const inverted = Buffer.from(alpha.map((a) => 255 - a));
    const d = await trace(await sharp(inverted, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer());
    const svg = (px) =>
      `<svg xmlns="http://www.w3.org/2000/svg"${px ? ` width="${px}" height="${px}"` : ""} viewBox="0 0 ${MASTER} ${MASTER}"><path transform="matrix(${s.toFixed(6)} 0 0 ${s.toFixed(6)} ${tx.toFixed(3)} ${ty.toFixed(3)})" fill="#FFFFFF" fill-rule="evenodd" d="${d}"/></svg>`;
    await fs.writeFile(path.join(masterDir, `${icon.id}.svg`), svg());
    await sharp(Buffer.from(svg(MASTER))).png({ compressionLevel: 9 }).toFile(path.join(masterDir, `${icon.id}@4k.png`));
    await sharp(Buffer.from(svg(UI))).png({ compressionLevel: 9 }).toFile(path.join(uiDir, `${icon.id}.png`));
  } else {
    // Scale the glyph's alpha up smoothly, then steepen it back into a crisp edge.
    const w = Math.round(bw * s);
    const h = Math.round(bh * s);
    const edge = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } })
      .extract({ left: x0, top: y0, width: bw, height: bh })
      .resize(w, h, { kernel: "lanczos3" })
      .linear(4, -384)
      .extend({ left: Math.round(tx + x0 * s), top: Math.round(ty + y0 * s), right: MASTER - w - Math.round(tx + x0 * s), bottom: MASTER - h - Math.round(ty + y0 * s), background: "#000000" })
      .toColourspace("b-w")
      .raw()
      .toBuffer();
    const master = sharp({ create: { width: MASTER, height: MASTER, channels: 3, background: "#ffffff" } }).joinChannel(edge, { raw: { width: MASTER, height: MASTER, channels: 1 } });
    await master.clone().png({ compressionLevel: 9 }).toFile(path.join(masterDir, `${icon.id}@4k.png`));
    await sharp(await master.png().toBuffer()).resize(UI, UI, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(path.join(uiDir, `${icon.id}.png`));
  }
  console.log(`done  ${icon.id}`);
}

for (const icon of icons) {
  await render(icon);
}
console.log("icons finished");
