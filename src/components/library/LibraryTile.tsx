"use client";

/* eslint-disable @next/next/no-img-element */
import { memo, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Check, Copy, Download, Ellipsis, FolderInput, Maximize2, Play, Trash, TriangleAlert } from "lucide-react";
import type { TakeKey } from "@/lib/hooks/use-library";
import type { ProjectInput } from "@/lib/library/types";
import { posterUrl, previewSrcSet, previewUrl } from "@/lib/media-url";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { Osd } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { Popover } from "@/components/ui/Popover";
import { MoveMenu } from "./MoveMenu";
import type { FolderInfo } from "./folders";
import { clock, download, downloadName, toolName, type Take } from "./takes";

/** What picking needs from a click or a key press: Shift, and a way to stop it going further. */
export type PickEvent = { shiftKey: boolean; preventDefault: () => void; stopPropagation: () => void };

export type TileHandlers = {
  open: (key: TakeKey) => void;
  toggle: (key: TakeKey, e: PickEvent) => void;
  startDrag: (e: DragEvent<HTMLDivElement>, key: TakeKey) => void;
  endDrag: () => void;
  remove: (id: string) => void;
  cancel: (id: string) => void;
  moveTo: (keys: TakeKey[], id: string) => void;
  createAndMove: (input: ProjectInput, keys: TakeKey[]) => Promise<void>;
};

/** The light copies a card picks from; `sizes` is the card's own width, so the browser takes the sharp one. */
const WIDTHS = [480, 640, 960, 1280];
/** A clip starts playing once the pointer has rested on it this long, so sweeping across the grid stays still. */
const PLAY_AFTER = 140;

type TileProps = {
  take: Take;
  /** Width over height, as the row lays it out. */
  ratio: number;
  /** In a full row the card grows to its share; in a short last row it keeps `width`. */
  full: boolean;
  /** About how wide the card is, in CSS pixels. */
  width: number;
  selecting: boolean;
  selected: boolean;
  leaving: boolean;
  dragged: boolean;
  folders: FolderInfo[];
  newColor: string;
  on: TileHandlers;
};

/**
 * One take in the grid. A click opens it in the viewer; the corner check picks it; the "…" holds
 * the rest. Nothing covers the picture but a faint shade under those two buttons, and clips sit
 * on their opening frame until you rest the pointer on them. Redraws only when its own take or
 * state changes.
 */
export const LibraryTile = memo(function LibraryTile(props: TileProps) {
  const { take, ratio, full, width } = props;
  const style: CSSProperties = full ? { flex: `${ratio} ${ratio} 0%`, minWidth: 0 } : { width, flex: "none" };
  if (take.gen.status === "queued" || take.gen.status === "running") return <RunningTile take={take} style={style} onCancel={props.on.cancel} />;
  if (take.gen.status === "error") return <FailedTile take={take} style={style} onRemove={props.on.remove} />;
  return <DoneTile {...props} style={style} />;
});

