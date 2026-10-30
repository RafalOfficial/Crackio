"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowUpRight, Check, Cpu, FileDown, Gauge, HardDrive, LoaderCircle, MemoryStick, Monitor, Plug, Plus, Search, Square, Thermometer, Trash2, TriangleAlert, X, Zap } from "lucide-react";
import { AppIcon } from "@/components/ui/ToolTile";
import { PRESETS } from "@/lib/local/presets";
import { downloadGb, fastestFor, fitModel, formatSeconds, hostedNote, mainGpu, type Pick } from "@/lib/local/fit";
import { EDIT_WORK, PRACTICAL, byBest, estimateNote, fitRows, gb, installState, localAction, runsWell, sourceOf, stopDownloads, type Row } from "@/lib/local/rows";
import { BENCHMARKS } from "@/lib/local/benchmarks";
import { gpuClass, gpuKeyOf } from "@/lib/local/gpu-series";
import { setRunOn } from "@/lib/hooks/use-run-on";
import { reloadLocal, useLocal } from "@/lib/hooks/use-local";
import { noteFor } from "@/lib/models/notes";
import type { Fit, LocalModel, LocalStatus, LocalTask, MacHeat, Machine, TargetStatus } from "@/lib/local/types";
import { SetupComfy } from "./SetupComfy";
import { ConnectCloud } from "./ConnectCloud";
import { LoraSection } from "@/components/loras/LoraSection";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks/use-now";

type Tab = LocalTask | "all";
type Sort = "best" | "newest" | "popular";

const TASKS: { id: LocalTask; label: string; unit: string }[] = [
  { id: "video", label: "Video", unit: "per 5 s clip" },
  { id: "swap", label: "Character swap", unit: "per 5 s clip" },
  { id: "image", label: "Image", unit: "per image" },
  { id: "edit", label: "Edit", unit: "per edit (1 picture)" },
  { id: "upscale", label: "Upscale", unit: "per 1 MP picture, 2×" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "best", label: "Best here" },
  { id: "newest", label: "Newest" },
  { id: "popular", label: "Most used" },
];

const FIT_STYLE: Record<Fit["state"], { label: string; className: string }> = {
  great: { label: "Runs great", className: "bg-chroma/15 text-chroma" },
  ok: { label: "Runs well", className: "bg-[var(--color-tool-upscale)]/15 text-[var(--color-tool-upscale)]" },
  slow: { label: "Runs, slower", className: "bg-tungsten/15 text-tungsten" },
  no: { label: "Too big here", className: "bg-white/[0.06] text-haze" },
};

/** Released this recently: marked new. */
const NEW_DAYS = 45;

const uses = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k uses` : `${n} uses`);
const month = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
/** What a card's time is for (local/work `cardWork`): a clip upscaler times a 5 s clip in the Upscale tab too. */
const unitOf = (m: LocalModel, tab: Tab) =>
  m.unit === "clip" || m.tasks.includes("swap") ? "per 5 s clip" : tab !== "all" ? TASKS.find((t) => t.id === tab)!.unit : m.tasks.includes("upscale") ? "per 1 MP picture, 2×" : "per image";

/** Seconds one job of a task takes at this fit: an edit at its own measured pace when edits have run here. */
const taskSeconds = (fit: Fit, task: Tab) => (fit.seconds === null ? null : task === "edit" ? (fit.edit ?? fit.seconds) * EDIT_WORK : fit.seconds);

const SORTERS: Record<Sort, (a: Row, b: Row) => number> = {
  best: byBest,
  newest: (a, b) => (b.model.released ?? "").localeCompare(a.model.released ?? "") || byBest(a, b),
  popular: (a, b) => (b.model.usage ?? 0) - (a.model.usage ?? 0) || byBest(a, b),
};

/**
 * What a machine's times rest on: how many of its runs it has learned from, how it compares with the benchmarks of its
 * card or series, and what slows it now (other apps on the GPU).
 */
function EstimatesNote({ gpuName, compute, target }: { gpuName: string; compute?: number; target: TargetStatus }) {
  // Its own card's benchmarks, else its series', else other cards': what Crackio measured closest to it.
  const series = gpuClass(gpuName, compute).series;
  const source = BENCHMARKS.some((b) => gpuKeyOf(b.gpu) === gpuKeyOf(gpuName))
    ? `Crackio's benchmarks of this card`
    : BENCHMARKS.some((b) => gpuClass(b.gpu).series === series)
      ? `Crackio's ${series} benchmarks`
      : `Crackio's benchmarks of other cards`;
  const runs = Object.values(target.measured).reduce((n, m) => n + m.runs + (m.edit?.runs ?? 0), 0);
  const factor = target.live?.factor ?? 1;
  const pace = Math.abs(factor - 1) < 0.06 ? `runs as benchmarked` : factor > 1 ? `runs ${Math.round((factor - 1) * 100)}% slower than the benchmarks` : `runs ${Math.round((1 / factor - 1) * 100)}% faster than the benchmarks`;
  const busy = target.live?.busy ?? 0;
  return (
    <p className="text-[12.5px] leading-relaxed text-haze">
      <Gauge size={13} className="mr-1 inline -translate-y-px" />
      {runs ? `Times learn from its ${runs} run${runs === 1 ? "" : "s"} here and ${source}; it ${pace}` : `Times come from ${source} until it runs a model here`}
      {busy >= 0.05 ? `. Other apps keep its GPU ${Math.round(busy * 100)}% busy now, counted in` : ""}
      {target.live?.accuracy ? `. Of its last ${target.live.accuracy.runs} runs, ${Math.round(target.live.accuracy.within * 100)}% took within 25% of the time shown before` : ""}.
    </p>
  );
}

