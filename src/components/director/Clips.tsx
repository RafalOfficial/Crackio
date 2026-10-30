"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { create } from "zustand";
import { Clapperboard, LoaderCircle, Play, X } from "lucide-react";
import { useGenerations } from "@/lib/hooks/use-generations";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { durationTicks } from "@/lib/models/caps";
import type { Generation } from "@/lib/generations/types";
import type { Scene } from "@/lib/director/types";
import { ModelPicker } from "@/components/models/ModelPicker";
import { Popover } from "@/components/ui/Popover";
import { posterUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

/**
 * Shots into a film: any take becomes a clip of the length you want (2, 4 or 6 seconds), and the clips play in the
 * order you made them, each cut to its length: a wide shot for four seconds, a close-up for two, then the next scene.
 */

/** A take that is a clip: made from a still take, cut to `length` seconds. */
export const isClip = (g: Generation) => g.params?.kind === "video";
export const clipLength = (g: Generation) => (typeof g.params?.length === "number" ? g.params.length : 4);

/** Every finished clip, in the order they were made. */
export function useDirectorClips() {
  const { items } = useGenerations();
  return useMemo(
    () =>
      items
        .filter((g) => g.tool === "director" && isClip(g) && g.status === "done" && g.outputs.some((o) => o.kind === "video"))
        .sort((a, b) => a.createdAt - b.createdAt),
    [items],
  );
}

const LENGTHS = [2, 4, 6];
const MOVES = [
  { id: "still", label: "Still", words: "The camera stays perfectly still: a locked-off shot." },
  { id: "push", label: "Push in", words: "The camera slowly pushes in." },
  { id: "follow", label: "Follow", words: "The camera follows the action smoothly." },
] as const;

/** Make a clip from a still take: what happens, for how long, how the camera moves, with the video model you choose. */
export function MakeClip({ take }: { take: Generation }) {
  const submit = useGenerations((s) => s.submit);
  const [model, setModel] = useModelChoice("video", "video");
  const info = useModelInfo(model === "auto" ? "" : model);
  const scene = take.params?.scene as Scene | undefined;
  const [what, setWhat] = useState(() => scene?.notes?.trim() ?? "");
  const [length, setLength] = useState(4);
  const [move, setMove] = useState<(typeof MOVES)[number]["id"]>("still");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const still = take.outputs.find((o) => o.kind === "image");
  if (!still || isClip(take)) return null;

  // The model's shortest length that holds the cut (the clip is trimmed to it when it plays).
  const ticks = info.caps?.duration ? durationTicks(info.caps.duration) : null;
  const duration = ticks ? (ticks.seconds.filter((s) => s >= length).sort((a, b) => a - b)[0] ?? ticks.max) : Math.max(length, 5);

  const go = async (close: () => void) => {
    if (model === "auto") return void askForModel("video");
    setBusy(true);
    setError(null);
    try {
      const words = what.trim() || "Natural, subtle movement: everyone stays in character.";
      const moveWords = MOVES.find((m) => m.id === move)!.words;
      await submit({
        tool: "director",
        prompt: words,
        compiledPrompt: `${words.replace(/\.?$/, ".")} ${moveWords} Everyone and everything keeps the look they have in the first frame.`,
        aspect: take.aspect,
        count: 1,
        model,
        refine: false,
        references: [{ url: still.url, label: "the start frame", role: "subject" }],
        params: { kind: "video", startUrl: still.url, options: { duration }, fromTake: take.id, length, scene },
      });
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      placement="bottom-end"
      panelClassName="w-[300px]"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          className="press squircle inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-spike px-2.5 text-[12.5px] font-semibold text-spike-ink"
          title="Turn this shot into a clip"
        >
          <Clapperboard size={14} /> <span className="hidden md:inline">Make it move</span>
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-3 p-3">
          <div>
            <p className="label mb-1.5">What happens</p>
            <textarea
              autoFocus
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              rows={2}
              placeholder="She turns and walks away; he laughs"
              className="squircle field-focus w-full resize-none rounded-[10px] bg-white/[0.05] px-2.5 py-2 text-[13px] outline-none placeholder:text-haze"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="label">Length</p>
            <div className="flex gap-1">
              {LENGTHS.map((s) => (
                <button
                  key={s}
                  onClick={() => setLength(s)}
                  aria-pressed={length === s}
                  className={cn("press squircle h-7 rounded-[8px] px-2.5 text-[12.5px] font-semibold", length === s ? "bg-white/[0.14] text-paper" : "text-fog hover:bg-white/[0.06]")}
                >
                  {s}s
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="label">Camera</p>
            <div className="flex gap-1">
              {MOVES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMove(m.id)}
                  aria-pressed={move === m.id}
                  className={cn("press squircle h-7 rounded-[8px] px-2 text-[12px] font-semibold", move === m.id ? "bg-white/[0.14] text-paper" : "text-fog hover:bg-white/[0.06]")}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <ModelPicker kind="video" task="video" value={model} onChange={setModel} label="Clip made with" className="w-full" />
          {error ? <p className="text-[12px] text-tally">{error}</p> : null}
          <button
            onClick={() => void go(close)}
            disabled={busy}
            className="press squircle flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] bg-spike text-[13px] font-semibold text-spike-ink disabled:opacity-60"
          >
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Clapperboard size={14} />}
            Make a {length}s clip
          </button>
        </div>
      )}
    </Popover>
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