function DoneTile({ take, width, style, selecting, selected, leaving, dragged, folders, newColor, on }: TileProps & { style: CSSProperties }) {
  const { gen, key } = take;
  const output = gen.outputs[take.index];
  const video = take.kind === "video";
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!output) return null;

  const hover = (entering: boolean) => {
    if (!video) return;
    clearTimeout(timer.current);
    if (entering) timer.current = setTimeout(() => setLive(true), PLAY_AFTER);
    else setLive(false);
  };
  const sizes = `${Math.max(120, Math.round(width))}px`;
  const label = `${video ? "Clip" : "Image"}${gen.prompt ? `: ${gen.prompt.slice(0, 90)}` : ""}`;

  return (
    <div
      data-take={key}
      role="button"
      tabIndex={0}
      aria-label={selecting ? `${selected ? "Unpick" : "Pick"} ${label}` : `Open ${label}`}
      aria-pressed={selecting ? selected : undefined}
      draggable
      onDragStart={(e) => {
        hover(false);
        on.startDrag(e, key);
      }}
      onDragEnd={on.endDrag}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onClick={(e) => {
        // Clicks in its menu (drawn elsewhere on the page) reach here too: only the card's own count.
        if (!e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest("button, a")) return;
        // Picking: in Select, or Ctrl-, Cmd- or Shift-click any time.
        if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) return on.toggle(key, e);
        on.open(key);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        if (selecting) on.toggle(key, e);
        else on.open(key);
      }}
      className={cn(
        "lib-tile group/tile squircle relative overflow-hidden rounded-[12px] bg-apple",
        selecting ? "cursor-pointer" : "cursor-zoom-in",
        leaving && "take-leaving",
        dragged && "opacity-40",
      )}
      style={style}
    >
      <div
        className={cn(
          "squircle absolute inset-0 overflow-hidden transition-[transform,border-radius] duration-200 ease-[var(--ease-out-quint)]",
          selected && "scale-[0.93] rounded-[9px]",
        )}
      >
        {video ? (
          <>
            <Poster url={output.url} sizes={sizes} alt={label} />
            {live ? <HoverPlay url={output.url} /> : null}
          </>
        ) : (
          <img
            src={previewUrl(output.url, 640)}
            srcSet={previewSrcSet(output.url, WIDTHS)}
            sizes={sizes}
            alt={label}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full object-cover"
          />
        )}
      </div>

      {/* A hairline that brightens on hover; the spike ring when picked. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[inherit] transition-shadow duration-150",
          selected ? "shadow-[inset_0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] group-hover/tile:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.24)]",
        )}
      />

      {video ? (
        <span className="pointer-events-none absolute bottom-2 left-2 inline-flex h-[22px] items-center gap-1 rounded-[7px] bg-black/60 pl-1.5 pr-2 text-paper">
          <Play size={9} fill="currentColor" strokeWidth={0} />
          <Osd className="tabular text-paper/90">{output.duration ? clock(output.duration) : "Clip"}</Osd>
        </span>
      ) : null}

      {selecting ? (
        <SelectMark selected={selected} className="pointer-events-none absolute left-2.5 top-2.5" />
      ) : (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/50 via-black/15 to-transparent p-2 pb-7 transition-opacity duration-150",
            // Up while hovered or focused, and while its menu is open.
            "opacity-0 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100 group-has-[[data-popover-open]]/tile:opacity-100 focus-within:opacity-100",
          )}
        >
          <button
            type="button"
            onClick={(e) => on.toggle(key, e)}
            aria-label="Pick this take"
            title="Pick (or Ctrl-click)"
            className="press pointer-events-auto grid place-items-center rounded-full p-0.5"
          >
            <SelectMark selected={false} />
          </button>
          <Popover
            placement="bottom-end"
            className="pointer-events-auto"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                onClick={toggle}
                aria-label="More"
                title="More"
                aria-expanded={open}
                aria-controls={id}
                data-popover-open={open || undefined}
                className={cn("press squircle grid size-8 place-items-center rounded-[10px] text-paper", open ? "bg-black/80" : "bg-black/55 hover:bg-black/75")}
              >
                <Ellipsis size={16} />
              </button>
            )}
          >
            {(close) => <TakeMenu take={take} folders={folders} newColor={newColor} close={close} on={on} />}
          </Popover>
        </div>
      )}
    </div>
  );
}

/** A clip's opening frame, at the width the card needs. */
function Poster({ url, sizes, alt }: { url: string; sizes: string; alt: string }) {
  const still = posterUrl(url, 640);
  // Media that isn't Crackio's has no stills made for it: its own first frame stands in.
  if (!still) return <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-label={alt} className="size-full bg-black object-cover" />;
  return (
    <img
      src={still}
      srcSet={previewSrcSet(url, WIDTHS, "poster")}
      sizes={sizes}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="size-full bg-black object-cover"
    />
  );
}

/** The clip's light copy, playing muted over its still while the pointer rests on the card. */
function HoverPlay({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    void v.play().catch(() => {});
    return () => v.pause();
  }, []);
  return (
    <video
      ref={ref}
      src={previewUrl(url, 640)}
      muted
      loop
      playsInline
      preload="auto"
      draggable={false}
      aria-hidden="true"
      onPlaying={() => setPlaying(true)}
      className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", playing ? "opacity-100" : "opacity-0")}
    />
  );
}

