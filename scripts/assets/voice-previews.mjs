#!/usr/bin/env node
// Makes the takes behind Voice's ▶ buttons (components/voice/ComposerPanels.tsx): Mara, one of Crackio's own voices,
// saying a short line with each sound, each way of saying words, and in each mood. Fish Audio Drama 3 makes them
// through the Crackio bridge's Voice node, in one ComfyUI job, and Qwen3-ASR hears each one back, so a tag the model
// read out loud instead of acting shows up in the log. Needs a ComfyUI with Drama 3 on it (Voice models → Get it).
//
// Writes
//   public/assets/voice/previews/<id>.mp3
//
// Usage: node scripts/assets/voice-previews.mjs <ComfyUI url> [id …]
//   e.g. node scripts/assets/voice-previews.mjs http://127.0.0.1:8188 mood-calm sound-laughs
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(root, "public/assets/voice/previews");

const COMFY = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(COMFY)) {
  console.error("Usage: node scripts/assets/voice-previews.mjs <ComfyUI url> [id …]");
  process.exit(1);
}
const MODEL = "drama-3-backbone-8bit-experts-Q4_K_S.gguf";
// Mara's clip and what it says (lib/voice/ready.ts).
const VOICE = path.join(root, "public/assets/voices/mara.mp3");
const VOICE_TEXT = "Hello, and welcome. Let me tell you a short story about a small town by the sea, where every evening the lights came on one by one.";
const MOOD_LINE = "I didn't think you'd come back. But here you are.";

/** id → [how it's said, or "", the script]. Moods use the directions in ComposerPanels' MOODS. */
const TAKES = {
  "sound-laughs": ["", "[laughs] Okay, okay, that was actually funny."],
  "sound-chuckles": ["", "[chuckles] You're not wrong, you know."],
  "sound-sighs": ["", "[sighs] Fine. I'll do it myself."],
  "sound-gasps": ["", "[gasps] Wait. Is that for me?"],
  "sound-breath": ["", "[breath] Okay. Here we go."],
  "sound-pause": ["", "Three, two, one. [pause] Go."],
  "span-whisper": ["", "<whisper>Don't tell anyone, okay?</whisper>"],
  "span-slow": ["", "<slow>Take your time.</slow> There's no rush."],
  "span-emphasis": ["", "I said <emphasis>now</emphasis>, not later."],
  "mood-calm": ["Calm and even, no rush", MOOD_LINE],
  "mood-warm": ["Warm and close, like talking to a friend", MOOD_LINE],
  "mood-excited": ["Excited, can barely wait to say it", MOOD_LINE],
  "mood-serious": ["Serious and steady, every word matters", MOOD_LINE],
  "mood-sad": ["Quiet and sad, holding it together", MOOD_LINE],
  "mood-storyteller": ["A storyteller by the fire, taking their time", MOOD_LINE],
  "mood-playful": ["Playful and teasing, a smile in every word", MOOD_LINE],
  "mood-announcer": ["A confident announcer, big and clear", MOOD_LINE],
};

const only = process.argv.slice(3);
const ids = Object.keys(TAKES).filter((id) => !only.length || only.includes(id));

async function api(p, init) {
  const res = await fetch(`${COMFY}${p}`, init);
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 600));
  return res;
}

// Mara's clip as the WAV the Voice node takes.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-previews-"));
const wav = path.join(tmp, "mara-preview-voice.wav");
execFileSync(ffmpeg, ["-v", "error", "-y", "-i", VOICE, "-ac", "1", "-ar", "24000", wav]);
const form = new FormData();
form.append("image", new Blob([await fs.readFile(wav)]), "mara-preview-voice.wav");
form.append("overwrite", "true");
const uploaded = await (await api("/upload/image", { method: "POST", body: form })).json();

// One job: every take, then speech to text on each.
const graph = { voice: { class_type: "LoadAudio", inputs: { audio: uploaded.name } } };
for (const id of ids) {
  const [how, script] = TAKES[id];
  graph[`say-${id}`] = {
    class_type: "CrackioVoice",
    inputs: { model: MODEL, text: `${how ? `[${how}] ` : ""}${script}`, seed: 7, temperature: 0, speed: 1, preset: "", voice_1: ["voice", 0], voice_1_text: VOICE_TEXT },
  };
  graph[`save-${id}`] = { class_type: "SaveAudio", inputs: { audio: [`say-${id}`, 0], filename_prefix: `crackio/preview-${id}` } };
  graph[`hear-${id}`] = { class_type: "CrackioTranscribe", inputs: { audio: [`say-${id}`, 0], text: "", language: "en" } };
  graph[`heard-${id}`] = { class_type: "CrackioSaveText", inputs: { text: [`hear-${id}`, 0], filename_prefix: `crackio/preview-${id}-heard` } };
}
const { prompt_id: job } = await (await api("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) })).json();
console.log(`job ${job}: ${ids.length} takes`);

let done;
for (const t0 = Date.now(); !done; ) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = (await (await api(`/history/${job}`)).json())[job];
  if (h?.status?.status_str === "error") throw new Error(JSON.stringify(h.status.messages).slice(0, 2000));
  if (h?.status?.completed) done = h;
  if (Date.now() - t0 > 20 * 60_000) throw new Error("Gave up after 20 minutes.");
}

await fs.mkdir(out, { recursive: true });
const view = (f) => api(`/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "output"}`);
for (const id of ids) {
  const sound = done.outputs[`save-${id}`]?.audio?.[0];
  const heard = done.outputs[`heard-${id}`]?.text?.[0];
  if (!sound) {
    console.log(`${id}: no sound`);
    continue;
  }
  const raw = path.join(tmp, `${id}${path.extname(sound.filename)}`);
  await fs.writeFile(raw, Buffer.from(await (await view(sound)).arrayBuffer()));
  // Trimmed of silence at both ends, small enough to load on a click.
  const trim = "silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.05";
  execFileSync(ffmpeg, ["-v", "error", "-y", "-i", raw, "-af", `${trim},areverse,${trim},areverse`, "-ac", "1", "-ar", "44100", "-b:a", "80k", "-map_metadata", "-1", path.join(out, `${id}.mp3`)]);
  const text = heard ? (await (await view(heard)).text()).trim() : "";
  const { size } = await fs.stat(path.join(out, `${id}.mp3`));
  console.log(`${id}  ${(size / 1024).toFixed(0)} KB  heard: ${text}`);
}
await fs.rm(tmp, { recursive: true, force: true });
