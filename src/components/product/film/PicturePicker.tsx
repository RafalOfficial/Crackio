"use client";

/* eslint-disable @next/next/no-img-element */
import { useRef, useState } from "react";
import { Camera, ImagePlus, LoaderCircle } from "lucide-react";
import { previewUrl } from "@/lib/media-url";
import { FILM_STILLS } from "@/lib/product/film-previews";
import type { StudioPicture } from "@/lib/product/film";
import { cn } from "@/lib/cn";

/** A picture a video can start from: one of yours, an upload, or a sample. */
export type FilmPicture = { url: string; width: number; height: number; idea: string; from?: string; productUrl?: string; people?: StudioPicture["people"]; sample?: string };

async function uploadFile(file: File): Promise<FilmPicture> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string; width: number; height: number }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
  return { ...data.items[0], idea: file.name.replace(/\.[a-z0-9]+$/i, "") };
}

const H = 112;

/**
 * The pictures a video can start from: your newest Product Studio pictures first, then any picture
 * you drop in, then Crackio's samples. Campaign takes several, numbered in the order you pick them.
 */
export function PicturePicker({
  mine,
  selected,
  multi,
  onToggle,
  onError,
  onShoot,
}: {
  /** Your newest Product Studio pictures; null while loading. */
  mine: StudioPicture[] | null;
  selected: FilmPicture[];
  /** Up to this many pictures (Campaign); 1 picks one. */
  multi: number;
  onToggle: (p: FilmPicture) => void;
  onError: (message: string) => void;
  /** Go make one in Image mode. */
  onShoot: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<FilmPicture[]>([]);
  const [over, setOver] = useState(false);

  async function take(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setBusy(true);
    try {
      const added = await Promise.all(images.slice(0, 6).map(uploadFile));
      setUploads((u) => [...added, ...u].slice(0, 12));
      for (const p of added.slice(0, multi)) onToggle(p);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ours: FilmPicture[] = (mine ?? []).map((p) => ({ url: p.url, width: p.width, height: p.height, idea: p.idea, from: p.from, productUrl: p.productUrl, people: p.people }));
  const samples: FilmPicture[] = FILM_STILLS.map((s) => ({
    url: s.url,
    width: s.ratio >= 1 ? 1920 : Math.round(1920 * s.ratio),
    height: s.ratio >= 1 ? Math.round(1920 / s.ratio) : 1920,
    idea: s.idea,
    productUrl: `/assets/product/samples/${s.product}.webp`,
    people: s.id.startsWith("ugc-") || s.id.startsWith("life-") ? "person" : s.id.startsWith("demo-") ? "hands" : "none",
    sample: s.id,
  }));
  const order = (p: FilmPicture) => selected.findIndex((s) => s.url === p.url);

  const tile = (p: FilmPicture, thumb: string, key: string) => {
    const at = order(p);
    const ratio = Math.min(1.9, Math.max(0.5, p.width / p.height));
    return (
      <button
        key={key}
        type="button"
        onClick={() => onToggle(p)}
        title={p.idea}
        aria-pressed={at >= 0}
        className={cn(
          "press group relative shrink-0 overflow-hidden rounded-[12px] bg-apple-2",
          at >= 0 ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line)] hover:shadow-[0_0_0_1px_var(--color-line-strong)]",
        )}
        style={{ height: H, width: Math.round(H * ratio) }}
      >
        <img src={thumb} alt="" loading="lazy" className="size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.05]" />
        {at >= 0 && multi > 1 ? (
          <span className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-spike text-[11px] font-bold text-spike-ink">{at + 1}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(Array.from(e.dataTransfer.files));
      }}
      className={cn("rounded-[16px] transition-shadow", over && "shadow-[0_0_0_2px_var(--color-spike)]")}
    >
      <div className="scrollbar-none strip-fade -mx-1 flex gap-2 overflow-x-auto px-1 py-1 pr-8">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="press grid shrink-0 place-items-center rounded-[12px] border border-dashed border-line-strong text-haze hover:border-haze hover:bg-white/[0.04] hover:text-paper"
          style={{ height: H, width: 72 }}
          aria-label="Use another picture"
          title="Drop or pick any picture"
        >
          <span className="flex flex-col items-center gap-1.5 text-[10.5px] font-semibold">
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            Upload
          </span>
        </button>
        {mine === null ? [0, 1, 2].map((i) => <div key={i} className="skeleton shrink-0 rounded-[12px]" style={{ height: H, width: Math.round(H * 0.6) }} />) : null}
        {uploads.map((p) => tile(p, p.url, `u:${p.url}`))}
        {ours.map((p) => tile(p, previewUrl(p.url, 320), `m:${p.url}`))}
        {mine !== null ? (
          <>
            <span className="mx-1 w-px shrink-0 self-stretch bg-line" aria-hidden />
            <span className="flex shrink-0 items-center text-[10.5px] font-bold uppercase tracking-[0.08em] text-haze [writing-mode:vertical-rl] rotate-180">Samples</span>
            {samples.map((p) => tile(p, FILM_STILLS.find((s) => s.id === p.sample)!.thumb, `s:${p.sample}`))}
          </>
        ) : null}
      </div>
      {mine && !mine.length ? (
        <div className="mt-2 flex items-center gap-3 rounded-[12px] bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog">
            <Camera size={16} />
          </span>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-haze">Your newest Product Studio pictures show up here. Shoot one in Image mode, drop any picture, or start from a sample.</p>
          <button type="button" onClick={onShoot} className="press shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 text-[12px] font-semibold text-paper hover:bg-white/[0.12]">
            Shoot one
          </button>
        </div>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple={multi > 1}
        hidden
        onChange={(e) => {
          void take(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}
