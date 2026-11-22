"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Clapperboard, ListPlus, LoaderCircle, Music2, Plus, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { useEditor } from "@/lib/storyboard/edit-store";
import { clipFromFile, type EditFile } from "@/lib/storyboard/edit";
import { addMusic, insertMain } from "@/lib/storyboard/edit-ops";
import { useShallow } from "zustand/react/shallow";
import { isLive, useGenerations } from "@/lib/hooks/use-generations";
import type { Generation } from "@/lib/generations/types";
import { posterUrl, previewUrl } from "@/lib/media-url";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { useProjectFiles } from "./project-files";
import { FILE_DRAG, useFileDrag } from "./film";
import { cn } from "@/lib/cn";

type Show = "all" | "image" | "video" | "audio";

const SHOWS: { id: Show; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Pictures" },
  { id: "video", label: "Clips" },
  { id: "audio", label: "Sound" },
];

/** Put a file at the end of the film (a sound under it, from the start). */
export function appendFile(file: EditFile) {
  const { change, select } = useEditor.getState();
  const clip = clipFromFile(file, nanoid(8), 0);
  change((t) => (file.kind === "audio" ? addMusic(t, clip) : insertMain(t, clip)));
  select(clip.id);
}

/** A film exported from the project (it's in Files too, but it isn't a shot). */
export const isFilm = (f: EditFile) => f.from === "storyboard" && f.kind === "video" && f.name.endsWith("the film");

/** Every shot in Files that isn't in the film yet, at its end in the order they were made: a storyboard in one click. */
export function addAllToFilm() {
  const { change, timeline } = useEditor.getState();
  const used = new Set(timeline.main.map((c) => c.url));
  const shots = useProjectFiles
    .getState()
    .items.filter((f) => f.kind !== "audio" && !isFilm(f) && !used.has(f.url))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!shots.length) return;
  change((t) => shots.reduce((acc, f) => insertMain(acc, clipFromFile(f, nanoid(8))), t));
}

/**
 * Everything in the project, newest first: what the Director shot, the clips made here, the films exported, and what
 * you added. Drag one onto the timeline; click a picture to make a clip from it.
 */
