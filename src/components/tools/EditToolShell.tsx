"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ImagePlus, LoaderCircle, Minus, Plus, TriangleAlert, X } from "lucide-react";
import type { Tool } from "@/lib/tools";
import type { Generation, ReferenceRef } from "@/lib/generations/types";
import type { ModelKind } from "@/lib/models/catalog";
import { ASPECTS, type AspectId } from "@/lib/shot";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { ToolTile } from "@/components/ui/ToolTile";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RecDot } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine, usePricing } from "@/components/models/CostLine";
import { LocalTimeLine } from "@/components/models/LocalTimeLine";
import { QualityPicker, hasQualityChoices, useOutputQuality } from "@/components/models/QualityPicker";
import { resolveAuto, resolveAutoId, useModels } from "@/lib/hooks/use-models";
import { isCustomModel, useModelInfo } from "@/lib/hooks/use-custom-models";
import { imageSlots, type Caps, type ModelTask } from "@/lib/models/caps";
import Link from "next/link";
import { CompareView } from "./CompareView";
import { SourcePicker, type SourceImage } from "./SourcePicker";
import { PicturePicker } from "@/components/media/PicturePicker";
import { cn } from "@/lib/cn";
import { Media } from "@/components/ui/Media";
import { useModelParam } from "@/lib/hooks/use-model-param";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";

export type Compiled = {
  prompt: string;
  /** Short human summary for the library card. */
  summary: string;
  extraRefs?: ReferenceRef[];
  /** Send exactly these pictures instead of the original plus `extraRefs` (for models that take fewer). */
  refs?: ReferenceRef[];
  params?: Record<string, unknown>;
};

/** The model a tool will run (Auto already resolved) and what it accepts, when known. */
export type ToolModel = { id: string | null; caps: Caps | null };

/** What the Custom tab lists for each kind of transform. */
const TASK: Partial<Record<ModelKind, ModelTask>> = { image: "edit", upscale: "upscale", reframe: "reframe" };

export function nearestAspect(width: number, height: number): AspectId {
  const r = width / height;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? a : best)).id;
}

function loadSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1024, height: 1024 });
    img.src = url;
  });
}

/**
 * Layout shared by tools that transform one image: settings on the left, the before/after
 * on the right.
 */
