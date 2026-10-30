"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, ImagePlus, LoaderCircle, Package, PawPrint, Plus, RefreshCw, Sparkles, Trash, TriangleAlert, UserRound, X, type LucideIcon } from "lucide-react";
import { ToolTile } from "@/components/ui/ToolTile";
import { Button } from "@/components/ui/Button";
import { useCast } from "@/lib/hooks/use-cast";
import { useUploads } from "@/lib/hooks/use-uploads";
import { useModels } from "@/lib/hooks/use-models";
import { askForModel, useModelChoice } from "@/lib/hooks/use-model-choice";
import { ModelPicker } from "@/components/models/ModelPicker";
import { GeneratingField } from "@/components/ui/GeneratingField";
import { readSubject } from "@/lib/director/vision";
import { copyText } from "@/lib/clipboard";
import { toolBySlug } from "@/lib/tools";
import {
  CAST_KINDS,
  CAST_PREFER,
  LEGACY_SHEET_VIEWS,
  VIEW_LABELS,
  VIEW_ORDER,
  castFits,
  formatHeight,
  isLong,
  parseHeight,
  tidyViews,
  toHandle,
  type CastKind,
  type Character,
  type SheetView,
} from "@/lib/cast/types";
import { cn } from "@/lib/cn";

const tool = toolBySlug("cast")!;

const KIND_ICON: Record<CastKind, LucideIcon> = { person: UserRound, pet: PawPrint, character: Sparkles, object: Package };

/** What to show and say per kind while adding one. */
const KIND_COPY: Record<CastKind, { photos: string; describe: string; name: string; face: string; plural: string }> = {
  person: {
    photos: "A clear face is enough. Add a full-length photo too, so the outfit and build carry over.",
    describe: "A woman in her thirties with a short silver bob, freckles and a sage-green bomber jacket",
    name: "Mia",
    face: "a face close-up",
    plural: "People",
  },
  pet: {
    photos: "The whole animal in good light. A second photo from the side helps.",
    describe: "A fluffy ginger Maine Coon cat with a white chest and amber eyes",
    name: "Biscuit",
    face: "a face close-up",
    plural: "Animals",
  },
  character: {
    photos: "The design on a plain background: a front view, plus a side or back view if you have one.",
    describe: "A small round robot mascot with a glossy orange shell, one blue visor eye and stubby arms",
    name: "Bolt",
    face: "a face close-up",
    plural: "Characters",
  },
  object: {
    photos: "The whole thing on a plain background. Side or back photos keep those details too.",
    describe: "A matte black thermos with a bamboo lid and a small engraved fox logo",
    name: "Thermos",
    face: "a clean hero shot",
    plural: "Objects",
  },
};


