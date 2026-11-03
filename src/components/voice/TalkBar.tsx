"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Mic, Square, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { VoiceModelId } from "@/lib/voice/models";
import { Orb } from "./Orb";
import { SecureWay } from "./Recorder";
import { cantUseMic, micProblem, type MicProblem } from "./mic";
import { usePlayer } from "./player";
import { useTalkState, type TalkPhase } from "./talk-store";

/**
 * Talk: a live conversation in a voice. The mic listens all the time; when you stop talking, what you said goes to the
 * server (api/voice/talk), which hears it, has LFM3-VL answer, and sends back each sentence spoken as soon as it's
 * ready; they play one after another. Talking while it answers cuts it off: the answer stops where it was.
 */

type Turn = { role: "user" | "assistant"; text: string; cut?: boolean };

/* ------------------------------------------------------------------ speech in */

const PRE_ROLL_S = 0.35;
const END_SILENCE_S = 0.65;
const MIN_SPEECH_S = 0.3;

/** Mono float samples at `from` Hz as a 16 kHz 16-bit WAV, base64. */
function wavBase64(samples: Float32Array, from: number) {
  const to = 16000;
  const n = Math.max(1, Math.floor((samples.length * to) / from));
  const pcm = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const a = Math.floor(x);
    const f = x - a;
    const v = (samples[a] ?? 0) * (1 - f) + (samples[a + 1] ?? 0) * f;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, to, true);
  v.setUint32(28, to * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The mic, always on while talking: an adaptive noise floor, speech when it's well above it for a moment (higher while
 * the voice is playing, so its echo doesn't count), the end after a pause; each utterance with a little of what came
 * just before it.
 */
class Ear {
  ctx: AudioContext;
  private stream: MediaStream;
  private node: ScriptProcessorNode;
  private src: MediaStreamAudioSourceNode;
  private floor = 0.004;
  private above = 0;
  private quiet = 0;
  private talking = false;
  private pre: Float32Array[] = [];
  private got: Float32Array[] = [];
  level = 0;
  echoGuard = false;

  constructor(ctx: AudioContext, stream: MediaStream, on: { start: () => void; utterance: (samples: Float32Array, rate: number) => void }) {
    this.ctx = ctx;
    this.stream = stream;
    this.src = ctx.createMediaStreamSource(stream);
    this.node = ctx.createScriptProcessor(2048, 1, 1);
    const frameS = 2048 / ctx.sampleRate;
    this.node.onaudioprocess = (e) => {
      const x = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      this.level = rms;
      const start = Math.max(this.floor * (this.echoGuard ? 5 : 3.2), this.echoGuard ? 0.04 : 0.015);
      const stop = Math.max(this.floor * 2, 0.01);
      if (!this.talking) {
        this.pre.push(x);
        while (this.pre.length * frameS > PRE_ROLL_S) this.pre.shift();
        this.floor = rms < this.floor * 2.5 ? this.floor * 0.95 + rms * 0.05 : this.floor * 0.995 + rms * 0.005;
        this.above = rms > start ? this.above + 1 : 0;
        if (this.above >= 3) {
          this.talking = true;
          this.quiet = 0;
          this.got = [...this.pre];
          on.start();
        }
        return;
      }
      this.got.push(x);
      this.quiet = rms < stop ? this.quiet + 1 : 0;
      if (this.quiet * frameS >= END_SILENCE_S) {
        this.talking = false;
        this.above = 0;
        const total = this.got.reduce((n, a) => n + a.length, 0);
        const all = new Float32Array(total);
        let o = 0;
        for (const a of this.got) {
          all.set(a, o);
          o += a.length;
        }
        this.got = [];
        const seconds = total / ctx.sampleRate - END_SILENCE_S;
        if (seconds >= MIN_SPEECH_S) on.utterance(all, ctx.sampleRate);
      }
    };
    this.src.connect(this.node);
    // ScriptProcessor only runs while connected to the output; it writes silence.
    this.node.connect(ctx.destination);
  }

  close() {
    this.node.disconnect();
    this.src.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

/** Two runs of samples, one after the other. */
function joined(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* ------------------------------------------------------------------ speech out */

/** Sentences played back to back as they arrive; all stop at once when cut off. */
class Mouth {
  private ctx: AudioContext;
  private next = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private timers = new Set<number>();
  private analyser: AnalyserNode;
  private data: Uint8Array<ArrayBuffer>;
  onIdle: () => void = () => {};
  onSentence: (text: string) => void = () => {};

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.analyser.connect(ctx.destination);
  }

  get busy() {
    return this.playing.size > 0;
  }

  level() {
    if (!this.playing.size) return 0;
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.data.length) * 4);
  }

  async play(b64: string, text: string) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await this.ctx.decodeAudioData(bytes.buffer);
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.analyser);
    const at = Math.max(this.ctx.currentTime + 0.02, this.next);
    this.next = at + buf.duration;
    this.playing.add(node);
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      this.onSentence(text);
    }, Math.max(0, (at - this.ctx.currentTime) * 1000));
    this.timers.add(id);
    node.onended = () => {
      this.playing.delete(node);
      if (!this.playing.size) this.onIdle();
    };
    node.start(at);
  }

  stop() {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    for (const n of this.playing) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    this.playing.clear();
    this.next = 0;
  }
}

