"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Download, Trash, TriangleAlert } from "lucide-react";
import { Panel, PanelHeader, EmptyState } from "@/components/ui/Panel";
import { Osd } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { Media } from "@/components/ui/Media";
import { AppIcon, ToolTile } from "@/components/ui/ToolTile";
import { toolBySlug, type ToolSlug } from "@/lib/tools";

/** A tool's own app icon, small, for the "continue in…" shortcuts. */
function ToolGlyph({ slug }: { slug: ToolSlug }) {
  const t = toolBySlug(slug)!;
  return <ToolTile icon={t.icon} glyph={t.glyph} hue={t.hue} size={22} />;
}

type Tile = { gen: Generation; index: number };

/** The latest take, big, with the run's details; earlier takes in a strip below. */
export function OutputPanel() {
  const router = useRouter();
  const { items, loaded, remove, cancel } = useGenerations();
  const send = useHandoff((s) => s.send);
  const [pick, setPick] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // This page's own takes (and Home's composer's): Motion's turns, Swap's clips and the other tools' takes stay in their tools.
  const tiles: Tile[] = useMemo(
    () =>
      items
        .filter((gen) => gen.tool === "image" || gen.tool === "video")
        .flatMap((gen) => (gen.status === "done" ? gen.outputs.map((_, index) => ({ gen, index })) : [{ gen, index: 0 }]))
        .slice(0, 24),
    [items],
  );
  const current = tiles.find((t) => `${t.gen.id}:${t.index}` === pick) ?? tiles[0] ?? null;
  const gen = current?.gen;
  const out = gen?.outputs[current?.index ?? 0];
  const ratio = out?.width && out?.height ? out.width / out.height : gen ? aspectById(gen.aspect).w / aspectById(gen.aspect).h : 3 / 2;

  function openIn(href: string) {
    if (!out) return;
    send({ prompt: "", references: [{ url: out.url, name: gen?.prompt.slice(0, 40) || "Generation" }], from: "home" });
    router.push(href);
  }

  return (
    <Panel aria-label="Output" className="flex flex-col">
      <PanelHeader title={<span className="label text-fog">Output</span>}>
        <Link href="/library" className="text-[12.5px] font-semibold text-fog hover:text-paper">
          Open library
        </Link>
      </PanelHeader>

      <div className="relative grid h-[clamp(300px,58vh,660px)] place-items-center p-4" style={{ containerType: "size" }}>
        {!loaded ? (
          <div className="skeleton size-full rounded-[12px]" />
        ) : !gen ? (
          <EmptyState eyebrow="3:2" title="Your first shot appears here">
            Write a scene, pick a model, then Generate.
          </EmptyState>
        ) : (
          <div
            className="relative overflow-hidden rounded-[12px] bg-apple"
            style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
          >
            {out ? <Media media={out} alt={gen.prompt} controls className="size-full object-contain" /> : null}
            {gen.status === "queued" || gen.status === "running" ? (
              <GeneratingField stage={gen.stage} progress={gen.progress} prompt={gen.prompt || "From references"} since={gen.createdAt} onCancel={() => cancel(gen.id)} />
            ) : null}
            {gen.status === "error" ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-[380px]">
                  <TriangleAlert className="mx-auto text-tally" size={20} />
                  <p className="mt-2 text-[14px] font-semibold">Didn&rsquo;t render</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-fog">{gen.error}</p>
                  {gen.stage ? <p className="mt-1 text-[13px] text-paper">{gen.stage}</p> : null}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {gen ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5">
          <Osd className="tabular text-haze">
            {gen.aspect}
            {gen.modelName ? ` · ${gen.modelName}` : ""}
            {gen.finishedAt && gen.status === "done" ? ` · ${Math.round((gen.finishedAt - gen.createdAt) / 1000)}s` : ""}
          </Osd>
          {out ? (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {out.kind === "image" ? (
                <>
                  <IconButton label="Animate in Video" onClick={() => openIn("/video")}>
                    <AppIcon glyph="/icons/video.png" size={22} />
                  </IconButton>
                  <IconButton label="Re-shoot from another angle" onClick={() => openIn("/tools/angles")}>
                    <ToolGlyph slug="angles" />
                  </IconButton>
                  <IconButton label="Relight" onClick={() => openIn("/tools/relight")}>
                    <ToolGlyph slug="relight" />
                  </IconButton>
                  <IconButton label="Upscale" onClick={() => openIn("/tools/upscale")}>
                    <ToolGlyph slug="upscale" />
                  </IconButton>
                  <span className="mx-1 h-4 w-px bg-line-strong" />
                </>
              ) : null}
              <IconButton
                label={copied ? "Copied" : "Copy prompt"}
                onClick={async () => {
                  if (!(await copyText(gen.compiledPrompt ?? gen.prompt))) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                <Copy size={15} />
              </IconButton>
              <a href={out.url} download className="press squircle grid size-8 place-items-center rounded-[10px] text-fog hover:bg-white/[0.06] hover:text-paper" aria-label="Download" title="Download">
                <Download size={15} />
              </a>
              <DeleteButton onDelete={() => remove(gen.id)} />
            </div>
          ) : null}
        </div>
      ) : null}

      {tiles.length > 1 ? (
        <div className="scrollbar-none strip-fade flex gap-2 overflow-x-auto border-t border-line p-3 pr-9">
          {tiles.map((t) => {
            const o = t.gen.outputs[t.index];
            const key = `${t.gen.id}:${t.index}`;
            const active = current && `${current.gen.id}:${current.index}` === key;
            return (
              <button
                key={key}
                onClick={() => setPick(key)}
                className={cn(
                  "press squircle relative h-14 w-20 shrink-0 overflow-hidden rounded-[11px] bg-apple",
                  active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line)] opacity-80 hover:opacity-100",
                )}
                aria-label="Show this take"
              >
                {o ? <Media media={o} slot="chip" className="size-full object-cover" /> : null}
                {t.gen.status === "queued" || t.gen.status === "running" ? <div className="skeleton absolute inset-0" /> : null}
                {t.gen.status === "error" ? <TriangleAlert size={14} className="absolute inset-0 m-auto text-tally" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="press squircle grid size-8 place-items-center rounded-[10px] text-fog hover:bg-white/[0.06] hover:text-paper"
    >
      {children}
    </button>
  );
}

/** Two clicks to delete: the first arms it for a moment, so a stray click never loses a take. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  return (
    <button
      onClick={() => {
        if (arming) return onDelete();
        setArming(true);
        clearTimeout(disarm.current);
        disarm.current = setTimeout(() => setArming(false), 2600);
      }}
      title={arming ? "Click again to delete" : "Delete"}
      aria-label={arming ? "Click again to delete" : "Delete"}
      className={cn(
        "press squircle grid h-8 min-w-8 place-items-center rounded-[10px]",
        arming ? "bg-tally px-2.5 text-[12px] font-bold text-white" : "text-fog hover:bg-white/[0.06] hover:text-paper",
      )}
    >
      {arming ? "Delete?" : <Trash size={15} />}
    </button>
  );
}
