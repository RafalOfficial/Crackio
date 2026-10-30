import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderSound } from "@/lib/motion/sound";
import { runFfmpeg } from "@/lib/motion/ffmpeg";
import type { FilmPaceId } from "@/lib/product/film";

/**
 * A Campaign edit's music, made from code with Motion's sound kit (no music service, free, the same
 * every time): a beat at the pace you picked, a whoosh into every cut, a hit on the last shot, all
 * landing exactly on the cuts. Mixed under the clips' own sound.
 */

const STYLE: Record<FilmPaceId, { bpm: number; code: (cuts: number[], total: number) => string }> = {
  // Four on the floor with claps and a pumping bass: made to stop the scroll.
  punchy: {
    bpm: 120,
    code: (cuts, total) => `
const bpm = 120, bar = 60 / bpm * 4, end = ${total.toFixed(3)};
const music = kit.bus({ gain: 0.9 });
const hits = kit.beat(bpm, 0, end - 0.05, { kick: "x...x...x...x...", clap: "....x.......x...", hat: "..x...x...x...x.", open: "..............x.", dest: music });
const roots = ["A1", "F1", "C2", "G1"];
for (let i = 0, t = 0; t < end - 0.1; i++, t += bar) {
  const r = roots[i % roots.length];
  for (let k = 0; k < 4; k++) kit.bass(r, t + k * bar / 4, bar / 4 - 0.04, { gain: 0.2, dest: music });
  kit.pad([r.replace("1", "3").replace("2", "4"), "C4", "E4"], t, bar, { gain: 0.025, dest: music });
}
kit.duck(music, hits.kick, { depth: 0.35, release: 0.2 });
${cuts.map((c) => `kit.whoosh(${Math.max(0, c - 0.45).toFixed(3)}, 0.5, { gain: 0.16 });`).join("\n")}
kit.impact(${(cuts.at(-1) ?? 0).toFixed(3)}, { gain: 0.55 });
kit.room(0, end, { gain: 0.006 });`,
  },
  // Lo-fi groove: soft kick and hats, warm plucks.
  natural: {
    bpm: 96,
    code: (cuts, total) => `
const bpm = 96, beat = 60 / bpm, bar = beat * 4, end = ${total.toFixed(3)};
const music = kit.bus({ gain: 0.85, send: 0.1 });
kit.beat(bpm, 0, end - 0.05, { kick: "x.....x...x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.xx", gain: 0.7, dest: music });
const chords = [["D3", "F3", "A3", "C4"], ["G2", "B2", "D3", "F3"], ["C3", "E3", "G3", "B3"], ["A2", "C3", "E3", "G3"]];
for (let i = 0, t = 0; t < end - 0.1; i++, t += bar) {
  const c = chords[i % chords.length];
  kit.pad(c, t, bar, { gain: 0.03, dest: music });
  kit.bass(c[0], t, beat * 1.5, { gain: 0.16, dest: music });
  [0, 1.5, 2.5].forEach((b, k) => kit.pluck(c[(k + 1) % c.length].replace("3", "5").replace("2", "4"), t + b * beat, { gain: 0.07, dest: music }));
}
${cuts.map((c) => `kit.whoosh(${Math.max(0, c - 0.35).toFixed(3)}, 0.4, { gain: 0.1 });`).join("\n")}
kit.room(0, end, { gain: 0.006 });`,
  },
  // Slow and luxurious: a pad that opens, a few bell notes, no drums.
  calm: {
    bpm: 72,
    code: (cuts, total) => `
const end = ${total.toFixed(3)};
const music = kit.bus({ gain: 0.9, send: 0.3 });
const chords = [["E3", "G#3", "B3", "D#4"], ["C#3", "E3", "G#3", "B3"], ["A2", "C#3", "E3", "G#3"], ["B2", "D#3", "F#3", "A3"]];
const step = Math.max(2, end / 4);
for (let i = 0, t = 0; t < end - 0.1; i++, t += step) kit.pad(chords[i % chords.length], t, Math.min(step + 1, end - t + 0.4), { gain: 0.04, attack: 1.4, dest: music });
${cuts.map((c, i) => `kit.pluck(${JSON.stringify(["B5", "G#5", "E5", "F#5", "D#5", "C#6"][i % 6])}, ${c.toFixed(3)}, { gain: 0.08, decay: 1.4, send: 0.6 });`).join("\n")}
kit.shimmer(${(cuts.at(-1) ?? 0).toFixed(3)}, 2, { gain: 0.035 });
kit.room(0, end, { gain: 0.007 });`,
  },
};

/** The edit's music for these cut times (seconds into the edit, the first at 0) over `total` seconds. */
export async function scoreFor(cuts: number[], total: number, pace: FilmPaceId, signal: AbortSignal): Promise<Buffer | null> {
  const style = STYLE[pace] ?? STYLE.natural;
  try {
    const { data } = await renderSound({ code: style.code(cuts.slice(1), total), duration: total + 0.2, signal });
    return data;
  } catch (err) {
    console.warn(`[film] score: ${(err as Error).message}`);
    return null;
  }
}

/** The music under a clip: the clip's own sound kept, a little lower, the music fading out at the end. */
export async function withScore(video: Buffer, score: Buffer, total: number): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crackio-score-"));
  try {
    const v = path.join(dir, "v.mp4");
    const a = path.join(dir, "a.wav");
    const out = path.join(dir, "out.mp4");
    await fs.writeFile(v, video);
    await fs.writeFile(a, score);
    const fade = Math.max(0, total - 1.2).toFixed(2);
    const run = await runFfmpeg([
      "-y", "-i", v, "-i", a,
      "-filter_complex", `[0:a:0]volume=0.55[s];[1:a:0]volume=0.8,afade=t=out:st=${fade}:d=1.2[m];[s][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`,
      "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    ]);
    return run.code === 0 ? fs.readFile(out) : video;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
