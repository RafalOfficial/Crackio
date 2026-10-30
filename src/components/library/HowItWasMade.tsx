"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Download, Workflow } from "lucide-react";
import { cn } from "@/lib/cn";
import { byId, graphSettings, workflowFileName, type ApiGraph, type JobRecipe } from "@/lib/recipes/recipe";
import type { Generation } from "@/lib/generations/types";
import { DEMO } from "@/lib/demo/config";
import { shortGpuName } from "@/lib/local/fit";

/**
 * "How it was made": the recipe a take keeps (lib/recipes, server/recipes). Its model files, LoRAs, seed, steps and
 * guidance, the machine and GPU it ran on, every ComfyUI graph its job queued in order with their nodes, and buttons that
 * open a graph in ComfyUI (the ComfyUI page, on the machine that ran it) or download it in API format. A take from before
 * recipes were kept, or made without ComfyUI, shows nothing.
 */
export function HowItWasMade({ gen }: { gen: Generation }) {
  const [kept, setKept] = useState<{ id: string; recipe: JobRecipe | null } | null>(null);
  useEffect(() => {
    if (gen.status !== "done") return;
    let off = false;
    fetch(`/api/generations/${encodeURIComponent(gen.id)}/recipe`, { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { recipe: JobRecipe }).recipe : null))
      .catch(() => null)
      .then((recipe) => {
        if (!off) setKept({ id: gen.id, recipe });
      });
    return () => {
      off = true;
    };
  }, [gen.id, gen.status]);
  const recipe = kept?.id === gen.id ? kept.recipe : null;
  if (!recipe?.steps.length) return null;
  return <Recipe recipe={recipe} key={recipe.id} />;
}

