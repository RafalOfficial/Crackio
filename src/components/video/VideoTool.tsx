"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight,
  Focus,
  Hand,
  ImagePlus,
  LoaderCircle,
  Plus,
  Lock,
  MoveDown,
  MoveHorizontal,
  MoveUp,
  Plane,
  RotateCcw,
  RotateCw,
  ScanEye,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Generation } from "@/lib/generations/types";
import { ASPECTS as SHOT_ASPECTS, aspectById, type AspectId } from "@/lib/shot";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { resolveAuto, resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { aspectChoice, durationTicks, fitDuration, fitResolution, nearestAspect, resolutionLabel, type AspectChoice } from "@/lib/models/caps";
import { AppIcon } from "@/components/ui/ToolTile";
import { Panel, PanelHeader, Switch, EmptyState } from "@/components/ui/Panel";
import { Osd, RecDot } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { Media } from "@/components/ui/Media";
import { DurationRuler } from "@/components/ui/DurationRuler";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine } from "@/components/models/CostLine";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { AdvancedOptions, useTuning } from "@/components/models/AdvancedOptions";
import { useMentions } from "@/components/cast/Mentions";
import { CastStrip } from "@/components/cast/CastStrip";
import { castFits, framePrefer, mentionedHandles } from "@/lib/cast/types";
import { useCast } from "@/lib/hooks/use-cast";
import { CastFrameControl, castFrameParams, namesOf, useCastFrame } from "@/components/media/CastFrame";
import { HoverPreview } from "./HoverPreview";
import { PicturePicker, type PickedPicture } from "@/components/media/PicturePicker";
import { sayPictures } from "@/lib/prompt-pictures";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";
import { useModelParam } from "@/lib/hooks/use-model-param";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

type Frame = { url: string; width: number; height: number; name: string; example?: boolean };
/** A picture the clip passes through between its start and end frames, at `t` seconds. */
type Keyframe = { id: string; frame: Frame; t: number };

const V = "/assets/video";

/** Camera moves in plain words, each with the phrasing video models follow best and a sample clip. */
const MOVES = [
  { id: "static", label: "Locked off", icon: Lock, phrase: "The camera stays perfectly still on a tripod.", caption: "The frame never moves; only the scene does." },
  { id: "push", label: "Push in", icon: ZoomIn, phrase: "The camera slowly pushes in toward the subject.", caption: "Moves closer for intimacy and tension." },
  { id: "pull", label: "Pull out", icon: ZoomOut, phrase: "The camera slowly pulls back to reveal more of the scene.", caption: "Backs away to reveal where we are." },
  {
    id: "orbit-l",
    label: "Orbit left",
    icon: RotateCcw,
    phrase: "The camera arcs smoothly to the left around the subject (counter-clockwise seen from above), keeping them centered as the background slides left.",
    caption: "Circles the subject to the left.",
  },
  {
    id: "orbit-r",
    label: "Orbit right",
    icon: RotateCw,
    phrase: "The camera arcs smoothly to the right around the subject (clockwise seen from above), keeping them centered as the background slides right.",
    caption: "Circles the subject to the right.",
  },
  { id: "pan", label: "Pan", icon: MoveHorizontal, phrase: "The camera pans slowly across the scene.", caption: "Turns side to side from one spot." },
  { id: "tilt", label: "Tilt up", icon: MoveUp, phrase: "The camera tilts up from the ground to the subject.", caption: "Turns upward, ground to face to sky." },
  { id: "crane", label: "Crane up", icon: MoveDown, phrase: "The camera cranes up and rises above the scene.", caption: "Rises high above for the big picture." },
  { id: "handheld", label: "Handheld", icon: Hand, phrase: "Handheld camera with subtle natural shake, documentary feel.", caption: "Natural shake, like a person holding it." },
  { id: "dolly-zoom", label: "Dolly zoom", icon: Focus, phrase: "A dolly zoom: the camera moves back while zooming in, warping the background.", caption: "The vertigo effect: the world stretches." },
  {
    id: "fpv",
    label: "Fly-through",
    icon: Plane,
    phrase: "A smooth FPV drone fly-through: the camera flies forward past the subject and on through the scene, while the subject stays where they are.",
    caption: "Flies past the subject and on into the scene.",
  },
  {
    id: "pov",
    label: "POV",
    icon: ScanEye,
    // Who it is comes from the prompt (or the main character), so the same words work for any scene.
    phrase:
      "First-person POV shot: the camera is the eyes of the main character (or whoever the prompt names), so we see exactly what they see as they move, at their own eye height, with the natural sway of their steps and head; their own hands, arms or body enter the edge of the frame when natural, and they are never seen from outside.",
    caption: "The camera becomes the character's own eyes.",
  },
] as const;

const PACES = [
  { id: "subtle", label: "Subtle", phrase: "Gentle, minimal motion.", caption: "Barely moving: hair and light, nothing else." },
  { id: "natural", label: "Natural", phrase: "", caption: "Real-life pace, like the moment really happened." },
  { id: "dynamic", label: "Dynamic", phrase: "Energetic, dynamic motion.", caption: "Big, energetic movement and quick camera work." },
] as const;

/** Shapes shown while the model's own list loads. */
const FALLBACK_SHAPES = ["16:9", "21:9", "3:2", "1:1", "2:3", "9:16"].map((v) => aspectChoice(v)!);

