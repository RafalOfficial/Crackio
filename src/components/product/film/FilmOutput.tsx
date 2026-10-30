"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, MessageSquareQuote, ShieldCheck, Trash, TriangleAlert, Volume2, VolumeX } from "lucide-react";
import type { Generation } from "@/lib/generations/types";
import { aspectById } from "@/lib/shot";
import { useGenerations } from "@/lib/hooks/use-generations";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Media } from "@/components/ui/Media";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { copyText } from "@/lib/clipboard";
import { previewUrl } from "@/lib/media-url";
import { filmPreviews, stillById } from "@/lib/product/film-previews";
import { FILM_CAMERAS, FILM_HOOKS, FILM_MOODS, FILM_PACES, FILM_STORIES, FILM_STYLES, byFilmId, type FilmAxis, type FilmCheck, type FilmPlan } from "@/lib/product/film";
import { ClipCycle } from "./FilmOptionGrid";
import { cn } from "@/lib/cn";

const AXIS: Record<FilmAxis, { name: string; list: readonly { id: string; label: string; caption: string }[] }> = {
  style: { name: "Style", list: FILM_STYLES },
  camera: { name: "Camera", list: FILM_CAMERAS },
  hook: { name: "Hook", list: FILM_HOOKS },
  mood: { name: "Mood", list: FILM_MOODS },
  pace: { name: "Pace", list: FILM_PACES },
  story: { name: "Story", list: FILM_STORIES },
};

const live = (g: Generation) => g.status === "queued" || g.status === "running";
const clipsOf = (g: Generation) => (Array.isArray(g.params?.clips) ? (g.params.clips as (FilmPlan & { check?: FilmCheck })[]) : []);
export const isFilmTake = (g: Generation) => g.tool === "product" && g.params?.kind === "video";

/**
 * Video mode's right side: the take you're looking at, with what was said and what the check found;
 * every take in a strip below. Before the first take, the pick you touched last, filmed on samples.
 */
