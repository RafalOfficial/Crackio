"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle, Square, TriangleAlert, X } from "lucide-react";
import { useTopPills } from "@/components/settings/SetupHint";
import { cn } from "@/lib/cn";
import { DEMO } from "@/lib/demo/config";
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
 * shares them with one already there costs only the rest), the line along the pill shows how far, and once it's in, the
 * tool runs on it. A pop-up like every set-up prompt: a pill floating at the top of the page (under Settings' one when
 * that's up), never a card that pushes the tool's panel down.
 */
export function GetToolModel({ id, why, onReady }: { id: string; why: string; onReady: (id: string) => void }) {
  // From the catalog the model library reads (loaded with your machines below), not a copy of it in the page's code.
  const catalog = useLocalStore((s) => s.catalog);
  const model = useMemo(() => catalog?.find((m) => m.crackio === id) ?? null, [catalog, id]);
  const status = useLocalStore((s) => s.status);
  const [off, setOff] = useState(readOff);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The machine a download was started on from here: the tool switches to the model once it's in.
  const started = useRef<string | null>(null);
  useEffect(() => prefetchLocal(), []);
  // Only while the tool is on screen: Next keeps visited pages alive but hidden, and the pill lives outside the page.
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOnScreen(true), 0);
    return () => {
      clearTimeout(t);
      setOnScreen(false);
    };
  }, []);
  const under = useTopPills((s) => s.setup);

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

  if (DEMO || !onScreen || !model || !spot || !state || state.installed) return null;
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

  const part = Math.max(0.02, Math.min(1, state.done / Math.max(1, state.total)));
  const facts = [why, spot.row.fit.seconds !== null ? `~${formatSeconds(spot.row.fit.seconds)} a picture there` : "", model.licence.commercial === "no" ? "Non-commercial licence" : ""].filter(Boolean).join(" · ");
  return createPortal(
    <div className={cn("pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4", under ? "top-[7.25rem] lg:top-[64px]" : "top-16 lg:top-4")} role="status">
      <div className="pointer-events-auto relative flex max-w-[680px] items-center gap-3 overflow-hidden rounded-[22px] bg-[#1d1a22]/95 py-1.5 pl-4 pr-1.5 text-[13px] text-fog shadow-[0_12px_40px_rgb(0_0_0/0.45),inset_0_0_0_1px_rgb(255_255_255/0.08)]">
        {failed ? <TriangleAlert size={14} className="shrink-0 text-tally" /> : <Download size={14} className="shrink-0 text-spike" />}
        <span className="min-w-0 py-0.5">
          <span className={cn("block truncate", failed ? "text-tally" : "text-fog")} title={failed ?? undefined}>
            {failed ? (
              failed
            ) : downloading ? (
              <>
                Getting <span className="font-semibold text-paper">{model.name}</span> on your {spot.gpu}
                <span className="tabular text-haze"> · {state.checking ? "checking the files…" : `${gb(state.done / 1024 ** 3)} of ${gb(state.total / 1024 ** 3)}`}</span>
              </>
            ) : (
              <>
                <span className="font-semibold text-paper">{model.name}</span> isn&rsquo;t on your {spot.gpu} yet
              </>
            )}
          </span>
          {facts ? (
            <span className="block truncate text-[11.5px] text-haze" title={facts}>
              {facts}
            </span>
          ) : null}
        </span>
        {downloading ? (
          <button
            type="button"
            onClick={() =>
              void stopDownloads(
                state.active.map((d) => d.id),
                spot.target.id,
              ).then(() => reloadLocal())
            }
            className="press inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/[0.1] px-3 text-[12px] font-semibold text-paper hover:bg-white/[0.16]"
          >
            <Square size={10} /> Stop
          </button>
        ) : roomy ? (
          <button
            type="button"
            onClick={() => void get()}
            disabled={working}
            className="press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-spike px-3.5 text-[12.5px] font-bold text-spike-ink hover:bg-spike-hi disabled:opacity-70"
          >
            {working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} {failed ? "Try again" : "Get it"} · {gb(state.missingGb)}
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-tungsten">
            Needs {gb(state.missingGb)} free; it has {gb(spot.diskGb)}
          </span>
        )}
        {downloading ? null : (
          <button type="button" onClick={notNow} aria-label="Not now" title="Not now" className="press grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.06] hover:text-paper">
            <X size={14} />
          </button>
        )}
        {downloading ? (
          <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-spike transition-transform duration-700 ease-out" style={{ transform: `scaleX(${part})` }} />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
