import "server-only";
import path from "node:path";
import sharp from "sharp";
import type { ModelAvailability } from "@/lib/models/catalog";
import { measureVideo } from "./analyze";
import { createBrain } from "./brain";
import { contactSheet, frameAt, frameTimes, toDataUrl } from "./ffmpeg";
import type { MotionPlan } from "./playbook";

/**
 * The second pair of eyes. A fresh conversation with the model that never saw the piece being
 * made, so it can't be talked into liking it: it gets the brief, the plan, frames across the whole
 * video, three larger stills, and the measurements (cuts, color cast, loudness), and answers as the
 * creative director who has to put their name on it. Calibrated to flag what a viewer would notice,
 * not to nitpick, so the agent fixes what matters and ships.
 */

const CRITIC = `You are the creative director at a top motion studio, reviewing a video before it goes to the client. You did not make it. You care about two things: would a real person on their phone stop and watch this, and does anything about it look cheap, templated or AI-generated.

You get: the client's brief, the team's plan, frames across the whole video (left to right, top to bottom, with their times), three larger stills, and measurements of the file (cuts, color cast, loudness). You can't hear it: judge sound from the measurements and the plan, and treat "no sound" or anything under -30 LUFS as silent.

Score 1-10 (10 = world-class studio work, 7 = good professional work, 5 = mediocre, 3 = clearly amateur or AI slop):
- hook: do the first 1.5 s grab attention with motion, a face, a question or a striking image?
- story: is there a clear idea and an arc, or a list of slides?
- realism: do people, animals, products and places look photographed, or plastic, waxy, over-perfect, morphing, wrong?
- color: is the grade deliberate and consistent? Is there an unmotivated yellow, beige or orange wash (the "AI yellow")? Do whites look white?
- type: is on-screen text minimal, readable, tasteful? Penalize text walls, text in most shots, header and footer bars, chapter numbers, "01 / 06" counters, hairline rules, separators (dashes, pipes, middots), labels and tags. No text at all can be a 9 or 10.
- edit: rhythm, varied shot lengths, cuts on action, every shot moving, no slideshow pacing, no frozen holds, nothing cut off, no black frames.
- sound: is there designed sound (a score or sound design made for this picture, or real clip sound) at a sensible level (about -14 LUFS for social)?
- craft: polish and artifacts: melting hands, warped faces, garbled generated text, jitter, bad crops, stretched images.

Be calibrated. Don't nitpick what a normal viewer would never notice. Say what's good too, briefly. Severity: "high" means a viewer would notice it and it makes the piece look cheap, broken or AI-made, or it ignores the brief. "medium" is a clear improvement worth a quick fix. "low" is polish.

Answer with only this JSON, no prose around it:
{"scores":{"hook":0,"story":0,"realism":0,"color":0,"type":0,"edit":0,"sound":0,"craft":0},"overall":0,"good":"one sentence","fixes":[{"severity":"high|medium|low","at":"0:03-0:06 or 'whole piece'","problem":"what's wrong, concretely","fix":"the specific change to make"}],"verdict":"ship|fix"}

At most 6 fixes, most important first. verdict is "ship" when there is no high-severity fix and overall is 7 or more.`;

export type Review = {
  scores: Record<string, number>;
  overall: number;
  good?: string;
  fixes: { severity: "high" | "medium" | "low"; at?: string; problem: string; fix: string }[];
  verdict: "ship" | "fix";
};

function parse(text: string): Review | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const r = JSON.parse(text.slice(start, end + 1)) as Review;
    if (!r || typeof r !== "object" || !Array.isArray(r.fixes)) return null;
    r.fixes = r.fixes.filter((f) => f && typeof f.problem === "string").slice(0, 6);
    r.verdict = r.verdict === "ship" && !r.fixes.some((f) => f.severity === "high") ? "ship" : "fix";
    return r;
  } catch {
    return null;
  }
}

const planText = (p: MotionPlan | null) =>
  p
    ? [
        `Concept: ${p.concept}`,
        p.format ? `Format: ${p.format}` : "",
        `Length: ${p.seconds} s. Look: ${p.look}${p.palette ? `; palette ${p.palette}` : ""}.`,
        `Sound plan: score ${p.music || "none"}; effects ${p.sfx || "none"}.`,
        `Shots: ${(p.shots ?? []).map((s, i) => `${i + 1}) ${s.seconds}s ${s.what}${s.text ? ` [text: "${s.text}"]` : ""}`).join(" ")}`,
      ]
        .filter(Boolean)
        .join("\n")
    : "No plan was written.";

export async function critique({
  model,
  file,
  brief,
  plan,
  sounds,
  signal,
}: {
  model: ModelAvailability;
  file: string;
  brief: string;
  plan: MotionPlan | null;
  /** The sound files this piece was mixed from. */
  sounds: string[];
  signal: AbortSignal;
}): Promise<{ review: Review | null; raw: string; measured: string[] }> {
  const measured = await measureVideo(file, signal);
  const duration = measured.info.duration ?? 1;
  const times = frameTimes(duration, 16);
  const sheet = await contactSheet(file, measured.info, times);
  const stills = await Promise.all([0.15, 0.5, 0.85].map((p) => frameAt(file, duration * p, 1024).catch(() => null)));
  const images = [toDataUrl(sheet), ...(await Promise.all(stills.filter((s): s is Buffer => Boolean(s)).map(async (s) => toDataUrl(await sharp(s).jpeg({ quality: 82 }).toBuffer()))))];
  const text = [
    `Brief from the client:\n${brief || "(no text, just attachments)"}`,
    `The team's plan:\n${planText(plan)}`,
    `Sound files mixed in: ${sounds.length ? sounds.join(", ") : "none recorded"}.`,
    `Measurements of ${path.basename(file)}:\n${measured.lines.join("\n")}`,
    `Pictures: first, 16 frames at ${times.map((t) => t.toFixed(1)).join(", ")} s; then larger stills at ${[0.15, 0.5, 0.85].map((p) => (duration * p).toFixed(1)).join(", ")} s.`,
  ].join("\n\n");
  const brain = await createBrain(model, CRITIC, [], { text, images });
  const turn = await brain.step({ signal, effort: "high" });
  return { review: parse(turn.text), raw: turn.text, measured: measured.lines };
}

export function formatReview(r: Review, round: number, rounds: number): string {
  const s = r.scores ?? {};
  const scores = Object.entries(s)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const fixes = r.fixes.map((f, i) => `${i + 1}. [${f.severity}]${f.at ? ` ${f.at}:` : ""} ${f.problem} → ${f.fix}`).join("\n");
  const next =
    r.verdict === "ship"
      ? "Verdict: ship. Fix any medium item that takes one quick step, then finish."
      : round >= rounds
        ? "Verdict: fix, but this was the last review round: fix the high items you can in a step or two, then finish without another review."
        : "Verdict: fix. Fix every high item (regenerate, re-cut, re-grade or re-mix as needed) and quick medium ones, then review the new file.";
  return `Review ${round} of ${rounds}. Overall ${r.overall}/10 (${scores}).\nGood: ${r.good ?? "-"}\n${fixes ? `Fixes:\n${fixes}` : "No fixes."}\n${next}`;
}
