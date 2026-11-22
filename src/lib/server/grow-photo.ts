import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import { urlToPath } from "./media";
import { forgetInstalled, installedFiles, pickTarget } from "./local-models";
import { withTarget, type ComfyTarget } from "./comfy-targets";
import { EngineError, type EngineJob } from "@/lib/engines/types";
import { loraFileName } from "@/lib/local/loras";
import { ASPECTS, type AspectId } from "@/lib/shot";

/**
 * Small extend (Director v2, experimental): the place's photo grown to 1.5 times its width and height
 * by FLUX 3 Image Klein with ausboss's Outpaint LoRA, a cheap step that gives the Camera more of the place to turn into
 * than the photo alone (the 360 world is the big one: minutes of GPU). The photo stays in the middle pixel for pixel; only
 * the ring around it is new. Same lens centre, so the stage keeps its set and the Camera where they are and only widens
 * the photo's field of view (lib/director/grow `grownView`).
 *
 * As the LoRA's card says: the canvas padded with flat #808080, the instruction first, the distilled model at strength
 * 1.5, 16 steps, CFG 1, about 1 MP (it was trained on 0.94 to 1.96 MP with the picture covering 45 to 93 % of it; 1.5×
 * each way leaves it 44 %), the original pasted back over the model's copy, and the new ring toned like the photo.
 */

/** How much bigger the photo grows, its width and its height each. */
export const GROW = 1.5;
/** lora-catalog `f3k-outpaint`. */
const LORA = { id: "f3k-outpaint", model: "flux3-klein", strength: 1.5 };
const TRIGGER = "Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, keeping the existing picture unchanged.";
/** The flat gray it learned to fill. */
const GRAY = { r: 128, g: 128, b: 128 };
/** The grown photo's longest side at most: a bigger photo is made smaller first. */
const MAX_EDGE = 4096;
const DIR = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "grow");

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new EngineError("Stopped."));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new EngineError("Stopped."))), { once: true });
  });

const smooth = (t: number) => {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
};

function nearestAspect(width: number, height: number): AspectId {
  const r = Math.log(width / height);
  return ASPECTS.reduce((a, b) => (Math.abs(Math.log(b.w / b.h) - r) < Math.abs(Math.log(a.w / a.h) - r) ? b : a)).id as AspectId;
}

/** The LoRA on the machine that will draw (downloaded there the first time: 161 MB), by the name its ComfyUI lists. */
async function loraOn(target: ComfyTarget, signal: AbortSignal, stage: (s: string) => void) {
  // Loaded here, not at the top: server/loras reads the model lists (a top-level import once closed a cycle).
  const { curated, installLora } = await import("./loras");
  const entry = curated().find((e) => e.id === LORA.id);
  const named = entry?.files[0] ? loraFileName(entry.repo, entry.files[0].path) : null;
  if (!entry || !named) throw new EngineError("The outpaint LoRA isn't in Crackio's library.");
  const has = async (file: string) =>
    withTarget(target, async () => {
      forgetInstalled();
      return (await installedFiles()).has(`loras/${file}`);
    });
  if (await has(named)) return named;
  stage("Getting the outpaint LoRA ready (161 MB, one time)");
  const { files } = await installLora({ model: LORA.model, id: LORA.id, targets: [target.id] });
  const file = files[0] ?? named;
  for (let i = 0; i < 100; i++) {
    await sleep(4000, signal);
    if (await has(file)) return file;
  }
  throw new EngineError("The outpaint LoRA didn't arrive on the GPU machine. Try again in a minute.");
}

/**
 * How well the model's copy of the photo lines up with the photo, on small copies (the photo 128 wide): the colour
 * match that takes the model's copy to the photo (per channel, gain and offset), the mean difference left at the photo's
 * own place, and the least found when the copy is moved up to 3 % or scaled by 3 % (a copy that slid or zoomed is
 * much nearer somewhere else; the LoRA's card: plain FLUX 3 slid or zoomed in 36 of 40 tests, with the LoRA within 2 px).
 */
