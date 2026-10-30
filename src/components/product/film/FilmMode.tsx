"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRightLeft, Camera, Clapperboard, LoaderCircle, Repeat, TriangleAlert, UserRound } from "lucide-react";
import { useGenerations } from "@/lib/hooks/use-generations";
import { resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { useCast } from "@/lib/hooks/use-cast";
import type { Someone } from "@/lib/cast/types";
import { useMentions } from "@/components/cast/Mentions";
import { Panel, PanelHeader, Switch } from "@/components/ui/Panel";
import { DurationRuler } from "@/components/ui/DurationRuler";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine } from "@/components/models/CostLine";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { durationTicks } from "@/lib/models/caps";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { previewUrl } from "@/lib/media-url";
import {
  FILM_CAMERAS,
  FILM_HOOKS,
  FILM_MOODS,
  FILM_PACES,
  FILM_STORIES,
  FILM_STYLES,
  STYLE_DEFAULTS,
  STYLE_STEPS,
  byFilmId,
  filmOptionsFor,
  filmSummary,
  type FilmAxis,
  type FilmCameraId,
  type FilmHookId,
  type FilmMoodId,
  type FilmOption,
  type FilmPaceId,
  type FilmSpec,
  type FilmStoryId,
  type FilmStyleId,
  type LanguageId,
  type StudioPicture,
  type VoiceId,
  type WordsMode,
} from "@/lib/product/film";
import { filmPreviews, stillById, tilePreview } from "@/lib/product/film-previews";
import { filmFit, type FilmAsk } from "@/lib/product/film-fit";
import { Step } from "../Step";
import { FilmOptionGrid } from "./FilmOptionGrid";
import { FilmOutput, isFilmTake } from "./FilmOutput";
import { PicturePicker, type FilmPicture } from "./PicturePicker";
import { WordsStep } from "./WordsStep";
import { cn } from "@/lib/cn";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