/**
 * A Mac's card: a job keeps its GPU, the chip that runs everything else, at full power for minutes. What Crackio does about
 * the heat (the bridge's Crackio Mac Tuning rests between steps while macOS says the Mac is hot), and how hot it is now.
 */
function MacNote({ heat }: { heat?: MacHeat }) {
  const hot = heat?.thermal === "serious" || heat?.thermal === "critical";
  const now = hot ? " It's hot now: jobs wait between steps until it cools." : heat?.thermal === "fair" ? (heat.fanless ? " It's warm now: jobs rest a little between steps." : " It's warm now.") : "";
  const battery = heat?.battery ? ` Battery ${Math.round(heat.battery.temp)} °C${heat.battery.plugged ? "" : `, ${heat.battery.percent ?? "?"}% and unplugged`}.` : "";
  const energy = heat?.power?.low
    ? " Low Power Mode is on, so jobs that run on it are slower (System Settings › Battery)."
    : heat?.power?.mode === "automatic"
      ? " For long clips, High Power Mode keeps it at full speed (System Settings › Battery › Energy Mode)."
      : "";
  return (
    <p className={cn("text-[12.5px] leading-relaxed", hot ? "text-spike" : "text-haze")}>
      <Thermometer size={13} className="mr-1 inline -translate-y-px" />
      {heat?.fanless ? "A MacBook Air has no fan, so its case gets hot in long jobs. " : ""}
      Crackio waits between steps when macOS says this Mac is hot{heat?.fanless ? ", rests a little in long jobs while it's warm," : ""} and stops a job before the battery runs flat. Plug it in
      for clips and keep it on a hard surface.{now}
      {battery}
      {energy}
    </p>
  );
}