export function Files({ projectId, onDirect, onDirectFrom }: { projectId: string; onDirect: () => void; onDirectFrom?: (file: EditFile) => void }) {
  const { items, loaded, uploading, error, upload, remove, refresh } = useProjectFiles();
  const pickKey = useEditor((s) => s.pick?.file.key ?? null);
  // Which file is which shot, as one string: a trim or a move that keeps the order changes nothing here.
  const order = useEditor((s) => s.timeline.main.map((c) => c.url).join("\n"));
  const [show, setShow] = useState<Show>("all");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Failures from the last hour are shown (older ones were seen before).
  const [since] = useState(() => Date.now() - 3_600_000);

  // Takes of this project still being made (or that just failed), followed live: only they redraw the panel.
  const mine = useGenerations(
    useShallow((s) => s.items.filter((g) => g.params?.project === projectId && (isLive(g) || (g.status === "error" && (g.finishedAt ?? g.createdAt) > since)))),
  );
  const making = useMemo(() => mine.filter((g) => !dismissed.includes(g.id)), [mine, dismissed]);
  // One finishing brings the list up to date.
  const liveIds = making.filter(isLive).map((g) => g.id).join(",");
  const lastLive = useRef(liveIds);
  useEffect(() => {
    if (lastLive.current && lastLive.current !== liveIds) void refresh();
    lastLive.current = liveIds;
  }, [liveIds, refresh]);
  // Coming back from the Director: what it shot meanwhile is here.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const shown = items.filter((f) => show === "all" || f.kind === show);
  const counts = { image: 0, video: 0, audio: 0 } as Record<EditFile["kind"], number>;
  for (const f of items) counts[f.kind]++;
  // Where each file is in the film: its shot numbers, shown on it.
  const usedAs = useMemo(() => {
    const map = new Map<string, number[]>();
    if (order) order.split("\n").forEach((url, i) => map.set(url, [...(map.get(url) ?? []), i + 1]));
    return map;
  }, [order]);
  const unused = items.filter((f) => f.kind !== "audio" && !isFilm(f) && !usedAs.has(f.url)).length;

  return (
    <section
      aria-label="Files"
      className={cn("surface relative flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-panel", over && "shadow-[inset_0_0_0_2px_var(--color-spike)]")}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      {/* One row: what to show, put every unused shot in the film, add your own files. */}
      <div className="flex items-center gap-1.5 p-2">
        <div role="radiogroup" aria-label="Show" className="grid min-w-0 flex-1 grid-cols-4 rounded-[12px] bg-white/[0.04] p-0.5">
          {SHOWS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={show === s.id}
              onClick={() => setShow(s.id)}
              title={s.id !== "all" && counts[s.id] ? `${counts[s.id]} ${s.label.toLowerCase()}` : undefined}
              className={cn(
                "press squircle h-7 truncate rounded-[10px] px-1 text-[11.5px] font-semibold",
                show === s.id ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-fog hover:text-paper",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {unused ? (
          <button
            type="button"
            onClick={addAllToFilm}
            title={`Put the ${unused === 1 ? "shot" : `${unused} shots`} not in the film yet at its end, in the order they were made`}
            aria-label="All to the film"
            className="press squircle relative grid size-8 shrink-0 place-items-center rounded-[10px] text-fog hover:bg-white/[0.07] hover:text-paper"
          >
            <ListPlus size={15} />
            <span className="tabular absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-spike px-1 text-[9.5px] font-bold text-spike-ink">{unused}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => input.current?.click()}
          title="Add pictures, clips or sounds from your computer"
          aria-label="Add files"
          className="press squircle grid size-8 shrink-0 place-items-center rounded-[10px] text-fog hover:bg-white/[0.07] hover:text-paper"
        >
          {uploading ? <LoaderCircle size={15} className="animate-spin" /> : <Upload size={15} />}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {/* A notice floats over the files (never pushes them down), and goes when you close it or the next thing works. */}
      {error ? (
        <div role="alert" className="absolute inset-x-3 bottom-3 z-10 flex items-start gap-2 rounded-[14px] bg-[#2a1416] px-3 py-2 text-[12px] leading-snug text-tally shadow-[0_10px_30px_-10px_rgb(0_0_0/0.8),inset_0_0_0_1px_rgb(255_91_74/0.3)]">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => useProjectFiles.setState({ error: null })} aria-label="Dismiss" className="press -m-1 grid size-6 shrink-0 place-items-center rounded-full text-tally/80 hover:bg-white/[0.08] hover:text-paper">
            <X size={12} />
          </button>
        </div>
      ) : null}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-0.5">
        {!loaded ? (
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton aspect-video rounded-[12px]" />
            ))}
          </div>
        ) : !items.length && !making.length ? (
          <div className="grid h-full min-h-[160px] place-items-center text-center">
            <div className="max-w-[240px]">
              <p className="text-[13px] font-semibold">Nothing here yet</p>
              <p className="mt-1 text-[12px] leading-relaxed text-haze">Shots you take in the Director and clips you make land here. Drop your own pictures, clips or music too.</p>
              <button
                type="button"
                onClick={onDirect}
                className="press squircle mt-3 inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-spike px-3 text-[12.5px] font-semibold text-spike-ink hover:bg-spike-hi"
              >
                <Clapperboard size={13} /> Direct a shot
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {making.map((g) => (
              <MakingTile key={g.id} gen={g} onDismiss={() => setDismissed((d) => [...d, g.id])} />
            ))}
            {shown.map((f) => (
              <FileTile key={f.key} file={f} picked={pickKey === f.key} shots={usedAs.get(f.url)?.join(", ")} onRemove={remove} onDirect={onDirectFrom} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MakingTile({ gen, onDismiss }: { gen: Generation; onDismiss: () => void }) {
  const backdrop = typeof gen.params?.startUrl === "string" ? previewUrl(gen.params.startUrl, 320) : null;
  return (
    <div className="relative aspect-video overflow-hidden rounded-[12px] bg-apple shadow-[inset_0_0_0_1px_var(--color-line)]" title={gen.error ?? gen.prompt}>
      {gen.status === "error" ? (
        <div className="absolute inset-0 flex flex-col justify-center gap-1 bg-tally/10 p-2.5">
          <TriangleAlert size={14} className="text-tally" />
          <p className="line-clamp-3 text-[11px] leading-snug text-tally">{gen.error ?? "It didn't come through."}</p>
          <button type="button" onClick={onDismiss} className="press absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      ) : (
        <GeneratingField bare progress={gen.progress} backdrop={backdrop} />
      )}
      {gen.status !== "error" ? (
        <span className="tabular absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-paper/90">
          {gen.params?.kind === "video" ? "Clip" : "Shot"} · {Math.round((gen.progress ?? 0) * 100)}%
        </span>
      ) : null}
    </div>
  );
}

/** One file: memoized on what it shows, so a project's take finishing or a trim on the timeline doesn't redraw them all. */
const FileTile = memo(function FileTile({
  file,
  picked,
  shots,
  onRemove,
  onDirect,
}: {
  file: EditFile;
  picked: boolean;
  shots?: string;
  onRemove: (key: string) => unknown;
  /** A picture: a new Director set made from it, and over to the Director. */
  onDirect?: (file: EditFile) => void;
}) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  const pickIt = () => {
    if (file.kind === "image") useEditor.getState().setPick(picked ? null : { file });
  };
  return (
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={file.kind === "image" ? `${file.name}: make a clip from it` : `${file.name}: add it at the end of the film`}
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_DRAG, file.key);
        e.dataTransfer.effectAllowed = "copy";
        useFileDrag.setState({ file });
      }}
      onDragEnd={() => useFileDrag.setState({ file: null })}
      onClick={pickIt}
      onDoubleClick={() => appendFile(file)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        // Enter makes a clip from a picture (Shift: puts it at the end of the film); a clip or a sound goes at the end.
        if (file.kind === "image" && !e.shiftKey) pickIt();
        else appendFile(file);
      }}
      title={file.kind === "image" ? `${file.name}\nClick to make a clip from it · drag it onto the timeline` : `${file.name}\nDrag it onto the timeline · double-click to add it at the end`}
      className={cn(
        "group relative aspect-video cursor-grab overflow-hidden rounded-[12px] bg-apple outline-none active:cursor-grabbing focus-visible:shadow-[0_0_0_2px_var(--color-paper)]",
        picked ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
      )}
    >
      {file.kind === "audio" ? (
        <div className="absolute inset-0 flex flex-col justify-end bg-[color-mix(in_oklab,var(--color-chroma)_14%,#1b1820)] p-2">
          <Music2 size={16} className="mb-auto text-chroma" />
          <p className="truncate text-[11.5px] font-semibold text-paper/90">{file.name}</p>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={file.kind === "video" ? (posterUrl(file.url, 320) ?? file.url) : previewUrl(file.url, 320)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="pointer-events-none absolute inset-0 size-full object-cover transition-transform duration-500 ease-[var(--ease-out-quint)] group-hover:scale-[1.04]"
        />
      )}
      {file.kind !== "image" && file.duration ? (
        <span className="tabular pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-paper/90">{file.duration.toFixed(1)}s</span>
      ) : null}
      {isFilm(file) ? (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-tool-storyboard">Film</span>
      ) : shots ? (
        <span className="tabular pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-paper px-1.5 py-0.5 text-[10.5px] font-bold text-[#16131b]" title={`In the film as shot ${shots}`}>
          {shots.split(", ").length > 2 ? `${shots.split(", ").slice(0, 2).join(", ")}…` : shots}
        </span>
      ) : null}
      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100">
        {file.kind === "image" && onDirect ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDirect(file);
            }}
            className="press inline-flex h-6 items-center gap-1 rounded-full bg-spike px-2 text-[10.5px] font-bold text-spike-ink hover:bg-spike-hi"
            title="Direct it: a new Director set made from this picture, then over to the Director"
            aria-label="Direct it: a new Director set made from this picture"
          >
            <Clapperboard size={11} /> Direct
          </button>
        ) : null}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            appendFile(file);
          }}
          className="press grid size-6 place-items-center rounded-full bg-black/60 text-paper hover:bg-black/85"
          title="Add it at the end of the film"
          aria-label="Add it at the end of the film"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!arming) {
              setArming(true);
              disarm.current = setTimeout(() => setArming(false), 2500);
              return;
            }
            void onRemove(file.key);
          }}
          className={cn("press grid h-6 place-items-center rounded-full text-paper", arming ? "bg-tally px-2 text-[10.5px] font-semibold" : "size-6 bg-black/60 hover:bg-black/85")}
          title={file.gen ? "Out of the project (it stays in the Library)" : "Out of the project"}
          aria-label="Remove from the project"
        >
          {arming ? "Remove?" : <Trash2 size={11} />}
        </button>
      </div>
    </div>
  );
});
