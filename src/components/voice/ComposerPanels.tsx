"use client";

import type { CSSProperties, ReactNode } from "react";
import { Check, Laugh, Pause, Play, Smile, Waves, Wind, Zap, type LucideIcon } from "lucide-react";
import { Sky, Orb } from "./Orb";
import { usePlayer } from "./player";
import type { ScriptEditor } from "./ScriptBox";
import { POINT_TAGS, SPAN_TAGS, type PointTag, type SpanTag } from "@/lib/voice/script";
import { cn } from "@/lib/cn";

/**
 * The composer's two panels. Add puts a sound where the cursor is, or says the selected words a certain way; How sets
 * the mood, the delivery and the language. Every choice has a real take behind its ▶: Mara, made by Drama 3 on an RTX
 * 5090 (public/assets/voice/previews, from scripts/assets/voice-previews.mjs).
 */

const PREVIEWS = "/assets/voice/previews";

export const MOODS: { id: string; label: string; text: string; hues: [string, string] }[] = [
  { id: "calm", label: "Calm", text: "Calm and even, no rush", hues: ["#c4e4ff", "#3a6cb4"] },
  { id: "warm", label: "Warm", text: "Warm and close, like talking to a friend", hues: ["#ffd9a3", "#c2611f"] },
  { id: "excited", label: "Excited", text: "Excited, can barely wait to say it", hues: ["#ffc0d8", "#d02f6c"] },
  { id: "serious", label: "Serious", text: "Serious and steady, every word matters", hues: ["#d3d9e6", "#39445a"] },
  { id: "sad", label: "Sad", text: "Quiet and sad, holding it together", hues: ["#c3caff", "#383d8f"] },
  { id: "storyteller", label: "Storyteller", text: "A storyteller by the fire, taking their time", hues: ["#cdf2ad", "#3d7d38"] },
  { id: "playful", label: "Playful", text: "Playful and teasing, a smile in every word", hues: ["#fff2a0", "#dd8a1b"] },
  { id: "announcer", label: "Announcer", text: "A confident announcer, big and clear", hues: ["#ffcaa8", "#c63b28"] },
];