/** Run the best open models on your own hardware: Crackio reads the machine, picks what fits and installs it into ComfyUI. */
export function LocalView() {
  const { status, error, catalog } = useLocal();
  const reload = reloadLocal;
  const now = useNow();
  const [picked, setPicked] = useState(0);
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("best");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());
  const [onlyRuns, setOnlyRuns] = useState(false);
  const [onlyCommercial, setOnlyCommercial] = useState(false);
  const machines = status?.machines ?? [];
  // An example machine to compare against, instead of a detected one.
  const [example, setExample] = useState<number | null>(null);
  // A GPU just connected is the one shown once it's listed (until you pick another), so its models are what the page shows.
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const connectedAt = justConnected ? machines.findIndex((m) => m.target === justConnected) : -1;
  const current = connectedAt >= 0 ? connectedAt : Math.min(picked, machines.length - 1);
  const machine = (example !== null ? PRESETS[example] : machines[current]) as Machine | undefined;
  // The ComfyUI the selected machine runs: installs go there, and its own runs are what "measured" means.
  const target = machine?.where === "comfyui" ? (status?.targets.find((t) => t.id === machine.target) ?? null) : null;

  // Every model on this machine (local/rows): the variant to install or the one installed, and how fast.
  const rows = useMemo<Row[]>(() => (machine && catalog ? fitRows({ machine, catalog, target, status }) : []), [machine, catalog, target, status]);

  const counts = useMemo(() => {
    const out: Record<Tab, number> = { all: rows.length, video: 0, swap: 0, image: 0, edit: 0, upscale: 0 };
    for (const r of rows) for (const t of r.model.tasks) out[t]++;
    return out;
  }, [rows]);

  const shown = useMemo(() => {
    const words = search.split(/\s+/).filter(Boolean);
    return rows
      .filter((r) => tab === "all" || r.model.tasks.includes(tab))
      .filter((r) => !onlyRuns || (runsWell(r.fit) && !r.blocked))
      .filter((r) => !onlyCommercial || (r.model.licence.commercial !== "no" && !r.blocked))
      .filter((r) => {
        if (!words.length) return true;
        const hay = [r.model.name, r.model.maker, r.model.blurb, r.model.licence.name, ...r.model.tasks, ...r.model.variants.map((v) => v.label)].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(SORTERS[sort]);
  }, [rows, tab, onlyRuns, onlyCommercial, search, sort]);

  const installsHere = Boolean(target?.connected);
  const filtered = Boolean(search || onlyRuns || onlyCommercial);

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-start gap-3">
          <AppIcon glyph="/icons/local.png" size={36} className="mt-1" />
          <div className="min-w-0">
            <h1 className="font-display text-[30px] sm:text-[34px]">Local</h1>
            <p className="mt-1 max-w-[72ch] text-[15px] leading-relaxed text-haze">
              Every open image, video, edit and upscale model ComfyUI runs, on your own hardware: free, private, no account. Crackio reads your machine, says honestly what runs
              well on it, installs the version that fits, and runs it in every tool.
            </p>
          </div>
        </div>
      </header>

      <ol className="mt-5 grid gap-2 text-[13px] sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Reads your machine", "GPU and its memory, RAM, CPU, disk: this computer's, or the ComfyUI you connect."],
          ["Says what runs", "For each job, the best model that runs well here and the fastest, with real times once you've run them."],
          ["Installs it", "The version your GPU runs best, straight into ComfyUI's folders, checked byte for byte."],
          ["Runs it everywhere", "Every Crackio tool can use it, free, with settings tuned for each model."],
        ].map(([title, body], i) => (
          <li key={title} className="rounded-[14px] bg-white/[0.03] px-3.5 py-3">
            <p className="font-semibold text-paper">
              <span className="mr-1.5 text-spike">{i + 1}</span>
              {title}
            </p>
            <p className="mt-0.5 leading-relaxed text-haze">{body}</p>
          </li>
        ))}
      </ol>

      {error && !status ? (
        <p className="mt-6 flex items-center gap-2 rounded-[12px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally">
          <TriangleAlert size={15} /> Couldn&rsquo;t read this machine: {error}
        </p>
      ) : null}

      {!status || !catalog ? (
        <div className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="skeleton h-[168px] rounded-panel" />
          <div className="skeleton h-[168px] rounded-panel" />
        </div>
      ) : (
        <>
          <div className={cn("mt-6 grid gap-3", machines.length > 1 && "lg:grid-cols-2")}>
            {machines.map((m, i) => (
              <MachineCard
                key={`${m.target ?? m.where}-${i}`}
                machine={m}
                status={status}
                target={status.targets.find((t) => t.id === m.target) ?? null}
                models={catalog}
                active={example === null && i === current}
                onPick={machines.length > 1 || example !== null ? () => (setPicked(i), setExample(null), setJustConnected(null)) : undefined}
                onChange={reload}
              />
            ))}
          </div>

          {machines.length > 1 && status.targets.some((t) => t.connected && (t.lendsGb ?? 0) >= 2) ? <PoolingChoice mode={status.pooling} onChange={reload} /> : null}

          {status.targets
            .filter((t) => !t.connected && !t.implicit)
            .map((t) => (
              <p key={t.id} className="mt-3 flex items-center gap-2 rounded-[12px] bg-white/[0.03] px-4 py-2.5 text-[13px] text-haze">
                <TriangleAlert size={14} className="shrink-0 text-tungsten" />
                {/* Comfy Cloud is Comfy's service, reached through a stand-in address here: never "the ComfyUI at 127.0.0.3". */}
                {t.id === "comfy-cloud"
                  ? "Comfy Cloud isn't taking jobs right now (it needs a Comfy plan with API access, Standard or higher): jobs go to your other machines meanwhile."
                  : t.source === "installed"
                    ? "ComfyUI on this computer isn't running: its models come back when it does."
                    : t.cloud
                      ? `${t.label} isn't answering (stopped, or given back to the cloud?): its models come back when it does.`
                      : `The ComfyUI at ${t.url} isn't answering: its models come back when it does.`}
              </p>
            ))}

          <ConnectCloud
            onConnected={(id) => {
              setJustConnected(id);
              setExample(null);
              void reload();
            }}
          />

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SetupComfy onChange={() => void reload()} />
            <AddMachine onAdded={reload} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="mr-1 text-haze">What would run on</span>
            {PRESETS.map((p, i) => (
              <button
                key={`${p.label}-${p.gpus[0]?.name}`}
                onClick={() => setExample(example === i ? null : i)}
                aria-pressed={example === i}
                className={cn(
                  "press h-7 rounded-full px-2.5 font-semibold",
                  example === i ? "bg-spike/15 text-spike shadow-[inset_0_0_0_1px_var(--color-spike)]" : "bg-white/[0.05] text-fog hover:text-paper",
                )}
              >
                {p.gpus[0]?.vendor === "apple" ? `${p.label} ${p.cpu?.model.replace("Apple ", "")} · ${p.ramGb} GB` : `${p.gpus[0]?.name.replace(/^(NVIDIA GeForce|AMD Radeon) /, "")} · ${p.gpus[0]?.memoryGb} GB`}
              </button>
            ))}
          </div>

          {machine && machine.where === "example" ? (
            <p className="mt-3 text-[13px] text-haze">
              An example {machine.label} with {machine.gpus[0]?.unified ? `${machine.ramGb} GB of unified memory` : `${machine.gpus[0]?.memoryGb} GB of VRAM and ${machine.ramGb} GB of RAM`}: estimates, not measurements.
            </p>
          ) : null}
          {machine && machine.where === "this-computer" ? (
            <p className="mt-3 text-[13px] text-haze">What this computer could run once ComfyUI is on it: set it up above, and installs for it go there.</p>
          ) : null}

          {machine ? <Recommendations rows={onlyCommercial ? rows.filter((r) => r.model.licence.commercial !== "no") : rows} machine={machine} commercial={onlyCommercial} /> : null}

          <section className="mt-10" aria-label="Every model">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-display text-[24px] uppercase leading-tight">Every model</h2>
                <p className="mt-0.5 text-[13px] text-haze">
                  {catalog.length} open models. Pick any: Crackio installs the version that suits this machine and sets it up.
                </p>
              </div>
              <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12.5px]" role="group" aria-label="Order">
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSort(s.id)}
                    aria-pressed={sort === s.id}
                    className={cn("press h-8 rounded-full px-3 font-semibold", sort === s.id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Kind of model">
              {(["all", ...TASKS.map((t) => t.id)] as Tab[])
                .filter((t) => t === "all" || counts[t] > 0)
                .map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    aria-pressed={tab === t}
                    className={cn("press inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold", tab === t ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:text-paper")}
                  >
                    {t === "all" ? "All" : TASKS.find((x) => x.id === t)!.label}
                    <span className={cn("text-[11.5px] tabular-nums", tab === t ? "text-[#16131b]/60" : "text-haze")}>{counts[t]}</span>
                  </button>
                ))}
            </nav>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="field-focus flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-full bg-white/[0.05] px-3.5 sm:max-w-[340px]">
                <Search size={14} className="shrink-0 text-haze" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models, makers, licences"
                  aria-label="Search models"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-paper outline-none placeholder:text-haze"
                />
                {query ? (
                  <button onClick={() => setQuery("")} aria-label="Clear the search" className="press text-haze hover:text-paper">
                    <X size={14} />
                  </button>
                ) : null}
              </label>
              <Toggle on={onlyRuns} onClick={() => setOnlyRuns(!onlyRuns)}>
                Runs well here
              </Toggle>
              <Toggle on={onlyCommercial} onClick={() => setOnlyCommercial(!onlyCommercial)}>
                OK for commercial use
              </Toggle>
              <span className="ml-auto text-[12.5px] tabular-nums text-haze">
                {shown.length} of {tab === "all" ? rows.length : counts[tab]}
              </span>
            </div>

            {shown.length ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 min-[1900px]:grid-cols-4">
                {shown.map((r) => (
                  <ModelCard key={r.model.id} row={r} status={status} target={target} machine={machine ?? null} installsHere={installsHere} example={machine?.where === "example"} unit={unitOf(r.model, tab)} task={tab} now={now} onChange={reload} />
                ))}
              </div>
            ) : (
              <div className="mt-6 flex flex-wrap items-center gap-3 text-[13.5px] text-haze">
                No model matches that{onlyRuns ? " and runs well here" : ""}.
                {filtered ? (
                  <button
                    onClick={() => (setQuery(""), setOnlyRuns(false), setOnlyCommercial(false))}
                    className="press h-8 rounded-full bg-white/[0.06] px-3 text-[12.5px] font-semibold text-fog hover:text-paper"
                  >
                    Show all
                  </button>
                ) : null}
              </div>
            )}
          </section>

          <LoraSection catalog={catalog} status={status} />
        </>
      )}
    </div>
  );
}

