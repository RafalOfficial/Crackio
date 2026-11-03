"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Download, LoaderCircle, Mic, Pause, Play, Search, ShieldCheck, Sparkles, Trash2, TriangleAlert, UserRound, Wand2, X } from "lucide-react";
import { LibraryDrawer, TabButton, useLibraryClose, type TabItem } from "@/components/models/ModelLibrary";
import { Sky } from "./Orb";
import { Wave } from "./Wave";
import { usePlayer } from "./player";
import { VoiceModelMark } from "./VoiceModelLibrary";
import { Listening, Recorder } from "./Recorder";
import { useVoiceStore } from "@/lib/hooks/use-voice";
import { HEARING, VOICE_MODELS, gbOf, variantFor, voiceModel, type VoiceModelId } from "@/lib/voice/models";
import type { VoiceCard, VoiceMachine } from "@/lib/voice/types";
import { cn } from "@/lib/cn";

export type VoiceView = "all" | "yours" | "clone" | "design";
type View = VoiceView;

/**
 * Voices, on the model library's glass sheet: Crackio's voices and yours as little skies to pick from, Clone a voice
 * (which model will speak it, your permission, then a recording or a clip, heard in that model before it's kept) and
 * Design a voice (described in words, made by the model that designs voices). `forWho` names the speaker being cast in
 * a conversation.
 */
export function VoiceDrawer({
  open,
  onClose,
  anchor,
  current,
  onPick,
  forWho,
  view = "all",
}: {
  open: boolean;
  onClose: () => void;
  /** The chip it opens from (the sheet lives where its trigger does). */
  anchor: HTMLElement | null;
  current: string | null;
  onPick: (v: VoiceCard) => void;
  forWho?: string | null;
  /** The tab it opens on. */
  view?: View;
}) {
  return (
    <LibraryDrawer open={open} onClose={onClose} anchor={anchor} glass label={forWho ? `Choose who plays ${forWho}` : "Choose a voice"}>
      <Voices key={open ? `open-${view}` : "shut"} current={current} onPick={onPick} forWho={forWho ?? null} first={view} />
    </LibraryDrawer>
  );
}

function Voices({ current, onPick, forWho, first }: { current: string | null; onPick: (v: VoiceCard) => void; forWho: string | null; first: View }) {
  const close = useLibraryClose();
  const ready = useVoiceStore((s) => s.ready);
  const yours = useVoiceStore((s) => s.yours);
  const tabsId = useId();
  const [view, setView] = useState<View>(first);
  const [query, setQuery] = useState("");
  const done = (v: VoiceCard) => {
    onPick(v);
    close();
  };
  const q = query.trim().toLowerCase();
  const fits = (v: VoiceCard) => !q || `${v.name} ${v.desc} ${v.tags.join(" ")}`.toLowerCase().includes(q);

  const tabs: TabItem<View>[] = [
    { id: "all", label: "All voices", caption: `${ready.length + yours.length} to pick from`, icon: <Sparkles size={15} /> },
    { id: "yours", label: "Yours", caption: yours.length ? `${yours.length} saved` : "None yet", icon: <UserRound size={15} /> },
    { id: "clone", label: "Clone a voice", caption: "From 10–30 s of talking", icon: <Mic size={15} /> },
    { id: "design", label: "Design a voice", caption: "From a description", icon: <Wand2 size={15} /> },
  ];

  return (
    <div data-sheet tabIndex={-1} className="@container flex h-full min-h-0 flex-col outline-none">
      <header className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[22px] leading-[1.2] sm:text-[24px]">{forWho ? `Who plays ${forWho}?` : "Voices"}</h2>
            <p className="mt-0.5 truncate text-[12.5px] text-haze">
              {view === "clone" ? "Your own voice, or one you have permission to use" : view === "design" ? "A new voice from words, made on your GPU" : "Pick one, ▶ to hear it first"}
            </p>
          </div>
          {view === "all" || view === "yours" ? (
            <label className="field-focus hidden h-10 w-[min(240px,30vw)] items-center gap-2 rounded-full bg-white/[0.06] px-3.5 sm:flex">
              <Search size={15} className="shrink-0 text-haze" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices" aria-label="Search voices" data-autofocus className="min-w-0 flex-1 bg-transparent text-[13.5px] text-paper outline-none placeholder:text-haze" />
            </label>
          ) : null}
          <button type="button" onClick={close} aria-label="Close" className="press grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper">
            <X size={17} />
          </button>
        </div>
        <div className="relative mt-3.5">
          <div className="scroll-thin flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <TabButton key={t.id} item={t} on={view === t.id} layout={tabsId} onClick={() => setView(t.id)} />
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line" />
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-5 sm:px-6">
        {view === "all" ? (
          <div className="space-y-6">
            {yours.filter(fits).length ? <VoiceGrid title="Yours" voices={yours.filter(fits)} current={current} onPick={done} mine /> : null}
            <VoiceGrid title="Crackio's voices" hint="Designed from words with VoxCPM2, never copied from a real person" voices={ready.filter(fits)} current={current} onPick={done} />
          </div>
        ) : view === "yours" ? (
          yours.filter(fits).length ? (
            <VoiceGrid title="Yours" voices={yours.filter(fits)} current={current} onPick={done} mine />
          ) : (
            <div className="rounded-[18px] bg-white/[0.025] px-5 py-10 text-center">
              <p className="text-[14.5px] font-semibold text-paper">No voices of your own yet</p>
              <p className="mx-auto mt-1 max-w-[44ch] text-[13px] leading-relaxed text-haze">Clone one from a recording, or design one from a description. They stay on this computer.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <GhostTab onClick={() => setView("clone")} icon={<Mic size={14} />}>
                  Clone a voice
                </GhostTab>
                <GhostTab onClick={() => setView("design")} icon={<Wand2 size={14} />}>
                  Design a voice
                </GhostTab>
              </div>
            </div>
          )
        ) : view === "clone" ? (
          <Clone onSaved={done} />
        ) : (
          <Design onSaved={done} />
        )}
      </div>
    </div>
  );
}