export const LANGS: [string, string][] = [
  ["auto", "Auto"],
  ["en", "English"],
  ["pl", "Polski"],
  ["it", "Italiano"],
  ["es", "Español"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["pt", "Português"],
  ["ja", "日本語"],
];

const SOUND_ICON: Record<PointTag, LucideIcon> = { laughs: Laugh, chuckles: Smile, sighs: Wind, gasps: Zap, breath: Waves, pause: Pause };
const SOUND_HINT: Record<PointTag, string> = {
  laughs: "A real laugh",
  chuckles: "Under the breath",
  sighs: "Tired, or relieved",
  gasps: "Caught by surprise",
  breath: "Before a big line",
  pause: "A beat of silence",
};

/** How each way of saying words looks, so you see it before you hear it. */
const SPAN_LOOK: Record<SpanTag, { sample: ReactNode; hint: string }> = {
  whisper: { sample: <span className="italic tracking-wide text-paper/55">psst…</span>, hint: "Close and quiet" },
  slow: { sample: <span className="tracking-[0.32em] text-paper/85">s l o w</span>, hint: "Every word lands" },
  emphasis: { sample: <span className="font-extrabold uppercase text-paper underline decoration-[var(--color-tool-voice)] decoration-2 underline-offset-4">really</span>, hint: "Leans on them" },
};

/** ▶ for a preview take; the one playing shows its level as three bars. */
export function PreviewButton({ id, label, className }: { id: string; label: string; className?: string }) {
  const key = `preview:${id}`;
  const playing = usePlayer((s) => s.key === key && s.playing);
  const level = usePlayer((s) => (s.key === key ? s.level : 0));
  return (
    <button
      type="button"
      aria-label={playing ? `Stop ${label}` : `Hear ${label}`}
      title={playing ? "Stop" : "Hear it"}
      onClick={(e) => {
        e.stopPropagation();
        usePlayer.getState().toggle(key, `${PREVIEWS}/${id}.mp3`);
      }}
      className={cn(
        "press grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-150",
        playing ? "bg-paper text-[#16131b]" : "bg-black/35 text-paper hover:bg-black/55",
        className,
      )}
    >
      {playing ? (
        <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
          {[0.55, 1, 0.7].map((k, i) => (
            <i key={i} className="w-[2.5px] rounded-full bg-current transition-[height] duration-75" style={{ height: `${Math.max(25, Math.min(100, level * 160 * k + 25))}%` }} />
          ))}
        </span>
      ) : (
        <Play size={11} fill="currentColor" strokeWidth={0} className="translate-x-px" />
      )}
    </button>
  );
}

/** Add: sounds at the cursor, and ways to say the selected words. */
export function AddPanel({ editor, close }: { editor: ScriptEditor | null; close: () => void }) {
  return (
    <div className="flex w-[min(420px,calc(100vw-24px))] flex-col gap-3 p-2.5">
      <PanelHead title="Sounds" note="where the cursor is" />
      <div className="grid grid-cols-3 gap-1.5">
        {POINT_TAGS.map((t) => {
          const Icon = SOUND_ICON[t.tag];
          return (
            <div key={t.tag} className="voice-tile group/tile squircle relative rounded-[16px]">
              <button
                type="button"
                onClick={() => {
                  editor?.insertTag(t.tag);
                  close();
                }}
                className="press flex w-full flex-col items-start gap-2.5 rounded-[inherit] p-2.5 pb-2 text-left"
              >
                <span className="voice-tile-icon grid size-9 place-items-center rounded-[12px]">
                  <Icon size={17} strokeWidth={2.2} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold leading-tight text-paper">{t.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-tight text-haze">{SOUND_HINT[t.tag]}</span>
                </span>
              </button>
              <PreviewButton id={`sound-${t.tag}`} label={t.label} className="absolute right-2 top-2" />
            </div>
          );
        })}
      </div>
      <PanelHead title="Say the selected words" note="select them first" />
      <div className="grid grid-cols-3 gap-1.5">
        {SPAN_TAGS.map((t) => (
          <div key={t.tag} className="voice-tile squircle relative rounded-[16px]">
            <button
              type="button"
              onClick={() => {
                editor?.wrapSpan(t.tag);
                close();
              }}
              className="press flex w-full flex-col items-start gap-2 rounded-[inherit] p-2.5 pb-2 text-left"
            >
              <span className="flex h-9 items-center text-[14px]">{SPAN_LOOK[t.tag].sample}</span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-tight text-paper">{t.label}</span>
                <span className="mt-0.5 block truncate text-[11px] leading-tight text-haze">{SPAN_LOOK[t.tag].hint}</span>
              </span>
            </button>
            <PreviewButton id={`span-${t.tag}`} label={t.label} className="absolute right-2 top-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** How it's said: in your words or a mood, steady to lively, and the language. */
export function HowPanel(p: {
  who: { name: string; hues: [string, string] };
  direction: string;
  setDirection: (v: string) => void;
  lively: number;
  setLively: (v: number) => void;
  language: string;
  setLanguage: (v: string) => void;
  speed: number;
  setSpeed: (v: number) => void;
  canDirect: boolean;
  canSpeed: boolean;
  modelName: string;
}) {
  return (
    <div className="flex w-[min(460px,calc(100vw-24px))] flex-col gap-3.5 p-2.5">
      <div className="flex items-center gap-2.5 px-0.5 pt-0.5">
        <Orb hues={p.who.hues} size={30} />
        <div className="min-w-0">
          <p className="truncate font-display text-[17px] leading-tight">How {p.who.name} says it</p>
          <p className="truncate text-[11.5px] text-haze">{p.canDirect ? "In your own words, or pick a mood" : `${p.modelName} reads the words as they are`}</p>
        </div>
      </div>

      {p.canDirect ? (
        <>
          <label className="field-focus squircle block rounded-[14px] bg-black/25 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="sr-only">How it&rsquo;s said</span>
            <textarea
              value={p.direction}
              onChange={(e) => p.setDirection(e.target.value)}
              rows={2}
              placeholder="Like you'd tell an actor: calm, rushed, about to cry…"
              className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-snug text-paper outline-none placeholder:text-haze"
            />
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {MOODS.map((m) => {
              const on = p.direction.trim() === m.text;
              return (
                <div key={m.id} className={cn("voice-mood squircle relative h-[74px] overflow-hidden rounded-[14px]", on && "voice-mood-on")}>
                  <Sky hues={m.hues} still />
                  <button type="button" onClick={() => p.setDirection(on ? "" : m.text)} aria-pressed={on} title={m.text} className="press absolute inset-0 z-10 flex flex-col justify-end p-2 text-left">
                    <span className="flex items-center gap-1 text-[12.5px] font-bold leading-none text-white [text-shadow:0_1px_8px_rgb(0_0_0/0.45)]">
                      {on ? <Check size={12} strokeWidth={3.2} /> : null}
                      {m.label}
                    </span>
                  </button>
                  <PreviewButton id={`mood-${m.id}`} label={`${m.label} mood`} className="absolute right-1.5 top-1.5 z-20 size-6" />
                </div>
              );
            })}
          </div>
          <div>
            <PanelHead title="Delivery" />
            <div role="radiogroup" aria-label="Delivery" className="mt-1.5 grid grid-cols-3 gap-1 rounded-[14px] bg-black/25 p-1 shadow-[inset_0_0_0_1px_var(--color-line)]">
              {(["Steady", "Natural", "Lively"] as const).map((t, i) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={p.lively === i}
                  onClick={() => p.setLively(i)}
                  className={cn(
                    "press squircle flex h-11 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[12px] font-semibold",
                    p.lively === i ? "bg-white/[0.12] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.09),0_1px_2px_rgb(0_0_0/0.25)]" : "text-fog hover:text-paper",
                  )}
                >
                  <DeliveryWave level={i} on={p.lively === i} />
                  {t}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {p.canSpeed ? (
        <label className="block">
          <span className="flex items-baseline justify-between">
            <span className="label">Speed</span>
            <span className="tabular text-[12px] font-semibold text-fog">{p.speed.toFixed(2)}×</span>
          </span>
          <input type="range" min={0.8} max={1.3} step={0.05} value={p.speed} onChange={(e) => p.setSpeed(Number(e.target.value))} className="mt-1.5 w-full accent-[var(--color-tool-voice)]" />
        </label>
      ) : null}

      <div>
        <PanelHead title="Language" note={p.language === "auto" ? "from your words" : undefined} />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {LANGS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => p.setLanguage(v)}
              aria-pressed={p.language === v}
              className={cn(
                "press h-7 rounded-full px-2.5 text-[12px] font-semibold transition-colors duration-150",
                p.language === v ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.09] hover:text-paper",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PanelHead({ title, note }: { title: string; note?: string }) {
  return (
    <p className="flex items-baseline justify-between gap-2 px-0.5">
      <span className="label">{title}</span>
      {note ? <span className="text-[11px] text-haze">{note}</span> : null}
    </p>
  );
}

/** Steady, natural, lively: a line that's calm, moves, or bounces. */
function DeliveryWave({ level, on }: { level: number; on: boolean }) {
  const amp = [1.2, 4, 7.5][level];
  const d = `M1 9 C 5 ${9 - amp}, 9 ${9 - amp}, 13 9 S 21 ${9 + amp}, 25 9 S 33 ${9 - amp}, 37 9 S 45 ${9 + amp}, 47 9`;
  return (
    <svg width="48" height="18" viewBox="0 0 48 18" fill="none" aria-hidden="true" style={{ "--c": on ? "var(--color-tool-voice)" : "currentColor" } as CSSProperties}>
      <path d={d} stroke="var(--c)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
