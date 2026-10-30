"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Check, Clapperboard, Copy, Download, ShieldCheck, Trash, TriangleAlert } from "lucide-react";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useHandoff } from "@/lib/hooks/use-handoff";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Media } from "@/components/ui/Media";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { AppIcon, ToolTile } from "@/components/ui/ToolTile";
import { copyText } from "@/lib/clipboard";
import { toolBySlug, type ToolSlug } from "@/lib/tools";
import { previewIdea, previewSamples, previewSrc, sampleById, type PreviewAxis, type PreviewContext, type SampleId } from "@/lib/product/previews";
import { CAMERAS, FINISHES, LIGHTS, MOMENTS, SCENES, byId, type ShotCheck, type ShotPlan } from "@/lib/product/vocab";
import type { FilmPicture } from "./film/PicturePicker";
import { cn } from "@/lib/cn";

const PEOPLE_OF: Record<string, FilmPicture["people"]> = { still: "none", ingredients: "none", motion: "none", hand: "hands", use: "person", together: "person", creator: "person" };

const AXIS: Record<PreviewAxis, { name: string; list: readonly { id: string; label: string; caption: string }[] }> = {
  moment: { name: "Shot", list: MOMENTS },
  scene: { name: "Scene", list: SCENES },
  camera: { name: "Camera", list: CAMERAS },
  light: { name: "Light", list: LIGHTS },
  finish: { name: "Finish", list: FINISHES },
};

type Tile = { gen: Generation; index: number };
const live = (g: Generation) => g.status === "queued" || g.status === "running";
const shotsOf = (g: Generation) => (Array.isArray(g.params?.shots) ? (g.params.shots as ShotPlan[]) : []);

/**
 * Product Studio's right side: the take you're looking at, big, with the idea behind it; every
 * take in a strip below. Before the first take, the pick you touched last, shown on many products.
 */
