import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { withTarget, type ComfyTarget } from "../comfy-targets";
import { urlToPath } from "../media";
// The registry loads comfy-local whole first (see server/voice/setup).
import "@/lib/engines/refine";
import { downloadOutput, runWorkflow, uploadFile } from "@/lib/engines/comfy-local";
import { EngineError, type EngineContext, type EngineOutput } from "@/lib/engines/types";
import { ffmpegPath, runFfmpeg } from "@/lib/motion/ffmpeg";
import { ask as askBridge, machineFor } from "../voice/machines";
import { voiceById } from "../voice/store";
import { toWav } from "../voice/audio";
import { analysisByKey, analyzeClip, CACHE } from "./analyze";
import { lipsyncMachineFor } from "./machines";
import { bridgeHas } from "@/lib/setup/bridge";
import { forModel, missedShare } from "@/lib/voice/script";
import { voiceModel } from "@/lib/voice/models";
import type { Generation } from "@/lib/generations/types";
import type { LipAnalysis, LipRegion, LipSentence, LipsyncAsk, LipsyncRefine, LipsyncReport, LipWord } from "@/lib/lipsync/types";

/**
 * A Lip Sync take: the clip with some of its words changed, and its mouth redrawn to say them, only in those stretches
 * and only round the mouth.
 *
 *   1. The new words: the chosen voice model says each changed stretch three ways (in the clip's own voice, cloned from
 *      its sound, or in one of your voices); speech to text hears each take back, and the one that says every word and
 *      fits the time there is wins (sped up by at most a fifth when nothing fits as it is).
 *   2. The new soundtrack: the clip's own, with the old words of each stretch faded out and the new ones in.
 *   3. The mouth: each stretch's frames (with a few on either side) go to the Lip Sync node (comfyui/crackio_bridge/
 *      lipsync.py: LatentSync 1.6), which sends back only what it changed, as RGBA patches.
 *   4. The video: the clip decoded frame by frame here, the patches pasted onto exactly those frames (so every other
 *      pixel is the clip's own), encoded once at high quality with the new soundtrack.
 *
 * In another voice (`whole`), every other line is said again too, in that voice, and timed word by word onto the clip's
 * own words (revoiceLines), so the mouths already in the clip still fit: no new mouths there. With no words changed,
 * nothing is redrawn at all and the clip's video stream is kept bit for bit (remux).
 */

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type OutputFile = { filename: string; subfolder?: string; type?: string };

const RATE = 48000;
/** How much faster the new words may be said to fit their time. */
const MAX_STRETCH = 1.2;
/** Frames redrawn round each stretch's words (mouths move a little before and after the sound), and around those for the model's context. */
const PAD_FRAMES = 3;
const CONTEXT_FRAMES = 8;
const TAKES = 3;
/**
 * The sync score (SyncNet's, over the stretch) the new mouths must reach. Good redraws score 0.8–0.9 and the clip's own
 * mouths with words they never said about 0; under the bar the mouth is drawn once more with another seed, the better kept.
 */
const SYNC_BAR = 0.5;
/**
 * Best quality's bar: HuMo's real teeth and lips score lower with SyncNet than LatentSync's own (0.58 against 0.85 on
 * the same mouths, 2026-11-03: SyncNet flatters LatentSync), and a second try costs another HuMo pass, so only a
 * clearly broken one is drawn again.
 */
const SYNC_BAR_BEST = 0.35;
const SEEDS = [1247, 7919];

/**
 * A step's own progress (a ComfyUI run's 0–1, "Rendering · about 40 s left") as its share of the whole take, under the
 * step's own words.
 */
function part(ctx: EngineContext, lo: number, hi: number, label: string): EngineContext {
  return {
    signal: ctx.signal,
    progress: (v, stage) => {
      const left = stage?.match(/(about \d+ \w+ left|step \d+\/\d+)/)?.[1];
      ctx.progress(lo + (hi - lo) * Math.max(0, Math.min(1, v)), left ? `${label} · ${left}` : label);
    },
  };
}

