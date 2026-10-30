"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { create } from "zustand";
import { ChevronLeft, ChevronRight, Download, History, ImageIcon, Play, TriangleAlert } from "lucide-react";
import { useGenerations } from "@/lib/hooks/use-generations";
import type { Generation } from "@/lib/generations/types";
import type { Scene } from "@/lib/director/types";
import { useDirector } from "@/lib/director/store";
import { aspectById } from "@/lib/shot";
import { CompareView } from "@/components/tools/CompareView";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { posterUrl, previewSrcSet, previewUrl } from "@/lib/media-url";
import { clipLength, isClip, PlayCut } from "./Clips";
import { closeTake, openTake, useTakeView } from "./take-view";
import { useStageView } from "./stage/view";
import { TitleBar, ToolButton, ToolGroup, ToolPill } from "./TitleBar";
import { cn } from "@/lib/cn";

/** Whose takes the Director shows: a Storyboard project's only while it's open in Storyboard, else every take. */
export const useTakesFrom = create<{ project: string | null }>(() => ({ project: null }));

/** Every Director take, newest first. */
export function useDirectorTakes() {
  const { items } = useGenerations();
  const project = useTakesFrom((s) => s.project);
  return useMemo(() => items.filter((g) => g.tool === "director" && (!project || g.params?.project === project)), [items, project]);
}

const isLive = (g: Generation) => g.status === "queued" || g.status === "running";
const guideOf = (g: Generation) => (typeof g.params?.guideUrl === "string" ? g.params.guideUrl : null);
/** What the model got: the composite (composed takes), else the blocking frame (a colored stand-in per subject). */
const blockingOf = (g: Generation) =>
  typeof g.params?.compUrl === "string" ? g.params.compUrl : typeof g.params?.blockingUrl === "string" ? g.params.blockingUrl : null;

/** How the takes stand, for the camera view's Takes button: how many, how many are being made and how far, new ones. */
export function useTakesSummary() {
  const takes = useDirectorTakes();
  const seen = useTakeView((s) => s.seen);
  const live = takes.filter(isLive);
  return {
    count: takes.length,
    live: live.length,
    progress: live.length ? live.reduce((sum, g) => sum + (g.progress ?? 0), 0) / live.length : 0,
    fresh: takes.slice(0, 4).filter((g) => g.status === "done" && !seen.includes(g.id)).length,
  };
}

type Show = "all" | "stills" | "clips";

