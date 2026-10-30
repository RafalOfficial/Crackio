import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { ASPECTS, sizeFor, type AspectId } from "@/lib/shot";
import { imageSlots } from "@/lib/models/caps";
import { planRetouch, placeIn, type Box, type Region, type RetouchChange, type RetouchSpec } from "@/lib/retouch/plan";
import { EngineError, type Engine, type EngineContext, type EngineJob, type EngineOutput, type EngineReference } from "@/lib/engines/types";
import { DATA_DIR } from "./paths";
import { urlToPath } from "./media";
import { keepOutside } from "./protect";

/**
 * Retouch, carried out. Every change is made on a clean picture with plain words (no boxes or
 * marks for a model to copy): a change that covers most of the picture on the whole of it, and
 * every other one "up close", on an enlarged crop of its own surroundings. Each close-up comes
 * back, is lined up with the original crop (models nudge things), color-matched on the parts that
 * shouldn't change, and only the pixels that really changed around the target are blended in.
 * Everything else keeps the original's exact pixels. Inpainting models also get a mask.
 */

const WORK = path.join(DATA_DIR, "cache", "retouch");
/** Close-ups run a few at a time. */
const PARALLEL = 3;

type Px = { left: number; top: number; width: number; height: number };
type Patch = { png: Buffer; left: number; top: number };

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => s.trim().replace(/[.;:,\s]+$/, "");
const nearestShape = (r: number): AspectId => ASPECTS.reduce((b, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(b.w / b.h / r)) ? a : b)).id;

async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    }),
  );
  return out;
}

/** A picture as plain RGB pixels at a size (filled to it, or center-cropped when its shape differs). */
async function rgb(input: Buffer, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const same = meta.width && meta.height ? Math.abs(Math.log(meta.width / meta.height / (width / height))) < 0.03 : true;
  return sharp(input, { failOn: "none" })
    .removeAlpha()
    .resize(width, height, { fit: same ? "fill" : "cover", kernel: "lanczos3" })
    .raw()
    .toBuffer();
}

/** Pixels from the change areas inside a crop of `px` (enlarged to cw × ch). */
function zonesIn(changes: RetouchChange[], px: Px, W: number, H: number, cw: number, ch: number): Box[] {
  return changes.map((c) => {
    const x0 = (((c.box[0] / 1000) * W - px.left) / px.width) * cw;
    const y0 = (((c.box[1] / 1000) * H - px.top) / px.height) * ch;
    const x1 = (((c.box[2] / 1000) * W - px.left) / px.width) * cw;
    const y1 = (((c.box[3] / 1000) * H - px.top) / px.height) * ch;
    return [Math.max(0, x0), Math.max(0, y0), Math.min(cw, x1), Math.min(ch, y1)];
  });
}

/** 1 inside the (grown) zones, 0 outside, as one byte per pixel of a w × h grid. */
function zoneGrid(zones: Box[], w: number, h: number, sx: number, sy: number, grow: (z: Box) => number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (const z of zones) {
    const pad = grow(z);
    const x0 = Math.max(0, Math.floor((z[0] - pad) * sx));
    const y0 = Math.max(0, Math.floor((z[1] - pad) * sy));
    const x1 = Math.min(w, Math.ceil((z[2] + pad) * sx));
    const y1 = Math.min(h, Math.ceil((z[3] + pad) * sy));
    for (let y = y0; y < y1; y++) g.fill(1, y * w + x0, y * w + x1);
  }
  return g;
}

