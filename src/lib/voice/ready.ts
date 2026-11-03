import type { VoiceCard } from "./types";

/**
 * Crackio's own voices, ready to use. Each was made from words alone with VoxCPM2 (Apache-2.0), never copied from a real
 * person: `design` is the description it was made from (seed 7 unless noted; Otto and Rook were remade until their pitch
 * matched a man's), the sample is what models clone,
 * and `preset` is Supertonic's closest voice of its own, for when it can't clone.
 */
export const READY_LINE = "Hello, and welcome. Let me tell you a short story about a small town by the sea, where every evening the lights came on one by one.";

type Ready = Omit<VoiceCard, "source" | "sample" | "text"> & { design: string; /** VoxCPM2's seed for it, when not 7. */ seed?: number };

const LIST: Ready[] = [
  { id: "mara", name: "Mara", desc: "Warm, low, unhurried", tags: ["Woman", "Narrator"], hues: ["#ffc07c", "#b8432e"], preset: "F2", design: "A woman in her thirties with a warm, low, slightly husky voice, calm and unhurried, like a late-night radio host" },
  { id: "juno", name: "Juno", desc: "Bright, quick, smiling", tags: ["Woman", "Social"], hues: ["#ffe27a", "#e0457f"], preset: "F1", design: "A young woman with a bright, clear, cheerful voice, speaking quickly and smiling" },
  { id: "elio", name: "Elio", desc: "Calm, deep, close to the mic", tags: ["Man", "Documentary"], hues: ["#86c8ff", "#2a3d99"], preset: "M2", design: "A man in his forties with a deep, calm, resonant voice, speaking close to the microphone, like a nature documentary narrator" },
  { id: "wren", name: "Wren", desc: "Soft and breathy", tags: ["Woman", "Calm"], hues: ["#d8c8ff", "#5b3fa8"], preset: "F3", design: "A young woman with a soft, breathy, gentle voice, speaking quietly and intimately" },
  { id: "otto", name: "Otto", desc: "Gravelly, older, kind", tags: ["Man", "Storyteller"], hues: ["#e8b880", "#5c3a22"], preset: "M4", design: "An older man in his sixties with a deep, gravelly, warm and kind voice, telling a story slowly", seed: 3 },
  { id: "sloane", name: "Sloane", desc: "Crisp and confident", tags: ["Woman", "Announcer"], hues: ["#ffa071", "#b8175a"], preset: "F4", design: "A woman in her thirties with a crisp, confident, polished voice, like a premium car commercial" },
  { id: "bram", name: "Bram", desc: "Steady and clear", tags: ["Man", "Explainer"], hues: ["#93eed6", "#1f6f6a"], preset: "M1", design: "A man in his thirties with a steady, neutral, clear voice, explaining things patiently" },
  { id: "pip", name: "Pip", desc: "Light and playful", tags: ["Character"], hues: ["#cbff80", "#2f9e44"], preset: "F5", design: "A playful, light, animated voice full of energy, like a cartoon sidekick" },
  { id: "nia", name: "Nia", desc: "Upbeat and warm", tags: ["Woman", "Social"], hues: ["#ffd48e", "#d4562f"], preset: "F1", design: "A young woman with an upbeat, warm, friendly voice, talking straight to the camera" },
  { id: "rook", name: "Rook", desc: "Dry, low, dramatic", tags: ["Man", "Trailer"], hues: ["#b9c2d4", "#2b2f3a"], preset: "M3", design: "A man in his forties with a low, dry, dramatic voice, like a movie trailer narrator, clear and resonant", seed: 1 },
  { id: "lumi", name: "Lumi", desc: "Gentle and slow", tags: ["Woman", "Calm"], hues: ["#a6dcff", "#4b6cb7"], preset: "F3", design: "A woman with a gentle, slow, soothing voice, reading a bedtime story" },
  { id: "vesna", name: "Vesna", desc: "Clear and warm", tags: ["Woman", "Multilingual"], hues: ["#b0f2b6", "#2d7d5a"], preset: "F2", design: "A woman in her twenties with a clear, warm, articulate voice" },
];

export const READY_VOICES: (VoiceCard & { design: string; seed?: number })[] = LIST.map((v) => ({ ...v, source: "ready", sample: `/assets/voices/${v.id}.mp3`, text: READY_LINE }));
