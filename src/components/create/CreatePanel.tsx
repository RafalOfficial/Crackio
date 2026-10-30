"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, ImagePlus, Images, LoaderCircle, Minus, Plus } from "lucide-react";
import { Panel, PanelHeader, Row, RowGroup, Segmented, Switch } from "@/components/ui/Panel";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { ModelPicker } from "@/components/models/ModelPicker";
import { PicturePicker } from "@/components/media/PicturePicker";
import { ShotStrip, type ShotTile } from "@/components/dashboard/ShotStrip";
import { previewUrl } from "@/lib/media-url";
import { referenceName, sayPictures } from "@/lib/prompt-pictures";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { CostLine, usePricing } from "@/components/models/CostLine";
import { QualityPicker, useOutputQuality } from "@/components/models/QualityPicker";
import { AdvancedOptions, useTuning } from "@/components/models/AdvancedOptions";
import { IMAGE_RESOLUTIONS, imagePixels } from "@/lib/local/resolution";
import { useMentions } from "@/components/cast/Mentions";
import { CastStrip } from "@/components/cast/CastStrip";
import { useConnections } from "@/lib/hooks/use-connections";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { useComposerBridge } from "@/lib/hooks/use-composer-bridge";
import { useUploads } from "@/lib/hooks/use-uploads";
import { resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { isCustomModel, useModelInfo } from "@/lib/hooks/use-custom-models";
import { imageSlots, type AspectChoice } from "@/lib/models/caps";
import { ASPECTS, aspectById, sizeFor, type AspectId } from "@/lib/shot";
import { cn } from "@/lib/cn";
import { useModelParam } from "@/lib/hooks/use-model-param";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

const PLACEHOLDERS = [
  "A woman in a red coat on a rainy street at night, shot from low, neon behind her…",
  "Une tasse de café sur une table en marbre, lumière du matin, vue de dessus…",
  "Mi perro corriendo en la playa al atardecer, cámara a ras del suelo…",
  "Product shot of my sneaker floating over wet asphalt, hard rim light…",
];

/** The shapes a Custom-tab image model makes (null for Crackio's own models, which take any shape). */
function customShapes(caps: ReturnType<typeof useModelInfo>["caps"]): AspectChoice[] | null {
  const list = (caps?.aspect?.choices ?? caps?.size?.presets ?? []).filter((c) => c.ratio !== null);
  const seen = new Set<string>();
  const unique = list.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)));
  return unique.length ? unique : null;
}

/** The page's frame closest to a ratio, for the output box. */
const nearestShot = (ratio: number): AspectId =>
  ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / ratio)) < Math.abs(Math.log(best.w / best.h / ratio)) ? a : best)).id;

