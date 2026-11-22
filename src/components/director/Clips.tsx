"use client";

import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { create } from "zustand";
import { Play, X } from "lucide-react";
import type { Generation } from "@/lib/generations/types";
import { useToolTakes } from "@/components/tools/use-tool-takes";
import { posterUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

/**
 * Shots into a film: the Director's clips play in the order you made them, each cut to its length: a wide shot for four
 * seconds, a close-up for two, then the next scene.
 */

/** A take that is a clip: made from a still take, cut to `length` seconds. */
export const isClip = (g: Generation) => g.params?.kind === "video";
export const clipLength = (g: Generation) => (typeof g.params?.length === "number" ? g.params.length : 4);

/** Every finished clip, in the order they were made (every Director take, not only the newest of all tools). */
export function useDirectorClips() {
  const items = useToolTakes("director");
  return useMemo(
    () => items.filter((g) => isClip(g) && g.status === "done" && g.outputs.some((o) => o.kind === "video")).sort((a, b) => a.createdAt - b.createdAt),
    [items],
  );
}

/** The cut playing over the camera view. */
export const useCut = create<{ playing: boolean; index: number }>(() => ({ playing: false, index: 0 }));

/** "Play the cut": every clip in order, each for its length. */
export function PlayCut({ compact }: { compact?: boolean } = {}) {
  const clips = useDirectorClips();
  if (!clips.length) return null;
  const total = clips.reduce((t, g) => t + clipLength(g), 0);
  return (
    <button
      onClick={() => useCut.setState({ playing: true, index: 0 })}
      className={cn(
        "press squircle flex shrink-0 items-center justify-center rounded-[12px] bg-spike/15 text-spike hover:bg-spike/25",
        compact ? "h-8 gap-1.5 px-2.5" : "h-[62px] flex-col gap-0.5 px-3",
      )}
      title="Play every clip in order, each cut to its length"
    >
      <Play size={compact ? 12 : 16} fill="currentColor" />
      <span className={cn("font-semibold", compact ? "text-[12.5px]" : "text-[11px]")}>
        {compact ? "Play the cut · " : ""}
        {clips.length} {clips.length === 1 ? "clip" : "clips"} · {total}s
      </span>
    </button>
  );
}

export function CutPlayer() {
  const { playing, index } = useCut();
  const clips = useDirectorClips();
  const video = useRef<HTMLVideoElement>(null);
  const clip = clips[index];
  const url = clip?.outputs.find((o) => o.kind === "video")?.url;

  // Each clip stops at its length and the next one starts: the cut.
  useEffect(() => {
    const v = video.current;
    if (!v || !clip) return;
    const length = clipLength(clip);
    const onTime = () => {
      if (v.currentTime >= length) next();
    };
    const next = () => {
      v.removeEventListener("timeupdate", onTime);
      useCut.setState(index + 1 < clips.length ? { index: index + 1 } : { playing: false });
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", next);
    // With sound when the browser lets it, else silent rather than stuck.
    void v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => undefined);
    });
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", next);
    };
  }, [clip, index, clips.length]);

  if (!playing || !url) return null;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 z-30 grid place-items-center bg-black">
      <video key={url} ref={video} src={url} poster={posterUrl(url, 960)} playsInline className="max-h-full max-w-full" />
      <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[12px] font-semibold text-paper/90">
        Shot {index + 1} of {clips.length} · {clipLength(clip)}s
      </div>
      <button
        onClick={() => useCut.setState({ playing: false })}
        className="press absolute right-3 top-3 grid size-8 place-items-center rounded-[10px] bg-black/60 text-paper hover:bg-black/80"
        aria-label="Stop"
      >
        <X size={16} />
      </button>
      <div className="absolute inset-x-3 bottom-3 flex gap-1">
        {clips.map((g, i) => (
          <span key={g.id} className={cn("h-1 rounded-full", i < index ? "bg-paper" : i === index ? "bg-spike" : "bg-white/25")} style={{ flex: clipLength(g) }} />
        ))}
      </div>
    </motion.div>
  );
}
