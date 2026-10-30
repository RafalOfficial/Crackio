import { fitModel, fitPooled, fitVariant, formatSeconds, type Pick } from "./fit";
import { cardWork, pictureWork } from "./work";
import { estimateJob, mainMode } from "./estimate";
import type { Download, Fit, LocalEstimate, LocalModel, LocalStatus, LocalVariant, Machine, TargetStatus } from "./types";

/**
 * Every open model on one machine, as the Local page and the model library both show it: the version to install (or the
 * one installed, when it runs there), its time for the card's job, and whether its licence lets it run where you are.
 * Client-safe.
 */

/** Slower than this per image or clip isn't worth recommending, even as the only option. */
export const PRACTICAL = 30 * 60;

/** An edit's work next to a picture from words: it reads its ~1 MP picture beside the one it makes (local/work). */
export const EDIT_WORK = pictureWork({ references: 1 });

export const runsWell = (f: Fit) => f.state === "great" || f.state === "ok";

/** What a model's measured speed is filed under: the recipe Crackio runs it with. */
export const speedKey = (m: LocalModel) => m.crackio?.replace(/^local:/, "") ?? m.id;

export type Row = Pick & { blocked: boolean };

/** An example machine's (or one the server didn't estimate) time for a model: Crackio's benchmarks alone, the model loaded. */
export function exampleEstimate(machine: Machine, model: LocalModel, variant: LocalVariant, models: LocalModel[]): LocalEstimate | null {
  const main = estimateJob({ machine, model, variant, mode: mainMode(model), work: cardWork(model), models, live: { loaded: true } });
  if (!main) return null;
  const edit = model.tasks.includes("edit") ? estimateJob({ machine, model, variant, mode: "edit", work: EDIT_WORK, models, live: { loaded: true } }) : null;
  return {
    seconds: main.seconds,
    low: main.low,
    high: main.high,
    load: 0,
    basis: main.basis,
    runs: 0,
    from: main.from,
    variant: variant.id,
    ...(edit ? { edit: { seconds: edit.seconds, low: edit.low, high: edit.high, basis: edit.basis, runs: 0 } } : {}),
  };
}

/** Where a time comes from, in a card's words, with the cards behind it: "From GTX 10 cards", "Benchmarked: RTX 4070". */
export function sourceOf(e: LocalEstimate) {
  if (e.basis === "measured") return "Measured here";
  if (e.basis === "catalog" || !e.from) return "Estimate";
  return e.basis === "same-gpu" ? `Benchmarked: ${e.from}` : `From ${e.from}`;
}

/** A time's range and source, for its tooltip: "Likely 40–55 s · 12 runs here". */
export function estimateNote(e: LocalEstimate | undefined) {
  if (!e) return undefined;
  const source = e.basis === "measured" ? `${e.runs} run${e.runs === 1 ? "" : "s"} on this machine` : e.basis === "same-gpu" ? `Crackio's benchmarks of this card` : e.basis === "catalog" ? "an estimate from the model's size and steps" : `Crackio's benchmarks on ${e.from ?? "other cards"}`;
  return `Likely ${formatSeconds(e.low)}–${formatSeconds(e.high)}, from ${source}${e.basis === "measured" ? "" : "; every run here sharpens it"}.`;
}

/** Another of your computers lending GPU memory (its bridge's pool): models too big for this machine alone run split with it. */
export function lenderFor(machine: Machine | undefined, status: LocalStatus | null) {
  if (!machine || machine.where !== "comfyui") return null;
  const best = (status?.targets ?? []).filter((t) => t.connected && t.id !== machine.target && (t.lendsGb ?? 0) >= 2).sort((a, b) => (b.lendsGb ?? 0) - (a.lendsGb ?? 0))[0];
  return best ? { gb: best.lendsGb!, label: best.label === "ComfyUI" ? new URL(best.url).hostname : best.label } : null;
}

/** The version of a model a machine has every file of, if any. */
export const installedVariant = (model: LocalModel, target: TargetStatus | null) => {
  const have = new Set(target?.installed ?? []);
  return model.variants.find((v) => v.files.length > 0 && v.files.every((f) => have.has(`${f.folder}/${f.name}`))) ?? null;
};

/**
 * Every model on this machine: the variant to install (or the one installed, when it runs here), how fast (what really ran
 * here beats the estimate, for the version that ran).
 */