export function CreatePanel() {
  const router = useRouter();
  const submit = useGenerations((s) => s.submit);
  const { usable, loaded: connectionsLoaded, error: connectionsError } = useConnections();
  const { refs, add, addRemote, move, remove, uploading } = useUploads();
  const sendHandoff = useHandoff((s) => s.send);

  const [model, setModel] = useModelChoice("image");
  useModelParam(setModel);
  const { models, defaults, setDefault } = useModels();
  const writer = defaults.text ?? "auto";
  // The prompt writer is a saved default, so the choice follows you to every tool.
  const setWriter = (id: string) => void setDefault("text", id);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<AspectId>("3:2");
  const [count, setCount] = useState(1);
  const [refine, setRefine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "hint"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [placeholder, setPlaceholder] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const readyRefs = refs.filter((r) => r.status === "ready" && r.url);
  const size = sizeFor(aspect);

  // A Custom-tab model brings its own rules: the shapes it makes, whether it takes (or needs) pictures, how many takes.
  const effectiveId = model === "auto" ? resolveAutoId("image", models, defaults) : model;
  const info = useModelInfo(effectiveId);
  const customCaps = isCustomModel(effectiveId) ? info.caps : null;
  const shapes = customShapes(customCaps);
  const [shape, setShape] = useState<string | null>(null);
  const chosenShape = shapes ? (shapes.find((x) => x.value === shape) ?? shapes.find((x) => x.label === aspect) ?? shapes[0]) : null;
  const shotAspect = chosenShape?.ratio ? nearestShot(chosenShape.ratio) : aspect;
  const slots = customCaps ? imageSlots(customCaps) : null;
  const refsIgnored = slots === 0 && readyRefs.length > 0;
  const needsRef = Boolean(customCaps && (customCaps.image?.required || customCaps.refs?.required) && readyRefs.length === 0);
  // The references above the words, each with its tag and the word that mentions it ("@ref2"), like on Home.
  const tiles: ShotTile[] = refs.map((r, i) => ({ r, role: "ref", tag: referenceName(i + 1).tag, token: referenceName(i + 1).token, unused: slots !== null && i >= slots }));
  const named = tiles.flatMap((t, i) => (t.unused || t.r.status === "error" ? [] : [{ t, ...referenceName(i + 1) }]));
  const mentions = useMentions({
    textarea,
    value: prompt,
    onChange: setPrompt,
    pictures: named.map(({ t, token, label }) => ({ token, label, src: t.r.preview.startsWith("blob:") ? t.r.preview : previewUrl(t.r.preview, 96) })),
  });
  const tags = Object.fromEntries(tiles.filter((t) => t.r.url).map((t) => [t.r.url!, t.tag]));
  const pickRole = { id: "ref" as const, label: "References", caption: "Who and what it shows", icon: <Images size={14} />, several: { have: refs.length, max: slots || undefined } };
  const unpick = (url: string) => {
    const r = refs.find((x) => x.url === url);
    if (r) remove(r.id);
  };
  // The resolution, quality or size it renders at, each priced, so you can pick by cost too.
  const quality = useOutputQuality(info.caps);
  // Open models on your own GPU: steps, guidance, a negative prompt and a seed.
  const tuning = useTuning(info.caps?.tuning);
  // The size the picture comes out at: an open model's resolution (Draft to 4K) in this frame, else the frame's own.
  const pixels =
    effectiveId?.startsWith("local:") && quality.resolution && IMAGE_RESOLUTIONS.some((r) => r.value === quality.resolution) ? imagePixels(quality.resolution, size.width / size.height) : size;
  const pricing = usePricing(effectiveId);
  const ratio = chosenShape?.ratio ?? aspectById(aspect).w / aspectById(aspect).h;

  // Text pushed from elsewhere on the page ("Use this prompt"), or sent from the Library before this
  // page opened ("Start a new image from this prompt"): that one is applied a tick after mount.
  useEffect(() => {
    const apply = () => {
      const p = useComposerBridge.getState().consume();
      if (!p) return;
      setPrompt(p.prompt);
      if (p.aspect && ASPECTS.some((a) => a.id === p.aspect)) setAspect(p.aspect as AspectId);
      textarea.current?.focus({ preventScroll: true });
    };
    void Promise.resolve().then(apply);
    return useComposerBridge.subscribe((s) => {
      if (s.pending) apply();
    });
  }, []);

  // The words from a showcase demo you opened on Home (drafts for other tools are left alone).
  // Applied a tick after mount, like the other handoffs: the draft lives in session storage.
  useEffect(() => {
    const d = useHandoff.getState().draft;
    if (d?.from !== "showcase" || d.references.length) return;
    useHandoff.getState().take();
    void Promise.resolve().then(() => {
      setPrompt(d.prompt);
      if (d.aspect && ASPECTS.some((a) => a.id === d.aspect)) setAspect(d.aspect as AspectId);
    });
  }, []);

  useEffect(() => {
    if (prompt) return;
    const t = setInterval(() => setPlaceholder((p) => (p + 1) % PLACEHOLDERS.length), 4200);
    return () => clearInterval(t);
  }, [prompt]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 240)}px`;
  }, [prompt]);

  async function generate() {
    if (busy) return;
    if (uploading) return setNotice({ tone: "hint", text: "Wait for the references to finish uploading." });
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") {
      askForModel("image");
      return setNotice({ tone: "hint", text: "Choose a model first." });
    }
    if (!prompt.trim() && readyRefs.length === 0) {
      textarea.current?.focus();
      return setNotice({ tone: "hint", text: "Describe the shot first, or add a reference image." });
    }
    if (needsRef) return setNotice({ tone: "hint", text: "This model edits pictures: add a reference image first." });
    setBusy(true);
    setNotice(null);
    try {
      await submit({
        tool: "image",
        prompt: sayPictures(prompt, named),
        aspect: shotAspect,
        count,
        model,
        refine,
        // Each picture called what its tag says, so "@ref2" in the words is the second one.
        references: named.filter(({ t }) => t.r.status === "ready" && t.r.url).map(({ t, said }) => ({ url: t.r.url!, label: said, role: "subject" })),
        params: { kind: "image", options: { ...quality.options, ...tuning.options, ...(chosenShape ? { aspectValue: chosenShape.value } : {}) } },
      });
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

  const noEngine = connectionsLoaded && !connectionsError && usable.length === 0;

  return (
    <Panel
      aria-label="New shot"
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
        void add(Array.from(e.dataTransfer.files));
      }}
      className={cn("flex flex-col", dragging && "shadow-[inset_0_0_0_1.5px_var(--color-spike)]")}
    >
      <PanelHeader title="New shot">
        <Segmented
          value="image"
          onChange={(v) => v === "video" && router.push("/video")}
          options={[
            { id: "image", label: "Image" },
            { id: "video", label: "Video", title: "Make a clip from a still" },
          ]}
        />
      </PanelHeader>

      <div className="space-y-3 p-3">
        {noEngine ? (
          <p className="rounded-[12px] bg-tungsten/10 px-3.5 py-3 text-[13px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
            No picture model yet. Install a free one on your GPU in{" "}
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
        {connectionsError ? (
          <p className="rounded-[12px] bg-tally/10 px-3.5 py-3 text-[13px] text-tally">
            Couldn&rsquo;t reach the Crackio server: {connectionsError}
          </p>
        ) : null}

        <ModelPicker kind="image" value={model} onChange={setModel} />

        <div className="field-focus squircle rounded-[16px] bg-white/[0.02] shadow-[inset_0_0_0_1px_var(--color-line)]">
          {tiles.length ? (
            <ShotStrip
              frames={null}
              refs={tiles}
              refsMax={slots}
              endSlot={false}
              making={{}}
              clipRatio={1}
              shape={null}
              roles={["ref"]}
              addSlot={(_, trigger) => (
                <PicturePicker
                  roles={[pickRole]}
                  tags={tags}
                  placement="bottom-start"
                  className="size-full"
                  trigger={trigger}
                  onPick={(_r, pictures) => pictures.forEach((p) => addRemote(p.url, p.name, p))}
                  onUpload={(_r, files) => void add(files)}
                  onUnpick={(_r, url) => unpick(url)}
                />
              )}
              onRemove={remove}
              onMove={(id, _role, before) => move(id, before ? refs.findIndex((r) => r.id === before) : refs.length - 1)}
            />
          ) : null}
          <label className="sr-only" htmlFor="create-prompt">
            Describe the shot
          </label>
          <textarea
            id="create-prompt"
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
                void add(files);
              }
            }}
            placeholder={PLACEHOLDERS[placeholder]}
            className="block w-full resize-none bg-transparent px-3.5 pb-2 pt-3 text-[15px] leading-relaxed text-paper outline-none placeholder:text-haze"
          />
          {mentions.menu}
          <div className="flex items-end justify-between gap-3 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {/* Your latest pictures first, then your computer. */}
              <PicturePicker
                roles={[pickRole]}
                tags={tags}
                onUnpick={(_, url) => unpick(url)}
                placement="bottom-start"
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    className="press squircle inline-flex h-9 items-center gap-1.5 rounded-[11px] px-2.5 text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04] hover:text-paper aria-expanded:bg-white/[0.06] aria-expanded:text-paper"
                    aria-label="Add reference images"
                    title="Add reference images (or paste / drop them)"
                  >
                    <ImagePlus size={15} />
                    References
                    {refs.length ? <span className="tabular text-haze">{refs.length}</span> : null}
                  </button>
                )}
                onPick={(_, pictures) => pictures.forEach((p) => addRemote(p.url, p.name, p))}
                onUpload={(_, files) => void add(files)}
              />
            </div>
            <Switch checked={refine} onChange={setRefine} label="Refine" title="Rewrites your words, in any language, into a precise English prompt" />
          </div>
        </div>
        <CastStrip prompt={prompt} onChange={setPrompt} how="Their reference sheet (front, side and back) goes along, with their face close-up for close shots, and the prompt keeps them at their real size." />

        <RowGroup>
          {refine ? <ModelPicker kind="text" value={writer} onChange={setWriter} variant="setting" label="Refine with" className="block" /> : null}
          <Popover
            placement="bottom-start"
            className="block"
            panelClassName="w-[240px]"
            trigger={({ open, toggle }) =>
              chosenShape ? (
                <Row onClick={toggle} aria-expanded={open} thumb={<AspectGlyph id={shotAspect} />} label="Frame" value={chosenShape.label} tags={["This model's shapes"]} />
              ) : (
                <Row
                  onClick={toggle}
                  aria-expanded={open}
                  thumb={<AspectGlyph id={aspect} />}
                  label="Frame"
                  value={`${aspect} · ${aspectById(aspect).label}`}
                  tags={[`${pixels.width}×${pixels.height}`]}
                />
              )
            }
          >
            {(close) => (
              <div role="menu" aria-label="Aspect ratio" className="scroll-thin max-h-[min(420px,var(--popover-max-h,70vh))] overflow-y-auto">
                {shapes
                  ? shapes.map((x) => (
                      <MenuItem
                        key={x.value}
                        selected={x.value === chosenShape?.value}
                        onSelect={() => {
                          setShape(x.value);
                          close();
                        }}
                        hint={x.value === x.label ? undefined : x.value}
                      >
                        <AspectGlyph id={nearestShot(x.ratio ?? 1)} />
                        {x.label}
                      </MenuItem>
                    ))
                  : ASPECTS.map((a) => (
                      <MenuItem
                        key={a.id}
                        selected={a.id === aspect}
                        onSelect={() => {
                          setAspect(a.id);
                          close();
                        }}
                        hint={a.id}
                      >
                        <AspectGlyph id={a.id} />
                        {a.label}
                      </MenuItem>
                    ))}
              </div>
            )}
          </Popover>
          <QualityPicker q={quality} pricing={pricing} input={{ output: "image", count: 1, ratio }} />
          <div className="flex min-h-12 items-center gap-3 px-3 py-2">
            <span className="grid h-7 w-10 shrink-0 place-items-center rounded-[6px] bg-apple-2 font-mono text-[11px] text-fog">×{count}</span>
            <span className="w-[76px] shrink-0 text-[13px] text-haze">Takes</span>
            <span className="flex-1 text-[14px] font-semibold">{count === 1 ? "One image" : `${count} images`}</span>
            <div className="squircle flex items-center rounded-[12px] bg-white/[0.05]">
              <button
                onClick={() => setCount((c) => Math.max(1, c - 1))}
                disabled={count <= 1}
                className="press grid size-8 place-items-center text-fog hover:text-paper disabled:opacity-30"
                aria-label="Fewer images"
              >
                <Minus size={13} />
              </button>
              <span className="tabular w-5 text-center text-[13px] font-semibold">{count}</span>
              <button
                onClick={() => setCount((c) => Math.min(4, c + 1))}
                disabled={count >= 4}
                className="press grid size-8 place-items-center text-fog hover:text-paper disabled:opacity-30"
                aria-label="More images"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
          <AdvancedOptions s={tuning} job={{ model: effectiveId, count, references: refsIgnored ? 0 : readyRefs.length, resolution: quality.resolution ?? undefined }} />
        </RowGroup>
      </div>

      <div className="sticky bottom-0 z-10 mt-auto space-y-2 rounded-b-panel border-t border-line bg-flat/90 p-3 backdrop-blur-xl">
        <LocalTimeLine modelId={effectiveId} count={count} references={refsIgnored ? 0 : readyRefs.length} resolution={quality.resolution ?? undefined} ratio={size.width / size.height} />
        <CostLine
          modelId={effectiveId}
          input={{ output: "image", count, ratio, ...quality.cost }}
          quote={{ output: "image", aspect: shotAspect, aspectValue: chosenShape?.value ?? null, count, images: readyRefs.length, resolution: quality.resolution, quality: quality.quality }}
        />
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="lip squircle flex h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
        >
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
          Generate
        </button>
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="min-h-5 text-[12.5px]" aria-live="polite">
            {notice ? (
              <span className={notice.tone === "error" ? "text-tally" : "text-tungsten"}>{notice.text}</span>
            ) : needsRef ? (
              <span className="text-tungsten">This model edits pictures: add a reference image.</span>
            ) : refsIgnored ? (
              <span className="text-tungsten">This model makes images from words only; your references won&rsquo;t be used.</span>
            ) : dragging ? (
              <span className="text-spike">Drop to add as references</span>
            ) : (
              <span className="text-haze">Enter to generate · Shift+Enter for a new line</span>
            )}
          </p>
          <button
            type="button"
            onClick={stageInDirector}
            className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-fog hover:text-paper"
          >
            <Clapperboard size={14} className="text-spike" />
            Stage it in Director
          </button>
        </div>
      </div>
    </Panel>
  );
}