export function ProductOutput({
  focus,
  mine,
  onFilm,
}: {
  focus: { axis: PreviewAxis; id: string; ctx?: PreviewContext };
  mine: SampleId | null;
  /** Make a video of a take in Video mode (it opens with the take picked). */
  onFilm?: (p: FilmPicture) => void;
}) {
  const router = useRouter();
  const items = useGenerations((s) => s.items);
  const remove = useGenerations((s) => s.remove);
  const cancel = useGenerations((s) => s.cancel);
  const send = useHandoff((s) => s.send);
  const [pick, setPick] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tiles: Tile[] = useMemo(
    () =>
      items
        .filter((g) => g.tool === "product" && g.params?.kind !== "video")
        .flatMap((gen) => (gen.status === "done" && gen.outputs.length ? gen.outputs.map((_, index) => ({ gen, index })) : [{ gen, index: 0 }]))
        .slice(0, 40),
    [items],
  );
  // A new take takes the stage when it starts.
  const newest = tiles[0]?.gen.id;
  const lastNewest = useRef(newest);
  useEffect(() => {
    if (newest && newest !== lastNewest.current) setPick(null);
    lastNewest.current = newest;
  }, [newest]);

  const current = tiles.find((t) => `${t.gen.id}:${t.index}` === pick) ?? tiles[0] ?? null;
  const gen = current?.gen;
  const out = gen?.outputs[current?.index ?? 0];
  const shot = gen ? shotsOf(gen)[current?.index ?? 0] : undefined;

  function openIn(href: string) {
    if (!out) return;
    send({ prompt: "", references: [{ url: out.url, name: shot?.idea || gen?.prompt.slice(0, 40) || "Product shot" }], from: "product" });
    router.push(href);
  }

  return (
    <Panel className="flex min-h-[480px] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-190px)] lg:min-h-[560px]">
      <PanelHeader title={<span className="label text-fog">Output</span>} />

      <div className="grid h-[62vh] min-h-[320px] place-items-center p-4 [container-type:size] lg:h-auto lg:min-h-0 lg:flex-1">
        {!gen ? (
          <Board focus={focus} mine={mine} />
        ) : (
          <Frame gen={gen} index={current?.index ?? 0}>
            {out ? <Media media={out} alt={shot?.idea || gen.prompt} controls className="size-full object-contain" /> : null}
            {live(gen) ? <Working gen={gen} onCancel={() => cancel(gen.id)} /> : null}
            {gen.status === "error" ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-[380px]">
                  <TriangleAlert className="mx-auto text-tally" size={20} />
                  <p className="mt-2 text-[14px] font-semibold">Didn&rsquo;t shoot</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-fog">{gen.error}</p>
                  {gen.stage ? <p className="mt-1 text-[13px] text-paper">{gen.stage}</p> : null}
                </div>
              </div>
            ) : null}
          </Frame>
        )}
      </div>

      {gen && gen.status === "done" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {shot?.idea ? <p className="truncate text-[13.5px] font-semibold text-paper">{shot.idea}</p> : null}
            {shot?.check ? <CheckNote check={shot.check} /> : null}
            <p className="tabular text-[11.5px] text-haze">
              {gen.aspect}
              {gen.modelName ? ` · ${gen.modelName}` : ""}
              {gen.finishedAt ? ` · ${Math.round((gen.finishedAt - gen.createdAt) / 1000)}s` : ""}
            </p>
          </div>
          {out ? (
            <div className="flex flex-wrap items-center gap-1">
              {onFilm ? (
                <button
                  type="button"
                  onClick={() =>
                    onFilm({
                      url: out.url,
                      width: out.width ?? 1024,
                      height: out.height ?? 1280,
                      idea: shot?.idea || gen.prompt.slice(0, 80),
                      from: gen.id,
                      productUrl: gen.references.find((r) => r.role === "product")?.url,
                      people: PEOPLE_OF[(gen.params?.studio as { moment?: string } | undefined)?.moment ?? ""] ?? null,
                    })
                  }
                  className="press mr-1 inline-flex h-8 items-center gap-1.5 rounded-full bg-spike px-3 text-[12px] font-bold text-spike-ink hover:bg-spike-hi"
                  title="Turn this picture into a video ad"
                >
                  <Clapperboard size={14} /> Make a video
                </button>
              ) : (
                <IconButton label="Animate in Video" onClick={() => openIn("/video")}>
                  <AppIcon glyph="/icons/video.png" size={22} />
                </IconButton>
              )}
              <IconButton label="Re-shoot from another angle" onClick={() => openIn("/tools/angles")}>
                <ToolGlyph slug="angles" />
              </IconButton>
              <IconButton label="Relight" onClick={() => openIn("/tools/relight")}>
                <ToolGlyph slug="relight" />
              </IconButton>
              <IconButton label="Retouch" onClick={() => openIn("/tools/retouch")}>
                <ToolGlyph slug="retouch" />
              </IconButton>
              <IconButton label="Upscale" onClick={() => openIn("/tools/upscale")}>
                <ToolGlyph slug="upscale" />
              </IconButton>
              <span className="mx-1 h-4 w-px bg-line-strong" />
              <IconButton
                label={copied ? "Copied" : "Copy prompt"}
                onClick={async () => {
                  if (!(await copyText(shot?.prompt ?? gen.compiledPrompt ?? gen.prompt))) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
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
                title={shotsOf(t.gen)[t.index]?.idea || t.gen.prompt}
                className={cn(
                  "press squircle relative h-16 w-[52px] shrink-0 overflow-hidden rounded-[10px] bg-apple",
                  active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "opacity-80 shadow-[0_0_0_1px_var(--color-line)] hover:opacity-100",
                )}
                aria-label="Show this take"
              >
                {o ? <Media media={o} slot="chip" className="size-full object-cover" /> : null}
                {live(t.gen) ? <GeneratingField bare progress={t.gen.progress} backdrop={t.gen.references[0]?.url} /> : null}
                {t.gen.status === "error" ? <TriangleAlert size={14} className="absolute inset-0 m-auto text-tally" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

/** The take's frame: its real shape once made, else the shape that was asked for. */
function Frame({ gen, index, children }: { gen: Generation; index: number; children: ReactNode }) {
  const out = gen.outputs[index];
  const a = aspectById(gen.aspect);
  const ratio = out?.width && out?.height ? out.width / out.height : a.w / a.h;
  return (
    <div className="relative overflow-hidden rounded-[16px] bg-apple" style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}>
      {children}
    </div>
  );
}

/** The steps a take goes through, and what each one is called while it runs. */
const STEPS = [
  { match: /reading/i, label: "Reading your product" },
  { match: /planning/i, label: "Planning the shots" },
  { match: /shooting|rendering/i, label: "Shooting" },
  { match: /check|re-shoot/i, label: "Checking every detail" },
];

/** A take in progress: the product, softly, under a calm shimmer, and one line on how far along it is. */
function Working({ gen, onCancel }: { gen: Generation; onCancel: () => void }) {
  const checking = Boolean((gen.params?.studio as { check?: boolean } | undefined)?.check);
  const steps = checking ? STEPS : STEPS.slice(0, 3);
  const stage = gen.stage ?? "";
  const at = Math.max(0, steps.findIndex((s) => s.match.test(stage)));
  const label = /re-shoot/i.test(stage) ? "Re-shooting one take" : /saving/i.test(stage) ? "Almost there" : !stage || /queued|starting/i.test(stage) ? "Getting ready" : steps[at].label;
  const product = gen.references[0]?.url;
  return (
    <GeneratingField
      stage={`${label}… · ${Math.min(at + 1, steps.length)} of ${steps.length}`}
      progress={gen.progress}
      since={gen.createdAt}
      backdrop={product}
      onCancel={onCancel}
    />
  );
}

/** What the quality check made of a take, said plainly (including when it still found something). */
function CheckNote({ check }: { check: ShotCheck }) {
  const detail = check.issues.join(" ");
  if (check.pass)
    return (
      <p className="flex items-center gap-1 text-[11.5px] font-semibold text-chroma" title={check.retried && detail ? detail : undefined}>
        <ShieldCheck size={12} /> {check.retried ? "Re-shot once, then checked: product and label true" : "Checked: product and label true"}
      </p>
    );
  return (
    <p className="flex items-center gap-1 truncate text-[11.5px] font-semibold text-tungsten" title={detail}>
      <TriangleAlert size={12} className="shrink-0" /> <span className="truncate">{check.retried ? "Re-shot once, still" : "Check"}: {check.issues[0] ?? "something looks off"}</span>
    </p>
  );
}

/** Before the first take: the pick you touched last, played out on very different products. */
function Board({ focus, mine }: { focus: { axis: PreviewAxis; id: string; ctx?: PreviewContext }; mine: SampleId | null }) {
  const axis = AXIS[focus.axis];
  const option = byId(axis.list, focus.id);
  const available = previewSamples(focus.axis, focus.id, focus.ctx);
  // Yours first when there's one like it, then the rest; six at most so they stay big enough to read.
  const shown = (mine && available.includes(mine) ? [mine, ...available.filter((s) => s !== mine)] : available).slice(0, 6);
  return (
    <div className="w-full max-w-[820px] px-2">
      <p className="label text-haze">
        {axis.name} · <span className="text-paper">{option.label}</span>
      </p>
      <h3 className="mt-2 font-display text-[24px] leading-tight sm:text-[28px]">Any product. Every pick fitted to it.</h3>
      <p className="mt-1.5 max-w-[64ch] text-[13.5px] leading-relaxed text-haze">
        Food, drinks, beauty, fashion, tech, home, pets: Crackio reads what yours is and how it&rsquo;s used, then turns every pick into the shot that makes sense for it. Real takes from these exact settings:
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {shown.map((s) => {
          const sample = sampleById(s);
          const idea = previewIdea(focus.axis, focus.id, s, focus.ctx);
          return (
            <figure key={s} className="min-w-0">
              <div className={cn("relative aspect-[4/5] overflow-hidden rounded-[12px] bg-apple-2", mine === s && "shadow-[0_0_0_2px_var(--color-tool-product)]")}>
                <BoardImage src={previewSrc(focus.axis, focus.id, s, false, focus.ctx)} />
                <span className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-black/55 py-0.5 pl-0.5 pr-2 text-[10.5px] font-bold text-white">
                  <img src={sample.thumb} alt="" className="size-5 shrink-0 rounded-full object-cover" />
                  <span className="truncate">{sample.label}</span>
                </span>
                {mine === s ? <span className="absolute right-2 top-2 rounded-full bg-tool-product px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[#06210f]">Like yours</span> : null}
              </div>
              {idea ? <figcaption className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-fog">{idea}</figcaption> : null}
            </figure>
          );
        })}
      </div>
    </div>
  );
}

function BoardImage({ src }: { src: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  // One that failed before the page came alive never fires onError for React.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth === 0) setFailed(src);
  }, [src]);
  if (failed === src) return <div className="skeleton absolute inset-0 opacity-50" />;
  return (
    <motion.img
      ref={img}
      key={src}
      src={src}
      alt=""
      onError={() => setFailed(src)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="absolute inset-0 size-full object-cover"
    />
  );
}

function ToolGlyph({ slug }: { slug: ToolSlug }) {
  const t = toolBySlug(slug)!;
  return <ToolTile icon={t.icon} glyph={t.glyph} hue={t.hue} size={22} />;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="press squircle grid size-8 place-items-center rounded-[10px] text-fog hover:bg-white/[0.06] hover:text-paper">
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
      className={cn("press squircle grid h-8 min-w-8 place-items-center rounded-[10px]", arming ? "bg-tally px-2.5 text-[12px] font-bold text-white" : "text-fog hover:bg-white/[0.06] hover:text-paper")}
    >
      {arming ? "Delete?" : <Trash size={15} />}
    </button>
  );
}
