"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Timer } from "lucide-react";
import { formatSeconds } from "@/lib/local/fit";
import { askEta, etaBody, useRunOnVersion } from "@/lib/hooks/use-run-on";
import { Popover } from "@/components/ui/Popover";
import { listedMachines, RunOnMenu, type RunOnMachine } from "./RunOnMenu";
import type { MacHeat } from "@/lib/local/types";
import { DEMO } from "@/lib/demo/config";
import { DEMO_CREDITS_HINT, demoCredits } from "@/lib/demo/estimate";
import { cn } from "@/lib/cn";

type Eta = {
  seconds: number;
  /** A likely range for it. */
  low: number;
  high: number;
  measured: boolean;
  /** Where it comes from: "6 runs here", "benchmarked on this card", "from benchmarks on RTX 40 cards", "estimated". */
  why: string;
  /** Of the seconds: loading the model, weights streaming from RAM, other apps on the GPU. */
  load: number;
  offload: number;
  busy: number;
  gpu: string;
  machine: string;
  referenceMp: number | null;
  plain: number | null;
  /** A picture's size: drawn there natively, or drawn smaller and redrawn ("detail") or enlarged at it. */
  size: { native: string; target: string; how: "native" | "detail" | "enlarge" } | null;
  /** The machine it would run on. */
  target: string;
  /** That machine's heat, battery and energy mode, when it's a Mac. */
  mac?: MacHeat | null;
};

/** `demo`: in the live demo, whether the job's credits are held (it runs on the demo's GPU) or it's free (your own). */
type Answer = { eta: Eta | null; runOn: string; fallback: "offline" | "no-model" | "unavailable" | null; machines: RunOnMachine[]; demo?: { charged: boolean } | null };

/**
 * How long the next job on a local model will take with the settings on screen, on the machine it would run on
 * (local/estimate: that machine's own runs, Crackio's benchmarks of its card or series, what it's doing now), with a likely
 * range and where the number comes from. Says when the pictures are what makes it long, and what else is in the time
 * (loading the model, weights streaming from RAM, other apps on the GPU). The machine's name opens the "Run on" picker
 * when there's more than one: each machine with the job's time there. Nothing for models that don't run locally.
 */