async function workDir() {
  const dir = path.join(CACHE, `run-${nanoid(10)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A sound file as 48 kHz stereo float samples (interleaved). */
async function decodeAudio(file: string, signal: AbortSignal): Promise<Float32Array> {
  const res = await runFfmpeg(["-hide_banner", "-i", file, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "-"], { signal, timeoutMs: 180_000 });
  if (res.code !== 0) throw new EngineError("Couldn't read the clip's sound.", res.stderr.trim().split("\n").slice(-1)[0] ?? "");
  const b = res.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 8)));
}

async function writeWav(file: string, samples: Float32Array, channels: number, rate: number) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  await fs.writeFile(file, buf);
}

/**
 * Speech level: the RMS of the loudest 60% of 20 ms frames (pauses between words don't count), over interleaved stereo
 * from `from` to `to` frames.
 */
function speechLevel(x: Float32Array, from = 0, to = x.length / 2) {
  const hop = Math.round(0.02 * RATE);
  const levels: number[] = [];
  for (let a = Math.max(0, from); a + hop <= Math.min(to, x.length / 2); a += hop) {
    let sum = 0;
    for (let i = a; i < a + hop; i++) sum += (x[i * 2] * x[i * 2] + x[i * 2 + 1] * x[i * 2 + 1]) / 2;
    levels.push(sum / hop);
  }
  if (!levels.length) return 0;
  levels.sort((p, q) => q - p);
  const loud = levels.slice(0, Math.max(1, Math.round(levels.length * 0.6)));
  return Math.sqrt(loud.reduce((s, v) => s + v, 0) / loud.length);
}

/** A take scaled to the speech level of the clip's own words it replaces (gain 0.25-4x; left as it is when either is silent). */
function levelled(take: Float32Array, base: Float32Array, start: number, end: number) {
  const want = speechLevel(base, Math.round(start * RATE), Math.round(end * RATE));
  const have = speechLevel(take);
  if (want < 1e-4 || have < 1e-4) return take;
  const gain = Math.max(0.25, Math.min(4, want / have));
  if (Math.abs(gain - 1) < 0.05) return take;
  const out = new Float32Array(take.length);
  for (let i = 0; i < take.length; i++) out[i] = Math.max(-1, Math.min(1, take[i] * gain));
  return out;
}

/** A take without its silence at either end (20 ms kept), as stereo frames. */
function trimmed(x: Float32Array, floor = 0.012) {
  const frames = x.length / 2;
  let a = 0;
  let b = frames - 1;
  while (a < frames && Math.max(Math.abs(x[a * 2]), Math.abs(x[a * 2 + 1])) < floor) a++;
  while (b > a && Math.max(Math.abs(x[b * 2]), Math.abs(x[b * 2 + 1])) < floor) b--;
  const pad = Math.round(0.02 * RATE);
  a = Math.max(0, a - pad);
  b = Math.min(frames - 1, b + pad);
  return x.slice(a * 2, (b + 1) * 2);
}

/** The new soundtrack: the old words of each stretch faded out (20 ms), each new take faded in where it's placed. */
function mixed(base: Float32Array, cuts: { start: number; end: number; take: Float32Array; at: number }[]) {
  const out = base.slice();
  const frames = out.length / 2;
  const fade = Math.round(0.02 * RATE);
  for (const c of cuts) {
    const a = Math.max(0, Math.round(c.start * RATE));
    const b = Math.min(frames, Math.round(c.end * RATE));
    for (let i = Math.max(0, a - fade); i < Math.min(frames, b + fade); i++) {
      const g = i < a ? (a - i) / fade : i >= b ? (i - b + 1) / fade : 0;
      out[i * 2] *= g;
      out[i * 2 + 1] *= g;
    }
  }
  for (const c of cuts) {
    const at = Math.round(c.at * RATE);
    const n = c.take.length / 2;
    const f = Math.round(0.01 * RATE);
    for (let k = 0; k < n && at + k < frames; k++) {
      const env = Math.min(1, k / f, (n - 1 - k) / f);
      out[(at + k) * 2] += c.take[k * 2] * env;
      out[(at + k) * 2 + 1] += c.take[k * 2 + 1] * env;
    }
  }
  return out;
}

/** The speaker's own voice from the clip: up to 20 s of its speech round the stretch, with what's said in it. */
async function cloneReference(src: string, a: LipAnalysis, near: number, dir: string, signal: AbortSignal) {
  const words = a.words;
  if (!words.length) throw new EngineError("The clip has no speech to take the voice from.", "Pick one of your voices instead.");
  let from = Math.max(0, near - 10);
  let to = Math.min(a.duration, from + 20);
  from = Math.max(0, to - 20);
  const inside = words.filter((w) => w.start >= from && w.end <= to);
  if (inside.length < 3) {
    from = words[0].start;
    to = Math.min(words[words.length - 1].end, from + 20);
  }
  const used = words.filter((w) => w.start >= from - 0.01 && w.end <= to + 0.01);
  const file = path.join(dir, "voice.wav");
  const cut = path.join(dir, "voice-src.wav");
  const res = await runFfmpeg(["-hide_banner", "-y", "-ss", from.toFixed(3), "-to", (to + 0.15).toFixed(3), "-i", src, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", cut], { signal, timeoutMs: 60_000 });
  if (res.code !== 0) throw new EngineError("Couldn't take the voice from the clip.", "Try again.");
  await toWav(cut, file, { rate: 24000, signal });
  return { file, text: used.map((w) => w.word).join(" ") };
}

export async function runLipsync(gen: Generation, ctx: EngineContext): Promise<{ outputs: EngineOutput[]; report: LipsyncReport; usedPrompt: string; modelName: string }> {
  const t0 = Date.now();
  const ask = gen.params?.lipsync as LipsyncAsk | undefined;
  const model = voiceModel(ask?.model);
  if (!ask || !model) throw new EngineError("This take doesn't say what to change.", "Open the clip in Lip Sync again.");
  const src = urlToPath(ask.url);
  if (!src || !(await fs.stat(src).catch(() => null))) throw new EngineError("Crackio can't find the clip.", "Pick it again.");
  const analysis = (await analysisByKey(ask.analysis)) ?? (await analyzeClip(ask.url, ctx.signal));
  const regions = [...ask.regions].filter((r) => r.text.trim() !== r.was.trim()).sort((a, b) => a.start - b.start);
  // Every line in another voice (the clone would only say them again as they were).
  const whole = Boolean(ask.whole) && ask.voice.kind === "voice";
  if (!regions.length && !whole) throw new EngineError("Nothing to change: the words are the same.", "Change a sentence, or pick another voice.");
  if (whole && !analysis.sentences.length) throw new EngineError("Crackio heard no words in this clip.", "Pick a clip with speech.");
  const fps = analysis.fps;

  const speech = await machineFor(model.id);
  if (!speech) throw new EngineError(`${model.name} isn't on any of your GPUs yet.`, "Get it under Voice models, then try again.");
  // New mouths only where the words change: a new voice alone leaves every frame as it is.
  const lips = regions.length ? await lipsyncMachineFor() : null;
  if (regions.length && !lips) throw new EngineError("Lip Sync isn't set up on any of your GPUs yet.", "Set it up from the Lip Sync tool.");
  const where = lips ? (lips.machine.gpu ?? lips.machine.label) : (speech.machine.gpu ?? speech.machine.label);
  // Shares of the take's progress: the changed lines' new words, every other line in the new voice, the mouths.
  const wordsEnd = regions.length ? (whole ? 0.22 : 0.4) : 0.05;
  const voiceEnd = regions.length ? 0.4 : 0.85;
  if (ask.voice.kind === "clone" && !ask.voice.consent) throw new EngineError("Cloning the clip's voice needs your permission.", "Tick the permission and try again.");
  if (ask.voice.kind === "clone" && !model.can.clone) throw new EngineError(`${model.name} can't clone a voice.`, "Pick Drama 3 or VoxCPM2.");

  const dir = await workDir();
  // What this take leaves on the Lip Sync machine (its windows and sounds, the patches' folders), cleared at the end.
  const left: Leftovers = { inputs: [], outputs: [], nonce: path.basename(dir) };
  try {
    // ------------------------------------------------------------ 1. the new words
    const variant = model.variants.find((x) => speech.machine.files.includes(x.file.name)) ?? model.variants[0];
    const base = analysis.audio ? await decodeAudio(src, ctx.signal) : new Float32Array(Math.ceil(analysis.duration * RATE) * 2);
    const cuts: { start: number; end: number; take: Float32Array; at: number }[] = [];
    const report: LipsyncReport = { regions: [], machine: where };
    let voiceRef: { name: string; text: string } | null = null;
    let voiceName = "";
    if (ask.voice.kind === "voice") {
      const v = await voiceById(ask.voice.id);
      if (!v) throw new EngineError("That voice is gone.", "Pick another voice.");
      voiceName = v.name;
      const sample = urlToPath(v.sample);
      if (!sample) throw new EngineError(`${v.name}'s sample is missing.`, "Pick another voice.");
      const wav = path.join(dir, "voice.wav");
      await toWav(sample, wav, { rate: 24000, signal: ctx.signal });
      const up = await withTarget(speech.target, () => uploadFile(wav, ctx.signal, "voice"));
      voiceRef = { name: up.name, text: v.text };
    }
    for (let r = 0; r < regions.length; r++) {
      const region = regions[r];
      const voiceLabel = `Saying the new words${regions.length > 1 ? ` (${r + 1} of ${regions.length})` : ""} with ${model.name}`;
      const lo = 0.05 + ((wordsEnd - 0.05) * r) / regions.length;
      const hi = 0.05 + ((wordsEnd - 0.05) * (r + 1)) / regions.length;
      ctx.progress(lo, voiceLabel);
      if (ask.voice.kind === "clone" && (!voiceRef || r === 0)) {
        const ref = await cloneReference(src, analysis, region.start, dir, ctx.signal);
        const up = await withTarget(speech.target, () => uploadFile(ref.file, ctx.signal, "voice"));
        voiceRef = { name: up.name, text: ref.text };
      }
      const said = region.text.trim();
      let take: { samples: Float32Array; seconds: number; heard?: string; missed?: number } | null = null;
      if (said) {
        take = await bestTake(speech.target, speech.machine.hearing, variant.file.name, model.id, said, voiceRef, region, ask.language ?? "", dir, part(ctx, lo, hi, voiceLabel));
      }
      const room = region.until - region.from;
      const natural = region.until - region.start;
      let stretch = 1;
      let samples = take?.samples ?? new Float32Array(0);
      let seconds = take?.seconds ?? 0;
      if (seconds > room) {
        stretch = seconds / room;
        if (stretch > MAX_STRETCH) {
          throw new EngineError(
            `“${said.slice(0, 60)}${said.length > 60 ? "…" : ""}” runs ${seconds.toFixed(1)} s, and there's room for ${room.toFixed(1)} s there.`,
            "Say it in fewer words.",
          );
        }
        const raw = path.join(dir, `take-${r}.wav`);
        const fast = path.join(dir, `take-${r}-fast.wav`);
        await writeWav(raw, samples, 2, RATE);
        const res = await runFfmpeg(["-hide_banner", "-y", "-i", raw, "-af", `atempo=${stretch.toFixed(4)}`, "-ac", "2", "-ar", String(RATE), fast], { signal: ctx.signal, timeoutMs: 60_000 });
        if (res.code !== 0) throw new EngineError("Couldn't fit the new words in.", "Try shorter words.");
        samples = trimmed(await decodeAudio(fast, ctx.signal));
        seconds = samples.length / 2 / RATE;
      }
      // Where they start: where the old words did, or earlier when they need the room.
      const at = seconds <= natural ? region.start : Math.max(region.from, region.until - seconds);
      // As loud as she spoke the words it replaces (speech level, not the pauses), so the new line doesn't stand out.
      samples = levelled(samples, base, region.start, region.end);
      cuts.push({ start: region.start, end: region.end, take: samples, at });
      report.regions.push({ start: at, end: at + seconds, text: said, take: { seconds: Number(seconds.toFixed(2)), stretch: Number(stretch.toFixed(3)), heard: take?.heard, missed: take?.missed }, frames: 0 });
    }
    // ------------------------------------------------------------ 1b. every other line, in the new voice
    if (whole && voiceRef) {
      const covered = new Set(regions.flatMap((x) => x.sentences));
      const lines = analysis.sentences.filter((x) => !covered.has(x.id) && x.text.trim());
      if (lines.length) {
        const label = `Saying every line again with ${model.name}`;
        ctx.progress(wordsEnd, label);
        const got = await revoiceLines(speech.target, speech.machine.hearing, variant.file.name, model.id, lines, analysis, voiceRef, ask.language ?? "", dir, part(ctx, wordsEnd, voiceEnd, label));
        // As loud as the speaker said each line.
        for (const c of got.cuts) cuts.push({ ...c, take: levelled(c.take, base, c.start, c.end) });
        report.voice = { name: voiceName, lines: lines.length, timed: got.timed, redone: got.redone };
      }
    }
    const soundtrack = mixed(base, cuts);
    const soundFile = path.join(dir, "soundtrack.wav");
    await writeWav(soundFile, soundtrack, 2, RATE);
    const originalFile = path.join(dir, "original.wav");
    await writeWav(originalFile, base, 2, RATE);

    // ------------------------------------------------------------ 2. the mouths
    const total = Math.round(analysis.duration * fps);
    const patches = new Map<number, Patch>();
    // Each stretch's window and sound go up once; a second try reuses them.
    const sent = new Map<string, Sent>();
    for (let r = 0; lips && r < regions.length; r++) {
      const lipLabel = `Redrawing the mouth${regions.length > 1 ? ` (${r + 1} of ${regions.length})` : ""} on ${lips.machine.gpu ?? lips.machine.label}`;
      ctx.progress(0.42 + (0.45 * r) / regions.length, lipLabel);
      const c = cuts[r];
      const said = report.regions[r];
      const spanStart = Math.max(0, Math.floor(Math.min(c.start, said.start) * fps) - PAD_FRAMES);
      const spanEnd = Math.min(total, Math.ceil(Math.max(c.end, said.end) * fps) + PAD_FRAMES);
      const ws = Math.max(0, spanStart - CONTEXT_FRAMES);
      const we = Math.min(total, spanEnd + CONTEXT_FRAMES);
      const hi = 0.42 + (0.45 * (r + 1)) / regions.length;
      const fine = bridgeHas(lips.machine.bridge, "lipsyncFine");
      const lipsOnly = bridgeHas(lips.machine.bridge, "lipsyncLips");
      const draw = (k: number, step: EngineContext) => mouths(lips.target, src, soundFile, originalFile, ws, we, spanStart, spanEnd, fps, dir, `${r}`, sent, left, SEEDS[k], step, ask.tuning, fine, lipsOnly);
      let got = await draw(0, part(ctx, 0.42 + (0.45 * r) / regions.length, hi, lipLabel));
      let tries = 1;
      const first = syncOf(got.report).new;
      const bar = ask.tuning?.refine ? SYNC_BAR_BEST : SYNC_BAR;
      if (first != null && first < bar) {
        const again = await draw(1, part(ctx, hi, hi, `${lipLabel} again (its sync came out ${first.toFixed(2)})`));
        tries = 2;
        if ((syncOf(again.report).new ?? -1) > first) got = again;
      }
      for (const p of got.patches) patches.set(ws + p.frame, { x: got.box[0], y: got.box[1], w: got.box[2], h: got.box[3], png: p.png, matrix: got.matrix });
      said.frames = spanEnd - spanStart;
      const sync = syncOf(got.report);
      said.sync = got.report.scores ? sync : undefined;
      said.tries = tries;
      said.low = sync.new != null && sync.new < bar;
      said.lips = Array.isArray(got.report.lips_shift_ab) ? (got.report.lips_shift_ab as number[]) : null;
    }

    // ------------------------------------------------------------ 3. the video
    ctx.progress(0.9, "Putting the video together");
    const out = path.join(dir, "lipsync.mp4");
    if (patches.size) await compose(src, soundFile, out, analysis, patches, ctx.signal);
    else await remux(src, soundFile, out, ctx.signal);
    report.seconds = Math.round((Date.now() - t0) / 1000);
    const data = await fs.readFile(out);
    return {
      outputs: [{ data, mime: "video/mp4", width: analysis.width, height: analysis.height }],
      report,
      usedPrompt: [...regions.map((r) => r.text), ...(report.voice ? [`Every line in ${report.voice.name}`] : [])].join(" · "),
      modelName: `Lip Sync · ${model.name}${lips ? (ask.tuning?.refine ? " · LatentSync + HuMo 17B" : " · LatentSync") : ""}${where ? ` · ${where}` : ""}`,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (lips && (left.inputs.length || left.outputs.length)) {
      await askBridge(lips.target, "/crackio/lipsync/forget", { method: "POST", body: JSON.stringify({ inputs: left.inputs, outputs: left.outputs }), timeoutMs: 8000 });
    }
  }
}

type Cut = { start: number; end: number; take: Float32Array; at: number };

/** Interleaved stereo to mono. */
function mono(x: Float32Array) {
  const out = new Float32Array(x.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (x[i * 2] + x[i * 2 + 1]) / 2;
  return out;
}

/** Mono to interleaved stereo. */
function stereo(x: Float32Array) {
  const out = new Float32Array(x.length * 2);
  for (let i = 0; i < x.length; i++) out[i * 2] = out[i * 2 + 1] = x[i];
  return out;
}

/** Where a take's sound starts and ends (seconds; 20 ms kept either side). */
function soundSpan(x: Float32Array, floor = 0.012) {
  let a = 0;
  let b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < floor) a++;
  while (b > a && Math.abs(x[b]) < floor) b--;
  const pad = Math.round(0.02 * RATE);
  return [Math.max(0, a - pad) / RATE, Math.min(x.length, b + pad) / RATE] as const;
}

/** ffmpeg's atempo for a speed (it takes 0.5-2 a stage), as one chain. */
function atempo(speed: number) {
  const stages: number[] = [];
  let r = Math.max(0.25, Math.min(4, speed));
  while (r > 2) {
    stages.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    stages.push(0.5);
    r /= 0.5;
  }
  stages.push(r);
  return stages.map((x) => `atempo=${x.toFixed(5)}`).join(",");
}

/**
 * Every line said again in another voice, kept on the clip's own mouths. The voice model says each line (one graph for
 * them all); speech to text times the new words against the line's own and hears what was said; then each word, and
 * each pause between words, is stretched (pitch kept) to start and end where the speaker said it (timeLine), so the
 * mouths in the clip still fit every word and its frames stay as they are. A take that drops words is said once more
 * with other seeds, the better one kept.
 */
async function revoiceLines(
  target: ComfyTarget,
  hearing: boolean,
  modelFile: string,
  modelId: Parameters<typeof forModel>[0],
  lines: LipSentence[],
  a: LipAnalysis,
  ref: { name: string; text: string },
  language: string,
  dir: string,
  ctx: EngineContext,
) {
  const say = async (which: LipSentence[], seed: number, tag: string, step: EngineContext) => {
    const graph: Graph = { ref: { class_type: "LoadAudio", inputs: { audio: ref.name } } };
    which.forEach((s, k) => {
      graph[`say${k}`] = {
        class_type: "CrackioVoice",
        inputs: { model: modelFile, text: forModel(modelId, s.text, ""), seed: seed + k, temperature: 0, speed: 1, preset: "", voice_1: ["ref", 0], voice_1_text: ref.text },
      };
      graph[`save${k}`] = { class_type: "SaveAudio", inputs: { audio: [`say${k}`, 0], filename_prefix: `crackio/revoice-${tag}-say${k}` } };
      if (hearing) {
        graph[`align${k}`] = { class_type: "CrackioTranscribe", inputs: { audio: [`say${k}`, 0], text: s.text, language } };
        graph[`timed${k}`] = { class_type: "CrackioSaveText", inputs: { text: [`align${k}`, 1], filename_prefix: `crackio/revoice-${tag}-words${k}` } };
        graph[`hear${k}`] = { class_type: "CrackioTranscribe", inputs: { audio: [`say${k}`, 0], text: "", language } };
        graph[`heard${k}`] = { class_type: "CrackioSaveText", inputs: { text: [`hear${k}`, 0], filename_prefix: `crackio/revoice-${tag}-heard${k}` } };
      }
    });
    const chars = which.reduce((n, s) => n + s.text.length, 0);
    const { files } = await withTarget(target, () => runWorkflow(graph, step, 60_000 + chars * 500, "Lip Sync · every line"));
    const text = async (re: RegExp) => {
      const f = files.find((x) => re.test(x.filename));
      return f ? (await withTarget(target, () => downloadOutput(f, ctx.signal))).data.toString("utf8") : null;
    };
    return Promise.all(
      which.map(async (s, k) => {
        const sound = files.find((f) => new RegExp(`revoice-${tag}-say${k}_`).test(f.filename));
        if (!sound) throw new EngineError("The voice model made no sound for a line.", "Try again.");
        const got = await withTarget(target, () => downloadOutput(sound, ctx.signal));
        const file = path.join(dir, `line-${tag}-${k}${path.extname(sound.filename) || ".flac"}`);
        await fs.writeFile(file, got.data);
        const [timed, heard] = await Promise.all([text(new RegExp(`revoice-${tag}-words${k}_`)), text(new RegExp(`revoice-${tag}-heard${k}_`))]);
        let words: LipWord[] = [];
        try {
          words = timed ? (JSON.parse(timed) as LipWord[]).filter((w) => w && typeof w.start === "number" && typeof w.end === "number") : [];
        } catch {
          words = [];
        }
        return { file, words, missed: heard != null ? missedShare(s.text, heard.trim()) : 0 };
      }),
    );
  };
  const seed = Math.floor(Math.random() * 2 ** 30);
  const takes = await say(lines, seed, "a", part(ctx, 0, 0.75, "Saying every line again"));
  // A take that dropped words: once more with other seeds, the better one kept.
  const weak = lines.map((_, k) => k).filter((k) => takes[k].missed > 0.2);
  let redone = 0;
  if (weak.length) {
    const again = await say(
      weak.map((k) => lines[k]),
      seed + 7919,
      "b",
      part(ctx, 0.75, 0.9, `Saying ${weak.length === 1 ? "a line" : `${weak.length} lines`} once more`),
    );
    weak.forEach((k, j) => {
      if (again[j].missed < takes[k].missed) {
        takes[k] = again[j];
        redone++;
      }
    });
  }
  ctx.progress(0.92, "Timing every word to their lips");
  let timed = 0;
  const cuts: Cut[] = [];
  for (let k = 0; k < lines.length; k++) {
    const s = lines[k];
    const own = a.words.filter((w) => w.start >= s.start - 0.02 && w.end <= s.end + 0.02);
    const laid = await timeLine(takes[k].file, takes[k].words, own, s, dir, `${k}`, ctx.signal);
    if (laid.byWord) timed++;
    // The speaker's own words there fade out a little either side of the new ones.
    cuts.push({ start: laid.at - 0.03, end: laid.at + laid.samples.length / 2 / RATE + 0.03, take: laid.samples, at: laid.at });
  }
  return { cuts, timed, redone };
}

/**
 * A line's new take laid onto when the speaker said it: (time in the take, time in the clip) pairs at every word's
 * start and end when the words pair up one to one, else at the line's two ends; each piece between two pairs stretched
 * by ffmpeg's atempo (pitch kept) to exactly its length in the clip, with 6 ms fades so the pieces join without clicks.
 */
async function timeLine(file: string, said: LipWord[], own: LipWord[], s: LipSentence, dir: string, tag: string, signal: AbortSignal) {
  const x = mono(await decodeAudio(file, signal));
  const byWord = said.length > 0 && said.length === own.length;
  let pairs: [number, number][];
  if (byWord) pairs = said.flatMap((w, i) => [[w.start, own[i].start] as [number, number], [w.end, own[i].end] as [number, number]]);
  else {
    const [t0, t1] = soundSpan(x);
    pairs = [
      [t0, own[0]?.start ?? s.start],
      [t1, own.at(-1)?.end ?? s.end],
    ];
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  // Pieces of at least 40 ms on both sides (a pair that would make a shorter one is dropped).
  const keep: [number, number][] = [pairs[0]];
  for (const p of pairs.slice(1)) {
    const last = keep[keep.length - 1];
    if (p[0] - last[0] >= 0.04 && p[1] - last[1] >= 0.04) keep.push(p);
  }
  if (keep.length < 2) {
    const [t0, t1] = soundSpan(x);
    keep.splice(0, keep.length, [t0, s.start], [t1, Math.max(s.end, s.start + 0.2)]);
  }
  const pieces: string[] = [];
  const names: string[] = [];
  for (let i = 0; i + 1 < keep.length; i++) {
    const [s0, d0] = keep[i];
    const [s1, d1] = keep[i + 1];
    const want = Math.max(1, Math.round((d1 - d0) * RATE));
    const speed = (s1 - s0) / (d1 - d0);
    const fadeOut = Math.max(0, want / RATE - 0.006).toFixed(4);
    pieces.push(
      `[s${i}]atrim=start=${s0.toFixed(4)}:end=${s1.toFixed(4)},asetpts=PTS-STARTPTS,${atempo(speed)},apad=whole_len=${want},atrim=end_sample=${want},afade=t=in:d=0.006,afade=t=out:st=${fadeOut}:d=0.006[p${i}]`,
    );
    names.push(`[p${i}]`);
  }
  const n = names.length;
  const graph = `[0:a]aresample=${RATE},aformat=sample_fmts=flt:channel_layouts=mono,asplit=${n}${names.map((_, i) => `[s${i}]`).join("")};${pieces.join(";")};${names.join("")}concat=n=${n}:v=0:a=1[out]`;
  const script = path.join(dir, `line-${tag}.filter`);
  await fs.writeFile(script, graph);
  const res = await runFfmpeg(["-hide_banner", "-y", "-i", file, "-filter_complex_script", script, "-map", "[out]", "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"], { signal, timeoutMs: 120_000 });
  if (res.code !== 0) throw new EngineError("Couldn't time the new voice to the lips.", res.stderr.trim().split("\n").slice(-1)[0] ?? "");
  const b = res.stdout;
  const laid = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
  return { samples: stereo(laid), at: keep[0][1], byWord };
}

/** The clip's own video stream, bit for bit, with the new soundtrack (nothing redrawn: a new voice alone). */
async function remux(src: string, sound: string, out: string, signal: AbortSignal) {
  // The sound padded with silence to the video's end, so no frame is dropped where the clip's sound ran shorter.
  const res = await runFfmpeg(["-hide_banner", "-y", "-i", src, "-i", sound, "-map", "0:v:0", "-map", "1:a", "-c:v", "copy", "-af", "apad", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], {
    signal,
    timeoutMs: 600_000,
  });
  if (res.code !== 0) throw new EngineError("Couldn't put the video together.", res.stderr.trim().split("\n").slice(-1)[0] ?? "");
}

/** Three takes of the new words in one graph; each heard back; the one that says them all and fits best. */
async function bestTake(
  target: ComfyTarget,
  hearing: boolean,
  modelFile: string,
  modelId: Parameters<typeof forModel>[0],
  said: string,
  ref: { name: string; text: string } | null,
  region: LipRegion,
  language: string,
  dir: string,
  ctx: EngineContext,
) {
  const graph: Graph = {};
  if (ref) graph.ref = { class_type: "LoadAudio", inputs: { audio: ref.name } };
  const seed = Math.floor(Math.random() * 2 ** 30);
  for (let k = 0; k < TAKES; k++) {
    graph[`say${k}`] = {
      class_type: "CrackioVoice",
      inputs: { model: modelFile, text: forModel(modelId, said, ""), seed: seed + k, temperature: 0, speed: 1, preset: ref ? "" : "F2", ...(ref ? { voice_1: ["ref", 0], voice_1_text: ref.text } : {}) },
    };
    graph[`save${k}`] = { class_type: "SaveAudio", inputs: { audio: [`say${k}`, 0], filename_prefix: `crackio/lipsync-take${k}` } };
    if (hearing) {
      graph[`hear${k}`] = { class_type: "CrackioTranscribe", inputs: { audio: [`say${k}`, 0], text: "", language } };
      graph[`heard${k}`] = { class_type: "CrackioSaveText", inputs: { text: [`hear${k}`, 0], filename_prefix: `crackio/lipsync-heard${k}` } };
    }
  }
  const { files } = await withTarget(target, () => runWorkflow(graph, ctx, 30_000 + said.length * 400, "Lip Sync · new words"));
  const takes: { samples: Float32Array; seconds: number; heard?: string; missed?: number }[] = [];
  for (let k = 0; k < TAKES; k++) {
    const sound = files.find((f) => new RegExp(`lipsync-take${k}_`).test(f.filename));
    if (!sound) continue;
    const got = await withTarget(target, () => downloadOutput(sound, ctx.signal));
    const file = path.join(dir, `raw-${k}${path.extname(sound.filename) || ".flac"}`);
    await fs.writeFile(file, got.data);
    const samples = trimmed(await decodeAudio(file, ctx.signal));
    const hf = files.find((f) => new RegExp(`lipsync-heard${k}_`).test(f.filename));
    const heard = hf ? (await withTarget(target, () => downloadOutput(hf, ctx.signal))).data.toString("utf8").trim() : undefined;
    takes.push({ samples, seconds: samples.length / 2 / RATE, heard, missed: heard !== undefined ? missedShare(said, heard) : undefined });
  }
  if (!takes.length) throw new EngineError("The voice model made no sound.", "Try again.");
  const room = region.until - region.from;
  const want = region.end - region.start;
  // Says every word first; then fits without speeding up; then closest to how long the old words took.
  const score = (t: (typeof takes)[number]) => (t.missed ?? 0) * 10 + (t.seconds > room ? 5 + (t.seconds - room) : 0) + Math.abs(t.seconds - want) * 0.3;
  return takes.sort((a, b) => score(a) - score(b))[0];
}

/** The node's sync scores (null when it couldn't score). */
function syncOf(report: Record<string, unknown>) {
  const s = report.scores as { new?: { sync?: number } | null; original?: { sync?: number } | null } | null | undefined;
  return { new: s?.new?.sync ?? null, original: s?.original?.sync ?? null };
}

type Sent = { video: string; words: string; was: string };
/** A take's files on the Lip Sync machine, and the tag that keeps its uploads its own (nothing shared with another take). */
type Leftovers = { inputs: string[]; outputs: string[]; nonce: string };

/**
 * One stretch's mouths: the window (exact frames from here, as a high-quality MP4) and its sound go to the Lip Sync
 * node (once per stretch: `sent` keeps what's already there); the patches come back.
 */
async function mouths(
  target: ComfyTarget,
  src: string,
  sound: string,
  original: string,
  ws: number,
  we: number,
  ss: number,
  se: number,
  fps: number,
  dir: string,
  tag: string,
  sent: Map<string, Sent>,
  left: Leftovers,
  seed: number,
  ctx: EngineContext,
  tuning?: LipsyncAsk["tuning"],
  fine = false,
  lipsOnly = false,
) {
  const steps = Math.max(4, Math.min(60, Math.round(tuning?.steps ?? 20)));
  const overlap = Math.max(0, Math.min(12, Math.round(tuning?.overlap ?? 0)));
  const refine = tuning?.refine ?? null;
  // Best quality: LatentSync takes its looks from her open-mouth frame where the words are loud and her closed one where
  // they're quiet ("pair"), so HuMo gets real teeth to work from (2026-11-03, same words and frames: more teeth, a softer
  // line down the lips, sync 0.68 against 0.60 with each frame's own looks). It costs nothing more.
  const reference = tuning?.reference ?? (refine ? "pair" : "same");
  let up = sent.get(tag);
  if (!up) {
    up = await sendWindow(target, src, sound, original, ws, we, fps, dir, tag, left.nonce, ctx.signal);
    sent.set(tag, up);
    left.inputs.push(up.video, up.words, up.was);
  }
  const graph: Graph = {
    clip: { class_type: "LoadVideo", inputs: { file: up.video } },
    words: { class_type: "LoadAudio", inputs: { audio: up.words } },
    was: { class_type: "LoadAudio", inputs: { audio: up.was } },
    lip: {
      class_type: "CrackioLipSync",
      inputs: {
        // The node reads the clip itself with BT.709 said outright, so its patches go back in the same colours.
        video: ["clip", 0],
        audio: ["words", 0],
        original_audio: ["was", 0],
        fps,
        span_start: ss - ws,
        span_end: se - ws,
        steps,
        guidance: tuning?.guidance ?? 1.5,
        seed,
        // Only when asked: a bridge before 1.10.1 has neither.
        ...(reference !== "same" ? { reference } : {}),
        ...(overlap ? { overlap } : {}),
        fade: 4,
        sharpen: true,
        // Best quality scores (and saves) what HuMo made instead.
        check: !refine,
        patch_prefix: refine ? "" : "crackio/lipsync",
      },
    },
  };
  const humo = refine ? await humoModel(target) : HUMO_FILES.model;
  if (refine) Object.assign(graph, refineNodes(refine, fps, ss - ws, se - ws, refine.attention !== "pytorch" && (await int8Attention(target)), fine, humo, lipsOnly));
  // HuMo's share on an RTX 5090: about 5.5 minutes for each of its windows (97 frames; longer stretches take several
  // that share 16), the model's first load in it. 8 steps at the face's own size with INT8 attention: 333 s (the take
  // itself 424 s); bridge 1.10.2's finer drawing, 6 steps at 832: 290 s in the node, about 345 with the loads.
  const humoWindows = we - ws <= 97 ? 1 : Math.ceil((we - ws - 16) / 81);
  // The MXFP8 build: 155 s of drawing instead of 260 for the same window.
  const humoMs = refine ? humoWindows * (fine ? 345_000 * ((refine.steps ?? 6) / 6) : 330_000 * ((refine.steps ?? 8) / 8)) * (refine.lora ? 0.5 : 1) * (humo === HUMO_MXFP8 ? 0.7 : 1) : 0;
  const { files } = await withTarget(target, () => runWorkflow(graph, ctx, 30_000 + (we - ws) * 900 * (steps / 20) * (overlap ? 16 / (16 - overlap) : 1) + humoMs, refine ? "Lip Sync · LatentSync + HuMo" : "Lip Sync · LatentSync"));
  const get = (name: string) => files.find((f: OutputFile) => f.filename === name);
  const listFile = get("patches.json");
  const reportFile = get("report.json");
  if (listFile?.subfolder) left.outputs.push(listFile.subfolder);
  if (!listFile) throw new EngineError("The Lip Sync node sent nothing back.", "Try again.");
  const [list, rep] = await withTarget(target, () => Promise.all([downloadOutput(listFile, ctx.signal), reportFile ? downloadOutput(reportFile, ctx.signal) : null]));
  const info = JSON.parse(list.data.toString("utf8")) as { box: [number, number, number, number] | null; frames: { frame: number; file: string }[]; matrix?: string | null };
  const report = rep ? (JSON.parse(rep.data.toString("utf8")) as Record<string, unknown>) : {};
  const matrix: Patch["matrix"] = info.matrix === "bt601" ? "bt601" : "bt709";
  if (!info.box) return { box: [0, 0, 0, 0] as [number, number, number, number], patches: [], report, matrix };
  const patches = await Promise.all(
    info.frames.map(async (p) => {
      const f = get(p.file);
      if (!f) throw new EngineError("A patch went missing on the way back.", "Try again.");
      const got = await withTarget(target, () => downloadOutput(f, ctx.signal));
      return { frame: p.frame, png: got.data };
    }),
  );
  return { box: info.box, patches, report, matrix };
}

/** HuMo 17B and what it needs (Comfy-Org's repack of HuMo, Whisper large v3, Wan 2.1's umt5 and VAE) for best quality. */
export const HUMO_FILES = {
  model: "humo_17B_fp8_e4m3fn.safetensors",
  whisper: "whisper_large_v3_fp16.safetensors",
  text: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
} as const;

/**
 * Crackio's MXFP8 build of HuMo 17B, made from Comfy-Org's fp16 one (Apache-2.0): every Linear weight of its blocks in
 * MXFP8 (e4m3 with a scale per 32 weights), everything else kept fp16 (C:/CrackioTemp/humo/to_mxfp8_stream.py). Used
 * where a machine has it: the same pictures as Comfy-Org's fp8 file (2026-11-03, two faces, fixed inputs: detail 0.87
 * and 0.87, the same skin and teeth) in 155 s of drawing instead of 260 on an RTX 5090, whose tensor cores do MXFP8
 * themselves (other cards unpack it, as they do the fp8 one). Comfy-Org's fp8 file is a plain cast of every tensor with
 * no scales, biases and norms too (its text embedding's bias 99% off, the audio cross-attention's 50-60%).
 */
const HUMO_MXFP8 = "humo_17B_mxfp8_crackio.safetensors";
const humoKnown = new Map<string, Promise<string>>();
function humoModel(target: ComfyTarget) {
  let file = humoKnown.get(target.url);
  if (!file) {
    file = askBridge<string[]>(target, "/models/diffusion_models", { timeoutMs: 15_000 }).then(
      (list) => (Array.isArray(list) && list.includes(HUMO_MXFP8) ? HUMO_MXFP8 : HUMO_FILES.model),
      () => HUMO_FILES.model,
    );
    humoKnown.set(target.url, file);
    // Not there (yet): asked again next time.
    void file.then((f) => void (f === HUMO_MXFP8 || humoKnown.delete(target.url)));
  }
  return file;
}

/** Whether a ComfyUI has ComfyUI's INT8 attention (ModelAttentionBackend's comfy-kitchen one, NVIDIA and AMD). */
const int8Known = new Map<string, Promise<boolean>>();
function int8Attention(target: ComfyTarget) {
  let has = int8Known.get(target.url);
  if (!has) {
    has = askBridge<{ ModelAttentionBackend?: { input?: { required?: { attention?: [string[] | string, { options?: string[] }?] } } } }>(target, "/object_info/ModelAttentionBackend", { timeoutMs: 15_000 }).then((j) => {
      const a = j?.ModelAttentionBackend?.input?.required?.attention;
      const options = Array.isArray(a?.[0]) ? a[0] : (a?.[1]?.options ?? []);
      return options.includes("comfy kitchen attention");
    });
    int8Known.set(target.url, has);
    // A no (an older ComfyUI, or one restarting) is asked again next time.
    void has.then((yes) => void (yes || int8Known.delete(target.url)));
  }
  return has;
}

/**
 * Bridge 1.10.2's finer drawing (2026-11-03, the "Green tee UGC" woman's take, one change at a time against the clip the
 * user picked): a window 1.5x the face instead of 1.9x, always drawn at 832 (her face 1.46x bigger than in the clip,
 * shrunk back when pasted), so HuMo has more pixels for the teeth and lips (individual teeth instead of a white bar, her
 * own lip shape, LatentSync's crease down the lips gone; sync 0.74); denoise 0.42 (more of HuMo, less of LatentSync's
 * crease); Wan's own negative prompt (the one HuMo was made with) and the mouth's own words (sync 0.71 against 0.66);
 * 6 steps, which look like 8 (detail 0.85 against 0.86) in a quarter less time. With the bridge's new paste (one bicubic
 * resampling instead of a bilinear one): fine detail 0.87 of her real mouth's against 0.83, 260 s of drawing a window.
 * Not taken: cfg on the first steps only (24% faster, the teeth go back to a bar), LatentSync at 12 steps (15 s saved,
 * worse sync), a 2x VAE decoder (spacepxl's image-only one breaks every video frame after the first).
 * Bridge 1.10.3, area "lips" (2026-11-03, two more of Crackio's faces, fixed inputs): on the "Capsules UGC" woman (a
 * 954 px face) HuMo gave the skin round the mouth a stubble-like band and pits whatever the prompt, precision, drawing
 * size, window, negative or cfg; LatentSync's own skin there is clean. Taking only HuMo's lips and mouth opening, on
 * LatentSync's frames, keeps HuMo's teeth and lips without it, and lifts sync (0.84 against 0.79 on her, 0.82 against
 * 0.65 on the "Green tee UGC" woman, whose look stays clip 5's; 0.80 on the "Serum UGC" woman's long line, her own 0.80).
 */
const FINE = {
  area: "lips" as "mouth" | "lips",
  scale: 1.5,
  size: 832,
  denoise: 0.42,
  steps: 6,
  prompt: "a person is speaking to the camera, close-up, natural lips and clearly defined teeth, detailed skin texture, sharp focus.",
  negative:
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走，blurry, distorted mouth, deformed teeth, smeared lips",
};

/**
 * Best quality's nodes, after the Lip Sync node (`lip`): HuMo (with the speed LoRA when asked) redraws the face window
 * lightly over LatentSync's mouths, hearing the new words and looking at the person's own most-open-mouth frame, and
 * CrackioMouthRefine puts only the mouth back and saves the patches. Span frames are the window's own. `int8`: ComfyUI's
 * INT8 attention, 1.6x faster for the same look (lips SSIM 0.96 to PyTorch's at 8 steps, 333 s instead of 530 on the 5090).
 * `fine`: the machine's bridge draws finer (1.10.2, FINE); an older one gets the drawing it was made with.
 */
function refineNodes(r: LipsyncRefine, fps: number, spanStart: number, spanEnd: number, int8: boolean, fine = false, humo: string = HUMO_FILES.model, lipsOnly = false): Graph {
  const g: Graph = {
    humo: { class_type: "UNETLoader", inputs: { unet_name: humo, weight_dtype: "default" } },
    humoVae: { class_type: "VAELoader", inputs: { vae_name: HUMO_FILES.vae } },
    humoText: { class_type: "CLIPLoader", inputs: { clip_name: HUMO_FILES.text, type: "wan", device: "default" } },
    humoSay: { class_type: "CLIPTextEncode", inputs: { text: r.prompt?.trim() || (fine ? FINE.prompt : "a person is speaking to the camera, natural lips and teeth, sharp detail."), clip: ["humoText", 0] } },
    humoAvoid: { class_type: "CLIPTextEncode", inputs: { text: r.negative?.trim() || (fine ? FINE.negative : "blurry, distorted mouth, deformed teeth, smeared lips"), clip: ["humoText", 0] } },
    humoEar: { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: HUMO_FILES.whisper } },
  };
  let model: [string, number] = ["humo", 0];
  if (r.lora) {
    g.humoFast = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: r.lora, strength_model: 1 } };
    model = ["humoFast", 0];
  }
  if (int8) {
    g.humoAttention = { class_type: "ModelAttentionBackend", inputs: { model, attention: "comfy kitchen attention" } };
    model = ["humoAttention", 0];
  }
  g.humoShift = { class_type: "ModelSamplingSD3", inputs: { model, shift: 5 } };
  g.refine = {
    class_type: "CrackioMouthRefine",
    inputs: {
      model: ["humoShift", 0],
      vae: ["humoVae", 0],
      positive: ["humoSay", 0],
      negative: ["humoAvoid", 0],
      audio_encoder: ["humoEar", 0],
      images: ["lip", 0],
      video: ["clip", 0],
      audio: ["words", 0],
      original_audio: ["was", 0],
      fps,
      span_start: spanStart,
      span_end: spanEnd,
      denoise: r.denoise ?? (fine ? FINE.denoise : 0.35),
      // 8 look like 20 (lips SSIM 0.95 to the 20-step take, 2026-11-03) in 9 minutes instead of 21; 6 like 8.
      steps: Math.max(1, Math.min(60, Math.round(r.steps ?? (fine ? FINE.steps : 8)))),
      cfg: r.cfg ?? (r.lora ? 1 : 5),
      sampler_name: r.sampler ?? (r.lora ? "lcm" : "euler"),
      scheduler: "simple",
      seed: 11,
      size: r.size ?? 832,
      fade: 4,
      check: true,
      patch_prefix: "crackio/lipsync",
      // Only to a bridge that has them (1.10.2): an older one would refuse the inputs.
      ...(fine ? { scale: r.scale ?? FINE.scale, upscale: r.upscale ?? true, ...(r.guided ? { guided_steps: Math.round(r.guided) } : {}) } : {}),
      // 1.10.3: only HuMo's lips and the mouth's opening, on LatentSync's frames.
      ...(lipsOnly ? { area: r.area ?? FINE.area } : {}),
    },
  };
  return g;
}