/** Takes by the day they were made, newest first: "Today", "Yesterday", then dates. */
function byDay(takes: Generation[]) {
  const day = (t: number) => new Date(t).toDateString();
  const today = day(Date.now());
  const yesterday = day(Date.now() - 86_400_000);
  const groups: { label: string; takes: Generation[] }[] = [];
  for (const g of takes) {
    const d = day(g.createdAt);
    const label = d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(g.createdAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const last = groups.at(-1);
    if (last?.label === label) last.takes.push(g);
    else groups.push({ label, takes: [g] });
  }
  return groups;
}

/**
 * Every take, on the camera's screen (its Takes button): by day, stills or clips, click one to compare what you planned
 * with what came back. It took the strip's place under the camera, which crowded the middle (the user).
 */
export function TakesLibrary({ onClose }: { onClose: () => void }) {
  const takes = useDirectorTakes();
  const viewing = useTakeView((s) => s.viewing);
  const seen = useTakeView((s) => s.seen);
  const [show, setShow] = useState<Show>("all");
  // Esc goes back to the camera (once no take is open over it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useTakeView.getState().viewing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const clips = takes.filter(isClip).length;
  const shown = takes.filter((g) => show === "all" || (show === "clips") === isClip(g));
  const number = new Map(takes.map((g, i) => [g.id, takes.length - i]));
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      className="absolute inset-0 z-20 flex flex-col bg-stage"
    >
      <TitleBar>
        <ToolGroup>
          <ToolPill title="Back to the camera (Esc)" onClick={onClose} className="pl-1.5">
            <ChevronLeft size={16} /> Camera
          </ToolPill>
        </ToolGroup>
        <p className="flex items-baseline gap-1.5 px-1.5">
          <span className="text-[13.5px] font-semibold">Takes</span>
          <span className="tabular text-[12px] text-haze">{takes.length}</span>
        </p>
        {clips ? (
          <ToolGroup label="Show">
            {(["all", "stills", "clips"] as const).map((k) => (
              <ToolPill key={k} title={`Show ${k}`} onClick={() => setShow(k)} active={show === k} className="capitalize">
                {k}
                <span className="tabular text-[11.5px] text-haze">{k === "all" ? takes.length : k === "clips" ? clips : takes.length - clips}</span>
              </ToolPill>
            ))}
          </ToolGroup>
        ) : null}
        <span className="flex-1" />
        <PlayCut compact />
      </TitleBar>
      {shown.length ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {byDay(shown).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <p className="sticky top-0 z-10 bg-stage/90 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze backdrop-blur-sm">
                {group.label} <span className="tabular ml-1 text-haze/70">{group.takes.length}</span>
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5" role="list">
                {group.takes.map((g, i) => (
                  <TakeTile
                    key={g.id}
                    g={g}
                    number={number.get(g.id) ?? 0}
                    active={viewing === g.id}
                    fresh={g.status === "done" && !seen.includes(g.id) && takes.indexOf(g) < 4}
                    delay={Math.min(i, 12) * 0.02}
                    onClick={() => openTake(g.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <span className="mx-auto grid size-12 place-items-center rounded-[14px] bg-white/[0.05] text-haze">
              <ImageIcon size={20} />
            </span>
            <p className="mt-3 text-[14px] font-semibold">No takes yet</p>
            <p className="mx-auto mt-1 max-w-[300px] text-[12.5px] leading-relaxed text-haze">Frame the shot, say what happens in it below, and press Shoot it.</p>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/** What a take on its way starts from, faint under its generating field: a clip's first frame, a still's planned frame. */
function liveBackdrop(g: Generation) {
  const from = isClip(g) && typeof g.params?.startUrl === "string" ? g.params.startUrl : guideOf(g);
  return from ? previewUrl(from, 480) : null;
}

/** One take: its picture (or what's being made, and how far), its number and age, how many results, new or failed. */
function TakeTile({ g, number, active, fresh, delay, onClick }: { g: Generation; number: number; active: boolean; fresh: boolean; delay: number; onClick: () => void }) {
  const out = g.outputs[0];
  const guide = guideOf(g);
  const live = isLive(g);
  return (
    <motion.button
      type="button"
      role="listitem"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay }}
      onClick={onClick}
      title={g.status === "error" ? g.error : "Compare what you planned with what came back"}
      className={cn(
        "press group relative w-full overflow-hidden rounded-[14px] bg-[linear-gradient(135deg,rgb(255_255_255/0.05),rgb(255_255_255/0.015))] text-left transition-shadow duration-200",
        active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_rgb(255_255_255/0.07)] hover:shadow-[0_0_0_1px_rgb(255_255_255/0.22),0_18px_40px_-18px_rgb(0_0_0/0.9)]",
      )}
      style={{ aspectRatio: aspectRatioOf(g) }}
    >
      {/* Clipped by a clip-path: with a squircle and only overflow-hidden, Chrome left the blurred pictures and the dot
          field square at the corners, outside the rounded outline (the user). */}
      <span className="absolute inset-0 overflow-hidden rounded-[14px] [clip-path:inset(0_round_14px)]">
        {out?.kind === "video" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(out.url, 480)} alt="" decoding="async" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
        ) : out ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl(out.url, 480)}
            srcSet={previewSrcSet(out.url, [320, 480, 720])}
            sizes="280px"
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : live ? null : isClip(g) && typeof g.params?.startUrl === "string" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl(g.params.startUrl, 480)} alt="" className="size-full object-cover opacity-35 blur-[1px]" />
        ) : guide ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={guide} alt="" className="size-full object-cover opacity-35 blur-[1px]" />
        ) : null}

        <span className="absolute inset-x-2 top-2 flex items-center gap-1">
          {fresh ? <span className="rounded-full bg-spike px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-spike-ink">New</span> : null}
          {isClip(g) ? (
            <span className="flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-px text-[10.5px] font-semibold text-paper backdrop-blur-sm">
              <Play size={9} fill="currentColor" /> {clipLength(g)}s
            </span>
          ) : null}
          {g.outputs.length > 1 ? <span className="tabular ml-auto rounded-full bg-black/60 px-1.5 py-px text-[10.5px] font-semibold text-paper backdrop-blur-sm">×{g.outputs.length}</span> : null}
        </span>

        {live ? (
          // On its way: the generating look every generation has, the Library's included (the user); it fits itself to
          // the tile. No Cancel of its own here (a button inside the tile's button); the take's viewer has it.
          <GeneratingField stage={g.stage} progress={g.progress} since={g.createdAt} backdrop={liveBackdrop(g)} />
        ) : g.status === "error" ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-tally/10 px-4 text-center">
            <TriangleAlert size={16} className="text-tally" />
            <span className="line-clamp-2 text-[11px] leading-snug text-paper/75">{g.error ?? "Failed"}</span>
          </span>
        ) : (
          <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2.5 pb-2 pt-10">
            <span className="min-w-0">
              <span className="tabular block text-[12.5px] font-semibold text-paper">Take {number}</span>
              <span className="block truncate text-[11px] text-paper/60">
                {g.modelName ?? "Auto"} · {ago(g.createdAt)}
              </span>
            </span>
            <span className="shrink-0 translate-y-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold text-paper opacity-0 backdrop-blur-sm transition-[opacity,transform] duration-200 group-hover:translate-y-0 group-hover:opacity-100">
              Compare
            </span>
          </span>
        )}
      </span>
    </motion.button>
  );
}

