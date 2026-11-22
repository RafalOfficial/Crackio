import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { withTarget } from "../comfy-targets";
import { DATA_DIR } from "../paths";
import { urlToPath } from "../media";
// The registry loads comfy-local whole first (see setup.ts).
import "@/lib/engines/refine";
import { downloadOutput, runWorkflow, uploadFile } from "@/lib/engines/comfy-local";
import { EngineError, type EngineContext, type EngineOutput } from "@/lib/engines/types";
import { machineFor } from "./machines";
import { voiceById } from "./store";
import { peaksOf, toWav } from "./audio";
import { voiceModel, type VoiceModel } from "@/lib/voice/models";
import { forModel, missedShare, sceneForDrama, secondsOf, wordsOf, type SceneLine } from "@/lib/voice/script";
import type { Generation } from "@/lib/generations/types";
import type { VoiceAsk, VoiceCard, VoiceHeard } from "@/lib/voice/types";

/**
 * A Voice take: the script goes to the "Crackio Voice" node on the GPU that has the model (comfyui/crackio_bridge/voice.py,
 * audio.cpp underneath), with each voice's clip uploaded beside it, and comes back through ComfyUI's Save Audio. In the
 * same graph "Crackio Transcribe" times every word for the take's highlight, and hears the take back: a take that
 * skipped words is made once more on its own, since the Drama 3 port can drop a line after a laugh.
 */

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const TMP = path.join(/*turbopackIgnore: true*/ DATA_DIR, "cache", "voice");

/** A take that missed more than this share of the script's words is made again (once). */
const REDO_ABOVE = 0.3;

async function tmpFile(ext: string) {
  await fs.mkdir(/*turbopackIgnore: true*/ TMP, { recursive: true });
  return path.join(/*turbopackIgnore: true*/ TMP, `${nanoid(10)}${ext}`);
}

/** Lively, as the Drama 3 port's temperature: 0 keeps its own (natural). */
const temperatureFor = (model: VoiceModel, lively: number) => (model.id !== "local:voice:drama3" ? 0 : lively <= 0 ? 0.55 : lively >= 2 ? 0.95 : 0);

const langName = (code: string) => (code && code !== "auto" ? code : "en");

/**
 * The aligner times bare words ("Okay", "Last"); the take shows the script's own ("Okay.", "Last"), so each timing goes back
 * onto the script's word it belongs to, in order. A word it can't place keeps the aligner's spelling.
 */
function withPunctuation(script: string, words: VoiceHeard["words"]) {
  const bare = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}']/gu, "");
  const mine = script.split(/\s+/).filter(Boolean);
  let at = 0;
  return words.map((w) => {
    const want = bare(w.word);
    for (let k = at; k < Math.min(mine.length, at + 4); k++) {
      if (bare(mine[k]) === want) {
        at = k + 1;
        return { ...w, word: mine[k] };
      }
    }
    return w;
  });
}