type StepId = FilmAxis | "words";
const PEOPLE: FilmStyleId[] = ["creator", "lifestyle"];
/** Models that talk, take references and render 1080p: Video mode's first choice. */
const PREFER = ["local:ltx-2.5", "comfy:minimax/minimax-h3", "comfy:veo/veo-3.1-generate-001"];
const TITLES: Record<StepId, string> = { style: "Style", camera: "Filmed", hook: "Hook", mood: "Mood", pace: "Pace", story: "Story", words: "Words" };

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="label">{title}</h2>
        {hint ? <span className="text-right text-[11.5px] text-haze">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The page's frame shape closest to a picture's. */
const aspectFor = (ratio: number): AspectId => ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

/**
 * Product Studio's Video mode: a picture you made (or any picture) becomes an ad you can post. Pick a
 * style, how it's filmed, the hook, the mood and how it unfolds, each one shown as a real clip; Crackio
 * fits them to your product, writes what's said, films, watches every frame and re-films once if needed.
 */
export function FilmMode({ incoming, onShoot }: { incoming: FilmPicture | null; onShoot: () => void }) {
  const submit = useGenerations((s) => s.submit);
  const items = useGenerations((s) => s.items);
  const { models, defaults, loaded: modelsLoaded } = useModels();
  const cast = useCast();
  const [model, setModel] = useModelChoice("video", "animate");
  const [mine, setMine] = useState<StudioPicture[] | null>(null);
  const [selected, setSelected] = useState<FilmPicture[]>([]);
  const [style, setStyle] = useState<FilmStyleId>("creator");
  const [camera, setCamera] = useState<FilmCameraId>("auto");
  const [hook, setHook] = useState<FilmHookId>("none");
  const [mood, setMood] = useState<FilmMoodId>("warm");
  const [pace, setPace] = useState<FilmPaceId>("natural");
  const [story, setStory] = useState<FilmStoryId>("one");
  const [words, setWords] = useState<WordsMode>("auto");
  const [script, setScript] = useState("");
  const [language, setLanguage] = useState<LanguageId>("en-US");
  const [voice, setVoice] = useState<VoiceId | null>(null);
  // Most people watch ads muted: captions are on by default.
  const [captions, setCaptions] = useState(true);
  const [castId, setCastId] = useState<string | null>(null);
  const [loop, setLoop] = useState(true);
  // 720p is quicker and lighter on a plan's limits, for trying ideas; 1080p for the take you post.
  const [quality, setQuality] = useState<"720p" | "1080p">("1080p");
  const [seconds, setSeconds] = useState(12);
  const [check, setCheck] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ axis: FilmAxis; id: string }>({ axis: "style", id: "creator" });
  const [openStep, setOpenStep] = useState<StepId | null>(null);
  const [done, setDone] = useState<StepId[]>([]);
  const stepRefs = useRef<Partial<Record<StepId, HTMLElement | null>>>({});
  const notesField = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ textarea: notesField, value: notes, onChange: setNotes });
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  // Your newest Product Studio pictures, again whenever a new one is made.
  const imageTakes = items.filter((g) => g.tool === "product" && g.params?.kind === "image" && g.status === "done").length;
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/product/takes?limit=10", { signal: ctrl.signal, cache: "no-store" })
      .then((r) => r.json() as Promise<{ pictures?: StudioPicture[] }>)
      .then((d) => setMine(d.pictures ?? []))
      .catch(() => {
        if (!ctrl.signal.aborted) setMine([]);
      });
    return () => ctrl.abort();
  }, [imageTakes]);

  // A picture sent from Image mode ("Make a video") is picked; otherwise your newest, once they load.
  const [took, setTook] = useState<string | null>(null);
  if (incoming && incoming.url !== took) {
    setTook(incoming.url);
    setSelected([incoming]);
  }
  if (!incoming && !selected.length && mine?.length && took !== "auto") {
    setTook("auto");
    const p = mine[0];
    setSelected([{ url: p.url, width: p.width, height: p.height, idea: p.idea, from: p.from, productUrl: p.productUrl, people: p.people }]);
  }

  const picture = selected[0] ?? null;
  // Once there's a picture, the walk through "Your ad" starts at its first step.
  const [walked, setWalked] = useState(false);
  if (picture && !walked && !done.length && openStep === null) {
    setWalked(true);
    setOpenStep("style");
  }
  const multi = style === "campaign" ? 6 : 1;
  const like = picture ? (picture.sample ? (stillById(picture.sample)?.product ?? null) : (mine?.find((m) => m.url === picture.url)?.like ?? null)) : null;
  const ratio = picture ? picture.width / picture.height : 9 / 16;
  const aspect = aspectFor(ratio);

  // The model that will run, and what it can do.
  const autoId = model === "auto" ? resolveAutoId("video", models, defaults, PREFER) : null;
  const effectiveId = model === "auto" ? autoId : model;
  const info = useModelInfo(effectiveId);
  const caps = info.caps;
  const noModel = modelsLoaded && !effectiveId;
  const maxClip = caps?.duration ? durationTicks(caps.duration).max : 15;
  const minClip = caps?.duration ? durationTicks(caps.duration).min : 1;
  const talks = style === "creator" && words !== "none";
  const coStar = PEOPLE.includes(style) && (story === "handoff" || story === "joins");
  const castChar = coStar && castId ? (cast.items.find((c): c is Someone => c.id === castId && Boolean(c.portrait) && c.kind !== "object") ?? null) : null;

  const ask: FilmAsk = { style, words, story, loop: style === "living" && loop, seconds, language, cast: Boolean(castChar), voice: Boolean(voice), pictures: selected.length };
  const fit = filmFit(effectiveId, caps, ask);
  // The first connected model that does everything you picked, to offer when yours can't.
  const better = useMemo(() => {
    if (fit.ok) return null;
    return models.find((m) => m.kind === "video" && m.available && m.id !== effectiveId && m.caps && filmFit(m.id, m.caps, ask).ok) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.ok, models, effectiveId, style, words, story, loop, seconds, language, castChar, voice, selected.length]);

  // Lengths: the model's own, and longer ones made in parts (talking and lifestyle takes) or shot by shot (Campaign).
  const longest = style === "creator" || style === "lifestyle" || style === "campaign" ? Math.max(maxClip, 30) : maxClip;
  const allowed = Array.from({ length: longest - minClip + 1 }, (_, i) => minClip + i);
  const secondsNow = Math.min(longest, Math.max(minClip, seconds));

  const steps = STYLE_STEPS[style];
  const value: Record<FilmAxis, string> = { style, camera, hook, mood, pace, story };
  const listOf = (axis: FilmAxis): readonly FilmOption[] =>
    axis === "style" ? FILM_STYLES : axis === "camera" ? filmOptionsFor(FILM_CAMERAS, style) : axis === "hook" ? filmOptionsFor(FILM_HOOKS, style) : axis === "mood" ? FILM_MOODS : axis === "pace" ? FILM_PACES : filmOptionsFor(FILM_STORIES, style);
  const thumbOf = (axis: FilmAxis, id: string) => tilePreview(filmPreviews(axis, id), like, 0)?.poster ?? null;
  const warn = (o: FilmOption) => (o.needs?.includes("sound") && caps && !caps.audio ? "Needs a model with sound" : null);

  /** A pick lands: its step closes and the next one you haven't been through opens. */
  function advance(from: StepId, list = steps) {
    const nextDone = done.includes(from) ? done : [...done, from];
    setDone(nextDone);
    const next = list.slice(list.indexOf(from) + 1).find((s) => !nextDone.includes(s)) ?? list.find((s) => !nextDone.includes(s)) ?? null;
    later(() => {
      setOpenStep(next);
      if (next) later(() => stepRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" }), 360);
    }, 200);
  }

  function chooseStyle(id: FilmStyleId) {
    const d = STYLE_DEFAULTS[id];
    setStyle(id);
    setCamera(d.camera);
    setHook(d.hook);
    setMood(d.mood);
    setPace(d.pace);
    setStory(d.story);
    setSeconds(d.seconds);
    setFocus({ axis: "style", id });
    if (id !== "campaign") setSelected((s) => s.slice(0, 1));
    setDone(["style"]);
    later(() => {
      const next = STYLE_STEPS[id][1] ?? null;
      setOpenStep(next);
      if (next) later(() => stepRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" }), 360);
    }, 200);
  }

  const choose = (axis: FilmAxis) => (id: string) => {
    if (axis === "style") return chooseStyle(id as FilmStyleId);
    ({ camera: setCamera, hook: setHook, mood: setMood, pace: setPace, story: setStory } as Record<FilmAxis, (v: string) => void>)[axis](id as never);
    setFocus({ axis, id });
    // Someone joining waits for you to say who.
    if (axis === "story" && (id === "handoff" || id === "joins")) return;
    advance(axis);
  };

  function toggleStep(step: StepId) {
    setOpenStep((o) => (o === step ? null : step));
    if (step !== "words") setFocus({ axis: step, id: value[step] });
  }

  function togglePicture(p: FilmPicture) {
    setError(null);
    setSelected((cur) => {
      const has = cur.some((c) => c.url === p.url);
      if (multi === 1) return has ? cur : [p];
      return has ? cur.filter((c) => c.url !== p.url) : [...cur, p].slice(0, multi);
    });
  }

  const draft = useCallback(async () => {
    const res = await fetch("/api/product/film/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ picture: picture?.url, from: picture?.from, productUrl: picture?.productUrl, camera, hook, mood, story, language, seconds: secondsNow, notes }),
    });
    const data = (await res.json()) as { script?: string; error?: string };
    return res.ok && data.script ? data.script : null;
  }, [picture, camera, hook, mood, story, language, secondsNow, notes]);

  async function film() {
    if (!picture || busy) return;
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") return void askForModel("video");
    setBusy(true);
    setError(null);
    try {
      const castRefs = castChar
        ? [castChar.portrait, castChar.sheet].filter((u): u is string => Boolean(u)).slice(0, 2).map((url) => ({ url, label: `${castChar.name}, the ${castChar.kind === "pet" ? "animal" : castChar.kind} to keep consistent`, role: "subject" as const }))
        : [];
      const pictures = (style === "campaign" ? selected : [picture]).map((p) => ({ url: p.url, ...(p.from ? { from: p.from } : {}) }));
      const spec: FilmSpec = {
        version: 1,
        style,
        camera,
        hook,
        mood,
        pace,
        story,
        words: style === "creator" ? (words === "mine" && !script.trim() ? "auto" : words) : "none",
        ...(style === "creator" && words === "mine" && script.trim() ? { script: script.trim() } : {}),
        language,
        ...(voice && style === "creator" ? { voice } : {}),
        ...(castChar ? { cast: { id: castChar.id, name: castChar.name, kind: castChar.kind, traits: castChar.traits } } : {}),
        seconds: secondsNow,
        ...(quality !== "1080p" ? { resolution: quality } : {}),
        ...(style === "living" && loop ? { loop: true } : {}),
        ...(style === "creator" && words !== "none" && captions ? { captions: true } : {}),
        noted: Boolean(notes.trim()),
        check,
        pictures,
        ...(picture.productUrl ? { productUrl: picture.productUrl } : {}),
      };
      await submit({
        tool: "product",
        prompt: notes.trim() || filmSummary(spec),
        aspect,
        count: 1,
        // Auto is sent as the model it resolved to here (this tool's favorites are unknown to the server).
        model: model === "auto" ? (effectiveId ?? "auto") : model,
        refine: false,
        references: [...pictures.map((p, i) => ({ url: p.url, label: i === 0 ? "the start frame" : `picture ${i + 1}`, role: "subject" as const })), ...castRefs],
        params: { kind: "video", startUrl: picture.url, film: spec, options: {} },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const live = items.some((g) => isFilmTake(g) && (g.status === "queued" || g.status === "running"));
  const needsPeople = PEOPLE.includes(style) && (picture?.people === "none" || picture?.people === "hands");
  const fewPictures = style === "campaign" && selected.length < 2;
  const canFilm = Boolean(picture) && !busy && !noModel && !fewPictures && !(info.loading && !caps) && fit.missing.every((m) => !/Can't start|Silent: nobody/.test(m));
  const allDone = steps.every((s) => done.includes(s));

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
      <Panel className="flex flex-col">
        <PanelHeader title="Film" />
        <div className="space-y-6 p-3.5">
          <ModelPicker
            kind="video"
            task="animate"
            value={model}
            onChange={setModel}
            prefer={PREFER}
            fit={(id, c) => {
              const f = filmFit(id, c, ask);
              return f.ok ? { text: f.notes[0] ?? "Does everything you picked", whole: true } : { text: f.missing[0], whole: false };
            }}
          />
          {noModel ? (
            <Link
              href="/settings/connections"
              className="block rounded-[12px] bg-tungsten/10 px-3.5 py-3 text-[13px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)] hover:bg-tungsten/15"
            >
              Video mode needs a video model: install LTX-2.5 on the Local page, or add a Comfy key in Connections.
            </Link>
          ) : null}

          <Section title={style === "campaign" ? "Pictures" : "Picture"} hint={style === "campaign" ? `${selected.length} of up to 6 · in the order you pick` : picture ? (picture.idea || "Your picture") : "The video starts from it"}>
            <PicturePicker mine={mine} selected={selected} multi={multi} onToggle={togglePicture} onError={setError} onShoot={onShoot} />
            {needsPeople ? (
              <div className="mt-2 flex items-center gap-3 rounded-[12px] bg-white/[0.03] p-3 text-[12px] leading-snug text-fog shadow-[inset_0_0_0_1px_var(--color-line)]">
                <UserRound size={15} className="shrink-0 text-haze" />
                <span className="min-w-0 flex-1">
                  No one&rsquo;s in this picture, so Crackio first shoots {style === "creator" ? "a creator holding your product" : "someone using it"}, then films them.
                </span>
                <button type="button" onClick={onShoot} className="press shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 font-semibold text-paper hover:bg-white/[0.12]" title="Shoot the picture yourself in Image mode first">
                  Shoot it myself
                </button>
              </div>
            ) : null}
          </Section>

          <Section title="Your ad" hint={allDone ? "All set · tap any step to change it" : `${steps.filter((s) => done.includes(s)).length} of ${steps.length} · hover any option to watch it`}>
            <div className="space-y-1.5">
              {steps.map((st, i) => {
                const common = {
                  stepRef: (el: HTMLElement | null) => void (stepRefs.current[st] = el),
                  index: i + 1,
                  open: openStep === st,
                  done: done.includes(st),
                  onToggle: () => toggleStep(st),
                };
                if (st === "words") {
                  const label = words === "none" ? "No talking" : words === "mine" && script.trim() ? `“${script.trim().slice(0, 24)}${script.trim().length > 24 ? "…" : ""}”` : "Crackio writes it";
                  return (
                    <Step key={st} {...common} title={TITLES.words} value={voice ? `${label} · ${voice[0].toUpperCase()}${voice.slice(1)}` : label} auto={words === "auto"} note="What they say, in which language, and in whose voice.">
                      <WordsStep
                        mode={words}
                        script={script}
                        language={language}
                        voice={voice}
                        seconds={secondsNow}
                        voicesOk={false}
                        captions={captions}
                        onCaptions={setCaptions}
                        onMode={setWords}
                        onScript={setScript}
                        onLanguage={setLanguage}
                        onVoice={setVoice}
                        draft={draft}
                      />
                    </Step>
                  );
                }
                const axis = st;
                const option = byFilmId(listOf(axis), value[axis]);
                const note =
                  axis === "style"
                    ? "What kind of ad. Hover any option to watch it."
                    : axis === "story" && style === "living"
                      ? "What comes alive in your picture."
                      : axis === "mood"
                        ? "How they feel and sound."
                        : axis === "hook"
                          ? "The first second: what stops the scroll."
                          : axis === "camera"
                            ? PEOPLE.includes(style)
                              ? "Who's holding the camera, and how. Pick one your picture wasn't taken with and Crackio re-shoots it that way first: same person, same product."
                              : "How the camera moves."
                            : axis === "pace"
                              ? "How fast it moves."
                              : "How it unfolds.";
                return (
                  <Step key={st} {...common} title={axis === "story" && style === "living" ? "What moves" : TITLES[axis]} value={option.label} thumb={thumbOf(axis, option.id)} auto={option.id === "auto"} note={note}>
                    <FilmOptionGrid axis={axis} options={listOf(axis)} value={value[axis]} onChange={choose(axis)} like={like} warn={warn} cols={listOf(axis).length <= 3 ? 3 : 4} />
                    {axis === "story" && coStar ? (
                      <CoStar
                        castId={castId}
                        refsOk={Boolean(caps?.refs)}
                        onPick={(id) => {
                          setCastId(id);
                          advance("story");
                        }}
                      />
                    ) : null}
                  </Step>
                );
              })}
            </div>
          </Section>

          <Section title="Anything else?" hint="Optional · any language · @ for Cast">
            <textarea
              ref={notesField}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => void mentions.onKeyDown(e)}
              rows={2}
              placeholder={style === "creator" ? "She's a nurse coming off a night shift; end with her taking a sip…" : style === "living" ? "Only the steam moves, nothing else…" : "Make it feel like a late-night summer ad…"}
              className="w-full resize-none rounded-[14px] bg-white/[0.03] px-3.5 py-3 text-[14px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
            />
            {mentions.menu}
          </Section>

          <Section
            title="Length"
            hint={
              secondsNow > maxClip
                ? style === "campaign"
                  ? `${selected.length || "Each"} shots, about ${Math.round(secondsNow / Math.max(1, selected.length))} s each`
                  : `Over ${maxClip} s: filmed in ${Math.ceil(secondsNow / maxClip)} parts, joined`
                : style === "campaign"
                  ? `About ${Math.round(secondsNow / Math.max(1, selected.length))} s a shot`
                  : `${aspect} like your picture`
            }
          >
            <DurationRuler value={secondsNow} allowed={allowed} max={longest} onChange={(v) => typeof v === "number" && setSeconds(v)} />
            <div role="radiogroup" aria-label="Quality" className="mt-2 grid grid-cols-2 gap-1.5">
              {(
                [
                  ["720p", "720p · quicker", "Quicker and lighter: for trying ideas"],
                  ["1080p", "1080p · full", "Full quality, ready to post"],
                ] as const
              ).map(([id, label, title]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={quality === id}
                  title={title}
                  onClick={() => setQuality(id)}
                  className={cn("press h-9 rounded-full text-[12px] font-semibold transition-colors", quality === id ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper")}
                >
                  {label}
                </button>
              ))}
            </div>
          </Section>

          {style === "living" ? (
            <button
              type="button"
              onClick={() => setLoop((v) => !v)}
              className="press flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
              aria-pressed={loop}
            >
              <span className={cn("grid size-8 place-items-center rounded-full", loop ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-haze")}>
                <Repeat size={15} />
              </span>
              <span className="flex-1">
                <span className="block text-[13.5px] font-semibold">Seamless loop</span>
                <span className="block text-[12px] text-haze">{!caps?.end ? "This model can't land on an end frame" : loop ? "Ends exactly on your picture, for banners" : "Plays once, at full resolution"}</span>
              </span>
              <span className={cn("relative h-5 w-9 rounded-full transition-colors", loop ? "bg-spike" : "bg-gaffer")}>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", loop ? "left-[18px]" : "left-0.5")} />
              </span>
            </button>
          ) : null}
        </div>

        {/* Sticks to the bottom of the window while you scroll the picks, so Film is always in reach. */}
        <div className="sticky bottom-0 z-10 mt-auto space-y-2 rounded-b-panel border-t border-line bg-flat/90 p-3 backdrop-blur-xl">
          {!fit.ok && caps ? (
            <div className="flex items-start gap-2 rounded-[12px] bg-tungsten/10 px-3 py-2 text-[12px] leading-snug text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.22)]">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span className="min-w-0 flex-1">
                {info.name ?? "This model"}: {fit.missing.join(". ")}.
              </span>
              {better ? (
                <button type="button" onClick={() => setModel(better.id)} className="press inline-flex shrink-0 items-center gap-1 rounded-full bg-tungsten/20 px-2.5 py-1 font-semibold hover:bg-tungsten/30">
                  <ArrowRightLeft size={12} /> {better.name}
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
          <div className="flex min-h-5 items-center justify-between gap-3">
            <span className="min-w-0">
              <LocalTimeLine modelId={effectiveId} kind="video" duration={Math.min(secondsNow, maxClip)} />
              <CostLine
                className="min-w-0"
                modelId={effectiveId}
                noun="this take"
                input={{ output: "video", seconds: secondsNow, resolution: quality, ratio, count: 1, sound: talks || undefined }}
                quote={{ output: "video", seconds: secondsNow, resolution: quality, aspectValue: null, aspect, count: 1, sound: talks || undefined, start: true, end: style === "living" && loop }}
              />
            </span>
            <span className="ml-auto shrink-0">
              <Switch
                checked={check}
                onChange={setCheck}
                label={<span className="text-[12px]">Check every clip</span>}
                title="Crackio watches every clip frame by frame (and what's said) against your product and the plan, and re-films it once if a client would reject it."
              />
            </span>
          </div>
          <button
            onClick={() => void film()}
            disabled={!canFilm}
            className="lip squircle flex h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
          >
            {busy ? <LoaderCircle size={17} className="animate-spin" /> : live ? <Clapperboard size={16} /> : <Camera size={16} />}
            {!picture ? "Pick a picture" : fewPictures ? "Pick at least 2 pictures" : `Film ${secondsNow} s ${byFilmId(FILM_STYLES, style).label.toLowerCase()} ad`}
          </button>
        </div>
      </Panel>

      <FilmOutput focus={focus} like={like} />
    </div>
  );
}

/** Who steps in: a friend Crackio casts, or someone from your Cast (the same face as in your other ads). */
function CoStar({ castId, refsOk, onPick }: { castId: string | null; refsOk: boolean; onPick: (id: string | null) => void }) {
  const { items, loaded } = useCast();
  const usable = items.filter((c) => c.portrait && c.status !== "building" && c.kind !== "object");
  return (
    <div className="mt-3 rounded-[14px] bg-white/[0.02] p-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-haze">Who joins</p>
        <Link href="/cast" className="text-[11.5px] font-semibold text-fog hover:text-paper">
          New character
        </Link>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          onClick={() => onPick(null)}
          className={cn(
            "press grid aspect-square place-items-center rounded-[12px] px-1 text-center text-[11.5px] font-semibold",
            !castId ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-paper",
          )}
        >
          A friend
        </button>
        {!loaded
          ? [0, 1, 2].map((i) => <div key={i} className="skeleton aspect-square rounded-[12px]" />)
          : usable.slice(0, 7).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c.id)}
                title={refsOk ? c.traits ?? c.name : `${c.name}: this model can't take reference pictures, so they'd come out as a lookalike`}
                className={cn("press group relative aspect-square overflow-hidden rounded-[12px] bg-apple-2", castId === c.id ? "shadow-[inset_0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)]")}
              >
                <img src={previewUrl(c.portrait!, 160)} alt="" className={cn("absolute inset-0 size-full object-cover", !refsOk && "opacity-60")} />
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4 text-[10.5px] font-semibold text-white">{c.name}</span>
              </button>
            ))}
      </div>
      {!refsOk ? <p className="mt-2 text-[11.5px] leading-snug text-tungsten">This model can&rsquo;t take reference pictures: a Cast person would come out as a lookalike. Pick a model that takes reference pictures.</p> : null}
    </div>
  );
}