/* ------------------------------------------------------------------ the bar */

/** What the conversation keeps to send with each turn (the server uses the last 24 of them). */
const KEEP_TURNS = 40;

/**
 * Talk in Voice's bar: the conversation where the script goes (your lines right, theirs left with their orb), the chips
 * under it, Talk or End where Speak is, and what it's doing under the bar. Mic trouble floats under it as a card, so
 * nothing moves.
 */
export function TalkBar({
  voice,
  voiceName,
  hues,
  model,
  language,
  ready,
  onGetModel,
  idle,
  chips,
}: {
  voice: string;
  voiceName: string;
  hues: [string, string];
  model: VoiceModelId;
  /** The language you speak in (a code), or "auto": speech to text works it out each time. */
  language: string;
  /** What Talk needs is on your GPUs: the voice model, and LFM3-VL to write the answers. */
  ready: boolean;
  /** Talk pressed while something's missing: get it. */
  onGetModel: () => void;
  /** The line under the bar while it's off. */
  idle: ReactNode;
  chips: ReactNode;
}) {
  const [phase, setPhase] = useState<TalkPhase>("off");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [answeredIn, setAnsweredIn] = useState<number | null>(null);
  const [warming, setWarming] = useState(false);
  const warm = useRef<AbortController | null>(null);
  const ear = useRef<Ear | null>(null);
  const mouth = useRef<Mouth | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const turn = useRef<AbortController | null>(null);
  /**
   * The answer being heard: its sentences as they start playing, and whether its whole text is already in the
   * conversation (it goes in once written to the end). Cut short, the conversation keeps only what was heard of it.
   */
  const answer = useRef<{ said: string[]; recorded: boolean }>({ said: [], recorded: false });
  const history = useRef<Turn[]>([]);
  const raf = useRef(0);
  const phaseRef = useRef<TalkPhase>("off");
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * A pause mid-thought isn't the end of a turn: going on before any answer was heard joins the next utterance to the
   * last one (its sound, kept until an answer plays), and their words from the first part come out of the conversation.
   */
  const lastHeard = useRef<Float32Array | null>(null);
  const joining = useRef(false);
  /** The turn under way has put their words in the conversation. */
  const turnHeard = useRef(false);
  const setP = useCallback((p: TalkPhase) => {
    phaseRef.current = p;
    setPhase(p);
    useTalkState.setState({ phase: p });
  }, []);

  /** The answer so far stops: what was already spoken stays in the conversation, marked as cut. */
  const cut = useCallback(() => {
    turn.current?.abort();
    turn.current = null;
    const wasSpeaking = mouth.current?.busy;
    mouth.current?.stop();
    const { said, recorded } = answer.current;
    if ((said.length || recorded) && (wasSpeaking || phaseRef.current === "thinking" || phaseRef.current === "speaking")) {
      const text = said.join(" ");
      if (recorded) {
        // Its whole text went in when it was written: keep what was heard of it (nothing heard, nothing kept).
        const trim = (list: Turn[], mark: boolean): Turn[] => {
          const lastOne = list[list.length - 1];
          if (lastOne?.role !== "assistant") return list;
          return text ? [...list.slice(0, -1), { ...lastOne, text, ...(mark ? { cut: true } : {}) }] : list.slice(0, -1);
        };
        history.current = trim(history.current, false);
        setTurns((t) => trim(t, true));
      } else if (text) {
        history.current = [...history.current, { role: "assistant" as const, text }].slice(-KEEP_TURNS);
        setTurns((t) => [...t, { role: "assistant", text, cut: true }]);
      }
    }
    answer.current = { said: [], recorded: false };
    setLive("");
    if (ear.current) ear.current.echoGuard = false;
  }, []);

  const ask = useCallback(
    async (audio: string) => {
      cut();
      const ctrl = new AbortController();
      turn.current = ctrl;
      const sent = performance.now();
      let first = true;
      turnHeard.current = false;
      setP("hearing");
      setError(null);
      try {
        const res = await fetch("/api/voice/talk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio, history: history.current.map(({ role, text }) => ({ role, text })), voice, model, ...(language !== "auto" ? { language } : {}) }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `status ${res.status}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let reply = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const e = JSON.parse(line) as { type: string; text?: string; soFar?: string; wav?: string; reply?: string; error?: string };
            if (e.type === "heard") {
              if (!e.text) {
                void reader.cancel();
                if (turn.current === ctrl) turn.current = null;
                setP("listening");
                return;
              }
              history.current = [...history.current, { role: "user" as const, text: e.text }].slice(-KEEP_TURNS);
              setTurns((t) => [...t, { role: "user", text: e.text! }]);
              turnHeard.current = true;
              setP("thinking");
            } else if (e.type === "text") {
              setLive(e.soFar ?? "");
            } else if (e.type === "audio" && e.wav && mouth.current) {
              if (first) {
                first = false;
                // Answered: what comes next is a new turn.
                lastHeard.current = null;
                setAnsweredIn(performance.now() - sent);
              }
              if (ear.current) ear.current.echoGuard = true;
              setP("speaking");
              void mouth.current.play(e.wav, e.text ?? "");
            } else if (e.type === "done") {
              reply = e.reply ?? reply;
            } else if (e.type === "error") {
              throw new Error(e.error ?? "Something went wrong.");
            }
          }
        }
        if (turn.current !== ctrl) return;
        turn.current = null;
        if (reply) {
          history.current = [...history.current, { role: "assistant" as const, text: reply }].slice(-KEEP_TURNS);
          setTurns((t) => [...t, { role: "assistant", text: reply }]);
          answer.current.recorded = true;
        }
        setLive("");
        if (!mouth.current?.busy) {
          answer.current = { said: [], recorded: false };
          if (ear.current) ear.current.echoGuard = false;
          setP("listening");
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (turn.current === ctrl) turn.current = null;
        setLive("");
        setError((err as Error).message);
        setP(ear.current ? "listening" : "off");
      }
    },
    [cut, setP, voice, model, language],
  );
  // The mic calls the latest one: a voice or model picked mid-talk answers from the next turn on.
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  }, [ask]);

  const start = useCallback(async () => {
    setError(null);
    setProblem(null);
    const cant = cantUseMic("Talking");
    if (cant) {
      setProblem(cant);
      return;
    }
    usePlayer.getState().stop();
    setP("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const c = new AudioContext();
      await c.resume();
      ctx.current = c;
      const m = new Mouth(c);
      m.onSentence = (text) => {
        answer.current.said.push(text);
      };
      m.onIdle = () => {
        if (ear.current) ear.current.echoGuard = false;
        // Played to the end, and nothing more is coming: it was all heard.
        if (!turn.current) answer.current = { said: [], recorded: false };
        if (!turn.current && phaseRef.current === "speaking") setP("listening");
      };
      mouth.current = m;
      ear.current = new Ear(c, stream, {
        start: () => {
          const p = phaseRef.current;
          // Going on after a pause, before any answer was heard: still the same turn.
          const join = (p === "hearing" || p === "thinking") && !answer.current.said.length && !mouth.current?.busy && lastHeard.current !== null;
          // Talking over the answer cuts it off.
          if (p === "speaking" || p === "thinking" || p === "hearing") cut();
          joining.current = join;
          if (!join) lastHeard.current = null;
          else if (turnHeard.current) {
            history.current = history.current.slice(0, -1);
            setTurns((t) => t.slice(0, -1));
            turnHeard.current = false;
          }
          setP("hearing");
        },
        utterance: (samples, rate) => {
          const all = joining.current && lastHeard.current ? joined(lastHeard.current, samples) : samples;
          joining.current = false;
          lastHeard.current = all;
          void askRef.current(wavBase64(all, rate));
        },
      });
      setP("listening");
      // The models wake while they start talking, so the first answer isn't held up by loading them.
      const w = new AbortController();
      warm.current = w;
      setWarming(true);
      void fetch("/api/voice/talk/warm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice, model }), signal: w.signal })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          if (!r.ok && j.error && !w.signal.aborted) setError(j.error);
        })
        .catch(() => {})
        .finally(() => !w.signal.aborted && setWarming(false));
      // The orb and the backdrop follow whoever is talking; only real changes go out.
      let last = 0;
      const tick = () => {
        const l = Math.max(mouth.current?.level() ?? 0, Math.min(1, (ear.current?.level ?? 0) * 6));
        if (Math.abs(l - last) > 0.02 || (l === 0 && last !== 0)) {
          last = l;
          useTalkState.setState({ level: l });
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (err) {
      setProblem(micProblem(err, "Talk", ""));
      setP("off");
    }
  }, [cut, setP, voice, model]);

  const stop = useCallback(() => {
    cut();
    lastHeard.current = null;
    joining.current = false;
    warm.current?.abort();
    warm.current = null;
    setWarming(false);
    cancelAnimationFrame(raf.current);
    ear.current?.close();
    ear.current = null;
    mouth.current = null;
    void ctx.current?.close();
    ctx.current = null;
    useTalkState.setState({ level: 0 });
    setP("off");
  }, [cut, setP]);

  useEffect(() => () => stop(), [stop]);

  const on = phase !== "off" && phase !== "starting";
  // Esc ends it, as the button says.
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) stop();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [on, stop]);

  // The newest line stays in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live]);

  const status =
    phase === "listening"
      ? answeredIn !== null && turns.length
        ? `Listening · it answered in ${(answeredIn / 1000).toFixed(1)} s`
        : warming
          ? `Listening · waking ${voiceName}'s voice on your GPU, you can start talking`
          : "Listening · say something"
      : phase === "hearing"
        ? "Hearing you…"
        : phase === "thinking"
          ? "Thinking…"
          : phase === "speaking"
            ? "Speaking · talk over it to cut in"
            : phase === "starting"
              ? "Starting the mic…"
              : null;

  return (
    <div className="relative">
      <div className="smoked-glass squircle relative flex flex-col gap-2 rounded-[26px] p-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <div ref={scroller} className="scroll-thin max-h-[220px] min-h-[60px] overflow-y-auto px-2 py-2.5">
            {turns.length || live ? (
              <ol className="flex flex-col gap-2" aria-label={`Talking with ${voiceName}`}>
                {turns.map((t, i) =>
                  t.role === "user" ? (
                    <li key={i} className="max-w-[80%] self-end rounded-[16px] rounded-br-[6px] bg-white/[0.09] px-3 py-1.5 text-[15.5px] leading-relaxed text-paper">
                      {t.text}
                    </li>
                  ) : (
                    <li key={i} className="flex max-w-[88%] items-start gap-2 self-start">
                      <Orb hues={hues} size={18} className="mt-[5px] shrink-0" />
                      <span className="text-[15.5px] leading-relaxed text-paper/90">
                        {t.text}
                        {t.cut ? <span className="text-haze"> …</span> : null}
                      </span>
                    </li>
                  ),
                )}
                {live && (phase === "thinking" || phase === "speaking") ? (
                  <li className="flex max-w-[88%] items-start gap-2 self-start">
                    <Orb hues={hues} size={18} working className="mt-[5px] shrink-0" />
                    <span className="text-[15.5px] leading-relaxed text-fog">{live}</span>
                  </li>
                ) : null}
              </ol>
            ) : (
              <p className="px-1 py-0.5 text-[16px] leading-relaxed text-haze">
                {on ? `Go ahead: say something to ${voiceName}.` : `Press Talk and say hello to ${voiceName}. The answers come back out loud, in their voice.`}
              </p>
            )}
          </div>
          {chips}
        </div>

        <button
          type="button"
          onClick={() => (on ? stop() : ready ? void start() : onGetModel())}
          disabled={phase === "starting"}
          aria-pressed={on}
          className={cn(
            "squircle flex h-14 shrink-0 flex-col items-center justify-center gap-1 rounded-[20px] px-6 transition-[background-color,transform,box-shadow] duration-150 disabled:cursor-wait sm:h-auto sm:min-h-[98px] sm:w-[150px] sm:self-stretch",
            on
              ? "press bg-white/[0.08] text-paper shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.13]"
              : "lip bg-spike text-spike-ink [--lip-glow:0_10px_32px_-10px_rgb(255_91_46/0.5)] [--lip:var(--color-spike-lip)] hover:bg-spike-hi hover:[--lip-glow:0_12px_38px_-10px_rgb(255_91_46/0.62)]",
          )}
        >
          {phase === "starting" ? (
            <LoaderCircle size={20} className="animate-spin" />
          ) : (
            <span className="flex items-center gap-2 font-display text-[22px] leading-none">
              {on ? <Square size={14} className="fill-current" /> : <Mic size={19} />}
              {on ? "End" : "Talk"}
            </span>
          )}
          <span className="hidden text-[11.5px] font-bold opacity-75 sm:block">{on ? "or press Esc" : "live · your mic"}</span>
        </button>
      </div>

      <div className="mt-3 min-h-5 text-center text-[13px]" aria-live="polite">
        {error ? <span className="text-tally">{error}</span> : status ? <span className="text-fog">{status}</span> : idle}
      </div>

      {problem ? (
        <div
          role="alert"
          className="absolute inset-x-0 top-full z-10 mx-auto mt-1 flex max-w-[560px] items-start gap-2.5 rounded-[16px] bg-[#1d1520]/95 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgb(255_92_116/0.28),0_18px_40px_-12px_rgb(0_0_0/0.6)]"
        >
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-tally" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-paper">{problem.title}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-fog">{problem.body}</p>
            {problem.secure ? <SecureWay query="talk=1" /> : null}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setProblem(null)} className="press -mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
