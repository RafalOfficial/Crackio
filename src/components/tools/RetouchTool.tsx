"use client";

import { useRef, useState, type ReactNode } from "react";
import { MousePointerClick, Trash } from "lucide-react";
import { toolBySlug } from "@/lib/tools";
import { useMentions } from "@/components/cast/Mentions";
import { ThingAnnotator } from "@/components/annotate/ThingAnnotator";
import { pinTarget, useThings, type Box, type Pin } from "@/components/annotate/things";
import { ControlSection, EditToolShell } from "./EditToolShell";
import { editsIn, planRetouch, type RetouchChange, type RetouchSpec } from "@/lib/retouch/plan";
import type { ReferenceRef } from "@/lib/generations/types";
import type { SourceImage } from "./SourcePicker";
import { cn } from "@/lib/cn";

/** A pin on a bare spot changes a small square around it. */
const spot = ([x, y]: [number, number]): Box => [Math.max(0, x - 60), Math.max(0, y - 60), Math.min(1000, x + 60), Math.min(1000, y + 60)];
const sentence = (s: string) => s.trim().replace(/[.;:,\s]+$/, "");

/** The changes as the server makes them: where, what it is, what it becomes, and a picture of how. */
function changesOf(pins: Pin[]): RetouchChange[] {
  return pins.map((p) => {
    const t = pinTarget(p);
    return {
      id: p.id,
      box: t.box ?? spot(p.at),
      target: t.box ? t.detail : "the spot",
      text: sentence(p.text),
      ...(p.image?.url ? { image: { url: p.image.url, description: p.image.description } } : {}),
    };
  });
}

/**
 * Retouch: point at things in a picture and say how each should change. Crackio finds the
 * things in it (and their parts), then makes each change up close: on an enlarged crop of its
 * own area, with a clean picture and plain words, blended back so nothing else moves.
 */