/** A one-byte-per-pixel grid, blurred (sharp's Gaussian), back as bytes. */
async function blurGrid(g: Uint8Array, w: number, h: number, sigma: number, scale = 255): Promise<Buffer> {
  const bytes = Buffer.alloc(g.length);
  for (let i = 0; i < g.length; i++) bytes[i] = Math.min(255, g[i] * scale);
  // One channel out: sharp would otherwise hand back three (sRGB).
  return sigma > 0.3 ? sharp(bytes, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer() : bytes;
}

/**
 * The shift and scale that best line the edited crop up with the original, judged on what
 * shouldn't have changed (outside the zones), on small grey copies. Identity unless it's clearly better.
 */
async function alignment(orig: Buffer, edit: Buffer, cw: number, ch: number, zones: Box[]) {
  const sw = cw >= ch ? 192 : Math.round((192 * cw) / ch);
  const sh = cw >= ch ? Math.round((192 * ch) / cw) : 192;
  const small = (b: Buffer) => sharp(b, { raw: { width: cw, height: ch, channels: 3 } }).resize(sw, sh, { fit: "fill" }).greyscale().blur(0.8).extractChannel(0).raw().toBuffer();
  const [o, e] = await Promise.all([small(orig), small(edit)]);
  const sx = sw / cw;
  const sy = sh / ch;
  const keep = zoneGrid(zones, sw, sh, sx, sy, (z) => Math.max(z[2] - z[0], z[3] - z[1]) * 0.2);
  const cx = sw / 2;
  const cy = sh / 2;
  const cost = (dx: number, dy: number, s: number) => {
    let sum = 0;
    let n = 0;
    for (let y = 2; y < sh - 2; y += 2) {
      for (let x = 2; x < sw - 2; x += 2) {
        if (keep[y * sw + x]) continue;
        const ex = Math.round((x - cx - dx) / s + cx);
        const ey = Math.round((y - cy - dy) / s + cy);
        if (ex < 0 || ey < 0 || ex >= sw || ey >= sh) continue;
        sum += Math.abs(o[y * sw + x] - e[ey * sw + ex]);
        n++;
      }
    }
    return n > 40 ? sum / n : Infinity;
  };
  const base = cost(0, 0, 1);
  let best = { dx: 0, dy: 0, s: 1, c: base };
  for (const s of [0.97, 0.985, 1, 1.015, 1.03]) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const c = cost(dx, dy, s);
        if (c < best.c) best = { dx, dy, s, c };
      }
    }
  }
  // Only a clear improvement counts: otherwise noise would move a good result.
  if (!(best.c < base * 0.9)) return { dx: 0, dy: 0, s: 1 };
  return { dx: best.dx / sx, dy: best.dy / sy, s: best.s };
}

/** The edited crop moved by the alignment (bilinear), at the crop's size. */
function warp(edit: Buffer, cw: number, ch: number, a: { dx: number; dy: number; s: number }): Buffer {
  if (!a.dx && !a.dy && a.s === 1) return edit;
  const out = Buffer.alloc(edit.length);
  const cx = cw / 2;
  const cy = ch / 2;
  for (let y = 0; y < ch; y++) {
    const fy = Math.min(ch - 1.001, Math.max(0, (y - cy - a.dy) / a.s + cy));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < cw; x++) {
      const fx = Math.min(cw - 1.001, Math.max(0, (x - cx - a.dx) / a.s + cx));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const i00 = (y0 * cw + x0) * 3;
      const i10 = i00 + 3;
      const i01 = i00 + cw * 3;
      const i11 = i01 + 3;
      const o = (y * cw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = edit[i00 + c] * (1 - tx) + edit[i10 + c] * tx;
        const bottom = edit[i01 + c] * (1 - tx) + edit[i11 + c] * tx;
        out[o + c] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return out;
}

/** The edited crop's colors matched to the original on what shouldn't change (a model's slight overall shift). */
function matchColors(orig: Buffer, edit: Buffer, cw: number, ch: number, zones: Box[]): Buffer {
  const keep = zoneGrid(zones, cw, ch, 1, 1, (z) => Math.max(z[2] - z[0], z[3] - z[1]) * 0.25);
  const stats = [0, 1, 2].map(() => ({ so: 0, se: 0, qo: 0, qe: 0 }));
  let n = 0;
  for (let i = 0, p = 0; p < cw * ch; p += 3, i += 9) {
    if (keep[p]) continue;
    for (let c = 0; c < 3; c++) {
      const vo = orig[i + c];
      const ve = edit[i + c];
      stats[c].so += vo;
      stats[c].se += ve;
      stats[c].qo += vo * vo;
      stats[c].qe += ve * ve;
    }
    n++;
  }
  if (n < 200) return edit;
  const fix = stats.map((s) => {
    const mo = s.so / n;
    const me = s.se / n;
    const sdo = Math.sqrt(Math.max(1, s.qo / n - mo * mo));
    const sde = Math.sqrt(Math.max(1, s.qe / n - me * me));
    const gain = Math.min(1.18, Math.max(0.85, sdo / sde));
    return { gain, offset: mo - gain * me };
  });
  if (fix.every((f) => Math.abs(f.gain - 1) < 0.02 && Math.abs(f.offset) < 2)) return edit;
  const out = Buffer.alloc(edit.length);
  for (let i = 0; i < edit.length; i += 3) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.max(0, edit[i + c] * fix[c].gain + fix[c].offset));
  }
  return out;
}