const POOLING: { id: LocalStatus["pooling"]; label: string; says: string }[] = [
  { id: "auto", label: "Auto", says: "Only models this computer can't run at all: with RAM to spare it streams the rest of a model itself, usually quicker than waiting on a second GPU." },
  { id: "always", label: "Always", says: "Whenever a model doesn't fit this GPU: the other computer holds its last blocks and computes them. Slower than one GPU that held it; the two take turns each step." },
  { id: "off", label: "Off", says: "Every job runs on one computer." },
];

/** When a model too big for one GPU runs split with another computer that lends its memory (settings `pooling`). */
function PoolingChoice({ mode, onChange }: { mode: LocalStatus["pooling"]; onChange: () => void }) {
  const [working, setWorking] = useState(false);
  async function pick(next: LocalStatus["pooling"]) {
    setWorking(true);
    await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pooling", mode: next }) }).catch(() => undefined);
    setWorking(false);
    onChange();
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-white/[0.03] px-4 py-3 text-[13px]">
      <MemoryStick size={15} className="shrink-0 text-haze" />
      <span className="font-semibold text-paper">Split models too big for one GPU across your computers</span>
      <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12.5px]" role="group" aria-label="When to split a model">
        {POOLING.map((p) => (
          <button
            key={p.id}
            onClick={() => void pick(p.id)}
            disabled={working}
            aria-pressed={mode === p.id}
            className={cn("press h-7 rounded-full px-3 font-semibold", mode === p.id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <span className="basis-full leading-relaxed text-haze">{POOLING.find((p) => p.id === mode)?.says}</span>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "press inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold",
        on ? "bg-spike/15 text-spike shadow-[inset_0_0_0_1px_var(--color-spike)]" : "bg-white/[0.05] text-fog hover:text-paper",
      )}
    >
      {on ? <Check size={13} /> : null}
      {children}
    </button>
  );
}

function MachineCard({
  machine,
  status,
  target,
  models,
  active,
  onPick,
  onChange,
}: {
  machine: Machine;
  status: LocalStatus;
  target: TargetStatus | null;
  models: LocalModel[];
  active: boolean;
  onPick?: () => void;
  onChange: () => void;
}) {
  const gpu = mainGpu(machine);
  const comfy = machine.where === "comfyui";
  const hosted = target ? hostedNote(target) : null;
  const comfyCloud = target?.id === "comfy-cloud";
  const kind = !comfy
    ? "This computer"
    : hosted
      ? hosted
      : target?.source === "installed" || target?.onThisComputer
        ? "This computer · ComfyUI"
        : target?.source === "added"
          ? "Another computer"
          : "Runs your models";
  async function forget(e: React.MouseEvent) {
    e.stopPropagation();
    await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove-machine", target: target?.id }) }).catch(() => undefined);
    onChange();
  }
  // With more than one machine online: jobs can be sent here first (settings runOn), or back to Auto's pick.
  const choosable = Boolean(target) && status.targets.filter((t) => t.connected).length > 1;
  const jobsHere = Boolean(target) && status.runOn === target?.id;
  async function runHere(e: React.SyntheticEvent) {
    e.stopPropagation();
    if (!target) return;
    await setRunOn(jobsHere ? "auto" : target.id).catch(() => undefined);
    onChange();
  }
  const allowed = models.filter((m) => !(status.region && m.excludes?.includes(status.region)));
  const runs = allowed.filter((m) => runsWell(fitModel(machine, m))).length;
  const Tag = onPick ? "button" : "div";
  return (
    <Tag
      onClick={onPick}
      className={cn(
        "surface squircle flex flex-col gap-4 rounded-panel p-5 text-left",
        onPick && "press transition-shadow",
        active && onPick && "shadow-[inset_0_0_0_1.5px_var(--color-spike)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">{kind}</p>
          <h2 className="mt-1 truncate font-display text-[22px] uppercase leading-tight">{comfyCloud ? "Comfy Cloud" : gpu ? gpu.name.replace(/^NVIDIA (GeForce )?/i, "") : "No GPU found"}</h2>
          <p className="mt-0.5 text-[13px] text-fog">
            {gpu ? `${gb(gpu.memoryGb)} ${gpu.unified ? "unified memory" : "VRAM"}` : "Models need a GPU"}
            {gpu && !gpu.unified && gpu.memoryGb && machine.modelMemoryGb < gpu.memoryGb - 0.5 ? `, ${gb(machine.modelMemoryGb)} free now (other apps use the rest)` : ""} · {machine.label}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold", runs ? "bg-chroma/15 text-chroma" : "bg-white/[0.06] text-haze")}>
          {runs} of {allowed.length} run well
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5 text-[12.5px] text-fog">
        <Chip icon={MemoryStick}>{gb(machine.ramGb)} RAM</Chip>
        {machine.cpu ? <Chip icon={Cpu}>{machine.cpu.model.replace(/\(R\)|\(TM\)|CPU|@.*$/g, "").replace(/\s+/g, " ").trim()}</Chip> : null}
        <Chip icon={Monitor}>{machine.os.name}</Chip>
        {machine.diskFreeGb != null ? <Chip icon={HardDrive}>{gb(machine.diskFreeGb)} free</Chip> : null}
        {comfy && machine.comfy ? (
          <Chip icon={Plug}>
            ComfyUI {machine.comfy.version ?? ""}
            {target?.bridge ? " · bridge" : ""}
          </Chip>
        ) : null}
        {target?.lendsGb ? <Chip icon={MemoryStick}>Can pool {gb(target.lendsGb)}</Chip> : null}
      </ul>
      {gpu && target?.live ? <EstimatesNote gpuName={gpu.name} compute={gpu.compute} target={target} /> : null}
      {gpu?.unified ? <MacNote heat={target?.live?.mac} /> : null}
      {choosable && target?.connected ? (
        <span
          role="button"
          tabIndex={0}
          onClick={runHere}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            void runHere(e);
          }}
          title={jobsHere ? "Jobs go to this machine first, whenever it has their model. Click to let Auto pick the free machine with the fastest GPU." : "Send jobs to this machine first, whenever it has their model"}
          className={cn("press inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold", jobsHere ? "bg-spike/15 text-spike" : "bg-white/[0.06] text-fog hover:text-paper")}
        >
          {jobsHere ? <Check size={13} /> : <Zap size={13} />}
          {jobsHere ? "Jobs run here" : "Run jobs here"}
        </span>
      ) : null}
      {comfy && target && !target.bridge && !target.onThisComputer ? (
        <p className="text-[12.5px] leading-relaxed text-haze">
          {target.cloud ? (
            <>For one-click installs on it, connect it again below with its SSH command: Crackio adds its bridge.</>
          ) : (
            <>
              For one-click installs on that machine, copy <code className="text-fog">comfyui/crackio_bridge</code> into its ComfyUI <code className="text-fog">custom_nodes</code> folder and
              restart ComfyUI.
            </>
          )}
        </p>
      ) : null}
      {target?.source === "added" ? (
        <span role="button" tabIndex={0} onClick={forget} className="press w-fit text-[12.5px] font-semibold text-haze underline-offset-2 hover:text-paper hover:underline">
          Stop using this machine
        </span>
      ) : null}
      {!comfy && !status.targets.some((t) => t.connected && t.onThisComputer) ? (
        <a
          href="https://www.comfy.org/download"
          target="_blank"
          rel="noreferrer"
          className="press inline-flex h-9 w-fit items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 text-[13px] font-semibold text-fog hover:text-paper"
        >
          Get ComfyUI for {machine.os.family === "macos" ? "Mac" : machine.os.family === "windows" ? "Windows" : "Linux"} <ArrowUpRight size={14} />
        </a>
      ) : null}
    </Tag>
  );
}

function Chip({ icon: Icon, children }: { icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <li className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5">
      <Icon size={13} className="text-haze" />
      {children}
    </li>
  );
}

/** Another computer running ComfyUI on the same network (a Mac next to the PC): its models run from here too. */
function AddMachine({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setWorking(true);
    setProblem(null);
    try {
      const res = await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add-machine", url: url.trim(), token: token.trim() || undefined }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setProblem(body.error ?? "That didn't work.");
      else {
        setUrl("");
        setToken("");
        onAdded();
      }
    } finally {
      setWorking(false);
    }
  }
  return (
    <form onSubmit={add} className="surface squircle flex flex-col gap-3 rounded-panel p-5">
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">Use another computer</p>
        <p className="mt-1 text-[13px] leading-relaxed text-fog">
          A Mac or PC on the same network running ComfyUI (started with <code className="text-paper">--listen</code>). Crackio installs models on it too, and sends each job to a machine
          that has its model, idle and fastest first.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.20:8188"
          aria-label="Its ComfyUI address"
          className="field-focus h-9 min-w-[200px] flex-1 rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token (if it asks)"
          type="password"
          aria-label="Its access token, if it needs one"
          className="field-focus h-9 w-[150px] rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
        />
        <button type="submit" disabled={working || !url.trim()} className="press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-white/[0.08] px-3.5 text-[13px] font-semibold text-fog hover:text-paper disabled:opacity-50">
          {working ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </div>
      {problem ? (
        <p className="flex items-start gap-1.5 text-[12.5px] text-tally">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {problem}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The straight answer for each job on this machine: the best model that runs well, and the fastest that's nearly as good;
 * or, when nothing does, what comes closest and why.
 */
function Recommendations({ rows, machine, commercial }: { rows: Row[]; machine: Machine; commercial: boolean }) {
  const gpu = mainGpu(machine);
  const there = machine.where === "example";
  return (
    <section className="mt-8" aria-label="What to run here">
      <h2 className="font-display text-[24px] uppercase leading-tight">What to run {there ? "there" : "here"}</h2>
      <p className="mt-0.5 max-w-[80ch] text-[13px] leading-relaxed text-haze">
        {gpu ? `On ${there ? "that" : "this"} ${gpu.name.replace(/^NVIDIA (GeForce )?/i, "")}` : "Here"}, at the settings Crackio runs each model with: about 1 megapixel per
        image, an edit with one reference picture (each one more adds time: the model reads it at every step), 5 s of 720p per clip, a 1 MP picture made 2× per
        upscale (×4 models take the same for 4×; time grows with the picture)
        {commercial ? ", among models you may use commercially" : ""}. Times with ~ are estimates; the others were measured {there ? "on one" : "here"}. A model&rsquo;s first
        run also loads it, which adds a little.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {TASKS.map((t) => {
          const picks = rows.filter((r) => r.model.tasks.includes(t.id) && !r.blocked).sort(byBest);
          if (!picks.length) return null;
          const secs = (p: Row | Pick) => taskSeconds(p.fit, t.id);
          const practical = (p: Row | Pick) => (secs(p) ?? Infinity) <= PRACTICAL;
          const best = picks.find((p) => runsWell(p.fit) && practical(p)) ?? null;
          const fastest = fastestFor(picks.filter(practical));
          // With nothing that runs well, the best of those within twice the quickest's time: a 20B model at 14 min a
          // picture is no answer when a 4B one takes 3.
          const slowOnes = picks.filter((p) => p.fit.state === "slow");
          const quickest = Math.min(...slowOnes.map((p) => secs(p) ?? Infinity));
          const slow = slowOnes.find((p) => (secs(p) ?? Infinity) <= quickest * 2) ?? slowOnes[0];
          // What the smallest model would need, when none runs.
          const smallest = [...picks].sort((a, b) => (a.fit.variant?.needGb ?? Infinity) - (b.fit.variant?.needGb ?? Infinity))[0];
          return (
            <div key={t.id} className="surface squircle flex flex-col gap-2 rounded-panel p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">{t.label}</p>
              {best ? (
                <>
                  <p className="flex items-start gap-1.5 text-[15px] font-semibold leading-snug text-paper">
                    <Gauge size={15} className="mt-0.5 shrink-0 text-spike" /> {best.model.name}
                  </p>
                  <p className="text-[12.5px] text-fog">
                    {best.fit.variant?.label} · {best.fit.measured ? "" : "~"}
                    {formatSeconds(secs(best))} {t.unit}
                    {best.model.licence.commercial === "no" ? <span className="text-haze"> · non-commercial</span> : null}
                  </p>
                  {fastest && fastest.model.id !== best.model.id ? (
                    <p className="mt-auto flex items-start gap-1.5 pt-1 text-[12.5px] text-haze">
                      <Zap size={13} className="mt-0.5 shrink-0" /> Fastest: {fastest.model.name}, {fastest.fit.measured ? "" : "~"}
                      {formatSeconds(secs(fastest))}
                    </p>
                  ) : null}
                </>
              ) : slow && (secs(slow) ?? Infinity) <= PRACTICAL ? (
                <>
                  <p className="text-[15px] font-semibold leading-snug text-tungsten">{slow.model.name}, slowly</p>
                  <p className="text-[12.5px] leading-relaxed text-haze">
                    Nothing fits whole: it runs with part of it in RAM ({slow.fit.why.toLowerCase()}), about {formatSeconds(secs(slow))} {t.unit}.
                  </p>
                </>
              ) : slow ? (
                <>
                  <p className="text-[15px] font-semibold leading-snug text-haze">Not practical {there ? "there" : "here"}</p>
                  <p className="text-[12.5px] leading-relaxed text-haze">
                    The lightest, {slow.model.name}, would take about {formatSeconds(secs(slow))} {t.unit} with part of it in RAM. Run these on a bigger GPU.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[15px] font-semibold leading-snug text-haze">Nothing yet</p>
                  <p className="text-[12.5px] leading-relaxed text-haze">The smallest, {smallest.model.name}: {smallest.fit.why.toLowerCase()}.</p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Gated repos: accept the licence on Hugging Face once, and give Crackio a token to download with. */
function GatedNote({ repo, hasToken, onSaved }: { repo: string; hasToken: boolean; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!token.trim()) return;
    setSaving(true);
    await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: { name: "hf", value: token.trim() } }) }).catch(() => undefined);
    setSaving(false);
    setToken("");
    onSaved();
  }
  return (
    <div className="rounded-[12px] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-haze">
      <p>
        Its maker asks you to accept the licence first:{" "}
        <a href={`https://huggingface.co/${repo}`} target="_blank" rel="noreferrer" className="font-semibold text-fog underline-offset-2 hover:underline">
          open it on Hugging Face
        </a>
        {hasToken ? ", sign in and accept. Your token is set." : ", sign in, accept, and paste a read token here."}
      </p>
      {hasToken ? null : (
        <div className="mt-2 flex gap-1.5">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="hf_…"
            type="password"
            className="h-8 min-w-0 flex-1 rounded-[10px] bg-white/[0.05] px-2.5 text-[12.5px] text-paper outline-none placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          />
          <button onClick={save} disabled={saving || !token.trim()} className="press h-8 rounded-[10px] bg-white/[0.08] px-3 text-[12px] font-semibold text-fog hover:text-paper disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The model's preview from its ComfyUI template, or its name on a quiet ground. */
function Thumb({ model }: { model: LocalModel }) {
  const [failed, setFailed] = useState(false);
  if (!model.thumb || failed) {
    return (
      <div className="grid size-full place-items-center bg-[radial-gradient(120%_90%_at_30%_20%,rgb(255_255_255/0.07),transparent_60%)] px-6 text-center">
        <span className="font-display text-[26px] uppercase leading-none text-white/[0.14]">{model.name}</span>
      </div>
    );
  }
  return (
    // Small, cached stills (api/local/thumb); a plain img keeps 50 of them cheap.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/local/thumb/${encodeURIComponent(model.thumb)}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />
  );
}

const LICENCE_STYLE: Record<LocalModel["licence"]["commercial"], { label: string; className: string }> = {
  yes: { label: "Commercial use OK", className: "text-chroma" },
  limited: { label: "Commercial use, with limits", className: "text-tungsten" },
  no: { label: "Non-commercial", className: "text-haze" },
};

function ModelCard({
  row,
  status,
  target,
  machine,
  installsHere,
  example,
  unit,
  task,
  now,
  onChange,
}: {
  task: Tab;
  now: number | null;
  row: Row;
  status: LocalStatus;
  target: TargetStatus | null;
  machine: Machine | null;
  installsHere: boolean;
  example?: boolean;
  unit: string;
  onChange: () => void;
}) {
  const { model, fit, blocked } = row;
  const v = fit.variant;
  const seconds = taskSeconds(fit, task);
  // A model that makes pictures and edits them: an edit reads its picture too, so it takes longer than the time above.
  const editSeconds = task !== "edit" && model.tasks.includes("edit") && model.tasks.includes("image") ? taskSeconds(fit, "edit") : null;
  const { installed, active, checking, failed, total, done, missingGb } = installState(v, target);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(action: "install" | "remove") {
    if (!v) return;
    setWorking(true);
    setProblem(null);
    try {
      setProblem(await localAction(action, model.id, v.id, target?.id));
    } finally {
      setWorking(false);
      onChange();
    }
  }

  async function stop() {
    await stopDownloads(
      active.map((d) => d.id),
      target?.id,
    );
    onChange();
  }

  const style = blocked
    ? { label: "Not licensed here", className: "bg-tally/15 text-tally" }
    : fit.pool
      ? { label: "Runs pooled", className: "bg-[var(--color-tool-upscale)]/15 text-[var(--color-tool-upscale)]" }
      : FIT_STYLE[fit.state];
  const tool = model.tasks.includes("swap") ? "/templates" : model.tasks.includes("video") ? "/video" : model.tasks.includes("upscale") ? "/tools/upscale" : "/create";
  const where = model.crackio && tool !== "/templates" ? `${tool}?model=${encodeURIComponent(model.crackio)}` : tool;
  const roomy = machine?.diskFreeGb == null || missingGb < machine.diskFreeGb - 2;
  const fresh = Boolean(now && model.released && now - Date.parse(model.released) < NEW_DAYS * 86_400_000);
  const licence = LICENCE_STYLE[model.licence.commercial];
  // What the arenas and people say about it (lib/models/notes).
  const note = model.crackio ? noteFor(model.crackio) : undefined;
  return (
    <article className={cn("surface squircle flex flex-col overflow-hidden rounded-panel", (fit.state === "no" || blocked) && "opacity-80")}>
      <div className="relative aspect-[2/1] overflow-hidden bg-white/[0.03]">
        <Thumb model={model} />
        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          {fresh ? <span className="rounded-full bg-spike px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-spike-ink">New</span> : <span />}
          <span className={cn("rounded-full bg-[#121014]/85 px-2.5 py-1 text-[12px] font-semibold", style.className)}>{style.label}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 p-5">
        <div className="min-w-0">
          <h3 className="font-display text-[21px] uppercase leading-tight">{model.name}</h3>
          <p className="mt-0.5 text-[12.5px] text-haze">
            {[model.maker, model.released ? month(model.released) : null, model.audio ? "with sound" : null, model.usage ? uses(model.usage) : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <p className="line-clamp-3 text-[13.5px] leading-relaxed text-fog">{model.blurb}</p>
        {note?.says ? <p className="-mt-1.5 text-[12.5px] leading-relaxed text-haze">People say: {note.says}</p> : null}
        <dl className="grid grid-cols-3 gap-3 text-[12px]">
          <div>
            <dt className="text-haze" title={estimateNote(fit.estimate)}>
              {fit.estimate ? sourceOf(fit.estimate) : fit.measured ? (fit.coldOnly ? "Measured, loading" : "Measured here") : example ? "There (estimate)" : "Here (estimate)"}
            </dt>
            <dd className="mt-0.5 text-[14px] font-semibold text-paper" title={estimateNote(fit.estimate)}>
              {seconds ? `${fit.measured ? "" : "~"}${formatSeconds(seconds)}` : "—"}
            </dd>
            <dd className="text-haze">{seconds ? (fit.load && fit.load >= 5 && !fit.coldOnly ? `${unit}; first run +${formatSeconds(fit.load)}` : unit) : ""}</dd>
          </div>
          <div>
            <dt className="text-haze">Version</dt>
            <dd className="mt-0.5 text-[14px] font-semibold text-paper">{v?.label ?? "—"}</dd>
            <dd className="text-haze">{v ? `${gb(downloadGb(v))} download` : ""}</dd>
          </div>
          <div>
            <dt className="text-haze" title={note?.rank}>
              Quality
            </dt>
            {model.qualityKnown ? (
              <>
                <dd className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <div className="h-full rounded-full bg-spike" style={{ width: `${model.quality}%` }} />
                </dd>
                <dd className="mt-1 text-haze" title={note?.rank}>
                  {model.quality} of 100
                </dd>
              </>
            ) : (
              <dd className="mt-0.5 text-haze">Not rated yet</dd>
            )}
          </div>
        </dl>
        {editSeconds ? (
          <p className="-mt-1 text-[12px] text-haze">
            An edit with one reference picture: <span className="font-semibold text-fog">{fit.measured && fit.edit ? "" : "~"}{formatSeconds(editSeconds)}</span>; each picture more adds time
          </p>
        ) : null}
        <p className="-mt-1 text-[12px] text-haze">
          {fit.why}
          {v ? ` · needs ${gb(v.needGb)} to run` : ""}
          {v?.requires?.customNodes?.length && !installed ? ` · sets up ${v.requires.customNodes.join(", ")}` : ""} ·{" "}
          <span className={licence.className} title={model.licence.note}>
            {model.licence.name}: {licence.label.toLowerCase()}
          </span>
        </p>

        {blocked ? (
          <p className="rounded-[12px] bg-tally/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-tally">
            Its licence leaves out where you are ({status.region}){model.licence.note ? `: ${model.licence.note.toLowerCase().replace(/\.$/, "")}` : ""}. Crackio won&rsquo;t install it here.
          </p>
        ) : null}
        {model.gated && installsHere && !installed && !blocked ? <GatedNote repo={model.gated.repo} hasToken={status.hfToken} onSaved={onChange} /> : null}

        {active.length ? (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(2, (done / Math.max(1, total)) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[12px] text-haze">
              {checking ? "Checking the files…" : `Downloading ${gb(done / 1024 ** 3)} of ${gb(total / 1024 ** 3)}`}
            </p>
          </div>
        ) : null}
        {problem || failed?.error ? (
          <p className="flex items-start gap-1.5 text-[12.5px] text-tally">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {problem ?? failed?.error}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2">
          {example ? (
            <span className="text-[12.5px] text-haze">{fit.state === "no" ? `Won't run there: ${fit.why.toLowerCase()}.` : `${v?.label} would run there.`}</span>
          ) : blocked ? null : installed ? (
            <>
              <span className="inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-chroma/12 px-3.5 text-[13px] font-semibold text-chroma">
                <Check size={15} /> Installed
              </span>
              {model.crackio ? (
                <Link href={where} className="press squircle inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-paper px-4 text-[13px] font-semibold text-[#16171a]">
                  Use it <ArrowUpRight size={14} />
                </Link>
              ) : null}
              {model.crackio && !model.tasks.includes("swap") ? (
                <a
                  href={`/api/local/workflow?model=${model.id}`}
                  download
                  title="The exact ComfyUI workflow Crackio runs (open it in ComfyUI)"
                  className="press inline-flex h-10 items-center gap-1.5 rounded-[12px] px-3 text-[12.5px] font-semibold text-haze hover:bg-white/[0.05] hover:text-paper"
                >
                  <FileDown size={14} /> Workflow
                </a>
              ) : null}
              {installsHere ? (
                <button onClick={() => act("remove")} disabled={working} aria-label="Remove its files" className="press ml-auto grid size-10 place-items-center rounded-[12px] text-haze hover:bg-white/[0.05] hover:text-paper">
                  <Trash2 size={15} />
                </button>
              ) : null}
            </>
          ) : active.length ? (
            <button onClick={stop} className="press inline-flex h-10 items-center gap-1.5 rounded-[12px] bg-white/[0.06] px-3.5 text-[13px] font-semibold text-fog hover:text-paper">
              <Square size={13} /> Stop
            </button>
          ) : installsHere && fit.state !== "no" && !roomy ? (
            <span className="text-[12.5px] text-tungsten">Needs {gb(missingGb)} free on that machine; it has {gb(machine?.diskFreeGb)}.</span>
          ) : installsHere && fit.state !== "no" ? (
            <button
              onClick={() => act("install")}
              disabled={working}
              className="lip squircle inline-flex h-10 items-center gap-2 rounded-[12px] bg-spike px-4 text-[13px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
            >
              {working ? <LoaderCircle size={15} className="animate-spin" /> : null} Install · {gb(missingGb)}
            </button>
          ) : (
            <span className="text-[12.5px] text-haze">{fit.state === "no" ? `Won't run here: ${fit.why.toLowerCase()}.` : "Connect ComfyUI on this machine to install."}</span>
          )}
        </div>
      </div>
    </article>
  );
}
