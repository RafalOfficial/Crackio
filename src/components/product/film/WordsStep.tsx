"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { LoaderCircle, Pause, Play, Sparkles } from "lucide-react";
import { LANGUAGES, VOICES, countWords, wordsFor, type LanguageId, type VoiceId, type WordsMode } from "@/lib/product/film";
import { cn } from "@/lib/cn";

const MODES: { id: WordsMode; label: string; note: string }[] = [
  { id: "auto", label: "Crackio writes it", note: "Written for your product, picture and picks when you film." },
  { id: "mine", label: "My words", note: "Said exactly as you write them." },
  { id: "none", label: "No talking", note: "They react without words: a laugh, a hum, a breath." },
];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * What the creator says: Crackio writes it (or drafts it for you to edit), your own lines, or nothing;
 * the language they speak; and their voice (a preset voice stays the same in every video).
 */
export function WordsStep({
  mode,
  script,
  language,
  voice,
  seconds,
  voicesOk,
  captions,
  onCaptions,
  onMode,
  onScript,
  onLanguage,
  onVoice,
  draft,
}: {
  mode: WordsMode;
  script: string;
  language: LanguageId;
  voice: VoiceId | null;
  seconds: number;
  /** The model speaks with preset voices. */
  voicesOk: boolean;
  /** Burn captions in from what's said. */
  captions: boolean;
  onCaptions: (on: boolean) => void;
  onMode: (m: WordsMode) => void;
  onScript: (s: string) => void;
  onLanguage: (l: LanguageId) => void;
  onVoice: (v: VoiceId | null) => void;
  /** Ask Crackio for a first draft of the lines. */
  draft: () => Promise<string | null>;
}) {
  const [writing, setWriting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const words = countWords(script);
  const fits = wordsFor(seconds);

  return (
    <div className="space-y-3.5">
      <div role="radiogroup" className="grid grid-cols-3 gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            title={m.note}
            onClick={() => onMode(m.id)}
            className={cn(
              "press relative h-10 rounded-[12px] px-1 text-[12px] font-semibold transition-colors",
              mode === m.id ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
            )}
          >
            {mode === m.id ? <motion.span layoutId="words-pill" className="absolute inset-0 rounded-[12px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
            <span className="relative">{m.label}</span>
          </button>
        ))}
      </div>
      <p className="-mt-1.5 text-[11.5px] leading-snug text-haze">{MODES.find((m) => m.id === mode)?.note}</p>

      {mode !== "none" ? (
        <div>
          <textarea
            value={script}
            onChange={(e) => {
              onScript(e.target.value.slice(0, 900));
              if (mode !== "mine" && e.target.value.trim()) onMode("mine");
            }}
            rows={4}
            placeholder={mode === "auto" ? "Leave it to Crackio, or tap “Write a draft” to see and edit the lines first…" : "Okay so, I've been using this every morning for like two weeks now…"}
            className="w-full resize-none rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[13.5px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className={cn("tabular text-[11.5px]", words > fits * 1.25 ? "text-tungsten" : "text-haze")}>
              {words ? `${words} words · about ${fits} fit ${seconds} s${words > fits * 1.25 ? ": it'll sound rushed" : ""}` : `About ${fits} words fit ${seconds} s`}
            </span>
            <button
              type="button"
              disabled={writing}
              onClick={async () => {
                setWriting(true);
                setFailed(null);
                const text = await draft().catch(() => null);
                setWriting(false);
                if (!text) return setFailed("Couldn't write a draft. Write the lines yourself, or try again.");
                onScript(text);
                onMode("mine");
              }}
              className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.08] px-3 text-[12px] font-semibold text-paper hover:bg-white/[0.12] disabled:opacity-60"
            >
              {writing ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />} {script.trim() ? "Write another" : "Write a draft"}
            </button>
          </div>
          {failed ? <p className="mt-1 text-[11.5px] text-tally">{failed}</p> : null}
        </div>
      ) : null}

      {mode !== "none" ? (
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <span className="text-[12px] font-semibold text-fog">Speaks</span>
          <select
            value={language}
            onChange={(e) => onLanguage(e.target.value as LanguageId)}
            className="h-9 rounded-[10px] bg-white/[0.05] px-2.5 text-[12.5px] font-semibold text-paper outline-none shadow-[inset_0_0_0_1px_var(--color-line)]"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id} className="bg-[#1b1820]">
                {l.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {mode !== "none" ? <VoicePicker voice={voice} onVoice={onVoice} ok={voicesOk} /> : null}

      {mode !== "none" ? (
        <button
          type="button"
          onClick={() => onCaptions(!captions)}
          aria-pressed={captions}
          className="press flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
        >
          <span className="flex-1">
            <span className="block text-[13px] font-semibold">Captions</span>
            <span className="block text-[11.5px] leading-snug text-haze">{captions ? "Burned in, a few words at a time, timed to what's said" : "No text on the video"}</span>
          </span>
          <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", captions ? "bg-spike" : "bg-gaffer")}>
            <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", captions ? "left-[18px]" : "left-0.5")} />
          </span>
        </button>
      ) : null}
    </div>
  );
}

/** Auto (the model casts a voice that fits the person) or a preset voice you can hear first. */
function VoicePicker({ voice, onVoice, ok }: { voice: VoiceId | null; onVoice: (v: VoiceId | null) => void; ok: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = (id: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const a = new Audio(`/assets/product/film/voices/${id}.mp3`);
    audio.current = a;
    setPlaying(id);
    a.onended = () => setPlaying((p) => (p === id ? null : p));
    a.onerror = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
  };
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-fog">Voice</span>
        <span className="text-right text-[11px] text-haze">{!ok ? "Preset voices need Grok Imagine Video 1.5" : voice ? "Same voice in every video · 720p" : "The model casts one · 1080p"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onVoice(null)}
          className={cn("press h-8 rounded-full px-3 text-[12px] font-semibold", !voice ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper")}
        >
          Auto
        </button>
        {VOICES.map((v) => (
          <span key={v.id} className={cn("flex h-8 items-center rounded-full", voice === v.id ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog", !ok && "opacity-45")}>
            <button type="button" disabled={!ok} onClick={() => onVoice(v.id)} className="press h-8 pl-3 pr-1.5 text-[12px] font-semibold disabled:cursor-not-allowed" title={`${cap(v.id)} · ${v.gender}`}>
              {cap(v.id)}
            </button>
            <button type="button" onClick={() => play(v.id)} className="grid size-7 place-items-center rounded-full hover:bg-black/10" aria-label={`Hear ${cap(v.id)}`}>
              {playing === v.id ? <Pause size={11} /> : <Play size={11} />}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
