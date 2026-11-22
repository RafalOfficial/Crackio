import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { withTarget, type ComfyTarget } from "../comfy-targets";
import { urlToPath } from "../media";
import { machineFor } from "./machines";
import { machineWith } from "./setup";
import { voiceById } from "./store";
import { toWav } from "./audio";
// The registry loads comfy-local whole first (see server/voice/setup).
import "@/lib/engines/refine";
import { uploadFile } from "@/lib/engines/comfy-local";
import { lfm3Chat } from "@/lib/engines/comfy-text";
import { LFM3_NAME } from "@/lib/local/lfm3";
import { voiceModel, type VoiceModelId } from "@/lib/voice/models";
import { forModel } from "@/lib/voice/script";

/**
 * One turn of a live conversation (Voice's Talk): what someone just said, heard (Qwen3-ASR on the bridge's own route,
 * outside ComfyUI's queue), answered by LFM3-VL as it writes (lfm3Chat), and each sentence of the answer spoken the moment
 * it's complete (the voice model on the bridge's /crackio/voice/say), so the first words play while the rest is still
 * being written. Everything stops when the signal does: someone talking over it aborts the turn.
 */

export type TalkTurn = { role: "user" | "assistant"; text: string };
export type TalkEvent =
  | { type: "heard"; text: string; ms: number }
  | { type: "text"; soFar: string }
  | { type: "audio"; i: number; text: string; wav: string; ms: number }
  | { type: "done"; reply: string; ms: number }
  | { type: "error"; error: string };

export class TalkError extends Error {}

type Machine = NonNullable<Awaited<ReturnType<typeof machineFor>>>;
/** Where a model's turns go: the machine that speaks it and the one that hears. */
type Route = { speech: Machine; hearing: ComfyTarget; at: number };

/**
 * A voice's reference on a machine, sent once (by machine and voice), and each model's route, kept for a while: finding
 * the machines asks every one of them, and one that's switched off takes seconds to give up. One server process: Maps on
 * globalThis.
 */
const g = globalThis as unknown as { __crackioTalkRefs?: Map<string, { name: string; text: string }>; __crackioTalkRoutes?: Map<VoiceModelId, Route> };
const refs = (g.__crackioTalkRefs ??= new Map());
const routes = (g.__crackioTalkRoutes ??= new Map());
const ROUTE_MS = 5 * 60_000;

async function routeFor(model: VoiceModelId, name: string): Promise<Route> {
  const hit = routes.get(model);
  if (hit && Date.now() - hit.at < ROUTE_MS) return hit;
  const speech = await machineFor(model);
  if (!speech) throw new TalkError(`${name} isn't on any of your GPUs yet: get it under Voice models.`);
  const hearing = speech.machine.hearing ? speech : await machineWith((m) => m.hearing);
  if (!hearing?.target) throw new TalkError("Talking needs speech to text (Qwen3-ASR): install it from Voice.");
  const route = { speech, hearing: hearing.target, at: Date.now() };
  routes.set(model, route);
  return route;
}

/** Words that make a voice's name a description ("Deep narrator", "My voice"), not someone to be. */
const DESCRIBES = /\b(narrator|voice|announcer|speaker|presenter|host|robot|clone|sample|recording|take|test|deep|soft|warm|old|young|man|woman|girl|boy|guy|lady|kid|my|the)\b/i;

/** A voice's name when it's a person's ("Mara", "Lena", "Mary Jane"): LFM3 answers as them (lfm3Chat's `name`). */
function personaOf(name?: string) {
  const n = (name ?? "").trim();
  if (n.length < 2 || n.length > 24 || DESCRIBES.test(n)) return undefined;
  return /^\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*)?$/u.test(n) ? n : undefined;
}

/** A machine that stopped answering: the next turn looks for the machines again. */
function forget(model: VoiceModelId) {
  routes.delete(model);
}

