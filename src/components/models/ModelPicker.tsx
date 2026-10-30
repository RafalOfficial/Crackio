"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, LayoutGrid, Sparkles } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { Row } from "@/components/ui/Panel";
import { VendorMark } from "@/components/brand/BrandMark";
import { resolveAuto, revalidateModels, useModels } from "@/lib/hooks/use-models";
import { ASK, type ModelAsk } from "@/lib/hooks/use-model-choice";
import { prefetchLocal } from "@/lib/hooks/use-local";
import { isCustomModel, useCustomModels } from "@/lib/hooks/use-custom-models";
import { engineShortName } from "@/lib/providers/names";
import { capsFit, type Caps, type ModelTask } from "@/lib/models/caps";
import { cardName } from "@/lib/models/gallery";
import type { ModelAvailability, ModelKind } from "@/lib/models/catalog";
import type { CustomRow } from "@/lib/models/custom-types";
import type { ProviderId } from "@/lib/providers/types";
import { formatSeconds } from "@/lib/local/fit";
import { localJob } from "@/lib/local/work";
import { ModelLibrary } from "./ModelLibrary";
import { cn } from "@/lib/cn";

// Real company logos now live in components/brand/BrandMark; re-exported for existing imports.
export { VendorMark };

const SPEED = { fast: "Fast", medium: "Balanced", slow: "Best quality" } as const;

/** What each kind of picker's models must do, unless a tool says otherwise. */
const DEFAULT_TASK: Partial<Record<ModelKind, ModelTask>> = { image: "image", video: "video", upscale: "upscale", reframe: "reframe" };

/** Kinds whose models have something to show open the model library; prompt writers and the one reframe model keep a short list. */
const LIBRARY: ModelKind[] = ["image", "video", "upscale"];

/** One picker a page draws the library ahead (ModelLibrary `warm`). */
let warmClaimed = false;

/**
 * Choose which model runs a job. Picture, video and upscale models open the model library (ModelLibrary): a card per
 * model with its preview, on your GPUs and Comfy Cloud, and open models to install. They're always your
 * choice: with nothing chosen ("auto", see hooks/use-model-choice) the trigger says "Choose a model". Prompt writers keep
 * a short list, where "Auto" uses your saved default, then the first ready model.
 */
