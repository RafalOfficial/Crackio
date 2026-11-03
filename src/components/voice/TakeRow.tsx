"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Copy, Download, MoreHorizontal, Pause, Play, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { Orb } from "./Orb";
import { Wave } from "./Wave";
import { usePlayer } from "./player";
import { voiceOf } from "@/lib/hooks/use-voice";
import { isLive, useGenerations } from "@/lib/hooks/use-generations";
import { wordsOf } from "@/lib/voice/script";
import type { Generation } from "@/lib/generations/types";
import type { VoiceAsk, VoiceHeard } from "@/lib/voice/types";
import { cn } from "@/lib/cn";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const NOTES = ["happier", "slower", "more dramatic", "softer", "less acted"];

/**
 * A take, as a line of the page: the speaker's sky is the play button (pointed at, it shows ▶), the words beside it, and
 * what made it under them. While it plays the line opens to its waveform and its words light up one by one. The rest
 * (again, download, copy, delete) waits in one menu that shows when you point at the line.
 */
export function TakeRow({ gen, onAgain }: { gen: Generation; onAgain: (gen: Generation, note: string) => void }) {
  const ask = gen.params?.voice as VoiceAsk | undefined;
  const heard = gen.params?.heard as VoiceHeard | undefined;
  const known = (ask?.cast?.length ? ask.cast : [ask?.voice]).map((id) => voiceOf(id));
  const cast = known.every(Boolean) ? (known as NonNullable<(typeof known)[number]>[]) : (ask?.who ?? []).map((w, i) => ({ id: `who-${i}`, ...w }));
  const out = gen.outputs[0];
  const key = `take:${gen.id}`;
  const playing = usePlayer((s) => s.key === key && s.playing);
  const mine = usePlayer((s) => s.key === key);
  const time = usePlayer((s) => (s.key === key ? s.time : 0));
  const level = usePlayer((s) => (s.key === key ? s.level : 0));
  const remove = useGenerations((s) => s.remove);
  const cancel = useGenerations((s) => s.cancel);
  const [note, setNote] = useState<string | null>(null);
  const length = out?.duration ?? 0;
  const words = useMemo(() => heard?.words ?? [], [heard]);
  const said = wordsOf(gen.prompt);
  const hues = cast[0]?.hues ?? (["#c9f5a2", "#2f9e44"] as [string, string]);
  const who = cast.map((v) => v.name).join(" & ") || "Voice";

  if (isLive(gen)) {
    const share = Math.max(0.04, Math.min(1, gen.progress ?? 0));
    return (
      <li className="voice-line">
        <span className="relative grid size-11 shrink-0 place-items-center">
          <Orb hues={hues} size={44} working />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[15.5px] text-paper/80">{said}</p>
          <div className="mt-2 flex items-center gap-3">
            <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <span className="block h-full rounded-full bg-[var(--color-tool-voice)] transition-[width] duration-700" style={{ width: `${share * 100}%` }} />
            </span>
            <span className="shrink-0 text-[12px] text-haze">{gen.stage ?? "Waiting for the GPU"}</span>
          </div>
        </div>
        <button type="button" aria-label="Stop making it" title="Stop" onClick={() => void cancel(gen.id)} className="press grid size-8 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
          <X size={14} />
        </button>
      </li>
    );
  }
  if (gen.status === "error" || !out) {
    return (
      <li className="voice-line">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-tally/[0.08] text-tally">
          <TriangleAlert size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[15.5px] text-paper/70">{said}</p>
          <p className="mt-0.5 truncate text-[12px] text-tally/90">{gen.error ?? "This take didn't come out."}</p>
        </div>
        <button type="button" onClick={() => onAgain(gen, "")} className="press shrink-0 text-[12.5px] font-semibold text-fog hover:text-paper">
          Try again
        </button>
        <button type="button" aria-label="Remove" title="Remove" onClick={() => void remove(gen.id)} className="press grid size-8 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
          <X size={14} />
        </button>
      </li>
    );
  }

  const progress = length ? Math.min(1, time / length) : 0;
  const toggle = () => usePlayer.getState().toggle(key, out.url);
  return (
    <li className={cn("voice-line group", mine && "voice-line-on")} style={{ "--th1": hues[0], "--th2": hues[1] } as CSSProperties}>
      {/* The speaker's sky is the play button: ▶ when pointed at, ❚❚ while it plays. */}
      <button type="button" onClick={toggle} aria-label={playing ? `Pause ${who}` : `Play ${who}`} className="voice-line-orb relative grid size-11 shrink-0 place-items-center rounded-full outline-none">
        {cast.length > 1 ? (
          <span className="relative block size-full">
            <Orb hues={cast[0].hues} size={32} level={mine ? level : 0} className="absolute left-0 top-0" />
            <Orb hues={cast[1].hues} size={27} level={mine ? level : 0} className="absolute bottom-0 right-0 ring-2 ring-[#16131b]" />
          </span>
        ) : (
          <Orb hues={hues} size={44} level={mine ? level : 0} />
        )}
        <span className={cn("voice-line-glyph", playing && "voice-line-glyph-on")} aria-hidden="true">
          {playing ? <Pause size={15} fill="currentColor" strokeWidth={0} /> : <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        {mine && words.length ? (
          <Words words={words} time={time} onSeek={(t) => usePlayer.getState().seek(key, out.url, t)} />
        ) : (
          <button type="button" onClick={toggle} className="block max-w-full text-left">
            <span className={cn("block font-display text-[15.5px] leading-snug text-paper/90 group-hover:text-paper", mine ? "" : "truncate")}>{said}</span>
          </button>
        )}
        {mine ? (
          <div className="mt-2 h-7">
            <Wave peaks={heard?.peaks ?? []} progress={progress} color={hues[0]} onSeek={(s) => usePlayer.getState().seek(key, out.url, s * length)} />
          </div>
        ) : null}
        <p className="mt-1 truncate text-[12px] text-haze">
          <span className="font-semibold text-fog">{who}</span> · {gen.modelName ?? "Voice"} · {ago(gen.finishedAt ?? gen.createdAt)}
          {ask?.note ? ` · “${ask.note}”` : ""}
        </p>
        {note !== null ? (
          <form
            className="mt-2.5 flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) onAgain(gen, note.trim());
              setNote(null);
            }}
          >
            <span className="mr-0.5 text-[12px] font-semibold text-fog">Again, but</span>
            {NOTES.map((n) => (
              <button key={n} type="button" onClick={() => (onAgain(gen, n), setNote(null))} className="press h-7 rounded-full bg-white/[0.05] px-2.5 text-[12px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
                {n}
              </button>
            ))}
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="or say how…" className="field-focus h-7 min-w-[140px] flex-1 rounded-full bg-black/25 px-3 text-[12.5px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
          </form>
        ) : null}
      </div>

      <span className="tabular shrink-0 self-start pt-1 text-[12px] text-haze">
        {mine ? `${clock(time)} / ` : ""}
        {clock(length)}
      </span>
      <Popover
        placement="bottom-end"
        trigger={({ toggle: open, open: isOpen, id }) => (
          <button
            type="button"
            aria-label="More"
            title="More"
            aria-expanded={isOpen}
            aria-controls={id}
            onClick={open}
            className={cn("press grid size-8 shrink-0 place-items-center self-start rounded-full text-fog transition-opacity duration-150 hover:bg-white/[0.07] hover:text-paper", isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      >
        {(close) => (
          <div className="flex w-[210px] flex-col">
            <MenuItem onSelect={() => (setNote(""), close())}>
              <RotateCcw size={14} /> Again, but…
            </MenuItem>
            <a href={out.url} download={`${(cast[0]?.name ?? "voice").toLowerCase()}-${gen.id}.wav`} onClick={close} className="squircle flex items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-[13px] text-fog hover:bg-gaffer/60 hover:text-paper">
              <Download size={14} /> Download WAV
            </a>
            <MenuItem onSelect={() => (void navigator.clipboard?.writeText(gen.prompt), close())}>
              <Copy size={14} /> Copy the script
            </MenuItem>
            <MenuItem onSelect={() => (usePlayer.getState().stop(), void remove(gen.id), close())}>
              <Trash2 size={14} /> Delete
            </MenuItem>
          </div>
        )}
      </Popover>
    </li>
  );
}

/** The take's words, each lit as it's said; click one to hear from there. */
function Words({ words, time, onSeek }: { words: VoiceHeard["words"]; time: number; onSeek: (t: number) => void }) {
  return (
    <p className="font-display text-[15.5px] leading-[1.6] text-haze">
      {words.map((w, i) => {
        const now = time >= w.start && time < w.end;
        const past = time >= w.end;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(w.start + 0.01)}
            className={cn("rounded-[5px] px-[2px] transition-colors duration-150", now ? "bg-[var(--th1)] text-[#16131b]" : past ? "text-paper" : "hover:text-fog")}
          >
            {w.word}
          </button>
        );
      })}
    </p>
  );
}