export function RetouchTool() {
  const tool = toolBySlug("retouch")!;
  // Changes per picture, so switching pictures and back keeps them.
  const [pinsByImage, setPinsByImage] = useState<Record<string, Pin[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [extra, setExtra] = useState("");
  const [mode, setMode] = useState<RetouchSpec["mode"]>("closeup");
  // "All at once" only: keep the original outside the changes (off by default for general words like "make it night").
  const [lockChoice, setLockChoice] = useState<boolean | null>(null);
  const lock = lockChoice ?? !extra.trim();
  const field = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ textarea: field, value: extra, onChange: setExtra });

  const pinsOf = (url: string) => pinsByImage[url] ?? [];
  const written = (url: string) => pinsOf(url).filter((p) => p.text.trim());
  const setPinsOf = (url: string) => (fn: (p: Pin[]) => Pin[]) => setPinsByImage((m) => ({ ...m, [url]: fn(m[url] ?? []) }));
  const specFor = (source: SourceImage): RetouchSpec => ({ version: 2, mode, changes: changesOf(written(source.url)), extra: extra.trim() || undefined, lock: mode === "whole" ? lock : undefined });

  return (
    <EditToolShell
      tool={tool}
      task="retouch"
      hint="Then hover it: Crackio finds every thing in it. Click one (or a part of it) and say how it should change."
      actionLabel="Apply changes"
      ready={(source) => written(source.url).length > 0 || extra.trim().length > 3}
      edits={(source) => Math.max(1, editsIn(planRetouch(specFor(source), source.width, source.height)))}
      compile={(source) => {
        const spec = specFor(source);
        if (!spec.changes.length && !spec.extra) throw new Error("Pin a change on the picture, or describe one under “Anything else”.");
        const summary = `Retouch · ${[...spec.changes.map((c) => c.text), spec.extra ?? ""].filter(Boolean).join(" · ")}`.slice(0, 160);
        // The record of what was asked; the server makes it change by change from `retouch`.
        const prompt = [...spec.changes.map((c, i) => `${i + 1}. ${c.target}: ${c.text}.`), spec.extra ? `Also: ${sentence(spec.extra)}.` : ""].filter(Boolean).join("\n");
        const refs: ReferenceRef[] = [
          { url: source.url, label: "the original image", role: "edit-target" },
          ...spec.changes.flatMap((c, i) => (c.image ? [{ url: c.image.url, label: `how change ${i + 1} should look`, role: "style" as const }] : [])),
        ];
        return { summary, prompt, refs, params: { retouch: spec } };
      }}
      stage={(source, out) => (
        <RetouchStage source={source} result={out.result} compare={out.compare} pins={pinsOf(source.url)} setPins={setPinsOf(source.url)} editing={editing} setEditing={setEditing} />
      )}
      controls={(source) => {
        const list = source ? written(source.url) : [];
        const edits = source && mode === "closeup" ? editsIn(planRetouch(specFor(source), source.width, source.height)) : 1;
        return (
          <>
            <ControlSection title="Changes" hint={list.length ? `${list.length} pinned` : "Click things in the picture"}>
              {list.length ? (
                <ol className="space-y-1.5">
                  {list.map((p, i) => (
                    <li key={p.id} className="group flex items-start gap-2.5 rounded-[12px] bg-white/[0.04] p-2.5">
                      <span className="tabular grid size-5 shrink-0 place-items-center rounded-full bg-spike text-[11px] font-bold text-spike-ink">{i + 1}</span>
                      <button type="button" onClick={() => setEditing(p.id)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[12px] font-semibold text-paper">{pinTarget(p).name}</span>
                        <span className="block text-[12.5px] leading-snug text-fog">{p.text}</span>
                        {p.image ? (
                          <span className="mt-1.5 flex items-center gap-2 text-[11.5px] text-haze">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.image.preview} alt="" className="size-7 rounded-[6px] object-cover" /> With a reference picture
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => source && setPinsOf(source.url)((ps) => ps.filter((x) => x.id !== p.id))}
                        className="text-haze opacity-0 transition-opacity hover:text-paper group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label="Remove change"
                      >
                        <Trash size={13} />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="flex items-start gap-2 rounded-[12px] bg-white/[0.03] p-3 text-[12.5px] leading-relaxed text-fog">
                  <MousePointerClick size={14} className="mt-0.5 shrink-0 text-haze" />
                  {source ? "Hover the picture to see what Crackio found, then click a thing and say how it should change. While a note is open, click its parts to narrow it down." : "Add a picture first."}
                </p>
              )}
            </ControlSection>

            <ControlSection title="Anything else" hint="Optional · @name for your cast">
              <textarea
                ref={field}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => void mentions.onKeyDown(e)}
                rows={2}
                placeholder="Warmer evening light · remove the people in the background"
                className="field-focus squircle block w-full resize-none rounded-[12px] bg-flat px-3 py-2.5 text-[13px] leading-relaxed text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:text-haze"
              />
              {mentions.menu}
            </ControlSection>

            <ControlSection title="How" hint={mode === "closeup" && list.length ? `${edits} ${edits === 1 ? "edit" : "edits"}` : undefined}>
              <div role="radiogroup" aria-label="How the changes are made" className="grid grid-cols-2 gap-1 rounded-[14px] bg-white/[0.05] p-1">
                {(
                  [
                    ["closeup", "Up close"],
                    ["whole", "All at once"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => setMode(value)}
                    className={cn("press h-9 rounded-[10px] text-[12.5px] font-semibold", mode === value ? "bg-paper text-[#16131b]" : "text-fog hover:bg-white/[0.06] hover:text-paper")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 px-1 text-[12px] leading-relaxed text-haze">
                {mode === "closeup"
                  ? "Each change is made on an enlarged close-up of its own area and blended back in, so nothing else moves. Changes side by side share a close-up; the background and “Anything else” are done on the whole picture first."
                  : "One edit of the whole picture, with every change in words. Faster and cheaper, but the model may redraw other things a little."}
              </p>
            </ControlSection>

            {mode === "whole" && list.length ? (
              <Toggle
                on={lock}
                onChange={setLockChoice}
                title="Only change the marked areas"
                detail={lock ? "Everything outside your changes keeps its exact pixels (when the model kept the framing)." : "The model may touch the whole picture (needed for changes like the light)."}
              />
            ) : null}
          </>
        );
      }}
    />
  );
}

function Toggle({ on, onChange, title, detail }: { on: boolean; onChange: (v: boolean) => void; title: string; detail: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="press flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="block text-[12px] leading-snug text-haze">{detail}</span>
      </span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-spike" : "bg-gaffer")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-paper shadow transition-[left] duration-200", on ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}

/** The picture to point at, and the before/after once there's a result (shown as soon as it lands). */
function RetouchStage({
  source,
  result,
  compare,
  pins,
  setPins,
  editing,
  setEditing,
}: {
  source: SourceImage;
  result: string | null;
  compare: ReactNode;
  pins: Pin[];
  setPins: (fn: (p: Pin[]) => Pin[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  const found = useThings(source.url);
  const [view, setView] = useState<"mark" | "compare">("mark");
  // A new result shows itself; opening a change goes back to the picture.
  const [seen, setSeen] = useState(result);
  if (result !== seen) {
    setSeen(result);
    if (result) setView("compare");
  }
  const [wasEditing, setWasEditing] = useState(editing);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) setView("mark");
  }
  const showing = result ? view : "mark";

  return (
    <div className="flex size-full flex-col gap-3">
      {result ? (
        <div role="tablist" aria-label="View" className="flex shrink-0 gap-1 self-start rounded-full bg-white/[0.05] p-1">
          {(["mark", "compare"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={showing === v}
              onClick={() => setView(v)}
              className={cn("press h-8 rounded-full px-3.5 text-[12.5px] font-semibold", showing === v ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}
            >
              {v === "mark" ? "Mark changes" : "Before / after"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {showing === "mark" ? (
          <ThingAnnotator
            image={source}
            things={found.things}
            status={found.status}
            error={found.error}
            needParts={found.needParts}
            pins={pins}
            setPins={setPins}
            editing={editing}
            setEditing={setEditing}
          />
        ) : (
          compare
        )}
      </div>
    </div>
  );
}
