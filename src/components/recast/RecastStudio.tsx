"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Film, LoaderCircle, MousePointerClick, Pause, Play, Replace, ScanSearch, Trash, TriangleAlert, Upload, X } from "lucide-react";
import { ToolTile } from "@/components/ui/ToolTile";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { GenerationCard } from "@/components/generations/GenerationCard";
import { useMentions } from "@/components/cast/Mentions";
import { ThingAnnotator } from "@/components/annotate/ThingAnnotator";
import { pinTarget, useThings, where, type Box, type Pin } from "@/components/annotate/things";
import { useGenerations, useGenerationsStore } from "@/lib/hooks/use-generations";
import { useModelInfo } from "@/lib/hooks/use-custom-models";
import { ModelPicker } from "@/components/models/ModelPicker";
import { CostLine } from "@/components/models/CostLine";
import { toolBySlug } from "@/lib/tools";
import type { Generation } from "@/lib/generations/types";
import type { Caps } from "@/lib/models/caps";
import { cn } from "@/lib/cn";

const tool = toolBySlug("recast")!;
/** How much of a clip an editor that lists no limit is given. */
const DEFAULT_WINDOW = 8.5;
/** The clip editor Recast runs on unless you pick another: Kling 3 Omni on Comfy Router. */
const DEFAULT_EDITOR = "comfy:kling/kling-v3-omni";

/** How much of the clip a model edits at once: its own longest input (a hair under), else 8.5 s. */
function windowFor(caps: Caps | null) {
  const max = caps?.video?.limits?.maxDuration;
  return max ? Math.max(1, Math.floor((max - 0.1) * 10) / 10) : DEFAULT_WINDOW;
}
const STYLES = ["Anime", "Claymation", "3D animation", "Watercolor", "Film noir", "Vintage 16mm film"];

type Clip = { url: string; name: string; duration: number };
/** One change, pinned at a moment of the clip: on a thing (or one of its parts), or on a spot. */
type Note = Pin & { t: number };
type Frame = { url: string; width: number; height: number };