/** Cast: make a person, animal, character or object once, from photos or words, and call them into any shot with @name. */
export function CastStudio() {
  const { items, loaded } = useCast();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CastKind | "all">("all");
  const viewing = items.find((c) => c.id === openId) ?? null;
  const kinds = CAST_KINDS.filter((k) => items.some((c) => c.kind === k.id));
  const shown = filter === "all" ? items : items.filter((c) => c.kind === filter);

  return (
    <div className="mx-auto max-w-[1360px] px-4 pb-24 pt-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex items-start gap-4">
          <ToolTile icon={tool.icon} hue={tool.hue} size={44} />
          <div>
            <h1 className="font-display text-[34px] sm:text-[40px]">Cast</h1>
            <p className="mt-1 max-w-[64ch] text-[14.5px] leading-relaxed text-fog">
              Add a person, an animal, a character or an object once, from photos or a description. Type <Mention>@name</Mention> in any prompt, picture or clip, and it looks like itself, at its real size.
            </p>
          </div>
        </div>
        {items.length ? (
          <Button variant="primary" size="lg" onClick={() => setCreating(true)}>
            <Plus size={17} strokeWidth={2.6} /> Add to cast
          </Button>
        ) : null}
      </header>

      {kinds.length > 1 ? (
        <div className="mt-7 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Show">
          {[{ id: "all" as const, label: "All" }, ...kinds.map((k) => ({ id: k.id, label: KIND_COPY[k.id].plural }))].map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={filter === k.id}
              onClick={() => setFilter(k.id)}
              className={cn("press h-8 rounded-full px-3.5 text-[12.5px] font-semibold", filter === k.id ? "bg-paper text-[#16131b]" : "bg-white/[0.05] text-fog hover:text-paper")}
            >
              {k.label}
              <span className={cn("ml-1.5 tabular", filter === k.id ? "text-[#16131b]/55" : "text-haze")}>{k.id === "all" ? items.length : items.filter((c) => c.kind === k.id).length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {!loaded ? (
        <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton aspect-[4/5] rounded-card" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <ul className={cn("grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", kinds.length > 1 ? "mt-4" : "mt-8")}>
          {shown.map((c) => (
            <li key={c.id}>
              <CharacterCard c={c} onOpen={() => setOpenId(c.id)} />
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="press group flex aspect-[4/5] w-full flex-col items-center justify-center gap-3 rounded-card text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.03] hover:text-paper"
            >
              <span className="grid size-12 place-items-center rounded-full bg-white/[0.06] transition-colors group-hover:bg-spike group-hover:text-spike-ink">
                <Plus size={20} />
              </span>
              <span className="text-[14px] font-semibold">Add to cast</span>
            </button>
          </li>
        </ul>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} label="Add to cast" wide={false}>
        <NewMember
          onDone={(c) => {
            setCreating(false);
            setOpenId(c.id);
          }}
          onCancel={() => setCreating(false)}
        />
      </Modal>
      <Modal open={Boolean(viewing)} onClose={() => setOpenId(null)} label={viewing?.name ?? "Cast member"}>
        {viewing ? <CharacterDetail c={viewing} onClose={() => setOpenId(null)} /> : null}
      </Modal>
    </div>
  );
}

function Mention({ children }: { children: ReactNode }) {
  return <span className="rounded-[6px] bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.92em] text-paper">{children}</span>;
}

/* ------------------------------------------------------------------ empty state */

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="mt-10 grid items-center gap-10 lg:grid-cols-[1.25fr_1fr]">
      <figure className="relative overflow-hidden rounded-panel bg-apple shadow-[inset_0_0_0_1px_var(--color-line)]">
        <Image src={tool.media} alt="A reference sheet: the same woman from several sides" width={1200} height={900} className="h-auto w-full" priority />
        <figcaption className="absolute inset-x-0 bottom-0 flex flex-wrap gap-2 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12">
          {["Front", "Side", "Back", "Face"].map((v) => (
            <span key={v} className="rounded-full bg-black/55 px-2.5 py-1 text-[11.5px] font-semibold text-paper/90 ring-1 ring-white/10">
              {v}
            </span>
          ))}
        </figcaption>
      </figure>
      <div>
        <h2 className="font-display text-[28px]">Your recurring cast</h2>
        <ol className="mt-5 space-y-4">
          {[
            ["Add who or what", "A person, a pet, a mascot, or an object like a bag, a bottle or a car. From one to four photos, or a description."],
            ["Crackio draws their sheet", "Front, side and back on a plain backdrop, plus a face close-up (or a hero shot), and learns their real size."],
            ["Call them by name", "Type @name in Home, Image or Video. Their sheet goes along as a reference, so every picture and clip keeps them recognizable and true to scale."],
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-3.5">
              <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.07] text-[13px] font-bold text-paper">{i + 1}</span>
              <span>
                <span className="block text-[15px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[13.5px] leading-relaxed text-fog">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <Button variant="primary" size="lg" className="mt-7" onClick={onCreate}>
          <Plus size={17} strokeWidth={2.6} /> Add your first
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ card */

function CharacterCard({ c, onOpen }: { c: Character; onOpen: () => void }) {
  const cover = c.portrait ?? c.previous?.portrait ?? c.photos[0];
  const Icon = KIND_ICON[c.kind];
  return (
    <button type="button" onClick={onOpen} className="group block w-full text-left">
      <div className="relative aspect-[4/5] overflow-hidden rounded-card bg-apple">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt={c.name}
            className={cn(
              "size-full object-cover transition-[transform,filter] duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.03]",
              !c.portrait && !c.previous?.portrait && "scale-105 blur-md brightness-75",
            )}
          />
        ) : (
          <div className="skeleton absolute inset-0" />
        )}
        {c.status === "building" ? (
          <GeneratingField stage={c.sheet || c.portrait ? "Almost there" : c.photos.length ? "Drawing the sheet" : "Drawing them"} progress={c.progress} backdrop={cover} />
        ) : null}
        <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-paper/90 ring-1 ring-white/10">
          <Icon size={11} />
          {c.height ? formatHeight(c.height) : CAST_KINDS.find((k) => k.id === c.kind)?.label}
        </span>
        {c.status === "error" ? (
          <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-tally">
            <TriangleAlert size={11} /> Needs a rebuild
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-2 px-0.5">
        <span className="truncate text-[15px] font-semibold">{c.name}</span>
        <span className="shrink-0 font-mono text-[12px] text-haze">@{c.handle}</span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ add */

const kindOfRead = (k: string): CastKind => (k === "person" ? "person" : k === "animal" ? "pet" : "object");

function NewMember({ onDone, onCancel }: { onDone: (c: Character) => void; onCancel: () => void }) {
  const { create } = useCast();
  const { models } = useModels();
  const { refs, add, remove, uploading } = useUploads(4);
  const [kind, setKind] = useState<CastKind>("person");
  const [kindPicked, setKindPicked] = useState(false);
  const [from, setFrom] = useState<"photos" | "words">("photos");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [size, setSize] = useState("");
  const [sizeTyped, setSizeTyped] = useState(false);
  // You choose the model (Crackio doesn't pick one): your last pick for this job, else your default, else nothing yet.
  const [model, setModel] = useModelChoice("image", "edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [read, setRead] = useState<{ url: string; noun: string; height: number | null; long: boolean } | "reading" | null>(null);
  // The sides to draw: planned from the photo or the words (only the ones that look different), yours once you change them.
  const [views, setViews] = useState<SheetView[]>(["front", "side", "back"]);
  const [viewsWhy, setViewsWhy] = useState<string | null>(null);
  const [viewLooks, setViewLooks] = useState<Partial<Record<SheetView, string>> | null>(null);
  const [viewsPicked, setViewsPicked] = useState(false);
  const [planning, setPlanning] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const photos = refs.filter((r) => r.status === "ready" && r.url).map((r) => r.url!);
  const copy = KIND_COPY[kind];
  const height = parseHeight(size);
  const ready = name.trim().length > 0 && (from === "photos" ? photos.length > 0 && !uploading : description.trim().length > 8) && (!size.trim() || height !== null);
  const runs = model === "auto" ? null : models.find((m) => m.id === model);

  // The first photo is read by a vision model: what it is (person, animal, object) and how big it really is.
  const first = photos[0] ?? null;
  useEffect(() => {
    if (!first) return;
    let live = true;
    // Deferred a tick: the read's own state changes shouldn't land inside the upload's render.
    const t = setTimeout(() => {
      setRead("reading");
      void readSubject(first).then((r) => {
        if (!live) return;
        setRead(r ? { url: first, noun: r.noun, height: r.height, long: r.kind === "vehicle" || isLong(r.noun) } : null);
        if (!r) return;
        if (!kindPicked) setKind(kindOfRead(r.kind));
        if (!sizeTyped && r.height) setSize(formatHeight(r.height));
      });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // Only a new first photo starts a new reading; picking a kind or typing a size keeps what's read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  // A person, an animal or a character gets every side; a thing is planned once its photo or its words are in.
  const planFrom = kind !== "object" ? kind : from === "photos" ? (first ?? "") : description.trim().length > 8 ? description.trim() : "";
  useEffect(() => {
    if (viewsPicked || !planFrom) return;
    let live = true;
    const t = setTimeout(
      () => {
        setPlanning(true);
        void fetch("/api/cast/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            name: name.trim() || undefined,
            description: from === "words" ? description : undefined,
            notes: notes.trim() || undefined,
            photo: from === "photos" ? (first ?? undefined) : undefined,
          }),
        })
          .then((res) => (res.ok ? (res.json() as Promise<{ views: SheetView[]; why?: string; looks?: Partial<Record<SheetView, string>> }>) : null))
          .then((plan) => {
            if (!live || !plan?.views?.length) return;
            setViews(plan.views);
            setViewsWhy(plan.why ?? null);
            setViewLooks(plan.looks ?? null);
          })
          .catch(() => {})
          .finally(() => live && setPlanning(false));
      },
      kind === "object" && from === "words" ? 900 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
      setPlanning(false);
    };
    // Planned again when what it's planned from changes; the name and notes just ride along.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planFrom, viewsPicked]);

  async function submit() {
    if (!ready || busy) return;
    if (model === "auto") return void askForModel("image");
    setBusy(true);
    setError(null);
    try {
      const c = await create({
        name: name.trim(),
        kind,
        photos: from === "photos" ? photos : [],
        description: from === "words" ? description : undefined,
        notes,
        model,
        ...(height ? { height, heightSet: sizeTyped } : {}),
        // A car or a van from photos: its side view gets a long frame of its own.
        ...(kind === "object" && from === "photos" && read && read !== "reading" && read.long ? { long: true } : {}),
        views,
        ...(viewsWhy ? { viewsWhy } : {}),
        ...(viewLooks ? { viewLooks } : {}),
      });
      onDone(c);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-[24px]">Add to cast</h2>
        <CloseButton onClick={onCancel} />
      </div>

      <div role="radiogroup" aria-label="What is it?" className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CAST_KINDS.map((k) => {
          const Icon = KIND_ICON[k.id];
          const on = kind === k.id;
          return (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setKind(k.id);
                setKindPicked(true);
              }}
              className={cn(
                "press squircle flex flex-col items-start gap-2 rounded-[16px] p-3 text-left transition-colors",
                on ? "bg-paper text-[#16131b]" : "bg-white/[0.04] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.07] hover:text-paper",
              )}
            >
              <span className={cn("grid size-8 place-items-center rounded-full", on ? "bg-spike text-spike-ink" : "bg-white/[0.07]")}>
                <Icon size={16} />
              </span>
              <span>
                <span className="block text-[13.5px] font-bold">{k.label}</span>
                <span className={cn("mt-0.5 block text-[11.5px] leading-snug", on ? "text-[#16131b]/65" : "text-haze")}>{k.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <Segmented
        className="mt-5"
        value={from}
        onChange={setFrom}
        options={[
          { value: "photos", label: "From photos" },
          { value: "words", label: "From a description" },
        ]}
      />

      {from === "photos" ? (
        <div className="mt-4">
          <div
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void add(Array.from(e.dataTransfer.files));
            }}
            className={cn("grid grid-cols-4 gap-2.5 rounded-[18px] p-2.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-shadow", dragging && "shadow-[inset_0_0_0_2px_var(--color-spike)]")}
          >
            {refs.map((r) => (
              <div key={r.id} className="group relative aspect-[4/5] overflow-hidden rounded-[13px] bg-apple">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.preview} alt={r.name} className={cn("size-full object-cover", r.status === "uploading" && "opacity-50")} />
                {r.status === "uploading" ? <LoaderCircle size={18} className="absolute inset-0 m-auto animate-spin text-paper" /> : null}
                {r.status === "error" ? <TriangleAlert size={16} className="absolute inset-0 m-auto text-tally" aria-label={r.error} /> : null}
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-paper opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Remove ${r.name}`}
                >
                  <X size={12} strokeWidth={3} />
                </button>
              </div>
            ))}
            {refs.length < 4 ? (
              <button
                type="button"
                onClick={() => input.current?.click()}
                className={cn(
                  "press flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-[13px] bg-white/[0.03] text-fog hover:bg-white/[0.06] hover:text-paper",
                  !refs.length && "col-span-4 aspect-auto h-[132px]",
                )}
              >
                <ImagePlus size={20} />
                <span className="px-2 text-center text-[12px] font-semibold">{refs.length ? "Add another" : "Add or drop one to four photos"}</span>
              </button>
            ) : null}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {read === "reading" ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-haze">
              <LoaderCircle size={12} className="animate-spin" /> Looking at your photo…
            </p>
          ) : read ? (
            <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fog">
              <Check size={13} className="shrink-0 text-chroma" /> Looks like {read.noun}
              {read.height ? `, about ${formatHeight(read.height)} tall` : ""}.
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-haze">{copy.photos}</p>
          )}
        </div>
      ) : (
        <Field label="What does it look like?" className="mt-4">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder={copy.describe}
            className="field-focus block w-full resize-none rounded-[14px] bg-white/[0.04] px-3.5 py-3 text-[14px] leading-relaxed text-paper outline-none placeholder:text-haze"
          />
        </Field>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_150px]">
        <Field label="Name" hint={name.trim() ? `@${toHandle(name)}` : "You call it with @name"}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={copy.name}
            className="field-focus block h-11 w-full rounded-[14px] bg-white/[0.04] px-3.5 text-[14px] text-paper outline-none placeholder:text-haze"
          />
        </Field>
        <Field label="Real height" hint={sizeTyped || !size ? "Optional" : "Read"}>
          <input
            value={size}
            onChange={(e) => {
              setSize(e.target.value);
              setSizeTyped(true);
            }}
            inputMode="decimal"
            placeholder={kind === "object" ? "30 cm" : kind === "pet" ? "45 cm" : "1.70 m"}
            aria-invalid={Boolean(size.trim()) && height === null}
            className={cn(
              "field-focus block h-11 w-full rounded-[14px] bg-white/[0.04] px-3.5 text-[14px] text-paper outline-none placeholder:text-haze",
              size.trim() && height === null && "shadow-[inset_0_0_0_1px_var(--color-tally)]",
            )}
          />
        </Field>
      </div>
      <Field label="Always keep" hint="Optional" className="mt-4">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={400}
          placeholder={kind === "object" ? "The engraved fox logo on the front" : "Round tortoiseshell glasses, a small scar over the left eyebrow"}
          className="field-focus block h-11 w-full rounded-[14px] bg-white/[0.04] px-3.5 text-[14px] text-paper outline-none placeholder:text-haze"
        />
      </Field>

      {/* The sheet keeps a look from pictures, so only models that take pictures are offered; Auto shows exactly what runs. */}
      <Field label="Model" hint="Draws the sheet and the close-up" className="mt-4">
        <ModelPicker kind="image" task="edit" value={model} onChange={setModel} prefer={CAST_PREFER} fits={castFits} />
      </Field>

      <div className="mt-5 rounded-[14px] bg-white/[0.03] px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-fog">
          <span className="mr-1 font-semibold text-paper">You&rsquo;ll get</span>
          <ViewChips
            value={views}
            onChange={(next) => {
              setViews(next);
              setViewsPicked(true);
            }}
          />
          <span className="ml-1">and {copy.face}</span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-haze">
          {planning ? "Working out which sides look different… " : viewsWhy ? `${viewsWhy} ` : "Only the sides that look different. "}
          Each side is drawn as its own picture, so nothing gets squeezed{runs ? `, by ${runs.name}` : ""}.
        </p>
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        {error ? <p className="mr-auto text-[13px] text-tally">{error}</p> : null}
        <Button variant="primary" size="lg" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={16} />} Create
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function CharacterDetail({ c, onClose }: { c: Character; onClose: () => void }) {
  const { update, rebuild, remove } = useCast();
  const [name, setName] = useState(c.name);
  const [copied, setCopied] = useState(false);
  const views = c.views ?? (c.sheet ? LEGACY_SHEET_VIEWS : ["front", "side", "back"]);
  // A sheet drawn as one picture (from before each side got its own): its views may be squeezed.
  const onePicture = Boolean(c.sheet && !c.viewPictures);
  // Rebuilding happens right in the panel: its details make way for what you can change.
  const [editing, setEditing] = useState(false);
  // The sides for the next rebuild: the sheet's own until you change them.
  const [picked, setPicked] = useState<SheetView[] | null>(null);
  const building = c.status === "building";
  // While it's rebuilt, what it had stays in view.
  const sheet = c.sheet ?? c.previous?.sheet;
  const face = c.portrait ?? c.previous?.portrait ?? c.photos[0];
  const Icon = KIND_ICON[c.kind];
  const sides =
    c.sheetLayout === "rows" && views.includes("side")
      ? `${views.filter((v) => v !== "side").map((v) => VIEW_LABELS[v]).join(" · ")} on top, the whole side below`
      : views.map((v) => VIEW_LABELS[v]).join(" · ");
  const back = () => {
    setEditing(false);
    setPicked(null);
  };

  return (
    <div className="grid max-h-[calc(100dvh-2rem)] overflow-y-auto lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
      {/* The sheet is the show: as large as it fits, the stage around it no bigger than it needs. */}
      <div
        onClick={() => editing && back()}
        className="relative flex min-w-0 flex-col items-center justify-center overflow-hidden bg-[#0c0b10] px-3 pb-3 pt-4 sm:px-5 lg:min-h-[480px]"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_55%_at_50%_46%,rgb(255_255_255/0.075),transparent_75%)]" />
        {sheet ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sheet}
            alt={`${c.name}: ${sides}`}
            className={cn(
              "relative max-h-[min(76dvh,780px)] w-auto max-w-full rounded-[16px] shadow-[0_32px_90px_-28px_rgb(0_0_0/0.95)] transition-opacity duration-500",
              !c.sheet && "opacity-25",
            )}
          />
        ) : (
          <div className="skeleton relative aspect-[3/2] w-[min(100%,640px)] rounded-[16px] opacity-50" />
        )}
        {building && c.status !== "error" ? (
          <GeneratingField stage={!c.portrait && !c.photos.length ? `Drawing ${KIND_COPY[c.kind].face}` : "Drawing the sides"} progress={c.progress} backdrop={sheet} />
        ) : null}
        {c.status === "error" ? (
          <p className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-black/70 px-4 py-2 text-[13px] font-semibold text-paper shadow-[0_0_0_1px_var(--color-line)]">
            <TriangleAlert size={15} className="text-tally" /> The sheet didn&rsquo;t render
          </p>
        ) : null}
        <p className={cn("relative mt-3 text-center text-[11.5px] font-semibold tracking-wide text-haze", (!c.sheet || building) && "invisible")}>{sides}</p>
      </div>

      {/* On a wide screen the panel takes the sheet's height (its own content scrolls), so the dialog hugs the sheet. */}
      <aside className="relative bg-flat lg:shadow-[inset_1px_0_0_var(--color-line)]">
        <div
          className="flex flex-col lg:absolute lg:inset-0"
          onKeyDownCapture={(e) => {
            // Escape steps back out of rebuilding before it closes the member.
            if (!editing || e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            back();
          }}
        >
          <header className="flex items-start gap-3 px-5 pb-2 pt-5">
            {face ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={face} alt="" className="size-12 shrink-0 rounded-[14px] object-cover shadow-[0_0_0_1px_var(--color-line)]" />
            ) : (
              <span className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-white/[0.05] text-haze">
                <Icon size={18} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== c.name && void update(c.id, { name })}
                aria-label="Name"
                className="-ml-1 w-full rounded-[8px] bg-transparent px-1 font-display text-[22px] leading-tight text-paper outline-none hover:bg-white/[0.04] focus:bg-white/[0.06]"
              />
              <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-haze">
                <button
                  type="button"
                  onClick={async () => {
                    if (!(await copyText(`@${c.handle}`))) return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                  className="press inline-flex items-center gap-1 font-mono text-fog hover:text-paper"
                  title="Copy, then type it in any prompt"
                >
                  @{c.handle}
                  {copied ? <Check size={12} className="text-chroma" /> : <Copy size={11} />}
                </button>
                <span aria-hidden>·</span>
                {CAST_KINDS.find((k) => k.id === c.kind)?.label}
              </p>
            </div>
            <CloseButton onClick={onClose} autoFocus />
          </header>

          <div className="scroll-thin px-5 pb-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <AnimatePresence mode="wait" initial={false}>
              {editing ? (
                <motion.div key="rebuild" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="pt-3">
                  {/* The same glassy card the menu had, in place of the details. */}
                  <div className="squircle rounded-[22px] bg-apple-2 p-4 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_40px_-8px_rgb(0_0_0/0.6)]">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-[16px] font-semibold">Rebuild the sheet</h3>
                      <button
                        type="button"
                        onClick={back}
                        autoFocus
                        className="press grid size-8 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper"
                        aria-label="Back to the details"
                        title="Back (Esc)"
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <p className="label mb-2.5 mt-5">Sides</p>
                    <ViewChips large value={picked ?? views} onChange={setPicked} />
                    <p className="mt-2.5 text-[12.5px] leading-relaxed text-haze">Only the sides that look different. Each is drawn as its own picture.</p>
                    <p className="label mb-2 mt-5">Drawn by</p>
                    <ModelPicker kind="image" task="edit" value={c.model ?? "auto"} onChange={(id) => void update(c.id, { model: id === "auto" ? null : id })} variant="chip" placement="top-start" prefer={CAST_PREFER} fits={castFits} />
                    <button
                      type="button"
                      onClick={() => {
                        void rebuild(c.id, picked ?? undefined);
                        back();
                      }}
                      className="press squircle mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-paper text-[14.5px] font-semibold text-[#16131b] hover:bg-white"
                    >
                      <RefreshCw size={15} /> Rebuild the sheet
                    </button>
                    <p className="mt-2.5 text-center text-[12px] text-haze">The sheet you have stays until the new one is in.</p>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="details" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                  <Section label="Looks like">
                    {/* Keyed by the saved words, so a reading that lands after the dialog opened shows up. */}
                    <AboutField key={`about-${c.noun ?? ""}-${c.traits ?? ""}`} c={c} onSave={(patch) => void update(c.id, patch)} />
                  </Section>

                  <Section label="Details">
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5 text-[13px]">
                      <dt className="text-haze">Real height</dt>
                      <dd className="min-w-0">
                        <HeightField key={`height-${c.height ?? ""}`} c={c} onSave={(height) => void update(c.id, { height })} />
                      </dd>
                      <dt className="text-haze">Sides</dt>
                      <dd className="text-paper/90">{views.map((v) => VIEW_LABELS[v]).join(", ")}</dd>
                      {c.builtWith ? (
                        <>
                          <dt className="text-haze">Drawn by</dt>
                          <dd className="min-w-0 break-words text-paper/90">{c.builtWith}</dd>
                        </>
                      ) : null}
                      {c.notes ? (
                        <>
                          <dt className="text-haze">Always keep</dt>
                          <dd className="min-w-0 break-words text-paper/90">{c.notes}</dd>
                        </>
                      ) : null}
                      <dt className="text-haze">Made from</dt>
                      <dd className="min-w-0 text-paper/90">
                        {c.photos.length ? (
                          <span className="flex gap-1.5">
                            {c.photos.map((url) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={url} src={url} alt="" className="size-8 rounded-[8px] object-cover shadow-[0_0_0_1px_var(--color-line)]" />
                            ))}
                          </span>
                        ) : (
                          "A description"
                        )}
                      </dd>
                    </dl>
                  </Section>

                  {onePicture ? <p className="mt-6 text-[12.5px] leading-relaxed text-tungsten">Drawn as one picture, before each side got its own. Rebuild it for true proportions.</p> : null}
                  {c.error ? <p className="mt-6 text-[12.5px] leading-relaxed text-tally">{c.error}</p> : null}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {editing ? null : (
            <footer className="flex items-center gap-2 px-5 pb-5 pt-3 shadow-[inset_0_1px_0_var(--color-line)]">
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={building}
                className="press squircle inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-[14px] bg-white/[0.06] text-[14px] font-semibold text-paper hover:bg-white/[0.1] disabled:opacity-50"
              >
                <RefreshCw size={15} /> Rebuild
              </button>
              <DeleteButton
                onDelete={async () => {
                  onClose();
                  await remove(c.id);
                }}
              />
            </footer>
          )}
        </div>
      </aside>
    </div>
  );
}

/** The sides to draw: the front always, the others when they look different (a person's back does; an umbrella's doesn't). */
function ViewChips({ value, onChange, large }: { value: SheetView[]; onChange: (views: SheetView[]) => void; large?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5" role="group" aria-label="Sides to draw">
      {VIEW_ORDER.map((v) => {
        const on = value.includes(v);
        const front = v === "front";
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            disabled={front}
            title={front ? "Every sheet starts from the front" : on ? `Leave out the ${VIEW_LABELS[v].toLowerCase()} view` : `Add a ${VIEW_LABELS[v].toLowerCase()} view`}
            onClick={() => onChange(tidyViews(on ? value.filter((x) => x !== v) : [...value, v]))}
            className={cn(
              "inline-flex items-center gap-1 rounded-full font-semibold transition-colors",
              large ? "h-9 px-3.5 text-[13px]" : "h-7 px-2.5 text-[11.5px]",
              on ? "bg-white/[0.12] text-paper" : "bg-transparent text-haze shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-paper",
              front ? "cursor-default" : "press",
            )}
          >
            {on ? <Check size={large ? 13 : 11} strokeWidth={3} /> : <Plus size={large ? 13 : 11} strokeWidth={3} />}
            {VIEW_LABELS[v]}
          </button>
        );
      })}
    </span>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-3">
      <h3 className="label mb-2.5">{label}</h3>
      {children}
    </section>
  );
}

/** Delete, with a second click to be sure. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [arming, setArming] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);
  return (
    <button
      type="button"
      onClick={() => {
        if (arming) return onDelete();
        setArming(true);
        clearTimeout(disarm.current);
        disarm.current = setTimeout(() => setArming(false), 3000);
      }}
      title={arming ? "Click again to delete" : "Delete"}
      aria-label={arming ? "Click again to delete" : "Delete"}
      className={cn(
        "press squircle inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[14px] text-[13px] font-semibold",
        arming ? "bg-tally px-3.5 text-white" : "w-11 bg-white/[0.05] text-fog hover:bg-white/[0.09] hover:text-paper",
      )}
    >
      <Trash size={16} />
      {arming ? "Delete?" : null}
    </button>
  );
}

/** Words read as text (what models are told), edited right there when they're off. */
const quiet = "-mx-1 block w-[calc(100%+0.5rem)] rounded-[8px] bg-transparent px-1 text-paper outline-none transition-colors hover:bg-white/[0.04] focus:bg-white/[0.06] placeholder:text-haze";

function AboutField({ c, onSave }: { c: Character; onSave: (patch: { noun?: string; traits?: string }) => void }) {
  const [noun, setNoun] = useState(c.noun ?? "");
  const [traits, setTraits] = useState(c.traits ?? "");
  // Read from the pictures once they're drawn.
  if (c.status === "building" && !noun && !traits) {
    return (
      <div className="space-y-2" aria-label="Read once it's drawn">
        <div className="skeleton h-4 w-2/3 rounded-full" />
        <div className="skeleton h-3 w-full rounded-full" />
        <div className="skeleton h-3 w-4/5 rounded-full" />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <input
        value={noun}
        onChange={(e) => setNoun(e.target.value)}
        onBlur={() => noun.trim() !== (c.noun ?? "") && onSave({ noun })}
        maxLength={90}
        aria-label="What it is"
        placeholder="What it is, in a few words"
        className={cn(quiet, "h-8 text-[14.5px] font-semibold")}
      />
      <textarea
        value={traits}
        onChange={(e) => setTraits(e.target.value)}
        onBlur={() => traits.trim() !== (c.traits ?? "") && onSave({ traits })}
        aria-label="How it looks"
        placeholder="How it always looks"
        className={cn(quiet, "min-h-[4.5lh] resize-none py-1 text-[13.5px] leading-relaxed text-paper/85 [field-sizing:content]")}
      />
    </div>
  );
}

/** Real height: typed in any common way ("1.7", "170 cm", "33cm", 5'7"), kept as meters, shown back as "1.7 m" or "33 cm". */
function HeightField({ c, onSave }: { c: Character; onSave: (height: number | null) => void }) {
  const [text, setText] = useState(c.height ? formatHeight(c.height) : "");
  const parsed = parseHeight(text);
  const bad = Boolean(text.trim()) && parsed === null;
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (bad) return;
        const next = text.trim() ? parsed : null;
        if (next !== (c.height ?? null) && (next !== null || c.heightSet)) onSave(next);
        if (next) setText(formatHeight(next));
      }}
      inputMode="decimal"
      aria-label="Real height"
      aria-invalid={bad}
      title="Keeps shots true to scale"
      placeholder={c.status === "building" ? "Read once it's drawn" : "Add it"}
      className={cn(quiet, "h-7 text-[13px]", bad && "shadow-[inset_0_0_0_1px_var(--color-tally)]")}
    />
  );
}

/* ------------------------------------------------------------------ bits */

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        {hint ? <span className="font-mono text-[11.5px] text-haze">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <div role="radiogroup" className={cn("flex h-11 rounded-[14px] bg-white/[0.05] p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("relative flex-1 rounded-[10px] px-3 text-[13px] font-semibold transition-colors", value === o.value ? "text-[#16131b]" : "text-fog hover:text-paper")}
        >
          {value === o.value ? <motion.span layoutId={`seg-${options.map((x) => x.value).join("")}`} className="absolute inset-0 rounded-[10px] bg-paper" transition={{ type: "spring", bounce: 0.18, duration: 0.36 }} /> : null}
          <span className="relative whitespace-nowrap">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function CloseButton({ onClick, autoFocus }: { onClick: () => void; autoFocus?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-autofocus={autoFocus || undefined} className="press grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-fog hover:bg-white/[0.12] hover:text-paper" aria-label="Close">
      <X size={16} />
    </button>
  );
}

/** A native modal dialog: Escape and a click outside close it, and focus stays inside. */
function Modal({ open, onClose, label, wide = true, children }: { open: boolean; onClose: () => void; label: string; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // A dialog focuses its first field (on a member's page, the name, which then looks like a box): a marked button instead.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      // Only this dialog's own close: React bubbles a nested dialog's (a model library opened from it) up through portals.
      onClose={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] overflow-hidden rounded-panel bg-flat p-0 text-paper shadow-[0_0_0_1px_var(--color-line-strong),0_40px_120px_-20px_rgb(0_0_0/0.9)] backdrop:bg-black/80",
        wide ? "w-[min(1260px,calc(100vw-2rem))]" : "w-[min(680px,calc(100vw-2rem))]",
      )}
    >
      {open ? children : null}
    </dialog>
  );
}