/** A stretch's window cut out of the clip (its frames ws..we-1 exactly, as a high-quality MP4) and its new and old sound, sent to the machine. */
async function sendWindow(target: ComfyTarget, src: string, sound: string, original: string, ws: number, we: number, fps: number, dir: string, tag: string, nonce: string, signal: AbortSignal): Promise<Sent> {
  // Tagged with the take, so no other take's upload is the same file (uploads are shared by content, and these go when the take ends).
  const mark = ["-metadata", `comment=crackio-lipsync-${nonce}`];
  const clip = path.join(dir, `window-${tag}.mp4`);
  // The first video stream only (a clip may carry a cover picture as a second one), its frames ws..we-1 exactly.
  const res = await runFfmpeg(
    ["-hide_banner", "-y", "-i", src, "-map", "0:v:0", "-vf", `select='between(n\\,${ws}\\,${we - 1})',setpts=N/(${fps}*TB)`, "-fps_mode", "passthrough", "-an", "-c:v", "libx264", "-crf", "10", "-preset", "medium", "-pix_fmt", "yuv420p", ...mark, clip],
    { signal, timeoutMs: 600_000 },
  );
  if (res.code !== 0) throw new EngineError("Couldn't cut the stretch out of the clip.", res.stderr.trim().split("\n").slice(-1)[0] ?? "");
  const slice = async (from: string, name: string) => {
    const file = path.join(dir, name);
    const r = await runFfmpeg(["-hide_banner", "-y", "-ss", (ws / fps).toFixed(4), "-t", ((we - ws) / fps).toFixed(4), "-i", from, "-c:a", "pcm_s16le", ...mark, file], { signal, timeoutMs: 60_000 });
    if (r.code !== 0) throw new EngineError("Couldn't cut the sound for the stretch.", "Try again.");
    return file;
  };
  const [newSound, oldSound] = await Promise.all([slice(sound, `window-${tag}-new.wav`), slice(original, `window-${tag}-old.wav`)]);
  const [v, a, o] = await withTarget(target, () => Promise.all([uploadFile(clip, signal, "lipsync"), uploadFile(newSound, signal, "lipsync"), uploadFile(oldSound, signal, "lipsync")]));
  return { video: v.name, words: a.name, was: o.name };
}

