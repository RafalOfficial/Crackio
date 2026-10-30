import { shotDone, type Shot, type Storyboard } from "@/lib/storyboard/types";

export type ShotState = { label: string; tone: "work" | "done" | "warn" | "error" | "wait"; busy: boolean };

/** What's happening to a shot right now, in a word or two. */
export function shotState(b: Storyboard, s: Shot, i: number): ShotState {
  if (s.error) return { label: "Problem", tone: "error", busy: false };
  if (b.version !== 3) {
    if (s.jobs.frame || s.jobs.fix) return { label: "Drawing", tone: "work", busy: true };
    if (s.jobs.clip) return { label: "Animating", tone: "work", busy: true };
    return s.clip ? { label: "Clip", tone: "done", busy: false } : s.frame ? { label: "Frame", tone: "done", busy: false } : { label: "Empty", tone: "wait", busy: false };
  }
  if (s.jobs.frame) return { label: s.frameFrom === "bridge" ? "Drawing the cut" : "Drawing", tone: "work", busy: true };
  if (s.jobs.fix || s.check?.status === "fixing") return { label: "Fixing", tone: "work", busy: true };
  if (s.check?.status === "pending" || s.check?.status === "checking") return { label: "Checking", tone: "work", busy: true };
  if (s.jobs.clip) return { label: s.takes?.length ? `Retake ${s.takes.length + 1}` : "Animating", tone: "work", busy: true };
  if (s.review?.status === "pending" || s.review?.status === "reviewing") return { label: "Watching", tone: "work", busy: true };
  if (shotDone(s)) return s.review?.status === "flagged" || s.check?.status === "flagged" ? { label: "Needs a look", tone: "warn", busy: false } : { label: "Done", tone: "done", busy: false };
  if (s.clip && !s.outFrame) return { label: "Cutting", tone: "work", busy: true };
  const first = b.shots.findIndex((x) => !shotDone(x));
  if (b.paused && i === first) return { label: "Paused", tone: "wait", busy: false };
  return { label: b.status === "planning" ? "Planning" : "Waiting", tone: "wait", busy: false };
}

export const TONE: Record<ShotState["tone"], string> = {
  work: "text-paper",
  done: "text-chroma",
  warn: "text-tungsten",
  error: "text-tally",
  wait: "text-haze",
};
