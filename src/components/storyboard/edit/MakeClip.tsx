"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, ChevronDown, Clapperboard, ImagePlus, LoaderCircle, Plus, TriangleAlert, Volume2, VolumeX, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useEditor, type ClipPick } from "@/lib/storyboard/edit-store";
import { clipFromFile, placed, type EditFile } from "@/lib/storyboard/edit";
import { insertMain, patchClip } from "@/lib/storyboard/edit-ops";
import { useGenerations } from "@/lib/hooks/use-generations";
import { resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";
import { aspectChoice, durationTicks, fitDuration, fitResolution, nearestAspect, resolutionLabel, type AspectChoice } from "@/lib/models/caps";
import { ASPECTS, aspectById, type AspectId } from "@/lib/shot";
import { MOVES, PACES, SAMPLES, type MoveId, type PaceId } from "@/lib/video/moves";
import { previewUrl } from "@/lib/media-url";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine } from "@/components/models/CostLine";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { AdvancedOptions, useTuning } from "@/components/models/AdvancedOptions";
import { DurationRuler } from "@/components/ui/DurationRuler";
import { Switch } from "@/components/ui/Panel";
import { HoverPreview } from "@/components/video/HoverPreview";
import { PicturePicker, type PickedPicture } from "@/components/media/PicturePicker";
import { useMentions } from "@/components/cast/Mentions";
import { CastStrip } from "@/components/cast/CastStrip";
import { mentionedHandles } from "@/lib/cast/types";
import { sayPictures } from "@/lib/prompt-pictures";
import { cn } from "@/lib/cn";

/**
 * The panel under the files: a picture you clicked becomes a clip. Everything the chosen video model can do is here and
 * only that (start and end frames, shape, length, quality, sound), with the Video tool's camera moves and paces to pick
 * from instead of prompting them. A still on the timeline gives its place to the clip when it's done.
 */
export function MakeClip() {
  const pick = useEditor((s) => s.pick);
  return (
    <AnimatePresence initial={false}>
      {pick ? (
        <motion.section
          key="make"
          aria-label="Make a clip"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="surface flex max-h-[68%] min-h-[300px] shrink-0 flex-col overflow-hidden rounded-panel"
        >
          <MakeClipForm key={`${pick.file.key}:${pick.clip ?? ""}`} pick={pick} />
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

/** Shapes shown while the model's own list loads. */
const FALLBACK_SHAPES = ["16:9", "21:9", "1:1", "4:5", "9:16"].map((v) => aspectChoice(v)!);

/** One shape per label: fal lists both square_hd and square as 1:1. */
function uniqueShapes(list: AspectChoice[]) {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
}

const nearestShot = (ratio: number): AspectId => ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

function loadSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1280, height: 720 });
    img.src = url;
  });
}

type Frame = { url: string; width?: number; height?: number; name: string };