/** A sentence is spoken once it's closed (its end mark and the start of what follows), or at a comma past this many characters. */
const LONG = 110;
/** An answer's first piece goes at its first comma past this many characters: the voice starts while the rest is made. */
const FIRST = 36;
/** Pieces shorter than this wait to go with the next sentence. */
const SHORT = 16;

async function bridge(target: ComfyTarget, route: string, body: unknown, signal: AbortSignal) {
  return fetch(`${target.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
}

async function referenceOf(target: ComfyTarget, voiceId: string, signal: AbortSignal) {
  const key = `${target.id}|${voiceId}`;
  const have = refs.get(key);
  if (have) return have;
  const v = await voiceById(voiceId);
  if (!v) throw new TalkError("That voice is gone: pick another one.");
  const sample = urlToPath(v.sample);
  if (!sample) throw new TalkError(`${v.name}'s sample is missing.`);
  const wav = path.join(/*turbopackIgnore: true*/ os.tmpdir(), `crackio-talk-${nanoid(8)}.wav`);
  try {
    await toWav(sample, wav, { rate: 24000, signal });
    const up = await withTarget(target, () => uploadFile(wav, signal, "voice"));
    const ref = { name: up.name, text: v.text };
    refs.set(key, ref);
    return ref;
  } finally {
    await fs.rm(/*turbopackIgnore: true*/ wav, { force: true }).catch(() => {});
  }
}

/** The sentences closed so far in `text` from `from` on: their ends (indexes into text). */
function closedSentences(text: string, from: number, final: boolean) {
  const ends: number[] = [];
  const re = /[.!?…]+["'”’)\]]*(?=\s)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  let last = from;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    // A short sentence ("Congrats!", "Oh.") waits for the next one: one natural take instead of two clipped ones (the
    // end of the answer takes whatever is left).
    if (end - last >= SHORT) {
      ends.push(end);
      last = end;
    }
  }
  // A long run with no end yet goes at its last comma, so a long first sentence doesn't hold the voice back.
  if (!final && from === 0 && !ends.length) {
    const comma = text.indexOf(", ", FIRST);
    if (comma > 0) ends.push(comma + 1);
  }
  if (!final && text.length - last > LONG) {
    const comma = text.lastIndexOf(", ", text.length - 1);
    if (comma > last + 30) ends.push(comma + 1);
  }
  if (final && text.trim().length > last && text.slice(last).trim()) ends.push(text.length);
  return ends;
}

export async function talkTurn(
  input: { audio: string; history: TalkTurn[]; voice: string; model: VoiceModelId; language?: string },
  emit: (e: TalkEvent) => void,
  signal: AbortSignal,
) {
  const t0 = Date.now();
  const model = voiceModel(input.model);
  if (!model) throw new TalkError("Unknown voice model.");
  const { speech, hearing } = await routeFor(model.id, model.name);

  // 1. What they said.
  const heardRes = await bridge(hearing, "/crackio/voice/hear", { audio: input.audio, language: input.language ?? "" }, signal).catch((err: Error) => {
    if (!signal.aborted) forget(model.id);
    throw err;
  });
  const heardJson = (await heardRes.json().catch(() => ({}))) as { text?: string; ms?: number; error?: string };
  if (heardRes.status === 404) throw new TalkError("This GPU's Crackio bridge is too old for Talk (needs 1.9.1): restart its ComfyUI from Crackio.");
  if (!heardRes.ok) throw new TalkError(`Couldn't hear you: ${heardJson.error ?? heardRes.status}`);
  const heard = (heardJson.text ?? "").trim();
  emit({ type: "heard", text: heard, ms: heardJson.ms ?? 0 });
  if (!heard) {
    emit({ type: "done", reply: "", ms: Date.now() - t0 });
    return;
  }

  // 2. The answer, spoken sentence by sentence as it's written.
  const variant = model.variants.find((v) => speech.machine.files.includes(v.file.name)) ?? model.variants[0];
  const ref = model.can.clone ? await referenceOf(speech.target, input.voice, signal) : null;
  const card = await voiceById(input.voice);
  const voice = !model.can.clone ? (card?.preset ?? "") : "";
  let spoken = 0;
  let index = 0;
  let queue: Promise<void> = Promise.resolve();
  const say = (sentence: string) => {
    const i = index++;
    queue = queue.then(async () => {
      if (signal.aborted) return;
      const s0 = Date.now();
      const res = await bridge(speech.target, "/crackio/voice/say", { model: variant.file.name, text: forModel(model.id, sentence, ""), ...(ref ? { ref: ref.name, ref_text: ref.text } : { preset: voice }) }, signal).catch((err: Error) => {
        if (!signal.aborted) forget(model.id);
        throw err;
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new TalkError(`Couldn't say it: ${j.error ?? res.status}`);
      }
      const wav = Buffer.from(await res.arrayBuffer()).toString("base64");
      emit({ type: "audio", i, text: sentence, wav, ms: Date.now() - s0 });
    });
  };
  const take = (text: string, final: boolean) => {
    for (const end of closedSentences(text, spoken, final)) {
      const sentence = text.slice(spoken, end).trim();
      spoken = end;
      if (sentence) say(sentence);
    }
  };
  let written = "";
  const reply = await lfm3Chat({
    history: [...input.history.slice(-24), { role: "user", text: heard }],
    name: personaOf(card?.name),
    onText: (soFar) => {
      written = soFar;
      emit({ type: "text", soFar });
      take(soFar, false);
    },
    signal,
  }).catch((err: Error) => {
    // Nothing to write the answers with yet: the line under Talk sets it up.
    if (/isn't on any of your ComfyUIs/.test(err.message)) throw new TalkError(`${LFM3_NAME} writes Talk's answers and isn't on your GPUs yet: set it up under Talk.`);
    throw err;
  });
  // The rest, from the text as it streamed (the indexes are into it); the whole answer when nothing streamed.
  take(written || reply, true);
  await queue;
  emit({ type: "done", reply: reply.trim(), ms: Date.now() - t0 });
}

/** Half a second of silence, 16 kHz: what wakes speech to text without anything to hear. */
function silence() {
  const n = 8000;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf.toString("base64");
}

/**
 * Talk's first moment: when someone presses Talk, the machines are found, the voice's reference sent, and all three models
 * woken at once (speech to text on silence, LFM3 on a one-word answer, the voice on a short line), so the first thing they
 * say is answered as fast as the rest instead of waiting for models to load. Errors are the turn's to report.
 */
export async function talkWarm(input: { voice: string; model: VoiceModelId }, signal: AbortSignal) {
  const t0 = Date.now();
  const model = voiceModel(input.model);
  if (!model) throw new TalkError("Unknown voice model.");
  const { speech, hearing } = await routeFor(model.id, model.name);
  const variant = model.variants.find((v) => speech.machine.files.includes(v.file.name)) ?? model.variants[0];
  const ref = model.can.clone ? await referenceOf(speech.target, input.voice, signal) : null;
  const card = await voiceById(input.voice);
  const preset = !model.can.clone ? (card?.preset ?? "") : "";
  const woke = await Promise.allSettled([
    bridge(hearing, "/crackio/voice/hear", { audio: silence() }, signal).then((r) => r.ok),
    lfm3Chat({ history: [{ role: "user", text: "Hi!" }], name: personaOf(card?.name), maxTokens: 2, signal }).then(() => true),
    bridge(speech.target, "/crackio/voice/say", { model: variant.file.name, text: forModel(model.id, "Hi.", ""), ...(ref ? { ref: ref.name, ref_text: ref.text } : { preset }) }, signal).then((r) => r.ok),
  ]);
  return { ms: Date.now() - t0, ok: woke.map((w) => w.status === "fulfilled" && w.value) };
}
