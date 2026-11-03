"use client";

import { useEffect, useImperativeHandle, type CSSProperties, type Ref } from "react";
import { Pause, Play } from "lucide-react";
import { Orb } from "./Orb";
import { Wave } from "./Wave";
import { usePlayer } from "./player";
import { wordsOf } from "@/lib/voice/script";
import type { Generation, MediaRef } from "@/lib/generations/types";
import type { VoiceAsk, VoiceHeard } from "@/lib/voice/types";
import { cn } from "@/lib/cn";

/** Who speaks in a take, as it was saved with it (names and orb colours), for pages that don't load the voices. */
export function speakersOf(gen: Generation) {
  const ask = gen.params?.voice as VoiceAsk | undefined;
  return ask?.who ?? [];
}

const FALLBACK: [string, string] = ["#ffc07c", "#b8432e"];
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A Voice take as a card face (Library tiles, Recent): its first words, its waveform, who says it, and a play button. */
export function VoiceFace({ gen, output, className }: { gen: Generation; output: MediaRef; className?: string }) {
  const who = speakersOf(gen);
  const heard = gen.params?.heard as VoiceHeard | undefined;
  const key = `take:${gen.id}`;
  const playing = usePlayer((s) => s.key === key && s.playing);
  const time = usePlayer((s) => (s.key === key ? s.time : 0));
  const length = output.duration ?? 0;
  const hues = who[0]?.hues ?? FALLBACK;
  return (
    <div className={cn("relative flex size-full flex-col justify-between overflow-hidden bg-[#120f17] p-3", className)}>
      <div aria-hidden="true" className="voice-halo pointer-events-none absolute -left-1/4 -top-1/3 aspect-square w-[120%] opacity-80" style={{ "--h2": hues[1] } as CSSProperties} />
      <p className="relative line-clamp-4 font-display text-[clamp(13px,1.3vw,17px)] leading-snug text-paper">{wordsOf(gen.prompt)}</p>
      <div className="relative flex flex-col gap-2">
        <div className="h-8">
          <Wave peaks={heard?.peaks ?? []} progress={length ? time / length : 0} color={hues[0]} bar={2} gap={1.5} />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={(e) => {
              e.stopPropagation();
              usePlayer.getState().toggle(key, output.url);
            }}
            className="press grid size-8 shrink-0 place-items-center rounded-full bg-paper text-stage"
          >
            {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
          </button>
          <span className="flex shrink-0 -space-x-1.5">
            {(who.length ? who : [{ name: "Voice", hues: FALLBACK }]).map((v, i) => (
              <Orb key={i} hues={v.hues} size={14} />
            ))}
          </span>
          <span className="min-w-0 truncate text-[11.5px] font-semibold text-fog">{who.map((v) => v.name).join(" & ") || "Voice"}</span>
          <span className="tabular ml-auto shrink-0 text-[11px] text-haze">{clock(length)}</span>
        </div>
      </div>
    </div>
  );
}

/** A Voice take in the Library's viewer: big waveform, play, and the words lighting up as they're said. */
export function VoiceViewer({ gen, output, ref }: { gen: Generation; output: MediaRef; ref?: Ref<{ togglePlay?: () => void }> }) {
  const who = speakersOf(gen);
  const heard = gen.params?.heard as VoiceHeard | undefined;
  const key = `take:${gen.id}`;
  // Space and K in the viewer play and pause it, as they do a clip.
  useImperativeHandle(ref, () => ({ togglePlay: () => usePlayer.getState().toggle(key, output.url) }), [key, output.url]);
  // Stepping to another take or closing the viewer stops this one, as it would a clip.
  useEffect(() => () => void (usePlayer.getState().key === key && usePlayer.getState().stop()), [key]);
  const playing = usePlayer((s) => s.key === key && s.playing);
  const time = usePlayer((s) => (s.key === key ? s.time : 0));
  const level = usePlayer((s) => (s.key === key ? s.level : 0));
  const length = output.duration ?? 0;
  const hues = who[0]?.hues ?? FALLBACK;
  const words = heard?.words ?? [];
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[860px] flex-col items-center gap-8">
        <span className="flex -space-x-4">
          {(who.length ? who : [{ name: "Voice", hues: FALLBACK }]).map((v, i) => (
            <Orb key={i} hues={v.hues} size={88} level={level} className="ring-4 ring-stage" />
          ))}
        </span>
        <div className="flex w-full items-center gap-4">
          <button
            type="button"
            aria-label={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={() => usePlayer.getState().toggle(key, output.url)}
            className="press grid size-14 shrink-0 place-items-center rounded-full bg-paper text-stage"
          >
            {playing ? <Pause size={20} fill="currentColor" strokeWidth={0} /> : <Play size={20} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
          </button>
          <div className="h-16 min-w-0 flex-1">
            <Wave peaks={heard?.peaks ?? []} progress={length ? time / length : 0} color={hues[0]} bar={3} gap={2} onSeek={(s) => usePlayer.getState().seek(key, output.url, s * length)} />
          </div>
          <span className="tabular w-[92px] shrink-0 text-right text-[13px] text-fog">
            {clock(time)} / {clock(length)}
          </span>
        </div>
        <p className="max-w-[70ch] text-center text-[19px] leading-[1.8] text-haze">
          {words.length
            ? words.map((w, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => usePlayer.getState().seek(key, output.url, w.start + 0.01)}
                  className={cn("rounded-[6px] px-[2px] transition-colors duration-150", time >= w.start && time < w.end ? "bg-[var(--color-tool-voice)] text-[#11200a]" : time >= w.end ? "text-paper" : "hover:text-fog")}
                >
                  {w.word}
                </button>
              ))
            : wordsOf(gen.prompt)}
        </p>
      </div>
    </div>
  );
}
