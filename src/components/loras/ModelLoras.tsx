"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Download, Heart, KeyRound, LoaderCircle, Plus, Search, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Panel";
import { useLocalStore } from "@/lib/hooks/use-local";
import {
  addLora,
  deleteLoraFile,
  holders,
  loadLoraLibrary,
  loraDownloads,
  loraTargets,
  modelEntries,
  repoLoraFiles,
  searchLoras,
  unknownFiles,
  useLoraLibrary,
  viewOf,
  type LoraView,
} from "@/lib/hooks/use-lora-library";
import { MAX_LORAS, setLora, useModelLoras, type LoraPick } from "@/lib/hooks/use-model-loras";
import { autoTrigger, categoryLabel, LORA_CATEGORIES, type LoraCategory, type LoraEntry, type LoraFile } from "@/lib/local/loras";
import { gb } from "@/lib/local/rows";
import type { LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";

/**
 * One model's LoRAs: the ones you have (switched on, with their strength), Crackio's picks for it (checked files from
 * Hugging Face, one click to download and switch on), a Hugging Face search for the rest, and LoRA files on your machines
 * that nothing explains. What's switched on goes with every job the model runs, in every tool (hooks/use-model-loras).
 * The model library shows it when a card's LoRAs button is pressed; the Local page's LoRAs section for the model picked.
 */

const EMPTY: LoraPick[] = [];
const LICENCE: Record<LoraEntry["licence"]["commercial"], { text: string; className: string }> = {
  yes: { text: "Commercial OK", className: "text-chroma" },
  limited: { text: "Commercial, with limits", className: "text-[var(--color-tool-upscale)]" },
  no: { text: "Non-commercial", className: "text-haze" },
};
const count = (n: number | undefined) => (!n ? "0" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));
const bytesOf = (e: LoraEntry) => e.files.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;
const machineName = (t: TargetStatus) => (t.cloud ? { vast: "vast.ai", runpod: "RunPod", other: "cloud GPU" }[t.cloud.provider] : t.onThisComputer || t.source === "installed" ? "this computer" : t.label);