/** A take's size the way the size menu names it: 4K, 2K, 1K, or its pixels. */
function sizeLabel(width?: number, height?: number) {
  const long = Math.max(width ?? 0, height ?? 0);
  if (!long) return "";
  return long >= 3600 ? "4K" : long >= 1800 ? "2K" : long >= 900 ? "1K" : `${width}×${height}`;
}

function aspectRatioOf(g: Generation) {
  const a = aspectById(g.aspect);
  return Math.min(2.2, Math.max(0.6, a.w / a.h));
}

function ago(t: number) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Planned vs. result for one take, with a divider to drag. Replaces the camera view while open. */
export function TakeCompare() {
  const takes = useDirectorTakes();
  const viewing = useTakeView((s) => s.viewing);
  const output = useTakeView((s) => s.output);
  const model = useStageView((s) => s.model);
  const cancel = useGenerations((s) => s.cancel);
  const index = takes.findIndex((g) => g.id === viewing);
  const gen = index >= 0 ? takes[index] : null;
  if (!gen) return null;

  const blocking = blockingOf(gen);
  // What you planned, or (with the model's view on) the blocking frame the model got.
  const guide = (model && blocking) || guideOf(gen);
  const outs = gen.outputs.filter((o) => o.kind === "image");
  const out = outs[Math.min(output, outs.length - 1)] ?? null;
  const clipOut = gen.outputs.find((o) => o.kind === "video") ?? null;
  const a = aspectById(gen.aspect);
  const scene = gen.params?.scene as Scene | undefined;
  // Your words for the shot while it's made (the take's prompt leads with the camera sheet: "Film still · Wide shot…").
  const words = scene?.notes?.trim() || gen.prompt;
  const go = (d: number) => {
    const next = takes[index + d];
    if (next) openTake(next.id);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="absolute inset-0 z-20 flex flex-col bg-stage"
    >
      <TitleBar>
        <ToolGroup>
          <ToolPill title="Back to the camera (Esc)" onClick={closeTake} className="pl-1.5">
            <ChevronLeft size={16} /> Camera
          </ToolPill>
        </ToolGroup>
        {/* Just going through the takes: which one, made with what and how big, and the two things you do with one. */}
        <ToolGroup>
          <ToolButton label="Older take (←)" onClick={() => go(1)} disabled={index >= takes.length - 1}>
            <ChevronLeft size={16} />
          </ToolButton>
          <span className="tabular whitespace-nowrap px-1.5 text-[12.5px] font-semibold">
            Take {takes.length - index} <span className="text-haze">of {takes.length}</span>
          </span>
          <ToolButton label="Newer take (→)" onClick={() => go(-1)} disabled={index <= 0}>
            <ChevronRight size={16} />
          </ToolButton>
        </ToolGroup>
        <span className="hidden min-w-0 items-center gap-1.5 truncate whitespace-nowrap px-1 text-[12px] text-haze md:flex">
          <span className="truncate text-fog">{gen.modelName ?? "Auto"}</span>
          {out ? <span className="tabular shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-fog">{sizeLabel(out.width, out.height)}</span> : null}
          <span className="shrink-0">· {ago(gen.createdAt)}</span>
        </span>
        {outs.length > 1 ? (
          <div className="flex h-8 items-center gap-1 px-1">
            {outs.map((o, i) => (
              <button
                key={o.url}
                onClick={() => useTakeView.setState({ output: i })}
                aria-label={`Result ${i + 1}`}
                className={cn("size-2 rounded-full", i === Math.min(output, outs.length - 1) ? "bg-paper" : "bg-white/25 hover:bg-white/50")}
              />
            ))}
          </div>
        ) : null}
        <span className="flex-1" />
        <ToolGroup>
          {scene ? (
            <ToolPill
              title="Put the set, camera and light back the way they were for this take"
              onClick={() => {
                useDirector.getState().loadScene(scene);
                closeTake();
              }}
              className="whitespace-nowrap"
            >
              <History size={14} /> Use this setup
            </ToolPill>
          ) : null}
          {out ? (
            <a
              href={out.url}
              download
              className="press squircle inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-2.5 text-[12.5px] font-semibold text-fog hover:bg-white/[0.06] hover:text-paper"
              title="Download"
            >
              <Download size={14} /> Download
            </a>
          ) : null}
        </ToolGroup>
      </TitleBar>

      <div className="min-h-0 flex-1 p-2">
        {isClip(gen) ? (
          <div className="relative grid size-full place-items-center">
            {clipOut ? (
              <video key={clipOut.url} src={clipOut.url} poster={posterUrl(clipOut.url, 960)} controls autoPlay loop playsInline className="max-h-full max-w-full rounded-[14px]" />
            ) : gen.status === "error" ? (
              <span className="rounded-full bg-black/70 px-3 py-1.5 text-[12.5px] font-medium text-tally">{gen.error}</span>
            ) : (
              <GeneratingField
                stage={gen.stage ?? "Making the clip"}
                progress={gen.progress}
                prompt={words}
                since={gen.createdAt}
                backdrop={liveBackdrop(gen)}
                onCancel={() => void cancel(gen.id)}
                className="rounded-[14px]"
              />
            )}
          </div>
        ) : guide ? (
          <CompareView
            key={`${gen.id}-${guide}`}
            before={guide}
            after={out?.url ?? null}
            ratio={a.w / a.h}
            labels={[model && blocking ? (typeof gen.params?.compUrl === "string" ? "Composite" : "Model's view") : "Planned", "Result"]}
            overlay={
              isLive(gen) ? (
                <GeneratingField stage={gen.stage} progress={gen.progress} prompt={words} since={gen.createdAt} backdrop={guide} onCancel={() => void cancel(gen.id)} />
              ) : gen.status === "error" ? (
                <div className="absolute inset-0 grid place-items-center bg-black/55 p-6 text-center">
                  <p className="max-w-[420px] text-[13px] leading-relaxed text-tally">
                    {gen.error} {gen.stage ? <span className="text-paper">{gen.stage}</span> : null}
                  </p>
                </div>
              ) : null
            }
          />
        ) : out ? (
          <div className="grid size-full place-items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={out.url} alt="Result" className="max-h-full max-w-full rounded-[14px]" />
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