/**
 * Where to blend the close-up in: around each target, the pixels that really changed (on soft
 * copies, so re-drawn texture doesn't count), grown a little and feathered. With an inpainting
 * model the target areas themselves. Null when nothing visibly changed.
 */
async function blendMask(orig: Buffer, edit: Buffer, cw: number, ch: number, zones: Box[], masked: boolean): Promise<Buffer | null> {
  const mw = cw >= ch ? 512 : Math.round((512 * cw) / ch);
  const mh = cw >= ch ? Math.round((512 * ch) / cw) : 512;
  const sx = mw / cw;
  const sy = mh / ch;
  const long = Math.max(mw, mh);
  // Room for a change to grow past its box (a hat above a head, longer nails).
  const zone = zoneGrid(zones, mw, mh, sx, sy, (z) => Math.max(z[2] - z[0], z[3] - z[1]) * 0.25 + Math.max(cw, ch) * 0.02);
  let picked: Uint8Array;
  if (masked) {
    picked = zoneGrid(zones, mw, mh, sx, sy, (z) => Math.max(z[2] - z[0], z[3] - z[1]) * 0.08);
  } else {
    const soft = (b: Buffer) => sharp(b, { raw: { width: cw, height: ch, channels: 3 } }).resize(mw, mh, { fit: "fill" }).blur(1.6).raw().toBuffer();
    const [o, e] = await Promise.all([soft(orig), soft(edit)]);
    picked = new Uint8Array(mw * mh);
    let changed = 0;
    let room = 0;
    for (let p = 0, i = 0; p < mw * mh; p++, i += 3) {
      if (!zone[p]) continue;
      room++;
      const d = Math.max(Math.abs(o[i] - e[i]), Math.abs(o[i + 1] - e[i + 1]), Math.abs(o[i + 2] - e[i + 2]));
      if (d > 22) {
        picked[p] = 1;
        changed++;
      }
    }
    if (!room || changed / room < 0.004) return null;
    // Grow the changed pixels a little (a blur, then anything touched), so edges come along.
    const grown = await blurGrid(picked, mw, mh, long * 0.012);
    for (let p = 0; p < picked.length; p++) picked[p] = zone[p] && grown[p] > 18 ? 1 : 0;
  }
  // Feathered edges, at the crop's size.
  const feathered = await blurGrid(picked, mw, mh, long * 0.008);
  return sharp(feathered, { raw: { width: mw, height: mh, channels: 1 } }).resize(cw, ch, { fit: "fill", kernel: "cubic" }).extractChannel(0).raw().toBuffer();
}