export function EditToolShell({
  tool,
  hint,
  kind = "image",
  controls,
  compile,
  stageOverlay,
  stage,
  actionLabel = "Generate",
  ready = true,
  allowTakes = true,
  prefer,
  task,
  edits,
  upscaleBy,
}: {
  tool: Tool;
  hint: string;
  kind?: ModelKind;
  /** Tool settings. `modelId` is the model that will run (Auto already resolved); `caps` what it accepts. */
  controls: (source: SourceImage | null, modelId: string | null, caps: Caps | null) => ReactNode;
  compile: (source: SourceImage, model: ToolModel) => Promise<Compiled> | Compiled;
  stageOverlay?: (source: SourceImage) => ReactNode;
  /** Replaces the before/after on the right; gets it (and the result shown) to place beside its own view. */
  stage?: (source: SourceImage, output: { compare: ReactNode; result: string | null }) => ReactNode;
  /** The button's words; a function gets the model that will run (an upscaler's own factors, say). */
  actionLabel?: string | ((model: ToolModel) => string);
  /** Whether the tool has what it needs to run (a function gets the picture shown). */
  ready?: boolean | ((source: SourceImage) => boolean);
  allowTakes?: boolean;
  /** Models this tool's Auto tries first, after your saved default. */
  prefer?: string[];
  /** The Custom tab's list, when it differs from the kind's (Retouch adds inpainting models). */
  task?: ModelTask;
  /** How many model calls one take makes (Retouch edits each change on its own), for the price. */
  edits?: (source: SourceImage) => number;
  /** An upscale's factor with the model that will run, for its time (the work grows with the picture and the factor). */
  upscaleBy?: (model: ToolModel) => number | null;
}) {
  const { items, submit, cancel } = useGenerations();
  const { models, defaults, loaded: modelsLoaded } = useModels();
  const [source, setSource] = useState<SourceImage | null>(null);
  // Your pick for this job; a different job (upscale vs reframe) has its own (hooks/use-model-choice).
  const [model, setModel] = useModelChoice(kind, task ?? TASK[kind]);
  useModelParam(setModel);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  // An image sent from another page (e.g. "Relight" on a Home result) becomes the source.
  useEffect(() => {
    const draft = useHandoff.getState().take();
    const ref = draft?.references[0];
    if (!ref) return;
    void loadSize(ref.url).then((s) => setSource({ url: ref.url, name: ref.name, ...s }));
  }, []);

  // The model that will run: what you picked, or what Auto resolves to. A Custom-tab default is used
  // only when it can take the picture this tool edits; otherwise Auto falls back to Crackio's own pick.
  const autoId = model === "auto" ? resolveAutoId(kind, models, defaults, prefer) : null;
  const autoInfo = useModelInfo(autoId && isCustomModel(autoId) ? autoId : null);
  const autoUnfit = Boolean(autoId && isCustomModel(autoId) && autoInfo.caps && imageSlots(autoInfo.caps) === 0);
  const effectiveId = model === "auto" ? (autoUnfit ? (resolveAuto(kind, models, defaults, prefer)?.id ?? null) : autoId) : model;
  const info = useModelInfo(effectiveId);
  // Edits can pick the resolution and quality they come out at (upscales and reframes have their own settings).
  const quality = useOutputQuality(kind === "image" ? info.caps : null);
  const pricing = usePricing(effectiveId);
  const noModel = modelsLoaded && !effectiveId && !isCustomModel(model);

  const takes = useMemo(
    () => (source ? items.filter((g) => g.tool === tool.slug && g.params?.sourceUrl === source.url) : []),
    [items, source, tool.slug],
  );
  const latest = takes.find((g) => g.status === "done");
  const shown = viewing ?? latest?.outputs[0]?.url ?? null;
  const live = takes.filter((g) => g.status === "queued" || g.status === "running");
  const failed = takes[0]?.status === "error" ? takes[0] : null;

  async function upload(file?: File) {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body });
    const data = (await res.json()) as { items?: { url: string; width: number; height: number }[]; error?: string };
    if (!res.ok || !data.items?.[0]) return setError(data.error ?? "Upload failed");
    setSource({ ...data.items[0], name: file.name });
    setViewing(null);
  }

  async function run() {
    if (!source || busy) return;
    // Nothing chosen yet: the model library opens to choose one.
    if (model === "auto") return void askForModel(kind);
    setBusy(true);
    setError(null);
    try {
      const c = await compile(source, { id: effectiveId, caps: info.caps });
      await submit({
        tool: tool.slug,
        prompt: c.summary,
        compiledPrompt: c.prompt || undefined,
        aspect: nearestAspect(source.width, source.height),
        count: allowTakes ? count : 1,
        // Auto is sent as the model it resolved to here (a tool's own favorites, or a default this tool can't use, are unknown to the server).
        model: model === "auto" ? (effectiveId ?? "auto") : model,
        refine: false,
        references: c.refs ?? [{ url: source.url, label: "the original image", role: "edit-target" }, ...(c.extraRefs ?? [])],
        params: { kind, sourceUrl: source.url, ...c.params, options: { ...quality.options, ...(c.params?.options as Record<string, unknown> | undefined) } },
      });
      setViewing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex items-start gap-3">
        <ToolTile icon={tool.icon} hue={tool.hue} size={36} className="mt-1" />
        <div className="min-w-0">
          <h1 className="font-display text-[30px] sm:text-[34px]">{tool.name}</h1>
          <p className="mt-1 max-w-[70ch] text-[15px] leading-relaxed text-haze">{tool.description}</p>
        </div>
      </header>

      <div className="mt-7 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
        <Panel className="flex flex-col">
          <PanelHeader title="Settings" />
          <div className="space-y-4 p-3">
            <ModelPicker kind={kind} task={task ?? TASK[kind]} value={model} onChange={setModel} prefer={prefer} />
            {noModel ? (
              <p className="rounded-[12px] bg-tungsten/10 px-3.5 py-3 text-[13px] leading-relaxed text-tungsten shadow-[inset_0_0_0_1px_rgb(242_181_75/0.25)]">
                {kind === "upscale" ? "Upscaling needs an upscale model." : "This tool needs a picture model."} Install a free one on your GPU in{" "}
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

            <div className="squircle flex items-center gap-3 rounded-[16px] p-2 pr-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
              {source ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source.url} alt="" className="h-11 w-14 shrink-0 rounded-[8px] object-cover" />
              ) : (
                <span className="grid h-11 w-14 shrink-0 place-items-center rounded-[8px] bg-apple-2 text-haze">
                  <ImagePlus size={16} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-haze">Image</span>
                <span className="block truncate text-[14px] font-semibold">
                  {source ? `${source.width}×${source.height}` : "None yet"}
                </span>
              </span>
              {/* Your latest pictures first, then your computer. */}
              <PicturePicker
                roles={[{ id: "source", label: "Picture to work on" }]}
                placement="bottom-end"
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    className="press squircle rounded-[10px] bg-white/[0.06] px-3 py-1.5 text-[12.5px] font-semibold hover:bg-white/[0.1] aria-expanded:bg-white/[0.1]"
                  >
                    {source ? "Change" : "Add"}
                  </button>
                )}
                onPick={(_, [p]) => {
                  if (!p) return;
                  setViewing(null);
                  if (p.width && p.height) return setSource({ url: p.url, name: p.name, width: p.width, height: p.height });
                  void loadSize(p.url).then((s) => setSource({ url: p.url, name: p.name, ...s }));
                }}
                onUpload={(_, files) => void upload(files[0])}
              />
              {source ? (
                <button
                  onClick={() => {
                    setSource(null);
                    setViewing(null);
                  }}
                  className="press squircle grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.06] hover:text-paper"
                  aria-label="Remove image"
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>

            {controls(source, effectiveId, info.caps)}

            {hasQualityChoices(quality) ? (
              <ControlSection title="Output">
                <QualityPicker
                  q={quality}
                  layout="stack"
                  pricing={pricing}
                  input={{ output: "image", count: 1, ratio: source ? source.width / source.height : undefined, megapixels: source ? Math.min(16, (source.width * source.height) / 1e6) : undefined }}
                />
              </ControlSection>
            ) : null}
          </div>

          {/* Sticks to the bottom of the window on long settings, so the action is always in reach. */}
          <div className="sticky bottom-0 z-10 mt-auto space-y-2 rounded-b-panel border-t border-line bg-flat/90 p-3 backdrop-blur-xl">
            {failed ? (
              <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  {failed.error} {failed.stage ? <span className="text-paper">{failed.stage}</span> : null}
                </span>
              </p>
            ) : null}
            {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
            {source && (kind === "image" || kind === "upscale") ? (
              <LocalTimeLine
                modelId={effectiveId}
                kind={kind}
                count={(allowTakes ? count : 1) * Math.max(1, edits ? edits(source) : 1)}
                references={1}
                edit={kind === "image"}
                {...(kind === "upscale"
                  ? { source: { width: source.width, height: source.height }, scale: upscaleBy?.({ id: effectiveId, caps: info.caps }) ?? undefined }
                  : { resolution: quality.resolution ?? undefined, ratio: source.width / source.height })}
              />
            ) : null}
            {source ? (
              <CostLine
                modelId={effectiveId}
                noun={costNoun(kind, allowTakes ? count : 1, edits ? edits(source) : 1)}
                input={{ output: "image", count: (allowTakes ? count : 1) * Math.max(1, edits ? edits(source) : 1), megapixels: Math.min(16, (source.width * source.height) / 1e6), ratio: source.width / source.height, ...quality.cost }}
                quote={{ output: "image", aspect: nearestAspect(source.width, source.height), count: (allowTakes ? count : 1) * Math.max(1, edits ? edits(source) : 1), images: 1, resolution: quality.resolution, quality: quality.quality }}
              />
            ) : null}
            <div className="flex items-center gap-2">
              {allowTakes ? (
                <div className="squircle flex h-12 items-center rounded-[16px] bg-white/[0.05]" title="How many takes">
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
              ) : null}
              <button
                onClick={() => void run()}
                disabled={!source || busy || !(typeof ready === "function" ? ready(source) : ready) || noModel || (isCustomModel(effectiveId) && info.loading)}
                className="lip squircle flex h-12 flex-1 items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
              >
                {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
                {source ? (typeof actionLabel === "function" ? actionLabel({ id: effectiveId, caps: info.caps }) : actionLabel) : "Add an image first"}
              </button>
            </div>
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
          <div className="relative h-[62vh] min-h-[320px] p-4 lg:h-auto lg:min-h-0 lg:flex-1">
            {source ? (
              stage ? (
                stage(source, { compare: <CompareView before={source.url} after={shown} ratio={source.width / source.height} />, result: shown })
              ) : (
                <CompareView before={source.url} after={shown} ratio={source.width / source.height} overlay={stageOverlay ? stageOverlay(source) : null} />
              )
            ) : (
              <SourcePicker onPick={setSource} hint={hint} />
            )}
            {source && live.length ? (
              <GeneratingField
                className="inset-4 rounded-[16px]"
                stage={live[0].stage}
                progress={live[0].progress}
                prompt={live[0].prompt}
                since={live[0].createdAt}
                backdrop={source.url}
                onCancel={() => cancel(live[0].id)}
              />
            ) : null}
          </div>
          {takes.length ? (
            <div className="scrollbar-none strip-fade flex gap-2 overflow-x-auto border-t border-line p-3 pr-9">
              {takes.map((g) => (
                <TakeChip key={g.id} gen={g} active={g.outputs[0]?.url === shown} onClick={() => setViewing(g.outputs[0]?.url ?? null)} />
              ))}
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/** "this edit", "these 2 edits", "this retouch (3 edits)". */
function costNoun(kind: ModelKind, takes: number, edits: number) {
  if (kind === "upscale") return "this upscale";
  if (kind === "reframe") return "this reframe";
  if (edits > 1) return takes > 1 ? `these ${takes} takes (${edits} edits each)` : `this retouch (${edits} edits)`;
  return takes > 1 ? `these ${takes} edits` : "this edit";
}

function TakeChip({ gen, active, onClick }: { gen: Generation; active: boolean; onClick: () => void }) {
  const out = gen.outputs[0];
  const live = gen.status === "queued" || gen.status === "running";
  return (
    <button
      onClick={onClick}
      disabled={!out}
      className={cn(
        "press squircle relative h-14 w-20 shrink-0 overflow-hidden rounded-[11px] bg-apple hover:brightness-110",
        active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line)]",
      )}
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

export function ControlSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="label">{title}</h2>
        {hint ? <span className="text-[11.5px] text-haze">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