export function ModelLoras({ model, compact = false }: { model: LocalModel; compact?: boolean }) {
  const status = useLocalStore((s) => s.status);
  const { library, error } = useLoraLibrary();
  useEffect(() => loadLoraLibrary(), []);
  const crackio = model.crackio ?? `local:${model.id}`;
  const picks = useModelLoras((s) => s.byModel[crackio]) ?? EMPTY;
  const { picks: entries, found } = useMemo(() => modelEntries(library, model), [library, model]);
  const targets = loraTargets(status, model);
  const clip = model.unit === "clip";

  // Yours: every LoRA of this model that's switched on or on a machine (picks and finds), then files nothing explains
  // that are switched on for it.
  const views = useMemo(() => [...entries, ...found].map((e) => viewOf(e, status, model)), [entries, found, status, model]);
  const onFiles = new Set(picks.map((p) => p.file));
  const yours = views.filter((v) => v.installed.length > 0 || v.files.some((f) => onFiles.has(f)) || loraDownloads(status, v.files).active.length > 0);
  const strays = useMemo(() => unknownFiles(library, status), [library, status]);
  const known = new Set(views.flatMap((v) => v.files));
  const orphanOn = picks.filter((p) => !known.has(p.file) && !strays.some((s) => s.file === p.file));

  if (!model.crackio) return <p className="text-[13px] text-haze">Crackio can&rsquo;t run this model yet, so it takes no LoRAs.</p>;

  return (
    <div className="space-y-7">
      <p className="max-w-[78ch] text-[13px] leading-relaxed text-haze">
        A LoRA is a small add-on trained for one model: a look, a camera move, a fix. Switch one on and every {clip ? "clip" : "picture"} {model.name} makes, in every tool, carries it. Up to{" "}
        {MAX_LORAS} at once; strength sets how much.
      </p>

      {error && !library ? (
        <p className="flex items-center gap-2 rounded-[12px] bg-tally/10 px-3.5 py-2.5 text-[13px] text-tally">
          <TriangleAlert size={14} /> Couldn&rsquo;t load the LoRA library: {error}
        </p>
      ) : null}

      <section aria-label={`Your LoRAs for ${model.name}`}>
        <Heading title={`Yours on ${model.name}`} hint={picks.length ? `${picks.length} on` : undefined} />
        {yours.length || orphanOn.length ? (
          <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-[16px] bg-white/[0.03]">
            {yours.map((v) => (
              <LoraRow key={v.entry.id} view={v} crackio={crackio} picks={picks} status={status} model={model} />
            ))}
            {orphanOn.map((p) => (
              <FileRow key={p.file} file={p.file} where={[]} crackio={crackio} picks={picks} />
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-[14px] bg-white/[0.025] px-4 py-3.5 text-[13px] leading-relaxed text-haze">
            None yet. Add one of the picks below: it downloads to {targets.length ? targets.map((t) => machineName(t)).join(" and ") : "your GPU"} and switches on.
          </p>
        )}
      </section>

      <Picks views={views.filter((v) => !v.entry.found)} crackio={crackio} picks={picks} status={status} model={model} targets={targets} compact={compact} loading={!library && !error} />

      <HubSearch model={model} picks={picks} status={status} targets={targets} />

      {strays.length ? (
        <section aria-label="Other LoRA files">
          <Heading title="Other LoRA files on your machines" hint="Put there by hand, or for another model: Crackio can't tell what they're for" />
          <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-[16px] bg-white/[0.03]">
            {strays.map((s) => (
              <FileRow key={s.file} file={s.file} where={s.targets} crackio={crackio} picks={picks} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Heading({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <h3 className="label">
        {title}
        {hint ? <span className="ml-2 font-medium normal-case tracking-normal text-haze/80">{hint}</span> : null}
      </h3>
      {action}
    </div>
  );
}

/** Switch every file of a LoRA on (at a strength) or off, for one model; a seventh asks for one to go first. */
function useToggle(crackio: string, picks: LoraPick[]) {
  const [full, setFull] = useState(false);
  const set = (files: string[], strength: number | null) => {
    const adding = strength !== null ? files.filter((f) => !picks.some((p) => p.file === f)).length : 0;
    if (adding && picks.length + adding > MAX_LORAS) {
      setFull(true);
      setTimeout(() => setFull(false), 4000);
      return;
    }
    for (const f of files) setLora(crackio, f, strength);
  };
  return { set, full };
}

/** A LoRA you have: on or off, how strong, the words it adds, the machines it's on, and a way to delete it. */
function LoraRow({ view, crackio, picks, status, model }: { view: LoraView; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel }) {
  const { entry, files } = view;
  const mine = picks.filter((p) => files.includes(p.file));
  const on = mine.length === files.length && files.length > 0;
  const strength = mine[0]?.strength ?? entry.strength;
  const { set, full } = useToggle(crackio, picks);
  const downloads = loraDownloads(status, files);
  const trigger = autoTrigger(entry.trigger);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const missing = view.missing.filter((t) => !downloads.active.some((d) => d.target.id === t.id));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-3">
      <Thumb entry={entry} size={44} />
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="flex items-center gap-2 truncate text-[13.5px] font-semibold text-paper">
          <span className="truncate">{entry.name}</span>
          {entry.found ? <span className="shrink-0 rounded-full bg-white/[0.07] px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-haze">Hugging Face</span> : null}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-haze">
          {[categoryLabel(entry.category), trigger ? `adds “${trigger}”` : entry.trigger ? `prompt with ${entry.trigger}` : null, view.installed.length ? `on ${view.installed.map(machineName).join(", ")}` : null].filter(Boolean).join(" · ")}
        </p>
        {downloads.active.length ? <Progress share={downloads.share} checking={downloads.checking} /> : null}
        {missing.length && view.installed.length && !downloads.active.length ? (
          <button
            type="button"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              setProblem(await addLora(model, entry, missing, entry.files[0]));
              setWorking(false);
            }}
            className="press mt-1 inline-flex items-center gap-1 text-[11.5px] font-semibold text-tungsten hover:text-paper"
          >
            {working ? <LoaderCircle size={11} className="animate-spin" /> : <Download size={11} />} Not on {missing.map(machineName).join(", ")} yet: download there too
          </button>
        ) : null}
        {full ? <p className="mt-1 text-[11.5px] text-tungsten">Up to {MAX_LORAS} at once: switch one off first.</p> : null}
        {problem || downloads.failed?.error ? <Problem text={problem ?? downloads.failed!.error!} /> : null}
      </div>
      {on ? (
        <div className="w-[min(200px,100%)] shrink-0">
          <Slider
            label="Strength"
            value={strength}
            min={entry.range[0]}
            max={entry.range[1]}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set(files, Math.round(v * 100) / 100)}
          />
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch checked={on} onChange={(v) => set(files, v ? entry.strength : null)} title={on ? "Switch off" : "Switch on"} />
        <DeleteMenu files={files} where={view.installed} onDeleted={() => set(files, null)} />
      </div>
    </div>
  );
}

/** A LoRA file nothing explains: switch it on for this model at your own risk (it may be made for another one). */
function FileRow({ file, where, crackio, picks }: { file: string; where: TargetStatus[]; crackio: string; picks: LoraPick[] }) {
  const pick = picks.find((p) => p.file === file);
  const { set, full } = useToggle(crackio, picks);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-haze">
        <Sparkles size={16} />
      </span>
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="truncate text-[13px] font-semibold text-paper" title={file}>
          {file.replace(/\.safetensors$/i, "")}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-haze">{where.length ? `On ${where.map(machineName).join(", ")}` : "Not on any machine that answers now"}</p>
        {full ? <p className="mt-1 text-[11.5px] text-tungsten">Up to {MAX_LORAS} at once: switch one off first.</p> : null}
      </div>
      {pick ? (
        <div className="w-[min(200px,100%)] shrink-0">
          <Slider label="Strength" value={pick.strength} min={-2} max={2} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set([file], Math.round(v * 100) / 100)} />
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch checked={Boolean(pick)} onChange={(v) => set([file], v ? 1 : null)} title={pick ? "Switch off" : "Use with this model"} />
        {where.length ? <DeleteMenu files={[file]} where={where} onDeleted={() => set([file], null)} /> : null}
      </div>
    </div>
  );
}

/** Delete a LoRA's files from one machine, asked twice. */
function DeleteMenu({ files, where, onDeleted }: { files: string[]; where: TargetStatus[]; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (setOpen(false), setSure(null));
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (!where.length) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label="Delete" title="Delete from a machine" className="press grid size-8 place-items-center rounded-full text-haze hover:bg-white/[0.07] hover:text-paper">
        <Trash2 size={14} />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-30 w-[230px] rounded-[14px] bg-[#1b1920] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.5),inset_0_0_0_1px_rgb(255_255_255/0.06)]">
          {where.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={working}
              onClick={async () => {
                if (sure !== t.id) return setSure(t.id);
                setWorking(true);
                let failed: string | null = null;
                for (const f of files) failed = (await deleteLoraFile(f, t)) ?? failed;
                setWorking(false);
                setProblem(failed);
                if (!failed) {
                  setOpen(false);
                  setSure(null);
                  if (where.length === 1) onDeleted();
                }
              }}
              className={cn("press flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[12.5px] font-semibold", sure === t.id ? "bg-tally/15 text-tally" : "text-fog hover:bg-white/[0.06] hover:text-paper")}
            >
              {working && sure === t.id ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {sure === t.id ? `Delete it from ${machineName(t)}?` : `Delete from ${machineName(t)}`}
            </button>
          ))}
          {problem ? <Problem text={problem} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Crackio's picks for the model: checked files, by what they do. */
function Picks({
  views,
  crackio,
  picks,
  status,
  model,
  targets,
  compact,
  loading,
}: {
  views: LoraView[];
  crackio: string;
  picks: LoraPick[];
  status: LocalStatus | null;
  model: LocalModel;
  targets: TargetStatus[];
  compact: boolean;
  loading: boolean;
}) {
  const [category, setCategory] = useState<LoraCategory | "all">("all");
  const kinds = LORA_CATEGORIES.filter((c) => views.some((v) => v.entry.category === c.id));
  const shown = views.filter((v) => category === "all" || v.entry.category === category);
  return (
    <section aria-label={`Best LoRAs for ${model.name}`}>
      <Heading title={`Best LoRAs for ${model.name}`} hint={views.length ? "Checked by Crackio: right model, safe files, licence shown" : undefined} />
      {kinds.length > 1 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="What they do">
          {[{ id: "all" as const, label: "All", hint: "" }, ...kinds].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={category === c.id}
              title={c.hint}
              className={cn("press h-8 rounded-full px-3 text-[12.5px] font-semibold", category === c.id ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:text-paper")}
            >
              {c.label}
              {c.id !== "all" ? <span className={cn("ml-1.5 text-[11px] tabular-nums", category === c.id ? "text-[#16131b]/60" : "text-haze")}>{views.filter((v) => v.entry.category === c.id).length}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {loading ? (
        <div className={cn("mt-3 grid gap-2.5", compact ? "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(230px,1fr))]")}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-[290px] rounded-[18px]" />
          ))}
        </div>
      ) : shown.length ? (
        <div className={cn("mt-3 grid gap-2.5", compact ? "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(230px,1fr))]")}>
          {shown.map((v) => (
            <PickCard key={v.entry.id} view={v} crackio={crackio} picks={picks} status={status} model={model} targets={targets} />
          ))}
        </div>
      ) : (
        <p className="mt-2 rounded-[14px] bg-white/[0.025] px-4 py-3.5 text-[13px] leading-relaxed text-haze">
          No checked LoRAs for {model.name} yet: few exist for it so far. Search Hugging Face below for what people have made.
        </p>
      )}
    </section>
  );
}

function PickCard({ view, crackio, picks, status, model, targets }: { view: LoraView; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; targets: TargetStatus[] }) {
  const { entry, files } = view;
  const on = files.length > 0 && files.every((f) => picks.some((p) => p.file === f));
  const downloads = loraDownloads(status, files);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { set, full } = useToggle(crackio, picks);
  const trigger = autoTrigger(entry.trigger);
  const lic = LICENCE[entry.licence.commercial];
  const needsToken = Boolean(entry.gated) && !status?.hfToken;
  const ready = view.installed.length > 0;

  async function add() {
    setWorking(true);
    setProblem(await addLora(model, entry, view.missing.length ? view.missing : targets));
    setWorking(false);
  }

  let action: ReactNode;
  if (downloads.active.length) action = <Progress share={downloads.share} checking={downloads.checking} />;
  else if (ready && on)
    action = (
      <button type="button" onClick={() => set(files, null)} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-chroma/15 px-3 text-[12px] font-bold text-chroma hover:bg-chroma/25" title="Switch off">
        <Check size={13} strokeWidth={3} /> On
      </button>
    );
  else if (ready)
    action = (
      <button type="button" onClick={() => set(files, entry.strength)} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3 text-[12px] font-bold text-[#16131b] hover:bg-white">
        <Plus size={13} strokeWidth={3} /> Switch on
      </button>
    );
  else if (!targets.length) action = <span className="text-[11.5px] text-haze">Connect a GPU on the Local page to add it.</span>;
  else if (needsToken)
    action = (
      <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.1] px-3 text-[12px] font-bold text-paper hover:bg-white/[0.16]">
        <KeyRound size={13} /> Accept on Hugging Face <ArrowUpRight size={12} />
      </a>
    );
  else
    action = (
      <button
        type="button"
        onClick={() => void add()}
        disabled={working}
        className="lip press inline-flex h-8 items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70"
      >
        {working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} Add · {gb(bytesOf(entry))}
      </button>
    );

  return (
    <article className="squircle flex flex-col overflow-hidden rounded-[18px] bg-white/[0.035]">
      <div className="relative aspect-[4/3] overflow-hidden bg-white/[0.03]">
        <Cover entry={entry} />
        <span className="absolute left-2 top-2 flex gap-1">
          <span className="rounded-full bg-[#0d0c11]/75 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-paper">{categoryLabel(entry.category)}</span>
          {entry.tested ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-[#0d0c11]/75 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-chroma"
              title="Crackio ran it on an RTX 5090, with and without it on the same seed: it did what it promises"
            >
              <Check size={10} strokeWidth={3} /> Tested
            </span>
          ) : null}
        </span>
        {on ? (
          <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-spike text-spike-ink shadow-[0_2px_8px_rgb(0_0_0/0.4)]">
            <Check size={14} strokeWidth={3} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h4 className="text-[14px] font-semibold leading-snug text-paper">{entry.name}</h4>
        <p className="mt-0.5 truncate text-[11.5px] text-haze">
          by{" "}
          <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className="hover:text-paper hover:underline">
            {entry.author}
          </a>
          {entry.downloads ? ` · ${count(entry.downloads)} downloads a month` : ""}
          {entry.likes ? (
            <>
              {" · "}
              <Heart size={10} className="inline -translate-y-px" /> {count(entry.likes)}
            </>
          ) : null}
        </p>
        <p className="mt-2 text-[12.5px] leading-snug text-fog">{entry.blurb}</p>
        {trigger && trigger.length > 48 ? (
          <More label="Adds its own instruction to your prompt" text={trigger} />
        ) : trigger ? (
          <p className="mt-1.5 text-[11.5px] text-haze">
            Adds <span className="font-semibold text-paper">“{trigger}”</span> to your prompt
          </p>
        ) : entry.trigger ? (
          <p className="mt-1.5 text-[11.5px] text-haze">
            Prompt with <span className="font-semibold text-paper">{entry.trigger}</span>
          </p>
        ) : null}
        {entry.note ? <More label={entry.note.length > 90 ? `${entry.note.slice(0, 84).replace(/\s+\S*$/, "")}…` : entry.note} text={entry.note.length > 90 ? entry.note : null} /> : null}
        <div className="mt-auto pt-3">
          <p className="mb-2 flex flex-wrap gap-x-2 text-[11px]">
            <span className={lic.className} title={entry.licence.name}>
              {lic.text}
            </span>
            {entry.gated ? <span className="text-haze">Gated on Hugging Face</span> : null}
          </p>
          {action}
          {full ? <p className="mt-1.5 text-[11.5px] text-tungsten">Up to {MAX_LORAS} at once: switch one off first.</p> : null}
          {problem || downloads.failed?.error ? <Problem text={problem ?? downloads.failed!.error!} /> : null}
        </div>
      </div>
    </article>
  );
}

/** A line that opens to the whole text (a long instruction a LoRA adds, or how to prompt it). */
function More({ label, text }: { label: string; text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return <p className="mt-1.5 text-[11.5px] leading-snug text-haze">{label}</p>;
  return (
    <div className="mt-1.5 text-[11.5px] leading-snug text-haze">
      {open ? <p className="whitespace-pre-line">{text}</p> : <p>{label}</p>}
      <button type="button" onClick={() => setOpen(!open)} className="press mt-0.5 font-semibold text-fog hover:text-paper">
        {open ? "Less" : "Read more"}
      </button>
    </div>
  );
}

/** A pick's picture (made small on the server), or a field in its kind's colour with its name. */
function Cover({ entry }: { entry: LoraEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.preview && !entry.found && !failed)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/api/local/loras/preview/${encodeURIComponent(entry.id)}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
    );
  return (
    <div className="absolute inset-0 grid place-items-center" style={{ background: `radial-gradient(120% 90% at 30% 20%, oklch(0.5 0.13 ${hue(entry.category)} / 0.55), transparent 70%)` }}>
      <span className="px-4 text-center font-display text-[22px] uppercase leading-[0.95] text-white/25">{entry.name}</span>
    </div>
  );
}

function Thumb({ entry, size }: { entry: LoraEntry; size: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative shrink-0 overflow-hidden rounded-[12px] bg-white/[0.05]" style={{ width: size, height: size }}>
      {entry.preview && !entry.found && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/local/loras/preview/${encodeURIComponent(entry.id)}`} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-haze" style={{ background: `oklch(0.45 0.1 ${hue(entry.category)} / 0.35)` }}>
          <Sparkles size={16} />
        </span>
      )}
    </span>
  );
}

const HUES: Record<LoraCategory, number> = { looks: 330, detail: 200, light: 85, angles: 260, motion: 290, effects: 30, edit: 160, characters: 350, world: 140, design: 55, speed: 110 };
const hue = (c: LoraCategory) => HUES[c] ?? 250;

function Progress({ share, checking }: { share: number; checking: boolean }) {
  return (
    <div className="mt-1.5 w-full">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
        <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(3, share * 100)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-fog">{checking ? "Checking the file…" : `Downloading · ${Math.round(share * 100)}%`}</p>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <p className="mt-1.5 flex items-start gap-1 text-[11.5px] leading-snug text-tally">
      <TriangleAlert size={12} className="mt-px shrink-0" /> {text}
    </p>
  );
}

const SORTS = [
  { id: "downloads", label: "Most downloaded" },
  { id: "likes", label: "Most liked" },
  { id: "trendingScore", label: "Trending" },
] as const;

/** Every other LoRA on Hugging Face made for the model: searched there, filtered, downloaded like a pick. */
function HubSearch({ model, picks, status, targets }: { model: LocalModel; picks: LoraPick[]; status: LocalStatus | null; targets: TargetStatus[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("downloads");
  const [open, setOpen] = useState(false);
  // The last answer and what it was for: busy while the words or order on screen have none yet.
  const [answer, setAnswer] = useState<{ key: string; entries: LoraEntry[]; error: string | null } | null>(null);
  const key = `${model.id}|${sort}|${query.trim()}`;
  const busy = open && answer?.key !== key;
  const results = answer?.entries ?? null;
  const problem = answer?.error ?? null;
  const bases = useLoraLibrary((s) => s.library?.bases[model.id]) ?? [];
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(async () => {
      const out = await searchLoras(model, query, sort);
      if (live) setAnswer({ key: `${model.id}|${sort}|${query.trim()}`, entries: out.entries, error: out.error ?? null });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query, sort, model]);

  if (!bases.length) return null;
  return (
    <section aria-label="Search Hugging Face">
      <Heading title="More on Hugging Face" hint={`Every LoRA made for ${model.name}, searched live`} />
      {open ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <label className="field-focus flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-full bg-white/[0.05] px-3.5 sm:max-w-[360px]">
              <Search size={14} className="shrink-0 text-haze" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name: film, pixel, anime, detail…" aria-label="Search LoRAs" className="min-w-0 flex-1 bg-transparent text-[13px] text-paper outline-none placeholder:text-haze" />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear the search" className="press text-haze hover:text-paper">
                  <X size={14} />
                </button>
              ) : null}
            </label>
            <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12px]" role="group" aria-label="Order">
              {SORTS.map((s) => (
                <button key={s.id} type="button" onClick={() => setSort(s.id)} aria-pressed={sort === s.id} className={cn("press h-8 rounded-full px-3 font-semibold", sort === s.id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
                  {s.label}
                </button>
              ))}
            </div>
            {busy ? <LoaderCircle size={15} className="animate-spin text-haze" /> : null}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-haze">
            Found here, not checked by Crackio: read the card before using one for work. Adult, real-people and branded LoRAs are left out, and finds show no pictures.
          </p>
          {problem ? <Problem text={problem} /> : null}
          {results && !results.length && !busy ? <p className="mt-3 text-[13px] text-haze">Nothing more matches{query ? ` “${query}”` : ""}.</p> : null}
          {results?.length ? (
            <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-[16px] bg-white/[0.03]">
              {results.map((e) => (
                <FoundRow key={e.id} entry={e} picks={picks} status={status} model={model} targets={targets} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press mt-2.5 inline-flex h-9 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper"
        >
          <Search size={14} /> Search Hugging Face for {model.name} LoRAs
        </button>
      )}
    </section>
  );
}

/** A LoRA found on Hugging Face: its numbers, licence and files; Add picks the file when the repo has several. */
function FoundRow({ entry, picks, status, model, targets }: { entry: LoraEntry; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; targets: TargetStatus[] }) {
  const [files, setFiles] = useState<LoraFile[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lic = LICENCE[entry.licence.commercial];
  const records = useLoraLibrary((s) => s.library?.records);
  const mine = Object.values(records ?? {}).filter((r) => r.repo === entry.repo);
  const onDisk = mine.filter((r) => holders(status, r.file).length);
  const downloads = loraDownloads(
    status,
    mine.map((r) => r.file),
  );
  const on = onDisk.some((r) => picks.some((p) => p.file === r.file));

  async function add(file?: LoraFile) {
    setWorking(true);
    setProblem(null);
    let pick = file;
    if (!pick) {
      const out = files ? { files } : await repoLoraFiles(entry.repo);
      if ("error" in out && out.error) {
        setProblem(out.error);
        setWorking(false);
        return;
      }
      setFiles(out.files);
      if (out.files.length !== 1) {
        setChoosing(true);
        setWorking(false);
        if (!out.files.length) setProblem("No .safetensors LoRA file in this repo.");
        return;
      }
      pick = out.files[0];
    }
    setChoosing(false);
    setProblem(await addLora(model, { ...entry, files: [pick] }, targets, pick));
    setWorking(false);
  }

  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[220px]">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-paper">
            <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className="truncate hover:underline">
              {entry.name}
            </a>
            <ArrowUpRight size={12} className="shrink-0 text-haze" />
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-haze">
            {[entry.author, `${count(entry.downloads)} downloads`, `${count(entry.likes)} likes`, categoryLabel(entry.category)].join(" · ")}
            {" · "}
            <span className={lic.className} title={entry.licence.name}>
              {lic.text}
            </span>
            {entry.gated ? " · gated" : ""}
          </p>
          {entry.trigger ? <p className="mt-0.5 truncate text-[11.5px] text-haze">Trigger: {entry.trigger}</p> : null}
        </div>
        <div className="shrink-0">
          {downloads.active.length ? (
            <div className="w-[160px]">
              <Progress share={downloads.share} checking={downloads.checking} />
            </div>
          ) : onDisk.length ? (
            <span className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold", on ? "bg-chroma/15 text-chroma" : "bg-white/[0.07] text-fog")}>
              <Check size={13} strokeWidth={3} /> {on ? "On" : "Added"}
            </span>
          ) : !targets.length ? (
            <span className="text-[11.5px] text-haze">Connect a GPU first</span>
          ) : (
            <button
              type="button"
              disabled={working}
              onClick={() => void add()}
              className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.1] px-3 text-[12px] font-bold text-paper hover:bg-white/[0.16] disabled:opacity-70"
            >
              {working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />} Add
            </button>
          )}
        </div>
      </div>
      {choosing && files?.length ? (
        <div className="mt-2.5 rounded-[12px] bg-white/[0.035] p-2">
          <p className="px-1.5 pb-1.5 text-[11.5px] text-haze">This repo has {files.length} LoRA files. Pick one (often the newest or the one its card names):</p>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              disabled={working}
              onClick={() => void add(f)}
              className="press flex w-full items-center justify-between gap-3 rounded-[9px] px-2.5 py-1.5 text-left text-[12.5px] text-fog hover:bg-white/[0.06] hover:text-paper"
            >
              <span className="truncate">{f.path}</span>
              <span className="shrink-0 tabular-nums text-haze">{gb(f.bytes / 1024 ** 3)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {problem ? <Problem text={problem} /> : null}
    </div>
  );
}

/** How many LoRAs are switched on for a model (the model library's card shows it). */
export function useLoraCount(crackio: string | null | undefined) {
  return useModelLoras((s) => (crackio ? (s.byModel[crackio]?.length ?? 0) : 0));
}
