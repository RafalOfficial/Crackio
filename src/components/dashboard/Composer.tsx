"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Check, Clapperboard, CornerDownLeft, FlagTriangleRight, ImagePlus, Images, LoaderCircle, Minus, Play, Plus, Sparkles } from "lucide-react";
import { RecDot } from "@/components/ui/Viewfinder";
import { ScrollRow } from "@/components/ui/ScrollRow";
import { ModelPicker } from "@/components/models/ModelPicker";
import { useOutputQuality } from "@/components/models/QualityPicker";
import { usePricing } from "@/components/models/CostLine";
import { FrameMaker, PicturePicker, type MakerPicture, type PickedPicture, type PickerRole } from "@/components/media/PicturePicker";
import { isLive, useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import type { Generation } from "@/lib/generations/types";
import { previewUrl } from "@/lib/media-url";
import { referenceName, sayPictures } from "@/lib/prompt-pictures";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { useComposerBridge } from "@/lib/hooks/use-composer-bridge";
import { useUploads, type LocalRef } from "@/lib/hooks/use-uploads";
import { resolveAuto, resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { fitDuration, imageSlots, type Caps } from "@/lib/models/caps";
import { ASPECTS, aspectById, type AspectId } from "@/lib/shot";
import { cn } from "@/lib/cn";
import { HeroBackdrop, HeroCaption, useHeroBackdrops } from "./HeroBackdrop";
import { ChipButton, FormatChip, FramesButton, GLASS_CHIP, LengthChip, shotFor, type FrameRole } from "./ComposerControls";
import { DropZones, ShotStrip, type Making, type ShotRole, type ShotTile } from "./ShotStrip";
import { useMentions } from "@/components/cast/Mentions";
import { CastFrameControl, castFrameParams, drawsFirst, namesOf, useCastFrame } from "@/components/media/CastFrame";
import { Popover } from "@/components/ui/Popover";
import { useCast } from "@/lib/hooks/use-cast";
import { castFits, framePrefer, mentionedHandles } from "@/lib/cast/types";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

const PLACEHOLDERS = [
  "A woman in a red coat on a rainy street at night, shot from low, neon behind her…",
  "Une tasse de café sur une table en marbre, lumière du matin, vue de dessus…",
  "Mi perro corriendo en la playa al atardecer, cámara a ras del suelo…",
  "Product shot of my sneaker floating over wet asphalt, hard rim light…",
];

type Mode = "image" | "video";

/**
 * The dashboard's hero: one line of words (any language), optional reference photos, and Generate.
 * Results land in Recent just below; the full Image tool and Director are one click away.
 */
export function Composer() {
  const router = useRouter();
  // Just the action and the count of takes rendering, so progress ticks don't redraw the hero.
  const submit = useGenerations((s) => s.submit);
  const live = useGenerations((s) => s.items.filter(isLive).length);
  const { models, defaults, loaded: modelsLoaded } = useModels();
  const { refs, add, addRemote, move, remove, uploading } = useUploads();
  const sendHandoff = useHandoff((s) => s.send);

  const [mode, setMode] = useState<Mode>("image");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<AspectId>("3:2");
  const [count, setCount] = useState(1);
  // Your pick for each mode (hooks/use-model-choice): Crackio never chooses one for you.
  const [model, setModel] = useModelChoice(mode);
  const [refine, setRefine] = useState(true);
  const [duration, setDuration] = useState<number | "auto">(6);
  const [sound, setSound] = useState(true);
  /** What each picture is for in a clip. Pictures without a role are references, and the first of them the start frame. */
  const [roles, setRoles] = useState<Record<string, FrameRole>>({});
  /** The start frame a shape was picked for: until then, a clip keeps its start frame's own shape. */
  const [shapeFor, setShapeFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "hint"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [placeholder, setPlaceholder] = useState(0);
  /** Start and end frames being made on the spot: the generation making each. */
  const [making, setMaking] = useState<Partial<Record<"start" | "end", string>>>({});
  const startJob = useJob(making.start);
  const endJob = useJob(making.end);
  const landed = useRef(new Set<string>());

  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useHeroBackdrops();

  const writer = resolveAuto("text", models, defaults);
  const noModel = modelsLoaded && !models.some((m) => m.kind === mode && m.available);

  // What the model that will run accepts; every setting below is built from it.
  const effectiveId = model === "auto" ? resolveAutoId(mode, models, defaults) : model;
  const info = useModelInfo(effectiveId);
  const caps = info.caps;
  const who = info.name ?? "This model";
  // The resolution, quality or size it renders at; images and clips keep their own picks.
  const imageQuality = useOutputQuality(mode === "image" ? caps : null);
  const videoQuality = useOutputQuality(mode === "video" ? caps : null);
  const pricing = usePricing(effectiveId);

  // A clip: its pictures' roles, length, sound and shape.
  const video = mode === "video" ? videoInputs(caps, refs, roles) : null;
  const durationValue: number | "auto" | null = caps?.duration ? fitDuration(caps.duration, duration) : !caps ? duration : null;
  const soundOk = !caps || Boolean(caps.audio);
  const startRatio = video?.start?.width && video.start.height ? video.start.width / video.start.height : null;
  const following = Boolean(video?.start) && shapeFor !== video?.start?.id;
  const shot = aspectById(aspect);
  const cropping = Boolean(video?.start && !following && startRatio && Math.abs(Math.log(shot.w / shot.h / startRatio)) > 0.03);
  const clipAspect: AspectId = following && startRatio ? shotFor(startRatio) : aspect;
  const slots = mode === "image" && caps ? imageSlots(caps) : null;

  // A clip with your Cast in the words and no start frame: a model that takes reference pictures gets their photos, any
  // other first gets an opening frame drawn with them (server/cast-refs), unless you switch either way.
  const { items: castItems } = useCast();
  const inShot = mentionedHandles(prompt).flatMap((h) => castItems.filter((c) => c.handle === h));
  const [castFrame, setCastFrame] = useCastFrame();
  const localClip = Boolean(effectiveId?.startsWith("local:"));
  // A cloud clip model that takes reference pictures gets the cast's photos and builds the shot; the drawn frame is optional.
  const castRefs = !localClip && Boolean(caps?.refs?.max && !caps?.video);
  const drawsFrame = Boolean(video && (video.layout === "start" || video.layout === "start-end") && !video.start && inShot.length);
  const frameBy = drawsFrame ? resolveAuto("image", models, defaults, framePrefer(models, localClip), castFits) : null;
  const frameName = (castFrame.model ? models.find((m) => m.id === castFrame.model)?.name : null) ?? frameBy?.name ?? "Auto";

  // The pictures above the words (ShotStrip), each with its job, its tag and the word that mentions it ("@ref2").
  const frameTiles: { start: ShotTile | null; end: ShotTile | null } | null =
    video?.layout === "start" || video?.layout === "start-end"
      ? {
          start: video.start ? { r: video.start, role: "start", tag: "Start", token: "start" } : null,
          end: video.end ? { r: video.end, role: "end", tag: "End", token: "end" } : null,
        }
      : null;
  const refTiles: ShotTile[] = (video ? video.extras : refs).map((r, i) => ({
    r,
    role: "ref",
    tag: referenceName(i + 1).tag,
    token: referenceName(i + 1).token,
    unused: video ? !video.layout || i >= video.refsMax : slots !== null && i >= slots,
  }));
  // What each one is called: in the @ menu, and in the words the model reads.
  const named = [
    ...(frameTiles?.start ? [{ t: frameTiles.start, label: "Start frame", said: "the start frame" }] : []),
    ...(frameTiles?.end ? [{ t: frameTiles.end, label: "End frame", said: "the end frame" }] : []),
    ...refTiles.map((t, i) => ({ t, label: referenceName(i + 1).label, said: referenceName(i + 1).said })),
  ].filter((x) => !x.t.unused && x.t.r.status !== "error");
  const saidOf = (r: LocalRef) => named.find((x) => x.t.r.id === r.id)?.said ?? r.name;
  /** The words as the model reads them: "@start" is the start frame, "@ref2" reference image 2. */
  const spoken = (text: string) => sayPictures(text, named.map(({ t, said }) => ({ token: t.token, said })));
  // Pictures in the bar by url, with their tags: the picker marks them.
  const tags = Object.fromEntries(
    [frameTiles?.start, frameTiles?.end, ...refTiles].filter((t): t is ShotTile => Boolean(t?.r.url)).map((t) => [t.r.url!, t.tag]),
  );
  // The bar's references can go along when a frame is made, even ones the clip's model won't read itself.
  const makerPictures: MakerPicture[] = refTiles
    .filter((t) => t.r.status === "ready" && t.r.url)
    .map((t) => ({ ...referenceName(Number(t.token.slice(3))), url: t.r.url!, preview: t.r.preview.startsWith("blob:") ? t.r.preview : previewUrl(t.r.preview, 96) }));
  const mentions = useMentions({
    textarea,
    value: prompt,
    onChange: setPrompt,
    pictures: named.map(({ t, label }) => ({ token: t.token, label, src: t.r.preview.startsWith("blob:") ? t.r.preview : previewUrl(t.r.preview, 96) })),
  });
  const showStrip = refTiles.length > 0 || Boolean(frameTiles?.start || making.start || making.end);
  /** The jobs a picture can switch to from its tag. */
  const jobs: ShotRole[] =
    video?.layout === "start" || video?.layout === "start-end" ? ["start", ...(video.layout === "start-end" ? ["end" as const] : []), ...(video.refsMax ? ["ref" as const] : [])] : ["ref"];


  // Text pushed from elsewhere on the page ("Use this prompt").
  useEffect(
    () =>
      useComposerBridge.subscribe((s) => {
        if (!s.pending) return;
        const p = useComposerBridge.getState().consume();
        if (!p) return;
        setPrompt(p.prompt);
        if (p.aspect && ASPECTS.some((a) => a.id === p.aspect)) setAspect(p.aspect as AspectId);
        textarea.current?.focus({ preventScroll: true });
      }),
    [],
  );

  // Rotate example prompts (several languages) while the box is empty.
  useEffect(() => {
    if (prompt) return;
    const t = setInterval(() => setPlaceholder((p) => (p + 1) % PLACEHOLDERS.length), 4200);
    return () => clearInterval(t);
  }, [prompt]);

  // Grow the textarea with its content, up to five lines; past that it scrolls.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [prompt]);

  const readyRefs = refs.filter((r) => r.status === "ready" && r.url);

  /**
   * New pictures' jobs in a clip. The first goes where it was put (`first`: a slot, a drop zone, a picker tab) and a new
   * start or end frame replaces the old one; the rest fill the empty frames, then the references. Images need none.
   */
  function assign(ids: string[], first?: ShotRole) {
    if (!video || !ids.length) return;
    const frames = video.layout === "start" || video.layout === "start-end";
    if (first === "start" || first === "end") {
      const old = first === "start" ? video.start : video.end;
      if (old) remove(old.id);
      setMaking((m) => (m[first] ? { ...m, [first]: undefined } : m));
    }
    let start = Boolean(video.start) || first === "start";
    let end = Boolean(video.end) || first === "end";
    const next: Record<string, FrameRole> = {};
    ids.forEach((id, i) => {
      const role: FrameRole =
        first === "ref" || !frames ? "ref" : i === 0 && first ? first : !start ? "start" : video.layout === "start-end" && !end ? "end" : "ref";
      next[id] = role;
      start ||= role === "start";
      end ||= role === "end";
    });
    setRoles((r) => ({ ...r, ...next }));
  }

  /** Pictures dropped, pasted or uploaded: references for an image; for a clip, where they were put, else the empty frames first. */
  const addPictures = (files: File[], first?: ShotRole) => assign(add(files), first);
  /** Pictures picked from your latest ones: already on Crackio, so nothing uploads. */
  const addPicked = (pictures: PickedPicture[], first?: ShotRole) => assign(pictures.map((p) => addRemote(p.url, p.name, p)), first);

  function dropTo(role: ShotRole, files: File[]) {
    setDragging(false);
    addPictures(files, role);
  }

  /** A picture given another job, from its tag or dragged onto a slot: whoever had that job takes the picture's old one. */
  function moveTo(id: string, role: ShotRole, before?: string) {
    const at = (x: string) => refs.findIndex((r) => r.id === x);
    if (!video) return move(id, before ? at(before) : refs.length - 1);
    const from: ShotRole = video.start?.id === id ? "start" : video.end?.id === id ? "end" : "ref";
    const holder = role === "start" ? video.start : role === "end" ? video.end : before ? (refs.find((r) => r.id === before) ?? null) : null;
    const next: Record<string, FrameRole> = { [id]: role };
    if (holder && holder.id !== id) {
      if (role !== "ref" || from !== "ref") {
        // A swap: the holder takes the picture's old job, and its place among the references.
        next[holder.id] = from;
        if (from === "ref") move(holder.id, at(id));
        else if (role === "ref") move(id, at(holder.id));
      } else move(id, at(holder.id));
    } else if (role === "ref") move(id, refs.length - 1);
    setRoles((r) => ({ ...r, ...next }));
  }

  /** A start or end frame made on the spot (FrameMaker); it lands in its slot when it's done. The end frame is the start frame, edited. */
  async function makeFrame(which: "start" | "end", pick: string, words: string, going: MakerPicture[]) {
    const base = which === "end" && video?.start?.status === "ready" ? video.start : null;
    const g = await submit({
      tool: "image",
      prompt: words,
      aspect: base && startRatio ? shotFor(startRatio) : clipAspect,
      count: 1,
      model: pick,
      refine,
      references: [
        ...(base?.url ? [{ url: base.url, label: "the start frame: keep its place, people, framing and light; change only what the request says", role: "edit-target" as const }] : []),
        ...going.map((p) => ({ url: p.url, label: p.said, role: "subject" as const })),
      ],
      params: { kind: "image" },
    });
    setMaking((m) => ({ ...m, [which]: g.id }));
  }

  /** One job in the picture picker: references take several; frames can be made on the spot. */
  function pickerRole(role: ShotRole): PickerRole<ShotRole> {
    if (role === "ref") {
      const max = video ? video.refsMax : slots;
      return {
        id: "ref",
        label: "References",
        caption: "Who and what it shows",
        icon: <Images size={14} />,
        several: { have: video ? video.extras.length : refs.length, max: max || undefined },
      };
    }
    const base = role === "end" && video?.start?.status === "ready" && video.start.url ? video.start : null;
    return {
      id: role,
      label: role === "start" ? "Start frame" : "End frame",
      caption: role === "start" ? "The clip opens on it" : "Where the clip lands",
      icon: role === "start" ? <Play size={13} /> : <FlagTriangleRight size={14} />,
      maker:
        role === "end" && !base
          ? undefined
          : {
              label: role === "start" ? "Generate one" : "Generate from start",
              form: (done, back) => (
                <FrameMaker
                  which={role}
                  base={base ? { url: base.url!, name: base.name, width: base.width, height: base.height } : null}
                  shape={base && startRatio ? shotFor(startRatio) : clipAspect}
                  pictures={makerPictures}
                  onBack={back}
                  onMake={async (pick, words, going) => {
                    await makeFrame(role, pick, words, going);
                    done();
                  }}
                />
              ),
            },
    };
  }

  // A frame made on the spot lands in its slot when it's done.
  const land = useEffectEvent((which: "start" | "end", g: Generation) => {
    if (landed.current.has(g.id)) return;
    landed.current.add(g.id);
    setMaking((m) => (m[which] === g.id ? { ...m, [which]: undefined } : m));
    const out = g.outputs.find((o) => o.kind === "image");
    if (g.status !== "done" || !out) return setNotice({ tone: "error", text: g.error ?? `The ${which} frame didn't come out. Try again.` });
    assign([addRemote(out.url, which === "start" ? "Start frame" : "End frame", out)], which);
  });
  useEffect(() => {
    const jobs = Object.entries(making).filter((e): e is ["start" | "end", string] => Boolean(e[1]));
    if (!jobs.length) return;
    return useGenerationsStore.subscribe((s) => {
      for (const [which, id] of jobs) {
        const g = s.items.find((x) => x.id === id);
        if (g && (g.status === "done" || g.status === "error")) land(which, g);
      }
    });
  }, [making]);

  async function generate() {
    if (busy) return;
    if (uploading) return setNotice({ tone: "hint", text: "Wait for the pictures to finish uploading." });
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") {
      askForModel(mode);
      return setNotice({ tone: "hint", text: "Choose a model first." });
    }
    const pictured = video ? Boolean(video.start || (video.layout === "refs" && video.extras.length)) : readyRefs.length > 0;
    if (!prompt.trim() && !pictured) {
      textarea.current?.focus();
      return setNotice({ tone: "hint", text: mode === "video" ? "Describe the shot first, or add a start frame." : "Describe the shot first, or add a reference image." });
    }
    if (video?.needsStart && !pictured) return setNotice({ tone: "hint", text: `${who} needs a ${video.layout === "refs" ? "reference picture" : "start frame"}: add one first.` });
    setBusy(true);
    setNotice(null);
    try {
      if (!video) {
        await submit({
          tool: "image",
          prompt: spoken(prompt),
          aspect,
          count,
          model,
          refine,
          // The pictures the model takes, called what their tags say.
          references: named.filter((x) => x.t.r.status === "ready" && x.t.r.url).map(({ t, said }) => ({ url: t.r.url!, label: said, role: "subject" as const })),
          params: { kind: "image", options: imageQuality.options },
        });
      } else {
        const ready = (r: LocalRef | null) => (r?.status === "ready" && r.url ? r : null);
        const start = ready(video.start);
        const end = start ? ready(video.end) : null;
        const extras = video.extras.slice(0, video.refsMax).filter((r) => ready(r));
        await submit({
          tool: "video",
          prompt: spoken(prompt.trim()) || "Animate this image naturally.",
          aspect: clipAspect,
          count: 1,
          model,
          refine,
          references: [
            ...(start ? [{ url: start.url!, label: "the start frame", role: "subject" as const }] : []),
            ...(end ? [{ url: end.url!, label: "the end frame", role: "subject" as const }] : []),
            ...extras.map((r) => ({ url: r.url!, label: saidOf(r), role: "subject" as const })),
          ],
          params: {
            kind: "video",
            options: {
              ...(durationValue !== null ? { duration: durationValue } : {}),
              ...(videoQuality.resolution ? { resolution: videoQuality.resolution } : {}),
              ...(soundOk ? { sound } : {}),
              ...(cropping ? { cropFrames: true } : {}),
            },
            ...(start ? { startUrl: start.url } : {}),
            ...(inShot.length ? castFrameParams(castFrame, castRefs) : {}),
            ...(end ? { endUrl: end.url } : {}),
            // Pictures beside the frames: who and what the clip shows (reference-to-video).
            ...(start && extras.length ? { refs: extras.map((r) => ({ url: r.url!, label: saidOf(r) })) } : {}),
          },
        });
      }
      requestAnimationFrame(() => document.getElementById("recent")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function stageInDirector() {
    sendHandoff({ prompt, aspect, references: readyRefs.map((r) => ({ url: r.url!, name: r.name })), from: "home" });
    router.push("/director");
  }

  // What the model does with your pictures, when it isn't everything you gave it.
  const unused = refTiles.filter((t) => t.unused).length;
  const inputNote = !unused
    ? null
    : video && !video.layout
      ? `${who} makes clips from words only; your pictures won't be used.`
      : !video && slots === 0
        ? `${who} makes images from words only; your pictures won't be used.`
        : `${who} ${
            video?.layout === "start-end" ? "takes a start and an end frame" : video?.layout === "start" ? "starts from one frame" : `takes up to ${video ? video.refsMax : slots} pictures`
          }; ${unused === 1 ? "one of yours" : `${unused} of yours`} won't be used.`;

  const framesNote = !video
    ? ""
    : video.layout === "refs"
      ? `Your pictures guide the clip as references, up to ${video.refsMax}.`
      : video.layout === "start-end"
        ? video.start && video.end
          ? "Opens on your start frame and lands on your end frame. Drag one onto the other to swap them."
          : video.start
            ? "Animates from your start frame. Add an end frame to land on it."
            : "Optional: a picture to start from, and one to land on."
        : video.start
          ? `Animates from your start frame. ${who} can't land on an end frame.`
          : video.needsStart
            ? `${who} needs a start frame.`
            : "Optional: a picture for the clip to start from.";

  // Files dragged over the bar: a place for each job the model has for a picture.
  const zones: { role: ShotRole; label: string; hint: string }[] = !video
    ? [{ role: "ref", label: "Reference", hint: slots ? `${who} takes up to ${slots}` : "Guides the picture" }]
    : video.layout === "refs"
      ? [{ role: "ref", label: "Reference", hint: `${who} takes up to ${video.refsMax}` }]
      : video.layout
        ? [
            { role: "start", label: "Start", hint: "The clip opens on it" },
            ...(video.layout === "start-end" && video.start ? [{ role: "end" as const, label: "End", hint: "The clip lands on it" }] : []),
            ...(video.refsMax ? [{ role: "ref" as const, label: "Reference", hint: "Who or what it shows" }] : []),
          ]
        : [];
  // Where the bar's picture chip opens: the first empty slot.
  const pickerRoles: ShotRole[] = !video || video.layout === "refs" ? ["ref"] : ["start", ...(video.layout === "start-end" && video.start ? ["end" as const] : []), ...(video.refsMax ? ["ref" as const] : [])];
  const firstEmpty: ShotRole = !video || video.layout === "refs" ? "ref" : !video.start ? "start" : video.layout === "start-end" && !video.end ? "end" : video.refsMax ? "ref" : "start";
  /** A reference picked again in the picker: taken back out. */
  const unpick = (url: string) => {
    const r = (video ? video.extras : refs).find((x) => x.url === url);
    if (r) remove(r.id);
  };
  // The start frame's shape against the clip's: cropped to the clip, or the clip following the frame.
  const pictureShape = startRatio ? shotFor(startRatio) : null;
  const shape =
    video?.start && pictureShape && (cropping || (following && pictureShape !== aspect))
      ? { clip: aspect, clipRatio: shot.w / shot.h, picture: pictureShape, cropping, onToggle: () => setShapeFor(cropping ? null : video.start!.id) }
      : null;

  return (
    <section
      aria-label="Start a generation"
      id="composer"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addPictures(Array.from(e.dataTransfer.files));
      }}
      // From the top of the window down to Recent: one rounded stage with the backdrop behind it.
      className="relative isolate flex min-h-[calc(100svh-5rem)] scroll-mt-24 flex-col overflow-hidden rounded-panel bg-[#120f17] lg:min-h-[min(calc(100svh-2rem),68rem)]"
    >
      <HeroBackdrop state={backdrop} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]" />
      {dragging ? <div className="pointer-events-none absolute inset-0 rounded-panel shadow-[inset_0_0_0_2px_var(--color-spike)]" /> : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-3 p-4 sm:p-6">
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-black/35 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-paper/80 ring-1 ring-white/[0.08]">
          {live > 0 ? (
            <>
              <RecDot /> Rendering · {live}
            </>
          ) : (
            <>
              <span className="size-1.5 rounded-full bg-chroma/80" /> Ready
            </>
          )}
        </span>
        <HeroCaption
          state={backdrop}
          onUse={(p) => {
            setPrompt(p);
            setAspect("3:2");
            setNotice(null);
            textarea.current?.focus({ preventScroll: true });
          }}
        />
      </div>

      <div className="relative mx-auto my-auto w-full max-w-[1080px] px-4 pb-14 pt-24 sm:px-8 sm:pb-16 sm:pt-28">
        <h1 className="text-center font-display text-[46px] sm:text-[66px] lg:text-[82px] 2xl:text-[92px]">What&rsquo;s the shot?</h1>
        <p className="mx-auto mt-4 max-w-[54ch] text-center text-[15px] leading-relaxed text-fog sm:text-base">
          Describe it in any language, drop in reference photos, or stage it yourself in Director.
        </p>

        <div data-dragging={dragging || undefined} className="smoked-glass squircle relative mt-8 flex flex-col gap-2 rounded-[26px] p-2 sm:flex-row">
          {dragging ? <DropZones zones={zones} onDrop={dropTo} /> : null}
          <div className="min-w-0 flex-1">
            <AnimatePresence initial={false}>
              {showStrip ? (
                <motion.div key="strip" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  <ShotStrip
                    frames={frameTiles}
                    refs={refTiles}
                    refsMax={video ? video.refsMax : slots}
                    endSlot={video?.layout === "start-end"}
                    making={{ start: startJob, end: endJob }}
                    clipRatio={aspectById(clipAspect).w / aspectById(clipAspect).h}
                    shape={shape}
                    roles={jobs}
                    addSlot={(role, trigger) => (
                      <PicturePicker
                        roles={[pickerRole(role)]}
                        tags={tags}
                        onUnpick={(_, url) => unpick(url)}
                        placement="bottom-start"
                        className="size-full"
                        trigger={trigger}
                        onPick={(r, pictures) => addPicked(pictures, r)}
                        onUpload={(r, files) => addPictures(files, r)}
                      />
                    )}
                    onRemove={remove}
                    onMove={moveTo}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>

            <label className="sr-only" htmlFor="composer-prompt">
              Describe the shot
            </label>
            <textarea
              id="composer-prompt"
              ref={textarea}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (notice?.tone === "hint") setNotice(null);
              }}
              onKeyDown={(e) => {
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void generate();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addPictures(files);
                }
              }}
              rows={2}
              placeholder={PLACEHOLDERS[placeholder]}
              className="block min-h-[60px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[16px] leading-relaxed text-paper outline-none [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%_-_8px),transparent)] [scrollbar-color:rgb(255_255_255/0.16)_transparent] [scrollbar-width:thin] placeholder:text-haze"
            />
            {mentions.menu}

            {/* The settings keep one line and their full labels at any width: past what fits they scroll sideways. */}
            <ScrollRow className="-mb-0.5 -mt-1" trackClassName="gap-1.5 px-1">
              <div role="radiogroup" aria-label="What to make" className={cn("flex h-9 rounded-chip p-0.5", GLASS_CHIP)}>
                {(["image", "video"] as const).map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "press squircle rounded-[10px] px-3 text-[13px] font-semibold capitalize",
                      mode === m ? "bg-white/[0.12] text-paper shadow-[inset_0_1px_0_rgb(255_255_255/0.09),0_1px_2px_rgb(0_0_0/0.25)]" : "text-fog hover:text-paper",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <ModelPicker kind={mode} value={model} onChange={setModel} variant="chip" chipClassName={GLASS_CHIP} surface="glass" />

              {/* Your latest pictures, your computer, or a frame made on the spot. */}
              {!video || video.layout ? (
                <PicturePicker
                  key={`${mode}:${video?.layout}`}
                  roles={pickerRoles.map(pickerRole)}
                  onUnpick={(_, url) => unpick(url)}
                  initial={firstEmpty}
                  tags={tags}
                  note={framesNote || undefined}
                  placement="bottom-start"
                  trigger={({ open, toggle }) =>
                    !video || !video.layout ? (
                      <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="dialog" title="Add reference images">
                        <ImagePlus size={15} />
                        References
                        {refs.length ? <span className="tabular text-haze">{refs.length}</span> : null}
                      </ChipButton>
                    ) : (
                      <FramesButton layout={video.layout} start={video.start} end={video.end} extras={video.extras} open={open} toggle={toggle} />
                    )
                  }
                  onPick={(r, pictures) => addPicked(pictures, r)}
                  onUpload={(r, files) => addPictures(files, r)}
                />
              ) : null}

              {drawsFrame ? (
                <Popover
                  placement="bottom-start"
                  panelClassName="w-[min(360px,calc(100vw-24px))] p-1.5"
                  trigger={({ open, toggle }) => (
                    <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="dialog" title="How your cast gets into the clip">
                      <Sparkles size={14} className={drawsFirst(castFrame, castRefs) ? "text-spike" : "text-haze"} />
                      Cast frame
                      <span className="font-medium text-fog">· {drawsFirst(castFrame, castRefs) ? frameName : castRefs ? "Their photos" : "Off"}</span>
                    </ChipButton>
                  )}
                >
                  {() => (
                    <CastFrameControl
                      setting={castFrame}
                      onChange={setCastFrame}
                      auto={frameBy ? { id: frameBy.id, name: frameBy.name } : null}
                      who={namesOf(inShot.map((c) => c.name))}
                      refs={castRefs}
                      className="bg-transparent shadow-none"
                    />
                  )}
                </Popover>
              ) : null}

              <FormatChip
                aspect={aspect}
                onAspect={(a) => {
                  setAspect(a);
                  if (video?.start) setShapeFor(video.start.id);
                }}
                frame={video?.start ? { following, ratio: startRatio, follow: () => setShapeFor(null) } : null}
                note={cropping ? `Your frames are cropped to ${aspect}.` : following ? "The clip keeps your start frame's shape." : null}
                q={video ? videoQuality : imageQuality}
                hintKey={video ? "video" : "image"}
                pricing={pricing}
                input={
                  video
                    ? { output: "video", count: 1, seconds: durationValue ?? undefined, ratio: startRatio && following ? startRatio : shot.w / shot.h, sound: soundOk ? sound : undefined }
                    : { output: "image", count: 1, ratio: shot.w / shot.h }
                }
              />

              {!video ? (
                <div className={cn("flex h-9 items-center rounded-chip text-[13px]", GLASS_CHIP)}>
                  <button
                    onClick={() => setCount((c) => Math.max(1, c - 1))}
                    disabled={count <= 1}
                    className="press grid h-full w-7 place-items-center text-fog hover:text-paper disabled:opacity-30"
                    aria-label="Fewer images"
                  >
                    <Minus size={13} />
                  </button>
                  <span className="tabular w-7 text-center font-medium" aria-live="polite">
                    {count}/4
                  </span>
                  <button
                    onClick={() => setCount((c) => Math.min(4, c + 1))}
                    disabled={count >= 4}
                    className="press grid h-full w-7 place-items-center text-fog hover:text-paper disabled:opacity-30"
                    aria-label="More images"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              ) : (
                <LengthChip caps={caps} value={durationValue} onChange={setDuration} sound={soundOk ? sound : null} onSound={setSound} />
              )}

              <ChipButton
                onClick={() => setRefine((r) => !r)}
                aria-pressed={refine}
                aria-label="Refine"
                title={writer ? `Rewrites your words into a precise English prompt with ${writer.name} first` : "Rewrites your words into a precise English prompt first"}
                className={refine ? "text-paper" : "text-haze"}
              >
                <Sparkles size={14} className={refine ? "text-spike" : ""} />
                Refine
                {refine ? <Check size={13} className="text-spike" /> : null}
              </ChipButton>

              {/* Director stages stills, so it sits with the image settings only. */}
              {!video ? (
                <ChipButton onClick={stageInDirector} title="Place subjects, camera and light yourself">
                  <Clapperboard size={14} className="text-spike" />
                  Director
                </ChipButton>
              ) : null}
            </ScrollRow>
          </div>

          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || noModel}
            className="lip squircle flex h-14 shrink-0 flex-col items-center justify-center gap-1 rounded-[20px] bg-spike px-6 text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip-glow:0_10px_32px_-10px_rgb(255_91_46/0.5)] [--lip:var(--color-spike-lip)] hover:bg-spike-hi hover:[--lip-glow:0_12px_38px_-10px_rgb(255_91_46/0.62)] disabled:cursor-not-allowed disabled:opacity-60 sm:h-auto sm:min-h-[98px] sm:w-[150px] sm:self-stretch"
          >
            {busy ? <LoaderCircle size={20} className="animate-spin" /> : <span className="font-display text-[22px] leading-none">Generate</span>}
            <span className="tabular hidden items-center gap-1 text-[11.5px] font-bold opacity-75 sm:flex">
              {video ? `${typeof durationValue === "number" ? `${durationValue}s` : "Auto"} clip` : `×${count}`} <CornerDownLeft size={11} />
            </span>
          </button>
        </div>

        <div className="mt-3 min-h-5 text-center text-[13px]" aria-live="polite">
          {notice ? (
            <span className={notice.tone === "error" ? "text-tally" : "text-tungsten"}>{notice.text}</span>
          ) : dragging ? (
            <span className="text-spike">{zones.length > 1 ? "Drop it on what it's for" : zones.length ? "Drop to add as references" : `Drop to add: ${who} won't use pictures`}</span>
          ) : noModel ? (
            <span className="text-tungsten">
              {mode === "video" ? "No video model yet." : "No picture model yet."} Install a free one on your GPU in{" "}
              <Link href="/local" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
                Local
              </Link>{" "}
              (ComfyUI), or add a Comfy key in{" "}
              <Link href="/settings/connections" className="font-semibold underline decoration-tungsten/40 underline-offset-2 hover:text-paper">
                Connections
              </Link>
              .
            </span>
          ) : inputNote ? (
            <span className="text-tungsten">{inputNote}</span>
          ) : (
            <span className="text-haze">
              Enter to generate · paste or drop {video ? "frames" : "images"} ·{" "}
              <Link href={video ? "/video" : "/create"} className="font-semibold text-fog hover:text-paper">
                More controls in {video ? "Video" : "Image"}
              </Link>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** How far along a generation is, without redrawing the hero for any other take's progress. */
function useJob(id?: string): Making | undefined {
  const progress = useGenerations((s) => (id ? s.items.find((g) => g.id === id)?.progress : undefined));
  const stage = useGenerations((s) => (id ? s.items.find((g) => g.id === id)?.stage : undefined));
  return id ? { progress, stage } : undefined;
}

type VideoInputs = {
  /** What the model takes: a start and an end frame, a start frame only, references, or words only (null). */
  layout: "start-end" | "start" | "refs" | null;
  start: LocalRef | null;
  end: LocalRef | null;
  /** The other pictures, in order; the first `refsMax` go to the model as references. */
  extras: LocalRef[];
  refsMax: number;
  /** The model can't make a clip without a picture. */
  needsStart: boolean;
};

/**
 * Which picture is a clip's start frame, which its end frame, and which are references, for the
 * model that will run. A model Crackio doesn't know yet takes both frames, like in the Video tool.
 */
function videoInputs(caps: Caps | null, refs: LocalRef[], roles: Record<string, FrameRole>): VideoInputs {
  if (caps && !caps.image && !caps.keyframes) {
    return { layout: caps.refs ? "refs" : null, start: null, end: null, extras: refs, refsMax: caps.refs?.max ?? 0, needsStart: Boolean(caps.refs?.required) };
  }
  const endOk = !caps || Boolean(caps.end || caps.keyframes);
  // Pictures beside the frames go in as references when the model takes both.
  const refsMax = caps?.refs && caps.image ? caps.refs.max : 0;
  // An end frame left on its own (its start removed) is where the clip starts; so is the first reference when the model takes none.
  const start =
    refs.find((r) => roles[r.id] === "start") ?? refs.find((r) => !roles[r.id]) ?? refs.find((r) => roles[r.id] === "end") ?? (refsMax ? null : (refs[0] ?? null));
  const end = endOk ? (refs.find((r) => r !== start && roles[r.id] === "end") ?? null) : null;
  return {
    layout: endOk ? "start-end" : "start",
    start,
    end,
    extras: refs.filter((r) => r !== start && r !== end),
    refsMax,
    needsStart: Boolean(caps?.image?.required || caps?.keyframes?.required),
  };
}
