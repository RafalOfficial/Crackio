"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Clapperboard, Copy, CornerDownLeft, Expand, LoaderCircle, Mountain, PersonStanding, ScrollText, TriangleAlert, X } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { useCompiled } from "@/lib/director/use-compiled";
import { briefPictures, compileScene, swapPrompt } from "@/lib/director/compile";
import { useGenerations } from "@/lib/hooks/use-generations";
import { aspectById, sizeFor } from "@/lib/shot";
import { captureShot } from "./stage/capture";
import { useShotModel } from "./shot-model";
import { useModelChoice } from "@/lib/hooks/use-model-choice";
import { useModelsStore } from "@/lib/hooks/use-models";
import { usePlaceModel } from "./place-model";
import { generateLocation, useLocation } from "./location";
import { extendPlace, useExtend } from "./extend";
import { arrangeFromWords, useArrange } from "./arrange";
import { aboutTime, loadTypical, useTypical } from "./around";
import { DIRECTOR_MODELS, SHOT_MODELS } from "./models";
import { shotSizeFor, useDepthFigures, useDirectorShot, usePlaceSize, useShotSize, type DepthFigures } from "./shot-model";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { lorasFor, setLora, useModelLoras } from "@/lib/hooks/use-model-loras";
import { entryFiles, loadLoraLibrary, useLoraLibrary } from "@/lib/hooks/use-lora-library";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { ModelPicker } from "@/components/models/ModelPicker";
import { ChipButton, GLASS_CHIP } from "@/components/dashboard/ComposerControls";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

async function uploadBlob(blob: Blob, name: string) {
  const body = new FormData();
  body.append("file", new File([blob], name, { type: blob.type || "image/png" }));
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Couldn't save the layout guide.");
  return data.items[0].url;
}

/**
 * Notes, model and the one button. What's sent: the place as your camera sees it (what the photo doesn't show filled
 * in), a colored stand-in where each subject stands, each subject's own picture from the side the camera sees it, and
 * a prompt written from the set. Crackio fits that to what the model takes when the take runs (server/director).
 */