export async function runVoice(gen: Generation, ctx: EngineContext): Promise<{ outputs: EngineOutput[]; heard: VoiceHeard; usedPrompt: string; model: string; modelName: string }> {
  const ask = gen.params?.voice as VoiceAsk | undefined;
  const model = voiceModel(ask?.model);
  if (!ask || !model) throw new EngineError("This take doesn't say which voice model to use.", "Pick a model and try again.");
  const place = await machineFor(model.id);
  if (!place) throw new EngineError(`${model.name} isn't on any of your GPUs yet.`, "Open Voice models and get it, then try again.");

  // Who speaks: one voice, or the cast in order for a conversation.
  const scene = Array.isArray(ask.lines) && ask.lines.length > 0;
  const ids = scene ? (ask.cast ?? []) : [ask.voice ?? ""];
  const voices: VoiceCard[] = [];
  for (const id of ids) {
    const v = await voiceById(id);
    if (!v) throw new EngineError("One of the voices is gone.", "Pick another voice.");
    voices.push(v);
  }

  ctx.progress(0.04, `Getting ${voices.map((v) => v.name).join(" and ")} ready on ${place.machine.gpu ?? place.machine.label}`);
  // Each voice's clip, as a clean WAV in that ComfyUI's input folder (models that can't clone use a voice of their own).
  const uploaded = model.can.clone
    ? await Promise.all(
        voices.map(async (v) => {
          const src = urlToPath(v.sample);
          if (!src) throw new EngineError(`${v.name}'s sample is missing.`, "Pick another voice.");
          const wav = await tmpFile(".wav");
          await toWav(src, wav, { rate: 24000, signal: ctx.signal });
          const up = await withTarget(place.target, () => uploadFile(wav, ctx.signal, "voice"));
          await fs.rm(/*turbopackIgnore: true*/ wav, { force: true });
          return up.name;
        }),
      )
    : [];

  const lines: SceneLine[] = scene ? (ask.lines ?? []).filter((l) => l.text.trim()) : [];
  const script = gen.prompt;
  const spoken = scene ? lines.map((l) => wordsOf(l.text)).join(" ") : wordsOf(script);
  const variant = model.variants.find((x) => place.machine.files.includes(x.file.name)) ?? model.variants[0];
  const temperature = temperatureFor(model, ask.lively);
  const speed = model.id === "local:voice:supertonic" ? Math.min(1.5, Math.max(0.7, ask.speed || 1)) : 1;

  const build = (seed: number) => {
    const graph: Graph = {};
    uploaded.forEach((name, i) => (graph[`ref${i + 1}`] = { class_type: "LoadAudio", inputs: { audio: name } }));
    const say = (key: string, text: string, who: number[]) => {
      const inputs: Record<string, unknown> = { model: variant.file.name, text, seed, temperature, speed, preset: model.can.clone ? "" : (voices[who[0]]?.preset ?? "F2") };
      who.forEach((w, k) => {
        if (!uploaded[w]) return;
        inputs[`voice_${k + 1}`] = [`ref${w + 1}`, 0];
        inputs[`voice_${k + 1}_text`] = voices[w].text;
      });
      graph[key] = { class_type: "CrackioVoice", inputs };
    };
    let out = "say";
    if (scene && model.can.scene) {
      // Drama 3 voices the whole scene in one pass: speaker N is the cast's Nth voice.
      say("say", sceneForDrama(lines, ask.direction), voices.map((_, i) => i));
    } else if (scene) {
      // Other models: line by line, joined in order.
      lines.forEach((l, i) => say(`line${i + 1}`, forModel(model.id, l.text, ask.direction), [Math.min(l.speaker, voices.length - 1)]));
      out = "line1";
      for (let i = 2; i <= lines.length; i++) {
        graph[`join${i}`] = { class_type: "AudioConcat", inputs: { audio1: [out, 0], audio2: [`line${i}`, 0], direction: "after" } };
        out = `join${i}`;
      }
    } else {
      say("say", forModel(model.id, script, ask.direction), [0]);
    }
    graph.save = { class_type: "SaveAudio", inputs: { audio: [out, 0], filename_prefix: "crackio/voice" } };
    if (place.machine.hearing) {
      graph.align = { class_type: "CrackioTranscribe", inputs: { audio: [out, 0], text: spoken, language: langName(ask.language) } };
      graph.words = { class_type: "CrackioSaveText", inputs: { text: ["align", 1], filename_prefix: "crackio/voice-words" } };
      graph.hear = { class_type: "CrackioTranscribe", inputs: { audio: [out, 0], text: "", language: ask.language && ask.language !== "auto" ? ask.language : "" } };
      graph.heard = { class_type: "CrackioSaveText", inputs: { text: ["hear", 0], filename_prefix: "crackio/voice-heard" } };
    }
    return graph;
  };

  const seconds = scene ? lines.reduce((s, l) => s + secondsOf(l.text), 0) : secondsOf(script);
  const perSecond = model.id === "local:voice:drama3" ? 700 : model.id === "local:voice:voxcpm2" ? 600 : 250;
  const expected = 6000 + seconds * perSecond * ((place.machine.gpuGb ?? 8) >= 24 ? 1 : 3);

  const take = async (seed: number) => {
    const run = () => withTarget(place.target, () => runWorkflow(build(seed), ctx, expected, `Voice · ${model.name}`));
    const { files } = await run().catch(async (err: unknown) => {
      // The voice engine (audio.cpp) is its own program: ComfyUI can't make room for it as it does for its own models. A
      // picture model or an upscaler the job before left in the card's memory can leave too little (found on a 24 GB
      // card after a SeedVR2 upscale). ComfyUI lets go of what it holds, and the take runs once more.
      const said = err instanceof Error ? `${err.message} ${err instanceof EngineError ? (err.hint ?? "") : ""}` : "";
      if (ctx.signal?.aborted || !/out of memory/i.test(said)) throw err;
      ctx.progress(0.05, "Making room on the GPU");
      await withTarget(place.target, () => import("../train/comfy").then((m) => m.postJson("/free", { unload_models: true, free_memory: true }, 10_000))).catch(() => null);
      return run();
    });
    const sound = files.find((f) => /\.(flac|wav|mp3|ogg|opus)$/i.test(f.filename));
    if (!sound) throw new EngineError("ComfyUI made no sound.", "Try again.");
    const [audio, words, heard] = await withTarget(place.target, () =>
      Promise.all([
        downloadOutput(sound, ctx.signal),
        files.find((f) => /voice-words/.test(f.filename)) ? downloadOutput(files.find((f) => /voice-words/.test(f.filename))!, ctx.signal) : null,
        files.find((f) => /voice-heard/.test(f.filename)) ? downloadOutput(files.find((f) => /voice-heard/.test(f.filename))!, ctx.signal) : null,
      ]),
    );
    const parsedWords = (() => {
      try {
        return words ? (JSON.parse(words.data.toString("utf8")) as VoiceHeard["words"]) : [];
      } catch {
        return [];
      }
    })();
    const heardText = heard?.data.toString("utf8").trim() ?? "";
    return { audio, words: withPunctuation(spoken, parsedWords), heard: heardText, missed: heard ? missedShare(spoken, heardText) : undefined, ext: path.extname(sound.filename) };
  };

  const firstSeed = ask.seed && ask.seed > 0 ? ask.seed : Math.floor(Math.random() * 2 ** 31);
  let result = await take(firstSeed);
  let redone = false;
  if (result.missed !== undefined && result.missed > REDO_ABOVE && !ctx.signal.aborted) {
    ctx.progress(0.6, "A few words were skipped: making it again");
    const again = await take(firstSeed + 1);
    if ((again.missed ?? 1) < (result.missed ?? 1)) result = again;
    redone = true;
  }

  // One WAV for the Library, players and downloads, and its waveform.
  const raw = await tmpFile(result.ext || ".flac");
  const wav = await tmpFile(".wav");
  try {
    await fs.writeFile(/*turbopackIgnore: true*/ raw, result.audio.data);
    await toWav(raw, wav, { rate: 44100, signal: ctx.signal });
    const [data, peaks] = await Promise.all([fs.readFile(/*turbopackIgnore: true*/ wav), peaksOf(wav)]);
    return {
      outputs: [{ data, mime: "audio/wav" }],
      heard: { words: result.words, peaks, heard: result.heard || undefined, missed: result.missed, ...(redone ? { redone } : {}) },
      usedPrompt: scene && model.can.scene ? sceneForDrama(lines, ask.direction) : scene ? lines.map((l) => l.text).join("\n") : forModel(model.id, script, ask.direction),
      model: model.id,
      modelName: `${model.name}${place.machine.gpu ? ` · ${place.machine.gpu}` : ""}`,
    };
  } finally {
    await Promise.all([fs.rm(/*turbopackIgnore: true*/ raw, { force: true }), fs.rm(/*turbopackIgnore: true*/ wav, { force: true })]);
  }
}
