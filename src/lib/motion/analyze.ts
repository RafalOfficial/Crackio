import "server-only";
import sharp from "sharp";
import { frameAt, frameTimes, probe, runFfmpeg } from "./ffmpeg";

/**
 * Numbers Motion can't argue with: the color cast of a picture (measured on the things in it that
 * should be neutral: whites, greys, concrete, paper), how loud a mix is, and where a cut goes black,
 * freezes or never cuts at all. The agent and its critic read these next to the pictures, so a
 * yellow wash or a silent film is caught by measurement, not by taste alone.
 */

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function lab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r / 255);
  const G = lin(g / 255);
  const B = lin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export type ColorStats = {
  /** Mean a* and b* of the pixels that should be neutral (b* > 0 is yellow, a* > 0 magenta). */
  castA: number;
  castB: number;
  /** Share of the picture that reads as near-neutral (the cast is only trustworthy above ~8%). */
  neutralShare: number;
  /** Mean b* of the whole picture. */
  meanB: number;
  meanChroma: number;
  meanL: number;
  /** Share of blown highlights and crushed shadows. */
  clipHigh: number;
  clipLow: number;
  /** Mean RGB of the near-neutral pixels, for correcting the cast. */
  neutralRgb: [number, number, number];
};

export async function colorStats(input: string | Buffer): Promise<ColorStats> {
  const { data } = await sharp(input, { failOn: "none" }).resize(192, 192, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  let sumB = 0;
  let sumC = 0;
  let sumL = 0;
  let hi = 0;
  let lo = 0;
  let nn = 0;
  let nA = 0;
  let nB = 0;
  const rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [L, a, bb] = lab(r, g, b);
    const c = Math.hypot(a, bb);
    n++;
    sumB += bb;
    sumC += c;
    sumL += L;
    if (L > 97) hi++;
    if (L < 3) lo++;
    if (L > 25 && L < 95 && c < 22) {
      nn++;
      nA += a;
      nB += bb;
      rgb[0] += r;
      rgb[1] += g;
      rgb[2] += b;
    }
  }
  const k = Math.max(1, nn);
  return {
    castA: nA / k,
    castB: nB / k,
    neutralShare: nn / Math.max(1, n),
    meanB: sumB / Math.max(1, n),
    meanChroma: sumC / Math.max(1, n),
    meanL: sumL / Math.max(1, n),
    clipHigh: hi / Math.max(1, n),
    clipLow: lo / Math.max(1, n),
    neutralRgb: [rgb[0] / k, rgb[1] / k, rgb[2] / k],
  };
}

/** True when the picture's neutrals lean yellow or orange enough that people read it as "AI". */
export const yellowCast = (s: ColorStats) => s.neutralShare >= 0.08 && s.castB > 8;

/** One plain sentence about a picture's color, the way a colorist would flag it. */
export function describeColor(s: ColorStats): string {
  const parts: string[] = [];
  if (s.neutralShare >= 0.08) {
    const b = s.castB;
    const a = s.castA;
    if (b > 12) parts.push(`strong yellow cast on its neutrals (b* ${b.toFixed(1)}): this is the "AI yellow" look`);
    else if (b > 8) parts.push(`yellow cast on its neutrals (b* ${b.toFixed(1)})`);
    else if (b > 5) parts.push(`slightly warm neutrals (b* ${b.toFixed(1)})`);
    else if (b < -7) parts.push(`blue cast on its neutrals (b* ${b.toFixed(1)})`);
    else parts.push(`neutral white balance (b* ${b.toFixed(1)})`);
    if (a > 6) parts.push(`magenta lean (a* ${a.toFixed(1)})`);
    else if (a < -6) parts.push(`green lean (a* ${a.toFixed(1)})`);
  } else {
    parts.push(s.meanB > 22 ? `almost nothing neutral and the whole frame is yellow-orange (mean b* ${s.meanB.toFixed(1)})` : `few neutral areas (mean b* ${s.meanB.toFixed(1)})`);
  }
  if (s.meanChroma > 34) parts.push(`heavily saturated (chroma ${s.meanChroma.toFixed(0)})`);
  if (s.clipHigh > 0.06) parts.push(`${Math.round(s.clipHigh * 100)}% blown highlights`);
  if (s.clipLow > 0.12) parts.push(`${Math.round(s.clipLow * 100)}% crushed to black`);
  if (s.meanL < 18) parts.push("very dark overall");
  return parts.join("; ");
}

/**
 * Takes most of a cast out (white balance on the picture's own neutrals, as a channel gain), the
 * way a colorist would start. `keep` leaves this much of the cast in, so it stays natural.
 */
export async function neutralize(file: string, stats: ColorStats, keep = 0.25): Promise<Buffer> {
  const [r, g, b] = stats.neutralRgb;
  const target = (r + g + b) / 3;
  const gain = (c: number) => Math.min(1.35, Math.max(0.7, 1 + (1 - keep) * (target / Math.max(1, c) - 1)));
  const img = sharp(file, { failOn: "none" }).recomb([
    [gain(r), 0, 0],
    [0, gain(g), 0],
    [0, 0, gain(b)],
  ]);
  // Written back under the same name, so in the same format.
  const ext = file.toLowerCase().split(".").pop();
  return (ext === "jpg" || ext === "jpeg" ? img.jpeg({ quality: 95 }) : ext === "webp" ? img.webp({ quality: 95 }) : img.png()).toBuffer();
}

