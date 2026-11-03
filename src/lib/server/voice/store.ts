import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { DATA_DIR, MEDIA_DIR } from "../paths";
import { writeFileAtomic } from "../atomic-write";
import { READY_VOICES } from "@/lib/voice/ready";
import type { VoiceCard } from "@/lib/voice/types";

/**
 * Your voices: clones and designs, each a short clip (data/media/voices/<id>.wav) with exactly what it says. Crackio's
 * ready voices ship with the app (lib/voice/ready, public/assets/voices).
 */

const FILE = path.join(DATA_DIR, "voices.json");
export const VOICES_DIR = path.join(MEDIA_DIR, "voices");
export const voiceUrl = (file: string) => `/api/media/out/voices/${file}`;

async function read(): Promise<VoiceCard[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as VoiceCard[];
  } catch {
    return [];
  }
}

export async function myVoices() {
  return (await read()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function allVoices() {
  return [...READY_VOICES, ...(await myVoices())];
}

export async function voiceById(id: string | null | undefined): Promise<VoiceCard | null> {
  if (!id) return null;
  return READY_VOICES.find((v) => v.id === id) ?? (await read()).find((v) => v.id === id) ?? null;
}

/** Orb colours for a new voice, picked from its name so the same name keeps its look. */
const PAIRS: [string, string][] = [
  ["#a9ea6a", "#2e5f1c"], ["#ffcf8a", "#c0582e"], ["#f7b2d0", "#8e3d7a"], ["#9fd3ff", "#2f4f9e"], ["#ffe08f", "#a8662a"], ["#c8b6ff", "#4d3b9a"], ["#8eead6", "#1d6b64"],
];
const huesFor = (name: string) => PAIRS[[...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PAIRS.length];

export async function addVoice(v: { name: string; desc?: string; text: string; sampleFile: string; source: "clone" | "design"; consent?: boolean; language?: string; tags?: string[] }) {
  const list = await read();
  const id = nanoid(10);
  const ext = path.extname(v.sampleFile) || ".wav";
  await fs.mkdir(VOICES_DIR, { recursive: true });
  const file = `${id}${ext}`;
  await fs.copyFile(v.sampleFile, path.join(VOICES_DIR, file));
  const card: VoiceCard = {
    id,
    name: v.name.trim().slice(0, 40) || "My voice",
    desc: (v.desc ?? (v.source === "clone" ? "Cloned from your clip" : "Designed from words")).trim().slice(0, 90),
    tags: v.tags ?? [v.source === "clone" ? "Clone" : "Designed"],
    hues: huesFor(v.name),
    source: v.source,
    sample: voiceUrl(file),
    text: v.text.trim(),
    preset: "F2",
    language: v.language,
    createdAt: Date.now(),
    ...(v.source === "clone" ? { consent: Boolean(v.consent) } : {}),
  };
  list.push(card);
  await writeFileAtomic(FILE, JSON.stringify(list, null, 1));
  return card;
}

export async function updateVoice(id: string, patch: Partial<Pick<VoiceCard, "name" | "desc" | "text">>) {
  const list = await read();
  const v = list.find((x) => x.id === id);
  if (!v) return null;
  if (patch.name?.trim()) v.name = patch.name.trim().slice(0, 40);
  if (patch.desc !== undefined) v.desc = patch.desc.trim().slice(0, 90);
  if (patch.text?.trim()) v.text = patch.text.trim();
  await writeFileAtomic(FILE, JSON.stringify(list, null, 1));
  return v;
}

export async function removeVoice(id: string) {
  const list = await read();
  const v = list.find((x) => x.id === id);
  if (!v) return false;
  await writeFileAtomic(FILE, JSON.stringify(list.filter((x) => x.id !== id), null, 1));
  await fs.rm(path.join(VOICES_DIR, path.basename(v.sample)), { force: true });
  return true;
}

/** A scratch clip (an upload, a recording, a design option) on its way to becoming a voice. */
export const scratchDir = path.join(VOICES_DIR, "scratch");
export const scratchUrl = (file: string) => voiceUrl(`scratch/${file}`);
export async function scratchPath(name: string) {
  await fs.mkdir(scratchDir, { recursive: true });
  return path.join(scratchDir, name);
}
