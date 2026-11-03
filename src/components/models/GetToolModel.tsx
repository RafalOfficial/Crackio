"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, Square, TriangleAlert, X } from "lucide-react";
import { DEMO } from "@/lib/demo/config";
import { LOCAL_MODELS } from "@/lib/local/catalog";
import { prefetchLocal, reloadLocal, useLocalStore, useLocalWatch } from "@/lib/hooks/use-local";
import { useModelsStore } from "@/lib/hooks/use-models";
import { formatSeconds, mainGpu, shortGpuName } from "@/lib/local/fit";
import { fitRows, gb, installState, installedVariant, localAction, runsWell, stopDownloads, type Row } from "@/lib/local/rows";
import type { LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";

/** Paid by the job (RunPod Serverless), or a library of its own (Comfy Cloud): Auto doesn't send jobs there unasked. */
const billed = (t: TargetStatus) => t.id === "comfy-cloud" || t.id.startsWith("runpod-");

type Spot = { target: TargetStatus; gpu: string; row: Row; diskGb: number | null };

/**
 * Where a tool's jobs would run its model while that model isn't there: the machine picked in Run on, else (when no free
 * GPU has it) the online one it runs fastest on, as local-models `pickTarget` sends jobs. Null when jobs already find it,
 * or nowhere online runs it well.
 */
function spotFor(status: LocalStatus, model: LocalModel): Spot | null {
  const spots = status.targets.flatMap((target): Spot[] => {
    const machine = status.machines.find((m) => m.target === target.id);
    if (!target.connected || target.id === "comfy-cloud" || !machine) return [];
    const g = mainGpu(machine);
    // Judged by the card, not by what other jobs hold this minute (a training run, another job's models): ComfyUI makes
    // room for the next job itself.
    const card = g?.memoryGb && !g.unified ? { ...machine, modelMemoryGb: Math.max(machine.modelMemoryGb, g.memoryGb) } : machine;
    return [{ target, gpu: g ? shortGpuName(g.name) : machine.label, row: fitRows({ machine: card, catalog: [model], target, status })[0], diskGb: machine.diskFreeGb }];
  });
  const has = (s: Spot) => Boolean(installedVariant(model, s.target));
  const fits = (s: Spot) => runsWell(s.row.fit) && !s.row.blocked;
  const chosen = spots.find((s) => s.target.id === status.runOn);
  if (chosen) return has(chosen) || !fits(chosen) ? null : chosen;
  const free = spots.filter((s) => !billed(s.target));
  if (free.some(has)) return null;
  return free.filter(fits).sort((a, b) => (a.row.fit.seconds ?? Infinity) - (b.row.fit.seconds ?? Infinity))[0] ?? null;
}

/** "Not now", per model and machine, in this browser. */
const OFF = "crackio:get-model-off";

function readOff(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OFF) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/**
 * A tool's own open model (Angles: Qwen Angles) offered on the GPU its jobs go to, while it isn't there: a rented box
 * starts without it, and nothing downloads unless you ask. One click fetches the files that machine lacks (a model that
 * shares them with one already there costs only the rest), the bar shows how far, and once it's in, the tool runs on it.
 */
export function GetToolModel({ id, why, onReady }: { id: string; why: string; onReady: (id: string) => void }) {
  const model = useMemo(() => LOCAL_MODELS.find((m) => m.crackio === id) ?? null, [id]);
  const status = useLocalStore((s) => s.status);
  const [off, setOff] = useState(readOff);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The machine a download was started on from here: the tool switches to the model once it's in.
  const started = useRef<string | null>(null);
  useEffect(() => prefetchLocal(), []);

  const spot = status && model ? spotFor(status, model) : null;
  const state = spot ? installState(spot.row.fit.variant, spot.target) : null;
  // Looked at every 2 s while its files come down (use-local), not otherwise.
  useLocalWatch(Boolean(state?.active.length) || working);

  useEffect(() => {
    const t = status?.targets.find((x) => x.id === started.current);
    if (!t || !model || !installedVariant(model, t)) return;
    started.current = null;
    void useModelsStore
      .getState()
      .refresh()
      .then(() => onReady(id));
  }, [model, status, id, onReady]);

  if (DEMO || !model || !spot || !state || state.installed) return null;
  const key = `${id}@${spot.target.id}`;
  const downloading = state.active.length > 0;
  if (off.includes(key) && !downloading) return null;
  const v = spot.row.fit.variant!;
  const roomy = spot.diskGb == null || state.missingGb < spot.diskGb - 2;
  const failed = problem ?? (downloading ? null : (state.failed?.error ?? null));

  async function get() {
    setWorking(true);
    setProblem(null);
    const error = await localAction("install", model!.id, v.id, spot!.target.id);
    setProblem(error);
    if (!error) started.current = spot!.target.id;
    await reloadLocal();
    setWorking(false);
  }

  function notNow() {
    const next = [...off.filter((k) => k !== key), key];
    setOff(next);
    try {
      localStorage.setItem(OFF, JSON.stringify(next));
    } catch {
      /* private mode: hidden for this visit */
    }
  }

  return (
    <div className="squircle relative rounded-[16px] bg-spike/[0.06] p-3 shadow-[inset_0_0_0_1px_rgb(255_91_46/0.28)]">
      {downloading ? null : (
        <button
          type="button"
          onClick={notNow}
          aria-label="Not now"
          title="Not now"
          className="press absolute right-2 top-2 grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.06] hover:text-paper"
        >
          <X size={14} />
        </button>
      )}
      <p className="pr-8 text-[13.5px] font-semibold leading-snug text-paper">
        {downloading ? `Getting ${model.name} on your ${spot.gpu}` : `${model.name} isn’t on your ${spot.gpu} yet`}
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fog">{why}</p>
      <p className="mt-1 text-[11.5px] text-haze">
        {[spot.row.fit.seconds !== null ? `~${formatSeconds(spot.row.fit.seconds)} a picture there` : "", model.licence.commercial === "no" ? "Non-commercial licence" : ""].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-2.5">
        {downloading ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
              <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(2, (state.done / Math.max(1, state.total)) * 100)}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="truncate text-[11.5px] text-fog">{state.checking ? "Checking the files…" : `${gb(state.done / 1024 ** 3)} of ${gb(state.total / 1024 ** 3)}`}</span>
              <button
                type="button"
                onClick={() =>
                  void stopDownloads(
                    state.active.map((d) => d.id),
                    spot.target.id,
                  ).then(() => reloadLocal())
                }
                className="press inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.12] px-2.5 text-[11px] font-semibold text-paper hover:bg-white/[0.18]"
              >
                <Square size={10} /> Stop
              </button>
            </div>
          </>
        ) : roomy ? (
          <button
            type="button"
            onClick={() => void get()}
            disabled={working}
            className="lip press inline-flex h-8 items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
          >
            {working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} {failed ? "Try again" : "Get it"} · {gb(state.missingGb)}
          </button>
        ) : (
          <p className="text-[12px] text-tungsten">
            Needs {gb(state.missingGb)} free on the {spot.gpu}; it has {gb(spot.diskGb)}.
          </p>
        )}
      </div>
      {failed ? (
        <p className="mt-1.5 flex items-start gap-1 text-[11.5px] text-tally">
          <TriangleAlert size={12} className="mt-px shrink-0" /> {failed}
        </p>
      ) : null}
    </div>
  );
}