export function LocalTimeLine({
  modelId,
  kind = "image",
  count = 1,
  references = 0,
  duration,
  resolution,
  ratio,
  source,
  scale,
  edit,
  className,
}: {
  modelId: string | null;
  kind?: "image" | "video" | "upscale";
  count?: number;
  references?: number;
  duration?: number;
  resolution?: string;
  /** The picture's shape (width / height). */
  ratio?: number;
  /** An upscale's picture and factor: its work grows with them. */
  source?: { width: number; height: number };
  scale?: number;
  /** An edit (Retouch, Relight, Angles): the live demo prices it as about a megapixel. */
  edit?: boolean;
  className?: string;
}) {
  const version = useRunOnVersion();
  const body = etaBody({ model: modelId, kind, count, references, duration, resolution, ratio, source, scale });
  const key = body ? `${version}|${body}` : null;
  const [got, setGot] = useState<{ key: string; answer: Answer | null } | null>(null);

  // Asked again a moment after the settings settle, and when the machine to run on changes.
  useEffect(() => {
    if (!body || !key) return;
    let live = true;
    const t = setTimeout(() => {
      askEta<Partial<Answer>>(body)
        .then((d) => live && setGot({ key, answer: d.eta ? { eta: d.eta, runOn: d.runOn ?? "auto", fallback: d.fallback ?? null, machines: d.machines ?? [], demo: d.demo ?? null } : null }))
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body, key]);

  const answer = got && got.key === key ? got.answer : null;
  const eta = answer?.eta ?? null;
  if (!key || !answer || !eta) return null;
  const pickable = listedMachines(answer.machines, answer.runOn).length > 1;
  const asked = answer.runOn !== "auto" ? answer.machines.find((m) => m.id === answer.runOn) : undefined;
  const pictures = references === 1 ? "1 reference picture" : `${references} reference pictures`;
  const shrunk = eta.referenceMp !== null && eta.referenceMp < 1;
  const heavy = eta.plain !== null && eta.seconds > 60 && eta.seconds > eta.plain * 1.8;
  const inside = [
    eta.load >= 3 ? `about ${formatSeconds(eta.load)} loading the model` : null,
    eta.offload >= 3 ? `about ${formatSeconds(eta.offload)} streaming weights from RAM (the GPU's memory is short)` : null,
    eta.busy >= 3 ? `about ${formatSeconds(eta.busy)} for other apps using the GPU` : null,
  ].filter(Boolean);
  // Past what the model draws well, how the picture gets to the size asked.
  const made =
    eta.size && eta.size.how !== "native"
      ? eta.size.how === "detail"
        ? `Drawn at ${eta.size.native}, then redrawn at ${eta.size.target}`
        : `Drawn at ${eta.size.native}, then enlarged to ${eta.size.target}`
      : null;
  const why = [
    made
      ? `${made}: ${eta.size!.native} is the most this model draws well${eta.size!.how === "detail" ? ", and redrawing it lightly at the full size adds real detail" : ". Enlarging sharpens what's there rather than adding detail"}.`
      : eta.size
        ? `Drawn natively at ${eta.size.target}.`
        : null,
    shrunk
      ? `On this GPU a reference picture costs about as much as the picture itself, so ${pictures} share 1 megapixel instead of 1 each. Without them: ${formatSeconds(eta.plain)}.`
      : heavy
        ? `The model reads each reference picture alongside the one it makes, at every step.`
        : null,
    `Likely ${formatSeconds(eta.low)}–${formatSeconds(eta.high)} on this ${eta.gpu}, ${eta.why}${eta.measured ? "" : "; every run here sharpens it"}.`,
    inside.length ? `It includes ${inside.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  // The machine chosen, when the job can't go there: where it runs instead, said plainly (the job works, it isn't an error).
  const instead =
    answer.fallback === "offline" ? "is offline" : answer.fallback === "unavailable" ? `can't take jobs (${(asked?.note ?? "unavailable").toLowerCase()})` : "doesn't have this model";
  const note = answer.fallback && asked ? `${asked.label} ${instead}, so it runs on ${eta.machine}` : null;
  // A job about to run on a Mac (only then): what its heat, battery or energy mode will do to it.
  const mac = eta.mac;
  const flat = mac?.battery && !mac.battery.plugged && (mac.battery.percent ?? 100) <= 20;
  const macHint =
    mac?.thermal === "serious" || mac?.thermal === "critical"
      ? { short: "Mac is hot: pauses to cool", long: "Your Mac is hot: the job waits between steps until it cools" }
      : flat
        ? { short: `Battery ${mac!.battery!.percent}%: plug in`, long: `Your Mac's battery is at ${mac!.battery!.percent}%: plug it in (a job stops at 10%)` }
        : mac?.power?.low
          ? { short: "Low Power Mode: slower", long: "Low Power Mode is on, so this Mac runs the job slower (System Settings › Battery)" }
          : null;
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-3 px-1 text-[12px] text-haze", className)} aria-live="polite" title={why}>
      <div className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
        <Timer size={13} className="shrink-0" />
        <span className="whitespace-nowrap">
          {eta.measured ? "About " : "Roughly "}
          <span className="tabular font-semibold text-paper">{formatSeconds(eta.seconds)}</span> on
        </span>
        {pickable ? (
          <Popover
            placement="top-start"
            panelClassName="w-[320px]"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                title="Pick the machine this runs on"
                className="press inline-flex items-center gap-0.5 rounded-md font-semibold text-fog underline decoration-white/20 underline-offset-2 hover:text-paper"
              >
                {eta.gpu}
                <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="label px-2.5 pb-1.5 pt-1 text-haze">Run on</p>
                <RunOnMenu machines={answer.machines} runOn={answer.runOn} onPicked={close} />
              </>
            )}
          </Popover>
        ) : (
          <span>{eta.gpu}</span>
        )}
        {DEMO ? (
          answer.demo && !answer.demo.charged ? (
            <span className="whitespace-nowrap">· free (your own GPU)</span>
          ) : (
            <span className="whitespace-nowrap" title={DEMO_CREDITS_HINT}>
              · about{" "}
              <span className="tabular font-semibold text-paper">
                {demoCredits({ kind, count, resolution, duration, edit, clipSeconds: kind === "upscale" ? duration : undefined })}
              </span>{" "}
              credits
            </span>
          )
        ) : (
          <span className="whitespace-nowrap">· free</span>
        )}
      </div>
      {note ? (
        <span className="min-w-0 truncate text-right text-haze" title={`${note} (${eta.gpu}).`}>
          {note}
        </span>
      ) : macHint ? (
        <span className="min-w-0 truncate text-right text-tally" title={`${macHint.long}. ${why}`}>
          {macHint.short}
        </span>
      ) : heavy ? (
        <span className="min-w-0 truncate text-right">{shrunk ? `${pictures.replace(/ reference/, "")}, shrunk to save time` : `${formatSeconds(eta.plain)} without the pictures`}</span>
      ) : (
        <span className="min-w-0 truncate text-right">{made ?? eta.why}</span>
      )}
    </div>
  );
}