export function PromptBar() {
  const scene = useDirector((s) => s.scene);
  const { setScene } = useDirector.getState();
  const compiled = useCompiled();
  // The swap as the server writes it for a model that takes the shot and up to four subjects' pictures.
  const brief = useMemo(() => {
    const subjects = briefPictures(scene, 99).subjects.slice(0, 4);
    const pictures = new Map(subjects.map((s, i) => [s.el.id, { image: i + 2, sheet: s.sheet, matched: Boolean(s.el.cast?.sheet || s.el.views?.length) }]));
    return { prompt: swapPrompt(scene, pictures), subjects };
  }, [scene]);
  const submit = useGenerations((s) => s.submit);
  // The place's model as you chose it (with none, the first ready one: placeDefault below); the cast's drawings too.
  const [model] = useModelChoice("image", "edit", { first: DIRECTOR_MODELS });
  // Shots are drawn by the ControlNet model: the set's depth and the words, no pictures to copy (models.ts).
  const models = useModelsStore((s) => s.models);
  const shotChoice = useDirectorShot((s) => s.model);
  // Nothing chosen: the first Director shot model that’s ready (Z-Image Director, else Qwen Director), as the place does.
  const shotModel = SHOT_MODELS.includes(shotChoice) ? shotChoice : (SHOT_MODELS.find((id) => models.find((m) => m.id === id)?.available) ?? SHOT_MODELS[0]);
  // The sizes the shot model draws at (its own list, 4K where it offers it).
  const resolution = useModelInfo(shotModel).caps?.resolution;
  const picked = useShotSize((s) => s.size);
  const shotSize = shotSizeFor(resolution, picked);
  // With nothing chosen yet (a new studio, a fresh install), the place is made with the first of the Director's place
  // models that's ready, not a "Choose a model" step: no Auto and no guessing, just what's there (the user). A choice
  // made in a picker still wins.
  const placeDefault = model !== "auto" ? model : (DIRECTOR_MODELS.find((id) => models.find((m) => m.id === id)?.available) ?? model);
  useEffect(() => useShotModel.setState({ model: placeDefault }), [placeDefault]);
  const count = 1;
  const [busy, setBusy] = useState(false);
  // What the bar does: make the place from words (only while there's none), extend it where the camera looks, or
  // shoot. One bar for all three: the place's own prompt fields on the left and in the empty set crowded the page.
  const hasPlace = Boolean(scene.place.image);
  const [mode, setMode] = useState<Mode>(() => (hasPlace ? "generate" : "environment"));
  const cast = scene.elements.length > 0;
  const shown: Mode =
    mode === "environment" && hasPlace
      ? "generate"
      : mode === "extend" && !scene.place.image?.view
        ? hasPlace
          ? "generate"
          : "environment"
        : mode === "arrange" && !cast
          ? "generate"
          : mode;
  const [placeWords, setPlaceWords] = useState("");
  const [extendWords, setExtendWords] = useState("");
  const [arrangeWords, setArrangeWords] = useState("");
  const arranging = useArrange();
  const placeModelId = usePlaceModel((s) => s.model) ?? placeDefault;
  const location = useLocation();
  const extending = useExtend();
  // How long making the place takes here (its photo and its world, as the last runs went).
  const typical = useTypical();
  useEffect(loadTypical, []);
  const eta = typical.world ? aboutTime((typical.photo ?? 0) + typical.world) : null;
  const working = shown === "environment" ? location.busy : shown === "extend" ? Boolean(extending.stage) : shown === "arrange" ? arranging.busy : busy;
  const words = shown === "environment" ? placeWords : shown === "extend" ? extendWords : shown === "arrange" ? arrangeWords : scene.notes;
  const setWords = (v: string) =>
    shown === "environment" ? setPlaceWords(v) : shown === "extend" ? setExtendWords(v) : shown === "arrange" ? setArrangeWords(v) : setScene({ notes: v });
  const go = () => {
    if (shown === "environment") {
      if (placeWords.trim()) void generateLocation(placeWords);
    } else if (shown === "extend") {
      void extendPlace(extendWords).then(() => {
        if (!useExtend.getState().error) setExtendWords("");
      });
    } else if (shown === "arrange") {
      // Arranged, the words are the shot's too (when it has none yet), and the bar is ready to shoot it.
      const said = arrangeWords;
      void arrangeFromWords(said).then((ok) => {
        if (!ok) return;
        if (!useDirector.getState().scene.notes.trim()) setScene({ notes: said.trim() });
        setArrangeWords("");
        setMode("generate");
      });
    } else void shoot();
  };
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);

  async function shoot() {
    if (busy) return;
    if (!scene.elements.length && !scene.notes.trim() && !scene.place.image && !scene.place.text.trim()) {
      setError("Add a place or someone to the set, or describe the shot in the notes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const final = compileScene(scene);
      const size = sizeFor(scene.aspect, 1536);
      const shot = await captureShot(size.width, size.height);
      const [guideUrl, blockingUrl, depthUrl, plateUrl, idsUrl, lookUrl] = await Promise.all([
        uploadBlob(shot.guide, "guide.png"),
        uploadBlob(shot.blocking, "blocking.png"),
        uploadBlob(shot.depth, "depth.png"),
        uploadBlob(shot.plate, "plate.png"),
        uploadBlob(shot.ids, "ids.png"),
        uploadBlob(shot.look, "look.png"),
      ]);
      const summary = [final.sheet.map((s) => s.value).join(" · "), scene.notes.trim()].filter(Boolean).join(" — ");
      await submit({
        tool: "director",
        prompt: summary,
        compiledPrompt: brief.prompt,
        aspect: scene.aspect,
        count,
        model: shotModel,
        refine: false,
        // Each subject's Cast sheet or photo (the server sends the side the camera sees, as many as the model takes).
        references: brief.subjects.map((x) => ({ url: x.url, label: x.sheet ? `${x.el.name}, reference sheet` : x.el.name, role: x.el.kind === "product" ? ("product" as const) : ("subject" as const) })),
        params: {
          kind: "image",
          director: 4,
          guideUrl,
          blockingUrl,
          depthUrl,
          comp: { plateUrl, idsUrl, lookUrl, boxes: shot.boxes },
          // Drawn through a ControlNet (server/director-fresh `runDirectorControl`): the depth of the view the camera sees
          // holds the camera and everyone's marks, the words say who is where. "fresh" (the pieces as reference pictures,
          // 2026-10-29) and "swap" and "real" remain for comparison.
          cast: "control",
          figures: { auto: "auto", none: false, soft: "auto", "stand-ins": true }[useDepthFigures.getState().figures] ?? "auto",
          options: { resolution: shotSize, loras: lorasFor(shotModel) },
          placeModel: usePlaceModel.getState().model ?? undefined,
          // The place came from the surround (Stage3D): real pictures' pixels, nothing to redraw.
          surround: Boolean(scene.place.image),
          scene,
          sheet: final.sheet,
          layout: final.layout,
        },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const warning = compiled.warnings[0];

  return (
    <div className="relative">
      <AnimatePresence>
        {showPrompt ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            className="squircle absolute inset-x-0 bottom-full z-30 mb-2 rounded-card bg-apple-2 p-4 shadow-[0_0_0_1px_var(--color-line-strong),0_-20px_50px_-20px_rgb(0_0_0/0.7)]"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] font-semibold">What Crackio will send</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={async () => {
                    if (!(await copyText(brief.prompt))) return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold text-fog hover:bg-gaffer hover:text-paper"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
                </button>
                <button onClick={() => setShowPrompt(false)} className="press grid size-8 place-items-center rounded-lg text-haze hover:bg-gaffer hover:text-paper" aria-label="Close">
                  <X size={15} />
                </button>
              </div>
            </div>
            <p className="scroll-thin mt-2 max-h-[34vh] overflow-y-auto text-[13px] leading-relaxed text-paper/90">{brief.prompt}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 items-center rounded-lg bg-flat px-2 text-[12px] text-fog">Image 1: your shot, with a stand-in for each subject</span>
              {brief.subjects.map((x, i) => (
                <span key={x.el.id} className="inline-flex items-center gap-1.5 rounded-lg bg-flat py-1 pl-1 pr-2 text-[12px] text-fog">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={x.url} alt="" className="checker size-6 rounded-md object-cover" />
                  Image {i + 2}: {x.el.name}
                  {x.el.cast?.sheet || x.el.views?.length ? ", from the side your camera sees" : ""}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-haze">
              Crackio fills in what your place photo doesn&apos;t show and puts a colored stand-in where each subject stands. The model then swaps each stand-in for its subject, so the camera, framing and place stay exactly as you set them. People and pets look most like themselves when they come from Cast.
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Like Home's prompt bar: the words first and big, the settings in a row of chips under them, the button on the
          right. A warning floats over it instead of making it taller (the button didn't grow with it: the user). */}
      <AnimatePresence>
        {(shown === "generate" && (warning || error)) || (shown === "environment" && location.error) || (shown === "extend" && extending.error) || (shown === "arrange" && arranging.error) ? (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cn(
              "absolute bottom-full left-3 z-20 mb-2 flex max-w-[calc(100%-24px)] items-center gap-1.5 rounded-full bg-apple-2 px-3 py-1.5 text-[12.5px] shadow-[0_0_0_1px_var(--color-line-strong),0_10px_30px_-10px_rgb(0_0_0/0.8)]",
              shown === "generate" && !error ? "text-tungsten" : "text-tally",
            )}
            title={compiled.warnings.join("\n")}
          >
            <TriangleAlert size={13} className="shrink-0" />
            <span className="truncate">{shown === "environment" ? location.error : shown === "extend" ? extending.error : shown === "arrange" ? arranging.error : (error ?? warning)}</span>
            {shown === "generate" && !error && compiled.warnings.length > 1 ? <span className="shrink-0 text-haze">+{compiled.warnings.length - 1}</span> : null}
          </motion.p>
        ) : null}
      </AnimatePresence>
      <div className="smoked-glass squircle rounded-[26px] p-2">
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="director-notes">
              {MODES[shown].label}
            </label>
            <div className="relative">
              {/* The example is one line, faded out where it would run on: a native placeholder wrapped onto a second
                  line under the chips (the user). The box grows only with lines you type, up to --words-max (the
                  camera column sets it: until the screen's top is level with the side panels'). */}
              {words ? null : (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden whitespace-nowrap px-3 pt-3 text-[15px] leading-relaxed text-haze [mask-image:linear-gradient(to_right,#000_calc(100%-64px),transparent)]"
                >
                  {MODES[shown].placeholder}
                </span>
              )}
              <textarea
                id="director-notes"
                value={words}
                onChange={(e) => setWords(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                    e.preventDefault();
                    go();
                  }
                }}
                rows={1}
                className="block max-h-[var(--words-max,160px)] min-h-[48px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[15px] leading-relaxed text-paper outline-none [field-sizing:content] [scrollbar-width:thin]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 pb-0.5">
              <ModeSwitch
                modes={[...(hasPlace ? (scene.place.image?.view ? (["extend"] as const) : []) : (["environment"] as const)), ...(cast ? (["arrange"] as const) : []), "generate"]}
                value={shown}
                onChange={setMode}
              />
              {shown === "generate" ? (
                <>
                  {/* The shot model: its card says whether it's on your GPUs, and gets it when it isn't. */}
                  <ModelPicker kind="image" task="image" only={SHOT_MODELS} value={shotModel} onChange={(m) => useDirectorShot.setState({ model: m })} placement="top-start" variant="chip" chipClassName={GLASS_CHIP} surface="glass" />
                  <SizeMenu size={shotSize} choices={resolution?.choices ?? []} modelId={shotModel} />
                  <ChipButton onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt} title="See the prompt Crackio writes from the set" className={showPrompt ? "bg-white/[0.08]" : undefined}>
                    <ScrollText size={14} />
                    <span className="hidden sm:inline">Prompt</span>
                  </ChipButton>
                  {/* How long a shot takes at this size on your machine, and how it's drawn (natively, or enlarged). */}
                  <LocalTimeLine
                    modelId={shotModel}
                    count={count}
                    references={0}
                    resolution={shotSize}
                    ratio={aspectById(scene.aspect).w / aspectById(scene.aspect).h}
                    className="px-2"
                  />
                </>
              ) : shown === "arrange" ? (
                <span className="min-w-0 flex-1 basis-[150px] truncate px-2 text-[12px] text-haze">{working ? "Arranging the set from your words…" : MODES.arrange.note}</span>
              ) : (
                <>
                  {/* The place is made (and extended) with the place's model. */}
                  <ModelPicker
                    kind="image"
                    task="edit"
                    only={DIRECTOR_MODELS}
                    value={placeModelId}
                    onChange={(m) => usePlaceModel.setState({ model: m })}
                    placement="top-start"
                    variant="chip"
                    chipClassName={GLASS_CHIP}
                    surface="glass"
                  />
                  <PlaceSizeMenu modelId={placeModelId} />
                  {/* Cut short rather than dropped onto a row of its own (that made the bar taller). */}
                  <span className="min-w-0 flex-1 basis-[150px] truncate px-2 text-[12px] text-haze">
                    {working ? `${shown === "extend" ? extending.stage : "Drawing the place"}…` : `${MODES[shown].note}${eta ? `, ${eta}` : ""}`}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Home's Generate: a rounded square on the right. */}
          <button
            onClick={go}
            disabled={working}
            title={`${MODES[shown].action} (Enter)`}
            className="lip squircle flex min-h-[96px] w-[118px] shrink-0 flex-col items-center justify-center gap-1.5 self-stretch rounded-[20px] bg-spike px-4 text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip-glow:0_10px_32px_-10px_rgb(255_91_46/0.5)] [--lip:var(--color-spike-lip)] hover:bg-spike-hi hover:[--lip-glow:0_12px_38px_-10px_rgb(255_91_46/0.62)] disabled:opacity-80 sm:w-[136px]"
          >
            {working ? <LoaderCircle size={20} className="animate-spin" /> : <span className="font-display text-[21px] leading-none">{MODES[shown].action}</span>}
            <span className="flex items-center gap-1 text-[11.5px] font-bold opacity-75">
              {MODES[shown].icon} <CornerDownLeft size={11} />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

type Mode = "environment" | "extend" | "arrange" | "generate";

/** How big the place is made with its model: that model's own sizes, 4K where it offers it. */
function PlaceSizeMenu({ modelId }: { modelId: string }) {
  const resolution = useModelInfo(modelId === "auto" ? null : modelId).caps?.resolution;
  const picked = usePlaceSize((s) => s.size);
  const size = shotSizeFor(resolution, picked);
  const list = resolution?.choices?.length ? resolution.choices : [{ value: "2k", label: "2K" }, { value: "4k", label: "4K" }];
  const label = list.find((c) => String(c.value) === size)?.label ?? size.toUpperCase();
  return (
    <Popover
      placement="top-start"
      panelClassName="w-[260px]"
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label="Place size"
          title="How big the place is made: bigger is sharper and slower"
          className={cn("press flex h-9 shrink-0 items-center gap-1 rounded-chip px-3 text-[13px] font-semibold text-paper", GLASS_CHIP)}
        >
          {label}
          <ChevronDown size={13} className="text-haze" />
        </button>
      )}
    >
      {(close) => (
        <div className="p-1">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">Place size</p>
          {list.map((c) => (
            <MenuItem
              key={String(c.value)}
              selected={String(c.value) === size}
              hint={String(c.value) === "4k" ? "Sharpest, slowest" : String(c.value) === "2k" ? "Sharp" : undefined}
              onSelect={() => {
                usePlaceSize.setState({ size: String(c.value) });
                close();
              }}
            >
              {c.label}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

const MODES: Record<Mode, { label: string; action: string; placeholder: string; note: string; icon: React.ReactNode }> = {
  environment: {
    label: "The place",
    action: "Create",
    placeholder: "Where is it? A rainy neon alley at night",
    note: "Builds the place all around you",
    icon: <Mountain size={11} />,
  },
  extend: {
    label: "What's further on",
    action: "Extend",
    placeholder: "What's further on? A pub on the right",
    note: "Makes the place again from here, to walk on",
    icon: <Expand size={11} />,
  },
  arrange: {
    label: "Who does what, and how it's framed",
    action: "Arrange",
    placeholder: "Who does what? Lena rides the motorbike",
    note: "Poses your cast and frames the shot from your words",
    icon: <PersonStanding size={11} />,
  },
  generate: {
    label: "What happens in the shot",
    action: "Shoot it",
    placeholder: "What happens? Two friends run for the bus",
    note: "",
    icon: <Clapperboard size={11} />,
  },
};

/** What the bar does: make the place, extend it, or shoot. */
function ModeSwitch({ modes, value, onChange }: { modes: Mode[]; value: Mode; onChange: (m: Mode) => void }) {
  if (modes.length < 2) return null;
  return (
    <div role="radiogroup" aria-label="What the bar does" className={cn("flex h-9 rounded-chip p-0.5", GLASS_CHIP, "bg-white/[0.04]")}>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "press squircle inline-flex items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold",
            value === m ? "bg-white/[0.12] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.09),0_1px_2px_rgb(0_0_0/0.25)]" : "text-fog hover:text-paper",
          )}
        >
          {MODES[m].icon}
          {m === "environment" ? "Place" : m === "extend" ? "Extend" : m === "arrange" ? "Arrange" : "Shoot"}
        </button>
      ))}
    </div>
  );
}

const SIZE_HINTS: Record<string, string> = {
  draft: "Quickest look",
  "720p": "Fast, small",
  "1k": "Fast",
  "2k": "Best: sharp faces",
  "4k": "Biggest, slowest",
};

/** How big the shot is drawn: the chosen model's own sizes (2K by default: faces in a two-shot sharp enough to read). */
function SizeMenu({ size, choices, modelId }: { size: string; choices: { value: string | number; label: string }[]; modelId: string }) {
  const list = choices.length ? choices : [{ value: "1k", label: "1K" }, { value: "2k", label: "2K" }];
  const figures = shownFigures(useDepthFigures((s) => s.figures));
  const people = FIGURES.find((f) => f.id === figures);
  const loras = useModelLoras((s) => s.byModel[modelId]?.length ?? 0);
  const label = `${list.find((c) => String(c.value) === size)?.label ?? size.toUpperCase()}${figures !== "auto" && people && !SHOT_MODELS.includes(modelId) ? ` · ${people.short}` : ""}${loras ? ` · ${loras} LoRA${loras > 1 ? "s" : ""}` : ""}`;
  return (
    <Popover
      placement="top-start"
      panelClassName="w-[300px]"
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label="Shot size and people"
          title="How big the shot is drawn, and how the people are posed"
          className={cn("press flex h-9 shrink-0 items-center gap-1 rounded-chip px-3 text-[13px] font-semibold text-paper", GLASS_CHIP)}
        >
          {label}
          <ChevronDown size={13} className="text-haze" />
        </button>
      )}
    >
      {(close) => (
        <div className="p-1">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">Size</p>
          {list.map((c) => (
            <MenuItem
              key={String(c.value)}
              selected={String(c.value) === size}
              hint={SIZE_HINTS[String(c.value)]}
              onSelect={() => {
                useShotSize.setState({ size: String(c.value) });
                close();
              }}
            >
              {c.label}
            </MenuItem>
          ))}
          {SHOT_MODELS.includes(modelId) ? null : <FiguresChoice close={close} />}
          <LoraChoice modelId={modelId} />
        </div>
      )}
    </Popover>
  );
}

/**
 * The LoRAs on the shot's model: those of its LoRAs your ComfyUIs have (api/local/loras), named as the LoRA library names
 * them, each on or off and how strong. A LoRA is made for one model, so the list is the model's own (lib/hooks/
 * use-model-loras, shared with the model picker's LoRA page, where more are downloaded); files the library can't place on
 * this model are left out (video LoRAs on an image model), unless they're already on.
 */
function LoraChoice({ modelId }: { modelId: string }) {
  const [files, setFiles] = useState<{ file: string; machines: string[] }[] | null>(null);
  const picks = useModelLoras((s) => s.byModel[modelId]);
  const library = useLoraLibrary((s) => s.library);
  useEffect(() => {
    loadLoraLibrary();
    let live = true;
    void fetch("/api/local/loras")
      .then((r) => r.json())
      .then((d: { files?: { file: string; machines: string[] }[] }) => live && setFiles(d.files ?? []))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, []);
  // The library's id for the model: "local:tpl:qwen-image-2.1" is "tpl-qwen-image-2.1", "local:flux3-klein" "flux3-klein".
  // The Director model is Z-Image Turbo underneath: its LoRAs are Z-Image Turbo’s.
  const libraryId = modelId === "local:z-image-director" ? "z-image-turbo" : modelId === "local:qwen-director" ? "tpl-qwen-image-2.1" : modelId.replace(/^local:/, "").replace(/^tpl:/, "tpl-");
  // Each file's LoRA: its name and the strength it's made for (switched on at that).
  const named = new Map<string, { name: string; strength: number }>();
  for (const e of library?.entries ?? []) if (e.models.includes(libraryId)) for (const f of entryFiles(e)) named.set(f, { name: e.name, strength: e.strength ?? 1 });
  for (const r of Object.values(library?.records ?? {})) if (r.models.includes(libraryId)) named.set(r.file, { name: r.name, strength: r.strength ?? 1 });
  const fits = (files ?? []).filter(({ file }) => named.has(file) || picks?.some((p) => p.file === file));
  if (modelId === "auto") return null;
  return (
    <div className="mt-1 border-t border-white/[0.06] pt-1">
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">LoRAs</p>
      {files === null ? (
        <p className="px-2.5 pb-2 text-[12px] text-haze">Looking on your ComfyUI…</p>
      ) : fits.length === 0 ? (
        <p className="px-2.5 pb-2 text-[12px] leading-snug text-haze">None for this model yet: get them from the model picker&rsquo;s LoRAs.</p>
      ) : (
        <div className="scroll-thin max-h-[180px] overflow-y-auto pb-1">
          {fits.map(({ file, machines }) => {
            const pick = picks?.find((p) => p.file === file);
            return (
              <div key={file} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-white/[0.04]">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(pick)}
                  onClick={() => setLora(modelId, file, pick ? null : (named.get(file)?.strength ?? 1))}
                  title={`${file} · on ${machines.join(", ")}`}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12.5px]"
                >
                  <span className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border", pick ? "border-spike bg-spike text-spike-ink" : "border-line-strong")}>
                    {pick ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  <span className="truncate">{named.get(file)?.name ?? file.replace(/\.safetensors$/, "")}</span>
                </button>
                {pick ? (
                  <span className="flex shrink-0 items-center gap-1 text-[12px]">
                    <button type="button" aria-label="Weaker" onClick={() => setLora(modelId, file, Math.max(0.1, Math.round((pick.strength - 0.1) * 10) / 10))} className="press grid size-5 place-items-center rounded-md text-haze hover:bg-white/[0.08] hover:text-paper">
                      −
                    </button>
                    <span className="tabular w-7 text-center text-paper">{pick.strength.toFixed(1)}</span>
                    <button type="button" aria-label="Stronger" onClick={() => setLora(modelId, file, Math.min(1.5, Math.round((pick.strength + 0.1) * 10) / 10))} className="press grid size-5 place-items-center rounded-md text-haze hover:bg-white/[0.08] hover:text-paper">
                      +
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** How the people are posed: what reaches the model's depth of them (server/director-fresh), in plain words. */
const FIGURES: { id: DepthFigures; label: string; short: string; when: string }[] = [
  {
    id: "auto",
    label: "Auto",
    short: "auto",
    when: "Each person by their action: sitting, walking, kneeling or lying follow their stand-in; standing people act freely.",
  },
  { id: "none", label: "Natural", short: "natural", when: "The model poses everyone from your words. The most natural acting; people may shift a little from their marks." },
  { id: "stand-ins", label: "Copy the stand-ins", short: "stand-ins", when: "Everyone follows their stand-in's pose. Standing people can look stiff." },
];

/**
 * "On their marks" is gone from the menu (it came out worst every time: the user), and so is anything a browser kept from
 * older menus (the stick figures): a choice of either counts as Auto.
 */
const shownFigures = (f: DepthFigures): DepthFigures => (f !== "soft" && FIGURES.some((x) => x.id === f) ? f : "auto");

function FiguresChoice({ close }: { close: () => void }) {
  const figures = shownFigures(useDepthFigures((s) => s.figures));
  return (
    <div className="mt-1 border-t border-white/[0.06] pt-1">
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">People</p>
      {FIGURES.map((f) => {
        const selected = figures === f.id;
        return (
          <button
            key={f.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => {
              useDepthFigures.setState({ figures: f.id });
              close();
            }}
            className={cn(
              "squircle flex w-full items-start gap-2.5 rounded-[14px] px-2.5 py-2 text-left transition-colors duration-150",
              selected ? "bg-gaffer text-paper" : "text-fog hover:bg-gaffer/60 hover:text-paper active:bg-gaffer",
            )}
          >
            <span className={cn("mt-[5px] size-2 shrink-0 rounded-full", selected ? "bg-paper" : "bg-white/20")} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                {f.label}
                {f.id === "auto" ? <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10.5px] font-medium text-haze">Default</span> : null}
              </span>
              <span className="mt-0.5 block text-[12px] leading-snug text-haze">{f.when}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