type Patch = { x: number; y: number; w: number; h: number; png: Buffer; matrix: "bt709" | "bt601" };

/** The clip's pixel format and colour tags, as ffmpeg reads them ("yuv420p(tv, bt709/bt709/iec61966-2-1, progressive)"). */
async function colourOf(src: string, signal: AbortSignal) {
  const res = await runFfmpeg(["-hide_banner", "-i", src], { signal, timeoutMs: 30_000 });
  const line = res.stderr.split("\n").find((l) => /Stream #0:\d+.*Video:/.test(l)) ?? "";
  const m = /Video: [^,]+, (\w+)(?:\(([^)]*)\))?/.exec(line);
  const parts = (m?.[2] ?? "").split(",").map((x) => x.trim());
  const range = parts.includes("pc") ? "pc" : "tv";
  const tag = parts.find((x) => /^(bt|smpte|iec|gbr|fcc|ycgco|linear|log)/.test(x));
  const [space, primaries, trc] = tag ? (tag.includes("/") ? tag.split("/") : [tag, tag, tag]) : [];
  return { fmt: m?.[1] ?? "yuv420p", range, space, primaries, trc };
}

/** Full-range RGB to limited-range YUV with the matrix the node read the clip with. */
function yuvOf(matrix: Patch["matrix"]) {
  const [kr, kb] = matrix === "bt601" ? [0.299, 0.114] : [0.2126, 0.0722];
  const kg = 1 - kr - kb;
  return (r: number, g: number, b: number) => {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    const y = kr * R + kg * G + kb * B;
    return [16 + 219 * y, 128 + 224 * ((B - y) / (2 * (1 - kb))), 128 + 224 * ((R - y) / (2 * (1 - kr)))];
  };
}

