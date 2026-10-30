"use client";

import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Check, Copy, Download, LoaderCircle, Trash, TriangleAlert } from "lucide-react";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { toolBySlug } from "@/lib/tools";
import { useGenerationsStore } from "@/lib/hooks/use-generations";
import { Osd } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { Media } from "@/components/ui/Media";

/** Picking several takes at once (the Library). */
export type CardSelect = { active: boolean; selected: boolean; onToggle: (e: MouseEvent) => void };

/**
 * One output (or the in-progress placeholder) of a generation. It redraws only when its own take
 * (or what it's handed) changes, not when another take in the list ticks forward.
 */
export const GenerationCard = memo(function GenerationCard({
  gen,
  index = 0,
  onRemove,
  actions,
  select,
}: {
  gen: Generation;
  index?: number;
  /** Replaces the plain delete (the Library also forgets where the take was filed). */
  onRemove?: (id: string) => void;
  /** More buttons for the hover bar, before Copy. */
  actions?: ReactNode;
  select?: CardSelect;
}) {
  const removeTake = useGenerationsStore((s) => s.remove);
  const cancel = useGenerationsStore((s) => s.cancel);
  const remove = onRemove ?? removeTake;
  const [copied, setCopied] = useState(false);
  // Delete takes two clicks: the first arms it for a moment, so a stray click never loses a take.
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const output = gen.outputs[index];
  const aspect = aspectById(gen.aspect);
  const ratio = output?.width && output?.height ? output.width / output.height : aspect.w / aspect.h;
  const tool = toolBySlug(gen.tool);
  // Clips from the Video page (and from Motion before it became the agent) aren't a tool in the list.
  const label = gen.tool === "templates" ? "Template" : gen.params?.kind === "video" ? "Video" : (tool?.name ?? "Image");

  if (gen.status === "queued" || gen.status === "running") {
    return (
      <div className="squircle relative overflow-hidden rounded-[16px] bg-apple" style={{ aspectRatio: ratio }}>
        <GeneratingField
          stage={gen.stage}
          progress={gen.progress}
          prompt={gen.prompt || "From references"}
          since={gen.createdAt}
          backdrop={typeof gen.params?.startUrl === "string" ? gen.params.startUrl : gen.references[0]?.url}
          onCancel={() => cancel(gen.id)}
        />
      </div>
    );
  }

  if (gen.status === "error") {
    return (
      <div
        className="squircle relative flex flex-col justify-between rounded-[16px] p-4 shadow-[inset_0_0_0_1px_rgb(255_59_92/0.35)]"
        style={{ aspectRatio: ratio, background: "rgb(255 59 92 / 0.05)" }}
      >
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-tally">
            <TriangleAlert size={15} /> Didn&rsquo;t render
          </div>
          <p className="mt-2 line-clamp-4 text-[12.5px] leading-relaxed text-fog">{gen.error}</p>
          {gen.stage ? <p className="mt-2 text-[12.5px] leading-relaxed text-paper">{gen.stage}</p> : null}
        </div>
        <button
          onClick={() => remove(gen.id)}
          className="press squircle mt-3 inline-flex h-8 w-fit items-center gap-1.5 rounded-[10px] bg-apple-2 px-2.5 text-[12px] text-fog hover:bg-gaffer hover:text-paper"
        >
          <Trash size={13} /> Remove
        </button>
      </div>
    );
  }

  if (!output) return null;

  const picking = select?.active;
  return (
    <figure
      onClick={picking ? select.onToggle : undefined}
      className={cn(
        "squircle group relative overflow-hidden rounded-[16px] bg-apple",
        picking && "cursor-pointer",
        select?.selected && "shadow-[inset_0_0_0_2px_var(--color-spike)]",
      )}
      style={{ aspectRatio: ratio }}
    >
      <Media
        media={output}
        alt={gen.prompt}
        className={cn(
          "size-full object-cover",
          select && "squircle transition-[transform,border-radius] duration-200 ease-[var(--ease-out-quint)]",
          select?.selected && "scale-[0.9] rounded-[12px]",
        )}
      />
      {picking ? (
        <SelectMark selected={select.selected} className="absolute left-3 top-3" />
      ) : (
        <figcaption className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/75 via-black/10 to-black/30 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
          <div className="flex items-center justify-between gap-2">
            {/* With a check in the corner, the label goes down with the prompt so neither gets cut short. */}
            {select ? (
              <button type="button" onClick={select.onToggle} aria-label="Select this take" title="Select" className="press -m-1 grid shrink-0 place-items-center rounded-full p-1">
                <SelectMark selected={false} />
              </button>
            ) : (
              <Osd className="truncate">
                {label} · {gen.aspect}
              </Osd>
            )}
            <div className="flex shrink-0 gap-1">
              {actions}
              <IconAction
                label={copied ? "Copied" : "Copy prompt"}
                onClick={async () => {
                  if (!(await copyText(gen.compiledPrompt ?? gen.prompt))) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                <Copy size={14} />
              </IconAction>
              <a
                href={output.url}
                download
                className="press squircle grid size-8 place-items-center rounded-[10px] bg-black/55 text-paper hover:bg-black/75"
                aria-label="Download"
              >
                <Download size={14} />
              </a>
              <IconAction
                label={arming ? "Click again to delete" : "Delete"}
                danger={arming}
                onClick={() => {
                  if (arming) return void remove(gen.id);
                  setArming(true);
                  clearTimeout(disarm.current);
                  disarm.current = setTimeout(() => setArming(false), 2600);
                }}
              >
                {arming ? <span className="px-1 text-[12px] font-bold">Delete?</span> : <Trash size={14} />}
              </IconAction>
            </div>
          </div>
          <div>
            {select ? (
              <Osd className="mb-1.5 block truncate">
                {label} · {gen.aspect}
              </Osd>
            ) : null}
            <p className="line-clamp-3 text-[12.5px] leading-snug text-paper/90">{gen.prompt || gen.compiledPrompt}</p>
          </div>
        </figcaption>
      )}
    </figure>
  );
});

/** The round check in a card's corner. */
function SelectMark({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-[22px] place-items-center rounded-full transition-[background-color,box-shadow] duration-150",
        selected
          ? "bg-spike text-spike-ink shadow-[0_1px_4px_rgb(0_0_0/0.45)]"
          : "bg-black/30 text-transparent shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.85),0_1px_4px_rgb(0_0_0/0.35)] hover:bg-white/20",
        className,
      )}
    >
      <Check size={13} strokeWidth={3} />
    </span>
  );
}

export function IconAction({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "press squircle grid h-8 min-w-8 place-items-center rounded-[10px] text-paper",
        danger ? "bg-tally hover:bg-tally" : "bg-black/55 hover:bg-black/75",
      )}
    >
      {children}
    </button>
  );
}

export function GenerationSpinner() {
  return <LoaderCircle className="animate-spin" size={16} />;
}