export function fitRows({ machine, catalog, target, status }: { machine: Machine; catalog: LocalModel[]; target: TargetStatus | null; status: LocalStatus | null }): Row[] {
  const region = status?.region ?? null;
  const lender = lenderFor(machine, status);
  return catalog.map((model) => {
    // Times for the card's job (a picture, a 5 s clip, a 1 MP picture made 2×): fit's are per unit of work.
    const work = cardWork(model);
    const perJob = (f: Fit): Fit => (work === 1 || f.seconds === null ? f : { ...f, seconds: f.seconds * work });
    let fit = perJob(fitModel(machine, model));
    const installed = installedVariant(model, target);
    if (installed && installed.id !== fit.variant?.id) {
      const mine = perJob(fitVariant(machine, installed));
      if (mine.state !== "no") fit = mine;
    }
    // Its time here (local/estimate): this machine's runs, Crackio's benchmarks of its card or series, what it's doing now
    // (the server's look); an example machine gets the same estimate from the benchmarks alone.
    const est = fit.state !== "no" && fit.variant ? (target?.estimates?.[model.id] ?? exampleEstimate(machine, model, fit.variant, catalog)) : null;
    if (est && est.variant === fit.variant?.id) {
      // Far slower than its size says it should be here: part of it runs from RAM (or something else holds the GPU). Not "runs well".
      const slower = runsWell(fit) && fit.seconds !== null && est.basis === "measured" && est.seconds > fit.seconds * 3;
      fit = {
        ...fit,
        seconds: est.seconds,
        measured: est.basis === "measured",
        load: est.load,
        edit: est.edit ? est.edit.seconds / EDIT_WORK : undefined,
        estimate: est,
        ...(slower ? { state: "slow" as const, why: "Measured far slower than it fits: part of it runs from RAM" } : {}),
      };
    }
    // Fits, but a job would take longer than anyone waits.
    if (runsWell(fit) && fit.seconds !== null && fit.seconds > PRACTICAL) fit = { ...fit, state: "slow", why: `Fits, but takes ${formatSeconds(fit.seconds)} a ${model.unit === "clip" ? "clip" : "picture"} here` };
    // Too big for this GPU alone: split with the computer lending its memory, at its measured pace once it has run so
    // (on Auto, only what this machine can't run at all; with RAM to spare it streams the rest itself).
    const splits = status?.pooling === "always" ? !runsWell(fit) : status?.pooling !== "off" && fit.state === "no";
    const pooled = lender && splits ? fitPooled(machine, model, lender.gb, lender.label) : null;
    if (pooled) {
      fit = pooled;
      const seen = target?.measured[speedKey(model)];
      if (seen && seen.variant === pooled.variant?.id) fit = { ...fit, seconds: seen.seconds, measured: true, load: seen.load, coldOnly: seen.coldOnly };
    }
    return { model, fit, blocked: Boolean(region && model.excludes?.includes(region)) };
  });
}

const RANK: Record<Fit["state"], number> = { great: 2, ok: 2, slow: 1, no: 0 };

/** Runs well here first, then the best quality at its version, then the quickest. */
export function byBest(a: Row, b: Row) {
  const ra = a.blocked ? -1 : RANK[a.fit.state];
  const rb = b.blocked ? -1 : RANK[b.fit.state];
  if (ra !== rb) return rb - ra;
  const qa = a.model.quality * (a.fit.variant?.fidelity ?? 1);
  const qb = b.model.quality * (b.fit.variant?.fidelity ?? 1);
  return qb - qa || (a.fit.seconds ?? Infinity) - (b.fit.seconds ?? Infinity);
}

/** A version's files on a machine: installed, downloading (how far), or failed, and what's left to fetch. */
export function installState(variant: LocalVariant | null, target: TargetStatus | null) {
  const files = variant?.files ?? [];
  const have = new Set(target?.installed ?? []);
  const downloads = target?.downloads ?? [];
  const mine = (d: Download) => files.some((f) => f.folder === d.folder && f.name === d.filename);
  const active = downloads.filter((d) => mine(d) && (d.state === "queued" || d.state === "downloading" || d.state === "checking"));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const done = files.reduce((n, f) => {
    if (have.has(`${f.folder}/${f.name}`)) return n + f.bytes;
    const d = downloads.filter((x) => x.folder === f.folder && x.filename === f.name).at(-1);
    return n + (d ? Math.min(d.received, f.bytes) : 0);
  }, 0);
  return {
    installed: files.length > 0 && files.every((f) => have.has(`${f.folder}/${f.name}`)),
    active,
    checking: active.some((d) => d.state === "checking"),
    failed: downloads.filter((d) => mine(d) && d.state === "error").at(-1) ?? null,
    total,
    done,
    missingGb: files.filter((f) => !have.has(`${f.folder}/${f.name}`)).reduce((n, f) => n + f.bytes, 0) / 1024 ** 3,
  };
}

/** Starts or removes a model's files on a machine; the error to show when it can't. */
export async function localAction(action: "install" | "remove", model: string, variant: string, target: string | undefined): Promise<string | null> {
  const res = await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, model, variant, target }) }).catch(() => null);
  if (!res) return "Crackio didn't answer.";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? null : (body.error ?? "That didn't work.");
}

/** Stops downloads in progress on a machine. */
export async function stopDownloads(ids: string[], target: string | undefined) {
  for (const id of ids) await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop", id, target }) }).catch(() => undefined);
}

/** "29 MB", "4.5 GB", "32 GB": a 29 MB model read "0 GB" in GB alone. */
export const gb = (n: number | null | undefined) => (n == null ? "?" : n < 0.1 ? `${Math.max(1, Math.round(n * 1024))} MB` : `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} GB`);