/** One edited close-up, lined up, matched and masked, as a patch at its place in the picture. */
async function patchFrom(origCrop: Buffer, edited: Buffer, cw: number, ch: number, zones: Box[], px: Px, masked: boolean): Promise<Patch | null> {
  const meta = await sharp(edited).metadata();
  if (meta.width && meta.height && Math.abs(Math.log(meta.width / meta.height / (cw / ch))) > 0.1) {
    throw new EngineError("The model returned a close-up of a different shape, so it can't be put back in place.", "Try another model for Retouch.");
  }
  let e = await rgb(edited, cw, ch);
  e = warp(e, cw, ch, await alignment(origCrop, e, cw, ch, zones));
  e = matchColors(origCrop, e, cw, ch, zones);
  const alpha = await blendMask(origCrop, e, cw, ch, zones, masked);
  if (!alpha) return null;
  // Joined first, then scaled back to the crop's place (sharp skips a resize chained after joinChannel).
  const joined = await sharp(e, { raw: { width: cw, height: ch, channels: 3 } })
    .joinChannel(alpha, { raw: { width: cw, height: ch, channels: 1 } })
    .png()
    .toBuffer();
  const rgba = await sharp(joined).resize(px.width, px.height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  return { png: rgba, left: px.left, top: px.top };
}

/** The pictures attached to changes that fit beside the main one, and how each change refers to its own. */
function attachments(changes: RetouchChange[], slots: number) {
  const refs: EngineReference[] = [];
  const number = new Map<string, number>();
  for (const c of changes) {
    const p = c.image?.url ? urlToPath(c.image.url) : null;
    if (!p || 1 + refs.length >= slots) continue;
    refs.push({ path: p, label: `how change ${changes.indexOf(c) + 1} should look`, role: "style" });
    number.set(c.id, 1 + refs.length);
  }
  const look = (c: RetouchChange) => {
    const n = number.get(c.id);
    if (n) return ` Make it look like image ${n}.`;
    return c.image?.description ? ` Make it look exactly like this: ${sentence(c.image.description)}.` : "";
  };
  return { refs, look };
}

function regionPrompt(region: Region, slots: number) {
  const { refs, look } = attachments(region.changes, slots);
  const one = region.changes.length === 1;
  const lines = region.changes.map((c, i) => `${one ? "" : `${i + 1}. `}${capital(c.target)} at ${placeIn(c.box, region.crop, "close-up")}: ${sentence(c.text)}.${look(c)}`);
  const prompt = [
    `This is a close-up from a larger picture. ${one ? "Make this one change" : "Make these changes"} and nothing else:`,
    ...lines,
    "Keep everything else in the close-up exactly as it is (the same framing, shapes, colors, light, focus and grain), so it fits back into the full picture. Blend the change in seamlessly. No text, borders or watermarks.",
  ].join("\n");
  return { prompt, refs };
}

function wholePrompt(whole: { changes: RetouchChange[]; extra?: string }, everything: boolean, slots: number) {
  const { refs, look } = attachments(whole.changes, slots);
  const lines = whole.changes.map((c, i) => {
    // A position means nothing for something that fills the picture.
    const big = (c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) > 0.85e6;
    return `${whole.changes.length > 1 ? `${i + 1}. ` : ""}${capital(c.target)}${big ? "" : ` in ${placeIn(c.box)}`}: ${sentence(c.text)}.${look(c)}`;
  });
  const also = whole.extra ? `${lines.length ? "Also: " : ""}${sentence(whole.extra)}.` : "";
  const keep = everything
    ? "Everything else stays exactly as it is: the composition and framing, the people and their faces, the colors, the lighting and the grain. Blend each change seamlessly into its surroundings. No text or watermarks."
    : "Keep every person, animal and object that isn't mentioned exactly as it is, with the same shape, pose and position, and keep the framing. No text or watermarks.";
  const prompt = [lines.length ? `Edit this picture. ${lines.length > 1 ? "Make these changes" : "Make this change"}:` : "Edit this picture.", ...lines, also, keep].filter(Boolean).join("\n");
  return { prompt, refs };
}

/** A white-on-black picture of the change areas (soft edges), for inpainting models. */
async function maskFile(file: string, zones: Box[], w: number, h: number, grow: number) {
  const g = zoneGrid(zones, w, h, 1, 1, (z) => Math.max(z[2] - z[0], z[3] - z[1]) * grow + 4);
  const bytes = await blurGrid(g, w, h, Math.max(w, h) * 0.004);
  await sharp(bytes, { raw: { width: w, height: h, channels: 1 } }).png().toFile(file);
  return file;
}

/** A sub-job: the same model and settings, one picture (and its references), one instruction. */
function subJob(job: EngineJob, part: { file: string; refs: EngineReference[]; prompt: string; aspect: AspectId; count: number; mask?: string }): EngineJob {
  const { width, height } = sizeFor(part.aspect);
  return {
    ...job,
    references: [{ path: part.file, label: "the picture to edit", role: "edit-target" }, ...part.refs],
    prompt: part.prompt,
    userPrompt: part.prompt,
    refine: false,
    aspect: part.aspect,
    width,
    height,
    count: part.count,
    mask: part.mask ? { path: part.mask, role: "mask" } : undefined,
    guide: undefined,
    depth: undefined,
    layout: undefined,
    options: { ...job.options, aspectValue: undefined, cropFrames: undefined },
  };
}

/** Fits a result to the picture's size (the same shape is stretched a hair; another shape is center-cropped). */
async function fitTo(data: Buffer, W: number, H: number) {
  return sharp(await rgb(data, W, H), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** Makes a Retouch spec on the source picture with the job's model. */
export async function runRetouch(job: EngineJob, spec: RetouchSpec, sourcePath: string, engine: Engine, ctx: EngineContext): Promise<{ outputs: EngineOutput[]; usedPrompt: string }> {
  const src = await sharp(await fs.readFile(sourcePath), { failOn: "none" }).rotate().removeAlpha().png().toBuffer({ resolveWithObject: true });
  const W = src.info.width;
  const H = src.info.height;
  const plan = planRetouch(spec, W, H);
  if (!plan.whole && !plan.regions.length) throw new EngineError("There's nothing to change yet.", "Pin a change, or describe one under “Anything else”.");
  const takes = Math.max(1, Math.min(job.count, 4));
  const slots = job.caps ? imageSlots(job.caps) : 1;
  const masked = Boolean(job.caps?.mask);
  const quiet = { signal: ctx.signal, progress: () => {} };
  const dir = path.join(WORK, nanoid(10));
  await fs.mkdir(dir, { recursive: true });
  const last = path.join(WORK, "last");
  await fs.rm(last, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(last, { recursive: true }).catch(() => {});
  const prompts: string[] = [];
  const total = (plan.whole ? 1 : 0) + plan.regions.length * (plan.whole ? takes : 1);
  let done = 0;
  const tick = () => {
    done++;
    ctx.progress(Math.min(0.95, 0.05 + (0.9 * done) / Math.max(1, total)), total > 1 ? `${done} of ${total} edits done` : "Blending it in");
  };

  try {
    // The whole picture first: changes that cover most of it, and general words.
    let bases: Buffer[] = Array.from({ length: takes }, () => src.data);
    if (plan.whole) {
      ctx.progress(0.05, plan.regions.length ? "Changing the whole picture" : "Editing");
      const file = path.join(dir, "whole.png");
      await fs.writeFile(file, src.data);
      const { prompt, refs } = wholePrompt(plan.whole, spec.mode === "whole", slots);
      const boxes = plan.whole.changes.map((c) => c.box);
      const mask = masked && spec.mode === "whole" && boxes.length && !plan.whole.extra ? await maskFile(path.join(dir, "whole-mask.png"), boxes.map((b) => [(b[0] / 1000) * W, (b[1] / 1000) * H, (b[2] / 1000) * W, (b[3] / 1000) * H] as Box), W, H, 0.06) : undefined;
      const res = await engine.run(subJob(job, { file, refs, prompt, aspect: nearestShape(W / H), count: takes, mask }), quiet);
      prompts.push(prompt);
      tick();
      if (!res.outputs.length) throw new EngineError("The model returned no picture.");
      // "All at once": the model's own result, with the original kept outside the changes when asked.
      if (spec.mode === "whole") {
        const outputs = spec.lock && boxes.length && !plan.whole.extra ? await keepOutside(sourcePath, res.outputs, boxes) : res.outputs;
        return { outputs, usedPrompt: prompt };
      }
      bases = await Promise.all(Array.from({ length: takes }, (_, k) => fitTo(res.outputs[Math.min(k, res.outputs.length - 1)].data, W, H)));
    }

    // Then every close-up. Without a whole-picture pass, all takes start from the original, so one call makes them all.
    const shared = !plan.whole;
    const patches: (Patch | null)[][] = Array.from({ length: takes }, () => new Array<Patch | null>(plan.regions.length).fill(null));
    await mapLimit(plan.regions, PARALLEL, async (region, i) => {
      const { prompt, refs } = regionPrompt(region, slots);
      prompts.push(`Close-up ${i + 1}:\n${prompt}`);
      const runs = shared ? [{ base: src.data, count: takes, into: Array.from({ length: takes }, (_, k) => k) }] : bases.map((base, k) => ({ base, count: 1, into: [k] }));
      for (const [r, run] of runs.entries()) {
        // The crop, enlarged so small things are seen up close (long edge 1024–2048).
        const { left, top, width, height } = region.px;
        const long = Math.max(width, height);
        const scale = Math.min(2048, Math.max(1024, long)) / long;
        const cw = Math.max(16, Math.round(width * scale));
        const ch = Math.max(16, Math.round(height * scale));
        const cropPng = await sharp(run.base).extract({ left, top, width, height }).resize(cw, ch, { kernel: "lanczos3" }).png().toBuffer();
        const orig = await sharp(cropPng).removeAlpha().raw().toBuffer();
        const file = path.join(dir, `close-${i}-${r}.png`);
        await fs.writeFile(file, cropPng);
        const zones = zonesIn(region.changes, region.px, W, H, cw, ch);
        const mask = masked ? await maskFile(path.join(dir, `close-${i}-${r}-mask.png`), zones, cw, ch, 0.08) : undefined;
        let res: Awaited<ReturnType<Engine["run"]>>;
        try {
          res = await engine.run(subJob(job, { file, refs, prompt, aspect: region.aspect, count: run.count, mask }), quiet);
        } catch (err) {
          const e = err instanceof EngineError ? err : new EngineError((err as Error).message);
          throw new EngineError(`Close-up ${i + 1} (${region.changes.map((c) => sentence(c.text)).join(", ")}): ${e.message}`, e.hint);
        }
        for (const [n, k] of run.into.entries()) {
          const out = res.outputs[Math.min(n, res.outputs.length - 1)];
          if (!out) continue;
          patches[k][i] = await patchFrom(orig, out.data, cw, ch, zones, region.px, masked);
          // The last run's close-ups, for a look when a change didn't land (data/cache/retouch/last).
          await Promise.all([
            fs.writeFile(path.join(last, `close-${i + 1}-sent.png`), cropPng),
            fs.writeFile(path.join(last, `close-${i + 1}-back.png`), out.data),
            fs.writeFile(path.join(last, `close-${i + 1}.json`), JSON.stringify({ prompt, zones, px: region.px, blended: Boolean(patches[k][i]) }, null, 1)),
          ]).catch(() => {});
        }
        tick();
      }
    });

    ctx.progress(0.96, "Blending the changes in");
    const outputs: EngineOutput[] = await Promise.all(
      bases.map(async (base, k) => {
        const mine = patches[k].filter((p): p is Patch => p !== null);
        return { data: mine.length ? await sharp(base).composite(mine.map((p) => ({ input: p.png, left: p.left, top: p.top }))).png().toBuffer() : base, mime: "image/png" };
      }),
    );
    if (!plan.whole && patches.every((p) => p.every((x) => x === null))) {
      throw new EngineError("The model didn't change anything visible.", "Say the change another way, or try another model.");
    }
    return { outputs, usedPrompt: prompts.join("\n\n") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
