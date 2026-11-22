"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useModels } from "@/lib/hooks/use-models";
import { useSetup } from "@/lib/hooks/use-setup";
import { ModelPicker, VendorMark } from "@/components/models/ModelPicker";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Verdict } from "./parts";
import { bytesText } from "./words";
import { KIND_LABEL, type ModelKind } from "@/lib/models/catalog";
import { previewSrc } from "@/lib/models/gallery";
import { optionsOf } from "@/lib/setup/options";
import type { KitId, ModelOption, OptionVariant, SetupMachine, SetupSnapshot } from "@/lib/setup/types";
import { engineShortName } from "@/lib/providers/names";
import { cn } from "@/lib/cn";

const KINDS: { kind: ModelKind; body: string }[] = [
  { kind: "image", body: "New images and edits: the composer, Director, Angles, Relight, Retouch and Product Studio." },
  { kind: "video", body: "New clips, from words or a still: Home's composer, Video, Director's clips, Storyboard and Product Video." },
  { kind: "text", body: "Rewrites your words, in any language, into a precise prompt before each generation when Refine is on. Fast models keep it snappy." },
  { kind: "upscale", body: "Making images bigger and sharper in Upscale." },
  { kind: "reframe", body: "Extending a picture to a new aspect ratio in Upscale → Reframe." },
];

const SPEED = { fast: "Fast", medium: "Balanced", slow: "Best quality" } as const;

/**
 * The tool parts whose model lists are a kind's open models (setup/kits): pictures from words and picture editors for
 * images, clip models for video, picture and clip upscalers for upscale. A model's set-up opens in the first that lists it.
 */
const PARTS: Partial<Record<ModelKind, { kit: KitId; part: string }[]>> = {
  image: [
    { kit: "image", part: "image.model" },
    { kit: "relight", part: "relight.model" },
  ],
  video: [{ kit: "video", part: "video.model" }],
  upscale: [
    { kit: "upscale", part: "upscale.pictures" },
    { kit: "upscale", part: "upscale.clips" },
  ],
};

/** A catalog id as the models list names it: "ltx-2.5" → "local:ltx-2.5", "tpl-wan2.2-14b-video" → "local:tpl:wan2.2-14b-video". */
const crackioId = (model: string) => (model.startsWith("tpl-") ? `local:tpl:${model.slice(4)}` : `local:${model}`);

type OpenModel = { option: ModelOption; variant: OptionVariant; machine: SetupMachine; kit: KitId; rank: number };

const runs = (v: OptionVariant) => (v.fit === "great" || v.fit === "ok" ? 2 : v.fit === "slow" ? 1 : 0);

/**
 * A kind's open models that aren't on any machine yet, each on the machine it would run best on (and fit the disk of),
 * the ones that run well first. `listed`: the models the list above already shows (the built-in ones, and every model
 * that's installed somewhere).
 */
