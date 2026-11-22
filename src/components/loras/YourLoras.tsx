"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Download, Eye, LoaderCircle, Pencil, Sparkles, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Panel";
import {
  addLora,
  deleteLoraFile,
  cancelUpload,
  dismissUpload,
  editUploadedLora,
  forgetUploadedLora,
  loadLoraSends,
  loraDownloads,
  sendHomeLora,
  sendTrainedLora,
  stopLoraSend,
  unknownFiles,
  uploadLora,
  useLoraLibrary,
  useLoraTransfers,
  type LoraSend,
  type LoraUpload,
  type LoraView,
} from "@/lib/hooks/use-lora-library";
import { MAX_LORAS, setLora, type LoraPick } from "@/lib/hooks/use-model-loras";
import { autoTrigger, categoryLabel, previewId, type LoraCategory, type LoraEntry } from "@/lib/local/loras";
import { gb } from "@/lib/local/rows";
import type { LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";

/**
 * The LoRAs you have on one model (the "Yours" side of components/loras/ModelLoras): each one on or off, how strong, the
 * machines it's on, sending it to another, deleting it; your own files uploaded from your computer (Crackio keeps them and
 * sends them to whichever GPU you draw on); and LoRA files on your machines that nothing explains. With the small parts
 * the marketplace shares: a LoRA's picture, a download's bar, a problem's line.
 */

export const LICENCE: Record<LoraEntry["licence"]["commercial"], { text: string; className: string }> = {
  yes: { text: "Commercial OK", className: "text-chroma" },
  limited: { text: "Commercial, with limits", className: "text-[var(--color-tool-upscale)]" },
  no: { text: "Non-commercial", className: "text-haze" },
};
export const count = (n: number | undefined) => (!n ? "0" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));
export const bytesOf = (e: LoraEntry) => e.files.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;
// A rented machine by its own name ("RTX 3090 · vast.ai"), not just its cloud: with two boxes on one cloud, "on vast.ai"
// didn't say which one has the file.
export const machineName = (t: TargetStatus) => (t.cloud ? t.label || { vast: "vast.ai", runpod: "RunPod", other: "cloud GPU" }[t.cloud.provider] : t.onThisComputer || t.source === "installed" ? "this computer" : t.label);

