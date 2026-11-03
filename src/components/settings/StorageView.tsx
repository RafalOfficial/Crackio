"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSetup, announce } from "@/lib/hooks/use-setup";
import { KITS } from "@/lib/setup/kits";
import { CAP_WARN_AT, GB, formatBytes, type StorageAction, type StorageModel, type StorageReport } from "@/lib/storage/types";
import { cn } from "@/lib/cn";
import { Heading, Loading, MachineStrip, ProblemCard, Tape, Verdict } from "./parts";
import { pickMachine } from "./words";

/**
 * Settings → Storage: each drive and how full it is, where downloads go, the most Crackio may keep, one-click ways to
 * free space, and everything that uses it with what each frees (server/storage reads the machine; nothing you made is
 * ever removed for you).
 */
export function StorageView() {
  const params = useSearchParams();
  const { snap } = useSetup();
  const m = pickMachine(snap, params.get("machine"));
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const id = m?.id ?? null;

  /** The report for a machine, or the error to show instead. */
  const measure = useCallback(async (machine: string) => {
    const res = await fetch(`/api/settings/storage?machine=${encodeURIComponent(machine)}`, { cache: "no-store" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (StorageReport & { error?: string }) | null;
    return !res?.ok || !body || body.error ? { report: null, error: body?.error ?? "Crackio couldn't measure this machine." } : { report: body, error: null };
  }, []);
  const load = useCallback(async () => {
    if (!id) return;
    const got = await measure(id);
    if (got.report) setReport(got.report);
    setError(got.error);
  }, [id, measure]);

  // A new machine shows its own report, not the last one's, until it's measured.
  const [shownFor, setShownFor] = useState(id);
  if (shownFor !== id) {
    setShownFor(id);
    setReport(null);
  }
  useEffect(() => {
    if (!id) return;
    let live = true;
    measure(id).then((got) => {
      if (!live) return;
      if (got.report) setReport(got.report);
      setError(got.error);
    });
    return () => {
      live = false;
    };
  }, [id, measure]);

  /** Several models off this machine, one after another, then one look at what's left. */
  async function removeMany(items: StorageModel[]) {
    setBusy("rm:all");
    setError(null);
    for (const x of items) {
      if (!x.remove) continue;
      const res = await fetch(x.remove.url, { method: x.remove.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(x.remove.body) }).catch(() => null);
      if (!res?.ok) {
        const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
        setError(`${x.name}: ${body?.error ?? "couldn't remove it."}`);
        break;
      }
    }
    await load();
    announce();
    setBusy(null);
  }

  async function act(key: string, action: StorageAction | { method: string; url: string; body: Record<string, unknown> }) {
    setBusy(key);
    setError(null);
    const req =
      "action" in action
        ? fetch("/api/settings/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) })
        : fetch(action.url, { method: action.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(action.body) });
    const res = await req.catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (!res?.ok) setError(body?.error ?? "That didn't work.");
    await load();
    announce();
    setBusy(null);
  }

  if (!snap) return <Loading rows={6} />;
  if (!m) return <ProblemCard tone="needs" title="No machine yet" why="Add a computer under Machines first." />;
  const r = report;
  const downloadDrive = r?.drives.find((d) => d.holds.includes("downloads"));
  return (
    <div>
      <Verdict
        title="Storage"
        facts={
          r
            ? `${r.downloads.freeBytes != null ? `${formatBytes(r.downloads.freeBytes)} free where ${m.label} downloads models` : "Free space unknown"} · Crackio keeps ${formatBytes(r.cap.usedBytes)} there`
            : `Measuring ${m.label}…`
        }
      />
      <div className="mt-6">
        <MachineStrip snap={snap} selected={m.id} />
      </div>
      {error ? (
        <div className="mt-6">
          <ProblemCard title="That didn't work" why={error} />
        </div>
      ) : null}
      {!r ? (
        <Loading rows={4} />
      ) : r.machine.metered ? (
        <div className="mt-8">
          <ProblemCard tone="needs" title="Pay per job" why="This endpoint keeps its models on its own volume; Crackio doesn't manage its space." />
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          <section className="space-y-4">
            {r.drives.map((d) => (
              <DriveBar key={d.path} d={d} cap={d === downloadDrive ? r.cap : null} />
            ))}
            {!r.drives.length ? <p className="text-[13px] text-haze">This machine doesn&rsquo;t say how its drives are doing.</p> : null}
          </section>

          <section className="space-y-3">
            <Heading title="Where downloads go" note="New models land here. What's already in ComfyUI's own folders stays usable." />
            <DownloadFolder r={r} busy={busy === "root"} onSet={(path) => void act("root", { action: "set-root", machine: m.id, path })} />
          </section>

          <section className="space-y-3">
            <Heading title="The most Crackio may keep here" note="Set-ups stop and ask past it; nothing you made is ever removed for it." />
            <CapEditor r={r} busy={busy === "cap"} onSet={(gb) => void act("cap", { action: "set-cap", machine: m.id, gb })} />
          </section>

          {r.suggestions.length ? (
            <section className="space-y-3">
              <Heading title="Free up space" />
              <ul className="squircle divide-y divide-line overflow-hidden rounded-[18px] shadow-[inset_0_0_0_1px_var(--color-line)]">
                {r.suggestions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <span className="text-[14px] text-paper">{s.label}</span>
                    <Button variant="outline" size="sm" onClick={() => void act(s.id, s.action)} disabled={Boolean(busy)}>
                      {busy === s.id ? <LoaderCircle size={14} className="animate-spin" /> : null}
                      {s.bytes ? `Free ${formatBytes(s.bytes)}` : "Do it"}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Unused report={r} busy={busy} onRemove={(x) => x.remove && void act(`rm:${x.id}`, x.remove)} onRemoveAll={(xs) => void removeMany(xs)} />

          <section className="space-y-3">
            <Heading title="What uses space" note={r.measuredAt ? `Measured on the machine ${new Date(r.measuredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "Sizes from Crackio's catalog."} />
            <ModelList models={r.models} busy={busy} onRemove={(x) => x.remove && void act(`rm:${x.id}`, x.remove)} />
          </section>

          {r.data.length ? (
            <section className="space-y-3">
              <Heading title="Crackio's own files on this computer" note="Your takes, uploads and Crackio's caches. Caches rebuild by themselves when needed." />
              <ul className="squircle divide-y divide-line overflow-hidden rounded-[18px] shadow-[inset_0_0_0_1px_var(--color-line)]">
                {[...r.data].sort((a, b) => b.bytes - a.bytes).map((d) => (
                  <li key={d.kind} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium text-paper">{d.label}</span>
                      {d.note ? <span className="block text-[12.5px] text-haze">{d.note}</span> : null}
                    </span>
                    <span className="text-[13px] tabular text-fog">{formatBytes(d.bytes)}</span>
                    {d.clearable && d.kind === "cache" ? (
                      <Button variant="ghost" size="sm" onClick={() => void act("cache", { action: "clear-cache", kind: "all" })} disabled={Boolean(busy)}>
                        Clear
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {r.notes.length ? (
            <ul className="max-w-[86ch] list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-haze">
              {r.notes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** One drive: used and free, with the spike-tape mark at your limit when one is set. */
function DriveBar({ d, cap }: { d: StorageReport["drives"][number]; cap: StorageReport["cap"] | null }) {
  const used = Math.max(0, d.totalBytes - d.freeBytes);
  const pct = d.totalBytes ? (used / d.totalBytes) * 100 : 0;
  const capPct = cap?.bytes && d.totalBytes ? Math.min(100, ((used - cap.usedBytes + cap.bytes) / d.totalBytes) * 100) : null;
  const low = d.freeBytes < 2 * GB;
  const tight = d.freeBytes < 10 * GB;
  const what = d.holds.map((h) => ({ downloads: "downloads go here", models: "model folders", data: "Crackio's data", comfyui: "ComfyUI" })[h]).join(" · ");
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[14px] text-paper">
          <span className="font-display text-[17px] uppercase">{d.label}</span>
          <span className="ml-2 text-[12.5px] text-haze">{what}</span>
        </p>
        <p className={cn("text-[13px] tabular", low ? "font-semibold text-tally" : tight ? "text-tungsten" : "text-fog")}>
          {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
        </p>
      </div>
      <div className="relative mt-2 h-3 rounded-full bg-white/[0.06]">
        <div className={cn("h-full rounded-full", low ? "bg-tally" : tight ? "bg-tungsten" : "bg-[#3987e5]")} style={{ width: `${Math.max(1.5, pct)}%` }} />
        {capPct != null ? (
          <span className="absolute -top-1.5 h-6 w-[3px] rounded-[1px] bg-spike" style={{ left: `calc(${capPct}% - 1px)` }} title={`Your limit: ${formatBytes(cap!.bytes)}`} />
        ) : null}
      </div>
    </div>
  );
}

function DownloadFolder({ r, busy, onSet }: { r: StorageReport; busy: boolean; onSet: (path: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(r.downloads.root ?? "");
  const suggestion = r.suggestions.find((s) => s.action.action === "set-root");
  return (
    <div className="squircle space-y-3 rounded-[18px] bg-white/[0.03] px-5 py-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {/* The folder you chose, as you chose it (each kind of model gets its own folder inside). */}
          <p className="truncate font-mono text-[13px] text-paper" title={r.downloads.root ?? r.downloads.goesTo ?? undefined}>
            {r.downloads.root ?? r.downloads.goesTo ?? "ComfyUI's own model folders"}
          </p>
          <p className="mt-0.5 text-[12.5px] text-haze">
            {r.downloads.root ? "Chosen by you: each kind of model gets its own folder in it" : "ComfyUI's own folders (the default)"}
            {r.downloads.freeBytes != null ? ` · ${formatBytes(r.downloads.freeBytes)} free there` : ""}
          </p>
        </div>
        {r.machine.canChooseFolder ? (
          <div className="flex items-center gap-2">
            {r.downloads.root ? (
              <Button variant="ghost" size="sm" onClick={() => onSet(null)} disabled={busy}>
                Back to the default
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setEditing((e) => !e)} disabled={busy}>
              {editing ? "Close" : "Change"}
            </Button>
          </div>
        ) : (
          <span className="max-w-[340px] text-[12.5px] text-haze">Choosing a folder needs Crackio&rsquo;s helper 1.10 there (Machines → update it).</span>
        )}
      </div>
      {editing ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onSet(path.trim());
            setEditing(false);
          }}
        >
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={suggestion?.action.action === "set-root" && suggestion.action.path ? suggestion.action.path : "D:\\Models"}
            aria-label="Download folder"
            className="field-focus h-10 min-w-[280px] flex-1 rounded-[11px] bg-white/[0.05] px-3 font-mono text-[13px] text-paper outline-none placeholder:text-haze"
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !path.trim()}>
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : null}
            Download there
          </Button>
        </form>
      ) : null}
      {r.downloads.earlier.length ? <p className="text-[12.5px] text-haze">Still looked in: {r.downloads.earlier.join(", ")}</p> : null}
    </div>
  );
}

function CapEditor({ r, busy, onSet }: { r: StorageReport; busy: boolean; onSet: (gb: number | null) => void }) {
  const [value, setValue] = useState(r.cap.bytes ? String(Math.round(r.cap.bytes / GB)) : "");
  const share = r.cap.bytes ? r.cap.usedBytes / r.cap.bytes : null;
  return (
    <div className="squircle flex flex-wrap items-center justify-between gap-3 rounded-[18px] bg-white/[0.03] px-5 py-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <p className="text-[14px] text-fog">
        Crackio keeps <span className="font-semibold text-paper">{formatBytes(r.cap.usedBytes)}</span> here
        {r.cap.bytes ? (
          <>
            {" "}
            of your <span className="relative font-semibold text-paper">{formatBytes(r.cap.bytes)}<Tape className="inset-x-0 -bottom-1 h-[2px]" /></span> limit
            {share != null && share >= CAP_WARN_AT ? <span className="ml-1 text-tungsten">· nearly there</span> : null}
          </>
        ) : (
          ", with no limit"
        )}
        .
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const gb = Number(value);
          onSet(value.trim() && gb > 0 ? gb : null);
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          inputMode="decimal"
          placeholder="No limit"
          aria-label="Limit in GB"
          className="field-focus h-9 w-[110px] rounded-[11px] bg-white/[0.05] px-3 text-right text-[13px] tabular text-paper outline-none placeholder:text-haze"
        />
        <span className="text-[13px] text-haze">GB</span>
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : null}
          Save
        </Button>
      </form>
    </div>
  );
}

const kitName = (id: string) => KITS.find((k) => k.id === id)?.name ?? id;

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

/**
 * Smart cleanup: the models on this machine nothing has used for two weeks (no take, and no step of one, ran them here),
 * biggest first, each with what removing it frees and which tools would need setting up again. Crackio keeps take
 * records since Oct 29, so a model with none since is listed once that's three days back, saying so.
 */
function Unused({ report, busy, onRemove, onRemoveAll }: { report: StorageReport; busy: string | null; onRemove: (m: StorageModel) => void; onRemoveAll: (ms: StorageModel[]) => void }) {
  const [confirm, setConfirm] = useState(false);
  const now = report.now ?? report.measuredAt ?? 0;
  const since = report.usedSince ?? null;
  if (!now) return null;
  const stale = report.models
    // Removing frees something (a model sharing all its files with another frees nothing alone).
    .filter((x) => x.remove && !x.partial && x.freesBytes > 0 && x.kind !== "unknown" && x.kind !== "lfm3" && x.kind !== "lora")
    .filter((x) => (x.lastUsed != null ? now - x.lastUsed >= 14 * DAY : since !== null && now - since >= 3 * DAY))
    .sort((a, b) => b.freesBytes - a.freesBytes);
  if (!stale.length) return null;
  const frees = stale.reduce((n, x) => n + x.freesBytes, 0);
  return (
    <section id="unused" className="space-y-3">
      <Heading
        title="Not used lately"
        note={`${stale.length === 1 ? "A model" : `${stale.length} models`} no take has used here for two weeks${since ? `, or at all since Crackio began keeping take records (${day(since)})` : ""}. Removing one frees its files; its tools can set it up again any time.`}
        aside={
          confirm ? (
            <span className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                Keep them
              </Button>
              <Button variant="outline" size="sm" onClick={() => onRemoveAll(stale)} disabled={Boolean(busy)}>
                {busy === "rm:all" ? <LoaderCircle size={14} className="animate-spin" /> : null}
                Remove all · frees {formatBytes(frees)}
              </Button>
            </span>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)} disabled={Boolean(busy)}>
              Free {formatBytes(frees)}
            </Button>
          )
        }
      />
      <ul className="squircle divide-y divide-line overflow-hidden rounded-[18px] shadow-[inset_0_0_0_1px_var(--color-line)]">
        {stale.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-paper">
                {x.name}
                {x.variant ? <span className="ml-2 text-[12.5px] font-normal text-haze">{x.variant}</span> : null}
              </span>
              <span className="block truncate text-[12.5px] text-haze">
                {x.lastUsed != null ? `Last used ${day(x.lastUsed)}` : `No takes here since ${since ? day(since) : "records began"}`}
                {x.tools.length ? ` · ${x.tools.map(kitName).join(", ")} would need setting up again` : ""}
              </span>
            </span>
            <span className="text-[13px] tabular text-fog">{formatBytes(x.freesBytes)}</span>
            <Button variant="ghost" size="sm" onClick={() => onRemove(x)} disabled={Boolean(busy)}>
              {busy === `rm:${x.id}` ? <LoaderCircle size={14} className="animate-spin" /> : null}
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModelList({ models, busy, onRemove }: { models: StorageModel[]; busy: string | null; onRemove: (m: StorageModel) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const rows = [...models].sort((a, b) => b.bytes - a.bytes);
  const shown = all ? rows : rows.slice(0, 12);
  if (!rows.length) return <p className="text-[13px] text-haze">No models on this machine yet.</p>;
  return (
    <div>
      <ul className="squircle divide-y divide-line overflow-hidden rounded-[18px] shadow-[inset_0_0_0_1px_var(--color-line)]">
        {shown.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-paper">
                {x.name}
                {x.variant ? <span className="ml-2 text-[12.5px] font-normal text-haze">{x.variant}</span> : null}
                {x.partial ? <span className="ml-2 text-[12px] text-tungsten">part downloaded</span> : null}
              </span>
              <span className="block truncate text-[12.5px] text-haze">{x.tools.length ? `Used by ${x.tools.map(kitName).join(", ")}` : x.kind === "unknown" ? "Not used by Crackio (maybe yours)" : "No tool uses it now"}</span>
            </span>
            <span className="text-[13px] tabular text-fog">{x.sizeKnown || x.bytes ? formatBytes(x.bytes) : "?"}</span>
            {x.remove ? (
              confirm === x.id ? (
                <span className="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    Keep
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onRemove(x)} disabled={Boolean(busy)}>
                    {busy === `rm:${x.id}` ? <LoaderCircle size={14} className="animate-spin" /> : null}
                    Remove · frees {formatBytes(x.freesBytes)}
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirm(x.id)} disabled={Boolean(busy)}>
                  Remove
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length > 12 ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-3 text-[13px] font-semibold text-haze hover:text-paper">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}
