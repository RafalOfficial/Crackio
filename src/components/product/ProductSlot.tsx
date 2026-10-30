"use client";

/* eslint-disable @next/next/no-img-element */
import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Pencil, Plus, ScanSearch, X } from "lucide-react";
import { SAMPLES, type SampleId } from "@/lib/product/previews";
import type { ProductRead } from "@/lib/product/vocab";
import { cn } from "@/lib/cn";

export type ProductPhoto = { url: string; width: number; height: number; name: string; sample?: SampleId };
export type ReadState = { key: string; status: "reading" | "done" | "failed"; read?: ProductRead; error?: string };

/** Front photo first, then up to two more angles of the same product. */
export const MAX_PHOTOS = 3;

async function uploadFile(file: File): Promise<ProductPhoto> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const data = (await res.json()) as { items?: { url: string; width: number; height: number }[]; error?: string };
  if (!res.ok || !data.items?.[0]) throw new Error(data.error ?? "Upload failed");
  return { ...data.items[0], name: file.name };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The product: its photos, and what Crackio understood it to be and how it's used. The reading
 * steers every shot, so it's shown, and a wrong one can be corrected in your own words.
 */
export function ProductSlot({
  photos,
  onPhotos,
  read,
  identity,
  onIdentity,
  onError,
}: {
  photos: ProductPhoto[];
  onPhotos: (next: ProductPhoto[]) => void;
  read: ReadState | null;
  /** Your own words for what it is, when Crackio got it wrong. */
  identity: string | null;
  onIdentity: (text: string | null) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"front" | "angle" | null>(null);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState<"front" | "angle">("front");

  async function take(files: File[], slot: "front" | "angle") {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setBusy(slot);
    try {
      const added = await Promise.all(images.slice(0, MAX_PHOTOS).map(uploadFile));
      // A new front photo is a new product; more angles join the one you have.
      onPhotos(slot === "front" ? added.slice(0, MAX_PHOTOS) : [...photos, ...added].slice(0, MAX_PHOTOS));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const pick = (slot: "front" | "angle") => {
    setAdding(slot);
    input.current?.click();
  };

  const front = photos[0];
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      multiple
      hidden
      onChange={(e) => {
        void take(Array.from(e.target.files ?? []), adding);
        e.target.value = "";
      }}
    />
  );

  if (!front) {
    return (
      <div>
        <button
          type="button"
          onClick={() => pick("front")}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void take(Array.from(e.dataTransfer.files), "front");
          }}
          className={cn(
            "press group flex h-[138px] w-full flex-col items-center justify-center gap-2 rounded-[16px] bg-white/[0.02] text-center transition-shadow",
            over ? "shadow-[inset_0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04]",
          )}
        >
          <span className="grid size-10 place-items-center rounded-[12px] bg-white/[0.06] text-fog transition-colors group-hover:text-paper">
            {busy ? <LoaderCircle size={18} className="animate-spin" /> : <ImagePlus size={18} />}
          </span>
          <span className="text-[14px] font-semibold text-paper">Drop a photo of anything you sell</span>
          <span className="px-4 text-[12px] leading-snug text-haze">Food, drinks, beauty, fashion, tech, home, pets… any background works.</span>
        </button>
        <p className="mb-1.5 mt-3 text-[12px] text-haze">Or try one of these</p>
        <div className="grid grid-cols-6 gap-1.5">
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.label}
              onClick={() => onPhotos([{ url: s.url, width: s.width, height: s.height, name: s.label, sample: s.id as SampleId }])}
              className="press group flex min-w-0 flex-col items-center gap-1 rounded-[12px] px-0.5 py-1 text-fog hover:bg-white/[0.05] hover:text-paper"
            >
              <span className="block aspect-square w-full overflow-hidden rounded-[10px] bg-[#e6e6e8]">
                <img src={s.thumb} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.08]" />
              </span>
              <span className="w-full truncate text-center text-[10px] font-semibold leading-tight tracking-[-0.01em]">{s.label}</span>
            </button>
          ))}
        </div>
        {fileInput}
      </div>
    );
  }

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
        void take(Array.from(e.dataTransfer.files), photos.length < MAX_PHOTOS ? "angle" : "front");
      }}
      className={cn("rounded-[16px] bg-white/[0.02] p-2 transition-shadow", over ? "shadow-[inset_0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)]")}
    >
      <div className="flex gap-3">
        <div className="group relative size-[112px] shrink-0 overflow-hidden rounded-[12px] bg-[#e4e4e6]">
          <img src={front.url} alt={front.name} className="size-full object-contain" />
          <button
            type="button"
            onClick={() => pick("front")}
            className="absolute inset-x-1.5 bottom-1.5 h-7 rounded-[8px] bg-black/60 text-[11.5px] font-semibold text-white opacity-0 transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100"
          >
            {busy === "front" ? <LoaderCircle size={13} className="mx-auto animate-spin" /> : "Replace"}
          </button>
          <button
            type="button"
            onClick={() => onPhotos([])}
            className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white hover:bg-black/80"
            aria-label="Remove the product"
          >
            <X size={12} />
          </button>
        </div>
        <div className="min-w-0 flex-1 py-0.5">
          <Reading read={read} identity={identity} onIdentity={onIdentity} />
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {photos.slice(1).map((p, i) => (
          <span key={p.url} className="group relative size-10 shrink-0 overflow-hidden rounded-[9px] bg-[#e4e4e6]">
            <img src={p.url} alt={p.name} className="size-full object-contain" />
            <button
              type="button"
              onClick={() => onPhotos(photos.filter((_, k) => k !== i + 1))}
              className="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove this angle"
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {photos.length < MAX_PHOTOS ? (
          <button
            type="button"
            onClick={() => pick("angle")}
            className="press grid size-10 shrink-0 place-items-center rounded-[9px] border border-dashed border-line-strong text-haze hover:border-haze hover:bg-white/[0.04] hover:text-paper"
            aria-label="Add another angle of the product"
            title="Add another angle (the back, the label, a detail)"
          >
            {busy === "angle" ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        ) : null}
        <span className="min-w-0 pl-1 text-[11.5px] leading-snug text-haze">
          {photos.length > 1 ? `${photos.length} angles: the label and shape stay truer` : "Add the back or a detail: more angles keep it truer"}
        </span>
      </div>
      {fileInput}
    </div>
  );
}

/** What Crackio understood the product to be, with a way to say otherwise. */
function Reading({ read, identity, onIdentity }: { read: ReadState | null; identity: string | null; onIdentity: (text: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const r = read?.status === "done" ? read.read : undefined;

  const startEditing = () => {
    setDraft(identity ?? (r ? `${capital(r.name)}. ${r.use}` : ""));
    setEditing(true);
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onIdentity(draft.trim() || null);
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          rows={3}
          placeholder="What is it, and how is it used? (any language)"
          className="w-full flex-1 resize-none rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-[12.5px] leading-snug outline-none shadow-[inset_0_0_0_1px_var(--color-line-strong)] placeholder:text-haze"
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              onIdentity(draft.trim() || null);
              setEditing(false);
            }}
            className="press h-7 rounded-full bg-paper px-3 text-[11.5px] font-bold text-[#16131b]"
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="h-7 rounded-full px-2.5 text-[11.5px] font-semibold text-fog hover:text-paper">
            Cancel
          </button>
          {identity ? (
            <button
              type="button"
              onClick={() => {
                onIdentity(null);
                setEditing(false);
              }}
              className="ml-auto h-7 px-1 text-[11.5px] font-semibold text-haze hover:text-paper"
            >
              Use Crackio&rsquo;s
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (identity) {
    return (
      <div>
        <span className="inline-flex items-center gap-1 rounded-full bg-tool-product/15 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-tool-product">Your words</span>
        <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-snug text-paper">{identity}</p>
        <EditLink onClick={startEditing}>Edit</EditLink>
      </div>
    );
  }

  if (!read || read.status === "reading") {
    return (
      <div>
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-fog">
          <ScanSearch size={13} className="text-tool-product" /> Reading your product…
        </p>
        <div className="mt-2 space-y-1.5">
          <div className="skeleton h-3 w-[86%] rounded-full" />
          <div className="skeleton h-3 w-[64%] rounded-full" />
          <div className="skeleton h-3 w-[74%] rounded-full" />
        </div>
      </div>
    );
  }

  if (!r) {
    return (
      <div>
        <p className="text-[12.5px] font-semibold text-paper">Tell Crackio what it is</p>
        <p className="mt-0.5 text-[12px] leading-snug text-haze">{read.error ?? "It couldn't read this one by itself."}</p>
        <EditLink onClick={startEditing}>Describe it</EditLink>
      </div>
    );
  }

  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate rounded-full bg-tool-product/15 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-tool-product">{r.kind || "Product"}</span>
        {r.brand ? <span className="truncate text-[12px] font-semibold text-fog">{r.brand}</span> : null}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-paper" title={r.use}>
        {r.use}
      </p>
      <EditLink onClick={startEditing}>Not right? Say what it is</EditLink>
    </div>
  );
}

function EditLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-haze hover:text-paper">
      <Pencil size={11} /> {children}
    </button>
  );
}