function openModels(snap: SetupSnapshot | null, kind: ModelKind, listed: Set<string>): OpenModel[] {
  const parts = PARTS[kind];
  if (!snap || !parts) return [];
  const out = new Map<string, OpenModel>();
  for (const machine of snap.machines) {
    if (!machine.online || machine.metered) continue;
    for (const { kit, part } of parts) {
      for (const option of optionsOf(machine, machine.tools[kit]?.reqs.find((r) => r.id === part))) {
        if (listed.has(crackioId(option.model)) || option.blocked || option.variants.some((v) => v.installed)) continue;
        const variant = option.variants.find((v) => v.id === option.variant);
        if (!variant) continue;
        const rank = runs(variant) * 2 + Number(variant.fitsDisk);
        const had = out.get(option.model);
        if (!had || rank > had.rank) out.set(option.model, { option, variant, machine, kit: had?.kit ?? kit, rank });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.rank - a.rank || b.option.quality - a.option.quality);
}

/** Where a model's set-up opens: its tool's sheet on that machine, the model picked. */
const setUpHref = (machine: string, kit: KitId, model: string) => `/settings/tools?machine=${encodeURIComponent(machine)}&tool=${kit}&model=${encodeURIComponent(model)}`;

export function ModelsView() {
  const { models, defaults, loaded, error, setDefault, refresh } = useModels();
  // Every open model each machine could run (the Tools sheet's lists): the ones not set up yet are offered below each kind.
  const { snap } = useSetup(true, { full: true });
  // Each kind shows its ready models first, a few at a time: the full list is one click away.
  const [open, setOpen] = useState<Partial<Record<ModelKind, boolean>>>({});
  const listed = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  // A built-in open model that isn't set up: its set-up, on the machine it would run best on.
  const builtIn = useMemo(() => {
    const where = new Map<string, string>();
    for (const { kind } of KINDS) for (const o of openModels(snap, kind, new Set())) where.set(crackioId(o.option.model), setUpHref(o.machine.id, o.kit, o.option.model));
    return where;
  }, [snap]);

  return (
    <div>
      <Verdict title="Models" facts="The model each kind of job starts on, and every open model your machines can run: one click sets one up." />
      {error ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally">
          <span>Couldn&rsquo;t load models: {error}</span>
          <button onClick={() => void refresh()} className="font-semibold hover:underline">
            Try again
          </button>
        </div>
      ) : null}

      {KINDS.map(({ kind, body }) => {
        const list = models.filter((m) => m.kind === kind).sort((a, b) => Number(b.id === defaults[kind]) - Number(a.id === defaults[kind]) || Number(b.available) - Number(a.available));
        const ready = list.filter((m) => m.available).length;
        const shown = open[kind] ? list : list.slice(0, 4);
        return (
          <section key={kind} className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[16px] font-semibold">{KIND_LABEL[kind]}</h2>
              <span className="text-[12.5px] text-haze">{loaded ? `${ready} of ${list.length} ready` : ""}</span>
            </div>
            <p className="mt-1 text-[13.5px] text-haze">{body}</p>
            <Panel className="mt-3">
              <PanelHeader title="Default">
                <div className="w-[min(320px,60vw)]">
                  <ModelPicker kind={kind} value={defaults[kind] ?? "auto"} onChange={(id) => void setDefault(kind, id)} placement="bottom-end" emptyLabel="None: tools keep your last pick" />
                </div>
              </PanelHeader>
              <ul className="divide-y divide-line">
                {!loaded
                  ? Array.from({ length: 3 }, (_, i) => <li key={i} className="skeleton m-3 h-12 rounded-[10px]" />)
                  : shown.map((m) => (
                      <li key={m.id} className={cn("flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap", !m.available && "opacity-70")}>
                        <VendorMark vendor={m.vendor} model={m.name} size={36} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[14px] font-semibold">{m.name}</p>
                          <p className="mt-0.5 text-[12px] text-haze">
                            {m.vendor} · {m.providers.map(engineShortName).join(" or ")} · {SPEED[m.speed]}
                            {m.kind === "image" ? ` · ${m.maxRefs ? `up to ${m.maxRefs} references` : "text only"}` : ""}
                          </p>
                          <p className="mt-1 text-[13px] leading-relaxed text-fog">{m.bestFor}</p>
                        </div>
                        {/* Under the description on phones; a narrow right column from sm up, so long reasons wrap instead of widening the page. */}
                        <span className="basis-full pl-12 text-[12.5px] leading-snug sm:max-w-[260px] sm:shrink-0 sm:basis-auto sm:pl-0 sm:pt-0.5 sm:text-right">
                          {m.available ? (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-chroma">
                              <span className="size-1.5 rounded-full bg-chroma" /> Ready via {engineShortName(m.via!)}
                            </span>
                          ) : m.runnable ? (
                            <Link href={builtIn.get(m.id) ?? "/settings/tools"} className="font-semibold text-tungsten hover:underline">
                              {m.reason}
                            </Link>
                          ) : (
                            <span className="text-haze">{m.reason}</span>
                          )}
                        </span>
                      </li>
                    ))}
              </ul>
              {loaded && list.length > shown.length ? (
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [kind]: true }))} className="w-full border-t border-line px-4 py-3 text-left text-[13px] font-semibold text-haze hover:text-paper">
                  Show all {list.length}
                </button>
              ) : null}
            </Panel>
            {loaded ? <OpenModels list={openModels(snap, kind, listed)} /> : null}
          </section>
        );
      })}
      {/* The LoRA library has its own page now; the old address (#loras) still lands on a way there. */}
      <section id="loras" className="mt-10 scroll-mt-24">
        <Link href="/settings/loras" className="press squircle flex items-center justify-between gap-4 rounded-[18px] bg-white/[0.035] px-5 py-4 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]">
          <span>
            <span className="block text-[15px] font-semibold text-paper">LoRAs</span>
            <span className="mt-0.5 block text-[13px] text-haze">Add-ons for each model: looks, camera moves, effects. Browse them with examples.</span>
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-fog">Open LoRAs</span>
        </Link>
      </section>
    </div>
  );
}

/**
 * A kind's open models that no machine has yet: what each is, what it downloads and how it would run on the machine it
 * suits best, and the link that opens its set-up there (Settings → Tools, that model picked). Nothing while no machine
 * answers: what would run is only known from a machine.
 */
function OpenModels({ list }: { list: OpenModel[] }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 4);
  return (
    <Panel className="mt-3">
      <PanelHeader title="Open models to set up">
        <span className="text-[12.5px] tabular text-haze">{list.length}</span>
      </PanelHeader>
      <ul className="divide-y divide-line">
        {shown.map(({ option: o, variant: v, machine, kit }) => {
          const fit = !v.fitsDisk ? "no room there yet" : runs(v) === 2 ? "runs well" : runs(v) === 1 ? "slow there" : "may not run there";
          return (
            <li key={o.model} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap">
              {o.thumb ? (
                // What it makes, as its card in the model library shows it: a small cached still.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewSrc(o.thumb)} alt="" loading="lazy" decoding="async" className="squircle size-9 shrink-0 rounded-[9px] bg-apple-2 object-cover" />
              ) : (
                <VendorMark vendor={o.maker} model={o.name} size={36} />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold">{o.name}</p>
                <p className="mt-0.5 text-[12px] text-haze">
                  {o.maker} · {bytesText(v.bytes)}
                  {o.qualityKnown ? ` · quality ${o.quality}` : ""}
                  {o.licence.commercial === "no" ? " · not for business" : ""}
                </p>
                <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-fog">{o.blurb}</p>
              </div>
              <span className="basis-full pl-12 text-[12.5px] leading-snug sm:max-w-[260px] sm:shrink-0 sm:basis-auto sm:pl-0 sm:pt-0.5 sm:text-right">
                <Link href={setUpHref(machine.id, kit, o.model)} className="font-semibold text-tungsten hover:underline">
                  Set up on {machine.label}
                </Link>
                <span className={cn("block", runs(v) === 2 && v.fitsDisk ? "text-haze" : "text-tungsten/80")}>{fit}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {list.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="w-full border-t border-line px-4 py-3 text-left text-[13px] font-semibold text-haze hover:text-paper">
          Show all {list.length}
        </button>
      ) : null}
    </Panel>
  );
}
