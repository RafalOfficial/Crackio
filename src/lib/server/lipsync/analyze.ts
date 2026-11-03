import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { withTarget } from "../comfy-targets";
import { DATA_DIR } from "../paths";
import { urlToPath } from "../media";
// The registry loads comfy-local whole first (see server/voice/setup).
import "@/lib/engines/refine";
import { downloadOutput, uploadFile } from "@/lib/engines/comfy-local";
import { probe } from "@/lib/motion/ffmpeg";
import { toWav } from "../voice/audio";
import { machineWith, texts } from "../voice/setup";
import { sentencesOf } from "@/lib/lipsync/plan";
import type { LipAnalysis, LipWord } from "@/lib/lipsync/types";

/**
 * What a clip says and when: its sound heard by Qwen3-ASR on a GPU that has speech to text, then every word timed by
 * the forced aligner against what was heard, then cut into sentences. Kept by the clip's file, size and time, so a clip
 * is heard once.
 */

export const CACHE = path.join(DATA_DIR, "cache", "lipsync");

export class LipsyncError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

async function keyOf(file: string) {
  const st = await fs.stat(file);
  return crypto.createHash("sha1").update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
}

export async function analysisByKey(key: string): Promise<LipAnalysis | null> {
  if (!/^[0-9a-f]{16}$/.test(key)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE, `${key}.json`), "utf8")) as LipAnalysis;
  } catch {
    return null;
  }
}

export async function analyzeClip(url: string, signal: AbortSignal, fresh = false): Promise<LipAnalysis> {
  const file = urlToPath(url);
  if (!file || !(await fs.stat(file).catch(() => null))) throw new LipsyncError("Crackio can't find that clip.", 404);
  const key = await keyOf(file);
  if (!fresh) {
    const kept = await analysisByKey(key);
    if (kept) return kept;
  }
  const info = await probe(file);
  if (info.kind !== "video" || !info.width || !info.height || !info.duration) throw new LipsyncError("That isn't a video Crackio can read.");
  const base: LipAnalysis = {
    key,
    url,
    fps: info.fps ?? 24,
    width: info.width,
    height: info.height,
    duration: info.duration,
    audio: Boolean(info.audio),
    text: "",
    words: [],
    sentences: [],
  };
  if (info.audio) {
    const place = await machineWith((m) => m.hearing);
    if (!place?.target) throw new LipsyncError("Hearing what a clip says needs speech to text on one of your GPUs: get it under Voice models.", 409);
    await fs.mkdir(CACHE, { recursive: true });
    const wav = path.join(CACHE, `${nanoid(10)}.wav`);
    try {
      await toWav(file, wav, { rate: 16000, signal });
      const up = await withTarget(place.target, () => uploadFile(wav, signal, "lipsync"));
      const files = await texts(
        place.target,
        {
          clip: { class_type: "LoadAudio", inputs: { audio: up.name } },
          hear: { class_type: "CrackioTranscribe", inputs: { audio: ["clip", 0], text: "", language: "" } },
          // The aligner times what was heard, word by word.
          align: { class_type: "CrackioTranscribe", inputs: { audio: ["clip", 0], text: ["hear", 0], language: "" } },
          heard: { class_type: "CrackioSaveText", inputs: { text: ["hear", 0], filename_prefix: "crackio/lipsync-heard" } },
          timed: { class_type: "CrackioSaveText", inputs: { text: ["align", 1], filename_prefix: "crackio/lipsync-words" } },
        },
        "Lip Sync · hearing the clip",
        signal,
      );
      const get = async (re: RegExp) => {
        const f = files.find((x) => re.test(x.filename));
        return f ? (await withTarget(place.target!, () => downloadOutput(f, signal))).data.toString("utf8") : "";
      };
      const [heard, timed] = await Promise.all([get(/lipsync-heard/), get(/lipsync-words/)]);
      let words: LipWord[] = [];
      try {
        words = (JSON.parse(timed || "[]") as LipWord[]).filter((w) => w && typeof w.start === "number" && typeof w.end === "number");
      } catch {
        words = [];
      }
      const text = heard.trim();
      const cut = sentencesOf(text, words);
      Object.assign(base, { text, words: cut.words, sentences: cut.sentences });
    } finally {
      await fs.rm(wav, { force: true });
    }
  }
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(path.join(CACHE, `${key}.json`), JSON.stringify(base));
  return base;
}