/** A frame of the clip at `t`, as a picture (fast: the things in it are found after it shows). */
async function frameAt(source: string, t: number): Promise<{ frame?: Frame; error?: string }> {
  try {
    const res = await fetch("/api/recast/frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, t }) });
    const data = (await res.json()) as { frame?: Frame; error?: string };
    if (!res.ok || !data.frame) throw new Error(data.error ?? "Couldn't read the frame.");
    return { frame: data.frame };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const spotBox = ([x, y]: [number, number]): Box => [x - 20, y - 20, x + 20, y + 20];

/** The edit instruction: every note, with where it is and what it becomes, and the rest kept as is. */
function composePrompt(notes: Note[], extra: string, style: string | null, moment: number) {
  const lines = notes
    .filter((n) => n.text.trim())
    .map((n, i) => {
      const t = pinTarget(n);
      const target = t.box ? `${t.detail.charAt(0).toUpperCase()}${t.detail.slice(1)} in ${where(t.box, "frame")}` : `The spot at ${where(spotBox(n.at), "frame")}`;
      const look = n.image?.description ? ` Make it look exactly like this: ${n.image.description.replace(/\.$/, "")}.` : "";
      return `${i + 1}. ${target}: ${n.text.trim().replace(/\.$/, "")}.${look}`;
    });
  const parts = [
    lines.length ? `Make exactly these changes to the clip and nothing else. Positions refer to the frame at ${moment.toFixed(1)} s; follow each thing as it moves through the clip.\n${lines.join("\n")}` : "",
    extra.trim() ? `${lines.length ? "Also: " : ""}${extra.trim().replace(/\.$/, "")}.` : "",
    style ? `Restyle the whole clip as ${style.toLowerCase()}, keeping the composition, the people and what they do exactly the same.` : "",
    "Everything else stays exactly as it is: the people, the setting, the motion, the timing, the camera movement and the framing.",
  ];
  return parts.filter(Boolean).join("\n");
}

/** Recast: keep a clip's motion and timing, and change exactly the things you point at. */
export function RecastStudio() {
  const { items } = useGenerations();
  const [viewing, setViewing] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [start, setStart] = useState(0);
  const [moment, setMoment] = useState(0);
  const [notes, setNotes] = useState<Note[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  // Kling 3 Omni unless you pick another one in the Custom tab.
  const [model, setModel] = useState(DEFAULT_EDITOR);
  const info = useModelInfo(model);
  const span = windowFor(info.caps);
  const takes = items.filter((g) => g.tool === "recast");
  const shown = takes.find((g) => g.id === viewing) ?? takes[0] ?? null;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 lg:px-8">
      <header className="flex items-start gap-4">
        <ToolTile icon={tool.icon} hue={tool.hue} size={44} />
        <div>
          <h1 className="font-display text-[34px] sm:text-[40px]">Recast</h1>
          <p className="mt-1 max-w-[70ch] text-[14.5px] leading-relaxed text-fog">
            Point at anything in your clip and say how it should change. Crackio finds every object, writes one precise edit (where, what, and into what) and keeps the motion, timing and sound.
          </p>
        </div>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[400px_1fr]">
        <Controls
          clip={clip}
          setClip={(c) => {
            setClip(c);
            setStart(0);
            setMoment(0);
            setNotes([]);
          }}
          start={start}
          setStart={(v) => {
            setStart(v);
            setMoment(v);
          }}
          moment={moment}
          notes={notes}
          onEdit={setEditing}
          onRemove={(id) => setNotes((ns) => ns.filter((n) => n.id !== id))}
          onStarted={setViewing}
          model={model}
          setModel={setModel}
          modelName={info.name}
          caps={info.caps}
          span={span}
        />
        <main className="min-w-0 space-y-8">
          {clip ? (
            <Annotator
              key={`${clip.url}:${Math.round(start * 10)}:${span}`}
              clip={clip}
              span={span}
              start={start}
              moment={moment}
              setMoment={setMoment}
              notes={notes}
              setNotes={setNotes}
              editing={editing}
              setEditing={setEditing}
            />
          ) : (
            <Empty />
          )}
          {shown ? <Compare gen={shown} /> : null}
          {takes.length > 1 ? (
            <section>
              <h2 className="label mb-2">Your recasts</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {takes.map((g) => (
                  // A div, not a button: the card has its own buttons inside.
                  <div
                    key={g.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Show ${g.prompt}`}
                    onClick={() => setViewing(g.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setViewing(g.id)}
                    className={cn("cursor-pointer rounded-[18px]", g.id === shown?.id && "ring-2 ring-spike ring-offset-2 ring-offset-stage")}
                  >
                    <GenerationCard gen={g} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

function Controls({
  clip,
  setClip,
  start,
  setStart,
  moment,
  notes,
  onEdit,
  onRemove,
  onStarted,
  model,
  setModel,
  modelName,
  caps,
  span,
}: {
  clip: Clip | null;
  setClip: (c: Clip | null) => void;
  start: number;
  setStart: (v: number) => void;
  moment: number;
  notes: Note[];
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onStarted: (id: string) => void;
  model: string;
  setModel: (id: string) => void;
  modelName: string | null;
  /** What a Custom-tab clip editor accepts (null for Grok's). */
  caps: Caps | null;
  /** How many seconds of the clip get edited. */
  span: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [extra, setExtra] = useState("");
  const [style, setStyle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ textarea: field, value: extra, onChange: setExtra });

  async function upload(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError("Pick a video file (MP4, MOV or WebM).");
    setError(null);
    setUploading(true);
    try {
      const duration = await new Promise<number>((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => resolve(v.duration || 0);
        v.onerror = () => resolve(0);
        v.src = URL.createObjectURL(file);
      });
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = (await res.json()) as { items?: { url: string }[]; error?: string };
      if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed.");
      setClip({ url: data.items[0].url, name: file.name, duration });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const written = notes.filter((n) => n.text.trim());
  const describing = notes.some((n) => n.image?.describing);
  // Pictures attached to changes go along as references to models that take them.
  const pictures = written.flatMap((n) => (n.image?.url ? [n.image.url] : []));
  const takesPictures = Boolean(caps?.image || caps?.refs);
  const needsPicture = Boolean(caps?.image?.required || caps?.refs?.required) && !pictures.length && !/@\w/.test([extra, ...written.map((n) => n.text)].join(" "));
  const ready = Boolean(clip) && (written.length > 0 || extra.trim().length > 3 || Boolean(style)) && !needsPicture;

  async function recast() {
    if (!clip || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const prompt = composePrompt(written, extra, style, moment);
      const label = [written.map((n) => n.text.trim()).join(" · "), extra.trim(), style ? `Look → ${style}` : ""].filter(Boolean).join(" · ").slice(0, 118);
      const res = await fetch("/api/recast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: clip.url, start, prompt, label, model, images: takesPictures ? pictures : [] }),
      });
      const data = (await res.json()) as { item?: Generation; error?: string };
      if (!res.ok || !data.item) throw new Error(data.error ?? "Couldn't start the recast.");
      // Show it right away; the store polls it like any other take.
      const store = useGenerationsStore.getState();
      useGenerationsStore.setState({ items: [data.item, ...store.items] });
      void store.load();
      onStarted(data.item.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const long = clip ? clip.duration > span + 0.2 : false;
  const minClip = caps?.video?.limits?.minDuration;
  return (
    <aside className="surface space-y-5 rounded-panel p-5 lg:sticky lg:top-6">
      <Section title="Model" hint={`Edits up to ${span} s`}>
        <ModelPicker kind="video" task="video-edit" only={[DEFAULT_EDITOR]} noAuto value={model} onChange={setModel} />
      </Section>

      <Section title="Clip" hint={clip ? `${clip.name} · ${clip.duration.toFixed(1)} s` : `Up to ${span} s is recast`}>
        {clip ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[12.5px] text-fog">
              <span className="inline-flex min-w-0 items-center gap-2">
                <Film size={14} className="shrink-0" /> <span className="truncate">{clip.name}</span>
              </span>
              <button type="button" onClick={() => setClip(null)} className="text-haze hover:text-paper" aria-label="Remove the clip">
                <X size={14} />
              </button>
            </div>
            {long ? (
              <Slider
                label="Recast from"
                value={start}
                min={0}
                max={Math.max(0.1, clip.duration - span)}
                step={0.1}
                onChange={setStart}
                format={(v) => `${v.toFixed(1)}–${Math.min(clip.duration, v + span).toFixed(1)} s`}
              />
            ) : null}
            {minClip && clip.duration < minClip - 0.05 ? (
              <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-tungsten">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" /> This model needs a clip of at least {minClip} s. Pick a longer clip or another model.
              </p>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files[0]);
            }}
            className={cn(
              "press flex h-36 w-full flex-col items-center justify-center gap-2 rounded-[14px] bg-white/[0.03] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper",
              dragging && "shadow-[inset_0_0_0_2px_var(--color-spike)]",
            )}
          >
            {uploading ? <LoaderCircle size={20} className="animate-spin" /> : <Upload size={20} />}
            <span className="text-[13px] font-semibold">{uploading ? "Uploading…" : "Drop a clip or browse"}</span>
            <span className="text-[11.5px] text-haze">MP4, MOV or WebM</span>
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </Section>

      <Section title="Changes" hint={written.length ? `${written.length} pinned` : "Click things in the frame"}>
        {written.length ? (
          <ol className="space-y-1.5">
            {written.map((n, i) => (
              <li key={n.id} className="group flex items-start gap-2.5 rounded-[12px] bg-white/[0.04] p-2.5">
                <span className="tabular grid size-5 shrink-0 place-items-center rounded-full bg-spike text-[11px] font-bold text-spike-ink">{i + 1}</span>
                <button type="button" onClick={() => onEdit(n.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[12px] font-semibold text-paper">{pinTarget(n).name}</span>
                  <span className="block text-[12.5px] leading-snug text-fog">{n.text}</span>
                  {n.image ? (
                    <span className="mt-1.5 flex items-center gap-2 text-[11.5px] text-haze">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={n.image.preview} alt="" className="size-7 rounded-[6px] object-cover" />
                      {n.image.describing ? "Reading the image…" : n.image.description ? "Image described" : (n.image.error ?? "")}
                    </span>
                  ) : null}
                </button>
                <button type="button" onClick={() => onRemove(n.id)} className="text-haze opacity-0 transition-opacity hover:text-paper group-hover:opacity-100" aria-label="Remove change">
                  <Trash size={13} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="flex items-start gap-2 rounded-[12px] bg-white/[0.03] p-3 text-[12.5px] leading-relaxed text-fog">
            <MousePointerClick size={14} className="mt-0.5 shrink-0 text-haze" />
            {clip ? "Hover the frame to find things, then click one and say how it should change." : "Add a clip first."}
          </p>
        )}
      </Section>

      <Section title="Anything else" hint="Optional · @name for your cast">
        <textarea
          ref={field}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => void mentions.onKeyDown(e)}
          rows={2}
          placeholder="Make it snow lightly · turn the evening into golden hour"
          className="field-focus block w-full resize-none rounded-[12px] bg-white/[0.04] px-3 py-2.5 text-[13.5px] leading-relaxed text-paper outline-none placeholder:text-haze"
        />
        {mentions.menu}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStyle((cur) => (cur === s ? null : s))}
              className={cn("press h-7 rounded-full px-2.5 text-[11.5px] font-semibold", style === s ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:text-paper")}
            >
              {s}
            </button>
          ))}
        </div>
      </Section>

      <CostLine
        modelId={model}
        noun="this recast"
        input={{ output: "video", seconds: clip ? Math.max(1, Math.round(Math.min(span, clip.duration - start))) : Math.round(span), count: 1 }}
        quote={{ output: "video", seconds: clip ? Math.max(1, Math.round(Math.min(span, clip.duration - start))) : Math.round(span), aspect: "16:9", count: 1, images: takesPictures ? pictures.length : 0 }}
      />
      <Button variant="primary" size="lg" className="w-full" disabled={!ready || busy || uploading || describing} onClick={() => void recast()}>
        {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Replace size={16} />} Recast
      </Button>
      {needsPicture ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-tungsten">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> This model needs a reference picture: attach an image to a change, or @mention someone from your cast.
        </p>
      ) : null}
      <p className="text-[12px] leading-relaxed text-haze">
        {`Runs on ${modelName ?? "the model you picked"}, which edits up to ${span} s of your clip.${takesPictures ? " Pictures you attach to changes go along as references." : ""} Small, pinned changes come out the most faithful.`}
      </p>
      {error ? (
        <p className="flex items-start gap-2 text-[13px] text-tally">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {error}
        </p>
      ) : null}
    </aside>
  );
}

/* ------------------------------------------------------------------ annotator */

/**
 * The frame, shown as soon as it's read, with everything in it found after: hovering outlines a
 * thing, a click pins a note there (on a thing, one of its parts, or a bare spot), and notes can
 * carry a reference image.
 */
function Annotator({
  clip,
  span,
  start,
  moment,
  setMoment,
  notes,
  setNotes,
  editing,
  setEditing,
}: {
  clip: Clip;
  /** How many seconds of the clip get edited. */
  span: number;
  start: number;
  moment: number;
  setMoment: (t: number) => void;
  notes: Note[];
  setNotes: (fn: (n: Note[]) => Note[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  // Keyed by clip and window start (see RecastStudio), so a new window starts at its first frame.
  const first = Math.round(start * 10) / 10;
  const [shot, setShot] = useState<{ t: number; frame?: Frame; busy: boolean; error?: string }>({ t: first, busy: true });
  const found = useThings(shot.frame?.url ?? null);
  const end = Math.min(clip.duration, start + span);

  useEffect(() => {
    let alive = true;
    void frameAt(clip.url, first).then((r) => alive && setShot({ t: first, busy: false, ...r }));
    return () => {
      alive = false;
    };
  }, [clip.url, first]);

  async function grab(t: number) {
    setShot((s) => ({ ...s, busy: true, error: undefined }));
    const r = await frameAt(clip.url, t);
    setShot((s) => (r.frame ? { t, frame: r.frame, busy: false } : { ...s, busy: false, error: r.error }));
  }

  // The notes pinned on the frame on screen.
  const near = (n: Note) => Math.abs(n.t - shot.t) < 0.05;
  const here = notes.filter(near);
  const status = shot.busy && !shot.frame ? "Reading the frame…" : found.status === "loading" ? "Finding things in this frame…" : null;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[22px]">Point at what changes</h2>
        <p className="flex items-center gap-1.5 text-[12.5px] text-haze">
          {status ? (
            <>
              <LoaderCircle size={13} className="animate-spin" /> {status}
            </>
          ) : shot.error ? (
            <span className="text-tungsten">{shot.error}</span>
          ) : found.status === "error" ? (
            <span className="text-tungsten">{found.error ?? "Nothing found"} · click anywhere to add a note</span>
          ) : (
            <>
              <ScanSearch size={13} /> {found.things.length} things found · click one (then its parts), or any spot
            </>
          )}
        </p>
      </div>

      {shot.frame ? (
        <ThingAnnotator
          image={shot.frame}
          things={found.things}
          status={found.status}
          error={found.error}
          needParts={found.needParts}
          pins={here}
          setPins={(fn) =>
            setNotes((all) => {
              const next = fn(all.filter(near)).map((p) => ({ ...p, t: (p as Partial<Note>).t ?? shot.t }));
              return [...all.filter((n) => !near(n)), ...next];
            })
          }
          editing={editing}
          setEditing={setEditing}
          newPin={(p) => ({ ...p, t: shot.t })}
          fit="width"
          dim={shot.busy}
          chip={false}
        />
      ) : (
        <div className="skeleton mx-auto aspect-video w-full max-w-[960px] rounded-panel" />
      )}

      <div className="mx-auto mt-3 flex max-w-[960px] items-end gap-3">
        <Slider className="flex-1" label="Moment" value={moment} min={start} max={Math.max(start + 0.1, end - 0.1)} step={0.1} onChange={setMoment} format={(v) => `${v.toFixed(1)} s`} />
        <Button size="sm" variant="secondary" disabled={shot.busy || Math.abs(moment - shot.t) < 0.05} onClick={() => void grab(Math.round(moment * 10) / 10)}>
          <ScanSearch size={13} /> Scan this moment
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ results */

/** Before and after, side by side, playing together. */
function Compare({ gen }: { gen: Generation }) {
  const before = useRef<HTMLVideoElement>(null);
  const after = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const source = typeof gen.params?.videoUrl === "string" ? gen.params.videoUrl : null;
  const result = gen.outputs[0]?.url;

  const toggle = () => {
    const videos = [before.current, after.current].filter((v): v is HTMLVideoElement => Boolean(v));
    if (playing) videos.forEach((v) => v.pause());
    else {
      videos.forEach((v) => (v.currentTime = 0));
      void Promise.all(videos.map((v) => v.play().catch(() => {})));
    }
    setPlaying(!playing);
  };

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="line-clamp-1 font-display text-[22px]">{gen.prompt}</h2>
        {result ? (
          <Button size="sm" variant="secondary" onClick={toggle}>
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : "Play both"}
          </Button>
        ) : null}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <figure>
          <div className="overflow-hidden rounded-card bg-black">{source ? <video ref={before} src={source} muted loop playsInline className="aspect-video w-full object-contain" /> : null}</div>
          <figcaption className="label mt-2">Before</figcaption>
        </figure>
        <figure>
          <div className="relative overflow-hidden rounded-card bg-black">
            {result ? (
              <video ref={after} src={result} loop playsInline controls className="aspect-video w-full object-contain" />
            ) : gen.status === "error" ? (
              <div className="grid aspect-video place-items-center p-6 text-center text-[13px] text-tally">{gen.error}</div>
            ) : (
              <div className="grid aspect-video place-items-center">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-paper">
                  <LoaderCircle size={15} className="animate-spin" /> {gen.stage ?? "Queued"} · {Math.round((gen.progress ?? 0) * 100)}%
                </p>
              </div>
            )}
          </div>
          <figcaption className="label mt-2">After</figcaption>
        </figure>
      </div>
    </section>
  );
}

function Empty() {
  return (
    <div className="surface grid min-h-[420px] place-items-center rounded-panel p-10 text-center">
      <div className="max-w-[48ch]">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-white/[0.05] text-tool-recast">
          <Film size={24} />
        </span>
        <h2 className="mt-5 font-display text-[26px]">Same moves, exact changes</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-fog">Drop a clip on the left. Crackio finds everything in it; hover a thing, click it, and say what it should become. Attach an image when words aren&rsquo;t enough.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="label shrink-0">{title}</h2>
        {hint ? <span className="truncate text-right text-[11.5px] leading-snug text-haze">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
