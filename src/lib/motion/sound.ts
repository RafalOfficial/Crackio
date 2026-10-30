import "server-only";
import { EngineError } from "@/lib/engines/types";
import { launch } from "./render";

/**
 * Sound made from code, the way a motion designer scores a piece with a synth: the agent writes Web
 * Audio code against an OfflineAudioContext, headless Chrome renders it faster than real time, and the
 * result comes back as a WAV. Deterministic (seeded noise), free, and in sync with the picture because
 * the agent schedules every sound at the exact second it designed the motion for. A small kit of
 * instruments and effects (drums, pads, plucks, bass, whooshes, risers, impacts, UI ticks, reverb,
 * ducking) keeps it musical without making every piece sound the same.
 */

const KIT = /* js */ `
const SR = ctx.sampleRate;
let seed = 0x2f6b9a1;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const master = ctx.createDynamicsCompressor();
master.threshold.value = -16; master.knee.value = 12; master.ratio.value = 3; master.attack.value = 0.004; master.release.value = 0.18;
const out = ctx.createGain(); out.gain.value = 0.9; master.connect(out); out.connect(ctx.destination);
const noiseBuffer = (seconds) => {
  const b = ctx.createBuffer(2, Math.max(1, Math.round(seconds * SR)), SR);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }
  return b;
};
const impulse = (seconds, decay) => {
  const b = ctx.createBuffer(2, Math.round(seconds * SR), SR);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / d.length, decay); }
  return b;
};
const verb = ctx.createConvolver(); verb.buffer = impulse(2.8, 3.2);
const verbIn = ctx.createGain(); verbIn.gain.value = 0.8; verbIn.connect(verb); verb.connect(master);
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const hz = (n) => {
  if (typeof n === "number") return n;
  const m = /^([A-G])([#b]?)(-?\\d)$/.exec(String(n).trim());
  if (!m) throw new Error("Unknown note " + n);
  const midi = 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
};
/** A gain envelope into dest (and the reverb by send). */
const env = (t, dur, { gain = 0.3, attack = 0.005, release = 0.15, dest = master, send = 0, curve = "exp" } = {}) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, Math.max(t + attack, t + dur - release));
  if (curve === "exp") g.gain.exponentialRampToValueAtTime(0.0001, t + dur); else g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(dest);
  if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verbIn); }
  return g;
};
const panner = (pan, dest) => { const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(dest); return p; };
const noiseAt = (t, dur) => { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(dur + 0.05); s.start(t); s.stop(t + dur + 0.05); return s; };
const oscAt = (type, freq, t, dur, detune = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune; o.start(t); o.stop(t + dur + 0.05); return o; };
const filter = (type, freq, q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };

const kit = {
  ctx, master, reverb: verbIn, rand, hz,
  /** A bus with its own level (and reverb send), for groups of sounds you want to duck or fade together. */
  bus({ gain = 1, send = 0 } = {}) { const g = ctx.createGain(); g.gain.value = gain; g.connect(master); if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verbIn); } return g; },
  /** Duck a bus at the given times (a kick, a hit): depth 0-1, back up over release seconds. */
  duck(bus, times, { depth = 0.55, release = 0.28 } = {}) { const base = bus.gain.value; for (const t of times) { bus.gain.setValueAtTime(base * (1 - depth), t); bus.gain.linearRampToValueAtTime(base, t + release); } },
  /** One oscillator note: type sine|triangle|square|sawtooth, optional glide to, lowpass cutoff, pan. */
  tone(note, t, dur, { type = "sine", gain = 0.2, attack = 0.01, release = 0.2, to, cutoff, pan = 0, send = 0, dest = master, detune = 0 } = {}) {
    const o = oscAt(type, hz(note), t, dur, detune);
    if (to) o.frequency.exponentialRampToValueAtTime(hz(to), t + dur);
    let node = o;
    if (cutoff) { const f = filter("lowpass", cutoff); node.connect(f); node = f; }
    node.connect(env(t, dur, { gain, attack, release, dest: pan ? panner(pan, dest) : dest, send }));
    return o;
  },
  /** A soft chord pad: detuned saws through a slowly opening lowpass, into the reverb. */
  pad(notes, t, dur, { gain = 0.05, cutoff = 1400, open = 2600, attack = 1.2, release = 1.6, send = 0.45, dest = master } = {}) {
    const f = filter("lowpass", cutoff, 0.4);
    f.frequency.setValueAtTime(cutoff, t); f.frequency.linearRampToValueAtTime(open, t + dur * 0.6);
    f.connect(env(t, dur, { gain, attack, release, dest, send, curve: "lin" }));
    for (const n of notes) for (const d of [-7, 7]) oscAt("sawtooth", hz(n), t, dur, d).connect(f);
  },
  /** A plucked note (triangle with a fast filter decay). */
  pluck(note, t, { gain = 0.16, decay = 0.6, send = 0.25, pan = 0, dest = master } = {}) {
    const f = filter("lowpass", 4000, 1); f.frequency.setValueAtTime(5200, t); f.frequency.exponentialRampToValueAtTime(500, t + decay);
    oscAt("triangle", hz(note), t, decay).connect(f);
    f.connect(env(t, decay, { gain, attack: 0.002, release: decay * 0.9, dest: pan ? panner(pan, dest) : dest, send }));
  },
  /** A round bass note. */
  bass(note, t, dur, { gain = 0.22, cutoff = 420, dest = master } = {}) {
    const f = filter("lowpass", cutoff, 0.9); f.connect(env(t, dur, { gain, attack: 0.008, release: Math.min(0.25, dur * 0.5), dest }));
    oscAt("sine", hz(note), t, dur).connect(f); oscAt("sawtooth", hz(note), t, dur).connect(filter("lowpass", cutoff * 0.8)).connect(f);
  },
  kick(t, { gain = 0.9, from = 150, to = 42, dest = master } = {}) {
    const o = oscAt("sine", from, t, 0.45); o.frequency.exponentialRampToValueAtTime(to, t + 0.12);
    o.connect(env(t, 0.42, { gain, attack: 0.001, release: 0.38, dest }));
    const c = noiseAt(t, 0.006); c.connect(filter("highpass", 2500)).connect(env(t, 0.006, { gain: gain * 0.25, attack: 0.0005, release: 0.005, dest }));
  },
  snare(t, { gain = 0.35, dest = master, send = 0.12 } = {}) {
    noiseAt(t, 0.2).connect(filter("bandpass", 1900, 0.8)).connect(env(t, 0.2, { gain, attack: 0.001, release: 0.18, dest, send }));
    oscAt("triangle", 190, t, 0.12).connect(env(t, 0.12, { gain: gain * 0.6, attack: 0.001, release: 0.1, dest }));
  },
  clap(t, { gain = 0.3, dest = master, send = 0.2 } = {}) { for (const d of [0, 0.012, 0.024]) noiseAt(t + d, 0.06).connect(filter("bandpass", 1150, 1.2)).connect(env(t + d, d === 0.024 ? 0.18 : 0.03, { gain, attack: 0.001, release: 0.025, dest, send })); },
  hat(t, { gain = 0.12, open = false, dest = master } = {}) { const dur = open ? 0.28 : 0.05; noiseAt(t, dur).connect(filter("highpass", 7200, 0.8)).connect(env(t, dur, { gain, attack: 0.001, release: dur * 0.9, dest })); },
  /** Drum pattern: one character per 16th note ("x" hit, "." rest), repeated from t0 to t1 at bpm. */
  beat(bpm, t0, t1, { kick = "", snare = "", clap = "", hat = "", open = "", gain = 1, dest = master } = {}) {
    const step = 60 / bpm / 4; const hits = { kick: [], snare: [], hat: [] };
    for (let i = 0, t = t0; t < t1 - 1e-6; i++, t += step) {
      const at = (p) => p.length && p[i % p.length] === "x";
      if (at(kick)) { this.kick(t, { gain: 0.9 * gain, dest }); hits.kick.push(t); }
      if (at(snare)) { this.snare(t, { gain: 0.35 * gain, dest }); hits.snare.push(t); }
      if (at(clap)) this.clap(t, { gain: 0.3 * gain, dest });
      if (at(hat)) { this.hat(t, { gain: 0.12 * gain, dest }); hits.hat.push(t); }
      if (at(open)) this.hat(t, { gain: 0.1 * gain, open: true, dest });
    }
    return hits;
  },
  /** Air moving past: a band of noise sweeping from one pitch to another, swelling and fading. */
  whoosh(t, dur = 0.6, { from = 350, to = 4200, gain = 0.22, pan = 0, dest = master, send = 0.15 } = {}) {
    const f = filter("bandpass", from, 1.6); f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noiseAt(t, dur).connect(f); f.connect(g); g.connect(pan ? panner(pan, dest) : dest);
    if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verbIn); }
  },
  /** Tension building into a moment that lands at t + dur (it stops dead there). */
  riser(t, dur = 2.5, { gain = 0.16, dest = master } = {}) {
    const f = filter("highpass", 300, 0.9); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur - 0.02); g.gain.setValueAtTime(0.0001, t + dur);
    noiseAt(t, dur).connect(f); f.connect(g); g.connect(dest);
    const o = oscAt("sawtooth", 180, t, dur); o.frequency.exponentialRampToValueAtTime(900, t + dur);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(gain * 0.25, t + dur - 0.02); og.gain.setValueAtTime(0.0001, t + dur);
    o.connect(filter("lowpass", 2500)).connect(og); og.connect(dest);
  },
  /** A deep hit for a reveal: sub drop, a burst of filtered noise, a tail in the reverb. */
  impact(t, { gain = 0.8, dest = master, send = 0.35 } = {}) {
    const o = oscAt("sine", 95, t, 1.4); o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
    o.connect(env(t, 1.4, { gain, attack: 0.002, release: 1.2, dest }));
    noiseAt(t, 0.5).connect(filter("lowpass", 900, 0.7)).connect(env(t, 0.5, { gain: gain * 0.45, attack: 0.001, release: 0.45, dest, send }));
  },
  /** A small UI tick or tap. */
  tick(t, { gain = 0.12, freq = 2400, dest = master } = {}) { oscAt("sine", freq, t, 0.03).connect(env(t, 0.03, { gain, attack: 0.0008, release: 0.025, dest })); },
  /** A glassy high shimmer (sparkle, reveal of light). */
  shimmer(t, dur = 1.5, { gain = 0.05, notes = ["E6", "B6", "G#6"], dest = master } = {}) { notes.forEach((n, i) => kit.tone(n, t + i * 0.07, dur, { type: "sine", gain, attack: 0.02, release: dur * 0.8, send: 0.6, dest, pan: (i - 1) * 0.4 })); },
  /** Quiet room or air bed under the whole piece. */
  room(t, dur, { gain = 0.012, tone = 900, dest = master } = {}) { noiseAt(t, dur).connect(filter("lowpass", tone, 0.5)).connect(env(t, dur, { gain, attack: 0.5, release: 0.8, dest, curve: "lin" })); },
};
`;