/**
 * The clip decoded frame by frame in its own YUV (4:2:0), each stretch's patches written onto exactly their frames
 * (only their opaque pixels, what the node changed: their luma, and the chroma of the 2×2 blocks they touch), and
 * encoded once at high quality (CRF 10) with the new soundtrack and the clip's own colour tags. Nothing else is ever
 * turned into RGB and back.
 */
async function compose(src: string, sound: string, out: string, a: LipAnalysis, patches: Map<number, Patch>, signal: AbortSignal) {
  const { width, height, fps } = a;
  if (width % 2 || height % 2) throw new EngineError("Lip Sync needs a clip whose width and height are even numbers.", "Re-export the clip at an even size.");
  const colour = await colourOf(src, signal);
  const ySize = width * height;
  const cw = width / 2;
  const cSize = cw * (height / 2);
  const size = ySize + 2 * cSize;
  const raw = new Map<number, { x: number; y: number; w: number; h: number; rgba: Buffer; matrix: Patch["matrix"] }>();
  for (const [frame, p] of patches) {
    const { data, info } = await sharp(p.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    raw.set(frame, { x: p.x, y: p.y, w: info.width, h: info.height, rgba: data, matrix: p.matrix });
  }
  const dec = spawn(/*turbopackIgnore: true*/ ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-"], { windowsHide: true });
  const tags = ["-color_range", colour.range, ...(colour.space ? ["-colorspace", colour.space] : []), ...(colour.primaries ? ["-color_primaries", colour.primaries] : []), ...(colour.trc ? ["-color_trc", colour.trc] : [])];
  const enc = spawn(
    /*turbopackIgnore: true*/ ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "-s",
      `${width}x${height}`,
      "-r",
      String(fps),
      ...tags,
      "-i",
      "-",
      "-i",
      sound,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-crf",
      "10",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      ...tags,
      // The sound padded to the video's end: a clip's sound often ends a frame or two before its video.
      "-af",
      "apad",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      out,
    ],
    { windowsHide: true },
  );
  const kill = () => {
    dec.kill("SIGKILL");
    enc.kill("SIGKILL");
  };
  signal.addEventListener("abort", kill, { once: true });
  let encErr = "";
  enc.stderr.on("data", (c: Buffer) => (encErr = (encErr + c.toString()).slice(-4000)));
  let decErr = "";
  dec.stderr.on("data", (c: Buffer) => (decErr = (decErr + c.toString()).slice(-4000)));
  const done = new Promise<void>((resolve, reject) => {
    enc.on("close", (code) => (code === 0 ? resolve() : reject(new EngineError("Couldn't put the video together.", encErr.trim().split("\n").slice(-1)[0] ?? ""))));
    enc.on("error", reject);
  });
  let frame = 0;
  let pending: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        const img = Buffer.from(pending.subarray(0, size));
        pending = pending.subarray(size);
        const p = raw.get(frame);
        if (p) paste(img, p, width, height, ySize, cSize, cw);
        frame++;
        if (!enc.stdin.write(img)) await new Promise((r) => enc.stdin.once("drain", r));
      }
    }
    enc.stdin.end();
    await done;
  } catch (err) {
    kill();
    throw err;
  } finally {
    signal.removeEventListener("abort", kill);
  }
  if (frame === 0) throw new EngineError("Couldn't read the clip's frames.", decErr.trim().split("\n").slice(-1)[0] ?? "");
}