export async function lineUp(out: Buffer, CW: number, CH: number, photo: Buffer, W: number, H: number, padX: number, padY: number) {
  const T = 128;
  const k = T / W;
  const tw = T;
  const th = Math.max(8, Math.round(H * k));
  const { data: b } = await sharp(photo, { raw: { width: W, height: H, channels: 3 } }).resize(tw, th, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const sw = Math.max(tw + 2, Math.round(CW * k));
  const sh = Math.max(th + 2, Math.round(CH * k));
  const { data: s } = await sharp(out, { raw: { width: CW, height: CH, channels: 3 } }).resize(sw, sh, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const ox = padX * (sw / CW);
  const oy = padY * (sh / CH);
  const at = (fx: number, fy: number, c: number) => {
    const x = Math.min(sw - 1.001, Math.max(0, fx));
    const y = Math.min(sh - 1.001, Math.max(0, fy));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const p = (xx: number, yy: number) => s[(yy * sw + xx) * 3 + c];
    return (p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty;
  };
  // The colour match, at the photo's own place.
  const gain = [1, 1, 1];
  const offset = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let ma = 0;
    let mb = 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        ma += at(ox + x, oy + y, c);
        mb += b[(y * tw + x) * 3 + c];
      }
    }
    const n = tw * th;
    ma /= n;
    mb /= n;
    let va = 0;
    let vb = 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        va += (at(ox + x, oy + y, c) - ma) ** 2;
        vb += (b[(y * tw + x) * 3 + c] - mb) ** 2;
      }
    }
    gain[c] = Math.min(1.25, Math.max(0.8, Math.sqrt(vb / Math.max(1e-6, va))));
    offset[c] = mb - gain[c] * ma;
  }
  const error = (dx: number, dy: number, scale: number) => {
    let sum = 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const fx = ox + tw / 2 + (x + 0.5 - tw / 2) * scale - 0.5 + dx;
        const fy = oy + th / 2 + (y + 0.5 - th / 2) * scale - 0.5 + dy;
        for (let c = 0; c < 3; c++) sum += Math.abs(gain[c] * at(fx, fy, c) + offset[c] - b[(y * tw + x) * 3 + c]);
      }
    }
    return sum / (tw * th * 3);
  };
  const here = error(0, 0, 1);
  let best = here;
  for (const scale of [0.97, 1, 1.03]) for (const dx of [-4, -2, 0, 2, 4]) for (const dy of [-2, -1, 0, 1, 2]) if (dx || dy || scale !== 1) best = Math.min(best, error(dx, dy, scale));
  // Slid or zoomed: much nearer elsewhere. Redrawn: far from the photo everywhere.
  const off = (here > 6 && best < 0.75 * here) || here > 16;
  return { gain, offset, here: Math.round(here * 10) / 10, best: Math.round(best * 10) / 10, off };
}

/** The new ring toned like the photo (`lineUp`'s colour match), and the photo itself back on top, its edge faded in. */
export function pasteBack(out: Buffer, CW: number, CH: number, photo: Buffer, W: number, H: number, padX: number, padY: number, fit: { gain: number[]; offset: number[] }) {
  const F = Math.max(6, Math.round(0.025 * Math.min(W, H)));
  for (let y = 0; y < CH; y++) {
    const iy = y - padY;
    for (let x = 0; x < CW; x++) {
      const o = (y * CW + x) * 3;
      const ix = x - padX;
      const inside = ix >= 0 && iy >= 0 && ix < W && iy < H;
      const k = inside ? smooth((Math.min(ix, W - 1 - ix, iy, H - 1 - iy) + 0.5) / F) : 0;
      for (let c = 0; c < 3; c++) {
        const ring = Math.min(255, Math.max(0, fit.gain[c] * out[o + c] + fit.offset[c]));
        out[o + c] = Math.round(k > 0 ? ring * (1 - k) + photo[(iy * W + ix) * 3 + c] * k : ring);
      }
    }
  }
}

/**
 * The photo at `url` grown 1.5 times each way. `words`: what the place is (the place's own words), which the LoRA reads
 * after its instruction. Returns the grown photo and how many times wider and taller it is than the photo in it.
 */
