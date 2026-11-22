"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Clapperboard, LoaderCircle, X } from "lucide-react";
import { useDirector } from "@/lib/director/store";
import { useGenerations } from "@/lib/hooks/use-generations";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";
import { useToolTakes } from "@/components/tools/use-tool-takes";
import { MOVES, PACES, type MoveId, type PaceId } from "@/lib/video/moves";
import { previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";
import { angleDelta } from "@/lib/director/camera";
import { hasKeys, type Timeline } from "@/lib/director/timeline";
import { isClip } from "../Clips";
import { useTakesFrom } from "../take-view";
import { notice } from "./notice";

/**
 * The camera move the timeline makes, in the video model's words: what the first and last camera keys differ by most
 * (round the subject, nearer or farther, higher). Null with no move on the timeline.
 */
export function moveOfTimeline(tl: Timeline | null | undefined): { move: MoveId; seconds: number } | null {
  if (!hasKeys(tl) || tl.camera.length < 2) return null;
  const a = tl.camera[0].cam;
  const b = tl.camera[tl.camera.length - 1].cam;
  const turn = angleDelta(a.azimuth, b.azimuth);
  const closer = b.distance / Math.max(0.01, a.distance);
  const rise = b.elevation - a.elevation + (b.focusHeight - a.focusHeight) * 20;
  const seconds = Math.min(8, Math.max(3, Math.round((tl.camera[tl.camera.length - 1].t - tl.camera[0].t) / Math.max(1, tl.fps))));
  let move: MoveId = "static";
  if (Math.abs(turn) >= 12) move = turn > 0 ? "orbit-r" : "orbit-l";
  else if (closer <= 0.85) move = "push";
  else if (closer >= 1.15) move = "pull";
  else if (rise >= 8) move = "crane";
  else if (Math.abs(b.focusHeight - a.focusHeight) >= 0.3) move = "tilt";
  return { move, seconds: seconds <= 4 ? 3 : seconds <= 6 ? 5 : 8 };
}

/** The moves Film it offers: the ones a director asks for (the rest live in the Video tool). */
const FILM_MOVES: MoveId[] = ["push", "pull", "orbit-l", "orbit-r", "crane", "tilt", "static", "handheld"];

/**
 * Film it: your last shot, moving. The still you shot opens the clip and the camera makes the move you pick, on your
 * video model (LTX-2.5 on your GPU by default). The clip lands in your takes, next to the still it came from.
 */
/** `compact`: a phone's small button (the Director full screen); its card opens above it, as wide as the phone allows. */
export function FilmIt({ move: suggested, compact = false }: { move?: MoveId | null; compact?: boolean }) {
  const takes = useToolTakes("director");
  const project = useTakesFrom((s) => s.project);
  const still = useMemo(
    () =>
      takes
        .filter((g) => !isClip(g) && g.status === "done" && g.outputs.some((o) => o.kind === "image") && (!project || g.params?.project === project))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    [takes, project],
  );
  const filming = takes.some((g) => isClip(g) && (g.status === "queued" || g.status === "running"));
  const [open, setOpen] = useState(false);
  const [move, setMove] = useState<MoveId>(suggested ?? "push");
  const [pace, setPace] = useState<PaceId>("natural");
  const [seconds, setSeconds] = useState(5);
  const [busy, setBusy] = useState(false);
  // The move on the timeline, when there is one, is what Film it starts from each time it opens.
  const timeline = useDirector((s) => s.scene.timeline);
  const fromTimeline = useMemo(() => moveOfTimeline(timeline), [timeline]);
  const [model] = useModelChoice("video", "video");
  const submit = useGenerations((s) => s.submit);
  const image = still?.outputs.find((o) => o.kind === "image");

  async function film() {
    if (!still || !image) return;
    if (model === "auto") return void askForModel("video");
    setBusy(true);
    try {
      const scene = useDirector.getState().scene;
      const m = MOVES.find((x) => x.id === move);
      const p = PACES.find((x) => x.id === pace);
      const words = [scene.notes.trim() || "The scene comes to life naturally.", m?.phrase, p?.phrase].filter(Boolean).join(" ");
      await submit({
        tool: "director",
        prompt: scene.notes.trim() || `${m?.label ?? "Moving"} shot`,
        compiledPrompt: words,
        aspect: scene.aspect,
        count: 1,
        model,
        refine: false,
        references: [{ url: image.url, label: "the start frame", role: "subject" as const }],
        params: { kind: "video", options: { duration: seconds }, move, pace, startUrl: image.url, length: seconds, from: still.id, ...(project ? { project } : {}) },
      });
      setOpen(false);
      notice("Filming your shot · it lands in Takes", "busy", 4000);
    } catch (err) {
      notice((err as Error).message, "stop", 6000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "relative" : "relative h-full"}>
      <button
        type="button"
        onClick={() => {
          if (!open && fromTimeline) {
            setMove(fromTimeline.move);
            setSeconds(fromTimeline.seconds);
          }
          setOpen((o) => !o);
        }}
        disabled={!still}
        title={still ? "Make your last shot move" : "Shoot a still first: Film it makes it move"}
        aria-label="Film it"
        className={cn(
          compact
            ? "press grid size-9 place-items-center rounded-[10px] transition-colors disabled:opacity-35"
            : "press squircle flex h-full min-h-[64px] w-[132px] flex-col items-center justify-center gap-1 rounded-[18px] text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          open ? "bg-white/[0.14] text-paper" : compact ? "text-paper/85" : "bg-white/[0.07] text-paper hover:bg-white/[0.11]",
        )}
      >
        {filming ? <LoaderCircle size={compact ? 17 : 18} className="animate-spin text-spike" /> : <Clapperboard size={compact ? 17 : 18} className="text-spike" />}
        {compact ? null : "Film it"}
      </button>
      <AnimatePresence>
        {open && still && image ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-[min(380px,calc(100vw-20px))] rounded-[16px] bg-[#16171a] p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_20px_60px_rgb(0_0_0/0.5)]"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[14px] font-semibold text-paper">Make your last shot move</p>
              <button type="button" onClick={() => setOpen(false)} className="press grid size-7 place-items-center rounded-md text-haze hover:text-paper" aria-label="Close">
                <X size={14} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl(image.url, 640)} alt="" className="mb-3 aspect-video w-full rounded-[10px] object-cover" />
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">The camera{fromTimeline ? " · from your timeline" : ""}</p>
            <div className="grid grid-cols-4 gap-1.5">
              {FILM_MOVES.map((id) => {
                const m = MOVES.find((x) => x.id === id)!;
                const Icon = m.icon;
                return (
                  <button
                    key={id}
                    type="button"
                    title={m.caption}
                    onClick={() => setMove(id)}
                    className={cn(
                      "press flex flex-col items-center gap-1 rounded-[10px] px-1 py-2 text-[11.5px] font-semibold transition-colors",
                      move === id ? "bg-spike/15 text-paper shadow-[inset_0_0_0_1px_rgb(255_91_46/0.7)]" : "bg-white/[0.04] text-fog hover:text-paper",
                    )}
                  >
                    <Icon size={16} />
                    {m.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="flex flex-1 rounded-[10px] bg-white/[0.05] p-0.5">
                {PACES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    title={p.caption}
                    onClick={() => setPace(p.id)}
                    className={cn("press h-7 flex-1 rounded-[8px] text-[12px] font-semibold", pace === p.id ? "bg-white/[0.16] text-paper" : "text-fog hover:text-paper")}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex rounded-[10px] bg-white/[0.05] p-0.5">
                {[3, 5, 8].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeconds(s)}
                    className={cn("press tabular h-7 w-10 rounded-[8px] text-[12px] font-semibold", seconds === s ? "bg-white/[0.16] text-paper" : "text-fog hover:text-paper")}
                  >
                    {s}s
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void film()}
              disabled={busy}
              className="press mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-spike text-[14px] font-semibold text-spike-ink disabled:opacity-60"
            >
              {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Clapperboard size={16} />}
              Film it
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
