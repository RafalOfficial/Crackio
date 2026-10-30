"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Film, LoaderCircle, TriangleAlert, Upload, X } from "lucide-react";
import type { Tool } from "@/lib/tools";
import { useGenerations } from "@/lib/hooks/use-generations";
import { useModels } from "@/lib/hooks/use-models";
import { ToolTile } from "@/components/ui/ToolTile";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RecDot } from "@/components/ui/Viewfinder";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { CLIP_TARGETS, VIDEO_UPSCALERS, upscaledSize } from "@/lib/local/upscalers";
import { ControlSection, nearestAspect } from "./EditToolShell";
import { cn } from "@/lib/cn";
import { demoWords } from "@/lib/demo/config";

type Clip = { url: string; name: string; duration: number; width: number; height: number };

const TIER_STYLE = {
  "Best detail": "bg-spike/15 text-spike",
  Balanced: "bg-chroma/15 text-chroma",
  Fast: "bg-white/[0.07] text-paper",
  Fastest: "bg-white/[0.07] text-fog",
} as const;

/** A clip's length and size, read in the browser before it uploads. */
function readClip(file: File) {
  return new Promise<{ duration: number; width: number; height: number }>((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ duration: v.duration || 0, width: v.videoWidth || 1280, height: v.videoHeight || 720 });
    v.onerror = () => resolve({ duration: 0, width: 1280, height: 720 });
    v.src = URL.createObjectURL(file);
  });
}

/**
 * Upscale's Video section: a clip to 1080p, 2K or 4K on your own GPU, through ComfyUI. The upscalers are listed best first,
 * with what each is like and the memory it needs; ones none of your machines has yet point to the Local page.
 */