export async function growPhoto(url: string, signal: AbortSignal, opts: { words?: string; machine?: string; mp?: number; stage?: (s: string) => void } = {}) {
  const started = Date.now();
  const stage = opts.stage ?? (() => undefined);
  const file = urlToPath(url);
  if (!file) throw new EngineError("Crackio can't find the place's photo.");
  const read = await sharp(file).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (read.info.channels !== 3) throw new EngineError("That photo's colours can't be read.");
  let photo = read.data;
  let W = read.info.width;
  let H = read.info.height;
  const shrink = Math.min(1, MAX_EDGE / (Math.max(W, H) * GROW));
  if (shrink < 1) {
    const w = Math.round(W * shrink);
    const h = Math.round(H * shrink);
    photo = await sharp(photo, { raw: { width: W, height: H, channels: 3 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
    W = w;
    H = h;
  }
  const padX = Math.round((W * (GROW - 1)) / 2);
  const padY = Math.round((H * (GROW - 1)) / 2);
  const CW = W + 2 * padX;
  const CH = H + 2 * padY;

  // The canvas the model gets, as ausboss's workflow pads it: the photo in the middle, flat gray all round, about 1 MP on
  // the 32 grid (its pad node: 1 MP, steps of 32), a PNG (no JPEG speckle in the gray). The model draws it at that very
  // size (`keepReference`): at 2.4 MP, past the 0.94 to 1.96 MP it was trained on, and resized off the VAE's grid by
  // the reference node, every try on a cabin test photo came back moved (Nov 14).
  const k = Math.sqrt(((opts.mp ?? 1.05) * 1e6) / (CW * CH));
  const gw = Math.max(256, Math.round((CW * k) / 32) * 32);
  const gh = Math.max(256, Math.round((CH * k) / 32) * 32);
  await fs.mkdir(/*turbopackIgnore: true*/ DIR, { recursive: true });
  const canvasFile = path.join(/*turbopackIgnore: true*/ DIR, `canvas-${nanoid(8)}.png`);
  // Padded first, then made smaller, in two steps: in one sharp chain the resize runs before the extend whatever the
  // order written, which shrank the photo to the canvas's size and padded it after (it covered half the width, not
  // two thirds, and every try "moved").
  const padded = await sharp(photo, { raw: { width: W, height: H, channels: 3 } })
    .extend({ top: padY, bottom: padY, left: padX, right: padX, background: GRAY })
    .raw()
    .toBuffer();
  await fs.writeFile(
    /*turbopackIgnore: true*/ canvasFile,
    await sharp(padded, { raw: { width: CW, height: CH, channels: 3 } }).resize(gw, gh, { fit: "fill", kernel: "lanczos3" }).png().toBuffer(),
  );
  try {
    stage("Finding the GPU");
    const target = await pickTarget(LORA.model, opts.machine);
    const lora = await loraOn(target, signal, stage);
    const [{ resolveModel }, { engineFor }] = await Promise.all([import("@/lib/models/resolve"), import("@/lib/engines/registry")]);
    const def = await resolveModel("image", `local:${LORA.model}`);
    const engine = def.via ? engineFor(def.via) : null;
    if (!engine) throw new EngineError(`${def.name} has no engine connected.`, "Open Connections.");
    const words = opts.words?.trim().replace(/[.\s]+$/, "");
    const prompt = words ? `${TRIGGER} Scene: ${words}.` : TRIGGER;

    // Not every run is clean (its card: 1 of 20 drew part of the picture again): one that doesn't line up goes again.
    let kept: { out: Buffer; fit: Awaited<ReturnType<typeof lineUp>> } | null = null;
    const tries: { here: number; best: number }[] = [];
    for (let run = 0; run < 3 && !(kept && !kept.fit.off); run++) {
      let without = false;
      const job: EngineJob = {
        kind: "image",
        model: def.model,
        via: def.via ?? undefined,
        family: def.family,
        caps: def.caps ?? undefined,
        options: { machine: target.id, loras: [{ file: lora, strength: LORA.strength }], keepReference: true },
        prompt,
        userPrompt: prompt,
        refine: false,
        aspect: nearestAspect(CW, CH),
        width: gw,
        height: gh,
        count: 1,
        references: [{ path: canvasFile, label: "the picture", role: "edit-target" }],
        mode: "image",
      };
      stage(run ? "Drawing it again (the first one didn't line up)" : "Drawing past the photo's edges");
      const result = await engine.run(job, {
        signal,
        progress: (_v, s) => {
          // The machine's list of LoRAs is up to 30 s old in the engine: a run just after the download can miss it.
          if (s && /drawn without it/i.test(s)) without = true;
        },
      });
      const data = result.outputs[0]?.data;
      if (!data) throw new EngineError("The model returned nothing.");
      if (without) {
        await sleep(31_000, signal);
        continue;
      }
      const meta = await sharp(data).metadata();
      const out = await sharp(data).removeAlpha().resize(CW, CH, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
      const fit = await lineUp(out, CW, CH, photo, W, H, padX, padY);
      tries.push({ here: fit.here, best: fit.best });
      // The last tries as the model drew them, for a look when one doesn't line up (overwritten each time).
      await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ DIR, `try-${run}.jpg`), await sharp(data).jpeg({ quality: 90 }).toBuffer()).catch(() => undefined);
      console.info(`[grow] try ${run}: ${meta.width}x${meta.height} from ${gw}x${gh}, off by ${fit.here} here, ${fit.best} at best${fit.off ? " (moved)" : ""}`);
      if (!kept || fit.here < kept.fit.here) kept = { out, fit };
    }
    if (!kept) throw new EngineError("The outpaint LoRA didn't load on the GPU machine. Try again in a minute.");
    if (kept.fit.off) throw new EngineError("The model moved the photo instead of growing it around it. Try again.");

    const { out, fit } = kept;
    pasteBack(out, CW, CH, photo, W, H, padX, padY, fit);
    // Saved at its own size (uploads are capped at 2560 wide, which would shrink the photo inside it).
    const name = `${nanoid(12)}.jpg`;
    await fs.mkdir(/*turbopackIgnore: true*/ UPLOADS_DIR, { recursive: true });
    await sharp(out, { raw: { width: CW, height: CH, channels: 3 } }).jpeg({ quality: 93 }).toFile(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, name));
    return { url: `/api/media/uploads/${name}`, width: CW, height: CH, grow: { x: CW / W, y: CH / H }, tries, ms: Date.now() - started };
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ canvasFile, { force: true });
  }
}
