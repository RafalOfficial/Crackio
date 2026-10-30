"use client";

import { useEffect, useMemo, useState } from "react";
import { Film, Image as ImageIcon, Layers } from "lucide-react";
import { ModelLoras } from "./ModelLoras";
import { entryFiles, holders, loadLoraLibrary, onlineTargets, useLoraLibrary } from "@/lib/hooks/use-lora-library";
import { useModelLoras } from "@/lib/hooks/use-model-loras";
import { installedVariant } from "@/lib/local/rows";
import { categoryLabel, takesLoras } from "@/lib/local/loras";
import type { LocalModel, LocalStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";

/**
 * The Local page's LoRAs: pick any open model, see Crackio's checked LoRAs for it and every other one on Hugging Face,
 * download them into your ComfyUI and switch them on (components/loras/ModelLoras); then every LoRA file your machines
 * have, what it's for, and how big. The model library opens the same page for one model from its card.
 */
export function LoraSection({ catalog, status }: { catalog: LocalModel[]; status: LocalStatus }) {
  const library = useLoraLibrary((s) => s.library);
  useEffect(() => loadLoraLibrary(), []);
  const [kind, setKind] = useState<"image" | "clip">("image");
  const [picked, setPicked] = useState<string | null>(null);
  const on = useModelLoras((s) => s.byModel);

  const picksOf = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of library?.entries ?? []) for (const m of e.models) out.set(m, (out.get(m) ?? 0) + 1);
    return out;
  }, [library]);
  const installed = (m: LocalModel) => onlineTargets(status).some((t) => installedVariant(m, t));
  const models = useMemo(
    () =>
      catalog
        .filter((m) => takesLoras(m) && m.crackio)
        .sort((a, b) => Number(installed(b)) - Number(installed(a)) || (picksOf.get(b.id) ?? 0) - (picksOf.get(a.id) ?? 0) || b.quality - a.quality),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, status, picksOf],
  );
  const ofKind = models.filter((m) => (kind === "clip") === (m.unit === "clip"));
  // Chips for what you'd reach for (installed, or with checked picks); the rest in a list.
  const chips = ofKind.filter((m) => installed(m) || (picksOf.get(m.id) ?? 0) > 0);
  const rest = ofKind.filter((m) => !chips.includes(m));
  const model = models.find((m) => m.id === picked) ?? chips[0] ?? ofKind[0] ?? null;
  const total = library?.entries.length ?? 0;
  const covered = picksOf.size;

  return (
    <section id="loras" className="mt-12 scroll-mt-6" aria-label="LoRAs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-[24px] uppercase leading-tight">
            <Layers size={20} className="text-spike" /> LoRAs
          </h2>
          <p className="mt-0.5 max-w-[86ch] text-[13px] leading-relaxed text-haze">
            Small add-ons for one model that change how it draws: looks, camera moves, effects, fixes.{" "}
            {total ? `${total} checked picks for ${covered} models, and` : "Crackio's picks, and"} every LoRA on Hugging Face one search away. They download into your ComfyUI,
            switch on per model, and go with every job that model runs, in every tool.
          </p>
        </div>
        <div className="flex rounded-full bg-white/[0.05] p-0.5 text-[12.5px]" role="group" aria-label="Kind of model">
          {(
            [
              ["image", "Picture models", ImageIcon],
              ["clip", "Video models", Film],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => (setKind(id), setPicked(null))}
              aria-pressed={kind === id}
              className={cn("press inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-semibold", kind === id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Model">
        {chips.map((m) => {
          const active = m.id === model?.id;
          const count = on[m.crackio!]?.length ?? 0;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPicked(m.id)}
              className={cn(
                "press inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold",
                active ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:text-paper",
              )}
            >
              {installed(m) ? <i className={cn("size-[7px] rounded-full", active ? "bg-[#16131b]/50" : "bg-chroma")} title="Installed" /> : null}
              {m.name}
              <span className={cn("text-[11.5px] tabular-nums", active ? "text-[#16131b]/60" : "text-haze")}>{picksOf.get(m.id) ?? 0}</span>
              {count ? <span className={cn("rounded-full px-1.5 text-[10.5px] font-bold", active ? "bg-spike text-spike-ink" : "bg-spike/20 text-spike")}>{count} on</span> : null}
            </button>
          );
        })}
        {rest.length ? (
          <select
            value={rest.some((m) => m.id === model?.id) ? model!.id : ""}
            onChange={(e) => e.target.value && setPicked(e.target.value)}
            aria-label="More models"
            className="h-9 rounded-full bg-white/[0.05] px-3 text-[13px] font-semibold text-fog outline-none hover:text-paper"
          >
            <option value="">More models ({rest.length})</option>
            {rest.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {model ? (
        <div className="mt-4 rounded-panel bg-white/[0.02] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-display text-[21px] uppercase leading-tight">{model.name}</h3>
            <p className="text-[12.5px] text-haze">
              {installed(model)
                ? `Installed on ${onlineTargets(status)
                    .filter((t) => installedVariant(model, t))
                    .map((t) => (t.cloud ? "your cloud GPU" : t.onThisComputer || t.source === "installed" ? "this computer" : t.label))
                    .join(" and ")}`
                : "Not installed yet: install it in Every model above to use its LoRAs"}
            </p>
          </div>
          <ModelLoras key={model.id} model={model} />
        </div>
      ) : null}

      <AllFiles status={status} catalog={catalog} />
    </section>
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
    const files = new Set(onlineTargets(status).flatMap((t) => t.installed.filter((f) => f.startsWith("loras/") && /\.safetensors$/i.test(f)).map((f) => f.slice(6))));
    return [...files]
      .map((file) => ({ file, info: byFile.get(file), where: holders(status, file) }))
      .sort((a, b) => (a.info?.name ?? a.file).localeCompare(b.info?.name ?? b.file));
  }, [library, status]);
  if (!rows.length) return null;
  const name = (id: string) => catalog.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="mt-5">
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
                  <td className="px-3.5 py-2.5 text-fog">{r.where.map((t) => (t.cloud ? "cloud GPU" : t.onThisComputer || t.source === "installed" ? "this computer" : t.label)).join(", ")}</td>
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