export function VideoUpscale({ tool, modeSwitch }: { tool: Tool; modeSwitch: ReactNode }) {
  const { items, submit, cancel } = useGenerations();
  const { models } = useModels();
  const [clip, setClip] = useState<Clip | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("2160p");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [before, setBefore] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Each upscaler, and whether one of your machines has it.
  const rows = VIDEO_UPSCALERS.map((u) => ({ ...u, model: models.find((m) => m.id === u.id) }));
  const chosen = rows.find((r) => r.id === picked && r.model?.available) ?? rows.find((r) => r.model?.available) ?? null;
  const height = CLIP_TARGETS.find((t) => t.value === target)?.height ?? 2160;
  const size = clip ? upscaledSize(clip.width, clip.height, height) : null;

  const takes = useMemo(() => (clip ? items.filter((g) => g.tool === tool.slug && g.params?.videoUrl === clip.url) : []), [items, clip, tool.slug]);
  const live = takes.filter((g) => g.status === "queued" || g.status === "running");
  const shown = takes.find((g) => g.id === viewing) ?? takes.find((g) => g.status === "done") ?? null;
  const failed = takes[0]?.status === "error" ? takes[0] : null;
  const result = shown?.outputs[0]?.url ?? null;

  async function upload(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError("Pick a video file (MP4, MOV or WebM).");
    setError(null);
    setUploading(true);
    try {
      const meta = await readClip(file);
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = (await res.json()) as { items?: { url: string }[]; error?: string };
      if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed.");
      setClip({ url: data.items[0].url, name: file.name, ...meta });
      setViewing(null);
      setBefore(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function run() {
    if (!clip || !chosen || !size || busy) return;
    setBusy(true);
    setError(null);
    try {
      const label = CLIP_TARGETS.find((t) => t.value === target)?.label ?? target;
      await submit({
        tool: tool.slug,
        prompt: `Upscale to ${label} · ${size.width}×${size.height}`,
        aspect: nearestAspect(clip.width, clip.height),
        count: 1,
        model: chosen.id,
        refine: false,
        references: [],
        params: { kind: "upscale", videoUrl: clip.url, options: { resolution: target } },
      });
      setViewing(null);
      setBefore(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <header className="flex items-start gap-3">
        <ToolTile icon={tool.icon} hue={tool.hue} size={36} className="mt-1" />
        <div className="min-w-0">
          <h1 className="font-display text-[30px] sm:text-[34px]">{tool.name}</h1>
          <p className="mt-1 max-w-[70ch] text-[15px] leading-relaxed text-haze">{tool.description}</p>
        </div>
      </header>

      <div className="mt-7 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
        <Panel className="flex flex-col">
          <PanelHeader title="Settings" />
          <div className="space-y-4 p-3">
            {modeSwitch}

            <ControlSection title="Upscaler" hint={demoWords("Best first · runs on your own GPU")}>
              <div className="space-y-1.5" role="radiogroup" aria-label="Upscaler">
                {rows.map((r) => {
                  const on = chosen?.id === r.id;
                  const have = Boolean(r.model?.available);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!have}
                      onClick={() => setPicked(r.id)}
                      className={cn(
                        "press squircle w-full rounded-[14px] px-3 py-2.5 text-left disabled:cursor-default",
                        on ? "bg-white/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn("text-[14px] font-semibold", on ? "text-paper" : have ? "text-fog" : "text-haze")}>{r.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TIER_STYLE[r.tier])}>{r.tier}</span>
                      </span>
                      <span className="mt-1 block text-[12px] leading-relaxed text-haze">{r.note}</span>
                      <span className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="text-haze">About {r.needGb} GB of GPU memory</span>
                        {have ? null : (
                          <Link href="/local" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 font-semibold text-fog hover:text-paper">
                            Install on Local <ArrowUpRight size={11} />
                          </Link>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ControlSection>

            <ControlSection title="Clip" hint={clip ? `${clip.width}×${clip.height} · ${clip.duration.toFixed(1)} s` : "MP4, MOV or WebM"}>
              {clip ? (
                <div className="flex items-center justify-between gap-2 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[12.5px] text-fog">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Film size={14} className="shrink-0" /> <span className="truncate">{clip.name}</span>
                  </span>
                  <button type="button" onClick={() => setClip(null)} className="text-haze hover:text-paper" aria-label="Remove the clip">
                    <X size={14} />
                  </button>
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
                    "press flex h-28 w-full flex-col items-center justify-center gap-2 rounded-[14px] bg-white/[0.03] text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper",
                    dragging && "shadow-[inset_0_0_0_2px_var(--color-spike)]",
                  )}
                >
                  {uploading ? <LoaderCircle size={20} className="animate-spin" /> : <Upload size={20} />}
                  <span className="text-[13px] font-semibold">{uploading ? "Uploading…" : "Drop a clip or browse"}</span>
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
            </ControlSection>

            <ControlSection title="Size" hint={size ? `${size.width}×${size.height}` : undefined}>
              <div className="grid grid-cols-3 gap-1.5">
                {CLIP_TARGETS.map((t) => {
                  const on = target === t.value;
                  const already = clip ? Math.min(clip.width, clip.height) >= t.height : false;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setTarget(t.value)}
                      aria-pressed={on}
                      disabled={already}
                      className={cn(
                        "press squircle flex flex-col rounded-[14px] px-3 py-2.5 text-left disabled:opacity-40",
                        on ? "bg-white/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03]",
                      )}
                    >
                      <span className={cn("font-display text-[20px]", on && "text-spike")}>{t.label}</span>
                      <span className="text-[11.5px] text-haze">{already ? "Already this big" : `${t.height}p`}</span>
                    </button>
                  );
                })}
              </div>
            </ControlSection>
          </div>

          <div className="sticky bottom-0 z-10 mt-auto space-y-2 rounded-b-panel border-t border-line bg-flat/90 p-3 backdrop-blur-xl">
            {failed ? (
              <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  {failed.error} {failed.stage ? <span className="text-paper">{failed.stage}</span> : null}
                </span>
              </p>
            ) : null}
            {error ? <p className="text-[12.5px] text-tally">{error}</p> : null}
            {!chosen ? (
              <p className="text-[12.5px] leading-relaxed text-haze">
                None of your machines has a video upscaler yet:{" "}
                <Link href="/local" className="font-semibold text-fog underline-offset-2 hover:underline">
                  install one on the Local page
                </Link>
                .
              </p>
            ) : (
              <p className="text-[12.5px] text-haze">{demoWords("Free on your own GPU")} · {chosen.name}</p>
            )}
            <button
              onClick={() => void run()}
              disabled={!clip || !chosen || busy || uploading}
              className="lip squircle flex h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.05em] text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-haze disabled:shadow-none"
            >
              {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
              {clip ? `Upscale to ${CLIP_TARGETS.find((t) => t.value === target)?.label}` : "Add a clip first"}
            </button>
          </div>
        </Panel>

        <Panel className="flex min-h-[480px] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-190px)] lg:min-h-[560px]">
          <PanelHeader title={<span className="label text-fog">Output</span>}>
            {live.length ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-fog">
                <RecDot /> {live[0].stage ?? "Upscaling"} <span className="tabular text-haze">{Math.round((live[0].progress ?? 0) * 100)}%</span>
              </span>
            ) : result ? (
              <div className="flex items-center gap-1 rounded-full bg-white/[0.05] p-0.5 text-[12px] font-semibold">
                {(["Before", "After"] as const).map((v) => {
                  const on = (v === "Before") === before;
                  return (
                    <button key={v} type="button" onClick={() => setBefore(v === "Before")} className={cn("press rounded-full px-3 py-1", on ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
                      {v}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </PanelHeader>
          <div className="relative grid h-[62vh] min-h-[320px] place-items-center p-4 lg:h-auto lg:min-h-0 lg:flex-1">
            {clip ? (
              <video key={before || !result ? clip.url : result} src={before || !result ? clip.url : result} controls loop playsInline className="max-h-full max-w-full rounded-[14px] bg-black" />
            ) : (
              <p className="max-w-[44ch] text-center text-[13.5px] leading-relaxed text-haze">
                {demoWords("Drop a clip on the left. Crackio upscales it on your own GPU through ComfyUI, keeping its sound and frame rate.")}
              </p>
            )}
            {clip && live.length ? (
              <GeneratingField
                className="inset-4 rounded-[16px]"
                stage={live[0].stage}
                progress={live[0].progress}
                prompt={live[0].prompt}
                since={live[0].createdAt}
                onCancel={() => cancel(live[0].id)}
              />
            ) : null}
          </div>
          {takes.length ? (
            <div className="scrollbar-none flex gap-2 overflow-x-auto border-t border-line p-3">
              {takes.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    setViewing(g.id);
                    setBefore(false);
                  }}
                  disabled={g.status !== "done"}
                  title={g.status === "error" ? g.error : g.modelName}
                  className={cn(
                    "press squircle shrink-0 rounded-[11px] px-3 py-2 text-left text-[12px]",
                    g.id === shown?.id ? "bg-white/[0.07] shadow-[0_0_0_2px_var(--color-spike)]" : "bg-white/[0.03] shadow-[0_0_0_1px_var(--color-line)]",
                  )}
                >
                  <span className="block font-semibold text-paper">{g.modelName?.replace(/ \(your GPU\)$/, "") ?? "Upscale"}</span>
                  <span className="block text-haze">{g.status === "done" ? g.prompt.replace(/^Upscale to /, "") : g.status === "error" ? "Failed" : `${Math.round((g.progress ?? 0) * 100)}%`}</span>
                </button>
              ))}
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
