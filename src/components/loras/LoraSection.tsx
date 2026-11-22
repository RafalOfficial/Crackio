"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEMO } from "@/lib/demo/config";
import { loadLoraPolicy, useLoraPolicyStore } from "@/lib/hooks/use-lora-policy";
import { Film, Image as ImageIcon } from "lucide-react";
import { ModelLoras } from "./ModelLoras";
import { entryFiles, holders, loadLoraLibrary, onlineTargets, useLoraLibrary } from "@/lib/hooks/use-lora-library";
import { useModelLoras } from "@/lib/hooks/use-model-loras";
import { installedVariant } from "@/lib/local/rows";
import { categoryLabel, takesLoras, type LoraEntry } from "@/lib/local/loras";
import type { LocalModel, LocalStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";

/**
 * Settings → LoRAs: pick a model, and its LoRAs are a shop window below (components/loras/ModelLoras): the most popular
 * first, each with an example, one button to add it. The models you have come as chips; the others in one list. At the
 * end, every LoRA file your machines hold. The model library opens the same window for one model from its card.
 */

/** The model last looked at here, per kind, in this browser. */
const LAST = "crackio:loras-model";
const read = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

export function LoraSection({ catalog, status }: { catalog: LocalModel[]; status: LocalStatus }) {
  const library = useLoraLibrary((s) => s.library);
  useEffect(() => loadLoraLibrary(), []);
  const [kind, setKind] = useState<"image" | "clip">("clip");
  const [picked, setPicked] = useState<Record<string, string>>({});
  // After the page is drawn (the server knows no browser): the kind and model last looked at.
  useEffect(() => {
    const last = read();
    const t = setTimeout(() => {
      setPicked(last);
      if (last.kind === "image" || last.kind === "clip") setKind(last.kind);
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const remember = (next: Record<string, string>) => {
    setPicked(next);
    try {
      localStorage.setItem(LAST, JSON.stringify(next));
    } catch {
      /* private mode: it lasts this visit */
    }
  };
  const on = useModelLoras((s) => s.byModel);

  const picksOf = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of library?.entries ?? []) for (const m of e.models) out.set(m, (out.get(m) ?? 0) + 1);
    return out;
  }, [library]);
  // On one of your own machines: Comfy Cloud lists every model, and takes no LoRAs of yours.
  const mine = useMemo(() => onlineTargets(status).filter((t) => t.id !== "comfy-cloud"), [status]);
  const models = useMemo(() => {
    const have = (m: LocalModel) => mine.some((t) => installedVariant(m, t));
    return catalog
      .filter((m) => takesLoras(m) && m.crackio && !m.tool)
      .map((m) => ({ m, have: have(m) }))
      .sort((a, b) => Number(b.have) - Number(a.have) || (picksOf.get(b.m.id) ?? 0) - (picksOf.get(a.m.id) ?? 0) || b.m.quality - a.m.quality);
  }, [catalog, mine, picksOf]);
  const ofKind = models.filter((x) => (kind === "clip") === (x.m.unit === "clip"));
  // Chips for the models you have; with none yet, the few with the most LoRAs. The rest in one list.
  const chips = ofKind.some((x) => x.have) ? ofKind.filter((x) => x.have).slice(0, 8) : ofKind.slice(0, 5);
  const rest = ofKind.filter((x) => !chips.includes(x));
  const current = ofKind.find((x) => x.m.id === picked[kind]) ?? chips[0] ?? ofKind[0] ?? null;
  const model = current?.m ?? null;
  const names = useMemo(() => Object.fromEntries(catalog.map((m) => [m.id, m.name])), [catalog]);
  // A LoRA picked from the search that's made for another model: its model comes into view with the LoRA open.
  const [arrive, setArrive] = useState<{ model: string; lora: string } | null>(null);
  const goTo = (entry: LoraEntry) => {
    const made = models.filter((x) => entry.models.includes(x.m.id));
    const to = made.find((x) => x.have) ?? made[0];
    if (!to) return;
    const k = to.m.unit === "clip" ? "clip" : "image";
    setKind(k);
    setArrive({ model: to.m.id, lora: entry.id });
    remember({ ...picked, kind: k, [k]: to.m.id });
  };

  return (
    <section id="loras" aria-label="LoRAs" className="mt-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex shrink-0 self-start rounded-full bg-white/[0.05] p-0.5 text-[13px]" role="group" aria-label="Kind of model">
          {(
            [
              ["clip", "Video", Film],
              ["image", "Pictures", ImageIcon],
            ] as const
          ).map(([id, label, Icon]) => (
            <button key={id} type="button" onClick={() => (setKind(id), remember({ ...picked, kind: id }))} aria-pressed={kind === id} className={cn("press inline-flex h-9 items-center gap-1.5 rounded-full px-4 font-semibold", kind === id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Model">
          {chips.map(({ m, have }) => {
            const active = m.id === model?.id;
            const count = on[m.crackio!]?.length ?? 0;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => remember({ ...picked, [kind]: m.id })}
                title={have ? "On one of your machines" : "Not set up yet"}
                className={cn("press inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold", active ? "bg-white/[0.16] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" : "bg-white/[0.045] text-fog hover:text-paper")}
              >
                {have ? <i className="size-[7px] rounded-full bg-chroma" /> : null}
                {m.name}
                {count ? <span className="rounded-full bg-chroma/15 px-1.5 text-[10.5px] font-bold text-chroma">{count} on</span> : null}
              </button>
            );
          })}
          {rest.length ? (
            <select
              value={rest.some((x) => x.m.id === model?.id) ? model!.id : ""}
              onChange={(e) => e.target.value && remember({ ...picked, [kind]: e.target.value })}
              aria-label="More models"
              className={cn("h-9 min-w-0 max-w-full rounded-full px-3 text-[13px] font-semibold outline-none hover:text-paper", rest.some((x) => x.m.id === model?.id) ? "bg-white/[0.16] text-paper" : "bg-white/[0.045] text-fog")}
            >
              <option value="">More models ({rest.length})</option>
              {rest.map(({ m }) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      {model ? (
        <div className="mt-5">
          {!current?.have ? (
            <p className="mb-3 text-[12.5px] text-haze">
              {model.name} isn&rsquo;t on your machines yet: set it up under Settings → Models, and its LoRAs download beside it.
            </p>
          ) : null}
          <ModelLoras key={`${model.id}|${arrive?.model === model.id ? arrive.lora : ""}`} model={model} names={names} onElsewhere={goTo} initial={arrive?.model === model.id ? arrive.lora : null} />
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-haze">No {kind === "clip" ? "video" : "picture"} model takes LoRAs yet.</p>
      )}

      <AllFiles status={status} catalog={catalog} />
      <AdultNote />
    </section>
  );
}

/** Where the choice about adult LoRAs is made (Settings → Preferences), said once, small, under everything. */
function AdultNote() {
  const policy = useLoraPolicyStore((s) => s.policy);
  useEffect(() => loadLoraPolicy(), []);
  if (DEMO || !policy || policy.locked) return null;
  return (
    <p className="mt-4 text-[12px] text-haze">
      Adult LoRAs are {policy.adult ? "shown in searches, marked 18+" : "left out of searches"}.{" "}
      <Link href="/settings/preferences#adult-loras" className="font-semibold text-fog underline-offset-2 hover:text-paper hover:underline">
        Change
      </Link>
    </p>
  );
}

/** Every LoRA file on your machines: what it is, which models it's for, where it is and how big. */
function AllFiles({ status, catalog }: { status: LocalStatus; catalog: LocalModel[] }) {
  const library = useLoraLibrary((s) => s.library);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    const byFile = new Map<string, { name: string; models: string[]; category?: string; bytes?: number }>();
    for (const e of library?.entries ?? []) entryFiles(e).forEach((f, i) => byFile.set(f, { name: e.name, models: e.models, category: categoryLabel(e.category), bytes: e.files[i]?.bytes }));
    for (const r of Object.values(library?.records ?? {})) if (!byFile.has(r.file)) byFile.set(r.file, { name: r.name, models: r.models, category: categoryLabel(r.category), bytes: r.bytes });
    // Your own machines': Comfy Cloud lists its whole library (hundreds), none of it yours.
    const mine = onlineTargets(status).filter((t) => t.id !== "comfy-cloud");
    const files = new Set(mine.flatMap((t) => t.installed.filter((f) => f.startsWith("loras/") && /\.safetensors$/i.test(f)).map((f) => f.slice(6))));
    return [...files]
      .map((file) => ({ file, info: byFile.get(file), where: holders(status, file).filter((t) => t.id !== "comfy-cloud") }))
      .sort((a, b) => (a.info?.name ?? a.file).localeCompare(b.info?.name ?? b.file));
  }, [library, status]);
  if (!rows.length) return null;
  const name = (id: string) => catalog.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="mt-10">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="press inline-flex h-9 items-center gap-2 rounded-full bg-white/[0.05] px-4 text-[13px] font-semibold text-fog hover:text-paper">
        Every LoRA file on your machines <span className="tabular-nums text-haze">{rows.length}</span>
      </button>
      {open ? (
        <div className="mt-2.5 overflow-x-auto rounded-[16px] bg-white/[0.03]">
          <table className="w-full min-w-[640px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-[0.06em] text-haze">
              <tr>
                <th className="px-3.5 py-2.5 font-semibold">LoRA</th>
                <th className="px-3.5 py-2.5 font-semibold">For</th>
                <th className="px-3.5 py-2.5 font-semibold">On</th>
                <th className="px-3.5 py-2.5 text-right font-semibold">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.file}>
                  <td className="px-3.5 py-2.5">
                    <p className="font-semibold text-paper">{r.info?.name ?? r.file.replace(/\.safetensors$/i, "")}</p>
                    <p className="truncate text-[11px] text-haze">{r.file}</p>
                  </td>
                  <td className="px-3.5 py-2.5 text-fog">{r.info ? r.info.models.map(name).join(", ") : <span className="text-haze">Unknown: put there by hand</span>}</td>
                  <td className="px-3.5 py-2.5 text-fog">{r.where.map((t) => (t.cloud ? t.label || "cloud GPU" : t.onThisComputer || t.source === "installed" ? "this computer" : t.label)).join(", ")}</td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums text-haze">{r.info?.bytes ? `${Math.max(1, Math.round(r.info.bytes / 1024 ** 2))} MB` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