/** The cast of a video, from a few frames across it. */
export async function videoColor(file: string, duration: number, count = 5): Promise<{ at: number; stats: ColorStats }[]> {
  const times = frameTimes(Math.max(0.2, duration), count);
  const out: { at: number; stats: ColorStats }[] = [];
  for (const t of times) {
    const jpg = await frameAt(file, t, 320).catch(() => null);
    if (jpg) out.push({ at: t, stats: await colorStats(jpg) });
  }
  return out;
}

export function summarizeVideoColor(frames: { at: number; stats: ColorStats }[]): string {
  if (!frames.length) return "Couldn't read its color.";
  const yellow = frames.filter((x) => yellowCast(x.stats));
  const avgB = frames.reduce((s, x) => s + (x.stats.neutralShare >= 0.08 ? x.stats.castB : x.stats.meanB * 0.5), 0) / frames.length;
  const sat = frames.reduce((s, x) => s + x.stats.meanChroma, 0) / frames.length;
  const parts = [yellow.length ? `yellow cast in ${yellow.length} of ${frames.length} sampled frames (${yellow.map((x) => `${x.at.toFixed(1)} s`).join(", ")})` : `no yellow cast in ${frames.length} sampled frames`];
  parts.push(`average neutral b* ${avgB.toFixed(1)}`);
  if (sat > 34) parts.push(`heavily saturated (chroma ${sat.toFixed(0)})`);
  return parts.join("; ");
}

export type Loudness = { lufs: number | null; truePeak: number | null; lra: number | null };

/** Integrated loudness (LUFS), true peak (dBTP) and loudness range of a file's sound. */
export async function loudness(file: string, signal?: AbortSignal): Promise<Loudness> {
  const r = await runFfmpeg(["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { signal, timeoutMs: 5 * 60_000 });
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}

export function describeLoudness(l: Loudness): string {
  if (l.lufs === null || l.lufs < -60) return "no sound at all";
  const parts = [`${l.lufs.toFixed(1)} LUFS integrated`];
  if (l.truePeak !== null) parts.push(`true peak ${l.truePeak.toFixed(1)} dBTP`);
  if (l.lufs < -24) parts.push("too quiet for social or web (aim for about -14)");
  else if (l.lufs > -11) parts.push("very loud (aim for about -14)");
  if (l.truePeak !== null && l.truePeak > -0.5) parts.push("peaks can clip");
  return parts.join(", ");
}

export type CutStats = { cuts: number[]; black: { start: number; end: number }[]; frozen: { start: number; duration: number }[] };

/** Where the picture cuts, goes black or stands still, read from a small copy of the video. */
export async function cutStats(file: string, signal?: AbortSignal): Promise<CutStats> {
  const r = await runFfmpeg(
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-an",
      "-vf",
      // The detectors see every frame; only then does select keep the cuts for printing.
      "scale=320:-2,blackdetect=d=0.2:pix_th=0.08,freezedetect=n=-55dB:d=1.2,select='gt(scene,0.3)',metadata=print:key=lavfi.scene_score",
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 10 * 60_000 },
  );
  const log = r.stderr;
  const cuts = [...log.matchAll(/pts_time:([\d.]+)[^\n]*\n[^\n]*lavfi\.scene_score/g)].map((m) => Number(m[1]));
  const black = [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const frozen = [...log.matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_duration: ([\d.]+)/g)].map((m) => ({ start: Number(m[1]), duration: Number(m[2]) }));
  return { cuts: [...new Set(cuts.map((c) => Math.round(c * 10) / 10))], black, frozen };
}

export function describeCuts(c: CutStats, duration: number): string {
  const shots = c.cuts.length + 1;
  const parts = [`${shots} shot${shots === 1 ? "" : "s"} (hard cuts detected: ${c.cuts.length}), average ${(duration / shots).toFixed(1)} s per shot`];
  if (c.black.length) parts.push(`black at ${c.black.map((b) => `${b.start.toFixed(1)}-${b.end.toFixed(1)} s`).join(", ")}`);
  if (c.frozen.length) parts.push(`picture stands still at ${c.frozen.map((z) => `${z.start.toFixed(1)} s for ${z.duration.toFixed(1)} s`).join(", ")}`);
  return parts.join("; ");
}

/** Everything measurable about a finished video, in a few lines. */
export async function measureVideo(file: string, signal?: AbortSignal) {
  const info = await probe(file);
  const duration = info.duration ?? 0;
  const [color, sound, cuts] = await Promise.all([
    videoColor(file, duration, 6),
    info.audio ? loudness(file, signal) : Promise.resolve<Loudness>({ lufs: null, truePeak: null, lra: null }),
    cutStats(file, signal).catch(() => ({ cuts: [], black: [], frozen: [] }) as CutStats),
  ]);
  return {
    info,
    lines: [
      `Length ${duration.toFixed(1)} s, ${info.width}x${info.height}, ${info.fps ? Math.round(info.fps) : "?"} fps.`,
      `Edit: ${describeCuts(cuts, duration)}.`,
      `Color: ${summarizeVideoColor(color)}.`,
      `Sound: ${info.audio ? describeLoudness(sound) : "no audio track"}.`,
    ],
  };
}