/** The LoRAs you have on a model, your uploads, and the files nothing explains. `views`: every LoRA of the model (picks and finds). */
export function YourLoras({ model, views, picks, status, targets }: { model: LocalModel; views: LoraView[]; picks: LoraPick[]; status: LocalStatus | null; targets: TargetStatus[] }) {
  const library = useLoraLibrary((s) => s.library);
  const crackio = model.crackio ?? `local:${model.id}`;
  const onFiles = new Set(picks.map((p) => p.file));
  // One Crackio keeps a copy of (your upload, one trained here) is always listed: it's yours whatever machine is on.
  // Comfy Cloud holds a library of its own (hundreds of files): what's there isn't yours until you switch it on.
  const yours = views.filter((v) => v.installed.some((t) => t.id !== "comfy-cloud") || v.files.some((f) => onFiles.has(f)) || loraDownloads(status, v.files).active.length > 0 || Boolean(v.entry.uploaded || v.entry.trained));
  const strays = useMemo(
    () =>
      unknownFiles(library, status)
        .map((x) => ({ ...x, targets: x.targets.filter((t) => t.id !== "comfy-cloud") }))
        .filter((x) => x.targets.length > 0),
    [library, status],
  );
  const known = new Set(views.flatMap((v) => v.files));
  const orphanOn = picks.filter((p) => !known.has(p.file) && !strays.some((s) => s.file === p.file));

  // Your own files: on their way from this browser, then from Crackio to machines (asked while this page is open).
  const transfers = useLoraTransfers();
  const uploads = transfers.uploads.filter((u) => u.model === model.id);
  useEffect(() => {
    void loadLoraSends();
    const t = setInterval(() => void loadLoraSends(), 2500);
    return () => clearInterval(t);
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // The file just uploaded that came without trigger words: its line opens asking for them.
  const [fresh, setFresh] = useState<string | null>(null);
  const take = (list: FileList | null) => {
    for (const f of Array.from(list ?? []).slice(0, 6)) void uploadLora(model, f, targets, (file, record) => !record?.trigger && setFresh(file));
  };

  return (
    <div className="space-y-7">
      <section
        aria-label={`Your LoRAs for ${model.name}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={cn("rounded-[18px] transition-shadow duration-150", over && "shadow-[0_0_0_2px_var(--color-spike),0_0_0_8px_rgb(255_255_255/0.03)]")}
      >
        <Heading
          title={`Yours on ${model.name}`}
          hint={picks.length ? `${picks.length} on` : undefined}
          action={
            <>
              <input
                ref={input}
                type="file"
                accept=".safetensors"
                multiple
                hidden
                onChange={(e) => {
                  take(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => input.current?.click()}
                title="A .safetensors LoRA from your computer: Crackio keeps it and sends it to whichever GPU you draw on"
                className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 text-[12px] font-bold text-paper hover:bg-white/[0.12]"
              >
                <Upload size={13} strokeWidth={2.4} /> Upload a LoRA
              </button>
            </>
          }
        />
        {yours.length || orphanOn.length || uploads.length ? (
          <div className="mt-2.5 divide-y divide-line rounded-[16px] bg-white/[0.03]">
            {uploads.map((u) => (
              <UploadRow key={u.id} upload={u} sends={transfers.sends} />
            ))}
            {yours.map((v) => (
              <LoraRow key={v.entry.id} view={v} crackio={crackio} picks={picks} status={status} model={model} sends={transfers.sends} fresh={fresh !== null && v.files.includes(fresh)} />
            ))}
            {orphanOn.map((p) => (
              <FileRow key={p.file} file={p.file} where={[]} crackio={crackio} picks={picks} />
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-[14px] bg-white/[0.025] px-4 py-3.5 text-[13px] leading-relaxed text-haze">None yet. Add one from Browse, or upload your own .safetensors file (drop it here).</p>
        )}
        {yours.length || uploads.length ? <p className="mt-2 px-0.5 text-[11.5px] leading-relaxed text-haze">Your own file? Upload it, or drop it here: Crackio keeps it and sends it to each GPU the first time you use it there.</p> : null}
      </section>

      {strays.length ? (
        <section aria-label="Other LoRA files">
          <Heading title="Other LoRA files on your machines" hint="Put there by hand, or for another model" />
          <div className="mt-2.5 divide-y divide-line rounded-[16px] bg-white/[0.03]">
            {strays.map((s) => (
              <FileRow key={s.file} file={s.file} where={s.targets} crackio={crackio} picks={picks} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function Heading({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
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
export function useToggle(crackio: string, picks: LoraPick[]) {
  const [full, setFull] = useState(false);
  // "Seven at most" shows for a few seconds.
  useEffect(() => {
    if (!full) return;
    const t = setTimeout(() => setFull(false), 4000);
    return () => clearTimeout(t);
  }, [full]);
  const set = (files: string[], strength: number | null) => {
    const adding = strength !== null ? files.filter((f) => !picks.some((p) => p.file === f)).length : 0;
    if (adding && picks.length + adding > MAX_LORAS) {
      setFull(true);
      return;
    }
    for (const f of files) setLora(crackio, f, strength);
  };
  return { set, full };
}

/** Your file on its way: from this browser to Crackio, a check, then to the machines the model is on. */
function UploadRow({ upload, sends }: { upload: LoraUpload; sends: LoraSend[] }) {
  const going = sends.filter((s) => s.file === upload.file && s.state === "sending");
  const share = upload.stage === "sending" ? (going.length ? going.reduce((n, s) => n + s.share, 0) / going.length : 0) : upload.share;
  const label =
    upload.stage === "sending" ? `Kept on this computer. ${going.length === 1 ? sendWords(going[0]) : `Sending to ${going.length ? going.map((s) => s.label).join(", ") : "your GPU"}`}` : upload.stage === "checking" ? "Checking the file" : `Uploading to Crackio (${upload.bytes >= 1024 ** 3 ? gb(upload.bytes / 1024 ** 3) : `${Math.max(1, Math.round(upload.bytes / 1024 ** 2))} MB`})`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-haze">{upload.stage === "error" ? <TriangleAlert size={16} className="text-tally" /> : <Upload size={16} />}</span>
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="truncate text-[13.5px] font-semibold text-paper" title={upload.name}>
          {upload.name.replace(/\.safetensors$/i, "")}
        </p>
        {upload.stage === "error" ? <Problem text={upload.error ?? "That didn't work."} /> : <Progress share={share} checking={false} label={label} />}
      </div>
      {upload.stage === "error" ? (
        <button type="button" onClick={() => dismissUpload(upload.id)} aria-label="Close" className="press grid size-8 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.07] hover:text-paper">
          <X size={14} />
        </button>
      ) : upload.stage === "uploading" ? (
        <button type="button" onClick={() => cancelUpload(upload.id)} aria-label="Stop the upload" title="Stop the upload" className="press grid size-8 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.07] hover:text-paper">
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** An uploaded LoRA's own words: its name, the trigger words Crackio adds to every prompt, and where they go. */
function EditUpload({ entry, file, asked, onClose }: { entry: LoraEntry; file: string; asked: boolean; onClose: () => void }) {
  const [name, setName] = useState(entry.name);
  const [trigger, setTrigger] = useState(entry.trigger ?? "");
  const [last, setLast] = useState(entry.triggerAt === "end");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = "field-focus mt-1 h-9 w-full rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze";
  return (
    <form
      className="basis-full rounded-[12px] bg-white/[0.035] p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        const failed = await editUploadedLora(file, { name, trigger, triggerAt: last ? "end" : "start" });
        setSaving(false);
        if (failed) setProblem(failed);
        else onClose();
      }}
    >
      {asked ? (
        <p className="mb-2.5 text-[12px] leading-relaxed text-fog">
          Does it need trigger words? Type them here and Crackio adds them to every prompt for you. Leave it empty if it needs none.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2.5">
        <label className="min-w-[170px] flex-1 text-[11.5px] font-semibold text-haze">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={field} />
        </label>
        <label className="min-w-[200px] flex-[1.5] text-[11.5px] font-semibold text-haze">
          Trigger words
          <input value={trigger} onChange={(e) => setTrigger(e.target.value)} maxLength={160} placeholder="The words it was trained with, if any" autoFocus={asked} className={field} />
        </label>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12px]" role="group" aria-label="Where the trigger words go in your prompt">
          {[
            { on: !last, label: "Words first", set: false, hint: "Before your prompt: the usual place for a person, a character or an object" },
            { on: last, label: "Words last", set: true, hint: "After your prompt: the usual place for a look (“…, in mystyle style”)" },
          ].map((o) => (
            <button key={o.label} type="button" onClick={() => setLast(o.set)} aria-pressed={o.on} title={o.hint} className={cn("press h-7 rounded-full px-3 font-semibold", o.on ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onClose} className="press h-8 rounded-full px-3 text-[12px] font-semibold text-fog hover:text-paper">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[12px] font-bold text-[#16131b] hover:bg-white disabled:opacity-70">
            {saving ? <LoaderCircle size={13} className="animate-spin" /> : null} Save
          </button>
        </div>
      </div>
      {problem ? <Problem text={problem} /> : null}
    </form>
  );
}

/** A LoRA you have: on or off, how strong, the words it adds, the machines it's on, and a way to delete it. */
function LoraRow({ view, crackio, picks, status, model, sends, fresh }: { view: LoraView; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; sends: LoraSend[]; fresh: boolean }) {
  const { entry, files } = view;
  // Crackio keeps its own copy (your upload, or one trained here): it has no repo to download from, it's sent.
  const kept = Boolean(entry.trained || entry.uploaded);
  const going = sends.filter((s) => files.includes(s.file) && s.state === "sending");
  const [editing, setEditing] = useState(fresh);
  const mine = picks.filter((p) => files.includes(p.file));
  const on = mine.length === files.length && files.length > 0;
  const strength = mine[0]?.strength ?? entry.strength;
  const { set, full } = useToggle(crackio, picks);
  const downloads = loraDownloads(status, files);
  const trigger = autoTrigger(entry.trigger);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const missing = view.missing.filter((t) => !downloads.active.some((d) => d.target.id === t.id) && !going.some((s) => s.target === t.id));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-3">
      <Thumb entry={entry} size={44} />
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="flex items-center gap-2 truncate text-[13.5px] font-semibold text-paper">
          <span className="truncate">{entry.name}</span>
          {entry.trained ? (
            <span className="shrink-0 rounded-full bg-daylight/12 px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-daylight">Trained by you</span>
          ) : entry.uploaded ? (
            <span className="shrink-0 rounded-full bg-daylight/12 px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-daylight">Your file</span>
          ) : entry.found ? (
            <span className="shrink-0 rounded-full bg-white/[0.07] px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] text-haze">Hugging Face</span>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-haze">
          {[
            categoryLabel(entry.category),
            trigger ? `adds “${trigger}”` : entry.trigger ? `prompt with ${entry.trigger}` : entry.uploaded ? "no trigger words" : null,
            entry.fits ? `fits ${model.name}` : null,
            view.installed.length ? `on ${view.installed.map(machineName).join(", ")}` : kept ? "kept on this computer" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {entry.warning ? (
          <p className="mt-1 flex items-start gap-1 text-[11.5px] leading-snug text-tungsten">
            <TriangleAlert size={12} className="mt-px shrink-0" /> {entry.warning}
          </p>
        ) : null}
        {downloads.active.length ? <Progress share={downloads.share} checking={downloads.checking} /> : null}
        {/* Each machine it's travelling to has its own line: where it's going, how much has arrived, and a way to stop it. */}
        {going.map((s) => (
          <div key={s.target} className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <Progress share={s.share} checking={false} label={sendWords(s)} />
            </div>
            <button type="button" onClick={() => void stopLoraSend(s.file, s.target)} title="Stop sending" aria-label={`Stop sending to ${s.label}`} className="press grid size-6 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.07] hover:text-paper">
              <X size={12} />
            </button>
          </div>
        ))}
        {/* And each machine it isn't on has its own button: you say where it goes. One you pay per job is never sent to
            along with the others (it used to be, first in line, and held the rest up). */}
        {missing.length && (view.installed.length || kept) && !downloads.active.length ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            <span className="text-haze">Not on</span>
            {missing.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  setProblem(null);
                  // The spinner only until the send shows on its own line (a moment): the file may travel for minutes.
                  const sent = entry.trained ? sendTrainedLora(entry.trained, [t]) : entry.uploaded ? sendHomeLora(files[0], [t]) : addLora(model, entry, [t], entry.files[0]);
                  setTimeout(() => setWorking(false), 2500);
                  const said = await sent;
                  if (said) setProblem(`${t.label}: ${said}`);
                }}
                title={t.metered ? "This one is billed per job: sending the file there runs a short paid job" : kept ? "Crackio sends it there by itself before the first job that uses it; this sends it now" : undefined}
                className={cn("press inline-flex items-center gap-1 font-semibold hover:text-paper", kept ? "text-fog" : "text-tungsten")}
              >
                {working ? <LoaderCircle size={11} className="animate-spin" /> : kept ? <Upload size={11} /> : <Download size={11} />} {t.label}
                {t.metered ? " (paid job)" : ""}: {kept ? "send it now" : "download there"}
              </button>
            ))}
          </p>
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
        {entry.uploaded ? (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-label="Change its name and trigger words"
            aria-expanded={editing}
            title="Name and trigger words"
            className={cn("press grid size-8 place-items-center rounded-full hover:bg-white/[0.07] hover:text-paper", editing ? "bg-white/[0.07] text-paper" : "text-haze")}
          >
            <Pencil size={13} />
          </button>
        ) : null}
        <DeleteMenu files={files} where={view.installed} onDeleted={() => set(files, null)} forget={entry.uploaded ? files[0] : undefined} />
      </div>
      {editing && entry.uploaded ? <EditUpload entry={entry} file={files[0]} asked={fresh && !entry.trigger} onClose={() => setEditing(false)} /> : null}
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

/** Delete a LoRA's files from one machine, asked twice; `forget`: an uploaded file, which can also go everywhere at once. */
function DeleteMenu({ files, where, onDeleted, forget }: { files: string[]; where: TargetStatus[]; onDeleted: () => void; forget?: string }) {
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
  if (!where.length && !forget) return null;
  return (
    <div
      ref={ref}
      className="relative"
      // While it's open, Escape closes this menu, not the model library around it.
      data-own-escape={open || undefined}
      onKeyDown={(e) => {
        if (!open || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setSure(null);
        ref.current?.querySelector<HTMLElement>("button")?.focus();
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Delete"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Delete from a machine"
        className="press grid size-8 place-items-center rounded-full text-haze hover:bg-white/[0.07] hover:text-paper"
      >
        <Trash2 size={14} />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-9 z-30 w-[230px] rounded-[14px] bg-[#1b1920] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.5),inset_0_0_0_1px_rgb(255_255_255/0.06)]">
          {where.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
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
          {forget ? (
            <button
              type="button"
              role="menuitem"
              disabled={working}
              title="Crackio's copy on this computer, and the file on every machine that's on now"
              onClick={async () => {
                if (sure !== "everywhere") return setSure("everywhere");
                setWorking(true);
                const failed = await forgetUploadedLora(forget);
                setWorking(false);
                setProblem(failed);
                if (!failed) {
                  setOpen(false);
                  setSure(null);
                  onDeleted();
                }
              }}
              className={cn("press flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[12.5px] font-semibold", sure === "everywhere" ? "bg-tally/15 text-tally" : "text-fog hover:bg-white/[0.06] hover:text-paper")}
            >
              {working && sure === "everywhere" ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {sure === "everywhere" ? "Delete it everywhere?" : "Delete everywhere"}
            </button>
          ) : null}
          {problem ? <Problem text={problem} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Where a LoRA's example is served from, when the library shows one for it: its small still, or the loop of one that moves. */
export const previewUrl = (entry: LoraEntry, kind: boolean | "blur" = false) =>
  entry.preview ? `/api/local/loras/preview/${encodeURIComponent(previewId(entry.id))}${kind === "blur" ? "?v=blur" : kind ? "?v=clip" : ""}` : null;

/**
 * A LoRA nobody at Crackio looked at shows its maker's own example; one whose words say that example may be suggestive
 * (`blur`) shows a smear of its colours and a button instead. Once asked for, it shows on its card and on its page
 * alike, for this visit.
 */
const peeked = new Set<string>();
const peekers = new Set<() => void>();
const watchPeeks = (changed: () => void) => {
  peekers.add(changed);
  return () => void peekers.delete(changed);
};
export function usePeek(entry: LoraEntry): { waits: boolean; show: () => void } {
  const asked = useSyncExternalStore(
    watchPeeks,
    () => peeked.has(entry.id),
    () => false,
  );
  return {
    waits: Boolean(entry.unchecked && entry.blur && entry.preview) && !asked,
    show: () => {
      peeked.add(entry.id);
      peekers.forEach((tell) => tell());
    },
  };
}

/**
 * A LoRA's example (made small on the server), or a field in its kind's colour with its name. `play`: an example that
 * moves plays as a muted loop over its still (a card under the pointer, the LoRA's own page).
 */
export function Cover({ entry, play = false, fit = "cover" }: { entry: LoraEntry; play?: boolean; fit?: "cover" | "contain" }) {
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const { waits } = usePeek(entry);
  const still = previewUrl(entry);
  if (!still || failed)
    return (
      <div className="absolute inset-0 grid place-items-center" style={{ background: `radial-gradient(120% 90% at 30% 20%, oklch(0.5 0.13 ${hue(entry.category)} / 0.55), transparent 70%)` }}>
        <span className="line-clamp-3 px-4 text-center font-display text-[20px] uppercase leading-[0.95] text-white/25">{entry.name}</span>
      </div>
    );
  // Kept back: a smear of its colours (40 px, blurred on the server: the picture itself isn't fetched yet) fills the
  // card, with the button in the middle.
  if (waits)
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={previewUrl(entry, "blur")!} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full scale-125 object-cover" />
        <span className="absolute inset-0 bg-[#0d0c11]/25" aria-hidden="true" />
        <span className="absolute left-1/2 top-1/2 inline-flex h-8 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-[#0d0c11]/80 px-3.5 text-[12px] font-semibold text-paper shadow-[0_2px_12px_rgb(0_0_0/0.45)]">
          <Eye size={13} /> Show example
        </span>
      </>
    );
  const shape = fit === "contain" ? "object-contain" : "object-cover";
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={still} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn("absolute inset-0 size-full", shape)} />
      {play && entry.clip ? (
        <video
          key={still}
          src={previewUrl(entry, true)!}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          onPlaying={() => setPlaying(true)}
          className={cn("absolute inset-0 size-full transition-opacity duration-200", shape, playing ? "opacity-100" : "opacity-0")}
        />
      ) : null}
    </>
  );
}

export function Thumb({ entry, size }: { entry: LoraEntry; size: number }) {
  const [failed, setFailed] = useState(false);
  const still = previewUrl(entry);
  return (
    <span className="relative shrink-0 overflow-hidden rounded-[12px] bg-white/[0.05]" style={{ width: size, height: size }}>
      {still && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={still} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-haze" style={{ background: `oklch(0.45 0.1 ${hue(entry.category)} / 0.35)` }}>
          <Sparkles size={16} />
        </span>
      )}
    </span>
  );
}

const HUES: Record<LoraCategory, number> = { looks: 330, detail: 200, light: 85, angles: 260, motion: 290, effects: 30, edit: 160, characters: 350, world: 140, design: 55, speed: 110 };
export const hue = (c: LoraCategory) => HUES[c] ?? 250;

/** A file on its way to a machine, in words: where to, how much of it has arrived, and when the link is slow. */
function sendWords(s: LoraSend) {
  const mb = (n: number) => Math.round(n / 1e6);
  const size = s.bytes ? ` · ${mb(s.bytes * s.share)} of ${mb(s.bytes)} MB` : "";
  return `Sending to ${s.label}${s.metered ? " (a paid job there)" : ""}${size}${s.slow ? " · slow link, still going" : ""}`;
}

export function Progress({ share, checking, label = "Downloading" }: { share: number; checking: boolean; label?: string }) {
  return (
    <div className="mt-1.5 w-full">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
        <div className="h-full rounded-full bg-spike transition-[width] duration-700" style={{ width: `${Math.max(3, share * 100)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-fog">{checking ? "Checking the file…" : `${label} · ${Math.round(share * 100)}%`}</p>
    </div>
  );
}

export function Problem({ text }: { text: string }) {
  return (
    <p className="mt-1.5 flex items-start gap-1 text-[11.5px] leading-snug text-tally">
      <TriangleAlert size={12} className="mt-px shrink-0" /> {text}
    </p>
  );
}