function Recipe({ recipe }: { recipe: JobRecipe }) {
  const [picked, setPicked] = useState(recipe.main >= 0 ? recipe.main : recipe.steps.length - 1);
  const [showNodes, setShowNodes] = useState(false);
  const step = recipe.steps[picked] ?? recipe.steps[recipe.steps.length - 1];
  const settings = useMemo(() => (step.graph ? graphSettings(step.graph) : null), [step]);
  const nodes = useMemo(() => (step.graph ? nodeRows(step.graph) : []), [step]);
  const custom = [...new Map(recipe.steps.flatMap((s) => s.custom ?? []).map((c) => [c.pack, c])).keys()];
  const download = (index: number) => `/api/generations/${encodeURIComponent(recipe.id)}/recipe?step=${index}&download=1`;
  const open = (index: number) => {
    const s = recipe.steps[index];
    // The machine that ran it, when Crackio still knows it (the server finds its id again); else the page's own pick.
    const q = new URLSearchParams({ ...(s.machine?.id ? { machine: s.machine.id } : {}), recipe: recipe.id, step: String(index) });
    return `/comfy?${q}`;
  };
  const guidance = [settings?.cfg !== undefined ? `CFG ${settings.cfg}` : null, settings?.guidance !== undefined ? `guidance ${settings.guidance}` : null].filter(Boolean).join(" · ");
  const time = step.ms ?? step.wallMs;

  return (
    <section className="mt-6">
      <div className="mb-2.5 flex h-7 items-center justify-between gap-3">
        <h3 className="label">How it was made</h3>
        <a
          href={`/api/generations/${encodeURIComponent(recipe.id)}/recipe?download=all`}
          download
          title="The whole recipe: every step's graph or request, with where and how long it ran"
          className="press rounded-[8px] px-1.5 text-[12px] font-semibold text-haze hover:text-paper"
        >
          Recipe (.json)
        </a>
      </div>

      {recipe.steps.length > 1 ? (
        <ol className="mb-3 grid gap-1">
          {recipe.steps.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setPicked(i)}
                aria-pressed={i === picked}
                className={cn(
                  "press squircle flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left text-[12.5px] hover:bg-white/[0.05]",
                  i === picked ? "bg-white/[0.06] text-paper shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-fog",
                )}
              >
                <span className="tabular grid size-5 shrink-0 place-items-center rounded-full bg-white/[0.07] text-[11px] font-semibold">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{s.name}</span>
                <span className="tabular shrink-0 text-haze">
                  {s.status === "error" ? "failed" : s.kind === "router" ? "Router" : s.kind === "outside" ? "outside ComfyUI" : `${Object.keys(s.graph ?? {}).length} nodes`}
                  {s.ms ?? s.wallMs ? ` · ${seconds((s.ms ?? s.wallMs)!)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-[13px]">
        <Row term="Workflow">
          {step.kind === "router" ? (
            <>
              Comfy Router · <span className="break-all font-mono text-[12px]">{step.endpoint}</span>
            </>
          ) : step.kind === "outside" ? (
            <>
              Outside ComfyUI · {step.name}
              {step.detail ? <span className="mt-1 block break-words text-[12px] text-haze">{step.detail}</span> : null}
            </>
          ) : (
            <>
              {step.name} · <span className="tabular">{settings?.nodes ?? 0} nodes</span>
            </>
          )}
        </Row>
        {settings?.models.length ? (
          <Row term={settings.models.length > 1 ? "Models" : "Model"}>
            <Files names={settings.models} />
          </Row>
        ) : null}
        {settings?.loras.length ? (
          <Row term="LoRAs">
            <span className="grid gap-1">
              {settings.loras.map((l, i) => (
                <span key={i} className="break-all font-mono text-[12px]">
                  {l.name} <span className="tabular text-haze">× {l.strength}</span>
                </span>
              ))}
            </span>
          </Row>
        ) : null}
        {settings?.seed !== undefined ? (
          <Row term="Seed">
            <span className="tabular select-text">{settings.seed}</span>
          </Row>
        ) : null}
        {settings?.steps !== undefined ? (
          <Row term="Steps">
            <span className="tabular">
              {settings.steps}
              {settings.samplers > 1 ? ` · ${settings.samplers} sampling passes` : ""}
            </span>
          </Row>
        ) : null}
        {guidance ? (
          <Row term="Guidance">
            <span className="tabular">{guidance}</span>
          </Row>
        ) : null}
        {settings?.sampler || settings?.scheduler ? <Row term="Sampler">{[settings.sampler, settings.scheduler].filter(Boolean).join(" · ")}</Row> : null}
        {settings?.denoise !== undefined && settings.denoise < 1 ? (
          <Row term="Denoise">
            <span className="tabular">{settings.denoise}</span>
          </Row>
        ) : null}
        {settings?.width && settings.height ? (
          <Row term="Latent">
            <span className="tabular">
              {settings.width} × {settings.height}
              {settings.frames ? ` · ${settings.frames} frames` : ""}
              {settings.fps ? ` · ${settings.fps} fps` : ""}
            </span>
          </Row>
        ) : null}
        {step.machine ? (
          <Row term="Ran on">
            {step.machine.label}
            {/* "RTX 5090 · vast.ai" already says which card. */}
            {step.machine.gpu && !step.machine.label.includes(shortGpuName(step.machine.gpu)) ? ` · ${shortGpuName(step.machine.gpu)}` : ""}
          </Row>
        ) : null}
        {time ? (
          <Row term={step.ms ? "ComfyUI took" : "Took"}>
            <span className="tabular">
              {seconds(time)}
              {step.warm === true ? " · models already loaded" : step.warm === false ? " · loading models included" : ""}
            </span>
          </Row>
        ) : null}
        {custom.length ? (
          <Row term="Custom nodes">
            <Files names={custom} />
          </Row>
        ) : null}
      </dl>

      {nodes.length ? (
        <>
          <button
            type="button"
            onClick={() => setShowNodes((s) => !s)}
            aria-expanded={showNodes}
            className="press mt-3 inline-flex h-7 items-center gap-1 rounded-[9px] pl-0.5 pr-2 text-[12.5px] font-semibold text-fog hover:text-paper"
          >
            <ChevronDown size={14} className={cn("transition-transform duration-200", showNodes && "rotate-180")} />
            {showNodes ? "Hide" : "Show"} the {nodes.length} nodes
          </button>
          {showNodes ? (
            <ol className="squircle scroll-thin mt-2 max-h-[280px] overflow-y-auto rounded-[14px] bg-white/[0.035] p-1.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              {nodes.map((n) => (
                <li key={n.id} className="flex items-baseline gap-2 rounded-[8px] px-2 py-1 text-[12px]">
                  <span className="tabular w-8 shrink-0 text-right font-mono text-[11px] text-haze">#{n.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold text-paper/90">{n.type}</span>
                    {n.values ? <span className="ml-1.5 break-all text-haze">{n.values}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}

      <div className={cn("mt-3 grid grid-cols-2 gap-1.5", step.kind === "outside" && "hidden")}>
        {/* The live demo keeps ComfyUI itself private: the graph downloads instead. */}
        {step.graph && !DEMO ? (
          <Link
            href={open(picked)}
            title={step.machine ? `Open this graph in ComfyUI on ${step.machine.label}` : "Open this graph in ComfyUI"}
            className="press squircle inline-flex h-10 items-center justify-center gap-2 rounded-[13px] bg-white/[0.05] text-[13px] font-semibold text-paper hover:bg-white/[0.09]"
          >
            <Workflow size={15} /> Open in ComfyUI
          </Link>
        ) : null}
        <a
          href={download(picked)}
          download={workflowFileName(recipe, step, picked, recipe.steps.length)}
          title={step.kind === "router" ? "The request Crackio sent to Comfy Router" : "The graph in ComfyUI's API format, exactly as it ran"}
          className={cn(
            "press squircle inline-flex h-10 items-center justify-center gap-2 rounded-[13px] bg-white/[0.05] text-[13px] font-semibold text-paper hover:bg-white/[0.09]",
            !step.graph && "col-span-2",
          )}
        >
          <Download size={15} /> {step.kind === "router" ? "Request (.json)" : "Workflow (.json)"}
        </a>
      </div>
    </section>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-haze">{term}</dt>
      <dd className="min-w-0 break-words text-paper/90">{children}</dd>
    </>
  );
}

function Files({ names }: { names: string[] }) {
  return (
    <span className="grid gap-1">
      {names.map((n) => (
        <span key={n} className="break-all font-mono text-[12px]">
          {n}
        </span>
      ))}
    </span>
  );
}

const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** Each node in order, with the settings typed into it (links to other nodes left out). */
function nodeRows(graph: ApiGraph) {
  return Object.entries(graph)
    .sort(([a], [b]) => byId(a, b))
    .map(([id, node]) => {
      const values = Object.values(node.inputs ?? {})
        .filter((v) => !Array.isArray(v) && v !== null && v !== undefined && v !== "")
        .map((v) => (typeof v === "string" ? (v.length > 36 ? `${v.slice(0, 34)}…` : v) : String(v)))
        .slice(0, 3)
        .join(" · ");
      return { id, type: node._meta?.title && node._meta.title !== node.class_type ? `${node.class_type} (${node._meta.title})` : (node.class_type ?? "node"), values };
    });
}