/** The page's frame shape (for the output box and cropping guides) closest to a ratio. */
function shotAspect(ratio: number): AspectId {
  return SHOT_ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;
}

/** Which sample clip shows a shape: landscape shapes share one, tall shapes another. */
const shapeClip = (ratio: number) => (Math.abs(Math.log(ratio)) < 0.05 ? `${V}/aspect-square.mp4` : ratio > 1 ? `${V}/aspect-wide.mp4` : `${V}/aspect-tall.mp4`);

/** One shape per label: fal lists both square_hd and square as 1:1. */
function uniqueShapes(list: AspectChoice[]) {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
}

const EXAMPLE_START: Frame = { url: `${V}/frames-start.webp`, width: 1024, height: 1280, name: "Example start", example: true };
const EXAMPLE_END: Frame = { url: `${V}/frames-end.webp`, width: 1024, height: 1280, name: "Example end", example: true };

function loadSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1280, height: 720 });
    img.src = url;
  });
}

async function uploadFile(file: File): Promise<Frame> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string; width: number; height: number }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
  return { ...data.items[0], name: file.name };
}

/** A pill track whose selected pill slides between options. */
function Choice<T extends string | number>({
  value,
  options,
  onChange,
  id,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  id: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("flex rounded-full bg-white/[0.05] p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative h-8 flex-1 rounded-full px-2.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35",
            value === o.value ? "text-[#16131b]" : "text-fog hover:text-paper",
          )}
        >
          {value === o.value ? <motion.span layoutId={`choice-${id}`} className="absolute inset-0 rounded-full bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

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

/** A tiny rectangle at a ratio, so a shape reads before its numbers. */
function RatioGlyph({ ratio, max = 15 }: { ratio: number | null; max?: number }) {
  if (ratio === null) {
    return (
      <span className="grid shrink-0 place-items-center" style={{ width: max + 2, height: max + 2 }} aria-hidden>
        <span className="size-[13px] rounded-[3px] border-[1.5px] border-dashed border-current opacity-80" />
      </span>
    );
  }
  const w = ratio >= 1 ? max : Math.round(max * ratio);
  const h = ratio >= 1 ? Math.round(max / ratio) : max;
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: max + 2, height: max + 2 }} aria-hidden>
      <span className="rounded-[2px] border-[1.5px] border-current opacity-80" style={{ width: Math.max(4, w), height: Math.max(4, h) }} />
    </span>
  );
}

