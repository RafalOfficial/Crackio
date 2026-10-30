"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MathUtils } from "three";
import { AnimatePresence, motion } from "motion/react";
import {
  Armchair,
  Car,
  Check,
  ChevronDown,
  Crosshair,
  ImagePlus,
  LoaderCircle,
  Orbit,
  PencilLine,
  Package,
  PawPrint,
  Plus,
  Replace,
  RotateCcw,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { useDirector, useSelected } from "@/lib/director/store";
import { cameraPosition, focusPoint, yawTowardCamera } from "@/lib/director/camera";
import type { ElementKind, Scene, SceneElement } from "@/lib/director/types";
import { previewUrl } from "@/lib/media-url";
import { useDirectorTakes } from "./Takes";
import { ELEMENT_DEFAULTS } from "@/lib/director/vocab";
import { standInColor } from "@/lib/director/standin";
import { useDepth, useVision, visionMessage } from "@/lib/director/vision";
import { Slider } from "@/components/ui/Slider";
import { MenuItem, Popover } from "@/components/ui/Popover";
import { PlanView } from "./PlanView";
import { EXAMPLE_CAST, EXAMPLE_PLACES } from "./examples";
import { addFilesToCast, addFromCast, addPlacePhotoFile, addToCast, dismissPending, setPlaceFile, useIntake, type CastMember } from "./intake";
import { buildAround, buildWorld, turnsFor, useAround, useWorld } from "./around";
import { liftFromPlace, useLift } from "./lift";
import { placeModel, usePlaceModel } from "./place-model";
import { useShotModel } from "./shot-model";
import { ModelPicker } from "@/components/models/ModelPicker";
import { DIRECTOR_MODELS } from "./models";
import { cn } from "@/lib/cn";

export const KINDS: { id: ElementKind; label: string; icon: typeof UserRound }[] = [
  { id: "person", label: "Person", icon: UserRound },
  { id: "animal", label: "Animal", icon: PawPrint },
  { id: "object", label: "Object", icon: Armchair },
  { id: "product", label: "Product", icon: Package },
  { id: "vehicle", label: "Vehicle", icon: Car },
];

const ACTIONS = ["standing", "walking toward the camera", "sitting", "running", "looking over the shoulder", "laughing"];

/** Left panel: where the shot happens, who's in it, and the selected subject. */
export function ScenePanel() {
  return (
    <div className="scroll-thin flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-3 pb-6">
      <LocationSection />
      <CastSection />
      <Inspector />
      <TopView />
    </div>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex h-7 items-center justify-between gap-2 px-0.5">
      <h2 className="label">{children}</h2>
      {action}
    </div>
  );
}

function IconButton({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn("press squircle grid size-7 place-items-center rounded-[9px] text-haze hover:bg-white/[0.06] hover:text-paper", className)}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Location

function LocationSection() {
  const place = useDirector((s) => s.scene.place);
  const { setPlace, setPlaceScale, toPhotoView, checkpoint } = useDirector.getState();
  const input = useRef<HTMLInputElement>(null);
  const busy = useIntake((s) => s.placeBusy);
  const error = useIntake((s) => s.placeError);
  const [dragging, setDragging] = useState(false);

  const pick = (file?: File) => {
    if (file) void setPlaceFile(file);
  };

  const image = place.image;
  return (
    <section>
      <SectionTitle
        action={
          image ? (
            <span className="flex items-center gap-0.5">
              <IconButton label="Back to the photo's viewpoint" onClick={toPhotoView}>
                <RotateCcw size={14} />
              </IconButton>
              <IconButton label="Use another photo" onClick={() => input.current?.click()}>
                <Replace size={14} />
              </IconButton>
              {/* Its words go too: "a busy highway" stayed in every shot after the place was removed. */}
              <IconButton label="Remove the location" onClick={() => setPlace(null, "")}>
                <X size={15} />
              </IconButton>
            </span>
          ) : null
        }
      >
        Location
      </SectionTitle>

      {image ? (
        <>
          <div className="relative overflow-hidden rounded-card bg-apple shadow-[inset_0_0_0_1px_var(--color-line)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt="Location" className="aspect-video w-full object-cover" />
            <PlaceStatus url={image.url} ready={Boolean(image.view)} />
          </div>
          <LiftStatus />
          <WorldStrip />
          <YourPlaces />
          <PlaceMore>
            <PlaceModel />
            <MorePhotos />
            {image.view ? (
              <Slider
                className="mt-3.5 px-0.5"
                label="Size of the place"
                value={Math.log2(place.scale ?? 1)}
                min={-2}
                max={2}
                step={0.05}
                onStart={checkpoint}
                onChange={(v) => setPlaceScale(Math.round(2 ** v * 100) / 100, true)}
                format={(v) => `${(2 ** v).toFixed(2).replace(/\.?0+$/, "")}×`}
                hint={["Smaller", "Bigger"]}
              />
            ) : null}
          </PlaceMore>
        </>
      ) : (
        <>
          {/* Made from words in the bar under the camera (Place); here, from a photo. */}
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
              e.stopPropagation();
              setDragging(false);
              pick(e.dataTransfer.files[0]);
            }}
            className={cn(
              "press squircle flex w-full items-center gap-3 rounded-card border border-dashed p-3 text-left",
              dragging ? "border-spike bg-spike/5" : "border-line-strong hover:border-haze hover:bg-white/[0.02]",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-fog">
              {busy ? <LoaderCircle size={17} className="animate-spin" /> : <ImagePlus size={17} />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold">Use a photo of the place</span>
              <span className="block text-[12px] leading-snug text-haze">It becomes a 3D set you can move through</span>
            </span>
          </button>
          <YourPlaces />
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {EXAMPLE_PLACES.map((p) => (
              <button
                key={p.url}
                type="button"
                onClick={() => setPlace({ url: p.url, width: p.width, height: p.height }, p.text)}
                title={p.label}
                className="press squircle group overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-line)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.label} className="aspect-[4/3] w-full object-cover opacity-80 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </>
      )}
      {error ? <p className="mt-2 text-[12px] text-tally">{error}</p> : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </section>
  );
}

/**
 * Build the rest of the place around the photo's spot: each side is filled from the ones next to it, so a landmark stays
 * where the photo has it and the camera can turn anywhere.
 */
function AroundButton() {
  const { busy, done, total, error } = useAround();
  // After the photo's things are lifted out: the views carry on the photo without them.
  const ready = useDirector((s) => Boolean(s.scene.place.image?.view && s.scene.place.lifted));
  const covered = useDirector((s) => {
    const image = s.scene.place.image;
    return Boolean(image?.view) && (s.scene.place.more?.length ?? 0) >= turnsFor(image!.view!.fov, image!.width / image!.height).length;
  });
  if (!ready) return null;
  return (
    <div>
      <button
        type="button"
        disabled={busy || covered}
        onClick={() => void buildAround()}
        className="press squircle flex w-full items-center gap-2 rounded-[12px] bg-white/[0.05] px-2.5 py-2 text-left text-[12.5px] font-semibold text-paper hover:bg-white/[0.08] disabled:opacity-60"
        title="Fills in what the photo doesn't show, all around its spot, one side at a time from the sides next to it"
      >
        {busy ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Orbit size={14} className="shrink-0" />}
        {busy ? `Building the place around you · ${done}/${total}` : covered ? "The place is built all around" : "Build the place all around (360°)"}
      </button>
      {error ? <p className="mt-1 text-[11.5px] text-tally">{error}</p> : null}
    </div>
  );
}

/** The place all around you once it's built: the 360 picture every way the camera turns sees. */
function WorldStrip() {
  const world = useDirector((s) => s.scene.place.world);
  if (!world) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={world.url} alt="The place all around you" title="The place all around you: every way the camera turns" className="mt-2 h-12 w-full rounded-[10px] object-cover shadow-[inset_0_0_0_1px_var(--color-line)]" />
  );
}

/**
 * The places you've shot, newest first, each as you left it (its world, cast and camera): a film with several scenes is
 * a click between them, where making a new place lost the last one's set.
 */
function YourPlaces() {
  const takes = useDirectorTakes();
  const current = useDirector((s) => s.scene.place.image?.url);
  const places = useMemo(() => {
    const seen = new Map<string, Scene>();
    for (const g of takes) {
      const scene = g.params?.scene as Scene | undefined;
      const url = scene?.place.image?.url;
      if (!url || !scene.place.world || seen.has(url)) continue;
      seen.set(url, scene);
    }
    return [...seen.entries()].slice(0, 8);
  }, [takes]);
  if (!places.length || (places.length === 1 && places[0][0] === current)) return null;
  return (
    <div className="mt-3">
      <p className="label mb-1.5 px-0.5">Your places</p>
      <div className="grid grid-cols-4 gap-1.5">
        {places.map(([url, scene]) => (
          <button
            key={url}
            type="button"
            onClick={() => useDirector.getState().loadScene(scene)}
            title={scene.place.text ? `Back to ${scene.place.text}, as you left it` : "Back to this place, as you left it"}
            className={cn(
              "press squircle overflow-hidden rounded-[10px]",
              url === current ? "shadow-[0_0_0_2px_var(--color-spike)]" : "opacity-80 shadow-[inset_0_0_0_1px_var(--color-line)] hover:opacity-100",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl(url, 160)} alt="" className="aspect-[4/3] w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The place's settings you rarely need: its model, drawing it again, more photos of it, its size. */
function PlaceMore({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="press flex w-full items-center gap-1 px-0.5 py-1 text-[12px] font-semibold text-haze hover:text-paper"
      >
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
        {open ? "Less" : "More about the place"}
      </button>
      {open ? children : null}
    </div>
  );
}

/** The place all around you drawn again (it's built on its own once the place is ready). */
function WorldButton() {
  const { busy, error } = useWorld();
  const ready = useDirector((s) => Boolean(s.scene.place.image?.view && s.scene.place.lifted));
  const world = useDirector((s) => s.scene.place.world);
  if (!ready) return null;
  return (
    <div className="mb-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void buildWorld(Boolean(world))}
        className="press squircle flex w-full items-center gap-2 rounded-[12px] bg-white/[0.05] px-2.5 py-2 text-left text-[12.5px] font-semibold text-paper hover:bg-white/[0.08] disabled:opacity-60"
        title="The place all around the photo's spot, drawn as one 360 picture, so every way the camera turns is the same world"
      >
        {busy ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Orbit size={14} className="shrink-0" />}
        {busy ? "Drawing the place all around you…" : world ? "Draw the place around you again" : "Build the place all around you (360°)"}
      </button>
      {error ? <p className="mt-1 text-[11.5px] text-tally">{error}</p> : null}
    </div>
  );
}

/** The photo's cars, people and things being lifted out onto the set, or why they couldn't be. */
function LiftStatus() {
  const { busy, error } = useLift();
  const lifted = useDirector((s) => s.scene.elements.filter((e) => e.fromPlace).length);
  const waiting = useDirector((s) => Boolean(s.scene.place.image?.view && !s.scene.place.lifted));
  const own = usePlaceModel((s) => s.model);
  const shot = useShotModel((s) => s.model);
  if (waiting && !busy && !error && (!own || own === "auto") && shot === "auto") {
    return <p className="mt-2 px-0.5 text-[12px] text-haze">Choose the model that makes the place: it lifts the photo&apos;s cars and people onto the set and builds the place around you.</p>;
  }
  if (busy) {
    return (
      <p className="mt-2 flex items-center gap-1.5 px-0.5 text-[12px] text-fog">
        <LoaderCircle size={13} className="shrink-0 animate-spin" />
        {busy}
      </p>
    );
  }
  if (error) {
    return (
      <p className="mt-2 flex items-center gap-1.5 px-0.5 text-[12px] text-tally">
        <TriangleAlert size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{error}</span>
        <button type="button" onClick={() => void liftFromPlace()} className="press shrink-0 font-semibold text-paper underline-offset-2 hover:underline">
          Try again
        </button>
      </p>
    );
  }
  return lifted ? <p className="mt-2 px-0.5 text-[12px] text-haze">{lifted === 1 ? "1 thing" : `${lifted} things`} from the photo stand on set now, drawn from your camera&apos;s angle.</p> : null;
}

/** Which model makes the place: lifts things out of the photo, builds it all around, fills in what the photo doesn't show. */
function PlaceModel() {
  const own = usePlaceModel((s) => s.model);
  const shot = useShotModel((s) => s.model);
  return (
    <div className="mt-2.5">
      <ModelPicker kind="image" task="edit" only={DIRECTOR_MODELS} value={own ?? shot} onChange={(m) => usePlaceModel.setState({ model: m })} label="Place made with" className="w-full" />
      {own && own !== shot ? (
        <button type="button" onClick={() => usePlaceModel.setState({ model: null })} className="press mt-1 px-0.5 text-[11.5px] text-haze hover:text-paper">
          Use the model you shoot with
        </button>
      ) : null}
    </div>
  );
}

/** Where a turn points, in words: "behind", "to the left", "a bit right". */
function turnWord(turn: number) {
  const a = Math.abs(turn);
  if (a >= 150) return "Behind";
  if (a >= 60) return turn > 0 ? "To the left" : "To the right";
  if (a >= 15) return turn > 0 ? "A bit left" : "A bit right";
  return "Same way";
}

/** One view around the spot drawn again, or changed in your words ("a pine forest here"). */
function ViewActions({ url, turn }: { url: string; turn: number }) {
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const building = useAround((s) => s.busy);
  const change = async (close: () => void) => {
    if (!words.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/director/edit-view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, words, model: placeModel() }) });
      const data = (await res.json().catch(() => ({}))) as { url?: string; width?: number; height?: number; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "The model couldn't change it.");
      useDirector.getState().replacePlacePhoto(url, { url: data.url, width: data.width ?? 0, height: data.height ?? 0 });
      close();
      setWords("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Popover
        placement="bottom-end"
        panelClassName="w-[260px]"
        trigger={({ toggle }) => (
          <IconButton label="Change this side in words" onClick={toggle}>
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <PencilLine size={14} />}
          </IconButton>
        )}
      >
        {(close) => (
          <div className="p-2">
            <input
              autoFocus
              value={words}
              onChange={(e) => setWords(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void change(close)}
              placeholder="What should be here instead?"
              className="squircle field-focus h-9 w-full rounded-[10px] bg-white/[0.05] px-2.5 text-[13px] outline-none placeholder:text-haze"
            />
            {error ? <p className="mt-1.5 text-[11.5px] text-tally">{error}</p> : null}
          </div>
        )}
      </Popover>
      <IconButton
        label="Draw this side again"
        onClick={() => {
          if (building) return;
          useDirector.getState().removePlacePhoto(url);
          void buildAround([turn]);
        }}
      >
        <RotateCcw size={14} />
      </IconButton>
    </>
  );
}

/**
 * More photos of the place, taken from the same spot facing other ways: each joins the 3D set around the camera
 * (two back to back make a place you can turn around in). Each has its turn, which you can correct by hand.
 */
function MorePhotos() {
  const more = useDirector((s) => s.scene.place.more) ?? [];
  const { setPlacePhotoTurn, removePlacePhoto, checkpoint } = useDirector.getState();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-2.5">
      {more.map((p) => (
        <div key={p.url} className="mb-2 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.url} alt="" className="h-10 w-16 shrink-0 rounded-[8px] object-cover shadow-[inset_0_0_0_1px_var(--color-line)]" />
          <Slider
            className="min-w-0 flex-1"
            label={turnWord(p.turn)}
            value={p.turn}
            min={-180}
            max={180}
            step={5}
            onStart={checkpoint}
            onChange={(v) => setPlacePhotoTurn(p.url, v, true)}
            format={(v) => `${Math.round(v)}°`}
          />
          <ViewActions url={p.url} turn={p.turn} />
          <IconButton label="Remove this photo" onClick={() => removePlacePhoto(p.url)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <WorldButton />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="press squircle mt-1.5 flex w-full items-center gap-2 rounded-[12px] px-2.5 py-2 text-left text-[12.5px] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.03] hover:text-paper"
        title="A photo from the same spot facing another way: behind you, to the side. It joins the 3D set around the camera."
      >
        <ImagePlus size={14} className="shrink-0" />
        {more.length ? "Add another side of the place" : "Add the view behind (same spot, turned around)"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          for (const f of Array.from(e.target.files ?? []).slice(0, 3)) void addPlacePhotoFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** "Building 3D…" while the depth map is made, a check when the set is ready, or what went wrong. */
function PlaceStatus({ url, ready }: { url: string; ready: boolean }) {
  const { error, retry } = useDepth(url);
  const models = useVision((s) => s.models);
  const busy = useVision((s) => s.busy > 0);
  const message = busy ? visionMessage(models) : null;
  return (
    <AnimatePresence>
      {error ? (
        <motion.button
          key="error"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={retry}
          className="absolute inset-x-2 bottom-2 flex items-start gap-1.5 rounded-[10px] bg-black/75 px-2.5 py-2 text-left text-[11.5px] leading-snug text-tally backdrop-blur"
        >
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>
            {error} <span className="font-semibold text-paper underline underline-offset-2">Try again</span>
          </span>
        </motion.button>
      ) : !ready ? (
        <motion.span
          key="busy"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full bg-black/70 py-1 pl-1.5 pr-2.5 text-[11.5px] font-medium text-paper backdrop-blur"
        >
          <LoaderCircle size={12} className="shrink-0 animate-spin text-spike" />
          <span className="truncate">{message ?? "Building the 3D set"}</span>
        </motion.span>
      ) : (
        <motion.span
          key="ready"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 py-0.5 pl-1.5 pr-2 text-[11px] font-medium text-paper/90 backdrop-blur"
        >
          <Check size={11} className="text-chroma" /> 3D set
        </motion.span>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------- Cast

function CastSection() {
  const elements = useDirector((s) => s.scene.elements);
  const selectedId = useDirector((s) => s.selectedId);
  const focusId = useDirector((s) => s.scene.camera.focusId ?? s.scene.elements[0]?.id ?? null);
  const pending = useIntake((s) => s.pending);
  const note = useIntake((s) => s.note);
  const models = useVision((s) => s.models);
  const { select } = useDirector.getState();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const empty = !elements.length && !pending.length;

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      void addFilesToCast(Array.from(e.dataTransfer.files));
    },
  };

  return (
    <section {...dropProps} className={cn("rounded-card transition-shadow", dragging && !empty && "shadow-[0_0_0_1.5px_var(--color-spike)]")}>
      <SectionTitle
        action={
          empty ? null : (
            <Popover
              placement="bottom-end"
              panelClassName="w-[240px]"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={open}
                  className="press squircle inline-flex h-7 items-center gap-1 rounded-[9px] bg-white/[0.06] px-2.5 text-[12px] font-semibold hover:bg-white/[0.1]"
                >
                  <Plus size={13} strokeWidth={2.5} /> Add
                </button>
              )}
            >
              {(close) => (
                <div>
                  <MenuItem
                    onSelect={() => {
                      close();
                      input.current?.click();
                    }}
                  >
                    <ImagePlus size={15} /> Photos of people or things
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      close();
                      useDirector.getState().addElement({ kind: "person", name: `Person ${elements.length + 1}` });
                    }}
                  >
                    <UserRound size={15} /> A stand-in, no photo
                  </MenuItem>
                  <FromCast onPick={close} />
                  <p className="px-2.5 pb-1.5 pt-2.5 text-[11.5px] text-haze">Examples</p>
                  <div className="flex gap-1.5 px-1.5 pb-1">
                    {EXAMPLE_CAST.map((c) => (
                      <button
                        key={c.url}
                        type="button"
                        onClick={() => {
                          close();
                          void addToCast(c);
                        }}
                        title={`Add ${c.name}`}
                        className="press squircle checker flex h-12 flex-1 items-end justify-center overflow-hidden rounded-[10px] hover:brightness-110"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={c.url} alt={c.name} className="h-[44px] w-auto object-contain" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Popover>
          )
        }
      >
        In the shot
      </SectionTitle>

      {empty ? (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={cn(
              "press squircle flex w-full items-center gap-3 rounded-card border border-dashed p-3 text-left",
              dragging ? "border-spike bg-spike/5" : "border-line-strong hover:border-haze hover:bg-white/[0.02]",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.05] text-fog">
              <UserRound size={17} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold">Add people or things</span>
              <span className="block text-[12px] leading-snug text-haze">People and pets join Cast first, so they look like themselves</span>
            </span>
          </button>
          <div className="-mx-1.5">
            <FromCast onPick={() => undefined} />
          </div>
          <div className="mt-2 flex gap-1.5">
            {EXAMPLE_CAST.map((c) => (
              <button
                key={c.url}
                type="button"
                onClick={() => void addToCast(c)}
                title={`Add ${c.name}`}
                className="press squircle checker flex h-14 flex-1 items-end justify-center overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-line)] hover:brightness-110"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt={c.name} className="h-[52px] w-auto object-contain" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <ul className="space-y-1">
          {elements.map((el, i) => (
            <li key={el.id}>
              <CastRow el={el} color={standInColor(i).hex} selected={el.id === selectedId} framed={el.id === focusId} onSelect={() => select(el.id === selectedId ? null : el.id)} />
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.id} className="flex items-center gap-2.5 rounded-[12px] p-1.5 pr-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumb} alt="" className="size-10 shrink-0 rounded-[9px] object-cover opacity-60" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{p.name}</span>
                {p.error ? (
                  <span className="block truncate text-[11.5px] text-tally" title={p.error}>
                    {p.error}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-haze">
                    <LoaderCircle size={11} className="animate-spin text-spike" />
                    <span className="truncate">{visionMessage(models) ?? p.stage}</span>
                  </span>
                )}
              </span>
              {p.error ? (
                <IconButton label="Dismiss" onClick={() => dismissPending(p.id)}>
                  <X size={14} />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {note ? (
        <p className="mt-2 flex items-start gap-1.5 px-0.5 text-[11.5px] leading-snug text-tungsten">
          <span className="flex-1">{note}</span>
          <button onClick={() => useIntake.setState({ note: null })} className="text-haze hover:text-paper" aria-label="Dismiss">
            <X size={12} />
          </button>
        </p>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addFilesToCast(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </section>
  );
}

/** Cast members to put on set: people and pets look most like themselves from their Cast sheet. */
function FromCast({ onPick }: { onPick: () => void }) {
  const [members, setMembers] = useState<CastMember[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/director/cast", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { items?: CastMember[] }) => live && setMembers(d.items ?? []))
      .catch(() => live && setMembers([]));
    return () => {
      live = false;
    };
  }, []);
  if (!members?.length) return null;
  return (
    <>
      <p className="px-2.5 pb-1.5 pt-2.5 text-[11.5px] text-haze">From Cast</p>
      <div className="grid grid-cols-4 gap-1.5 px-1.5 pb-1">
        {members.slice(0, 12).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              onPick();
              void addFromCast(m);
            }}
            title={`Add ${m.name}${m.noun ? `, ${m.noun}` : ""}`}
            className="press squircle overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-line)] hover:brightness-110"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.portrait ?? m.sheet} alt={m.name} className="aspect-square w-full object-cover" />
          </button>
        ))}
      </div>
    </>
  );
}

function CastRow({ el, color, selected, framed, onSelect }: { el: SceneElement; color: string; selected: boolean; framed: boolean; onSelect: () => void }) {
  const Icon = KINDS.find((k) => k.id === el.kind)?.icon ?? UserRound;
  const drawing = useIntake((s) => s.drawing.includes(el.id));
  const casting = useIntake((s) => s.casting.includes(el.id));
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "press squircle flex w-full items-center gap-2.5 rounded-[12px] p-1.5 pr-2.5 text-left",
        selected ? "bg-white/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "hover:bg-white/[0.04]",
      )}
    >
      {el.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={el.image.url} alt="" className={cn("size-10 shrink-0 rounded-[9px] object-contain", el.image.cutout ? "checker" : "object-cover")} />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-[9px] bg-white/[0.05] text-haze">
          <Icon size={16} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className="size-2.5 shrink-0 rounded-full shadow-[0_0_0_1.5px_rgb(0_0_0/0.35)]"
            style={{ background: color }}
            title="Its stand-in's color in what the image model sees"
          />
          <span className="block truncate text-[13.5px] font-semibold">{el.name}</span>
        </span>
        <span className="block truncate text-[11.5px] text-haze" title={el.read?.identity}>
          <Icon size={11} className="mr-1 inline align-[-1px]" />
          {casting ? "Making their Cast sheet…" : drawing ? "Drawing it from every side…" : `${el.cast ? "Cast · " : el.fromPlace ? "From the photo · " : ""}${el.read?.noun ?? KINDS.find((k) => k.id === el.kind)?.label}`}
        </span>
      </span>
      {framed ? (
        <span title="The camera is framing this one" className="text-spike">
          <Crosshair size={14} />
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------- Selected subject

function Inspector() {
  const el = useSelected();
  const scene = useDirector((s) => s.scene);
  const { updateElement, checkpoint, focusOn, applyShotSize, removeElement } = useDirector.getState();
  const [more, setMore] = useState(false);
  if (!el) return null;

  const camPos = cameraPosition(scene.camera, focusPoint(scene));
  const toward = yawTowardCamera(el, camPos);
  const framed = (scene.camera.focusId ?? scene.elements[0]?.id) === el.id;

  return (
    <motion.section key={el.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
      <SectionTitle
        action={
          <IconButton label={`Remove ${el.name}`} onClick={() => removeElement(el.id)} className="hover:text-tally">
            <Trash2 size={14} />
          </IconButton>
        }
      >
        Selected
      </SectionTitle>
      <div className="squircle space-y-4 rounded-card bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <div className="flex items-center gap-2">
          <input
            aria-label="Name"
            value={el.name}
            onChange={(e) => updateElement(el.id, { name: e.target.value })}
            className="squircle field-focus h-9 min-w-0 flex-1 rounded-[11px] bg-white/[0.04] px-3 text-[14px] font-semibold outline-none shadow-[inset_0_0_0_1px_var(--color-line)]"
          />
        </div>

        <div role="radiogroup" aria-label="What it is" className="grid grid-cols-5 gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={el.kind === k.id}
              title={k.label}
              onClick={() => updateElement(el.id, { kind: k.id, kindAuto: false, height: ELEMENT_DEFAULTS[k.id].height })}
              className={cn(
                "press squircle flex h-12 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[10.5px] font-semibold",
                el.kind === k.id ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-haze hover:bg-white/[0.05] hover:text-paper",
              )}
            >
              <k.icon size={15} />
              {k.label}
            </button>
          ))}
        </div>

        <div>
          <input
            aria-label="Doing what"
            value={el.action ?? ""}
            onChange={(e) => updateElement(el.id, { action: e.target.value })}
            placeholder="Doing what? (walking toward the camera…)"
            className="squircle field-focus h-9 w-full rounded-[11px] bg-white/[0.04] px-3 text-[13px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze"
          />
          {el.kind === "person" || el.kind === "animal" ? (
            <div className="scrollbar-none strip-fade -mx-0.5 mt-1.5 flex gap-1 overflow-x-auto px-0.5 pr-9">
              {ACTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => updateElement(el.id, { action: a })}
                  className={cn(
                    "press shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                    el.action === a ? "bg-spike/15 text-spike" : "bg-white/[0.05] text-fog hover:text-paper",
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <FacingDial
            yaw={el.yaw}
            cameraYaw={toward}
            onStart={checkpoint}
            onChange={(yaw) => updateElement(el.id, { yaw }, true)}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-fog">Facing</p>
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              <SmallButton onClick={() => updateElement(el.id, { yaw: Math.round(toward) })}>To camera</SmallButton>
              <SmallButton onClick={() => updateElement(el.id, { yaw: Math.round(toward + 180) })}>Away</SmallButton>
              <SmallButton onClick={() => updateElement(el.id, { yaw: Math.round(toward - 90) })}>Left</SmallButton>
              <SmallButton onClick={() => updateElement(el.id, { yaw: Math.round(toward + 90) })}>Right</SmallButton>
            </div>
          </div>
        </div>

        <Slider
          label="Height"
          value={el.height}
          min={0.05}
          max={el.kind === "vehicle" ? 4 : 2.6}
          step={0.01}
          onStart={checkpoint}
          onChange={(v) => updateElement(el.id, { height: v }, true)}
          format={(v) => (v < 1 ? `${Math.round(v * 100)} cm` : `${v.toFixed(2)} m`)}
        />

        <div>
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            aria-expanded={more}
            className="flex w-full items-center justify-between text-[12.5px] font-medium text-fog hover:text-paper"
          >
            More
            <ChevronDown size={14} className={cn("transition-transform", more && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {more ? (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="space-y-4 pt-3">
                  <input
                    aria-label="Looks like"
                    value={el.look ?? ""}
                    onChange={(e) => updateElement(el.id, { look: e.target.value })}
                    placeholder="Looks like (red coat, short silver hair…)"
                    className="squircle field-focus h-9 w-full rounded-[11px] bg-white/[0.04] px-3 text-[13px] outline-none shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-haze"
                  />
                  <Slider
                    label="Off the floor"
                    value={el.lift}
                    min={0}
                    max={3}
                    step={0.01}
                    onStart={checkpoint}
                    onChange={(v) => updateElement(el.id, { lift: v }, true)}
                    format={(v) => (v === 0 ? "On the floor" : `${Math.round(v * 100)} cm`)}
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={() => {
            focusOn(el.id);
            applyShotSize(el.kind === "person" ? "ms" : "cu");
          }}
          className="press squircle flex h-9 w-full items-center justify-center gap-1.5 rounded-[11px] bg-white/[0.06] text-[13px] font-semibold hover:bg-white/[0.1]"
        >
          <Crosshair size={14} className="text-spike" /> {framed ? `Move in on ${el.name}` : `Frame ${el.name}`}
        </button>
      </div>
    </motion.section>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="press squircle h-7 rounded-[8px] bg-white/[0.05] text-[11.5px] font-semibold text-fog hover:bg-white/[0.09] hover:text-paper">
      {children}
    </button>
  );
}

/** Top-down dial: the arrow is where the subject faces; the orange dot is where the camera is. */
function FacingDial({ yaw, cameraYaw, onChange, onStart }: { yaw: number; cameraYaw: number; onChange: (yaw: number) => void; onStart: () => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const setFromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    onChange(Math.round(MathUtils.radToDeg(Math.atan2(dx, dy))));
  };
  const rad = MathUtils.degToRad(yaw);
  const crad = MathUtils.degToRad(cameraYaw);
  return (
    <svg
      ref={ref}
      viewBox="-30 -30 60 60"
      className="size-[76px] shrink-0 cursor-grab touch-none active:cursor-grabbing"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        onStart();
        setFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons) setFromEvent(e);
      }}
      role="slider"
      aria-label="Facing direction"
      aria-valuenow={Math.round(((yaw % 360) + 360) % 360)}
    >
      <circle r={27} fill="rgb(255 255 255 / 0.04)" stroke="rgb(255 255 255 / 0.1)" />
      <circle cx={Math.sin(crad) * 27} cy={Math.cos(crad) * 27} r={3.4} fill="#ff5b2e" />
      <circle r={6.5} fill="#f0efed" />
      <line x1={0} y1={0} x2={Math.sin(rad) * 20} y2={Math.cos(rad) * 20} stroke="#f0efed" strokeWidth={3} strokeLinecap="round" />
      <circle cx={Math.sin(rad) * 20} cy={Math.cos(rad) * 20} r={3.5} fill="#f0efed" />
    </svg>
  );
}

// ---------------------------------------------------------------- Top view

function TopView() {
  const [open, setOpen] = useState(false);
  const hasSomething = useDirector((s) => s.scene.elements.length > 0 || Boolean(s.scene.place.image));
  if (!hasSomething) return null;
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-7 w-full items-center justify-between px-0.5 text-left"
      >
        <span className="label">Seen from above</span>
        <ChevronDown size={14} className={cn("text-haze transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 overflow-hidden rounded-card bg-white/[0.02] shadow-[inset_0_0_0_1px_var(--color-line)]">
              <PlanView className="aspect-square w-full" />
            </div>
            <p className="mt-1.5 px-0.5 text-[11.5px] text-haze">Drag people, the camera or the sun.</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