function GhostTab({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="press inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-[13px] font-semibold text-paper hover:bg-white/[0.14]">
      {icon} {children}
    </button>
  );
}

/* ------------------------------------------------------------------ the voices */

function VoiceGrid({ title, hint, voices, current, onPick, mine }: { title: string; hint?: string; voices: VoiceCard[]; current: string | null; onPick: (v: VoiceCard) => void; mine?: boolean }) {
  return (
    <section>
      <h3 className="label mb-2.5">
        {title}
        {hint ? <span className="ml-2 font-medium normal-case tracking-normal text-haze/80">{hint}</span> : null}
      </h3>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]">
        {voices.map((v) => (
          <VoiceTile key={v.id} v={v} on={current === v.id} onPick={() => onPick(v)} mine={mine} />
        ))}
      </ul>
    </section>
  );
}

/** A voice as a little sky: its name, a word on how it sounds, ▶ to hear it. */
function VoiceTile({ v, on, onPick, mine }: { v: VoiceCard; on: boolean; onPick: () => void; mine?: boolean }) {
  const remove = useVoiceStore((s) => s.removeVoice);
  return (
    <li className={cn("voice-card squircle relative aspect-[5/4] overflow-hidden rounded-[18px]", on && "voice-card-on")}>
      <Sky hues={v.hues} still />
      <button type="button" onClick={onPick} aria-label={`${v.name}: ${v.desc}`} aria-current={on || undefined} className="absolute inset-0 z-10 rounded-[inherit] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-paper)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-1.5 p-2">
        <span className="flex flex-wrap gap-1">
          {v.tags.slice(0, 2).map((t) => (
            <span key={t} className="rounded-full bg-[#0d0c11]/55 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-paper/90">
              {t}
            </span>
          ))}
        </span>
        {on ? (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-tool-voice)] text-[#11200a] shadow-[0_2px_8px_rgb(0_0_0/0.4)]">
            <Check size={14} strokeWidth={3} />
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end gap-2 p-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[19px] leading-tight text-white [text-shadow:0_1px_10px_rgb(0_0_0/0.4)]">{v.name}</p>
          <p className="truncate text-[11.5px] text-white/75">{v.desc}</p>
        </div>
        {mine ? (
          <button
            type="button"
            aria-label={`Delete ${v.name}`}
            title="Delete"
            onClick={() => void remove(v.id)}
            className="press pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full bg-[#0d0c11]/55 text-white/70 hover:bg-tally/80 hover:text-white"
          >
            <Trash2 size={13} />
          </button>
        ) : null}
        <SampleButton id={`sample:${v.id}`} url={v.sample} label={v.name} />
      </div>
    </li>
  );
}

function SampleButton({ id, url, label }: { id: string; url: string; label: string }) {
  const playing = usePlayer((s) => s.key === id && s.playing);
  return (
    <button
      type="button"
      aria-label={playing ? `Stop ${label}` : `Hear ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        usePlayer.getState().toggle(id, url);
      }}
      className="press pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full bg-paper text-[#16131b] shadow-[0_4px_14px_rgb(0_0_0/0.35)] hover:bg-white"
    >
      {playing ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
    </button>
  );
}

/* ------------------------------------------------------------------ which model does it */

/** Where a model is: on which GPU, on its way, or not yet (and whether one of your GPUs could hold it). */
function modelState(id: VoiceModelId, machines: VoiceMachine[]) {
  const m = voiceModel(id)!;
  const usable = machines.filter((x) => x.online && x.voiceReady);
  // Ready means the model AND audio.cpp are there; a file without the engine still needs its one-click setup.
  const on = usable.find((x) => x.engine && x.models.includes(id));
  const coming = usable.find((x) => !x.models.includes(id) && x.downloads.some((d) => m.variants.some((v) => v.file.name === d.file)));
  // Its file is there but audio.cpp isn't: set that up there, before anywhere else.
  const half = usable.find((x) => !x.engine && x.models.includes(id));
  const fits = half ?? usable.filter((x) => variantFor(m, x.gpuGb, x.ramGb, x.unified)).sort((a, b) => (b.gpuGb ?? 0) - (a.gpuGb ?? 0))[0];
  return { m, on, coming, fits, half };
}

/**
 * The step that says which model does the job: one tile per model that can, with where it is. One that isn't on your
 * GPUs yet gets itself there in a click (audio.cpp and speech to text with the first).
 */
function ModelChoice({ ids, value, onChange, cant }: { ids: VoiceModelId[]; value: VoiceModelId; onChange: (id: VoiceModelId) => void; cant: string }) {
  const machines = useVoiceStore((s) => s.machines);
  const others = VOICE_MODELS.filter((m) => !ids.includes(m.id));
  return (
    <div>
      <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ids.map((id) => {
          const { m, on, coming, fits, half } = modelState(id, machines);
          const chosen = value === id;
          return (
            <div
              key={id}
              role="radio"
              aria-checked={chosen}
              tabIndex={0}
              onClick={() => onChange(id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onChange(id))}
              className={cn(
                "squircle flex cursor-pointer items-center gap-3 rounded-[16px] bg-white/[0.035] p-3 outline-none transition-shadow focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-paper)]",
                chosen ? "shadow-[inset_0_0_0_1.5px_var(--color-tool-voice)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
              )}
            >
              <VoiceModelMark model={m} size={38} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-paper">
                  {m.name}
                  {chosen ? <Check size={14} className="text-[var(--color-tool-voice)]" /> : null}
                </span>
                <span className="mt-0.5 block truncate text-[12px]">
                  {on ? (
                    <span className="text-chroma">On {on.gpu ?? on.label}</span>
                  ) : coming ? (
                    <span className="text-fog">Downloading to {coming.gpu ?? coming.label}…</span>
                  ) : half ? (
                    <span className="text-tungsten">On {half.gpu ?? half.label} · needs audio.cpp</span>
                  ) : fits ? (
                    <span className="text-tungsten">Not on your GPUs yet</span>
                  ) : (
                    <span className="text-haze">Needs a bigger GPU</span>
                  )}
                </span>
              </span>
              {!on && !coming && fits ? <GetModel id={id} machine={fits} /> : null}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-haze">
        {others.map((m) => m.name).join(" and ")} {cant}
      </p>
    </div>
  );
}

function GetModel({ id, machine }: { id: VoiceModelId; machine: VoiceMachine }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = voiceModel(id)!;
  const fit = variantFor(m, machine.gpuGb, machine.ramGb, machine.unified);
  const has = Boolean(fit && machine.files.includes(fit.variant.file.name));
  const bytes = (has ? 0 : (fit?.variant.file.bytes ?? 0)) + (machine.hearing ? 0 : HEARING.reduce((s, f) => s + f.bytes, 0));
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        title={`Get ${m.name} on ${machine.gpu ?? machine.label}`}
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/voice/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id, machine: machine.id }) });
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(data.error ?? "Couldn't start it.");
            await useVoiceStore.getState().loadMachines(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="lip press inline-flex h-8 items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
      >
        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} {has && !bytes ? "Set up audio.cpp" : `Get it · ${gbOf(bytes)}`}
      </button>
      {error ? <span className="max-w-[220px] text-right text-[11px] leading-snug text-tally">{error}</span> : null}
    </span>
  );
}

function Step({ n, title, note, children, dim }: { n: number; title: string; note?: ReactNode; children: ReactNode; dim?: boolean }) {
  return (
    <section className={cn("transition-opacity duration-200", dim && "pointer-events-none opacity-40")} inert={dim || undefined}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] font-mono text-[11px] font-bold text-paper">{n}</span>
        <h3 className="text-[14.5px] font-semibold text-paper">{title}</h3>
        {note ? <span className="min-w-0 truncate text-[12px] text-haze">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ clone */

type Sample = { url: string; file: string; seconds: number; peaks: number[]; checks: { long: boolean; clean: boolean; loud: boolean }; text: string; heard: boolean };
type Heard = { url: string; file: string; peaks: number[]; seconds: number; model: string; gpu: string };

const CLONERS = VOICE_MODELS.filter((m) => m.can.clone).map((m) => m.id);

function Clone({ onSaved }: { onSaved: (v: VoiceCard) => void }) {
  const machines = useVoiceStore((s) => s.machines);
  // The model that will speak it: the first one you have, else the first that clones.
  const firstOn = CLONERS.find((id) => machines.some((m) => m.online && m.models.includes(id)));
  const [model, setModel] = useState<VoiceModelId | null>(null);
  const chosen = model ?? firstOn ?? CLONERS[0];
  const [consent, setConsent] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("My voice");
  const [heard, setHeard] = useState<Heard | null>(null);
  // A clip on its way to the server (its shape while it's read), and what went wrong reading one.
  const [pending, setPending] = useState<number[] | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const consentRef = useRef<HTMLButtonElement>(null);
  const added = useVoiceStore((s) => s.added);

  // Record or Upload before the permission is ticked: point at it.
  const nudge = () => {
    const el = consentRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.animate(
      still
        ? [{ boxShadow: "inset 0 0 0 2px var(--color-tool-voice)" }, { boxShadow: "inset 0 0 0 1px var(--color-line-strong)" }]
        : [
            { transform: "translateX(0)", boxShadow: "inset 0 0 0 2px var(--color-tool-voice)" },
            { transform: "translateX(-7px)" },
            { transform: "translateX(6px)" },
            { transform: "translateX(-3px)" },
            { transform: "translateX(0)", boxShadow: "inset 0 0 0 1px var(--color-line-strong)" },
          ],
      { duration: still ? 900 : 520, easing: "cubic-bezier(.22,1,.36,1)" },
    );
  };

  const send = async (blob: Blob, filename: string, levels: number[]) => {
    setPending(levels);
    setClipError(null);
    setError(null);
    setHeard(null);
    try {
      const form = new FormData();
      form.append("file", blob, filename);
      const res = await fetch("/api/voice/sample", { method: "POST", body: form });
      const data = (await res.json()) as Sample & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't read that clip.");
      setSample(data);
      setText(data.text);
    } catch (e) {
      setClipError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  const hear = async () => {
    if (!sample) return;
    setBusy(`${voiceModel(chosen)!.name} is trying the voice…`);
    setError(null);
    try {
      const res = await fetch("/api/voice/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: sample.file, text, model: chosen }) });
      const data = (await res.json()) as Heard & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't try it.");
      setHeard(data);
      usePlayer.getState().toggle(`scratch:${data.file}`, data.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!sample || !consent) return;
    setBusy("Saving…");
    setError(null);
    try {
      const res = await fetch("/api/voice/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text, file: sample.file, source: "clone", consent }),
      });
      const data = (await res.json()) as { voice?: VoiceCard; error?: string };
      if (!res.ok || !data.voice) throw new Error(data.error ?? "Couldn't save it.");
      added(data.voice);
      onSaved(data.voice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const m = voiceModel(chosen)!;
  return (
    <div className="flex max-w-[720px] flex-col gap-7">
      <Step n={1} title="Which model will speak it" note="the clone is a clip; this model reads it">
        <ModelChoice ids={CLONERS} value={chosen} onChange={(id) => (setModel(id), setHeard(null))} cant="can't clone: they speak in voices of their own." />
      </Step>

      <Step n={2} title="Your permission">
        <button
          ref={consentRef}
          type="button"
          role="switch"
          aria-checked={consent}
          onClick={() => setConsent((c) => !c)}
          className={cn(
            "squircle flex w-full items-start gap-3.5 rounded-[16px] p-3.5 text-left transition-[background-color,box-shadow] duration-200",
            consent ? "bg-[color-mix(in_oklab,var(--color-tool-voice)_10%,transparent)] shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-tool-voice)_55%,transparent)]" : "bg-white/[0.035] shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
          )}
        >
          <span className={cn("relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors duration-200", consent ? "bg-[var(--color-tool-voice)]" : "bg-white/[0.16]")}>
            <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200", consent ? "translate-x-[18px]" : "translate-x-0.5")} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[14px] font-semibold text-paper">
              <ShieldCheck size={15} className={consent ? "text-[var(--color-tool-voice)]" : "text-haze"} /> I have permission to clone this voice
            </span>
            <span className="mt-1 block text-[12.5px] leading-relaxed text-fog">
              It&rsquo;s my own voice, or its owner agreed to have it cloned. Cloning anyone without their consent isn&rsquo;t allowed
              {m.credit ? `, and ${m.name}'s licence forbids it` : ""}.
            </span>
          </span>
        </button>
      </Step>

      <Step n={3} title="Their voice" note="10 to 30 seconds of one person talking, in a quiet room">
        {!sample ? (
          <div className="flex flex-col gap-2.5">
            {pending ? <Listening levels={pending} /> : <Recorder locked={!consent} onLocked={nudge} onClip={(clip, filename, levels) => void send(clip, filename, levels)} />}
            {clipError ? (
              <p role="alert" className="flex items-start gap-2 text-[13px] leading-snug text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {clipError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <ClipLine id={`scratch:${sample.file}`} url={sample.url} peaks={sample.peaks} seconds={sample.seconds} label="Your clip" />
            <ul className="flex flex-wrap gap-1.5 text-[12.5px]">
              <Check2 ok={sample.checks.long} yes={`${Math.round(sample.seconds)} seconds`} no={`Only ${Math.round(sample.seconds)} s: 10+ clones better`} />
              <Check2 ok={sample.checks.clean} yes="Quiet room" no="Some noise under it" />
              <Check2 ok={sample.checks.loud} yes="Not too loud" no="Too loud in places" />
            </ul>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-fog">{sample.heard ? "What it says (typed for you; fix anything wrong)" : "Type exactly what it says"}</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="field-focus squircle resize-none rounded-[14px] bg-black/25 px-3 py-2.5 text-[14px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
            </label>
            <button type="button" onClick={() => (setSample(null), setHeard(null))} className="press self-start text-[12.5px] font-semibold text-fog underline decoration-white/20 underline-offset-2 hover:text-paper">
              Use another clip
            </button>
          </div>
        )}
      </Step>

      <Step n={4} title={`Hear it as ${m.name}, then keep it`} dim={!sample || !consent}>
        <div className="flex flex-col gap-3.5">
          {heard ? <ClipLine id={`scratch:${heard.file}`} url={heard.url} peaks={heard.peaks} seconds={heard.seconds} label={`${heard.model} · ${heard.gpu}`} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!sample || !text.trim() || Boolean(busy)}
              onClick={() => void hear()}
              className="press squircle flex h-11 items-center gap-2 rounded-[14px] bg-white/[0.08] px-4 text-[13.5px] font-semibold text-paper hover:bg-white/[0.13] disabled:opacity-50"
            >
              <Play size={14} fill="currentColor" strokeWidth={0} /> {heard ? "Try again" : `Hear it as ${m.name}`}
            </button>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Name" placeholder="Name" className="field-focus squircle h-11 min-w-[140px] flex-1 rounded-[14px] bg-black/25 px-3 text-[14px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
            <button
              type="button"
              disabled={!consent || !sample || !text.trim() || !name.trim() || Boolean(busy)}
              onClick={() => void save()}
              className="press squircle flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[var(--color-tool-voice)] px-5 text-[14px] font-bold text-[#11200a] disabled:bg-apple-2 disabled:text-haze"
            >
              <Check size={16} /> Save voice
            </button>
          </div>
          <p className="text-[12px] leading-relaxed text-haze">It stays on this computer. Every model that clones speaks with it, not only {m.name}.</p>
        </div>
      </Step>

      <Status busy={busy} error={error} />
    </div>
  );
}

function ClipLine({ id, url, peaks, seconds, label }: { id: string; url: string; peaks: number[]; seconds: number; label: string }) {
  const playing = usePlayer((s) => s.key === id && s.playing);
  const progress = usePlayer((s) => (s.key === id && s.duration ? s.time / s.duration : 0));
  return (
    <div className="squircle flex items-center gap-3 rounded-[16px] bg-black/25 p-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => usePlayer.getState().toggle(id, url)} className="press grid size-10 shrink-0 place-items-center rounded-full bg-paper text-stage">
        {playing ? <Pause size={15} fill="currentColor" strokeWidth={0} /> : <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
      </button>
      <div className="h-11 min-w-0 flex-1">
        <Wave peaks={peaks} progress={progress} onSeek={(s) => usePlayer.getState().seek(id, url, s * seconds)} />
      </div>
      <span className="hidden shrink-0 text-right text-[11.5px] leading-tight text-fog sm:block">
        {label}
        <span className="tabular block text-haze">{seconds.toFixed(0)} s</span>
      </span>
    </div>
  );
}

function Check2({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <li className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1", ok ? "bg-chroma/10 text-chroma" : "bg-tungsten/10 text-tungsten")}>
      {ok ? <Check size={12} /> : <span className="size-1.5 rounded-full bg-current" />} {ok ? yes : no}
    </li>
  );
}

function Status({ busy, error }: { busy: string | null; error: string | null }) {
  if (!busy && !error) return null;
  return busy ? (
    <p className="flex items-center gap-2 text-[13px] text-fog">
      <LoaderCircle size={14} className="animate-spin" /> {busy}
    </p>
  ) : (
    <p className="flex items-start gap-2 text-[13px] leading-snug text-tally">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {error}
    </p>
  );
}

/* ------------------------------------------------------------------ design */

const PICKS = [
  ["Woman", "Man", "Young adult", "Older"],
  ["Warm", "Bright", "Deep", "Raspy", "Breathy"],
  ["Slow", "Fast", "Calm", "Energetic"],
  ["British accent", "American accent", "Italian accent", "Polish accent"],
];
type Option = { url: string; file: string; peaks: number[]; text: string; seconds: number };
const DESIGNERS = VOICE_MODELS.filter((m) => m.can.design).map((m) => m.id);

function Design({ onSaved }: { onSaved: (v: VoiceCard) => void }) {
  const [designer, setDesigner] = useState<VoiceModelId>(DESIGNERS[0]);
  const [desc, setDesc] = useState("A woman in her thirties with a warm, low voice and a light Italian accent. Speaks slowly, like she's smiling.");
  const [line, setLine] = useState("Hi, I'm your new voice. Shall we start?");
  const [options, setOptions] = useState<Option[] | null>(null);
  const [kept, setKept] = useState<number | null>(null);
  const [name, setName] = useState("New voice");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const added = useVoiceStore((s) => s.added);
  const machines = useVoiceStore((s) => s.machines);
  const playingKey = usePlayer((s) => (s.playing ? s.key : null));
  const t = usePlayer((s) => s.time);
  const d = usePlayer((s) => s.duration);
  const ready = useMemo(() => machines.some((m) => m.online && m.models.includes(designer)), [machines, designer]);
  const dm = voiceModel(designer)!;

  const make = async () => {
    setBusy(`${dm.name} is making three takes on it…`);
    setError(null);
    setOptions(null);
    setKept(null);
    try {
      const res = await fetch("/api/voice/design", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: desc, line }) });
      const data = (await res.json()) as { options?: Option[]; error?: string };
      if (!res.ok || !data.options) throw new Error(data.error ?? "Couldn't design it.");
      setOptions(data.options);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (kept === null || !options) return;
    setBusy("Saving…");
    try {
      const o = options[kept];
      const res = await fetch("/api/voice/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text: o.text, file: o.file, source: "design", desc: desc.slice(0, 90) }),
      });
      const data = (await res.json()) as { voice?: VoiceCard; error?: string };
      if (!res.ok || !data.voice) throw new Error(data.error ?? "Couldn't save it.");
      added(data.voice);
      onSaved(data.voice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-7">
      <Step n={1} title="The model that designs it" note="then any model that clones speaks with it">
        <ModelChoice ids={DESIGNERS} value={designer} onChange={setDesigner} cant="can't make a voice from words: they speak the voices you design or clone." />
      </Step>

      <Step n={2} title="Describe the voice" note="who, how it sounds, how they speak">
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className="field-focus squircle w-full resize-none rounded-[14px] bg-black/25 px-3 py-2.5 text-[14px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
        <div className="mt-2.5 flex flex-col gap-1.5">
          {PICKS.map((row, i) => (
            <div key={i} className="flex flex-wrap gap-1.5">
              {row.map((p) => {
                const on = desc.toLowerCase().includes(p.toLowerCase());
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDesc((v) => (on ? v : `${v.trim().replace(/[.]?$/, ".")} ${p}.`))}
                    className={cn(
                      "press h-7 rounded-full px-2.5 text-[12px] font-semibold transition-colors duration-150",
                      on ? "bg-[color-mix(in_oklab,var(--color-tool-voice)_18%,transparent)] text-[#c9f5a2]" : "bg-white/[0.05] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.09] hover:text-paper",
                    )}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Step>

      <Step n={3} title="A line for it to say" note="the takes you'll compare">
        <input value={line} onChange={(e) => setLine(e.target.value)} className="field-focus squircle h-11 w-full rounded-[14px] bg-black/25 px-3 text-[14px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
      </Step>

      <Step n={4} title="Pick one of three, keep it">
        <div className="flex flex-col gap-3">
          <button
            type="button"
            disabled={Boolean(busy) || desc.trim().length < 3 || !ready}
            onClick={() => void make()}
            title={ready ? undefined : `Get ${dm.name} in step 1 first`}
            className="press squircle flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[var(--color-tool-voice)] text-[14px] font-bold text-[#11200a] disabled:bg-apple-2 disabled:text-haze"
          >
            <Sparkles size={16} /> {options ? "Make three more" : ready ? "Make three" : `Get ${dm.name} first (step 1)`}
          </button>
          {options ? (
            <ul className="grid grid-cols-3 gap-2">
              {options.map((o, i) => {
                const key = `scratch:${o.file}`;
                return (
                  <li key={o.file}>
                    <button
                      type="button"
                      onClick={() => {
                        setKept(i);
                        usePlayer.getState().toggle(key, o.url);
                      }}
                      className={cn(
                        "squircle flex w-full flex-col gap-2 rounded-[16px] bg-black/25 p-2.5 text-left",
                        kept === i ? "shadow-[inset_0_0_0_1.5px_var(--color-tool-voice)]" : "shadow-[inset_0_0_0_1px_var(--color-line)]",
                      )}
                    >
                      <span className="flex items-center justify-between text-[12px] font-semibold text-fog">
                        Take {i + 1} {kept === i ? <Check size={13} className="text-[var(--color-tool-voice)]" /> : <Play size={11} fill="currentColor" strokeWidth={0} />}
                      </span>
                      <span className="block h-9">
                        <Wave peaks={o.peaks} progress={playingKey === key && d ? t / d : 0} bar={2} gap={1.5} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {kept !== null ? (
            <div className="flex items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Name" className="field-focus squircle h-11 min-w-0 flex-1 rounded-[14px] bg-black/25 px-3 text-[14px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)]" />
              <button type="button" onClick={() => void save()} disabled={Boolean(busy) || !name.trim()} className="press squircle flex h-11 items-center gap-2 rounded-[14px] bg-paper px-4 text-[14px] font-bold text-stage disabled:opacity-50">
                <Check size={16} /> Keep it
              </button>
            </div>
          ) : null}
        </div>
      </Step>

      <Status busy={busy} error={error} />
    </div>
  );
}