function MenuAction({ onSelect, children, danger }: { onSelect: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "squircle flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left text-[13px] transition-colors duration-150",
        danger ? "bg-tally/15 font-semibold text-tally hover:bg-tally/25" : "text-fog hover:bg-gaffer/60 hover:text-paper active:bg-gaffer",
      )}
    >
      {children}
    </button>
  );
}

/** A card's "…": view, copy, save, file it, or delete it (two clicks). */
function TakeMenu({ take, folders, newColor, close, on }: { take: Take; folders: FolderInfo[]; newColor: string; close: () => void; on: TileHandlers }) {
  const [moving, setMoving] = useState(false);
  const [arming, setArming] = useState(false);
  const output = take.gen.outputs[take.index];
  const prompt = take.gen.compiledPrompt ?? take.gen.prompt;

  if (moving) {
    return (
      <MoveMenu
        folders={folders}
        current={take.folder}
        count={1}
        close={close}
        newColor={newColor}
        onMove={(id) => on.moveTo([take.key], id)}
        onCreate={(input) => on.createAndMove(input, [take.key])}
      />
    );
  }
  return (
    <div role="menu" className="w-[230px]">
      <MenuAction
        onSelect={() => {
          close();
          on.open(take.key);
        }}
      >
        <Maximize2 size={15} /> View
      </MenuAction>
      {prompt ? (
        <MenuAction
          onSelect={() => {
            void copyText(prompt);
            close();
          }}
        >
          <Copy size={15} /> Copy prompt
        </MenuAction>
      ) : null}
      {output ? (
        <MenuAction
          onSelect={() => {
            download(output.url, downloadName(take));
            close();
          }}
        >
          <Download size={15} /> Download
        </MenuAction>
      ) : null}
      <MenuAction onSelect={() => setMoving(true)}>
        <FolderInput size={15} /> Move to&hellip;
      </MenuAction>
      <div className="mx-2.5 my-1.5 h-px bg-line" />
      <MenuAction
        danger={arming}
        onSelect={() => {
          if (!arming) return setArming(true);
          close();
          on.remove(take.gen.id);
        }}
      >
        <Trash size={15} />
        {arming ? (take.gen.outputs.length > 1 ? `Delete all ${take.gen.outputs.length} takes of this run?` : "Click again to delete") : "Delete"}
      </MenuAction>
    </div>
  );
}

/** The round check in a card's corner. */
export function SelectMark({ selected, className }: { selected: boolean; className?: string }) {
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

function RunningTile({ take, style, onCancel }: { take: Take; style: CSSProperties; onCancel: (id: string) => void }) {
  const { gen } = take;
  return (
    <div data-take={take.key} className="squircle relative overflow-hidden rounded-[12px] bg-apple" style={style}>
      <GeneratingField
        stage={gen.stage}
        progress={gen.progress}
        prompt={gen.prompt}
        since={gen.createdAt}
        backdrop={typeof gen.params?.startUrl === "string" ? gen.params.startUrl : gen.references[0]?.url}
        onCancel={() => onCancel(gen.id)}
      />
    </div>
  );
}

/** A run that didn't render: what went wrong, which tool and when, and Remove. Compact, it has no picture. */
export function FailedTile({ take, style, onRemove }: { take: Take; style?: CSSProperties; onRemove: (id: string) => void }) {
  const { gen } = take;
  return (
    <div
      data-take={take.key}
      className="squircle relative flex min-h-[132px] flex-col justify-between overflow-hidden rounded-[12px] p-3.5 shadow-[inset_0_0_0_1px_rgb(255_59_92/0.3)]"
      style={{ ...style, background: "rgb(255 59 92 / 0.05)" }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-tally">
          <TriangleAlert size={15} className="shrink-0" /> Didn&rsquo;t render
          <span className="ml-auto truncate text-[12px] font-medium text-haze">
            {toolName(take.tool)} · {new Date(gen.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-fog">{gen.error}</p>
        {gen.prompt ? <p className="mt-1 truncate text-[12px] text-haze">{gen.prompt}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onRemove(gen.id)}
        className="press squircle mt-2 inline-flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-[10px] bg-apple-2 px-2.5 text-[12px] text-fog hover:bg-gaffer hover:text-paper"
      >
        <Trash size={13} /> Remove
      </button>
    </div>
  );
}