export function FilmOutput({ focus, like }: { focus: { axis: FilmAxis; id: string }; like: string | null }) {
  const items = useGenerations((s) => s.items);
  const remove = useGenerations((s) => s.remove);
  const cancel = useGenerations((s) => s.cancel);
  const [pick, setPick] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const takes = useMemo(() => items.filter(isFilmTake).slice(0, 40), [items]);
  // A new take takes the stage when it starts.
  const newest = takes[0]?.id;
  const lastNewest = useRef(newest);
  useEffect(() => {
    if (newest && newest !== lastNewest.current) setPick(null);
    lastNewest.current = newest;
  }, [newest]);

  const gen = takes.find((t) => t.id === pick) ?? takes[0] ?? null;
  const out = gen?.outputs[0];
  const clips = gen ? clipsOf(gen) : [];
  const script = clips.map((c) => c.script).filter(Boolean).join(" ");
  const check = clips.find((c) => c.check && !c.check.pass)?.check ?? clips.find((c) => c.check)?.check;
  const idea = typeof gen?.params?.idea === "string" ? gen.params.idea : "";

  return (
    <Panel className="flex min-h-[480px] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-190px)] lg:min-h-[560px]">
      <PanelHeader title={<span className="label text-fog">Output</span>} />
      <div className="grid h-[62vh] min-h-[320px] place-items-center p-4 [container-type:size] lg:h-auto lg:min-h-0 lg:flex-1">
        {!gen ? (
          <Board focus={focus} like={like} />
        ) : (
          <Frame gen={gen}>
            {out ? <Media media={out} alt={idea || gen.prompt} controls className="size-full object-contain" /> : null}
            {live(gen) ? <Working gen={gen} onCancel={() => cancel(gen.id)} /> : null}
            {gen.status === "error" ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-[380px]">
                  <TriangleAlert className="mx-auto text-tally" size={20} />
                  <p className="mt-2 text-[14px] font-semibold">Didn&rsquo;t film</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-fog">{gen.error}</p>
                  {gen.stage ? <p className="mt-1 text-[13px] text-paper">{gen.stage}</p> : null}
                </div>
              </div>
            ) : null}
          </Frame>
        )}
      </div>

      {gen && gen.status === "done" ? (
        <div className="space-y-1.5 border-t border-line px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              {idea ? <p className="truncate text-[13.5px] font-semibold text-paper">{idea}</p> : null}
              {check ? <CheckNote check={check} /> : null}
              <p className="tabular text-[11.5px] text-haze">
                {out?.duration ? `${out.duration.toFixed(1)} s · ` : ""}
                {gen.aspect}
                {gen.modelName ? ` · ${gen.modelName}` : ""}
                {gen.finishedAt ? ` · made in ${Math.round((gen.finishedAt - gen.createdAt) / 1000)} s` : ""}
              </p>
            </div>
            {out ? (
              <div className="flex items-center gap-1">
                <IconButton
                  label={copied ? "Copied" : "Copy prompt"}
                  onClick={async () => {
                    if (!(await copyText(gen.compiledPrompt ?? gen.prompt))) return;
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
          {script ? (
            <p className="flex gap-1.5 text-[12.5px] leading-snug text-fog">
              <MessageSquareQuote size={14} className="mt-px shrink-0 text-haze" />
              <span className="line-clamp-3">&ldquo;{script}&rdquo;</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {takes.length > 1 ? (
        <div className="scrollbar-none strip-fade flex gap-2 overflow-x-auto border-t border-line p-3 pr-9">
          {takes.map((t) => {
            const o = t.outputs[0];
            const start = typeof t.params?.startUrl === "string" ? t.params.startUrl : t.references[0]?.url;
            return (
              <button
                key={t.id}
                onClick={() => setPick(t.id)}
                title={(typeof t.params?.idea === "string" && t.params.idea) || t.prompt}
                className={cn(
                  "press squircle relative h-16 w-[52px] shrink-0 overflow-hidden rounded-[10px] bg-apple",
                  gen?.id === t.id ? "shadow-[0_0_0_2px_var(--color-spike)]" : "opacity-80 shadow-[0_0_0_1px_var(--color-line)] hover:opacity-100",
                )}
                aria-label="Show this take"
              >
                {o ? <Media media={o} slot="chip" className="size-full object-cover" /> : start ? <img src={previewUrl(start, 160)} alt="" className="size-full object-cover opacity-45" /> : null}
                {live(t) ? <GeneratingField bare progress={t.progress} backdrop={start ? previewUrl(start, 160) : null} /> : null}
                {t.status === "error" ? <TriangleAlert size={14} className="absolute inset-0 m-auto text-tally" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

/** The take's frame: its real shape once made, else the shape that was asked for. */
function Frame({ gen, children }: { gen: Generation; children: ReactNode }) {
  const out = gen.outputs[0];
  const a = aspectById(gen.aspect);
  const ratio = out?.width && out?.height ? out.width / out.height : a.w / a.h;
  return (
    <div className="relative overflow-hidden rounded-[16px] bg-apple" style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}>
      {children}
    </div>
  );
}

const STEPS = [
  { match: /reading|re-shoot/i, label: "Reading your product" },
  { match: /script|planning/i, label: "Writing the take" },
  { match: /filming|rendering|sending|connecting/i, label: "Filming" },
  { match: /check|re-film/i, label: "Watching every frame" },
  { match: /cutting|saving/i, label: "Cutting" },
];

/** A take in progress: its first frame, softly, under a calm shimmer, and one line on how far along it is. */
function Working({ gen, onCancel }: { gen: Generation; onCancel: () => void }) {
  const stage = gen.stage ?? "";
  const at = Math.max(0, STEPS.findIndex((s) => s.match.test(stage)));
  const label = /re-film/i.test(stage) ? "Re-filming one clip" : /re-shoot/i.test(stage) ? "Re-shooting your picture for the camera" : !stage || /queued|starting/i.test(stage) ? "Getting ready" : /filming \d/i.test(stage) ? stage : STEPS[at].label;
  const start = typeof gen.params?.startUrl === "string" ? gen.params.startUrl : gen.references[0]?.url;
  return (
    <GeneratingField
      stage={`${label}… · ${Math.min(at + 1, STEPS.length)} of ${STEPS.length}`}
      progress={gen.progress}
      since={gen.createdAt}
      backdrop={start ? previewUrl(start, 960) : null}
      onCancel={onCancel}
    />
  );
}

function CheckNote({ check }: { check: FilmCheck }) {
  const detail = check.issues.join(" ");
  if (check.pass)
    return (
      <p className="flex items-center gap-1 text-[11.5px] font-semibold text-chroma" title={check.retried && detail ? detail : undefined}>
        <ShieldCheck size={12} /> {check.retried ? "Re-filmed once, then checked frame by frame" : "Checked frame by frame: product, people, words"}
      </p>
    );
  return (
    <p className="flex items-center gap-1 truncate text-[11.5px] font-semibold text-tungsten" title={detail}>
      <TriangleAlert size={12} className="shrink-0" /> <span className="truncate">{check.retried ? "Re-filmed once, still" : "Check"}: {check.issues[0] ?? "something looks off"}</span>
    </p>
  );
}

/** Before the first take: the pick you touched last, filmed from sample pictures, with sound on demand. */
function Board({ focus, like }: { focus: { axis: FilmAxis; id: string }; like: string | null }) {
  const axis = AXIS[focus.axis];
  const option = byFilmId(axis.list, focus.id);
  const list = filmPreviews(focus.axis, focus.id);
  const shown = (like ? [...list.filter((p) => stillById(p.still)?.product === like), ...list.filter((p) => stillById(p.still)?.product !== like)] : list).slice(0, 3);
  const [sound, setSound] = useState<string | null>(null);
  return (
    <div className="w-full max-w-[860px] px-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="label text-haze">
          {axis.name} · <span className="text-paper">{option.label}</span>
        </p>
        <span className="text-[11.5px] text-haze">Real takes from these exact picks</span>
      </div>
      <h3 className="mt-2 font-display text-[24px] leading-tight sm:text-[28px]">Your picture, turned into an ad.</h3>
      <p className="mt-1.5 max-w-[64ch] text-[13.5px] leading-relaxed text-haze">{option.caption} Crackio fits every pick to your product, writes what they say, films it, then watches every frame and re-films what a client would reject.</p>
      {shown.length ? (
        <div className={cn("mt-4 grid gap-2.5", shown.length === 1 ? "grid-cols-1 sm:max-w-[320px]" : shown.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
          {shown.map((p) => (
            <figure key={p.clip} className="min-w-0">
              <div className="relative overflow-hidden rounded-[12px] bg-apple-2" style={{ aspectRatio: Math.max(0.5625, Math.min(1, p.ratio)) }}>
                <ClipCycle list={[p]} first={p} muted={sound !== p.clip} />
                <button
                  type="button"
                  onClick={() => setSound((s) => (s === p.clip ? null : p.clip))}
                  className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75"
                  aria-label={sound === p.clip ? "Mute" : "Hear it"}
                  title={sound === p.clip ? "Mute" : "Hear it"}
                >
                  {sound === p.clip ? <Volume2 size={13} /> : <VolumeX size={13} />}
                </button>
              </div>
            </figure>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid h-[240px] place-items-center rounded-[14px] bg-white/[0.03] text-[13px] text-haze shadow-[inset_0_0_0_1px_var(--color-line)]">Preview coming soon for this pick.</div>
      )}
    </div>
  );
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
