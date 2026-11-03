"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Lock, Mic, MicOff, ShieldCheck, Square, TriangleAlert, Upload, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { micProblem as micTrouble, safari, type MicProblem as Problem } from "./mic";

/** Long enough to clone well, and where it stops by itself. */
const ENOUGH_S = 10;
const MAX_S = 30;
/** What MediaRecorder can write, best first (Chrome and Firefox take the first, Safari an mp4). */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
const BARS = 48;
const READ = "The easy part is talking. The hard part is sounding like yourself while you read someone else’s words. So I’ll keep going, a little slower than usual, and let it listen. One more line, the way I’d tell a friend about my day.";

type Phase = { at: "idle" } | { at: "asking" } | { at: "count"; n: number } | { at: "rec"; seconds: number };
type Session = {
  stream: MediaStream;
  ctx: AudioContext;
  an: AnalyserNode;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  timers: number[];
  raf: number;
  /** When it started recording, and for how long, on the meter's clock. */
  started: number;
  seconds: number;
  levels: number[];
  loudest: number;
  done: boolean;
  /** Stopped with Stop (send it on), not Cancel. */
  keep: boolean;
};

const micProblem = (err: unknown) => micTrouble(err, "Record");

/**
 * Why this page can't record at all, before trying. Browsers only open the microphone on https or on the computer
 * itself, so http://192.168.x.x (Crackio on another computer) can't; Crackio's secure address can.
 */
function cantRecord(): Problem | null {
  if (typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined") return null;
  if (!window.isSecureContext)
    return {
      title: "Recording needs Crackio's secure address",
      body: `Browsers only let a page use the microphone on https or on the computer it runs on, and this is http://${location.host}.`,
      secure: true,
    };
  return { title: "This browser can't record audio", body: "Use a current Chrome, Edge, Safari or Firefox, or upload a recording instead." };
}


/** Squeeze a run of levels into `n` bars. */
function bars(levels: number[], n = BARS) {
  if (levels.length <= n) return levels;
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    return Math.max(...levels.slice(a, b));
  });
}

/**
 * Clone's recorder: Record asks for the microphone, counts 3, 2, 1 with the level already moving (so you can see it hears
 * you), then records up to 30 seconds with the lines to read in front of you. Anything in the way (a blocked microphone,
 * an address browsers won't record on, a silent device) is said right here, with where to fix it. `locked` until the
 * permission above is ticked: pressing Record then points at it instead.
 */
