"use client";

import { useState } from "react";
import { ChevronDown, Dices, RotateCcw } from "lucide-react";
import type { Tuning, TuningOptions } from "@/lib/local/resolution";
import type { EtaAsk } from "@/lib/hooks/use-run-on";
import { listedMachines, RunOnMenu, useRunOnChoices } from "./RunOnMenu";
import { cn } from "@/lib/cn";

const MAX_SEED = 2 ** 48;

/** A number typed in a field, within bounds; nothing when the field is empty or not a number. */
function numberIn(value: string, min: number, max: number) {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

/**
 * The Advanced section's state for an open model on your own GPU (caps `tuning`): a negative prompt, steps, guidance and a
 * seed. Empty fields keep the model's own settings; `options` holds only what was changed, for the job.
 */
export function useTuning(tuning: Tuning | null | undefined) {
  const [negative, setNegative] = useState("");
  const [steps, setSteps] = useState("");
  const [cfg, setCfg] = useState("");
  const [seed, setSeed] = useState("");
  const t = tuning ?? null;
  const stepsValue = t?.steps ? numberIn(steps, t.steps.min, t.steps.max) : undefined;
  const cfgValue = t?.cfg ? numberIn(cfg, t.cfg.min, t.cfg.max) : undefined;
  const seedValue = t?.seed ? numberIn(seed, 0, MAX_SEED) : undefined;
  const options: TuningOptions = t
    ? {
        ...(t.negative && negative.trim() ? { negative: negative.trim() } : {}),
        ...(stepsValue !== undefined ? { steps: Math.round(stepsValue) } : {}),
        ...(cfgValue !== undefined ? { cfg: Math.round(cfgValue * 10) / 10 } : {}),
        ...(seedValue !== undefined ? { seed: Math.floor(seedValue) } : {}),
      }
    : {};
  return {
    tuning: t,
    negative,
    setNegative,
    steps,
    setSteps,
    cfg,
    setCfg,
    seed,
    setSeed,
    options,
    reset() {
      setNegative("");
      setSteps("");
      setCfg("");
      setSeed("");
    },
  };
}

export type TuningState = ReturnType<typeof useTuning>;

/** "Steps 12 · Guidance 3.5 · Seed 42 · Negative prompt", or the model's own settings. */
function summary(s: TuningState) {
  const o = s.options;
  const parts = [o.steps !== undefined && `Steps ${o.steps}`, o.cfg !== undefined && `Guidance ${o.cfg}`, o.seed !== undefined && `Seed ${o.seed}`, o.negative && "Negative prompt"].filter(Boolean);
  return parts.length ? parts.join(" · ") : "The model's own settings";
}

/**
 * Advanced settings for an open model on your own GPU, folded away until asked for: the machine it runs on (when there's
 * more than one, each with the job's time there), what to keep out of the picture, denoising steps, guidance and a fixed
 * seed. Only what the model's workflow takes is shown, with its own values as the placeholders.
 */
export function AdvancedOptions({ s, job, className }: { s: TuningState; /** The job as the time line asks it. */ job?: EtaAsk; className?: string }) {
  const [open, setOpen] = useState(false);
  const run = useRunOnChoices(job ?? { model: null });
  const machines = run ? listedMachines(run.machines, run.runOn) : [];
  const pickable = machines.length > 1;
  const t = s.tuning;
  if (!t && !pickable) return null;
  const guidance = s.options.cfg ?? t?.cfg?.default ?? null;
  const chosen = run && run.runOn !== "auto" ? machines.find((m) => m.id === run.runOn) : undefined;
  const where = pickable ? (chosen ? `On ${chosen.label}` : "On Auto") : null;
  const field = "field-focus h-9 w-full rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze";
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="press flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left">
        <span className="w-[76px] shrink-0 text-[13px] text-haze">Advanced</span>
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", Object.keys(s.options).length || chosen ? "font-semibold text-paper" : "text-fog")}>
          {[where, t ? summary(s) : null].filter(Boolean).join(" · ")}
        </span>
        <ChevronDown size={15} className={cn("shrink-0 text-haze transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-3 px-3 pb-3">
          {pickable && run ? (
            <div className="space-y-1.5">
              <span className="label block">Run on</span>
              <RunOnMenu machines={run.machines} runOn={run.runOn} className="rounded-[12px] bg-white/[0.03] p-1" />
            </div>
          ) : null}
          {t?.negative ? (
            <label className="block space-y-1.5">
              <span className="label block">Negative prompt</span>
              <textarea
                value={s.negative}
                onChange={(e) => s.setNegative(e.target.value)}
                rows={2}
                placeholder="What to keep out: blur, extra fingers, text, watermark…"
                className="field-focus w-full resize-y rounded-[10px] bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-paper outline-none placeholder:text-haze"
              />
              {guidance !== null && guidance <= 1 ? (
                <span className="block text-[12px] leading-relaxed text-haze">This model runs without guidance (1): raise Guidance above 1 for the negative prompt to count.</span>
              ) : null}
            </label>
          ) : null}
          {t ? (
            <div className="grid grid-cols-3 gap-2">
              {t.steps ? (
                <label className="block space-y-1.5">
                  <span className="label block">Steps</span>
                  <input type="number" inputMode="numeric" min={t.steps.min} max={t.steps.max} value={s.steps} onChange={(e) => s.setSteps(e.target.value)} placeholder={String(t.steps.default)} className={field} />
                </label>
              ) : null}
              {t.cfg ? (
                <label className="block space-y-1.5">
                  <span className="label block">Guidance</span>
                  <input type="number" inputMode="decimal" step={0.5} min={t.cfg.min} max={t.cfg.max} value={s.cfg} onChange={(e) => s.setCfg(e.target.value)} placeholder={String(t.cfg.default)} className={field} />
                </label>
              ) : null}
              {t.seed ? (
                <label className="block space-y-1.5">
                  <span className="label block">Seed</span>
                  <span className="flex gap-1">
                    <input type="number" inputMode="numeric" min={0} value={s.seed} onChange={(e) => s.setSeed(e.target.value)} placeholder="Random" className={cn(field, "min-w-0")} />
                    <button
                      type="button"
                      onClick={() => s.setSeed(String(Math.floor(Math.random() * 1_000_000_000)))}
                      title="A random seed you can keep"
                      aria-label="Pick a seed"
                      className="press grid size-9 shrink-0 place-items-center rounded-[10px] bg-white/[0.05] text-fog hover:text-paper"
                    >
                      <Dices size={14} />
                    </button>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}
          {t && !t.steps ? <p className="text-[12px] leading-relaxed text-haze">This model&rsquo;s steps are a fixed schedule it was trained for, so they aren&rsquo;t offered.</p> : null}
          {Object.keys(s.options).length ? (
            <button type="button" onClick={s.reset} className="press inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-haze hover:text-paper">
              <RotateCcw size={12} /> Back to the model&rsquo;s own settings
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
