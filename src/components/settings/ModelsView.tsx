"use client";

import Link from "next/link";
import { useModels } from "@/lib/hooks/use-models";
import { ModelPicker, VendorMark } from "@/components/models/ModelPicker";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { KIND_LABEL, type ModelKind } from "@/lib/models/catalog";
import { engineShortName } from "@/lib/providers/names";
import { cn } from "@/lib/cn";

const KINDS: { kind: ModelKind; body: string }[] = [
  { kind: "image", body: "New images and edits: the composer, Director, Angles, Relight, Retouch and Product Studio." },
  { kind: "video", body: "Clips in Motion: animate a still or write a shot from scratch." },
  { kind: "text", body: "Rewrites your words, in any language, into a precise prompt before each generation when Refine is on. Fast models keep it snappy." },
  { kind: "upscale", body: "Making images bigger and sharper in Upscale." },
  { kind: "reframe", body: "Extending a picture to a new aspect ratio in Upscale → Reframe." },
];

const SPEED = { fast: "Fast", medium: "Balanced", slow: "Best quality" } as const;

export function ModelsView() {
  const { models, defaults, loaded, error, setDefault, refresh } = useModels();

  return (
    <div className="mt-8">
      <h1 className="font-display text-[34px]">Models</h1>
      <p className="mt-1.5 max-w-[66ch] text-[15px] leading-relaxed text-haze">
        Pick the model each kind of job uses by default. Every tool also has its own picker, so you can switch per shot.
      </p>
      {error ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] bg-tally/10 px-4 py-3 text-[13.5px] text-tally">
          <span>Couldn&rsquo;t load models: {error}</span>
          <button onClick={() => void refresh()} className="font-semibold hover:underline">
            Try again
          </button>
        </div>
      ) : null}

      {KINDS.map(({ kind, body }) => {
        const list = models.filter((m) => m.kind === kind);
        const ready = list.filter((m) => m.available).length;
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
                  <ModelPicker kind={kind} value={defaults[kind] ?? "auto"} onChange={(id) => void setDefault(kind, id)} placement="bottom-end" />
                </div>
              </PanelHeader>
              <ul className="divide-y divide-line">
                {!loaded
                  ? Array.from({ length: 3 }, (_, i) => <li key={i} className="skeleton m-3 h-12 rounded-[10px]" />)
                  : list.map((m) => (
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
                            <Link href="/settings/connections" className="font-semibold text-tungsten hover:underline">
                              {m.reason}
                            </Link>
                          ) : (
                            <span className="text-haze">{m.reason}</span>
                          )}
                        </span>
                      </li>
                    ))}
              </ul>
            </Panel>
          </section>
        );
      })}
    </div>
  );
}