function MakeClipForm({ pick }: { pick: ClipPick }) {
  const submit = useGenerations((s) => s.submit);
  const makingId = useEditor((s) => (pick.clip ? s.timeline.main.find((c) => c.id === pick.clip)?.making : undefined));
  const making = useGenerations((s) => (makingId ? s.items.find((g) => g.id === makingId) : undefined));
  const timeline = useEditor((s) => s.timeline);
  const filmAspect = useEditor((s) => s.project?.aspect ?? "16:9");
  const { models, defaults, loaded, setDefault } = useModels();
  const [model, setModel] = useModelChoice("video", "video");
  const effectiveId = model === "auto" ? resolveAutoId("video", models, defaults) : model;
  const info = useModelInfo(effectiveId);
  const caps = info.caps;
  const tuning = useTuning(caps?.tuning);
  const noModel = loaded && !effectiveId;

  const start: Frame = pick.file;
  // The next picture on the timeline is the natural place for this one's clip to land.
  const nextStill = useMemo(() => {
    if (!pick.clip) return null;
    const list = placed(timeline.main);
    const at = list.findIndex((p) => p.clip.id === pick.clip);
    const next = list[at + 1]?.clip;
    return next?.kind === "image" ? next : null;
  }, [timeline.main, pick.clip]);
  const [end, setEnd] = useState<Frame | null>(null);
  const [prompt, setPrompt] = useState("");
  const [refine, setRefine] = useState(true);
  const [move, setMove] = useState<MoveId | null>("push");
  const [pace, setPace] = useState<PaceId>("natural");
  const [moves, setMoves] = useState(false);
  const [duration, setDuration] = useState<number | "auto">(5);
  const [resolution, setResolution] = useState<string | number | undefined>(undefined);
  const [shape, setShape] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const [onTimeline, setOnTimeline] = useState(true);
  const [refs, setRefs] = useState<Frame[]>([]);
  const [more, setMore] = useState(false);
  const shot = pick.clip ? timeline.main.findIndex((c) => c.id === pick.clip) + 1 : 0;
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shapes = useMemo(() => uniqueShapes(caps ? (caps.aspect?.choices ?? caps.size?.presets ?? []) : FALLBACK_SHAPES), [caps]);
  const realShapes = shapes.filter((s) => s.ratio !== null);
  const ticks = caps?.duration ? durationTicks(caps.duration) : null;
  const resChoices = caps?.resolution?.choices ?? (caps ? [] : ["480p", "720p", "1080p"].map((v) => ({ value: v, label: v })));
  const keyframesCap = caps?.keyframes ?? null;
  const startRole: "frame" | "reference" | null = !caps ? "frame" : caps.image || keyframesCap ? "frame" : caps.refs ? "reference" : null;
  const endOk = !caps || Boolean(caps.end) || Boolean(keyframesCap);
  const soundOk = !caps || Boolean(caps.audio);
  const usedEnd = endOk && startRole === "frame" ? end : null;
  // Pictures of who and what the clip shows, next to its start frame: Grok takes them (and then renders at up to 720p).
  const refRoom = caps?.refs?.max && effectiveId?.startsWith("grok:") ? caps.refs.max : 0;
  const usedRefs = refs.slice(0, refRoom);
  // The frames have words too ("@start", "@end"), and "@" brings in your Cast, like on the Video page.
  const framePictures = [
    { token: "start", label: "Start frame", said: "the start frame", url: start.url },
    ...(usedEnd ? [{ token: "end", label: "End frame", said: "the end frame", url: usedEnd.url }] : []),
  ];
  const mentions = useMentions({ textarea: field, value: prompt, onChange: setPrompt, pictures: framePictures.map(({ token, label, url }) => ({ token, label, src: previewUrl(url, 96) })) });
  const castRefs = Boolean(caps?.refs?.max && !caps.video) && !effectiveId?.startsWith("local:");
  const castHow = mentionedHandles(prompt).length
    ? castRefs
      ? "Your picture opens the clip, and their photos go along as reference pictures."
      : "Your picture opens the clip and they're described in words: this model takes no reference pictures."
    : null;

  // The clip takes the film's shape unless you pick another; the picture is cropped to it when they differ.
  const film = aspectById(filmAspect);
  const filmRatio = film.w / film.h;
  const chosen = (shape ? shapes.find((s) => s.value === shape) : undefined) ?? nearestAspect(realShapes, filmRatio) ?? null;
  const ratio = chosen?.ratio ?? filmRatio;
  const startRatio = start.width && start.height ? start.width / start.height : null;
  const cropping = Boolean(startRole && chosen?.ratio && startRatio && Math.abs(Math.log(chosen.ratio / startRatio)) > 0.03);

  const durationValue: number | "auto" | null = caps?.duration ? fitDuration(caps.duration, duration) : !caps ? duration : null;
  const resValue = resChoices.length ? (fitResolution(resChoices, resolution, caps?.resolution?.default ?? null) ?? resChoices[0].value) : null;
  const lengthLabel = durationValue === "auto" ? "auto length" : durationValue ? `${durationValue}s` : null;
  const moveInfo = MOVES.find((m) => m.id === move);
  const words = [sayPictures(prompt.trim(), framePictures), moveInfo?.phrase, PACES.find((p) => p.id === pace)?.phrase].filter(Boolean).join(" ");
  const canRun = !busy && !noModel && !(info.loading && !caps) && Boolean(startRole);

  async function run() {
    if (model === "auto") return void askForModel("video");
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      const gen = await submit({
        tool: "storyboard",
        prompt: refine ? words || "Animate this image naturally." : sayPictures(prompt.trim(), framePictures) || "Animate this image.",
        compiledPrompt: refine ? undefined : words || "Animate this image naturally.",
        aspect: nearestShot(ratio),
        count: 1,
        model,
        refine,
        references: [
          { url: start.url, label: "the start frame", role: "subject" as const },
          ...(usedEnd ? [{ url: usedEnd.url, label: "the end frame", role: "subject" as const }] : []),
        ],
        params: {
          kind: "video",
          options: {
            ...(durationValue !== null ? { duration: durationValue } : {}),
            ...(resValue !== null ? { resolution: String(resValue) } : {}),
            ...(soundOk ? { sound } : {}),
            ...(chosen ? { aspectValue: chosen.value } : {}),
            ...(cropping ? { cropFrames: true } : {}),
            ...tuning.options,
          },
          move,
          pace,
          startUrl: start.url,
          endUrl: usedEnd?.url,
          ...(usedRefs.length ? { refs: usedRefs.map((r, i) => ({ url: r.url, label: `reference picture ${i + 1}` })) } : {}),
        },
      });
      // The still it's made from waits on the timeline under the dots, and the clip takes its place when it's done.
      const { change, select, setPick } = useEditor.getState();
      if (pick.clip) change((t) => patchClip(t, pick.clip!, { making: gen.id }));
      else if (onTimeline) {
        const clip = { ...clipFromFile(pick.file as EditFile, nanoid(8)), making: gen.id };
        change((t) => insertMain(t, clip));
        select(clip.id);
      }
      setPick(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <h2 className="label flex items-center gap-1.5">
          <Clapperboard size={12} className="text-spike" /> {shot ? `Make shot ${shot} move` : "Make it move"}
        </h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => useEditor.getState().setPick(null)}
          className="press grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.06] hover:text-paper"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        <ModelPicker kind="video" task="video" value={model} onChange={setModel} />
        {noModel ? (
          <p className="rounded-[12px] bg-tungsten/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
            Clips need a video model: install a free one in{" "}
            <Link href="/local" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
              Local
            </Link>
            , or add a Comfy key in{" "}
            <Link href="/settings/connections" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
              Connections
            </Link>
            .
          </p>
        ) : null}
        {making && (making.status === "queued" || making.status === "running") ? (
          <p className="flex items-center gap-1.5 rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-[12px] text-fog">
            <LoaderCircle size={13} className="animate-spin text-spike" /> Its clip is being made ({Math.round((making.progress ?? 0) * 100)}%). Another one replaces it.
          </p>
        ) : null}

        {/* The frames: this picture, and where the clip lands. */}
        <div className="flex items-stretch gap-2">
          <FrameTile label={startRole === "reference" ? "Reference" : "Start"} frame={start} crop={cropping ? ratio : undefined} />
          <span className="grid w-6 shrink-0 place-items-center text-haze">
            <ArrowRight size={13} className={cn(!usedEnd && "opacity-40")} />
          </span>
          <EndSlot frame={end} onChange={setEnd} usable={endOk && startRole === "frame"} next={nextStill} crop={cropping ? ratio : undefined} />
        </div>

        <Field
          title="What happens"
          hint={<Switch checked={refine} onChange={setRefine} label="Refine" title="Rewrite your words into a precise motion prompt, in any language" />}
        >
          <textarea
            ref={field}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                return void run();
              }
              void mentions.onKeyDown(e);
            }}
            rows={2}
            placeholder="What happens? Steam curls up as the light shifts…"
            className="field-focus w-full resize-none rounded-[12px] bg-white/[0.04] px-3 py-2.5 text-[13.5px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze"
          />
          {mentions.menu}
          <CastStrip prompt={prompt} onChange={setPrompt} how={castHow} className="mt-2" />
        </Field>

        {/* The camera presets: one line until you open it. */}
        <div>
          <button
            type="button"
            onClick={() => setMoves((o) => !o)}
            aria-expanded={moves}
            className="press squircle flex h-10 w-full items-center gap-2.5 rounded-[12px] bg-white/[0.04] px-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]"
          >
            <span className="label w-14 shrink-0">Camera</span>
            {moveInfo ? <moveInfo.icon size={14} className="text-spike" /> : null}
            <span className="flex-1 truncate text-[13px] font-semibold">{moveInfo?.label ?? "The model decides"}</span>
            <ChevronDown size={14} className={cn("text-haze transition-transform", moves && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {moves ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-3 gap-1.5 pt-1.5">
                  {MOVES.map((m) => {
                    const Icon = m.icon;
                    const active = move === m.id;
                    return (
                      <HoverPreview key={m.id} title={m.label} caption={m.caption} src={`${SAMPLES}/cam-${m.id}.mp4`}>
                        <button
                          type="button"
                          onClick={() => setMove((cur) => (cur === m.id ? null : m.id))}
                          className={cn(
                            "press group flex h-[52px] w-full flex-col items-start justify-between rounded-[11px] px-2 py-1.5 text-left transition-colors",
                            active ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                          )}
                        >
                          <Icon size={14} className={cn("transition-transform duration-500 group-hover:scale-110", active && "text-spike")} />
                          <span className="text-[11.5px] font-semibold leading-none">{m.label}</span>
                        </button>
                      </HoverPreview>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <Field title="Pace">
          <div className="grid grid-cols-3 gap-1.5">
            {PACES.map((p) => (
              <HoverPreview key={p.id} title={p.label} caption={p.caption} src={`${SAMPLES}/pace-${p.id}.mp4`}>
                <button
                  type="button"
                  onClick={() => setPace(p.id)}
                  aria-pressed={pace === p.id}
                  className={cn(
                    "press h-9 w-full rounded-full text-[12.5px] font-semibold transition-colors",
                    pace === p.id ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                  )}
                >
                  {p.label}
                </button>
              </HoverPreview>
            ))}
          </div>
        </Field>

        <Field title="Length" hint={!caps?.duration && caps ? "Set by the model" : durationValue === "auto" ? "The model picks it" : undefined}>
          {ticks && ticks.seconds.length > 1 ? (
            <DurationRuler value={durationValue ?? ticks.seconds[0]} allowed={ticks.seconds} max={ticks.max} auto={ticks.auto} onChange={setDuration} />
          ) : ticks ? (
            <p className="flex h-10 items-center rounded-full bg-white/[0.05] px-4 text-[12.5px] text-haze">
              <span className="mr-1.5 font-bold text-paper">{ticks.seconds[0]}s</span> the only length this model makes
            </p>
          ) : caps ? (
            <p className="flex h-10 items-center rounded-full bg-white/[0.05] px-4 text-[12.5px] text-haze">The model sets the length</p>
          ) : (
            <div className="skeleton h-10 rounded-full" />
          )}
        </Field>

        <button
          type="button"
          onClick={() => setMore((o) => !o)}
          aria-expanded={more}
          className="press flex h-8 w-full items-center gap-2 px-0.5 text-left text-[12.5px] font-semibold text-fog hover:text-paper"
        >
          <span className="h-px flex-1 bg-white/[0.07]" />
          More settings
          <span className="tabular font-normal text-haze">
            {[resValue !== null ? resolutionLabel(resValue) : null, chosen?.label, soundOk ? (sound ? "sound" : "silent") : null].filter(Boolean).join(" · ")}
          </span>
          <ChevronDown size={13} className={cn("text-haze transition-transform", more && "rotate-180")} />
          <span className="h-px flex-1 bg-white/[0.07]" />
        </button>
        {more ? (
          <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {resChoices.length ? (
            <Field title="Quality">
              <Pills value={String(resValue)} onChange={(v) => setResolution(v)} options={resChoices.map((c) => ({ value: String(c.value), label: resolutionLabel(c.value) }))} />
            </Field>
          ) : null}
          {realShapes.length ? (
            <Field title="Shape" hint={chosen && Math.abs(Math.log((chosen.ratio ?? filmRatio) / filmRatio)) < 0.03 ? "The film's" : undefined}>
              <select
                value={chosen?.value ?? ""}
                onChange={(e) => setShape(e.target.value)}
                className="field-focus h-9 w-full rounded-[10px] bg-white/[0.05] px-2.5 text-[12.5px] font-semibold text-paper outline-none"
              >
                {realShapes.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>

        {soundOk ? (
          <button
            type="button"
            onClick={() => setSound((s) => !s)}
            aria-pressed={sound}
            className="press flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
          >
            <span className={cn("grid size-7 place-items-center rounded-full", sound ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-haze")}>{sound ? <Volume2 size={14} /> : <VolumeX size={14} />}</span>
            <span className="flex-1 text-[12.5px] font-semibold">{sound ? "With sound" : "Silent"}</span>
          </button>
        ) : null}

        {refRoom ? <References refs={usedRefs} max={refRoom} onChange={setRefs} /> : null}

        {refine ? <ModelPicker kind="text" value={defaults.text ?? "auto"} onChange={(id) => void setDefault("text", id)} variant="setting" label="Refine with" className="block" /> : null}

        {!pick.clip ? (
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[12.5px] text-fog">Put it at the end of the film</span>
            <Switch checked={onTimeline} onChange={setOnTimeline} title="The picture goes on the timeline now, and its clip takes its place when it's done" />
          </div>
        ) : null}

        <AdvancedOptions
          s={tuning}
          job={{ model: effectiveId, kind: "video", duration: typeof durationValue === "number" ? durationValue : undefined, resolution: resValue !== null ? String(resValue) : undefined }}
          className="rounded-[12px] shadow-[inset_0_0_0_1px_var(--color-line)]"
        />
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-line p-3">
        {error ? (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-tally">
            <TriangleAlert size={13} className="mt-px shrink-0" /> {error}
          </p>
        ) : null}
        {!startRole && caps ? <p className="text-[12px] text-haze">This model makes clips from words only: pick one that starts from a picture.</p> : null}
        <LocalTimeLine modelId={effectiveId} kind="video" duration={typeof durationValue === "number" ? durationValue : undefined} resolution={resValue !== null ? String(resValue) : undefined} />
        <CostLine
          modelId={effectiveId}
          input={{ output: "video", seconds: durationValue ?? undefined, resolution: resValue, ratio, count: 1, sound: soundOk ? sound : undefined }}
          quote={{
            output: "video",
            seconds: durationValue ?? undefined,
            resolution: resValue !== null ? String(resValue) : null,
            aspectValue: chosen?.value ?? null,
            aspect: nearestShot(ratio),
            count: 1,
            sound: soundOk ? sound : undefined,
            start: startRole === "frame",
            end: Boolean(usedEnd),
          }}
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={!canRun && model !== "auto"}
          className="lip press flex h-11 w-full items-center justify-center gap-2 rounded-full bg-spike text-[13.5px] font-bold uppercase tracking-[0.05em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
        >
          {busy || (info.loading && !caps) ? <LoaderCircle size={16} className="animate-spin" /> : null}
          {model === "auto" ? "Choose a video model" : `Make the clip${lengthLabel ? ` · ${lengthLabel}` : ""}`}
        </button>
      </div>
    </>
  );
}

function Field({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <h3 className="label">{title}</h3>
        {hint ? <span className="text-[11.5px] text-haze">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Pills({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" className="flex h-9 rounded-full bg-white/[0.05] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("press h-full flex-1 rounded-full px-1.5 text-[11.5px] font-semibold", value === o.value ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Where a center crop to `ratio` lands on a frame shown in a 16:10 tile, in percent of the tile. */
function cropGuide(frame: Frame, ratio: number) {
  const card = 16 / 10;
  const img = frame.width && frame.height ? frame.width / frame.height : card;
  const shownW = img > card ? img / card : 1;
  const shownH = img > card ? 1 : card / img;
  return { width: Math.min(1, Math.min(1, ratio / img) * shownW) * 100, height: Math.min(1, Math.min(1, img / ratio) * shownH) * 100 };
}

function FrameTile({ label, frame, crop }: { label: string; frame: Frame; crop?: number }) {
  const guide = crop ? cropGuide(frame, crop) : null;
  return (
    <div className="relative aspect-[16/10] min-w-0 flex-1 overflow-hidden rounded-[12px] bg-apple shadow-[inset_0_0_0_1px_var(--color-line)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={previewUrl(frame.url, 480)} alt="" className="absolute inset-0 size-full object-cover" />
      {guide ? (
        <span
          aria-hidden
          title="What the clip keeps"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[6px] shadow-[0_0_0_1.5px_rgb(255_255_255/0.9),0_0_0_999px_rgb(10_8_14/0.55)]"
          style={{ width: `${guide.width}%`, height: `${guide.height}%` }}
        />
      ) : null}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-4 text-[10.5px] font-bold uppercase tracking-[0.08em] text-white">{label}</span>
    </div>
  );
}

function EndSlot({ frame, onChange, usable, next, crop }: { frame: Frame | null; onChange: (f: Frame | null) => void; usable: boolean; next: { url: string; width?: number; height?: number; name?: string } | null; crop?: number }) {
  const [busy, setBusy] = useState(false);
  async function take(p: PickedPicture) {
    setBusy(true);
    const size = p.width && p.height ? { width: p.width, height: p.height } : await loadSize(p.url);
    onChange({ url: p.url, name: p.name, ...size });
    setBusy(false);
  }
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = (await res.json()) as { items?: { url: string; width: number; height: number }[] };
      if (data.items?.[0]) onChange({ ...data.items[0], name: file.name });
    } finally {
      setBusy(false);
    }
  }
  if (!usable) {
    return (
      <div className="grid aspect-[16/10] min-w-0 flex-1 place-items-center rounded-[12px] bg-white/[0.02] px-2 text-center text-[10.5px] leading-snug text-haze shadow-[inset_0_0_0_1px_var(--color-line)]">
        This model doesn&apos;t land on an end frame
      </div>
    );
  }
  if (frame) {
    return (
      <div className="relative min-w-0 flex-1">
        <FrameTile label="End" frame={frame} crop={crop} />
        <button type="button" onClick={() => onChange(null)} className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-paper hover:bg-black/80" aria-label="Remove the end frame">
          <X size={12} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <PicturePicker
        roles={[{ id: "frame", label: "End frame" }]}
        placement="bottom-end"
        className="block w-full flex-1"
        onPick={(_, [p]) => p && void take(p)}
        onUpload={(_, files) => void upload(files[0])}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="press grid aspect-[16/10] w-full place-items-center rounded-[12px] bg-white/[0.03] text-haze shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-paper hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          >
            <span className="flex flex-col items-center gap-1">
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <ImagePlus size={15} />}
              <span className="text-[10.5px] font-semibold">End frame</span>
            </span>
          </button>
        )}
      />
      {next ? (
        <button
          type="button"
          onClick={() => onChange({ url: next.url, width: next.width, height: next.height, name: next.name ?? "The next shot" })}
          className="press truncate rounded-[8px] px-1 text-[10.5px] font-semibold text-fog hover:text-paper"
          title="Land on the picture that comes next on the timeline"
        >
          Use the next shot
        </button>
      ) : null}
    </div>
  );
}

/** Pictures of the people, products and places in the clip, beside its start frame (models that take them). */
function References({ refs, max, onChange }: { refs: Frame[]; max: number; onChange: (next: Frame[]) => void }) {
  const add = async (p: PickedPicture) => {
    const size = p.width && p.height ? { width: p.width, height: p.height } : await loadSize(p.url);
    onChange([...refs.filter((r) => r.url !== p.url), { url: p.url, name: p.name, ...size }].slice(0, max));
  };
  const upload = async (files: File[]) => {
    const body = new FormData();
    for (const f of files.slice(0, max - refs.length)) body.append("file", f);
    const res = await fetch("/api/uploads", { method: "POST", body });
    const data = (await res.json().catch(() => ({}))) as { items?: { url: string; width: number; height: number; name?: string }[] };
    if (data.items?.length) onChange([...refs, ...data.items.map((i) => ({ url: i.url, width: i.width, height: i.height, name: i.name ?? "Reference" }))].slice(0, max));
  };
  return (
    <Field title="References" hint={`${refs.length} of ${max}`}>
      <div className="flex flex-wrap gap-1.5">
        {refs.map((r) => (
          <span key={r.url} className="group relative size-12 overflow-hidden rounded-[10px] bg-apple shadow-[inset_0_0_0_1px_var(--color-line)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl(r.url, 160)} alt="" className="size-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(refs.filter((x) => x.url !== r.url))}
              className="absolute inset-0 grid place-items-center bg-black/55 text-paper opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove this reference"
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {refs.length < max ? (
          <PicturePicker
            roles={[{ id: "ref", label: "References", several: { have: refs.length, max } }]}
            tags={Object.fromEntries(refs.map((r, i) => [r.url, `Ref ${i + 1}`]))}
            note="People, products or places the clip should show as they are."
            placement="bottom-end"
            onPick={(_, picked) => picked.forEach((p) => void add(p))}
            onUnpick={(_, url) => onChange(refs.filter((r) => r.url !== url))}
            onUpload={(_, files) => void upload(files)}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                title="Add a reference picture"
                className="press grid size-12 place-items-center rounded-[10px] bg-white/[0.03] text-haze shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-paper hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
              >
                <Plus size={15} />
              </button>
            )}
          />
        ) : null}
      </div>
      <p className="mt-1.5 px-0.5 text-[11.5px] leading-snug text-haze">With references, Grok renders at up to 720p.</p>
    </Field>
  );
}
