import "server-only";
import { runFfmpeg } from "@/lib/motion/ffmpeg";

/** Sound files for Voice, through ffmpeg: clean WAV copies, waveforms, and a quick look at a sample's quality. */

export class AudioError extends Error {}

/**
 * Any recording, clip or upload as a mono WAV, optionally cut to `maxSeconds` with the silence at both ends taken off
 * (a voice sample), at `rate` Hz.
 */
export async function toWav(input: string, output: string, { rate = 44100, maxSeconds, trim = false, signal }: { rate?: number; maxSeconds?: number; trim?: boolean; signal?: AbortSignal } = {}) {
  const filters = trim
    ? ["silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15", "areverse", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25", "areverse"]
    : [];
  const args = ["-hide_banner", "-y", "-i", input, "-vn", "-ac", "1", "-ar", String(rate)];
  if (filters.length) args.push("-af", filters.join(","));
  if (maxSeconds) args.push("-t", String(maxSeconds));
  args.push("-c:a", "pcm_s16le", output);
  const res = await runFfmpeg(args, { signal, timeoutMs: 120_000 });
  if (res.code !== 0) throw new AudioError(`Couldn't read that sound file: ${res.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`);
}

/** The samples, mono 16-bit at `rate`, for looking at. */
async function samples(file: string, rate: number) {
  const res = await runFfmpeg(["-hide_banner", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new AudioError("Couldn't read the sound.");
  const buf = res.stdout;
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** The waveform as `bars` heights from 0 to 1 (loud parts near 1). */
export async function peaksOf(file: string, bars = 180) {
  const s = await samples(file, 8000);
  if (!s.length) return [];
  const per = Math.max(1, Math.floor(s.length / bars));
  const out: number[] = [];
  let top = 0;
  for (let i = 0; i < bars; i++) {
    let m = 0;
    const end = Math.min(s.length, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const v = Math.abs(s[j]);
      if (v > m) m = v;
    }
    out.push(m);
    if (m > top) top = m;
  }
  return out.map((v) => Math.round(Math.sqrt(v / (top || 1)) * 1000) / 1000);
}

/** How long a sample is, how loud its loudest moment, and how much noise sits under the speech. */
export async function lookAt(file: string) {
  const rate = 16000;
  const s = await samples(file, rate);
  const seconds = s.length / rate;
  let peak = 0;
  for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
  // Noise: the quietest tenth of 50 ms windows, against the loudest tenth.
  const win = rate / 20;
  const rms: number[] = [];
  for (let i = 0; i + win <= s.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += s[j] * s[j];
    rms.push(Math.sqrt(sum / win));
  }
  rms.sort((a, b) => a - b);
  const tenth = Math.max(1, Math.floor(rms.length / 10));
  const quiet = rms.slice(0, tenth).reduce((a, b) => a + b, 0) / tenth;
  const loud = rms.slice(-tenth).reduce((a, b) => a + b, 0) / tenth;
  const snr = loud > 0 ? 20 * Math.log10(loud / Math.max(1, quiet)) : 0;
  return { seconds: Math.round(seconds * 10) / 10, clipped: peak >= 32700, snr: Math.round(snr) };
}