export function ModelPicker({
  kind,
  value,
  onChange,
  className,
  chipClassName,
  placement = "bottom-start",
  variant = "row",
  label = "Model",
  prefer,
  task: taskProp,
  only,
  noAuto = false,
  featured,
  tags,
  fit,
  fits,
  surface,
  library: libraryProp = false,
}: {
  kind: ModelKind;
  value: string;
  onChange: (id: string) => void;
  className?: string;
  /** Restyles the "chip" variant's button (the Home composer's glass chips). */
  chipClassName?: string;
  /** Where the short list opens (prompt writers, reframe); the library always comes from the right. */
  placement?: "top-start" | "bottom-start" | "bottom-end" | "top-end";
  /** "row" fills its column (tool panels); "chip" is a compact pill for composers; "setting" sits in a RowGroup. */
  variant?: "row" | "chip" | "setting";
  /** Label for the "setting" variant. */
  label?: string;
  /** Models this tool's Auto tries first (after your saved default). */
  prefer?: string[];
  /** What the tool needs from a model (an edit model, a clip editor…). */
  task?: ModelTask;
  /** Limit the list to these models (Recast: only Grok's clip editor can edit). */
  only?: string[];
  /** Hide "Auto" in the short lists (prompt writers). Picture, video and upscale pickers never offer Auto. */
  noAuto?: boolean;
  /** Models from providers' catalogs (fal:…, comfy:…) that suit this tool best, listed first. */
  featured?: string[];
  /** A word or two on why a featured model is listed ("Best value"), by id. */
  tags?: Record<string, string>;
  /** How well each model fits what's being made (Templates: how much of the clip it takes), shown on its card. */
  fit?: (id: string, caps: Caps | null) => ClipFit | null;
  /** Models this tool's Auto can run (Cast: only ones that take pictures); the server must pick with the same rule. */
  fits?: (m: ModelAvailability) => boolean;
  /** "glass": the library is smoked glass, like Home's composer it opens from. Tool pages keep the solid sheet. */
  surface?: "glass";
  /** A text picker that opens the model library too (Motion). Its "auto" still means the model Auto uses, shown by name. */
  library?: boolean;
}) {
  const { models, defaults, loaded } = useModels();
  const task = taskProp ?? DEFAULT_TASK[kind];
  // Models a tool names in `only` are shown as they are; others only when what they take fits the task
  // (the clip-only swap model isn't offered where there's no clip).
  const list = useMemo(
    () => models.filter((m) => m.kind === kind && (!only || only.includes(m.id)) && (!task || only?.includes(m.id) || !m.caps || capsFit(m.caps, task))),
    [models, kind, only, task],
  );
  const auto = resolveAuto(kind, models, defaults, prefer, fits);
  const custom = isCustomModel(value);
  // A provider-catalog model saved as the default is what Auto runs.
  const savedCustom = isCustomModel(defaults[kind]) ? defaults[kind]! : null;
  const customId = custom ? value : value === "auto" ? savedCustom : null;
  const customRow = useCustomModels((s) => (customId ? s.rows[customId] : undefined));
  const savedRow = useCustomModels((s) => (savedCustom ? s.rows[savedCustom] : undefined));
  useEffect(() => {
    for (const id of [customId, savedCustom]) if (id && !useCustomModels.getState().rows[id]) void useCustomModels.getState().load(id);
  }, [customId, savedCustom]);
  const rows = useCustomModels((s) => s.rows);
  const featuredKey = featured?.join("|") ?? "";
  useEffect(() => {
    for (const id of featuredKey ? featuredKey.split("|") : []) if (!useCustomModels.getState().rows[id]) void useCustomModels.getState().load(id);
  }, [featuredKey]);
  const picks = useMemo(() => (featuredKey ? featuredKey.split("|") : []).map((id) => rows[id]).filter((r): r is CustomRow => Boolean(r)), [featuredKey, rows]);

  // Picture, video and upscale models are always chosen by you: "auto" there means nothing is chosen yet.
  const library = LIBRARY.includes(kind) || libraryProp;
  const unchosen = LIBRARY.includes(kind) && value === "auto";
  const selected = value === "auto" ? null : (list.find((m) => m.id === value) ?? null);
  // A recommended model can also be one of Crackio's own (Kling Omni on Router) outside this tool's list.
  const pick = (featured ?? []).includes(value) ? rows[value] : undefined;
  const shown: { name: string; vendor: string; via: ProviderId | null } | null = unchosen
    ? null
    : customId
      ? { name: customRow?.name ?? "Custom model", vendor: customRow?.vendor ?? "fal", via: customRow?.provider ?? null }
      : pick
        ? { name: pick.name, vendor: pick.vendor, via: pick.provider }
        : (selected ?? auto);
  const autoDetail = savedCustom ? `Uses your default, ${savedRow?.name ?? "a custom model"}` : auto ? `Uses ${cardName(auto.name)} right now` : "Picks the first ready model";

  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // The trigger's box: the library opens inside the dialog it sits in, when it does.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);

  // Generate pressed with nothing chosen: this picker's library opens (the first picker of the kind on the page).
  useEffect(() => {
    if (!unchosen) return;
    const ask = (e: Event) => {
      const want = (e as CustomEvent<ModelAsk>).detail;
      if (want.kind !== kind || want.taken) return;
      want.taken = true;
      setOpen(true);
    };
    window.addEventListener(ASK, ask);
    return () => window.removeEventListener(ASK, ask);
  }, [unchosen, kind]);

  // On its way to the picker, the pointer has the library built (hidden) and your machines loading: a click only slides it in.
  const [primed, setPrimed] = useState(false);
  // The first picker on a page also has it built and drawn once, unseen, while the page is idle (ModelLibrary `warm`).
  const [warmer, setWarmer] = useState(false);
  const [drawAhead, setDrawAhead] = useState(false);
  useEffect(() => {
    if (!library || warmClaimed) return;
    warmClaimed = true;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1500));
    const id = idle(
      () => {
        prefetchLocal();
        setPrimed(true);
        setWarmer(true);
      },
      { timeout: 4000 },
    );
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
      warmClaimed = false;
    };
  }, [library]);
  // Drawn once the models are in and its cards built (a moment after it's built).
  useEffect(() => {
    if (!warmer || !loaded || drawAhead) return;
    const t = setTimeout(() => setDrawAhead(true), 600);
    return () => clearTimeout(t);
  }, [warmer, loaded, drawAhead]);
  const warm = library
    ? () => {
        prefetchLocal();
        revalidateModels();
        setPrimed(true);
      }
    : undefined;
  const none = !loaded ? "Loading…" : unchosen ? "Choose a model" : "None connected";

  const trigger = (isOpen: boolean, toggle: () => void): ReactNode =>
    variant === "setting" ? (
      <Row
        onClick={toggle}
        onPointerEnter={warm}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        thumb={shown ? <VendorMark vendor={shown.vendor} model={shown.name} variant="bare" size={16} /> : <LayoutGrid size={14} className={unchosen ? "text-spike" : "text-haze"} />}
        label={label}
        value={loaded && shown ? cardName(shown.name) : none}
        tags={value === "auto" && !library ? ["Auto"] : shown?.via ? [engineShortName(shown.via)] : undefined}
      />
    ) : variant === "chip" ? (
      <button
        type="button"
        onClick={toggle}
        onPointerEnter={warm}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Model"
        className={cn(
          "press inline-flex h-9 max-w-[240px] items-center gap-2 rounded-chip bg-apple-2 pl-2.5 pr-2.5 text-[13px] font-semibold text-paper hover:bg-gaffer",
          isOpen && "bg-gaffer",
          chipClassName,
        )}
      >
        {shown ? <VendorMark vendor={shown.vendor} model={shown.name} variant="bare" size={15} /> : <LayoutGrid size={14} className={unchosen ? "text-spike" : "text-haze"} />}
        <span className={cn("truncate", unchosen && loaded && "text-spike")}>{!loaded ? "Models…" : shown ? cardName(shown.name) : unchosen ? "Choose a model" : "No model"}</span>
        <ChevronDown size={13} className={cn("shrink-0 text-haze transition-transform", isOpen && "rotate-180")} />
      </button>
    ) : (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onPointerEnter={warm}
        className={cn(
          "press squircle flex h-12 w-full items-center gap-2.5 rounded-[14px] pl-2 pr-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]",
          isOpen && "bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
          unchosen && loaded && "shadow-[inset_0_0_0_1px_rgb(255_91_46/0.45)] hover:bg-spike/[0.05]",
        )}
      >
        {shown ? (
          <VendorMark vendor={shown.vendor} model={shown.name} size={32} />
        ) : (
          <span className="brand-tile squircle grid size-8 shrink-0 place-items-center rounded-[10px]">
            <LayoutGrid size={15} className={unchosen ? "text-spike" : "text-haze"} />
          </span>
        )}
        <span className={cn("min-w-0 flex-1 truncate text-[14px] font-semibold", unchosen && loaded && "text-spike")}>
          {!loaded && !custom ? "Loading models…" : shown ? cardName(shown.name) : unchosen ? "Choose a model" : "No model connected"}
        </span>
        {value === "auto" && !library ? <span className="text-[12px] text-haze">Auto</span> : null}
        {shown?.via ? <span className="rounded-[6px] bg-apple-2 px-1.5 py-0.5 text-[11px] text-fog">{engineShortName(shown.via)}</span> : null}
        {library ? <ChevronRight size={15} className="shrink-0 text-haze" /> : <ChevronDown size={15} className={cn("shrink-0 text-haze transition-transform", isOpen && "rotate-180")} />}
      </button>
    );

  if (library) {
    return (
      // Keyboard users get the library built as they reach the picker too.
      <div ref={setAnchor} onFocus={warm} className={cn("relative", className)}>
        {trigger(open, () => setOpen((o) => !o))}
        <ModelLibrary
          open={open}
          primed={primed}
          warm={drawAhead}
          onClose={close}
          anchor={anchor}
          kind={kind}
          task={task}
          // A text picker on Auto shows the model Auto uses as the chosen card.
          value={value === "auto" && !unchosen ? (auto?.id ?? value) : value}
          onChange={onChange}
          list={list}
          picks={picks}
          tags={tags}
          fit={fit}
          glass={surface === "glass"}
        />
      </div>
    );
  }

  const available = list.filter((m) => m.available);
  // One row per model name: the same model through two connections reads as a duplicate.
  const unavailable = list.filter((m, i) => !m.available && !list.some((x, j) => j < i && !x.available && x.name === m.name));
  return (
    <Popover placement={placement} className={className} panelClassName="w-[min(440px,calc(100vw-32px))] p-1.5" trigger={({ open: isOpen, toggle }) => trigger(isOpen, toggle)}>
      {(close) => (
        <div className="flex max-h-[min(560px,calc(var(--popover-max-h,70vh)-16px))] flex-col">
          <div role="listbox" aria-label="Model" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {noAuto ? null : (
              <ModelOption
                selected={value === "auto"}
                onSelect={() => {
                  onChange("auto");
                  close();
                }}
                title="Auto"
                detail={autoDetail}
                mark={
                  <span className="brand-tile squircle grid size-9 place-items-center rounded-[11px]">
                    <Sparkles size={16} className="text-spike" />
                  </span>
                }
              />
            )}
            {available.length ? <p className="label px-2.5 pb-1 pt-3">Ready</p> : null}
            {available.map((m) => (
              <ModelRow
                key={m.id}
                m={m}
                fit={fit?.(m.id, m.caps ?? null)}
                selected={value === m.id}
                onSelect={() => {
                  onChange(m.id);
                  close();
                }}
              />
            ))}
            {unavailable.length ? <p className="label px-2.5 pb-1 pt-3">Needs a connection</p> : null}
            {unavailable.map((m) => (
              <ModelRow key={m.id} m={m} fit={fit?.(m.id, m.caps ?? null)} selected={false} disabled onSelect={() => {}} />
            ))}
          </div>
          <div className="mt-1.5 flex shrink-0 items-center justify-between border-t border-line px-2.5 pb-1 pt-2.5 text-[12px]">
            <Link href="/settings/models" onClick={close} className="font-semibold text-fog hover:text-paper">
              Set defaults
            </Link>
            <Link href="/settings/connections" onClick={close} className="font-semibold text-fog hover:text-paper">
              Connect more
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** What a model says about fitting the job: green when it fits all of it, amber when only part. */
export type ClipFit = { text: string; whole: boolean | null };

function FitNote({ fit }: { fit: ClipFit }) {
  return (
    <span className={cn("mt-0.5 flex min-w-0 items-center gap-1 text-[11.5px] font-semibold", fit.whole === true ? "text-chroma" : fit.whole === false ? "text-tungsten" : "text-fog")}>
      {fit.whole === true ? <Check size={11} className="shrink-0" /> : null}
      <span className="truncate">{fit.text}</span>
    </span>
  );
}

function ModelRow({ m, fit, selected, disabled, onSelect }: { m: ModelAvailability; fit?: ClipFit | null; selected: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <ModelOption
      selected={selected}
      disabled={disabled}
      onSelect={onSelect}
      title={m.name}
      mark={<VendorMark vendor={m.vendor} model={m.name} size={36} active={selected} />}
      detail={disabled ? (m.reason ?? "Unavailable") : m.bestFor}
      fit={fit}
      meta={
        <>
          <span>{m.vendor}</span>
          {m.via ? <span>· {engineShortName(m.via)}</span> : null}
          {/* A local model's time on the machine that runs it: "fast" means nothing on a 6 GB card. */}
          <span>· {m.localTime ? `${m.localTime.measured ? "" : "~"}${formatSeconds(m.localTime.seconds)} ${localJob(m.kind)} on ${m.localTime.gpu}` : SPEED[m.speed]}</span>
          {m.kind === "image" ? <span>· {m.maxRefs ? `${m.maxRefs} refs` : "text only"}</span> : null}
        </>
      }
    />
  );
}

function ModelOption({
  selected,
  disabled,
  onSelect,
  title,
  detail,
  meta,
  mark,
  fit,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  detail?: string;
  meta?: React.ReactNode;
  mark: React.ReactNode;
  fit?: ClipFit | null;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "squircle flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
        selected ? "bg-white/[0.07]" : "hover:bg-white/[0.045] active:bg-white/[0.07]",
      )}
    >
      <span className="grid shrink-0 place-items-center">{mark}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-paper">
          {title}
          {selected ? <Check size={13} className="text-spike" /> : null}
        </span>
        {meta ? <span className="mt-0.5 flex flex-wrap gap-x-1 text-[11.5px] text-haze">{meta}</span> : null}
        {detail ? <span className="mt-0.5 block text-[12px] leading-snug text-fog">{detail}</span> : null}
        {fit ? <FitNote fit={fit} /> : null}
      </span>
    </button>
  );
}
