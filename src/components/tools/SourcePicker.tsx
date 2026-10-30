"use client";

import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { useGenerations } from "@/lib/hooks/use-generations";
import { EXAMPLES } from "@/lib/examples";
import { previewSrcSet, previewUrl } from "@/lib/media-url";
import { cn } from "@/lib/cn";

export type SourceImage = { url: string; width: number; height: number; name: string };

/** Pick the image a tool works on: upload, drop, paste, or reuse something already made. */
export function SourcePicker({ onPick, hint }: { onPick: (src: SourceImage) => void; hint: string }) {
  const { items } = useGenerations();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recent = items
    .filter((g) => g.status === "done")
    .flatMap((g) => g.outputs.filter((o) => o.kind === "image").map((o) => ({ ...o, prompt: g.prompt })))
    .slice(0, 12);

  async function upload(file?: File) {
    if (!file || !file.type.startsWith("image/")) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = (await res.json()) as { items?: { url: string; width: number; height: number }[]; error?: string };
      if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
      onPick({ ...data.items[0], name: file.name });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files[0]);
        }}
        onPaste={(e) => void upload(e.clipboardData.files[0])}
        className={cn(
          "grid min-h-[280px] flex-1 place-items-center rounded-[14px] border border-dashed p-8 text-center transition-colors",
          dragging ? "border-spike bg-spike/5" : "border-line-strong hover:border-haze",
        )}
      >
        <span>
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-apple-2 text-paper">
            {busy ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
          </span>
          <span className="mt-4 block text-[17px] font-semibold">Drop an image here</span>
          <span className="mt-1.5 block text-[14px] text-fog">{hint}</span>
          {error ? <span className="mt-2 block text-[13px] text-tally">{error}</span> : null}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div>
        <p className="text-[13px] font-semibold">{recent.length ? "Or use something you made" : "Or try one of these"}</p>
        <div className="scrollbar-none strip-fade -mx-1 mt-1 flex gap-2 overflow-x-auto p-1 pr-9">
          {(recent.length
            ? recent.map((o) => ({ url: o.url, width: o.width ?? 1024, height: o.height ?? 1024, name: o.prompt.slice(0, 40) || "Generation" }))
            : EXAMPLES.slice(0, 8).map((e) => ({ url: e.src, width: e.width, height: e.height, name: e.id }))
          ).map((s) => (
            <button
              key={s.url}
              onClick={() => onPick(s)}
              className="press squircle h-20 shrink-0 overflow-hidden rounded-[12px] bg-apple shadow-[0_0_0_1px_var(--color-line)] hover:brightness-110 hover:shadow-[0_0_0_1px_var(--color-line-strong)]"
              style={{ aspectRatio: `${s.width} / ${s.height}` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl(s.url, 320)} srcSet={previewSrcSet(s.url, [320, 480])} sizes="160px" alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
