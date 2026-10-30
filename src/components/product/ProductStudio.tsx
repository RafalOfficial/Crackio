"use client";

import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { Clapperboard, Image as ImageIcon, LoaderCircle, Minus, Plus, Type } from "lucide-react";
import { toolBySlug } from "@/lib/tools";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { resolveAuto, resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { isCustomModel, useModelInfo } from "@/lib/hooks/use-custom-models";
import { imageSlots } from "@/lib/models/caps";
import { ToolTile } from "@/components/ui/ToolTile";
import { Panel, PanelHeader, Switch } from "@/components/ui/Panel";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine, usePricing } from "@/components/models/CostLine";
import { QualityPicker, hasQualityChoices, useOutputQuality } from "@/components/models/QualityPicker";
import { useMentions } from "@/components/cast/Mentions";
import { OptionGrid } from "./OptionGrid";
import { ProductSlot, type ProductPhoto, type ReadState } from "./ProductSlot";
import { ProductOutput } from "./ProductOutput";
import {
  CAMERAS,
  FINISHES,
  FORMATS,
  LIGHTS,
  MOMENTS,
  PEOPLE_MOMENTS,
  SCENES,
  WHO,
  studioSummary,
  type CameraId,
  type FinishId,
  type FormatId,
  type LightId,
  type MomentId,
  type SceneId,
  type StudioSpec,
} from "@/lib/product/vocab";
import { contextFor, previewSamples, previewSrc, sampleFor, tileSample, type PreviewAxis, type PreviewContext, type SampleId } from "@/lib/product/previews";
import { Step } from "./Step";
import { WhoPicker, type WhoChoice } from "./WhoPicker";
import { FilmMode } from "./film/FilmMode";
import type { FilmPicture } from "./film/PicturePicker";
import { useCast } from "@/lib/hooks/use-cast";
import { previewUrl } from "@/lib/media-url";
import type { Character, Someone } from "@/lib/cast/types";
import { aspectById } from "@/lib/shot";
import { cn } from "@/lib/cn";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

/** "Your shot", one step at a time. Who only shows for shots with people in them. */
type StepId = "moment" | "who" | "scene" | "camera" | "light" | "finish";
const STEP_ORDER: StepId[] = ["moment", "who", "scene", "camera", "light", "finish"];
const stepsFor = (moment: MomentId) => STEP_ORDER.filter((s) => s !== "who" || PEOPLE_MOMENTS.includes(moment));

/** Models that keep a label's every letter, first (after your saved default). */
const PREFER = ["comfy:openai/gpt-image-2.5-flare", "comfy:vertexai/gemini-nano-banana-2.1", "local:flux3-klein", "local:flux2-klein-4b"];

/** Ideas for the direction box, by what the product is. */
const PLACEHOLDERS: [RegExp, string[]][] = [
  [/^drink$/, ["Cap off, cold drops on the bottle, just after a sip on a run…", "Poured over ice in a tall glass, lime on the rim…", "Shared on a picnic blanket with friends, late afternoon…"]],
  [/food|kitchenware/, ["Broken in half so the inside shows, crumbs on the board…", "Fresh out of the oven on a cooling rack, warm steam…", "On a café table next to a flat white, morning light…"]],
  [/supplement|health/, ["One capsule in her palm, a glass of water, morning light…", "On the breakfast table beside berries and coffee…", "Next to a yoga mat after a morning stretch…"]],
  [/skincare|makeup|haircare|fragrance|cleaning/, ["A drop on her fingertip, fresh-faced, bathroom mirror…", "On wet stone with water droplets, spa calm…", "In her bag next to sunglasses and keys…"]],
  [/apparel|footwear|bag|accessory|jewelry|eyewear|watch/, ["Worn with wide jeans, walking past a café, wind in the fabric…", "Laid out on a wooden chair by the window…", "On a rail in a small boutique, morning light…"]],
  [/electronics|tool|vehicle/, ["On the desk next to a laptop, screen glowing, late night…", "In use on a train, the city sliding past…", "Charging on the nightstand, soft lamp light…"]],
  [/home|furniture|stationery|book/, ["In a sunlit living room with a stack of books and a plant…", "On a bedside table, evening, warm lamp light…", "Being unboxed on a wooden floor, morning light…"]],
  [/pet/, ["A golden retriever sitting politely, waiting for one…", "On the kitchen floor next to a full water bowl…", "In a park, a puppy mid-jump toward it…"]],
  [/toy|baby/, ["On a soft rug in a bright nursery, a parent's hands nearby…", "Mid-play on a wooden floor, warm afternoon light…", "Wrapped as a gift with kraft paper and twine…"]],
];
const GENERIC = ["Our brand color is deep green: keep the set close to it…", "Make it feel premium and quiet, lots of space…", "Shot for a summer launch: bright, warm and fresh…"];

function loadSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1024, height: 1024 });
    img.src = url;
  });
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

/** A small rectangle at a ratio, so a shape reads before its numbers. */
function RatioGlyph({ ratio, max = 16 }: { ratio: number; max?: number }) {
  const w = ratio >= 1 ? max : Math.round(max * ratio);
  const h = ratio >= 1 ? Math.round(max / ratio) : max;
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: max + 2, height: max + 2 }} aria-hidden>
      <span className="rounded-[2px] border-[1.5px] border-current opacity-80" style={{ width: Math.max(4, w), height: Math.max(4, h) }} />
    </span>
  );
}

/**
 * Product Studio: a photo of your product in, ads you can post out. Crackio reads the product
 * (what it is, how it's used, where it belongs), then every pick (the shot, the scene, the
 * camera, the light, the finish) becomes the version of that shot that makes sense for it.
 */
function ImageMode({ hidden, onFilm, shootFor }: { hidden: boolean; onFilm: (p: FilmPicture) => void; shootFor: number }) {
  const submit = useGenerations((s) => s.submit);
  const { models, defaults, loaded: modelsLoaded } = useModels();
  const [model, setModel] = useModelChoice("image", "edit");
  const [photos, setPhotos] = useState<ProductPhoto[]>([]);
  const [readResult, setReadResult] = useState<ReadState | null>(null);
  const [identityFor, setIdentityFor] = useState<{ url: string; text: string } | null>(null);
  const [moment, setMoment] = useState<MomentId>("auto");
  const [scene, setScene] = useState<SceneId>("auto");
  const [camera, setCamera] = useState<CameraId>("auto");
  const [light, setLight] = useState<LightId>("auto");
  const [finish, setFinish] = useState<FinishId>("auto");
  const [who, setWho] = useState<WhoChoice>("auto");
  const [castId, setCastId] = useState<string | null>(null);
  const [whoText, setWhoText] = useState("");
  const cast = useCast();
  const [format, setFormat] = useState<FormatId>("4:5");
  const [copySpace, setCopySpace] = useState(false);
  const [headline, setHeadline] = useState("");
  const [check, setCheck] = useState(true);
  const [notes, setNotes] = useState("");
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ axis: PreviewAxis; id: string }>({ axis: "scene", id: "beach" });
  const [openStep, setOpenStep] = useState<StepId | null>(null);
  const [done, setDone] = useState<StepId[]>([]);
  const stepRefs = useRef<Partial<Record<StepId, HTMLElement | null>>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const [placeholder, setPlaceholder] = useState(0);
  const notesField = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ textarea: notesField, value: notes, onChange: setNotes });

  // A picture sent from another page ("Product Studio" on a take) becomes the product.
  useEffect(() => {
    const ref = useHandoff.getState().take()?.references[0];
    if (!ref) return;
    void loadSize(ref.url).then((s) => setPhotos([{ url: ref.url, name: ref.name, ...s }]));
  }, []);

  // Crackio reads the product as soon as it's in: the reading shows here and steers every shot.
  const readKey = photos.map((p) => p.url).join("|");
  useEffect(() => {
    if (!readKey) return;
    const ctrl = new AbortController();
    fetch("/api/product/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: readKey.split("|") }), signal: ctrl.signal })
      .then(async (res) => {
        const data = (await res.json()) as { read?: ReadState["read"]; error?: string };
        setReadResult(res.ok && data.read ? { key: readKey, status: "done", read: data.read } : { key: readKey, status: "failed", error: data.error });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setReadResult({ key: readKey, status: "failed", error: "Couldn't reach Crackio." });
      });
    return () => ctrl.abort();
  }, [readKey]);
  const read: ReadState | null = !readKey ? null : readResult?.key === readKey ? readResult : { key: readKey, status: "reading" };
  const identity = identityFor && identityFor.url === photos[0]?.url ? identityFor.text : null;
  const category = read?.read?.category;
  // The previews show the sample closest to your product.
  const mine = photos[0]?.sample ?? sampleFor(category);

  const ideas = PLACEHOLDERS.find(([re]) => category && re.test(category))?.[1] ?? GENERIC;
  useEffect(() => {
    if (notes) return;
    const t = setInterval(() => setPlaceholder((p) => p + 1), 4200);
    return () => clearInterval(t);
  }, [notes]);

  // The model that will run: your pick, or what Auto resolves to (one that can see your product).
  const autoId = model === "auto" ? resolveAutoId("image", models, defaults, PREFER) : null;
  const autoInfo = useModelInfo(autoId && isCustomModel(autoId) ? autoId : null);
  const autoUnfit = Boolean(autoId && isCustomModel(autoId) && autoInfo.caps && imageSlots(autoInfo.caps) === 0);
  const effectiveId = model === "auto" ? (autoUnfit ? (resolveAuto("image", models, defaults, PREFER)?.id ?? null) : autoId) : model;
  const info = useModelInfo(effectiveId);
  const quality = useOutputQuality(info.caps);
  const pricing = usePricing(effectiveId);
  const noModel = modelsLoaded && !effectiveId && !isCustomModel(model);

  const a = aspectById(format);
  const ratio = a.w / a.h;
  const steps = stepsFor(moment);

  // "Shoot one" in Video mode: a creator holding the product, in Story format, ready to film.
  const [shootSeen, setShootSeen] = useState(shootFor);
  if (shootFor !== shootSeen) {
    setShootSeen(shootFor);
    setMoment("creator");
    setFormat("9:16");
    setFocus({ axis: "moment", id: "creator" });
    setDone((d) => (d.includes("moment") ? d : [...d, "moment"]));
    setOpenStep(photos.length ? "who" : null);
  }

  // Adding a product starts the walk through "Your shot" at its first step.
  const hasProduct = photos.length > 0;
  const [hadProduct, setHadProduct] = useState(hasProduct);
  if (hasProduct !== hadProduct) {
    setHadProduct(hasProduct);
    if (hasProduct && !done.length) setOpenStep("moment");
  }

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  /** A step's pick lands: it closes, and the next one you haven't been through opens and comes into view. */
  function advance(from: StepId, momentNow: MomentId = moment) {
    const list = stepsFor(momentNow);
    const nextDone = done.includes(from) ? done : [...done, from];
    setDone(nextDone);
    const next = list.slice(list.indexOf(from) + 1).find((s) => !nextDone.includes(s)) ?? list.find((s) => !nextDone.includes(s)) ?? null;
    later(() => {
      setOpenStep(next);
      if (next) later(() => stepRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" }), 360);
    }, 200);
  }

  /** Picking something also shows it on the right, played out on several products, until the first take. */
  const choose =
    <T extends string>(axis: PreviewAxis, set: Dispatch<SetStateAction<T>>) =>
    (id: T) => {
      set(id);
      setFocus({ axis, id });
      advance(axis, axis === "moment" ? (id as MomentId) : moment);
    };

  function toggleStep(step: StepId) {
    setOpenStep((o) => (o === step ? null : step));
    if (step !== "who") setFocus({ axis: step, id: { moment, scene, camera, light, finish }[step] });
  }

  // The previews follow the shot: the product on its own, or someone using it.
  const ctx = (axis: PreviewAxis): PreviewContext => contextFor(axis, moment);
  const momentLabel = MOMENTS.find((m) => m.id === moment)!.label;
  const note = (axis: PreviewAxis) => {
    const c = ctx(axis);
    if (c === "person") return `Shown with someone using the product, like your ${momentLabel === "Best fit" ? "shot" : `“${momentLabel}” shot`}.`;
    if (c === "alone") return `Shown with the product on its own, like your ${momentLabel === "Best fit" ? "shot" : `“${momentLabel}” shot`}.`;
    return axis === "scene" ? "Shown the way Crackio fits each product to the place." : null;
  };
  /** The small picture on a closed step: the pick, on the product most like yours. */
  const thumbOf = (axis: PreviewAxis, id: string): string | null => {
    const c = ctx(axis);
    const sample = tileSample(previewSamples(axis, id, c), mine as SampleId | null, 0);
    return sample ? previewSrc(axis, id, sample, true, c) : null;
  };
  const chosen = { moment: MOMENTS.find((m) => m.id === moment)!, scene: SCENES.find((x) => x.id === scene)!, camera: CAMERAS.find((x) => x.id === camera)!, light: LIGHTS.find((x) => x.id === light)!, finish: FINISHES.find((x) => x.id === finish)! };
  const allDone = steps.every((st) => done.includes(st));

  async function shoot() {
    if (!photos.length || busy) return;
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") return void askForModel("image");
    setBusy(true);
    setError(null);
    try {
      const withPeople = PEOPLE_MOMENTS.includes(moment);
      const castChar = who === "cast" && withPeople ? (cast.items.find((c): c is Someone => c.id === castId && Boolean(c.portrait) && c.kind !== "object") ?? null) : null;
      const noun = castChar ? ({ person: "person", pet: "animal", character: "character" } as const)[castChar.kind] : "";
      // Face and full body while there's room beside the product photos (models take about five pictures).
      const castRefs = castChar
        ? [castChar.portrait, castChar.sheet]
            .filter((u): u is string => Boolean(u))
            .slice(0, photos.length >= 3 ? 1 : 2)
            .map((url) => ({ url, label: `${castChar.name}, the ${noun} to keep consistent`, role: "subject" as const }))
        : [];
      const whoNow: StudioSpec["who"] = castChar ? "cast" : who === "custom" && whoText.trim() ? "custom" : who === "cast" || who === "custom" ? "auto" : who;
      const spec: StudioSpec = {
        version: 2,
        moment,
        scene,
        camera,
        light,
        finish,
        who: whoNow,
        ...(castChar ? { cast: { id: castChar.id, name: castChar.name, kind: castChar.kind, traits: castChar.traits } } : {}),
        ...(whoNow === "custom" ? { whoText: whoText.trim() } : {}),
        copySpace,
        headline: copySpace && headline.trim() ? headline.trim() : undefined,
        check,
        noted: Boolean(notes.trim()),
        identity: identity ?? undefined,
        read: read?.status === "done" ? read.read : null,
        productImages: photos.length,
      };
      await submit({
        tool: "product",
        prompt: notes.trim() || `${studioSummary(spec, read?.read?.kind)}${castChar ? ` · ${castChar.name}` : ""}`,
        aspect: format,
        count,
        // Auto is sent as the model it resolved to here (this tool's favorites are unknown to the server).
        model: model === "auto" ? (effectiveId ?? "auto") : model,
        refine: false,
        references: [...photos.map((p, i) => ({ url: p.url, label: i === 0 ? "the product" : "the same product from another angle", role: "product" as const })), ...castRefs],
        params: { kind: "image", sourceUrl: photos[0].url, studio: spec, options: { ...quality.options } },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canShoot = photos.length > 0 && !busy && !noModel && !(isCustomModel(effectiveId) && info.loading);

  return (
    <div className={cn("grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]", hidden && "hidden")}>
        <Panel className="flex flex-col">
          <PanelHeader title="Shoot" />
          <div className="space-y-6 p-3.5">
            <ModelPicker kind="image" task="edit" value={model} onChange={setModel} prefer={PREFER} />
            {noModel ? (
              <p className="rounded-[12px] bg-tungsten/10 px-3.5 py-3 text-[13px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
                Product Studio needs a picture model that works from your photo. Install a free one on your GPU in{" "}
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

            <Section title="Product" hint={photos.length ? `${photos.length} of 3 angles` : "Your photo, any background"}>
              <ProductSlot
                photos={photos}
                onPhotos={(next) => {
                  setPhotos(next);
                  setError(null);
                }}
                read={read}
                identity={identity}
                onIdentity={(text) => setIdentityFor(text && photos[0] ? { url: photos[0].url, text } : null)}
                onError={setError}
              />
            </Section>

            <Section title="Your shot" hint={allDone ? "All set · tap any step to change it" : `${steps.filter((st) => done.includes(st)).length} of ${steps.length} · Best fit lets Crackio decide`}>
              <div className="space-y-1.5">
                {steps.map((st, i) => {
                  const common = {
                    stepRef: (el: HTMLElement | null) => void (stepRefs.current[st] = el),
                    index: i + 1,
                    open: openStep === st,
                    done: done.includes(st),
                    onToggle: () => toggleStep(st),
                  };
                  if (st === "who") {
                    const castChar = who === "cast" ? cast.items.find((c) => c.id === castId) : undefined;
                    const value = castChar ? castChar.name : who === "custom" ? (whoText.trim().length > 26 ? `${whoText.trim().slice(0, 26)}…` : whoText.trim() || "Your description") : (WHO.find((x) => x.id === who)?.label ?? "Best fit");
                    return (
                      <Step
                        key={st}
                        {...common}
                        title="Who"
                        value={value}
                        thumb={castChar?.portrait ? previewUrl(castChar.portrait, 160) : null}
                        auto={who === "auto"}
                        note="A quick pick, someone from your Cast (the same face in every ad), or describe them."
                      >
                        <WhoPicker
                          who={who}
                          castId={castId}
                          text={whoText}
                          onQuick={(id) => {
                            setWho(id);
                            advance("who");
                          }}
                          onCast={(c: Character) => {
                            setWho("cast");
                            setCastId(c.id);
                            advance("who");
                          }}
                          onDescribe={(text) => {
                            setWho("custom");
                            setWhoText(text);
                            advance("who");
                          }}
                        />
                      </Step>
                    );
                  }
                  const axis = st;
                  const option = chosen[axis];
                  const title = { moment: "Shot", scene: "Scene", camera: "Camera", light: "Light", finish: "Finish" }[axis];
                  return (
                    <Step key={st} {...common} title={title} value={option.label} thumb={thumbOf(axis, option.id)} auto={option.id === "auto"} note={axis === "moment" ? "How the product is shown. Hover any option to see it on different products." : note(axis)}>
                      {axis === "moment" ? <OptionGrid axis="moment" options={MOMENTS} value={moment} onChange={choose("moment", setMoment)} sample={mine} /> : null}
                      {axis === "scene" ? <OptionGrid axis="scene" options={SCENES} value={scene} onChange={choose("scene", setScene)} sample={mine} ctx={ctx("scene")} /> : null}
                      {axis === "camera" ? <OptionGrid axis="camera" options={CAMERAS} value={camera} onChange={choose("camera", setCamera)} sample={mine} ctx={ctx("camera")} /> : null}
                      {axis === "light" ? <OptionGrid axis="light" options={LIGHTS} value={light} onChange={choose("light", setLight)} sample={mine} ctx={ctx("light")} /> : null}
                      {axis === "finish" ? <OptionGrid axis="finish" options={FINISHES} value={finish} onChange={choose("finish", setFinish)} sample={mine} ctx={ctx("finish")} /> : null}
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
                placeholder={ideas[placeholder % ideas.length]}
                className="w-full resize-none rounded-[14px] bg-white/[0.03] px-3.5 py-3 text-[14px] leading-relaxed outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
              />
              {mentions.menu}
            </Section>

            <Section title="Format" hint={FORMATS.find((f) => f.id === format)?.caption}>
              <div role="radiogroup" className="grid grid-cols-5 gap-1.5">
                {FORMATS.map((f) => {
                  const active = format === f.id;
                  const r = aspectById(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={f.caption}
                      onClick={() => setFormat(f.id)}
                      className={cn(
                        "press relative flex h-[60px] flex-col items-center justify-center gap-1 rounded-[12px] text-[11.5px] font-semibold transition-colors",
                        active ? "text-[#16131b]" : "bg-white/[0.04] text-fog hover:bg-white/[0.08] hover:text-paper",
                      )}
                    >
                      {active ? <motion.span layoutId="format-pill" className="absolute inset-0 rounded-[12px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
                      <span className="relative">
                        <RatioGlyph ratio={r.w / r.h} />
                      </span>
                      <span className="relative leading-none">{f.label}</span>
                      <span className={cn("relative text-[10px] leading-none", active ? "text-[#16131b]/60" : "text-haze")}>{f.id}</span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <div className="rounded-[14px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              <button
                type="button"
                onClick={() => setCopySpace((v) => !v)}
                className="press flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left hover:bg-white/[0.03]"
                aria-pressed={copySpace}
              >
                <span className={cn("grid size-8 place-items-center rounded-full", copySpace ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-haze")}>
                  <Type size={15} />
                </span>
                <span className="flex-1">
                  <span className="block text-[13.5px] font-semibold">Room for a headline</span>
                  <span className="block text-[12px] text-haze">
                    {!copySpace ? "The shot fills the whole frame" : headline.trim() ? "Your headline is set in a calm part of the frame" : "A calm third of the frame stays empty for your text"}
                  </span>
                </span>
                <span className={cn("relative h-5 w-9 rounded-full transition-colors", copySpace ? "bg-spike" : "bg-gaffer")}>
                  <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", copySpace ? "left-[18px]" : "left-0.5")} />
                </span>
              </button>
              {copySpace ? (
                <div className="px-3.5 pb-3">
                  <input
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value.slice(0, 80))}
                    placeholder="Headline on the picture (optional), e.g. Taste the crunch"
                    className="h-10 w-full rounded-[11px] bg-white/[0.03] px-3 text-[13.5px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
                  />
                </div>
              ) : null}
            </div>

            {hasQualityChoices(quality) ? (
              <Section title="Output">
                <QualityPicker q={quality} layout="stack" pricing={pricing} input={{ output: "image", count: 1, ratio }} />
              </Section>
            ) : null}
          </div>

          {/* Sticks to the bottom of the window while you scroll the picks, so Shoot is always in reach. */}
          <div className="sticky bottom-0 z-10 mt-auto space-y-2 rounded-b-panel border-t border-line bg-flat/90 p-3 backdrop-blur-xl">
            {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
            <div className="flex min-h-5 items-center justify-between gap-3">
              {photos.length ? (
                <CostLine
                  className="min-w-0"
                  modelId={effectiveId}
                  noun={count > 1 ? `these ${count} takes` : "this take"}
                  input={{ output: "image", count, ratio, ...quality.cost }}
                  quote={{ output: "image", aspect: format, count, images: photos.length, resolution: quality.resolution, quality: quality.quality }}
                />
              ) : (
                <span />
              )}
              <span className="ml-auto shrink-0">
              <Switch
                checked={check}
                onChange={setCheck}
                label={<span className="text-[12px]">Check each take</span>}
                title="Crackio compares every take with your product photo (label, shape, hands, placement) and re-shoots it once if something's off."
              />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="squircle flex h-12 items-center rounded-[16px] bg-white/[0.05]" title="Each take is a different idea">
                <button
                  onClick={() => setCount((c) => Math.max(1, c - 1))}
                  disabled={count <= 1}
                  className="press grid size-10 place-items-center text-fog hover:text-paper disabled:opacity-30"
                  aria-label="Fewer takes"
                >
                  <Minus size={13} />
                </button>
                <span className="tabular w-6 text-center text-[13px] font-semibold">×{count}</span>
                <button
                  onClick={() => setCount((c) => Math.min(4, c + 1))}
                  disabled={count >= 4}
                  className="press grid size-10 place-items-center text-fog hover:text-paper disabled:opacity-30"
                  aria-label="More takes"
                >
                  <Plus size={13} />
                </button>
              </div>
              <button
                onClick={() => void shoot()}
                disabled={!canShoot}
                className="lip squircle flex h-12 flex-1 items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
              >
                {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
                {!photos.length ? "Add your product" : count > 1 ? `Shoot ${count} ideas` : "Shoot"}
              </button>
            </div>
          </div>
        </Panel>

        <ProductOutput focus={{ ...focus, ctx: contextFor(focus.axis, moment) }} mine={mine} onFilm={onFilm} />
    </div>
  );
}

type Mode = "image" | "video";

/**
 * Product Studio: a photo of your product in, ads you can post out. Image mode shoots the pictures;
 * Video mode turns any of them into a video ad (a creator talking about it, a living photo, a hero
 * shot, a hands-on demo, a campaign edit). Both stay open, so switching never loses your picks.
 */
export function ProductStudio() {
  const tool = toolBySlug("product")!;
  // The mode lives in the address (?mode=video), so a reload, a shared link or Back opens the same one.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const mode: Mode = params.get("mode") === "video" ? "video" : "image";
  const [incoming, setIncoming] = useState<FilmPicture | null>(null);
  // "Shoot one" from Video mode: Image mode opens on a creator shot in Story format.
  const [shootFor, setShootFor] = useState(0);

  function switchTo(next: Mode) {
    const q = new URLSearchParams(params.toString());
    if (next === "video") q.set("mode", "video");
    else q.delete("mode");
    router.replace(q.size ? `${pathname}?${q}` : pathname, { scroll: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-4">
        <ToolTile icon={tool.icon} glyph={tool.glyph} hue={tool.hue} size={36} className="mt-1" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[30px] sm:text-[34px]">{tool.name}</h1>
          <p className="mt-1 max-w-[72ch] text-[15px] leading-relaxed text-haze">
            {mode === "image"
              ? "Any product, from cookies to sneakers to skincare. Crackio works out what it is and how people use it, then fits every scene, shot and angle to it, label and colors kept true. Hover any option to see it."
              : "Turn any picture into an ad that passes as real: a creator talking about it, a living photo, a hero shot, hands-on, or a campaign edit. Crackio writes what's said, films, watches every frame and re-films what a client would reject."}
          </p>
        </div>
        <ModeSwitch mode={mode} onChange={switchTo} />
      </header>

      <div className="mt-7">
        <ImageMode
          hidden={mode !== "image"}
          shootFor={shootFor}
          onFilm={(p) => {
            setIncoming(p);
            switchTo("video");
          }}
        />
        {mode === "video" || incoming ? (
          <div className={cn(mode !== "video" && "hidden")}>
            <FilmMode
              incoming={incoming}
              onShoot={() => {
                setShootFor((n) => n + 1);
                switchTo("image");
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Image or Video: the same studio, two kinds of ad. */
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: { id: Mode; label: string; icon: ReactNode }[] = [
    { id: "image", label: "Image", icon: <ImageIcon size={15} /> },
    { id: "video", label: "Video", icon: <Clapperboard size={15} /> },
  ];
  return (
    <div role="tablist" aria-label="What to make" className="flex shrink-0 rounded-full bg-white/[0.05] p-1 shadow-[inset_0_0_0_1px_var(--color-line)] sm:mt-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={mode === o.id}
          onClick={() => onChange(o.id)}
          className={cn("relative flex h-10 items-center gap-2 rounded-full px-5 text-[13.5px] font-bold transition-colors", mode === o.id ? "text-[#16131b]" : "text-fog hover:text-paper")}
        >
          {mode === o.id ? <motion.span layoutId="studio-mode" className="absolute inset-0 rounded-full bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.38 }} /> : null}
          <span className="relative">{o.icon}</span>
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