const PAGE = `<!doctype html><html><head></head><body><script>
window.__render = async (code, duration, sampleRate) => {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(duration * sampleRate)), sampleRate);
  ${KIT}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("ctx", "kit", "duration", code)(ctx, kit, duration);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let peak = 0, sum = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; sum += L[i] * L[i] + R[i] * R[i]; }
  const rms = Math.sqrt(sum / (2 * L.length));
  // Peak-normalize to -1 dBFS (the final mix sets the loudness).
  const k = peak > 0 ? Math.min(8, 0.891 / peak) : 1;
  const n = L.length, data = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); data.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true); w(36, "data"); data.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    data.setInt16(o, Math.max(-1, Math.min(1, L[i] * k)) * 32767, true);
    data.setInt16(o + 2, Math.max(-1, Math.min(1, R[i] * k)) * 32767, true);
  }
  const bytes = new Uint8Array(data.buffer); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { wav: btoa(bin), peak, rms };
};
</script></body></html>`;

export async function renderSound({ code, duration, signal }: { code: string; duration: number; signal: AbortSignal }): Promise<{ data: Buffer; peak: number; rms: number }> {
  const browser = await launch();
  const stop = () => void browser.close().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await browser.newPage();
    // Nothing leaves the page: sound is pure code.
    await page.route("**/*", (route) => route.abort());
    await page.setContent(PAGE);
    const r = await page
      .evaluate(async ([c, d]) => (window as unknown as { __render: (c: string, d: number, sr: number) => Promise<{ wav: string; peak: number; rms: number }> }).__render(c as string, d as number, 48000), [code, duration] as const)
      .catch((err: unknown) => {
        if (signal.aborted) throw new EngineError("Cancelled.");
        throw new EngineError(`The sound code failed: ${(err instanceof Error ? err.message : String(err)).replace(/^page\.evaluate:\s*/, "").slice(0, 400)}`);
      });
    if (!(r.peak > 0)) throw new EngineError("The sound code rendered silence: nothing was scheduled, or nothing reached kit.master (or ctx.destination).");
    return { data: Buffer.from(r.wav, "base64"), peak: r.peak, rms: r.rms };
  } finally {
    signal.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}