/** A patch onto a YUV 4:2:0 frame: luma where it changed; each touched 2×2 block's chroma averaged from its changed pixels' and the block's own. */
function paste(img: Buffer, p: { x: number; y: number; w: number; h: number; rgba: Buffer; matrix: Patch["matrix"] }, width: number, height: number, ySize: number, cSize: number, cw: number) {
  const toYuv = yuvOf(p.matrix);
  const blocks = new Map<number, { u: number; v: number; n: number }>();
  for (let y = 0; y < p.h; y++) {
    const fy = p.y + y;
    if (fy < 0 || fy >= height) continue;
    for (let x = 0; x < p.w; x++) {
      const s = (y * p.w + x) * 4;
      if (p.rgba[s + 3] !== 255) continue;
      const fx = p.x + x;
      if (fx < 0 || fx >= width) continue;
      const [Y, U, V] = toYuv(p.rgba[s], p.rgba[s + 1], p.rgba[s + 2]);
      img[fy * width + fx] = Math.max(0, Math.min(255, Math.round(Y)));
      const b = (fy >> 1) * cw + (fx >> 1);
      const acc = blocks.get(b) ?? { u: 0, v: 0, n: 0 };
      acc.u += U;
      acc.v += V;
      acc.n++;
      blocks.set(b, acc);
    }
  }
  for (const [b, acc] of blocks) {
    const keep = 4 - Math.min(4, acc.n);
    img[ySize + b] = Math.max(0, Math.min(255, Math.round((acc.u + img[ySize + b] * keep) / (acc.n + keep))));
    img[ySize + cSize + b] = Math.max(0, Math.min(255, Math.round((acc.v + img[ySize + cSize + b] * keep) / (acc.n + keep))));
  }
}