export function Recorder({ locked, onLocked, onClip }: { locked: boolean; onLocked: () => void; onClip: (clip: Blob, filename: string, levels: number[]) => void }) {
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const [problem, setProblem] = useState<Problem | null>(() => cantRecord());
  const [levels, setLevels] = useState<number[]>([]);
  const [quiet, setQuiet] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState("");
  const live = useRef<Session | null>(null);
  const sendClip = useRef(onClip);
  useEffect(() => {
    sendClip.current = onClip;
  }, [onClip]);

  // A microphone already blocked for this site says so before you press anything.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const read = (state: PermissionState) => {
      if (state === "denied") setProblem(micProblem({ name: "NotAllowedError" }));
      else setProblem((p) => (p?.title === "The microphone is blocked for Crackio" ? null : p));
    };
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        status = s;
        read(s.state);
        s.onchange = () => read(s.state);
      })
      .catch(() => {});
    return () => {
      if (status) status.onchange = null;
    };
  }, []);

  const teardown = () => {
    const s = live.current;
    live.current = null;
    if (!s) return;
    s.done = true;
    s.timers.forEach((t) => window.clearTimeout(t));
    cancelAnimationFrame(s.raf);
    const off = () => s.stream.getTracks().forEach((t) => t.stop());
    // The microphone closes once the recorder has handed over its last piece.
    if (s.recorder && s.recorder.state !== "inactive") {
      s.recorder.addEventListener("stop", off);
      s.recorder.stop();
    } else off();
    void s.ctx.close().catch(() => {});
  };
  useEffect(() => () => teardown(), []);

  const open = async (deviceId?: string) => {
    if (locked) return onLocked();
    const cant = cantRecord();
    if (cant) return setProblem(cant);
    setProblem(null);
    setQuiet(false);
    setLevels([]);
    teardown();
    // Made inside the click, so the browser lets it run.
    const ctx = new AudioContext();
    setPhase({ at: "asking" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Raw-ish: no echo cancelling or level riding (the clone copies whatever the browser does to the voice); noise
        // suppression stays on for fans and rooms.
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      void ctx.close().catch(() => {});
      setPhase({ at: "idle" });
      setProblem(micProblem(err));
      return;
    }
    void ctx.resume().catch(() => {});
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const s: Session = { stream, ctx, an, recorder: null, chunks: [], timers: [], raf: 0, started: 0, seconds: 0, levels: [], loudest: 0, done: false, keep: false };
    live.current = s;
    // Names show only once the microphone is allowed.
    void navigator.mediaDevices
      .enumerateDevices()
      .then((all) => {
        if (s.done) return;
        setDevices(all.filter((d) => d.kind === "audioinput" && d.deviceId));
        setDevice(stream.getAudioTracks()[0]?.getSettings().deviceId ?? "");
      })
      .catch(() => {});
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (live.current === s) {
        teardown();
        setPhase({ at: "idle" });
        setProblem({ title: "The microphone went away", body: "It was unplugged or taken by another app. Press Record to try again." });
      }
    });

    // The level, from the first moment: the countdown already shows it hears you.
    const buf = new Float32Array(an.fftSize);
    let last = 0;
    const meter = (now: number) => {
      if (s.done) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 5.5);
      if (now - last > 66) {
        last = now;
        if (s.recorder) {
          if (!s.started) s.started = now;
          s.seconds = (now - s.started) / 1000;
          s.levels.push(level);
          s.loudest = Math.max(s.loudest, level);
          setPhase({ at: "rec", seconds: s.seconds });
          setQuiet(s.seconds > 3 && s.loudest < 0.04);
        }
        setLevels((l) => [...l.slice(-(BARS - 1)), level]);
      }
      s.raf = requestAnimationFrame(meter);
    };
    s.raf = requestAnimationFrame(meter);

    // 3, 2, 1, then it records.
    setPhase({ at: "count", n: 3 });
    s.timers.push(window.setTimeout(() => setPhase({ at: "count", n: 2 }), 1000));
    s.timers.push(window.setTimeout(() => setPhase({ at: "count", n: 1 }), 2000));
    s.timers.push(window.setTimeout(() => begin(s), 3000));
  };

  const begin = (s: Session) => {
    if (s.done) return;
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(s.stream, type ? { mimeType: type, audioBitsPerSecond: 128_000 } : undefined);
    } catch (err) {
      teardown();
      setPhase({ at: "idle" });
      setProblem({ title: "This browser couldn't record", body: `${(err as Error).message || "MediaRecorder failed"}. Upload a recording instead.` });
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size) s.chunks.push(e.data);
    };
    recorder.onstop = () => {
      // The meter's clock pauses in a background tab; a clip that size is long enough whatever it says.
      const long = s.seconds >= 2 || s.chunks.reduce((n, c) => n + c.size, 0) > 40_000;
      const kind = recorder.mimeType || type || "audio/webm";
      const ext = kind.includes("mp4") ? "m4a" : kind.includes("ogg") ? "ogg" : "webm";
      const clip = new Blob(s.chunks, { type: kind });
      if (s.keep && long && clip.size > 0) sendClip.current(clip, `recording.${ext}`, s.levels);
      else if (s.keep) setProblem({ title: "That was too short", body: `Record at least ${ENOUGH_S} seconds of talking.` });
    };
    s.recorder = recorder;
    recorder.start(250);
    setPhase({ at: "rec", seconds: 0 });
    // Stops by itself at 30 s, even in a background tab (the meter pauses there, this doesn't).
    s.timers.push(window.setTimeout(() => finish(true), MAX_S * 1000));
  };

  /** Stop: keep it (send it on) or throw it away. */
  const finish = (keep: boolean) => {
    const s = live.current;
    if (!s) return;
    s.keep = keep && Boolean(s.recorder);
    teardown();
    setPhase({ at: "idle" });
    setLevels([]);
    setQuiet(false);
  };

  const label = (d: MediaDeviceInfo, i: number) => (d.label || `Microphone ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "");

  if (phase.at !== "idle") {
    const counting = phase.at === "count" || phase.at === "asking";
    const seconds = phase.at === "rec" ? phase.seconds : 0;
    const share = Math.min(1, seconds / MAX_S);
    const enough = seconds >= ENOUGH_S;
    return (
      <div className="squircle flex flex-col gap-4 rounded-[18px] bg-black/25 p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <p className={cn("text-[15px] leading-relaxed transition-colors duration-300", counting ? "text-fog" : "text-paper")}>&ldquo;{READ}&rdquo;</p>

        <div className="relative flex h-14 items-center gap-[3px]">
          {Array.from({ length: BARS }, (_, i) => {
            const l = levels[i - (BARS - levels.length)] ?? 0;
            return <span key={i} className={cn("flex-1 rounded-full transition-[height] duration-75", counting ? "bg-white/30" : "bg-tally/85")} style={{ height: `${6 + l * 94}%` }} />;
          })}
          {phase.at === "count" ? (
            <span className="absolute inset-0 grid place-items-center">
              <span key={phase.n} className="voice-count tabular grid size-16 place-items-center rounded-full bg-[#0d0c11]/75 font-display text-[40px] leading-none text-paper shadow-[0_8px_30px_rgb(0_0_0/0.5)] backdrop-blur-md">
                {phase.n}
              </span>
            </span>
          ) : null}
        </div>

        {/* 0 → 30 s, with the 10 s mark where it's enough. */}
        <div className="relative h-1.5 rounded-full bg-white/[0.08]">
          <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-100", enough ? "bg-[var(--color-tool-voice)]" : "bg-tally")} style={{ width: `${share * 100}%` }} />
          <span className="absolute -top-1 bottom-[-4px] w-px bg-white/30" style={{ left: `${(ENOUGH_S / MAX_S) * 100}%` }} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {phase.at === "rec" ? <span className="size-2.5 animate-pulse rounded-full bg-tally" /> : null}
          <span className="tabular font-display text-[24px] leading-none">
            {phase.at === "rec" ? `0:${String(Math.floor(seconds)).padStart(2, "0")}` : phase.at === "asking" ? "…" : "Ready"}
          </span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-haze">
            {phase.at === "asking"
              ? "Allow the microphone in your browser’s prompt"
              : phase.at === "count"
                ? "Get ready to read the lines above"
                : enough
                  ? "Enough to clone. Keep going for a better one, or Stop"
                  : `Read the lines above · ${Math.ceil(ENOUGH_S - seconds)} s to go`}
          </span>
          <button type="button" onClick={() => finish(false)} className="press h-9 rounded-[12px] px-3 text-[13px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper">
            Cancel
          </button>
          {phase.at === "rec" ? (
            <button type="button" onClick={() => finish(true)} className="press squircle flex h-9 items-center gap-2 rounded-[12px] bg-paper px-3.5 text-[13px] font-semibold text-stage">
              <Square size={12} fill="currentColor" strokeWidth={0} /> Stop
            </button>
          ) : null}
        </div>

        {quiet ? (
          <p className="flex items-start gap-2 rounded-[12px] bg-tungsten/10 px-3 py-2 text-[12.5px] leading-snug text-tungsten">
            <MicOff size={14} className="mt-0.5 shrink-0" /> Crackio can&rsquo;t hear anything from this microphone. Speak up, or pick another one below.
          </p>
        ) : null}

        {devices.length > 1 ? (
          <label className="flex items-center gap-2 text-[12px] text-haze">
            <Mic size={13} className="shrink-0" />
            <span className="sr-only">Microphone</span>
            <select
              value={device}
              onChange={(e) => {
                setDevice(e.target.value);
                void open(e.target.value);
              }}
              className="field-focus h-8 min-w-0 max-w-full flex-1 truncate rounded-[10px] bg-white/[0.05] px-2 text-[12.5px] text-fog outline-none shadow-[inset_0_0_0_1px_var(--color-line)]"
            >
              {devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId} className="bg-[#16131b]">
                  {label(d, i)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => void open(device || undefined)}
          aria-describedby={locked ? "voice-rec-lock" : undefined}
          className={cn(
            "press squircle flex min-h-[132px] flex-col items-center justify-center gap-3 rounded-[18px] bg-black/20 shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
            locked ? "opacity-60" : "hover:shadow-[inset_0_0_0_1px_rgb(255_92_116/0.5)]",
          )}
        >
          <span className="grid size-12 place-items-center rounded-full bg-tally/15 text-tally">{locked ? <Lock size={19} /> : <Mic size={21} />}</span>
          <span className="text-[14px] font-semibold">Record</span>
          <span className="-mt-2 text-[11.5px] text-haze">3, 2, 1, then up to 30 s</span>
        </button>
        <label
          onClick={(e) => {
            if (!locked) return;
            e.preventDefault();
            onLocked();
          }}
          className={cn(
            "press squircle flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[18px] border border-dashed border-line-strong bg-black/20 px-3 text-center",
            locked ? "opacity-60" : "hover:border-[color-mix(in_oklab,var(--color-tool-voice)_50%,transparent)]",
          )}
        >
          <span className="grid size-12 place-items-center rounded-full bg-[color-mix(in_oklab,var(--color-tool-voice)_14%,transparent)] text-[var(--color-tool-voice)]">{locked ? <Lock size={19} /> : <Upload size={21} />}</span>
          <span className="text-[14px] font-semibold">Upload a clip</span>
          <span className="text-[11.5px] leading-snug text-haze">Audio or video</span>
          <input
            type="file"
            accept="audio/*,video/*"
            disabled={locked}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onClip(f, f.name, []);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {locked ? (
        <p id="voice-rec-lock" className="flex items-center gap-1.5 text-[12px] text-haze">
          <Lock size={12} /> Tick the permission above first
        </p>
      ) : null}
      {problem ? (
        <div role="alert" className="flex items-start gap-2.5 rounded-[14px] bg-tally/[0.08] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgb(255_92_116/0.25)]">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-tally" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-paper">{problem.title}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-fog">{problem.body}</p>
            {problem.secure ? <SecureWay /> : null}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setProblem(null)} className="press -mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

type Lan = { allowed: boolean; port: number; running: boolean; error: string | null };

/**
 * The way to record from another device: Crackio's https address on the same computer (lib/server/lan-https), opening
 * straight on Clone. Off until someone asks for it here (then it stays on). The browser warns once, since the
 * certificate is Crackio's own; trusting it ends that for good.
 */
export function SecureWay({ query = "voices=clone" }: { query?: string }) {
  const [lan, setLan] = useState<Lan | null>(null);
  const [turning, setTurning] = useState(false);
  useEffect(() => {
    let gone = false;
    fetch("/api/lan")
      .then((r) => r.json() as Promise<Lan>)
      .then((d) => !gone && setLan(d))
      .catch(() => !gone && setLan({ allowed: false, port: 0, running: false, error: null }));
    return () => {
      gone = true;
    };
  }, []);
  const turnOn = async () => {
    setTurning(true);
    try {
      const res = await fetch("/api/lan", { method: "POST" });
      const d = (await res.json()) as Partial<Lan>;
      setLan((l) => ({ allowed: true, port: d.port ?? l?.port ?? 0, running: Boolean(d.running), error: d.error ?? null }));
    } catch (err) {
      setLan((l) => (l ? { ...l, error: (err as Error).message } : l));
    } finally {
      setTurning(false);
    }
  };
  if (!lan) return null;
  if (!lan.allowed)
    return <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">Open Crackio on the computer that runs it (http://localhost{location.port ? `:${location.port}` : ""}), or upload a recording instead.</p>;
  if (!lan.running)
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-[12.5px] leading-relaxed text-fog">Crackio can answer on https too, for the devices on your network (port {lan.port}), with a certificate it makes for itself. It stays on once you turn it on.</p>
        <button type="button" disabled={turning} onClick={() => void turnOn()} className="press inline-flex h-9 items-center gap-2 self-start rounded-full bg-paper px-4 text-[13px] font-bold text-stage hover:bg-white disabled:opacity-70">
          {turning ? <LoaderCircle size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Turn on the secure address
        </button>
        {lan.error ? <p className="text-[12px] leading-snug text-tally">{lan.error}</p> : null}
      </div>
    );
  const href = `https://${location.hostname}:${lan.port}${location.pathname}?${query}`;
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <a href={href} className="press inline-flex h-9 items-center gap-2 self-start rounded-full bg-paper px-4 text-[13px] font-bold text-stage hover:bg-white">
        <ShieldCheck size={14} /> Open the secure address
      </a>
      <p className="text-[12px] leading-relaxed text-haze">
        {safari()
          ? "Safari warns the first time, because the certificate is Crackio's own (made on the computer that runs it): click Show Details, then “visit this website”, then Visit Website, and enter your Mac's password if it asks. Once is enough."
          : "Your browser warns the first time, because the certificate is Crackio's own (made on the computer that runs it): click Advanced, then Proceed. Once is enough."}
      </p>
      <details className="text-[12px] leading-relaxed text-haze">
        <summary className="cursor-pointer font-semibold text-fog hover:text-paper">Never see the warning</summary>
        <p className="mt-1.5">
          <a href="/api/lan/ca" download className="font-semibold text-paper underline decoration-white/25 underline-offset-2">
            Get Crackio&rsquo;s certificate
          </a>{" "}
          and trust it. Mac: open it, then in Keychain Access double-click &ldquo;Crackio local CA&rdquo; → Trust → Always Trust. iPhone or iPad: Settings → Profile Downloaded → Install, then General → About → Certificate Trust Settings → turn it on. It can only vouch for addresses on your own network, never a real website.
        </p>
      </details>
    </div>
  );
}

/** A clip on its way to the server: its shape, while it's cleaned up and typed out. */
export function Listening({ levels }: { levels: number[] }) {
  const shape = bars(levels);
  return (
    <div className="squircle flex flex-col gap-3 rounded-[18px] bg-black/25 p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      {shape.length ? (
        <div className="flex h-10 items-center gap-[3px] opacity-60">
          {shape.map((l, i) => (
            <span key={i} className="flex-1 animate-pulse rounded-full bg-[var(--color-tool-voice)]" style={{ height: `${8 + l * 92}%`, animationDelay: `${(i % 12) * 90}ms` }} />
          ))}
        </div>
      ) : null}
      <div>
        <p className="text-[13.5px] font-semibold text-paper">Listening to your clip…</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-haze">Cleaning it up and typing out what it says. The first time on a GPU takes up to half a minute.</p>
      </div>
    </div>
  );
}