/** Image-to-video and text-to-video: start and end frames, a camera move, a pace, a shape, a length. */
export function VideoTool() {
  const { items, submit, cancel } = useGenerations();
  const { models, defaults, loaded } = useModels();
  const [model, setModel] = useModelChoice("video", "video");
  useModelParam(setModel);
  const [start, setStart] = useState<Frame | null>(EXAMPLE_START);
  const [end, setEnd] = useState<Frame | null>(EXAMPLE_END);
  const [prompt, setPrompt] = useState("");
  const promptField = useRef<HTMLTextAreaElement>(null);
  const [move, setMove] = useState<(typeof MOVES)[number]["id"] | null>("push");
  const [pace, setPace] = useState<(typeof PACES)[number]["id"]>("natural");
  const [duration, setDuration] = useState<number | "auto">(6);
  // Unset until you pick one: each model starts at its own default (Wan 2.2 5B's is 540p, what small GPUs run).
  const [resolution, setResolution] = useState<string | number | undefined>(undefined);
  /** The shape you picked (a model's own value, e.g. "16:9" or "landscape_16_9"); null follows the start frame. */
  const [shape, setShape] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const [refine, setRefine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [mids, setMids] = useState<Keyframe[]>([]);

  // A still sent from elsewhere ("Animate") becomes the start frame.
  useEffect(() => {
    const ref = useHandoff.getState().take()?.references[0];
    if (ref)
      void loadSize(ref.url).then((s) => {
        setStart({ url: ref.url, name: ref.name, ...s });
        setEnd(null);
        setShape(null);
      });
  }, []);

  // A new start frame brings its own shape; pick another and the frames are cropped to it.
  function pickStart(f: Frame | null) {
    setStart(f);
    if (f) setShape(null);
  }

  // What the model that will run accepts: its frames, shapes, resolutions, lengths and sound.
  const effectiveId = model === "auto" ? resolveAutoId("video", models, defaults) : model;
  const info = useModelInfo(effectiveId);
  const caps = info.caps;
  // Open models on your own GPU: steps, guidance, a negative prompt and a seed.
  const tuning = useTuning(caps?.tuning);
  const noModel = loaded && !effectiveId;

  const shapes = useMemo(() => uniqueShapes(caps ? (caps.aspect?.choices ?? caps.size?.presets ?? []) : FALLBACK_SHAPES), [caps]);
  const realShapes = shapes.filter((s) => s.ratio !== null);
  const autoShape = shapes.find((s) => s.ratio === null) ?? null;
  const ticks = caps?.duration ? durationTicks(caps.duration) : null;
  const resChoices = caps?.resolution?.choices ?? (caps ? [] : ["480p", "720p", "1080p"].map((v) => ({ value: v, label: v })));
  // Keyframe models (FLUX 3) take the start and end frames as their first and last keyframes, and more in between.
  const keyframesCap = caps?.keyframes ?? null;
  const startRole: "frame" | "reference" | null = !caps ? "frame" : caps.image || keyframesCap ? "frame" : caps.refs ? "reference" : null;
  const endOk = !caps || Boolean(caps.end) || Boolean(keyframesCap);
  const startNeeded = Boolean(caps?.image?.required || keyframesCap?.required || (!caps?.image && caps?.refs?.required));
  const soundOk = !caps || Boolean(caps.audio);
  const usedStart = startRole ? start : null;
  const usedEnd = endOk && usedStart ? end : null;
  // The frames have words in the prompt too, like on Home: "@start", "@end" (the "@" menu offers them).
  const framePictures = [
    ...(usedStart ? [{ token: "start", label: startRole === "reference" ? "Reference" : "Start frame", said: "the start frame", url: usedStart.url }] : []),
    ...(usedEnd ? [{ token: "end", label: "End frame", said: "the end frame", url: usedEnd.url }] : []),
  ];
  const mentions = useMentions({
    textarea: promptField,
    value: prompt,
    onChange: setPrompt,
    pictures: framePictures.map(({ token, label, url }) => ({ token, label, src: previewUrl(url, 96) })),
  });
  // How the cast you @mention gets into the clip with this model (server/cast-refs does the same): a cloud model that takes
  // reference pictures gets their pictures; any other is shown them through a first frame drawn with them, or words.
  const castRefs = Boolean(caps?.refs?.max && !caps.video) && !effectiveId?.startsWith("local:");
  const capped = effectiveId?.startsWith("grok:") ? " (Grok renders those at up to 720p)" : "";
  const castFrameBy = resolveAuto("image", models, defaults, framePrefer(models, Boolean(effectiveId?.startsWith("local:"))), castFits);
  // Who from your Cast is in the words, and whether the clip first gets an opening frame drawn with them (you choose).
  const { items: castItems } = useCast();
  const inShot = mentionedHandles(prompt).flatMap((h) => castItems.filter((c) => c.handle === h));
  const [castFrame, setCastFrame] = useCastFrame();
  const drawsFrame = inShot.length > 0 && startRole === "frame" && !usedStart;
  const castHow =
    startRole === "reference" && castRefs
      ? `Their photos go along as reference pictures${capped}.`
      : !startRole
        ? "This model makes clips from words only, so your cast is described in words."
        : usedStart
          ? castRefs
            ? `Your start frame opens the clip, and their photos go along as reference pictures${capped}.`
            : "Your start frame opens the clip and they're described in words: this model takes no reference pictures. Leave the start frame empty and Crackio draws one with them."
          : castRefs
            ? `Their photos go along as reference pictures${capped}, and the model builds the shot around them.`
            : `Crackio first draws the opening frame with them on ${castFrameBy?.name ?? "your image model"}, then animates it.`;
  const startRatio = usedStart ? usedStart.width / usedStart.height : null;

  // Every setting snapped to what this model allows.
  const durationValue: number | "auto" | null = caps?.duration ? fitDuration(caps.duration, duration) : !caps ? duration : null;
  const resValue = resChoices.length ? (fitResolution(resChoices, resolution, caps?.resolution?.default ?? null) ?? resChoices[0].value) : null;
  const chosen =
    (shape ? shapes.find((s) => s.value === shape) : undefined) ??
    (startRatio !== null ? (autoShape ?? nearestAspect(realShapes, startRatio)) : null) ??
    realShapes.find((s) => s.value === (caps?.aspect?.default ?? caps?.size?.default)) ??
    nearestAspect(realShapes, 16 / 9) ??
    null;
  // Until you pick a shape, a clip keeps its start frame's shape; a shape you pick crops the frames to it.
  const explicit = Boolean(shape && chosen?.value === shape);
  const ratio = (explicit ? chosen?.ratio : null) ?? startRatio ?? chosen?.ratio ?? 16 / 9;
  const aspect = shotAspect(ratio);
  const cropping = Boolean(explicit && usedStart && chosen?.ratio && startRatio && Math.abs(Math.log(chosen.ratio / startRatio)) > 0.03);
  const cropRatio = cropping ? (chosen?.ratio ?? undefined) : undefined;

  const takes = useMemo(() => items.filter((g) => g.tool === "video" || (g.tool === "motion" && g.params?.kind === "video")), [items]);
  const live = takes.filter((g) => g.status === "queued" || g.status === "running");
  const shownGen = takes.find((g) => g.outputs[0]?.url === viewing) ?? live[0] ?? takes.find((g) => g.status === "done") ?? takes[0] ?? null;
  const shown = shownGen?.outputs[0];

  const words = [sayPictures(prompt.trim(), framePictures), MOVES.find((m) => m.id === move)?.phrase, PACES.find((p) => p.id === pace)?.phrase].filter(Boolean).join(" ");
  const missingStart = startNeeded && !usedStart;
  const canRun = Boolean((prompt.trim() || usedStart || words) && !busy && !noModel && !missingStart && !(info.loading && !caps));
  const lengthLabel = durationValue === "auto" ? "auto length" : durationValue ? `${durationValue}s` : null;
  // The clip's length in seconds, for placing keyframes (the model's usual length when it picks its own).
  const clipSeconds = typeof durationValue === "number" ? durationValue : typeof ticks?.preferred === "number" ? ticks.preferred : 5;
  const roomForMids = keyframesCap ? Math.max(0, keyframesCap.max - 2) : 0;
  const usedMids = keyframesCap && usedStart ? mids.slice(0, roomForMids).map((m) => ({ ...m, t: Math.min(clipSeconds - 0.25, Math.max(0.25, m.t)) })) : [];

  async function run() {
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") return void askForModel("video");
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      await submit({
        tool: "video",
        prompt: refine ? words : prompt.trim() || "Animate this image.",
        compiledPrompt: refine ? undefined : words || "Animate this image naturally.",
        aspect,
        count: 1,
        model,
        refine,
        references: [
          ...(usedStart ? [{ url: usedStart.url, label: "the start frame", role: "subject" as const }] : []),
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
          ...(inShot.length ? castFrameParams(castFrame, castRefs) : {}),
          startUrl: usedStart?.url,
          ...(usedMids.length ? { keyframes: usedMids.map((m) => ({ url: m.frame.url, t: Math.round(m.t * 100) / 100 })) } : {}),
          endUrl: usedEnd?.url,
        },
      });
      setViewing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const frameHint = !startRole
    ? "This model makes clips from words only"
    : startRole === "reference"
      ? "Your picture guides the clip as a reference"
      : start?.example || end?.example
        ? "Example loaded · replace with yours"
        : keyframesCap && start
          ? `Passes through every keyframe · up to ${keyframesCap.max}`
          : start
          ? usedEnd
            ? "Lands on your end frame"
            : end && !endOk
              ? "This model can't land on an end frame"
              : "Animates from your start frame"
          : startNeeded
            ? "This model needs a start frame"
            : "Optional";

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex items-start gap-3">
        <AppIcon glyph="/icons/video.png" size={36} className="mt-1" />
        <div className="min-w-0">
          <h1 className="font-display text-[30px] sm:text-[34px]">Video</h1>
          <p className="mt-1 max-w-[70ch] text-[15px] leading-relaxed text-haze">
            Bring a still to life, or write a shot from scratch. Hover any option to see what it does before you pick it.
          </p>
        </div>
      </header>

      <div className="mt-7 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
        <Panel className="flex flex-col">
          <PanelHeader title="Shot" />
          <div className="space-y-6 p-3.5">
            <ModelPicker kind="video" task="video" value={model} onChange={setModel} />
            {noModel ? (
              <p className="rounded-[12px] bg-tungsten/10 px-3.5 py-3 text-[13px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
                Video needs a video model. Install a free one on your GPU in{" "}
                <Link href="/local" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
                  Local
                </Link>{" "}
                (ComfyUI), or add a Comfy key in{" "}
                <Link href="/settings/connections" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
                  Connections
                </Link>
                .
              </p>
            ) : null}

            <Section title={keyframesCap ? "Keyframes" : "Start & end frames"} hint={frameHint}>
              <HoverPreview
                title="How start and end frames shape a clip"
                caption="The clip opens on your first frame and lands exactly on your last; the prompt fills the motion between them."
                width={280}
                ratio={4 / 5}
                className="block"
                media={
                  <>
                    <video src={`${V}/frames-clip.mp4`} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />
                    <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2">
                      <MiniFrame src={EXAMPLE_START.url} label="Start" />
                      <span className="grid size-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur-md">
                        <ArrowRight size={12} />
                      </span>
                      <MiniFrame src={EXAMPLE_END.url} label="End" />
                    </div>
                  </>
                }
              >
                <div className="flex items-stretch gap-2">
                  <FrameSlot
                    label={startRole === "reference" ? "Reference" : "Start"}
                    word={usedStart ? "start" : undefined}
                    frame={start}
                    onChange={pickStart}
                    onError={setError}
                    crop={cropRatio}
                    cropLabel={chosen?.label}
                    unused={!startRole}
                    unusedNote="Not used by this model"
                    needed={missingStart}
                  />
                  <div className="grid w-7 shrink-0 place-items-center">
                    <span className={cn("grid size-7 place-items-center rounded-full bg-white/[0.06] text-fog transition-opacity", !(usedStart && usedEnd) && "opacity-40")}>
                      <ArrowRight size={13} />
                    </span>
                  </div>
                  <FrameSlot
                    label="End"
                    word={usedEnd ? "end" : undefined}
                    frame={end}
                    onChange={setEnd}
                    onError={setError}
                    disabled={!start || !startRole}
                    crop={cropRatio}
                    cropLabel={chosen?.label}
                    unused={Boolean(start) && !endOk}
                    unusedNote="This model can't use an end frame"
                  />
                </div>
              </HoverPreview>
              {keyframesCap ? (
                <Keyframes
                  mids={mids}
                  setMids={setMids}
                  seconds={clipSeconds}
                  room={roomForMids}
                  disabled={!usedStart}
                  crop={cropRatio}
                  cropLabel={chosen?.label}
                  onError={setError}
                />
              ) : null}
            </Section>

            <Section title="What happens" hint={<Switch checked={refine} onChange={setRefine} label="Refine" title="Rewrite your words into a precise motion prompt, in any language" />}>
              <textarea
                ref={promptField}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => void mentions.onKeyDown(e)}
                rows={3}
                placeholder={usedStart ? "She turns from the window and smiles, lifting her cup…" : "A paper boat drifts across a pond at dawn, ripples spreading…"}
                className="w-full resize-none rounded-[14px] bg-white/[0.03] px-3.5 py-3 text-[14px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
              />
              {mentions.menu}
              <CastStrip prompt={prompt} onChange={setPrompt} how={drawsFrame ? null : castHow} className="mt-2.5" />
              {drawsFrame ? (
                <CastFrameControl
                  setting={castFrame}
                  onChange={setCastFrame}
                  auto={castFrameBy ? { id: castFrameBy.id, name: castFrameBy.name } : null}
                  who={namesOf(inShot.map((c) => c.name))}
                  refs={castRefs}
                  className="mt-2"
                />
              ) : null}
            </Section>

            <Section title="Camera" hint={move ? MOVES.find((m) => m.id === move)?.label : "Model decides"}>
              <div className="grid grid-cols-3 gap-1.5">
                {MOVES.map((m) => {
                  const Icon = m.icon;
                  const active = move === m.id;
                  return (
                    <HoverPreview key={m.id} title={m.label} caption={m.caption} src={`${V}/cam-${m.id}.mp4`}>
                      <button
                        type="button"
                        onClick={() => setMove((cur) => (cur === m.id ? null : m.id))}
                        className={cn(
                          "press group relative flex h-[58px] flex-col items-start justify-between overflow-hidden rounded-[12px] px-2.5 py-2 text-left transition-colors",
                          active ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                        )}
                      >
                        <Icon size={15} className={cn("transition-transform duration-500 group-hover:scale-110", active ? "text-spike" : "")} />
                        <span className="text-[12px] font-semibold leading-none">{m.label}</span>
                      </button>
                    </HoverPreview>
                  );
                })}
              </div>
            </Section>

            <Section title="Pace">
              <div className="grid grid-cols-3 gap-1.5">
                {PACES.map((p) => (
                  <HoverPreview key={p.id} title={p.label} caption={p.caption} src={`${V}/pace-${p.id}.mp4`}>
                    <button
                      type="button"
                      onClick={() => setPace(p.id)}
                      className={cn(
                        "press relative h-10 rounded-full text-[12.5px] font-semibold transition-colors",
                        pace === p.id ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                      )}
                    >
                      {pace === p.id ? <motion.span layoutId="pace-pill" className="absolute inset-0 rounded-full bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
                      <span className="relative">{p.label}</span>
                    </button>
                  </HoverPreview>
                ))}
              </div>
            </Section>

            <Section
              title="Aspect ratio"
              hint={
                !shapes.length
                  ? usedStart
                    ? "Follows your start frame"
                    : "Set by the model"
                  : chosen?.ratio === null || (usedStart && !explicit)
                    ? "Matches your start frame"
                    : cropping
                      ? "Your frames are cropped to fit"
                      : chosen?.label
              }
            >
              {shapes.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1.5">
                  {shapes
                    .filter((s) => s.ratio !== null || usedStart)
                    .map((s) => {
                      // Until you pick, a clip with a start frame keeps the frame's shape: no ratio is lit, only "Frame".
                      const active = explicit || !usedStart ? chosen?.value === s.value : s.ratio === null;
                      const r = s.ratio ?? startRatio ?? 1;
                      return (
                        <HoverPreview
                          key={s.value}
                          title={s.ratio === null ? "Match the start frame" : s.label}
                          caption={s.ratio === null ? "The clip keeps your start frame's own shape." : "The same shot, cropped to this shape."}
                          src={shapeClip(r)}
                          ratio={16 / 9}
                          crop={r}
                          width={r >= 1 ? 240 : 170}
                        >
                          <button
                            type="button"
                            onClick={() => setShape(s.value)}
                            aria-pressed={active}
                            className={cn(
                              "press relative flex h-14 w-full flex-col items-center justify-center gap-1 rounded-[12px] text-[11px] font-semibold transition-colors",
                              active ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                            )}
                          >
                            {active ? <motion.span layoutId="aspect-pill" className="absolute inset-0 rounded-[12px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
                            <span className="relative">
                              <RatioGlyph ratio={s.ratio} />
                            </span>
                            <span className="relative">{s.ratio === null ? "Frame" : s.label}</span>
                          </button>
                        </HoverPreview>
                      );
                    })}
                </div>
              ) : (
                <p className="rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[12.5px] text-haze">
                  {usedStart ? "This model keeps your start frame's shape." : "This model picks the shape itself."}
                </p>
              )}
            </Section>

            {/* Length and quality share one line: the ruler stretches, the resolutions sit beside it. */}
            <Section
              title={resChoices.length ? "Length & quality" : "Length"}
              hint={
                !caps?.duration && caps
                  ? "Length set by the model"
                  : durationValue === "auto"
                    ? "The model picks the length"
                    : ticks
                      ? ticks.seconds.length === ticks.max - ticks.min + 1
                        ? `${ticks.min}–${ticks.max} s`
                        : `${ticks.seconds.length} lengths up to ${ticks.max} s`
                      : null
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {ticks && ticks.seconds.length > 1 ? (
                  <DurationRuler className="min-w-[200px] flex-1" value={durationValue ?? ticks.seconds[0]} allowed={ticks.seconds} max={ticks.max} auto={ticks.auto} onChange={setDuration} />
                ) : ticks ? (
                  <span className="flex h-10 flex-1 items-center rounded-full bg-white/[0.05] px-4 text-[12.5px] text-haze">
                    <span className="mr-1.5 font-bold text-paper">{ticks.seconds[0]}s</span> the only length this model makes
                  </span>
                ) : caps ? (
                  <span className="flex h-10 flex-1 items-center rounded-full bg-white/[0.05] px-4 text-[12.5px] text-haze">The model sets the length</span>
                ) : (
                  <div className="skeleton h-10 flex-1 rounded-full" />
                )}
                {resChoices.length ? (
                  <Choice
                    id="quality"
                    className="h-10 shrink-0 p-1"
                    value={String(resValue)}
                    onChange={(v) => setResolution(v)}
                    options={resChoices.map((c) => ({ value: String(c.value), label: resolutionLabel(c.value), title: resChoices.length === 1 ? "The only resolution this model makes" : undefined }))}
                  />
                ) : null}
              </div>
            </Section>

            {soundOk ? (
              <button
                type="button"
                onClick={() => setSound((s) => !s)}
                className="press flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
              >
                <span className={cn("grid size-8 place-items-center rounded-full", sound ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-haze")}>
                  {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </span>
                <span className="flex-1">
                  <span className="block text-[13.5px] font-semibold">{sound ? "Sound on" : "Silent"}</span>
                  <span className="block text-[12px] text-haze">{sound ? "Ambience and effects generated with the clip" : "Video only"}</span>
                </span>
                <span className={cn("relative h-5 w-9 rounded-full transition-colors", sound ? "bg-spike" : "bg-gaffer")}>
                  <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", sound ? "left-[18px]" : "left-0.5")} />
                </span>
              </button>
            ) : caps ? (
              <p className="flex items-center gap-2 px-1 text-[12px] text-haze">
                <VolumeX size={13} /> This model has no sound setting.
              </p>
            ) : null}

            <AdvancedOptions
              s={tuning}
              job={{ model: effectiveId, kind: "video", duration: typeof durationValue === "number" ? durationValue : undefined, resolution: resValue !== null ? String(resValue) : undefined }}
              className="rounded-[14px] shadow-[inset_0_0_0_1px_var(--color-line)]"
            />
          </div>

          <div className="mt-auto space-y-2 border-t border-line p-3.5">
            {shownGen?.status === "error" ? (
              <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  {shownGen.error} {shownGen.stage ? <span className="text-paper">{shownGen.stage}</span> : null}
                </span>
              </p>
            ) : null}
            {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
            <LocalTimeLine modelId={effectiveId} kind="video" duration={typeof durationValue === "number" ? durationValue : undefined} resolution={resValue !== null ? String(resValue) : undefined} />
            <CostLine
              modelId={effectiveId}
              input={{ output: "video", seconds: durationValue ?? undefined, resolution: resValue, ratio, count: 1, sound: soundOk ? sound : undefined }}
              quote={{
                output: "video",
                seconds: durationValue ?? undefined,
                resolution: resValue !== null ? String(resValue) : null,
                aspectValue: chosen?.value ?? null,
                aspect,
                count: 1,
                sound: soundOk ? sound : undefined,
                start: Boolean(usedStart),
                end: Boolean(usedEnd),
              }}
            />
            <button
              onClick={() => void run()}
              disabled={!canRun}
              className="lip press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
            >
              {busy || (info.loading && !caps) ? <LoaderCircle size={17} className="animate-spin" /> : null}
              {missingStart ? "Add a start frame for this model" : prompt.trim() || usedStart || words ? `Make the clip${lengthLabel ? ` · ${lengthLabel}` : ""}` : "Add a start frame or describe the shot"}
            </button>
          </div>
        </Panel>

        <Panel className="flex min-h-[480px] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-190px)] lg:min-h-[560px]">
          <PanelHeader title={<span className="label text-fog">Output</span>}>
            {live.length ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-fog">
                <RecDot /> {live[0].stage ?? "Rendering"} <span className="tabular text-haze">{Math.round((live[0].progress ?? 0) * 100)}%</span>
              </span>
            ) : null}
          </PanelHeader>
          <div className="grid h-[62vh] min-h-[320px] place-items-center p-4 [container-type:size] lg:h-auto lg:min-h-0 lg:flex-1">
            {!shownGen ? (
              <EmptyState eyebrow="00:00:06" title="Your clip plays here">
                Pick a start frame (or keep the example), choose a camera move, and make the clip.
              </EmptyState>
            ) : (
              <OutputBox gen={shownGen}>
                {shown ? <Media media={shown} alt={shownGen.prompt} controls className="size-full object-contain" /> : null}
                {shownGen.status === "queued" || shownGen.status === "running" ? (
                  <GeneratingField
                    stage={shownGen.stage}
                    progress={shownGen.progress}
                    prompt={shownGen.prompt}
                    since={shownGen.createdAt}
                    backdrop={typeof shownGen.params?.startUrl === "string" ? shownGen.params.startUrl : null}
                    onCancel={() => cancel(shownGen.id)}
                  />
                ) : null}
              </OutputBox>
            )}
          </div>
          {shownGen?.status === "done" ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5">
              <Osd className="tabular text-haze">
                {shownGen.aspect}
                {shownGen.modelName ? ` · ${shownGen.modelName}` : ""}
                {shownGen.finishedAt ? ` · ${Math.round((shownGen.finishedAt - shownGen.createdAt) / 1000)}s` : ""}
              </Osd>
              {shown ? (
                <a href={shown.url} download className="ml-auto text-[12.5px] font-semibold text-fog hover:text-paper">
                  Download
                </a>
              ) : null}
            </div>
          ) : null}
          {takes.length > 1 ? (
            <div className="scrollbar-none flex gap-2 overflow-x-auto border-t border-line p-3">
              {takes.map((g) => (
                <TakeChip key={g.id} gen={g} active={g.id === shownGen?.id} onClick={() => setViewing(g.outputs[0]?.url ?? null)} />
              ))}
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/** The clip's frame: the real size of the result once known, else the shape that was asked for. */
function OutputBox({ gen, children }: { gen: Generation; children: ReactNode }) {
  const out = gen.outputs[0];
  const a = aspectById(gen.aspect);
  const ratio = out?.width && out?.height ? out.width / out.height : a.w / a.h;
  return (
    <div className="relative overflow-hidden rounded-[12px] bg-apple" style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}>
      {children}
    </div>
  );
}

function MiniFrame({ src, label }: { src: string; label: string }) {
  return (
    <span className="relative block h-14 w-11 overflow-hidden rounded-[8px] shadow-[0_0_0_1.5px_rgb(255_255_255/0.85),0_6px_14px_-4px_rgb(0_0_0/0.6)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="size-full object-cover" />
      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-px text-center text-[8.5px] font-bold uppercase tracking-[0.08em] text-white">{label}</span>
    </span>
  );
}

/** Where a center crop to `ratio` lands on a frame shown edge to edge in a 4:5 card, in percent of the card. */
function cropGuide(frame: Frame, ratio: number) {
  const card = 4 / 5;
  const img = frame.width / frame.height;
  const shownW = img > card ? img / card : 1;
  const shownH = img > card ? 1 : card / img;
  return { width: Math.min(1, Math.min(1, ratio / img) * shownW) * 100, height: Math.min(1, Math.min(1, img / ratio) * shownH) * 100 };
}

/**
 * The pictures a keyframe model passes through between the start and end frames: each one a
 * thumbnail and a moment on the clip's own timeline, added up to the model's limit.
 */
function Keyframes({
  mids,
  setMids,
  seconds,
  room,
  disabled,
  crop,
  cropLabel,
  onError,
}: {
  mids: Keyframe[];
  setMids: (fn: (m: Keyframe[]) => Keyframe[]) => void;
  /** The clip's length. */
  seconds: number;
  /** How many fit between the start and end frames. */
  room: number;
  disabled: boolean;
  crop?: number;
  cropLabel?: string;
  onError: (e: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const sorted = [...mids].sort((a, b) => a.t - b.t);

  // A new keyframe goes in the middle of the widest gap left on the timeline.
  function nextMoment() {
    const marks = [0, ...sorted.map((m) => Math.min(seconds, m.t)), seconds];
    let best = { at: seconds / 2, gap: 0 };
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > best.gap) best = { at: (marks[i] + marks[i - 1]) / 2, gap: marks[i] - marks[i - 1] };
    return Math.round(best.at * 4) / 4;
  }

  async function add(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const frame = await uploadFile(file);
      const t = nextMoment();
      setMids((m) => [...m, { id: `${Date.now().toString(36)}${m.length}`, frame, t }]);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("mt-2.5 space-y-1.5", disabled && "pointer-events-none opacity-40")}>
      {sorted.map((m) => {
        const guide = crop ? cropGuide(m.frame, crop) : null;
        const over = m.t >= seconds - 0.25;
        return (
          <div key={m.id} className="flex items-center gap-2.5 rounded-[12px] bg-white/[0.03] p-1.5 pr-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="relative h-12 w-10 shrink-0 overflow-hidden rounded-[8px] bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.frame.url} alt="" className="size-full object-cover" />
              {guide ? (
                <span
                  aria-hidden
                  title={cropLabel}
                  className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] shadow-[0_0_0_1px_rgb(255_255_255/0.9),0_0_0_99px_rgb(10_8_14/0.55)]"
                  style={{ width: `${guide.width}%`, height: `${guide.height}%` }}
                />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="font-semibold text-paper">Keyframe</span>
                <span className={cn("tabular", over ? "text-tungsten" : "text-fog")}>{over ? `past the end (${seconds}s)` : `at ${m.t.toFixed(m.t % 1 ? 2 : 0).replace(/0$/, "")} s`}</span>
              </span>
              <input
                type="range"
                min={0.25}
                max={Math.max(0.5, seconds - 0.25)}
                step={0.25}
                value={Math.min(m.t, Math.max(0.5, seconds - 0.25))}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  setMids((all) => all.map((x) => (x.id === m.id ? { ...x, t } : x)));
                }}
                aria-label="When the clip reaches this keyframe"
                className="mt-1 block w-full accent-[var(--color-spike)]"
              />
            </span>
            <button type="button" onClick={() => setMids((all) => all.filter((x) => x.id !== m.id))} className="grid size-6 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper" aria-label="Remove keyframe">
              <X size={12} />
            </button>
          </div>
        );
      })}
      {mids.length < room ? (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void add(e.dataTransfer.files[0]);
          }}
          className="press flex h-10 w-full items-center justify-center gap-1.5 rounded-[12px] text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03] hover:text-paper disabled:cursor-not-allowed"
        >
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />} Add a keyframe in between
          <span className="font-normal text-haze">· {room - mids.length} more</span>
        </button>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void add(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function FrameSlot({
  label,
  word,
  frame,
  onChange,
  onError,
  disabled,
  crop,
  cropLabel,
  unused,
  unusedNote,
  needed,
}: {
  label: string;
  /** The word that names it in the prompt ("start"). */
  word?: string;
  frame: Frame | null;
  onChange: (f: Frame | null) => void;
  onError: (e: string) => void;
  disabled?: boolean;
  /** The clip's shape (width / height) when the frame gets cropped to it. */
  crop?: number;
  cropLabel?: string;
  /** The model won't use this frame. */
  unused?: boolean;
  unusedNote?: string;
  /** The model needs this frame and it's missing. */
  needed?: boolean;
}) {
  const guide = frame && crop && !unused ? cropGuide(frame, crop) : null;
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  /** A picture you made before: already on Crackio, only its size is needed. */
  async function reuse(p: PickedPicture) {
    setBusy(true);
    try {
      const size = p.width && p.height ? { width: p.width, height: p.height } : await loadSize(p.url);
      onChange({ url: p.url, name: p.name, ...size });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function take(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadFile(file));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cn("relative min-w-0 flex-1", disabled && "opacity-40")}>
      {/* Your latest pictures first, then your computer. */}
      <PicturePicker
        roles={[{ id: "frame", label: `${label} frame` }]}
        placement="bottom-start"
        className="block w-full"
        onPick={(_, [p]) => p && void reuse(p)}
        onUpload={(_, files) => void take(files[0])}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="dialog"
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void take(e.dataTransfer.files[0]);
            }}
            className={cn(
              "press group relative block aspect-[4/5] w-full overflow-hidden rounded-[14px] bg-white/[0.03] text-left transition-shadow disabled:cursor-not-allowed",
              over
                ? "shadow-[inset_0_0_0_2px_var(--color-spike)]"
                : needed
                  ? "shadow-[inset_0_0_0_1.5px_var(--color-tungsten)]"
                  : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
            )}
          >
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={frame.url} alt="" className={cn("absolute inset-0 size-full object-cover transition-[transform,opacity] duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.04]", unused && "opacity-30 grayscale")} />
            ) : (
              <span className={cn("absolute inset-0 flex flex-col items-center justify-center gap-1.5", needed ? "text-tungsten" : "text-haze")}>
                {busy ? <LoaderCircle size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                <span className="text-[11px] font-medium">{needed ? "Needed" : "Drop or click"}</span>
              </span>
            )}
            {frame && unused ? (
              <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 rounded-[8px] bg-black/60 px-2 py-1.5 text-center text-[10.5px] font-semibold leading-snug text-white backdrop-blur">{unusedNote}</span>
            ) : null}
            {frame && !unused ? (
              // What the clip keeps when it's a different shape than the picture.
              <motion.span
                aria-hidden
                initial={false}
                animate={{ width: `${guide?.width ?? 100}%`, height: `${guide?.height ?? 100}%`, opacity: guide ? 1 : 0 }}
                transition={{ type: "spring", bounce: 0.12, duration: 0.5 }}
                className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[8px] shadow-[0_0_0_1.5px_rgb(255_255_255/0.9),0_0_0_999px_rgb(10_8_14/0.6)]"
              >
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-px text-[9.5px] font-bold text-white backdrop-blur">{cropLabel}</span>
              </motion.span>
            ) : null}
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 to-transparent px-2.5 pb-2 pt-6">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[12px] font-bold uppercase tracking-[0.08em] text-white">{label}</span>
                {word ? <span className="font-mono text-[10.5px] text-white/65">@{word}</span> : null}
              </span>
              {frame?.example ? <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[9.5px] font-semibold text-white backdrop-blur">Example</span> : null}
            </span>
          </button>
        )}
      />
      {frame ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-paper hover:bg-black/80"
          aria-label={`Remove ${label.toLowerCase()} frame`}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function TakeChip({ gen, active, onClick }: { gen: Generation; active: boolean; onClick: () => void }) {
  const out = gen.outputs[0];
  const live = gen.status === "queued" || gen.status === "running";
  return (
    <button
      onClick={onClick}
      className={cn("relative h-14 w-24 shrink-0 overflow-hidden rounded-[8px] bg-apple", active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line)]")}
      title={gen.status === "error" ? gen.error : gen.modelName}
    >
      {out ? <Media media={out} slot="chip" className="size-full object-cover" /> : null}
      {live ? <GeneratingField bare progress={gen.progress} /> : null}
      {gen.status === "error" ? (
        <span className="absolute inset-0 grid place-items-center text-tally">
          <TriangleAlert size={15} />
        </span>
      ) : null}
    </button>
  );
}
